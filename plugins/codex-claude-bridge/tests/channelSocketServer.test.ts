import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { Socket, connect } from "node:net";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  type ChannelDeliveryResponse,
  startChannelSocketServer,
} from "../src/channel/channelSocketServer.js";
import {
  maximumSerializedAgentMessageEnvelopeFrameUtf8Bytes,
  type AgentMessageEnvelope,
} from "../src/protocol/messageEnvelope.js";
import {
  findActiveSession,
  registerActiveSession,
} from "../src/registry/activeSessionRegistry.js";

const projectIdentifier = "0123456789abcdef01234567";
const claudeSessionIdentifier = "ad65b1c1-7386-4465-80f9-4de0a26bc212";
const codexSessionIdentifier = "8d6380bf-1b93-44b3-b3da-a1a661cf8b69";

function validEnvelope(
  overrides: Partial<AgentMessageEnvelope> = {},
): AgentMessageEnvelope {
  return {
    schemaVersion: 1,
    messageId: "3c4b3c10-21a7-4d6f-b964-3c816b9ed8db",
    conversationId: "5cb1e2fd-5b24-4699-bfea-878e9b147370",
    sentAt: "2026-09-03T12:00:00.000Z",
    messageType: "question",
    sender: {
      runtime: "codex",
      sessionId: codexSessionIdentifier,
      projectId: projectIdentifier,
    },
    recipient: {
      runtime: "claude",
      sessionId: claudeSessionIdentifier,
      projectId: projectIdentifier,
    },
    content: "status?",
    replyRoute: {
      runtime: "codex",
      sessionId: codexSessionIdentifier,
      projectId: projectIdentifier,
    },
    ...overrides,
  };
}

async function createStateHomeDirectory(): Promise<string> {
  const stateHomeDirectory = await mkdtemp(join("/tmp", "ccb-channel-"));
  return stateHomeDirectory;
}

function owningSession() {
  return {
    sessionId: claudeSessionIdentifier,
    displayName: "claude-owner",
    processId: process.pid,
    workingDirectory: process.cwd(),
    projectId: projectIdentifier,
  };
}

async function registerCodexSender(
  stateHomeDirectory: string,
  senderProjectIdentifier = projectIdentifier,
): Promise<void> {
  await registerActiveSession(
    {
      schemaVersion: 1,
      runtime: "codex",
      sessionId: codexSessionIdentifier,
      displayName: "codex-sender",
      processId: process.pid,
      workingDirectory: process.cwd(),
      projectId: senderProjectIdentifier,
      registeredAt: "2026-09-03T12:00:00.000Z",
    },
    stateHomeDirectory,
  );
}

test("accepts an active Codex sender from another project", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory();
  const senderProjectIdentifier = "fedcba987654321001234567";
  await registerCodexSender(stateHomeDirectory, senderProjectIdentifier);
  const server = await startChannelSocketServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    deliverEnvelope: async () => undefined,
  });
  testContext.after(async () => {
    await server.close();
    await rm(stateHomeDirectory, { recursive: true, force: true });
  });
  const crossProjectEnvelope = validEnvelope({
    sender: {
      runtime: "codex",
      sessionId: codexSessionIdentifier,
      projectId: senderProjectIdentifier,
    },
    replyRoute: {
      runtime: "codex",
      sessionId: codexSessionIdentifier,
      projectId: senderProjectIdentifier,
    },
  });

  assert.deepEqual(
    await exchangeSocketFrame(
      server.socketPath,
      `${JSON.stringify(crossProjectEnvelope)}\n`,
    ),
    { delivered: true, messageId: crossProjectEnvelope.messageId },
  );
});

