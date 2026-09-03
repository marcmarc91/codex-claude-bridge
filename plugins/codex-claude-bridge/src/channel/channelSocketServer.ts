import { randomBytes } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";

import {
  parseAgentMessageEnvelope,
  type AgentMessageEnvelope,
} from "../protocol/messageEnvelope.js";
import {
  activeSessionRegistrationIsOwned,
  findActiveSession,
  registerActiveSession,
  unregisterActiveSessionGeneration,
  type ActiveSessionRecord,
} from "../registry/activeSessionRegistry.js";
import {
  ensurePrivateBridgeDirectory,
  prepareSecureBridgeState,
  resolveSecureBridgeOwnedPath,
  type SecureBridgeStateContext,
} from "../registry/secureStateFilesystem.js";

export type ChannelDeliveryResponse =
  | { delivered: true; messageId: string }
  | { delivered: false; error: string };

export interface ChannelOwningSession {
  sessionId: string;
  displayName: string;
  processId: number;
  workingDirectory: string;
  projectId: string;
}

export interface StartChannelSocketServerOptions {
  owningSession: ChannelOwningSession;
  deliverEnvelope: (
    envelope: AgentMessageEnvelope,
    abortSignal: AbortSignal,
  ) => Promise<void>;
  stateHomeDirectory?: string;
  maximumConcurrentConnections?: number;
  readTimeoutMilliseconds?: number;
  writeTimeoutMilliseconds?: number;
  notificationTimeoutMilliseconds?: number;
  randomSocketIdentifier?: () => string;
}

export interface ChannelSocketServer {
  socketPath: string;
  close(): Promise<void>;
}

interface SocketIdentity {
  deviceIdentifier: number;
  inodeIdentifier: number;
}

