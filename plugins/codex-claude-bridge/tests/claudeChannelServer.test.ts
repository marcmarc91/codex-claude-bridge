import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
import { createConversationRouteStore } from "../src/conversations/conversationRoutes.js";
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

function observeTransportStart(serverTransport: InMemoryTransport): Promise<void> {
  let resolveTransportStart: (() => void) | undefined;
  const transportStarted = new Promise<void>((resolveStart) => {
    resolveTransportStart = resolveStart;
  });
  const startTransport = serverTransport.start.bind(serverTransport);
  serverTransport.start = async () => {
    await startTransport();
    resolveTransportStart?.();
  };
  return transportStarted;
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
  const tools = (await client.listTools()).tools;
  assert.deepEqual(
    tools.map(({ name }) => name),
    ["list_codex_sessions", "send_to_codex", "reply_to_codex"],
  );
  const uuidInputSchema = {
    type: "string",
    format: "uuid",
    minLength: 36,
    maxLength: 36,
    pattern:
      "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
  };
  assert.deepEqual(tools[0]?.inputSchema, {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Optional absolute project path to filter.",
        minLength: 1,
        maxLength: 4_096,
        pattern: "^/[^\\u0000]*$",
      },
    },
    additionalProperties: false,
  });
  assert.deepEqual(tools[1]?.inputSchema, {
    type: "object",
    properties: {
      session_id: {
        ...uuidInputSchema,
        description: "Target Codex session UUID.",
      },
      message_type: {
        type: "string",
        enum: ["message", "question", "handoff"],
      },
      content: {
        type: "string",
        description: "Message content.",
        minLength: 1,
        maxLength: 65_536,
      },
    },
    required: ["session_id", "message_type", "content"],
    additionalProperties: false,
  });
  assert.deepEqual(tools[2]?.inputSchema, {
    type: "object",
    properties: {
      conversation_id: {
        ...uuidInputSchema,
        description: "Inbound bridge conversation UUID.",
      },
      content: {
        type: "string",
        description: "Reply content.",
        minLength: 1,
        maxLength: 65_536,
      },
    },
    required: ["conversation_id", "content"],
    additionalProperties: false,
  });
  const projectPattern = tools[0]?.inputSchema.properties?.project?.pattern;
  assert.equal(new RegExp(String(projectPattern)).test("/tmp/project\0nested"), false);
  assert.equal(new RegExp(String(projectPattern)).test("/segment\n\0tail"), false);
});

test("rejects relative project filters and enforces UTF-8 content limits at runtime", async (testContext) => {
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

  const relativeProjectResult = await client.callTool({
    name: "list_codex_sessions",
    arguments: { project: "." },
  });
  const overLimitContentResult = await client.callTool({
    name: "send_to_codex",
    arguments: {
      session_id: codexSessionIdentifier,
      message_type: "message",
      content: "é".repeat(32_769),
    },
  });

  assert.equal(relativeProjectResult.isError, true);
  assert.equal(overLimitContentResult.isError, true);
  assert.equal(queueCount, 0);
});

test("lists active Codex sessions and safely queues an explicitly selected target", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  await registerCodexSession(stateHomeDirectory);
  const queuedEnvelopes: AgentMessageEnvelope[] = [];
  const routeInspector = createConversationRouteStore({
    stateHomeDirectory,
    currentDate: () => new Date("2026-09-03T13:00:00.000Z"),
    isAddressActive: async () => true,
  });
  let routeObservedBeforeQueue = false;
  const channelServer = createClaudeChannelServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    notificationSender: async () => undefined,
    queueMessage: async ({ envelope }) => {
      routeObservedBeforeQueue =
        (await routeInspector.findActive(envelope.conversationId)) !== undefined;
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
  assert.equal(routeObservedBeforeQueue, true);
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

test("propagates MCP request cancellation to the Codex queue operation", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  await registerCodexSession(stateHomeDirectory);
  let observeQueueStart: (() => void) | undefined;
  const queueStarted = new Promise<void>((resolve) => {
    observeQueueStart = resolve;
  });
  let observeQueueCancellation: (() => void) | undefined;
  const queueCancellationObserved = new Promise<void>((resolve) => {
    observeQueueCancellation = resolve;
  });
  let receivedQueueSignal: AbortSignal | undefined;
  const channelServer = createClaudeChannelServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    notificationSender: async () => undefined,
    queueMessage: async ({ signal }) => {
      receivedQueueSignal = signal;
      observeQueueStart?.();
      if (signal === undefined) {
        observeQueueCancellation?.();
        return;
      }
      await new Promise<void>((resolveAbort) => {
        if (signal.aborted) {
          resolveAbort();
          return;
        }
        signal.addEventListener("abort", () => resolveAbort(), { once: true });
      });
      observeQueueCancellation?.();
      throw new Error("queue operation cancelled");
    },
  });
  const client = await connectClient(channelServer.mcpServer, testContext);
  const requestAbortController = new AbortController();
  const toolCall = client.callTool(
    {
      name: "send_to_codex",
      arguments: {
        session_id: codexSessionIdentifier,
        message_type: "message",
        content: "cancel this queue request",
      },
    },
    undefined,
    { signal: requestAbortController.signal },
  );
  void toolCall.catch(() => undefined);
  await queueStarted;

  requestAbortController.abort();
  await queueCancellationObserved;
  await toolCall.catch(() => undefined);

  assert.equal(receivedQueueSignal?.aborted, true);
  await channelServer.close();
});

