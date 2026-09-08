import assert from "node:assert/strict";
import test from "node:test";

import {
  createMessageWatchdog,
  diagnoseMessageDelivery,
  waitForMessageStatus,
} from "../src/conversations/messageWatchdog.js";
import type { MessageStatusRecord, MessageStatusStore } from "../src/conversations/messageStatusStore.js";
import { MessageStatusLockTimeoutError } from "../src/conversations/messageStatusStore.js";
import type { AgentAddress } from "../src/protocol/messageEnvelope.js";
import type { ActiveSessionRecord } from "../src/registry/activeSessionRegistry.js";

const timestamp = "2026-09-08T17:00:00.000Z";
const codexAddress: AgentAddress = {
  runtime: "codex",
  sessionId: "8d6380bf-1b93-44b3-b3da-a1a661cf8b69",
  projectId: "0123456789abcdef01234567",
};
const claudeAddress: AgentAddress = {
  runtime: "claude",
  sessionId: "ad65b1c1-7386-4465-80f9-4de0a26bc212",
  projectId: "fedcba987654321001234567",
};

function statusRecord(overrides: Partial<MessageStatusRecord> = {}): MessageStatusRecord {
  return {
    messageId: "00000000-0000-4000-8000-000000000001",
    conversationId: "5cb1e2fd-5b24-4699-bfea-878e9b147370",
    sender: claudeAddress,
    recipient: codexAddress,
    messageType: "question",
    contentDigest: "a".repeat(64),
    sentAt: timestamp,
    createdAt: timestamp,
    expiresAt: "2026-09-09T17:05:00.000Z",
    deadlineAt: "2026-09-08T17:05:00.000Z",
    transportState: "accepted",
    transportAcceptedAt: timestamp,
    state: "accepted",
    ...overrides,
  };
}

function activeSession(address: AgentAddress): ActiveSessionRecord {
  return {
    ...address,
    schemaVersion: 1,
    displayName: "watchdog-target",
    processId: process.pid,
    workingDirectory: process.cwd(),
    registeredAt: timestamp,
    ...(address.runtime === "claude" ? { socketPath: "/private/tmp/watchdog-target.sock" } : {}),
  };
}

function fakeStore(records: MessageStatusRecord[], overrides: Partial<MessageStatusStore> = {}): MessageStatusStore {
  const rejectMutation = async (): Promise<never> => {
    throw new Error("Watchdog must not mutate message status or retransmit tasks");
  };
  return {
    createPending: rejectMutation,
    markAccepted: rejectMutation,
    markTransportFailure: rejectMutation,
    markSeen: rejectMutation,
    markReplied: rejectMutation,
    findReplyTarget: rejectMutation,
    get: async (messageId) => records.find((record) => record.messageId === messageId),
    listOverdue: async () => records,
    ...overrides,
  };
}

