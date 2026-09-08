import { execFile } from "node:child_process";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  readOwningClaudeSessionMetadata,
  type ClaudeSessionMetadata,
} from "../channel/claudeSessionMetadata.js";

export type HookHostRuntime = "codex" | "claude" | "unknown";

export type OwningClaudeSessionReader = (
  parentProcessIdentifier: number,
) => Promise<ClaudeSessionMetadata>;

export type ParentProcessCommandLineReader = (
  parentProcessIdentifier: number,
) => Promise<string | undefined>;

export interface HookHostRuntimeEvidence {
  sessionId: string;
  parentProcessIdentifier: number;
  transcriptPath?: string;
}

export interface HookHostRuntimeIdentifiers {
  readOwningClaudeSession?: OwningClaudeSessionReader;
  readParentProcessCommandLine?: ParentProcessCommandLineReader;
  configuredClaudeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
}

type RuntimeSignal = HookHostRuntime | undefined;

const executeFile = promisify(execFile);

export async function readParentProcessCommandLine(
  parentProcessIdentifier: number,
): Promise<string | undefined> {
  try {
    const { stdout } = await executeFile(
      "ps",
      ["-o", "command=", "-p", String(parentProcessIdentifier)],
      { timeout: 1_000 },
    );
    const trimmedCommandLine = stdout.trim();
    return trimmedCommandLine.length > 0 ? trimmedCommandLine : undefined;
  } catch {
    return undefined;
  }
}

function pathSegments(path: string): string[] {
  return path.split(sep).filter((segment) => segment.length > 0);
}

function pathIsWithinDirectory(candidatePath: string, ancestorDirectory: string): boolean {
  const relativePath = relative(resolve(ancestorDirectory), resolve(candidatePath));
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function identifyRuntimeFromTranscriptPath(
  transcriptPath: string | undefined,
  configuredClaudeDirectory: string | undefined,
): RuntimeSignal {
  if (transcriptPath === undefined || transcriptPath.length === 0) {
    return undefined;
  }
  if (
    configuredClaudeDirectory !== undefined &&
    configuredClaudeDirectory.length > 0 &&
    pathIsWithinDirectory(transcriptPath, configuredClaudeDirectory)
  ) {
    return "claude";
  }
  const segments = pathSegments(transcriptPath);
  if (segments.includes(".claude")) {
    return "claude";
  }
  if (segments.includes(".codex")) {
    return "codex";
  }
  return undefined;
}

function commandLineTokens(commandLine: string): string[] {
  return commandLine.trim().split(/\s+/);
}

function tokenPathSegments(token: string | undefined): string[] {
  return token === undefined ? [] : pathSegments(token);
}

function identifyRuntimeFromParentProcessCommandLine(commandLine: string | undefined): RuntimeSignal {
  if (commandLine === undefined || commandLine.length === 0) {
    return undefined;
  }
  const [executableToken, scriptToken] = commandLineTokens(commandLine);
  const executableName = basename(executableToken ?? "");
  if (executableName === "claude") {
    return "claude";
  }
  if (executableName === "codex") {
    return "codex";
  }
  if (executableName !== "node") {
    return undefined;
  }
  const scriptSegments = tokenPathSegments(scriptToken);
  if (scriptSegments.includes("claude-code")) {
    return "claude";
  }
  const scriptPath = scriptToken ?? "";
  if (scriptPath.includes("@openai/codex") || scriptSegments.includes("codex")) {
    return "codex";
  }
  return undefined;
}

async function identifyRuntimeFromOwningClaudeSession(
  sessionId: string,
  parentProcessIdentifier: number,
  readOwningClaudeSession: OwningClaudeSessionReader,
): Promise<RuntimeSignal> {
  try {
    const owningClaudeSession = await readOwningClaudeSession(parentProcessIdentifier);
    return owningClaudeSession.sessionId === sessionId ? "claude" : undefined;
  } catch {
    return undefined;
  }
}

function identifyRuntimeFromEnvironment(environment: NodeJS.ProcessEnv): RuntimeSignal {
  return environment.CLAUDECODE === "1" && Boolean(environment.CLAUDE_CODE_SESSION_ID)
    ? "claude"
    : undefined;
}

export async function identifyHookHostRuntime(
  evidence: HookHostRuntimeEvidence,
  dependencies: HookHostRuntimeIdentifiers = {},
): Promise<HookHostRuntime> {
  const readOwningClaudeSession =
    dependencies.readOwningClaudeSession ?? readOwningClaudeSessionMetadata;
  const readCommandLine = dependencies.readParentProcessCommandLine ?? readParentProcessCommandLine;
  const configuredClaudeDirectory =
    dependencies.configuredClaudeDirectory ?? process.env.CLAUDE_CONFIG_DIR;
  const environment = dependencies.environment ?? process.env;

  const authoritativeSignals = await Promise.all([
    identifyRuntimeFromOwningClaudeSession(
      evidence.sessionId,
      evidence.parentProcessIdentifier,
      readOwningClaudeSession,
    ),
    readCommandLine(evidence.parentProcessIdentifier).then(identifyRuntimeFromParentProcessCommandLine),
    identifyRuntimeFromTranscriptPath(evidence.transcriptPath, configuredClaudeDirectory),
  ]);

  if (authoritativeSignals.includes("claude")) {
    return "claude";
  }
  if (authoritativeSignals.includes("codex")) {
    return "codex";
  }

  return identifyRuntimeFromEnvironment(environment) === "claude" ? "claude" : "unknown";
}
