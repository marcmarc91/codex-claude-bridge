import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  findActiveSession,
  listActiveSessions,
  registerActiveSession,
  unregisterActiveSession,
} from "../src/registry/activeSessionRegistry.js";
import { resolveSessionRegistryDirectory } from "../src/runtime/paths.js";
import { resolveBridgeStateDirectory } from "../src/runtime/paths.js";

const projectIdentifier = "0123456789abcdef01234567";

function createRecord(overrides: Partial<{
  runtime: "claude" | "codex";
  sessionId: string;
  displayName: string;
  processId: number;
  projectId: string;
  socketPath: string;
}> = {}) {
  return {
    schemaVersion: 1 as const,
    runtime: "codex" as const,
    sessionId: "3c4b3c10-21a7-4d6f-b964-3c816b9ed8db",
    displayName: "working-session",
    processId: process.pid,
    workingDirectory: process.cwd(),
    projectId: projectIdentifier,
    registeredAt: "2026-09-03T12:00:00.000Z",
    ...overrides,
  };
}

async function createStateHomeDirectory(testContext: test.TestContext): Promise<string> {
  const stateHomeDirectory = await mkdtemp(join(tmpdir(), "ccb-"));
  testContext.after(async () => {
    await import("node:fs/promises").then(({ rm }) =>
      rm(stateHomeDirectory, { recursive: true, force: true }),
    );
  });
  return stateHomeDirectory;
}

async function createClaudeSocket(testContext: test.TestContext, stateHomeDirectory: string): Promise<string> {
  const socketPath = join(resolveBridgeStateDirectory(stateHomeDirectory), "s");
  const server = createServer();
  await import("node:fs/promises").then(({ mkdir }) => mkdir(resolveBridgeStateDirectory(stateHomeDirectory), { recursive: true, mode: 0o700 }));
  await new Promise<void>((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(socketPath, resolveServer);
  });
  await chmod(socketPath, 0o600);
  testContext.after(async () => new Promise<void>((resolveServer) => server.close(() => resolveServer())));
  return socketPath;
}

async function createUnixSocket(
  testContext: test.TestContext,
  socketPath: string,
): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(socketPath, resolveServer);
  });
  testContext.after(
    async () => new Promise<void>((resolveServer) => server.close(() => resolveServer())),
  );
}

test("înregistrează atomic sesiuni și păstrează permisiunile private", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const record = createRecord();

  await registerActiveSession(record, stateHomeDirectory);

  const registryDirectory = resolveSessionRegistryDirectory(stateHomeDirectory, record.projectId);
  const recordPath = join(registryDirectory, `${record.sessionId}.json`);
  assert.equal((await stat(registryDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(recordPath)).mode & 0o777, 0o600);
  assert.deepEqual(
    (await listActiveSessions({ runtime: "codex", projectId: record.projectId }, stateHomeDirectory)).map(
      ({ sessionId }) => sessionId,
    ),
    [record.sessionId],
  );
});

test("filtrează, găsește ID-uri unice și respinge nume ambigue", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const firstRecord = createRecord();
  const secondRecord = createRecord({
    runtime: "claude",
    sessionId: "5cb1e2fd-5b24-4699-bfea-878e9b147370",
    displayName: "working-session",
    socketPath: await createClaudeSocket(testContext, stateHomeDirectory),
  });
  await registerActiveSession(firstRecord, stateHomeDirectory);
  await registerActiveSession(secondRecord, stateHomeDirectory);

  assert.equal(
    (await listActiveSessions({ runtime: "codex", projectId: projectIdentifier }, stateHomeDirectory)).length,
    1,
  );
  assert.equal(
    (await findActiveSession(firstRecord.sessionId, { projectId: projectIdentifier }, stateHomeDirectory))
      ?.sessionId,
    firstRecord.sessionId,
  );
  await assert.rejects(() =>
    findActiveSession("working-session", { projectId: projectIdentifier }, stateHomeDirectory),
  );
  await unregisterActiveSession(firstRecord.sessionId, projectIdentifier, process.pid, stateHomeDirectory);
  assert.equal(
    await findActiveSession(firstRecord.sessionId, { projectId: projectIdentifier }, stateHomeDirectory),
    undefined,
  );
});

test("elimină procesele moarte și sesiunile Claude fără socket", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const deadRecord = createRecord({ processId: 999999 });
  const disconnectedClaudeRecord = createRecord({
    runtime: "claude",
    sessionId: "ad65b1c1-7386-4465-80f9-4de0a26bc212",
    displayName: "claude-session",
    socketPath: join(resolveBridgeStateDirectory(stateHomeDirectory), "missing.sock"),
  });
  await registerActiveSession(deadRecord, stateHomeDirectory);
  await registerActiveSession(disconnectedClaudeRecord, stateHomeDirectory);

  assert.deepEqual(
    await listActiveSessions({ projectId: projectIdentifier }, stateHomeDirectory),
    [],
  );
});

