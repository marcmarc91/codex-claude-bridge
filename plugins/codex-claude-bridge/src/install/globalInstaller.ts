import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ActiveSessionRecord } from "../registry/activeSessionRegistry.js";
import type { SecureBridgeStateContext } from "../registry/secureStateFilesystem.js";
import { resolveStateHomeDirectory } from "../runtime/paths.js";
import {
  CommandTerminationUnconfirmedError,
  executeBoundedCommand,
  sanitizeCommandError,
  type CommandExecutionRequest,
  type CommandExecutionResult,
} from "./commandExecution.js";
import {
  parseVersionTuple,
  resolveClaudeExecutable,
  resolvePathExecutable,
  versionAtLeast,
  type InstallerExecutables,
} from "./executableResolver.js";
import {
  compareAndSwapJsonStringSetting,
  readJsonSetting,
  updateJsonStringSetting,
  type JsonSettingSnapshot,
} from "./jsonSettingsEditor.js";
import {
  readReceipt,
  readReceiptReadonly,
  removeReceipt,
  withInstallationLock,
  writeReceipt,
  type InstallationReceipt,
  type InstallationStep,
  type VscodeSettingsTarget,
} from "./installationReceiptStore.js";
import {
  assertMarketplaceSources,
  assertNoNpmCollision,
  pathExists,
  pathResolvesTo,
  readClaudeMarketplaceSource,
  readClaudePluginInstalled,
  readCodexMarketplaceSource,
  readCodexPluginInstalled,
  readInstalledIntegrationState,
  type InstalledIntegrationState,
} from "./integrationStateDiscovery.js";
import { inspectActiveSessionsReadOnly } from "./readOnlySessionInspector.js";
import { discoverVscodeUserSettingsPaths } from "./vscodeSettingsDiscovery.js";

export {
  executeBoundedCommand,
  type CommandExecutionRequest,
  type CommandExecutionResult,
} from "./commandExecution.js";

export {
  resolveClaudeExecutable,
  type InstallerExecutables,
} from "./executableResolver.js";

export interface GlobalInstallerOptions {
  repositoryRoot?: string;
  homeDirectory?: string;
  stateHomeDirectory?: string;
  environmentPath?: string;
  vscodeSettingsPath?: string;
  configureVscode?: boolean;
  executables?: InstallerExecutables;
  executeCommand?: (
    request: CommandExecutionRequest,
  ) => Promise<CommandExecutionResult>;
  writeOutput?: (value: string) => void;
  listActiveSessions?: () => Promise<ActiveSessionRecord[]>;
  listRunningClaudeProcessIdentifiers?: () => Promise<number[]>;
  processGroupIsActive?: (processGroupIdentifier: number) => Promise<boolean>;
  confirmPendingCommandStopped?: boolean;
  installationLockTimeoutSeconds?: number;
  persistInstallationReceipt?: typeof writeReceipt;
}

export interface DoctorCheck {
  name: string;
  status: "passed" | "failed" | "info";
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

interface ResolvedInstallerContext {
  repositoryRoot: string;
  pluginRoot: string;
  homeDirectory: string;
  stateHomeDirectory: string | undefined;
  environmentPath: string;
  vscodeSettingsPaths: string[];
  explicitVscodeSettingsPath: string | undefined;
  executables: InstallerExecutables;
  executeCommand: (
    request: CommandExecutionRequest,
  ) => Promise<CommandExecutionResult>;
  writeOutput: (value: string) => void;
  listActiveSessions: () => Promise<ActiveSessionRecord[]>;
  processGroupIsActive: (processGroupIdentifier: number) => Promise<boolean>;
  confirmPendingCommandStopped: boolean;
  installationLockTimeoutSeconds: number;
  persistInstallationReceipt: typeof writeReceipt;
}

const marketplaceName = "codex-claude-bridge-local";
const pluginName = "codex-claude-bridge";
const pluginIdentifier = `${pluginName}@${marketplaceName}`;
const wrapperSettingName = "claudeCode.claudeProcessWrapper";
const commandTimeoutMilliseconds = 15_000;
const maximumCommandOutputBytes = 65_536;
const maximumProcessListingBytes = 4 * 1024 * 1024;
const defaultInstallationLockTimeoutSeconds = 4;
const modulePluginRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const canonicalInstallationOrder: InstallationStep[] = [
  "npmLink",
  "codexMarketplace",
  "codexPlugin",
  "claudeMarketplace",
  "claudePlugin",
  "vscodeSetting",
];

function installReceiptPath(stateHomeDirectory: string | undefined): string {
  return join(
    resolveStateHomeDirectory(stateHomeDirectory),
    "codex-claude-bridge",
    "install-receipt.json",
  );
}

async function processGroupIsActive(
  processGroupIdentifier: number,
): Promise<boolean> {
  try {
    process.kill(-processGroupIdentifier, 0);
    return true;
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ESRCH") {
      return false;
    }
    if (errorCode === "EPERM") {
      return true;
    }
    throw error;
  }
}

async function runCommand(
  context: ResolvedInstallerContext,
  executablePath: string,
  argumentsList: string[],
  cwd?: string,
): Promise<CommandExecutionResult> {
  return context.executeCommand({
    executablePath,
    arguments: [...argumentsList],
    ...(cwd === undefined ? {} : { cwd }),
    timeoutMilliseconds: commandTimeoutMilliseconds,
    maximumOutputBytes: maximumCommandOutputBytes,
  });
}

async function runRequiredCommand(
  context: ResolvedInstallerContext,
  executablePath: string,
  argumentsList: string[],
  cwd?: string,
): Promise<CommandExecutionResult> {
  const result = await runCommand(context, executablePath, argumentsList, cwd);
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${result.exitCode}): ${executablePath} ${argumentsList.join(" ")}: ${sanitizeCommandError(result.stderr) || "no error output"}`,
    );
  }
  return result;
}

async function resolveInstallerContext(
  options: GlobalInstallerOptions,
): Promise<ResolvedInstallerContext> {
  const repositoryRoot = await realpath(
    options.repositoryRoot ?? dirname(dirname(modulePluginRoot)),
  );
  const pluginRoot = await realpath(join(repositoryRoot, "plugins", pluginName));
  const homeDirectory = options.homeDirectory ?? homedir();
  const environmentPath = options.environmentPath ?? process.env.PATH ?? "";
  const executables =
    options.executables ?? {
      node: process.execPath,
      npm:
        (await resolvePathExecutable("npm", environmentPath)) ??
        (() => {
          throw new Error("Unable to resolve npm");
        })(),
      codex:
        (await resolvePathExecutable("codex", environmentPath)) ??
        (() => {
          throw new Error("Unable to resolve Codex");
        })(),
      claude: await resolveClaudeExecutable({ homeDirectory, environmentPath }),
    };
  const vscodeSettingsPaths =
    options.configureVscode === false
      ? []
      : options.vscodeSettingsPath !== undefined
        ? [options.vscodeSettingsPath]
        : await discoverVscodeUserSettingsPaths(homeDirectory, process.platform);
  return {
    repositoryRoot,
    pluginRoot,
    homeDirectory,
    stateHomeDirectory: options.stateHomeDirectory,
    environmentPath,
    vscodeSettingsPaths,
    explicitVscodeSettingsPath: options.vscodeSettingsPath,
    executables,
    executeCommand: options.executeCommand ?? executeBoundedCommand,
    writeOutput: options.writeOutput ?? ((value) => process.stdout.write(value)),
    listActiveSessions:
      options.listActiveSessions ??
      (() => inspectActiveSessionsReadOnly(options.stateHomeDirectory)),
    processGroupIsActive: options.processGroupIsActive ?? processGroupIsActive,
    confirmPendingCommandStopped: options.confirmPendingCommandStopped ?? false,
    installationLockTimeoutSeconds:
      options.installationLockTimeoutSeconds ?? defaultInstallationLockTimeoutSeconds,
    persistInstallationReceipt:
      options.persistInstallationReceipt ?? writeReceipt,
  };
}

function printStatePreparationPlan(context: ResolvedInstallerContext): void {
  const stateHomeDirectory = resolveStateHomeDirectory(context.stateHomeDirectory);
  const bridgeStateDirectory = join(
    stateHomeDirectory,
    "codex-claude-bridge",
  );
  context.writeOutput(
    [
      `state directory: ${bridgeStateDirectory} (create or validate mode 0700)`,
      `installation lock: ${join(bridgeStateDirectory, ".install.lock")} (create or validate mode 0600)`,
      "",
    ].join("\n"),
  );
}

async function readVscodeSetting(
  settingsPath: string,
): Promise<JsonSettingSnapshot> {
  try {
    return await readJsonSetting(settingsPath, wrapperSettingName);
  } catch (error) {
    throw new Error(
      `VS Code settings at ${settingsPath} are unreadable: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

