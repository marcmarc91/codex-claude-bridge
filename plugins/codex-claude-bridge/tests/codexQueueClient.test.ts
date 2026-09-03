import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import test from "node:test";

import { queueCodexMessage } from "../src/codex/codexQueueClient.js";
import type { AgentMessageEnvelope } from "../src/protocol/messageEnvelope.js";

const targetSessionIdentifier = "8d6380bf-1b93-44b3-b3da-a1a661cf8b69";

function validEnvelope(
  overrides: Partial<AgentMessageEnvelope> = {},
): AgentMessageEnvelope {
  return {
    schemaVersion: 1,
    messageId: "3c4b3c10-21a7-4d6f-b964-3c816b9ed8db",
    conversationId: "5cb1e2fd-5b24-4699-bfea-878e9b147370",
    sentAt: "2026-09-03T12:00:00.000Z",
    messageType: "question",
    sender: {
      runtime: "claude",
      sessionId: "ad65b1c1-7386-4465-80f9-4de0a26bc212",
      projectId: "0123456789abcdef01234567",
    },
    recipient: {
      runtime: "codex",
      sessionId: targetSessionIdentifier,
      projectId: "0123456789abcdef01234567",
    },
    content: "spaces 'quotes' \"double\" `backticks` $(touch /tmp/nope)\nsecond line",
    replyRoute: {
      runtime: "claude",
      sessionId: "ad65b1c1-7386-4465-80f9-4de0a26bc212",
      projectId: "0123456789abcdef01234567",
    },
    ...overrides,
  };
}

test("passes the exact approved argv with shell disabled and content serialized as data", async () => {
  let capturedCommand: string | undefined;
  let capturedArguments: readonly string[] | undefined;
  let capturedOptions: SpawnOptions | undefined;
  const spawnProcess = ((
    command: string,
    commandArguments: readonly string[],
    options: SpawnOptions,
  ) => {
    capturedCommand = command;
    capturedArguments = commandArguments;
    capturedOptions = options;
    return spawn(process.execPath, ["-e", "process.exit(0)"], {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
  }) as typeof spawn;
  const envelope = validEnvelope();
  const serializedInboundMessage = [
    "codex-claude-bridge/v1",
    `conversation_id=${envelope.conversationId}`,
    `sender_session_id=${envelope.sender.sessionId}`,
    `message_type=${envelope.messageType}`,
    `reply_command=codex-claude-bridge reply --conversation ${envelope.conversationId} --message <text>`,
    `content_json=${JSON.stringify(envelope.content)}`,
  ].join("\n");

  await queueCodexMessage({
    targetSessionId: targetSessionIdentifier,
    envelope,
    codexExecutablePath: "/opt/local/bin/codex",
    spawnProcess,
  });

  assert.equal(capturedCommand, "/opt/local/bin/codex");
  assert.deepEqual(capturedArguments, [
    "queue",
    "--thread",
    targetSessionIdentifier,
    "--message",
    serializedInboundMessage,
  ]);
  assert.equal(capturedOptions?.shell, false);
  assert.deepEqual(capturedOptions?.stdio, ["ignore", "ignore", "pipe"]);
  assert.equal(capturedOptions?.detached, true);
  assert.equal(capturedArguments?.some((argument) => argument.includes("--model")), false);
  assert.equal(capturedArguments?.some((argument) => argument.includes("sandbox")), false);
  assert.equal(capturedArguments?.some((argument) => argument.includes("approval")), false);
  assert.equal(capturedArguments?.some((argument) => argument.includes("remote")), false);
});

test("propagates a non-zero exit with bounded sanitized stderr", async () => {
  const spawnProcess = (() =>
    spawn(
      process.execPath,
      [
        "-e",
        "process.stderr.write('\\u001b[31mfirst\\nsecond\\u0000' + 'x'.repeat(10000)); process.exit(7)",
      ],
      { shell: false, stdio: ["ignore", "ignore", "pipe"] },
    )) as typeof spawn;

  await assert.rejects(
    () =>
      queueCodexMessage({
        targetSessionId: targetSessionIdentifier,
        envelope: validEnvelope(),
        spawnProcess,
      }),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      const errorMessage = (error as Error).message;
      assert.match(errorMessage, /exit code 7/u);
      assert.match(errorMessage, /first second/u);
      assert.equal(errorMessage.includes("\u001b"), false);
      assert.equal(errorMessage.includes("\0"), false);
      assert.equal(errorMessage.includes("\n"), false);
      assert.equal(Buffer.byteLength(errorMessage, "utf8") <= 4_300, true);
      return true;
    },
  );
});

test("terminates a queue process that exceeds its bounded timeout", async () => {
  const spawnProcess = ((_command, _commandArguments, options) =>
    spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
      ...options,
    })) as typeof spawn;
  const startedAt = Date.now();

  await assert.rejects(
    () =>
      queueCodexMessage({
        targetSessionId: targetSessionIdentifier,
        envelope: validEnvelope(),
        spawnProcess,
        timeoutMilliseconds: 30,
      }),
    /timed out/u,
  );

  assert.equal(Date.now() - startedAt < 1_000, true);
});

