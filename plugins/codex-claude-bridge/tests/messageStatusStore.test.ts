import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  createMessageStatusStore,
  MessageStatusLockTimeoutError,
  resolveMessageTimeoutMinutes,
} from "../src/conversations/messageStatusStore.js";
import type { AgentAddress, AgentMessageEnvelope } from "../src/protocol/messageEnvelope.js";
import { resolveBridgeStateDirectory } from "../src/runtime/paths.js";

const initialTimestamp = "2026-09-08T17:00:00.000Z";
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

function messageIdentifier(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function messageEnvelope(index = 1, overrides: Partial<AgentMessageEnvelope> = {}): AgentMessageEnvelope {
  return {
    schemaVersion: 1,
    messageId: messageIdentifier(index),
    conversationId: "5cb1e2fd-5b24-4699-bfea-878e9b147370",
    sentAt: initialTimestamp,
    messageType: "question",
    sender: codexAddress,
    recipient: claudeAddress,
    content: "PRIVATE_MESSAGE_CONTENT_MUST_NOT_BE_STORED",
    ...overrides,
  };
}

async function createTestState(testContext: test.TestContext) {
  const stateHomeDirectory = await mkdtemp("/private/tmp/ccb-status-");
  testContext.after(() => rm(stateHomeDirectory, { recursive: true, force: true }));
  let currentTimestamp = Date.parse(initialTimestamp);
  const storeOptions = {
    stateHomeDirectory,
    currentDate: () => new Date(currentTimestamp),
  };
  return {
    storeOptions,
    store: createMessageStatusStore(storeOptions),
    messagesDirectory: join(resolveBridgeStateDirectory(stateHomeDirectory), "messages"),
    advance(milliseconds: number) {
      currentTimestamp += milliseconds;
    },
  };
}

test("persists private metadata across store instances without message content", async (testContext) => {
  const fixture = await createTestState(testContext);
  const envelope = messageEnvelope();
  const pending = await fixture.store.createPending(envelope, { timeoutMinutes: 5 });
  assert.equal(pending.state, "pending");
  assert.equal(pending.transportState, "pending");
  assert.equal(pending.transportAcceptedAt, undefined);
  assert.equal(pending.acknowledgedAt, undefined);
  assert.equal(pending.deadlineAt, "2026-09-08T17:05:00.000Z");
  assert.deepEqual(await createMessageStatusStore(fixture.storeOptions).get(envelope.messageId), pending);
  const filenames = await readdir(fixture.messagesDirectory);
  assert.deepEqual(filenames.sort(), [".mutation.lock", "statuses.json"]);
  for (const filename of filenames) {
    const filePath = join(fixture.messagesDirectory, filename);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    assert.equal((await readFile(filePath, "utf8")).includes(envelope.content), false);
  }
  assert.equal((await stat(fixture.messagesDirectory)).mode & 0o777, 0o700);
});

test("transport acceptance stays distinct from explicit acknowledgment and preserves first timestamps", async (testContext) => {
  const fixture = await createTestState(testContext);
  const envelope = messageEnvelope();
  await fixture.store.createPending(envelope);
  fixture.advance(1_000);
  const accepted = await fixture.store.markAccepted(envelope.messageId);
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.acknowledgedAt, undefined);
  fixture.advance(1_000);
  const seen = await fixture.store.markSeen(envelope.messageId, claudeAddress);
  fixture.advance(1_000);
  await fixture.store.markAccepted(envelope.messageId);
  const repeated = await fixture.store.markSeen(envelope.messageId, claudeAddress);
  assert.equal(repeated.state, "seen");
  assert.equal(repeated.transportAcceptedAt, accepted.transportAcceptedAt);
  assert.equal(repeated.acknowledgedAt, seen.acknowledgedAt);
});

test("late transport acceptance cannot regress an already seen message", async (testContext) => {
  const fixture = await createTestState(testContext);
  const envelope = messageEnvelope();
  await fixture.store.createPending(envelope);
  const seen = await fixture.store.markSeen(envelope.messageId, claudeAddress);
  assert.equal(seen.transportAcceptedAt, undefined);
  fixture.advance(1_000);
  const accepted = await fixture.store.markAccepted(envelope.messageId);
  assert.equal(accepted.state, "seen");
  assert.equal(accepted.acknowledgedAt, seen.acknowledgedAt);
  assert.equal(accepted.transportAcceptedAt, "2026-09-08T17:00:01.000Z");
});

