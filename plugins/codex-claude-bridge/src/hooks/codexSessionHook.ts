import { pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";
import { z } from "zod";

import { registerActiveSession, unregisterActiveSession } from "../registry/activeSessionRegistry.js";
import { resolveProjectIdentity } from "../registry/projectIdentity.js";
import { uuidSchema } from "../protocol/messageEnvelope.js";

interface CodexSessionHookInput {
  hook_event_name: "SessionStart" | "SessionEnd";
  session_id: string;
  cwd: string;
}

const codexSessionHookInputSchema = z.object({
  hook_event_name: z.enum(["SessionStart", "SessionEnd"]),
  session_id: uuidSchema,
  cwd: z.string().refine((value) => isAbsolute(value) && !value.includes("\0")),
}).passthrough();

function parseCodexSessionHookInput(input: unknown): CodexSessionHookInput | undefined {
  const parsedInput = codexSessionHookInputSchema.safeParse(input);
  return parsedInput.success ? parsedInput.data : undefined;
}

export async function runCodexSessionHook(input: unknown): Promise<void> {
  const hookInput = parseCodexSessionHookInput(input);
  if (hookInput === undefined) {
    return;
  }

  const projectId = await resolveProjectIdentity(hookInput.cwd);
  if (hookInput.hook_event_name === "SessionEnd") {
    await unregisterActiveSession(hookInput.session_id, projectId, process.ppid);
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
  try {
    await runCodexSessionHook(JSON.parse(serializedInput));
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runFromStandardInput();
}
