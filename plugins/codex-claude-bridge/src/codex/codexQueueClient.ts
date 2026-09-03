import { spawn, type ChildProcess } from "node:child_process";

import {
  parseAgentMessageEnvelope,
  type AgentMessageEnvelope,
} from "../protocol/messageEnvelope.js";

interface SpawnOptions {
  detached: true;
  shell: false;
  stdio: ["ignore", "ignore", "pipe"];
}

export type SpawnCodexProcess = (
  executablePath: string,
  commandArguments: string[],
  options: SpawnOptions,
) => ChildProcess;

export interface QueueCodexMessageOptions {
  targetSessionId: string;
  envelope: AgentMessageEnvelope;
  codexExecutablePath?: string;
  spawnProcess?: SpawnCodexProcess;
  timeoutMilliseconds?: number;
}

const defaultTimeoutMilliseconds = 10_000;
const maximumCapturedStderrBytes = 4_096;
const forceKillGraceMilliseconds = 250;

function signalCodexProcessGroup(
  childProcess: ChildProcess,
  terminationSignal: NodeJS.Signals,
): void {
  if (childProcess.pid === undefined) {
    throw new Error("codex queue process identifier is unavailable");
  }

  try {
    process.kill(-childProcess.pid, terminationSignal);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return;
    }
    throw error;
  }
}

function signalDirectChildFallback(
  childProcess: ChildProcess,
  terminationSignal: NodeJS.Signals,
): void {
  try {
    childProcess.kill(terminationSignal);
  } catch {
    return;
  }
}

function validateTimeoutMilliseconds(timeoutMilliseconds: number): number {
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1 ||
    timeoutMilliseconds > 60_000
  ) {
    throw new RangeError("Codex queue timeout must be between 1 and 60000 milliseconds");
  }

  return timeoutMilliseconds;
}

function validateQueueEnvelope(
  targetSessionIdentifier: string,
  inputEnvelope: AgentMessageEnvelope,
): AgentMessageEnvelope {
  const envelope = parseAgentMessageEnvelope(inputEnvelope);
  if (
    envelope.sender.runtime !== "claude" ||
    envelope.recipient.runtime !== "codex" ||
    envelope.recipient.sessionId !== targetSessionIdentifier
  ) {
    throw new TypeError("Codex queue envelope route is invalid");
  }
  if (
    envelope.replyRoute !== undefined &&
    (envelope.replyRoute.runtime !== "claude" ||
      envelope.replyRoute.sessionId !== envelope.sender.sessionId ||
      envelope.replyRoute.projectId !== envelope.sender.projectId)
  ) {
    throw new TypeError("Codex queue reply route is invalid");
  }

  return envelope;
}

function serializeInboundCodexMessage(envelope: AgentMessageEnvelope): string {
  return [
    "codex-claude-bridge/v1",
    `conversation_id=${envelope.conversationId}`,
    `sender_session_id=${envelope.sender.sessionId}`,
    `message_type=${envelope.messageType}`,
    `reply_command=codex-claude-bridge reply --conversation ${envelope.conversationId} --message <text>`,
    `content_json=${JSON.stringify(envelope.content)}`,
  ].join("\n");
}

function sanitizeStderr(stderrBytes: Buffer): string {
  return stderrBytes
    .toString("utf8")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export async function queueCodexMessage(
  options: QueueCodexMessageOptions,
): Promise<void> {
  const envelope = validateQueueEnvelope(
    options.targetSessionId,
    options.envelope,
  );
  const timeoutMilliseconds = validateTimeoutMilliseconds(
    options.timeoutMilliseconds ?? defaultTimeoutMilliseconds,
  );
  const spawnProcess = options.spawnProcess ?? (spawn as SpawnCodexProcess);
  const commandArguments = [
    "queue",
    "--thread",
    options.targetSessionId,
    "--message",
    serializeInboundCodexMessage(envelope),
  ];

  await new Promise<void>((resolveQueue, rejectQueue) => {
    let queueSettled = false;
    let queueTimedOut = false;
    let childProcessClosed = false;
    let forceKillAttemptCompleted = false;
    let forceKillError: Error | undefined;
    let capturedStderrBytes = Buffer.alloc(0);
    const childProcess = spawnProcess(
      options.codexExecutablePath ?? "codex",
      commandArguments,
      {
        detached: true,
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    const settleQueue = (error?: Error) => {
      if (queueSettled) {
        return;
      }
      queueSettled = true;
      clearTimeout(queueTimeout);
      if (error === undefined) {
        resolveQueue();
      } else {
        rejectQueue(error);
      }
    };
    const settleTimedOutQueue = () => {
      if (queueTimedOut && childProcessClosed && forceKillAttemptCompleted) {
        settleQueue(forceKillError ?? new Error("codex queue timed out"));
      }
    };
    const queueTimeout = setTimeout(() => {
      queueTimedOut = true;
      try {
        signalCodexProcessGroup(childProcess, "SIGTERM");
      } catch {
        signalDirectChildFallback(childProcess, "SIGTERM");
      }
      setTimeout(() => {
        try {
          signalCodexProcessGroup(childProcess, "SIGKILL");
        } catch {
          forceKillError = new Error(
            "codex queue timed out and its process group could not be force killed",
          );
          signalDirectChildFallback(childProcess, "SIGKILL");
        }
        forceKillAttemptCompleted = true;
        settleTimedOutQueue();
      }, forceKillGraceMilliseconds);
    }, timeoutMilliseconds);

    childProcess.stderr?.on("data", (chunk: Buffer | string) => {
      const chunkBytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remainingByteCapacity =
        maximumCapturedStderrBytes - capturedStderrBytes.length;
      if (remainingByteCapacity > 0) {
        capturedStderrBytes = Buffer.concat([
          capturedStderrBytes,
          chunkBytes.subarray(0, remainingByteCapacity),
        ]);
      }
    });
    childProcess.once("error", () => {
      if (queueTimedOut) {
        return;
      }
      settleQueue(new Error("codex queue could not be started"));
    });
    childProcess.once("close", (exitCode, terminationSignal) => {
      childProcessClosed = true;
      if (queueTimedOut) {
        settleTimedOutQueue();
        return;
      }
      if (exitCode === 0) {
        settleQueue();
        return;
      }

      const sanitizedStderr = sanitizeStderr(capturedStderrBytes);
      const failureStatus =
        exitCode === null
          ? `signal ${terminationSignal ?? "unknown"}`
          : `exit code ${exitCode}`;
      settleQueue(
        new Error(
          `codex queue failed with ${failureStatus}${
            sanitizedStderr.length > 0 ? `: ${sanitizedStderr}` : ""
          }`,
        ),
      );
    });
  });
}
