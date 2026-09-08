import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import test from "node:test";

import {
  ChannelTransportError,
  deliverClaudeMessage,
} from "../src/channel/channelSocketClient.js";
import type { ChannelDeliveryResponse } from "../src/channel/channelSocketServer.js";
import type { AgentMessageEnvelope } from "../src/protocol/messageEnvelope.js";
import {
  activeSessionRegistrationIsOwned,
  listActiveSessions,
  registerActiveSession,
  type ActiveSessionRecord,
} from "../src/registry/activeSessionRegistry.js";
import { resolveBridgeStateDirectory } from "../src/runtime/paths.js";

const codexSessionIdentifier = "8d6380bf-1b93-44b3-b3da-a1a661cf8b69";
const claudeSessionIdentifier = "ad65b1c1-7386-4465-80f9-4de0a26bc212";
const projectIdentifier = "0123456789abcdef01234567";
const messageIdentifier = "3c4b3c10-21a7-4d6f-b964-3c816b9ed8db";

function messageEnvelope(): AgentMessageEnvelope {
  return {
    schemaVersion: 1,
    messageId: messageIdentifier,
    conversationId: "5cb1e2fd-5b24-4699-bfea-878e9b147370",
    sentAt: "2026-09-04T10:00:00.000Z",
    messageType: "question",
    sender: {
      runtime: "codex",
      sessionId: codexSessionIdentifier,
      projectId: projectIdentifier,
    },
    recipient: {
      runtime: "claude",
      sessionId: claudeSessionIdentifier,
      projectId: projectIdentifier,
    },
    content: "status?",
    replyRoute: {
      runtime: "codex",
      sessionId: codexSessionIdentifier,
      projectId: projectIdentifier,
    },
  };
}

async function createStateHomeDirectory(testContext: test.TestContext): Promise<string> {
  const stateHomeDirectory = await mkdtemp("/private/tmp/ccb-client-");
  testContext.after(() => rm(stateHomeDirectory, { recursive: true, force: true }));
  return stateHomeDirectory;
}

async function listenOnPrivateSocket(
  testContext: test.TestContext,
  stateHomeDirectory: string,
  socketName: string,
  connectionHandler: (socket: Socket) => void,
): Promise<{ server: Server; socketPath: string }> {
  const socketsDirectory = join(
    resolveBridgeStateDirectory(stateHomeDirectory),
    "sockets",
  );
  await mkdir(socketsDirectory, { recursive: true, mode: 0o700 });
  await chmod(resolveBridgeStateDirectory(stateHomeDirectory), 0o700);
  await chmod(socketsDirectory, 0o700);
  const socketPath = join(socketsDirectory, socketName);
  const connectedSockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    connectedSockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => connectedSockets.delete(socket));
    connectionHandler(socket);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, resolveListen);
  });
  await chmod(socketPath, 0o600);
  testContext.after(() => {
    for (const socket of connectedSockets) {
      socket.destroy();
    }
    return new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });
  return { server, socketPath };
}

function targetRecord(socketPath: string, registeredAt = "2026-09-04T10:00:00.000Z"): ActiveSessionRecord {
  return {
    schemaVersion: 1,
    runtime: "claude",
    sessionId: claudeSessionIdentifier,
    displayName: "claude-target",
    processId: process.pid,
    workingDirectory: process.cwd(),
    projectId: projectIdentifier,
    socketPath,
    registeredAt,
  };
}

async function registerTarget(
  stateHomeDirectory: string,
  socketPath: string,
  registeredAt?: string,
): Promise<ActiveSessionRecord> {
  const record = targetRecord(socketPath, registeredAt);
  await registerActiveSession(record, stateHomeDirectory);
  return record;
}

test("sends one envelope frame and accepts only its matching transport acknowledgement", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  let receivedFrame = "";
  const { socketPath } = await listenOnPrivateSocket(
    testContext,
    stateHomeDirectory,
    "success.sock",
    (socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        receivedFrame += chunk;
      });
      socket.once("end", () => {
        const response: ChannelDeliveryResponse = {
          delivered: true,
          messageId: messageIdentifier,
        };
        socket.end(`${JSON.stringify(response)}\n`);
      });
    },
  );
  const record = await registerTarget(stateHomeDirectory, socketPath);

  const response = await deliverClaudeMessage({
    targetSession: record,
    envelope: messageEnvelope(),
    stateHomeDirectory,
  });

  assert.deepEqual(response, { delivered: true, messageId: messageIdentifier });
  assert.equal(receivedFrame, `${JSON.stringify(messageEnvelope())}\n`);
});