test("close aborts and awaits an in-flight Codex queue tool call", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  await registerCodexSession(stateHomeDirectory);
  let observeQueueStart: (() => void) | undefined;
  const queueStarted = new Promise<void>((resolve) => {
    observeQueueStart = resolve;
  });
  let releaseQueue: (() => void) | undefined;
  const queueGate = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  let receivedQueueSignal: AbortSignal | undefined;
  const channelServer = createClaudeChannelServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    notificationSender: async () => undefined,
    queueMessage: async ({ signal }) => {
      receivedQueueSignal = signal;
      observeQueueStart?.();
      await queueGate;
      if (signal?.aborted === true) {
        throw new Error("queue operation cancelled");
      }
    },
  });
  const client = await connectClient(channelServer.mcpServer, testContext);
  const toolCall = client.callTool({
    name: "send_to_codex",
    arguments: {
      session_id: codexSessionIdentifier,
      message_type: "message",
      content: "close during queue",
    },
  });
  void toolCall.catch(() => undefined);
  await queueStarted;
  let closeSettled = false;
  const closePromise = channelServer.close().finally(() => {
    closeSettled = true;
  });
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  const closeSettledBeforeQueue = closeSettled;
  const queueAbortedBeforeRelease = receivedQueueSignal?.aborted;
  releaseQueue?.();

  await closePromise;
  await toolCall.catch(() => undefined);
  assert.equal(queueAbortedBeforeRelease, true);
  assert.equal(closeSettledBeforeQueue, false);
});

test("maps accepted envelopes to Channel notifications and persists the reply route", async (testContext) => {
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

  const persistedRoute = await createConversationRouteStore({
    stateHomeDirectory,
    currentDate: () => new Date("2026-09-03T13:00:00.000Z"),
    isAddressActive: async () => true,
  }).findActive(conversationIdentifier);
  assert.deepEqual(persistedRoute && {
    codex: persistedRoute.codex,
    claude: persistedRoute.claude,
  }, {
    codex: inboundEnvelope().sender,
    claude: inboundEnvelope().recipient,
  });

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
  assert.equal(replyResult.isError, undefined, JSON.stringify(replyResult));
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

test("resolves a persisted conversation route from a second Channel instance", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  await registerCodexSession(stateHomeDirectory);
  const firstChannelServer = createClaudeChannelServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    notificationSender: async () => undefined,
    queueMessage: async () => undefined,
    currentDate: () => new Date("2026-09-03T13:00:00.000Z"),
  });
  await firstChannelServer.deliverEnvelope(
    inboundEnvelope(),
    new AbortController().signal,
  );

  const queuedConversationIdentifiers: string[] = [];
  const secondChannelServer = createClaudeChannelServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    notificationSender: async () => undefined,
    queueMessage: async ({ envelope }) => {
      queuedConversationIdentifiers.push(envelope.conversationId);
    },
    randomIdentifier: () => "ea7220bc-cd1e-41f0-bf7f-413982f18a9c",
    currentDate: () => new Date("2026-09-03T13:00:00.000Z"),
  });
  const client = await connectClient(secondChannelServer.mcpServer, testContext);

  const replyResult = await client.callTool({
    name: "reply_to_codex",
    arguments: {
      conversation_id: conversationIdentifier,
      content: "persisted reply",
    },
  });

  assert.equal(replyResult.isError, undefined, JSON.stringify(replyResult));
  assert.deepEqual(queuedConversationIdentifiers, [conversationIdentifier]);
});

