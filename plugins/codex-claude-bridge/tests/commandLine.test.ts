import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  runCommandLine,
  type CommandLineDependencies,
} from "../src/cli/main.js";
import type { DeliverClaudeMessageOptions } from "../src/channel/channelSocketClient.js";
import type {
  ConversationRoute,
  ConversationRouteEndpoints,
  ConversationRouteStore,
} from "../src/conversations/conversationRoutes.js";
import { createConversationRouteStore } from "../src/conversations/conversationRoutes.js";
import {
  listActiveSessions,
  type ActiveSessionRecord,
} from "../src/registry/activeSessionRegistry.js";
import { resolveProjectIdentity } from "../src/registry/projectIdentity.js";

const executeFile = promisify(execFile);
const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const firstProjectIdentifier = "0123456789abcdef01234567";
const secondProjectIdentifier = "fedcba987654321001234567";
const localCodexSessionIdentifier = "8d6380bf-1b93-44b3-b3da-a1a661cf8b69";
const localClaudeSessionIdentifier = "ad65b1c1-7386-4465-80f9-4de0a26bc212";
const remoteClaudeSessionIdentifier = "ea7220bc-cd1e-41f0-bf7f-413982f18a9c";
const conversationIdentifier = "5cb1e2fd-5b24-4699-bfea-878e9b147370";
const messageIdentifier = "3c4b3c10-21a7-4d6f-b964-3c816b9ed8db";
const generationIdentifier = "d2f86dee-55db-4a12-9a98-04bc3df54687";

interface ClaudePluginManifest {
  mcpServers: Record<
    string,
    {
      command: string;
      args: string[];
    }
  >;
}

async function waitForCondition(
  condition: () => Promise<boolean>,
  failureMessage: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) {
      return;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(failureMessage);
}

function activeSession(
  runtime: "codex" | "claude",
  sessionId: string,
  displayName: string,
  projectId = firstProjectIdentifier,
): ActiveSessionRecord {
  return {
    schemaVersion: 1,
    runtime,
    sessionId,
    displayName,
    processId: process.pid,
    workingDirectory: `/projects/${projectId}`,
    projectId,
    ...(runtime === "claude" ? { socketPath: `/state/sockets/${sessionId}.sock` } : {}),
    registeredAt: "2026-09-04T10:00:00.000Z",
  };
}

const localCodexSession = activeSession(
  "codex",
  localCodexSessionIdentifier,
  "codex-local",
);
const localClaudeSession = activeSession(
  "claude",
  localClaudeSessionIdentifier,
  "claude-local",
);
const remoteClaudeSession = activeSession(
  "claude",
  remoteClaudeSessionIdentifier,
  "claude-remote",
  secondProjectIdentifier,
);

function createMemoryRouteStore(
  initialRoutes: ConversationRoute[] = [],
): ConversationRouteStore & { routes: Map<string, ConversationRoute> } {
  const routes = new Map(initialRoutes.map((route) => [route.conversationId, route]));
  return {
    routes,
    async reserve(conversationId, endpoints) {
      const previousRoute = routes.get(conversationId);
      const route: ConversationRoute = {
        schemaVersion: 1,
        conversationId,
        generationId: generationIdentifier,
        expiresAt: "2026-09-04T10:15:00.000Z",
        ...endpoints,
      };
      routes.set(conversationId, route);
      return { route, ...(previousRoute === undefined ? {} : { previousRoute }) };
    },
    async findActive(conversationId) {
      return routes.get(conversationId);
    },
    async rollback(reservation) {
      const route = routes.get(reservation.route.conversationId);
      if (route?.generationId !== reservation.route.generationId) {
        return false;
      }
      if (reservation.previousRoute === undefined) {
        routes.delete(reservation.route.conversationId);
      } else {
        routes.set(reservation.route.conversationId, reservation.previousRoute);
      }
      return true;
    },
  };
}