async function exchangeSocketFrame(
  socketPath: string,
  frame: string | Buffer,
  endConnection = true,
): Promise<ChannelDeliveryResponse> {
  return new Promise((resolveExchange, rejectExchange) => {
    const socket = connect(socketPath);
    const responseChunks: Buffer[] = [];
    const timeoutHandle = setTimeout(() => {
      socket.destroy();
      rejectExchange(new Error("Socket exchange timed out"));
    }, 2_000);

    socket.on("data", (chunk: Buffer) => responseChunks.push(chunk));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") {
        rejectExchange(error);
      }
    });
    socket.once("close", () => {
      clearTimeout(timeoutHandle);
      try {
        const serializedResponse = Buffer.concat(responseChunks).toString("utf8");
        assert.equal(serializedResponse.endsWith("\n"), true);
        assert.equal(serializedResponse.trimEnd().includes("\n"), false);
        resolveExchange(JSON.parse(serializedResponse) as ChannelDeliveryResponse);
      } catch (error) {
        rejectExchange(error);
      }
    });
    socket.once("connect", () => {
      socket.write(frame);
      if (endConnection) {
        socket.end();
      }
    });
  });
}

async function collectRejectedConnectionBytes(
  socketPath: string,
  frame: string,
): Promise<Buffer> {
  return new Promise((resolveConnection, rejectConnection) => {
    const socket = connect(socketPath);
    const receivedChunks: Buffer[] = [];
    const timeoutHandle = setTimeout(() => {
      socket.destroy();
      rejectConnection(new Error("Rejected socket did not close"));
    }, 2_000);
    socket.on("data", (chunk: Buffer) => receivedChunks.push(chunk));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ECONNRESET") {
        rejectConnection(error);
      }
    });
    socket.once("close", () => {
      clearTimeout(timeoutHandle);
      resolveConnection(Buffer.concat(receivedChunks));
    });
    socket.once("connect", () => {
      socket.end(frame);
    });
  });
}

test("accepts one bounded envelope and removes its private socket on close", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory();
  await registerCodexSender(stateHomeDirectory);
  const deliveredEnvelopes: AgentMessageEnvelope[] = [];
  const server = await startChannelSocketServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    deliverEnvelope: async (envelope) => {
      deliveredEnvelopes.push(envelope);
    },
  });
  testContext.after(async () => {
    await server.close();
    await rm(stateHomeDirectory, { recursive: true, force: true });
  });

  const canonicalStateHomeDirectory = await realpath(stateHomeDirectory);
  assert.equal(
    server.socketPath.startsWith(
      join(canonicalStateHomeDirectory, "codex-claude-bridge", "sockets"),
    ),
    true,
  );
  assert.equal((await stat(dirname(server.socketPath))).mode & 0o7777, 0o700);
  assert.equal((await lstat(server.socketPath)).isSocket(), true);
  assert.equal((await lstat(server.socketPath)).mode & 0o7777, 0o600);

  const response = await exchangeSocketFrame(
    server.socketPath,
    `${JSON.stringify(validEnvelope())}\n`,
  );

  assert.deepEqual(response, {
    delivered: true,
    messageId: validEnvelope().messageId,
  });
  const maximumContentValues = [
    "\0".repeat(65_536),
    "\u0001".repeat(65_536),
    '"'.repeat(65_536),
    "\\".repeat(65_536),
    "\0\u0001\"\\".repeat(16_384),
  ];
  for (const maximumContent of maximumContentValues) {
    const maximumContentEnvelope = validEnvelope({
      messageId: "ea7220bc-cd1e-41f0-bf7f-413982f18a9c",
      content: maximumContent,
    });
    const maximumContentFrame = `${JSON.stringify(maximumContentEnvelope)}\n`;
    assert.equal(Buffer.byteLength(maximumContent, "utf8"), 65_536);
    assert.deepEqual(
      await exchangeSocketFrame(server.socketPath, maximumContentFrame),
      {
        delivered: true,
        messageId: maximumContentEnvelope.messageId,
      },
    );
  }
  assert.equal(deliveredEnvelopes.length, 1 + maximumContentValues.length);

  await server.close();
  await assert.rejects(() => lstat(server.socketPath), { code: "ENOENT" });
  assert.equal(
    await findActiveSession(
      claudeSessionIdentifier,
      { runtime: "claude", projectId: projectIdentifier },
      stateHomeDirectory,
    ),
    undefined,
  );
});