test("allows exactly one reply across two Channel instances sharing one route generation", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  await registerCodexSession(stateHomeDirectory);
  await createConversationRouteStore({
    stateHomeDirectory,
    isAddressActive: async () => true,
  }).reserve(conversationIdentifier, {
    codex: inboundEnvelope().sender,
    claude: inboundEnvelope().recipient,
    codexCanReply: false,
    claudeCanReply: true,
  });
  let queueCount = 0;
  const createCompetingChannel = () =>
    createClaudeChannelServer({
      owningSession: owningSession(),
      stateHomeDirectory,
      notificationSender: async () => undefined,
      queueMessage: async () => {
        queueCount += 1;
      },
    });
  const firstChannel = createCompetingChannel();
  const secondChannel = createCompetingChannel();
  const firstClient = await connectClient(firstChannel.mcpServer, testContext);
  const secondClient = await connectClient(secondChannel.mcpServer, testContext);

  const replies = await Promise.all([
    firstClient.callTool({
      name: "reply_to_codex",
      arguments: {
        conversation_id: conversationIdentifier,
        content: "first competitor",
      },
    }),
    secondClient.callTool({
      name: "reply_to_codex",
      arguments: {
        conversation_id: conversationIdentifier,
        content: "second competitor",
      },
    }),
  ]);

  assert.equal(replies.filter(({ isError }) => isError === undefined).length, 1);
  assert.equal(replies.filter(({ isError }) => isError === true).length, 1);
  assert.equal(queueCount, 1);
});

test("delivers a one-way inbound envelope without authorizing reply_to_codex", async (testContext) => {
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
  const oneWayEnvelope = inboundEnvelope();
  delete oneWayEnvelope.replyRoute;

  await channelServer.deliverEnvelope(
    oneWayEnvelope,
    new AbortController().signal,
  );
  const replyResult = await client.callTool({
    name: "reply_to_codex",
    arguments: {
      conversation_id: conversationIdentifier,
      content: "not authorized",
    },
  });

  assert.equal(replyResult.isError, true);
  assert.equal(queueCount, 0);
});

test("rejects conflicting senders before notification and never broadcasts replies", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  await registerCodexSession(stateHomeDirectory);
  let queueCount = 0;
  let notificationCount = 0;
  const channelServer = createClaudeChannelServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    notificationSender: async () => {
      notificationCount += 1;
    },
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
  await assert.rejects(
    channelServer.deliverEnvelope(
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
    ),
    /different Codex sender/u,
  );
  assert.equal(notificationCount, 1);
  const authorizedReplyResult = await client.callTool({
    name: "reply_to_codex",
    arguments: { conversation_id: conversationIdentifier, content: "authorized" },
  });
  assert.equal(authorizedReplyResult.isError, undefined);
  assert.equal(queueCount, 1);

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
  assert.equal(queueCount, 1);
});

test("reserves a conversation owner while its first notification is in flight", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  let releaseFirstNotification: (() => void) | undefined;
  const firstNotificationGate = new Promise<void>((resolve) => {
    releaseFirstNotification = resolve;
  });
  let observeFirstNotification: (() => void) | undefined;
  const firstNotificationStarted = new Promise<void>((resolve) => {
    observeFirstNotification = resolve;
  });
  let notificationCount = 0;
  const channelServer = createClaudeChannelServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    findSession: async (sessionIdentifier) =>
      sessionIdentifier === codexSessionIdentifier
        ? {
            schemaVersion: 1,
            runtime: "codex",
            sessionId: codexSessionIdentifier,
            displayName: "codex-target",
            processId: process.pid,
            workingDirectory: process.cwd(),
            projectId: codexProjectIdentifier,
            registeredAt: "2026-09-03T12:00:00.000Z",
          }
        : undefined,
    notificationSender: async () => {
      notificationCount += 1;
      if (notificationCount === 1) {
        observeFirstNotification?.();
        await firstNotificationGate;
      }
    },
    queueMessage: async () => undefined,
  });
  const firstDelivery = channelServer.deliverEnvelope(
    inboundEnvelope(),
    new AbortController().signal,
  );
  await firstNotificationStarted;

  const conflictingDelivery = channelServer.deliverEnvelope(
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
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  const notificationsBeforeFirstDeliverySettled = notificationCount;
  releaseFirstNotification?.();
  await firstDelivery;
  await assert.rejects(conflictingDelivery, /different Codex sender/u);
  await channelServer.close();

  assert.equal(notificationsBeforeFirstDeliverySettled, 1);
  assert.equal(notificationCount, 1);
});

