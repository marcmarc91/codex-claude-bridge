import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { CommandTerminationUnconfirmedError } from "../src/install/commandExecution.js";
import { writeReceipt } from "../src/install/installationReceiptStore.js";
import {
  doctorBridgeInstallation,
  installBridgeGlobally,
  parseClaudeProcessIdentifiers,
  resolveClaudeExecutable,
  setupBridge,
  uninstallBridgeGlobally,
  type CommandExecutionRequest,
  type CommandExecutionResult,
  type GlobalInstallerOptions,
} from "../src/install/globalInstaller.js";
import type { MessageStatusRecord } from "../src/conversations/messageStatusStore.js";
import type { ActiveSessionRecord } from "../src/registry/activeSessionRegistry.js";

const marketplaceName = "codex-claude-bridge-local";
const pluginIdentifier = `codex-claude-bridge@${marketplaceName}`;

interface FakeIntegrationState {
  npmLinked: boolean;
  codexMarketplaceSource?: string;
  codexPluginInstalled: boolean;
  claudeMarketplaceSource?: string;
  claudePluginInstalled: boolean;
}

async function createTestOptions(testContext: test.TestContext): Promise<{
  options: GlobalInstallerOptions;
  state: FakeIntegrationState;
  commands: CommandExecutionRequest[];
  output: string[];
  settingsPath: string;
  stateHomeDirectory: string;
  repositoryRoot: string;
  homeDirectory: string;
  failCommand: (predicate: (request: CommandExecutionRequest) => boolean) => void;
  failAfterCommand: (predicate: (request: CommandExecutionRequest) => boolean) => void;
  setPreexistingExactIntegrations: () => Promise<void>;
}> {
  const temporaryDirectory = await realpath(
    await mkdtemp(join(tmpdir(), "ccb-installer-")),
  );
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const repositoryRoot = join(temporaryDirectory, "repository with spaces");
  const pluginRoot = join(repositoryRoot, "plugins", "codex-claude-bridge");
  const globalPrefix = join(temporaryDirectory, "global-prefix");
  const homeDirectory = join(temporaryDirectory, "home");
  const stateHomeDirectory = join(temporaryDirectory, "state");
  const settingsPath = join(homeDirectory, "Library", "Application Support", "Code", "User", "settings.json");
  await mkdir(join(pluginRoot, "node_modules", "typescript", "bin"), { recursive: true });
  await mkdir(join(pluginRoot, "dist", "bin"), { recursive: true });
  await writeFile(join(pluginRoot, "node_modules", "typescript", "bin", "tsc"), "build");
  await writeFile(join(pluginRoot, "tsconfig.json"), "{}\n");
  await writeFile(join(pluginRoot, "dist", "bin", "codexClaudeBridge.js"), "bridge", {
    mode: 0o700,
  });
  await writeFile(join(pluginRoot, "dist", "bin", "claudeCodeBridgeWrapper.js"), "wrapper", {
    mode: 0o700,
  });
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, '{\n  // keep\n  "editor.fontSize": 14,\n}\n');
  await chmod(settingsPath, 0o640);

  const state: FakeIntegrationState = {
    npmLinked: false,
    codexPluginInstalled: false,
    claudePluginInstalled: false,
  };
  const commands: CommandExecutionRequest[] = [];
  const output: string[] = [];
  let failurePredicate: ((request: CommandExecutionRequest) => boolean) | undefined;
  let failureAfterPredicate: ((request: CommandExecutionRequest) => boolean) | undefined;

  const packageLinkPath = join(globalPrefix, "lib", "node_modules", "codex-claude-bridge");
  const binDirectory = join(globalPrefix, "bin");
  const createGlobalLinks = async (): Promise<void> => {
    await mkdir(dirname(packageLinkPath), { recursive: true });
    await mkdir(binDirectory, { recursive: true });
    await symlink(pluginRoot, packageLinkPath);
    await symlink(
      join(pluginRoot, "dist", "bin", "codexClaudeBridge.js"),
      join(binDirectory, "codex-claude-bridge"),
    );
    await symlink(
      join(pluginRoot, "dist", "bin", "claudeCodeBridgeWrapper.js"),
      join(binDirectory, "claude-code-bridge-wrapper"),
    );
  };
  const removeGlobalLinks = async (): Promise<void> => {
    await unlink(join(binDirectory, "codex-claude-bridge")).catch(() => undefined);
    await unlink(join(binDirectory, "claude-code-bridge-wrapper")).catch(() => undefined);
    await unlink(packageLinkPath).catch(() => undefined);
  };

  const executeCommand = async (
    request: CommandExecutionRequest,
  ): Promise<CommandExecutionResult> => {
    commands.push(request);
    if (failurePredicate?.(request)) {
      return { exitCode: 19, stdout: "", stderr: "injected failure" };
    }
    const commandName = request.executablePath.split("/").at(-1);
    const argumentsList = request.arguments;
    if (commandName === "npm" && argumentsList.join(" ") === "prefix --global") {
      return { exitCode: 0, stdout: `${globalPrefix}\n`, stderr: "" };
    }
    if (
      commandName === "npm" &&
      argumentsList.join(" ") ===
        "list --global codex-claude-bridge --depth=0 --json"
    ) {
      return {
        exitCode: state.npmLinked ? 0 : 1,
        stdout: JSON.stringify(
          state.npmLinked
            ? { name: "lib", dependencies: { "codex-claude-bridge": { version: "0.1.0" } } }
            : { name: "lib" },
        ),
        stderr: state.npmLinked ? "" : "npm warning allowed",
      };
    }
    const isMutation =
      (commandName === "npm" && ["link", "unlink"].includes(argumentsList[0] ?? "")) ||
      (argumentsList[0] === "plugin" &&
        (["add", "remove", "install", "uninstall"].includes(argumentsList[1] ?? "") ||
          ["add", "remove"].includes(argumentsList[2] ?? "")));
    if (isMutation && output.length === 0) {
      return { exitCode: 91, stdout: "", stderr: "mutation plan was not printed" };
    }
    if (commandName === "npm" && argumentsList[0] === "link") {
      await createGlobalLinks();
      state.npmLinked = true;
    }
    if (commandName === "npm" && argumentsList[0] === "unlink") {
      await removeGlobalLinks();
      state.npmLinked = false;
    }
    if (commandName === "codex" && argumentsList.join(" ") === "plugin marketplace list --json") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          marketplaces:
            state.codexMarketplaceSource === undefined
              ? []
              : [{ name: marketplaceName, root: state.codexMarketplaceSource, marketplaceSource: { sourceType: "directory", source: state.codexMarketplaceSource } }],
        }),
        stderr: "warning allowed",
      };
    }
    if (commandName === "codex" && argumentsList.join(" ") === "plugin list --json") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          installed: state.codexPluginInstalled
            ? [{ pluginId: pluginIdentifier, name: "codex-claude-bridge", marketplaceName, version: "0.1.0", installed: true, enabled: true, source: "local", marketplaceSource: repositoryRoot }]
            : [],
          available: [],
        }),
        stderr: "",
      };
    }
    if (commandName === "claude" && argumentsList.join(" ") === "plugin marketplace list --json") {
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          state.claudeMarketplaceSource === undefined
            ? []
            : [{ name: marketplaceName, source: "directory", path: state.claudeMarketplaceSource, installLocation: state.claudeMarketplaceSource }],
        ),
        stderr: "",
      };
    }
    if (commandName === "claude" && argumentsList.join(" ") === "plugin list --json") {
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          state.claudePluginInstalled
            ? [{ id: pluginIdentifier, version: "0.1.0", scope: "user", enabled: true, installPath: join(temporaryDirectory, "claude-cache"), installedAt: "2026-09-04T00:00:00.000Z", lastUpdated: "2026-09-04T00:00:00.000Z" }]
            : [],
        ),
        stderr: "",
      };
    }
    if (commandName === "codex" && argumentsList[0] === "--version") {
      return { exitCode: 0, stdout: "codex-cli 0.153.1\n", stderr: "" };
    }
    if (commandName === "claude" && argumentsList[0] === "--version") {
      return { exitCode: 0, stdout: "2.1.259 (Claude Code)\n", stderr: "" };
    }
    if (commandName === "node" && argumentsList[0] === "--version") {
      return { exitCode: 0, stdout: "v26.7.0\n", stderr: "" };
    }
    if (commandName === "codex" && argumentsList.slice(0, 3).join(" ") === "plugin marketplace add") {
      state.codexMarketplaceSource = repositoryRoot;
    }
    if (commandName === "codex" && argumentsList.slice(0, 3).join(" ") === "plugin marketplace remove") {
      state.codexMarketplaceSource = undefined;
    }
    if (commandName === "codex" && argumentsList.slice(0, 2).join(" ") === "plugin add") {
      state.codexPluginInstalled = true;
    }
    if (commandName === "codex" && argumentsList.slice(0, 2).join(" ") === "plugin remove") {
      state.codexPluginInstalled = false;
    }
    if (commandName === "claude" && argumentsList.slice(0, 3).join(" ") === "plugin marketplace add") {
      state.claudeMarketplaceSource = repositoryRoot;
    }
    if (commandName === "claude" && argumentsList.slice(0, 3).join(" ") === "plugin marketplace remove") {
      state.claudeMarketplaceSource = undefined;
    }
    if (commandName === "claude" && argumentsList.slice(0, 2).join(" ") === "plugin install") {
      state.claudePluginInstalled = true;
    }
    if (commandName === "claude" && argumentsList.slice(0, 2).join(" ") === "plugin uninstall") {
      state.claudePluginInstalled = false;
    }
    if (failureAfterPredicate?.(request)) {
      return { exitCode: 29, stdout: "", stderr: "injected failure after mutation" };
    }
    return { exitCode: 0, stdout: "{}\n", stderr: "" };
  };

  return {
    state,
    commands,
    output,
    settingsPath,
    stateHomeDirectory,
    repositoryRoot,
    homeDirectory,
    failCommand: (predicate) => {
      failurePredicate = predicate;
    },
    failAfterCommand: (predicate) => {
      failureAfterPredicate = predicate;
    },
    setPreexistingExactIntegrations: async () => {
      await createGlobalLinks();
      state.npmLinked = true;
      state.codexMarketplaceSource = repositoryRoot;
      state.codexPluginInstalled = true;
      state.claudeMarketplaceSource = repositoryRoot;
      state.claudePluginInstalled = true;
      await writeFile(
        settingsPath,
        JSON.stringify({
          ["claudeCode.claudeProcessWrapper"]: join(
            globalPrefix,
            "bin",
            "claude-code-bridge-wrapper",
          ),
        }),
      );
    },
    options: {
      repositoryRoot,
      homeDirectory,
      stateHomeDirectory,
      environmentPath: binDirectory,
      vscodeSettingsPath: settingsPath,
      executables: {
        node: process.execPath,
        npm: "/fake/npm",
        codex: "/fake/codex",
        claude: "/fake/claude",
      },
      executeCommand,
      writeOutput: (value) => output.push(value),
    },
  };
}

