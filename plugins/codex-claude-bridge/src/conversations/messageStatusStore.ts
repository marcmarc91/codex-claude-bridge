import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { z } from "zod";

import {
  parseAgentMessageEnvelope,
  uuidSchema,
  type AgentAddress,
  type AgentMessageEnvelope,
} from "../protocol/messageEnvelope.js";
import {
  createPrivateRegularFile,
  ensurePrivateBridgeDirectory,
  openExistingPrivateRegularFile,
  openOrCreatePrivateRegularFile,
  prepareSecureBridgeState,
  removePrivateRegularFileIfPresent,
  renamePrivateRegularFile,
  type SecureBridgeStateContext,
} from "../registry/secureStateFilesystem.js";

const timestampSchema = z.string().datetime({ precision: 3 });
const addressSchema = z.object({
  runtime: z.enum(["claude", "codex"]),
  sessionId: uuidSchema.transform((identifier) => identifier.toLowerCase()),
  projectId: z.string().regex(/^[a-f0-9]{24}$/),
}).strict();

const messageStatusSchema = z.object({
  messageId: uuidSchema,
  conversationId: uuidSchema,
  sender: addressSchema,
  recipient: addressSchema,
  messageType: z.enum(["message", "question", "handoff", "reply"]),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sentAt: timestampSchema,
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  deadlineAt: timestampSchema,
  transportState: z.enum(["pending", "accepted", "unknown", "failed"]),
  transportAcceptedAt: timestampSchema.optional(),
  acknowledgedAt: timestampSchema.optional(),
  repliedAt: timestampSchema.optional(),
  replyMessageId: uuidSchema.optional(),
  replyToMessageId: uuidSchema.optional(),
}).strict();

type StoredMessageStatus = z.infer<typeof messageStatusSchema>;
export type MessageStatusRecord = StoredMessageStatus & {
  state: "pending" | "accepted" | "seen" | "replied";
};

export interface MessageStatusStore {
  createPending(
    envelope: AgentMessageEnvelope,
    options?: { timeoutMinutes?: number },
  ): Promise<MessageStatusRecord>;
  markAccepted(messageId: string): Promise<MessageStatusRecord>;
  markTransportFailure(messageId: string, outcome: "unknown" | "failed"): Promise<MessageStatusRecord>;
  markSeen(messageId: string, recipient: AgentAddress): Promise<MessageStatusRecord>;
  markReplied(messageId: string, recipient: AgentAddress, replyMessageId: string): Promise<MessageStatusRecord>;
  get(messageId: string): Promise<MessageStatusRecord | undefined>;
  findReplyTarget(conversationId: string, recipient: AgentAddress): Promise<MessageStatusRecord | undefined>;
  listOverdue(now?: Date): Promise<MessageStatusRecord[]>;
}

export interface CreateMessageStatusStoreOptions {
  stateHomeDirectory?: string;
  currentDate?: () => Date;
  retentionMilliseconds?: number;
  maximumRecords?: number;
}

const maximumStoredRecords = 512;
const maximumStoreBytes = 1_048_576;
const storedStatusesSchema = z.object({
  schemaVersion: z.literal(1),
  records: z.array(messageStatusSchema).max(maximumStoredRecords),
}).strict();

export function resolveMessageTimeoutMinutes(
  requestedMinutes?: number,
  environmentValue = process.env.CODEX_CLAUDE_BRIDGE_TIMEOUT_MINUTES,
): number {
  return z.number().finite().min(0.01).max(1_440).parse(
    requestedMinutes ?? (environmentValue === undefined ? 5 : Number(environmentValue)),
  );
}

function normalizeMessageId(messageId: string): string {
  return uuidSchema.parse(messageId).toLowerCase();
}

function addressesMatch(first: AgentAddress, second: AgentAddress): boolean {
  return first.runtime === second.runtime &&
    first.sessionId === second.sessionId && first.projectId === second.projectId;
}

function publicStatus(record: StoredMessageStatus): MessageStatusRecord {
  return {
    ...record,
    state: record.repliedAt !== undefined ? "replied" :
      record.acknowledgedAt !== undefined ? "seen" :
        record.transportAcceptedAt !== undefined ? "accepted" : "pending",
  };
}

export class MessageStatusLockTimeoutError extends Error {
  constructor() {
    super("Timed out acquiring the message status lock");
    this.name = "MessageStatusLockTimeoutError";
  }
}

async function acquireMessageStatusLock(fileDescriptor: number): Promise<void> {
  const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
    const lockProcess = spawn("/usr/bin/lockf", ["-s", "-t", "4", "3"], {
      shell: false,
      stdio: ["ignore", "ignore", "ignore", fileDescriptor],
    });
    lockProcess.once("error", rejectExit);
    lockProcess.once("close", resolveExit);
  });
  if (exitCode === 75) throw new MessageStatusLockTimeoutError();
  if (exitCode !== 0) {
    throw new Error("Unable to acquire the message status lock");
  }
}