test("prunes an offline conversation owner before accepting a new active sender", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  await registerCodexSession(stateHomeDirectory);
  const replacementSessionIdentifier = "ea7220bc-cd1e-41f0-bf7f-413982f18a9c";
  const queuedSessionIdentifiers: string[] = [];
  let notificationCount = 0;
  const channelServer = createClaudeChannelServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    notificationSender: async () => {
      notificationCount += 1;
    },
    queueMessage: async ({ targetSessionId }) => {
      queuedSessionIdentifiers.push(targetSessionId);
    },
  });
  const client = await connectClient(channelServer.mcpServer, testContext);

  await channelServer.deliverEnvelope(
    inboundEnvelope(),
    new AbortController().signal,
  );
  await unregisterActiveSession(
    codexSessionIdentifier,
    codexProjectIdentifier,
    process.pid,
    stateHomeDirectory,
  );
  await registerActiveSession(
    {
      schemaVersion: 1,
      runtime: "codex",
      sessionId: replacementSessionIdentifier,
      displayName: "replacement-codex",
      processId: process.pid,
      workingDirectory: process.cwd(),
      projectId: codexProjectIdentifier,
      registeredAt: "2026-09-04T10:00:00.000Z",
    },
    stateHomeDirectory,
  );
  await channelServer.deliverEnvelope(
    inboundEnvelope({
      sender: {
        runtime: "codex",
        sessionId: replacementSessionIdentifier,
        projectId: codexProjectIdentifier,
      },
      replyRoute: {
        runtime: "codex",
        sessionId: replacementSessionIdentifier,
        projectId: codexProjectIdentifier,
      },
    }),
    new AbortController().signal,
  );
  const replyResult = await client.callTool({
    name: "reply_to_codex",
    arguments: {
      conversation_id: conversationIdentifier,
      content: "replacement reply",
    },
  });

  assert.equal(notificationCount, 2);
  assert.equal(replyResult.isError, undefined);
  assert.deepEqual(queuedSessionIdentifiers, [replacementSessionIdentifier]);
});

test("serializes an in-flight reply with replacement delivery for the same conversation", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const replacementSessionIdentifier = "ea7220bc-cd1e-41f0-bf7f-413982f18a9c";
  const codexSessionRecord = {
    schemaVersion: 1 as const,
    runtime: "codex" as const,
    sessionId: codexSessionIdentifier,
    displayName: "codex-target",
    processId: process.pid,
    workingDirectory: process.cwd(),
    projectId: codexProjectIdentifier,
    registeredAt: "2026-09-03T12:00:00.000Z",
  };
  const replacementSessionRecord = {
    ...codexSessionRecord,
    sessionId: replacementSessionIdentifier,
    displayName: "replacement-codex",
  };
  let releaseFirstLookup: (() => void) | undefined;
  const firstLookupGate = new Promise<void>((resolveLookup) => {
    releaseFirstLookup = resolveLookup;
  });
  let observeFirstLookup: (() => void) | undefined;
  const firstLookupStarted = new Promise<void>((resolveLookup) => {
    observeFirstLookup = resolveLookup;
  });
  let originalSessionLookupCount = 0;
  let replacementSessionLookupCount = 0;
  let blockNextOriginalLookup = false;
  let originalSessionOffline = false;
  const queuedSessionIdentifiers: string[] = [];
  const channelServer = createClaudeChannelServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    notificationSender: async () => undefined,
    findSession: async (sessionIdentifier) => {
      if (sessionIdentifier === codexSessionIdentifier) {
        originalSessionLookupCount += 1;
        if (originalSessionOffline) {
          return undefined;
        }
        if (blockNextOriginalLookup) {
          blockNextOriginalLookup = false;
          observeFirstLookup?.();
          await firstLookupGate;
        }
        return codexSessionRecord;
      }
      if (sessionIdentifier === replacementSessionIdentifier) {
        replacementSessionLookupCount += 1;
        return replacementSessionRecord;
      }
      return undefined;
    },
    queueMessage: async ({ targetSessionId }) => {
      queuedSessionIdentifiers.push(targetSessionId);
      if (targetSessionId === codexSessionIdentifier) {
        originalSessionOffline = true;
      }
    },
  });
  const client = await connectClient(channelServer.mcpServer, testContext);

  await channelServer.deliverEnvelope(
    inboundEnvelope(),
    new AbortController().signal,
  );
  blockNextOriginalLookup = true;
  const originalReply = client.callTool({
    name: "reply_to_codex",
    arguments: {
      conversation_id: conversationIdentifier,
      content: "original reply",
    },
  });
  await firstLookupStarted;
  const replacementDelivery = channelServer.deliverEnvelope(
    inboundEnvelope({
      sender: {
        runtime: "codex",
        sessionId: replacementSessionIdentifier,
        projectId: codexProjectIdentifier,
      },
      replyRoute: {
        runtime: "codex",
        sessionId: replacementSessionIdentifier,
        projectId: codexProjectIdentifier,
      },
    }),
    new AbortController().signal,
  );
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  const replacementLookupsBeforeOriginalReplySettled =
    replacementSessionLookupCount;
  const queuesBeforeOriginalReplySettled = queuedSessionIdentifiers.length;
  releaseFirstLookup?.();
  await originalReply;
  await replacementDelivery;

  const replacementReply = await client.callTool({
    name: "reply_to_codex",
    arguments: {
      conversation_id: conversationIdentifier,
      content: "replacement reply",
    },
  });

  assert.equal(replacementLookupsBeforeOriginalReplySettled, 0);
  assert.equal(queuesBeforeOriginalReplySettled, 0);
  assert.ok(originalSessionLookupCount > 0);
  assert.equal(replacementReply.isError, undefined);
  assert.deepEqual(queuedSessionIdentifiers, [
    codexSessionIdentifier,
    replacementSessionIdentifier,
  ]);
});

