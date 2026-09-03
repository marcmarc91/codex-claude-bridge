import { randomBytes } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";

import {
  maximumSerializedAgentMessageEnvelopeFrameUtf8Bytes,
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
  processingTimeoutMilliseconds?: number;
  randomSocketIdentifier?: () => string;
  scheduleReadDeadline?: (
    deadlineReached: () => void,
    timeoutMilliseconds: number,
  ) => () => void;
}

export interface ChannelSocketServer {
  socketPath: string;
  close(): Promise<void>;
}

interface SocketIdentity {
  deviceIdentifier: number;
  inodeIdentifier: number;
}

const maximumTransportFrameBytes =
  maximumSerializedAgentMessageEnvelopeFrameUtf8Bytes;
const defaultMaximumConcurrentConnections = 16;
const defaultReadTimeoutMilliseconds = 2_000;
const defaultWriteTimeoutMilliseconds = 2_000;
const defaultProcessingTimeoutMilliseconds = 5_000;
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

async function awaitProcessingSettlement(
  operation: (abortSignal: AbortSignal) => Promise<void>,
  timeoutMilliseconds: number,
  shutdownSignal: AbortSignal,
): Promise<void> {
  const deadlineAbortController = new AbortController();
  const processingAbortSignal = AbortSignal.any([
    shutdownSignal,
    deadlineAbortController.signal,
  ]);
  let processingTimedOut = false;
  const timeoutHandle = setTimeout(() => {
    processingTimedOut = true;
    deadlineAbortController.abort();
  }, timeoutMilliseconds);
  let operationError: unknown;

  try {
    await operation(processingAbortSignal);
  } catch (error) {
    operationError = error;
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (processingTimedOut) {
    throw new Error("Channel notification timed out");
  }
  if (shutdownSignal.aborted) {
    throw new Error("Channel server is closing");
  }
  if (operationError !== undefined) {
    throw operationError;
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

  if (receivedBytes.length !== newlineOffset + 1) {
    throw new Error("Channel connection contained more than one envelope");
  }

  const frameEndOffset =
    newlineOffset > 0 && receivedBytes[newlineOffset - 1] === 0x0d
      ? newlineOffset - 1
      : newlineOffset;
  const frameBytes = receivedBytes.subarray(0, frameEndOffset);
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
    if (Buffer.byteLength(socketPath, "utf8") > 103) {
      throw new Error("Channel socket path must not exceed 103 UTF-8 bytes");
    }
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
  const processingTimeoutMilliseconds = validateTimeout(
    options.processingTimeoutMilliseconds ?? defaultProcessingTimeoutMilliseconds,
    "Processing timeout",
  );
  const scheduleReadDeadline =
    options.scheduleReadDeadline ??
    ((deadlineReached: () => void, timeoutMilliseconds: number) => {
      const timeoutHandle = setTimeout(deadlineReached, timeoutMilliseconds);
      return () => clearTimeout(timeoutHandle);
    });
  const bridgeStateContext = await prepareSecureBridgeState(
    options.stateHomeDirectory,
  );
  const canonicalStateHomeDirectory =
    bridgeStateContext.canonicalStateTrustRootDirectory;
  const socketsDirectory = join(
    bridgeStateContext.bridgeStateDirectory,
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
  const inFlightConnectionCompletions = new Set<Promise<void>>();
  const connectionProcessingAbortControllers = new Set<AbortController>();
  let closing = false;
  let closePromise: Promise<void> | undefined;

  const processConnection = async (socket: Socket): Promise<void> => {
    const connectionProcessingAbortController = new AbortController();
    connectionProcessingAbortControllers.add(
      connectionProcessingAbortController,
    );
    let completeConnection: (() => void) | undefined;
    const connectionCompletion = new Promise<void>((resolveCompletion) => {
      completeConnection = resolveCompletion;
    });
    inFlightConnectionCompletions.add(connectionCompletion);
    void connectionCompletion.then(() => {
      inFlightConnectionCompletions.delete(connectionCompletion);
    });
    const receivedChunks: Buffer[] = [];
    let receivedByteCount = 0;
    let responseStarted = false;
    let processingStarted = false;
    let connectionFinished = false;
    let cancelReadDeadline: (() => void) | undefined;
    const clearReadDeadline = () => {
      if (cancelReadDeadline !== undefined) {
        cancelReadDeadline();
        cancelReadDeadline = undefined;
      }
    };
    const finishConnection = () => {
      if (connectionFinished) {
        return;
      }
      connectionFinished = true;
      clearReadDeadline();
      connectedSockets.delete(socket);
      connectionProcessingAbortControllers.delete(
        connectionProcessingAbortController,
      );
      completeConnection?.();
    };
    const respond = async (response: ChannelDeliveryResponse): Promise<void> => {
      if (responseStarted) {
        return;
      }
      responseStarted = true;
      clearReadDeadline();
      try {
        await writeSingleResponse(socket, response, writeTimeoutMilliseconds);
      } finally {
        finishConnection();
      }
    };

    cancelReadDeadline = scheduleReadDeadline(() => {
      cancelReadDeadline = undefined;
      void respond({
        delivered: false,
        error: "Channel read timed out",
      }).catch(() => socket.destroy());
    }, readTimeoutMilliseconds);
    socket.on("data", (chunk: Buffer) => {
      if (responseStarted) {
        return;
      }
      receivedByteCount += chunk.length;
      if (receivedByteCount > maximumTransportFrameBytes) {
        socket.pause();
        clearReadDeadline();
        void respond({
          delivered: false,
          error: "Channel frame exceeds maximum encoded envelope size",
        }).catch(() => socket.destroy());
        return;
      }
      receivedChunks.push(chunk);
    });
    socket.once("end", () => {
      clearReadDeadline();
      if (responseStarted) {
        return;
      }
      processingStarted = true;
      void (async () => {
        try {
          const envelope = await parseSingleEnvelopeFrame(
            Buffer.concat(receivedChunks, receivedByteCount),
          );
          validateEnvelopeRoute(envelope, owningRecord);
          if (
            !(await activeSessionRegistrationIsOwned(
              owningRecord,
              canonicalStateHomeDirectory,
            ))
          ) {
            throw new Error("Channel registration is no longer owned");
          }
          const senderSession = await findActiveSession(
            envelope.sender.sessionId,
            { runtime: "codex", projectId: envelope.sender.projectId },
            canonicalStateHomeDirectory,
          );
          if (senderSession?.sessionId !== envelope.sender.sessionId) {
            throw new Error("Sender Codex session is not active");
          }
          await awaitProcessingSettlement(
            (abortSignal) => options.deliverEnvelope(envelope, abortSignal),
            processingTimeoutMilliseconds,
            connectionProcessingAbortController.signal,
          );
          await respond({ delivered: true, messageId: envelope.messageId });
        } catch (error) {
          await respond(errorResponse(error));
        }
      })().catch(() => {
        socket.destroy();
        finishConnection();
      });
    });
    socket.once("close", () => {
      clearReadDeadline();
      if (!processingStarted && !responseStarted) {
        finishConnection();
      }
    });
    socket.once("error", () => {
      clearReadDeadline();
      socket.destroy();
      if (!processingStarted && !responseStarted) {
        finishConnection();
      }
    });
  };

  listeningSocket.server.on("connection", (socket) => {
    if (closing || connectedSockets.size >= maximumConcurrentConnections) {
      socket.destroy();
      return;
    }
    connectedSockets.add(socket);
    void processConnection(socket);
  });

  try {
    await registerActiveSession(owningRecord, canonicalStateHomeDirectory);
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
        const stopAcceptingConnections = closeListeningServer(
          listeningSocket.server,
        );
        for (const connectionProcessingAbortController of connectionProcessingAbortControllers) {
          connectionProcessingAbortController.abort();
        }
        for (const socket of connectedSockets) {
          socket.destroy();
        }
        await Promise.allSettled([...inFlightConnectionCompletions]);
        const cleanupResults = await Promise.allSettled([
          stopAcceptingConnections,
          removeOwnedSocket(
            bridgeStateContext,
            listeningSocket.socketPath,
            listeningSocket.socketIdentity,
          ),
          unregisterActiveSessionGeneration(
            owningRecord,
            canonicalStateHomeDirectory,
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