function vscodeSettingsTarget(
  settingsPath: string,
  previous: JsonSettingSnapshot,
  wrapperPath: string,
): VscodeSettingsTarget {
  return {
    settingsPath,
    previous,
    installedValue: wrapperPath,
    owned: !previous.present || previous.value !== wrapperPath,
  };
}

async function createVscodeSettingsTargets(
  context: ResolvedInstallerContext,
  settingsPaths: string[],
  wrapperPath: string,
): Promise<VscodeSettingsTarget[]> {
  const targets: VscodeSettingsTarget[] = [];
  for (const settingsPath of settingsPaths) {
    const settingsFileExists = await pathExists(settingsPath);
    if (!settingsFileExists && context.explicitVscodeSettingsPath !== undefined) {
      throw new Error(`VS Code settings file does not exist: ${settingsPath}`);
    }
    if (!settingsFileExists) {
      continue;
    }
    try {
      targets.push(
        vscodeSettingsTarget(
          settingsPath,
          await readVscodeSetting(settingsPath),
          wrapperPath,
        ),
      );
    } catch (error) {
      if (context.explicitVscodeSettingsPath !== undefined) {
        throw error;
      }
      context.writeOutput(
        `${error instanceof Error ? error.message : "VS Code settings are unreadable"}; skipping this editor.\n`,
      );
    }
  }
  return targets;
}

function managedVscodeSettingsTargets(
  context: ResolvedInstallerContext,
  receipt: InstallationReceipt,
): VscodeSettingsTarget[] {
  return receipt.vscodeTargets.filter(
    (target) =>
      target.owned &&
      context.vscodeSettingsPaths.includes(target.settingsPath),
  );
}

function classifyVscodeSettingsTarget(
  target: VscodeSettingsTarget,
  currentSetting: JsonSettingSnapshot,
  wrapperPath: string,
): "installed" | "repairable" | "userChanged" {
  if (currentSetting.present && currentSetting.value === wrapperPath) {
    return "installed";
  }
  if (
    currentSetting.present === target.previous.present &&
    currentSetting.value === target.previous.value
  ) {
    return "repairable";
  }
  return "userChanged";
}

async function createReceipt(
  context: ResolvedInstallerContext,
  installedState: InstalledIntegrationState,
): Promise<InstallationReceipt> {
  const wrapperPath = join(
    installedState.npmPrefix,
    "bin",
    "claude-code-bridge-wrapper",
  );
  return {
    schemaVersion: 1,
    phase: "installing",
    installationId: randomUUID(),
    repositoryRoot: context.repositoryRoot,
    pluginRoot: context.pluginRoot,
    marketplaceName,
    pluginIdentifier,
    wrapperPath,
    npm: {
      executablePath: context.executables.npm,
      prefix: installedState.npmPrefix,
      packageLinkPath: join(
        installedState.npmPrefix,
        "lib",
        "node_modules",
        pluginName,
      ),
      binPaths: [
        join(installedState.npmPrefix, "bin", "codex-claude-bridge"),
        wrapperPath,
      ],
      owned: !installedState.npmPackageMatches,
    },
    vscodeTargets: await createVscodeSettingsTargets(
      context,
      context.vscodeSettingsPaths,
      wrapperPath,
    ),
    codex: {
      marketplaceOwned: installedState.codexMarketplaceSource === undefined,
      pluginOwned: !installedState.codexPluginInstalled,
    },
    claude: {
      marketplaceOwned: installedState.claudeMarketplaceSource === undefined,
      pluginOwned: !installedState.claudePluginInstalled,
      scope: "user",
    },
    completedSteps: [],
  };
}