test("only the complete recipient address can acknowledge a message", async (testContext) => {
  const fixture = await createTestState(testContext);
  const envelope = messageEnvelope();
  const pending = await fixture.store.createPending(envelope);
  const wrongRecipients: AgentAddress[] = [
    codexAddress,
    { ...claudeAddress, runtime: "codex" },
    { ...claudeAddress, sessionId: codexAddress.sessionId },
    { ...claudeAddress, projectId: codexAddress.projectId },
  ];
  for (const recipient of wrongRecipients) {
    await assert.rejects(fixture.store.markSeen(envelope.messageId, recipient), /recipient/);
    assert.deepEqual(await fixture.store.get(envelope.messageId), pending);
  }
  assert.equal((await fixture.store.markSeen(envelope.messageId, {
    ...claudeAddress,
    sessionId: claudeAddress.sessionId.toUpperCase(),
  })).state, "seen");
});

test("duplicate envelopes retain status and deadline while identifier collisions are rejected", async (testContext) => {
  const fixture = await createTestState(testContext);
  const envelope = messageEnvelope();
  await fixture.store.createPending(envelope, { timeoutMinutes: 5 });
  const seen = await fixture.store.markSeen(envelope.messageId, claudeAddress);
  fixture.advance(1_000);
  assert.deepEqual(await fixture.store.createPending(envelope, { timeoutMinutes: 10 }), seen);
  const collisions: Partial<AgentMessageEnvelope>[] = [
    { sender: claudeAddress },
    { recipient: codexAddress },
    { conversationId: messageIdentifier(20) },
    { content: "Changed content" },
    { messageType: "handoff" },
  ];
  for (const collision of collisions) {
    await assert.rejects(fixture.store.createPending({ ...envelope, ...collision }), /already bound/);
    assert.deepEqual(await fixture.store.get(envelope.messageId), seen);
  }
});

test("an accepted reverse-route reply implies acknowledgment before original acceptance", async (testContext) => {
  const fixture = await createTestState(testContext);
  const original = messageEnvelope();
  const reply = messageEnvelope(2, {
    messageType: "reply",
    sender: claudeAddress,
    recipient: codexAddress,
  });
  await fixture.store.createPending(original);
  await fixture.store.createPending(reply);
  await assert.rejects(fixture.store.markReplied(original.messageId, claudeAddress, reply.messageId), /accepted message/);
  await fixture.store.markAccepted(reply.messageId);
  fixture.advance(1_000);
  const replied = await fixture.store.markReplied(original.messageId, claudeAddress, reply.messageId);
  assert.equal(replied.state, "replied");
  assert.equal(replied.transportAcceptedAt, undefined);
  assert.equal(replied.acknowledgedAt, replied.repliedAt);
  assert.equal(replied.replyMessageId, reply.messageId);
  fixture.advance(1_000);
  await fixture.store.markAccepted(original.messageId);
  await fixture.store.markSeen(original.messageId, claudeAddress);
  const repeated = await fixture.store.markReplied(original.messageId, claudeAddress, reply.messageId);
  assert.equal(repeated.state, "replied");
  assert.equal(repeated.repliedAt, replied.repliedAt);
  assert.equal(repeated.acknowledgedAt, replied.acknowledgedAt);
  assert.equal(repeated.transportAcceptedAt, "2026-09-08T17:00:02.000Z");
});

test("reply correlation rejects wrong conversation, endpoints, message type and replacement reply", async (testContext) => {
  const fixture = await createTestState(testContext);
  const original = messageEnvelope();
  const pending = await fixture.store.createPending(original);
  const invalidReplies = [
    messageEnvelope(2, { messageType: "reply" }),
    messageEnvelope(3, { messageType: "reply", sender: claudeAddress, recipient: codexAddress, conversationId: messageIdentifier(20) }),
    messageEnvelope(4, { messageType: "message", sender: claudeAddress, recipient: codexAddress }),
    messageEnvelope(7, { messageType: "reply", sender: claudeAddress, recipient: codexAddress, replyToMessageId: messageIdentifier(99) }),
  ];
  for (const reply of invalidReplies) {
    await fixture.store.createPending(reply);
    await fixture.store.markAccepted(reply.messageId);
    await assert.rejects(fixture.store.markReplied(original.messageId, claudeAddress, reply.messageId), /reversed conversation route/);
    assert.deepEqual(await fixture.store.get(original.messageId), pending);
  }
  const validReplies = [5, 6].map((index) => messageEnvelope(index, {
    messageType: "reply", sender: claudeAddress, recipient: codexAddress,
  }));
  for (const reply of validReplies) {
    await fixture.store.createPending(reply);
    await fixture.store.markAccepted(reply.messageId);
  }
  await assert.rejects(fixture.store.markReplied(original.messageId, codexAddress, validReplies[0]!.messageId), /recipient/);
  await fixture.store.markReplied(original.messageId, claudeAddress, validReplies[0]!.messageId);
  await assert.rejects(fixture.store.markReplied(original.messageId, claudeAddress, validReplies[1]!.messageId), /different reply/);
});

