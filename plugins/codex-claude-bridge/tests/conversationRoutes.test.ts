import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  createConversationRouteStore,
  maximumSerializedConversationRouteRecordUtf8Bytes,
  type ConversationRouteEndpoints,
} from "../src/conversations/conversationRoutes.js";
import {
  resolveConversationDirectory,
  resolveConversationRecordPath,
} from "../src/runtime/paths.js";

const conversationIdentifier = "5cb1e2fd-5b24-4699-bfea-878e9b147370";
const firstGenerationIdentifier = "3c4b3c10-21a7-4d6f-b964-3c816b9ed8db";
const secondGenerationIdentifier = "ea7220bc-cd1e-41f0-bf7f-413982f18a9c";
const thirdGenerationIdentifier = "82708f24-3ea5-409a-9985-4ab05c59e803";
const codexProjectIdentifier = "0123456789abcdef01234567";
const claudeProjectIdentifier = "fedcba987654321001234567";

const endpoints: ConversationRouteEndpoints = {
  codex: {
    runtime: "codex",
    sessionId: "8d6380bf-1b93-44b3-b3da-a1a661cf8b69",
    projectId: codexProjectIdentifier,
  },
  claude: {
    runtime: "claude",
    sessionId: "ad65b1c1-7386-4465-80f9-4de0a26bc212",
    projectId: claudeProjectIdentifier,
  },
  codexCanReply: false,
  claudeCanReply: true,
};

async function createStateHomeDirectory(testContext: test.TestContext): Promise<string> {
  const stateHomeDirectory = await mkdtemp(join(tmpdir(), "ccb-routes-"));
  testContext.after(() => rm(stateHomeDirectory, { recursive: true, force: true }));
  return stateHomeDirectory;
}

function sequenceIdentifierFactory(...identifiers: string[]): () => string {
  let index = 0;
  return () => identifiers[index++] ?? identifiers.at(-1)!;
}

test("persists one globally indexed private route and reads it while both endpoints are active", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const currentDate = new Date("2026-09-04T10:00:00.000Z");
  const routeStore = createConversationRouteStore({
    stateHomeDirectory,
    currentDate: () => currentDate,
    randomIdentifier: () => firstGenerationIdentifier,
    isAddressActive: async () => true,
  });

  const reservation = await routeStore.reserve(conversationIdentifier, endpoints);
  const reservedRoute = reservation.route;
  const storedRoute = await routeStore.findActive(conversationIdentifier);
  const conversationDirectory = resolveConversationDirectory(stateHomeDirectory);
  const recordPath = resolveConversationRecordPath(
    stateHomeDirectory,
    conversationIdentifier,
  );

  assert.deepEqual(storedRoute, reservedRoute);
  assert.equal(reservedRoute.generationId, firstGenerationIdentifier);
  assert.equal(reservedRoute.expiresAt, "2026-09-04T10:15:00.000Z");
  assert.equal((await stat(conversationDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(recordPath)).mode & 0o777, 0o600);
  assert.equal(dirname(recordPath), conversationDirectory);
  assert.equal(JSON.parse(await readFile(recordPath, "utf8")).conversationId, conversationIdentifier);
});

test("rejects a live ownership collision and never overwrites the original route", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const routeStore = createConversationRouteStore({
    stateHomeDirectory,
    randomIdentifier: sequenceIdentifierFactory(
      firstGenerationIdentifier,
      secondGenerationIdentifier,
    ),
    isAddressActive: async () => true,
  });
  const originalRoute = (await routeStore.reserve(conversationIdentifier, endpoints)).route;
  const conflictingEndpoints: ConversationRouteEndpoints = {
    ...endpoints,
    codex: {
      ...endpoints.codex,
      sessionId: "d2f86dee-55db-4a12-9a98-04bc3df54687",
    },
  };

  await assert.rejects(
    routeStore.reserve(conversationIdentifier, conflictingEndpoints),
    /different active endpoints/u,
  );

  assert.deepEqual(await routeStore.findActive(conversationIdentifier), originalRoute);
});

test("rolls back only the generation owned by the failed send", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const routeStore = createConversationRouteStore({
    stateHomeDirectory,
    randomIdentifier: sequenceIdentifierFactory(
      firstGenerationIdentifier,
      secondGenerationIdentifier,
    ),
    isAddressActive: async () => true,
  });
  const firstReservation = await routeStore.reserve(conversationIdentifier, endpoints);
  const replacementReservation = await routeStore.reserve(
    conversationIdentifier,
    endpoints,
  );

  assert.equal(
    await routeStore.rollback(firstReservation),
    false,
  );
  assert.deepEqual(
    await routeStore.findActive(conversationIdentifier),
    replacementReservation.route,
  );
  assert.equal(
    await routeStore.rollback(replacementReservation),
    true,
  );
  assert.deepEqual(
    await routeStore.findActive(conversationIdentifier),
    firstReservation.route,
  );
  assert.equal(
    await routeStore.rollback(firstReservation),
    true,
  );
  assert.equal(await routeStore.findActive(conversationIdentifier), undefined);
});

