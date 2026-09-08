import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { uuidSchema } from "../protocol/messageEnvelope.js";
import { projectIdentitySchema } from "../runtime/paths.js";
import {
  listActiveSessions,
  probeUnixSocket,
} from "./activeSessionRegistry.js";
import {
  ensurePrivateBridgeDirectory,
  prepareSecureBridgeState,
  resolveSecureBridgeOwnedPath,
  type SecureBridgeStateContext,
} from "./secureStateFilesystem.js";

export interface SkippedBridgeStatePath {
  path: string;
  reason: string;
}

export interface BridgeStateCleanupSummary {
  removedSockets: number;
  removedSessionRecords: number;
  skipped: SkippedBridgeStatePath[];
}

const channelSocketFilenamePattern = /^c-[0-9a-f]{16}\.sock$/u;
const sessionRecordFilenameSuffix = ".json";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function pathStillExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return !isEnoent(error);
  }
}

async function listCandidateSessionRecordPaths(
  projectDirectory: string,
): Promise<string[]> {
  const entries = await readdir(projectDirectory, { withFileTypes: true });
  const recordPaths: string[] = [];

  for (const entry of entries) {
    if (!entry.name.endsWith(sessionRecordFilenameSuffix)) {
      continue;
    }
    const sessionIdentifier = entry.name.slice(
      0,
      -sessionRecordFilenameSuffix.length,
    );
    if (!uuidSchema.safeParse(sessionIdentifier).success) {
      continue;
    }
    recordPaths.push(join(projectDirectory, entry.name));
  }

  return recordPaths;
}

async function listValidatedProjectIdentifiers(
  bridgeStateContext: SecureBridgeStateContext,
  sessionsDirectory: string,
  skipped: SkippedBridgeStatePath[],
): Promise<{ projectIdentifiers: string[]; referenceSetIncomplete: boolean }> {
  let sessionsDirectoryEntries;
  try {
    await ensurePrivateBridgeDirectory(bridgeStateContext, sessionsDirectory, true);
    sessionsDirectoryEntries = await readdir(sessionsDirectory, {
      withFileTypes: true,
    });
  } catch (error) {
    skipped.push({
      path: sessionsDirectory,
      reason: `sessions directory failed the security check: ${describeError(error)}`,
    });
    return { projectIdentifiers: [], referenceSetIncomplete: true };
  }

  const projectIdentifiers: string[] = [];
  let referenceSetIncomplete = false;

  for (const entry of sessionsDirectoryEntries) {
    if (!projectIdentitySchema.safeParse(entry.name).success) {
      continue;
    }
    const projectDirectory = join(sessionsDirectory, entry.name);
    try {
      await ensurePrivateBridgeDirectory(bridgeStateContext, projectDirectory, false);
    } catch (error) {
      skipped.push({
        path: projectDirectory,
        reason: `project directory failed the security check: ${describeError(error)}`,
      });
      referenceSetIncomplete = true;
      continue;
    }
    projectIdentifiers.push(entry.name);
  }

  return { projectIdentifiers, referenceSetIncomplete };
}

