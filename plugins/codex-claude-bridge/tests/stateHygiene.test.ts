import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { registerActiveSession } from "../src/registry/activeSessionRegistry.js";
import { cleanupOrphanedBridgeState } from "../src/registry/stateHygiene.js";
import {
  resolveBridgeStateDirectory,
  resolveSessionRegistryDirectory,
} from "../src/runtime/paths.js";

const projectIdentifier = "0123456789abcdef01234567";
const socketFixturePath = fileURLToPath(
  new URL("fixtures/holdUnixSocket.ts", import.meta.url),
);

async function createStateHomeDirectory(testContext: test.TestContext): Promise<string> {
  const stateHomeDirectory = await mkdtemp(join("/tmp", "ccb-hygiene-"));
  testContext.after(() => rm(stateHomeDirectory, { recursive: true, force: true }));
  return stateHomeDirectory;
}

function createRecord(overrides: Partial<{
  runtime: "claude" | "codex";
  sessionId: string;
  processId: number;
  socketPath: string;
}> = {}) {
  return {
    schemaVersion: 1 as const,
    runtime: "codex" as const,
    sessionId: randomUUID(),
    displayName: "hygiene-session",
    processId: process.pid,
    workingDirectory: process.cwd(),
    projectId: projectIdentifier,
    registeredAt: "2026-09-03T12:00:00.000Z",
    ...overrides,
  };
}

async function waitForMessage(
  childProcess: ReturnType<typeof fork>,
  expectedMessage: string,
): Promise<void> {
  await new Promise<void>((resolveMessage, rejectMessage) => {
    const rejectEarlyExit = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      rejectMessage(
        new Error(`Fixture exited before ready: ${String(exitCode)} ${String(signal)}`),
      );
    };
    childProcess.once("error", rejectMessage);
    childProcess.once("exit", rejectEarlyExit);
    childProcess.once("message", (message) => {
      if (message !== expectedMessage) {
        rejectMessage(new Error("Fixture sent an unexpected message"));
        return;
      }
      childProcess.off("exit", rejectEarlyExit);
      resolveMessage();
    });
  });
}

async function waitForExit(childProcess: ReturnType<typeof fork>): Promise<void> {
  await new Promise<void>((resolveExit) => {
    childProcess.once("exit", () => resolveExit());
  });
}

async function forkAndKillAfterMessage(
  fixturePath: string,
  args: string[],
  expectedMessage: string,
): Promise<void> {
  const childProcess = fork(fixturePath, args, {
    execArgv: ["--import", "tsx"],
    silent: true,
  });
  await waitForMessage(childProcess, expectedMessage);
  childProcess.kill("SIGKILL");
  await waitForExit(childProcess);
}

async function createLiveClaudeSocket(
  testContext: test.TestContext,
  stateHomeDirectory: string,
  socketHexIdentifier: string,
): Promise<string> {
  const socketsDirectory = join(resolveBridgeStateDirectory(stateHomeDirectory), "sockets");
  await mkdir(socketsDirectory, { recursive: true, mode: 0o700 });
  const socketPath = join(socketsDirectory, `c-${socketHexIdentifier}.sock`);
  const server: Server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, resolveListen);
  });
  await chmod(socketPath, 0o600);
  testContext.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  return socketPath;
}

test("removes an orphaned socket that no session references and no process listens on", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const socketsDirectory = join(resolveBridgeStateDirectory(stateHomeDirectory), "sockets");
  await mkdir(socketsDirectory, { recursive: true, mode: 0o700 });
  const orphanSocketPath = join(socketsDirectory, "c-aaaaaaaaaaaaaaaa.sock");

  await forkAndKillAfterMessage(socketFixturePath, [orphanSocketPath], "listening");

  const summary = await cleanupOrphanedBridgeState(stateHomeDirectory);

  assert.equal(summary.removedSockets, 1);
  await assert.rejects(() => lstat(orphanSocketPath), { code: "ENOENT" });
});

test("keeps a live socket even when no session record references it", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const socketPath = await createLiveClaudeSocket(
    testContext,
    stateHomeDirectory,
    "bbbbbbbbbbbbbbbb",
  );

  const summary = await cleanupOrphanedBridgeState(stateHomeDirectory);

  assert.equal(summary.removedSockets, 0);
  assert.equal((await lstat(socketPath)).isSocket(), true);
});

test("removes a session record whose process is dead", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const deadRecord = createRecord({ processId: 999_999 });
  await registerActiveSession(deadRecord, stateHomeDirectory);

  const recordPath = join(
    resolveSessionRegistryDirectory(stateHomeDirectory, projectIdentifier),
    `${deadRecord.sessionId}.json`,
  );
  assert.equal((await lstat(recordPath)).isFile(), true);

  const summary = await cleanupOrphanedBridgeState(stateHomeDirectory);

  assert.equal(summary.removedSessionRecords, 1);
  await assert.rejects(() => lstat(recordPath), { code: "ENOENT" });
});

test("reports a correct summary with all orphaned state categories combined", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);

  const deadRecord = createRecord({ processId: 999_999 });
  await registerActiveSession(deadRecord, stateHomeDirectory);

  const liveSocketPath = await createLiveClaudeSocket(
    testContext,
    stateHomeDirectory,
    "cccccccccccccccc",
  );
  const liveRecord = createRecord({ runtime: "claude", socketPath: liveSocketPath });
  await registerActiveSession(liveRecord, stateHomeDirectory);

  const socketsDirectory = join(resolveBridgeStateDirectory(stateHomeDirectory), "sockets");
  const orphanSocketPath = join(socketsDirectory, "c-dddddddddddddddd.sock");
  await forkAndKillAfterMessage(socketFixturePath, [orphanSocketPath], "listening");

  const summary = await cleanupOrphanedBridgeState(stateHomeDirectory);

  assert.equal(summary.removedSessionRecords, 1);
  assert.equal(summary.removedSockets, 1);
  assert.equal(summary.skipped.length, 0);

  assert.equal((await lstat(liveSocketPath)).isSocket(), true);
  const liveRecordPath = join(
    resolveSessionRegistryDirectory(stateHomeDirectory, projectIdentifier),
    `${liveRecord.sessionId}.json`,
  );
  assert.equal((await lstat(liveRecordPath)).isFile(), true);
});

test("does not stall on a corrupted record and skips only the socket pass for that project", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const record = createRecord();
  await registerActiveSession(record, stateHomeDirectory);

  const recordPath = join(
    resolveSessionRegistryDirectory(stateHomeDirectory, projectIdentifier),
    `${record.sessionId}.json`,
  );
  await chmod(recordPath, 0o640);

  const socketsDirectory = join(resolveBridgeStateDirectory(stateHomeDirectory), "sockets");
  await mkdir(socketsDirectory, { recursive: true, mode: 0o700 });
  const orphanSocketPath = join(socketsDirectory, "c-eeeeeeeeeeeeeeee.sock");
  await forkAndKillAfterMessage(socketFixturePath, [orphanSocketPath], "listening");

  const summary = await cleanupOrphanedBridgeState(stateHomeDirectory);

  assert.equal(summary.removedSockets, 0);
  assert.equal((await lstat(orphanSocketPath)).isSocket(), true);

  assert.equal(summary.removedSessionRecords, 0);
  assert.equal((await lstat(recordPath)).isFile(), true);

  assert.ok(
    summary.skipped.some((skip) => skip.reason.includes("active sessions could not be evaluated")),
  );
  assert.ok(
    summary.skipped.some((skip) => skip.reason.includes("socket cleanup skipped")),
  );
});