test("independent stores preserve concurrent acceptance and acknowledgment", async (testContext) => {
  const fixture = await createTestState(testContext);
  const envelope = messageEnvelope();
  await fixture.store.createPending(envelope);
  const secondStore = createMessageStatusStore(fixture.storeOptions);
  await Promise.all([
    fixture.store.markAccepted(envelope.messageId),
    secondStore.markSeen(envelope.messageId, claudeAddress),
  ]);
  const status = await fixture.store.get(envelope.messageId);
  assert.equal(status?.state, "seen");
  assert.equal(status?.transportState, "accepted");
  assert.equal(status?.transportAcceptedAt, initialTimestamp);
  assert.equal(status?.acknowledgedAt, initialTimestamp);
});

test("capacity evicts the oldest completed receipt without discarding unanswered questions", async (testContext) => {
  const fixture = await createTestState(testContext);
  const store = createMessageStatusStore({ ...fixture.storeOptions, maximumRecords: 4 });
  const question = messageEnvelope(1);
  const reply = messageEnvelope(2, { messageType: "reply", sender: claudeAddress, recipient: codexAddress });
  await store.createPending(question);
  await store.markSeen(question.messageId, claudeAddress);
  await store.createPending(reply);
  await store.markAccepted(reply.messageId);
  await store.markReplied(question.messageId, claudeAddress, reply.messageId);
  fixture.advance(1_000);
  const information = messageEnvelope(3, { messageType: "message" });
  await store.createPending(information);
  await store.markSeen(information.messageId, claudeAddress);
  const unanswered = messageEnvelope(4);
  await store.createPending(unanswered);
  await store.markSeen(unanswered.messageId, claudeAddress);
  await store.createPending(messageEnvelope(5));
  assert.equal(await store.get(question.messageId), undefined);
  assert.equal((await store.get(information.messageId))?.state, "seen");
  assert.equal((await store.get(unanswered.messageId))?.state, "seen");
  await store.createPending(messageEnvelope(6));
  assert.equal(await store.get(information.messageId), undefined);
  await assert.rejects(store.createPending(messageEnvelope(7)), /capacity/);
  assert.equal((await store.get(unanswered.messageId))?.state, "seen");
  await store.markSeen(reply.messageId, codexAddress);
  await store.createPending(messageEnvelope(7));
  assert.equal(await store.get(reply.messageId), undefined);
});

test("capacity reclaims definite failures but preserves uncertain delivery", async (testContext) => {
  const fixture = await createTestState(testContext);
  const store = createMessageStatusStore({ ...fixture.storeOptions, maximumRecords: 2 });
  await store.createPending(messageEnvelope(1));
  await store.markTransportFailure(messageIdentifier(1), "unknown");
  await store.createPending(messageEnvelope(2));
  await store.markTransportFailure(messageIdentifier(2), "failed");
  await store.createPending(messageEnvelope(3));
  assert.equal(await store.get(messageIdentifier(2)), undefined);
  assert.equal((await store.get(messageIdentifier(1)))?.transportState, "unknown");
});