const maximumTransportFrameBytes = 131_072;
const defaultMaximumConcurrentConnections = 16;
const defaultReadTimeoutMilliseconds = 2_000;
const defaultWriteTimeoutMilliseconds = 2_000;
const defaultNotificationTimeoutMilliseconds = 5_000;
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function validatePositiveInteger(value: number, description: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${description} must be a positive integer`);
  }

  return value;
}

function validateTimeout(value: number, description: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new RangeError(`${description} must be between 1 and 60000 milliseconds`);
  }

  return value;
}

function validateEnvelopeRoute(
  envelope: AgentMessageEnvelope,
  owningRecord: ActiveSessionRecord,
): void {
  if (
    envelope.recipient.runtime !== "claude" ||
    envelope.recipient.sessionId !== owningRecord.sessionId ||
    envelope.recipient.projectId !== owningRecord.projectId
  ) {
    throw new Error("Envelope recipient does not match this Claude session");
  }
  if (envelope.sender.runtime !== "codex") {
    throw new Error("Envelope sender is not a Codex session");
  }
  if (
    envelope.replyRoute !== undefined &&
    (envelope.replyRoute.runtime !== "codex" ||
      envelope.replyRoute.sessionId !== envelope.sender.sessionId ||
      envelope.replyRoute.projectId !== envelope.sender.projectId)
  ) {
    throw new Error("Envelope reply route does not match its sender");
  }
}

async function awaitWithTimeout(
  operation: (abortSignal: AbortSignal) => Promise<void>,
  timeoutMilliseconds: number,
): Promise<void> {
  const abortController = new AbortController();
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, rejectTimeout) => {
    timeoutHandle = setTimeout(() => {
      abortController.abort();
      rejectTimeout(new Error("Channel notification timed out"));
    }, timeoutMilliseconds);
  });

  try {
    await Promise.race([operation(abortController.signal), timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

function writeSingleResponse(
  socket: Socket,
  response: ChannelDeliveryResponse,
  timeoutMilliseconds: number,
): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    let writeFinished = false;
    const finishWrite = (error?: Error) => {
      if (writeFinished) {
        return;
      }
      writeFinished = true;
      clearTimeout(timeoutHandle);
      socket.destroy();
      if (error === undefined) {
        resolveWrite();
      } else {
        rejectWrite(error);
      }
    };
    const timeoutHandle = setTimeout(
      () => finishWrite(new Error("Channel response write timed out")),
      timeoutMilliseconds,
    );

    socket.end(`${JSON.stringify(response)}\n`, () => finishWrite());
    socket.once("error", (error) => finishWrite(error));
  });
}

async function parseSingleEnvelopeFrame(
  receivedBytes: Buffer,
): Promise<AgentMessageEnvelope> {
  const newlineOffset = receivedBytes.indexOf(0x0a);
  if (newlineOffset < 0) {
    throw new Error("Channel frame ended before its newline terminator");
  }

  const trailingBytes = receivedBytes.subarray(newlineOffset + 1);
  if (!/^\s*$/u.test(strictUtf8Decoder.decode(trailingBytes))) {
    throw new Error("Channel connection contained more than one envelope");
  }

  const frameBytes = receivedBytes.subarray(0, newlineOffset);
  if (frameBytes.length === 0) {
    throw new Error("Channel envelope is empty");
  }

  return parseAgentMessageEnvelope(
    JSON.parse(strictUtf8Decoder.decode(frameBytes)) as unknown,
  );
}

function errorResponse(error: unknown): ChannelDeliveryResponse {
  const knownMessages = new Set([
    "Channel frame ended before its newline terminator",
    "Channel connection contained more than one envelope",
    "Channel envelope is empty",
    "Channel registration is no longer owned",
    "Sender Codex session is not active",
    "Channel notification timed out",
  ]);
  const message = error instanceof Error ? error.message : "";
  return {
    delivered: false,
    error: knownMessages.has(message) ? message : "Invalid channel envelope",
  };
}

async function closeListeningServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) {
        resolveClose();
      } else {
        rejectClose(error);
      }
    });
  });
}

async function removeOwnedSocket(
  bridgeStateContext: SecureBridgeStateContext,
  socketPath: string,
  socketIdentity: SocketIdentity,
): Promise<void> {
  const canonicalSocketPath = resolveSecureBridgeOwnedPath(
    bridgeStateContext,
    socketPath,
  );
  await ensurePrivateBridgeDirectory(
    bridgeStateContext,
    dirname(canonicalSocketPath),
    false,
  );

  let socketStatus;
  try {
    socketStatus = await lstat(canonicalSocketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (
    socketStatus.isSocket() &&
    socketStatus.dev === socketIdentity.deviceIdentifier &&
    socketStatus.ino === socketIdentity.inodeIdentifier
  ) {
    await unlink(canonicalSocketPath);
  }
}

async function listenOnRandomSocket(
  socketsDirectory: string,
  createRandomSocketIdentifier: () => string,
): Promise<{ server: Server; socketPath: string; socketIdentity: SocketIdentity }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const randomSocketIdentifier = createRandomSocketIdentifier();
    if (!/^[a-f0-9]{16}$/u.test(randomSocketIdentifier)) {
      throw new Error("Random socket identifier must contain 16 lowercase hexadecimal characters");
    }
    const socketPath = join(
      socketsDirectory,
      `c-${randomSocketIdentifier}.sock`,
    );
    const server = createServer({ allowHalfOpen: true });
    let socketWasCreated = false;
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(socketPath, resolveListen);
      });
      socketWasCreated = true;
      server.removeAllListeners("error");
      await chmod(socketPath, 0o600);
      const socketStatus = await lstat(socketPath);
      if (
        !socketStatus.isSocket() ||
        (typeof process.getuid === "function" && socketStatus.uid !== process.getuid()) ||
        (socketStatus.mode & 0o7777) !== 0o600
      ) {
        throw new Error("Channel socket is not private");
      }
      return {
        server,
        socketPath,
        socketIdentity: {
          deviceIdentifier: socketStatus.dev,
          inodeIdentifier: socketStatus.ino,
        },
      };
    } catch (error) {
      await closeListeningServer(server).catch(() => undefined);
      if (socketWasCreated) {
        await unlink(socketPath).catch(() => undefined);
      }
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw error;
      }
    }
  }

  throw new Error("Could not allocate a unique Channel socket path");
}

export async function startChannelSocketServer(
  options: StartChannelSocketServerOptions,
): Promise<ChannelSocketServer> {
  const maximumConcurrentConnections = validatePositiveInteger(
    options.maximumConcurrentConnections ?? defaultMaximumConcurrentConnections,
    "Maximum concurrent connections",
  );
  const readTimeoutMilliseconds = validateTimeout(
    options.readTimeoutMilliseconds ?? defaultReadTimeoutMilliseconds,
    "Read timeout",
  );
  const writeTimeoutMilliseconds = validateTimeout(
    options.writeTimeoutMilliseconds ?? defaultWriteTimeoutMilliseconds,
    "Write timeout",
  );
  const notificationTimeoutMilliseconds = validateTimeout(
    options.notificationTimeoutMilliseconds ??
      defaultNotificationTimeoutMilliseconds,
    "Notification timeout",
  );
  const bridgeStateContext = await prepareSecureBridgeState(
    options.stateHomeDirectory,
  );
  const socketsDirectory = join(
    bridgeStateContext.configuredBridgeStateDirectory,
    "sockets",
  );
  await ensurePrivateBridgeDirectory(
    bridgeStateContext,
    socketsDirectory,
    true,
  );
  const listeningSocket = await listenOnRandomSocket(
    socketsDirectory,
    options.randomSocketIdentifier ?? (() => randomBytes(8).toString("hex")),
  );
  const owningRecord: ActiveSessionRecord = {
    schemaVersion: 1,
    runtime: "claude",
    ...options.owningSession,
    socketPath: listeningSocket.socketPath,
    registeredAt: new Date().toISOString(),
  };
  const connectedSockets = new Set<Socket>();
  let closing = false;
  let closePromise: Promise<void> | undefined;

  const processConnection = async (socket: Socket): Promise<void> => {
    if (closing || connectedSockets.size >= maximumConcurrentConnections) {
      await writeSingleResponse(
        socket,
        {
          delivered: false,
          error: closing
            ? "Channel server is closing"
            : "Channel connection capacity exceeded",
        },
        writeTimeoutMilliseconds,
      ).catch(() => socket.destroy());
      return;
    }

    connectedSockets.add(socket);
    const receivedChunks: Buffer[] = [];
    let receivedByteCount = 0;
    let responseStarted = false;
    const respond = async (response: ChannelDeliveryResponse): Promise<void> => {
      if (responseStarted) {
        return;
      }
      responseStarted = true;
      socket.setTimeout(0);
      await writeSingleResponse(socket, response, writeTimeoutMilliseconds);
    };

    socket.setTimeout(readTimeoutMilliseconds);
    socket.on("data", (chunk: Buffer) => {
      if (responseStarted) {
        return;
      }
      receivedByteCount += chunk.length;
      if (receivedByteCount > maximumTransportFrameBytes) {
        socket.pause();
        void respond({
          delivered: false,
          error: "Channel frame exceeds 131072 UTF-8 bytes",
        }).catch(() => socket.destroy());
        return;
      }
      receivedChunks.push(chunk);
    });
    socket.once("timeout", () => {
      void respond({
        delivered: false,
        error: "Channel read timed out",
      }).catch(() => socket.destroy());
    });
    socket.once("end", () => {
      if (responseStarted) {
        return;
      }
      void (async () => {
        try {
          const envelope = await parseSingleEnvelopeFrame(
            Buffer.concat(receivedChunks, receivedByteCount),
          );
          validateEnvelopeRoute(envelope, owningRecord);
          if (
            !(await activeSessionRegistrationIsOwned(
              owningRecord,
              options.stateHomeDirectory,
            ))
          ) {
            throw new Error("Channel registration is no longer owned");
          }
          const senderSession = await findActiveSession(
            envelope.sender.sessionId,
            { runtime: "codex", projectId: envelope.sender.projectId },
            options.stateHomeDirectory,
          );
          if (senderSession?.sessionId !== envelope.sender.sessionId) {
            throw new Error("Sender Codex session is not active");
          }
          await awaitWithTimeout(
            (abortSignal) => options.deliverEnvelope(envelope, abortSignal),
            notificationTimeoutMilliseconds,
          );
          await respond({ delivered: true, messageId: envelope.messageId });
        } catch (error) {
          await respond(errorResponse(error));
        }
      })().catch(() => socket.destroy());
    });
    socket.once("close", () => connectedSockets.delete(socket));
    socket.once("error", () => socket.destroy());
  };

  listeningSocket.server.on("connection", (socket) => {
    void processConnection(socket);
  });

  try {
    await registerActiveSession(owningRecord, options.stateHomeDirectory);
  } catch (error) {
    await closeListeningServer(listeningSocket.server).catch(() => undefined);
    await removeOwnedSocket(
      bridgeStateContext,
      listeningSocket.socketPath,
      listeningSocket.socketIdentity,
    ).catch(() => undefined);
    throw error;
  }

  return {
    socketPath: listeningSocket.socketPath,
    close(): Promise<void> {
      if (closePromise !== undefined) {
        return closePromise;
      }
      closing = true;
      closePromise = (async () => {
        for (const socket of connectedSockets) {
          socket.destroy();
        }
        const cleanupResults = await Promise.allSettled([
          closeListeningServer(listeningSocket.server),
          removeOwnedSocket(
            bridgeStateContext,
            listeningSocket.socketPath,
            listeningSocket.socketIdentity,
          ),
          unregisterActiveSessionGeneration(
            owningRecord,
            options.stateHomeDirectory,
          ),
        ]);
        const cleanupErrors = cleanupResults
          .filter(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          )
          .map((result) => result.reason);
        if (cleanupErrors.length > 0) {
          throw new AggregateError(cleanupErrors, "Channel server cleanup failed");
        }
      })();
      return closePromise;
    },
  };
}
