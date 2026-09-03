import assert from "node:assert/strict";
import { execFile as executeFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  resolveBridgeStateDirectory,
  resolveConversationDirectory,
  resolveConversationRecordPath,
  resolveSessionRegistryDirectory,
} from "../src/runtime/paths.js";
import { parseAgentMessageEnvelope } from "../src/protocol/messageEnvelope.js";
import { resolveProjectIdentity } from "../src/registry/projectIdentity.js";
import { prepareSecureBridgeState } from "../src/registry/secureStateFilesystem.js";

const executeFileAsync = promisify(executeFile);

function assertPathIsContained(parentDirectory: string, childDirectory: string): void {
  const relativePath = relative(parentDirectory, childDirectory);
  assert.ok(
    relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath),
  );
}

test("worktree-ul Git partajează identitatea proiectului cu repository-ul principal", async (testContext) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "codex-claude-bridge-"));
  const repositoryDirectory = join(temporaryDirectory, "repository");
  const worktreeDirectory = join(temporaryDirectory, "worktree");
  testContext.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  await mkdir(repositoryDirectory);
  await executeFileAsync("git", ["init", repositoryDirectory]);
  await executeFileAsync("git", [
    "-C",
    repositoryDirectory,
    "-c",
    "user.name=Codex Test",
    "-c",
    "user.email=codex-test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  ]);
  await executeFileAsync("git", ["-C", repositoryDirectory, "worktree", "add", "-b", "linked-worktree", worktreeDirectory]);

  assert.equal(
    await resolveProjectIdentity(repositoryDirectory),
    await resolveProjectIdentity(worktreeDirectory),
  );
});

test("directorul non-Git are identitate deterministă", async (testContext) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "codex-claude-bridge-"));
  testContext.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  assert.equal(
    await resolveProjectIdentity(temporaryDirectory),
    await resolveProjectIdentity(await realpath(temporaryDirectory)),
  );
});

test("toate directoarele runtime valide rămân structural sub rădăcina de stare selectată", () => {
  const stateRootDirectory = join(tmpdir(), "codex-claude-bridge-state");
  const projectIdentity = "0123456789abcdef01234567";
  const bridgeStateDirectory = resolveBridgeStateDirectory(stateRootDirectory);

  assertPathIsContained(stateRootDirectory, bridgeStateDirectory);
  assertPathIsContained(
    bridgeStateDirectory,
    resolveSessionRegistryDirectory(stateRootDirectory, projectIdentity),
  );
  assertPathIsContained(
    bridgeStateDirectory,
    resolveConversationDirectory(stateRootDirectory),
  );
});

test("acceptă UUID v7 pentru conversații la fel ca envelope-ul protocolului", () => {
  const stateRootDirectory = join(tmpdir(), "codex-claude-bridge-state");
  const projectIdentity = "0123456789abcdef01234567";
  const uuidVersion7 = "018f1c57-9bd7-7f64-a9d3-9d7c90a3039c";
  const parsedEnvelope = parseAgentMessageEnvelope({
    schemaVersion: 1,
    messageId: "3c4b3c10-21a7-4d6f-b964-3c816b9ed8db",
    conversationId: uuidVersion7,
    sentAt: "2026-09-03T12:00:00.000Z",
    messageType: "message",
    sender: {
      runtime: "codex",
      sessionId: "8d6380bf-1b93-44b3-b3da-a1a661cf8b69",
      projectId: projectIdentity,
    },
    recipient: {
      runtime: "claude",
      sessionId: "ad65b1c1-7386-4465-80f9-4de0a26bc212",
      projectId: projectIdentity,
    },
    content: "status?",
  });

  const conversationDirectory = resolveConversationDirectory(
    stateRootDirectory,
  );

  assert.equal(parsedEnvelope.conversationId, uuidVersion7);
  assertPathIsContained(resolveBridgeStateDirectory(stateRootDirectory), conversationDirectory);
});

test("respinge identificatorii de proiect care pot traversa directoare", () => {
  const stateRootDirectory = join(tmpdir(), "codex-claude-bridge-state");
  const conversationIdentifier = "5cb1e2fd-5b24-4699-bfea-878e9b147370";

  for (const projectIdentity of ["../escape", "nested/path", "/tmp/escape"]) {
    assert.throws(() =>
      resolveSessionRegistryDirectory(stateRootDirectory, projectIdentity),
    );
  }
});

test("respinge identificatorii de conversație care pot traversa directoare", () => {
  const stateRootDirectory = join(tmpdir(), "codex-claude-bridge-state");

  for (const conversationIdentifier of ["../escape", "nested/path", "/tmp/escape"]) {
    assert.throws(() =>
      resolveConversationRecordPath(stateRootDirectory, conversationIdentifier),
    );
  }
});

test("tratează XDG_STATE_HOME gol ca absent și folosește directorul implicit", (testContext) => {
  const originalStateHomeDirectory = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = "";
  testContext.after(() => {
    if (originalStateHomeDirectory === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = originalStateHomeDirectory;
    }
  });

  assert.equal(
    resolveBridgeStateDirectory(),
    join(homedir(), ".local", "state", "codex-claude-bridge"),
  );
});

test("respinge valori XDG_STATE_HOME relative, whitespace și cu NUL", (testContext) => {
  const originalProcessEnvironment = process.env;
  testContext.after(() => {
    process.env = originalProcessEnvironment;
  });

  for (const invalidStateHomeDirectory of [
    "relative-state",
    "   ",
    "/tmp/invalid\0state",
  ]) {
    process.env = {
      ...originalProcessEnvironment,
      XDG_STATE_HOME: invalidStateHomeDirectory,
    };
    assert.throws(() => resolveBridgeStateDirectory());
  }
});

test("respinge toate rădăcinile injectate invalide înainte de I/O", async (testContext) => {
  const temporaryWorkingDirectory = await mkdtemp(join(tmpdir(), "ccb-invalid-root-"));
  const originalWorkingDirectory = process.cwd();
  process.chdir(temporaryWorkingDirectory);
  testContext.after(async () => {
    process.chdir(originalWorkingDirectory);
    await rm(temporaryWorkingDirectory, { recursive: true, force: true });
  });

  for (const invalidStateHomeDirectory of [
    "",
    "relative-state",
    "   ",
    "/tmp/invalid\0state",
  ]) {
    assert.throws(() => resolveBridgeStateDirectory(invalidStateHomeDirectory));
    assert.throws(() =>
      resolveSessionRegistryDirectory(
        invalidStateHomeDirectory,
        "0123456789abcdef01234567",
      ),
    );
    assert.throws(() => resolveConversationDirectory(invalidStateHomeDirectory));
    await assert.rejects(() => prepareSecureBridgeState(invalidStateHomeDirectory));
  }

  assert.deepEqual(await import("node:fs/promises").then(({ readdir }) => readdir(".")), []);
});

test("păstrează rădăcinile absolute valide injectate", () => {
  const absoluteStateHomeDirectory = join(tmpdir(), "ccb-valid-state-root");

  assert.equal(
    resolveBridgeStateDirectory(absoluteStateHomeDirectory),
    join(absoluteStateHomeDirectory, "codex-claude-bridge"),
  );
});
