import { randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

import {
  AgentRuntime as agentRuntimeSchema,
  uuidSchema,
} from "../protocol/messageEnvelope.js";
import {
  projectIdentitySchema,
  resolveBridgeStateDirectory,
} from "../runtime/paths.js";
import {
  createPrivateRegularFile,
  ensurePrivateBridgeDirectory,
  openExistingPrivateRegularFile,
  prepareSecureBridgeState,
  removePrivateRegularFileIfPresent,
  renamePrivateRegularFile,
  resolveSecureBridgeOwnedPath,
  type SecureBridgeStateContext,
} from "./secureStateFilesystem.js";
import { withSessionMutationLock } from "./sessionMutationLock.js";

export type AgentRuntime = z.infer<typeof agentRuntimeSchema>;

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

function activeSessionRecordsMatch(
  firstRecord: ActiveSessionRecord,
  secondRecord: ActiveSessionRecord,
): boolean {
  return (
    firstRecord.schemaVersion === secondRecord.schemaVersion &&
    firstRecord.runtime === secondRecord.runtime &&
    firstRecord.sessionId === secondRecord.sessionId &&
    firstRecord.displayName === secondRecord.displayName &&
    firstRecord.processId === secondRecord.processId &&
    firstRecord.workingDirectory === secondRecord.workingDirectory &&
    firstRecord.projectId === secondRecord.projectId &&
    firstRecord.socketPath === secondRecord.socketPath &&
    firstRecord.registeredAt === secondRecord.registeredAt
  );
}

interface ActiveSessionRecordReadResult {
  exists: boolean;
  record?: ActiveSessionRecord;
}

interface SessionRecordLocation {
  projectIdentifier: string;
  recordPath: string;
  sessionIdentifier: string;
}

interface SessionRegistryLocation {
  projectIdentifier: string;
  sessionRegistryDirectory: string;
}

const absolutePathSchema = z
  .string()
  .refine((value) => isAbsolute(value) && !value.includes("\0"));

const activeSessionRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    runtime: agentRuntimeSchema,
    sessionId: uuidSchema,
    displayName: z.string().min(1),
    processId: z.number().int().safe().positive(),
    workingDirectory: absolutePathSchema,
    projectId: projectIdentitySchema,
    socketPath: absolutePathSchema.optional(),
    registeredAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.runtime === "claude" && record.socketPath === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Claude sessions require a socket path",
      });
    }
    if (record.runtime === "codex" && record.socketPath !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Codex sessions cannot have a socket path",
      });
    }
  });

const activeSessionFiltersSchema = z
  .object({
    runtime: agentRuntimeSchema.optional(),
    projectId: projectIdentitySchema.optional(),
  })
  .strict();

