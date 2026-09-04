import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, parse as parsePath, resolve, sep } from "node:path";

import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parseTree,
  type Node as JsonNode,
  type ParseError,
} from "jsonc-parser";

export interface JsonSettingSnapshot {
  fileExisted: boolean;
  present: boolean;
  value?: string;
}

export interface JsonStringSettingReplacement {
  present: boolean;
  value?: string;
}

interface JsonSettingsMutationHooks {
  beforeReplace?: () => Promise<void>;
  renameFile?: (sourcePath: string, destinationPath: string) => Promise<void>;
}

interface JsonStringSettingMutation extends JsonSettingsMutationHooks {
  settingsPath: string;
  settingName: string;
  value: string;
}

interface JsonStringSettingCompareAndSwap extends JsonSettingsMutationHooks {
  settingsPath: string;
  settingName: string;
  expectedValue: string;
  replacement: JsonStringSettingReplacement;
}

interface SettingsFileIdentity {
  deviceIdentifier: number;
  inodeIdentifier: number;
  byteSize: number;
  modifiedAtMilliseconds: number;
  changedAtMilliseconds: number;
}

interface ParsedSettings {
  text: string;
  snapshot: JsonSettingSnapshot;
  mode: number;
  identity?: SettingsFileIdentity;
}

const maximumSettingsBytes = 1024 * 1024;

function countRootProperties(root: JsonNode, settingName: string): number {
  if (root.type !== "object") {
    throw new TypeError("VS Code settings must contain a JSON object");
  }
  return (root.children ?? []).filter(
    (property) =>
      property.type === "property" &&
      property.children?.[0]?.value === settingName,
  ).length;
}

