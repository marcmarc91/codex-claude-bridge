import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  createClaudeChannelServer,
  startClaudeChannelServer,
  type ClaudeChannelNotification,
} from "../src/channel/claudeChannelServer.js";
import type { AgentMessageEnvelope } from "../src/protocol/messageEnvelope.js";
import {
  registerActiveSession,
  unregisterActiveSession,
} from "../src/registry/activeSessionRegistry.js";

const claudeProjectIdentifier = "0123456789abcdef01234567";
const codexProjectIdentifier = "fedcba987654321001234567";
const claudeSessionIdentifier = "ad65b1c1-7386-4465-80f9-4de0a26bc212";
const codexSessionIdentifier = "8d6380bf-1b93-44b3-b3da-a1a661cf8b69";
const conversationIdentifier = "5cb1e2fd-5b24-4699-bfea-878e9b147370";

function owningSession() {
  return {
    sessionId: claudeSessionIdentifier,
    displayName: "claude-owner",
    processId: process.pid,
    workingDirectory: process.cwd(),
    projectId: claudeProjectIdentifier,
  };
}

function inboundEnvelope(
  overrides: Partial<AgentMessageEnvelope> = {},
): AgentMessageEnvelope {
  return {
    schemaVersion: 1,
    messageId: "3c4b3c10-21a7-4d6f-b964-3c816b9ed8db",
    conversationId: conversationIdentifier,
    sentAt: "2026-09-03T12:00:00.000Z",
    messageType: "question",
    sender: {
      runtime: "codex",
      sessionId: codexSessionIdentifier,
      projectId: codexProjectIdentifier,
    },
    recipient: {
      runtime: "claude",
      sessionId: claudeSessionIdentifier,
      projectId: claudeProjectIdentifier,
    },
    content: "status?",
    replyRoute: {
      runtime: "codex",
      sessionId: codexSessionIdentifier,
      projectId: codexProjectIdentifier,
    },
    ...overrides,
  };
}

async function createStateHomeDirectory(testContext: test.TestContext): Promise<string> {
  const stateHomeDirectory = await mkdtemp(join(tmpdir(), "ccb-mcp-"));
  testContext.after(() => rm(stateHomeDirectory, { recursive: true, force: true }));
  return stateHomeDirectory;
}

async function registerCodexSession(stateHomeDirectory: string): Promise<void> {
  await registerActiveSession(
    {
      schemaVersion: 1,
      runtime: "codex",
      sessionId: codexSessionIdentifier,
      displayName: "codex-target",
      processId: process.pid,
      workingDirectory: process.cwd(),
      projectId: codexProjectIdentifier,
      registeredAt: "2026-09-03T12:00:00.000Z",
    },
    stateHomeDirectory,
  );
}

async function connectClient(
  mcpServer: ReturnType<typeof createClaudeChannelServer>["mcpServer"],
  testContext: test.TestContext,
): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "channel-test-client", version: "1.0.0" },
    { capabilities: {} },
  );
  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);
  testContext.after(async () => {
    await client.close();
    await mcpServer.close();
  });
  return client;
}

test("declares the Channel capability without permission relay and exposes exactly three tools", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const channelServer = createClaudeChannelServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    notificationSender: async () => undefined,
    queueMessage: async () => undefined,
  });
  const client = await connectClient(channelServer.mcpServer, testContext);

  assert.deepEqual(client.getServerCapabilities(), {
    experimental: { "claude/channel": {} },
    tools: {},
  });
  assert.equal(
    Object.hasOwn(
      client.getServerCapabilities()?.experimental ?? {},
      "claude/channel/permission",
    ),
    false,
  );
  assert.match(client.getInstructions() ?? "", /another local agent/u);
  assert.match(client.getInstructions() ?? "", /not permission escalation/u);
  assert.match(client.getInstructions() ?? "", /reply_to_codex/u);
  assert.deepEqual(
    (await client.listTools()).tools.map(({ name }) => name),
    ["list_codex_sessions", "send_to_codex", "reply_to_codex"],
  );
});

