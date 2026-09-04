import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CommandTerminationUnconfirmedError,
  executeBoundedCommand,
  type CommandExecutionDependencies,
} from "../src/install/commandExecution.js";

class FakeBoundedChildProcess extends EventEmitter {
  readonly pid = 12345;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  unreferenced = false;

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }

  unref(): void {
    this.unreferenced = true;
  }
}

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

async function waitForProcessExit(processIdentifier: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      process.kill(processIdentifier, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
      throw error;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("Descendant process remained active after process-group kill");
}

test("waits for child close after a timeout kill before rejecting", async () => {
  const childProcess = new FakeBoundedChildProcess();
  const dependencies: CommandExecutionDependencies = {
    spawnProcess: () => childProcess,
  };
  let promiseSettled = false;
  const resultPromise = executeBoundedCommand(
    {
      executablePath: "/fake/slow-command",
      arguments: ["arg"],
      timeoutMilliseconds: 1,
      maximumOutputBytes: 1024,
    },
    dependencies,
  ).finally(() => {
    promiseSettled = true;
  });

  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  assert.deepEqual(childProcess.signals, ["SIGKILL"]);
  assert.equal(promiseSettled, false);

  childProcess.emit("close", null);
  await assert.rejects(resultPromise, /timed out/u);
});

test("kills on bounded output and waits for close before rejecting", async () => {
  const childProcess = new FakeBoundedChildProcess();
  let promiseSettled = false;
  const resultPromise = executeBoundedCommand(
    {
      executablePath: "/fake/noisy-command",
      arguments: [],
      timeoutMilliseconds: 1000,
      maximumOutputBytes: 4,
    },
    { spawnProcess: () => childProcess },
  ).finally(() => {
    promiseSettled = true;
  });

  childProcess.stdout.write("12345");
  await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  assert.deepEqual(childProcess.signals, ["SIGKILL"]);
  assert.equal(promiseSettled, false);

  childProcess.emit("close", null);
  await assert.rejects(resultPromise, /exceeded limit/u);
});

test("rejects a timeout group-kill failure without escaping the timer callback", async () => {
  const childProcess = new FakeBoundedChildProcess();
  const resultPromise = executeBoundedCommand(
    {
      executablePath: "/fake/slow-command",
      arguments: [],
      timeoutMilliseconds: 1,
      maximumOutputBytes: 1024,
    },
    {
      spawnProcess: () => childProcess,
      killProcessGroup: () => {
        const error = new Error("operation not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      },
      terminationGraceMilliseconds: 20,
    },
  );

  await assert.rejects(
    resultPromise,
    (error: unknown) =>
      error instanceof CommandTerminationUnconfirmedError &&
      /operation not permitted/u.test(error.message),
  );
  assert.deepEqual(childProcess.signals, ["SIGKILL"]);
  assert.equal(childProcess.unreferenced, true);
});

test("keeps group termination unconfirmed when only the fallback child closes", async () => {
  const childProcess = new FakeBoundedChildProcess();
  const resultPromise = executeBoundedCommand(
    {
      executablePath: "/fake/slow-command",
      arguments: [],
      timeoutMilliseconds: 1,
      maximumOutputBytes: 1024,
    },
    {
      spawnProcess: () => childProcess,
      killProcessGroup: () => {
        const error = new Error("operation not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      },
      terminationGraceMilliseconds: 20,
    },
  );

  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  childProcess.emit("close", null);

  await assert.rejects(
    resultPromise,
    (error: unknown) =>
      error instanceof CommandTerminationUnconfirmedError &&
      error.processGroupIdentifier === childProcess.pid,
  );
});

test("rejects bounded-output termination when the child never closes", async () => {
  const childProcess = new FakeBoundedChildProcess();
  const startedAt = Date.now();
  const resultPromise = executeBoundedCommand(
    {
      executablePath: "/fake/noisy-command",
      arguments: [],
      timeoutMilliseconds: 1000,
      maximumOutputBytes: 4,
    },
    {
      spawnProcess: () => childProcess,
      killProcessGroup: () => undefined,
      terminationGraceMilliseconds: 20,
    },
  );

  childProcess.stdout.write("12345");
  await assert.rejects(
    resultPromise,
    (error: unknown) =>
      error instanceof CommandTerminationUnconfirmedError &&
      /did not close/u.test(error.message),
  );
  assert.ok(Date.now() - startedAt < 1000);
});

test("lets the host exit after an unconfirmed child leaves inherited pipes open", { timeout: 10_000 }, async (testContext) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ccb-unconfirmed-host-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const descendantMarkerPath = join(temporaryDirectory, "descendant.pid");
  testContext.after(async () => {
    try {
      const processIdentifier = Number(await readFile(descendantMarkerPath, "utf8"));
      process.kill(processIdentifier, "SIGKILL");
    } catch {
      return;
    }
  });
  const startedAt = Date.now();
  const fixtureExitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
    const fixtureProcess = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(packageDirectory, "tests", "fixtures", "unconfirmedCommandHost.ts"),
        descendantMarkerPath,
      ],
      { cwd: packageDirectory, shell: false, stdio: "ignore" },
    );
    const deadline = setTimeout(() => {
      fixtureProcess.kill("SIGKILL");
      rejectExit(new Error("Unconfirmed-command fixture kept its host alive"));
    }, 1000);
    fixtureProcess.once("error", (error) => {
      clearTimeout(deadline);
      rejectExit(error);
    });
    fixtureProcess.once("close", (exitCode) => {
      clearTimeout(deadline);
      resolveExit(exitCode);
    });
  });

  assert.equal(fixtureExitCode, 0);
  assert.ok(Date.now() - startedAt < 1000);
});

test("terminates the full spawned process group on timeout", { timeout: 10_000 }, async (testContext) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ccb-command-group-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const descendantMarkerPath = join(temporaryDirectory, "descendant.pid");
  testContext.after(async () => {
    try {
      const processIdentifier = Number(await readFile(descendantMarkerPath, "utf8"));
      process.kill(processIdentifier, "SIGKILL");
    } catch {
      return;
    }
  });

  await assert.rejects(
    executeBoundedCommand({
      executablePath: process.execPath,
      arguments: [
        "--import",
        "tsx",
        join(packageDirectory, "tests", "fixtures", "holdCommandProcessGroup.ts"),
        descendantMarkerPath,
      ],
      cwd: packageDirectory,
      timeoutMilliseconds: 1500,
      maximumOutputBytes: 1024,
    }),
    /timed out/u,
  );
  const descendantProcessIdentifier = Number(
    await readFile(descendantMarkerPath, "utf8"),
  );
  await waitForProcessExit(descendantProcessIdentifier);
});
