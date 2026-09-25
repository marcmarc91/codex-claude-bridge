import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentMessageEnvelope,
  parseAgentMessageEnvelope,
  serializeAgentMessageEnvelope,
} from "../src/protocol/messageEnvelope.js";

const validEnvelope = {
  schemaVersion: 1,
  messageId: "3c4b3c10-21a7-4d6f-b964-3c816b9ed8db",
  conversationId: "5cb1e2fd-5b24-4699-bfea-878e9b147370",
  sentAt: "2026-09-03T12:00:00.000Z",
  messageType: "question",
  sender: {
    runtime: "codex",
    sessionId: "8d6380bf-1b93-44b3-b3da-a1a661cf8b69",
    projectId: "0123456789abcdef01234567",
  },
  recipient: {
    runtime: "claude",
    sessionId: "ad65b1c1-7386-4465-80f9-4de0a26bc212",
    projectId: "0123456789abcdef01234567",
  },
  content: "status?",
};

test("accepts a valid envelope", () => {
  assert.equal(parseAgentMessageEnvelope(validEnvelope).content, "status?");
});

test("rejects unknown fields", () => {
  assert.throws(() => parseAgentMessageEnvelope({ ...validEnvelope, extra: true }));
});

test("rejects a message ID that is not a UUID", () => {
  assert.throws(() => parseAgentMessageEnvelope({ ...validEnvelope, messageId: "bad" }));
});

test("accepts only UTC timestamps with milliseconds in toISOString form", () => {
  assert.equal(parseAgentMessageEnvelope(validEnvelope).sentAt, validEnvelope.sentAt);
  for (const sentAt of [
    "2026-09-03T12:00:00Z",
    "2026-09-03T12:00:00.0000Z",
    "2026-09-03T14:00:00.000+02:00",
    "2026-09-03t12:00:00.000z",
  ]) {
    assert.throws(() => parseAgentMessageEnvelope({ ...validEnvelope, sentAt }));
  }
});

test("rejects empty content", () => {
  assert.throws(() => parseAgentMessageEnvelope({ ...validEnvelope, content: "" }));
});

test("rejects content above the 65536 UTF-8 byte limit", () => {
  assert.throws(() => parseAgentMessageEnvelope({ ...validEnvelope, content: "ă".repeat(32769) }));
});

test("creates and serializes a valid envelope", () => {
  const envelope = createAgentMessageEnvelope({
    conversationId: validEnvelope.conversationId,
    messageType: validEnvelope.messageType,
    sender: validEnvelope.sender,
    recipient: validEnvelope.recipient,
    content: validEnvelope.content,
  });

  const serializedEnvelope = serializeAgentMessageEnvelope(envelope);

  assert.deepEqual(parseAgentMessageEnvelope(JSON.parse(serializedEnvelope)), envelope);
});
