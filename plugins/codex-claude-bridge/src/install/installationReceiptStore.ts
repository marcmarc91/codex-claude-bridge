import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  createPrivateRegularFile,
  openExistingPrivateRegularFile,
  openOrCreatePrivateRegularFile,
  prepareSecureBridgeState,
  removePrivateRegularFileIfPresent,
  renamePrivateRegularFile,
  type SecureBridgeStateContext,
} from "../registry/secureStateFilesystem.js";
import type { JsonSettingSnapshot } from "./jsonSettingsEditor.js";

export type InstallationStep =
  | "npmLink"
  | "codexMarketplace"
  | "codexPlugin"
  | "claudeMarketplace"
  | "claudePlugin"
  | "vscodeSetting";

export interface InstallationReceipt {
  schemaVersion: 1;
  phase: "installing" | "installed" | "uninstalling" | "rollback_failed";
  installationId: string;
  repositoryRoot: string;
  pluginRoot: string;
  marketplaceName: string;
  pluginIdentifier: string;
  wrapperPath: string;
  npm: {
    executablePath: string;
    prefix: string;
    packageLinkPath: string;
    binPaths: string[];
    owned: boolean;
  };
  vscode: {
    settingsPath: string;
    previous: JsonSettingSnapshot;
    installedValue: string;
    owned: boolean;
  };
  codex: {
    marketplaceOwned: boolean;
    pluginOwned: boolean;
  };
  claude: {
    marketplaceOwned: boolean;
    pluginOwned: boolean;
    scope: "user";
  };
  completedSteps: InstallationStep[];
  pendingStep?: InstallationStep;
  pendingRemovalStep?: InstallationStep;
  pendingCommandTerminationConfirmed?: true;
  commandTerminationUnconfirmed?: true;
  unconfirmedProcessGroupIdentifier?: number;
}

export interface InstallationLockOptions {
  stateHomeDirectory?: string;
  timeoutSeconds: number;
}

const marketplaceName = "codex-claude-bridge-local";
const pluginIdentifier = `codex-claude-bridge@${marketplaceName}`;
const maximumReceiptBytes = 256 * 1024;

const installationStepSchema = z.enum([
  "npmLink",
  "codexMarketplace",
  "codexPlugin",
  "claudeMarketplace",
  "claudePlugin",
  "vscodeSetting",
]);

