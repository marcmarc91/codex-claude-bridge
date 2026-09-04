import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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
const secondConversationIdentifier = "62212045-2128-4979-bc44-908c0955c072";
const thirdConversationIdentifier = "c9f5d58d-7d0d-4993-a328-6299465f1ad8";
const codexProjectIdentifier = "0123456789abcdef01234567";
const claudeProjectIdentifier = "fedcba987654321001234567";
const maximumExpectedConversationRouteRecords = 256;

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

function indexedIdentifier(
  index: number,
  variant: "conversation" | "generation",
): string {
  const boundedIndex = variant === "conversation" ? index : index + 100_000;
  return `00000000-0000-4000-8000-${boundedIndex.toString().padStart(12, "0")}`;
}

async function settlesBeforeDeadline(
  pendingOperation: Promise<unknown>,
  deadlineMilliseconds: number,
): Promise<boolean> {
  let deadline: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pendingOperation.then(() => true),
      new Promise<false>((resolveDeadline) => {
        deadline = setTimeout(
          () => resolveDeadline(false),
          deadlineMilliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
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

test("uses one persistent global mutation lock for every conversation", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const routeStore = createConversationRouteStore({
    stateHomeDirectory,
    randomIdentifier: sequenceIdentifierFactory(
      firstGenerationIdentifier,
      secondGenerationIdentifier,
      thirdGenerationIdentifier,
    ),
    isAddressActive: async () => true,
  });

  await routeStore.reserve(conversationIdentifier, endpoints);
  await routeStore.reserve(secondConversationIdentifier, endpoints);
  await routeStore.reserve(thirdConversationIdentifier, endpoints);

  assert.deepEqual(
    (await readdir(resolveConversationDirectory(stateHomeDirectory))).sort(),
    [
      ".mutation.lock",
      `${conversationIdentifier}.json`,
      `${secondConversationIdentifier}.json`,
      `${thirdConversationIdentifier}.json`,
    ].sort(),
  );
});

test("rejects rollback snapshots for another conversation or endpoint pair", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const routeStore = createConversationRouteStore({
    stateHomeDirectory,
    randomIdentifier: sequenceIdentifierFactory(
      firstGenerationIdentifier,
      secondGenerationIdentifier,
    ),
    isAddressActive: async () => true,
  });
  await routeStore.reserve(conversationIdentifier, endpoints);
  const reservation = await routeStore.reserve(conversationIdentifier, endpoints);
  assert.ok(reservation.previousRoute);

  await assert.rejects(
    routeStore.rollback({
      ...reservation,
      previousRoute: {
        ...reservation.previousRoute,
        conversationId: secondConversationIdentifier,
      },
    }),
    /same conversation/u,
  );
  await assert.rejects(
    routeStore.rollback({
      ...reservation,
      previousRoute: {
        ...reservation.previousRoute,
        claude: {
          ...reservation.previousRoute.claude,
          sessionId: thirdGenerationIdentifier,
        },
      },
    }),
    /same endpoints/u,
  );
  assert.deepEqual(
    await routeStore.findActive(conversationIdentifier),
    reservation.route,
  );
  assert.equal(await routeStore.findActive(secondConversationIdentifier), undefined);
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

test("opportunistically removes an abandoned route during another conversation operation", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const abandonedEndpoints: ConversationRouteEndpoints = {
    ...endpoints,
    claude: {
      ...endpoints.claude,
      sessionId: thirdGenerationIdentifier,
    },
  };
  const activeSessionIdentifiers = new Set([
    endpoints.codex.sessionId,
    endpoints.claude.sessionId,
    abandonedEndpoints.claude.sessionId,
  ]);
  const routeStore = createConversationRouteStore({
    stateHomeDirectory,
    randomIdentifier: sequenceIdentifierFactory(
      firstGenerationIdentifier,
      secondGenerationIdentifier,
    ),
    isAddressActive: async (address) => activeSessionIdentifiers.has(address.sessionId),
  });
  await routeStore.reserve(conversationIdentifier, abandonedEndpoints);
  const activeReservation = await routeStore.reserve(
    secondConversationIdentifier,
    endpoints,
  );
  activeSessionIdentifiers.delete(abandonedEndpoints.claude.sessionId);

  assert.deepEqual(
    await routeStore.findActive(secondConversationIdentifier),
    activeReservation.route,
  );
  await assert.rejects(
    lstat(resolveConversationRecordPath(stateHomeDirectory, conversationIdentifier)),
    { code: "ENOENT" },
  );
});

test("globally removes an expired abandoned route without probing its endpoints", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  let currentTimeMilliseconds = Date.parse("2026-09-04T10:00:00.000Z");
  let rejectAbandonedEndpointProbe = false;
  const abandonedEndpoints: ConversationRouteEndpoints = {
    ...endpoints,
    claude: {
      ...endpoints.claude,
      sessionId: thirdGenerationIdentifier,
    },
  };
  const routeStore = createConversationRouteStore({
    stateHomeDirectory,
    timeToLiveMilliseconds: 100,
    currentDate: () => new Date(currentTimeMilliseconds),
    randomIdentifier: sequenceIdentifierFactory(
      firstGenerationIdentifier,
      secondGenerationIdentifier,
    ),
    isAddressActive: async (address) => {
      if (
        rejectAbandonedEndpointProbe &&
        address.sessionId === abandonedEndpoints.claude.sessionId
      ) {
        throw new Error("Expired abandoned endpoint was probed");
      }
      return true;
    },
  });
  await routeStore.reserve(conversationIdentifier, abandonedEndpoints);
  currentTimeMilliseconds += 50;
  const activeReservation = await routeStore.reserve(
    secondConversationIdentifier,
    endpoints,
  );
  currentTimeMilliseconds += 51;
  rejectAbandonedEndpointProbe = true;

  assert.deepEqual(
    await routeStore.findActive(secondConversationIdentifier),
    activeReservation.route,
  );
  await assert.rejects(
    lstat(resolveConversationRecordPath(stateHomeDirectory, conversationIdentifier)),
    { code: "ENOENT" },
  );
});

test("prunes abandoned routes beyond one bounded liveness batch", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const activeSessionIdentifiers = new Set([
    endpoints.codex.sessionId,
    endpoints.claude.sessionId,
  ]);
  const routeStore = createConversationRouteStore({
    stateHomeDirectory,
    randomIdentifier: () => firstGenerationIdentifier,
    isAddressActive: async (address) => activeSessionIdentifiers.has(address.sessionId),
  });
  const activeRoute = (
    await routeStore.reserve(conversationIdentifier, endpoints)
  ).route;
  for (let index = 1; index <= 16; index += 1) {
    const generatedConversationIdentifier = indexedIdentifier(
      index,
      "conversation",
    );
    await writeFile(
      resolveConversationRecordPath(
        stateHomeDirectory,
        generatedConversationIdentifier,
      ),
      JSON.stringify({
        ...activeRoute,
        conversationId: generatedConversationIdentifier,
        generationId: indexedIdentifier(index, "generation"),
      }),
      { mode: 0o600 },
    );
  }
  const abandonedRoutePath = resolveConversationRecordPath(
    stateHomeDirectory,
    thirdConversationIdentifier,
  );
  await writeFile(
    abandonedRoutePath,
    JSON.stringify({
      ...activeRoute,
      conversationId: thirdConversationIdentifier,
      generationId: thirdGenerationIdentifier,
      claude: {
        ...activeRoute.claude,
        sessionId: thirdGenerationIdentifier,
      },
    }),
    { mode: 0o600 },
  );

  await routeStore.findActive(conversationIdentifier);

  await assert.rejects(lstat(abandonedRoutePath), { code: "ENOENT" });
});

test("does not hold the global lock during pruning liveness or remove a replacement generation", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  let blockAbandonedLiveness = false;
  let observePruningLiveness: (() => void) | undefined;
  const pruningLivenessStarted = new Promise<void>((resolveStarted) => {
    observePruningLiveness = resolveStarted;
  });
  let releasePruningLiveness: (() => void) | undefined;
  const pruningLivenessGate = new Promise<void>((resolveLiveness) => {
    releasePruningLiveness = resolveLiveness;
  });
  const abandonedEndpoints: ConversationRouteEndpoints = {
    ...endpoints,
    claude: {
      ...endpoints.claude,
      sessionId: thirdGenerationIdentifier,
    },
  };
  const pruningStore = createConversationRouteStore({
    stateHomeDirectory,
    randomIdentifier: sequenceIdentifierFactory(
      firstGenerationIdentifier,
      secondGenerationIdentifier,
    ),
    isAddressActive: async (address) => {
      if (
        blockAbandonedLiveness &&
        address.sessionId === abandonedEndpoints.claude.sessionId
      ) {
        observePruningLiveness?.();
        await pruningLivenessGate;
        return false;
      }
      return true;
    },
  });
  const replacementStore = createConversationRouteStore({
    stateHomeDirectory,
    randomIdentifier: () => thirdGenerationIdentifier,
    isAddressActive: async () => true,
  });
  await pruningStore.reserve(conversationIdentifier, abandonedEndpoints);
  await pruningStore.reserve(secondConversationIdentifier, endpoints);
  blockAbandonedLiveness = true;
  const pendingGlobalPrune = pruningStore.findActive(secondConversationIdentifier);
  const pruningStarted = await settlesBeforeDeadline(
    pruningLivenessStarted,
    2_000,
  );

  if (!pruningStarted) {
    releasePruningLiveness?.();
    await pendingGlobalPrune;
    assert.fail("Another-conversation operation did not probe abandoned routes");
  }
  const pendingReplacement = replacementStore.reserve(
    conversationIdentifier,
    abandonedEndpoints,
  );
  const replacementCompletedBeforeRelease = await settlesBeforeDeadline(
    pendingReplacement,
    2_000,
  );
  if (!replacementCompletedBeforeRelease) {
    releasePruningLiveness?.();
    await pendingGlobalPrune;
    await pendingReplacement;
    assert.fail("Pruning liveness held the global mutation lock");
  }
  const replacement = await pendingReplacement;
  releasePruningLiveness?.();
  await pendingGlobalPrune;

  assert.deepEqual(
    await replacementStore.findActive(conversationIdentifier),
    replacement.route,
  );
});

