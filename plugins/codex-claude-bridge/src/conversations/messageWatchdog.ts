import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { inspectActiveSessionsReadOnly } from "../install/readOnlySessionInspector.js";
import type { AgentAddress } from "../protocol/messageEnvelope.js";
import type { ActiveSessionRecord } from "../registry/activeSessionRegistry.js";
import {
  MessageStatusLockTimeoutError,
  resolveMessageTimeoutMinutes,
  type MessageStatusRecord,
  type MessageStatusStore,
} from "./messageStatusStore.js";

export interface MessageDeliveryDiagnosis {
  messageId: string;
  state: MessageStatusRecord["state"];
  transportState: MessageStatusRecord["transportState"];
  targetSessionAvailable: boolean;
  targetPidAlive: true | "unknown";
  socketAcceptsConnection: true | "unknown" | "not_applicable";
  channelLoaded: "agent_acknowledged" | "unknown" | "not_applicable";
  queueVisibility: "agent_acknowledged" | "unknown" | "not_applicable";
  inspectionFailed: boolean;
  diagnosticAttempts: number;
  taskRetransmitted: false;
  action: string;
}

export interface DiagnoseMessageOptions {
  stateHomeDirectory?: string;
  inspectSessions?: () => Promise<ActiveSessionRecord[]>;
  retryDelayMilliseconds?: number;
  signal?: AbortSignal;
}

function matchesAddress(session: ActiveSessionRecord, address: AgentAddress): boolean {
  return session.runtime === address.runtime && session.sessionId === address.sessionId &&
    session.projectId === address.projectId;
}

export async function diagnoseMessageDelivery(
  record: MessageStatusRecord,
  options: DiagnoseMessageOptions = {},
): Promise<MessageDeliveryDiagnosis> {
  const inspectSessions = options.inspectSessions ?? (() => inspectActiveSessionsReadOnly(options.stateHomeDirectory));
  const retryDelayMilliseconds = z.number().int().min(0).max(5_000).parse(options.retryDelayMilliseconds ?? 200);
  let targetSession: ActiveSessionRecord | undefined;
  let inspectionFailed = false;
  let diagnosticAttempts = 0;
  for (; diagnosticAttempts < 3;) {
    options.signal?.throwIfAborted();
    diagnosticAttempts += 1;
    try {
      targetSession = (await inspectSessions()).find((session) => matchesAddress(session, record.recipient));
      inspectionFailed = false;
    } catch {
      inspectionFailed = true;
    }
    if (targetSession !== undefined) break;
    if (diagnosticAttempts < 3) await delay(retryDelayMilliseconds, undefined, { signal: options.signal });
  }
  options.signal?.throwIfAborted();
  const acknowledged = record.acknowledgedAt !== undefined;
  return {
    messageId: record.messageId,
    state: record.state,
    transportState: record.transportState,
    targetSessionAvailable: targetSession !== undefined,
    targetPidAlive: targetSession === undefined ? "unknown" : true,
    socketAcceptsConnection: record.recipient.runtime === "codex" ? "not_applicable" :
      targetSession === undefined ? "unknown" : true,
    channelLoaded: record.recipient.runtime === "codex" ? "not_applicable" :
      acknowledged ? "agent_acknowledged" : "unknown",
    queueVisibility: record.recipient.runtime === "claude" ? "not_applicable" :
      acknowledged ? "agent_acknowledged" : "unknown",
    inspectionFailed,
    diagnosticAttempts,
    taskRetransmitted: false,
    action: targetSession === undefined
      ? "Run doctor and verify the exact target session and its startup configuration. Reconnect explicitly if the session ended."
      : acknowledged
        ? "The agent acknowledged the message but has not replied. Check its progress or pending approval in that session."
        : "The transport is reachable but agent receipt is unconfirmed. Check Channel activation or queue processing in the target session.",
  };
}

export interface WaitForMessageOptions extends DiagnoseMessageOptions {
  store: MessageStatusStore;
  messageId: string;
  waitMinutes?: number;
  pollIntervalMilliseconds?: number;
  currentDate?: () => Date;
  until?: "seen" | "replied";
}