test("returns a strict negative acknowledgement without removing a live target", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const { socketPath } = await listenOnPrivateSocket(
    testContext,
    stateHomeDirectory,
    "negative.sock",
    (socket) => {
      socket.resume();
      socket.once("end", () => {
        socket.end(`${JSON.stringify({ delivered: false, error: "Target rejected the message" })}\n`);
      });
    },
  );
  const record = await registerTarget(stateHomeDirectory, socketPath);

  const response = await deliverClaudeMessage({
    targetSession: record,
    envelope: messageEnvelope(),
    stateHomeDirectory,
  });

  assert.deepEqual(response, {
    delivered: false,
    error: "Target rejected the message",
  });
  assert.equal(
    (await listActiveSessions({ runtime: "claude" }, stateHomeDirectory)).length,
    1,
  );
});

test("rejects invalid response frames without removing a live target", async (testContext) => {
  const invalidResponses = [
    `${JSON.stringify({ delivered: true, messageId: "ea7220bc-cd1e-41f0-bf7f-413982f18a9c" })}\n`,
    "not-json\n",
    `${JSON.stringify({ delivered: false, error: "x".repeat(4_097) })}\n`,
    `${JSON.stringify({ delivered: true, messageId: messageIdentifier })}\n{}\n`,
  ];

  for (const [index, invalidResponse] of invalidResponses.entries()) {
    const stateHomeDirectory = await createStateHomeDirectory(testContext);
    const { socketPath } = await listenOnPrivateSocket(
      testContext,
      stateHomeDirectory,
      `invalid-${String(index)}.sock`,
      (socket) => {
        socket.resume();
        socket.once("end", () => socket.end(invalidResponse));
      },
    );
    const record = await registerTarget(stateHomeDirectory, socketPath);

    await assert.rejects(
      deliverClaudeMessage({
        targetSession: record,
        envelope: messageEnvelope(),
        stateHomeDirectory,
      }),
    );

    assert.deepEqual(
      await listActiveSessions({ runtime: "claude" }, stateHomeDirectory),
      [record],
    );
  }
});

test("preserves a slow target and permits a later delivery without registration", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  let shouldAcknowledgeDelivery = false;
  let observeConnection: (() => void) | undefined;
  const connectionAccepted = new Promise<void>((resolveConnection) => {
    observeConnection = resolveConnection;
  });
  const { socketPath } = await listenOnPrivateSocket(
    testContext,
    stateHomeDirectory,
    "timeout.sock",
    (socket) => {
      observeConnection?.();
      socket.resume();
      socket.once("end", () => {
        if (shouldAcknowledgeDelivery) {
          socket.end(`${JSON.stringify({ delivered: true, messageId: messageIdentifier })}\n`);
        }
      });
    },
  );
  const slowTargetRecord = await registerTarget(stateHomeDirectory, socketPath);
  const delivery = deliverClaudeMessage({
    targetSession: slowTargetRecord,
    envelope: messageEnvelope(),
    stateHomeDirectory,
    timeoutMilliseconds: 30,
  });
  await connectionAccepted;

  await assert.rejects(delivery, (error: unknown) =>
    error instanceof ChannelTransportError && error.code === "TIMEOUT",
  );
  assert.deepEqual(
    await listActiveSessions({ runtime: "claude" }, stateHomeDirectory),
    [slowTargetRecord],
  );
  shouldAcknowledgeDelivery = true;
  assert.deepEqual(
    await deliverClaudeMessage({
      targetSession: slowTargetRecord,
      envelope: messageEnvelope(),
      stateHomeDirectory,
    }),
    { delivered: true, messageId: messageIdentifier },
  );
});

test("reports connection refusal distinctly and removes the unavailable generation", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const socketsDirectory = join(
    resolveBridgeStateDirectory(stateHomeDirectory),
    "sockets",
  );
  await mkdir(socketsDirectory, { recursive: true, mode: 0o700 });
  const socketPath = join(socketsDirectory, "refused.sock");
  const socketCreator = spawnSync(
    process.execPath,
    [
      "-e",
      "require('node:net').createServer().listen(process.argv[1], () => process.exit(0))",
      socketPath,
    ],
    { timeout: 5_000 },
  );
  assert.equal(socketCreator.status, 0);
  await chmod(socketPath, 0o600);
  const unavailableTargetRecord = await registerTarget(stateHomeDirectory, socketPath);

  await assert.rejects(
    deliverClaudeMessage({
      targetSession: unavailableTargetRecord,
      envelope: messageEnvelope(),
      stateHomeDirectory,
    }),
    (error: unknown) =>
      error instanceof ChannelTransportError && error.code === "ECONNREFUSED",
  );
  assert.equal(
    await activeSessionRegistrationIsOwned(unavailableTargetRecord, stateHomeDirectory),
    false,
  );
});

