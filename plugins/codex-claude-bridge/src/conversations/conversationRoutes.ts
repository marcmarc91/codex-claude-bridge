import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { opendir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  AgentRuntime,
  uuidSchema,
  type AgentAddress,
} from "../protocol/messageEnvelope.js";
import {
  findActiveSession,
  type ActiveSessionRecord,
} from "../registry/activeSessionRegistry.js";
import {
  createPrivateRegularFile,
  ensurePrivateBridgeDirectory,
  openExistingPrivateRegularFile,
  openOrCreatePrivateRegularFile,
  prepareSecureBridgeState,
  removePrivateRegularFileIfPresent,
  renamePrivateRegularFile,
  type SecureBridgeStateContext,
} from "../registry/secureStateFilesystem.js";
import {
  normalizeConversationIdentifier,
  projectIdentitySchema,
  resolveConversationDirectory,
} from "../runtime/paths.js";

const canonicalUuidSchema = uuidSchema.transform((identifier) =>
  identifier.toLowerCase(),
);

const canonicalTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .datetime({ offset: false, precision: 3 });

const codexAddressSchema = z
  .object({
    runtime: z.literal("codex"),
    sessionId: canonicalUuidSchema,
    projectId: projectIdentitySchema,
  })
  .strict();

const claudeAddressSchema = z
  .object({
    runtime: z.literal("claude"),
    sessionId: canonicalUuidSchema,
    projectId: projectIdentitySchema,
  })
  .strict();

const routeEndpointsSchema = z
  .object({
    codex: codexAddressSchema,
    claude: claudeAddressSchema,
    codexCanReply: z.boolean(),
    claudeCanReply: z.boolean(),
  })
  .strict();

const conversationRouteSchema = routeEndpointsSchema
  .extend({
    schemaVersion: z.literal(1),
    conversationId: canonicalUuidSchema,
    generationId: canonicalUuidSchema,
    expiresAt: canonicalTimestampSchema,
  })
  .strict();

const conversationRouteReservationSchema = z
  .object({
    route: conversationRouteSchema,
    previousRoute: conversationRouteSchema.optional(),
  })
  .strict()
  .superRefine((reservation, refinementContext) => {
    if (reservation.previousRoute === undefined) {
      return;
    }
    if (
      reservation.previousRoute.conversationId !==
      reservation.route.conversationId
    ) {
      refinementContext.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Previous route must belong to the same conversation",
        path: ["previousRoute", "conversationId"],
      });
    }
    if (!endpointsMatch(reservation.route, reservation.previousRoute)) {
      refinementContext.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Previous route must use the same endpoints",
        path: ["previousRoute"],
      });
    }
  });

const conversationRouteReservationConditionSchema = z
  .object({
    expectedGenerationId: canonicalUuidSchema,
    requiredReplyCapability: z.enum(["codex", "claude"]),
  })
  .strict();

export type ConversationRouteEndpoints = z.infer<typeof routeEndpointsSchema>;
export type ConversationRoute = z.infer<typeof conversationRouteSchema>;
export type ConversationRouteReservation = z.infer<
  typeof conversationRouteReservationSchema
>;
export type ConversationRouteReservationCondition = z.infer<
  typeof conversationRouteReservationConditionSchema
>;

const maximumBoundedConversationRoute: ConversationRoute = {
  schemaVersion: 1,
  conversationId: "ffffffff-ffff-4fff-bfff-ffffffffffff",
  generationId: "ffffffff-ffff-4fff-bfff-ffffffffffff",
  expiresAt: "9999-12-31T23:59:59.999Z",
  codex: {
    runtime: "codex",
    sessionId: "ffffffff-ffff-4fff-bfff-ffffffffffff",
    projectId: "ffffffffffffffffffffffff",
  },
  claude: {
    runtime: "claude",
    sessionId: "ffffffff-ffff-4fff-bfff-ffffffffffff",
    projectId: "ffffffffffffffffffffffff",
  },
  codexCanReply: false,
  claudeCanReply: false,
};

export const maximumSerializedConversationRouteRecordUtf8Bytes =
  Buffer.byteLength(JSON.stringify(maximumBoundedConversationRoute), "utf8");