function createDependencies(
  overrides: Partial<CommandLineDependencies> = {},
): CommandLineDependencies {
  const sessions = [localCodexSession, localClaudeSession, remoteClaudeSession];
  return {
    currentWorkingDirectory: "/projects/local",
    currentDate: () => new Date("2026-09-04T10:00:00.000Z"),
    randomIdentifier: (() => {
      const identifiers = [conversationIdentifier, messageIdentifier];
      let index = 0;
      return () => identifiers[index++] ?? messageIdentifier;
    })(),
    resolveProjectIdentity: async () => firstProjectIdentifier,
    listActiveSessions: async (filters = {}) =>
      sessions.filter(
        (session) =>
          (filters.runtime === undefined || session.runtime === filters.runtime) &&
          (filters.projectId === undefined || session.projectId === filters.projectId),
      ),
    conversationRouteStore: createMemoryRouteStore(),
    deliverClaudeMessage: async ({ envelope }) => ({
      delivered: true,
      messageId: envelope.messageId,
    }),
    runCodexSessionHookFromStandardInput: async () => undefined,
    startClaudeChannelServer: async () => undefined,
    installBridgeGlobally: async () => undefined,
    uninstallBridgeGlobally: async () => undefined,
    doctorBridgeInstallation: async () => ({ ok: true, checks: [] }),
    setupBridge: async () => ({ ok: true, checks: [] }),
    launchBridgeRuntime: async () => 0,
    ...overrides,
  };
}

async function runCommand(
  argumentsList: string[],
  dependencies: CommandLineDependencies,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCommandLine({
    arguments: argumentsList,
    dependencies,
    writeOutput: (value) => {
      stdout += value;
    },
    writeError: (value) => {
      stderr += value;
    },
  });
  return { exitCode, stdout, stderr };
}

test("lists active sessions in deterministic human and JSON formats", async () => {
  const dependencies = createDependencies();
  const humanResult = await runCommand(["sessions", "--runtime", "claude"], dependencies);
  const jsonResult = await runCommand(["sessions", "--runtime", "codex", "--json"], dependencies);

  assert.equal(humanResult.exitCode, 0);
  assert.equal(humanResult.stderr, "");
  assert.equal(
    humanResult.stdout,
    [
      `claude\t${localClaudeSessionIdentifier}\tclaude-local\t${firstProjectIdentifier}\t/projects/${firstProjectIdentifier}`,
      `claude\t${remoteClaudeSessionIdentifier}\tclaude-remote\t${secondProjectIdentifier}\t/projects/${secondProjectIdentifier}`,
      "",
    ].join("\n"),
  );
  assert.equal(jsonResult.exitCode, 0);
  assert.deepEqual(JSON.parse(jsonResult.stdout), {
    sessions: [
      {
        runtime: "codex",
        session_id: localCodexSessionIdentifier,
        display_name: "codex-local",
        project_id: firstProjectIdentifier,
        working_directory: `/projects/${firstProjectIdentifier}`,
      },
    ],
  });
});

