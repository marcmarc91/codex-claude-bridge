import { pathToFileURL } from "node:url";

import { registerActiveSession, unregisterActiveSession } from "../registry/activeSessionRegistry.js";
import { resolveProjectIdentity } from "../registry/projectIdentity.js";

interface CodexSessionHookInput {
  hook_event_name: "SessionStart" | "SessionEnd";
  session_id: string;
  cwd: string;
}

function parseCodexSessionHookInput(input: unknown): CodexSessionHookInput | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }

  const hookInput = input as Record<string, unknown>;
  if (
    (hookInput.hook_event_name !== "SessionStart" && hookInput.hook_event_name !== "SessionEnd") ||
    typeof hookInput.session_id !== "string" ||
    typeof hookInput.cwd !== "string"
  ) {
    return undefined;
  }

  return {
    hook_event_name: hookInput.hook_event_name,
    session_id: hookInput.session_id,
    cwd: hookInput.cwd,
  };
}

export async function runCodexSessionHook(input: unknown): Promise<void> {
  const hookInput = parseCodexSessionHookInput(input);
  if (hookInput === undefined) {
    return;
  }

  const projectId = await resolveProjectIdentity(hookInput.cwd);
  if (hookInput.hook_event_name === "SessionEnd") {
    await unregisterActiveSession(hookInput.session_id, projectId);
    return;
  }

  await registerActiveSession({
    schemaVersion: 1,
    runtime: "codex",
    sessionId: hookInput.session_id,
    displayName: hookInput.session_id,
    processId: process.ppid,
    workingDirectory: hookInput.cwd,
    projectId,
    registeredAt: new Date().toISOString(),
  });
}

async function runFromStandardInput(): Promise<void> {
  let serializedInput = "";
  for await (const inputChunk of process.stdin) {
    serializedInput += inputChunk;
  }
  await runCodexSessionHook(JSON.parse(serializedInput));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runFromStandardInput();
}
