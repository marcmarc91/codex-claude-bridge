import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveBridgeStateDirectory, resolveSessionRegistryDirectory } from "../runtime/paths.js";

export type AgentRuntime = "claude" | "codex";

export interface ActiveSessionRecord {
  schemaVersion: 1;
  runtime: AgentRuntime;
  sessionId: string;
  displayName: string;
  processId: number;
  workingDirectory: string;
  projectId: string;
  socketPath?: string;
  registeredAt: string;
}

export interface ActiveSessionFilters {
  runtime?: AgentRuntime;
  projectId?: string;
}

function getRecordPath(registryDirectory: string, sessionId: string): string {
  return join(registryDirectory, `${sessionId}.json`);
}

function resolveRegistryDirectory(
  stateHomeDirectory: string | undefined,
  projectId: string,
): string {
  return resolveSessionRegistryDirectory(
    dirname(resolveBridgeStateDirectory(stateHomeDirectory)),
    projectId,
  );
}

function isAgentRuntime(value: unknown): value is AgentRuntime {
  return value === "claude" || value === "codex";
}

function parseActiveSessionRecord(value: unknown): ActiveSessionRecord | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    !isAgentRuntime(record.runtime) ||
    typeof record.sessionId !== "string" ||
    typeof record.displayName !== "string" ||
    typeof record.processId !== "number" ||
    !Number.isSafeInteger(record.processId) ||
    record.processId <= 0 ||
    typeof record.workingDirectory !== "string" ||
    typeof record.projectId !== "string" ||
    typeof record.registeredAt !== "string" ||
    (record.socketPath !== undefined && typeof record.socketPath !== "string")
  ) {
    return undefined;
  }

  if (record.runtime === "claude" && record.socketPath === undefined) {
    return undefined;
  }

  return {
    schemaVersion: 1,
    runtime: record.runtime,
    sessionId: record.sessionId,
    displayName: record.displayName,
    processId: record.processId,
    workingDirectory: record.workingDirectory,
    projectId: record.projectId,
    socketPath: record.socketPath,
    registeredAt: record.registeredAt,
  };
}

async function createPrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function isProcessActive(processId: number): Promise<boolean> {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function isSessionActive(record: ActiveSessionRecord): Promise<boolean> {
  if (!(await isProcessActive(record.processId))) {
    return false;
  }

  if (record.runtime !== "claude") {
    return true;
  }

  try {
    await stat(record.socketPath!);
    return true;
  } catch {
    return false;
  }
}

async function readActiveSessionRecord(recordPath: string): Promise<ActiveSessionRecord | undefined> {
  try {
    const file = await open(recordPath, "r");
    try {
      const content = await file.readFile({ encoding: "utf8" });
      return parseActiveSessionRecord(JSON.parse(content));
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

async function listRecordPaths(
  filters: ActiveSessionFilters,
  stateHomeDirectory: string | undefined,
): Promise<string[]> {
  const sessionsDirectory = join(resolveBridgeStateDirectory(stateHomeDirectory), "sessions");
  const registryDirectories = filters.projectId === undefined
    ? await readdir(sessionsDirectory, { withFileTypes: true }).then((entries) =>
      entries.filter((entry) => entry.isDirectory()).map((entry) => join(sessionsDirectory, entry.name)),
    ).catch(() => [])
    : [resolveRegistryDirectory(stateHomeDirectory, filters.projectId)];

  const recordPaths = await Promise.all(registryDirectories.map(async (registryDirectory) => {
    try {
      const entries = await readdir(registryDirectory, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => join(registryDirectory, entry.name));
    } catch {
      return [];
    }
  }));
  return recordPaths.flat();
}

export async function registerActiveSession(
  record: ActiveSessionRecord,
  stateHomeDirectory?: string,
): Promise<void> {
  const parsedRecord = parseActiveSessionRecord(record);
  if (parsedRecord === undefined) {
    throw new TypeError("Active session record is invalid");
  }

  const registryDirectory = resolveRegistryDirectory(stateHomeDirectory, parsedRecord.projectId);
  await createPrivateDirectory(registryDirectory);
  const recordPath = getRecordPath(registryDirectory, parsedRecord.sessionId);
  const temporaryRecordPath = join(registryDirectory, `.${parsedRecord.sessionId}.${randomUUID()}.tmp`);
  const temporaryRecord = await open(temporaryRecordPath, "wx", 0o600);

  try {
    await temporaryRecord.writeFile(JSON.stringify(parsedRecord), { encoding: "utf8" });
  } finally {
    await temporaryRecord.close();
  }

  try {
    await rename(temporaryRecordPath, recordPath);
    await chmod(recordPath, 0o600);
  } catch (error) {
    await rm(temporaryRecordPath, { force: true });
    throw error;
  }
}

export async function unregisterActiveSession(
  sessionId: string,
  projectId: string,
  stateHomeDirectory?: string,
): Promise<void> {
  const registryDirectory = resolveRegistryDirectory(stateHomeDirectory, projectId);
  await rm(getRecordPath(registryDirectory, sessionId), { force: true });
}

export async function listActiveSessions(
  filters: ActiveSessionFilters = {},
  stateHomeDirectory?: string,
): Promise<ActiveSessionRecord[]> {
  const recordPaths = await listRecordPaths(filters, stateHomeDirectory);
  const records = await Promise.all(recordPaths.map(async (recordPath) => {
    const record = await readActiveSessionRecord(recordPath);
    const sessionIsActive = record !== undefined && await isSessionActive(record);
    if (
      record === undefined ||
      (filters.runtime !== undefined && record.runtime !== filters.runtime) ||
      (filters.projectId !== undefined && record.projectId !== filters.projectId) ||
      !sessionIsActive
    ) {
      if (record === undefined || !sessionIsActive) {
        await rm(recordPath, { force: true });
      }
      return undefined;
    }
    return record;
  }));

  return records.filter((record): record is ActiveSessionRecord => record !== undefined)
    .sort((firstRecord, secondRecord) => firstRecord.sessionId.localeCompare(secondRecord.sessionId));
}

export async function findActiveSession(
  identifier: string,
  filters: ActiveSessionFilters = {},
  stateHomeDirectory?: string,
): Promise<ActiveSessionRecord | undefined> {
  const sessions = await listActiveSessions(filters, stateHomeDirectory);
  const sessionByIdentifier = sessions.find((session) => session.sessionId === identifier);
  if (sessionByIdentifier !== undefined) {
    return sessionByIdentifier;
  }

  const sessionsByName = sessions.filter((session) => session.displayName === identifier);
  if (sessionsByName.length > 1) {
    throw new RangeError("Session display name is ambiguous; use a session ID");
  }
  return sessionsByName[0];
}
