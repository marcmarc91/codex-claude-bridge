import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  maximumCodexSessionHookInputUtf8Bytes,
  runCodexSessionHook,
  runCodexSessionHookFromStandardInput,
} from "../src/hooks/codexSessionHook.js";
import { listActiveSessions } from "../src/registry/activeSessionRegistry.js";
import { resolveProjectIdentity } from "../src/registry/projectIdentity.js";
import { resolveSessionRegistryDirectory } from "../src/runtime/paths.js";

const executeFile = promisify(execFile);
const pluginDirectory = fileURLToPath(new URL("..", import.meta.url));

interface ManifestCommandHook {
  command: string;
  timeout: number;
}

interface HookManifest {
  hooks: {
    SessionStart?: Array<{ hooks?: ManifestCommandHook[] }>;
    SessionEnd?: Array<{ hooks?: ManifestCommandHook[] }>;
  };
}

interface ManifestInvocationResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnedProcessIdentifier: number | undefined;
  standardError: string;
  standardOutput: string;
  timedOut: boolean;
}

async function invokeHookEntry(input: object, stateHomeDirectory: string): Promise<{ exitCode: number | null; standardOutput: string }> {
  return invokeSerializedHookEntry(JSON.stringify(input), stateHomeDirectory);
}

async function invokeSerializedHookEntry(serializedInput: string, stateHomeDirectory: string): Promise<{ exitCode: number | null; standardOutput: string }> {
  return new Promise((resolveProcess, rejectProcess) => {
    const childProcess = spawn(process.execPath, [join(pluginDirectory, "dist/hooks/codexSessionHook.js")], {
      cwd: pluginDirectory,
      env: { ...process.env, XDG_STATE_HOME: stateHomeDirectory },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let standardOutput = "";
    childProcess.stdout.on("data", (chunk) => { standardOutput += chunk; });
    childProcess.once("error", rejectProcess);
    childProcess.once("close", (exitCode) => resolveProcess({ exitCode, standardOutput }));
    childProcess.stdin.end(serializedInput);
  });
}

async function writeExecutableShim(shimPath: string, scriptPath: string): Promise<void> {
  await writeFile(
    shimPath,
    `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
    { mode: 0o755 },
  );
}

async function invokeManifestCommand(
  manifestHook: ManifestCommandHook,
  serializedInput: string,
  stateHomeDirectory: string,
  workingDirectory: string,
  pluginRootDirectory = pluginDirectory,
  executableSearchPath = "/opt/homebrew/bin:/usr/bin:/bin",
): Promise<ManifestInvocationResult> {
  return new Promise((resolveProcess, rejectProcess) => {
    const childProcess = spawn("/bin/zsh", ["-lc", manifestHook.command], {
      cwd: workingDirectory,
      env: {
        ...process.env,
        PATH: executableSearchPath,
        PLUGIN_ROOT: pluginRootDirectory,
        XDG_STATE_HOME: stateHomeDirectory,
        ZDOTDIR: join(stateHomeDirectory, "zsh"),
      },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const spawnedProcessIdentifier = childProcess.pid;
    let standardError = "";
    let standardOutput = "";
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      childProcess.kill("SIGKILL");
    }, manifestHook.timeout * 1_000);

    childProcess.stdout.on("data", (chunk) => {
      standardOutput += String(chunk);
    });
    childProcess.stderr.on("data", (chunk) => {
      standardError += String(chunk);
    });
    childProcess.once("error", (error) => {
      clearTimeout(timeoutHandle);
      rejectProcess(error);
    });
    childProcess.once("close", (exitCode, signal) => {
      clearTimeout(timeoutHandle);
      resolveProcess({
        exitCode,
        signal,
        spawnedProcessIdentifier,
        standardError,
        standardOutput,
        timedOut,
      });
    });
    childProcess.stdin.end(serializedInput);
  });
}

test("hook-ul Codex înregistrează și elimină numai sesiunea specificată", async (testContext) => {
  const stateHomeDirectory = await mkdtemp(join(tmpdir(), "codex-claude-bridge-"));
  const originalStateHomeDirectory = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHomeDirectory;
  testContext.after(async () => {
    if (originalStateHomeDirectory === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = originalStateHomeDirectory;
    }
    await rm(stateHomeDirectory, { recursive: true, force: true });
  });

  const firstSessionIdentifier = "3c4b3c10-21a7-4d6f-b964-3c816b9ed8db";
  const secondSessionIdentifier = "5cb1e2fd-5b24-4699-bfea-878e9b147370";
  const workingDirectory = process.cwd();
  const projectIdentifier = await resolveProjectIdentity(workingDirectory);
  const sessionStartInput = {
    hook_event_name: "SessionStart",
    cwd: workingDirectory,
    model: "gpt-5.6-sol",
    permission_mode: "default",
    source: "startup",
    transcript_path: "/Users/codex-user/.codex/sessions/rollout-test.jsonl",
  };

  await runCodexSessionHook({ ...sessionStartInput, session_id: firstSessionIdentifier });
  await runCodexSessionHook({ ...sessionStartInput, session_id: secondSessionIdentifier });
  await runCodexSessionHook({
    hook_event_name: "SessionEnd",
    session_id: firstSessionIdentifier,
    cwd: workingDirectory,
  });

  assert.deepEqual(
    (await listActiveSessions({ runtime: "codex", projectId: projectIdentifier })).map(
      ({ sessionId }) => sessionId,
    ),
    [secondSessionIdentifier],
  );
});

test("entrypoint-ul compilat execută hook-ul din manifest fără stdout și ignoră stdin malformat", async (testContext) => {
  const stateHomeDirectory = await mkdtemp(join(tmpdir(), "ccb-"));
  testContext.after(() => rm(stateHomeDirectory, { recursive: true, force: true }));
  await executeFile(join(pluginDirectory, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], { cwd: pluginDirectory });
  const sessionId = "ad65b1c1-7386-4465-80f9-4de0a26bc212";
  const workingDirectory = process.cwd();
  const invocation = await invokeHookEntry(
    {
      hook_event_name: "SessionStart",
      session_id: sessionId,
      cwd: workingDirectory,
      transcript_path: "/Users/codex-user/.codex/sessions/rollout-entrypoint-test.jsonl",
    },
    stateHomeDirectory,
  );
  assert.equal(invocation.exitCode, 0);
  assert.equal(invocation.standardOutput, "");
  assert.equal((await listActiveSessions({ runtime: "codex", projectId: await resolveProjectIdentity(workingDirectory) }, stateHomeDirectory))[0]?.sessionId, sessionId);
  assert.equal((await invokeSerializedHookEntry("{", stateHomeDirectory)).exitCode, 0);
});

test("hook-ul oprește citirea imediat ce stdin depășește limita UTF-8", async () => {
  let readPastLimit = false;
  const oversizedInput = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.alloc(maximumCodexSessionHookInputUtf8Bytes, 0x20);
      yield Buffer.from("x");
      readPastLimit = true;
      throw new Error("input consumed past the bound");
    },
  };

  await runCodexSessionHookFromStandardInput(oversizedInput);

  assert.equal(readPastLimit, false);
});

test("comenzile manifestului rulează dintr-un cache fără dependențe și păstrează ciclul de viață al PID-ului părinte", async (testContext) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ccb-manifest-"));
  const stateHomeDirectory = join(temporaryDirectory, "state");
  const cachedPluginDirectory = join(temporaryDirectory, "plugin-cache");
  const temporaryBinaryDirectory = join(temporaryDirectory, "bin");
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await executeFile(join(pluginDirectory, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], {
    cwd: pluginDirectory,
  });
  await mkdir(cachedPluginDirectory, { recursive: true });
  await cp(join(pluginDirectory, "dist"), join(cachedPluginDirectory, "dist"), {
    recursive: true,
  });
  await mkdir(temporaryBinaryDirectory, { recursive: true });
  await mkdir(join(stateHomeDirectory, "zsh"), { recursive: true });
  await writeExecutableShim(
    join(temporaryBinaryDirectory, "codex-claude-bridge"),
    join(pluginDirectory, "dist/bin/codexClaudeBridge.js"),
  );

  const manifest = JSON.parse(
    await readFile(join(pluginDirectory, "hooks/hooks.json"), "utf8"),
  ) as HookManifest;
  const sessionStartHook = manifest.hooks.SessionStart?.[0]?.hooks?.[0];
  const sessionEndHook = manifest.hooks.SessionEnd?.[0]?.hooks?.[0];
  assert.ok(sessionStartHook);
  assert.ok(sessionEndHook);
  assert.equal(sessionStartHook.timeout, 5);

  const sessionIdentifier = "01994b35-1234-7abc-8def-0123456789ab";
  const workingDirectory = pluginDirectory;
  const executableSearchPath = `${temporaryBinaryDirectory}:/opt/homebrew/bin:/usr/bin:/bin`;
  const startInvocation = await invokeManifestCommand(
    sessionStartHook,
    JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: sessionIdentifier,
      cwd: workingDirectory,
      model: "gpt-5.6-sol",
      permission_mode: "default",
      source: "startup",
      transcript_path: "/Users/codex-user/.codex/sessions/rollout-manifest-test.jsonl",
    }),
    stateHomeDirectory,
    workingDirectory,
    cachedPluginDirectory,
    executableSearchPath,
  );

  assert.equal(startInvocation.timedOut, false, startInvocation.standardError);
  assert.equal(startInvocation.exitCode, 0, startInvocation.standardError);
  assert.equal(startInvocation.signal, null);
  assert.equal(startInvocation.standardOutput, "");
  assert.notEqual(startInvocation.spawnedProcessIdentifier, process.pid);
  assert.equal(sessionEndHook.timeout, 3);

  const projectIdentifier = await resolveProjectIdentity(workingDirectory);
  const sessionRecordPath = join(
    resolveSessionRegistryDirectory(stateHomeDirectory, projectIdentifier),
    `${sessionIdentifier}.json`,
  );
  const storedRecord = JSON.parse(
    await readFile(sessionRecordPath, "utf8"),
  ) as { processId: number };
  assert.equal(storedRecord.processId, process.pid);
  assert.doesNotThrow(() => process.kill(storedRecord.processId, 0));

  const endInvocation = await invokeManifestCommand(
    sessionEndHook,
    JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: sessionIdentifier,
      cwd: workingDirectory,
    }),
    stateHomeDirectory,
    workingDirectory,
    cachedPluginDirectory,
    executableSearchPath,
  );

  assert.equal(endInvocation.timedOut, false, endInvocation.standardError);
  assert.equal(endInvocation.exitCode, 0, endInvocation.standardError);
  assert.equal(endInvocation.signal, null);
  assert.equal(endInvocation.standardOutput, "");
  assert.deepEqual(
    await listActiveSessions(
      { runtime: "codex", projectId: projectIdentifier },
      stateHomeDirectory,
    ),
    [],
  );
});

async function withIsolatedStateHomeDirectory(
  testContext: test.TestContext,
): Promise<string> {
  const stateHomeDirectory = await mkdtemp(join(tmpdir(), "codex-claude-bridge-"));
  const originalStateHomeDirectory = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHomeDirectory;
  testContext.after(async () => {
    if (originalStateHomeDirectory === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = originalStateHomeDirectory;
    }
    await rm(stateHomeDirectory, { recursive: true, force: true });
  });
  return stateHomeDirectory;
}

async function failingOwningClaudeSessionReader(): Promise<never> {
  throw new Error("metadata indisponibilă");
}

test("hook-ul nu înregistrează sesiunile deținute de Claude Code când metadata se potrivește", async (testContext) => {
  await withIsolatedStateHomeDirectory(testContext);

  const claudeSessionIdentifier = "7b2f8c31-4d5a-4e6b-9c0d-1a2b3c4d5e6f";
  const workingDirectory = process.cwd();
  const projectIdentifier = await resolveProjectIdentity(workingDirectory);
  const sessionStartInput = {
    hook_event_name: "SessionStart",
    session_id: claudeSessionIdentifier,
    cwd: workingDirectory,
  };

  await runCodexSessionHook(sessionStartInput, async (parentProcessIdentifier) => ({
    pid: parentProcessIdentifier,
    sessionId: claudeSessionIdentifier,
    name: "claude-session",
    cwd: workingDirectory,
  }));

  assert.deepEqual(await listActiveSessions({ projectId: projectIdentifier }), []);
});

test("hook-ul nu înregistrează un subagent Claude Code când metadata eșuează dar procesul părinte este claude", async (testContext) => {
  await withIsolatedStateHomeDirectory(testContext);

  const sessionIdentifier = "7b2f8c31-4d5a-4e6b-9c0d-1a2b3c4d5e6f";
  const workingDirectory = process.cwd();
  const projectIdentifier = await resolveProjectIdentity(workingDirectory);
  const sessionStartInput = {
    hook_event_name: "SessionStart",
    session_id: sessionIdentifier,
    cwd: workingDirectory,
  };

  await runCodexSessionHook(sessionStartInput, failingOwningClaudeSessionReader, {
    readParentProcessCommandLine: async () => "/opt/homebrew/bin/claude",
    environment: {},
  });

  assert.deepEqual(await listActiveSessions({ projectId: projectIdentifier }), []);
});

test("hook-ul înregistrează sesiunea ca 'codex' când metadata eșuează dar procesul părinte este binarul codex", async (testContext) => {
  await withIsolatedStateHomeDirectory(testContext);

  const sessionIdentifier = "5a6f9c31-4d5a-4e6b-9c0d-1a2b3c4d5eab";
  const workingDirectory = process.cwd();
  const projectIdentifier = await resolveProjectIdentity(workingDirectory);
  const sessionStartInput = {
    hook_event_name: "SessionStart",
    session_id: sessionIdentifier,
    cwd: workingDirectory,
  };

  await runCodexSessionHook(sessionStartInput, failingOwningClaudeSessionReader, {
    readParentProcessCommandLine: async () => "/Users/marc/.local/bin/codex",
    environment: {},
  });

  const registeredSessions = await listActiveSessions({ projectId: projectIdentifier });
  assert.equal(registeredSessions.length, 1);
  assert.equal(registeredSessions[0]?.runtime, "codex");
});

test("hook-ul înregistrează sesiunea ca 'codex' pornind de la transcript_path sub .codex când procesul părinte e necunoscut", async (testContext) => {
  await withIsolatedStateHomeDirectory(testContext);

  const sessionIdentifier = "1234abcd-4d5a-4e6b-9c0d-1a2b3c4d5eab";
  const workingDirectory = process.cwd();
  const projectIdentifier = await resolveProjectIdentity(workingDirectory);
  const sessionStartInput = {
    hook_event_name: "SessionStart",
    session_id: sessionIdentifier,
    cwd: workingDirectory,
    transcript_path: "/Users/marc/.codex/sessions/2026/09/rollout-abc.jsonl",
  };

  await runCodexSessionHook(sessionStartInput, failingOwningClaudeSessionReader, {
    readParentProcessCommandLine: async () => undefined,
    environment: {},
  });

  const registeredSessions = await listActiveSessions({ projectId: projectIdentifier });
  assert.equal(registeredSessions.length, 1);
  assert.equal(registeredSessions[0]?.runtime, "codex");
});

test("hook-ul dezînregistrează la SessionEnd chiar dacă acel invocare este identificată drept 'claude'", async (testContext) => {
  await withIsolatedStateHomeDirectory(testContext);

  const sessionIdentifier = "3344abcd-4d5a-4e6b-9c0d-1a2b3c4d5eab";
  const workingDirectory = process.cwd();
  const projectIdentifier = await resolveProjectIdentity(workingDirectory);

  await runCodexSessionHook(
    {
      hook_event_name: "SessionStart",
      session_id: sessionIdentifier,
      cwd: workingDirectory,
      transcript_path: "/Users/marc/.codex/sessions/rollout-end-test.jsonl",
    },
    failingOwningClaudeSessionReader,
    { readParentProcessCommandLine: async () => undefined, environment: {} },
  );
  assert.equal((await listActiveSessions({ projectId: projectIdentifier })).length, 1);

  await runCodexSessionHook(
    { hook_event_name: "SessionEnd", session_id: sessionIdentifier, cwd: workingDirectory },
    failingOwningClaudeSessionReader,
    {
      readParentProcessCommandLine: async () => undefined,
      environment: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "some-session" },
    },
  );

  assert.deepEqual(await listActiveSessions({ projectId: projectIdentifier }), []);
});

test("hook-ul nu înregistrează și nu aruncă nicio eroare când toate dovezile despre rulanță sunt necunoscute", async (testContext) => {
  await withIsolatedStateHomeDirectory(testContext);

  const sessionIdentifier = "9988abcd-4d5a-4e6b-9c0d-1a2b3c4d5eab";
  const workingDirectory = process.cwd();
  const projectIdentifier = await resolveProjectIdentity(workingDirectory);
  const sessionStartInput = {
    hook_event_name: "SessionStart",
    session_id: sessionIdentifier,
    cwd: workingDirectory,
    transcript_path: null,
  };

  await assert.doesNotReject(
    runCodexSessionHook(sessionStartInput, failingOwningClaudeSessionReader, {
      readParentProcessCommandLine: async () => undefined,
      environment: {},
    }),
  );

  assert.deepEqual(await listActiveSessions({ projectId: projectIdentifier }), []);
});
