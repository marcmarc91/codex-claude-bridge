import { spawn } from "node:child_process";
import { join } from "node:path";

import { uuidSchema } from "../protocol/messageEnvelope.js";
import { projectIdentitySchema } from "../runtime/paths.js";
import {
  ensurePrivateBridgeDirectory,
  openOrCreatePrivateRegularFile,
  prepareSecureBridgeState,
  type SecureBridgeStateContext,
} from "./secureStateFilesystem.js";

export interface SessionMutationContext {
  bridgeStateContext: SecureBridgeStateContext;
  sessionRegistryDirectory: string;
}

const lockAcquisitionTimeoutSeconds = 4;

async function acquireKernelLock(fileDescriptor: number): Promise<void> {
  const lockExitCode = await new Promise<number | null>((resolveProcess, rejectProcess) => {
    const lockProcess = spawn(
      "/usr/bin/lockf",
      ["-s", "-t", String(lockAcquisitionTimeoutSeconds), "3"],
      {
        shell: false,
        stdio: ["ignore", "ignore", "ignore", fileDescriptor],
      },
    );

    lockProcess.once("error", rejectProcess);
    lockProcess.once("close", resolveProcess);
  });

  if (lockExitCode !== 0) {
    throw new Error("Timed out waiting for a session mutation lock");
  }
}

export async function withSessionMutationLock<T>(
  stateHomeDirectory: string | undefined,
  projectIdentifier: string,
  sessionIdentifier: string,
  operation: (context: SessionMutationContext) => Promise<T>,
): Promise<T> {
  const validatedProjectIdentifier = projectIdentitySchema.parse(projectIdentifier);
  const validatedSessionIdentifier = uuidSchema.parse(sessionIdentifier);
  const bridgeStateContext = await prepareSecureBridgeState(stateHomeDirectory);
  const sessionsDirectory = join(bridgeStateContext.bridgeStateDirectory, "sessions");
  const sessionRegistryDirectory = join(sessionsDirectory, validatedProjectIdentifier);
  const lockDirectory = join(sessionRegistryDirectory, ".locks");
  await ensurePrivateBridgeDirectory(bridgeStateContext, sessionsDirectory, true);
  await ensurePrivateBridgeDirectory(bridgeStateContext, sessionRegistryDirectory, true);
  await ensurePrivateBridgeDirectory(bridgeStateContext, lockDirectory, true);

  const lockFilePath = join(lockDirectory, `${validatedSessionIdentifier}.lock`);
  const openedLockFile = await openOrCreatePrivateRegularFile(
    bridgeStateContext,
    lockFilePath,
  );
  let operationFailed = false;

  try {
    await acquireKernelLock(openedLockFile.fileHandle.fd);
    return await operation({ bridgeStateContext, sessionRegistryDirectory });
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    if (operationFailed) {
      await openedLockFile.fileHandle.close().catch(() => undefined);
    } else {
      await openedLockFile.fileHandle.close();
    }
  }
}