export interface CreateConversationRouteStoreOptions {
  stateHomeDirectory?: string;
  timeToLiveMilliseconds?: number;
  randomIdentifier?: () => string;
  currentDate?: () => Date;
  isAddressActive?: (address: AgentAddress) => Promise<boolean>;
}

export interface ConversationRouteStore {
  reserve(
    conversationIdentifier: string,
    endpoints: ConversationRouteEndpoints,
    condition?: ConversationRouteReservationCondition,
  ): Promise<ConversationRouteReservation>;
  findActive(
    conversationIdentifier: string,
  ): Promise<ConversationRoute | undefined>;
  rollback(reservation: ConversationRouteReservation): Promise<boolean>;
}

interface ConversationMutationContext {
  bridgeStateContext: SecureBridgeStateContext;
  conversationDirectory: string;
}

const defaultTimeToLiveMilliseconds = 900_000;
const lockAcquisitionTimeoutSeconds = 4;
const maximumOptimisticMutationAttempts = 8;
const maximumConversationRouteRecords = 256;
const maximumLivenessChecksPerPrune = 16;
const maximumRouteMutationsPerLock = 16;

function addressesMatch(firstAddress: AgentAddress, secondAddress: AgentAddress): boolean {
  return (
    firstAddress.runtime === secondAddress.runtime &&
    firstAddress.sessionId === secondAddress.sessionId &&
    firstAddress.projectId === secondAddress.projectId
  );
}

function endpointsMatch(
  firstEndpoints: ConversationRouteEndpoints,
  secondEndpoints: ConversationRouteEndpoints,
): boolean {
  return (
    addressesMatch(firstEndpoints.codex, secondEndpoints.codex) &&
    addressesMatch(firstEndpoints.claude, secondEndpoints.claude)
  );
}

async function acquireConversationLock(fileDescriptor: number): Promise<void> {
  const exitCode = await new Promise<number | null>(
    (resolveProcess, rejectProcess) => {
      const lockProcess = spawn(
        "/usr/bin/lockf",
        ["-s", "-t", String(lockAcquisitionTimeoutSeconds), "3"],
        {
          shell: false,
          stdio: ["ignore", "ignore", "ignore", fileDescriptor],
        },
      );
      lockProcess.once("error", rejectProcess);
      lockProcess.once("close", resolveProcess);
    },
  );

  if (exitCode === 75) {
    throw new Error("Timed out waiting for a conversation mutation lock");
  }
  if (exitCode !== 0) {
    throw new Error(
      `Unable to acquire the conversation mutation lock: ${String(exitCode)}`,
    );
  }
}

async function createConversationMutationContext(
  stateHomeDirectory: string | undefined,
): Promise<ConversationMutationContext> {
  const bridgeStateContext = await prepareSecureBridgeState(stateHomeDirectory);
  const conversationDirectory = await ensurePrivateBridgeDirectory(
    bridgeStateContext,
    resolveConversationDirectory(stateHomeDirectory),
    true,
  );
  return { bridgeStateContext, conversationDirectory };
}

async function withConversationStoreMutationLock<Result>(
  stateHomeDirectory: string | undefined,
  operation: (context: ConversationMutationContext) => Promise<Result>,
): Promise<Result> {
  const conversationMutationContext = await createConversationMutationContext(
    stateHomeDirectory,
  );
  const lockFile = await openOrCreatePrivateRegularFile(
    conversationMutationContext.bridgeStateContext,
    join(conversationMutationContext.conversationDirectory, ".mutation.lock"),
  );
  let operationFailed = false;
  try {
    await acquireConversationLock(lockFile.fileHandle.fd);
    return await operation(conversationMutationContext);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    if (operationFailed) {
      await lockFile.fileHandle.close().catch(() => undefined);
    } else {
      await lockFile.fileHandle.close();
    }
  }
}

function conversationIdentifierFromRecordName(
  recordName: string,
): string | undefined {
  if (!recordName.endsWith(".json")) {
    return undefined;
  }
  const conversationIdentifier = recordName.slice(0, -".json".length);
  try {
    return normalizeConversationIdentifier(conversationIdentifier);
  } catch {
    return undefined;
  }
}

