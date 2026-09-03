import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readOwningClaudeSessionMetadata } from "../src/channel/claudeSessionMetadata.js";

const owningProcessIdentifier = 43127;

function validMetadata() {
  return {
    pid: owningProcessIdentifier,
    sessionId: "ad65b1c1-7386-4465-80f9-4de0a26bc212",
    name: "bridge-owner",
    cwd: "/private/tmp/bridge-project",
    messagingSocketPath: "/private/tmp/claude-private.sock",
  };
}

async function createClaudeHome(testContext: test.TestContext): Promise<string> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "ccb-claude-home-"));
  testContext.after(() => rm(homeDirectory, { recursive: true, force: true }));
  await mkdir(join(homeDirectory, ".claude", "sessions"), {
    recursive: true,
    mode: 0o700,
  });
  return homeDirectory;
}

test("reads only the exact JSON metadata path for the owning PID", async (testContext) => {
  const homeDirectory = await createClaudeHome(testContext);
  const sessionsDirectory = join(homeDirectory, ".claude", "sessions");
  await writeFile(
    join(sessionsDirectory, `${owningProcessIdentifier}.json`),
    JSON.stringify(validMetadata()),
    { mode: 0o600 },
  );
  await mkdir(join(sessionsDirectory, `${owningProcessIdentifier}.key`));
  await writeFile(join(sessionsDirectory, "unrelated.json"), "not json", {
    mode: 0o600,
  });
  await chmod(sessionsDirectory, 0o100);
  let metadata;
  try {
    metadata = await readOwningClaudeSessionMetadata(
      owningProcessIdentifier,
      homeDirectory,
    );
  } finally {
    await chmod(sessionsDirectory, 0o700);
  }

  assert.deepEqual(metadata, validMetadata());
});

test("rejects mismatched identity and malformed metadata fields", async (testContext) => {
  const homeDirectory = await createClaudeHome(testContext);
  const metadataPath = join(
    homeDirectory,
    ".claude",
    "sessions",
    `${owningProcessIdentifier}.json`,
  );
  const invalidMetadataRecords = [
    { ...validMetadata(), pid: owningProcessIdentifier + 1 },
    { ...validMetadata(), sessionId: "not-a-uuid" },
    { ...validMetadata(), name: "   " },
    { ...validMetadata(), name: "name\0suffix" },
    { ...validMetadata(), cwd: "relative/project" },
    { ...validMetadata(), messagingSocketPath: "relative/socket" },
    { ...validMetadata(), extra: true },
  ];

  for (const invalidMetadata of invalidMetadataRecords) {
    await writeFile(metadataPath, JSON.stringify(invalidMetadata), { mode: 0o600 });
    await assert.rejects(() =>
      readOwningClaudeSessionMetadata(owningProcessIdentifier, homeDirectory),
    );
  }

  await writeFile(metadataPath, "{", { mode: 0o600 });
  await assert.rejects(() =>
    readOwningClaudeSessionMetadata(owningProcessIdentifier, homeDirectory),
  );
});

test("rejects symlink and non-regular metadata paths", async (testContext) => {
  const homeDirectory = await createClaudeHome(testContext);
  const sessionsDirectory = join(homeDirectory, ".claude", "sessions");
  const metadataPath = join(sessionsDirectory, `${owningProcessIdentifier}.json`);
  const redirectedMetadataPath = join(homeDirectory, "redirected.json");
  await writeFile(redirectedMetadataPath, JSON.stringify(validMetadata()), {
    mode: 0o600,
  });
  await symlink(redirectedMetadataPath, metadataPath);

  await assert.rejects(() =>
    readOwningClaudeSessionMetadata(owningProcessIdentifier, homeDirectory),
  );

  await rm(metadataPath);
  await mkdir(metadataPath);
  await assert.rejects(() =>
    readOwningClaudeSessionMetadata(owningProcessIdentifier, homeDirectory),
  );
});

test("rejects invalid owning process identifiers before filesystem access", async () => {
  for (const invalidProcessIdentifier of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(() =>
      readOwningClaudeSessionMetadata(invalidProcessIdentifier, "/missing"),
    );
  }
});