const receiptSchema: z.ZodType<InstallationReceipt> = z
  .object({
    schemaVersion: z.literal(1),
    phase: z.enum(["installing", "installed", "uninstalling", "rollback_failed"]),
    installationId: z.string().uuid(),
    repositoryRoot: z.string().min(1),
    pluginRoot: z.string().min(1),
    marketplaceName: z.literal(marketplaceName),
    pluginIdentifier: z.literal(pluginIdentifier),
    wrapperPath: z.string().min(1),
    npm: z
      .object({
        executablePath: z.string().min(1),
        prefix: z.string().min(1),
        packageLinkPath: z.string().min(1),
        binPaths: z.array(z.string().min(1)).length(2),
        owned: z.boolean(),
      })
      .strict(),
    vscode: z
      .object({
        settingsPath: z.string().min(1),
        previous: z
          .object({
            fileExisted: z.boolean(),
            present: z.boolean(),
            value: z.string().optional(),
          })
          .strict(),
        installedValue: z.string().min(1),
        owned: z.boolean(),
      })
      .strict(),
    codex: z
      .object({ marketplaceOwned: z.boolean(), pluginOwned: z.boolean() })
      .strict(),
    claude: z
      .object({
        marketplaceOwned: z.boolean(),
        pluginOwned: z.boolean(),
        scope: z.literal("user"),
      })
      .strict(),
    completedSteps: z.array(installationStepSchema),
    pendingStep: installationStepSchema.optional(),
    pendingRemovalStep: installationStepSchema.optional(),
    pendingCommandTerminationConfirmed: z.literal(true).optional(),
    commandTerminationUnconfirmed: z.literal(true).optional(),
    unconfirmedProcessGroupIdentifier: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
    const stepOwnership: Record<InstallationStep, boolean> = {
      npmLink: receipt.npm.owned,
      codexMarketplace: receipt.codex.marketplaceOwned,
      codexPlugin: receipt.codex.pluginOwned,
      claudeMarketplace: receipt.claude.marketplaceOwned,
      claudePlugin: receipt.claude.pluginOwned,
      vscodeSetting: receipt.vscode.owned,
    };
    if (
      receipt.vscode.previous.present &&
      (!receipt.vscode.previous.fileExisted ||
        receipt.vscode.previous.value === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Prior VS Code setting snapshot is inconsistent",
      });
    }
    if (
      !receipt.vscode.previous.present &&
      receipt.vscode.previous.value !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Absent prior VS Code setting must not contain a value",
      });
    }
    if (
      receipt.commandTerminationUnconfirmed !== undefined &&
      receipt.phase !== "rollback_failed"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Unconfirmed process group requires rollback_failed phase",
      });
    }
    if (
      receipt.commandTerminationUnconfirmed === true &&
      receipt.pendingStep === undefined &&
      receipt.pendingRemovalStep === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Unconfirmed command termination requires a pending step",
      });
    }
    if (receipt.pendingRemovalStep === "vscodeSetting") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "VS Code setting removal does not use an external command",
      });
    }
    if (
      receipt.pendingRemovalStep !== undefined &&
      receipt.phase === "installed"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Installed receipt cannot contain a pending removal",
      });
    }
    if (
      receipt.pendingRemovalStep !== undefined &&
      !stepOwnership[receipt.pendingRemovalStep]
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Pending removal step must be owned",
      });
    }
    if (
      receipt.pendingRemovalStep !== undefined &&
      !receipt.completedSteps.includes(receipt.pendingRemovalStep) &&
      receipt.pendingStep !== receipt.pendingRemovalStep
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Pending removal step must be rollback-able",
      });
    }
    if (
      receipt.pendingRemovalStep !== undefined &&
      receipt.pendingStep !== undefined &&
      receipt.pendingRemovalStep !== receipt.pendingStep
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Pending installation and removal steps must match",
      });
    }
    if (
      receipt.commandTerminationUnconfirmed === true &&
      receipt.pendingCommandTerminationConfirmed === true
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Command termination cannot be confirmed and unconfirmed",
      });
    }
    if (
      receipt.unconfirmedProcessGroupIdentifier !== undefined &&
      receipt.commandTerminationUnconfirmed !== true
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Unconfirmed process group requires a termination marker",
      });
    }
    if (
      receipt.pendingCommandTerminationConfirmed === true &&
      receipt.pendingStep === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Confirmed pending command requires a pending step",
      });
    }
  });

function receiptPath(context: SecureBridgeStateContext): string {
  return join(context.bridgeStateDirectory, "install-receipt.json");
}

