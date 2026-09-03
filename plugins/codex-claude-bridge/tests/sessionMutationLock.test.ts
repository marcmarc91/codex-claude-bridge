import assert from "node:assert/strict";
import { fork } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { registerActiveSession, unregisterActiveSession } from "../src/registry/activeSessionRegistry.js";
import { withSessionMutationLock } from "../src/registry/sessionMutationLock.js";
import {
  resolveBridgeStateDirectory,
  resolveSessionRegistryDirectory,
} from "../src/runtime/paths.js";

const projectIdentifier = "0123456789abcdef01234567";
const sessionIdentifier = "3c4b3c10-21a7-4d6f-b964-3c816b9ed8db";

async function createStateHomeDirectory(testContext: test.TestContext): Promise<string> {
  const stateHomeDirectory = await mkdtemp(join(tmpdir(), "ccb-lock-"));
  testContext.after(() => rm(stateHomeDirectory, { recursive: true, force: true }));
  return stateHomeDirectory;
}

function createRecord() {
  return {
    schemaVersion: 1 as const,
    runtime: "codex" as const,
    sessionId: sessionIdentifier,
    displayName: "lock-session",
    processId: process.pid,
    workingDirectory: process.cwd(),
    projectId: projectIdentifier,
    registeredAt: "2026-09-03T12:00:00.000Z",
  };
}

async function waitForLockAcquisition(lockHolderProcess: ReturnType<typeof fork>): Promise<void> {
  await new Promise<void>((resolveAcquisition, rejectAcquisition) => {
    const rejectEarlyExit = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      rejectAcquisition(
        new Error(`Lock holder exited before acquisition: ${String(exitCode)} ${String(signal)}`),
      );
    };

    lockHolderProcess.once("error", rejectAcquisition);
    lockHolderProcess.once("exit", rejectEarlyExit);
    lockHolderProcess.once("message", (message) => {
      if (message !== "acquired") {
        rejectAcquisition(new Error("Lock holder sent an unexpected message"));
        return;
      }

      lockHolderProcess.off("exit", rejectEarlyExit);
      resolveAcquisition();
    });
  });
}

async function waitForProcessExit(lockHolderProcess: ReturnType<typeof fork>): Promise<void> {
  await new Promise<void>((resolveExit, rejectExit) => {
    lockHolderProcess.once("error", rejectExit);
    lockHolderProcess.once("exit", () => resolveExit());
  });
}

test("concurrent critical sections do not overlap when the first exceeds two seconds", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  let activeCriticalSections = 0;
  let maximumConcurrentCriticalSections = 0;
  let resolveFirstAcquisition: (() => void) | undefined;
  const firstAcquisition = new Promise<void>((resolveAcquisition) => {
    resolveFirstAcquisition = resolveAcquisition;
  });

  const firstOperation = withSessionMutationLock(
    stateHomeDirectory,
    projectIdentifier,
    sessionIdentifier,
    async () => {
      activeCriticalSections += 1;
      maximumConcurrentCriticalSections = Math.max(
        maximumConcurrentCriticalSections,
        activeCriticalSections,
      );
      resolveFirstAcquisition?.();
      await delay(2_200);
      activeCriticalSections -= 1;
    },
  );

  await firstAcquisition;

  const secondOperation = withSessionMutationLock(
    stateHomeDirectory,
    projectIdentifier,
    sessionIdentifier,
    async () => {
      activeCriticalSections += 1;
      maximumConcurrentCriticalSections = Math.max(
        maximumConcurrentCriticalSections,
        activeCriticalSections,
      );
      activeCriticalSections -= 1;
    },
  );

  await delay(2_050);
  assert.equal(maximumConcurrentCriticalSections, 1);

  await Promise.all([firstOperation, secondOperation]);
  assert.equal(maximumConcurrentCriticalSections, 1);
});