test("restores an existing reply route after a failed notification delivery", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  await registerCodexSession(stateHomeDirectory);
  let notificationCount = 0;
  let queueCount = 0;
  const channelServer = createClaudeChannelServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    notificationSender: async () => {
      notificationCount += 1;
      if (notificationCount === 2) {
        throw new Error("notification failed");
      }
    },
    queueMessage: async () => {
      queueCount += 1;
    },
  });
  const client = await connectClient(channelServer.mcpServer, testContext);

  await channelServer.deliverEnvelope(
    inboundEnvelope(),
    new AbortController().signal,
  );
  await assert.rejects(() =>
    channelServer.deliverEnvelope(inboundEnvelope(), new AbortController().signal),
  );
  const replyResult = await client.callTool({
    name: "reply_to_codex",
    arguments: { conversation_id: conversationIdentifier, content: "late" },
  });
  assert.equal(replyResult.isError, undefined);
  assert.equal(queueCount, 1);
});

test("restores the prior route after a failed reply queue operation", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  await registerCodexSession(stateHomeDirectory);
  let queueAttemptCount = 0;
  const channelServer = createClaudeChannelServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    notificationSender: async () => undefined,
    queueMessage: async () => {
      queueAttemptCount += 1;
      if (queueAttemptCount === 1) {
        throw new Error("queue failed");
      }
    },
  });
  const client = await connectClient(channelServer.mcpServer, testContext);
  await channelServer.deliverEnvelope(
    inboundEnvelope(),
    new AbortController().signal,
  );

  const failedReply = await client.callTool({
    name: "reply_to_codex",
    arguments: { conversation_id: conversationIdentifier, content: "first" },
  });
  const retriedReply = await client.callTool({
    name: "reply_to_codex",
    arguments: { conversation_id: conversationIdentifier, content: "second" },
  });

  assert.equal(failedReply.isError, true);
  assert.equal(retriedReply.isError, undefined);
  assert.equal(queueAttemptCount, 2);
});

test("reports notification and route rollback failures together", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const routeStore = createConversationRouteStore({
    stateHomeDirectory,
    isAddressActive: async () => true,
  });
  routeStore.rollback = async () => {
    throw new Error("route rollback failed");
  };
  const channelServer = createClaudeChannelServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    conversationRouteStore: routeStore,
    notificationSender: async () => {
      throw new Error("notification failed");
    },
    queueMessage: async () => undefined,
  });

  await assert.rejects(
    channelServer.deliverEnvelope(
      inboundEnvelope(),
      new AbortController().signal,
    ),
    /notification failed.*route rollback failed/u,
  );
});

test("reports queue and route rollback failures together for send and reply", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  await registerCodexSession(stateHomeDirectory);
  const routeStore = createConversationRouteStore({
    stateHomeDirectory,
    isAddressActive: async () => true,
  });
  await routeStore.reserve(conversationIdentifier, {
    codex: inboundEnvelope().sender,
    claude: inboundEnvelope().recipient,
    codexCanReply: false,
    claudeCanReply: true,
  });
  routeStore.rollback = async () => {
    throw new Error("route rollback failed");
  };
  const channelServer = createClaudeChannelServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    conversationRouteStore: routeStore,
    notificationSender: async () => undefined,
    queueMessage: async () => {
      throw new Error("queue failed");
    },
  });
  const client = await connectClient(channelServer.mcpServer, testContext);

  const sendResult = await client.callTool({
    name: "send_to_codex",
    arguments: {
      session_id: codexSessionIdentifier,
      message_type: "message",
      content: "send",
    },
  });
  const replyResult = await client.callTool({
    name: "reply_to_codex",
    arguments: {
      conversation_id: conversationIdentifier,
      content: "reply",
    },
  });

  assert.equal(sendResult.isError, true);
  assert.match(sendResult.content[0]!.text as string, /queue failed.*route rollback failed/u);
  assert.equal(replyResult.isError, true);
  assert.match(replyResult.content[0]!.text as string, /queue failed.*route rollback failed/u);
});

