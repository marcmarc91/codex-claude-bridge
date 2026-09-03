import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import { AgentRuntime as agentRuntimeSchema, uuidSchema } from "../protocol/messageEnvelope.js";
import { projectIdentitySchema, resolveBridgeStateDirectory, resolveSessionRegistryDirectory } from "../runtime/paths.js";

export type AgentRuntime = z.infer<typeof agentRuntimeSchema>;
export interface ActiveSessionRecord { schemaVersion: 1; runtime: AgentRuntime; sessionId: string; displayName: string; processId: number; workingDirectory: string; projectId: string; socketPath?: string; registeredAt: string; }
export interface ActiveSessionFilters { runtime?: AgentRuntime; projectId?: string; }

const activeSessionRecordSchema = z.object({
  schemaVersion: z.literal(1), runtime: agentRuntimeSchema, sessionId: uuidSchema, displayName: z.string().min(1),
  processId: z.number().int().safe().positive(), workingDirectory: z.string().refine((value) => isAbsolute(value) && !value.includes("\0")),
  projectId: projectIdentitySchema, socketPath: z.string().optional(), registeredAt: z.string().datetime({ offset: true }),
}).strict().superRefine((record, context) => {
  if (record.runtime === "claude" && record.socketPath === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: "Claude sessions require a socket path" });
  if (record.runtime === "codex" && record.socketPath !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: "Codex sessions cannot have a socket path" });
});

const sessionLockMetadataSchema = z.object({
  ownerId: uuidSchema,
  processId: z.number().int().safe().positive(),
  acquiredAt: z.string().datetime({ offset: true }),
}).strict();

const lockMetadataGraceMilliseconds = 500;
const lockLeaseMilliseconds = 2_000;

function contained(parent: string, candidate: string): boolean { const child = relative(resolve(parent), resolve(candidate)); return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child); }
function registry(stateHome: string | undefined, projectId: string): string { const root = resolveBridgeStateDirectory(stateHome); return resolveSessionRegistryDirectory(dirname(root), projectIdentitySchema.parse(projectId)); }
function recordPath(directory: string, sessionId: string): string { const path = join(directory, `${uuidSchema.parse(sessionId)}.json`); if (!contained(directory, path)) throw new RangeError("Session record path must remain within its registry directory"); return path; }
function lockPath(directory: string, sessionId: string): string { const path = join(directory, ".locks", uuidSchema.parse(sessionId)); if (!contained(directory, path)) throw new RangeError("Session lock path must remain within its registry directory"); return path; }
function parseRecord(input: unknown, stateHome?: string): ActiveSessionRecord | undefined { const parsed = activeSessionRecordSchema.safeParse(input); if (!parsed.success || (parsed.data.socketPath !== undefined && !contained(resolveBridgeStateDirectory(stateHome), parsed.data.socketPath))) return undefined; return parsed.data; }
async function privateDirectory(path: string): Promise<void> { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); }

async function secureExistingBridgePath(bridgeStateDirectory: string, existingPath: string): Promise<boolean> {
  if (!contained(bridgeStateDirectory, existingPath)) return false;
  const relativeSegments = relative(resolve(bridgeStateDirectory), resolve(existingPath)).split(sep).filter(Boolean);
  let inspectedPath = resolve(bridgeStateDirectory);
  try {
    if ((await lstat(inspectedPath)).isSymbolicLink()) return false;
    for (const pathSegment of relativeSegments) {
      inspectedPath = join(inspectedPath, pathSegment);
      if ((await lstat(inspectedPath)).isSymbolicLink()) return false;
    }
    return contained(await realpath(bridgeStateDirectory), await realpath(existingPath));
  } catch { return false; }
}

async function withLock<T>(directory: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
  const ticketDirectory = lockPath(directory, sessionId); const ownerId = randomUUID();
  await privateDirectory(ticketDirectory);
  const ticketBaseName = `${Date.now().toString().padStart(16, "0")}-${ownerId}`;
  const temporaryTicketPath = join(ticketDirectory, `.${ticketBaseName}.tmp`);
  const ticketPath = join(ticketDirectory, `${ticketBaseName}.ticket`);
  const ticketMetadata = JSON.stringify({ ownerId, processId: process.pid, acquiredAt: new Date().toISOString() });
  const ticketFile = await open(temporaryTicketPath, "wx", 0o600);
  await ticketFile.writeFile(ticketMetadata, "utf8");
  await ticketFile.close();
  await rename(temporaryTicketPath, ticketPath);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ticketNames = await readdir(ticketDirectory);
    for (const ticketName of ticketNames.filter((name) => name.endsWith(".ticket"))) {
      const candidateTicketPath = join(ticketDirectory, ticketName);
      const candidateTicketMetadata = sessionLockMetadataSchema.safeParse(JSON.parse(await readFile(candidateTicketPath, "utf8").catch(() => "null")));
      if (!candidateTicketMetadata.success) continue;
      const ticketAge = Date.now() - Date.parse(candidateTicketMetadata.data.acquiredAt);
      if (!(await processActive(candidateTicketMetadata.data.processId)) || ticketAge > lockLeaseMilliseconds) await unlink(candidateTicketPath).catch(() => undefined);
    }
    const activeTicketNames = (await readdir(ticketDirectory)).filter((name) => name.endsWith(".ticket")).sort();
    if (activeTicketNames[0] === `${ticketBaseName}.ticket`) {
      try { return await operation(); } finally { await unlink(ticketPath).catch(() => undefined); }
    }
    await delay(10);
  }
  await unlink(ticketPath).catch(() => undefined);
  throw new Error("Timed out waiting for a session mutation lock");
}