function bridgeBuildArguments(receipt: InstallationReceipt): string[] {
  return [
    join(receipt.pluginRoot, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    join(receipt.pluginRoot, "tsconfig.json"),
  ];
}

async function buildBridgePackage(
  context: ResolvedInstallerContext,
  receipt: InstallationReceipt,
): Promise<void> {
  await runRequiredCommand(
    context,
    context.executables.node,
    bridgeBuildArguments(receipt),
    receipt.pluginRoot,
  );
}

function installationStepPlanLine(
  context: ResolvedInstallerContext,
  receipt: InstallationReceipt,
  step: InstallationStep,
): string {
  switch (step) {
    case "npmLink":
      return `npm link: ${context.executables.npm} link --ignore-scripts (cwd ${receipt.pluginRoot})`;
    case "codexMarketplace":
      return `Codex marketplace: ${context.executables.codex} plugin marketplace add ${receipt.repositoryRoot} --json`;
    case "codexPlugin":
      return `Codex plugin: ${context.executables.codex} plugin add ${pluginIdentifier} --json`;
    case "claudeMarketplace":
      return `Claude marketplace: ${context.executables.claude} plugin marketplace add ${receipt.repositoryRoot} --scope user`;
    case "claudePlugin":
      return `Claude plugin: ${context.executables.claude} plugin install ${pluginIdentifier} --scope user --yes`;
    case "vscodeSetting":
      return `VS Code setting: ${managedVscodeSettingsTargets(context, receipt)
        .map((target) => target.settingsPath)
        .join(", ")} -> ${receipt.wrapperPath}`;
  }
}

function printMutationPlan(
  context: ResolvedInstallerContext,
  receipt: InstallationReceipt,
  steps: InstallationStep[],
): void {
  const lines = [
    `build: ${context.executables.node} ${bridgeBuildArguments(receipt).join(" ")}`,
    ...steps.map((step) => installationStepPlanLine(context, receipt, step)),
    `receipt: ${installReceiptPath(context.stateHomeDirectory)}`,
  ];
  context.writeOutput(`${lines.join("\n")}\n`);
}

async function beginStep(
  stateContext: SecureBridgeStateContext,
  receipt: InstallationReceipt,
  step: InstallationStep,
): Promise<void> {
  receipt.pendingStep = step;
  await writeReceipt(stateContext, receipt);
}

async function completeStep(
  stateContext: SecureBridgeStateContext,
  receipt: InstallationReceipt,
  step: InstallationStep,
): Promise<void> {
  if (!receipt.completedSteps.includes(step)) {
    receipt.completedSteps.push(step);
  }
  delete receipt.pendingStep;
  delete receipt.pendingCommandTerminationConfirmed;
  await writeReceipt(stateContext, receipt);
}

async function performOwnedStep(
  stateContext: SecureBridgeStateContext,
  receipt: InstallationReceipt,
  step: InstallationStep,
  owned: boolean,
  operation: () => Promise<void>,
  verifyOperation: () => Promise<boolean>,
): Promise<void> {
  if (!owned) {
    return;
  }
  await beginStep(stateContext, receipt, step);
  await operation();
  if (!(await verifyOperation())) {
    throw new Error(`Installation postcondition failed for ${step}`);
  }
  await completeStep(stateContext, receipt, step);
}

function rollbackSteps(receipt: InstallationReceipt): InstallationStep[] {
  const presentSteps = new Set(receipt.completedSteps);
  if (receipt.pendingStep !== undefined) {
    presentSteps.add(receipt.pendingStep);
  }
  return canonicalInstallationOrder
    .filter((step) => presentSteps.has(step))
    .reverse();
}

function printRemovalPlan(
  context: ResolvedInstallerContext,
  receipt: InstallationReceipt,
): void {
  const lines = rollbackSteps(receipt).map((step) => {
    switch (step) {
      case "vscodeSetting":
        return `VS Code CAS restore: ${receipt.vscodeTargets
          .map((target) => target.settingsPath)
          .join(", ")}`;
      case "claudePlugin":
        return `Claude plugin: ${context.executables.claude} plugin uninstall ${pluginIdentifier} --scope user --yes`;
      case "claudeMarketplace":
        return `Claude marketplace: ${context.executables.claude} plugin marketplace remove ${marketplaceName} --scope user`;
      case "codexPlugin":
        return `Codex plugin: ${context.executables.codex} plugin remove ${pluginIdentifier} --json`;
      case "codexMarketplace":
        return `Codex marketplace: ${context.executables.codex} plugin marketplace remove ${marketplaceName} --json`;
      case "npmLink":
        return `npm unlink: ${receipt.npm.executablePath} unlink --global ${pluginName} --ignore-scripts`;
    }
  });
  lines.push(
    `receipt updates: ${installReceiptPath(context.stateHomeDirectory)}`,
  );
  context.writeOutput(`${lines.join("\n")}\n`);
}

async function removeRollbackStep(
  context: ResolvedInstallerContext,
  stateContext: SecureBridgeStateContext,
  receipt: InstallationReceipt,
  step: InstallationStep,
): Promise<void> {
  const updatedReceipt: InstallationReceipt = {
    ...receipt,
    completedSteps: receipt.completedSteps.filter(
      (completedStep) => completedStep !== step,
    ),
  };
  if (updatedReceipt.pendingStep === step) {
    delete updatedReceipt.pendingStep;
    delete updatedReceipt.pendingCommandTerminationConfirmed;
  }
  if (updatedReceipt.pendingRemovalStep === step) {
    delete updatedReceipt.pendingRemovalStep;
  }
  await context.persistInstallationReceipt(stateContext, updatedReceipt);
  Object.assign(receipt, updatedReceipt);
  for (const fieldName of [
    "pendingStep",
    "pendingRemovalStep",
    "pendingCommandTerminationConfirmed",
  ] as const) {
    if (!(fieldName in updatedReceipt)) {
      delete receipt[fieldName];
    }
  }
}

class PendingRemovalReceiptPersistenceError extends Error {
  readonly persistenceError: Error;

  constructor(persistenceError: Error) {
    super(persistenceError.message);
    this.name = "PendingRemovalReceiptPersistenceError";
    this.persistenceError = persistenceError;
  }
}

async function beginExternalRemovalStep(
  context: ResolvedInstallerContext,
  stateContext: SecureBridgeStateContext,
  receipt: InstallationReceipt,
  step: InstallationStep,
): Promise<void> {
  const updatedReceipt: InstallationReceipt = {
    ...receipt,
    pendingRemovalStep: step,
  };
  context.writeOutput(
    `receipt update: mark pending removal ${step} at ${join(stateContext.bridgeStateDirectory, "install-receipt.json")} before command invocation\n`,
  );
  try {
    await context.persistInstallationReceipt(stateContext, updatedReceipt);
  } catch (error) {
    throw new PendingRemovalReceiptPersistenceError(
      error instanceof Error
        ? error
        : new Error("Pending removal receipt update failed"),
    );
  }
  receipt.pendingRemovalStep = step;
}

async function clearExternalRemovalStep(
  context: ResolvedInstallerContext,
  stateContext: SecureBridgeStateContext,
  receipt: InstallationReceipt,
  step: InstallationStep,
): Promise<void> {
  if (receipt.pendingRemovalStep !== step) {
    throw new Error(`Pending removal marker does not match ${step}`);
  }
  context.writeOutput(
    `receipt update: clear closed removal ${step} at ${join(stateContext.bridgeStateDirectory, "install-receipt.json")}\n`,
  );
  const updatedReceipt: InstallationReceipt = {
    ...receipt,
    completedSteps: [...receipt.completedSteps],
  };
  if (updatedReceipt.pendingStep === step) {
    if (!updatedReceipt.completedSteps.includes(step)) {
      updatedReceipt.completedSteps.push(step);
    }
    delete updatedReceipt.pendingStep;
    delete updatedReceipt.pendingCommandTerminationConfirmed;
  }
  delete updatedReceipt.pendingRemovalStep;
  await context.persistInstallationReceipt(stateContext, updatedReceipt);
  receipt.completedSteps = updatedReceipt.completedSteps;
  if (!("pendingStep" in updatedReceipt)) {
    delete receipt.pendingStep;
  }
  if (!("pendingCommandTerminationConfirmed" in updatedReceipt)) {
    delete receipt.pendingCommandTerminationConfirmed;
  }
  delete receipt.pendingRemovalStep;
}

async function restoreVscodeSettingsTarget(
  context: ResolvedInstallerContext,
  target: VscodeSettingsTarget,
): Promise<void> {
  const result = await compareAndSwapJsonStringSetting({
    settingsPath: target.settingsPath,
    settingName: wrapperSettingName,
    expectedValue: target.installedValue,
    replacement: target.previous.present
      ? { present: true, value: target.previous.value }
      : { present: false },
  });
  if (result === "conflict") {
    context.writeOutput(
      `VS Code wrapper has user-owned changes at ${target.settingsPath}; leaving it unchanged.\n`,
    );
    return;
  }
  const currentSetting = await readVscodeSetting(target.settingsPath);
  if (
    currentSetting.present !== target.previous.present ||
    currentSetting.value !== target.previous.value
  ) {
    throw new Error("VS Code setting rollback postcondition failed");
  }
}

async function rollbackInstallation(
  context: ResolvedInstallerContext,
  stateContext: SecureBridgeStateContext,
  receipt: InstallationReceipt,
): Promise<Error[]> {
  const rollbackErrors: Error[] = [];
  let vscodeSettingCleanupFailed = false;
  let claudePluginCleanupFailed = false;
  let codexPluginCleanupFailed = false;
  for (const step of rollbackSteps(receipt)) {
    if (
      (step === "npmLink" && vscodeSettingCleanupFailed) ||
      (step === "claudeMarketplace" && claudePluginCleanupFailed) ||
      (step === "codexMarketplace" && codexPluginCleanupFailed)
    ) {
      continue;
    }
    try {
      switch (step) {
        case "vscodeSetting": {
          const restorationErrors: Error[] = [];
          for (const target of receipt.vscodeTargets) {
            try {
              await restoreVscodeSettingsTarget(context, target);
            } catch (restorationError) {
              restorationErrors.push(
                restorationError instanceof Error
                  ? restorationError
                  : new Error("VS Code setting rollback failed"),
              );
            }
          }
          if (restorationErrors.length > 0) {
            throw restorationErrors[0];
          }
          break;
        }
        case "claudePlugin":
          if (await readClaudePluginInstalled(context)) {
            await beginExternalRemovalStep(
              context,
              stateContext,
              receipt,
              step,
            );
            await runRequiredCommand(context, context.executables.claude, [
              "plugin",
              "uninstall",
              pluginIdentifier,
              "--scope",
              "user",
              "--yes",
            ]);
            if (await readClaudePluginInstalled(context)) {
              throw new Error("Claude plugin uninstall postcondition failed");
            }
          }
          break;
        case "claudeMarketplace": {
          const source = await readClaudeMarketplaceSource(context);
          if (source !== undefined && resolve(source) !== receipt.repositoryRoot) {
            throw new Error("Claude marketplace has user-owned changes");
          }
          if (source !== undefined) {
            await beginExternalRemovalStep(
              context,
              stateContext,
              receipt,
              step,
            );
            await runRequiredCommand(context, context.executables.claude, [
              "plugin",
              "marketplace",
              "remove",
              marketplaceName,
              "--scope",
              "user",
            ]);
            if ((await readClaudeMarketplaceSource(context)) !== undefined) {
              throw new Error("Claude marketplace removal postcondition failed");
            }
          }
          break;
        }
        case "codexPlugin":
          if (await readCodexPluginInstalled(context)) {
            await beginExternalRemovalStep(
              context,
              stateContext,
              receipt,
              step,
            );
            await runRequiredCommand(context, context.executables.codex, [
              "plugin",
              "remove",
              pluginIdentifier,
              "--json",
            ]);
            if (await readCodexPluginInstalled(context)) {
              throw new Error("Codex plugin removal postcondition failed");
            }
          }
          break;
        case "codexMarketplace": {
          const source = await readCodexMarketplaceSource(context);
          if (source !== undefined && resolve(source) !== receipt.repositoryRoot) {
            throw new Error("Codex marketplace has user-owned changes");
          }
          if (source !== undefined) {
            await beginExternalRemovalStep(
              context,
              stateContext,
              receipt,
              step,
            );
            await runRequiredCommand(context, context.executables.codex, [
              "plugin",
              "marketplace",
              "remove",
              marketplaceName,
              "--json",
            ]);
            if ((await readCodexMarketplaceSource(context)) !== undefined) {
              throw new Error("Codex marketplace removal postcondition failed");
            }
          }
          break;
        }
        case "npmLink": {
          const currentPrefix = (
            await runRequiredCommand(context, receipt.npm.executablePath, [
              "prefix",
              "--global",
            ])
          ).stdout.trim();
          if (currentPrefix !== receipt.npm.prefix) {
            throw new Error("npm global prefix has user-owned changes");
          }
          const packageExists = await pathExists(receipt.npm.packageLinkPath);
          const firstBinExists = await pathExists(receipt.npm.binPaths[0]);
          const secondBinExists = await pathExists(receipt.npm.binPaths[1]);
          if (packageExists || firstBinExists || secondBinExists) {
            const packageMatches = await pathResolvesTo(
              receipt.npm.packageLinkPath,
              receipt.pluginRoot,
            );
            const binPathsMatch =
              (await pathResolvesTo(
                receipt.npm.binPaths[0],
                join(receipt.pluginRoot, "dist", "bin", "codexClaudeBridge.js"),
              )) &&
              (await pathResolvesTo(
                receipt.npm.binPaths[1],
                join(receipt.pluginRoot, "dist", "bin", "claudeCodeBridgeWrapper.js"),
              ));
            if (
              !packageExists ||
              !firstBinExists ||
              !secondBinExists ||
              !packageMatches ||
              !binPathsMatch
            ) {
              throw new Error("npm global link has user-owned changes");
            }
            await beginExternalRemovalStep(
              context,
              stateContext,
              receipt,
              step,
            );
            await runRequiredCommand(context, receipt.npm.executablePath, [
              "unlink",
              "--global",
              pluginName,
              "--ignore-scripts",
            ]);
            if (
              (await pathExists(receipt.npm.packageLinkPath)) ||
              (await pathExists(receipt.npm.binPaths[0])) ||
              (await pathExists(receipt.npm.binPaths[1]))
            ) {
              throw new Error("npm unlink postcondition failed");
            }
          }
          break;
        }
      }
      await removeRollbackStep(context, stateContext, receipt, step);
    } catch (error) {
      if (error instanceof PendingRemovalReceiptPersistenceError) {
        rollbackErrors.push(error.persistenceError);
        break;
      }
      if (
        error instanceof CommandTerminationUnconfirmedError &&
        receipt.pendingRemovalStep === step
      ) {
        delete receipt.pendingCommandTerminationConfirmed;
        receipt.commandTerminationUnconfirmed = true;
        if (error.processGroupIdentifier !== undefined) {
          receipt.unconfirmedProcessGroupIdentifier =
            error.processGroupIdentifier;
        }
        rollbackErrors.push(error);
        break;
      }
      if (error instanceof CommandTerminationUnconfirmedError) {
        rollbackErrors.push(error);
        break;
      }
      if (
        step !== "vscodeSetting" &&
        receipt.pendingRemovalStep === step
      ) {
        try {
          await clearExternalRemovalStep(
            context,
            stateContext,
            receipt,
            step,
          );
        } catch (receiptError) {
          rollbackErrors.push(
            error instanceof Error ? error : new Error("Rollback step failed"),
            receiptError instanceof Error
              ? receiptError
              : new Error("Removal receipt update failed"),
          );
          break;
        }
      }
      if (step === "vscodeSetting") {
        vscodeSettingCleanupFailed = true;
      }
      if (step === "claudePlugin") {
        claudePluginCleanupFailed = true;
      }
      if (step === "codexPlugin") {
        codexPluginCleanupFailed = true;
      }
      rollbackErrors.push(
        error instanceof Error ? error : new Error("Rollback step failed"),
      );
    }
  }
  return rollbackErrors;
}

async function assertReceiptStillInstalled(
  context: ResolvedInstallerContext,
  receipt: InstallationReceipt,
): Promise<void> {
  const installedState = await readInstalledIntegrationState(context);
  if (
    installedState.npmPrefix !== receipt.npm.prefix ||
    !installedState.npmPackageListed ||
    !installedState.npmPackageMatches ||
    !installedState.npmBinPathsMatch ||
    resolve(installedState.codexMarketplaceSource ?? "") !== receipt.repositoryRoot ||
    !installedState.codexPluginInstalled ||
    resolve(installedState.claudeMarketplaceSource ?? "") !== receipt.repositoryRoot ||
    !installedState.claudePluginInstalled
  ) {
    throw new Error("Installed bridge state drifted from its receipt");
  }
  for (const target of receipt.vscodeTargets) {
    const setting = await readVscodeSetting(target.settingsPath);
    if (!setting.present || setting.value !== receipt.wrapperPath) {
      throw new Error("Installed bridge state drifted from its receipt");
    }
  }
  await assertGlobalBridgeCommandIsResolvable(context, receipt.npm.binPaths[0]);
}

async function assertGlobalBridgeCommandIsResolvable(
  context: ResolvedInstallerContext,
  expectedExecutablePath: string,
): Promise<void> {
  const resolvedExecutablePath = await resolvePathExecutable(
    pluginName,
    context.environmentPath,
  );
  if (
    resolvedExecutablePath === undefined ||
    !(await pathResolvesTo(resolvedExecutablePath, expectedExecutablePath))
  ) {
    throw new Error("Global bridge command is not resolvable from PATH");
  }
}

function assertVscodeTargetProvenance(
  context: ResolvedInstallerContext,
  receipt: InstallationReceipt,
): void {
  const settingsPaths = receipt.vscodeTargets.map(
    (target) => target.settingsPath,
  );
  if (
    receipt.vscodeTargets.some(
      (target) =>
        !isAbsolute(target.settingsPath) ||
        target.installedValue !== receipt.wrapperPath,
    ) ||
    new Set(settingsPaths).size !== settingsPaths.length ||
    (context.explicitVscodeSettingsPath !== undefined &&
      (settingsPaths.length !== 1 ||
        settingsPaths[0] !== context.explicitVscodeSettingsPath))
  ) {
    throw new Error("Install receipt provenance does not match this installation");
  }
}

async function validateReceiptProvenance(
  context: ResolvedInstallerContext,
  receipt: InstallationReceipt,
): Promise<void> {
  if (
    !isAbsolute(receipt.repositoryRoot) ||
    !isAbsolute(receipt.pluginRoot) ||
    receipt.repositoryRoot !== context.repositoryRoot ||
    receipt.pluginRoot !== context.pluginRoot ||
    receipt.pluginRoot !== join(receipt.repositoryRoot, "plugins", pluginName) ||
    receipt.npm.executablePath !== context.executables.npm ||
    !isAbsolute(receipt.npm.prefix) ||
    receipt.npm.packageLinkPath !==
      join(receipt.npm.prefix, "lib", "node_modules", pluginName) ||
    receipt.npm.binPaths[0] !==
      join(receipt.npm.prefix, "bin", "codex-claude-bridge") ||
    receipt.npm.binPaths[1] !==
      join(receipt.npm.prefix, "bin", "claude-code-bridge-wrapper") ||
    receipt.wrapperPath !== receipt.npm.binPaths[1]
  ) {
    throw new Error("Install receipt provenance does not match this installation");
  }
  assertVscodeTargetProvenance(context, receipt);
  const stepOwnership: Record<InstallationStep, boolean> = {
    npmLink: receipt.npm.owned,
    codexMarketplace: receipt.codex.marketplaceOwned,
    codexPlugin: receipt.codex.pluginOwned,
    claudeMarketplace: receipt.claude.marketplaceOwned,
    claudePlugin: receipt.claude.pluginOwned,
    vscodeSetting: receipt.vscodeTargets.some((target) => target.owned),
  };
  if (
    new Set(receipt.completedSteps).size !== receipt.completedSteps.length ||
    receipt.completedSteps.some((step) => !stepOwnership[step]) ||
    (receipt.pendingStep !== undefined && !stepOwnership[receipt.pendingStep]) ||
    (receipt.pendingRemovalStep !== undefined &&
      (!stepOwnership[receipt.pendingRemovalStep] ||
        (!receipt.completedSteps.includes(receipt.pendingRemovalStep) &&
          receipt.pendingStep !== receipt.pendingRemovalStep) ||
        (receipt.pendingStep !== undefined &&
          receipt.pendingStep !== receipt.pendingRemovalStep))) ||
    (receipt.phase === "installed" && receipt.pendingStep !== undefined)
  ) {
    throw new Error("Install receipt step ownership is inconsistent");
  }
  if (
    receipt.phase === "installed" &&
    Object.entries(stepOwnership).some(
      ([step, owned]) =>
        owned && !receipt.completedSteps.includes(step as InstallationStep),
    )
  ) {
    throw new Error("Installed receipt is missing an owned completed step");
  }
  if (
    (await realpath(receipt.repositoryRoot)) !== context.repositoryRoot ||
    (await realpath(receipt.pluginRoot)) !== context.pluginRoot
  ) {
    throw new Error("Install receipt source paths are not canonical");
  }
}

async function prepareReceiptForRecovery(
  context: ResolvedInstallerContext,
  stateContext: SecureBridgeStateContext,
  receipt: InstallationReceipt,
): Promise<void> {
  if (receipt.commandTerminationUnconfirmed !== true) {
    if (receipt.pendingRemovalStep !== undefined) {
      if (!context.confirmPendingCommandStopped) {
        throw new Error(
          `A pending removal ${receipt.pendingRemovalStep} has no termination proof; manual recovery is required with --confirm-pending-command-stopped after verifying the prior command is no longer running`,
        );
      }
      context.writeOutput(
        `receipt update: user-confirmed termination for pending removal ${receipt.pendingRemovalStep} at ${join(stateContext.bridgeStateDirectory, "install-receipt.json")}\n`,
      );
      delete receipt.pendingRemovalStep;
      await writeReceipt(stateContext, receipt);
    }
    if (
      receipt.pendingStep !== undefined &&
      receipt.pendingStep !== "vscodeSetting" &&
      receipt.pendingCommandTerminationConfirmed !== true
    ) {
      if (!context.confirmPendingCommandStopped) {
        throw new Error(
          `Pending ${receipt.pendingStep} has no termination proof; manual recovery is required with --confirm-pending-command-stopped after verifying the prior command is no longer running`,
        );
      }
      context.writeOutput(
        `receipt update: user-confirmed termination for pending ${receipt.pendingStep} at ${join(stateContext.bridgeStateDirectory, "install-receipt.json")}\n`,
      );
      receipt.pendingCommandTerminationConfirmed = true;
      await writeReceipt(stateContext, receipt);
    }
    return;
  }
  const processGroupIdentifier = receipt.unconfirmedProcessGroupIdentifier;
  if (processGroupIdentifier === undefined) {
    if (!context.confirmPendingCommandStopped) {
      throw new Error(
        "Previous command termination is unconfirmed and has no process group identifier; manual recovery is required with --confirm-pending-command-stopped after verifying the prior command is no longer running",
      );
    }
    context.writeOutput(
      `receipt update: user-confirmed pending command termination at ${join(stateContext.bridgeStateDirectory, "install-receipt.json")}\n`,
    );
    delete receipt.commandTerminationUnconfirmed;
    delete receipt.pendingRemovalStep;
    if (
      receipt.pendingStep !== undefined &&
      receipt.pendingStep !== "vscodeSetting"
    ) {
      receipt.pendingCommandTerminationConfirmed = true;
    }
    await writeReceipt(stateContext, receipt);
    return;
  }
  if (await context.processGroupIsActive(processGroupIdentifier)) {
    throw new Error(
      `Previous command process group ${processGroupIdentifier} is still active; recovery was not started`,
    );
  }
  context.writeOutput(
    `receipt update: clear inactive process group ${processGroupIdentifier} at ${join(stateContext.bridgeStateDirectory, "install-receipt.json")} before rollback\n`,
  );
  delete receipt.commandTerminationUnconfirmed;
  delete receipt.unconfirmedProcessGroupIdentifier;
  delete receipt.pendingRemovalStep;
  if (
    receipt.pendingStep !== undefined &&
    receipt.pendingStep !== "vscodeSetting"
  ) {
    receipt.pendingCommandTerminationConfirmed = true;
  }
  await writeReceipt(stateContext, receipt);
}

async function assertSupportedInstallerVersions(
  context: ResolvedInstallerContext,
): Promise<void> {
  for (const [label, executablePath, minimum] of [
    ["Node", context.executables.node, [22, 0, 0]],
    ["Codex", context.executables.codex, [0, 149, 0]],
    ["Claude", context.executables.claude, [2, 1, 224]],
  ] as const) {
    const result = await runRequiredCommand(context, executablePath, ["--version"]);
    const detected = parseVersionTuple(result.stdout);
    if (detected === undefined || !versionAtLeast(detected, [...minimum])) {
      throw new Error(`${label} must be at least ${minimum.join(".")}`);
    }
  }
}

function writeUserChangedVscodeSettingWarning(
  context: ResolvedInstallerContext,
  target: VscodeSettingsTarget,
): void {
  context.writeOutput(
    `VS Code wrapper at ${target.settingsPath} was changed after installation; leaving it unchanged.\n`,
  );
}

async function writeVscodeSettingsTarget(
  context: ResolvedInstallerContext,
  target: VscodeSettingsTarget,
  wrapperPath: string,
): Promise<void> {
  const currentSetting = await readVscodeSetting(target.settingsPath);
  const targetState = classifyVscodeSettingsTarget(
    target,
    currentSetting,
    wrapperPath,
  );
  if (targetState === "installed") {
    return;
  }
  if (targetState === "userChanged") {
    writeUserChangedVscodeSettingWarning(context, target);
    return;
  }
  const recordedValue = target.previous.value;
  if (target.previous.present && recordedValue !== undefined) {
    const result = await compareAndSwapJsonStringSetting({
      settingsPath: target.settingsPath,
      settingName: wrapperSettingName,
      expectedValue: recordedValue,
      replacement: { present: true, value: wrapperPath },
    });
    if (result === "conflict") {
      throw new Error(
        `VS Code setting at ${target.settingsPath} changed since it was recorded`,
      );
    }
    return;
  }
  if (currentSetting.present) {
    throw new Error(
      `VS Code setting at ${target.settingsPath} changed since it was recorded`,
    );
  }
  await updateJsonStringSetting({
    settingsPath: target.settingsPath,
    settingName: wrapperSettingName,
    value: wrapperPath,
  });
}

interface InstallationStepOperations {
  apply: () => Promise<void>;
  verify: () => Promise<boolean>;
}

function receiptStepOwnership(
  receipt: InstallationReceipt,
): Record<InstallationStep, boolean> {
  return {
    npmLink: receipt.npm.owned,
    codexMarketplace: receipt.codex.marketplaceOwned,
    codexPlugin: receipt.codex.pluginOwned,
    claudeMarketplace: receipt.claude.marketplaceOwned,
    claudePlugin: receipt.claude.pluginOwned,
    vscodeSetting: receipt.vscodeTargets.some((target) => target.owned),
  };
}

function installationStepOperations(
  context: ResolvedInstallerContext,
  receipt: InstallationReceipt,
): Record<InstallationStep, InstallationStepOperations> {
  return {
    npmLink: {
      apply: async () => {
        await runRequiredCommand(
          context,
          context.executables.npm,
          ["link", "--ignore-scripts"],
          receipt.pluginRoot,
        );
      },
      verify: async () =>
        (await pathResolvesTo(receipt.npm.packageLinkPath, receipt.pluginRoot)) &&
        (await pathResolvesTo(
          receipt.npm.binPaths[0],
          join(receipt.pluginRoot, "dist", "bin", "codexClaudeBridge.js"),
        )) &&
        (await pathResolvesTo(
          receipt.npm.binPaths[1],
          join(receipt.pluginRoot, "dist", "bin", "claudeCodeBridgeWrapper.js"),
        )),
    },
    codexMarketplace: {
      apply: async () => {
        await runRequiredCommand(context, context.executables.codex, [
          "plugin",
          "marketplace",
          "add",
          receipt.repositoryRoot,
          "--json",
        ]);
      },
      verify: async () =>
        resolve((await readCodexMarketplaceSource(context)) ?? "") ===
        receipt.repositoryRoot,
    },
    codexPlugin: {
      apply: async () => {
        await runRequiredCommand(context, context.executables.codex, [
          "plugin",
          "add",
          pluginIdentifier,
          "--json",
        ]);
      },
      verify: async () => readCodexPluginInstalled(context),
    },
    claudeMarketplace: {
      apply: async () => {
        await runRequiredCommand(context, context.executables.claude, [
          "plugin",
          "marketplace",
          "add",
          receipt.repositoryRoot,
          "--scope",
          "user",
        ]);
      },
      verify: async () =>
        resolve((await readClaudeMarketplaceSource(context)) ?? "") ===
        receipt.repositoryRoot,
    },
    claudePlugin: {
      apply: async () => {
        await runRequiredCommand(context, context.executables.claude, [
          "plugin",
          "install",
          pluginIdentifier,
          "--scope",
          "user",
          "--yes",
        ]);
      },
      verify: async () => readClaudePluginInstalled(context),
    },
    vscodeSetting: {
      apply: async () => {
        for (const target of managedVscodeSettingsTargets(context, receipt)) {
          await writeVscodeSettingsTarget(context, target, receipt.wrapperPath);
        }
      },
      verify: async () => {
        for (const target of managedVscodeSettingsTargets(context, receipt)) {
          const currentSetting = await readVscodeSetting(target.settingsPath);
          if (
            classifyVscodeSettingsTarget(
              target,
              currentSetting,
              receipt.wrapperPath,
            ) === "repairable"
          ) {
            return false;
          }
        }
        return true;
      },
    },
  };
}

async function applyInstallationSteps(
  context: ResolvedInstallerContext,
  stateContext: SecureBridgeStateContext,
  receipt: InstallationReceipt,
  steps: InstallationStep[],
): Promise<void> {
  const operations = installationStepOperations(context, receipt);
  const ownership = receiptStepOwnership(receipt);
  for (const step of canonicalInstallationOrder.filter((candidate) =>
    steps.includes(candidate),
  )) {
    await performOwnedStep(
      stateContext,
      receipt,
      step,
      ownership[step],
      operations[step].apply,
      operations[step].verify,
    );
    if (step === "npmLink") {
      await assertGlobalBridgeCommandIsResolvable(
        context,
        receipt.npm.binPaths[0],
      );
    }
  }
}

async function recordInstallationStepFailure(
  context: ResolvedInstallerContext,
  stateContext: SecureBridgeStateContext,
  receipt: InstallationReceipt,
  error: unknown,
  unconfirmedTerminationPhase: "rollback_failed" | "refreshing",
): Promise<void> {
  if (error instanceof CommandTerminationUnconfirmedError) {
    receipt.phase = unconfirmedTerminationPhase;
    delete receipt.pendingCommandTerminationConfirmed;
    receipt.commandTerminationUnconfirmed = true;
    if (error.processGroupIdentifier !== undefined) {
      receipt.unconfirmedProcessGroupIdentifier = error.processGroupIdentifier;
    }
    context.writeOutput(
      "receipt recovery: preserve the pending step until command termination is confirmed\n",
    );
    await writeReceipt(stateContext, receipt);
    return;
  }
  if (
    receipt.pendingStep !== undefined &&
    receipt.pendingStep !== "vscodeSetting"
  ) {
    receipt.pendingCommandTerminationConfirmed = true;
    context.writeOutput(
      `receipt recovery: record confirmed termination for pending ${receipt.pendingStep}\n`,
    );
    await writeReceipt(stateContext, receipt);
  }
}

async function performFreshInstallation(
  context: ResolvedInstallerContext,
  stateContext: SecureBridgeStateContext,
): Promise<void> {
  const installedState = await readInstalledIntegrationState(context);
  await assertNoNpmCollision(context, installedState);
  assertMarketplaceSources(context, installedState);
  await assertSupportedInstallerVersions(context);
  const receipt = await createReceipt(context, installedState);
  const ownership = receiptStepOwnership(receipt);
  printMutationPlan(
    context,
    receipt,
    canonicalInstallationOrder.filter((step) => ownership[step]),
  );
  await buildBridgePackage(context, receipt);
  await writeReceipt(stateContext, receipt);
  try {
    await applyInstallationSteps(
      context,
      stateContext,
      receipt,
      canonicalInstallationOrder,
    );
    receipt.phase = "installed";
    await writeReceipt(stateContext, receipt);
  } catch (error) {
    await recordInstallationStepFailure(
      context,
      stateContext,
      receipt,
      error,
      "rollback_failed",
    );
    if (error instanceof CommandTerminationUnconfirmedError) {
      throw error;
    }
    printRemovalPlan(context, receipt);
    const rollbackErrors = await rollbackInstallation(
      context,
      stateContext,
      receipt,
    );
    if (rollbackErrors.length > 0) {
      receipt.phase = "rollback_failed";
      await writeReceipt(stateContext, receipt);
      throw new AggregateError(
        [error, ...rollbackErrors],
        `${error instanceof Error ? error.message : "Installation failed"}; rollback failed`,
      );
    }
    await removeReceipt(stateContext);
    throw error;
  }
}

async function discoverUnrecordedVscodeTargets(
  context: ResolvedInstallerContext,
  receipt: InstallationReceipt,
): Promise<VscodeSettingsTarget[]> {
  const recordedSettingsPaths = new Set(
    receipt.vscodeTargets.map((target) => target.settingsPath),
  );
  return createVscodeSettingsTargets(
    context,
    context.vscodeSettingsPaths.filter(
      (settingsPath) => !recordedSettingsPaths.has(settingsPath),
    ),
    receipt.wrapperPath,
  );
}

async function collectDriftedSteps(
  context: ResolvedInstallerContext,
  receipt: InstallationReceipt,
  installedState: InstalledIntegrationState,
): Promise<InstallationStep[]> {
  const ownership = receiptStepOwnership(receipt);
  const operations = installationStepOperations(context, receipt);
  const stepIsInstalled: Record<InstallationStep, boolean> = {
    npmLink: installedState.npmPackageMatches && installedState.npmBinPathsMatch,
    codexMarketplace:
      resolve(installedState.codexMarketplaceSource ?? "") ===
      receipt.repositoryRoot,
    codexPlugin: installedState.codexPluginInstalled,
    claudeMarketplace:
      resolve(installedState.claudeMarketplaceSource ?? "") ===
      receipt.repositoryRoot,
    claudePlugin: installedState.claudePluginInstalled,
    vscodeSetting: await operations.vscodeSetting.verify(),
  };
  return canonicalInstallationOrder.filter(
    (step) => ownership[step] && !stepIsInstalled[step],
  );
}

async function warnAboutUserChangedVscodeTargets(
  context: ResolvedInstallerContext,
  receipt: InstallationReceipt,
): Promise<void> {
  for (const target of managedVscodeSettingsTargets(context, receipt)) {
    const currentSetting = await readVscodeSetting(target.settingsPath);
    if (
      classifyVscodeSettingsTarget(
        target,
        currentSetting,
        receipt.wrapperPath,
      ) === "userChanged"
    ) {
      writeUserChangedVscodeSettingWarning(context, target);
    }
  }
}

async function markReceiptInstalled(
  stateContext: SecureBridgeStateContext,
  receipt: InstallationReceipt,
): Promise<void> {
  if (
    receipt.phase === "installed" &&
    receipt.pendingStep === undefined &&
    receipt.pendingCommandTerminationConfirmed === undefined
  ) {
    return;
  }
  receipt.phase = "installed";
  delete receipt.pendingStep;
  delete receipt.pendingCommandTerminationConfirmed;
  await writeReceipt(stateContext, receipt);
}

async function refreshInstalledBridge(
  context: ResolvedInstallerContext,
  stateContext: SecureBridgeStateContext,
  receipt: InstallationReceipt,
): Promise<void> {
  const installedState = await readInstalledIntegrationState(context);
  const unrecordedTargets = await discoverUnrecordedVscodeTargets(
    context,
    receipt,
  );
  const refreshedTargets = [...receipt.vscodeTargets, ...unrecordedTargets];
  const refreshedReceipt: InstallationReceipt = {
    ...receipt,
    vscodeTargets: refreshedTargets,
  };
  const driftedSteps = await collectDriftedSteps(
    context,
    refreshedReceipt,
    installedState,
  );
  if (!driftedSteps.includes("vscodeSetting")) {
    await warnAboutUserChangedVscodeTargets(context, refreshedReceipt);
  }
  if (unrecordedTargets.length === 0 && driftedSteps.length === 0) {
    await markReceiptInstalled(stateContext, receipt);
    context.writeOutput("Bridge integrations are already installed.\n");
    return;
  }
  await assertNoNpmCollision(context, installedState);
  assertMarketplaceSources(context, installedState);
  await assertSupportedInstallerVersions(context);
  printMutationPlan(context, refreshedReceipt, driftedSteps);
  await buildBridgePackage(context, receipt);
  receipt.vscodeTargets = refreshedTargets;
  receipt.phase = "refreshing";
  await writeReceipt(stateContext, receipt);
  try {
    await applyInstallationSteps(context, stateContext, receipt, driftedSteps);
    await markReceiptInstalled(stateContext, receipt);
  } catch (error) {
    await recordInstallationStepFailure(
      context,
      stateContext,
      receipt,
      error,
      "refreshing",
    );
    throw error;
  }
}

async function applyBridgeInstallation(
  options: GlobalInstallerOptions,
  repairInstalledBridge: boolean,
): Promise<void> {
  const context = await resolveInstallerContext(options);
  printStatePreparationPlan(context);
  await withInstallationLock(
    {
      stateHomeDirectory: context.stateHomeDirectory,
      timeoutSeconds: context.installationLockTimeoutSeconds,
    },
    async (stateContext) => {
      const existingReceipt = await readReceipt(stateContext);
      if (
        existingReceipt?.phase === "installed" ||
        existingReceipt?.phase === "refreshing"
      ) {
        await validateReceiptProvenance(context, existingReceipt);
        if (existingReceipt.phase === "refreshing" || repairInstalledBridge) {
          await prepareReceiptForRecovery(context, stateContext, existingReceipt);
          await refreshInstalledBridge(context, stateContext, existingReceipt);
          return;
        }
        await assertReceiptStillInstalled(context, existingReceipt);
        context.writeOutput("Bridge integrations are already installed.\n");
        return;
      }
      if (existingReceipt !== undefined) {
        await validateReceiptProvenance(context, existingReceipt);
        await prepareReceiptForRecovery(context, stateContext, existingReceipt);
        printRemovalPlan(context, existingReceipt);
        const recoveryErrors = await rollbackInstallation(
          context,
          stateContext,
          existingReceipt,
        );
        if (recoveryErrors.length > 0) {
          existingReceipt.phase = "rollback_failed";
          await writeReceipt(stateContext, existingReceipt);
          throw new AggregateError(
            recoveryErrors,
            "Unable to recover the previous installation",
          );
        }
        await removeReceipt(stateContext);
      }
      await performFreshInstallation(context, stateContext);
    },
  );
}

export async function installBridgeGlobally(
  options: GlobalInstallerOptions = {},
): Promise<void> {
  await applyBridgeInstallation(options, false);
}

export async function setupBridge(
  options: GlobalInstallerOptions = {},
): Promise<DoctorReport> {
  await applyBridgeInstallation(options, true);
  return doctorBridgeInstallation(options);
}

export async function uninstallBridgeGlobally(
  options: GlobalInstallerOptions = {},
): Promise<void> {
  const context = await resolveInstallerContext(options);
  printStatePreparationPlan(context);
  await withInstallationLock(
    {
      stateHomeDirectory: context.stateHomeDirectory,
      timeoutSeconds: context.installationLockTimeoutSeconds,
    },
    async (stateContext) => {
    const receipt = await readReceipt(stateContext);
    if (receipt === undefined) {
      context.writeOutput("No owned bridge installation was found.\n");
      return;
    }
    await validateReceiptProvenance(context, receipt);
    await prepareReceiptForRecovery(context, stateContext, receipt);
    printRemovalPlan(context, receipt);
    receipt.phase = "uninstalling";
    await writeReceipt(stateContext, receipt);
    const rollbackErrors = await rollbackInstallation(context, stateContext, receipt);
    if (rollbackErrors.length > 0) {
      receipt.phase = "rollback_failed";
      await writeReceipt(stateContext, receipt);
      throw new AggregateError(
        rollbackErrors,
        `Unable to remove every owned integration: ${rollbackErrors.map((error) => error.message).join("; ")}`,
      );
    }
    await removeReceipt(stateContext);
    },
  );
}

function addDoctorCheck(
  checks: DoctorCheck[],
  name: string,
  condition: boolean,
  successMessage: string,
  failureMessage: string,
): void {
  checks.push({
    name,
    status: condition ? "passed" : "failed",
    message: condition ? successMessage : failureMessage,
  });
}

export function parseClaudeProcessIdentifiers(processListing: string): number[] {
  const processIdentifiers: number[] = [];
  for (const line of processListing.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/u);
    if (match === null) {
      continue;
    }
    if (match[2].trim().split("/").includes("claude")) {
      processIdentifiers.push(Number(match[1]));
    }
  }
  return processIdentifiers;
}

