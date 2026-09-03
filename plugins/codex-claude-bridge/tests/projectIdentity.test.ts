import assert from "node:assert/strict";
import { execFile as executeFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  resolveBridgeStateDirectory,
  resolveConversationDirectory,
  resolveSessionRegistryDirectory,
} from "../src/runtime/paths.js";
import { resolveProjectIdentity } from "../src/registry/projectIdentity.js";

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
  const conversationIdentifier = "5cb1e2fd-5b24-4699-bfea-878e9b147370";
  const bridgeStateDirectory = resolveBridgeStateDirectory(stateRootDirectory);

  assertPathIsContained(stateRootDirectory, bridgeStateDirectory);
  assertPathIsContained(
    bridgeStateDirectory,
    resolveSessionRegistryDirectory(stateRootDirectory, projectIdentity),
  );
  assertPathIsContained(
    bridgeStateDirectory,
    resolveConversationDirectory(stateRootDirectory, projectIdentity, conversationIdentifier),
  );
});

test("respinge identificatorii de proiect care pot traversa directoare", () => {
  const stateRootDirectory = join(tmpdir(), "codex-claude-bridge-state");
  const conversationIdentifier = "5cb1e2fd-5b24-4699-bfea-878e9b147370";

  for (const projectIdentity of ["../escape", "nested/path", "/tmp/escape"]) {
    assert.throws(() =>
      resolveSessionRegistryDirectory(stateRootDirectory, projectIdentity),
    );
    assert.throws(() =>
      resolveConversationDirectory(stateRootDirectory, projectIdentity, conversationIdentifier),
    );
  }
});

test("respinge identificatorii de conversație care pot traversa directoare", () => {
  const stateRootDirectory = join(tmpdir(), "codex-claude-bridge-state");
  const projectIdentity = "0123456789abcdef01234567";

  for (const conversationIdentifier of ["../escape", "nested/path", "/tmp/escape"]) {
    assert.throws(() =>
      resolveConversationDirectory(stateRootDirectory, projectIdentity, conversationIdentifier),
    );
  }
});
