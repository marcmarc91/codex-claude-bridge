import assert from "node:assert/strict";
import { execFile as executeFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  resolveBridgeStateDirectory,
  resolveConversationDirectory,
  resolveSessionRegistryDirectory,
} from "../src/runtime/paths.js";
import { resolveProjectIdentity } from "../src/registry/projectIdentity.js";

const executeFileAsync = promisify(executeFile);

test("worktree-ul Git partajează identitatea proiectului cu repository-ul principal", async (testContext) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "codex-claude-bridge-"));
  const repositoryDirectory = join(temporaryDirectory, "repository");
  const worktreeDirectory = join(temporaryDirectory, "worktree");
  testContext.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  await mkdir(repositoryDirectory);
  await executeFileAsync("git", ["init", repositoryDirectory]);
  await executeFileAsync("git", ["-C", repositoryDirectory, "commit", "--allow-empty", "-m", "initial"]);
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

test("toate directoarele runtime rămân sub rădăcina de stare selectată", () => {
  const stateRootDirectory = join(tmpdir(), "codex-claude-bridge-state");
  const projectIdentity = "0123456789abcdef01234567";
  const conversationIdentifier = "5cb1e2fd-5b24-4699-bfea-878e9b147370";
  const bridgeStateDirectory = resolveBridgeStateDirectory(stateRootDirectory);

  assert.ok(bridgeStateDirectory.startsWith(`${stateRootDirectory}/`));
  assert.ok(resolveSessionRegistryDirectory(stateRootDirectory, projectIdentity).startsWith(`${bridgeStateDirectory}/`));
  assert.ok(
    resolveConversationDirectory(stateRootDirectory, projectIdentity, conversationIdentifier).startsWith(
      `${bridgeStateDirectory}/`,
    ),
  );
});