test("publishes and resolves the socket through a canonicalized state root", async (testContext) => {
  const canonicalStateHomeDirectory = await createStateHomeDirectory();
  const aliasParentDirectory = await mkdtemp(join("/tmp", "ccb-channel-alias-"));
  const configuredStateHomeDirectory = join(aliasParentDirectory, "state");
  await symlink(canonicalStateHomeDirectory, configuredStateHomeDirectory);
  const canonicalStateHomePath = await realpath(canonicalStateHomeDirectory);
  await registerCodexSender(configuredStateHomeDirectory);
  const server = await startChannelSocketServer({
    owningSession: owningSession(),
    stateHomeDirectory: configuredStateHomeDirectory,
    deliverEnvelope: async () => undefined,
  });
  testContext.after(async () => {
    await server.close();
    await rm(aliasParentDirectory, { recursive: true, force: true });
    await rm(canonicalStateHomeDirectory, { recursive: true, force: true });
  });

  assert.equal(
    server.socketPath.startsWith(
      join(canonicalStateHomePath, "codex-claude-bridge", "sockets"),
    ),
    true,
  );
  assert.equal(server.socketPath.includes(configuredStateHomeDirectory), false);
  assert.equal(
    (
      await findActiveSession(
        claudeSessionIdentifier,
        { runtime: "claude", projectId: projectIdentifier },
        configuredStateHomeDirectory,
      )
    )?.socketPath,
    server.socketPath,
  );
});

test("uses a fresh randomized socket path for each server generation", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory();
  await registerCodexSender(stateHomeDirectory);
  const firstServer = await startChannelSocketServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    deliverEnvelope: async () => undefined,
  });
  const secondServer = await startChannelSocketServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    deliverEnvelope: async () => undefined,
  });
  testContext.after(async () => {
    await Promise.all([firstServer.close(), secondServer.close()]);
    await rm(stateHomeDirectory, { recursive: true, force: true });
  });

  assert.notEqual(firstServer.socketPath, secondServer.socketPath);
  assert.deepEqual(
    await exchangeSocketFrame(
      firstServer.socketPath,
      `${JSON.stringify(validEnvelope())}\n`,
    ),
    { delivered: false, error: "Channel registration is no longer owned" },
  );

  await firstServer.close();
  assert.equal(
    (
      await findActiveSession(
        claudeSessionIdentifier,
        { runtime: "claude", projectId: projectIdentifier },
        stateHomeDirectory,
      )
    )?.socketPath,
    secondServer.socketPath,
  );
});

test("preserves an existing socket when a randomized name collides", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory();
  const firstSocketIdentifier = "aaaaaaaaaaaaaaaa";
  const secondSocketIdentifier = "bbbbbbbbbbbbbbbb";
  const firstServer = await startChannelSocketServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    deliverEnvelope: async () => undefined,
    randomSocketIdentifier: () => firstSocketIdentifier,
  });
  let identifierRequestCount = 0;
  const secondServer = await startChannelSocketServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    deliverEnvelope: async () => undefined,
    randomSocketIdentifier: () => {
      identifierRequestCount += 1;
      return identifierRequestCount === 1
        ? firstSocketIdentifier
        : secondSocketIdentifier;
    },
  });
  testContext.after(async () => {
    await Promise.all([firstServer.close(), secondServer.close()]);
    await rm(stateHomeDirectory, { recursive: true, force: true });
  });

  assert.equal(firstServer.socketPath.endsWith(`c-${firstSocketIdentifier}.sock`), true);
  assert.equal(secondServer.socketPath.endsWith(`c-${secondSocketIdentifier}.sock`), true);
  assert.equal((await lstat(firstServer.socketPath)).isSocket(), true);
  assert.equal((await lstat(secondServer.socketPath)).isSocket(), true);
  assert.notEqual(firstServer.socketPath, secondServer.socketPath);
});

test("rejects canonical ASCII and Unicode socket paths beyond macOS sun_path", async (testContext) => {
  const parentDirectory = await mkdtemp(join("/tmp", "ccb-long-root-"));
  testContext.after(() => rm(parentDirectory, { recursive: true, force: true }));
  const longStateHomeDirectories = [
    join(parentDirectory, "a".repeat(64)),
    join(parentDirectory, "ț".repeat(32)),
  ];

  for (const stateHomeDirectory of longStateHomeDirectories) {
    await mkdir(stateHomeDirectory);
    await assert.rejects(
      startChannelSocketServer({
        owningSession: owningSession(),
        stateHomeDirectory,
        randomSocketIdentifier: () => "aaaaaaaaaaaaaaaa",
        deliverEnvelope: async () => undefined,
      }),
      (error: unknown) => {
        assert.ok(error instanceof RangeError);
        assert.match(error.message, /socket path must not exceed 103 UTF-8 bytes/u);
        assert.match(error.message, /XDG_STATE_HOME/u);
        return true;
      },
    );
  }
});

