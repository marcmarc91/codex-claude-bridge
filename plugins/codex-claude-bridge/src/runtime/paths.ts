import { homedir } from "node:os";
import { join } from "node:path";

function resolveStateHomeDirectory(): string {
  return process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
}

export function resolveBridgeStateDirectory(stateHomeDirectory = resolveStateHomeDirectory()): string {
  return join(stateHomeDirectory, "codex-claude-bridge");
}

export function resolveSessionRegistryDirectory(
  stateHomeDirectory: string,
  projectIdentity: string,
): string {
  return join(resolveBridgeStateDirectory(stateHomeDirectory), "sessions", projectIdentity);
}

export function resolveConversationDirectory(
  stateHomeDirectory: string,
  projectIdentity: string,
  conversationIdentifier: string,
): string {
  return join(
    resolveBridgeStateDirectory(stateHomeDirectory),
    "conversations",
    projectIdentity,
    conversationIdentifier,
  );
}