test("installs in the documented order, writes a private receipt, and is idempotent", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  let stateDirectoryExistedAtFirstOutput: boolean | undefined;
  fixture.options.writeOutput = (value) => {
    if (stateDirectoryExistedAtFirstOutput === undefined) {
      stateDirectoryExistedAtFirstOutput = existsSync(
        join(fixture.stateHomeDirectory, "codex-claude-bridge"),
      );
    }
    fixture.output.push(value);
  };

  await installBridgeGlobally(fixture.options);

  assert.equal(stateDirectoryExistedAtFirstOutput, false);
  assert.match(fixture.output[0] ?? "", /\.install\.lock/u);
  const mutationCommands = fixture.commands.filter(({ arguments: argumentsList }) =>
    ["link", "add", "install"].includes(argumentsList[0] ?? argumentsList[1] ?? ""),
  );
  const commandSignatures = fixture.commands
    .filter(({ executablePath, arguments: argumentsList }) =>
      (executablePath === process.execPath && argumentsList[0] !== "--version") ||
      argumentsList[0] === "link" ||
      ["add", "install"].includes(argumentsList[1] ?? "") ||
      argumentsList[2] === "add",
    )
    .map(
    ({ executablePath, arguments: argumentsList }) => `${executablePath.split("/").at(-1)} ${argumentsList.join(" ")}`,
  );
  assert.ok(commandSignatures[0]?.startsWith("node "));
  assert.deepEqual(commandSignatures, [
    `node ${join(fixture.repositoryRoot, "plugins", "codex-claude-bridge", "node_modules", "typescript", "bin", "tsc")} -p ${join(fixture.repositoryRoot, "plugins", "codex-claude-bridge", "tsconfig.json")}`,
    "npm link --ignore-scripts",
    `codex plugin marketplace add ${fixture.repositoryRoot} --json`,
    `codex plugin add ${pluginIdentifier} --json`,
    `claude plugin marketplace add ${fixture.repositoryRoot} --scope user`,
    `claude plugin install ${pluginIdentifier} --scope user --yes`,
  ]);
  assert.ok(mutationCommands.length > 0);
  const receiptPath = join(fixture.stateHomeDirectory, "codex-claude-bridge", "install-receipt.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.phase, "installed");
  assert.equal(receipt.vscodeTargets[0].previous.present, false);
  assert.equal((await lstat(receiptPath)).mode & 0o777, 0o600);
  assert.match(await readFile(fixture.settingsPath, "utf8"), /\/\/ keep/u);
  const mutationCountAfterFirstInstall = fixture.commands.filter(
    ({ arguments: argumentsList }) =>
      ["link", "add", "install"].includes(argumentsList[0] ?? "") ||
      ["add", "install"].includes(argumentsList[1] ?? "") ||
      argumentsList[2] === "add",
  ).length;

  await installBridgeGlobally(fixture.options);

  assert.equal(
    fixture.commands.filter(
      ({ arguments: argumentsList }) =>
        ["link", "add", "install"].includes(argumentsList[0] ?? "") ||
        ["add", "install"].includes(argumentsList[1] ?? "") ||
        argumentsList[2] === "add",
    ).length,
    mutationCountAfterFirstInstall,
  );
});

test("rolls back installation when the global bridge command is unavailable through PATH", async (testContext) => {
  const fixture = await createTestOptions(testContext);

  await assert.rejects(
    installBridgeGlobally({ ...fixture.options, environmentPath: "" }),
    /Global bridge command is not resolvable from PATH/u,
  );

  assert.equal(fixture.state.npmLinked, false);
  assert.equal(fixture.state.codexMarketplaceSource, undefined);
  assert.equal(fixture.state.codexPluginInstalled, false);
  assert.equal(fixture.state.claudeMarketplaceSource, undefined);
  assert.equal(fixture.state.claudePluginInstalled, false);
});

test("uninstalls owned resources in reverse order, restores settings through CAS, and unlinks npm last", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await installBridgeGlobally(fixture.options);
  fixture.commands.length = 0;
  fixture.output.length = 0;

  await uninstallBridgeGlobally(fixture.options);

  assert.match(fixture.output.join(""), /plugin uninstall/u);
  assert.match(fixture.output.join(""), /npm unlink --global/u);
  const mutationSignatures = fixture.commands
    .filter(({ arguments: argumentsList }) =>
      argumentsList[0] === "unlink" ||
      ["remove", "uninstall"].includes(argumentsList[1] ?? "") ||
      argumentsList[2] === "remove",
    )
    .map(({ executablePath, arguments: argumentsList }) => `${executablePath.split("/").at(-1)} ${argumentsList.join(" ")}`);
  assert.deepEqual(mutationSignatures, [
    `claude plugin uninstall ${pluginIdentifier} --scope user --yes`,
    `claude plugin marketplace remove ${marketplaceName} --scope user`,
    `codex plugin remove ${pluginIdentifier} --json`,
    `codex plugin marketplace remove ${marketplaceName} --json`,
    "npm unlink --global codex-claude-bridge --ignore-scripts",
  ]);
  assert.doesNotMatch(await readFile(fixture.settingsPath, "utf8"), /claudeProcessWrapper/u);
  await assert.rejects(
    readFile(join(fixture.stateHomeDirectory, "codex-claude-bridge", "install-receipt.json")),
    { code: "ENOENT" },
  );

  const commandCount = fixture.commands.length;
  await uninstallBridgeGlobally(fixture.options);
  assert.equal(fixture.commands.length, commandCount);
});

test("persists each external removal step before invoking its command", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await installBridgeGlobally(fixture.options);
  const receiptPath = join(
    fixture.stateHomeDirectory,
    "codex-claude-bridge",
    "install-receipt.json",
  );
  const executeCommand = fixture.options.executeCommand!;
  const observedPendingRemovalSteps: string[] = [];
  fixture.options.executeCommand = async (request) => {
    const commandName = request.executablePath.split("/").at(-1);
    const argumentsList = request.arguments;
    const discoveryStep =
      commandName === "npm" && argumentsList.join(" ") === "prefix --global"
        ? "npmLink"
        : commandName === "claude" && argumentsList.join(" ") === "plugin list --json"
          ? "claudePlugin"
          : commandName === "claude" &&
              argumentsList.join(" ") === "plugin marketplace list --json"
            ? "claudeMarketplace"
            : commandName === "codex" && argumentsList.join(" ") === "plugin list --json"
              ? "codexPlugin"
              : commandName === "codex" &&
                  argumentsList.join(" ") === "plugin marketplace list --json"
                ? "codexMarketplace"
                : undefined;
    if (
      discoveryStep !== undefined &&
      !observedPendingRemovalSteps.includes(discoveryStep)
    ) {
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      assert.equal(receipt.pendingRemovalStep, undefined);
    }
    const removalStep =
      commandName === "npm" && argumentsList[0] === "unlink"
        ? "npmLink"
        : commandName === "claude" && argumentsList[1] === "uninstall"
          ? "claudePlugin"
          : commandName === "claude" && argumentsList[2] === "remove"
            ? "claudeMarketplace"
            : commandName === "codex" && argumentsList[1] === "remove"
              ? "codexPlugin"
              : commandName === "codex" && argumentsList[2] === "remove"
                ? "codexMarketplace"
                : undefined;
    if (removalStep !== undefined) {
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      assert.equal(receipt.pendingRemovalStep, removalStep);
      observedPendingRemovalSteps.push(removalStep);
    }
    return executeCommand(request);
  };

  await uninstallBridgeGlobally(fixture.options);

  assert.deepEqual(observedPendingRemovalSteps, [
    "claudePlugin",
    "claudeMarketplace",
    "codexPlugin",
    "codexMarketplace",
    "npmLink",
  ]);
});

test("preserves the install failure when a pending removal marker cannot be persisted", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  fixture.failAfterCommand(
    (request) =>
      request.executablePath.endsWith("claude") &&
      request.arguments[0] === "plugin" &&
      request.arguments[1] === "install",
  );
  let rejectPendingRemovalWrite = true;
  fixture.options.persistInstallationReceipt = async (
    stateContext,
    receipt,
  ) => {
    if (
      rejectPendingRemovalWrite &&
      receipt.pendingRemovalStep === "claudePlugin"
    ) {
      rejectPendingRemovalWrite = false;
      throw new Error("injected pending removal receipt failure");
    }
    await writeReceipt(stateContext, receipt);
  };

  await assert.rejects(
    installBridgeGlobally(fixture.options),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.errors[0].message, /injected failure after mutation/u);
      assert.match(
        error.errors[1].message,
        /injected pending removal receipt failure/u,
      );
      return true;
    },
  );
  assert.equal(
    fixture.commands.some(
      (request) =>
        request.executablePath.endsWith("claude") &&
        request.arguments[1] === "uninstall",
    ),
    false,
  );
  const receipt = JSON.parse(
    await readFile(
      join(
        fixture.stateHomeDirectory,
        "codex-claude-bridge",
        "install-receipt.json",
      ),
      "utf8",
    ),
  );
  assert.equal(receipt.phase, "rollback_failed");
  assert.equal(receipt.pendingStep, "claudePlugin");
  assert.equal(receipt.pendingRemovalStep, undefined);
});

test("retains the pending removal marker when its confirmed-close update fails", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await installBridgeGlobally(fixture.options);
  fixture.commands.length = 0;
  fixture.failAfterCommand(
    (request) =>
      request.executablePath.endsWith("claude") &&
      request.arguments[0] === "plugin" &&
      request.arguments[1] === "uninstall",
  );
  let pendingRemovalWasPersisted = false;
  let rejectConfirmedCloseWrite = true;
  fixture.options.persistInstallationReceipt = async (
    stateContext,
    receipt,
  ) => {
    if (receipt.pendingRemovalStep === "claudePlugin") {
      pendingRemovalWasPersisted = true;
    } else if (pendingRemovalWasPersisted && rejectConfirmedCloseWrite) {
      rejectConfirmedCloseWrite = false;
      throw new Error("injected confirmed-close receipt failure");
    }
    await writeReceipt(stateContext, receipt);
  };

  await assert.rejects(
    uninstallBridgeGlobally(fixture.options),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(
        error.errors.at(-1).message,
        /injected confirmed-close receipt failure/u,
      );
      return true;
    },
  );
  assert.equal(pendingRemovalWasPersisted, true);
  const receipt = JSON.parse(
    await readFile(
      join(
        fixture.stateHomeDirectory,
        "codex-claude-bridge",
        "install-receipt.json",
      ),
      "utf8",
    ),
  );
  assert.equal(receipt.phase, "rollback_failed");
  assert.equal(receipt.pendingRemovalStep, "claudePlugin");
  assert.equal(fixture.state.claudePluginInstalled, false);
  assert.equal(
    fixture.commands.some(
      (request) =>
        request.executablePath.endsWith("claude") &&
        request.arguments[2] === "remove",
    ),
    false,
  );
});

test("rolls back only completed owned mutations in reverse order after a failure", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  const timeline: string[] = [];
  const executeCommand = fixture.options.executeCommand!;
  fixture.options.executeCommand = async (request) => {
    timeline.push(`command:${request.executablePath} ${request.arguments.join(" ")}`);
    return executeCommand(request);
  };
  fixture.options.writeOutput = (value) => {
    fixture.output.push(value);
    timeline.push(`output:${value}`);
  };
  fixture.failCommand(
    ({ executablePath, arguments: argumentsList }) =>
      executablePath.endsWith("claude") && argumentsList[1] === "install",
  );

  await assert.rejects(installBridgeGlobally(fixture.options), /injected failure/u);

  const rollbackSignatures = fixture.commands
    .filter(({ arguments: argumentsList }) =>
      argumentsList[0] === "unlink" ||
      ["remove", "uninstall"].includes(argumentsList[1] ?? "") ||
      argumentsList[2] === "remove",
    )
    .map(({ executablePath, arguments: argumentsList }) => `${executablePath.split("/").at(-1)} ${argumentsList.join(" ")}`);
  assert.deepEqual(rollbackSignatures, [
    `claude plugin marketplace remove ${marketplaceName} --scope user`,
    `codex plugin remove ${pluginIdentifier} --json`,
    `codex plugin marketplace remove ${marketplaceName} --json`,
    "npm unlink --global codex-claude-bridge --ignore-scripts",
  ]);
  assert.equal(fixture.state.npmLinked, false);
  assert.equal(fixture.state.codexPluginInstalled, false);
  assert.equal(fixture.state.claudeMarketplaceSource, undefined);
  const removalPlanIndex = timeline.findIndex((entry) =>
    entry.includes("Claude marketplace: /fake/claude plugin marketplace remove"),
  );
  const firstRemovalCommandIndex = timeline.findIndex((entry) =>
    entry.includes("command:/fake/claude plugin marketplace remove"),
  );
  assert.ok(removalPlanIndex >= 0);
  assert.ok(firstRemovalCommandIndex > removalPlanIndex);
});