test("a real contended receipt lock produces the dedicated temporary timeout error", { timeout: 15_000 }, async (testContext) => {
  const fixture = await createTestState(testContext);
  const record = await fixture.store.createPending(messageEnvelope());
  const lockHolder = spawn("/usr/bin/lockf", [
    "-k", join(fixture.messagesDirectory, ".mutation.lock"), process.execPath,
    "-e", "process.stdout.write('ready'); setTimeout(() => {}, 10000)",
  ], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const holderClosed = once(lockHolder, "close");
  try {
    const readiness = await Promise.race([
      once(lockHolder.stdout!, "data").then(([data]) => String(data)),
      holderClosed.then(() => { throw new Error("Lock holder exited before readiness"); }),
    ]);
    assert.equal(readiness, "ready");
    await assert.rejects(fixture.store.get(record.messageId), MessageStatusLockTimeoutError);
  } finally {
    if (lockHolder.pid !== undefined) {
      try { process.kill(-lockHolder.pid, "SIGTERM"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await holderClosed;
  }
  assert.equal((await fixture.store.get(record.messageId))?.messageId, record.messageId);
});

test("independent stores enforce the global capacity atomically", async (testContext) => {
  const fixture = await createTestState(testContext);
  const firstStore = createMessageStatusStore({ ...fixture.storeOptions, maximumRecords: 1 });
  const secondStore = createMessageStatusStore({ ...fixture.storeOptions, maximumRecords: 1 });
  const outcomes = await Promise.allSettled([
    firstStore.createPending(messageEnvelope(1)),
    secondStore.createPending(messageEnvelope(2)),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.equal(rejected?.status, "rejected");
  if (rejected?.status === "rejected") assert.match(String(rejected.reason), /capacity/);
  const storedRecords = JSON.parse(await readFile(join(fixture.messagesDirectory, "statuses.json"), "utf8")).records;
  assert.equal(storedRecords.length, 1);
});

test("separate processes preserve concurrent acceptance and acknowledgment", { timeout: 15_000 }, async (testContext) => {
  const fixture = await createTestState(testContext);
  const envelope = messageEnvelope();
  await fixture.store.createPending(envelope);
  const mutationProcesses: ReturnType<typeof fork>[] = [];
  let readyProcesses = 0;
  const completedMutations = ["accepted", "seen"].map((mutation) => {
    const mutationProcess = fork(new URL("./fixtures/messageStatusMutation.ts", import.meta.url), [JSON.stringify({
      stateHomeDirectory: fixture.storeOptions.stateHomeDirectory,
      messageId: envelope.messageId,
      recipient: claudeAddress,
      timestamp: initialTimestamp,
      mutation,
    })], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    mutationProcesses.push(mutationProcess);
    return new Promise<void>((resolveCompletion, rejectCompletion) => {
      mutationProcess.once("error", rejectCompletion);
      mutationProcess.once("exit", (exitCode, signal) => {
        if (exitCode !== 0) {
          rejectCompletion(new Error(`Message mutation process failed: ${String(exitCode)} ${String(signal)}`));
          return;
        }
        resolveCompletion();
      });
      mutationProcess.once("message", (message) => {
        if (message !== "ready") {
          rejectCompletion(new Error("Message mutation process sent an unexpected response"));
          return;
        }
        readyProcesses += 1;
        if (readyProcesses === 2) {
          for (const readyProcess of mutationProcesses) readyProcess.send("start");
        }
      });
    });
  });
  try {
    await Promise.all(completedMutations);
  } finally {
    for (const mutationProcess of mutationProcesses) {
      if (mutationProcess.exitCode === null && mutationProcess.signalCode === null) {
        mutationProcess.kill("SIGKILL");
      }
    }
    await Promise.allSettled(completedMutations);
  }
  const status = await fixture.store.get(envelope.messageId);
  assert.equal(status?.state, "seen");
  assert.equal(status?.transportState, "accepted");
  assert.equal(status?.transportAcceptedAt, initialTimestamp);
  assert.equal(status?.acknowledgedAt, initialTimestamp);
});

test("retains overdue records until deadline plus retention and then frees capacity", async (testContext) => {
  const fixture = await createTestState(testContext);
  const options = { ...fixture.storeOptions, retentionMilliseconds: 1_000, maximumRecords: 1 };
  const store = createMessageStatusStore(options);
  const envelope = messageEnvelope();
  const pending = await store.createPending(envelope, { timeoutMinutes: 0.01 });
  assert.equal(pending.expiresAt, "2026-09-08T17:00:01.600Z");
  fixture.advance(599);
  assert.deepEqual(await store.listOverdue(), []);
  fixture.advance(1);
  assert.equal((await store.listOverdue())[0]?.messageId, envelope.messageId);
  fixture.advance(999);
  assert.notEqual(await createMessageStatusStore(options).get(envelope.messageId), undefined);
  fixture.advance(1);
  assert.equal(await store.get(envelope.messageId), undefined);
  await assert.rejects(store.markSeen(envelope.messageId, claudeAddress), /missing or expired/);
  assert.equal((await store.createPending(messageEnvelope(2))).state, "pending");
});

test("overdue queries keep seen questions but exclude definite failures and informational messages", async (testContext) => {
  const fixture = await createTestState(testContext);
  for (const envelope of [
    messageEnvelope(1),
    messageEnvelope(2),
    messageEnvelope(3, { messageType: "handoff" }),
    messageEnvelope(4, { messageType: "message" }),
  ]) await fixture.store.createPending(envelope, { timeoutMinutes: 0.01 });
  await fixture.store.markSeen(messageIdentifier(1), claudeAddress);
  await fixture.store.markTransportFailure(messageIdentifier(2), "failed");
  await fixture.store.markTransportFailure(messageIdentifier(3), "unknown");
  fixture.advance(600);
  assert.deepEqual((await fixture.store.listOverdue()).map((record) => record.messageId).sort(), [messageIdentifier(1), messageIdentifier(3)]);
  await fixture.store.markTransportFailure(messageIdentifier(1), "failed");
  assert.equal((await fixture.store.get(messageIdentifier(1)))?.state, "seen");
  await fixture.store.markAccepted(messageIdentifier(3));
  await fixture.store.markTransportFailure(messageIdentifier(3), "unknown");
  assert.equal((await fixture.store.get(messageIdentifier(3)))?.transportState, "accepted");
});

test("rejects malformed, oversized and duplicate stored records without overwriting them", async (testContext) => {
  const fixture = await createTestState(testContext);
  const envelope = messageEnvelope();
  await fixture.store.createPending(envelope);
  const recordPath = join(fixture.messagesDirectory, "statuses.json");
  const originalContents = await readFile(recordPath, "utf8");
  const originalData = JSON.parse(originalContents);
  const malformedContents = [
    "{invalid",
    " ".repeat(1_048_577),
    JSON.stringify({ ...originalData, records: [originalData.records[0], originalData.records[0]] }),
  ];
  for (const contents of malformedContents) {
    await writeFile(recordPath, contents, { mode: 0o600 });
    await assert.rejects(fixture.store.get(envelope.messageId));
    assert.equal(await readFile(recordPath, "utf8"), contents);
  }
});

test("rejects a symlinked status store without reading or changing its target", async (testContext) => {
  const fixture = await createTestState(testContext);
  const envelope = messageEnvelope();
  await fixture.store.createPending(envelope);
  const recordPath = join(fixture.messagesDirectory, "statuses.json");
  const targetPath = join(fixture.storeOptions.stateHomeDirectory, "untouched.json");
  const targetContents = "sensitive unrelated contents";
  await writeFile(targetPath, targetContents, { mode: 0o600 });
  await unlink(recordPath);
  await symlink(targetPath, recordPath);
  await assert.rejects(fixture.store.get(envelope.messageId));
  await assert.rejects(fixture.store.createPending(messageEnvelope(2)));
  assert.equal(await readFile(targetPath, "utf8"), targetContents);
});

test("timeout configuration uses explicit overrides and rejects invalid bounds", () => {
  assert.equal(resolveMessageTimeoutMinutes(undefined, "7"), 7);
  assert.equal(resolveMessageTimeoutMinutes(2, "7"), 2);
  assert.equal(resolveMessageTimeoutMinutes(0.01, "invalid"), 0.01);
  assert.equal(resolveMessageTimeoutMinutes(1_440, "invalid"), 1_440);
  for (const value of [0, -1, 0.009, 1_441, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => resolveMessageTimeoutMinutes(value, "5"));
  }
  for (const value of ["", " ", "invalid", "Infinity", "-1"]) {
    assert.throws(() => resolveMessageTimeoutMinutes(undefined, value));
  }
});

test("overdue evaluation accepts an explicit clock and rejects invalid dates", async (testContext) => {
  const fixture = await createTestState(testContext);
  const envelope = messageEnvelope();
  await fixture.store.createPending(envelope, { timeoutMinutes: 5 });
  assert.deepEqual(await fixture.store.listOverdue(), []);
  assert.equal((await fixture.store.listOverdue(new Date("2026-09-08T17:05:00.000Z")))[0]?.messageId, envelope.messageId);
  assert.throws(() => fixture.store.listOverdue(new Date(Number.NaN)));
});