async function cleanupOrphanedSockets(
  bridgeStateContext: SecureBridgeStateContext,
  referencedSocketPaths: ReadonlySet<string>,
  skipped: SkippedBridgeStatePath[],
): Promise<number> {
  const socketsDirectory = join(bridgeStateContext.bridgeStateDirectory, "sockets");
  let socketDirectoryEntries;
  try {
    await ensurePrivateBridgeDirectory(bridgeStateContext, socketsDirectory, true);
    socketDirectoryEntries = await readdir(socketsDirectory, {
      withFileTypes: true,
    });
  } catch (error) {
    skipped.push({
      path: socketsDirectory,
      reason: `sockets directory failed the security check: ${describeError(error)}`,
    });
    return 0;
  }

  let removedSockets = 0;
  for (const entry of socketDirectoryEntries) {
    if (!channelSocketFilenamePattern.test(entry.name)) {
      continue;
    }

    const socketPath = join(socketsDirectory, entry.name);
    let socketStatusBeforeProbe;
    try {
      socketStatusBeforeProbe = await lstat(socketPath);
    } catch (error) {
      if (isEnoent(error)) {
        continue;
      }
      skipped.push({
        path: socketPath,
        reason: `socket failed the security check: ${describeError(error)}`,
      });
      continue;
    }

    if (
      socketStatusBeforeProbe.isSymbolicLink() ||
      !socketStatusBeforeProbe.isSocket() ||
      socketStatusBeforeProbe.uid !== bridgeStateContext.userIdentifier ||
      (socketStatusBeforeProbe.mode & 0o7777) !== 0o600
    ) {
      skipped.push({
        path: socketPath,
        reason: "does not match the expected type or mode of a private socket",
      });
      continue;
    }

    if (referencedSocketPaths.has(socketPath)) {
      continue;
    }

    if (await probeUnixSocket(socketPath)) {
      skipped.push({
        path: socketPath,
        reason: "socket still accepts connections",
      });
      continue;
    }

    let socketStatusBeforeRemoval;
    try {
      socketStatusBeforeRemoval = await lstat(socketPath);
    } catch (error) {
      if (isEnoent(error)) {
        continue;
      }
      skipped.push({
        path: socketPath,
        reason: `socket failed the security check: ${describeError(error)}`,
      });
      continue;
    }
    if (
      socketStatusBeforeRemoval.dev !== socketStatusBeforeProbe.dev ||
      socketStatusBeforeRemoval.ino !== socketStatusBeforeProbe.ino
    ) {
      skipped.push({
        path: socketPath,
        reason: "socket changed during cleanup",
      });
      continue;
    }

    await unlink(socketPath);
    removedSockets += 1;
  }

  return removedSockets;
}

export async function cleanupOrphanedBridgeState(
  stateHomeDirectory?: string,
): Promise<BridgeStateCleanupSummary> {
  const bridgeStateContext = await prepareSecureBridgeState(stateHomeDirectory);
  const skipped: SkippedBridgeStatePath[] = [];
  const referencedSocketPaths = new Set<string>();
  let removedSessionRecords = 0;

  const sessionsDirectory = join(bridgeStateContext.bridgeStateDirectory, "sessions");
  const { projectIdentifiers, referenceSetIncomplete: sessionsDirectoryIncomplete } =
    await listValidatedProjectIdentifiers(bridgeStateContext, sessionsDirectory, skipped);
  let referenceSetIncomplete = sessionsDirectoryIncomplete;

  for (const projectIdentifier of projectIdentifiers) {
    const projectDirectory = join(sessionsDirectory, projectIdentifier);

    let recordPathsBeforeCleanup: string[] = [];
    try {
      recordPathsBeforeCleanup = await listCandidateSessionRecordPaths(projectDirectory);
    } catch (error) {
      skipped.push({
        path: projectDirectory,
        reason: `session records could not be listed: ${describeError(error)}`,
      });
      referenceSetIncomplete = true;
    }

    try {
      const survivingSessions = await listActiveSessions(
        { projectId: projectIdentifier },
        stateHomeDirectory,
      );
      for (const survivingSession of survivingSessions) {
        if (
          survivingSession.runtime === "claude" &&
          survivingSession.socketPath !== undefined
        ) {
          referencedSocketPaths.add(
            resolveSecureBridgeOwnedPath(bridgeStateContext, survivingSession.socketPath),
          );
        }
      }
    } catch (error) {
      referenceSetIncomplete = true;
      skipped.push({
        path: projectDirectory,
        reason: `active sessions could not be evaluated: ${describeError(error)}`,
      });
    }

    for (const recordPath of recordPathsBeforeCleanup) {
      if (!(await pathStillExists(recordPath))) {
        removedSessionRecords += 1;
      }
    }
  }

  let removedSockets = 0;
  if (referenceSetIncomplete) {
    skipped.push({
      path: join(bridgeStateContext.bridgeStateDirectory, "sockets"),
      reason:
        "socket cleanup skipped: the set of active sessions could not be fully evaluated",
    });
  } else {
    removedSockets = await cleanupOrphanedSockets(
      bridgeStateContext,
      referencedSocketPaths,
      skipped,
    );
  }

  return { removedSockets, removedSessionRecords, skipped };
}
