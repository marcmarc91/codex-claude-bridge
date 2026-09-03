import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCodexSessionHook } from "../src/hooks/codexSessionHook.js";
import { listActiveSessions } from "../src/registry/activeSessionRegistry.js";
import { resolveProjectIdentity } from "../src/registry/projectIdentity.js";

test("hook-ul Codex înregistrează și elimină numai sesiunea specificată", async (testContext) => {
  const stateHomeDirectory = await mkdtemp(join(tmpdir(), "codex-claude-bridge-"));
  const originalStateHomeDirectory = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHomeDirectory;
  testContext.after(async () => {
    if (originalStateHomeDirectory === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = originalStateHomeDirectory;
    }
    await rm(stateHomeDirectory, { recursive: true, force: true });
  });

  const firstSessionIdentifier = "3c4b3c10-21a7-4d6f-b964-3c816b9ed8db";
  const secondSessionIdentifier = "5cb1e2fd-5b24-4699-bfea-878e9b147370";
  const workingDirectory = process.cwd();
  const projectIdentifier = await resolveProjectIdentity(workingDirectory);
  const sessionStartInput = {
    hook_event_name: "SessionStart",
    cwd: workingDirectory,
    model: "gpt-5.6-sol",
    permission_mode: "default",
    source: "startup",
  };

  await runCodexSessionHook({ ...sessionStartInput, session_id: firstSessionIdentifier });
  await runCodexSessionHook({ ...sessionStartInput, session_id: secondSessionIdentifier });
  await runCodexSessionHook({
    hook_event_name: "SessionEnd",
    session_id: firstSessionIdentifier,
    cwd: workingDirectory,
  });

  assert.deepEqual(
    (await listActiveSessions({ runtime: "codex", projectId: projectIdentifier })).map(
      ({ sessionId }) => sessionId,
    ),
    [secondSessionIdentifier],
  );
});
