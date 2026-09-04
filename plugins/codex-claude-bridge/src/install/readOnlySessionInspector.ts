import { constants } from "node:fs";
import type { Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { uuidSchema } from "../protocol/messageEnvelope.js";
import {
  parseStoredActiveSessionRecord,
  type ActiveSessionRecord,
} from "../registry/activeSessionRegistry.js";
import { projectIdentitySchema, resolveBridgeStateDirectory } from "../runtime/paths.js";

const maximumRecordBytes = 64 * 1024;
const maximumProjectEntries = 64;
const maximumSessionEntries = 128;
const maximumConcurrentProbes = 16;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;

interface ReadOnlyRegistryContext {
  bridgeStateDirectory: string;
  stateHomeDirectory: string | undefined;
  userIdentifier: number;
}

interface RecordCandidate {
  projectIdentifier: string;
  recordPath: string;
  sessionIdentifier: string;
}

function currentUserIdentifier(): number {
  if (typeof process.getuid !== "function") {
    throw new Error("A numeric user identifier is required for bridge state inspection");
  }
  return process.getuid();
}

async function processIsActive(processIdentifier: number): Promise<boolean> {
  try {
    process.kill(processIdentifier, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function socketAcceptsConnection(
  socketPath: string,
  context: ReadOnlyRegistryContext,
): Promise<boolean> {
  try {
    await verifyReadOnlySessionSocketParent(
      context.bridgeStateDirectory,
      socketPath,
      context.userIdentifier,
    );
    const status = await lstat(socketPath);
    if (
      !status.isSocket() ||
      status.isSymbolicLink() ||
      (status.mode & 0o7777) !== privateFileMode ||
      status.uid !== context.userIdentifier
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return new Promise<boolean>((resolveConnection) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (accepted: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolveConnection(accepted);
    };
    const timeout = setTimeout(() => finish(false), 250);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}

async function readBoundedFile(
  fileHandle: FileHandle,
  maximumBytes: number,
): Promise<Buffer> {
  const output = Buffer.allocUnsafe(maximumBytes + 1);
  let offset = 0;
  while (offset < output.byteLength) {
    const { bytesRead } = await fileHandle.read(
      output,
      offset,
      output.byteLength - offset,
      offset,
    );
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  if (offset > maximumBytes) {
    throw new Error("Active session record exceeds the size limit");
  }
  return output.subarray(0, offset);
}

async function verifyPrivateDirectory(
  directoryPath: string,
  userIdentifier: number,
): Promise<void> {
  let directoryHandle: FileHandle;
  try {
    directoryHandle = await open(
      directoryPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ELOOP" || errorCode === "ENOTDIR") {
      throw new Error(`Session registry directory is not canonical: ${directoryPath}`);
    }
    throw error;
  }
  try {
    const status = await directoryHandle.stat();
    if (!status.isDirectory() || status.uid !== userIdentifier) {
      throw new Error(`Session registry directory has an unexpected owner: ${directoryPath}`);
    }
    if ((status.mode & 0o7777) !== privateDirectoryMode) {
      throw new Error(`Session registry directory is not private: ${directoryPath}`);
    }
    if ((await realpath(directoryPath)) !== resolve(directoryPath)) {
      throw new Error(`Session registry directory is not canonical: ${directoryPath}`);
    }
  } finally {
    await directoryHandle.close();
  }
}

export async function verifyReadOnlySessionSocketParent(
  bridgeStateDirectory: string,
  socketPath: string,
  userIdentifier = currentUserIdentifier(),
): Promise<void> {
  const canonicalBridgeStateDirectory = resolve(bridgeStateDirectory);
  const socketParentDirectory = resolve(dirname(socketPath));
  const socketParentRelativePath = relative(
    canonicalBridgeStateDirectory,
    socketParentDirectory,
  );
  if (
    socketParentRelativePath === ".." ||
    socketParentRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(socketParentRelativePath)
  ) {
    throw new RangeError("Session socket must remain within the bridge state directory");
  }

  await verifyPrivateDirectory(canonicalBridgeStateDirectory, userIdentifier);
  let currentDirectory = canonicalBridgeStateDirectory;
  for (const segment of socketParentRelativePath.split(sep).filter(Boolean)) {
    currentDirectory = join(currentDirectory, segment);
    await verifyPrivateDirectory(currentDirectory, userIdentifier);
  }
}

async function readDirectoryEntriesBounded(
  directoryPath: string,
  maximumEntries: number,
  userIdentifier: number,
): Promise<Dirent[]> {
  await verifyPrivateDirectory(directoryPath, userIdentifier);
  const directory = await opendir(directoryPath);
  const entries: Dirent[] = [];
  try {
    while (entries.length <= maximumEntries) {
      const entry = await directory.read();
      if (entry === null) {
        break;
      }
      entries.push(entry);
    }
  } finally {
    await directory.close().catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ERR_DIR_CLOSED") {
        throw error;
      }
    });
  }
  await verifyPrivateDirectory(directoryPath, userIdentifier);
  if (entries.length > maximumEntries) {
    throw new Error(`Session registry entry limit exceeded: ${directoryPath}`);
  }
  return entries;
}

async function resolveReadOnlyRegistryContext(
  stateHomeDirectory?: string,
): Promise<ReadOnlyRegistryContext | undefined> {
  const configuredBridgeStateDirectory = resolve(
    resolveBridgeStateDirectory(stateHomeDirectory),
  );
  let canonicalStateTrustRoot: string;
  try {
    canonicalStateTrustRoot = await realpath(dirname(configuredBridgeStateDirectory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  const bridgeStateDirectory = join(
    canonicalStateTrustRoot,
    basename(configuredBridgeStateDirectory),
  );
  const userIdentifier = currentUserIdentifier();
  try {
    await verifyPrivateDirectory(bridgeStateDirectory, userIdentifier);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  return { bridgeStateDirectory, stateHomeDirectory, userIdentifier };
}

async function readRecord(
  context: ReadOnlyRegistryContext,
  candidate: RecordCandidate,
): Promise<ActiveSessionRecord | undefined> {
  let recordFile: FileHandle;
  try {
    recordFile = await open(
      candidate.recordPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    const status = await recordFile.stat();
    if (
      !status.isFile() ||
      status.size > maximumRecordBytes ||
      (status.mode & 0o7777) !== privateFileMode ||
      status.uid !== context.userIdentifier
    ) {
      throw new Error(`Active session record is unsafe: ${candidate.recordPath}`);
    }
    let parsedInput: unknown;
    try {
      parsedInput = JSON.parse(
        (await readBoundedFile(recordFile, maximumRecordBytes)).toString("utf8"),
      );
    } catch {
      throw new Error(`Active session record is invalid: ${candidate.recordPath}`);
    }
    const parsedRecord = parseStoredActiveSessionRecord(
      parsedInput,
      context.stateHomeDirectory,
      context.bridgeStateDirectory,
    );
    if (
      parsedRecord === undefined ||
      parsedRecord.projectId !== candidate.projectIdentifier ||
      parsedRecord.sessionId !== candidate.sessionIdentifier
    ) {
      throw new Error(`Active session record identity is invalid: ${candidate.recordPath}`);
    }
    return parsedRecord;
  } finally {
    await recordFile.close();
  }
}

async function recordIsActive(
  context: ReadOnlyRegistryContext,
  record: ActiveSessionRecord,
): Promise<boolean> {
  if (!(await processIsActive(record.processId))) {
    return false;
  }
  return (
    record.runtime === "codex" ||
    (await socketAcceptsConnection(record.socketPath!, context))
  );
}

async function inspectCandidateBatch(
  context: ReadOnlyRegistryContext,
  candidates: RecordCandidate[],
): Promise<ActiveSessionRecord[]> {
  const records = await Promise.all(
    candidates.map(async (candidate) => {
      const record = await readRecord(context, candidate);
      return record !== undefined && (await recordIsActive(context, record))
        ? record
        : undefined;
    }),
  );
  return records.filter((record): record is ActiveSessionRecord => record !== undefined);
}

export async function inspectActiveSessionsReadOnly(
  stateHomeDirectory?: string,
): Promise<ActiveSessionRecord[]> {
  const context = await resolveReadOnlyRegistryContext(stateHomeDirectory);
  if (context === undefined) {
    return [];
  }
  const sessionsDirectory = join(context.bridgeStateDirectory, "sessions");
  let projectEntries: Dirent[];
  try {
    projectEntries = await readDirectoryEntriesBounded(
      sessionsDirectory,
      maximumProjectEntries,
      context.userIdentifier,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const candidates: RecordCandidate[] = [];
  for (const projectEntry of projectEntries) {
    if (
      !projectEntry.isDirectory() ||
      !projectIdentitySchema.safeParse(projectEntry.name).success
    ) {
      continue;
    }
    const projectDirectory = join(sessionsDirectory, projectEntry.name);
    const recordEntries = await readDirectoryEntriesBounded(
      projectDirectory,
      maximumSessionEntries,
      context.userIdentifier,
    );
    for (const recordEntry of recordEntries) {
      if (!recordEntry.isFile() || !recordEntry.name.endsWith(".json")) {
        continue;
      }
      const sessionIdentifier = recordEntry.name.slice(0, -5);
      if (!uuidSchema.safeParse(sessionIdentifier).success) {
        continue;
      }
      if (candidates.length >= maximumSessionEntries) {
        throw new Error("Active session registry entry limit exceeded");
      }
      candidates.push({
        projectIdentifier: projectEntry.name,
        recordPath: join(projectDirectory, recordEntry.name),
        sessionIdentifier,
      });
    }
  }

  const activeSessions: ActiveSessionRecord[] = [];
  for (let offset = 0; offset < candidates.length; offset += maximumConcurrentProbes) {
    activeSessions.push(
      ...(await inspectCandidateBatch(
        context,
        candidates.slice(offset, offset + maximumConcurrentProbes),
      )),
    );
  }
  return activeSessions.sort((firstRecord, secondRecord) =>
    firstRecord.sessionId.localeCompare(secondRecord.sessionId),
  );
}
