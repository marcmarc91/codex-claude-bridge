import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectActiveSessionsReadOnly,
  verifyReadOnlySessionSocketParent,
} from "../src/install/readOnlySessionInspector.js";
import { parseStoredActiveSessionRecord } from "../src/registry/activeSessionRegistry.js";

test("reports registry records that fail strict schema and path identity checks without deleting them", async (testContext) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ccb-readonly-registry-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const stateHomeDirectory = join(temporaryDirectory, "state");
  const projectIdentifier = "0123456789abcdef01234567";
  const sessionsDirectory = join(
    stateHomeDirectory,
    "codex-claude-bridge",
    "sessions",
    projectIdentifier,
  );
  await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
  await chmod(join(stateHomeDirectory, "codex-claude-bridge"), 0o700);
  await chmod(join(stateHomeDirectory, "codex-claude-bridge", "sessions"), 0o700);
  await chmod(sessionsDirectory, 0o700);

  const validSessionIdentifier = randomUUID();
  const validRecord = {
    schemaVersion: 1,
    runtime: "codex",
    sessionId: validSessionIdentifier,
    displayName: "Valid session",
    processId: process.pid,
    workingDirectory: temporaryDirectory,
    projectId: projectIdentifier,
    registeredAt: new Date().toISOString(),
  };
  const validRecordPath = join(sessionsDirectory, `${validSessionIdentifier}.json`);
  await writeFile(validRecordPath, JSON.stringify(validRecord), { mode: 0o600 });
  await chmod(validRecordPath, 0o600);
  assert.deepEqual(
    await inspectActiveSessionsReadOnly(stateHomeDirectory),
    [validRecord],
  );

  const craftedRecordPath = join(sessionsDirectory, `${randomUUID()}.json`);
  await writeFile(
    craftedRecordPath,
    JSON.stringify({
      ...validRecord,
      sessionId: "not-a-uuid",
      projectId: "fedcba9876543210fedcba98",
      processId: -1,
      workingDirectory: "relative",
      registeredAt: "not-a-date",
      unexpected: true,
    }),
    { mode: 0o600 },
  );
  await chmod(craftedRecordPath, 0o600);

  await assert.rejects(
    inspectActiveSessionsReadOnly(stateHomeDirectory),
    /identity is invalid/u,
  );
  assert.equal(
    await readFile(craftedRecordPath, "utf8"),
    JSON.stringify({
      ...validRecord,
      sessionId: "not-a-uuid",
      projectId: "fedcba9876543210fedcba98",
      processId: -1,
      workingDirectory: "relative",
      registeredAt: "not-a-date",
      unexpected: true,
    }),
  );
});

test("rejects Claude session sockets outside the bridge state directory", () => {
  const stateHomeDirectory = "/tmp/ccb-inspector-state";
  const bridgeStateDirectory = join(stateHomeDirectory, "codex-claude-bridge");

  assert.equal(
    parseStoredActiveSessionRecord(
      {
        schemaVersion: 1,
        runtime: "claude",
        sessionId: randomUUID(),
        displayName: "Unsafe socket",
        processId: process.pid,
        workingDirectory: "/tmp",
        projectId: "0123456789abcdef01234567",
        socketPath: "/tmp/unrelated.sock",
        registeredAt: new Date().toISOString(),
      },
      stateHomeDirectory,
      bridgeStateDirectory,
    ),
    undefined,
  );
});

test("refuses to traverse an unsafe session registry directory", async (testContext) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ccb-readonly-mode-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const stateHomeDirectory = join(temporaryDirectory, "state");
  const sessionsDirectory = join(
    stateHomeDirectory,
    "codex-claude-bridge",
    "sessions",
  );
  await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
  await chmod(join(stateHomeDirectory, "codex-claude-bridge"), 0o700);
  await chmod(sessionsDirectory, 0o755);

  await assert.rejects(
    inspectActiveSessionsReadOnly(stateHomeDirectory),
    /private/u,
  );
});