test("rejects malformed, partial, extra, overlong, and wrongly addressed frames", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory();
  await registerCodexSender(stateHomeDirectory);
  let deliveryCount = 0;
  const server = await startChannelSocketServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    deliverEnvelope: async () => {
      deliveryCount += 1;
    },
  });
  testContext.after(async () => {
    await server.close();
    await rm(stateHomeDirectory, { recursive: true, force: true });
  });

  const rejectedFrames = [
    "{\n",
    JSON.stringify(validEnvelope()),
    `${JSON.stringify(validEnvelope())}\n${JSON.stringify(validEnvelope())}\n`,
    `${JSON.stringify(validEnvelope())}\n `,
    `${JSON.stringify(validEnvelope())}\n\n`,
    `${JSON.stringify(
      validEnvelope({
        recipient: {
          runtime: "claude",
          sessionId: "ea7220bc-cd1e-41f0-bf7f-413982f18a9c",
          projectId: projectIdentifier,
        },
      }),
    )}\n`,
    `${JSON.stringify(
      validEnvelope({
        recipient: {
          runtime: "claude",
          sessionId: claudeSessionIdentifier,
          projectId: "fedcba987654321001234567",
        },
      }),
    )}\n`,
    Buffer.alloc(maximumSerializedAgentMessageEnvelopeFrameUtf8Bytes + 1, 0x20),
  ];

  for (const rejectedFrame of rejectedFrames) {
    const response = await exchangeSocketFrame(server.socketPath, rejectedFrame);
    assert.equal(response.delivered, false);
  }
  assert.deepEqual(
    await exchangeSocketFrame(
      server.socketPath,
      Buffer.alloc(maximumSerializedAgentMessageEnvelopeFrameUtf8Bytes + 1, 0x20),
    ),
    {
      delivered: false,
      error: "Channel frame exceeds maximum encoded envelope size",
    },
  );
  assert.equal(deliveryCount, 0);

  const staleSenderResponse = await exchangeSocketFrame(
    server.socketPath,
    `${JSON.stringify(
      validEnvelope({
        sender: {
          runtime: "codex",
          sessionId: "ea7220bc-cd1e-41f0-bf7f-413982f18a9c",
          projectId: projectIdentifier,
        },
        replyRoute: {
          runtime: "codex",
          sessionId: "ea7220bc-cd1e-41f0-bf7f-413982f18a9c",
          projectId: projectIdentifier,
        },
      }),
    )}\n`,
  );
  assert.deepEqual(staleSenderResponse, {
    delivered: false,
    error: "Sender Codex session is not active",
  });

  assert.deepEqual(
    await exchangeSocketFrame(
      server.socketPath,
      `${JSON.stringify(validEnvelope())}\r\n`,
    ),
    { delivered: true, messageId: validEnvelope().messageId },
  );
  assert.equal(deliveryCount, 1);
});

test("bounds idle client reads", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory();
  await registerCodexSender(stateHomeDirectory);
  const server = await startChannelSocketServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    deliverEnvelope: async () => undefined,
    readTimeoutMilliseconds: 30,
    writeTimeoutMilliseconds: 200,
  });
  testContext.after(async () => {
    await server.close();
    await rm(stateHomeDirectory, { recursive: true, force: true });
  });

  const idleSocket = new Socket();
  testContext.after(() => idleSocket.destroy());
  const idleResponsePromise = new Promise<ChannelDeliveryResponse>(
    (resolveResponse, rejectResponse) => {
      const responseChunks: Buffer[] = [];
      idleSocket.on("data", (chunk: Buffer) => responseChunks.push(chunk));
      idleSocket.once("error", rejectResponse);
      idleSocket.once("close", () => {
        try {
          resolveResponse(
            JSON.parse(Buffer.concat(responseChunks).toString("utf8")) as ChannelDeliveryResponse,
          );
        } catch (error) {
          rejectResponse(error);
        }
      });
    },
  );
  idleSocket.connect(server.socketPath);

  const idleResponse = await idleResponsePromise;
  assert.deepEqual(idleResponse, {
    delivered: false,
    error: "Channel read timed out",
  });
});