test("lists active Codex sessions and safely queues an explicitly selected target", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  await registerCodexSession(stateHomeDirectory);
  const queuedEnvelopes: AgentMessageEnvelope[] = [];
  const channelServer = createClaudeChannelServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    notificationSender: async () => undefined,
    queueMessage: async ({ envelope }) => {
      queuedEnvelopes.push(envelope);
    },
    randomIdentifier: () => "ea7220bc-cd1e-41f0-bf7f-413982f18a9c",
    currentDate: () => new Date("2026-09-03T13:00:00.000Z"),
  });
  const client = await connectClient(channelServer.mcpServer, testContext);

  const listResult = await client.callTool({
    name: "list_codex_sessions",
    arguments: {},
  });
  assert.equal(listResult.isError, undefined);
  assert.deepEqual(JSON.parse(listResult.content[0]!.text as string), {
    sessions: [
      {
        session_id: codexSessionIdentifier,
        display_name: "codex-target",
        project_id: codexProjectIdentifier,
        working_directory: process.cwd(),
      },
    ],
  });

  const sendResult = await client.callTool({
    name: "send_to_codex",
    arguments: {
      session_id: codexSessionIdentifier,
      message_type: "handoff",
      content: "continue from here",
    },
  });
  assert.equal(sendResult.isError, undefined);
  assert.match(sendResult.content[0]!.text as string, /transport acknowledgement/u);
  assert.deepEqual(queuedEnvelopes, [
    {
      schemaVersion: 1,
      messageId: "ea7220bc-cd1e-41f0-bf7f-413982f18a9c",
      conversationId: "ea7220bc-cd1e-41f0-bf7f-413982f18a9c",
      sentAt: "2026-09-03T13:00:00.000Z",
      messageType: "handoff",
      sender: {
        runtime: "claude",
        sessionId: claudeSessionIdentifier,
        projectId: claudeProjectIdentifier,
      },
      recipient: {
        runtime: "codex",
        sessionId: codexSessionIdentifier,
        projectId: codexProjectIdentifier,
      },
      content: "continue from here",
      replyRoute: {
        runtime: "claude",
        sessionId: claudeSessionIdentifier,
        projectId: claudeProjectIdentifier,
      },
    },
  ]);
});

test("maps accepted envelopes to Channel notifications and learns an in-memory reply route", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  await registerCodexSession(stateHomeDirectory);
  const notifications: ClaudeChannelNotification[] = [];
  const queuedEnvelopes: AgentMessageEnvelope[] = [];
  const channelServer = createClaudeChannelServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    notificationSender: async (notification) => {
      notifications.push(notification);
    },
    queueMessage: async ({ envelope }) => {
      queuedEnvelopes.push(envelope);
    },
    randomIdentifier: () => "ea7220bc-cd1e-41f0-bf7f-413982f18a9c",
    currentDate: () => new Date("2026-09-03T13:00:00.000Z"),
  });
  const client = await connectClient(channelServer.mcpServer, testContext);
  const abortController = new AbortController();

  await channelServer.deliverEnvelope(inboundEnvelope(), abortController.signal);

  assert.deepEqual(notifications, [
    {
      method: "notifications/claude/channel",
      params: {
        content: "status?",
        meta: {
          message_id: "3c4b3c10-21a7-4d6f-b964-3c816b9ed8db",
          conversation_id: conversationIdentifier,
          sender_runtime: "codex",
          sender_session_id: codexSessionIdentifier,
          message_type: "question",
        },
      },
    },
  ]);

  const replyResult = await client.callTool({
    name: "reply_to_codex",
    arguments: {
      conversation_id: conversationIdentifier,
      content: "done",
    },
  });
  assert.equal(replyResult.isError, undefined);
  assert.equal(queuedEnvelopes.length, 1);
  assert.deepEqual(queuedEnvelopes[0], {
    schemaVersion: 1,
    messageId: "ea7220bc-cd1e-41f0-bf7f-413982f18a9c",
    conversationId: conversationIdentifier,
    sentAt: "2026-09-03T13:00:00.000Z",
    messageType: "reply",
    sender: {
      runtime: "claude",
      sessionId: claudeSessionIdentifier,
      projectId: claudeProjectIdentifier,
    },
    recipient: {
      runtime: "codex",
      sessionId: codexSessionIdentifier,
      projectId: codexProjectIdentifier,
    },
    content: "done",
    replyRoute: {
      runtime: "claude",
      sessionId: claudeSessionIdentifier,
      projectId: claudeProjectIdentifier,
    },
  });
});