test("refreshes TTL independently for persistent conversation routes", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  await registerCodexSession(stateHomeDirectory);
  const secondConversationIdentifier = "d2f86dee-55db-4a12-9a98-04bc3df54687";
  const thirdConversationIdentifier = "82708f24-3ea5-409a-9985-4ab05c59e803";
  let currentTimeMilliseconds = Date.parse("2026-09-04T08:00:00.000Z");
  let queueCount = 0;
  const channelServer = createClaudeChannelServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    conversationRouteTimeToLiveMilliseconds: 100,
    currentDate: () => new Date(currentTimeMilliseconds),
    notificationSender: async () => undefined,
    queueMessage: async () => {
      queueCount += 1;
    },
  });
  const client = await connectClient(channelServer.mcpServer, testContext);

  await channelServer.deliverEnvelope(
    inboundEnvelope({ conversationId: conversationIdentifier }),
    new AbortController().signal,
  );
  currentTimeMilliseconds += 10;
  await channelServer.deliverEnvelope(
    inboundEnvelope({ conversationId: secondConversationIdentifier }),
    new AbortController().signal,
  );
  currentTimeMilliseconds += 10;
  await channelServer.deliverEnvelope(
    inboundEnvelope({ conversationId: conversationIdentifier }),
    new AbortController().signal,
  );
  currentTimeMilliseconds += 10;
  await channelServer.deliverEnvelope(
    inboundEnvelope({ conversationId: thirdConversationIdentifier }),
    new AbortController().signal,
  );

  const secondConversationReply = await client.callTool({
    name: "reply_to_codex",
    arguments: { conversation_id: secondConversationIdentifier, content: "active" },
  });
  assert.equal(secondConversationReply.isError, undefined);
  const refreshedReply = await client.callTool({
    name: "reply_to_codex",
    arguments: { conversation_id: conversationIdentifier, content: "active" },
  });
  assert.equal(refreshedReply.isError, undefined);
  assert.equal(queueCount, 2);

  currentTimeMilliseconds += 101;
  const expiredReply = await client.callTool({
    name: "reply_to_codex",
    arguments: { conversation_id: conversationIdentifier, content: "expired" },
  });
  assert.equal(expiredReply.isError, true);
  assert.equal(queueCount, 2);
});

test("closes a blocked MCP transport on abort and waits without a late notification", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  await registerCodexSession(stateHomeDirectory);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "blocked-channel-client", version: "1.0.0" },
    { capabilities: {} },
  );
  testContext.after(async () => {
    await client.close().catch(() => undefined);
  });
  let releaseNotification: (() => void) | undefined;
  const notificationGate = new Promise<void>((resolveNotification) => {
    releaseNotification = resolveNotification;
  });
  let observeNotificationStart: (() => void) | undefined;
  const notificationStarted = new Promise<void>((resolveStart) => {
    observeNotificationStart = resolveStart;
  });
  let transportClosed = false;
  let forwardedNotificationCount = 0;
  const sendThroughTransport = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => {
    if ("method" in message && message.method === "notifications/claude/channel") {
      observeNotificationStart?.();
      await notificationGate;
      if (transportClosed) {
        throw new Error("transport closed before notification write");
      }
      forwardedNotificationCount += 1;
    }
    await sendThroughTransport(message, options);
  };
  const closeTransport = serverTransport.close.bind(serverTransport);
  serverTransport.close = async () => {
    transportClosed = true;
    await closeTransport();
  };
  const channelServer = createClaudeChannelServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    queueMessage: async () => undefined,
  });
  await channelServer.mcpServer.connect(serverTransport);
  await client.connect(clientTransport);
  const abortController = new AbortController();

  let deliverySettled = false;
  const deliveryPromise = channelServer
    .deliverEnvelope(inboundEnvelope(), abortController.signal)
    .finally(() => {
      deliverySettled = true;
    });
  await notificationStarted;
  abortController.abort();
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  const transportClosedBeforeRelease = transportClosed;
  const deliverySettledBeforeRelease = deliverySettled;
  releaseNotification?.();

  await assert.rejects(deliveryPromise, /aborted/u);
  assert.equal(transportClosedBeforeRelease, true);
  assert.equal(deliverySettledBeforeRelease, false);
  assert.equal(forwardedNotificationCount, 0);
});