test("uses one absolute read deadline despite a slow byte stream", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory();
  let readDeadlineReached: (() => void) | undefined;
  let scheduledReadDeadlineCount = 0;
  let observeReadDeadlineSchedule: (() => void) | undefined;
  const readDeadlineScheduled = new Promise<void>((resolveSchedule) => {
    observeReadDeadlineSchedule = resolveSchedule;
  });
  const server = await startChannelSocketServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    deliverEnvelope: async () => undefined,
    readTimeoutMilliseconds: 50,
    writeTimeoutMilliseconds: 200,
    scheduleReadDeadline: (deadlineReached) => {
      scheduledReadDeadlineCount += 1;
      readDeadlineReached = deadlineReached;
      observeReadDeadlineSchedule?.();
      return () => undefined;
    },
  });
  testContext.after(async () => {
    await server.close();
    await rm(stateHomeDirectory, { recursive: true, force: true });
  });
  const response = await new Promise<ChannelDeliveryResponse>(
    (resolveResponse, rejectResponse) => {
      const socket = connect(server.socketPath);
      const responseChunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => responseChunks.push(chunk));
      socket.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") {
          rejectResponse(error);
        }
      });
      socket.once("close", () => {
        try {
          resolveResponse(
            JSON.parse(Buffer.concat(responseChunks).toString("utf8")) as ChannelDeliveryResponse,
          );
        } catch (error) {
          rejectResponse(error);
        }
      });
      socket.once("connect", () => {
        void readDeadlineScheduled.then(() => {
          socket.write(" ");
          setImmediate(() => readDeadlineReached?.());
        });
      });
    },
  );

  assert.deepEqual(response, {
    delivered: false,
    error: "Channel read timed out",
  });
  assert.equal(scheduledReadDeadlineCount, 1);
});

test("clears the read deadline at EOF before bounded processing", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory();
  await registerCodexSender(stateHomeDirectory);
  let releaseDelivery: (() => void) | undefined;
  const deliveryGate = new Promise<void>((resolveDelivery) => {
    releaseDelivery = resolveDelivery;
  });
  let observeDeliveryStart: (() => void) | undefined;
  const deliveryStarted = new Promise<void>((resolveDelivery) => {
    observeDeliveryStart = resolveDelivery;
  });
  let readDeadlineWasCancelled = false;
  const server = await startChannelSocketServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    deliverEnvelope: async () => {
      observeDeliveryStart?.();
      await deliveryGate;
    },
    readTimeoutMilliseconds: 20,
    processingTimeoutMilliseconds: 60_000,
    writeTimeoutMilliseconds: 200,
    scheduleReadDeadline: () => () => {
      readDeadlineWasCancelled = true;
    },
  });
  testContext.after(async () => {
    await server.close();
    await rm(stateHomeDirectory, { recursive: true, force: true });
  });

  const responsePromise = exchangeSocketFrame(
    server.socketPath,
    `${JSON.stringify(validEnvelope())}\n`,
  );
  await deliveryStarted;
  const deadlineWasCancelledBeforeDeliverySettled = readDeadlineWasCancelled;
  releaseDelivery?.();

  assert.deepEqual(
    await responsePromise,
    { delivered: true, messageId: validEnvelope().messageId },
  );
  assert.equal(deadlineWasCancelledBeforeDeliverySettled, true);
});

test("bounds concurrent client resource use", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory();
  await registerCodexSender(stateHomeDirectory);
  const server = await startChannelSocketServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    deliverEnvelope: async () => undefined,
    maximumConcurrentConnections: 1,
    readTimeoutMilliseconds: 200,
    writeTimeoutMilliseconds: 200,
  });
  testContext.after(async () => {
    await server.close();
    await rm(stateHomeDirectory, { recursive: true, force: true });
  });

  const idleSocket = connect(server.socketPath);
  testContext.after(() => idleSocket.destroy());
  await new Promise<void>((resolveConnection, rejectConnection) => {
    idleSocket.once("connect", resolveConnection);
    idleSocket.once("error", rejectConnection);
  });
  const rejectedConnectionBytes = await Promise.all(
    Array.from({ length: 16 }, () =>
      collectRejectedConnectionBytes(
        server.socketPath,
        `${JSON.stringify(validEnvelope())}\n`,
      ),
    ),
  );
  assert.deepEqual(
    rejectedConnectionBytes.map((receivedBytes) => receivedBytes.length),
    Array.from({ length: 16 }, () => 0),
  );
});