test("rejects missing, ambiguous, and offline reply routes without broadcasting", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  await registerCodexSession(stateHomeDirectory);
  let queueCount = 0;
  const channelServer = createClaudeChannelServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    notificationSender: async () => undefined,
    queueMessage: async () => {
      queueCount += 1;
    },
  });
  const client = await connectClient(channelServer.mcpServer, testContext);

  const missingResult = await client.callTool({
    name: "reply_to_codex",
    arguments: { conversation_id: conversationIdentifier, content: "missing" },
  });
  assert.equal(missingResult.isError, true);

  await channelServer.deliverEnvelope(inboundEnvelope(), new AbortController().signal);
  await channelServer.deliverEnvelope(
    inboundEnvelope({
      sender: {
        runtime: "codex",
        sessionId: "ea7220bc-cd1e-41f0-bf7f-413982f18a9c",
        projectId: codexProjectIdentifier,
      },
      replyRoute: {
        runtime: "codex",
        sessionId: "ea7220bc-cd1e-41f0-bf7f-413982f18a9c",
        projectId: codexProjectIdentifier,
      },
    }),
    new AbortController().signal,
  );
  const ambiguousResult = await client.callTool({
    name: "reply_to_codex",
    arguments: { conversation_id: conversationIdentifier, content: "ambiguous" },
  });
  assert.equal(ambiguousResult.isError, true);
  assert.equal(queueCount, 0);

  const offlineConversationIdentifier = "d2f86dee-55db-4a12-9a98-04bc3df54687";
  await channelServer.deliverEnvelope(
    inboundEnvelope({ conversationId: offlineConversationIdentifier }),
    new AbortController().signal,
  );
  await unregisterActiveSession(
    codexSessionIdentifier,
    codexProjectIdentifier,
    process.pid,
    stateHomeDirectory,
  );
  const offlineResult = await client.callTool({
    name: "reply_to_codex",
    arguments: {
      conversation_id: offlineConversationIdentifier,
      content: "offline",
    },
  });
  assert.equal(offlineResult.isError, true);
  assert.equal(queueCount, 0);
});

test("does not learn a reply route after an aborted notification delivery", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const abortController = new AbortController();
  const channelServer = createClaudeChannelServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    notificationSender: async () => {
      abortController.abort();
    },
    queueMessage: async () => undefined,
  });
  const client = await connectClient(channelServer.mcpServer, testContext);

  await assert.rejects(() =>
    channelServer.deliverEnvelope(inboundEnvelope(), abortController.signal),
  );
  const replyResult = await client.callTool({
    name: "reply_to_codex",
    arguments: { conversation_id: conversationIdentifier, content: "late" },
  });
  assert.equal(replyResult.isError, true);
});

test("closes the MCP transport even when socket cleanup fails", async (testContext) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  testContext.after(() => clientTransport.close());
  let transportCloseCount = 0;
  const closeServerTransport = serverTransport.close.bind(serverTransport);
  serverTransport.close = async () => {
    transportCloseCount += 1;
    await closeServerTransport();
  };
  let socketCloseCount = 0;
  const runningServer = await startClaudeChannelServer({
    transport: serverTransport,
    readSessionMetadata: async () => ({
      pid: process.pid,
      sessionId: claudeSessionIdentifier,
      name: "claude-owner",
      cwd: process.cwd(),
      messagingSocketPath: "/tmp/private-claude.sock",
    }),
    resolveProject: async () => claudeProjectIdentifier,
    startSocketServer: async () => ({
      socketPath: "/tmp/bridge-test.sock",
      close: async () => {
        socketCloseCount += 1;
        throw new Error("socket cleanup failed");
      },
    }),
    notificationSender: async () => undefined,
    queueMessage: async () => undefined,
  });

  await assert.rejects(runningServer.close(), /Channel server cleanup failed/u);
  assert.equal(socketCloseCount, 1);
  assert.equal(transportCloseCount > 0, true);
});
