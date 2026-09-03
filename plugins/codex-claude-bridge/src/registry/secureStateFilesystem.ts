import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { resolveBridgeStateDirectory } from "../runtime/paths.js";

export interface SecureBridgeStateContext {
  configuredBridgeStateDirectory: string;
  canonicalStateTrustRootDirectory: string;
  bridgeStateDirectory: string;
  userIdentifier: number;
}

export interface OpenedPrivateRegularFile {
  fileHandle: FileHandle;
  deviceIdentifier: number;
  inodeIdentifier: number;
}

const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const permissionModeMask = 0o7777;

function currentUserIdentifier(): number {
  if (typeof process.getuid !== "function") {
    throw new Error("A numeric user identifier is required for bridge state");
  }

  return process.getuid();
}

function pathIsContained(parentDirectory: string, candidatePath: string): boolean {
  const relativePath = relative(resolve(parentDirectory), resolve(candidatePath));
  return (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function bridgeRelativePath(
  context: SecureBridgeStateContext,
  candidatePath: string,
): string {
  const absoluteCandidatePath = resolve(candidatePath);
  if (pathIsContained(context.configuredBridgeStateDirectory, absoluteCandidatePath)) {
    return relative(context.configuredBridgeStateDirectory, absoluteCandidatePath);
  }

  if (pathIsContained(context.bridgeStateDirectory, absoluteCandidatePath)) {
    return relative(context.bridgeStateDirectory, absoluteCandidatePath);
  }

  throw new RangeError("Bridge path must remain within the canonical state directory");
}

export function resolveSecureBridgeOwnedPath(
  context: SecureBridgeStateContext,
  candidatePath: string,
): string {
  const relativePath = bridgeRelativePath(context, candidatePath);
  const canonicalCandidatePath = resolve(context.bridgeStateDirectory, relativePath);
  if (!pathIsContained(context.canonicalStateTrustRootDirectory, canonicalCandidatePath)) {
    throw new RangeError("Bridge path must remain beneath the canonical state trust root");
  }

  return canonicalCandidatePath;
}

async function verifyPrivateDirectoryHandle(
  directoryHandle: FileHandle,
  directoryPath: string,
  userIdentifier: number,
): Promise<void> {
  let directoryStatus = await directoryHandle.stat();
  if (!directoryStatus.isDirectory()) {
    throw new TypeError(`Bridge-owned path is not a directory: ${directoryPath}`);
  }
  if (directoryStatus.uid !== userIdentifier) {
    throw new Error(`Bridge-owned directory has an unexpected owner: ${directoryPath}`);
  }
  if ((directoryStatus.mode & permissionModeMask) !== privateDirectoryMode) {
    await directoryHandle.chmod(privateDirectoryMode);
    directoryStatus = await directoryHandle.stat();
  }
  if ((directoryStatus.mode & permissionModeMask) !== privateDirectoryMode) {
    throw new Error(`Bridge-owned directory is not private: ${directoryPath}`);
  }
}

async function verifyPrivateDirectoryComponent(
  directoryPath: string,
  userIdentifier: number,
): Promise<void> {
  const directoryHandle = await open(
    directoryPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let verificationFailed = false;

  try {
    await verifyPrivateDirectoryHandle(directoryHandle, directoryPath, userIdentifier);
    const canonicalDirectoryPath = await realpath(directoryPath);
    if (canonicalDirectoryPath !== directoryPath) {
      throw new Error(`Bridge-owned directory is not canonical: ${directoryPath}`);
    }
  } catch (error) {
    verificationFailed = true;
    throw error;
  } finally {
    if (verificationFailed) {
      await directoryHandle.close().catch(() => undefined);
    } else {
      await directoryHandle.close();
    }
  }
}

export async function ensurePrivateBridgeDirectory(
  context: SecureBridgeStateContext,
  directoryPath: string,
  createMissingDirectories: boolean,
): Promise<string> {
  const canonicalDirectoryPath = resolveSecureBridgeOwnedPath(context, directoryPath);
  const relativeDirectoryPath = relative(
    context.canonicalStateTrustRootDirectory,
    canonicalDirectoryPath,
  );
  const directorySegments = relativeDirectoryPath.split(sep).filter(Boolean);
  let currentDirectoryPath = context.canonicalStateTrustRootDirectory;

  for (const directorySegment of directorySegments) {
    currentDirectoryPath = join(currentDirectoryPath, directorySegment);
    if (createMissingDirectories) {
      try {
        await mkdir(currentDirectoryPath, { mode: privateDirectoryMode });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
    }

    await verifyPrivateDirectoryComponent(currentDirectoryPath, context.userIdentifier);
  }

  return canonicalDirectoryPath;
}

export async function prepareSecureBridgeState(
  stateHomeDirectory?: string,
): Promise<SecureBridgeStateContext> {
  const configuredBridgeStateDirectory = resolve(
    resolveBridgeStateDirectory(stateHomeDirectory),
  );
  const configuredStateTrustRootDirectory = dirname(configuredBridgeStateDirectory);
  await mkdir(configuredStateTrustRootDirectory, {
    recursive: true,
    mode: privateDirectoryMode,
  });
  const canonicalStateTrustRootDirectory = await realpath(
    configuredStateTrustRootDirectory,
  );
  const bridgeStateDirectory = join(
    canonicalStateTrustRootDirectory,
    basename(configuredBridgeStateDirectory),
  );
  const context: SecureBridgeStateContext = {
    configuredBridgeStateDirectory,
    canonicalStateTrustRootDirectory,
    bridgeStateDirectory,
    userIdentifier: currentUserIdentifier(),
  };

  await ensurePrivateBridgeDirectory(context, bridgeStateDirectory, true);
  return context;
}

export async function verifyPrivateRegularFileDescriptor(
  fileHandle: FileHandle,
  filePath: string,
  userIdentifier: number,
): Promise<OpenedPrivateRegularFile> {
  const fileStatus = await fileHandle.stat();
  if (!fileStatus.isFile()) {
    throw new TypeError(`Bridge-owned path is not a regular file: ${filePath}`);
  }
  if (fileStatus.uid !== userIdentifier) {
    throw new Error(`Bridge-owned file has an unexpected owner: ${filePath}`);
  }
  if ((fileStatus.mode & permissionModeMask) !== privateFileMode) {
    throw new Error(`Bridge-owned file is not private: ${filePath}`);
  }

  return {
    fileHandle,
    deviceIdentifier: fileStatus.dev,
    inodeIdentifier: fileStatus.ino,
  };
}

async function closeAfterFailure(fileHandle: FileHandle, error: unknown): Promise<never> {
  await fileHandle.close().catch(() => undefined);
  throw error;
}

export async function openExistingPrivateRegularFile(
  context: SecureBridgeStateContext,
  filePath: string,
  accessFlags = constants.O_RDONLY,
): Promise<OpenedPrivateRegularFile> {
  const canonicalFilePath = resolveSecureBridgeOwnedPath(context, filePath);
  await ensurePrivateBridgeDirectory(context, dirname(canonicalFilePath), false);
  const fileHandle = await open(canonicalFilePath, accessFlags | constants.O_NOFOLLOW);

  try {
    return await verifyPrivateRegularFileDescriptor(
      fileHandle,
      canonicalFilePath,
      context.userIdentifier,
    );
  } catch (error) {
    return closeAfterFailure(fileHandle, error);
  }
}

export async function createPrivateRegularFile(
  context: SecureBridgeStateContext,
  filePath: string,
  accessFlags = constants.O_WRONLY,
): Promise<OpenedPrivateRegularFile> {
  const canonicalFilePath = resolveSecureBridgeOwnedPath(context, filePath);
  await ensurePrivateBridgeDirectory(context, dirname(canonicalFilePath), false);
  const fileHandle = await open(
    canonicalFilePath,
    accessFlags |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    privateFileMode,
  );

  try {
    await fileHandle.chmod(privateFileMode);
    return await verifyPrivateRegularFileDescriptor(
      fileHandle,
      canonicalFilePath,
      context.userIdentifier,
    );
  } catch (error) {
    await fileHandle.close().catch(() => undefined);
    await unlink(canonicalFilePath).catch(() => undefined);
    throw error;
  }
}

export async function openOrCreatePrivateRegularFile(
  context: SecureBridgeStateContext,
  filePath: string,
): Promise<OpenedPrivateRegularFile> {
  try {
    return await createPrivateRegularFile(context, filePath, constants.O_RDWR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

  return openExistingPrivateRegularFile(context, filePath, constants.O_RDWR);
}

export async function validatePrivateRegularFileIfPresent(
  context: SecureBridgeStateContext,
  filePath: string,
): Promise<boolean> {
  let openedFile: OpenedPrivateRegularFile;
  try {
    openedFile = await openExistingPrivateRegularFile(context, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }

  await openedFile.fileHandle.close();
  return true;
}

export async function renamePrivateRegularFile(
  context: SecureBridgeStateContext,
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  const canonicalSourcePath = resolveSecureBridgeOwnedPath(context, sourcePath);
  const canonicalDestinationPath = resolveSecureBridgeOwnedPath(context, destinationPath);
  await ensurePrivateBridgeDirectory(context, dirname(canonicalSourcePath), false);
  await ensurePrivateBridgeDirectory(context, dirname(canonicalDestinationPath), false);
  if (!(await validatePrivateRegularFileIfPresent(context, canonicalSourcePath))) {
    throw new Error("Private source file is missing before rename");
  }
  await validatePrivateRegularFileIfPresent(context, canonicalDestinationPath);
  await rename(canonicalSourcePath, canonicalDestinationPath);
}

export async function removePrivateRegularFileIfPresent(
  context: SecureBridgeStateContext,
  filePath: string,
): Promise<boolean> {
  const canonicalFilePath = resolveSecureBridgeOwnedPath(context, filePath);
  let openedFile: OpenedPrivateRegularFile;
  try {
    openedFile = await openExistingPrivateRegularFile(context, canonicalFilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }

  await openedFile.fileHandle.close();
  await ensurePrivateBridgeDirectory(context, dirname(canonicalFilePath), false);
  const fileBeforeRemoval = await openExistingPrivateRegularFile(context, canonicalFilePath);
  try {
    if (
      fileBeforeRemoval.deviceIdentifier !== openedFile.deviceIdentifier ||
      fileBeforeRemoval.inodeIdentifier !== openedFile.inodeIdentifier
    ) {
      throw new Error("Bridge-owned file changed before removal");
    }
  } finally {
    await fileBeforeRemoval.fileHandle.close();
  }
  await unlink(canonicalFilePath);
  return true;
}