test("force kills the complete timed-out process group after both processes report readiness", async () => {
  let spawnedProcess: ReturnType<typeof spawn> | undefined;
  let parentProcessIdentifier: number | undefined;
  let grandchildProcessIdentifier: number | undefined;
  let resolveReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const grandchildProgram = [
    "process.on('SIGTERM', () => undefined)",
    "process.send('ready')",
    "setInterval(() => undefined, 1000)",
  ].join(";");
  const parentProgram = [
    "const { spawn } = require('node:child_process')",
    "process.on('SIGTERM', () => undefined)",
    `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildProgram)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })`,
    "grandchild.once('message', () => process.stdout.write(JSON.stringify({ parentPid: process.pid, grandchildPid: grandchild.pid }) + '\\n'))",
    "setInterval(() => undefined, 1000)",
  ].join(";");
  const spawnProcess = ((_command, _commandArguments, options) => {
    spawnedProcess = spawn(
      process.execPath,
      ["-e", parentProgram],
      { ...options, stdio: ["ignore", "pipe", "pipe"] },
    );
    let readinessBytes = "";
    spawnedProcess.stdout?.on("data", (chunk: Buffer | string) => {
      readinessBytes += chunk.toString();
      const newlineIndex = readinessBytes.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const readyProcessIdentifiers = JSON.parse(
        readinessBytes.slice(0, newlineIndex),
      ) as { parentPid: number; grandchildPid: number };
      parentProcessIdentifier = readyProcessIdentifiers.parentPid;
      grandchildProcessIdentifier = readyProcessIdentifiers.grandchildPid;
      resolveReady?.();
    });
    return spawnedProcess;
  }) as typeof spawn;

  const queueResult = queueCodexMessage({
    targetSessionId: targetSessionIdentifier,
    envelope: validEnvelope(),
    spawnProcess,
    timeoutMilliseconds: 500,
  });

  try {
    await Promise.race([
      ready,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("Process group was not ready")), 400);
      }),
    ]);
    await assert.rejects(queueResult, /timed out/u);
    assert.equal(spawnedProcess?.signalCode, "SIGKILL");
    assert.notEqual(parentProcessIdentifier, undefined);
    assert.notEqual(grandchildProcessIdentifier, undefined);
    for (const processIdentifier of [
      parentProcessIdentifier!,
      grandchildProcessIdentifier!,
    ]) {
      assert.throws(
        () => process.kill(processIdentifier, 0),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "ESRCH",
      );
    }
  } finally {
    if (spawnedProcess?.pid !== undefined) {
      try {
        process.kill(-spawnedProcess.pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
          throw error;
        }
      }
    }
  }
});

test("rejects a target that does not match a Codex recipient", async () => {
  await assert.rejects(() =>
    queueCodexMessage({
      targetSessionId: "ea7220bc-cd1e-41f0-bf7f-413982f18a9c",
      envelope: validEnvelope(),
    }),
  );
  await assert.rejects(() =>
    queueCodexMessage({
      targetSessionId: targetSessionIdentifier,
      envelope: validEnvelope({
        recipient: {
          runtime: "claude",
          sessionId: targetSessionIdentifier,
          projectId: "0123456789abcdef01234567",
        },
      }),
    }),
  );
});

test("allows explicitly selected active routes across projects", async () => {
  const spawnProcess = (() =>
    spawn(process.execPath, ["-e", "process.exit(0)"], {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    })) as typeof spawn;

  await queueCodexMessage({
    targetSessionId: targetSessionIdentifier,
    envelope: validEnvelope({
      sender: {
        runtime: "claude",
        sessionId: "ad65b1c1-7386-4465-80f9-4de0a26bc212",
        projectId: "fedcba987654321001234567",
      },
      replyRoute: {
        runtime: "claude",
        sessionId: "ad65b1c1-7386-4465-80f9-4de0a26bc212",
        projectId: "fedcba987654321001234567",
      },
    }),
    spawnProcess,
  });
});
