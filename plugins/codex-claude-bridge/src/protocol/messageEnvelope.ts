import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import { z } from "zod";

export const AgentRuntime = z.enum(["claude", "codex"]);
export const uuidSchema = z.string().uuid();
export const maximumProtocolMessageContentUtf8Bytes = 65_536;

export type AgentRuntime = z.infer<typeof AgentRuntime>;

const agentAddressSchema = z
  .object({
    runtime: AgentRuntime,
    sessionId: uuidSchema,
    projectId: z.string().regex(/^[a-f0-9]{24}$/),
  })
  .strict();

const contentSchema = z
  .string()
  .min(1)
  .refine(
    (content) =>
      Buffer.byteLength(content, "utf8") <=
      maximumProtocolMessageContentUtf8Bytes,
    "Message content exceeds 65536 UTF-8 bytes",
  );

const agentMessageEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    messageId: uuidSchema,
    conversationId: uuidSchema,
    sentAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      .datetime({ offset: false, precision: 3 }),
    messageType: z.enum(["message", "question", "handoff", "reply"]),
    sender: agentAddressSchema,
    recipient: agentAddressSchema,
    content: contentSchema,
    replyRoute: agentAddressSchema.optional(),
  })
  .strict();

export type AgentAddress = z.infer<typeof agentAddressSchema>;
export type AgentMessageEnvelope = z.infer<typeof agentMessageEnvelopeSchema>;
export type CreateAgentMessageEnvelopeInput = Omit<
  AgentMessageEnvelope,
  "schemaVersion" | "messageId" | "sentAt"
>;

export function parseAgentMessageEnvelope(input: unknown): AgentMessageEnvelope {
  return agentMessageEnvelopeSchema.parse(input);
}

export function serializeAgentMessageEnvelope(envelope: AgentMessageEnvelope): string {
  return JSON.stringify(parseAgentMessageEnvelope(envelope));
}

const maximumBoundedAgentAddress: AgentAddress = {
  runtime: "claude",
  sessionId: "ffffffff-ffff-4fff-bfff-ffffffffffff",
  projectId: "ffffffffffffffffffffffff",
};

export const maximumSerializedAgentMessageEnvelopeFrameUtf8Bytes =
  Buffer.byteLength(
    `${serializeAgentMessageEnvelope({
      schemaVersion: 1,
      messageId: "ffffffff-ffff-4fff-bfff-ffffffffffff",
      conversationId: "ffffffff-ffff-4fff-bfff-ffffffffffff",
      sentAt: "9999-12-31T23:59:59.999Z",
      messageType: "question",
      sender: maximumBoundedAgentAddress,
      recipient: maximumBoundedAgentAddress,
      content: "\0".repeat(maximumProtocolMessageContentUtf8Bytes),
      replyRoute: maximumBoundedAgentAddress,
    })}\n`,
    "utf8",
  );

export function createAgentMessageEnvelope(
  input: CreateAgentMessageEnvelopeInput,
): AgentMessageEnvelope {
  return parseAgentMessageEnvelope({
    ...input,
    schemaVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
  });
}
