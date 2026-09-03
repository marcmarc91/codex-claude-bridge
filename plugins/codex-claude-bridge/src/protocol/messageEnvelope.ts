import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import { z } from "zod";

export const AgentRuntime = z.enum(["claude", "codex"]);

export type AgentRuntime = z.infer<typeof AgentRuntime>;

const agentAddressSchema = z
  .object({
    runtime: AgentRuntime,
    sessionId: z.string().uuid(),
    projectId: z.string().regex(/^[a-f0-9]{24}$/),
  })
  .strict();

const contentSchema = z
  .string()
  .min(1)
  .refine(
    (content) => Buffer.byteLength(content, "utf8") <= 65_536,
    "Message content exceeds 65536 UTF-8 bytes",
  );

const agentMessageEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    messageId: z.string().uuid(),
    conversationId: z.string().uuid(),
    sentAt: z.string().datetime({ offset: true }),
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