async function processActive(processId: number): Promise<boolean> { try { process.kill(processId, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }
async function socketActive(path: string, stateHome?: string): Promise<boolean> {
  if (!contained(resolveBridgeStateDirectory(stateHome), path)) return false;
  try { const status = await lstat(path); if (status.isSymbolicLink() || !status.isSocket() || (status.mode & 0o077) !== 0 || !(await secureExistingBridgePath(resolveBridgeStateDirectory(stateHome), path))) return false; } catch { return false; }
  return new Promise((resolveProbe) => { const socket = connect(path); const timer = setTimeout(() => socket.destroy(), 200); const finish = (value: boolean) => { clearTimeout(timer); socket.destroy(); resolveProbe(value); }; socket.once("connect", () => finish(true)); socket.once("error", () => finish(false)); socket.once("close", () => finish(false)); });
}
async function active(record: ActiveSessionRecord, stateHome?: string): Promise<boolean> { return (await processActive(record.processId)) && (record.runtime !== "claude" || await socketActive(record.socketPath!, stateHome)); }
async function readRecord(path: string, stateHome?: string): Promise<ActiveSessionRecord | undefined> { try { return parseRecord(JSON.parse(await readFile(path, "utf8")), stateHome); } catch { return undefined; } }

async function cleanInactive(path: string, directory: string, sessionId: string, stateHome?: string): Promise<void> { await withLock(directory, sessionId, async () => { const current = await readRecord(path, stateHome); if (current === undefined || !(await active(current, stateHome))) await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }); }
async function paths(filters: ActiveSessionFilters, stateHome?: string): Promise<string[]> {
  const sessions = join(resolveBridgeStateDirectory(stateHome), "sessions");
  const directories = filters.projectId === undefined ? await readdir(sessions, { withFileTypes: true }).then((entries) => entries.filter((entry) => entry.isDirectory() && projectIdentitySchema.safeParse(entry.name).success).map((entry) => join(sessions, entry.name))).catch(() => []) : [registry(stateHome, filters.projectId)];
  return (await Promise.all(directories.map(async (directory) => { try { return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".json") && uuidSchema.safeParse(entry.name.slice(0, -5)).success).map((entry) => join(directory, entry.name)); } catch { return []; } }))).flat();
}

export async function registerActiveSession(record: ActiveSessionRecord, stateHome?: string): Promise<void> {
  const parsed = parseRecord(record, stateHome); if (parsed === undefined) throw new TypeError("Active session record is invalid");
  const directory = registry(stateHome, parsed.projectId); await privateDirectory(directory); const path = recordPath(directory, parsed.sessionId);
  await withLock(directory, parsed.sessionId, async () => { const temporaryPath = join(directory, `.${parsed.sessionId}.${randomUUID()}.tmp`); let file: Awaited<ReturnType<typeof open>> | undefined; try { file = await open(temporaryPath, "wx", 0o600); await file.writeFile(JSON.stringify(parsed), "utf8"); await file.close(); file = undefined; await rename(temporaryPath, path); await chmod(path, 0o600); } catch (error) { if (file !== undefined) await file.close().catch(() => undefined); await rm(temporaryPath, { force: true }).catch(() => undefined); throw error; } });
}

export async function unregisterActiveSession(sessionId: string, projectId: string, expectedProcessId: number, stateHome?: string): Promise<void> {
  const directory = registry(stateHome, projectId); const path = recordPath(directory, sessionId);
  await withLock(directory, sessionId, async () => { const current = await readRecord(path, stateHome); if (current !== undefined && current.processId === expectedProcessId) await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); });
}

export async function listActiveSessions(filters: ActiveSessionFilters = {}, stateHome?: string): Promise<ActiveSessionRecord[]> {
  const records = await Promise.all((await paths(filters, stateHome)).map(async (path) => { const sessionId = path.slice(path.lastIndexOf("/") + 1, -5); const current = await readRecord(path, stateHome); if (current === undefined || !(await active(current, stateHome))) { await cleanInactive(path, dirname(path), sessionId, stateHome); return undefined; } if ((filters.runtime !== undefined && current.runtime !== filters.runtime) || (filters.projectId !== undefined && current.projectId !== filters.projectId)) return undefined; return current; }));
  return records.filter((record): record is ActiveSessionRecord => record !== undefined).sort((first, second) => first.sessionId.localeCompare(second.sessionId));
}

export async function findActiveSession(identifier: string, filters: ActiveSessionFilters = {}, stateHome?: string): Promise<ActiveSessionRecord | undefined> {
  const sessions = await listActiveSessions(filters, stateHome); const exact = sessions.filter((session) => session.sessionId === identifier); if (exact.length > 1) throw new RangeError("Session ID is not unique; apply more filters"); if (exact.length === 1) return exact[0]; const named = sessions.filter((session) => session.displayName === identifier); if (named.length > 1) throw new RangeError("Session display name is ambiguous; use a session ID"); return named[0];
}