test("serializes concurrent reservations and permits only one endpoint owner", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const conflictingEndpoints: ConversationRouteEndpoints = {
    ...endpoints,
    claude: {
      ...endpoints.claude,
      sessionId: "82708f24-3ea5-409a-9985-4ab05c59e803",
    },
  };
  const firstStore = createConversationRouteStore({
    stateHomeDirectory,
    randomIdentifier: () => firstGenerationIdentifier,
    isAddressActive: async () => true,
  });
  const secondStore = createConversationRouteStore({
    stateHomeDirectory,
    randomIdentifier: () => secondGenerationIdentifier,
    isAddressActive: async () => true,
  });

  const results = await Promise.allSettled([
    firstStore.reserve(conversationIdentifier, endpoints),
    secondStore.reserve(conversationIdentifier, conflictingEndpoints),
  ]);

  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
});

test("does not restore a prior route over a concurrent replacement generation", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  let blockRollbackLiveness = false;
  let observeRollbackLiveness: (() => void) | undefined;
  const rollbackLivenessStarted = new Promise<void>((resolveStarted) => {
    observeRollbackLiveness = resolveStarted;
  });
  let releaseRollbackLiveness: (() => void) | undefined;
  const rollbackLivenessGate = new Promise<void>((resolveLiveness) => {
    releaseRollbackLiveness = resolveLiveness;
  });
  const rollbackStore = createConversationRouteStore({
    stateHomeDirectory,
    randomIdentifier: sequenceIdentifierFactory(
      firstGenerationIdentifier,
      secondGenerationIdentifier,
    ),
    isAddressActive: async () => {
      if (blockRollbackLiveness) {
        observeRollbackLiveness?.();
        await rollbackLivenessGate;
      }
      return true;
    },
  });
  const replacementStore = createConversationRouteStore({
    stateHomeDirectory,
    randomIdentifier: () => thirdGenerationIdentifier,
    isAddressActive: async () => true,
  });
  await rollbackStore.reserve(conversationIdentifier, endpoints);
  const failedReservation = await rollbackStore.reserve(
    conversationIdentifier,
    endpoints,
  );
  blockRollbackLiveness = true;
  const pendingRollback = rollbackStore.rollback(failedReservation);
  await rollbackLivenessStarted;

  const concurrentReplacement = await replacementStore.reserve(
    conversationIdentifier,
    endpoints,
  );
  releaseRollbackLiveness?.();

  assert.equal(await pendingRollback, false);
  assert.deepEqual(
    await replacementStore.findActive(conversationIdentifier),
    concurrentReplacement.route,
  );
});

test("allows only one store instance to consume the same reply capability generation", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const firstStore = createConversationRouteStore({
    stateHomeDirectory,
    randomIdentifier: sequenceIdentifierFactory(
      firstGenerationIdentifier,
      secondGenerationIdentifier,
    ),
    isAddressActive: async () => true,
  });
  const secondStore = createConversationRouteStore({
    stateHomeDirectory,
    randomIdentifier: () => thirdGenerationIdentifier,
    isAddressActive: async () => true,
  });
  const initialReservation = await firstStore.reserve(conversationIdentifier, {
    ...endpoints,
    claudeCanReply: true,
  });
  const consumedEndpoints: ConversationRouteEndpoints = {
    ...endpoints,
    codexCanReply: true,
    claudeCanReply: false,
  };

  const results = await Promise.allSettled([
    firstStore.reserve(conversationIdentifier, consumedEndpoints, {
      expectedGenerationId: initialReservation.route.generationId,
      requiredReplyCapability: "claude",
    }),
    secondStore.reserve(conversationIdentifier, consumedEndpoints, {
      expectedGenerationId: initialReservation.route.generationId,
      requiredReplyCapability: "claude",
    }),
  ]);

  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
});

