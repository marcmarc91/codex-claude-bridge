import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

export interface CommandExecutionRequest {
  executablePath: string;
  arguments: string[];
  cwd?: string;
  timeoutMilliseconds: number;
  maximumOutputBytes: number;
}

export interface CommandExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class CommandTerminationUnconfirmedError extends Error {
  readonly terminationConfirmed = false;
  readonly processGroupIdentifier: number | undefined;

  constructor(
    message: string,
    processGroupIdentifier?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CommandTerminationUnconfirmedError";
    this.processGroupIdentifier = processGroupIdentifier;
  }
}

interface SpawnedCommandProcess {
  pid?: number;
  stdout: Readable;
  stderr: Readable;
  kill(signal: NodeJS.Signals): boolean;
  unref(): void;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (exitCode: number | null) => void): this;
}

export interface CommandExecutionDependencies {
  spawnProcess: (
    executablePath: string,
    argumentsList: string[],
    options: {
      cwd?: string;
      detached: true;
      shell: false;
      stdio: ["ignore", "pipe", "pipe"];
    },
  ) => SpawnedCommandProcess;
  killProcessGroup?: (processIdentifier: number, signal: NodeJS.Signals) => void;
  terminationGraceMilliseconds?: number;
}

export function sanitizeCommandError(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim();
}

export async function executeBoundedCommand(
  request: CommandExecutionRequest,
  dependencies: CommandExecutionDependencies = {
    spawnProcess: spawn,
    killProcessGroup: (processIdentifier, signal) =>
      process.kill(-processIdentifier, signal),
  },
): Promise<CommandExecutionResult> {
  return new Promise<CommandExecutionResult>((resolveCommand, rejectCommand) => {
    const childProcess = dependencies.spawnProcess(request.executablePath, request.arguments, {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let terminationRequested = false;
    let terminationError: Error | undefined;
    let terminationFailure: Error | undefined;
    let terminationGraceTimeout: NodeJS.Timeout | undefined;
    let processGroupAbsenceConfirmed = false;
    const terminationGraceMilliseconds =
      dependencies.terminationGraceMilliseconds ?? 2_000;
    const clearTimers = (): void => {
      clearTimeout(timeout);
      if (terminationGraceTimeout !== undefined) {
        clearTimeout(terminationGraceTimeout);
      }
    };
    const terminateProcessGroup = (): void => {
      let processGroupTerminationSucceeded = false;
      if (
        childProcess.pid !== undefined &&
        dependencies.killProcessGroup !== undefined
      ) {
        try {
          dependencies.killProcessGroup(childProcess.pid, "SIGKILL");
          processGroupTerminationSucceeded = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            processGroupTerminationSucceeded = true;
            processGroupAbsenceConfirmed = true;
          } else {
            terminationFailure =
              error instanceof Error
                ? error
                : new Error("Process group termination failed");
          }
        }
      }
      if (!processGroupTerminationSucceeded) {
        try {
          if (!childProcess.kill("SIGKILL") && terminationFailure === undefined) {
            terminationFailure = new Error("Child process rejected the termination signal");
          }
        } catch (error) {
          terminationFailure =
            error instanceof Error
              ? error
              : new Error("Child process termination failed");
        }
      }
      terminationGraceTimeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimers();
        childProcess.stdout.removeAllListeners("data");
        childProcess.stderr.removeAllListeners("data");
        childProcess.stdout.destroy();
        childProcess.stderr.destroy();
        childProcess.unref();
        if (processGroupAbsenceConfirmed && terminationError !== undefined) {
          rejectCommand(terminationError);
          return;
        }
        const detail = terminationFailure?.message;
        rejectCommand(
          new CommandTerminationUnconfirmedError(
            detail === undefined
              ? `Command did not close after termination: ${request.executablePath}`
              : `Command termination was not confirmed: ${request.executablePath}: ${detail}`,
            childProcess.pid,
            terminationFailure === undefined
              ? undefined
              : { cause: terminationFailure },
          ),
        );
      }, terminationGraceMilliseconds);
    };
    const requestTermination = (reason: Error): void => {
      if (terminationRequested) {
        return;
      }
      terminationRequested = true;
      terminationError = reason;
      terminateProcessGroup();
    };
    const timeout = setTimeout(() => {
      requestTermination(new Error(`Command timed out: ${request.executablePath}`));
    }, request.timeoutMilliseconds);
    const collectChunk = (collection: Buffer[], chunk: Buffer): void => {
      if (terminationRequested) {
        return;
      }
      outputBytes += chunk.byteLength;
      if (outputBytes > request.maximumOutputBytes) {
        requestTermination(
          new Error(`Command output exceeded limit: ${request.executablePath}`),
        );
        return;
      }
      collection.push(chunk);
    };
    childProcess.stdout.on("data", (chunk: Buffer) =>
      collectChunk(stdoutChunks, chunk),
    );
    childProcess.stderr.on("data", (chunk: Buffer) =>
      collectChunk(stderrChunks, chunk),
    );
    childProcess.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimers();
        rejectCommand(
          terminationRequested
            ? new CommandTerminationUnconfirmedError(
                `Command termination was not confirmed: ${request.executablePath}: ${error.message}`,
                childProcess.pid,
                { cause: error },
              )
            : error,
        );
      }
    });
    childProcess.once("close", (exitCode) => {
      if (!settled) {
        settled = true;
        clearTimers();
        if (terminationError !== undefined) {
          rejectCommand(
            terminationFailure === undefined
              ? terminationError
              : new CommandTerminationUnconfirmedError(
                  `Command termination was not confirmed: ${request.executablePath}: ${terminationFailure.message}`,
                  childProcess.pid,
                  { cause: terminationFailure },
                ),
          );
          return;
        }
        resolveCommand({
          exitCode: exitCode ?? 1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        });
      }
    });
  });
}