test("respinge un symlink folosit drept director intermediar sessions", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const bridgeStateDirectory = resolveBridgeStateDirectory(stateHomeDirectory);
  const redirectedSessionsDirectory = join(stateHomeDirectory, "redirected-sessions");
  await mkdir(bridgeStateDirectory, { mode: 0o700 });
  await mkdir(redirectedSessionsDirectory, { mode: 0o700 });
  await symlink(redirectedSessionsDirectory, join(bridgeStateDirectory, "sessions"));

  await assert.rejects(() => registerActiveSession(createRecord(), stateHomeDirectory));
  assert.deepEqual(await readdir(redirectedSessionsDirectory), []);
});

test("respinge un symlink folosit drept director intermediar de proiect", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const bridgeStateDirectory = resolveBridgeStateDirectory(stateHomeDirectory);
  const sessionsDirectory = join(bridgeStateDirectory, "sessions");
  const redirectedRegistryDirectory = join(stateHomeDirectory, "redirected-registry");
  await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
  await chmod(bridgeStateDirectory, 0o700);
  await chmod(sessionsDirectory, 0o700);
  await mkdir(redirectedRegistryDirectory, { mode: 0o700 });
  await symlink(redirectedRegistryDirectory, join(sessionsDirectory, projectIdentifier));

  await assert.rejects(() => registerActiveSession(createRecord(), stateHomeDirectory));
  assert.deepEqual(await readdir(redirectedRegistryDirectory), []);
});

test("respinge symlink-uri finale de record la citire, scriere și eliminare", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const record = createRecord();
  await registerActiveSession(record, stateHomeDirectory);
  await unregisterActiveSession(
    record.sessionId,
    record.projectId,
    record.processId,
    stateHomeDirectory,
  );

  const registryDirectory = resolveSessionRegistryDirectory(
    stateHomeDirectory,
    record.projectId,
  );
  const recordPath = join(registryDirectory, `${record.sessionId}.json`);
  const recordTargetPath = join(stateHomeDirectory, "record-target.json");
  const serializedRecord = JSON.stringify(record);
  await writeFile(recordTargetPath, serializedRecord, { mode: 0o600 });
  await symlink(recordTargetPath, recordPath);

  await assert.rejects(() => listActiveSessions({ projectId: record.projectId }, stateHomeDirectory));
  await assert.rejects(() => registerActiveSession(record, stateHomeDirectory));
  await assert.rejects(() =>
    unregisterActiveSession(
      record.sessionId,
      record.projectId,
      record.processId,
      stateHomeDirectory,
    ),
  );
  assert.equal(await readFile(recordTargetPath, "utf8"), serializedRecord);
  assert.equal((await lstat(recordPath)).isSymbolicLink(), true);
});

test("respinge record-uri cu mod neprivat și păstrează proprietarul curent", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const record = createRecord();
  await registerActiveSession(record, stateHomeDirectory);

  const recordPath = join(
    resolveSessionRegistryDirectory(stateHomeDirectory, record.projectId),
    `${record.sessionId}.json`,
  );
  const originalRecordStatus = await stat(recordPath);
  assert.equal(originalRecordStatus.uid, process.getuid());
  assert.equal(originalRecordStatus.mode & 0o777, 0o600);

  await chmod(recordPath, 0o640);

  await assert.rejects(() =>
    listActiveSessions({ projectId: record.projectId }, stateHomeDirectory),
  );

  await chmod(recordPath, 0o4600);
  await assert.rejects(() =>
    listActiveSessions({ projectId: record.projectId }, stateHomeDirectory),
  );
});

test("elimină un record al cărui proiect sau ID nu corespunde căii", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const record = createRecord();
  await registerActiveSession(record, stateHomeDirectory);

  const recordPath = join(
    resolveSessionRegistryDirectory(stateHomeDirectory, record.projectId),
    `${record.sessionId}.json`,
  );
  await writeFile(
    recordPath,
    JSON.stringify({
      ...record,
      sessionId: "ad65b1c1-7386-4465-80f9-4de0a26bc212",
      projectId: "fedcba987654321001234567",
    }),
  );

  assert.deepEqual(
    await listActiveSessions({ projectId: record.projectId }, stateHomeDirectory),
    [],
  );
  await assert.rejects(() => stat(recordPath), { code: "ENOENT" });
});

