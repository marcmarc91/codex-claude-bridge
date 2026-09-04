import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  sanitizeCommandError,
  type CommandExecutionRequest,
  type CommandExecutionResult,
} from "./commandExecution.js";
import type { InstallerExecutables } from "./executableResolver.js";
import { readJsonSetting, type JsonSettingSnapshot } from "./jsonSettingsEditor.js";

export interface InstalledIntegrationState {
  npmPrefix: string;
  npmPackageListed: boolean;
  npmPackageMatches: boolean;
  npmBinPathsMatch: boolean;
  codexMarketplaceSource?: string;
  codexPluginInstalled: boolean;
  claudeMarketplaceSource?: string;
  claudePluginInstalled: boolean;
  vscodeSetting: JsonSettingSnapshot;
}

export interface IntegrationDiscoveryContext {
  repositoryRoot: string;
  pluginRoot: string;
  vscodeSettingsPath: string;
  executables: InstallerExecutables;
  executeCommand: (
    request: CommandExecutionRequest,
  ) => Promise<CommandExecutionResult>;
}

const marketplaceName = "codex-claude-bridge-local";
const pluginName = "codex-claude-bridge";
const pluginIdentifier = `${pluginName}@${marketplaceName}`;
const wrapperSettingName = "claudeCode.claudeProcessWrapper";
const commandTimeoutMilliseconds = 15_000;
const maximumCommandOutputBytes = 65_536;

async function runCommand(
  context: IntegrationDiscoveryContext,
  executablePath: string,
  argumentsList: string[],
): Promise<CommandExecutionResult> {
  return context.executeCommand({
    executablePath,
    arguments: [...argumentsList],
    timeoutMilliseconds: commandTimeoutMilliseconds,
    maximumOutputBytes: maximumCommandOutputBytes,
  });
}

async function runRequiredCommand(
  context: IntegrationDiscoveryContext,
  executablePath: string,
  argumentsList: string[],
): Promise<CommandExecutionResult> {
  const result = await runCommand(context, executablePath, argumentsList);
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${result.exitCode}): ${executablePath} ${argumentsList.join(" ")}: ${sanitizeCommandError(result.stderr) || "no error output"}`,
    );
  }
  return result;
}

function parseJsonOutput(value: string, commandDescription: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${commandDescription} returned invalid JSON`);
  }
}

function pathFromMarketplaceEntry(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const marketplaceEntry = entry as Record<string, unknown>;
  if (typeof marketplaceEntry.root === "string") {
    return marketplaceEntry.root;
  }
  if (marketplaceEntry.source === "directory") {
    for (const key of ["path", "repo", "installLocation"]) {
      if (typeof marketplaceEntry[key] === "string") {
        return marketplaceEntry[key] as string;
      }
    }
    return undefined;
  }
  for (const key of ["repo", "path", "installLocation"]) {
    if (typeof marketplaceEntry[key] === "string") {
      return marketplaceEntry[key] as string;
    }
  }
  return undefined;
}

export async function readCodexMarketplaceSource(
  context: IntegrationDiscoveryContext,
): Promise<string | undefined> {
  const result = await runRequiredCommand(context, context.executables.codex, [
    "plugin",
    "marketplace",
    "list",
    "--json",
  ]);
  const parsed = parseJsonOutput(result.stdout, "Codex marketplace list");
  const marketplaces =
    typeof parsed === "object" && parsed !== null &&
    Array.isArray((parsed as Record<string, unknown>).marketplaces)
      ? ((parsed as Record<string, unknown>).marketplaces as unknown[])
      : undefined;
  if (marketplaces === undefined) {
    throw new Error("Codex marketplace list returned an unexpected schema");
  }
  const entry = marketplaces.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as Record<string, unknown>).name === marketplaceName,
  );
  return pathFromMarketplaceEntry(entry);
}

