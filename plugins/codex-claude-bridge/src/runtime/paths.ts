import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

import { uuidSchema } from "../protocol/messageEnvelope.js";

export const projectIdentitySchema = z.string().regex(/^[a-f0-9]{24}$/);

export const maximumChannelSocketPathUtf8Bytes = 103;

function validateStateHomeDirectory(stateHomeDirectory: string): string {
  if (!isAbsolute(stateHomeDirectory) || stateHomeDirectory.includes("\0")) {
    throw new TypeError("State home directory must be an absolute path without NUL bytes");
  }

  return stateHomeDirectory;
}

export function resolveStateHomeDirectory(
  injectedStateHomeDirectory?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (injectedStateHomeDirectory !== undefined) {
    return validateStateHomeDirectory(injectedStateHomeDirectory);
  }

  const environmentStateHomeDirectory = environment.XDG_STATE_HOME;
  if (
    environmentStateHomeDirectory === undefined ||
    environmentStateHomeDirectory.length === 0
  ) {
    return validateStateHomeDirectory(join(homedir(), ".local", "state"));
  }

  return validateStateHomeDirectory(environmentStateHomeDirectory);
}

function resolveContainedDirectory(parentDirectory: string, ...pathSegments: string[]): string {
  const resolvedParentDirectory = resolve(parentDirectory);
  const resolvedDirectory = resolve(resolvedParentDirectory, ...pathSegments);
  const relativePath = relative(resolvedParentDirectory, resolvedDirectory);

  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new RangeError("Runtime directory must remain within the bridge state directory");
  }

  return resolvedDirectory;
}

function validateProjectIdentity(projectIdentity: string): void {
  projectIdentitySchema.parse(projectIdentity);
}

export function normalizeConversationIdentifier(
  conversationIdentifier: string,
): string {
  const validationResult = uuidSchema.safeParse(conversationIdentifier);
  if (!validationResult.success) {
    throw new TypeError("Conversation identifier must be a UUID");
  }
  return validationResult.data.toLowerCase();
}

export function resolveBridgeStateDirectory(
  stateHomeDirectory?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return join(
    resolveStateHomeDirectory(stateHomeDirectory, environment),
    "codex-claude-bridge",
  );
}

export function resolveSocketsDirectory(
  stateHomeDirectory?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return resolveContainedDirectory(
    resolveBridgeStateDirectory(stateHomeDirectory, environment),
    "sockets",
  );
}

export function assertSocketPathWithinLimit(socketPath: string): void {
  const socketPathByteLength = Buffer.byteLength(socketPath, "utf8");
  if (socketPathByteLength > maximumChannelSocketPathUtf8Bytes) {
    throw new RangeError(
      `Channel socket path must not exceed ${maximumChannelSocketPathUtf8Bytes} UTF-8 bytes but was ${socketPathByteLength}; set XDG_STATE_HOME to a shorter absolute directory to fix this`,
    );
  }
}

export function resolveSessionRegistryDirectory(
  stateHomeDirectory: string,
  projectIdentity: string,
): string {
  validateProjectIdentity(projectIdentity);
  return resolveContainedDirectory(
    resolveBridgeStateDirectory(stateHomeDirectory),
    "sessions",
    projectIdentity,
  );
}

export function resolveConversationDirectory(
  stateHomeDirectory?: string,
): string {
  return resolveContainedDirectory(
    resolveBridgeStateDirectory(stateHomeDirectory),
    "conversations",
  );
}

export function resolveConversationRecordPath(
  stateHomeDirectory: string | undefined,
  conversationIdentifier: string,
): string {
  const normalizedConversationIdentifier = normalizeConversationIdentifier(
    conversationIdentifier,
  );
  return resolveContainedDirectory(
    resolveConversationDirectory(stateHomeDirectory),
    `${normalizedConversationIdentifier}.json`,
  );
}
