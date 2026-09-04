import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  deliverClaudeMessage,
  type DeliverClaudeMessageOptions,
} from "../channel/channelSocketClient.js";
import { startClaudeChannelServer } from "../channel/claudeChannelServer.js";
import {
  createConversationRouteStore,
  type ConversationRouteEndpoints,
  type ConversationRouteReservationCondition,
  type ConversationRouteStore,
} from "../conversations/conversationRoutes.js";
import { runCodexSessionHookFromStandardInput } from "../hooks/codexSessionHook.js";
import {
  doctorBridgeInstallation,
  installBridgeGlobally,
  uninstallBridgeGlobally,
  type DoctorReport,
} from "../install/globalInstaller.js";
import {
  AgentRuntime,
  parseAgentMessageEnvelope,
  uuidSchema,
  type AgentAddress,
  type AgentMessageEnvelope,
} from "../protocol/messageEnvelope.js";
import {
  listActiveSessions,
  type ActiveSessionFilters,
  type ActiveSessionRecord,
} from "../registry/activeSessionRegistry.js";
import { resolveProjectIdentity } from "../registry/projectIdentity.js";

export interface CommandLineDependencies {
  currentWorkingDirectory: string;
  currentDate: () => Date;
  randomIdentifier: () => string;
  resolveProjectIdentity: (workingDirectory: string) => Promise<string>;
  listActiveSessions: (
    filters?: ActiveSessionFilters,
  ) => Promise<ActiveSessionRecord[]>;
  conversationRouteStore: ConversationRouteStore;
  deliverClaudeMessage: (
    options: DeliverClaudeMessageOptions,
  ) => ReturnType<typeof deliverClaudeMessage>;
  runCodexSessionHookFromStandardInput: () => Promise<void>;
  startClaudeChannelServer: () => Promise<unknown>;
  installBridgeGlobally: (
    writeOutput: (value: string) => void,
    confirmPendingCommandStopped: boolean,
  ) => Promise<void>;
  uninstallBridgeGlobally: (
    writeOutput: (value: string) => void,
    confirmPendingCommandStopped: boolean,
  ) => Promise<void>;
  doctorBridgeInstallation: () => Promise<DoctorReport>;
  stateHomeDirectory?: string;
}

export interface RunCommandLineOptions {
  arguments: string[];
  dependencies?: CommandLineDependencies;
  writeOutput?: (value: string) => void;
  writeError?: (value: string) => void;
}

interface OptionDefinition {
  takesValue: boolean;
  required?: boolean;
}

type ParsedOptions = Record<string, string | true>;

const sendMessageTypeSchema = z.enum(["message", "question", "handoff"]);

function parseOptions(
  argumentsList: string[],
  definitions: Record<string, OptionDefinition>,
): ParsedOptions {
  const parsedOptions: ParsedOptions = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const optionName = argumentsList[index];
    const definition = definitions[optionName];
    if (definition === undefined) {
      throw new TypeError(`Unknown argument: ${optionName}`);
    }
    if (Object.hasOwn(parsedOptions, optionName)) {
      throw new TypeError(`Duplicate argument: ${optionName}`);
    }
    if (!definition.takesValue) {
      parsedOptions[optionName] = true;
      continue;
    }
    const optionValue = argumentsList[index + 1];
    if (optionValue === undefined) {
      throw new TypeError(`Missing value for argument: ${optionName}`);
    }
    parsedOptions[optionName] = optionValue;
    index += 1;
  }

  for (const [optionName, definition] of Object.entries(definitions)) {
    if (definition.required && !Object.hasOwn(parsedOptions, optionName)) {
      throw new TypeError(`Missing required argument: ${optionName}`);
    }
  }
  return parsedOptions;
}

function optionValue(options: ParsedOptions, optionName: string): string {
  const value = options[optionName];
  if (typeof value !== "string") {
    throw new TypeError(`Missing required argument: ${optionName}`);
  }
  return value;
}

function sessionAddress(session: ActiveSessionRecord): AgentAddress {
  return {
    runtime: session.runtime,
    sessionId: session.sessionId,
    projectId: session.projectId,
  };
}

