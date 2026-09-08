import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  ChannelTransportError,
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
import {
  createMessageStatusStore,
  resolveMessageTimeoutMinutes,
  type MessageStatusRecord,
  type MessageStatusStore,
} from "../conversations/messageStatusStore.js";
import {
  waitForMessageStatus,
  type MessageDeliveryDiagnosis,
} from "../conversations/messageWatchdog.js";
import { runCodexSessionHookFromStandardInput } from "../hooks/codexSessionHook.js";
import {
  doctorBridgeInstallation,
  installBridgeGlobally,
  setupBridge,
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
import {
  cleanupOrphanedBridgeState,
  type BridgeStateCleanupSummary,
} from "../registry/stateHygiene.js";
import {
  launchBridgeRuntime,
  type BridgeRuntimeName,
} from "../wrapper/runtimeLauncher.js";

export interface BridgeSetupCommandOptions {
  configureVscode: boolean;
  vscodeSettingsPath?: string;
  confirmPendingCommandStopped: boolean;
}

export interface CommandLineDependencies {
  currentWorkingDirectory: string;
  currentDate: () => Date;
  randomIdentifier: () => string;
  resolveProjectIdentity: (workingDirectory: string) => Promise<string>;
  listActiveSessions: (
    filters?: ActiveSessionFilters,
  ) => Promise<ActiveSessionRecord[]>;
  conversationRouteStore: ConversationRouteStore;
  messageStatusStore: MessageStatusStore;
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
  cleanupBridgeState: () => Promise<BridgeStateCleanupSummary>;
  setupBridge: (
    writeOutput: (value: string) => void,
    setupOptions: BridgeSetupCommandOptions,
  ) => Promise<DoctorReport>;
  launchBridgeRuntime: (
    runtime: BridgeRuntimeName,
    argumentsList: string[],
  ) => Promise<number>;
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

const usageText = [
  "Usage: codex-claude-bridge <command> [options]",
  "",
  "Commands:",
  "  sessions [--runtime <claude|codex>] [--project <path>] [--json]",
  "  send --from <session> --to <session> --type <message|question|handoff>",
  "       --message <text> [--wait-minutes <minutes>] [--json]",
  "  reply --conversation <conversation-id> --message <text>",
  "       [--reply-to <message-id>] [--json]",
  "  ack --message <message-id> [--from <session>] [--json]",
  "  status --message <message-id> [--json]",
  "  clean [--json]",
  "  setup [--no-vscode] [--vscode-settings <path>]",
  "       [--confirm-pending-command-stopped]",
  "  launch <claude|codex> [runtime arguments...]",
  "  install --global [--confirm-pending-command-stopped]",
  "  uninstall --global [--confirm-pending-command-stopped]",
  "  doctor [--json]",
  "  help",
  "",
  "send --wait-minutes waits for an explicit receipt: seen for a message, replied",
  "for a question or a handoff. It exits 0 when that receipt arrives, 1 when the",
  "receipt is missing, 2 when the deadline passes without it, and 3 when the",
  "receipt store stays locked.",
  "",
].join("\n");

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

function addressesMatch(first: AgentAddress, second: AgentAddress): boolean {
  return (
    first.runtime === second.runtime &&
    first.sessionId === second.sessionId &&
    first.projectId === second.projectId
  );
}

function transportFailureOutcome(error: unknown): "unknown" | "failed" {
  return error instanceof ChannelTransportError &&
    (error.code === "ECONNREFUSED" || error.code === "ENOENT")
    ? "failed"
    : "unknown";
}

function channelTransportCode(error: unknown): string | undefined {
  if (error instanceof ChannelTransportError) {
    return error.code;
  }
  if (error instanceof AggregateError) {
    for (const nestedError of error.errors) {
      const nestedCode = channelTransportCode(nestedError);
      if (nestedCode !== undefined) {
        return nestedCode;
      }
    }
  }
  return undefined;
}

function describeCommandError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Command failed";
  const transportCode = channelTransportCode(error);
  return transportCode === undefined ? message : `${message} (${transportCode})`;
}

async function rollbackRouteAfterFailure(
  routeStore: ConversationRouteStore,
  reservation: Awaited<ReturnType<ConversationRouteStore["reserve"]>>,
  deliveryError: unknown,
): Promise<never> {
  try {
    await routeStore.rollback(reservation);
  } catch (rollbackError) {
    const deliveryMessage =
      deliveryError instanceof Error ? deliveryError.message : "Channel delivery failed";
    const rollbackMessage =
      rollbackError instanceof Error ? rollbackError.message : "route rollback failed";
    throw new AggregateError(
      [deliveryError, rollbackError],
      `${deliveryMessage}; route rollback failed: ${rollbackMessage}`,
    );
  }
  throw deliveryError;
}

interface TrackedDelivery {
  status: MessageStatusRecord;
  receiptWarning?: string;
}

function receiptUpdateWarning(messageId: string, error: unknown): string {
  return `Message ${messageId} was delivered but its receipt could not be updated: ${describeCommandError(error)}`;
}

async function createPendingReceipt(
  envelope: AgentMessageEnvelope,
  dependencies: CommandLineDependencies,
  reservation: Awaited<ReturnType<ConversationRouteStore["reserve"]>>,
): Promise<MessageStatusRecord> {
  try {
    return await dependencies.messageStatusStore.createPending(envelope);
  } catch (error) {
    return rollbackRouteAfterFailure(
      dependencies.conversationRouteStore,
      reservation,
      error,
    );
  }
}

async function deliverTrackedMessage(
  envelope: AgentMessageEnvelope,
  targetSession: ActiveSessionRecord,
  endpoints: ConversationRouteEndpoints,
  dependencies: CommandLineDependencies,
  condition?: ConversationRouteReservationCondition,
): Promise<TrackedDelivery> {
  const reservation = await dependencies.conversationRouteStore.reserve(
    envelope.conversationId,
    endpoints,
    condition,
  );
  const pendingStatus = await createPendingReceipt(
    envelope,
    dependencies,
    reservation,
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
    await dependencies.messageStatusStore
      .markTransportFailure(envelope.messageId, transportFailureOutcome(error))
      .catch(() => undefined);
    await rollbackRouteAfterFailure(
      dependencies.conversationRouteStore,
      reservation,
      error,
    );
  }
  try {
    return { status: await dependencies.messageStatusStore.markAccepted(envelope.messageId) };
  } catch (error) {
    return {
      status: pendingStatus,
      receiptWarning: receiptUpdateWarning(envelope.messageId, error),
    };
  }
}

function deliveryResultPayload(
  envelope: AgentMessageEnvelope,
  status: MessageStatusRecord,
  receiptWarning: string | undefined,
) {
  return {
    delivered: true,
    message_id: envelope.messageId,
    conversation_id: envelope.conversationId,
    acknowledgement: "transport acknowledgement only",
    status,
    ...(receiptWarning === undefined ? {} : { receipt_warning: receiptWarning }),
  };
}

function deliveryResultLine(
  envelope: AgentMessageEnvelope,
  status: MessageStatusRecord,
): string {
  return `Transport accepted message ${envelope.messageId} in conversation ${envelope.conversationId}; receipt state ${status.state}; transport acknowledgement only.\n`;
}

function writeDeliveryResult(
  envelope: AgentMessageEnvelope,
  delivery: TrackedDelivery,
  useJson: boolean,
  writeOutput: (value: string) => void,
  writeError: (value: string) => void,
): void {
  if (useJson) {
    writeOutput(
      `${JSON.stringify(deliveryResultPayload(envelope, delivery.status, delivery.receiptWarning))}\n`,
    );
  } else {
    writeOutput(deliveryResultLine(envelope, delivery.status));
  }
  if (delivery.receiptWarning !== undefined) {
    writeError(`${delivery.receiptWarning}\n`);
  }
}

function messageIsOverdue(record: MessageStatusRecord, now: Date): boolean {
  return (
    (record.messageType === "question" || record.messageType === "handoff") &&
    record.repliedAt === undefined &&
    record.transportState !== "failed" &&
    Date.parse(record.deadlineAt) <= now.getTime()
  );
}

function writeMessageStatus(
  record: MessageStatusRecord,
  now: Date,
  useJson: boolean,
  writeOutput: (value: string) => void,
): void {
  const overdue = messageIsOverdue(record, now);
  if (useJson) {
    writeOutput(
      `${JSON.stringify({
        message_id: record.messageId,
        conversation_id: record.conversationId,
        message_type: record.messageType,
        state: record.state,
        transport_state: record.transportState,
        sent_at: record.sentAt,
        transport_accepted_at: record.transportAcceptedAt ?? null,
        acknowledged_at: record.acknowledgedAt ?? null,
        replied_at: record.repliedAt ?? null,
        deadline_at: record.deadlineAt,
        overdue,
      })}\n`,
    );
    return;
  }
  writeOutput(
    `${[
      ["message_id", record.messageId],
      ["conversation_id", record.conversationId],
      ["message_type", record.messageType],
      ["state", record.state],
      ["transport_state", record.transportState],
      ["sent_at", record.sentAt],
      ["transport_accepted_at", record.transportAcceptedAt ?? "-"],
      ["acknowledged_at", record.acknowledgedAt ?? "-"],
      ["replied_at", record.repliedAt ?? "-"],
      ["deadline_at", record.deadlineAt],
      ["overdue", overdue ? "yes" : "no"],
    ]
      .map(([field, value]) => `${field}\t${value}`)
      .join("\n")}\n`,
  );
}

function parseWaitMinutes(rawValue: string): number {
  try {
    return resolveMessageTimeoutMinutes(Number(rawValue));
  } catch {
    throw new TypeError(
      "Argument --wait-minutes must be a number of minutes between 0.01 and 1440",
    );
  }
}

function formatDeliveryDiagnosis(diagnosis: MessageDeliveryDiagnosis): string {
  return `${Object.entries(diagnosis)
    .map(([field, value]) => `${field}\t${String(value)}`)
    .join("\n")}\n`;
}

async function waitForDeliveryReceipt(
  envelope: AgentMessageEnvelope,
  delivery: TrackedDelivery,
  waitMinutes: number,
  dependencies: CommandLineDependencies,
  useJson: boolean,
  writeOutput: (value: string) => void,
  writeError: (value: string) => void,
): Promise<number> {
  const deliveryPayload = deliveryResultPayload(
    envelope,
    delivery.status,
    delivery.receiptWarning,
  );
  if (!useJson) {
    writeOutput(deliveryResultLine(envelope, delivery.status));
  }
  if (delivery.receiptWarning !== undefined) {
    writeError(`${delivery.receiptWarning}\n`);
  }
  let waitResult;
  try {
    waitResult = await waitForMessageStatus({
      store: dependencies.messageStatusStore,
      messageId: envelope.messageId,
      waitMinutes,
      until: envelope.messageType === "message" ? "seen" : "replied",
      currentDate: dependencies.currentDate,
      ...(dependencies.stateHomeDirectory === undefined
        ? {}
        : { stateHomeDirectory: dependencies.stateHomeDirectory }),
    });
  } catch (error) {
    const waitErrorMessage = describeCommandError(error);
    if (useJson) {
      writeOutput(
        `${JSON.stringify({ ...deliveryPayload, wait_error: waitErrorMessage })}\n`,
      );
    }
    writeError(`${waitErrorMessage}\n`);
    return 1;
  }
  if (useJson) {
    writeOutput(
      `${JSON.stringify({
        ...deliveryPayload,
        status: waitResult.status ?? delivery.status,
        outcome: waitResult.outcome,
        ...(waitResult.reason === undefined ? {} : { reason: waitResult.reason }),
        ...(waitResult.diagnosis === undefined
          ? {}
          : { diagnosis: waitResult.diagnosis }),
      })}\n`,
    );
  } else {
    writeOutput(
      `Message ${envelope.messageId} ended the wait as ${waitResult.outcome}.\n`,
    );
  }
  if (waitResult.outcome === "seen" || waitResult.outcome === "replied") {
    return 0;
  }
  if (waitResult.outcome === "overdue") {
    if (waitResult.diagnosis !== undefined) {
      writeError(formatDeliveryDiagnosis(waitResult.diagnosis));
    }
    return 2;
  }
  if (waitResult.reason === "receipt_lock_timeout") {
    writeError(`receipt_lock_timeout\n`);
    return 3;
  }
  writeError(`no receipt for message ${envelope.messageId}\n`);
  return 1;
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
  writeError: (value: string) => void,
): Promise<number> {
  const options = parseOptions(argumentsList, {
    "--from": { takesValue: true, required: true },
    "--to": { takesValue: true, required: true },
    "--type": { takesValue: true, required: true },
    "--message": { takesValue: true, required: true },
    "--wait-minutes": { takesValue: true },
    "--json": { takesValue: false },
  });
  const useJson = options["--json"] === true;
  const requestedWaitMinutes = options["--wait-minutes"];
  const waitMinutes =
    typeof requestedWaitMinutes === "string"
      ? parseWaitMinutes(requestedWaitMinutes)
      : undefined;
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
  const delivery = await deliverTrackedMessage(
    envelope,
    target,
    endpoints,
    dependencies,
  );
  if (waitMinutes === undefined) {
    writeDeliveryResult(envelope, delivery, useJson, writeOutput, writeError);
    return 0;
  }
  return waitForDeliveryReceipt(
    envelope,
    delivery,
    waitMinutes,
    dependencies,
    useJson,
    writeOutput,
    writeError,
  );
}

async function resolveReplyTarget(
  conversationIdentifier: string,
  route: { codex: AgentAddress; claude: AgentAddress },
  requestedReplyTarget: string | true | undefined,
  dependencies: CommandLineDependencies,
): Promise<MessageStatusRecord | undefined> {
  if (typeof requestedReplyTarget !== "string") {
    return dependencies.messageStatusStore.findReplyTarget(
      conversationIdentifier,
      route.codex,
    );
  }
  const replyTargetIdentifier = uuidSchema.parse(requestedReplyTarget);
  const replyTarget =
    await dependencies.messageStatusStore.get(replyTargetIdentifier);
  if (
    replyTarget === undefined ||
    replyTarget.conversationId !== conversationIdentifier ||
    !addressesMatch(replyTarget.recipient, route.codex) ||
    !addressesMatch(replyTarget.sender, route.claude) ||
    replyTarget.repliedAt !== undefined
  ) {
    throw new Error(
      `Message "${replyTargetIdentifier}" is not an unanswered message addressed to this Codex session`,
    );
  }
  return replyTarget;
}

async function resolveReceivingCodexSession(
  record: MessageStatusRecord,
  requestedSelector: string | true | undefined,
  dependencies: CommandLineDependencies,
): Promise<ActiveSessionRecord> {
  if (record.recipient.runtime !== "codex") {
    throw new Error(
      `Message ${record.messageId} was not addressed to a Codex session`,
    );
  }
  if (typeof requestedSelector === "string") {
    const selectedSession = await selectSession(
      requestedSelector,
      "codex",
      record.recipient.projectId,
      dependencies,
    );
    if (!addressesMatch(sessionAddress(selectedSession), record.recipient)) {
      throw new Error(
        `Session "${requestedSelector}" did not receive message ${record.messageId}`,
      );
    }
    return selectedSession;
  }
  const receivingSession = (
    await dependencies.listActiveSessions({
      runtime: "codex",
      projectId: record.recipient.projectId,
    })
  ).find((session) => addressesMatch(sessionAddress(session), record.recipient));
  if (receivingSession === undefined) {
    throw new Error(
      `No active codex session matches "${record.recipient.sessionId}"`,
    );
  }
  return receivingSession;
}

async function runAcknowledgeCommand(
  argumentsList: string[],
  dependencies: CommandLineDependencies,
  writeOutput: (value: string) => void,
): Promise<void> {
  const options = parseOptions(argumentsList, {
    "--message": { takesValue: true, required: true },
    "--from": { takesValue: true },
    "--json": { takesValue: false },
  });
  const messageIdentifier = uuidSchema.parse(optionValue(options, "--message"));
  const record = await dependencies.messageStatusStore.get(messageIdentifier);
  if (record === undefined) {
    throw new Error(`no receipt for message ${messageIdentifier}`);
  }
  const receivingSession = await resolveReceivingCodexSession(
    record,
    options["--from"],
    dependencies,
  );
  const status = await dependencies.messageStatusStore.markSeen(
    messageIdentifier,
    sessionAddress(receivingSession),
  );
  writeMessageStatus(
    status,
    dependencies.currentDate(),
    options["--json"] === true,
    writeOutput,
  );
}

async function runStatusCommand(
  argumentsList: string[],
  dependencies: CommandLineDependencies,
  writeOutput: (value: string) => void,
  writeError: (value: string) => void,
): Promise<number> {
  const options = parseOptions(argumentsList, {
    "--message": { takesValue: true, required: true },
    "--json": { takesValue: false },
  });
  const messageIdentifier = uuidSchema.parse(optionValue(options, "--message"));
  const record = await dependencies.messageStatusStore.get(messageIdentifier);
  if (record === undefined) {
    writeError(`no receipt for message ${messageIdentifier}\n`);
    return 1;
  }
  writeMessageStatus(
    record,
    dependencies.currentDate(),
    options["--json"] === true,
    writeOutput,
  );
  return 0;
}

async function correlateDeliveredReply(
  replyTarget: MessageStatusRecord,
  envelope: AgentMessageEnvelope,
  replyingCodexAddress: AgentAddress,
  dependencies: CommandLineDependencies,
): Promise<string | undefined> {
  try {
    await dependencies.messageStatusStore.markReplied(
      replyTarget.messageId,
      replyingCodexAddress,
      envelope.messageId,
    );
    return undefined;
  } catch (error) {
    return receiptUpdateWarning(envelope.messageId, error);
  }
}

async function runReplyCommand(
  argumentsList: string[],
  dependencies: CommandLineDependencies,
  writeOutput: (value: string) => void,
  writeError: (value: string) => void,
): Promise<void> {
  const options = parseOptions(argumentsList, {
    "--conversation": { takesValue: true, required: true },
    "--message": { takesValue: true, required: true },
    "--reply-to": { takesValue: true },
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
  const replyTarget = await resolveReplyTarget(
    conversationIdentifier,
    route,
    options["--reply-to"],
    dependencies,
  );
  const envelope = createEnvelope(dependencies, {
    conversationId: conversationIdentifier,
    messageType: "reply",
    sender: route.codex,
    recipient: route.claude,
    content: optionValue(options, "--message"),
    replyRoute: route.codex,
    ...(replyTarget === undefined
      ? {}
      : { replyToMessageId: replyTarget.messageId }),
  });
  const delivery = await deliverTrackedMessage(
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
  const correlationWarning =
    replyTarget === undefined
      ? undefined
      : await correlateDeliveredReply(
          replyTarget,
          envelope,
          route.codex,
          dependencies,
        );
  writeDeliveryResult(
    envelope,
    {
      status: delivery.status,
      receiptWarning: delivery.receiptWarning ?? correlationWarning,
    },
    options["--json"] === true,
    writeOutput,
    writeError,
  );
}

async function runCleanCommand(
  argumentsList: string[],
  dependencies: CommandLineDependencies,
  writeOutput: (value: string) => void,
): Promise<void> {
  const options = parseOptions(argumentsList, { "--json": { takesValue: false } });
  const summary = await dependencies.cleanupBridgeState();
  if (options["--json"] === true) {
    writeOutput(
      `${JSON.stringify({
        removed_sockets: summary.removedSockets,
        removed_session_records: summary.removedSessionRecords,
        skipped: summary.skipped.map(({ path, reason }) => ({ path, reason })),
      })}\n`,
    );
    return;
  }
  writeOutput(
    `${[
      `removed_sockets\t${summary.removedSockets}`,
      `removed_session_records\t${summary.removedSessionRecords}`,
      ...summary.skipped.map(({ path, reason }) => `skipped\t${path}\t${reason}`),
    ].join("\n")}\n`,
  );
}

function createDefaultDependencies(): CommandLineDependencies {
  return {
    currentWorkingDirectory: process.cwd(),
    currentDate: () => new Date(),
    randomIdentifier: randomUUID,
    resolveProjectIdentity,
    listActiveSessions: (filters = {}) => listActiveSessions(filters),
    conversationRouteStore: createConversationRouteStore(),
    messageStatusStore: createMessageStatusStore(),
    deliverClaudeMessage,
    runCodexSessionHookFromStandardInput,
    startClaudeChannelServer,
    installBridgeGlobally: (writeOutput, confirmPendingCommandStopped) =>
      installBridgeGlobally({ writeOutput, confirmPendingCommandStopped }),
    uninstallBridgeGlobally: (writeOutput, confirmPendingCommandStopped) =>
      uninstallBridgeGlobally({ writeOutput, confirmPendingCommandStopped }),
    doctorBridgeInstallation: () => doctorBridgeInstallation(),
    cleanupBridgeState: () => cleanupOrphanedBridgeState(),
    setupBridge: (writeOutput, setupOptions) =>
      setupBridge({ writeOutput, ...setupOptions }),
    launchBridgeRuntime,
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

function parseSetupOptions(argumentsList: string[]): BridgeSetupCommandOptions {
  const options = parseOptions(argumentsList, {
    "--no-vscode": { takesValue: false },
    "--vscode-settings": { takesValue: true },
    "--confirm-pending-command-stopped": { takesValue: false },
  });
  const vscodeSettingsPath = options["--vscode-settings"];
  if (options["--no-vscode"] === true && vscodeSettingsPath !== undefined) {
    throw new TypeError(
      "Arguments --no-vscode and --vscode-settings cannot be combined",
    );
  }
  return {
    configureVscode: options["--no-vscode"] !== true,
    ...(typeof vscodeSettingsPath === "string" ? { vscodeSettingsPath } : {}),
    confirmPendingCommandStopped:
      options["--confirm-pending-command-stopped"] === true,
  };
}

function writeSetupNextSteps(writeOutput: (value: string) => void): void {
  writeOutput(
    [
      "Next steps:",
      "  codex-claude-bridge launch claude",
      "  codex-claude-bridge launch codex",
      "Approve the Claude development Channel prompt and the Codex hook-trust prompt once per machine.",
      "Optional: codex-claude-bridge clean removes sockets left by crashed sessions.",
      "",
    ].join("\n"),
  );
}

function parseLaunchRuntime(runtimeName: string | undefined): BridgeRuntimeName {
  if (runtimeName !== "claude" && runtimeName !== "codex") {
    throw new TypeError(
      "Usage: codex-claude-bridge launch <claude|codex> [runtime arguments...]",
    );
  }
  return runtimeName;
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
        return await runSendCommand(
          commandArguments,
          dependencies,
          writeOutput,
          writeError,
        );
      case "reply":
        await runReplyCommand(
          commandArguments,
          dependencies,
          writeOutput,
          writeError,
        );
        break;
      case "clean":
        await runCleanCommand(commandArguments, dependencies, writeOutput);
        break;
      case "ack":
        await runAcknowledgeCommand(commandArguments, dependencies, writeOutput);
        break;
      case "status":
        return await runStatusCommand(
          commandArguments,
          dependencies,
          writeOutput,
          writeError,
        );
      case "codex-session-hook":
        parseOptions(commandArguments, {});
        await dependencies.runCodexSessionHookFromStandardInput();
        break;
      case "claude-channel":
        parseOptions(commandArguments, {});
        await dependencies.startClaudeChannelServer();
        break;
      case "setup": {
        const report = await dependencies.setupBridge(
          writeOutput,
          parseSetupOptions(commandArguments),
        );
        writeDoctorReport(report, false, writeOutput);
        writeSetupNextSteps(writeOutput);
        return report.ok ? 0 : 1;
      }
      case "launch": {
        const [runtimeName, ...runtimeArguments] = commandArguments;
        return await dependencies.launchBridgeRuntime(
          parseLaunchRuntime(runtimeName),
          runtimeArguments,
        );
      }
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
      case "help":
      case "--help":
        parseOptions(commandArguments, {});
        writeOutput(usageText);
        break;
      default:
        throw new TypeError(
          `${command === undefined ? "Missing command" : `Unknown command: ${command}`}; run codex-claude-bridge help`,
        );
    }
    return 0;
  } catch (error) {
    writeError(`${describeCommandError(error)}\n`);
    return 1;
  }
}

export async function runCommandLineFromProcess(): Promise<number> {
  return runCommandLine({ arguments: process.argv.slice(2) });
}