async function listConversationIdentifiers(
  conversationDirectory: string,
): Promise<string[]> {
  const conversationIdentifiers: string[] = [];
  const conversationDirectoryHandle = await opendir(conversationDirectory);
  for await (const directoryEntry of conversationDirectoryHandle) {
    const conversationIdentifier = conversationIdentifierFromRecordName(
      directoryEntry.name,
    );
    if (conversationIdentifier === undefined) {
      continue;
    }
    conversationIdentifiers.push(conversationIdentifier);
    if (conversationIdentifiers.length > maximumConversationRouteRecords) {
      throw new Error("Conversation route capacity is exceeded");
    }
  }
  return conversationIdentifiers;
}

function routeRecordPath(
  conversationDirectory: string,
  conversationIdentifier: string,
): string {
  return join(
    conversationDirectory,
    `${normalizeConversationIdentifier(conversationIdentifier)}.json`,
  );
}

async function readConversationRoute(
  context: ConversationMutationContext,
  conversationIdentifier: string,
): Promise<{ exists: boolean; route?: ConversationRoute }> {
  let openedRecord;
  try {
    openedRecord = await openExistingPrivateRegularFile(
      context.bridgeStateContext,
      routeRecordPath(context.conversationDirectory, conversationIdentifier),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }

  try {
    const recordStatus = await openedRecord.fileHandle.stat();
    if (
      recordStatus.size > maximumSerializedConversationRouteRecordUtf8Bytes
    ) {
      return { exists: true };
    }
    const serializedRoute = await openedRecord.fileHandle.readFile("utf8");
    try {
      const route = conversationRouteSchema.parse(JSON.parse(serializedRoute));
      if (
        route.conversationId !==
        normalizeConversationIdentifier(conversationIdentifier)
      ) {
        return { exists: true };
      }
      return { exists: true, route };
    } catch {
      return { exists: true };
    }
  } finally {
    await openedRecord.fileHandle.close();
  }
}

async function writeConversationRoute(
  context: ConversationMutationContext,
  conversationIdentifier: string,
  route: ConversationRoute,
): Promise<void> {
  const validatedConversationIdentifier = normalizeConversationIdentifier(
    conversationIdentifier,
  );
  if (route.conversationId !== validatedConversationIdentifier) {
    throw new Error("Conversation route must match the locked conversation");
  }
  const recordPath = routeRecordPath(
    context.conversationDirectory,
    validatedConversationIdentifier,
  );
  const temporaryRecordPath = join(
    context.conversationDirectory,
    `.${validatedConversationIdentifier}.${route.generationId}.tmp`,
  );
  let temporaryRecord;
  try {
    temporaryRecord = await createPrivateRegularFile(
      context.bridgeStateContext,
      temporaryRecordPath,
    );
    await temporaryRecord.fileHandle.writeFile(JSON.stringify(route), "utf8");
    await temporaryRecord.fileHandle.chmod(0o600);
    await temporaryRecord.fileHandle.close();
    temporaryRecord = undefined;
    await renamePrivateRegularFile(
      context.bridgeStateContext,
      temporaryRecordPath,
      recordPath,
    );
    const storedRecord = await openExistingPrivateRegularFile(
      context.bridgeStateContext,
      recordPath,
    );
    await storedRecord.fileHandle.close();
  } catch (error) {
    if (temporaryRecord !== undefined) {
      await temporaryRecord.fileHandle.close().catch(() => undefined);
    }
    await removePrivateRegularFileIfPresent(
      context.bridgeStateContext,
      temporaryRecordPath,
    ).catch(() => undefined);
    throw error;
  }
}

async function removeRoute(
  context: ConversationMutationContext,
  conversationIdentifier: string,
): Promise<boolean> {
  return removePrivateRegularFileIfPresent(
    context.bridgeStateContext,
    routeRecordPath(context.conversationDirectory, conversationIdentifier),
  );
}

async function readValidConversationRoute(
  context: ConversationMutationContext,
  conversationIdentifier: string,
): Promise<ConversationRoute | undefined> {
  const storedRoute = await readConversationRoute(context, conversationIdentifier);
  if (storedRoute.route !== undefined) {
    return storedRoute.route;
  }
  if (storedRoute.exists) {
    await removeRoute(context, conversationIdentifier);
  }
  return undefined;
}

function routeGenerationMatches(
  snapshot: ConversationRoute | undefined,
  currentRoute: ConversationRoute | undefined,
): boolean {
  if (snapshot === undefined || currentRoute === undefined) {
    return snapshot === currentRoute;
  }
  return snapshot.generationId === currentRoute.generationId;
}

async function defaultAddressIsActive(
  address: AgentAddress,
  stateHomeDirectory?: string,
): Promise<boolean> {
  const activeSession = await findActiveSession(
    address.sessionId,
    { runtime: AgentRuntime.parse(address.runtime), projectId: address.projectId },
    stateHomeDirectory,
  );
  return (
    activeSession !== undefined &&
    activeSession.runtime === address.runtime &&
    activeSession.sessionId === address.sessionId &&
    activeSession.projectId === address.projectId
  );
}

export function createConversationRouteStore(
  options: CreateConversationRouteStoreOptions = {},
): ConversationRouteStore {
  const timeToLiveMilliseconds = z
    .number()
    .int()
    .min(1)
    .max(86_400_000)
    .parse(options.timeToLiveMilliseconds ?? defaultTimeToLiveMilliseconds);
  const currentDate = options.currentDate ?? (() => new Date());
  const randomIdentifier = options.randomIdentifier ?? randomUUID;
  const isAddressActive =
    options.isAddressActive ??
    ((address: AgentAddress) =>
      defaultAddressIsActive(address, options.stateHomeDirectory));

  const routeIsActive = async (route: ConversationRoute): Promise<boolean> => {
    const now = currentDate();
    if (!Number.isFinite(now.getTime())) {
      throw new Error("Current date is invalid");
    }
    if (Date.parse(route.expiresAt) <= now.getTime()) {
      return false;
    }
    const [codexIsActive, claudeIsActive] = await Promise.all([
      isAddressActive(route.codex),
      isAddressActive(route.claude),
    ]);
    return codexIsActive && claudeIsActive;
  };

  const readRouteSnapshot = (conversationIdentifier: string) =>
    withConversationStoreMutationLock(
      options.stateHomeDirectory,
      (context) => readValidConversationRoute(context, conversationIdentifier),
    );

  const snapshotConversationRoutes = async (): Promise<ConversationRoute[]> => {
    const conversationIdentifiers = await withConversationStoreMutationLock(
      options.stateHomeDirectory,
      (context) => listConversationIdentifiers(context.conversationDirectory),
    );
    const snapshotContext = await createConversationMutationContext(
      options.stateHomeDirectory,
    );
    const routes: ConversationRoute[] = [];
    const invalidConversationIdentifiers: string[] = [];
    for (const conversationIdentifier of conversationIdentifiers) {
      const storedRoute = await readConversationRoute(
        snapshotContext,
        conversationIdentifier,
      );
      if (storedRoute.route !== undefined) {
        routes.push(storedRoute.route);
      } else if (storedRoute.exists) {
        invalidConversationIdentifiers.push(conversationIdentifier);
      }
    }
    if (invalidConversationIdentifiers.length > 0) {
      for (
        let batchStartIndex = 0;
        batchStartIndex < invalidConversationIdentifiers.length;
        batchStartIndex += maximumRouteMutationsPerLock
      ) {
        const conversationIdentifierBatch = invalidConversationIdentifiers.slice(
          batchStartIndex,
          batchStartIndex + maximumRouteMutationsPerLock,
        );
        await withConversationStoreMutationLock(
          options.stateHomeDirectory,
          async (context) => {
            for (const conversationIdentifier of conversationIdentifierBatch) {
              const currentRoute = await readConversationRoute(
                context,
                conversationIdentifier,
              );
              if (currentRoute.exists && currentRoute.route === undefined) {
                await removeRoute(context, conversationIdentifier);
              }
            }
          },
        );
      }
    }
    return routes;
  };

  const pruneConversationRoutes = async (
    excludedConversationIdentifier: string,
  ): Promise<void> => {
    const routeSnapshots = (await snapshotConversationRoutes()).filter(
      (route) => route.conversationId !== excludedConversationIdentifier,
    );
    routeSnapshots.sort(
      (firstRoute, secondRoute) =>
        firstRoute.expiresAt.localeCompare(secondRoute.expiresAt) ||
        firstRoute.conversationId.localeCompare(secondRoute.conversationId),
    );
    const routeActivity: Array<{
      route: ConversationRoute;
      active: boolean;
    }> = [];
    for (
      let batchStartIndex = 0;
      batchStartIndex < routeSnapshots.length;
      batchStartIndex += maximumLivenessChecksPerPrune
    ) {
      const routeBatch = routeSnapshots.slice(
        batchStartIndex,
        batchStartIndex + maximumLivenessChecksPerPrune,
      );
      routeActivity.push(
        ...(await Promise.all(
          routeBatch.map(async (route) => ({
            route,
            active: await routeIsActive(route),
          })),
        )),
      );
    }
    const staleRouteSnapshots = routeActivity
      .filter(({ active }) => !active)
      .map(({ route }) => route);
    if (staleRouteSnapshots.length === 0) {
      return;
    }
    for (
      let batchStartIndex = 0;
      batchStartIndex < staleRouteSnapshots.length;
      batchStartIndex += maximumRouteMutationsPerLock
    ) {
      const staleRouteBatch = staleRouteSnapshots.slice(
        batchStartIndex,
        batchStartIndex + maximumRouteMutationsPerLock,
      );
      await withConversationStoreMutationLock(
        options.stateHomeDirectory,
        async (context) => {
          for (const staleRouteSnapshot of staleRouteBatch) {
            const currentRoute = await readValidConversationRoute(
              context,
              staleRouteSnapshot.conversationId,
            );
            if (
              currentRoute?.generationId === staleRouteSnapshot.generationId
            ) {
              await removeRoute(context, staleRouteSnapshot.conversationId);
            }
          }
        },
      );
    }
  };

  return {
    async reserve(conversationIdentifier, inputEndpoints, inputCondition) {
      const validatedConversationIdentifier = normalizeConversationIdentifier(
        conversationIdentifier,
      );
      const endpoints = routeEndpointsSchema.parse(inputEndpoints);
      const condition =
        inputCondition === undefined
          ? undefined
          : conversationRouteReservationConditionSchema.parse(inputCondition);
      await pruneConversationRoutes(validatedConversationIdentifier);

      for (
        let attempt = 0;
        attempt < maximumOptimisticMutationAttempts;
        attempt += 1
      ) {
        const snapshot = await readRouteSnapshot(validatedConversationIdentifier);
        const snapshotIsActive =
          snapshot !== undefined && (await routeIsActive(snapshot));
        let activeSnapshot = snapshotIsActive ? snapshot : undefined;
        if (snapshot !== undefined && !snapshotIsActive) {
          const staleSnapshotWasRemoved = await withConversationStoreMutationLock(
            options.stateHomeDirectory,
            async (context) => {
              const currentRoute = await readValidConversationRoute(
                context,
                validatedConversationIdentifier,
              );
              if (!routeGenerationMatches(snapshot, currentRoute)) {
                return false;
              }
              await removeRoute(context, validatedConversationIdentifier);
              return true;
            },
          );
          if (!staleSnapshotWasRemoved) {
            continue;
          }
          activeSnapshot = undefined;
        }
        if (
          condition !== undefined &&
          (activeSnapshot === undefined ||
            activeSnapshot.generationId !== condition.expectedGenerationId ||
            (condition.requiredReplyCapability === "codex"
              ? !activeSnapshot.codexCanReply
              : !activeSnapshot.claudeCanReply))
        ) {
          throw new Error("Conversation reply authorization is no longer active");
        }
        if (
          activeSnapshot !== undefined &&
          !endpointsMatch(activeSnapshot, endpoints)
        ) {
          const collisionIsCurrent = await withConversationStoreMutationLock(
            options.stateHomeDirectory,
            async (context) =>
              routeGenerationMatches(
                activeSnapshot,
                await readValidConversationRoute(
                  context,
                  validatedConversationIdentifier,
                ),
              ),
          );
          if (collisionIsCurrent) {
            throw new Error(
              "Conversation is owned by different active endpoints",
            );
          }
          continue;
        }
        const [codexIsActive, claudeIsActive] = await Promise.all([
          isAddressActive(endpoints.codex),
          isAddressActive(endpoints.claude),
        ]);
        if (!codexIsActive || !claudeIsActive) {
          throw new Error("Both conversation endpoints must be active");
        }
        const mutationResult = await withConversationStoreMutationLock(
          options.stateHomeDirectory,
          async (context) => {
            const currentRoute = await readValidConversationRoute(
              context,
              validatedConversationIdentifier,
            );
            if (!routeGenerationMatches(activeSnapshot, currentRoute)) {
              return undefined;
            }
            if (
              currentRoute === undefined &&
              (await listConversationIdentifiers(context.conversationDirectory))
                .length >= maximumConversationRouteRecords
            ) {
              throw new Error("Conversation route capacity is exhausted");
            }
            if (
              condition !== undefined &&
              (currentRoute === undefined ||
                currentRoute.generationId !== condition.expectedGenerationId ||
                (condition.requiredReplyCapability === "codex"
                  ? !currentRoute.codexCanReply
                  : !currentRoute.claudeCanReply))
            ) {
              throw new Error("Conversation reply authorization is no longer active");
            }
            const now = currentDate();
            if (!Number.isFinite(now.getTime())) {
              throw new Error("Current date is invalid");
            }
            const generationIdentifier = canonicalUuidSchema.parse(
              randomIdentifier(),
            );
            if (generationIdentifier === currentRoute?.generationId) {
              throw new Error("Conversation route generation must be unique");
            }
            const route = conversationRouteSchema.parse({
              schemaVersion: 1,
              conversationId: validatedConversationIdentifier,
              generationId: generationIdentifier,
              expiresAt: new Date(
                now.getTime() + timeToLiveMilliseconds,
              ).toISOString(),
              ...endpoints,
            });
            await writeConversationRoute(
              context,
              validatedConversationIdentifier,
              route,
            );
            return conversationRouteReservationSchema.parse({
              route,
              ...(activeSnapshot !== undefined
                ? { previousRoute: activeSnapshot }
                : {}),
            });
          },
        );
        if (mutationResult !== undefined) {
          return mutationResult;
        }
      }
      throw new Error("Conversation route changed too many times");
    },
    async findActive(conversationIdentifier) {
      const validatedConversationIdentifier = normalizeConversationIdentifier(
        conversationIdentifier,
      );
      await pruneConversationRoutes(validatedConversationIdentifier);
      for (
        let attempt = 0;
        attempt < maximumOptimisticMutationAttempts;
        attempt += 1
      ) {
        const snapshot = await readRouteSnapshot(validatedConversationIdentifier);
        if (snapshot === undefined) {
          return undefined;
        }
        const snapshotIsActive = await routeIsActive(snapshot);
        const readResult = await withConversationStoreMutationLock(
          options.stateHomeDirectory,
          async (context) => {
            const currentRoute = await readValidConversationRoute(
              context,
              validatedConversationIdentifier,
            );
            if (!routeGenerationMatches(snapshot, currentRoute)) {
              return { retry: true as const };
            }
            if (!snapshotIsActive) {
              await removeRoute(context, validatedConversationIdentifier);
              return { retry: false as const, route: undefined };
            }
            return { retry: false as const, route: currentRoute };
          },
        );
        if (!readResult.retry) {
          return readResult.route;
        }
      }
      throw new Error("Conversation route changed too many times");
    },
    async rollback(inputReservation) {
      const reservation = conversationRouteReservationSchema.parse(
        inputReservation,
      );
      const validatedConversationIdentifier = reservation.route.conversationId;
      const previousRouteIsActive =
        reservation.previousRoute !== undefined &&
        (await routeIsActive(reservation.previousRoute));
      const rollbackResult = await withConversationStoreMutationLock(
        options.stateHomeDirectory,
        async (context) => {
          const storedRoute = await readConversationRoute(
            context,
            validatedConversationIdentifier,
          );
          if (storedRoute.route === undefined) {
            if (storedRoute.exists) {
              await removeRoute(context, validatedConversationIdentifier);
            }
            return false;
          }
          if (
            storedRoute.route.generationId !== reservation.route.generationId
          ) {
            return false;
          }
          if (previousRouteIsActive && reservation.previousRoute !== undefined) {
            await writeConversationRoute(
              context,
              validatedConversationIdentifier,
              reservation.previousRoute,
            );
          } else {
            await removeRoute(context, validatedConversationIdentifier);
          }
          return true;
        },
      );
      void pruneConversationRoutes(validatedConversationIdentifier).catch(
        () => undefined,
      );
      return rollbackResult;
    },
  };
}