test("a killed lock holder releases the kernel lock for another process", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const fixturePath = fileURLToPath(
    new URL("fixtures/holdSessionMutationLock.ts", import.meta.url),
  );
  const lockHolderProcess = fork(
    fixturePath,
    [stateHomeDirectory, projectIdentifier, sessionIdentifier],
    {
      execArgv: ["--import", "tsx"],
      silent: true,
    },
  );

  testContext.after(() => {
    lockHolderProcess.kill("SIGKILL");
  });

  await waitForLockAcquisition(lockHolderProcess);
  lockHolderProcess.kill("SIGKILL");
  await waitForProcessExit(lockHolderProcess);

  let acquiredAfterProcessDeath = false;
  await withSessionMutationLock(
    stateHomeDirectory,
    projectIdentifier,
    sessionIdentifier,
    async () => {
      acquiredAfterProcessDeath = true;
    },
  );

  assert.equal(acquiredAfterProcessDeath, true);
});

test("an operation exception releases the lock and preserves the callback error", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const callbackError = new Error("operation failed");

  await assert.rejects(
    withSessionMutationLock(
      stateHomeDirectory,
      projectIdentifier,
      sessionIdentifier,
      async () => {
        throw callbackError;
      },
    ),
    (error) => error === callbackError,
  );

  let subsequentOperationRan = false;
  await withSessionMutationLock(
    stateHomeDirectory,
    projectIdentifier,
    sessionIdentifier,
    async () => {
      subsequentOperationRan = true;
    },
  );

  assert.equal(subsequentOperationRan, true);
});

test("a final lock symlink is rejected without changing its target", async (testContext) => {
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
    projectIdentifier,
  );
  const lockFilePath = join(registryDirectory, ".locks", `${sessionIdentifier}.lock`);
  const lockTargetPath = join(stateHomeDirectory, "lock-target");
  await writeFile(lockTargetPath, "unchanged", { mode: 0o600 });
  await unlink(lockFilePath);
  await symlink(lockTargetPath, lockFilePath);

  await assert.rejects(() => registerActiveSession(record, stateHomeDirectory));
  assert.equal(await readFile(lockTargetPath, "utf8"), "unchanged");
  assert.equal((await lstat(lockFilePath)).isSymbolicLink(), true);
});

test("lock files remain persistent, private, regular, and user-owned", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const record = createRecord();
  await registerActiveSession(record, stateHomeDirectory);

  const lockFilePath = join(
    resolveSessionRegistryDirectory(stateHomeDirectory, projectIdentifier),
    ".locks",
    `${sessionIdentifier}.lock`,
  );
  const lockFileStatus = await stat(lockFilePath);
  assert.equal(lockFileStatus.isFile(), true);
  assert.equal(lockFileStatus.mode & 0o777, 0o600);
  assert.equal(lockFileStatus.uid, process.getuid());

  const bridgeStateDirectory = resolveBridgeStateDirectory(stateHomeDirectory);
  const privateDirectories = [
    bridgeStateDirectory,
    join(bridgeStateDirectory, "sessions"),
    resolveSessionRegistryDirectory(stateHomeDirectory, projectIdentifier),
    join(
      resolveSessionRegistryDirectory(stateHomeDirectory, projectIdentifier),
      ".locks",
    ),
  ];
  for (const privateDirectory of privateDirectories) {
    const directoryStatus = await stat(privateDirectory);
    assert.equal(directoryStatus.mode & 0o777, 0o700);
    assert.equal(directoryStatus.uid, process.getuid());
  }

  await chmod(lockFilePath, 0o640);
  await assert.rejects(() => registerActiveSession(record, stateHomeDirectory));

  await chmod(lockFilePath, 0o4600);
  await assert.rejects(() => registerActiveSession(record, stateHomeDirectory));

  const lockDirectory = join(
    resolveSessionRegistryDirectory(stateHomeDirectory, projectIdentifier),
    ".locks",
  );
  await chmod(lockDirectory, 0o1700);
  await chmod(lockFilePath, 0o600);
  await withSessionMutationLock(
    stateHomeDirectory,
    projectIdentifier,
    sessionIdentifier,
    async () => undefined,
  );
  assert.equal((await stat(lockDirectory)).mode & 0o7777, 0o700);
});