async function synchronizeStateDirectory(
  stateContext: SecureBridgeStateContext,
): Promise<void> {
  const directoryHandle = await open(
    stateContext.bridgeStateDirectory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function readBoundedFile(
  fileHandle: FileHandle,
  maximumBytes: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(maximumBytes + 1);
  let bytesReadTotal = 0;
  while (bytesReadTotal < buffer.byteLength) {
    const { bytesRead } = await fileHandle.read(
      buffer,
      bytesReadTotal,
      buffer.byteLength - bytesReadTotal,
      null,
    );
    if (bytesRead === 0) {
      break;
    }
    bytesReadTotal += bytesRead;
  }
  if (bytesReadTotal > maximumBytes) {
    throw new RangeError("Private state file is too large");
  }
  return buffer.subarray(0, bytesReadTotal);
}

export async function removeReceipt(
  stateContext: SecureBridgeStateContext,
): Promise<void> {
  if (
    await removePrivateRegularFileIfPresent(
      stateContext,
      receiptPath(stateContext),
    )
  ) {
    await synchronizeStateDirectory(stateContext);
  }
}

export async function readReceipt(
  stateContext: SecureBridgeStateContext,
): Promise<InstallationReceipt | undefined> {
  let receiptFile;
  try {
    receiptFile = await openExistingPrivateRegularFile(
      stateContext,
      receiptPath(stateContext),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    const status = await receiptFile.fileHandle.stat();
    if (status.size > maximumReceiptBytes) {
      throw new RangeError("Install receipt is too large");
    }
    return receiptSchema.parse(
      JSON.parse(
        (await readBoundedFile(receiptFile.fileHandle, maximumReceiptBytes)).toString("utf8"),
      ),
    );
  } finally {
    await receiptFile.fileHandle.close();
  }
}

export async function writeReceipt(
  stateContext: SecureBridgeStateContext,
  receipt: InstallationReceipt,
): Promise<void> {
  const validatedReceipt = receiptSchema.parse(receipt);
  const temporaryReceiptPath = join(
    stateContext.bridgeStateDirectory,
    `.install-receipt-${randomUUID()}.tmp`,
  );
  const temporaryReceipt = await createPrivateRegularFile(
    stateContext,
    temporaryReceiptPath,
  );
  let renamed = false;
  try {
    await temporaryReceipt.fileHandle.writeFile(
      `${JSON.stringify(validatedReceipt, null, 2)}\n`,
      "utf8",
    );
    await temporaryReceipt.fileHandle.sync();
    await temporaryReceipt.fileHandle.close();
    await renamePrivateRegularFile(
      stateContext,
      temporaryReceiptPath,
      receiptPath(stateContext),
    );
    await synchronizeStateDirectory(stateContext);
    renamed = true;
  } finally {
    await temporaryReceipt.fileHandle.close().catch(() => undefined);
    if (!renamed) {
      await removePrivateRegularFileIfPresent(
        stateContext,
        temporaryReceiptPath,
      ).catch(() => undefined);
    }
  }
}

async function acquireInstallationLock(
  lockFileDescriptor: number,
  timeoutSeconds: number,
): Promise<void> {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 30) {
    throw new RangeError("Installation lock timeout must be an integer from 0 to 30");
  }
  const exitCode = await new Promise<number | null>((resolveProcess, rejectProcess) => {
    const lockProcess = spawn(
      "/usr/bin/lockf",
      ["-s", "-t", String(timeoutSeconds), "3"],
      { shell: false, stdio: ["ignore", "ignore", "ignore", lockFileDescriptor] },
    );
    lockProcess.once("error", rejectProcess);
    lockProcess.once("close", resolveProcess);
  });
  if (exitCode === 75) {
    throw new Error("Timed out waiting for the global installation lock");
  }
  if (exitCode !== 0) {
    throw new Error(`Unable to acquire the global installation lock: ${String(exitCode)}`);
  }
}

export async function withInstallationLock<T>(
  options: InstallationLockOptions,
  operation: (stateContext: SecureBridgeStateContext) => Promise<T>,
): Promise<T> {
  const stateContext = await prepareSecureBridgeState(options.stateHomeDirectory);
  const lockFile = await openOrCreatePrivateRegularFile(
    stateContext,
    join(stateContext.bridgeStateDirectory, ".install.lock"),
  );
  try {
    await acquireInstallationLock(lockFile.fileHandle.fd, options.timeoutSeconds);
    return await operation(stateContext);
  } finally {
    await lockFile.fileHandle.close();
  }
}

export async function readReceiptReadonly(
  stateHomeDirectory: string,
): Promise<{ receipt: InstallationReceipt; mode: number; directoryMode: number }> {
  const bridgeDirectory = join(stateHomeDirectory, "codex-claude-bridge");
  const directoryStatus = await lstat(bridgeDirectory);
  if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
    throw new Error("Bridge state directory is unsafe");
  }
  const path = join(bridgeDirectory, "install-receipt.json");
  const receiptFile = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = await receiptFile.stat();
    if (!status.isFile() || status.size > maximumReceiptBytes) {
      throw new Error("Install receipt is unsafe");
    }
    return {
      receipt: receiptSchema.parse(
        JSON.parse(
          (await readBoundedFile(receiptFile, maximumReceiptBytes)).toString("utf8"),
        ),
      ),
      mode: status.mode & 0o777,
      directoryMode: directoryStatus.mode & 0o777,
    };
  } finally {
    await receiptFile.close();
  }
}