test("filters sessions by a project path before formatting the result", async () => {
  const requestedProjectPaths: string[] = [];
  const dependencies = createDependencies({
    resolveProjectIdentity: async (projectPath) => {
      requestedProjectPaths.push(projectPath);
      return secondProjectIdentifier;
    },
  });

  const result = await runCommand(
    ["sessions", "--project", "/projects/remote", "--json"],
    dependencies,
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(requestedProjectPaths, ["/projects/remote"]);
  assert.deepEqual(
    JSON.parse(result.stdout).sessions.map((session: { session_id: string }) => session.session_id),
    [remoteClaudeSessionIdentifier],
  );
});

test("resolves display names only in the source project and stores correlation before delivery", async () => {
  const duplicateRemoteSource = activeSession(
    "codex",
    "82708f24-3ea5-409a-9985-4ab05c59e803",
    "codex-local",
    secondProjectIdentifier,
  );
  const sessions = [
    localCodexSession,
    duplicateRemoteSource,
    localClaudeSession,
    remoteClaudeSession,
  ];
  const routeStore = createMemoryRouteStore();
  const deliveredOptions: DeliverClaudeMessageOptions[] = [];
  const dependencies = createDependencies({
    listActiveSessions: async (filters = {}) =>
      sessions.filter(
        (session) =>
          (filters.runtime === undefined || session.runtime === filters.runtime) &&
          (filters.projectId === undefined || session.projectId === filters.projectId),
      ),
    conversationRouteStore: routeStore,
    deliverClaudeMessage: async (options) => {
      assert.notEqual(
        await routeStore.findActive(options.envelope.conversationId),
        undefined,
      );
      deliveredOptions.push(options);
      return { delivered: true, messageId: options.envelope.messageId };
    },
  });

  const result = await runCommand(
    [
      "send",
      "--from",
      "codex-local",
      "--to",
      "claude-local",
      "--type",
      "question",
      "--message",
      "status?",
      "--json",
    ],
    dependencies,
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    delivered: true,
    message_id: messageIdentifier,
    conversation_id: conversationIdentifier,
    acknowledgement: "transport acknowledgement only",
  });
  assert.deepEqual(deliveredOptions[0]?.envelope, {
    schemaVersion: 1,
    messageId: messageIdentifier,
    conversationId: conversationIdentifier,
    sentAt: "2026-09-04T10:00:00.000Z",
    messageType: "question",
    sender: {
      runtime: "codex",
      sessionId: localCodexSessionIdentifier,
      projectId: firstProjectIdentifier,
    },
    recipient: {
      runtime: "claude",
      sessionId: localClaudeSessionIdentifier,
      projectId: firstProjectIdentifier,
    },
    content: "status?",
    replyRoute: {
      runtime: "codex",
      sessionId: localCodexSessionIdentifier,
      projectId: firstProjectIdentifier,
    },
  });
});

test("permits explicit UUID selection across projects", async () => {
  let deliveredTarget: ActiveSessionRecord | undefined;
  const dependencies = createDependencies({
    deliverClaudeMessage: async (options) => {
      deliveredTarget = options.targetSession;
      return { delivered: true, messageId: options.envelope.messageId };
    },
  });

  const result = await runCommand(
    [
      "send",
      "--from",
      localCodexSessionIdentifier,
      "--to",
      remoteClaudeSessionIdentifier,
      "--type",
      "handoff",
      "--message",
      "continue",
    ],
    dependencies,
  );

  assert.equal(result.exitCode, 0);
  assert.equal(deliveredTarget?.sessionId, remoteClaudeSessionIdentifier);
});

test("fails on ambiguous or missing display-name targets without delivery", async () => {
  const duplicateClaudeTarget = activeSession(
    "claude",
    "82708f24-3ea5-409a-9985-4ab05c59e803",
    "claude-local",
  );
  let deliveryCount = 0;
  const dependencies = createDependencies({
    listActiveSessions: async (filters = {}) =>
      [localCodexSession, localClaudeSession, duplicateClaudeTarget].filter(
        (session) =>
          (filters.runtime === undefined || session.runtime === filters.runtime) &&
          (filters.projectId === undefined || session.projectId === filters.projectId),
      ),
    deliverClaudeMessage: async ({ envelope }) => {
      deliveryCount += 1;
      return { delivered: true, messageId: envelope.messageId };
    },
  });
  const commonArguments = [
    "send",
    "--from",
    localCodexSessionIdentifier,
    "--type",
    "message",
    "--message",
    "hello",
  ];

  const ambiguousResult = await runCommand(
    [...commonArguments, "--to", "claude-local"],
    dependencies,
  );
  const missingResult = await runCommand(
    [...commonArguments, "--to", "missing"],
    dependencies,
  );

  assert.equal(ambiguousResult.exitCode, 1);
  assert.match(ambiguousResult.stderr, /ambiguous/u);
  assert.match(ambiguousResult.stderr, new RegExp(localClaudeSessionIdentifier, "u"));
  assert.match(
    ambiguousResult.stderr,
    new RegExp(duplicateClaudeTarget.sessionId, "u"),
  );
  assert.equal(missingResult.exitCode, 1);
  assert.match(missingResult.stderr, /No active claude session/u);
  assert.match(missingResult.stderr, /claude-local/u);
  assert.match(missingResult.stderr, new RegExp(localClaudeSessionIdentifier, "u"));
  assert.equal(deliveryCount, 0);
});