function deferred<Value>() {
  let resolvePromise!: (value: Value) => void;
  const promise = new Promise<Value>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

test("diagnosis makes at most three read-only inspections without switching target address", async () => {
  const record = statusRecord();
  let inspections = 0;
  const unrelatedSessions = [
    activeSession({ ...codexAddress, sessionId: claudeAddress.sessionId }),
    activeSession({ ...codexAddress, projectId: claudeAddress.projectId }),
    activeSession({ ...codexAddress, runtime: "claude" }),
  ];
  const originalRecord = structuredClone(record);
  const diagnosis = await diagnoseMessageDelivery(record, {
    retryDelayMilliseconds: 0,
    inspectSessions: async () => {
      inspections += 1;
      return unrelatedSessions;
    },
  });
  assert.equal(inspections, 3);
  assert.equal(diagnosis.diagnosticAttempts, 3);
  assert.equal(diagnosis.targetSessionAvailable, false);
  assert.equal(diagnosis.targetPidAlive, "unknown");
  assert.equal(diagnosis.inspectionFailed, false);
  assert.equal(diagnosis.taskRetransmitted, false);
  assert.deepEqual(record, originalRecord);
});

test("diagnosis stops probing when the exact session appears without claiming the agent saw the message", async () => {
  const record = statusRecord({ sender: codexAddress, recipient: claudeAddress });
  let inspections = 0;
  const diagnosis = await diagnoseMessageDelivery(record, {
    retryDelayMilliseconds: 0,
    inspectSessions: async () => ++inspections === 2 ? [activeSession(claudeAddress)] : [],
  });
  assert.equal(inspections, 2);
  assert.equal(diagnosis.targetSessionAvailable, true);
  assert.equal(diagnosis.targetPidAlive, true);
  assert.equal(diagnosis.socketAcceptsConnection, true);
  assert.equal(diagnosis.channelLoaded, "unknown");
  assert.equal(diagnosis.queueVisibility, "not_applicable");
  assert.equal(diagnosis.taskRetransmitted, false);
});

test("failed inspection leaves process and visibility unknown rather than declaring the target dead", async () => {
  let inspections = 0;
  const diagnosis = await diagnoseMessageDelivery(statusRecord(), {
    retryDelayMilliseconds: 0,
    inspectSessions: async () => {
      inspections += 1;
      throw new Error("Inspection unavailable");
    },
  });
  assert.equal(inspections, 3);
  assert.equal(diagnosis.inspectionFailed, true);
  assert.equal(diagnosis.targetPidAlive, "unknown");
  assert.equal(diagnosis.queueVisibility, "unknown");
  assert.equal(diagnosis.socketAcceptsConnection, "not_applicable");
});

test("diagnosis reports explicit acknowledgment independently of runtime reachability", async () => {
  const acknowledged = statusRecord({ state: "seen", acknowledgedAt: timestamp });
  const diagnosis = await diagnoseMessageDelivery(acknowledged, {
    retryDelayMilliseconds: 0,
    inspectSessions: async () => [],
  });
  assert.equal(diagnosis.queueVisibility, "agent_acknowledged");
  assert.equal(diagnosis.targetPidAlive, "unknown");
  assert.equal(diagnosis.channelLoaded, "not_applicable");
});

test("wait returns seen and replied immediately without diagnosis", async () => {
  for (const state of ["seen", "replied"] as const) {
    const record = statusRecord({ state, acknowledgedAt: timestamp, ...(state === "replied" ? { repliedAt: timestamp } : {}) });
    let reads = 0;
    const result = await waitForMessageStatus({
      store: fakeStore([record], { get: async () => { reads += 1; return record; } }),
      messageId: record.messageId,
      waitMinutes: 0.01,
      inspectSessions: async () => { assert.fail("Immediate receipts must not trigger diagnosis"); },
    });
    assert.equal(result.outcome, state);
    assert.equal(result.status, record);
    assert.equal(reads, 1);
    assert.equal(result.diagnosis, undefined);
  }
});

test("wait reaches deadline with an advancing clock and returns a diagnosis without a long sleep", async () => {
  const record = statusRecord();
  let elapsedMilliseconds = 0;
  let inspections = 0;
  const result = await waitForMessageStatus({
    store: fakeStore([record]),
    messageId: record.messageId,
    waitMinutes: 0.01,
    retryDelayMilliseconds: 0,
    currentDate: () => {
      const currentDate = new Date(Date.parse(timestamp) + elapsedMilliseconds);
      elapsedMilliseconds += 600;
      return currentDate;
    },
    inspectSessions: async () => { inspections += 1; return [activeSession(codexAddress)]; },
  });
  assert.equal(result.outcome, "overdue");
  assert.equal(result.status, record);
  assert.equal(result.diagnosis?.targetSessionAvailable, true);
  assert.equal(inspections, 1);
});

test("wait returns a reply that arrives during diagnosis instead of stale overdue status", async () => {
  let record = statusRecord();
  let elapsedMilliseconds = 0;
  const result = await waitForMessageStatus({
    store: fakeStore([], { get: async () => record }),
    messageId: record.messageId,
    waitMinutes: 0.01,
    currentDate: () => new Date(Date.parse(timestamp) + (elapsedMilliseconds += 600)),
    inspectSessions: async () => {
      record = { ...record, state: "replied", acknowledgedAt: timestamp, repliedAt: timestamp };
      return [activeSession(codexAddress)];
    },
  });
  assert.equal(result.outcome, "replied");
  assert.equal(result.diagnosis, undefined);
});

test("waiting until replied keeps a seen receipt pending until the configured deadline", async () => {
  const record = statusRecord({ state: "seen", acknowledgedAt: timestamp });
  let elapsedMilliseconds = 0;
  let inspections = 0;
  const result = await waitForMessageStatus({
    store: fakeStore([record]),
    messageId: record.messageId,
    waitMinutes: 0.01,
    until: "replied",
    currentDate: () => new Date(Date.parse(timestamp) + (elapsedMilliseconds += 600)),
    inspectSessions: async () => { inspections += 1; return [activeSession(codexAddress)]; },
  });
  assert.equal(result.outcome, "overdue");
  assert.equal(result.status?.state, "seen");
  assert.equal(result.diagnosis?.queueVisibility, "agent_acknowledged");
  assert.equal(inspections, 1);
});

test("wait retries only temporary receipt lock contention before returning an explicit reply", async () => {
  const record = statusRecord({ state: "replied", repliedAt: timestamp });
  let reads = 0;
  const result = await waitForMessageStatus({
    store: fakeStore([], { get: async () => {
      if (++reads === 1) throw new MessageStatusLockTimeoutError();
      return record;
    } }),
    messageId: record.messageId,
    pollIntervalMilliseconds: 10,
    waitMinutes: 0.01,
  });
  assert.equal(reads, 2);
  assert.equal(result.outcome, "replied");
});

test("wait reports unknown when receipt lock contention lasts through its deadline", async () => {
  const record = statusRecord();
  let elapsedMilliseconds = 0;
  const result = await waitForMessageStatus({
    store: fakeStore([], { get: async () => { throw new MessageStatusLockTimeoutError(); } }),
    messageId: record.messageId,
    waitMinutes: 0.01,
    currentDate: () => new Date(Date.parse(timestamp) + (elapsedMilliseconds += 600)),
    inspectSessions: async () => { assert.fail("Unavailable receipts are not evidence for delivery diagnosis"); },
  });
  assert.deepEqual(result, { outcome: "unknown", reason: "receipt_lock_timeout" });
});

test("wait reports unknown if receipt access times out after diagnosis instead of returning stale status", async () => {
  const record = statusRecord();
  let reads = 0;
  let elapsedMilliseconds = 0;
  const result = await waitForMessageStatus({
    store: fakeStore([], { get: async () => {
      if (++reads > 1) throw new MessageStatusLockTimeoutError();
      return record;
    } }),
    messageId: record.messageId,
    waitMinutes: 0.01,
    currentDate: () => new Date(Date.parse(timestamp) + (elapsedMilliseconds += 600)),
    inspectSessions: async () => [activeSession(codexAddress)],
  });
  assert.deepEqual(result, { outcome: "unknown", reason: "receipt_lock_timeout" });
});

test("wait propagates receipt corruption and aborts during contention", async () => {
  const record = statusRecord();
  const corruption = new SyntaxError("Invalid receipt JSON");
  await assert.rejects(waitForMessageStatus({
    store: fakeStore([], { get: async () => { throw corruption; } }),
    messageId: record.messageId,
  }), (error) => error === corruption);
  const controller = new AbortController();
  await assert.rejects(waitForMessageStatus({
    store: fakeStore([], { get: async () => {
      controller.abort();
      throw new MessageStatusLockTimeoutError();
    } }),
    messageId: record.messageId,
    signal: controller.signal,
  }), { name: "AbortError" });
});

test("wait returns missing status and respects abort while entering a polling delay", async () => {
  const record = statusRecord();
  assert.deepEqual(await waitForMessageStatus({ store: fakeStore([]), messageId: record.messageId }), { outcome: "missing" });
  const stopController = new AbortController();
  let inspections = 0;
  await assert.rejects(waitForMessageStatus({
    store: fakeStore([record], { get: async () => { stopController.abort(); return record; } }),
    messageId: record.messageId,
    signal: stopController.signal,
    waitMinutes: 0.01,
    pollIntervalMilliseconds: 10,
    inspectSessions: async () => { inspections += 1; return []; },
  }), { name: "AbortError" });
  assert.equal(inspections, 0);
});

test("watchdog filters by the entire sender address and deduplicates repeated and concurrent checks", async () => {
  const ownRecord = statusRecord();
  const records = [
    ownRecord,
    statusRecord({ messageId: "00000000-0000-4000-8000-000000000002", sender: { ...claudeAddress, runtime: "codex" } }),
    statusRecord({ messageId: "00000000-0000-4000-8000-000000000003", sender: { ...claudeAddress, sessionId: codexAddress.sessionId } }),
    statusRecord({ messageId: "00000000-0000-4000-8000-000000000004", sender: { ...claudeAddress, projectId: codexAddress.projectId } }),
  ];
  const notificationStarted = deferred<void>();
  const finishNotification = deferred<void>();
  let notifications = 0;
  let inspections = 0;
  const watchdog = createMessageWatchdog({
    store: fakeStore(records),
    sender: claudeAddress,
    intervalMilliseconds: 60_000,
    inspectSessions: async () => { inspections += 1; return [activeSession(codexAddress)]; },
    notify: async (record, diagnosis) => {
      assert.equal(record.messageId, ownRecord.messageId);
      assert.equal(diagnosis.messageId, ownRecord.messageId);
      notifications += 1;
      notificationStarted.resolve();
      await finishNotification.promise;
    },
  });
  try {
    const firstCheck = watchdog.check();
    await notificationStarted.promise;
    const concurrentCheck = watchdog.check();
    assert.equal(concurrentCheck, firstCheck);
    finishNotification.resolve();
    await Promise.all([firstCheck, concurrentCheck]);
    await watchdog.check();
    assert.equal(notifications, 1);
    assert.equal(inspections, 1);
  } finally {
    finishNotification.resolve();
    await watchdog.close();
  }
});

test("watchdog suppresses overdue notification if a reply arrives during diagnosis", async () => {
  const originalRecord = statusRecord();
  let latestRecord = originalRecord;
  let notifications = 0;
  const watchdog = createMessageWatchdog({
    store: fakeStore([originalRecord], { get: async () => latestRecord }),
    sender: claudeAddress,
    intervalMilliseconds: 60_000,
    inspectSessions: async () => {
      latestRecord = { ...originalRecord, state: "replied", acknowledgedAt: timestamp, repliedAt: timestamp };
      return [activeSession(codexAddress)];
    },
    notify: async () => { notifications += 1; },
  });
  try {
    await watchdog.check();
    assert.equal(notifications, 0);
  } finally {
    await watchdog.close();
  }
});

test("watchdog retries a failed notification, continues the batch and deduplicates after success", async () => {
  const firstRecord = statusRecord();
  const secondRecord = statusRecord({ messageId: "00000000-0000-4000-8000-000000000002" });
  const attemptedMessages: string[] = [];
  const temporaryFailure = new Error("Notification temporarily unavailable");
  let firstMessageAttempts = 0;
  const watchdog = createMessageWatchdog({
    store: fakeStore([firstRecord, secondRecord]),
    sender: claudeAddress,
    intervalMilliseconds: 60_000,
    inspectSessions: async () => [activeSession(codexAddress)],
    notify: async (record) => {
      attemptedMessages.push(record.messageId);
      if (record.messageId === firstRecord.messageId && ++firstMessageAttempts === 1) {
        throw temporaryFailure;
      }
    },
  });
  try {
    await assert.rejects(watchdog.check(), temporaryFailure);
    assert.deepEqual(attemptedMessages, [firstRecord.messageId, secondRecord.messageId]);
    await watchdog.check();
    assert.deepEqual(attemptedMessages, [firstRecord.messageId, secondRecord.messageId, firstRecord.messageId]);
    await watchdog.check();
    assert.equal(attemptedMessages.length, 3);
  } finally {
    await watchdog.close();
  }
});

test("watchdog stops retrying a permanently failing notification after three attempts", async () => {
  let notificationAttempts = 0;
  let inspections = 0;
  const permanentFailure = new Error("Notification unavailable");
  const watchdog = createMessageWatchdog({
    store: fakeStore([statusRecord()]),
    sender: claudeAddress,
    intervalMilliseconds: 60_000,
    inspectSessions: async () => { inspections += 1; return [activeSession(codexAddress)]; },
    notify: async () => {
      notificationAttempts += 1;
      throw permanentFailure;
    },
  });
  try {
    for (let attemptIndex = 0; attemptIndex < 3; attemptIndex += 1) {
      await assert.rejects(watchdog.check(), permanentFailure);
    }
    await watchdog.check();
    await watchdog.check();
    assert.equal(notificationAttempts, 3);
    assert.equal(inspections, 3);
  } finally {
    await watchdog.close();
  }
});

test("closing the watchdog during inspection prevents notifications and future checks", async () => {
  const inspectionStarted = deferred<void>();
  const finishInspection = deferred<ActiveSessionRecord[]>();
  let notifications = 0;
  let inspections = 0;
  const watchdog = createMessageWatchdog({
    store: fakeStore([statusRecord()]),
    sender: claudeAddress,
    intervalMilliseconds: 60_000,
    inspectSessions: async () => {
      inspections += 1;
      inspectionStarted.resolve();
      return finishInspection.promise;
    },
    notify: async () => { notifications += 1; },
  });
  try {
    const checkOutcome = watchdog.check().then(() => undefined, (error: unknown) => error);
    await inspectionStarted.promise;
    const closing = watchdog.close();
    finishInspection.resolve([activeSession(codexAddress)]);
    await closing;
    await checkOutcome;
    await watchdog.check();
    assert.equal(notifications, 0);
    assert.equal(inspections, 1);
  } finally {
    finishInspection.resolve([]);
    await watchdog.close();
  }
});