test("close aborts every active delivery and waits for the MCP notification to settle", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  await registerCodexSession(stateHomeDirectory);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "close-abort-channel-client", version: "1.0.0" },
    { capabilities: {} },
  );
  testContext.after(async () => {
    await client.close().catch(() => undefined);
  });
  let releaseNotification: (() => void) | undefined;
  const notificationGate = new Promise<void>((resolveNotification) => {
    releaseNotification = resolveNotification;
  });
  let observeNotificationStart: (() => void) | undefined;
  const notificationStarted = new Promise<void>((resolveStart) => {
    observeNotificationStart = resolveStart;
  });
  let transportClosed = false;
  let forwardedNotificationCount = 0;
  const sendThroughTransport = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => {
    if ("method" in message && message.method === "notifications/claude/channel") {
      observeNotificationStart?.();
      await notificationGate;
      if (transportClosed) {
        throw new Error("transport closed before notification write");
      }
      forwardedNotificationCount += 1;
    }
    await sendThroughTransport(message, options);
  };
  const closeTransport = serverTransport.close.bind(serverTransport);
  serverTransport.close = async () => {
    transportClosed = true;
    await closeTransport();
  };
  const channelServer = createClaudeChannelServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    queueMessage: async () => undefined,
  });
  await channelServer.mcpServer.connect(serverTransport);
  await client.connect(clientTransport);
  let deliverySettled = false;
  const deliveryPromise = channelServer
    .deliverEnvelope(inboundEnvelope(), new AbortController().signal)
    .finally(() => {
      deliverySettled = true;
    });
  await notificationStarted;
  let closeSettled = false;
  const closePromise = channelServer.close().finally(() => {
    closeSettled = true;
  });
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  const transportClosedBeforeRelease = transportClosed;
  const deliverySettledBeforeRelease = deliverySettled;
  const closeSettledBeforeRelease = closeSettled;
  releaseNotification?.();

  await assert.rejects(deliveryPromise, /aborted/u);
  await closePromise;
  assert.equal(transportClosedBeforeRelease, true);
  assert.equal(deliverySettledBeforeRelease, false);
  assert.equal(closeSettledBeforeRelease, false);
  assert.equal(forwardedNotificationCount, 0);
});

test("waits for MCP initialization and closes once for EOF, transport close, and signals", async () => {
  const lifecycleTriggers = ["end", "transport", "SIGINT", "SIGTERM", "SIGHUP"] as const;

  for (const lifecycleTrigger of lifecycleTriggers) {
    const processEventSource = new EventEmitter();
    const standardInputEventSource = new EventEmitter();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const transportStarted = observeTransportStart(serverTransport);
    const client = new Client(
      { name: `lifecycle-${lifecycleTrigger}`, version: "1.0.0" },
      { capabilities: {} },
    );
    let socketStartCount = 0;
    let socketCloseCount = 0;
    let observeSocketClose: (() => void) | undefined;
    const socketClosed = new Promise<void>((resolveClose) => {
      observeSocketClose = resolveClose;
    });
    const runningServerPromise = startClaudeChannelServer({
      transport: serverTransport,
      processEventSource,
      standardInputEventSource,
      readSessionMetadata: async () => ({
        pid: process.pid,
        sessionId: claudeSessionIdentifier,
        name: "claude-owner",
        cwd: process.cwd(),
      }),
      resolveProject: async () => claudeProjectIdentifier,
      startSocketServer: async () => {
        socketStartCount += 1;
        return {
          socketPath: "/tmp/bridge-lifecycle.sock",
          close: async () => {
            socketCloseCount += 1;
            observeSocketClose?.();
          },
        };
      },
      notificationSender: async () => undefined,
      queueMessage: async () => undefined,
    });
    let startSettled = false;
    void runningServerPromise.then(
      () => {
        startSettled = true;
      },
      () => {
        startSettled = true;
      },
    );
    await transportStarted;
    const startSettledBeforeInitialization = startSettled;
    const handlersInstalledBeforeInitialization =
      standardInputEventSource.listenerCount("end") === 1 &&
      processEventSource.listenerCount("SIGINT") === 1 &&
      processEventSource.listenerCount("SIGTERM") === 1 &&
      processEventSource.listenerCount("SIGHUP") === 1;

    await client.connect(clientTransport);
    const runningServer = await runningServerPromise;
    assert.equal(socketStartCount, 1);
    if (lifecycleTrigger === "end") {
      standardInputEventSource.emit("end");
    } else if (lifecycleTrigger === "transport") {
      await client.close();
    } else {
      processEventSource.emit(lifecycleTrigger);
    }
    await socketClosed;
    const closedFromLifecycleTrigger = socketCloseCount === 1;
    await runningServer.close().catch(() => undefined);
    await client.close().catch(() => undefined);

    assert.equal(startSettledBeforeInitialization, false);
    assert.equal(handlersInstalledBeforeInitialization, true);
    assert.equal(closedFromLifecycleTrigger, true);
    assert.equal(socketCloseCount, 1);
    assert.equal(standardInputEventSource.listenerCount("end"), 0);
    assert.equal(processEventSource.listenerCount("SIGINT"), 0);
    assert.equal(processEventSource.listenerCount("SIGTERM"), 0);
    assert.equal(processEventSource.listenerCount("SIGHUP"), 0);
  }
});

