import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname } from "node:path";

import {
  resolveClaudeExecutable,
  resolvePathExecutable,
} from "../install/executableResolver.js";
import { readReceiptReadonly } from "../install/installationReceiptStore.js";
import { resolveStateHomeDirectory } from "../runtime/paths.js";
import {
  buildClaudeProcessArguments,
  prependGlobalBinaryDirectory,
  runSupervisedProcess,
  type ProcessSupervisionDependencies,
} from "./claudeProcessWrapper.js";

export type BridgeRuntimeName = "claude" | "codex";

export interface RuntimeLaunchDependencies extends ProcessSupervisionDependencies {
  resolveRuntimeExecutablePath: (
    runtime: BridgeRuntimeName,
    environmentPath: string,
  ) => Promise<string>;
  resolveGlobalBinaryDirectory: () => Promise<string | undefined>;
  processEnvironment: NodeJS.ProcessEnv;
}

export function buildRuntimeLaunchArguments(
  runtime: BridgeRuntimeName,
  argumentsList: string[],
): string[] {
  const passthroughArguments =
    argumentsList[0] === "--" ? argumentsList.slice(1) : [...argumentsList];
  return runtime === "claude"
    ? buildClaudeProcessArguments(passthroughArguments)
    : passthroughArguments;
}

async function resolveRuntimeExecutablePath(
  runtime: BridgeRuntimeName,
  environmentPath: string,
): Promise<string> {
  if (runtime === "claude") {
    return resolveClaudeExecutable({
      homeDirectory: homedir(),
      environmentPath,
    });
  }
  const codexExecutablePath = await resolvePathExecutable(
    "codex",
    environmentPath,
  );
  if (codexExecutablePath === undefined) {
    throw new Error("Unable to resolve the Codex executable from PATH");
  }
  return codexExecutablePath;
}

async function resolveGlobalBinaryDirectory(): Promise<string | undefined> {
  try {
    const { receipt } = await readReceiptReadonly(resolveStateHomeDirectory());
    return dirname(receipt.npm.binPaths[0]);
  } catch {
    return undefined;
  }
}

function createDefaultDependencies(): RuntimeLaunchDependencies {
  return {
    spawnProcess: (executablePath, argumentsList, options) =>
      spawn(executablePath, argumentsList, options),
    addSignalHandler: (signal, handler) => process.on(signal, handler),
    removeSignalHandler: (signal, handler) => process.off(signal, handler),
    signalHandlers: new Map(),
    resolveRuntimeExecutablePath,
    resolveGlobalBinaryDirectory,
    processEnvironment: process.env,
  };
}

export async function launchBridgeRuntime(
  runtime: BridgeRuntimeName,
  argumentsList: string[],
  dependencies: RuntimeLaunchDependencies = createDefaultDependencies(),
): Promise<number> {
  const runtimeEnvironment = prependGlobalBinaryDirectory(
    dependencies.processEnvironment,
    await dependencies.resolveGlobalBinaryDirectory(),
  );
  const executablePath = await dependencies.resolveRuntimeExecutablePath(
    runtime,
    runtimeEnvironment.PATH ?? "",
  );
  return runSupervisedProcess(
    executablePath,
    buildRuntimeLaunchArguments(runtime, argumentsList),
    runtimeEnvironment,
    dependencies,
  );
}