test("atomically refuses new routes at the fixed global cardinality limit", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const routeStore = createConversationRouteStore({
    stateHomeDirectory,
    randomIdentifier: sequenceIdentifierFactory(
      firstGenerationIdentifier,
      secondGenerationIdentifier,
      thirdGenerationIdentifier,
    ),
    isAddressActive: async () => true,
  });
  const templateRoute = (
    await routeStore.reserve(conversationIdentifier, endpoints)
  ).route;
  const conversationDirectory = resolveConversationDirectory(stateHomeDirectory);
  await Promise.all(
    Array.from(
      { length: maximumExpectedConversationRouteRecords - 2 },
      async (_, offset) => {
        const index = offset + 1;
        const generatedConversationIdentifier = indexedIdentifier(
          index,
          "conversation",
        );
        await writeFile(
          resolveConversationRecordPath(
            stateHomeDirectory,
            generatedConversationIdentifier,
          ),
          JSON.stringify({
            ...templateRoute,
            conversationId: generatedConversationIdentifier,
            generationId: indexedIdentifier(index, "generation"),
          }),
          { mode: 0o600 },
        );
      },
    ),
  );

  const results = await Promise.allSettled([
    routeStore.reserve(secondConversationIdentifier, endpoints),
    routeStore.reserve(thirdConversationIdentifier, endpoints),
  ]);
  const routeRecordNames = (await readdir(conversationDirectory)).filter(
    (entryName) => entryName.endsWith(".json"),
  );
  const rejectedResults = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );

  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(rejectedResults.length, 1);
  assert.match(String(rejectedResults[0]?.reason), /capacity/u);
  assert.equal(routeRecordNames.length, maximumExpectedConversationRouteRecords);

  const overflowConversationIdentifier = indexedIdentifier(
    maximumExpectedConversationRouteRecords + 1,
    "conversation",
  );
  await writeFile(
    resolveConversationRecordPath(
      stateHomeDirectory,
      overflowConversationIdentifier,
    ),
    JSON.stringify({
      ...templateRoute,
      conversationId: overflowConversationIdentifier,
      generationId: indexedIdentifier(
        maximumExpectedConversationRouteRecords + 1,
        "generation",
      ),
    }),
    { mode: 0o600 },
  );
  await assert.rejects(
    routeStore.findActive(conversationIdentifier),
    /capacity/u,
  );
});