test("bounds the number of registry entries inspected", async (testContext) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ccb-readonly-cap-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const stateHomeDirectory = join(temporaryDirectory, "state");
  const sessionsDirectory = join(
    stateHomeDirectory,
    "codex-claude-bridge",
    "sessions",
  );
  await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
  await chmod(join(stateHomeDirectory, "codex-claude-bridge"), 0o700);
  await chmod(sessionsDirectory, 0o700);
  for (let index = 0; index < 65; index += 1) {
    const projectDirectory = join(
      sessionsDirectory,
      index.toString(16).padStart(24, "0"),
    );
    await mkdir(projectDirectory, { mode: 0o700 });
  }

  await assert.rejects(
    inspectActiveSessionsReadOnly(stateHomeDirectory),
    /entry limit/u,
  );
});

test("rejects an oversized record without reading or modifying it", async (testContext) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ccb-readonly-size-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const stateHomeDirectory = join(temporaryDirectory, "state");
  const projectIdentifier = "0123456789abcdef01234567";
  const sessionsDirectory = join(
    stateHomeDirectory,
    "codex-claude-bridge",
    "sessions",
    projectIdentifier,
  );
  await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
  await chmod(join(stateHomeDirectory, "codex-claude-bridge"), 0o700);
  await chmod(join(stateHomeDirectory, "codex-claude-bridge", "sessions"), 0o700);
  await chmod(sessionsDirectory, 0o700);
  const oversizedContents = "x".repeat(64 * 1024 + 1);
  const recordPath = join(sessionsDirectory, `${randomUUID()}.json`);
  await writeFile(recordPath, oversizedContents, { mode: 0o600 });
  await chmod(recordPath, 0o600);

  await assert.rejects(
    inspectActiveSessionsReadOnly(stateHomeDirectory),
    /unsafe/u,
  );
  assert.equal(await readFile(recordPath, "utf8"), oversizedContents);
});

test("bounds the total number of session records across projects", async (testContext) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ccb-readonly-total-cap-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const stateHomeDirectory = join(temporaryDirectory, "state");
  const sessionsRoot = join(
    stateHomeDirectory,
    "codex-claude-bridge",
    "sessions",
  );
  const projectIdentifiers = [
    "0123456789abcdef01234567",
    "fedcba9876543210fedcba98",
  ];
  await mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
  await chmod(join(stateHomeDirectory, "codex-claude-bridge"), 0o700);
  await chmod(sessionsRoot, 0o700);
  for (const projectIdentifier of projectIdentifiers) {
    const projectDirectory = join(sessionsRoot, projectIdentifier);
    await mkdir(projectDirectory, { mode: 0o700 });
    for (let index = 0; index < 65; index += 1) {
      const sessionIdentifier = `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
      await writeFile(
        join(projectDirectory, `${sessionIdentifier}.json`),
        JSON.stringify({
          schemaVersion: 1,
          runtime: "codex",
          sessionId: sessionIdentifier,
          displayName: "Bounded",
          processId: process.pid,
          workingDirectory: temporaryDirectory,
          projectId: projectIdentifier,
          registeredAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
    }
  }

  await assert.rejects(
    inspectActiveSessionsReadOnly(stateHomeDirectory),
    /entry limit/u,
  );
});

test("rejects socket paths through symlinked or non-private directories before probing", async (testContext) => {
  const temporaryDirectory = await realpath(
    await mkdtemp(join(tmpdir(), "ccb-readonly-socket-")),
  );
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const bridgeStateDirectory = join(temporaryDirectory, "bridge");
  const outsideDirectory = join(temporaryDirectory, "outside");
  await mkdir(bridgeStateDirectory, { mode: 0o700 });
  await mkdir(outsideDirectory, { mode: 0o700 });
  await symlink(outsideDirectory, join(bridgeStateDirectory, "escaped"));

  await assert.rejects(
    verifyReadOnlySessionSocketParent(
      bridgeStateDirectory,
      join(bridgeStateDirectory, "escaped", "session.sock"),
    ),
    /canonical/u,
  );

  const sharedDirectory = join(bridgeStateDirectory, "shared");
  await mkdir(sharedDirectory, { mode: 0o700 });
  await chmod(sharedDirectory, 0o777);
  await assert.rejects(
    verifyReadOnlySessionSocketParent(
      bridgeStateDirectory,
      join(sharedDirectory, "session.sock"),
    ),
    /private/u,
  );
});