test("aborts an active delivery without contacting a replacement generation", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  let observeFirstConnection: (() => void) | undefined;
  const firstConnectionAccepted = new Promise<void>((resolveConnection) => {
    observeFirstConnection = resolveConnection;
  });
  const firstSocket = await listenOnPrivateSocket(
    testContext,
    stateHomeDirectory,
    "first.sock",
    (socket) => {
      observeFirstConnection?.();
      socket.resume();
    },
  );
  let replacementConnectionCount = 0;
  const replacementSocket = await listenOnPrivateSocket(
    testContext,
    stateHomeDirectory,
    "replacement.sock",
    (socket) => {
      replacementConnectionCount += 1;
      socket.destroy();
    },
  );
  const staleRecord = await registerTarget(
    stateHomeDirectory,
    firstSocket.socketPath,
  );
  const abortController = new AbortController();
  const delivery = deliverClaudeMessage({
    targetSession: staleRecord,
    envelope: messageEnvelope(),
    stateHomeDirectory,
    signal: abortController.signal,
  });
  await firstConnectionAccepted;
  const replacementRecord = await registerTarget(
    stateHomeDirectory,
    replacementSocket.socketPath,
    "2026-09-04T10:01:00.000Z",
  );

  abortController.abort();
  await assert.rejects(delivery, /aborted/u);

  assert.deepEqual(
    await listActiveSessions({ runtime: "claude" }, stateHomeDirectory),
    [replacementRecord],
  );
  assert.equal(replacementConnectionCount, 1);
});

test("preserves the current target generation after caller-requested cancellation", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  let observeConnection: (() => void) | undefined;
  const connectionAccepted = new Promise<void>((resolveConnection) => {
    observeConnection = resolveConnection;
  });
  const { socketPath } = await listenOnPrivateSocket(
    testContext,
    stateHomeDirectory,
    "cancel-current.sock",
    (socket) => {
      observeConnection?.();
      socket.resume();
    },
  );
  const record = await registerTarget(stateHomeDirectory, socketPath);
  const abortController = new AbortController();
  const delivery = deliverClaudeMessage({
    targetSession: record,
    envelope: messageEnvelope(),
    stateHomeDirectory,
    signal: abortController.signal,
  });
  await connectionAccepted;

  abortController.abort();
  await assert.rejects(delivery, /aborted/u);

  assert.deepEqual(
    await listActiveSessions({ runtime: "claude" }, stateHomeDirectory),
    [record],
  );
});

test("rejects invalid routes before opening the target transport", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  let connectionCount = 0;
  const { socketPath } = await listenOnPrivateSocket(
    testContext,
    stateHomeDirectory,
    "route.sock",
    (socket) => {
      connectionCount += 1;
      socket.destroy();
    },
  );
  const record = await registerTarget(stateHomeDirectory, socketPath);
  const invalidEnvelope = messageEnvelope();
  invalidEnvelope.recipient = {
    ...invalidEnvelope.recipient,
    sessionId: "ea7220bc-cd1e-41f0-bf7f-413982f18a9c",
  };

  await assert.rejects(
    deliverClaudeMessage({
      targetSession: record,
      envelope: invalidEnvelope,
      stateHomeDirectory,
    }),
    /route/u,
  );
  assert.equal(connectionCount, 0);
});

test("fails an offline target without attempting transport fallback", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const offlineSocketPath = join(
    resolveBridgeStateDirectory(stateHomeDirectory),
    "sockets",
    "offline.sock",
  );

  await assert.rejects(
    deliverClaudeMessage({
      targetSession: targetRecord(offlineSocketPath),
      envelope: messageEnvelope(),
      stateHomeDirectory,
    }),
    /not active/u,
  );
  assert.deepEqual(
    await listActiveSessions({ runtime: "claude" }, stateHomeDirectory),
    [],
  );
});
