import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readOwningClaudeSessionMetadata } from "../src/channel/claudeSessionMetadata.js";

delete process.env.CLAUDE_CONFIG_DIR;

const owningProcessIdentifier = 43127;

function representativeClaudeMetadataInput() {
  return {
    pid: owningProcessIdentifier,
    sessionId: "ad65b1c1-7386-4465-80f9-4de0a26bc212",
    name: "bridge-owner",
    cwd: "/private/tmp/bridge-project",
    messagingSocketPath: "/private/tmp/claude-private.sock",
  };
}

function expectedOwningMetadata() {
  return {
    pid: owningProcessIdentifier,
    sessionId: "ad65b1c1-7386-4465-80f9-4de0a26bc212",
    name: "bridge-owner",
    cwd: "/private/tmp/bridge-project",
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
    JSON.stringify(representativeClaudeMetadataInput()),
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

  assert.deepEqual(metadata, expectedOwningMetadata());
  assert.equal(Object.hasOwn(metadata, "messagingSocketPath"), false);
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
    { ...representativeClaudeMetadataInput(), pid: owningProcessIdentifier + 1 },
    { ...representativeClaudeMetadataInput(), sessionId: "not-a-uuid" },
    { ...representativeClaudeMetadataInput(), name: "   " },
    { ...representativeClaudeMetadataInput(), name: "name\0suffix" },
    { ...representativeClaudeMetadataInput(), cwd: "relative/project" },
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
  await writeFile(
    redirectedMetadataPath,
    JSON.stringify(representativeClaudeMetadataInput()),
    {
      mode: 0o600,
    },
  );
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

test("prefers the configured Claude directory over the home directory", async (testContext) => {
  const homeDirectory = await createClaudeHome(testContext);
  const configurationParent = await realpath(
    await mkdtemp(join(tmpdir(), "ccb-claude-config-")),
  );
  testContext.after(() => rm(configurationParent, { recursive: true, force: true }));
  const configuredClaudeDirectory = join(configurationParent, ".claude-work");
  await mkdir(join(configuredClaudeDirectory, "sessions"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    join(configuredClaudeDirectory, "sessions", `${owningProcessIdentifier}.json`),
    JSON.stringify(representativeClaudeMetadataInput()),
    { mode: 0o600 },
  );

  assert.deepEqual(
    await readOwningClaudeSessionMetadata(
      owningProcessIdentifier,
      homeDirectory,
      configuredClaudeDirectory,
    ),
    expectedOwningMetadata(),
  );
});

test("rejects a relative configured Claude directory", async (testContext) => {
  const homeDirectory = await createClaudeHome(testContext);

  await assert.rejects(() =>
    readOwningClaudeSessionMetadata(
      owningProcessIdentifier,
      homeDirectory,
      "relative/config",
    ),
  );
});
