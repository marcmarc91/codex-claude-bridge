import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { constants } from "node:os";

export const bridgeChannelSelector =
  "plugin:codex-claude-bridge@codex-claude-bridge-local";

const channelSelectionFlag = "--dangerously-load-development-channels";
const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

interface SpawnedClaudeProcess {
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  off(event: "error", listener: (error: Error) => void): this;
  off(
    event: "close",
    listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal: NodeJS.Signals): boolean;
}

export interface ClaudeProcessWrapperDependencies {
  spawnProcess: (
    executablePath: string,
    argumentsList: string[],
    options: { shell: false; stdio: "inherit" },
  ) => SpawnedClaudeProcess;
  addSignalHandler: (
    signal: NodeJS.Signals,
    handler: () => void,
  ) => void;
  removeSignalHandler: (
    signal: NodeJS.Signals,
    handler: () => void,
  ) => void;
  signalHandlers: Map<NodeJS.Signals, () => void>;
  wrapperExecutablePath?: string;
  resolveExecutableIdentity?: (executablePath: string) => Promise<string>;
}

export function buildClaudeProcessArguments(
  originalArguments: string[],
): string[] {
  const argumentsWithoutBridgeSelector: string[] = [];
  for (let index = 0; index < originalArguments.length; index += 1) {
    const argument = originalArguments[index];
    if (argument === "--") {
      argumentsWithoutBridgeSelector.push(...originalArguments.slice(index));
      break;
    }
    if (argument === `${channelSelectionFlag}=${bridgeChannelSelector}`) {
      continue;
    }
    if (
      argument === channelSelectionFlag &&
      originalArguments[index + 1] === bridgeChannelSelector
    ) {
      index += 1;
      continue;
    }
    argumentsWithoutBridgeSelector.push(argument);
  }
  return [
    channelSelectionFlag,
    bridgeChannelSelector,
    ...argumentsWithoutBridgeSelector,
  ];
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) {
    return 1;
  }
  return 128 + constants.signals[signal];
}

function createDefaultDependencies(): ClaudeProcessWrapperDependencies {
  return {
    spawnProcess: (executablePath, argumentsList, options) =>
      spawn(executablePath, argumentsList, options),
    addSignalHandler: (signal, handler) => process.on(signal, handler),
    removeSignalHandler: (signal, handler) => process.off(signal, handler),
    signalHandlers: new Map(),
    wrapperExecutablePath: process.argv[1],
    resolveExecutableIdentity: realpath,
  };
}

export async function runClaudeProcessWrapper(
  wrapperArguments: string[],
  dependencies: ClaudeProcessWrapperDependencies = createDefaultDependencies(),
): Promise<number> {
  const [claudeExecutablePath, ...originalArguments] = wrapperArguments;
  if (claudeExecutablePath === undefined || claudeExecutablePath.length === 0) {
    throw new TypeError("Claude executable path is required");
  }
  const resolveExecutableIdentity =
    dependencies.resolveExecutableIdentity ?? (async (executablePath) => executablePath);
  const wrapperExecutablePath =
    dependencies.wrapperExecutablePath ?? process.argv[1];
  if (
    wrapperExecutablePath !== undefined &&
    (await resolveExecutableIdentity(claudeExecutablePath)) ===
      (await resolveExecutableIdentity(wrapperExecutablePath))
  ) {
    throw new Error("Claude process wrapper cannot invoke itself");
  }

  const claudeProcess = dependencies.spawnProcess(
    claudeExecutablePath,
    buildClaudeProcessArguments(originalArguments),
    { shell: false, stdio: "inherit" },
  );
  for (const signal of forwardedSignals) {
    const handler = (): void => {
      claudeProcess.kill(signal);
    };
    dependencies.signalHandlers.set(signal, handler);
    dependencies.addSignalHandler(signal, handler);
  }

  try {
    return await new Promise<number>((resolveProcess, rejectProcess) => {
      let settled = false;
      const removeChildListeners = (): void => {
        claudeProcess.off("error", handleError);
        claudeProcess.off("close", handleClose);
      };
      const handleError = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        removeChildListeners();
        rejectProcess(error);
      };
      const handleClose = (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        removeChildListeners();
        resolveProcess(exitCode ?? signalExitCode(signal));
      };
      claudeProcess.once("error", handleError);
      claudeProcess.once("close", handleClose);
    });
  } finally {
    for (const [signal, handler] of dependencies.signalHandlers) {
      dependencies.removeSignalHandler(signal, handler);
    }
    dependencies.signalHandlers.clear();
  }
}