test("global pruning removes corrupt and oversized private records", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory(testContext);
  const routeStore = createConversationRouteStore({
    stateHomeDirectory,
    randomIdentifier: sequenceIdentifierFactory(
      firstGenerationIdentifier,
      secondGenerationIdentifier,
      thirdGenerationIdentifier,
    ),
    isAddressActive: async () => true,
  });
  await routeStore.reserve(conversationIdentifier, endpoints);
  const activeReservation = await routeStore.reserve(
    secondConversationIdentifier,
    endpoints,
  );
  await routeStore.reserve(thirdConversationIdentifier, endpoints);
  const corruptRoutePath = resolveConversationRecordPath(
    stateHomeDirectory,
    conversationIdentifier,
  );
  const oversizedRoutePath = resolveConversationRecordPath(
    stateHomeDirectory,
    thirdConversationIdentifier,
  );
  await writeFile(corruptRoutePath, "not-json", "utf8");
  await writeFile(
    oversizedRoutePath,
    "x".repeat(maximumSerializedConversationRouteRecordUtf8Bytes + 1),
    "utf8",
  );

  assert.deepEqual(
    await routeStore.findActive(secondConversationIdentifier),
    activeReservation.route,
  );
  await assert.rejects(lstat(corruptRoutePath), { code: "ENOENT" });
  await assert.rejects(lstat(oversizedRoutePath), { code: "ENOENT" });
});