function parseSettingsText(
  settingsText: string,
  settingName: string,
  fileExisted: boolean,
  mode: number,
  identity?: SettingsFileIdentity,
): ParsedSettings {
  const parseErrors: ParseError[] = [];
  const root = parseTree(settingsText, parseErrors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (root === undefined || parseErrors.length > 0) {
    throw new TypeError("VS Code settings contain invalid JSONC");
  }
  const propertyCount = countRootProperties(root, settingName);
  if (propertyCount > 1) {
    throw new TypeError(`VS Code settings contain duplicate ${settingName} keys`);
  }
  const settingNode = findNodeAtLocation(root, [settingName]);
  if (settingNode !== undefined && typeof settingNode.value !== "string") {
    throw new TypeError(`${settingName} must be a string when present`);
  }
  return {
    text: settingsText,
    mode,
    ...(identity === undefined ? {} : { identity }),
    snapshot:
      settingNode === undefined
        ? { fileExisted, present: false }
        : { fileExisted, present: true, value: settingNode.value as string },
  };
}

async function assertNoSymbolicLinkParents(settingsPath: string): Promise<void> {
  if (!isAbsolute(settingsPath)) {
    throw new TypeError("VS Code settings path must be absolute");
  }
  const absoluteSettingsPath = resolve(settingsPath);
  const pathRoot = parsePath(absoluteSettingsPath).root;
  const parentSegments = dirname(absoluteSettingsPath)
    .slice(pathRoot.length)
    .split(sep)
    .filter(Boolean);
  let currentPath = pathRoot;
  for (const segment of parentSegments) {
    currentPath = resolve(currentPath, segment);
    try {
      const status = await lstat(currentPath);
      if (status.isSymbolicLink()) {
        throw new TypeError("VS Code settings parent must not be a symbolic link");
      }
      if (!status.isDirectory()) {
        throw new TypeError("VS Code settings parent must be a directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

function fileIdentity(status: Stats): SettingsFileIdentity {
  return {
    deviceIdentifier: status.dev,
    inodeIdentifier: status.ino,
    byteSize: status.size,
    modifiedAtMilliseconds: status.mtimeMs,
    changedAtMilliseconds: status.ctimeMs,
  };
}

function identitiesMatch(
  firstIdentity: SettingsFileIdentity,
  secondIdentity: SettingsFileIdentity,
): boolean {
  return (
    firstIdentity.deviceIdentifier === secondIdentity.deviceIdentifier &&
    firstIdentity.inodeIdentifier === secondIdentity.inodeIdentifier &&
    firstIdentity.byteSize === secondIdentity.byteSize &&
    firstIdentity.modifiedAtMilliseconds === secondIdentity.modifiedAtMilliseconds &&
    firstIdentity.changedAtMilliseconds === secondIdentity.changedAtMilliseconds
  );
}

async function readBoundedSettingsFile(fileHandle: FileHandle): Promise<Buffer> {
  const readBuffer = Buffer.alloc(maximumSettingsBytes + 1);
  let totalBytesRead = 0;
  while (totalBytesRead < readBuffer.byteLength) {
    const { bytesRead } = await fileHandle.read(
      readBuffer,
      totalBytesRead,
      readBuffer.byteLength - totalBytesRead,
      null,
    );
    if (bytesRead === 0) {
      break;
    }
    totalBytesRead += bytesRead;
  }
  if (totalBytesRead > maximumSettingsBytes) {
    throw new RangeError("VS Code settings file is too large");
  }
  return readBuffer.subarray(0, totalBytesRead);
}

async function openSettingsFile(settingsPath: string): Promise<FileHandle | undefined> {
  try {
    return await open(settingsPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT") {
      return undefined;
    }
    if (errorCode === "ELOOP") {
      throw new TypeError("VS Code settings path must not be a symbolic link");
    }
    throw error;
  }
}

async function readExistingSettings(
  fileHandle: FileHandle,
  settingName: string,
): Promise<ParsedSettings> {
  const statusBeforeRead = await fileHandle.stat();
  if (!statusBeforeRead.isFile()) {
    throw new TypeError("VS Code settings path must be a regular file");
  }
  if (statusBeforeRead.size > maximumSettingsBytes) {
    throw new RangeError("VS Code settings file is too large");
  }
  const settingsBuffer = await readBoundedSettingsFile(fileHandle);
  const statusAfterRead = await fileHandle.stat();
  if (
    settingsBuffer.byteLength > maximumSettingsBytes ||
    !identitiesMatch(fileIdentity(statusBeforeRead), fileIdentity(statusAfterRead))
  ) {
    throw new Error("VS Code settings changed concurrently while being read");
  }
  return parseSettingsText(
    settingsBuffer.toString("utf8"),
    settingName,
    true,
    statusAfterRead.mode & 0o777,
    fileIdentity(statusAfterRead),
  );
}

async function readSettings(
  settingsPath: string,
  settingName: string,
): Promise<ParsedSettings> {
  await assertNoSymbolicLinkParents(settingsPath);
  const settingsFile = await openSettingsFile(settingsPath);
  if (settingsFile === undefined) {
    return parseSettingsText("{}\n", settingName, false, 0o600);
  }
  try {
    return await readExistingSettings(settingsFile, settingName);
  } finally {
    await settingsFile.close();
  }
}

async function verifySettingsUnchanged(
  settingsPath: string,
  parsedSettings: ParsedSettings,
): Promise<void> {
  const currentSettingsFile = await openSettingsFile(settingsPath);
  if (parsedSettings.identity === undefined) {
    if (currentSettingsFile !== undefined) {
      await currentSettingsFile.close();
      throw new Error("VS Code settings changed concurrently before replacement");
    }
    return;
  }
  if (currentSettingsFile === undefined) {
    throw new Error("VS Code settings changed concurrently before replacement");
  }
  try {
    const currentStatus = await currentSettingsFile.stat();
    const currentContents = await readBoundedSettingsFile(currentSettingsFile);
    if (
      !currentStatus.isFile() ||
      currentContents.byteLength > maximumSettingsBytes ||
      !identitiesMatch(parsedSettings.identity, fileIdentity(currentStatus)) ||
      currentContents.toString("utf8") !== parsedSettings.text
    ) {
      throw new Error("VS Code settings changed concurrently before replacement");
    }
  } finally {
    await currentSettingsFile.close();
  }
}

async function writeSettingsAtomically(
  settingsPath: string,
  settingsText: string,
  parsedSettings: ParsedSettings,
  hooks: JsonSettingsMutationHooks,
): Promise<void> {
  const settingsDirectory = dirname(settingsPath);
  await mkdir(settingsDirectory, { recursive: true, mode: 0o700 });
  await assertNoSymbolicLinkParents(settingsPath);
  const temporaryPath = resolve(
    settingsDirectory,
    `.codex-claude-bridge-${randomUUID()}.tmp`,
  );
  const temporaryFile = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  let replacementCompleted = false;
  try {
    await temporaryFile.writeFile(settingsText, "utf8");
    await temporaryFile.sync();
    await temporaryFile.chmod(parsedSettings.mode);
    await temporaryFile.close();
    await hooks.beforeReplace?.();
    await verifySettingsUnchanged(settingsPath, parsedSettings);
    await (hooks.renameFile ?? rename)(temporaryPath, settingsPath);
    replacementCompleted = true;
  } finally {
    await temporaryFile.close().catch(() => undefined);
    if (!replacementCompleted) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

function applySettingValue(
  parsedSettings: ParsedSettings,
  settingName: string,
  value: string | undefined,
): string {
  const lineEnding = parsedSettings.text.includes("\r\n") ? "\r\n" : "\n";
  return applyEdits(
    parsedSettings.text,
    modify(parsedSettings.text, [settingName], value, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
        eol: lineEnding,
      },
    }),
  );
}

export async function readJsonSetting(
  settingsPath: string,
  settingName: string,
): Promise<JsonSettingSnapshot> {
  return (await readSettings(settingsPath, settingName)).snapshot;
}

export async function updateJsonStringSetting(
  mutation: JsonStringSettingMutation,
): Promise<JsonSettingSnapshot> {
  const parsedSettings = await readSettings(
    mutation.settingsPath,
    mutation.settingName,
  );
  if (
    parsedSettings.snapshot.present &&
    parsedSettings.snapshot.value === mutation.value
  ) {
    return parsedSettings.snapshot;
  }
  const updatedText = applySettingValue(
    parsedSettings,
    mutation.settingName,
    mutation.value,
  );
  await writeSettingsAtomically(
    mutation.settingsPath,
    updatedText,
    parsedSettings,
    mutation,
  );
  return parsedSettings.snapshot;
}

export async function compareAndSwapJsonStringSetting(
  operation: JsonStringSettingCompareAndSwap,
): Promise<"updated" | "unchanged" | "conflict"> {
  const parsedSettings = await readSettings(
    operation.settingsPath,
    operation.settingName,
  );
  if (
    !parsedSettings.snapshot.present ||
    parsedSettings.snapshot.value !== operation.expectedValue
  ) {
    return "conflict";
  }
  const replacementValue = operation.replacement.present
    ? operation.replacement.value
    : undefined;
  if (operation.replacement.present && replacementValue === undefined) {
    throw new TypeError("A present JSON setting replacement requires a value");
  }
  if (replacementValue === operation.expectedValue) {
    return "unchanged";
  }
  const updatedText = applySettingValue(
    parsedSettings,
    operation.settingName,
    replacementValue,
  );
  await writeSettingsAtomically(
    operation.settingsPath,
    updatedText,
    parsedSettings,
    operation,
  );
  return "updated";
}
