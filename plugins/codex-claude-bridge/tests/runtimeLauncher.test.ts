import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  buildRuntimeLaunchArguments,
  launchBridgeRuntime,
  type RuntimeLaunchDependencies,
} from "../src/wrapper/runtimeLauncher.js";

const channelSelectionFlag = "--dangerously-load-development-channels";
const channelSelector = "plugin:codex-claude-bridge@codex-claude-bridge-local";

async function waitForSpawn(): Promise<void> {
  await new Promise<void>((resolveWait) => setImmediate(resolveWait));
}

class FakeRuntimeProcess extends EventEmitter {
  readonly forwardedSignals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.forwardedSignals.push(signal);
    return true;
  }
}

interface CapturedSpawn {
  executablePath?: string;
  arguments?: string[];
  options?: { shell?: boolean; stdio?: string; env?: NodeJS.ProcessEnv };
  environmentPath?: string;
}

function createLaunchDependencies(
  fakeRuntimeProcess: FakeRuntimeProcess,
  capturedSpawn: CapturedSpawn,
  globalBinaryDirectory: string | undefined,
  processEnvironment: NodeJS.ProcessEnv,
): RuntimeLaunchDependencies {
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  return {
    spawnProcess: (executablePath, argumentsList, options) => {
      capturedSpawn.executablePath = executablePath;
      capturedSpawn.arguments = argumentsList;
      capturedSpawn.options = options;
      return fakeRuntimeProcess;
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
    resolveRuntimeExecutablePath: async (runtime, environmentPath) => {
      capturedSpawn.environmentPath = environmentPath;
      return `/fake/bin/${runtime}`;
    },
    resolveGlobalBinaryDirectory: async () => globalBinaryDirectory,
    processEnvironment,
  };
}

test("adds the bridge Channel selector only for Claude and strips one leading separator", () => {
  assert.deepEqual(buildRuntimeLaunchArguments("claude", []), [
    channelSelectionFlag,
    channelSelector,
  ]);
  assert.deepEqual(
    buildRuntimeLaunchArguments("claude", ["--", "--resume", "--json"]),
    [channelSelectionFlag, channelSelector, "--resume", "--json"],
  );
  assert.deepEqual(
    buildRuntimeLaunchArguments("claude", [
      channelSelectionFlag,
      channelSelector,
      "--model",
      "opus",
    ]),
    [channelSelectionFlag, channelSelector, "--model", "opus"],
  );
  assert.deepEqual(
    buildRuntimeLaunchArguments("claude", [
      `${channelSelectionFlag}=${channelSelector}`,
      "--resume",
    ]),
    [channelSelectionFlag, channelSelector, "--resume"],
  );
  assert.deepEqual(
    buildRuntimeLaunchArguments("codex", ["exec", "--sandbox", "read-only"]),
    ["exec", "--sandbox", "read-only"],
  );
  assert.deepEqual(
    buildRuntimeLaunchArguments("codex", ["--", "exec", "--json"]),
    ["exec", "--json"],
  );
});

test("launches Claude with the global bin directory first in PATH and inherited stdio", async () => {
  const fakeRuntimeProcess = new FakeRuntimeProcess();
  const capturedSpawn: CapturedSpawn = {};
  const dependencies = createLaunchDependencies(
    fakeRuntimeProcess,
    capturedSpawn,
    "/global/bin",
    { PATH: "/usr/bin:/global/bin", HOME: "/home/user" },
  );

  const exitCodePromise = launchBridgeRuntime(
    "claude",
    ["--model", "opus"],
    dependencies,
  );
  await waitForSpawn();
  fakeRuntimeProcess.emit("close", 0, null);

  assert.equal(await exitCodePromise, 0);
  assert.equal(capturedSpawn.executablePath, "/fake/bin/claude");
  assert.deepEqual(capturedSpawn.arguments, [
    channelSelectionFlag,
    channelSelector,
    "--model",
    "opus",
  ]);
  assert.equal(capturedSpawn.options?.shell, false);
  assert.equal(capturedSpawn.options?.stdio, "inherit");
  assert.equal(capturedSpawn.options?.env?.PATH, "/global/bin:/usr/bin");
  assert.equal(capturedSpawn.options?.env?.HOME, "/home/user");
  assert.equal(capturedSpawn.environmentPath, "/global/bin:/usr/bin");
});

test("launches Codex verbatim, forwards signals, and passes the exit code through", async () => {
  const fakeRuntimeProcess = new FakeRuntimeProcess();
  const capturedSpawn: CapturedSpawn = {};
  const dependencies = createLaunchDependencies(
    fakeRuntimeProcess,
    capturedSpawn,
    undefined,
    { PATH: "/usr/bin" },
  );

  const exitCodePromise = launchBridgeRuntime(
    "codex",
    ["exec", "--json"],
    dependencies,
  );
  await waitForSpawn();
  for (const handler of dependencies.signalHandlers.values()) {
    handler();
  }
  fakeRuntimeProcess.emit("close", 7, null);

  assert.equal(await exitCodePromise, 7);
  assert.equal(capturedSpawn.executablePath, "/fake/bin/codex");
  assert.deepEqual(capturedSpawn.arguments, ["exec", "--json"]);
  assert.equal(capturedSpawn.options?.env?.PATH, "/usr/bin");
  assert.deepEqual(fakeRuntimeProcess.forwardedSignals, [
    "SIGINT",
    "SIGTERM",
    "SIGHUP",
  ]);
  assert.equal(dependencies.signalHandlers.size, 0);
});