test("accepts message content beginning with dashes and describes human output as transport-only", async () => {
  let deliveredContent = "";
  const dependencies = createDependencies({
    deliverClaudeMessage: async ({ envelope }) => {
      deliveredContent = envelope.content;
      return { delivered: true, messageId: envelope.messageId };
    },
  });

  const result = await runCommand(
    [
      "send",
      "--from",
      localCodexSessionIdentifier,
      "--to",
      localClaudeSessionIdentifier,
      "--type",
      "question",
      "--message",
      "--please-check-this",
    ],
    dependencies,
  );

  assert.equal(result.exitCode, 0);
  assert.equal(deliveredContent, "--please-check-this");
  assert.match(result.stdout, /Transport accepted/u);
  assert.match(result.stdout, /transport acknowledgement only/u);
  assert.doesNotMatch(result.stdout, /^Delivered/u);
});

test("routes global install and uninstall commands only with the explicit global flag", async () => {
  const calls: string[] = [];
  const dependencies = Object.assign(createDependencies(), {
    installBridgeGlobally: async (_writeOutput: unknown, confirmPendingCommandStopped: boolean) => {
      calls.push(`install:${String(confirmPendingCommandStopped)}`);
    },
    uninstallBridgeGlobally: async (_writeOutput: unknown, confirmPendingCommandStopped: boolean) => {
      calls.push(`uninstall:${String(confirmPendingCommandStopped)}`);
    },
    doctorBridgeInstallation: async () => ({ ok: true, checks: [] }),
  });

  assert.equal((await runCommand(["install", "--global"], dependencies)).exitCode, 0);
  assert.equal(
    (
      await runCommand(
        ["uninstall", "--global", "--confirm-pending-command-stopped"],
        dependencies,
      )
    ).exitCode,
    0,
  );
  assert.deepEqual(calls, ["install:false", "uninstall:true"]);
  assert.equal((await runCommand(["install"], dependencies)).exitCode, 1);
  assert.equal((await runCommand(["uninstall", "--project"], dependencies)).exitCode, 1);
});

test("runs setup with optional editor integration and prints the launch next steps", async () => {
  const setupCalls: unknown[] = [];
  const dependencies = Object.assign(createDependencies(), {
    setupBridge: async (
      _writeOutput: (value: string) => void,
      setupOptions: unknown,
    ) => {
      setupCalls.push(setupOptions);
      return {
        ok: true,
        checks: [
          { name: "active_sessions", status: "info" as const, message: "none active" },
        ],
      };
    },
  });

  const defaultResult = await runCommand(["setup"], dependencies);
  const explicitResult = await runCommand(
    ["setup", "--vscode-settings", "/tmp/settings.json"],
    dependencies,
  );
  const disabledResult = await runCommand(["setup", "--no-vscode"], dependencies);
  const conflictingResult = await runCommand(
    ["setup", "--no-vscode", "--vscode-settings", "/tmp/settings.json"],
    dependencies,
  );

  assert.equal(defaultResult.exitCode, 0);
  assert.equal(explicitResult.exitCode, 0);
  assert.equal(disabledResult.exitCode, 0);
  assert.equal(conflictingResult.exitCode, 1);
  assert.match(conflictingResult.stderr, /cannot be combined/u);
  assert.deepEqual(setupCalls, [
    { configureVscode: true, confirmPendingCommandStopped: false },
    {
      configureVscode: true,
      vscodeSettingsPath: "/tmp/settings.json",
      confirmPendingCommandStopped: false,
    },
    { configureVscode: false, confirmPendingCommandStopped: false },
  ]);
  assert.match(defaultResult.stdout, /INFO\tactive_sessions\tnone active/u);
  assert.match(defaultResult.stdout, /codex-claude-bridge launch claude/u);
  assert.match(defaultResult.stdout, /codex-claude-bridge launch codex/u);
});