export async function readCodexPluginInstalled(
  context: IntegrationDiscoveryContext,
): Promise<boolean> {
  const result = await runRequiredCommand(context, context.executables.codex, [
    "plugin",
    "list",
    "--json",
  ]);
  const parsed = parseJsonOutput(result.stdout, "Codex plugin list");
  const installed =
    typeof parsed === "object" && parsed !== null &&
    Array.isArray((parsed as Record<string, unknown>).installed)
      ? ((parsed as Record<string, unknown>).installed as unknown[])
      : undefined;
  if (installed === undefined) {
    throw new Error("Codex plugin list returned an unexpected schema");
  }
  const matchingPlugin = installed.find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as Record<string, unknown>).pluginId === pluginIdentifier &&
      (entry as Record<string, unknown>).marketplaceName === marketplaceName,
  );
  const exactPlugin =
    matchingPlugin !== undefined &&
    (matchingPlugin as Record<string, unknown>).installed === true &&
    (matchingPlugin as Record<string, unknown>).enabled === true
      ? matchingPlugin
      : undefined;
  if (matchingPlugin !== undefined && exactPlugin === undefined) {
    throw new Error("Codex bridge plugin is installed but disabled or incomplete");
  }
  const conflictingPlugin = installed.find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (((entry as Record<string, unknown>).name === pluginName &&
        (entry as Record<string, unknown>).pluginId !== pluginIdentifier) ||
        ((entry as Record<string, unknown>).pluginId === pluginIdentifier &&
          (entry as Record<string, unknown>).marketplaceName !== marketplaceName)),
  );
  if (conflictingPlugin !== undefined) {
    throw new Error("Codex plugin identifier collision");
  }
  return exactPlugin !== undefined;
}

export async function readClaudeMarketplaceSource(
  context: IntegrationDiscoveryContext,
): Promise<string | undefined> {
  const result = await runRequiredCommand(context, context.executables.claude, [
    "plugin",
    "marketplace",
    "list",
    "--json",
  ]);
  const parsed = parseJsonOutput(result.stdout, "Claude marketplace list");
  if (!Array.isArray(parsed)) {
    throw new Error("Claude marketplace list returned an unexpected schema");
  }
  const entry = parsed.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as Record<string, unknown>).name === marketplaceName,
  );
  return pathFromMarketplaceEntry(entry);
}

export async function readClaudePluginInstalled(
  context: IntegrationDiscoveryContext,
): Promise<boolean> {
  const result = await runRequiredCommand(context, context.executables.claude, [
    "plugin",
    "list",
    "--json",
  ]);
  const parsed = parseJsonOutput(result.stdout, "Claude plugin list");
  if (!Array.isArray(parsed)) {
    throw new Error("Claude plugin list returned an unexpected schema");
  }
  const matchingPlugin = parsed.find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as Record<string, unknown>).id === pluginIdentifier &&
      (entry as Record<string, unknown>).scope === "user",
  );
  const exactPlugin =
    matchingPlugin !== undefined &&
    (matchingPlugin as Record<string, unknown>).enabled === true
      ? matchingPlugin
      : undefined;
  if (matchingPlugin !== undefined && exactPlugin === undefined) {
    throw new Error("Claude bridge plugin is installed but disabled");
  }
  const conflictingPlugin = parsed.find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).id === "string" &&
      ((entry as Record<string, unknown>).id as string).startsWith(`${pluginName}@`) &&
      ((entry as Record<string, unknown>).id !== pluginIdentifier ||
        (entry as Record<string, unknown>).scope !== "user"),
  );
  if (conflictingPlugin !== undefined) {
    throw new Error("Claude plugin identifier collision");
  }
  return exactPlugin !== undefined;
}

export async function pathResolvesTo(
  candidatePath: string,
  targetPath: string,
): Promise<boolean> {
  try {
    return (await realpath(candidatePath)) === (await realpath(targetPath));
  } catch {
    return false;
  }
}