test("keeps a retryable receipt and skips rollback when command termination is unconfirmed", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  const executeCommand = fixture.options.executeCommand!;
  let terminateUnconfirmed = true;
  fixture.options.executeCommand = async (request) => {
    if (
      terminateUnconfirmed &&
      request.executablePath.endsWith("codex") &&
      request.arguments.slice(0, 3).join(" ") === "plugin marketplace add"
    ) {
      terminateUnconfirmed = false;
      throw new CommandTerminationUnconfirmedError("command did not close", 4321);
    }
    return executeCommand(request);
  };

  await assert.rejects(
    installBridgeGlobally(fixture.options),
    CommandTerminationUnconfirmedError,
  );

  assert.equal(fixture.state.npmLinked, true);
  assert.equal(
    fixture.commands.some(({ arguments: argumentsList }) =>
      argumentsList[0] === "unlink" ||
      argumentsList[1] === "remove" ||
      argumentsList[1] === "uninstall" ||
      argumentsList[2] === "remove",
    ),
    false,
  );
  const receiptPath = join(
    fixture.stateHomeDirectory,
    "codex-claude-bridge",
    "install-receipt.json",
  );
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.phase, "rollback_failed");
  assert.equal(receipt.unconfirmedProcessGroupIdentifier, 4321);
  assert.equal(receipt.pendingStep, "codexMarketplace");
  assert.deepEqual(receipt.completedSteps, ["npmLink"]);

  fixture.commands.length = 0;
  await assert.rejects(
    installBridgeGlobally({
      ...fixture.options,
      confirmPendingCommandStopped: true,
      processGroupIsActive: async (processGroupIdentifier) => {
        assert.equal(processGroupIdentifier, 4321);
        return true;
      },
    }),
    /process group 4321 is still active/u,
  );
  assert.equal(
    fixture.commands.some(({ arguments: argumentsList }) =>
      argumentsList[0] === "unlink" ||
      argumentsList[1] === "remove" ||
      argumentsList[1] === "uninstall" ||
      argumentsList[2] === "remove",
    ),
    false,
  );

  fixture.commands.length = 0;
  let processGroupMarkerWasPresentWhenPlanWasPrinted = false;
  fixture.options.writeOutput = (value) => {
    fixture.output.push(value);
    if (value.includes(receiptPath) && value.includes("clear inactive process group")) {
      processGroupMarkerWasPresentWhenPlanWasPrinted =
        JSON.parse(readFileSync(receiptPath, "utf8"))
          .unconfirmedProcessGroupIdentifier === 4321;
    }
  };
  await installBridgeGlobally({
    ...fixture.options,
    processGroupIsActive: async () => false,
  });
  assert.equal(fixture.state.npmLinked, true);
  assert.equal(fixture.state.codexPluginInstalled, true);
  assert.equal(fixture.state.claudePluginInstalled, true);
  assert.equal(processGroupMarkerWasPresentWhenPlanWasPrinted, true);
  assert.equal(
    JSON.parse(
      await readFile(
        join(
          fixture.stateHomeDirectory,
          "codex-claude-bridge",
          "install-receipt.json",
        ),
        "utf8",
      ),
    ).phase,
    "installed",
  );
});

test("rejects a marketplace source collision before build or mutation", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  fixture.state.codexMarketplaceSource = "/different/source";

  await assert.rejects(installBridgeGlobally(fixture.options), /source collision/u);

  assert.equal(
    fixture.commands.some(
      ({ executablePath, arguments: argumentsList }) =>
        executablePath === process.execPath && argumentsList[0] !== "--version",
    ),
    false,
  );
  assert.equal(fixture.state.npmLinked, false);
});

test("recovers an unconfirmed command without a PID only after explicit confirmation", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  const executeCommand = fixture.options.executeCommand!;
  let terminateUnconfirmed = true;
  fixture.options.executeCommand = async (request) => {
    if (
      terminateUnconfirmed &&
      request.executablePath.endsWith("codex") &&
      request.arguments.slice(0, 3).join(" ") === "plugin marketplace add"
    ) {
      terminateUnconfirmed = false;
      throw new CommandTerminationUnconfirmedError("command did not close");
    }
    return executeCommand(request);
  };
  await assert.rejects(
    installBridgeGlobally(fixture.options),
    CommandTerminationUnconfirmedError,
  );
  const receiptPath = join(
    fixture.stateHomeDirectory,
    "codex-claude-bridge",
    "install-receipt.json",
  );
  let markerWasPresentWhenPlanWasPrinted = false;
  fixture.options.writeOutput = (value) => {
    fixture.output.push(value);
    if (value.includes(receiptPath) && value.includes("user-confirmed")) {
      markerWasPresentWhenPlanWasPrinted =
        JSON.parse(readFileSync(receiptPath, "utf8")).commandTerminationUnconfirmed ===
        true;
    }
  };

  await installBridgeGlobally({
    ...fixture.options,
    confirmPendingCommandStopped: true,
  });

  assert.equal(markerWasPresentWhenPlanWasPrinted, true);
  assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).phase, "installed");
});

test("leaves a user-owned wrapper change intact while removing every owned integration", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await installBridgeGlobally(fixture.options);
  await writeFile(
    fixture.settingsPath,
    JSON.stringify({ "claudeCode.claudeProcessWrapper": "/user/wrapper" }, null, 2),
  );

  await uninstallBridgeGlobally(fixture.options);

  assert.equal(
    JSON.parse(await readFile(fixture.settingsPath, "utf8"))["claudeCode.claudeProcessWrapper"],
    "/user/wrapper",
  );
  assert.match(fixture.output.join(""), /user-owned changes/u);
  await assert.rejects(
    readFile(
      join(fixture.stateHomeDirectory, "codex-claude-bridge", "install-receipt.json"),
    ),
    { code: "ENOENT" },
  );
});

test("doctor accepts supported integrations and reports no active sessions as informational", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await installBridgeGlobally(fixture.options);

  const report = await doctorBridgeInstallation({
    ...fixture.options,
    listActiveSessions: async () => [],
  });

  assert.equal(report.ok, true);
  assert.equal(report.checks.find(({ name }) => name === "active_sessions")?.status, "info");
  assert.equal(report.checks.some(({ status }) => status === "failed"), false);
  assert.match(
    report.checks.find(({ name }) => name === "node_version")?.message ?? "",
    /detected 26\.7\.0.*minimum 22\.0\.0/u,
  );
  assert.match(
    report.checks.find(({ name }) => name === "codex_hook_trust")?.message ?? "",
    /0\.153\.1/u,
  );
});

test("doctor reports a global bridge command that is unavailable through PATH", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await installBridgeGlobally(fixture.options);

  const report = await doctorBridgeInstallation({
    ...fixture.options,
    environmentPath: "",
  });

  assert.equal(report.ok, false);
  const integrationsCheck = report.checks.find(({ name }) => name === "integrations");
  assert.equal(integrationsCheck?.status, "failed");
  assert.match(
    integrationsCheck?.message ?? "",
    /Global bridge command is not resolvable from PATH/u,
  );
});

test("doctor reports independent failures without skipping later read-only checks", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await installBridgeGlobally(fixture.options);
  const receiptPath = join(
    fixture.stateHomeDirectory,
    "codex-claude-bridge",
    "install-receipt.json",
  );
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.phase = "rollback_failed";
  await writeFile(receiptPath, JSON.stringify(receipt));
  await chmod(receiptPath, 0o644);
  await writeFile(
    fixture.settingsPath,
    JSON.stringify({ "claudeCode.claudeProcessWrapper": "/drifted/wrapper" }),
  );
  const executeCommand = fixture.options.executeCommand!;
  fixture.options.executeCommand = async (request) => {
    if (
      request.executablePath.endsWith("codex") &&
      request.arguments[0] === "--version"
    ) {
      throw new Error("Codex probe failed");
    }
    return executeCommand(request);
  };

  const report = await doctorBridgeInstallation({
    ...fixture.options,
    listActiveSessions: async () => {
      throw new Error("Session inspection failed");
    },
  });

  assert.equal(report.ok, false);
  const checksByName = new Map(report.checks.map((check) => [check.name, check]));
  assert.equal(checksByName.get("node_version")?.status, "passed");
  assert.equal(checksByName.get("codex_version")?.status, "failed");
  assert.match(checksByName.get("codex_version")?.message ?? "", /probe failed/u);
  assert.equal(checksByName.get("claude_version")?.status, "passed");
  assert.equal(checksByName.get("state_permissions")?.status, "failed");
  assert.equal(checksByName.get("receipt_phase")?.status, "failed");
  assert.equal(checksByName.get("integrations")?.status, "failed");
  assert.match(
    checksByName.get("codex_hook_trust")?.message ?? "",
    /unavailable/u,
  );
  assert.equal(checksByName.get("active_sessions")?.status, "failed");
  assert.match(
    checksByName.get("active_sessions")?.message ?? "",
    /Session inspection failed/u,
  );
});

test("resolves Claude from the user-local fallback when PATH has no executable", async (testContext) => {
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), "ccb-claude-resolve-")));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const userClaudePath = join(temporaryDirectory, ".local", "bin", "claude");
  await mkdir(dirname(userClaudePath), { recursive: true });
  await writeFile(userClaudePath, "binary");
  await chmod(userClaudePath, 0o700);

  assert.equal(
    await resolveClaudeExecutable({
      homeDirectory: temporaryDirectory,
      environmentPath: join(temporaryDirectory, "empty-bin"),
    }),
    userClaudePath,
  );
});

test("does not claim or remove integrations that already match exactly", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await fixture.setPreexistingExactIntegrations();

  await installBridgeGlobally(fixture.options);

  const receiptPath = join(
    fixture.stateHomeDirectory,
    "codex-claude-bridge",
    "install-receipt.json",
  );
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.deepEqual(receipt.completedSteps, []);
  assert.equal(receipt.npm.owned, false);
  assert.equal(receipt.codex.marketplaceOwned, false);
  assert.equal(receipt.codex.pluginOwned, false);
  assert.equal(receipt.claude.marketplaceOwned, false);
  assert.equal(receipt.claude.pluginOwned, false);
  assert.equal(receipt.vscodeTargets[0].owned, false);
  fixture.commands.length = 0;

  await uninstallBridgeGlobally(fixture.options);

  assert.equal(fixture.state.npmLinked, true);
  assert.equal(fixture.state.codexPluginInstalled, true);
  assert.equal(fixture.state.claudePluginInstalled, true);
  assert.equal(
    fixture.commands.some(({ arguments: argumentsList }) =>
      argumentsList.some((argument) => ["remove", "uninstall", "unlink"].includes(argument)),
    ),
    false,
  );
});

