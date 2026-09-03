import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat } from "node:fs/promises";
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
  const stateHomeDirectory = await mkdtemp(join(tmpdir(), "codex-claude-bridge-"));
  testContext.after(async () => {
    await import("node:fs/promises").then(({ rm }) =>
      rm(stateHomeDirectory, { recursive: true, force: true }),
    );
  });
  return stateHomeDirectory;
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
    socketPath: join(stateHomeDirectory, "claude.sock"),
  });
  await mkdir(secondRecord.socketPath);
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
  await unregisterActiveSession(firstRecord.sessionId, projectIdentifier, stateHomeDirectory);
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
    socketPath: join(stateHomeDirectory, "missing.sock"),
  });
  await registerActiveSession(deadRecord, stateHomeDirectory);
  await registerActiveSession(disconnectedClaudeRecord, stateHomeDirectory);

  assert.deepEqual(
    await listActiveSessions({ projectId: projectIdentifier }, stateHomeDirectory),
    [],
  );
});