test("bounds Channel notification delivery", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory();
  await registerCodexSender(stateHomeDirectory);
  let releaseFirstDelivery: (() => void) | undefined;
  const firstDeliveryGate = new Promise<void>((resolveDelivery) => {
    releaseFirstDelivery = resolveDelivery;
  });
  let observeFirstAbort: (() => void) | undefined;
  const firstAbortObserved = new Promise<void>((resolveAbort) => {
    observeFirstAbort = resolveAbort;
  });
  let deliveryCount = 0;
  const server = await startChannelSocketServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    deliverEnvelope: async (_envelope, abortSignal) => {
      deliveryCount += 1;
      if (deliveryCount !== 1) {
        return;
      }
      abortSignal.addEventListener("abort", () => observeFirstAbort?.(), {
        once: true,
      });
      await firstDeliveryGate;
    },
    maximumConcurrentConnections: 1,
    processingTimeoutMilliseconds: 30,
    readTimeoutMilliseconds: 200,
    writeTimeoutMilliseconds: 200,
  });
  testContext.after(async () => {
    await server.close();
    await rm(stateHomeDirectory, { recursive: true, force: true });
  });

  let firstResponseSettled = false;
  const notificationResponsePromise = exchangeSocketFrame(
    server.socketPath,
    `${JSON.stringify(validEnvelope())}\n`,
  );
  void notificationResponsePromise.finally(() => {
    firstResponseSettled = true;
  });
  await firstAbortObserved;
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  const responseBeforeRelease = firstResponseSettled;
  const rejectedConnectionBytes = await collectRejectedConnectionBytes(
    server.socketPath,
    `${JSON.stringify(validEnvelope())}\n`,
  );
  releaseFirstDelivery?.();
  const notificationResponse = await notificationResponsePromise;

  assert.equal(responseBeforeRelease, false);
  assert.equal(rejectedConnectionBytes.length, 0);
  assert.deepEqual(notificationResponse, {
    delivered: false,
    error: "Channel notification timed out",
  });
  assert.equal(deliveryCount, 1);
});

test("aborts active processing before close waits for connection settlement", async (testContext) => {
  const stateHomeDirectory = await createStateHomeDirectory();
  await registerCodexSender(stateHomeDirectory);
  let observeDeliveryStart: (() => void) | undefined;
  const deliveryStarted = new Promise<void>((resolveStart) => {
    observeDeliveryStart = resolveStart;
  });
  let abortObserved = false;
  const server = await startChannelSocketServer({
    owningSession: owningSession(),
    stateHomeDirectory,
    deliverEnvelope: async (_envelope, abortSignal) => {
      observeDeliveryStart?.();
      await new Promise<void>((resolveAbort) => {
        if (abortSignal.aborted) {
          abortObserved = true;
          resolveAbort();
          return;
        }
        abortSignal.addEventListener(
          "abort",
          () => {
            abortObserved = true;
            resolveAbort();
          },
          { once: true },
        );
      });
    },
    processingTimeoutMilliseconds: 60_000,
    readTimeoutMilliseconds: 200,
    writeTimeoutMilliseconds: 100,
  });
  const clientSocket = connect(server.socketPath);
  clientSocket.once("error", () => undefined);
  testContext.after(async () => {
    clientSocket.destroy();
    await server.close();
    await rm(stateHomeDirectory, { recursive: true, force: true });
  });
  await new Promise<void>((resolveConnection) => {
    clientSocket.once("connect", () => {
      clientSocket.end(`${JSON.stringify(validEnvelope())}\n`);
      resolveConnection();
    });
  });
  await deliveryStarted;
  await server.close();

  assert.equal(abortObserved, true);
});
