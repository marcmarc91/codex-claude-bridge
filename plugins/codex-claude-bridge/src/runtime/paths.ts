import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const projectIdentityPattern = /^[a-f0-9]{24}$/;
const conversationIdentifierPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resolveStateHomeDirectory(): string {
  return process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
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
  if (!projectIdentityPattern.test(projectIdentity)) {
    throw new TypeError("Project identity must be a 24-character hexadecimal hash");
  }
}

function validateConversationIdentifier(conversationIdentifier: string): void {
  if (!conversationIdentifierPattern.test(conversationIdentifier)) {
    throw new TypeError("Conversation identifier must be a UUID");
  }
}

export function resolveBridgeStateDirectory(stateHomeDirectory = resolveStateHomeDirectory()): string {
  return join(stateHomeDirectory, "codex-claude-bridge");
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