for (const failureStep of [
  { executable: "npm", argument: "link" },
  { executable: "codex", argument: "add", occurrence: 1 },
  { executable: "codex", argument: "add", occurrence: 2 },
  { executable: "claude", argument: "add" },
  { executable: "claude", argument: "install" },
] as const) {
  test(`recovers a side effect when ${failureStep.executable} ${failureStep.argument} exits non-zero after mutation`, async (testContext) => {
    const fixture = await createTestOptions(testContext);
    let matchingOccurrence = 0;
    fixture.failAfterCommand(({ executablePath, arguments: argumentsList }) => {
      if (
        executablePath.endsWith(failureStep.executable) &&
        argumentsList.includes(failureStep.argument)
      ) {
        matchingOccurrence += 1;
        return matchingOccurrence === (failureStep.occurrence ?? 1);
      }
      return false;
    });

    await assert.rejects(
      installBridgeGlobally(fixture.options),
      /injected failure after mutation/u,
    );

    assert.equal(fixture.state.npmLinked, false);
    assert.equal(fixture.state.codexMarketplaceSource, undefined);
    assert.equal(fixture.state.codexPluginInstalled, false);
    assert.equal(fixture.state.claudeMarketplaceSource, undefined);
    assert.equal(fixture.state.claudePluginInstalled, false);
  });
}

test("preserves a user setting added to a settings file managed by install", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await writeFile(fixture.settingsPath, "{}\n");
  await installBridgeGlobally(fixture.options);
  const installedSettings = JSON.parse(await readFile(fixture.settingsPath, "utf8"));
  await writeFile(
    fixture.settingsPath,
    JSON.stringify({ ...installedSettings, "editor.fontSize": 18 }, null, 2),
  );

  await uninstallBridgeGlobally(fixture.options);

  assert.deepEqual(JSON.parse(await readFile(fixture.settingsPath, "utf8")), {
    "editor.fontSize": 18,
  });
});

test("rejects a tampered receipt target before any uninstall mutation", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await installBridgeGlobally(fixture.options);
  const receiptPath = join(
    fixture.stateHomeDirectory,
    "codex-claude-bridge",
    "install-receipt.json",
  );
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.vscodeTargets[0].settingsPath = join(dirname(fixture.settingsPath), "other.json");
  await writeFile(receiptPath, JSON.stringify(receipt));
  await chmod(receiptPath, 0o600);
  fixture.commands.length = 0;

  await assert.rejects(
    uninstallBridgeGlobally({
      ...fixture.options,
      confirmPendingCommandStopped: true,
    }),
    /provenance/u,
  );

  assert.equal(
    fixture.commands.some(({ arguments: argumentsList }) =>
      argumentsList.some((argument) => ["remove", "uninstall", "unlink"].includes(argument)),
    ),
    false,
  );
});

test("refuses an unsupported Claude version before build or mutation", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  const executeCommand = fixture.options.executeCommand;
  assert.notEqual(executeCommand, undefined);
  fixture.options.executeCommand = async (request) =>
    request.executablePath.endsWith("claude") && request.arguments[0] === "--version"
      ? { exitCode: 0, stdout: "2.1.100 (Claude Code)\n", stderr: "" }
      : executeCommand!(request);

  await assert.rejects(installBridgeGlobally(fixture.options), /at least 2\.1\.224/u);

  assert.equal(
    fixture.commands.some(
      ({ executablePath, arguments: argumentsList }) =>
        executablePath === process.execPath && argumentsList[0] !== "--version",
    ),
    false,
  );
  assert.equal(fixture.state.npmLinked, false);
});

test("refuses an unsupported Node executable before build or mutation", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  const executeCommand = fixture.options.executeCommand!;
  fixture.options.executeCommand = async (request) =>
    request.executablePath === process.execPath && request.arguments[0] === "--version"
      ? { exitCode: 0, stdout: "v21.7.0\n", stderr: "" }
      : executeCommand(request);

  await assert.rejects(installBridgeGlobally(fixture.options), /at least 22\.0\.0/u);

  assert.equal(
    fixture.commands.some(
      ({ executablePath, arguments: argumentsList }) =>
        executablePath === process.execPath && argumentsList[0] !== "--version",
    ),
    false,
  );
  assert.equal(fixture.state.npmLinked, false);
});

test("selects the newest executable Claude VS Code extension fallback", async (testContext) => {
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), "ccb-claude-extension-")));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  for (const version of ["2.1.224", "2.1.259", "2.1.240"]) {
    const executablePath = join(
      temporaryDirectory,
      ".vscode",
      "extensions",
      `anthropic.claude-code-${version}-darwin-arm64`,
      "resources",
      "native-binary",
      "claude",
    );
    await mkdir(dirname(executablePath), { recursive: true });
    await writeFile(executablePath, version);
    await chmod(executablePath, 0o700);
  }

  assert.equal(
    await resolveClaudeExecutable({
      homeDirectory: temporaryDirectory,
      environmentPath: "",
    }),
    join(
      temporaryDirectory,
      ".vscode",
      "extensions",
      "anthropic.claude-code-2.1.259-darwin-arm64",
      "resources",
      "native-binary",
      "claude",
    ),
  );
});

test("keeps recovery ownership when npm package link disappears but owned bin links remain", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await installBridgeGlobally(fixture.options);
  const receiptPath = join(
    fixture.stateHomeDirectory,
    "codex-claude-bridge",
    "install-receipt.json",
  );
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  await unlink(receipt.npm.packageLinkPath);

  await assert.rejects(
    uninstallBridgeGlobally(fixture.options),
    /npm global link/u,
  );

  assert.equal(await pathExistsForTest(receipt.npm.binPaths[0]), true);
  assert.equal(await pathExistsForTest(receipt.npm.binPaths[1]), true);
  assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).phase, "rollback_failed");
});

test("retries only remaining rollback steps after a fail-once plugin removal", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await installBridgeGlobally(fixture.options);
  let failedOnce = false;
  fixture.failCommand(({ executablePath, arguments: argumentsList }) => {
    const shouldFail =
      !failedOnce &&
      executablePath.endsWith("claude") &&
      argumentsList[0] === "plugin" &&
      argumentsList[1] === "uninstall";
    if (shouldFail) {
      failedOnce = true;
    }
    return shouldFail;
  });

  await assert.rejects(
    uninstallBridgeGlobally(fixture.options),
    /Unable to remove every owned integration/u,
  );

  assert.equal(fixture.state.claudePluginInstalled, true);
  assert.equal(fixture.state.claudeMarketplaceSource, fixture.repositoryRoot);
  assert.equal(fixture.state.codexPluginInstalled, false);
  assert.equal(fixture.state.codexMarketplaceSource, undefined);
  assert.equal(fixture.state.npmLinked, false);
  const receiptPath = join(
    fixture.stateHomeDirectory,
    "codex-claude-bridge",
    "install-receipt.json",
  );
  const failedReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(failedReceipt.phase, "rollback_failed");
  assert.deepEqual(
    new Set(failedReceipt.completedSteps),
    new Set(["claudePlugin", "claudeMarketplace"]),
  );
  fixture.commands.length = 0;

  await uninstallBridgeGlobally(fixture.options);

  const retryMutations = fixture.commands.filter(
    ({ arguments: argumentsList }) =>
      argumentsList[0] === "unlink" ||
      ["remove", "uninstall"].includes(argumentsList[1] ?? "") ||
      argumentsList[2] === "remove",
  );
  assert.deepEqual(
    retryMutations.map(({ executablePath, arguments: argumentsList }) =>
      `${executablePath.split("/").at(-1)} ${argumentsList.join(" ")}`,
    ),
    [
      `claude plugin uninstall ${pluginIdentifier} --scope user --yes`,
      `claude plugin marketplace remove ${marketplaceName} --scope user`,
    ],
  );
  await assert.rejects(readFile(receiptPath), { code: "ENOENT" });
});

test("stops rollback when a removal command termination is unconfirmed", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await installBridgeGlobally(fixture.options);
  const executeCommand = fixture.options.executeCommand!;
  let terminateUnconfirmed = true;
  fixture.options.executeCommand = async (request) => {
    if (
      terminateUnconfirmed &&
      request.executablePath.endsWith("claude") &&
      request.arguments.slice(0, 2).join(" ") === "plugin uninstall"
    ) {
      terminateUnconfirmed = false;
      throw new CommandTerminationUnconfirmedError("uninstall did not close", 9876);
    }
    return executeCommand(request);
  };
  fixture.commands.length = 0;

  await assert.rejects(
    uninstallBridgeGlobally(fixture.options),
    /Unable to remove every owned integration/u,
  );

  assert.equal(fixture.state.claudePluginInstalled, true);
  assert.equal(fixture.state.claudeMarketplaceSource, fixture.repositoryRoot);
  assert.equal(fixture.state.codexPluginInstalled, true);
  assert.equal(fixture.state.codexMarketplaceSource, fixture.repositoryRoot);
  assert.equal(fixture.state.npmLinked, true);
  const receiptPath = join(
    fixture.stateHomeDirectory,
    "codex-claude-bridge",
    "install-receipt.json",
  );
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.phase, "rollback_failed");
  assert.equal(receipt.pendingRemovalStep, "claudePlugin");
  assert.equal(receipt.commandTerminationUnconfirmed, true);
  assert.equal(receipt.unconfirmedProcessGroupIdentifier, 9876);

  fixture.commands.length = 0;
  await assert.rejects(
    uninstallBridgeGlobally({
      ...fixture.options,
      confirmPendingCommandStopped: true,
      processGroupIsActive: async () => true,
    }),
    /process group 9876 is still active/u,
  );
  assert.equal(fixture.commands.length, 0);

  await uninstallBridgeGlobally({
    ...fixture.options,
    processGroupIsActive: async () => false,
  });
  await assert.rejects(readFile(receiptPath), { code: "ENOENT" });
});

test("stops rollback without removal metadata when read-only discovery termination is unconfirmed", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await installBridgeGlobally(fixture.options);
  fixture.commands.length = 0;
  const executeCommand = fixture.options.executeCommand!;
  const discoveryError = new CommandTerminationUnconfirmedError(
    "plugin discovery did not close",
    6789,
  );
  let rejectFirstClaudePluginDiscovery = true;
  fixture.options.executeCommand = async (request) => {
    if (
      rejectFirstClaudePluginDiscovery &&
      request.executablePath.endsWith("claude") &&
      request.arguments.join(" ") === "plugin list --json"
    ) {
      rejectFirstClaudePluginDiscovery = false;
      throw discoveryError;
    }
    return executeCommand(request);
  };

  await assert.rejects(
    uninstallBridgeGlobally(fixture.options),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], discoveryError);
      return true;
    },
  );

  assert.equal(
    fixture.commands.some(({ arguments: argumentsList }) =>
      argumentsList[0] === "unlink" ||
      argumentsList[1] === "remove" ||
      argumentsList[1] === "uninstall" ||
      argumentsList[2] === "remove",
    ),
    false,
  );
  const receiptPath = join(
    fixture.stateHomeDirectory,
    "codex-claude-bridge",
    "install-receipt.json",
  );
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.phase, "rollback_failed");
  assert.equal(receipt.pendingRemovalStep, undefined);
  assert.equal(receipt.commandTerminationUnconfirmed, undefined);
  assert.equal(receipt.unconfirmedProcessGroupIdentifier, undefined);
  const report = await doctorBridgeInstallation({
    ...fixture.options,
    executeCommand,
  });
  assert.equal(
    report.checks.find(({ name }) => name === "receipt_phase")?.message,
    "Install receipt phase is rollback_failed",
  );
});