async function listClaudeProcessIdentifiersThroughProcessStatus(
  context: ResolvedInstallerContext,
): Promise<number[]> {
  const result = await context.executeCommand({
    executablePath: "/bin/ps",
    arguments: ["-Ao", "pid=,comm="],
    timeoutMilliseconds: commandTimeoutMilliseconds,
    maximumOutputBytes: maximumProcessListingBytes,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Process listing failed (${result.exitCode}): ${sanitizeCommandError(result.stderr) || "no error output"}`,
    );
  }
  return parseClaudeProcessIdentifiers(result.stdout);
}

function bridgeIsNotInstalledReport(): DoctorReport {
  return {
    ok: false,
    checks: [
      {
        name: "installation",
        status: "failed",
        message: "Bridge is not installed; run codex-claude-bridge setup",
      },
    ],
  };
}

export async function doctorBridgeInstallation(
  options: GlobalInstallerOptions = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  try {
    if (!(await pathExists(installReceiptPath(options.stateHomeDirectory)))) {
      return bridgeIsNotInstalledReport();
    }
  } catch (error) {
    return {
      ok: false,
      checks: [
        {
          name: "doctor_runtime",
          status: "failed",
          message: error instanceof Error ? error.message : "Doctor failed",
        },
      ],
    };
  }
  let context: ResolvedInstallerContext;
  try {
    context = await resolveInstallerContext(options);
  } catch (error) {
    checks.push({
      name: "doctor_runtime",
      status: "failed",
      message: error instanceof Error ? error.message : "Doctor failed",
    });
    return { ok: false, checks };
  }

  let detectedCodexVersion: string | undefined;
  for (const [name, label, executablePath, minimum] of [
    ["node_version", "Node", context.executables.node, [22, 0, 0]],
    ["codex_version", "Codex", context.executables.codex, [0, 149, 0]],
    ["claude_version", "Claude", context.executables.claude, [2, 1, 224]],
  ] as const) {
    try {
      const versionResult = await runRequiredCommand(context, executablePath, ["--version"]);
      const detectedVersion = parseVersionTuple(versionResult.stdout);
      const detectedVersionLabel =
        detectedVersion === undefined ? "unparseable" : detectedVersion.join(".");
      if (name === "codex_version" && detectedVersion !== undefined) {
        detectedCodexVersion = detectedVersionLabel;
      }
      addDoctorCheck(
        checks,
        name,
        detectedVersion !== undefined && versionAtLeast(detectedVersion, [...minimum]),
        `${label} detected ${detectedVersionLabel}; minimum ${minimum.join(".")}`,
        `${label} detected ${detectedVersionLabel}; minimum ${minimum.join(".")}`,
      );
    } catch (error) {
      checks.push({
        name,
        status: "failed",
        message: `${label} version check failed: ${error instanceof Error ? error.message : "unknown error"}`,
      });
    }
  }

  const stateHomeDirectory = resolveStateHomeDirectory(context.stateHomeDirectory);
  try {
    const readonlyReceipt = await readReceiptReadonly(stateHomeDirectory);
    addDoctorCheck(
      checks,
      "state_permissions",
      readonlyReceipt.mode === 0o600 && readonlyReceipt.directoryMode === 0o700,
      "State directory and receipt are private",
      "State directory or receipt permissions are unsafe",
    );
  } catch (error) {
    checks.push({
      name: "state_permissions",
      status: "failed",
      message: error instanceof Error ? error.message : "State permission check failed",
    });
  }
  try {
    const readonlyReceipt = await readReceiptReadonly(stateHomeDirectory);
    await validateReceiptProvenance(context, readonlyReceipt.receipt);
    addDoctorCheck(
      checks,
      "receipt_phase",
      readonlyReceipt.receipt.phase === "installed",
      "Install receipt is complete",
      `Install receipt phase is ${readonlyReceipt.receipt.phase}`,
    );
  } catch (error) {
    checks.push({
      name: "receipt_phase",
      status: "failed",
      message: error instanceof Error ? error.message : "Receipt phase check failed",
    });
  }
  try {
    const readonlyReceipt = await readReceiptReadonly(stateHomeDirectory);
    await validateReceiptProvenance(context, readonlyReceipt.receipt);
    await assertReceiptStillInstalled(context, readonlyReceipt.receipt);
    checks.push({
      name: "integrations",
      status: "passed",
      message: "All integrations match the receipt",
    });
  } catch (error) {
    checks.push({
      name: "integrations",
      status: "failed",
      message: error instanceof Error ? error.message : "Integration check failed",
    });
  }
  checks.push({
    name: "codex_hook_trust",
    status: "info",
    message:
      detectedCodexVersion === undefined
        ? "Codex version unavailable; stable hook trust status is not exposed in plugin JSON output"
        : `Codex ${detectedCodexVersion} does not expose stable hook trust status in plugin JSON output`,
  });
  try {
    const readonlyReceipt = await readReceiptReadonly(stateHomeDirectory);
    const globalBinaryDirectory = dirname(readonlyReceipt.receipt.npm.binPaths[0]);
    const globalBinaryDirectoryIsInPath = context.environmentPath
      .split(delimiter)
      .includes(globalBinaryDirectory);
    checks.push({
      name: "global_bin_path",
      status: globalBinaryDirectoryIsInPath ? "passed" : "info",
      message: globalBinaryDirectoryIsInPath
        ? `Global bin directory ${globalBinaryDirectory} is in PATH; Codex and Claude must inherit it`
        : `Global bin directory ${globalBinaryDirectory} is not in PATH; Codex and Claude must inherit it`,
    });
  } catch (error) {
    checks.push({
      name: "global_bin_path",
      status: "info",
      message: error instanceof Error ? error.message : "PATH check failed",
    });
  }
  let activeSessions: ActiveSessionRecord[] | undefined;
  try {
    activeSessions = await context.listActiveSessions();
    checks.push({
      name: "active_sessions",
      status: activeSessions.length === 0 ? "info" : "passed",
      message:
        activeSessions.length === 0
          ? "No active bridge sessions; start one with codex-claude-bridge launch claude or codex-claude-bridge launch codex"
          : `${activeSessions.length} active bridge sessions`,
    });
  } catch (error) {
    checks.push({
      name: "active_sessions",
      status: "failed",
      message: error instanceof Error ? error.message : "Session inspection failed",
    });
  }
  try {
    const runningClaudeProcessIdentifiers = await (
      options.listRunningClaudeProcessIdentifiers ??
      (() => listClaudeProcessIdentifiersThroughProcessStatus(context))
    )();
    if (activeSessions === undefined) {
      checks.push({
        name: "claude_channel_coverage",
        status: "info",
        message:
          "Registered Claude sessions are unavailable; running Claude processes were not compared",
      });
    } else {
      const registeredProcessIdentifiers = new Set(
        activeSessions
          .filter((session) => session.runtime === "claude")
          .map((session) => session.processId),
      );
      const unregisteredProcessCount = runningClaudeProcessIdentifiers.filter(
        (processIdentifier) =>
          !registeredProcessIdentifiers.has(processIdentifier),
      ).length;
      checks.push({
        name: "claude_channel_coverage",
        status: unregisteredProcessCount === 0 ? "passed" : "info",
        message:
          unregisteredProcessCount === 0
            ? "Every running Claude process is registered with the bridge Channel"
            : `${unregisteredProcessCount} running Claude processes have no bridge Channel; start them with codex-claude-bridge launch claude`,
      });
    }
  } catch (error) {
    checks.push({
      name: "claude_channel_coverage",
      status: "info",
      message: `Running Claude processes were not inspected: ${error instanceof Error ? error.message : "unknown error"}`,
    });
  }
  return {
    ok: !checks.some(({ status }) => status === "failed"),
    checks,
  };
}
