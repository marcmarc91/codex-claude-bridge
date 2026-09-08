import { Buffer } from "node:buffer";
import { lstat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { dirname } from "node:path";
import { TextDecoder } from "node:util";

import { z } from "zod";

import {
  parseAgentMessageEnvelope,
  serializeAgentMessageEnvelope,
  uuidSchema,
  type AgentMessageEnvelope,
} from "../protocol/messageEnvelope.js";
import {
  activeSessionRegistrationIsOwned,
  unregisterActiveSessionGeneration,
  type ActiveSessionRecord,
} from "../registry/activeSessionRegistry.js";
import {
  ensurePrivateBridgeDirectory,
  prepareSecureBridgeState,
  resolveSecureBridgeOwnedPath,
} from "../registry/secureStateFilesystem.js";
import type { ChannelDeliveryResponse } from "./channelSocketServer.js";

export interface DeliverClaudeMessageOptions {
  targetSession: ActiveSessionRecord;
  envelope: AgentMessageEnvelope;
  stateHomeDirectory?: string;
  timeoutMilliseconds?: number;
  signal?: AbortSignal;
}

const maximumResponseErrorUtf8Bytes = 4_096;
const defaultTimeoutMilliseconds = 5_000;
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export class ChannelTransportError extends Error {
  constructor(
    readonly code: "TIMEOUT" | "ECONNREFUSED" | "ENOENT" | "TRANSPORT_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "ChannelTransportError";
  }
}

class ChannelDeliveryAbortedError extends Error {
  constructor() {
    super("Channel delivery aborted");
    this.name = "ChannelDeliveryAbortedError";
  }
}

const channelDeliveryResponseSchema = z.discriminatedUnion("delivered", [
  z
    .object({
      delivered: z.literal(true),
      messageId: uuidSchema,
    })
    .strict(),
  z
    .object({
      delivered: z.literal(false),
      error: z
        .string()
        .min(1)
        .refine(
          (value) =>
            Buffer.byteLength(value, "utf8") <= maximumResponseErrorUtf8Bytes,
        ),
    })
    .strict(),
]);

const maximumResponseFrameUtf8Bytes = Buffer.byteLength(
  `${JSON.stringify({
    delivered: false,
    error: "\0".repeat(maximumResponseErrorUtf8Bytes),
  })}\n`,
  "utf8",
);

function validateTimeoutMilliseconds(timeoutMilliseconds: number): number {
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1 ||
    timeoutMilliseconds > 60_000
  ) {
    throw new RangeError("Channel delivery timeout must be between 1 and 60000 milliseconds");
  }
  return timeoutMilliseconds;
}

function validateDeliveryRoute(
  inputEnvelope: AgentMessageEnvelope,
  targetSession: ActiveSessionRecord,
): AgentMessageEnvelope {
  const envelope = parseAgentMessageEnvelope(inputEnvelope);
  if (
    targetSession.runtime !== "claude" ||
    targetSession.socketPath === undefined ||
    envelope.sender.runtime !== "codex" ||
    envelope.recipient.runtime !== "claude" ||
    envelope.recipient.sessionId !== targetSession.sessionId ||
    envelope.recipient.projectId !== targetSession.projectId
  ) {
    throw new TypeError("Claude delivery route is invalid");
  }
  if (
    envelope.replyRoute !== undefined &&
    (envelope.replyRoute.runtime !== "codex" ||
      envelope.replyRoute.sessionId !== envelope.sender.sessionId ||
      envelope.replyRoute.projectId !== envelope.sender.projectId)
  ) {
    throw new TypeError("Claude delivery reply route is invalid");
  }
  return envelope;
}

function parseResponseFrame(
  receivedBytes: Buffer,
  expectedMessageIdentifier: string,
): ChannelDeliveryResponse {
  const newlineOffset = receivedBytes.indexOf(0x0a);
  if (newlineOffset < 0 || receivedBytes.length !== newlineOffset + 1) {
    throw new Error("Channel response must contain exactly one terminated frame");
  }
  const frameEndOffset =
    newlineOffset > 0 && receivedBytes[newlineOffset - 1] === 0x0d
      ? newlineOffset - 1
      : newlineOffset;
  const response = channelDeliveryResponseSchema.parse(
    JSON.parse(
      strictUtf8Decoder.decode(receivedBytes.subarray(0, frameEndOffset)),
    ),
  );
  if (response.delivered && response.messageId !== expectedMessageIdentifier) {
    throw new Error("Channel acknowledgement message ID does not match");
  }
  return response;
}