test("rejects impossible prior-setting receipt state before uninstall mutations", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await installBridgeGlobally(fixture.options);
  const receiptPath = join(
    fixture.stateHomeDirectory,
    "codex-claude-bridge",
    "install-receipt.json",
  );
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.vscodeTargets[0].previous = { fileExisted: false, present: true, value: "/impossible" };
  await writeFile(receiptPath, JSON.stringify(receipt));
  await chmod(receiptPath, 0o600);
  fixture.commands.length = 0;

  await assert.rejects(uninstallBridgeGlobally(fixture.options));

  assert.equal(
    fixture.commands.some(({ arguments: argumentsList }) =>
      argumentsList.some((argument) => ["remove", "uninstall", "unlink"].includes(argument)),
    ),
    false,
  );
});

for (const invalidTerminationState of [
  "unconfirmed-without-pending",
  "confirmed-and-unconfirmed",
] as const) {
  test(`rejects receipt state ${invalidTerminationState}`, async (testContext) => {
    const fixture = await createTestOptions(testContext);
    await installBridgeGlobally(fixture.options);
    const receiptPath = join(
      fixture.stateHomeDirectory,
      "codex-claude-bridge",
      "install-receipt.json",
    );
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.phase = "rollback_failed";
    receipt.commandTerminationUnconfirmed = true;
    if (invalidTerminationState === "confirmed-and-unconfirmed") {
      receipt.pendingStep = "codexPlugin";
      receipt.pendingCommandTerminationConfirmed = true;
    } else {
      delete receipt.pendingStep;
    }
    await writeFile(receiptPath, JSON.stringify(receipt));
    await chmod(receiptPath, 0o600);
    fixture.commands.length = 0;

    await assert.rejects(
      uninstallBridgeGlobally({
        ...fixture.options,
        confirmPendingCommandStopped: true,
      }),
    );

    assert.equal(fixture.commands.length, 0);
  });
}

for (const invalidRemovalState of [
  "not-owned",
  "not-rollbackable",
  "different-install-pending",
] as const) {
  test(`rejects receipt removal state ${invalidRemovalState}`, async (testContext) => {
    const fixture = await createTestOptions(testContext);
    await installBridgeGlobally(fixture.options);
    const receiptPath = join(
      fixture.stateHomeDirectory,
      "codex-claude-bridge",
      "install-receipt.json",
    );
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.phase = "uninstalling";
    receipt.pendingRemovalStep = "claudePlugin";
    if (invalidRemovalState === "not-owned") {
      receipt.claude.pluginOwned = false;
    }
    if (invalidRemovalState === "not-rollbackable") {
      receipt.completedSteps = receipt.completedSteps.filter(
        (step: string) => step !== "claudePlugin",
      );
    }
    if (invalidRemovalState === "different-install-pending") {
      receipt.pendingStep = "codexPlugin";
    }
    await writeFile(receiptPath, JSON.stringify(receipt));
    await chmod(receiptPath, 0o600);
    fixture.commands.length = 0;

    await assert.rejects(
      uninstallBridgeGlobally({
        ...fixture.options,
        confirmPendingCommandStopped: true,
      }),
    );

    assert.equal(fixture.commands.length, 0);
  });
}

test("serializes concurrent installs before either can inspect or mutate shared state", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  const executeCommand = fixture.options.executeCommand!;
  let releaseFirstQuery: (() => void) | undefined;
  const firstQueryBlocked = new Promise<void>((resolveBlocked) => {
    fixture.options.executeCommand = async (request) => {
      if (
        request.executablePath.endsWith("npm") &&
        request.arguments.join(" ") === "prefix --global" &&
        releaseFirstQuery === undefined
      ) {
        await new Promise<void>((resolveRelease) => {
          releaseFirstQuery = resolveRelease;
          resolveBlocked();
        });
      }
      return executeCommand(request);
    };
  });
  const firstInstall = installBridgeGlobally(fixture.options);
  await firstQueryBlocked;
  const secondInstall = installBridgeGlobally(fixture.options);
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 30));
  assert.equal(fixture.commands.length, 0);

  releaseFirstQuery?.();
  await Promise.all([firstInstall, secondInstall]);

  const linkCommands = fixture.commands.filter(
    ({ arguments: argumentsList }) => argumentsList[0] === "link",
  );
  assert.equal(linkCommands.length, 1);
});

test("a lock timeout fails without inspecting integration state", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  const executeCommand = fixture.options.executeCommand!;
  let releaseFirstQuery: (() => void) | undefined;
  const firstQueryBlocked = new Promise<void>((resolveBlocked) => {
    fixture.options.executeCommand = async (request) => {
      if (
        request.executablePath.endsWith("npm") &&
        request.arguments.join(" ") === "prefix --global" &&
        releaseFirstQuery === undefined
      ) {
        await new Promise<void>((resolveRelease) => {
          releaseFirstQuery = resolveRelease;
          resolveBlocked();
        });
      }
      return executeCommand(request);
    };
  });
  const firstInstall = installBridgeGlobally(fixture.options);
  await firstQueryBlocked;

  await assert.rejects(
    installBridgeGlobally({
      ...fixture.options,
      installationLockTimeoutSeconds: 0,
    }),
    /Timed out waiting for the global installation lock/u,
  );

  releaseFirstQuery?.();
  await firstInstall;
});

test("recovers an interrupted pending step before reinstalling", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await installBridgeGlobally(fixture.options);
  const receiptPath = join(
    fixture.stateHomeDirectory,
    "codex-claude-bridge",
    "install-receipt.json",
  );
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.phase = "installing";
  receipt.completedSteps = receipt.completedSteps.filter(
    (step: string) => step !== "vscodeSetting",
  );
  receipt.pendingStep = "vscodeSetting";
  await writeFile(receiptPath, JSON.stringify(receipt));
  await chmod(receiptPath, 0o600);

  await installBridgeGlobally(fixture.options);

  const recoveredReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(recoveredReceipt.phase, "installed");
  assert.equal(recoveredReceipt.pendingStep, undefined);
  assert.equal(fixture.state.npmLinked, true);
});

test("refuses automatic recovery for an external pending step without termination proof", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await installBridgeGlobally(fixture.options);
  const receiptPath = join(
    fixture.stateHomeDirectory,
    "codex-claude-bridge",
    "install-receipt.json",
  );
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.phase = "installing";
  receipt.completedSteps = receipt.completedSteps.filter(
    (step: string) =>
      step !== "claudePlugin" && step !== "vscodeSetting",
  );
  receipt.pendingStep = "claudePlugin";
  await writeFile(
    fixture.settingsPath,
    '{\n  // keep\n  "editor.fontSize": 14,\n}\n',
  );
  await writeFile(receiptPath, JSON.stringify(receipt));
  await chmod(receiptPath, 0o600);
  fixture.commands.length = 0;

  await assert.rejects(
    installBridgeGlobally(fixture.options),
    /termination proof.*manual recovery/u,
  );

  assert.equal(
    fixture.commands.some(({ arguments: argumentsList }) =>
      argumentsList[0] === "unlink" ||
      argumentsList[1] === "remove" ||
      argumentsList[1] === "uninstall" ||
      argumentsList[2] === "remove",
    ),
    false,
  );
  assert.equal(
    JSON.parse(await readFile(receiptPath, "utf8")).pendingStep,
    "claudePlugin",
  );

  let crashMarkerWasUnchangedWhenPlanWasPrinted = false;
  fixture.options.writeOutput = (value) => {
    fixture.output.push(value);
    if (value.includes(receiptPath) && value.includes("user-confirmed")) {
      crashMarkerWasUnchangedWhenPlanWasPrinted =
        JSON.parse(readFileSync(receiptPath, "utf8"))
          .pendingCommandTerminationConfirmed !== true;
    }
  };
  await installBridgeGlobally({
    ...fixture.options,
    confirmPendingCommandStopped: true,
  });
  assert.equal(crashMarkerWasUnchangedWhenPlanWasPrinted, true);
  assert.equal(
    JSON.parse(await readFile(receiptPath, "utf8")).phase,
    "installed",
  );
});

test("refuses a crash-pending removal before commands and resumes only after confirmation", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await installBridgeGlobally(fixture.options);
  const receiptPath = join(
    fixture.stateHomeDirectory,
    "codex-claude-bridge",
    "install-receipt.json",
  );
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.phase = "uninstalling";
  receipt.pendingRemovalStep = "claudePlugin";
  await writeFile(receiptPath, JSON.stringify(receipt));
  await chmod(receiptPath, 0o600);
  fixture.commands.length = 0;

  await assert.rejects(
    uninstallBridgeGlobally(fixture.options),
    /pending removal.*manual recovery/u,
  );
  assert.equal(fixture.commands.length, 0);
  assert.equal(fixture.state.npmLinked, true);

  await uninstallBridgeGlobally({
    ...fixture.options,
    confirmPendingCommandStopped: true,
  });
  await assert.rejects(readFile(receiptPath), { code: "ENOENT" });
  assert.equal(fixture.state.npmLinked, false);
});

for (const invalidReceiptKind of [
  "symlink",
  "corrupt",
  "oversized",
  "non-private",
] as const) {
  test(`refuses a ${invalidReceiptKind} receipt without integration mutations`, async (testContext) => {
    const fixture = await createTestOptions(testContext);
    const bridgeStateDirectory = join(
      fixture.stateHomeDirectory,
      "codex-claude-bridge",
    );
    const receiptPath = join(bridgeStateDirectory, "install-receipt.json");
    await mkdir(bridgeStateDirectory, { recursive: true, mode: 0o700 });
    await chmod(bridgeStateDirectory, 0o700);
    if (invalidReceiptKind === "symlink") {
      const targetPath = join(fixture.stateHomeDirectory, "outside-receipt.json");
      await writeFile(targetPath, "{}\n");
      await symlink(targetPath, receiptPath);
    } else if (invalidReceiptKind === "non-private") {
      await writeFile(receiptPath, "{}\n");
      await chmod(receiptPath, 0o644);
    } else {
      await writeFile(
        receiptPath,
        invalidReceiptKind === "corrupt" ? "not-json" : "x".repeat(300_000),
      );
      await chmod(receiptPath, 0o600);
    }

    await assert.rejects(uninstallBridgeGlobally(fixture.options));

    assert.equal(
      fixture.commands.some(({ arguments: argumentsList }) =>
        argumentsList.some((argument) => ["remove", "uninstall", "unlink"].includes(argument)),
      ),
      false,
    );
  });
}

test("refuses a symbolic-link installation lock without modifying its target", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  const bridgeStateDirectory = join(
    fixture.stateHomeDirectory,
    "codex-claude-bridge",
  );
  const lockTargetPath = join(fixture.stateHomeDirectory, "outside-lock");
  await mkdir(bridgeStateDirectory, { recursive: true, mode: 0o700 });
  await chmod(bridgeStateDirectory, 0o700);
  await writeFile(lockTargetPath, "unchanged", { mode: 0o600 });
  await symlink(lockTargetPath, join(bridgeStateDirectory, ".install.lock"));

  await assert.rejects(installBridgeGlobally(fixture.options));

  assert.equal(await readFile(lockTargetPath, "utf8"), "unchanged");
  assert.equal(fixture.commands.length, 0);
});

test("doctor reports wrapper drift as a required failure", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await installBridgeGlobally(fixture.options);
  await writeFile(
    fixture.settingsPath,
    JSON.stringify({ "claudeCode.claudeProcessWrapper": "/drifted/wrapper" }),
  );

  const report = await doctorBridgeInstallation(fixture.options);

  assert.equal(report.ok, false);
  assert.equal(
    report.checks.find(({ name }) => name === "integrations")?.status,
    "failed",
  );
});

