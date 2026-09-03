import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runCodexSessionHook } from "../src/hooks/codexSessionHook.js";
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

async function invokeManifestCommand(
  manifestHook: ManifestCommandHook,
  serializedInput: string,
  stateHomeDirectory: string,
  workingDirectory: string,
): Promise<ManifestInvocationResult> {
  return new Promise((resolveProcess, rejectProcess) => {
    const childProcess = spawn("/bin/zsh", ["-lc", manifestHook.command], {
      cwd: workingDirectory,
      env: {
        ...process.env,
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
        PLUGIN_ROOT: pluginDirectory,
        XDG_STATE_HOME: stateHomeDirectory,
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
  const invocation = await invokeHookEntry({ hook_event_name: "SessionStart", session_id: sessionId, cwd: workingDirectory }, stateHomeDirectory);
  assert.equal(invocation.exitCode, 0);
  assert.equal(invocation.standardOutput, "");
  assert.equal((await listActiveSessions({ runtime: "codex", projectId: await resolveProjectIdentity(workingDirectory) }, stateHomeDirectory))[0]?.sessionId, sessionId);
  assert.equal((await invokeSerializedHookEntry("{", stateHomeDirectory)).exitCode, 0);
});

test("comanda SessionStart din manifest păstrează semantica reală a PID-ului părinte", async (testContext) => {
  const stateHomeDirectory = await mkdtemp(join(tmpdir(), "ccb-manifest-"));
  testContext.after(() => rm(stateHomeDirectory, { recursive: true, force: true }));
  await executeFile(join(pluginDirectory, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], {
    cwd: pluginDirectory,
  });

  const manifest = JSON.parse(
    await readFile(join(pluginDirectory, "hooks/hooks.json"), "utf8"),
  ) as HookManifest;
  const sessionStartHook = manifest.hooks.SessionStart?.[0]?.hooks?.[0];
  assert.ok(sessionStartHook);
  assert.equal(sessionStartHook.timeout, 5);

  const sessionIdentifier = "8d6380bf-1b93-44b3-b3da-a1a661cf8b69";
  const workingDirectory = pluginDirectory;
  const invocation = await invokeManifestCommand(
    sessionStartHook,
    JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: sessionIdentifier,
      cwd: workingDirectory,
    }),
    stateHomeDirectory,
    workingDirectory,
  );

  assert.equal(invocation.timedOut, false, invocation.standardError);
  assert.equal(invocation.exitCode, 0, invocation.standardError);
  assert.equal(invocation.signal, null);
  assert.equal(invocation.standardOutput, "");
  assert.notEqual(invocation.spawnedProcessIdentifier, process.pid);

  const projectIdentifier = await resolveProjectIdentity(workingDirectory);
  const storedRecord = JSON.parse(
    await readFile(
      join(
        resolveSessionRegistryDirectory(stateHomeDirectory, projectIdentifier),
        `${sessionIdentifier}.json`,
      ),
      "utf8",
    ),
  ) as { processId: number };
  assert.equal(storedRecord.processId, process.pid);
});