function exchangeSingleFrame(
  socketPath: string,
  serializedEnvelope: string,
  expectedMessageIdentifier: string,
  timeoutMilliseconds: number,
  signal?: AbortSignal,
): Promise<ChannelDeliveryResponse> {
  return new Promise((resolveExchange, rejectExchange) => {
    let settled = false;
    let receivedByteCount = 0;
    const receivedChunks: Buffer[] = [];
    let socket: Socket | undefined;
    const settle = (
      error?: Error,
      response?: ChannelDeliveryResponse,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", abortExchange);
      socket?.destroy();
      if (error !== undefined) {
        rejectExchange(error);
      } else {
        resolveExchange(response!);
      }
    };
    const abortExchange = () => settle(new ChannelDeliveryAbortedError());
    const timeoutHandle = setTimeout(
      () => settle(new ChannelTransportError(
        "TIMEOUT",
        "Channel delivery timed out; delivery status is unknown",
      )),
      timeoutMilliseconds,
    );

    if (signal?.aborted === true) {
      abortExchange();
      return;
    }
    signal?.addEventListener("abort", abortExchange, { once: true });
    socket = connect({ path: socketPath, allowHalfOpen: true });
    socket.once("connect", () => {
      socket?.end(`${serializedEnvelope}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      receivedByteCount += chunk.length;
      if (receivedByteCount > maximumResponseFrameUtf8Bytes) {
        settle(new Error("Channel response exceeds maximum size"));
        return;
      }
      receivedChunks.push(chunk);
    });
    socket.once("end", () => {
      try {
        settle(
          undefined,
          parseResponseFrame(
            Buffer.concat(receivedChunks, receivedByteCount),
            expectedMessageIdentifier,
          ),
        );
      } catch (error) {
        settle(error instanceof Error ? error : new Error("Invalid Channel response"));
      }
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") {
        settle(new ChannelTransportError(
          "ECONNREFUSED",
          "Claude Channel connection refused",
        ));
      } else if (error.code === "ENOENT") {
        settle(new ChannelTransportError(
          "ENOENT",
          "Claude Channel socket is missing",
        ));
      } else {
        settle(new ChannelTransportError(
          "TRANSPORT_ERROR",
          "Claude Channel transport failed; delivery status is unknown",
        ));
      }
    });
    socket.once("close", () => {
      if (!settled) {
        settle(new Error("Claude Channel closed without a response"));
      }
    });
  });
}

export async function deliverClaudeMessage(
  options: DeliverClaudeMessageOptions,
): Promise<ChannelDeliveryResponse> {
  const envelope = validateDeliveryRoute(options.envelope, options.targetSession);
  const timeoutMilliseconds = validateTimeoutMilliseconds(
    options.timeoutMilliseconds ?? defaultTimeoutMilliseconds,
  );
  let targetRegistrationIsOwned = false;
  try {
    targetRegistrationIsOwned = await activeSessionRegistrationIsOwned(
      options.targetSession,
      options.stateHomeDirectory,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (!targetRegistrationIsOwned) {
    await unregisterActiveSessionGeneration(
      options.targetSession,
      options.stateHomeDirectory,
    ).catch(() => undefined);
    throw new Error("Target Claude session is not active");
  }

  const bridgeStateContext = await prepareSecureBridgeState(
    options.stateHomeDirectory,
  );
  const socketPath = resolveSecureBridgeOwnedPath(
    bridgeStateContext,
    options.targetSession.socketPath!,
  );
  try {
    await ensurePrivateBridgeDirectory(
      bridgeStateContext,
      dirname(socketPath),
      false,
    );
    const socketStatus = await lstat(socketPath);
    if (
      socketStatus.isSymbolicLink() ||
      !socketStatus.isSocket() ||
      socketStatus.uid !== bridgeStateContext.userIdentifier ||
      (socketStatus.mode & 0o7777) !== 0o600
    ) {
      throw new Error("Target Claude socket is not private");
    }
    return await exchangeSingleFrame(
      socketPath,
      serializeAgentMessageEnvelope(envelope),
      envelope.messageId,
      timeoutMilliseconds,
      options.signal,
    );
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ECONNREFUSED" || errorCode === "ENOENT") {
      await unregisterActiveSessionGeneration(
        options.targetSession,
        options.stateHomeDirectory,
      ).catch(() => undefined);
    }
    throw error;
  }
}