test("global pruning never follows symlinks or repairs non-private records", async (testContext) => {
  await testContext.test("rejects a route symlink without touching its target", async (nestedContext) => {
    const stateHomeDirectory = await createStateHomeDirectory(nestedContext);
    const routeStore = createConversationRouteStore({
      stateHomeDirectory,
      randomIdentifier: () => firstGenerationIdentifier,
      isAddressActive: async () => true,
    });
    await routeStore.reserve(secondConversationIdentifier, endpoints);
    const externalRecordPath = join(stateHomeDirectory, "external-route.json");
    const symlinkedRoutePath = resolveConversationRecordPath(
      stateHomeDirectory,
      conversationIdentifier,
    );
    await writeFile(externalRecordPath, "external", { mode: 0o600 });
    await symlink(externalRecordPath, symlinkedRoutePath);

    await assert.rejects(routeStore.findActive(secondConversationIdentifier));
    assert.equal(await readFile(externalRecordPath, "utf8"), "external");
    assert.equal((await lstat(symlinkedRoutePath)).isSymbolicLink(), true);
  });

  await testContext.test("rejects a non-private route without changing its mode", async (nestedContext) => {
    const stateHomeDirectory = await createStateHomeDirectory(nestedContext);
    const routeStore = createConversationRouteStore({
      stateHomeDirectory,
      randomIdentifier: sequenceIdentifierFactory(
        firstGenerationIdentifier,
        secondGenerationIdentifier,
      ),
      isAddressActive: async () => true,
    });
    await routeStore.reserve(conversationIdentifier, endpoints);
    await routeStore.reserve(secondConversationIdentifier, endpoints);
    const nonPrivateRoutePath = resolveConversationRecordPath(
      stateHomeDirectory,
      conversationIdentifier,
    );
    await chmod(nonPrivateRoutePath, 0o640);

    await assert.rejects(
      routeStore.findActive(secondConversationIdentifier),
      /not private/u,
    );
    assert.equal((await stat(nonPrivateRoutePath)).mode & 0o777, 0o640);
  });
});

test("does not hold the global lock while target liveness is pending", async (testContext) => {
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