export async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await lstat(candidatePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readNpmPackageListed(
  context: IntegrationDiscoveryContext,
): Promise<boolean> {
  const result = await runCommand(context, context.executables.npm, [
    "list",
    "--global",
    pluginName,
    "--depth=0",
    "--json",
  ]);
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`npm global package query failed (${result.exitCode})`);
  }
  const parsed = parseJsonOutput(result.stdout, "npm global package list");
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("npm global package list returned an unexpected schema");
  }
  const dependencies = (parsed as Record<string, unknown>).dependencies;
  return (
    typeof dependencies === "object" &&
    dependencies !== null &&
    Object.hasOwn(dependencies, pluginName)
  );
}

export async function readInstalledIntegrationState(
  context: IntegrationDiscoveryContext,
): Promise<InstalledIntegrationState> {
  const npmPrefix = (
    await runRequiredCommand(context, context.executables.npm, ["prefix", "--global"])
  ).stdout.trim();
  if (npmPrefix.length === 0) {
    throw new Error("npm returned an empty global prefix");
  }
  const packageLinkPath = join(npmPrefix, "lib", "node_modules", pluginName);
  const binPaths = [
    join(npmPrefix, "bin", "codex-claude-bridge"),
    join(npmPrefix, "bin", "claude-code-bridge-wrapper"),
  ];
  return {
    npmPrefix,
    npmPackageListed: await readNpmPackageListed(context),
    npmPackageMatches: await pathResolvesTo(packageLinkPath, context.pluginRoot),
    npmBinPathsMatch:
      (await pathResolvesTo(
        binPaths[0],
        join(context.pluginRoot, "dist", "bin", "codexClaudeBridge.js"),
      )) &&
      (await pathResolvesTo(
        binPaths[1],
        join(context.pluginRoot, "dist", "bin", "claudeCodeBridgeWrapper.js"),
      )),
    codexMarketplaceSource: await readCodexMarketplaceSource(context),
    codexPluginInstalled: await readCodexPluginInstalled(context),
    claudeMarketplaceSource: await readClaudeMarketplaceSource(context),
    claudePluginInstalled: await readClaudePluginInstalled(context),
    vscodeSetting: await readJsonSetting(
      context.vscodeSettingsPath,
      wrapperSettingName,
    ),
  };
}

export async function assertNoNpmCollision(
  context: IntegrationDiscoveryContext,
  installedState: InstalledIntegrationState,
): Promise<void> {
  const packageLinkPath = join(
    installedState.npmPrefix,
    "lib",
    "node_modules",
    pluginName,
  );
  const binPaths = [
    join(installedState.npmPrefix, "bin", "codex-claude-bridge"),
    join(installedState.npmPrefix, "bin", "claude-code-bridge-wrapper"),
  ];
  if ((await pathExists(packageLinkPath)) && !installedState.npmPackageMatches) {
    throw new Error("npm global package source collision");
  }
  if (installedState.npmPackageListed !== installedState.npmPackageMatches) {
    throw new Error("npm global package registry and link disagree");
  }
  for (const binPath of binPaths) {
    if ((await pathExists(binPath)) && !installedState.npmBinPathsMatch) {
      throw new Error(`npm global binary collision: ${binPath}`);
    }
  }
  if (installedState.npmPackageMatches && !installedState.npmBinPathsMatch) {
    throw new Error("npm global bridge link is incomplete or changed");
  }
}

export function assertMarketplaceSources(
  context: IntegrationDiscoveryContext,
  installedState: InstalledIntegrationState,
): void {
  if (
    installedState.codexMarketplaceSource !== undefined &&
    resolve(installedState.codexMarketplaceSource) !== context.repositoryRoot
  ) {
    throw new Error("Codex marketplace source collision");
  }
  if (
    installedState.claudeMarketplaceSource !== undefined &&
    resolve(installedState.claudeMarketplaceSource) !== context.repositoryRoot
  ) {
    throw new Error("Claude marketplace source collision");
  }
}
