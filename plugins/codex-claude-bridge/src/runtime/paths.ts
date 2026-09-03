import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

import { uuidSchema } from "../protocol/messageEnvelope.js";

export const projectIdentitySchema = z.string().regex(/^[a-f0-9]{24}$/);

function validateStateHomeDirectory(stateHomeDirectory: string): string {
  if (!isAbsolute(stateHomeDirectory) || stateHomeDirectory.includes("\0")) {
    throw new TypeError("State home directory must be an absolute path without NUL bytes");
  }

  return stateHomeDirectory;
}

function resolveStateHomeDirectory(injectedStateHomeDirectory?: string): string {
  if (injectedStateHomeDirectory !== undefined) {
    return validateStateHomeDirectory(injectedStateHomeDirectory);
  }

  const environmentStateHomeDirectory = process.env.XDG_STATE_HOME;
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

function validateConversationIdentifier(conversationIdentifier: string): void {
  if (!uuidSchema.safeParse(conversationIdentifier).success) {
    throw new TypeError("Conversation identifier must be a UUID");
  }
}

export function resolveBridgeStateDirectory(stateHomeDirectory?: string): string {
  return join(resolveStateHomeDirectory(stateHomeDirectory), "codex-claude-bridge");
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
  stateHomeDirectory: string,
  projectIdentity: string,
  conversationIdentifier: string,
): string {
  validateProjectIdentity(projectIdentity);
  validateConversationIdentifier(conversationIdentifier);
  return resolveContainedDirectory(
    resolveBridgeStateDirectory(stateHomeDirectory),
    "conversations",
    projectIdentity,
    conversationIdentifier,
  );
}
