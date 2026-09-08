import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";
import { z } from "zod";

import { readOwningClaudeSessionMetadata } from "../channel/claudeSessionMetadata.js";
import { registerActiveSession, unregisterActiveSession } from "../registry/activeSessionRegistry.js";
import { resolveProjectIdentity } from "../registry/projectIdentity.js";
import { uuidSchema } from "../protocol/messageEnvelope.js";
import {
  identifyHookHostRuntime,
  type HookHostRuntimeIdentifiers,
  type OwningClaudeSessionReader,
} from "./hookHostRuntime.js";

interface CodexSessionHookInput {
  hook_event_name: "SessionStart" | "SessionEnd";
  session_id: string;
  cwd: string;
  transcript_path?: string | null;
}

const codexSessionHookInputSchema = z.object({
  hook_event_name: z.enum(["SessionStart", "SessionEnd"]),
  session_id: uuidSchema,
  cwd: z.string().refine((value) => isAbsolute(value) && !value.includes("\0")),
  transcript_path: z.string().nullish(),
}).passthrough();

export const maximumCodexSessionHookInputUtf8Bytes = 1_048_576;

function parseCodexSessionHookInput(input: unknown): CodexSessionHookInput | undefined {
  const parsedInput = codexSessionHookInputSchema.safeParse(input);
  return parsedInput.success ? parsedInput.data : undefined;
}

export type { OwningClaudeSessionReader };

export async function runCodexSessionHook(
  input: unknown,
  readOwningClaudeSession: OwningClaudeSessionReader = readOwningClaudeSessionMetadata,
  hostRuntimeIdentifiers: Omit<HookHostRuntimeIdentifiers, "readOwningClaudeSession"> = {},
): Promise<void> {
  const hookInput = parseCodexSessionHookInput(input);
  if (hookInput === undefined) {
    return;
  }

  const projectId = await resolveProjectIdentity(hookInput.cwd);
  if (hookInput.hook_event_name === "SessionEnd") {
    await unregisterActiveSession(hookInput.session_id, projectId, process.ppid);
    return;
  }

  const hookHostRuntime = await identifyHookHostRuntime(
    {
      sessionId: hookInput.session_id,
      parentProcessIdentifier: process.ppid,
      transcriptPath: hookInput.transcript_path ?? undefined,
    },
    { ...hostRuntimeIdentifiers, readOwningClaudeSession },
  );
  if (hookHostRuntime !== "codex") {
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

export async function runCodexSessionHookFromStandardInput(
  inputStream: AsyncIterable<string | Uint8Array> = process.stdin,
): Promise<void> {
  let receivedByteCount = 0;
  const receivedChunks: Buffer[] = [];
  for await (const inputChunk of inputStream) {
    const inputBuffer = Buffer.from(inputChunk);
    receivedByteCount += inputBuffer.length;
    if (receivedByteCount > maximumCodexSessionHookInputUtf8Bytes) {
      return;
    }
    receivedChunks.push(inputBuffer);
  }
  try {
    await runCodexSessionHook(
      JSON.parse(Buffer.concat(receivedChunks, receivedByteCount).toString("utf8")),
    );
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCodexSessionHookFromStandardInput();
}
