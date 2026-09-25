import assert from "node:assert/strict";
import { execFile as executeFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  assertSocketPathWithinLimit,
  maximumChannelSocketPathUtf8Bytes,
  resolveBridgeStateDirectory,
  resolveConversationDirectory,
  resolveConversationRecordPath,
  resolveSessionRegistryDirectory,
  resolveSocketsDirectory,
  resolveStateHomeDirectory,
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

test("a Git worktree shares the project identity with the main repository", async (testContext) => {
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

test("a non-Git directory has a deterministic identity", async (testContext) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "codex-claude-bridge-"));
  testContext.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  assert.equal(
    await resolveProjectIdentity(temporaryDirectory),
    await resolveProjectIdentity(await realpath(temporaryDirectory)),
  );
});

test("all valid runtime directories stay structurally under the selected state root", () => {
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

test("accepts UUID v7 for conversations just like the protocol envelope", () => {
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

test("rejects project identifiers that can traverse directories", () => {
  const stateRootDirectory = join(tmpdir(), "codex-claude-bridge-state");
  const conversationIdentifier = "5cb1e2fd-5b24-4699-bfea-878e9b147370";

  for (const projectIdentity of ["../escape", "nested/path", "/tmp/escape"]) {
    assert.throws(() =>
      resolveSessionRegistryDirectory(stateRootDirectory, projectIdentity),
    );
  }
});

test("rejects conversation identifiers that can traverse directories", () => {
  const stateRootDirectory = join(tmpdir(), "codex-claude-bridge-state");

  for (const conversationIdentifier of ["../escape", "nested/path", "/tmp/escape"]) {
    assert.throws(() =>
      resolveConversationRecordPath(stateRootDirectory, conversationIdentifier),
    );
  }
});

test("treats an empty XDG_STATE_HOME as absent and uses the default directory", (testContext) => {
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

test("rejects relative, whitespace and NUL-containing XDG_STATE_HOME values", (testContext) => {
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

test("rejects all invalid injected roots before any I/O", async (testContext) => {
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

test("keeps valid injected absolute roots", () => {
  const absoluteStateHomeDirectory = join(tmpdir(), "ccb-valid-state-root");

  assert.equal(
    resolveBridgeStateDirectory(absoluteStateHomeDirectory),
    join(absoluteStateHomeDirectory, "codex-claude-bridge"),
  );
});

test("resolveStateHomeDirectory honors XDG_STATE_HOME from an injected environment object", () => {
  const environmentStateHomeDirectory = join(tmpdir(), "ccb-injected-environment-state");

  assert.equal(
    resolveStateHomeDirectory(undefined, { XDG_STATE_HOME: environmentStateHomeDirectory }),
    environmentStateHomeDirectory,
  );
});

test("resolveStateHomeDirectory ignores XDG_STATE_HOME from process.env when the injected environment lacks it", (testContext) => {
  const originalStateHomeDirectory = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(tmpdir(), "ccb-real-process-env-state");
  testContext.after(() => {
    if (originalStateHomeDirectory === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = originalStateHomeDirectory;
    }
  });

  assert.equal(
    resolveStateHomeDirectory(undefined, {}),
    join(homedir(), ".local", "state"),
  );
});

test("an injected state root takes precedence over XDG_STATE_HOME from the environment", () => {
  const injectedStateHomeDirectory = join(tmpdir(), "ccb-injected-override-state");
  const environmentStateHomeDirectory = join(tmpdir(), "ccb-ignored-environment-state");

  assert.equal(
    resolveStateHomeDirectory(injectedStateHomeDirectory, {
      XDG_STATE_HOME: environmentStateHomeDirectory,
    }),
    injectedStateHomeDirectory,
  );
});

test("resolveBridgeStateDirectory propagates the injected environment to the XDG resolution", () => {
  const environmentStateHomeDirectory = join(tmpdir(), "ccb-bridge-environment-state");

  assert.equal(
    resolveBridgeStateDirectory(undefined, { XDG_STATE_HOME: environmentStateHomeDirectory }),
    join(environmentStateHomeDirectory, "codex-claude-bridge"),
  );
});

test("resolveSocketsDirectory uses <stateDir>/sockets under the state directory", () => {
  const stateHomeDirectory = join(tmpdir(), "ccb-sockets-default-state");

  assert.equal(
    resolveSocketsDirectory(stateHomeDirectory, {}),
    join(stateHomeDirectory, "codex-claude-bridge", "sockets"),
  );
});

test("assertSocketPathWithinLimit accepts paths within the UTF-8 byte limit", () => {
  const shortSocketPath = join(tmpdir(), "c-0123456789abcdef.sock");
  const exactLimitSocketPath = `/${"é".repeat(51)}`;

  assert.equal(Buffer.byteLength(exactLimitSocketPath, "utf8"), maximumChannelSocketPathUtf8Bytes);
  assert.doesNotThrow(() => assertSocketPathWithinLimit(shortSocketPath));
  assert.doesNotThrow(() => assertSocketPathWithinLimit(exactLimitSocketPath));
  assert.throws(() => assertSocketPathWithinLimit(`${exactLimitSocketPath}a`), RangeError);
});

test("assertSocketPathWithinLimit throws a RangeError with the limit, the actual length and the remedy variable", () => {
  const oversizedSocketPath = join(
    "/",
    "a".repeat(200),
    "c-0123456789abcdef.sock",
  );
  const expectedByteLength = Buffer.byteLength(oversizedSocketPath, "utf8");

  assert.throws(
    () => assertSocketPathWithinLimit(oversizedSocketPath),
    (error: unknown) => {
      assert.ok(error instanceof RangeError);
      const message = (error as Error).message;
      assert.ok(message.includes(String(maximumChannelSocketPathUtf8Bytes)));
      assert.ok(message.includes(String(expectedByteLength)));
      assert.ok(message.includes("XDG_STATE_HOME"));
      return true;
    },
  );
});