async function readStatuses(context: SecureBridgeStateContext, recordPath: string): Promise<StoredMessageStatus[]> {
  let openedRecord;
  try {
    openedRecord = await openExistingPrivateRegularFile(context, recordPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const bytes = Buffer.alloc(maximumStoreBytes + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const nextRead = await openedRecord.fileHandle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (nextRead.bytesRead === 0) break;
      bytesRead += nextRead.bytesRead;
    }
    if (bytesRead > maximumStoreBytes) throw new Error("Message status store exceeds its size limit");
    const records = storedStatusesSchema.parse(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"))).records;
    if (new Set(records.map((record) => record.messageId)).size !== records.length) {
      throw new Error("Message status store contains duplicate identifiers");
    }
    return records;
  } finally {
    await openedRecord.fileHandle.close();
  }
}

async function writeStatuses(context: SecureBridgeStateContext, recordPath: string, records: StoredMessageStatus[]): Promise<void> {
  const serializedRecords = JSON.stringify(storedStatusesSchema.parse({ schemaVersion: 1, records }));
  if (Buffer.byteLength(serializedRecords) > maximumStoreBytes) throw new Error("Message status store exceeds its size limit");
  const temporaryPath = `${recordPath}.tmp`;
  await removePrivateRegularFileIfPresent(context, temporaryPath);
  const temporaryRecord = await createPrivateRegularFile(context, temporaryPath);
  try {
    try {
      await temporaryRecord.fileHandle.writeFile(serializedRecords, "utf8");
      await temporaryRecord.fileHandle.sync();
    } finally {
      await temporaryRecord.fileHandle.close();
    }
    await renamePrivateRegularFile(context, temporaryPath, recordPath);
  } finally {
    await removePrivateRegularFileIfPresent(context, temporaryPath);
  }
}

export function createMessageStatusStore(options: CreateMessageStatusStoreOptions = {}): MessageStatusStore {
  const currentDate = options.currentDate ?? (() => new Date());
  const maximumRecords = z.number().int().min(1).max(maximumStoredRecords).parse(options.maximumRecords ?? maximumStoredRecords);
  const retentionMilliseconds = z.number().int().min(1).max(604_800_000).parse(options.retentionMilliseconds ?? 86_400_000);

  async function withStore<Result>(operation: (records: StoredMessageStatus[], now: Date) => Result, evaluationDate?: Date): Promise<Result> {
    const context = await prepareSecureBridgeState(options.stateHomeDirectory);
    const directory = await ensurePrivateBridgeDirectory(context, join(context.bridgeStateDirectory, "messages"), true);
    const lockFile = await openOrCreatePrivateRegularFile(context, join(directory, ".mutation.lock"));
    try {
      await acquireMessageStatusLock(lockFile.fileHandle.fd);
      const now = evaluationDate ?? currentDate();
      timestampSchema.parse(now.toISOString());
      const recordPath = join(directory, "statuses.json");
      const storedRecords = await readStatuses(context, recordPath);
      const records = storedRecords.filter((record) => Date.parse(record.expiresAt) > now.getTime());
      const previousContents = JSON.stringify(storedRecords);
      const result = operation(records, now);
      if (previousContents !== JSON.stringify(records)) await writeStatuses(context, recordPath, records);
      return result;
    } finally {
      await lockFile.fileHandle.close();
    }
  }

  async function update(messageId: string, mutation: (record: StoredMessageStatus, now: string, records: StoredMessageStatus[]) => void): Promise<MessageStatusRecord> {
    const normalizedIdentifier = normalizeMessageId(messageId);
    return withStore((records, now) => {
      const record = records.find((candidate) => candidate.messageId === normalizedIdentifier);
      if (record === undefined) throw new Error("Message status is missing or expired");
      mutation(record, now.toISOString(), records);
      return publicStatus(record);
    });
  }

  function requireRecipient(record: StoredMessageStatus, recipient: AgentAddress): void {
    if (!addressesMatch(record.recipient, addressSchema.parse(recipient))) {
      throw new Error("Only the message recipient can acknowledge it");
    }
  }

  return {
    async createPending(inputEnvelope, creationOptions = {}) {
      const envelope = parseAgentMessageEnvelope(inputEnvelope);
      const messageId = normalizeMessageId(envelope.messageId);
      const timeoutMinutes = resolveMessageTimeoutMinutes(creationOptions.timeoutMinutes);
      const contentDigest = createHash("sha256").update(JSON.stringify({
        ...envelope,
        messageId,
        conversationId: normalizeMessageId(envelope.conversationId),
        sender: addressSchema.parse(envelope.sender),
        recipient: addressSchema.parse(envelope.recipient),
      })).digest("hex");
      return withStore((records, now) => {
        const existing = records.find((record) => record.messageId === messageId);
        if (existing !== undefined) {
          if (existing.contentDigest !== contentDigest) throw new Error("Message identifier is already bound to another envelope");
          return publicStatus(existing);
        }
        while (records.length >= maximumRecords) {
          const oldestCompletedRecord = records.filter((candidate) =>
            candidate.repliedAt !== undefined || candidate.transportState === "failed" ||
            ((candidate.messageType === "message" || candidate.messageType === "reply") &&
              candidate.acknowledgedAt !== undefined),
          ).sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0];
          if (oldestCompletedRecord === undefined) throw new Error("Message status capacity is exhausted by outstanding messages");
          records.splice(records.indexOf(oldestCompletedRecord), 1);
        }
        const record: StoredMessageStatus = {
          messageId,
          conversationId: normalizeMessageId(envelope.conversationId),
          sender: addressSchema.parse(envelope.sender),
          recipient: addressSchema.parse(envelope.recipient),
          messageType: envelope.messageType,
          contentDigest,
          sentAt: envelope.sentAt,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + timeoutMinutes * 60_000 + retentionMilliseconds).toISOString(),
          deadlineAt: new Date(now.getTime() + timeoutMinutes * 60_000).toISOString(),
          transportState: "pending",
          ...(envelope.replyToMessageId === undefined ? {} : {
            replyToMessageId: normalizeMessageId(envelope.replyToMessageId),
          }),
        };
        records.push(record);
        return publicStatus(record);
      });
    },
    markAccepted(messageId) {
      return update(messageId, (record, now) => {
        record.transportAcceptedAt ??= now;
        record.transportState = "accepted";
      });
    },
    markTransportFailure(messageId, outcome) {
      const validatedOutcome = z.enum(["unknown", "failed"]).parse(outcome);
      return update(messageId, (record) => {
        if (record.transportAcceptedAt === undefined && record.acknowledgedAt === undefined) {
          record.transportState = validatedOutcome;
        }
      });
    },
    markSeen(messageId, recipient) {
      return update(messageId, (record, now) => {
        requireRecipient(record, recipient);
        record.acknowledgedAt ??= now;
      });
    },
    markReplied(messageId, recipient, replyMessageId) {
      const normalizedReplyId = normalizeMessageId(replyMessageId);
      return update(messageId, (record, now, records) => {
        requireRecipient(record, recipient);
        const reply = records.find((candidate) => candidate.messageId === normalizedReplyId);
        if (reply === undefined || reply.messageType !== "reply" ||
          (reply.replyToMessageId !== undefined && reply.replyToMessageId !== record.messageId) ||
          reply.conversationId !== record.conversationId ||
          !addressesMatch(reply.sender, record.recipient) ||
          !addressesMatch(reply.recipient, record.sender) ||
          reply.transportAcceptedAt === undefined) {
          throw new Error("Reply must be an accepted message on the reversed conversation route");
        }
        if (record.replyMessageId !== undefined && record.replyMessageId !== normalizedReplyId) {
          throw new Error("Message already has a different reply");
        }
        record.acknowledgedAt ??= now;
        record.repliedAt ??= now;
        record.replyMessageId = normalizedReplyId;
      });
    },
    get(messageId) {
      const normalizedIdentifier = normalizeMessageId(messageId);
      return withStore((records) => {
        const record = records.find((candidate) => candidate.messageId === normalizedIdentifier);
        return record === undefined ? undefined : publicStatus(record);
      });
    },
    findReplyTarget(conversationId, recipient) {
      const normalizedConversation = normalizeMessageId(conversationId);
      const validatedRecipient = addressSchema.parse(recipient);
      return withStore((records) => {
        const candidates = records.filter((record) =>
          record.conversationId === normalizedConversation &&
          addressesMatch(record.recipient, validatedRecipient) &&
          record.repliedAt === undefined,
        );
        return candidates.length === 1 ? publicStatus(candidates[0]!) : undefined;
      });
    },
    listOverdue(requestedDate) {
      if (requestedDate !== undefined) timestampSchema.parse(requestedDate.toISOString());
      return withStore((records, now) => records.filter((record) =>
        (record.messageType === "question" || record.messageType === "handoff") &&
        record.repliedAt === undefined && record.transportState !== "failed" &&
        Date.parse(record.deadlineAt) <= now.getTime(),
      ).map(publicStatus), requestedDate);
    },
  };
}