test("does not hold the conversation lock while endpoint liveness is pending", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  let blockLiveness = false;
  let observeBlockedLiveness: (() => void) | undefined;
  const blockedLivenessStarted = new Promise<void>((resolveStarted) => {
    observeBlockedLiveness = resolveStarted;
  });
  let releaseBlockedLiveness: (() => void) | undefined;
  const blockedLiveness = new Promise<void>((resolveLiveness) => {
    releaseBlockedLiveness = resolveLiveness;
  });
  const routeStore = createConversationRouteStore({
    stateHomeDirectory,
    randomIdentifier: () => firstGenerationIdentifier,
    isAddressActive: async () => {
      if (blockLiveness) {
        observeBlockedLiveness?.();
        await blockedLiveness;
      }
      return true;
    },
  });
  const reservation = await routeStore.reserve(conversationIdentifier, endpoints);
  blockLiveness = true;
  const pendingLookup = routeStore.findActive(conversationIdentifier);
  await blockedLivenessStarted;

  const rollbackCompletedBeforeNextTurn = await Promise.race([
    routeStore
      .rollback(reservation)
      .then(() => true),
    new Promise<false>((resolveTimeout) =>
      setTimeout(() => resolveTimeout(false), 500),
    ),
  ]);
  releaseBlockedLiveness?.();
  await pendingLookup;

  assert.equal(rollbackCompletedBeforeNextTurn, true);
  assert.equal(await routeStore.findActive(conversationIdentifier), undefined);
});

test("deletes expired and inactive routes before returning or replacing them", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  let currentTimeMilliseconds = Date.parse("2026-09-04T10:00:00.000Z");
  let activeSessionIdentifiers = new Set([
    endpoints.codex.sessionId,
    endpoints.claude.sessionId,
  ]);
  const routeStore = createConversationRouteStore({
    stateHomeDirectory,
    timeToLiveMilliseconds: 100,
    currentDate: () => new Date(currentTimeMilliseconds),
    randomIdentifier: sequenceIdentifierFactory(
      firstGenerationIdentifier,
      secondGenerationIdentifier,
    ),
    isAddressActive: async (address) => activeSessionIdentifiers.has(address.sessionId),
  });
  await routeStore.reserve(conversationIdentifier, endpoints);

  currentTimeMilliseconds += 101;
  assert.equal(await routeStore.findActive(conversationIdentifier), undefined);
  const replacementAfterExpiry = await routeStore.reserve(
    conversationIdentifier,
    endpoints,
  );
  assert.equal(replacementAfterExpiry.route.generationId, secondGenerationIdentifier);

  activeSessionIdentifiers = new Set([endpoints.codex.sessionId]);
  assert.equal(await routeStore.findActive(conversationIdentifier), undefined);
  await assert.rejects(
    routeStore.reserve(conversationIdentifier, endpoints),
    /Both conversation endpoints must be active/u,
  );
});

test("removes corrupt private records and rejects symlinked conversation state", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const routeStore = createConversationRouteStore({
    stateHomeDirectory,
    randomIdentifier: () => firstGenerationIdentifier,
    isAddressActive: async () => true,
  });
  const reservation = await routeStore.reserve(conversationIdentifier, endpoints);
  const recordPath = resolveConversationRecordPath(
    stateHomeDirectory,
    conversationIdentifier,
  );
  await writeFile(recordPath, "not-json", "utf8");

  assert.equal(await routeStore.findActive(conversationIdentifier), undefined);
  await assert.rejects(lstat(recordPath), { code: "ENOENT" });

  const redirectedDirectory = join(stateHomeDirectory, "redirected-conversations");
  await mkdir(redirectedDirectory, { mode: 0o700 });
  const conversationDirectory = resolveConversationDirectory(stateHomeDirectory);
  await rm(conversationDirectory, { recursive: true });
  await symlink(redirectedDirectory, conversationDirectory);

  await assert.rejects(routeStore.reserve(conversationIdentifier, endpoints));
  assert.deepEqual(await import("node:fs/promises").then(({ readdir }) => readdir(redirectedDirectory)), []);
  assert.equal(reservation.route.generationId, firstGenerationIdentifier);
});

test("removes an oversized private route record before reading its contents", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const routeStore = createConversationRouteStore({
    stateHomeDirectory,
    randomIdentifier: () => firstGenerationIdentifier,
    isAddressActive: async () => true,
  });
  await routeStore.reserve(conversationIdentifier, endpoints);
  const recordPath = resolveConversationRecordPath(
    stateHomeDirectory,
    conversationIdentifier,
  );
  await writeFile(
    recordPath,
    "x".repeat(maximumSerializedConversationRouteRecordUtf8Bytes + 1),
    { mode: 0o600 },
  );

  assert.equal(await routeStore.findActive(conversationIdentifier), undefined);
  await assert.rejects(lstat(recordPath), { code: "ENOENT" });
});

test("rejects non-private route records without repairing or following them", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const routeStore = createConversationRouteStore({
    stateHomeDirectory,
    randomIdentifier: () => firstGenerationIdentifier,
    isAddressActive: async () => true,
  });
  await routeStore.reserve(conversationIdentifier, endpoints);
  const recordPath = resolveConversationRecordPath(
    stateHomeDirectory,
    conversationIdentifier,
  );
  await chmod(recordPath, 0o640);

  await assert.rejects(routeStore.findActive(conversationIdentifier), /not private/u);
});
