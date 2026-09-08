import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { constants } from "node:os";
import { delimiter, dirname, isAbsolute } from "node:path";

export const bridgeChannelSelector =
  "plugin:codex-claude-bridge@codex-claude-bridge-local";

const channelSelectionFlag = "--dangerously-load-development-channels";
const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

interface SupervisedProcess {
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

export interface ProcessSupervisionDependencies {
  spawnProcess: (
    executablePath: string,
    argumentsList: string[],
    options: { shell: false; stdio: "inherit"; env: NodeJS.ProcessEnv },
  ) => SupervisedProcess;
  addSignalHandler: (
    signal: NodeJS.Signals,
    handler: () => void,
  ) => void;
  removeSignalHandler: (
    signal: NodeJS.Signals,
    handler: () => void,
  ) => void;
  signalHandlers: Map<NodeJS.Signals, () => void>;
}

export interface ClaudeProcessWrapperDependencies
  extends ProcessSupervisionDependencies {
  wrapperExecutablePath?: string;
  processEnvironment?: NodeJS.ProcessEnv;
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

export function prependGlobalBinaryDirectory(
  processEnvironment: NodeJS.ProcessEnv,
  globalBinaryDirectory: string | undefined,
): NodeJS.ProcessEnv {
  if (
    globalBinaryDirectory === undefined ||
    !isAbsolute(globalBinaryDirectory)
  ) {
    return { ...processEnvironment };
  }
  const remainingPathDirectories = (processEnvironment.PATH ?? "")
    .split(delimiter)
    .filter(
      (pathDirectory) =>
        pathDirectory.length > 0 && pathDirectory !== globalBinaryDirectory,
    );
  return {
    ...processEnvironment,
    PATH: [globalBinaryDirectory, ...remainingPathDirectories].join(delimiter),
  };
}

function buildClaudeProcessEnvironment(
  processEnvironment: NodeJS.ProcessEnv,
  wrapperExecutablePath: string | undefined,
): NodeJS.ProcessEnv {
  return prependGlobalBinaryDirectory(
    processEnvironment,
    wrapperExecutablePath === undefined || !isAbsolute(wrapperExecutablePath)
      ? undefined
      : dirname(wrapperExecutablePath),
  );
}

function createDefaultDependencies(): ClaudeProcessWrapperDependencies {
  return {
    spawnProcess: (executablePath, argumentsList, options) =>
      spawn(executablePath, argumentsList, options),
    addSignalHandler: (signal, handler) => process.on(signal, handler),
    removeSignalHandler: (signal, handler) => process.off(signal, handler),
    signalHandlers: new Map(),
    wrapperExecutablePath: process.argv[1],
    processEnvironment: process.env,
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

  return runSupervisedProcess(
    claudeExecutablePath,
    buildClaudeProcessArguments(originalArguments),
    buildClaudeProcessEnvironment(
      dependencies.processEnvironment ?? process.env,
      wrapperExecutablePath,
    ),
    dependencies,
  );
}

export async function runSupervisedProcess(
  executablePath: string,
  argumentsList: string[],
  processEnvironment: NodeJS.ProcessEnv,
  dependencies: ProcessSupervisionDependencies,
): Promise<number> {
  const supervisedProcess = dependencies.spawnProcess(
    executablePath,
    argumentsList,
    { shell: false, stdio: "inherit", env: processEnvironment },
  );
  for (const signal of forwardedSignals) {
    const handler = (): void => {
      supervisedProcess.kill(signal);
    };
    dependencies.signalHandlers.set(signal, handler);
    dependencies.addSignalHandler(signal, handler);
  }

  try {
    return await new Promise<number>((resolveProcess, rejectProcess) => {
      let settled = false;
      const removeChildListeners = (): void => {
        supervisedProcess.off("error", handleError);
        supervisedProcess.off("close", handleClose);
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
      supervisedProcess.once("error", handleError);
      supervisedProcess.once("close", handleClose);
    });
  } finally {
    for (const [signal, handler] of dependencies.signalHandlers) {
      dependencies.removeSignalHandler(signal, handler);
    }
    dependencies.signalHandlers.clear();
  }
}