for (const collision of ["claude-marketplace", "npm-binary"] as const) {
  test(`rejects ${collision} collision before build`, async (testContext) => {
    const fixture = await createTestOptions(testContext);
    if (collision === "claude-marketplace") {
      fixture.state.claudeMarketplaceSource = "/different/source";
    } else {
      const prefixResult = await fixture.options.executeCommand!({
        executablePath: "/fake/npm",
        arguments: ["prefix", "--global"],
        timeoutMilliseconds: 100,
        maximumOutputBytes: 100,
      });
      const wrongBinaryPath = join(
        prefixResult.stdout.trim(),
        "bin",
        "claude-code-bridge-wrapper",
      );
      await mkdir(dirname(wrongBinaryPath), { recursive: true });
      await writeFile(wrongBinaryPath, "foreign");
      fixture.commands.length = 0;
    }

    await assert.rejects(installBridgeGlobally(fixture.options), /collision/u);

    assert.equal(
      fixture.commands.some(({ executablePath }) => executablePath === process.execPath),
      false,
    );
  });
}

for (const pluginCollision of [
  "codex-wrong-marketplace",
  "claude-wrong-scope",
] as const) {
  test(`rejects ${pluginCollision} plugin ownership before build`, async (testContext) => {
    const fixture = await createTestOptions(testContext);
    const executeCommand = fixture.options.executeCommand!;
    fixture.options.executeCommand = async (request) => {
      if (
        pluginCollision === "codex-wrong-marketplace" &&
        request.executablePath.endsWith("codex") &&
        request.arguments.join(" ") === "plugin list --json"
      ) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: [
              {
                pluginId: pluginIdentifier,
                name: "codex-claude-bridge",
                marketplaceName: "different-marketplace",
                installed: true,
                enabled: true,
              },
            ],
            available: [],
          }),
          stderr: "",
        };
      }
      if (
        pluginCollision === "claude-wrong-scope" &&
        request.executablePath.endsWith("claude") &&
        request.arguments.join(" ") === "plugin list --json"
      ) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              id: pluginIdentifier,
              scope: "project",
              enabled: true,
            },
          ]),
          stderr: "",
        };
      }
      return executeCommand(request);
    };

    await assert.rejects(installBridgeGlobally(fixture.options), /collision/u);

    assert.equal(
      fixture.commands.some(
        ({ executablePath, arguments: argumentsList }) =>
          executablePath === process.execPath && argumentsList[0] !== "--version",
      ),
      false,
    );
  });
}

test("serializes install and uninstall so uninstall observes the completed receipt", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  const executeCommand = fixture.options.executeCommand!;
  let releaseFirstQuery: (() => void) | undefined;
  const firstQueryBlocked = new Promise<void>((resolveBlocked) => {
    fixture.options.executeCommand = async (request) => {
      if (
        request.executablePath.endsWith("npm") &&
        request.arguments.join(" ") === "prefix --global" &&
        releaseFirstQuery === undefined
      ) {
        await new Promise<void>((resolveRelease) => {
          releaseFirstQuery = resolveRelease;
          resolveBlocked();
        });
      }
      return executeCommand(request);
    };
  });
  const installPromise = installBridgeGlobally(fixture.options);
  await firstQueryBlocked;
  const uninstallPromise = uninstallBridgeGlobally(fixture.options);
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 30));
  assert.equal(fixture.commands.length, 0);

  releaseFirstQuery?.();
  await Promise.all([installPromise, uninstallPromise]);

  assert.equal(fixture.state.npmLinked, false);
  await assert.rejects(
    readFile(
      join(
        fixture.stateHomeDirectory,
        "codex-claude-bridge",
        "install-receipt.json",
      ),
    ),
    { code: "ENOENT" },
  );
});

test("install and doctor derive the same default state directory from XDG_STATE_HOME when stateHomeDirectory is not injected", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  const xdgStateHomeDirectory = join(dirname(fixture.stateHomeDirectory), "xdg-state-home");
  const originalXdgStateHomeDirectory = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = xdgStateHomeDirectory;
  testContext.after(() => {
    if (originalXdgStateHomeDirectory === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = originalXdgStateHomeDirectory;
    }
  });
  const { stateHomeDirectory: _omittedStateHomeDirectory, ...optionsWithoutStateHomeDirectory } =
    fixture.options;

  await installBridgeGlobally(optionsWithoutStateHomeDirectory);

  const bridgeStateDirectory = join(xdgStateHomeDirectory, "codex-claude-bridge");
  const receiptPath = join(bridgeStateDirectory, "install-receipt.json");
  assert.equal(existsSync(receiptPath), true);
  assert.equal(existsSync(join(fixture.stateHomeDirectory, "codex-claude-bridge")), false);
  assert.ok(fixture.output.join("").includes(bridgeStateDirectory));

  const report = await doctorBridgeInstallation({
    ...optionsWithoutStateHomeDirectory,
    listActiveSessions: async () => [],
  });

  assert.equal(report.checks.find(({ name }) => name === "receipt_phase")?.status, "passed");
  assert.equal(report.checks.find(({ name }) => name === "state_permissions")?.status, "passed");
  assert.equal(report.checks.find(({ name }) => name === "integrations")?.status, "passed");
});

async function pathExistsForTest(candidatePath: string): Promise<boolean> {
  try {
    await lstat(candidatePath);
    return true;
  } catch {
    return false;
  }
}

function claudeSessionRecord(processIdentifier: number): ActiveSessionRecord {
  return {
    schemaVersion: 1,
    runtime: "claude",
    sessionId: "ad65b1c1-7386-4465-80f9-4de0a26bc212",
    displayName: "claude-local",
    processId: processIdentifier,
    workingDirectory: "/projects/local",
    projectId: "0123456789abcdef01234567",
    socketPath: "/state/sockets/session.sock",
    registeredAt: "2026-09-04T10:00:00.000Z",
  };
}

function readReceiptForTest(stateHomeDirectory: string): {
  phase: string;
  installationId: string;
  wrapperPath: string;
  npm: { binPaths: string[] };
  completedSteps: string[];
  vscodeTargets: {
    settingsPath: string;
    owned: boolean;
    previous: { fileExisted: boolean; present: boolean; value?: string };
  }[];
} {
  return JSON.parse(
    readFileSync(
      join(stateHomeDirectory, "codex-claude-bridge", "install-receipt.json"),
      "utf8",
    ),
  );
}

function mutationSignaturesOf(commands: CommandExecutionRequest[]): string[] {
  return commands
    .filter(
      ({ arguments: argumentsList }) =>
        ["link", "unlink"].includes(argumentsList[0] ?? "") ||
        ["add", "install", "remove", "uninstall"].includes(argumentsList[1] ?? "") ||
        ["add", "remove"].includes(argumentsList[2] ?? ""),
    )
    .map(
      ({ executablePath, arguments: argumentsList }) =>
        `${executablePath.split("/").at(-1)} ${argumentsList.join(" ")}`,
    );
}

test("setup installs a missing bridge and returns a passing doctor report", async (testContext) => {
  const fixture = await createTestOptions(testContext);

  const report = await setupBridge({
    ...fixture.options,
    listActiveSessions: async () => [],
    listRunningClaudeProcessIdentifiers: async () => [],
  });

  assert.equal(report.ok, true);
  assert.equal(readReceiptForTest(fixture.stateHomeDirectory).phase, "installed");
  assert.equal(
    report.checks.find(({ name }) => name === "global_bin_path")?.status,
    "passed",
  );
  assert.equal(
    report.checks.find(({ name }) => name === "active_sessions")?.status,
    "info",
  );
  assert.match(
    report.checks.find(({ name }) => name === "active_sessions")?.message ?? "",
    /codex-claude-bridge launch claude/u,
  );
});

test("setup keeps the receipt and repairs only the integrations that drifted", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  const setupOptions = {
    ...fixture.options,
    listActiveSessions: async () => [],
    listRunningClaudeProcessIdentifiers: async () => [],
  };
  await setupBridge(setupOptions);
  const installationId = readReceiptForTest(fixture.stateHomeDirectory).installationId;

  fixture.commands.length = 0;
  fixture.output.length = 0;
  const idempotentReport = await setupBridge(setupOptions);
  const idempotentMutations = mutationSignaturesOf(fixture.commands);
  const idempotentOutput = fixture.output.join("");

  fixture.state.claudePluginInstalled = false;
  fixture.commands.length = 0;
  fixture.output.length = 0;
  const repairReport = await setupBridge(setupOptions);

  assert.equal(idempotentReport.ok, true);
  assert.deepEqual(idempotentMutations, []);
  assert.match(idempotentOutput, /already installed/u);
  assert.equal(repairReport.ok, true);
  assert.deepEqual(mutationSignaturesOf(fixture.commands), [
    `claude plugin install ${pluginIdentifier} --scope user --yes`,
  ]);
  assert.equal(fixture.state.claudePluginInstalled, true);
  const receipt = readReceiptForTest(fixture.stateHomeDirectory);
  assert.equal(receipt.installationId, installationId);
  assert.equal(receipt.phase, "installed");
});

test("setup records an editor installed after the first run and uninstall restores it", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  const { vscodeSettingsPath: _explicitSettingsPath, ...discoveringOptions } =
    fixture.options;
  const setupOptions = {
    ...discoveringOptions,
    listActiveSessions: async () => [],
    listRunningClaudeProcessIdentifiers: async () => [],
  };
  await setupBridge(setupOptions);
  const firstReceipt = readReceiptForTest(fixture.stateHomeDirectory);
  const windsurfSettingsDirectory = join(
    fixture.homeDirectory,
    "Library",
    "Application Support",
    "Windsurf",
    "User",
  );
  await mkdir(windsurfSettingsDirectory, { recursive: true });
  const windsurfSettingsPath = join(windsurfSettingsDirectory, "settings.json");
  await writeFile(windsurfSettingsPath, "{}\n");

  const report = await setupBridge(setupOptions);

  assert.equal(report.ok, true);
  const refreshedReceipt = readReceiptForTest(fixture.stateHomeDirectory);
  assert.deepEqual(firstReceipt.vscodeTargets.map(({ settingsPath }) => settingsPath), [
    fixture.settingsPath,
  ]);
  assert.deepEqual(
    refreshedReceipt.vscodeTargets.map(({ settingsPath }) => settingsPath),
    [fixture.settingsPath, windsurfSettingsPath],
  );
  assert.equal(refreshedReceipt.installationId, firstReceipt.installationId);
  assert.equal(refreshedReceipt.phase, "installed");
  assert.equal(
    JSON.parse(await readFile(windsurfSettingsPath, "utf8"))[
      "claudeCode.claudeProcessWrapper"
    ],
    refreshedReceipt.wrapperPath,
  );

  await uninstallBridgeGlobally(discoveringOptions);

  assert.doesNotMatch(
    await readFile(windsurfSettingsPath, "utf8"),
    /claudeProcessWrapper/u,
  );
  assert.doesNotMatch(
    await readFile(fixture.settingsPath, "utf8"),
    /claudeProcessWrapper/u,
  );
});