test("curăță fișierul temporar când mutația record-ului eșuează", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const record = createRecord();
  await registerActiveSession(record, stateHomeDirectory);
  await unregisterActiveSession(
    record.sessionId,
    record.projectId,
    record.processId,
    stateHomeDirectory,
  );

  const registryDirectory = resolveSessionRegistryDirectory(
    stateHomeDirectory,
    record.projectId,
  );
  await mkdir(join(registryDirectory, `${record.sessionId}.json`), { mode: 0o700 });

  await assert.rejects(() => registerActiveSession(record, stateHomeDirectory));
  assert.deepEqual(
    (await readdir(registryDirectory)).filter((entryName) => entryName.endsWith(".tmp")),
    [],
  );
});

test("acceptă numai modul exact 0600 pentru un socket Claude activ", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const socketPath = await createClaudeSocket(testContext, stateHomeDirectory);
  const claudeRecord = createRecord({
    runtime: "claude",
    sessionId: "5cb1e2fd-5b24-4699-bfea-878e9b147370",
    socketPath,
  });

  for (const socketMode of [0o000, 0o200, 0o400, 0o660, 0o1600]) {
    await chmod(socketPath, socketMode);
    await registerActiveSession(claudeRecord, stateHomeDirectory);
    assert.deepEqual(
      await listActiveSessions({ projectId: projectIdentifier }, stateHomeDirectory),
      [],
    );
  }

  await chmod(socketPath, 0o600);
  await registerActiveSession(claudeRecord, stateHomeDirectory);
  assert.equal(
    (await listActiveSessions({ projectId: projectIdentifier }, stateHomeDirectory))[0]
      ?.sessionId,
    claudeRecord.sessionId,
  );
});

test("respinge un director intermediar de socket care este symlink", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const bridgeStateDirectory = resolveBridgeStateDirectory(stateHomeDirectory);
  const socketTargetDirectory = join(stateHomeDirectory, "socket-target");
  const socketLinkDirectory = join(bridgeStateDirectory, "socket-link");
  const actualSocketPath = join(socketTargetDirectory, "claude.sock");
  const linkedSocketPath = join(socketLinkDirectory, "claude.sock");
  await mkdir(bridgeStateDirectory, { recursive: true, mode: 0o700 });
  await chmod(bridgeStateDirectory, 0o700);
  await mkdir(socketTargetDirectory, { mode: 0o700 });
  await createUnixSocket(testContext, actualSocketPath);
  await chmod(actualSocketPath, 0o600);
  await symlink(socketTargetDirectory, socketLinkDirectory);

  await registerActiveSession(
    createRecord({
      runtime: "claude",
      socketPath: linkedSocketPath,
    }),
    stateHomeDirectory,
  );

  assert.deepEqual(
    await listActiveSessions({ projectId: projectIdentifier }, stateHomeDirectory),
    [],
  );
  assert.equal((await lstat(actualSocketPath)).isSocket(), true);
});

test("înregistrarea și dezînregistrarea concurente păstrează proprietarul proaspăt", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const originalRecord = createRecord({ processId: process.pid });
  const freshRecord = createRecord({
    displayName: "fresh-owner",
    processId: process.ppid,
  });
  await registerActiveSession(originalRecord, stateHomeDirectory);

  await Promise.all([
    unregisterActiveSession(
      originalRecord.sessionId,
      originalRecord.projectId,
      originalRecord.processId,
      stateHomeDirectory,
    ),
    registerActiveSession(freshRecord, stateHomeDirectory),
  ]);

  assert.equal(
    (
      await findActiveSession(
        freshRecord.sessionId,
        { projectId: freshRecord.projectId },
        stateHomeDirectory,
      )
    )?.displayName,
    "fresh-owner",
  );
});

test("probeUnixSocketOutcome distinge acceptarea, refuzul cert și cazul incert", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { probeUnixSocketOutcome } = await import("../src/registry/activeSessionRegistry.js");
  const probeDirectory = await mkdtemp(join(tmpdir(), "ccb-probe-"));
  const listeningSocketPath = join(probeDirectory, "live.sock");
  const missingSocketPath = join(probeDirectory, "missing.sock");
  const orphanedSocketPath = join(probeDirectory, "orphan.sock");
  const listeningServer = createServer();
  await new Promise<void>((resolveListen) => listeningServer.listen(listeningSocketPath, resolveListen));
  const orphanedServer = createServer();
  await new Promise<void>((resolveListen) => orphanedServer.listen(orphanedSocketPath, resolveListen));
  await new Promise<void>((resolveClose) => orphanedServer.close(() => resolveClose()));
  await writeFile(orphanedSocketPath, "");

  try {
    assert.equal(await probeUnixSocketOutcome(listeningSocketPath), "accepting");
    assert.equal(await probeUnixSocketOutcome(missingSocketPath), "refused");
    assert.equal(await probeUnixSocketOutcome(orphanedSocketPath), "unknown");
  } finally {
    await new Promise<void>((resolveClose) => listeningServer.close(() => resolveClose()));
    await rm(probeDirectory, { recursive: true, force: true });
  }
});
