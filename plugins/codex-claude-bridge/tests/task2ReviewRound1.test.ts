import assert from "node:assert/strict";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findActiveSession, listActiveSessions, registerActiveSession, unregisterActiveSession } from "../src/registry/activeSessionRegistry.js";
import { resolveBridgeStateDirectory } from "../src/runtime/paths.js";

test("manifestul Codex folosește grupuri matcher cu hook-uri imbricate", async () => {
  const manifest = JSON.parse(await readFile(join(fileURLToPath(new URL("..", import.meta.url)), "hooks/hooks.json"), "utf8")) as {
    hooks: Record<string, Array<{ matcher?: string; hooks?: unknown[] }>>;
  };

  for (const eventName of ["SessionStart", "SessionEnd"]) {
    assert.equal(manifest.hooks[eventName]?.[0]?.matcher, "*");
    assert.equal(Array.isArray(manifest.hooks[eventName]?.[0]?.hooks), true);
  }
});

test("înregistrarea respinge ID-uri și directoare de lucru nesigure", async () => {
  await assert.rejects(() => registerActiveSession({
    schemaVersion: 1,
    runtime: "codex",
    sessionId: "../escape",
    displayName: "unsafe",
    processId: process.pid,
    workingDirectory: "relative-directory",
    projectId: "0123456789abcdef01234567",
    registeredAt: "not-a-timestamp",
  }));
});

test("respinge socket-uri Claude non-socket sau symlink și păstrează înregistrarea nouă la dezînregistrare întârziată", async (testContext) => {
  const stateHomeDirectory = await import("node:fs/promises").then(({ mkdtemp, rm }) => mkdtemp(join(tmpdir(), "ccb-")).then((directory) => {
    testContext.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
    return directory;
  }));
  const projectId = "0123456789abcdef01234567";
  const bridgeDirectory = resolveBridgeStateDirectory(stateHomeDirectory);
  const regularFilePath = join(bridgeDirectory, "regular");
  const symlinkPath = join(bridgeDirectory, "symlink");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bridgeDirectory, { recursive: true }));
  await writeFile(regularFilePath, "not a socket");
  await symlink(regularFilePath, symlinkPath);
  const claudeRecord = {
    schemaVersion: 1 as const, runtime: "claude" as const, sessionId: "3c4b3c10-21a7-4d6f-b964-3c816b9ed8db", displayName: "claude", processId: process.pid, workingDirectory: process.cwd(), projectId, socketPath: regularFilePath, registeredAt: "2026-09-03T12:00:00.000Z",
  };
  await registerActiveSession(claudeRecord, stateHomeDirectory);
  assert.deepEqual(await listActiveSessions({ projectId }, stateHomeDirectory), []);
  await registerActiveSession({ ...claudeRecord, socketPath: symlinkPath }, stateHomeDirectory);
  assert.deepEqual(await listActiveSessions({ projectId }, stateHomeDirectory), []);
  const freshRecord = { ...claudeRecord, runtime: "codex" as const, socketPath: undefined, processId: process.pid, displayName: "fresh" };
  await registerActiveSession(freshRecord, stateHomeDirectory);
  await unregisterActiveSession(freshRecord.sessionId, projectId, process.pid + 1, stateHomeDirectory);
  assert.equal((await findActiveSession(freshRecord.sessionId, { projectId }, stateHomeDirectory))?.displayName, "fresh");
});

test("respinge ID-uri duplicate între proiecte fără un filtru care să le distingă", async (testContext) => {
  const stateHomeDirectory = await import("node:fs/promises").then(({ mkdtemp, rm }) => mkdtemp(join(tmpdir(), "ccb-")).then((directory) => {
    testContext.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
    return directory;
  }));
  const sessionId = "5cb1e2fd-5b24-4699-bfea-878e9b147370";
  const record = { schemaVersion: 1 as const, runtime: "codex" as const, sessionId, displayName: "same", processId: process.pid, workingDirectory: process.cwd(), registeredAt: "2026-09-03T12:00:00.000Z" };
  await registerActiveSession({ ...record, projectId: "0123456789abcdef01234567" }, stateHomeDirectory);
  await registerActiveSession({ ...record, projectId: "fedcba987654321001234567" }, stateHomeDirectory);
  await assert.rejects(() => findActiveSession(sessionId, {}, stateHomeDirectory));
  assert.equal((await findActiveSession(sessionId, { projectId: record.projectId ?? "0123456789abcdef01234567" }, stateHomeDirectory))?.sessionId, sessionId);
});

test("consideră EPERM ca proces activ", async (testContext) => {
  const stateHomeDirectory = await import("node:fs/promises").then(({ mkdtemp, rm }) => mkdtemp(join(tmpdir(), "ccb-")).then((directory) => {
    testContext.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
    return directory;
  }));
  const originalKill = process.kill;
  process.kill = ((processId: number, signal?: number | NodeJS.Signals) => {
    if (processId === 424242) {
      const error = new Error("permission denied") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    }
    return originalKill(processId, signal!);
  }) as typeof process.kill;
  testContext.after(() => { process.kill = originalKill; });
  await registerActiveSession({ schemaVersion: 1, runtime: "codex", sessionId: "ad65b1c1-7386-4465-80f9-4de0a26bc212", displayName: "protected", processId: 424242, workingDirectory: process.cwd(), projectId: "0123456789abcdef01234567", registeredAt: "2026-09-03T12:00:00.000Z" }, stateHomeDirectory);
  assert.equal((await listActiveSessions({ projectId: "0123456789abcdef01234567" }, stateHomeDirectory)).length, 1);
});