test("setup configures every discovered editor and uninstall restores each settings file", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  const cursorSettingsDirectory = join(
    fixture.homeDirectory,
    "Library",
    "Application Support",
    "Cursor",
    "User",
  );
  await mkdir(cursorSettingsDirectory, { recursive: true });
  const cursorSettingsPath = join(cursorSettingsDirectory, "settings.json");
  await writeFile(cursorSettingsPath, "{}\n");
  const { vscodeSettingsPath: _explicitSettingsPath, ...discoveringOptions } =
    fixture.options;

  const report = await setupBridge({
    ...discoveringOptions,
    listActiveSessions: async () => [],
    listRunningClaudeProcessIdentifiers: async () => [],
  });

  assert.equal(report.ok, true);
  const receipt = readReceiptForTest(fixture.stateHomeDirectory);
  assert.deepEqual(
    receipt.vscodeTargets.map(({ settingsPath }) => settingsPath),
    [fixture.settingsPath, cursorSettingsPath],
  );
  assert.ok(receipt.wrapperPath.endsWith("/bin/claude-code-bridge-wrapper"));
  assert.match(
    await readFile(fixture.settingsPath, "utf8"),
    /claudeCode\.claudeProcessWrapper/u,
  );
  assert.equal(
    JSON.parse(await readFile(cursorSettingsPath, "utf8"))[
      "claudeCode.claudeProcessWrapper"
    ],
    receipt.wrapperPath,
  );

  await uninstallBridgeGlobally(discoveringOptions);

  assert.doesNotMatch(
    await readFile(fixture.settingsPath, "utf8"),
    /claudeProcessWrapper/u,
  );
  assert.doesNotMatch(
    await readFile(cursorSettingsPath, "utf8"),
    /claudeProcessWrapper/u,
  );
});

test("setup skips editor integration without a discovered editor and with --no-vscode", async (testContext) => {
  const editorlessFixture = await createTestOptions(testContext);
  const {
    vscodeSettingsPath: _editorlessSettingsPath,
    ...editorlessOptions
  } = editorlessFixture.options;
  await rm(join(editorlessFixture.homeDirectory, "Library"), {
    recursive: true,
    force: true,
  });

  const editorlessReport = await setupBridge({
    ...editorlessOptions,
    listActiveSessions: async () => [],
    listRunningClaudeProcessIdentifiers: async () => [],
  });

  assert.equal(editorlessReport.ok, true);
  const editorlessReceipt = readReceiptForTest(editorlessFixture.stateHomeDirectory);
  assert.deepEqual(editorlessReceipt.vscodeTargets, []);
  assert.equal(editorlessReceipt.completedSteps.includes("vscodeSetting"), false);

  const disabledFixture = await createTestOptions(testContext);
  const { vscodeSettingsPath: _disabledSettingsPath, ...disabledOptions } =
    disabledFixture.options;

  const disabledReport = await setupBridge({
    ...disabledOptions,
    configureVscode: false,
    listActiveSessions: async () => [],
    listRunningClaudeProcessIdentifiers: async () => [],
  });

  assert.equal(disabledReport.ok, true);
  assert.deepEqual(
    readReceiptForTest(disabledFixture.stateHomeDirectory).vscodeTargets,
    [],
  );
  assert.doesNotMatch(
    await readFile(disabledFixture.settingsPath, "utf8"),
    /claudeProcessWrapper/u,
  );
});

test("doctor reports a missing installation in one line without inspecting integrations", async (testContext) => {
  const fixture = await createTestOptions(testContext);

  const report = await doctorBridgeInstallation(fixture.options);

  assert.equal(report.ok, false);
  assert.deepEqual(report.checks, [
    {
      name: "installation",
      status: "failed",
      message: "Bridge is not installed; run codex-claude-bridge setup",
    },
  ]);
  assert.deepEqual(fixture.commands, []);
});

test("doctor warns about a global bin directory that is missing from PATH", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await installBridgeGlobally(fixture.options);

  const report = await doctorBridgeInstallation({
    ...fixture.options,
    environmentPath: "/usr/bin",
    listActiveSessions: async () => [],
    listRunningClaudeProcessIdentifiers: async () => [],
  });

  const globalBinaryPathCheck = report.checks.find(
    ({ name }) => name === "global_bin_path",
  );
  assert.equal(globalBinaryPathCheck?.status, "info");
  assert.match(
    globalBinaryPathCheck?.message ?? "",
    /is not in PATH; Codex and Claude must inherit it/u,
  );
});

test("doctor counts running Claude processes that are not registered with the Channel", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await installBridgeGlobally(fixture.options);

  const coveredReport = await doctorBridgeInstallation({
    ...fixture.options,
    listActiveSessions: async () => [claudeSessionRecord(4242)],
    listRunningClaudeProcessIdentifiers: async () => [4242],
  });
  const uncoveredReport = await doctorBridgeInstallation({
    ...fixture.options,
    listActiveSessions: async () => [claudeSessionRecord(4242)],
    listRunningClaudeProcessIdentifiers: async () => [4242, 5150, 6161],
  });

  assert.equal(
    coveredReport.checks.find(({ name }) => name === "claude_channel_coverage")
      ?.status,
    "passed",
  );
  const uncoveredCheck = uncoveredReport.checks.find(
    ({ name }) => name === "claude_channel_coverage",
  );
  assert.equal(uncoveredCheck?.status, "info");
  assert.match(
    uncoveredCheck?.message ?? "",
    /2 running Claude processes have no bridge Channel/u,
  );
  assert.equal(uncoveredReport.ok, true);
});

test("reads Claude process identifiers from a process listing", () => {
  assert.deepEqual(
    parseClaudeProcessIdentifiers(
      [
        "  501 /opt/homebrew/bin/claude",
        " 502 claude",
        "503 /Users/example/.local/share/claude/versions/2.1.263",
        "504 /Applications/Claude.app/Contents/Helpers/chrome-native-host",
        "505 codex",
        "506 /usr/local/bin/claude-code-bridge-wrapper",
        "not a process line",
        "",
      ].join("\n"),
    ),
    [501, 502, 503],
  );
});

test("setup keeps a working installation intact when its refresh build fails", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  const setupOptions = {
    ...fixture.options,
    listActiveSessions: async () => [],
    listRunningClaudeProcessIdentifiers: async () => [],
  };
  await setupBridge(setupOptions);
  const receiptPath = join(
    fixture.stateHomeDirectory,
    "codex-claude-bridge",
    "install-receipt.json",
  );
  const installedReceiptText = await readFile(receiptPath, "utf8");
  fixture.state.claudePluginInstalled = false;
  fixture.commands.length = 0;
  fixture.failCommand(
    ({ executablePath, arguments: argumentsList }) =>
      executablePath === process.execPath && argumentsList[0] !== "--version",
  );

  await assert.rejects(setupBridge(setupOptions), /Command failed \(19\)/u);

  assert.equal(await readFile(receiptPath, "utf8"), installedReceiptText);
  assert.deepEqual(mutationSignaturesOf(fixture.commands), []);
  assert.equal(fixture.state.npmLinked, true);
  assert.equal(fixture.state.codexPluginInstalled, true);
});

test("setup resumes a failed refresh step without rolling back the installation", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  const setupOptions = {
    ...fixture.options,
    listActiveSessions: async () => [],
    listRunningClaudeProcessIdentifiers: async () => [],
  };
  await setupBridge(setupOptions);
  const installationId = readReceiptForTest(fixture.stateHomeDirectory).installationId;
  fixture.state.claudePluginInstalled = false;
  fixture.failCommand(
    ({ arguments: argumentsList }) =>
      argumentsList[0] === "plugin" && argumentsList[1] === "install",
  );

  await assert.rejects(setupBridge(setupOptions), /Command failed \(19\)/u);

  const interruptedReceipt = JSON.parse(
    readFileSync(
      join(fixture.stateHomeDirectory, "codex-claude-bridge", "install-receipt.json"),
      "utf8",
    ),
  );
  assert.equal(interruptedReceipt.phase, "refreshing");
  assert.equal(interruptedReceipt.pendingStep, "claudePlugin");
  assert.equal(interruptedReceipt.installationId, installationId);
  assert.equal(fixture.state.npmLinked, true);
  assert.equal(fixture.state.codexMarketplaceSource, fixture.repositoryRoot);

  fixture.failCommand(() => false);
  fixture.commands.length = 0;
  const recoveryReport = await setupBridge(setupOptions);

  assert.equal(recoveryReport.ok, true);
  assert.deepEqual(mutationSignaturesOf(fixture.commands), [
    `claude plugin install ${pluginIdentifier} --scope user --yes`,
  ]);
  const recoveredReceipt = readReceiptForTest(fixture.stateHomeDirectory);
  assert.equal(recoveredReceipt.phase, "installed");
  assert.equal(recoveredReceipt.installationId, installationId);
});

test("setup refuses to repair a drifted integration when another checkout owns a marketplace", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  const setupOptions = {
    ...fixture.options,
    listActiveSessions: async () => [],
    listRunningClaudeProcessIdentifiers: async () => [],
  };
  await setupBridge(setupOptions);
  fixture.state.claudePluginInstalled = false;
  fixture.state.codexMarketplaceSource = join(fixture.repositoryRoot, "..", "other-checkout");
  fixture.commands.length = 0;

  await assert.rejects(setupBridge(setupOptions), /marketplace source collision/u);

  assert.deepEqual(mutationSignaturesOf(fixture.commands), []);
  assert.equal(fixture.state.claudePluginInstalled, false);
});

test("setup refuses to repair an npm link that another package owns", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  const setupOptions = {
    ...fixture.options,
    listActiveSessions: async () => [],
    listRunningClaudeProcessIdentifiers: async () => [],
  };
  await setupBridge(setupOptions);
  const receipt = readReceiptForTest(fixture.stateHomeDirectory);
  const packageLinkPath = join(
    dirname(dirname(receipt.npm.binPaths[0])),
    "lib",
    "node_modules",
    "codex-claude-bridge",
  );
  const foreignPackageRoot = join(fixture.repositoryRoot, "..", "foreign-package");
  await mkdir(foreignPackageRoot, { recursive: true });
  await unlink(packageLinkPath);
  await symlink(foreignPackageRoot, packageLinkPath);
  fixture.commands.length = 0;

  await assert.rejects(setupBridge(setupOptions), /npm global package source collision/u);

  assert.deepEqual(mutationSignaturesOf(fixture.commands), []);
});

test("doctor reads a bounded process listing by command name and degrades to information", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await installBridgeGlobally(fixture.options);
  const processListingRequests: CommandExecutionRequest[] = [];
  const executeCommand = fixture.options.executeCommand!;
  const largeProcessListing = `${Array.from(
    { length: 4000 },
    (_unused, index) => `${index + 1} /Applications/Other.app/Contents/MacOS/Other`,
  ).join("\n")}\n4242 /Users/example/.local/share/claude/versions/2.1.263\n`;

  const inspectedReport = await doctorBridgeInstallation({
    ...fixture.options,
    listActiveSessions: async () => [],
    executeCommand: async (request) => {
      if (request.executablePath === "/bin/ps") {
        processListingRequests.push(request);
        return { exitCode: 0, stdout: largeProcessListing, stderr: "" };
      }
      return executeCommand(request);
    },
  });
  const failedReport = await doctorBridgeInstallation({
    ...fixture.options,
    listActiveSessions: async () => [],
    executeCommand: async (request) => {
      if (request.executablePath === "/bin/ps") {
        return { exitCode: 1, stdout: "", stderr: "ps failed" };
      }
      return executeCommand(request);
    },
  });

  assert.deepEqual(processListingRequests[0]?.arguments, ["-Ao", "pid=,comm="]);
  assert.ok(
    (processListingRequests[0]?.maximumOutputBytes ?? 0) >
      Buffer.byteLength(largeProcessListing),
  );
  const inspectedCheck = inspectedReport.checks.find(
    ({ name }) => name === "claude_channel_coverage",
  );
  assert.equal(inspectedCheck?.status, "info");
  assert.match(inspectedCheck?.message ?? "", /1 running Claude processes/u);
  const failedCheck = failedReport.checks.find(
    ({ name }) => name === "claude_channel_coverage",
  );
  assert.equal(failedCheck?.status, "info");
  assert.match(
    failedCheck?.message ?? "",
    /Running Claude processes were not inspected: Process listing failed \(1\)/u,
  );
  assert.equal(failedReport.ok, true);
});