function pathIsContained(parentDirectory: string, candidatePath: string): boolean {
  const relativePath = relative(resolve(parentDirectory), resolve(candidatePath));
  return (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function parseStoredActiveSessionRecord(
  input: unknown,
  stateHomeDirectory?: string,
): ActiveSessionRecord | undefined {
  const parsedRecord = activeSessionRecordSchema.safeParse(input);
  if (!parsedRecord.success) {
    return undefined;
  }

  if (
    parsedRecord.data.socketPath !== undefined &&
    !pathIsContained(
      resolveBridgeStateDirectory(stateHomeDirectory),
      parsedRecord.data.socketPath,
    )
  ) {
    return undefined;
  }

  return parsedRecord.data;
}

function parseRegistrationRecord(
  input: ActiveSessionRecord,
  stateHomeDirectory?: string,
): ActiveSessionRecord {
  const parsedRecord = parseStoredActiveSessionRecord(input, stateHomeDirectory);
  if (parsedRecord === undefined) {
    throw new TypeError("Active session record is invalid");
  }

  return parsedRecord;
}

function resolveRecordPath(
  sessionRegistryDirectory: string,
  sessionIdentifier: string,
): string {
  return join(sessionRegistryDirectory, `${uuidSchema.parse(sessionIdentifier)}.json`);
}

async function processIsActive(processIdentifier: number): Promise<boolean> {
  try {
    process.kill(processIdentifier, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function probeUnixSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = connect(socketPath);
    let probeFinished = false;
    const finishProbe = (socketAccepted: boolean) => {
      if (probeFinished) {
        return;
      }

      probeFinished = true;
      clearTimeout(timeoutHandle);
      socket.destroy();
      resolveProbe(socketAccepted);
    };
    const timeoutHandle = setTimeout(() => finishProbe(false), 200);

    socket.once("connect", () => finishProbe(true));
    socket.once("error", () => finishProbe(false));
    socket.once("close", () => finishProbe(false));
  });
}

async function socketIsActive(
  socketPath: string,
  stateHomeDirectory?: string,
): Promise<boolean> {
  try {
    const bridgeStateContext = await prepareSecureBridgeState(stateHomeDirectory);
    const canonicalSocketPath = resolveSecureBridgeOwnedPath(
      bridgeStateContext,
      socketPath,
    );
    await ensurePrivateBridgeDirectory(
      bridgeStateContext,
      dirname(canonicalSocketPath),
      false,
    );
    const socketStatus = await lstat(canonicalSocketPath);
    if (
      socketStatus.isSymbolicLink() ||
      !socketStatus.isSocket() ||
      socketStatus.uid !== bridgeStateContext.userIdentifier ||
      (socketStatus.mode & 0o7777) !== 0o600
    ) {
      return false;
    }
    return probeUnixSocket(canonicalSocketPath);
  } catch {
    return false;
  }
}

async function activeSessionRecordIsActive(
  record: ActiveSessionRecord,
  stateHomeDirectory?: string,
): Promise<boolean> {
  if (!(await processIsActive(record.processId))) {
    return false;
  }

  return (
    record.runtime !== "claude" ||
    (await socketIsActive(record.socketPath!, stateHomeDirectory))
  );
}

async function readActiveSessionRecord(
  bridgeStateContext: SecureBridgeStateContext,
  recordPath: string,
  stateHomeDirectory?: string,
): Promise<ActiveSessionRecordReadResult> {
  let openedRecordFile;
  try {
    openedRecordFile = await openExistingPrivateRegularFile(
      bridgeStateContext,
      recordPath,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }

  let readFailed = false;
  try {
    const serializedRecord = await openedRecordFile.fileHandle.readFile("utf8");
    let parsedInput: unknown;
    try {
      parsedInput = JSON.parse(serializedRecord);
    } catch {
      return { exists: true };
    }

    return {
      exists: true,
      record: parseStoredActiveSessionRecord(parsedInput, stateHomeDirectory),
    };
  } catch (error) {
    readFailed = true;
    throw error;
  } finally {
    if (readFailed) {
      await openedRecordFile.fileHandle.close().catch(() => undefined);
    } else {
      await openedRecordFile.fileHandle.close();
    }
  }
}

async function writeActiveSessionRecord(
  bridgeStateContext: SecureBridgeStateContext,
  sessionRegistryDirectory: string,
  recordPath: string,
  record: ActiveSessionRecord,
): Promise<void> {
  const temporaryRecordPath = join(
    sessionRegistryDirectory,
    `.${record.sessionId}.${randomUUID()}.tmp`,
  );
  const serializedRecord = JSON.stringify(record);
  let temporaryRecordFile;

  try {
    await ensurePrivateBridgeDirectory(
      bridgeStateContext,
      sessionRegistryDirectory,
      false,
    );
    temporaryRecordFile = await createPrivateRegularFile(
      bridgeStateContext,
      temporaryRecordPath,
    );
    await temporaryRecordFile.fileHandle.writeFile(serializedRecord, "utf8");
    await temporaryRecordFile.fileHandle.chmod(0o600);
    await temporaryRecordFile.fileHandle.close();
    temporaryRecordFile = undefined;

    await ensurePrivateBridgeDirectory(
      bridgeStateContext,
      sessionRegistryDirectory,
      false,
    );
    await renamePrivateRegularFile(
      bridgeStateContext,
      temporaryRecordPath,
      recordPath,
    );
    const storedRecordFile = await openExistingPrivateRegularFile(
      bridgeStateContext,
      recordPath,
    );
    await storedRecordFile.fileHandle.close();
  } catch (error) {
    if (temporaryRecordFile !== undefined) {
      await temporaryRecordFile.fileHandle.close().catch(() => undefined);
    }
    await removePrivateRegularFileIfPresent(
      bridgeStateContext,
      temporaryRecordPath,
    ).catch(() => undefined);
    throw error;
  }
}

async function removeInactiveSessionRecord(
  recordPath: string,
  projectIdentifier: string,
  sessionIdentifier: string,
  stateHomeDirectory?: string,
): Promise<void> {
  await withSessionMutationLock(
    stateHomeDirectory,
    projectIdentifier,
    sessionIdentifier,
    async ({ bridgeStateContext }) => {
      const currentRecord = await readActiveSessionRecord(
        bridgeStateContext,
        recordPath,
        stateHomeDirectory,
      );
      if (
        currentRecord.exists &&
        (currentRecord.record === undefined ||
          currentRecord.record.projectId !== projectIdentifier ||
          currentRecord.record.sessionId !== sessionIdentifier ||
          !(await activeSessionRecordIsActive(
            currentRecord.record,
            stateHomeDirectory,
          )))
      ) {
        await removePrivateRegularFileIfPresent(bridgeStateContext, recordPath);
      }
    },
  );
}

async function listSessionRecordLocations(
  filters: ActiveSessionFilters,
  stateHomeDirectory?: string,
): Promise<SessionRecordLocation[]> {
  const bridgeStateContext = await prepareSecureBridgeState(stateHomeDirectory);
  const sessionsDirectory = join(bridgeStateContext.bridgeStateDirectory, "sessions");
  await ensurePrivateBridgeDirectory(bridgeStateContext, sessionsDirectory, true);

  let sessionRegistryLocations: SessionRegistryLocation[];
  if (filters.projectId !== undefined) {
    const sessionRegistryDirectory = join(sessionsDirectory, filters.projectId);
    await ensurePrivateBridgeDirectory(
      bridgeStateContext,
      sessionRegistryDirectory,
      true,
    );
    sessionRegistryLocations = [
      {
        projectIdentifier: filters.projectId,
        sessionRegistryDirectory,
      },
    ];
  } else {
    await ensurePrivateBridgeDirectory(bridgeStateContext, sessionsDirectory, false);
    const projectDirectoryEntries = await readdir(sessionsDirectory, {
      withFileTypes: true,
    });
    sessionRegistryLocations = [];
    for (const projectDirectoryEntry of projectDirectoryEntries) {
      if (!projectIdentitySchema.safeParse(projectDirectoryEntry.name).success) {
        continue;
      }

      const sessionRegistryDirectory = join(
        sessionsDirectory,
        projectDirectoryEntry.name,
      );
      await ensurePrivateBridgeDirectory(
        bridgeStateContext,
        sessionRegistryDirectory,
        false,
      );
      sessionRegistryLocations.push({
        projectIdentifier: projectDirectoryEntry.name,
        sessionRegistryDirectory,
      });
    }
  }

  const recordLocations: SessionRecordLocation[] = [];
  for (const sessionRegistryLocation of sessionRegistryLocations) {
    await ensurePrivateBridgeDirectory(
      bridgeStateContext,
      sessionRegistryLocation.sessionRegistryDirectory,
      false,
    );
    const registryEntries = await readdir(
      sessionRegistryLocation.sessionRegistryDirectory,
      { withFileTypes: true },
    );
    for (const registryEntry of registryEntries) {
      if (!registryEntry.name.endsWith(".json")) {
        continue;
      }

      const sessionIdentifier = registryEntry.name.slice(0, -5);
      if (!uuidSchema.safeParse(sessionIdentifier).success) {
        continue;
      }

      recordLocations.push({
        projectIdentifier: sessionRegistryLocation.projectIdentifier,
        recordPath: join(
          sessionRegistryLocation.sessionRegistryDirectory,
          registryEntry.name,
        ),
        sessionIdentifier,
      });
    }
  }

  return recordLocations;
}

export async function registerActiveSession(
  record: ActiveSessionRecord,
  stateHomeDirectory?: string,
): Promise<void> {
  const parsedRecord = parseRegistrationRecord(record, stateHomeDirectory);

  await withSessionMutationLock(
    stateHomeDirectory,
    parsedRecord.projectId,
    parsedRecord.sessionId,
    async ({ bridgeStateContext, sessionRegistryDirectory }) => {
      const recordPath = resolveRecordPath(
        sessionRegistryDirectory,
        parsedRecord.sessionId,
      );
      await writeActiveSessionRecord(
        bridgeStateContext,
        sessionRegistryDirectory,
        recordPath,
        parsedRecord,
      );
    },
  );
}

export async function activeSessionRegistrationIsOwned(
  expectedRecord: ActiveSessionRecord,
  stateHomeDirectory?: string,
): Promise<boolean> {
  const parsedExpectedRecord = parseRegistrationRecord(
    expectedRecord,
    stateHomeDirectory,
  );
  const bridgeStateContext = await prepareSecureBridgeState(stateHomeDirectory);
  const sessionRegistryDirectory = join(
    bridgeStateContext.bridgeStateDirectory,
    "sessions",
    parsedExpectedRecord.projectId,
  );
  await ensurePrivateBridgeDirectory(
    bridgeStateContext,
    sessionRegistryDirectory,
    false,
  );
  const currentRecord = await readActiveSessionRecord(
    bridgeStateContext,
    resolveRecordPath(sessionRegistryDirectory, parsedExpectedRecord.sessionId),
    stateHomeDirectory,
  );

  return (
    currentRecord.record !== undefined &&
    activeSessionRecordsMatch(currentRecord.record, parsedExpectedRecord) &&
    (await processIsActive(parsedExpectedRecord.processId))
  );
}

export async function unregisterActiveSessionGeneration(
  expectedRecord: ActiveSessionRecord,
  stateHomeDirectory?: string,
): Promise<void> {
  const parsedExpectedRecord = parseRegistrationRecord(
    expectedRecord,
    stateHomeDirectory,
  );

  await withSessionMutationLock(
    stateHomeDirectory,
    parsedExpectedRecord.projectId,
    parsedExpectedRecord.sessionId,
    async ({ bridgeStateContext, sessionRegistryDirectory }) => {
      const recordPath = resolveRecordPath(
        sessionRegistryDirectory,
        parsedExpectedRecord.sessionId,
      );
      const currentRecord = await readActiveSessionRecord(
        bridgeStateContext,
        recordPath,
        stateHomeDirectory,
      );
      if (
        currentRecord.record !== undefined &&
        activeSessionRecordsMatch(currentRecord.record, parsedExpectedRecord)
      ) {
        await removePrivateRegularFileIfPresent(bridgeStateContext, recordPath);
      }
    },
  );
}

export async function unregisterActiveSession(
  sessionIdentifier: string,
  projectIdentifier: string,
  expectedProcessIdentifier: number,
  stateHomeDirectory?: string,
): Promise<void> {
  const validatedSessionIdentifier = uuidSchema.parse(sessionIdentifier);
  const validatedProjectIdentifier = projectIdentitySchema.parse(projectIdentifier);
  const validatedProcessIdentifier = z
    .number()
    .int()
    .safe()
    .positive()
    .parse(expectedProcessIdentifier);

  await withSessionMutationLock(
    stateHomeDirectory,
    validatedProjectIdentifier,
    validatedSessionIdentifier,
    async ({ bridgeStateContext, sessionRegistryDirectory }) => {
      const recordPath = resolveRecordPath(
        sessionRegistryDirectory,
        validatedSessionIdentifier,
      );
      const currentRecord = await readActiveSessionRecord(
        bridgeStateContext,
        recordPath,
        stateHomeDirectory,
      );
      if (currentRecord.record?.processId === validatedProcessIdentifier) {
        await removePrivateRegularFileIfPresent(bridgeStateContext, recordPath);
      }
    },
  );
}

export async function listActiveSessions(
  filters: ActiveSessionFilters = {},
  stateHomeDirectory?: string,
): Promise<ActiveSessionRecord[]> {
  const validatedFilters = activeSessionFiltersSchema.parse(filters);
  const bridgeStateContext = await prepareSecureBridgeState(stateHomeDirectory);
  const recordLocations = await listSessionRecordLocations(
    validatedFilters,
    stateHomeDirectory,
  );
  const activeSessionRecords: ActiveSessionRecord[] = [];

  for (const recordLocation of recordLocations) {
    const currentRecord = await readActiveSessionRecord(
      bridgeStateContext,
      recordLocation.recordPath,
      stateHomeDirectory,
    );
    if (
      currentRecord.record === undefined ||
      currentRecord.record.projectId !== recordLocation.projectIdentifier ||
      currentRecord.record.sessionId !== recordLocation.sessionIdentifier ||
      !(await activeSessionRecordIsActive(
        currentRecord.record,
        stateHomeDirectory,
      ))
    ) {
      await removeInactiveSessionRecord(
        recordLocation.recordPath,
        recordLocation.projectIdentifier,
        recordLocation.sessionIdentifier,
        stateHomeDirectory,
      );
      continue;
    }

    if (
      validatedFilters.runtime !== undefined &&
      currentRecord.record.runtime !== validatedFilters.runtime
    ) {
      continue;
    }
    if (
      validatedFilters.projectId !== undefined &&
      currentRecord.record.projectId !== validatedFilters.projectId
    ) {
      continue;
    }

    activeSessionRecords.push(currentRecord.record);
  }

  return activeSessionRecords.sort((firstRecord, secondRecord) =>
    firstRecord.sessionId.localeCompare(secondRecord.sessionId),
  );
}

export async function findActiveSession(
  identifier: string,
  filters: ActiveSessionFilters = {},
  stateHomeDirectory?: string,
): Promise<ActiveSessionRecord | undefined> {
  if (identifier.length === 0 || identifier.includes("\0")) {
    throw new TypeError("Session identifier must not be empty");
  }

  const sessions = await listActiveSessions(filters, stateHomeDirectory);
  const exactIdentifierMatches = sessions.filter(
    (session) => session.sessionId === identifier,
  );
  if (exactIdentifierMatches.length > 1) {
    throw new RangeError("Session ID is not unique; apply more filters");
  }
  if (exactIdentifierMatches.length === 1) {
    return exactIdentifierMatches[0];
  }

  const displayNameMatches = sessions.filter(
    (session) => session.displayName === identifier,
  );
  if (displayNameMatches.length > 1) {
    throw new RangeError(
      "Session display name is ambiguous; use a session ID",
    );
  }

  return displayNameMatches[0];
}