export async function waitForMessageStatus(options: WaitForMessageOptions): Promise<{
  status?: MessageStatusRecord;
  outcome: "seen" | "replied" | "overdue" | "missing" | "unknown";
  reason?: "receipt_lock_timeout";
  diagnosis?: MessageDeliveryDiagnosis;
}> {
  const waitMinutes = resolveMessageTimeoutMinutes(options.waitMinutes);
  const until = z.enum(["seen", "replied"]).parse(options.until ?? "seen");
  const pollInterval = z.number().int().min(10).max(5_000).parse(options.pollIntervalMilliseconds ?? 1_000);
  const currentDate = options.currentDate ?? (() => new Date());
  const deadline = currentDate().getTime() + waitMinutes * 60_000;
  if (!Number.isFinite(deadline)) throw new Error("Wait clock is invalid");
  const readStatusUntilDeadline = async (): Promise<MessageStatusRecord | undefined | null> => {
    for (;;) {
      options.signal?.throwIfAborted();
      try {
        return await options.store.get(options.messageId);
      } catch (error) {
        if (!(error instanceof MessageStatusLockTimeoutError)) throw error;
        options.signal?.throwIfAborted();
        const remainingMilliseconds = deadline - currentDate().getTime();
        if (!Number.isFinite(remainingMilliseconds)) throw new Error("Wait clock is invalid");
        if (remainingMilliseconds <= 0) return null;
        await delay(Math.min(pollInterval, remainingMilliseconds), undefined, { signal: options.signal });
      }
    }
  };
  for (;;) {
    options.signal?.throwIfAborted();
    const status = await readStatusUntilDeadline();
    if (status === null) return { outcome: "unknown", reason: "receipt_lock_timeout" };
    if (status === undefined) return { outcome: "missing" };
    if (status.state === "replied" || (until === "seen" && status.state === "seen")) {
      return { status, outcome: status.state };
    }
    const remainingMilliseconds = deadline - currentDate().getTime();
    if (!Number.isFinite(remainingMilliseconds)) throw new Error("Wait clock is invalid");
    if (remainingMilliseconds <= 0) {
      const diagnosis = await diagnoseMessageDelivery(status, options);
      const latestStatus = await readStatusUntilDeadline();
      if (latestStatus === null) return { outcome: "unknown", reason: "receipt_lock_timeout" };
      if (latestStatus?.state === "replied" || (until === "seen" && latestStatus?.state === "seen")) {
        return { status: latestStatus, outcome: latestStatus.state };
      }
      return latestStatus === undefined ? { outcome: "missing" } : { status: latestStatus, outcome: "overdue", diagnosis };
    }
    await delay(Math.min(pollInterval, remainingMilliseconds), undefined, { signal: options.signal });
  }
}

export function createMessageWatchdog(options: DiagnoseMessageOptions & {
  store: MessageStatusStore;
  sender: AgentAddress;
  notify: (record: MessageStatusRecord, diagnosis: MessageDeliveryDiagnosis) => Promise<void>;
  intervalMilliseconds?: number;
}): { check(): Promise<void>; close(): Promise<void> } {
  const intervalMilliseconds = z.number().int().min(10).max(60_000).parse(options.intervalMilliseconds ?? 30_000);
  const stopController = new AbortController();
  const signal = options.signal === undefined ? stopController.signal : AbortSignal.any([options.signal, stopController.signal]);
  const notifiedMessages = new Set<string>();
  const notificationAttempts = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeCheck: Promise<void> | undefined;

  const check = (): Promise<void> => {
    if (signal.aborted) return Promise.resolve();
    if (activeCheck !== undefined) return activeCheck;
    activeCheck = (async () => {
      const overdueMessages = (await options.store.listOverdue()).filter((record) =>
        record.sender.runtime === options.sender.runtime &&
        record.sender.sessionId === options.sender.sessionId && record.sender.projectId === options.sender.projectId,
      );
      const overdueIdentifiers = new Set(overdueMessages.map((record) => record.messageId));
      for (const identifier of notifiedMessages) if (!overdueIdentifiers.has(identifier)) notifiedMessages.delete(identifier);
      for (const identifier of notificationAttempts.keys()) {
        if (!overdueIdentifiers.has(identifier)) notificationAttempts.delete(identifier);
      }
      let notificationError: unknown;
      for (const record of overdueMessages) {
        if (signal.aborted) return;
        if (notifiedMessages.has(record.messageId)) continue;
        const attempts = notificationAttempts.get(record.messageId) ?? 0;
        if (attempts >= 3) continue;
        const diagnosis = await diagnoseMessageDelivery(record, { ...options, signal });
        const latest = await options.store.get(record.messageId);
        if (signal.aborted) return;
        if (latest === undefined || latest.repliedAt !== undefined) continue;
        notificationAttempts.set(record.messageId, attempts + 1);
        try {
          await options.notify(latest, diagnosis);
          notifiedMessages.add(record.messageId);
        } catch (error) {
          notificationError = error;
        }
      }
      if (notificationError !== undefined) throw notificationError;
    })().finally(() => { activeCheck = undefined; });
    return activeCheck;
  };

  const schedule = (): void => {
    if (signal.aborted) return;
    timer = setTimeout(() => {
      void check().catch(() => undefined).finally(schedule);
    }, intervalMilliseconds);
    timer.unref();
  };
  schedule();
  return {
    check,
    async close() {
      stopController.abort();
      if (timer !== undefined) clearTimeout(timer);
      await activeCheck?.catch(() => undefined);
    },
  };
}