test("setup with --no-vscode records no editor target and leaves settings untouched", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await writeFile(fixture.settingsPath, "{ broken");
  const { vscodeSettingsPath: _explicitSettingsPath, ...discoveringOptions } =
    fixture.options;

  const report = await setupBridge({
    ...discoveringOptions,
    configureVscode: false,
    listActiveSessions: async () => [],
    listRunningClaudeProcessIdentifiers: async () => [],
  });

  assert.equal(report.ok, true);
  assert.deepEqual(readReceiptForTest(fixture.stateHomeDirectory).vscodeTargets, []);
  assert.equal(await readFile(fixture.settingsPath, "utf8"), "{ broken");
});

test("setup skips a discovered editor with unreadable settings and configures the others", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  const cursorSettingsDirectory = join(
    fixture.homeDirectory,
    "Library",
    "Application Support",
    "Cursor",
    "User",
  );
  await mkdir(cursorSettingsDirectory, { recursive: true });
  const cursorSettingsPath = join(cursorSettingsDirectory, "settings.json");
  await writeFile(cursorSettingsPath, "{ broken");
  const { vscodeSettingsPath: _explicitSettingsPath, ...discoveringOptions } =
    fixture.options;

  const report = await setupBridge({
    ...discoveringOptions,
    listActiveSessions: async () => [],
    listRunningClaudeProcessIdentifiers: async () => [],
  });

  assert.equal(report.ok, true);
  assert.deepEqual(
    readReceiptForTest(fixture.stateHomeDirectory).vscodeTargets.map(
      ({ settingsPath }) => settingsPath,
    ),
    [fixture.settingsPath],
  );
  assert.match(
    fixture.output.join(""),
    /are unreadable: VS Code settings contain invalid JSONC; skipping this editor/u,
  );
  assert.equal(await readFile(cursorSettingsPath, "utf8"), "{ broken");
  assert.match(
    await readFile(fixture.settingsPath, "utf8"),
    /claudeProcessWrapper/u,
  );
});

test("setup leaves an owned wrapper that changed after installation and keeps its receipt entry", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  const setupOptions = {
    ...fixture.options,
    listActiveSessions: async () => [],
    listRunningClaudeProcessIdentifiers: async () => [],
  };
  await setupBridge(setupOptions);
  const installedReceipt = readReceiptForTest(fixture.stateHomeDirectory);
  await writeFile(
    fixture.settingsPath,
    JSON.stringify({ "claudeCode.claudeProcessWrapper": "/user/wrapper" }, null, 2),
  );
  fixture.commands.length = 0;
  fixture.output.length = 0;

  await setupBridge(setupOptions);

  assert.equal(
    JSON.parse(await readFile(fixture.settingsPath, "utf8"))[
      "claudeCode.claudeProcessWrapper"
    ],
    "/user/wrapper",
  );
  assert.deepEqual(
    readReceiptForTest(fixture.stateHomeDirectory).vscodeTargets,
    installedReceipt.vscodeTargets,
  );
  assert.deepEqual(mutationSignaturesOf(fixture.commands), []);
  assert.match(
    fixture.output.join(""),
    /was changed after installation; leaving it unchanged/u,
  );

  await uninstallBridgeGlobally(fixture.options);

  assert.equal(
    JSON.parse(await readFile(fixture.settingsPath, "utf8"))[
      "claudeCode.claudeProcessWrapper"
    ],
    "/user/wrapper",
  );
});

test("setup --no-vscode leaves a recorded editor target untouched", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  const { vscodeSettingsPath: _explicitSettingsPath, ...discoveringOptions } =
    fixture.options;
  const setupOptions = {
    ...discoveringOptions,
    listActiveSessions: async () => [],
    listRunningClaudeProcessIdentifiers: async () => [],
  };
  await setupBridge(setupOptions);
  const installedReceipt = readReceiptForTest(fixture.stateHomeDirectory);
  assert.equal(installedReceipt.vscodeTargets[0].owned, true);
  await writeFile(
    fixture.settingsPath,
    JSON.stringify({ "claudeCode.claudeProcessWrapper": "/user/wrapper" }, null, 2),
  );
  const settingsTextBeforeRefresh = await readFile(fixture.settingsPath, "utf8");
  fixture.commands.length = 0;

  await setupBridge({ ...setupOptions, configureVscode: false });

  assert.equal(await readFile(fixture.settingsPath, "utf8"), settingsTextBeforeRefresh);
  assert.deepEqual(
    readReceiptForTest(fixture.stateHomeDirectory).vscodeTargets,
    installedReceipt.vscodeTargets,
  );
  assert.deepEqual(mutationSignaturesOf(fixture.commands), []);

  await uninstallBridgeGlobally(discoveringOptions);

  assert.equal(
    JSON.parse(await readFile(fixture.settingsPath, "utf8"))[
      "claudeCode.claudeProcessWrapper"
    ],
    "/user/wrapper",
  );
});

test("setup never takes over an editor target the bridge does not own", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await fixture.setPreexistingExactIntegrations();
  await installBridgeGlobally(fixture.options);
  const installedReceipt = readReceiptForTest(fixture.stateHomeDirectory);
  assert.equal(installedReceipt.vscodeTargets[0].owned, false);
  await writeFile(
    fixture.settingsPath,
    JSON.stringify({ "claudeCode.claudeProcessWrapper": "/other/wrapper" }, null, 2),
  );
  fixture.commands.length = 0;

  await setupBridge({
    ...fixture.options,
    listActiveSessions: async () => [],
    listRunningClaudeProcessIdentifiers: async () => [],
  });

  assert.equal(
    JSON.parse(await readFile(fixture.settingsPath, "utf8"))[
      "claudeCode.claudeProcessWrapper"
    ],
    "/other/wrapper",
  );
  assert.deepEqual(
    readReceiptForTest(fixture.stateHomeDirectory).vscodeTargets,
    installedReceipt.vscodeTargets,
  );
  assert.deepEqual(mutationSignaturesOf(fixture.commands), []);
});

test("setup ignores an editor directory without settings and rejects a missing explicit path", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await mkdir(
    join(fixture.homeDirectory, "Library", "Application Support", "Windsurf", "User"),
    { recursive: true },
  );
  const { vscodeSettingsPath: _explicitSettingsPath, ...discoveringOptions } =
    fixture.options;

  const report = await setupBridge({
    ...discoveringOptions,
    listActiveSessions: async () => [],
    listRunningClaudeProcessIdentifiers: async () => [],
  });

  assert.equal(report.ok, true);
  assert.deepEqual(
    readReceiptForTest(fixture.stateHomeDirectory).vscodeTargets.map(
      ({ settingsPath }) => settingsPath,
    ),
    [fixture.settingsPath],
  );
  assert.equal(
    existsSync(
      join(
        fixture.homeDirectory,
        "Library",
        "Application Support",
        "Windsurf",
        "User",
        "settings.json",
      ),
    ),
    false,
  );

  const missingExplicitFixture = await createTestOptions(testContext);
  const missingSettingsPath = join(
    missingExplicitFixture.homeDirectory,
    "Library",
    "Application Support",
    "Code",
    "User",
    "absent.json",
  );

  await assert.rejects(
    setupBridge({
      ...missingExplicitFixture.options,
      vscodeSettingsPath: missingSettingsPath,
    }),
    new RegExp(`VS Code settings file does not exist: ${missingSettingsPath}`, "u"),
  );

  assert.equal(existsSync(missingSettingsPath), false);
});

function overdueMessageRecord(messageId: string): MessageStatusRecord {
  return {
    messageId,
    conversationId: "5cb1e2fd-5b24-4699-bfea-878e9b147370",
    sender: {
      runtime: "codex",
      sessionId: "8d6380bf-1b93-44b3-b3da-a1a661cf8b69",
      projectId: "0123456789abcdef01234567",
    },
    recipient: {
      runtime: "claude",
      sessionId: "ad65b1c1-7386-4465-80f9-4de0a26bc212",
      projectId: "0123456789abcdef01234567",
    },
    messageType: "question",
    contentDigest: "0".repeat(64),
    sentAt: "2026-09-04T10:00:00.000Z",
    createdAt: "2026-09-04T10:00:00.000Z",
    expiresAt: "2026-09-05T10:05:00.000Z",
    deadlineAt: "2026-09-04T10:05:00.000Z",
    transportState: "accepted",
    transportAcceptedAt: "2026-09-04T10:00:00.000Z",
    state: "accepted",
  };
}

test("doctor lists overdue receipts without mutating bridge state", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await installBridgeGlobally(fixture.options);
  const firstOverdueIdentifier = "6f2b1f9c-4b0e-4a3f-9c1d-2e5a7b8c9d01";
  const secondOverdueIdentifier = "7a3c2e8d-5c1f-4b2e-ab34-1d2e3f4a5b6c";

  const idleReport = await doctorBridgeInstallation({
    ...fixture.options,
    listActiveSessions: async () => [],
    listRunningClaudeProcessIdentifiers: async () => [],
    listOverdueMessages: async () => [],
  });
  const busyReport = await doctorBridgeInstallation({
    ...fixture.options,
    listActiveSessions: async () => [],
    listRunningClaudeProcessIdentifiers: async () => [],
    listOverdueMessages: async () => [
      overdueMessageRecord(firstOverdueIdentifier),
      overdueMessageRecord(secondOverdueIdentifier),
    ],
  });

  const idleOverdueCheck = idleReport.checks.find(({ name }) => name === "overdue_messages");
  assert.equal(idleOverdueCheck?.status, "info");
  assert.equal(idleOverdueCheck?.message, "No overdue message receipts");
  assert.equal(
    idleReport.checks.find(({ name }) => name === "state_hygiene"),
    undefined,
  );
  const busyOverdueCheck = busyReport.checks.find(({ name }) => name === "overdue_messages");
  assert.equal(busyOverdueCheck?.status, "info");
  assert.match(busyOverdueCheck?.message ?? "", /^2 overdue message receipts: /u);
  assert.match(busyOverdueCheck?.message ?? "", new RegExp(firstOverdueIdentifier, "u"));
  assert.match(busyOverdueCheck?.message ?? "", new RegExp(secondOverdueIdentifier, "u"));
  assert.equal(
    busyReport.checks.find(({ name }) => name === "state_hygiene"),
    undefined,
  );
  assert.equal(busyReport.ok, true);
});

test("doctor keeps receipt inspection failures informational", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await installBridgeGlobally(fixture.options);

  const report = await doctorBridgeInstallation({
    ...fixture.options,
    listActiveSessions: async () => [],
    listRunningClaudeProcessIdentifiers: async () => [],
    listOverdueMessages: async () => {
      throw new Error("receipt store is locked");
    },
  });

  const overdueCheck = report.checks.find(({ name }) => name === "overdue_messages");
  assert.equal(overdueCheck?.status, "info");
  assert.match(overdueCheck?.message ?? "", /receipt store is locked/u);
  assert.equal(report.ok, true);
});

test("doctor inspects overdue receipts without creating the messages directory", async (testContext) => {
  const fixture = await createTestOptions(testContext);
  await installBridgeGlobally(fixture.options);
  const messagesDirectory = join(fixture.stateHomeDirectory, "codex-claude-bridge", "messages");
  assert.equal(existsSync(messagesDirectory), false);

  const report = await doctorBridgeInstallation({
    ...fixture.options,
    listActiveSessions: async () => [],
    listRunningClaudeProcessIdentifiers: async () => [],
  });

  assert.equal(report.checks.find(({ name }) => name === "overdue_messages")?.status, "info");
  assert.equal(existsSync(messagesDirectory), false);
});
