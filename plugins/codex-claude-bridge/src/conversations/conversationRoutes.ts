import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
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
  projectIdentitySchema,
  resolveConversationDirectory,
} from "../runtime/paths.js";

const canonicalTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .datetime({ offset: false, precision: 3 });

const codexAddressSchema = z
  .object({
    runtime: z.literal("codex"),
    sessionId: uuidSchema,
    projectId: projectIdentitySchema,
  })
  .strict();

const claudeAddressSchema = z
  .object({
    runtime: z.literal("claude"),
    sessionId: uuidSchema,
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
    conversationId: uuidSchema,
    generationId: uuidSchema,
    expiresAt: canonicalTimestampSchema,
  })
  .strict();

const conversationRouteReservationSchema = z
  .object({
    route: conversationRouteSchema,
    previousRoute: conversationRouteSchema.optional(),
  })
  .strict();

const conversationRouteReservationConditionSchema = z
  .object({
    expectedGenerationId: uuidSchema,
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
  const exitCode = await new Promise<number | null>((resolveProcess, rejectProcess) => {
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
  });

  if (exitCode === 75) {
    throw new Error("Timed out waiting for a conversation mutation lock");
  }
  if (exitCode !== 0) {
    throw new Error(`Unable to acquire the conversation mutation lock: ${String(exitCode)}`);
  }
}

async function withConversationMutationLock<Result>(
  stateHomeDirectory: string | undefined,
  conversationIdentifier: string,
  operation: (context: ConversationMutationContext) => Promise<Result>,
): Promise<Result> {
  const validatedConversationIdentifier = uuidSchema.parse(conversationIdentifier);
  const bridgeStateContext = await prepareSecureBridgeState(stateHomeDirectory);
  const conversationDirectory = join(
    bridgeStateContext.bridgeStateDirectory,
    "conversations",
  );
  const lockDirectory = join(conversationDirectory, ".locks");
  await ensurePrivateBridgeDirectory(
    bridgeStateContext,
    conversationDirectory,
    true,
  );
  await ensurePrivateBridgeDirectory(bridgeStateContext, lockDirectory, true);
  const lockFile = await openOrCreatePrivateRegularFile(
    bridgeStateContext,
    join(lockDirectory, `${validatedConversationIdentifier}.lock`),
  );
  let operationFailed = false;
  try {
    await acquireConversationLock(lockFile.fileHandle.fd);
    return await operation({ bridgeStateContext, conversationDirectory });
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

function routeRecordPath(
  conversationDirectory: string,
  conversationIdentifier: string,
): string {
  return join(conversationDirectory, `${uuidSchema.parse(conversationIdentifier)}.json`);
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
      return {
        exists: true,
        route: conversationRouteSchema.parse(JSON.parse(serializedRoute)),
      };
    } catch {
      return { exists: true };
    }
  } finally {
    await openedRecord.fileHandle.close();
  }
}

async function writeConversationRoute(
  context: ConversationMutationContext,
  route: ConversationRoute,
): Promise<void> {
  const recordPath = routeRecordPath(
    context.conversationDirectory,
    route.conversationId,
  );
  const temporaryRecordPath = join(
    context.conversationDirectory,
    `.${route.conversationId}.${route.generationId}.tmp`,
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
    withConversationMutationLock(
      options.stateHomeDirectory,
      conversationIdentifier,
      (context) => readValidConversationRoute(context, conversationIdentifier),
    );

  return {
    async reserve(conversationIdentifier, inputEndpoints, inputCondition) {
      const validatedConversationIdentifier = uuidSchema.parse(
        conversationIdentifier,
      );
      const endpoints = routeEndpointsSchema.parse(inputEndpoints);
      const condition =
        inputCondition === undefined
          ? undefined
          : conversationRouteReservationConditionSchema.parse(inputCondition);

      for (
        let attempt = 0;
        attempt < maximumOptimisticMutationAttempts;
        attempt += 1
      ) {
        const snapshot = await readRouteSnapshot(validatedConversationIdentifier);
        const snapshotIsActive =
          snapshot !== undefined && (await routeIsActive(snapshot));
        if (
          condition !== undefined &&
          (!snapshotIsActive ||
            snapshot?.generationId !== condition.expectedGenerationId ||
            (condition.requiredReplyCapability === "codex"
              ? !snapshot.codexCanReply
              : !snapshot.claudeCanReply))
        ) {
          throw new Error("Conversation reply authorization is no longer active");
        }
        if (
          snapshotIsActive &&
          snapshot !== undefined &&
          !endpointsMatch(snapshot, endpoints)
        ) {
          const collisionIsCurrent = await withConversationMutationLock(
            options.stateHomeDirectory,
            validatedConversationIdentifier,
            async (context) =>
              routeGenerationMatches(
                snapshot,
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
        const mutationResult = await withConversationMutationLock(
          options.stateHomeDirectory,
          validatedConversationIdentifier,
          async (context) => {
            const currentRoute = await readValidConversationRoute(
              context,
              validatedConversationIdentifier,
            );
            if (!routeGenerationMatches(snapshot, currentRoute)) {
              return undefined;
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
            const generationIdentifier = uuidSchema.parse(randomIdentifier());
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
            await writeConversationRoute(context, route);
            return conversationRouteReservationSchema.parse({
              route,
              ...(snapshotIsActive && snapshot !== undefined
                ? { previousRoute: snapshot }
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
      const validatedConversationIdentifier = uuidSchema.parse(
        conversationIdentifier,
      );
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
        const readResult = await withConversationMutationLock(
          options.stateHomeDirectory,
          validatedConversationIdentifier,
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
      return withConversationMutationLock(
        options.stateHomeDirectory,
        validatedConversationIdentifier,
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
            await writeConversationRoute(context, reservation.previousRoute);
          } else {
            await removeRoute(context, validatedConversationIdentifier);
          }
          return true;
        },
      );
    },
  };
}