function createEnvelope(
  dependencies: CommandLineDependencies,
  input: Omit<AgentMessageEnvelope, "schemaVersion" | "messageId" | "sentAt">,
): AgentMessageEnvelope {
  return parseAgentMessageEnvelope({
    ...input,
    schemaVersion: 1,
    messageId: dependencies.randomIdentifier(),
    sentAt: dependencies.currentDate().toISOString(),
  });
}

async function selectSession(
  identifier: string,
  runtime: "codex" | "claude",
  displayNameProjectIdentifier: string,
  dependencies: CommandLineDependencies,
): Promise<ActiveSessionRecord> {
  if (identifier.length === 0 || identifier.includes("\0")) {
    throw new TypeError("Session selector must not be empty");
  }
  const identifierIsUuid = uuidSchema.safeParse(identifier).success;
  const sessions = await dependencies.listActiveSessions({
    runtime,
    ...(identifierIsUuid
      ? {}
      : { projectId: displayNameProjectIdentifier }),
  });
  const matches = sessions.filter((session) =>
    identifierIsUuid
      ? session.sessionId === identifier
      : session.displayName === identifier,
  );
  const candidates = (matches.length > 0 ? matches : sessions)
    .map((session) => `${session.displayName} (${session.sessionId})`)
    .join(", ");
  if (matches.length === 0) {
    throw new Error(
      `No active ${runtime} session matches "${identifier}". Active candidates: ${candidates || "none"}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `${runtime} session selector "${identifier}" is ambiguous; use a session UUID. Matching candidates: ${candidates}`,
    );
  }
  return matches[0];
}

async function resolveExactClaudeTarget(
  address: AgentAddress,
  dependencies: CommandLineDependencies,
): Promise<ActiveSessionRecord> {
  const sessions = await dependencies.listActiveSessions({
    runtime: "claude",
    projectId: address.projectId,
  });
  const target = sessions.find(
    (session) => session.sessionId === address.sessionId,
  );
  if (target === undefined) {
    throw new Error(`No active claude session matches "${address.sessionId}"`);
  }
  return target;
}

async function deliverWithReservedRoute(
  envelope: AgentMessageEnvelope,
  targetSession: ActiveSessionRecord,
  endpoints: ConversationRouteEndpoints,
  dependencies: CommandLineDependencies,
  condition?: ConversationRouteReservationCondition,
): Promise<void> {
  const reservation = await dependencies.conversationRouteStore.reserve(
    envelope.conversationId,
    endpoints,
    condition,
  );
  try {
    const response = await dependencies.deliverClaudeMessage({
      targetSession,
      envelope,
      stateHomeDirectory: dependencies.stateHomeDirectory,
    });
    if (!response.delivered) {
      throw new Error(response.error);
    }
    if (response.messageId !== envelope.messageId) {
      throw new Error("Channel acknowledgement message ID does not match");
    }
  } catch (error) {
    try {
      await dependencies.conversationRouteStore.rollback(reservation);
    } catch (rollbackError) {
      const deliveryMessage =
        error instanceof Error ? error.message : "Channel delivery failed";
      const rollbackMessage =
        rollbackError instanceof Error
          ? rollbackError.message
          : "route rollback failed";
      throw new AggregateError(
        [error, rollbackError],
        `${deliveryMessage}; route rollback failed: ${rollbackMessage}`,
      );
    }
    throw error;
  }
}

function writeDeliveryResult(
  envelope: AgentMessageEnvelope,
  useJson: boolean,
  writeOutput: (value: string) => void,
): void {
  if (useJson) {
    writeOutput(
      `${JSON.stringify({
        delivered: true,
        message_id: envelope.messageId,
        conversation_id: envelope.conversationId,
        acknowledgement: "transport acknowledgement only",
      })}\n`,
    );
    return;
  }
  writeOutput(
    `Transport accepted message ${envelope.messageId} in conversation ${envelope.conversationId}; transport acknowledgement only.\n`,
  );
}

async function runSessionsCommand(
  argumentsList: string[],
  dependencies: CommandLineDependencies,
  writeOutput: (value: string) => void,
): Promise<void> {
  const options = parseOptions(argumentsList, {
    "--runtime": { takesValue: true },
    "--project": { takesValue: true },
    "--json": { takesValue: false },
  });
  const runtime =
    typeof options["--runtime"] === "string"
      ? AgentRuntime.parse(options["--runtime"])
      : undefined;
  const projectIdentifier =
    typeof options["--project"] === "string"
      ? await dependencies.resolveProjectIdentity(options["--project"])
      : undefined;
  const sessions = (
    await dependencies.listActiveSessions({
      ...(runtime === undefined ? {} : { runtime }),
      ...(projectIdentifier === undefined
        ? {}
        : { projectId: projectIdentifier }),
    })
  ).sort((firstSession, secondSession) =>
    firstSession.sessionId.localeCompare(secondSession.sessionId),
  );

  if (options["--json"] === true) {
    writeOutput(
      `${JSON.stringify({
        sessions: sessions.map((session) => ({
          runtime: session.runtime,
          session_id: session.sessionId,
          display_name: session.displayName,
          project_id: session.projectId,
          working_directory: session.workingDirectory,
        })),
      })}\n`,
    );
    return;
  }
  if (sessions.length > 0) {
    writeOutput(
      `${sessions
        .map((session) =>
          [
            session.runtime,
            session.sessionId,
            session.displayName,
            session.projectId,
            session.workingDirectory,
          ].join("\t"),
        )
        .join("\n")}\n`,
    );
  }
}

async function runSendCommand(
  argumentsList: string[],
  dependencies: CommandLineDependencies,
  writeOutput: (value: string) => void,
): Promise<void> {
  const options = parseOptions(argumentsList, {
    "--from": { takesValue: true, required: true },
    "--to": { takesValue: true, required: true },
    "--type": { takesValue: true, required: true },
    "--message": { takesValue: true, required: true },
    "--json": { takesValue: false },
  });
  const currentProjectIdentifier = await dependencies.resolveProjectIdentity(
    dependencies.currentWorkingDirectory,
  );
  const source = await selectSession(
    optionValue(options, "--from"),
    "codex",
    currentProjectIdentifier,
    dependencies,
  );
  const target = await selectSession(
    optionValue(options, "--to"),
    "claude",
    source.projectId,
    dependencies,
  );
  const endpoints: ConversationRouteEndpoints = {
    codex: sessionAddress(source) as ConversationRouteEndpoints["codex"],
    claude: sessionAddress(target) as ConversationRouteEndpoints["claude"],
    codexCanReply: false,
    claudeCanReply: true,
  };
  const envelope = createEnvelope(dependencies, {
    conversationId: uuidSchema.parse(dependencies.randomIdentifier()),
    messageType: sendMessageTypeSchema.parse(optionValue(options, "--type")),
    sender: endpoints.codex,
    recipient: endpoints.claude,
    content: optionValue(options, "--message"),
    replyRoute: endpoints.codex,
  });
  await deliverWithReservedRoute(envelope, target, endpoints, dependencies);
  writeDeliveryResult(envelope, options["--json"] === true, writeOutput);
}

async function runReplyCommand(
  argumentsList: string[],
  dependencies: CommandLineDependencies,
  writeOutput: (value: string) => void,
): Promise<void> {
  const options = parseOptions(argumentsList, {
    "--conversation": { takesValue: true, required: true },
    "--message": { takesValue: true, required: true },
    "--json": { takesValue: false },
  });
  const conversationIdentifier = uuidSchema.parse(
    optionValue(options, "--conversation"),
  );
  const route = await dependencies.conversationRouteStore.findActive(
    conversationIdentifier,
  );
  if (route === undefined) {
    throw new Error(`No active route for conversation "${conversationIdentifier}"`);
  }
  if (!route.codexCanReply) {
    throw new Error(`Conversation "${conversationIdentifier}" does not authorize a Codex reply`);
  }
  const target = await resolveExactClaudeTarget(route.claude, dependencies);
  const envelope = createEnvelope(dependencies, {
    conversationId: conversationIdentifier,
    messageType: "reply",
    sender: route.codex,
    recipient: route.claude,
    content: optionValue(options, "--message"),
    replyRoute: route.codex,
  });
  await deliverWithReservedRoute(
    envelope,
    target,
    {
      codex: route.codex,
      claude: route.claude,
      codexCanReply: false,
      claudeCanReply: true,
    },
    dependencies,
    {
      expectedGenerationId: route.generationId,
      requiredReplyCapability: "codex",
    },
  );
  writeDeliveryResult(envelope, options["--json"] === true, writeOutput);
}

function createDefaultDependencies(): CommandLineDependencies {
  return {
    currentWorkingDirectory: process.cwd(),
    currentDate: () => new Date(),
    randomIdentifier: randomUUID,
    resolveProjectIdentity,
    listActiveSessions: (filters = {}) => listActiveSessions(filters),
    conversationRouteStore: createConversationRouteStore(),
    deliverClaudeMessage,
    runCodexSessionHookFromStandardInput,
    startClaudeChannelServer,
    installBridgeGlobally: (writeOutput, confirmPendingCommandStopped) =>
      installBridgeGlobally({ writeOutput, confirmPendingCommandStopped }),
    uninstallBridgeGlobally: (writeOutput, confirmPendingCommandStopped) =>
      uninstallBridgeGlobally({ writeOutput, confirmPendingCommandStopped }),
    doctorBridgeInstallation: () => doctorBridgeInstallation(),
  };
}

function writeDoctorReport(
  report: DoctorReport,
  useJson: boolean,
  writeOutput: (value: string) => void,
): void {
  if (useJson) {
    writeOutput(`${JSON.stringify(report)}\n`);
    return;
  }
  writeOutput(
    `${report.checks
      .map(
        (check) =>
          `${check.status.toUpperCase()}\t${check.name}\t${check.message}`,
      )
      .join("\n")}\n`,
  );
}

export async function runCommandLine(options: RunCommandLineOptions): Promise<number> {
  const dependencies = options.dependencies ?? createDefaultDependencies();
  const writeOutput = options.writeOutput ?? ((value: string) => process.stdout.write(value));
  const writeError = options.writeError ?? ((value: string) => process.stderr.write(value));
  const [command, ...commandArguments] = options.arguments;
  try {
    switch (command) {
      case "sessions":
        await runSessionsCommand(commandArguments, dependencies, writeOutput);
        break;
      case "send":
        await runSendCommand(commandArguments, dependencies, writeOutput);
        break;
      case "reply":
        await runReplyCommand(commandArguments, dependencies, writeOutput);
        break;
      case "codex-session-hook":
        parseOptions(commandArguments, {});
        await dependencies.runCodexSessionHookFromStandardInput();
        break;
      case "claude-channel":
        parseOptions(commandArguments, {});
        await dependencies.startClaudeChannelServer();
        break;
      case "install":
        {
          const installOptions = parseOptions(commandArguments, {
            "--global": { takesValue: false, required: true },
            "--confirm-pending-command-stopped": { takesValue: false },
          });
          await dependencies.installBridgeGlobally(
            writeOutput,
            installOptions["--confirm-pending-command-stopped"] === true,
          );
        }
        break;
      case "uninstall":
        {
          const uninstallOptions = parseOptions(commandArguments, {
            "--global": { takesValue: false, required: true },
            "--confirm-pending-command-stopped": { takesValue: false },
          });
          await dependencies.uninstallBridgeGlobally(
            writeOutput,
            uninstallOptions["--confirm-pending-command-stopped"] === true,
          );
        }
        break;
      case "doctor": {
        const doctorOptions = parseOptions(commandArguments, {
          "--json": { takesValue: false },
        });
        const report = await dependencies.doctorBridgeInstallation();
        writeDoctorReport(report, doctorOptions["--json"] === true, writeOutput);
        return report.ok ? 0 : 1;
      }
      default:
        throw new TypeError(
          command === undefined ? "Missing command" : `Unknown command: ${command}`,
        );
    }
    return 0;
  } catch (error) {
    writeError(`${error instanceof Error ? error.message : "Command failed"}\n`);
    return 1;
  }
}

export async function runCommandLineFromProcess(): Promise<number> {
  return runCommandLine({ arguments: process.argv.slice(2) });
}