test("removes lifecycle handlers and closes MCP when socket startup fails", async () => {
  const processEventSource = new EventEmitter();
  const standardInputEventSource = new EventEmitter();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const transportStarted = observeTransportStart(serverTransport);
  const client = new Client(
    { name: "startup-failure-client", version: "1.0.0" },
    { capabilities: {} },
  );
  let transportCloseCount = 0;
  const closeServerTransport = serverTransport.close.bind(serverTransport);
  serverTransport.close = async () => {
    transportCloseCount += 1;
    await closeServerTransport();
  };
  const runningServerPromise = startClaudeChannelServer({
    transport: serverTransport,
    processEventSource,
    standardInputEventSource,
    readSessionMetadata: async () => ({
      pid: process.pid,
      sessionId: claudeSessionIdentifier,
      name: "claude-owner",
      cwd: process.cwd(),
    }),
    resolveProject: async () => claudeProjectIdentifier,
    startSocketServer: async () => {
      throw new Error("socket startup failed");
    },
    notificationSender: async () => undefined,
    queueMessage: async () => undefined,
  });
  await transportStarted;
  assert.equal(standardInputEventSource.listenerCount("end"), 1);
  assert.equal(processEventSource.listenerCount("SIGINT"), 1);
  assert.equal(processEventSource.listenerCount("SIGTERM"), 1);
  assert.equal(processEventSource.listenerCount("SIGHUP"), 1);

  await client.connect(clientTransport);
  await assert.rejects(runningServerPromise, /socket startup failed/u);
  await client.close().catch(() => undefined);

  assert.equal(transportCloseCount > 0, true);
  assert.equal(standardInputEventSource.listenerCount("end"), 0);
  assert.equal(processEventSource.listenerCount("SIGINT"), 0);
  assert.equal(processEventSource.listenerCount("SIGTERM"), 0);
  assert.equal(processEventSource.listenerCount("SIGHUP"), 0);
});

test("closes cleanly when stdin ends before MCP initialization", async () => {
  const processEventSource = new EventEmitter();
  const standardInputEventSource = new EventEmitter();
  const [, serverTransport] = InMemoryTransport.createLinkedPair();
  const transportStarted = observeTransportStart(serverTransport);
  let socketStartCount = 0;
  const runningServerPromise = startClaudeChannelServer({
    transport: serverTransport,
    processEventSource,
    standardInputEventSource,
    readSessionMetadata: async () => ({
      pid: process.pid,
      sessionId: claudeSessionIdentifier,
      name: "claude-owner",
      cwd: process.cwd(),
    }),
    resolveProject: async () => claudeProjectIdentifier,
    startSocketServer: async () => {
      socketStartCount += 1;
      return {
        socketPath: "/tmp/unexpected-pre-initialization.sock",
        close: async () => undefined,
      };
    },
    notificationSender: async () => undefined,
    queueMessage: async () => undefined,
  });
  await transportStarted;

  standardInputEventSource.emit("end");

  await assert.rejects(
    runningServerPromise,
    /closed before MCP initialization/u,
  );
  assert.equal(socketStartCount, 0);
  assert.equal(standardInputEventSource.listenerCount("end"), 0);
  assert.equal(processEventSource.listenerCount("SIGINT"), 0);
  assert.equal(processEventSource.listenerCount("SIGTERM"), 0);
  assert.equal(processEventSource.listenerCount("SIGHUP"), 0);
});

test("closes the MCP transport even when socket cleanup fails", async (testContext) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "cleanup-client", version: "1.0.0" },
    { capabilities: {} },
  );
  testContext.after(() => client.close().catch(() => undefined));
  let transportCloseCount = 0;
  const closeServerTransport = serverTransport.close.bind(serverTransport);
  serverTransport.close = async () => {
    transportCloseCount += 1;
    await closeServerTransport();
  };
  let socketCloseCount = 0;
  const runningServerPromise = startClaudeChannelServer({
    transport: serverTransport,
    readSessionMetadata: async () => ({
      pid: process.pid,
      sessionId: claudeSessionIdentifier,
      name: "claude-owner",
      cwd: process.cwd(),
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
  await client.connect(clientTransport);
  const runningServer = await runningServerPromise;

  await assert.rejects(runningServer.close(), /Channel server cleanup failed/u);
  assert.equal(socketCloseCount, 1);
  assert.equal(transportCloseCount > 0, true);
});