test("returns a failing setup exit code when the doctor report fails", async () => {
  const dependencies = Object.assign(createDependencies(), {
    setupBridge: async () => ({
      ok: false,
      checks: [
        { name: "integrations", status: "failed" as const, message: "drifted" },
      ],
    }),
  });

  const result = await runCommand(["setup"], dependencies);

  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /FAILED\tintegrations\tdrifted/u);
});

test("passes launch arguments verbatim to the selected runtime and returns its exit code", async () => {
  const launchCalls: { runtime: string; argumentsList: string[] }[] = [];
  const dependencies = Object.assign(createDependencies(), {
    launchBridgeRuntime: async (runtime: string, argumentsList: string[]) => {
      launchCalls.push({ runtime, argumentsList });
      return runtime === "codex" ? 7 : 0;
    },
  });

  const claudeResult = await runCommand(
    ["launch", "claude", "--", "--resume", "--json"],
    dependencies,
  );
  const codexResult = await runCommand(
    ["launch", "codex", "exec", "--sandbox", "read-only"],
    dependencies,
  );
  const unknownRuntimeResult = await runCommand(["launch", "gemini"], dependencies);
  const missingRuntimeResult = await runCommand(["launch"], dependencies);

  assert.equal(claudeResult.exitCode, 0);
  assert.equal(codexResult.exitCode, 7);
  assert.equal(unknownRuntimeResult.exitCode, 1);
  assert.equal(missingRuntimeResult.exitCode, 1);
  assert.match(unknownRuntimeResult.stderr, /launch <claude\|codex>/u);
  assert.deepEqual(launchCalls, [
    { runtime: "claude", argumentsList: ["--", "--resume", "--json"] },
    { runtime: "codex", argumentsList: ["exec", "--sandbox", "read-only"] },
  ]);
});

test("formats doctor checks and returns non-zero only for required failures", async () => {
  const informationalDependencies = Object.assign(createDependencies(), {
    installBridgeGlobally: async () => undefined,
    uninstallBridgeGlobally: async () => undefined,
    doctorBridgeInstallation: async () => ({
      ok: true,
      checks: [{ name: "active_sessions", status: "info" as const, message: "none active" }],
    }),
  });
  const failingDependencies = Object.assign(createDependencies(), {
    installBridgeGlobally: async () => undefined,
    uninstallBridgeGlobally: async () => undefined,
    doctorBridgeInstallation: async () => ({
      ok: false,
      checks: [{ name: "claude_version", status: "failed" as const, message: "too old" }],
    }),
  });

  const informationalResult = await runCommand(["doctor", "--json"], informationalDependencies);
  const failingResult = await runCommand(["doctor"], failingDependencies);

  assert.equal(informationalResult.exitCode, 0);
  assert.equal(JSON.parse(informationalResult.stdout).checks[0].status, "info");
  assert.equal(failingResult.exitCode, 1);
  assert.match(failingResult.stdout, /FAILED\tclaude_version\ttoo old/u);
});

