import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  buildClaudeProcessArguments,
  runClaudeProcessWrapper,
  type ClaudeProcessWrapperDependencies,
} from "../src/wrapper/claudeProcessWrapper.js";

const channelSelector =
  "plugin:codex-claude-bridge@codex-claude-bridge-local";

async function waitForSpawn(): Promise<void> {
  await new Promise<void>((resolveWait) => setImmediate(resolveWait));
}

class FakeClaudeProcess extends EventEmitter {
  readonly forwardedSignals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.forwardedSignals.push(signal);
    return true;
  }
}

function createWrapperDependencies(
  fakeClaudeProcess: FakeClaudeProcess,
  capturedSpawn: {
    executablePath?: string;
    arguments?: string[];
    options?: { shell?: boolean; stdio?: string };
  },
): ClaudeProcessWrapperDependencies {
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  return {
    spawnProcess: (executablePath, argumentsList, options) => {
      capturedSpawn.executablePath = executablePath;
      capturedSpawn.arguments = argumentsList;
      capturedSpawn.options = options;
      return fakeClaudeProcess;
    },
    addSignalHandler: (signal, handler) => {
      signalHandlers.set(signal, handler);
    },
    removeSignalHandler: (signal, handler) => {
      if (signalHandlers.get(signal) === handler) {
        signalHandlers.delete(signal);
      }
    },
    signalHandlers,
  };
}

test("adds the bridge Channel selector once while preserving every Claude argument", () => {
  assert.deepEqual(
    buildClaudeProcessArguments(["--model", "opus", "a value", "--flag=-x"]),
    [
      "--dangerously-load-development-channels",
      channelSelector,
      "--model",
      "opus",
      "a value",
      "--flag=-x",
    ],
  );
  assert.deepEqual(
    buildClaudeProcessArguments([
      "--",
      "--dangerously-load-development-channels",
      channelSelector,
    ]),
    [
      "--dangerously-load-development-channels",
      channelSelector,
      "--",
      "--dangerously-load-development-channels",
      channelSelector,
    ],
  );
  assert.deepEqual(
    buildClaudeProcessArguments([
      "--dangerously-load-development-channels",
      channelSelector,
      `--dangerously-load-development-channels=${channelSelector}`,
      "--dangerously-load-development-channels",
      "plugin:some-other-channel@local",
    ]),
    [
      "--dangerously-load-development-channels",
      channelSelector,
      "--dangerously-load-development-channels",
      "plugin:some-other-channel@local",
    ],
  );
  assert.deepEqual(
    buildClaudeProcessArguments([
      "--dangerously-load-development-channels",
      channelSelector,
      "--model",
      "sonnet",
    ]),
    [
      "--dangerously-load-development-channels",
      channelSelector,
      "--model",
      "sonnet",
    ],
  );
  assert.deepEqual(
    buildClaudeProcessArguments([
      `--dangerously-load-development-channels=${channelSelector}`,
      "--resume",
    ]),
    [
      "--dangerously-load-development-channels",
      channelSelector,
      "--resume",
    ],
  );
});

test("spawns the supplied Claude executable without a shell and returns its exit code", async () => {
  const fakeClaudeProcess = new FakeClaudeProcess();
  const capturedSpawn: Parameters<typeof createWrapperDependencies>[1] = {};
  const dependencies = createWrapperDependencies(fakeClaudeProcess, capturedSpawn);
  const resultPromise = runClaudeProcessWrapper(
    ["/path with spaces/claude", "--resume", "session-id"],
    dependencies,
  );

  await waitForSpawn();
  fakeClaudeProcess.emit("close", 17, null);

  assert.equal(await resultPromise, 17);
  assert.equal(capturedSpawn.executablePath, "/path with spaces/claude");
  assert.deepEqual(capturedSpawn.arguments, [
    "--dangerously-load-development-channels",
    channelSelector,
    "--resume",
    "session-id",
  ]);
  assert.deepEqual(capturedSpawn.options, { shell: false, stdio: "inherit" });
});

test("forwards termination signals exactly once and removes handlers after exit", async () => {
  const fakeClaudeProcess = new FakeClaudeProcess();
  const capturedSpawn: Parameters<typeof createWrapperDependencies>[1] = {};
  const dependencies = createWrapperDependencies(fakeClaudeProcess, capturedSpawn);
  const resultPromise = runClaudeProcessWrapper(["/usr/bin/claude"], dependencies);

  await waitForSpawn();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    dependencies.signalHandlers.get(signal)?.();
  }
  fakeClaudeProcess.emit("close", 0, null);

  assert.equal(await resultPromise, 0);
  assert.deepEqual(fakeClaudeProcess.forwardedSignals, ["SIGINT", "SIGTERM", "SIGHUP"]);
  assert.equal(dependencies.signalHandlers.size, 0);
});

test("rejects a missing executable and converts signal exits to shell-compatible codes", async () => {
  await assert.rejects(
    runClaudeProcessWrapper([], {
      ...createWrapperDependencies(new FakeClaudeProcess(), {}),
    }),
    /Claude executable path is required/u,
  );

  const fakeClaudeProcess = new FakeClaudeProcess();
  const resultPromise = runClaudeProcessWrapper(
    ["/usr/bin/claude"],
    createWrapperDependencies(fakeClaudeProcess, {}),
  );
  await waitForSpawn();
  fakeClaudeProcess.emit("close", null, "SIGTERM");
  assert.equal(await resultPromise, 143);
});

test("rejects a canonical executable identity matching the wrapper", async () => {
  const fakeClaudeProcess = new FakeClaudeProcess();
  const dependencies = Object.assign(
    createWrapperDependencies(fakeClaudeProcess, {}),
    {
      wrapperExecutablePath: "/global/bin/claude-code-bridge-wrapper",
      resolveExecutableIdentity: async () => "/package/dist/bin/claudeCodeBridgeWrapper.js",
    },
  );
  dependencies.spawnProcess = () => {
    throw new Error("unexpected spawn");
  };

  await assert.rejects(
    runClaudeProcessWrapper(["/alias/to/wrapper"], dependencies),
    /cannot invoke itself/u,
  );
});

test("removes child listeners and signal handlers after a spawn error", async () => {
  const fakeClaudeProcess = new FakeClaudeProcess();
  const dependencies = createWrapperDependencies(fakeClaudeProcess, {});
  const resultPromise = runClaudeProcessWrapper(["/usr/bin/claude"], dependencies);

  await waitForSpawn();
  fakeClaudeProcess.emit("error", new Error("spawn failed"));
  await assert.rejects(resultPromise, /spawn failed/u);

  assert.equal(fakeClaudeProcess.listenerCount("error"), 0);
  assert.equal(fakeClaudeProcess.listenerCount("close"), 0);
  assert.equal(dependencies.signalHandlers.size, 0);
});