test("reverses a persisted route for a correlated reply", async () => {
  const initialRoute: ConversationRoute = {
    schemaVersion: 1,
    conversationId: conversationIdentifier,
    generationId: "ea7220bc-cd1e-41f0-bf7f-413982f18a9c",
    expiresAt: "2026-09-04T10:15:00.000Z",
    codex: {
      runtime: "codex",
      sessionId: localCodexSessionIdentifier,
      projectId: firstProjectIdentifier,
    },
    claude: {
      runtime: "claude",
      sessionId: localClaudeSessionIdentifier,
      projectId: firstProjectIdentifier,
    },
    codexCanReply: true,
    claudeCanReply: false,
  };
  const routeStore = createMemoryRouteStore([initialRoute]);
  let deliveredEnvelope: DeliverClaudeMessageOptions["envelope"] | undefined;
  const dependencies = createDependencies({
    randomIdentifier: () => messageIdentifier,
    conversationRouteStore: routeStore,
    deliverClaudeMessage: async ({ envelope }) => {
      deliveredEnvelope = envelope;
      return { delivered: true, messageId: envelope.messageId };
    },
  });

  const result = await runCommand(
    [
      "reply",
      "--conversation",
      conversationIdentifier,
      "--message",
      "done",
      "--json",
    ],
    dependencies,
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(deliveredEnvelope, {
    schemaVersion: 1,
    messageId: messageIdentifier,
    conversationId: conversationIdentifier,
    sentAt: "2026-09-04T10:00:00.000Z",
    messageType: "reply",
    sender: initialRoute.codex,
    recipient: initialRoute.claude,
    content: "done",
    replyRoute: initialRoute.codex,
  });
});

test("allows only one concurrent CLI reply to consume a persisted generation", async (testContext) => {
  const stateHomeDirectory = await mkdtemp(join(tmpdir(), "ccb-cli-reply-"));
  testContext.after(() => rm(stateHomeDirectory, { recursive: true, force: true }));
  const firstStore = createConversationRouteStore({
    stateHomeDirectory,
    randomIdentifier: (() => {
      const identifiers = [generationIdentifier, messageIdentifier];
      let index = 0;
      return () => identifiers[index++] ?? messageIdentifier;
    })(),
    isAddressActive: async () => true,
  });
  const secondStore = createConversationRouteStore({
    stateHomeDirectory,
    randomIdentifier: () => "82708f24-3ea5-409a-9985-4ab05c59e803",
    isAddressActive: async () => true,
  });
  await firstStore.reserve(conversationIdentifier, {
    codex: {
      runtime: "codex",
      sessionId: localCodexSessionIdentifier,
      projectId: firstProjectIdentifier,
    },
    claude: {
      runtime: "claude",
      sessionId: localClaudeSessionIdentifier,
      projectId: firstProjectIdentifier,
    },
    codexCanReply: true,
    claudeCanReply: false,
  });
  let deliveryCount = 0;
  const sharedOverrides = {
    randomIdentifier: () => messageIdentifier,
    deliverClaudeMessage: async ({ envelope }: DeliverClaudeMessageOptions) => {
      deliveryCount += 1;
      return { delivered: true as const, messageId: envelope.messageId };
    },
  };

  const results = await Promise.all([
    runCommand(
      ["reply", "--conversation", conversationIdentifier, "--message", "first"],
      createDependencies({ ...sharedOverrides, conversationRouteStore: firstStore }),
    ),
    runCommand(
      ["reply", "--conversation", conversationIdentifier, "--message", "second"],
      createDependencies({ ...sharedOverrides, conversationRouteStore: secondStore }),
    ),
  ]);

  assert.equal(results.filter(({ exitCode }) => exitCode === 0).length, 1);
  assert.equal(results.filter(({ exitCode }) => exitCode === 1).length, 1);
  assert.equal(deliveryCount, 1);
});

test("rolls back its route generation when Channel transport rejects delivery", async () => {
  const routeStore = createMemoryRouteStore();
  const dependencies = createDependencies({
    conversationRouteStore: routeStore,
    deliverClaudeMessage: async () => ({
      delivered: false,
      error: "Channel rejected delivery",
    }),
  });

  const result = await runCommand(
    [
      "send",
      "--from",
      localCodexSessionIdentifier,
      "--to",
      localClaudeSessionIdentifier,
      "--type",
      "message",
      "--message",
      "hello",
    ],
    dependencies,
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Channel rejected delivery/u);
  assert.equal(await routeStore.findActive(conversationIdentifier), undefined);
});

test("preserves the transport failure when route rollback also fails", async () => {
  const routeStore = createMemoryRouteStore();
  routeStore.rollback = async () => {
    throw new Error("rollback storage unavailable");
  };
  const dependencies = createDependencies({
    conversationRouteStore: routeStore,
    deliverClaudeMessage: async () => {
      throw new Error("transport refused connection");
    },
  });

  const result = await runCommand(
    [
      "send",
      "--from",
      localCodexSessionIdentifier,
      "--to",
      localClaudeSessionIdentifier,
      "--type",
      "message",
      "--message",
      "hello",
    ],
    dependencies,
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /transport refused connection/u);
  assert.match(result.stderr, /rollback storage unavailable/u);
});

test("strictly rejects unknown, duplicate, and missing command arguments", async () => {
  const dependencies = createDependencies();
  const invalidArgumentLists = [
    ["sessions", "--unknown"],
    ["sessions", "--json", "--json"],
    ["send", "--from", localCodexSessionIdentifier],
    ["reply", "--conversation", conversationIdentifier, "--message"],
    ["unknown"],
  ];

  for (const invalidArguments of invalidArgumentLists) {
    const result = await runCommand(invalidArguments, dependencies);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.notEqual(result.stderr, "");
  }
});

test("dispatches internal hook and Channel commands without user output", async () => {
  const dispatchedCommands: string[] = [];
  const dependencies = createDependencies({
    runCodexSessionHookFromStandardInput: async () => {
      dispatchedCommands.push("codex-session-hook");
    },
    startClaudeChannelServer: async () => {
      dispatchedCommands.push("claude-channel");
    },
  });

  const hookResult = await runCommand(["codex-session-hook"], dependencies);
  const channelResult = await runCommand(["claude-channel"], dependencies);

  assert.deepEqual(dispatchedCommands, ["codex-session-hook", "claude-channel"]);
  assert.deepEqual(hookResult, { exitCode: 0, stdout: "", stderr: "" });
  assert.deepEqual(channelResult, { exitCode: 0, stdout: "", stderr: "" });
});

test("builds and executes the package bin entrypoint against an isolated empty state", async (testContext) => {
  const stateHomeDirectory = await mkdtemp(join(tmpdir(), "ccb-bin-state-"));
  testContext.after(() => rm(stateHomeDirectory, { recursive: true, force: true }));
  await executeFile(process.execPath, [
    join(packageDirectory, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    join(packageDirectory, "tsconfig.json"),
  ]);

  const { stdout, stderr } = await executeFile(
    process.execPath,
    [join(packageDirectory, "dist", "bin", "codexClaudeBridge.js"), "sessions", "--json"],
    {
      env: {
        ...process.env,
        XDG_STATE_HOME: stateHomeDirectory,
      },
    },
  );

  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { sessions: [] });
});

test("starts and cleans up the exact Claude MCP manifest command through a global bin", async (testContext) => {
  const temporaryDirectory = await mkdtemp("/tmp/ccb-mcp-command-");
  const homeDirectory = join(temporaryDirectory, "home");
  const stateHomeDirectory = join(temporaryDirectory, "state");
  const cachedPluginDirectory = join(temporaryDirectory, "plugin-cache");
  const cachedManifestDirectory = join(cachedPluginDirectory, ".claude-plugin");
  const temporaryBinaryDirectory = join(temporaryDirectory, "bin");
  const sourceManifestPath = join(
    packageDirectory,
    ".claude-plugin",
    "plugin.json",
  );
  const cachedManifestPath = join(cachedManifestDirectory, "plugin.json");
  const claudeSessionsDirectory = join(homeDirectory, ".claude", "sessions");
  let client: Client | undefined;
  testContext.after(async () => {
    await client?.close().catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  await Promise.all([
    mkdir(cachedManifestDirectory, { recursive: true }),
    mkdir(temporaryBinaryDirectory, { recursive: true }),
    mkdir(claudeSessionsDirectory, { recursive: true }),
  ]);
  await copyFile(sourceManifestPath, cachedManifestPath);
  await assert.rejects(access(join(cachedPluginDirectory, "node_modules")), {
    code: "ENOENT",
  });
  await executeFile(process.execPath, [
    join(packageDirectory, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    join(packageDirectory, "tsconfig.json"),
  ]);
  const compiledBridgePath = join(
    packageDirectory,
    "dist",
    "bin",
    "codexClaudeBridge.js",
  );
  await chmod(compiledBridgePath, 0o700);
  await symlink(
    compiledBridgePath,
    join(temporaryBinaryDirectory, "codex-claude-bridge"),
  );

  const sessionIdentifier = "01994b35-1234-7abc-8def-0123456789ab";
  await writeFile(
    join(claudeSessionsDirectory, `${process.pid}.json`),
    `${JSON.stringify({
      pid: process.pid,
      sessionId: sessionIdentifier,
      name: "manifest-smoke-test",
      cwd: packageDirectory,
    })}\n`,
    { mode: 0o600 },
  );

  const manifest = JSON.parse(
    await readFile(cachedManifestPath, "utf8"),
  ) as ClaudePluginManifest;
  const serverConfiguration = manifest.mcpServers["codex-claude-bridge"];
  assert.ok(serverConfiguration);
  let standardError = "";
  const transport = new StdioClientTransport({
    command: serverConfiguration.command,
    args: serverConfiguration.args,
    cwd: cachedPluginDirectory,
    env: {
      HOME: homeDirectory,
      PATH: `${temporaryBinaryDirectory}:${dirname(process.execPath)}:/usr/bin:/bin`,
      XDG_STATE_HOME: stateHomeDirectory,
      CLAUDE_PLUGIN_ROOT: cachedPluginDirectory,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    standardError += String(chunk);
  });
  client = new Client(
    { name: "manifest-smoke-client", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 4);

  const projectIdentifier = await resolveProjectIdentity(packageDirectory);
  let registeredSession: ActiveSessionRecord | undefined;
  await waitForCondition(async () => {
    [registeredSession] = await listActiveSessions(
      { runtime: "claude", projectId: projectIdentifier },
      stateHomeDirectory,
    );
    return registeredSession !== undefined;
  }, `Claude MCP manifest command did not register its session: ${standardError}`);
  assert.equal(registeredSession?.sessionId, sessionIdentifier);
  assert.equal(registeredSession?.processId, process.pid);
  assert.ok(registeredSession?.socketPath);
  const socketPath = registeredSession.socketPath;

  await client.close();
  client = undefined;
  await waitForCondition(async () => {
    const sessions = await listActiveSessions(
      { runtime: "claude", projectId: projectIdentifier },
      stateHomeDirectory,
    );
    return sessions.length === 0;
  }, "Claude MCP manifest command did not remove its session");
  await assert.rejects(access(socketPath), { code: "ENOENT" });
  assert.equal(standardError, "");
});

test("keeps Claude MCP inline and leaves no root MCP configuration discoverable by Codex", async () => {
  const claudeManifest = JSON.parse(
    await readFile(join(packageDirectory, ".claude-plugin", "plugin.json"), "utf8"),
  );
  const codexManifest = JSON.parse(
    await readFile(join(packageDirectory, ".codex-plugin", "plugin.json"), "utf8"),
  );
  const skill = await readFile(
    join(packageDirectory, "skills", "codex-claude-bridge", "SKILL.md"),
    "utf8",
  );

  await assert.rejects(access(join(packageDirectory, ".mcp.json")), { code: "ENOENT" });
  assert.deepEqual(claudeManifest.mcpServers, {
    "codex-claude-bridge": {
      command: "codex-claude-bridge",
      args: ["claude-channel"],
    },
  });
  assert.equal(
    JSON.stringify(claudeManifest.mcpServers).includes("CLAUDE_PLUGIN_ROOT"),
    false,
  );
  assert.equal(codexManifest.skills, "./skills/");
  assert.equal(Object.hasOwn(codexManifest, "mcpServers"), false);
  assert.equal(Object.hasOwn(codexManifest, "hooks"), false);
  assert.equal(typeof codexManifest.author.name, "string");
  assert.equal(codexManifest.interface.displayName, "Codex-Claude Bridge");
  assert.equal(codexManifest.interface.developerName, codexManifest.author.name);
  assert.equal(Array.isArray(codexManifest.interface.defaultPrompt), true);
  assert.equal(claudeManifest.author.name, codexManifest.author.name);
  assert.match(skill, /^---\nname: codex-claude-bridge\ndescription: .+\n---\n/u);
  assert.match(skill, /sessions/u);
  assert.match(skill, /Never broadcast/u);
  assert.match(skill, /current task scope/u);
  assert.match(skill, /reply --conversation/u);
});
