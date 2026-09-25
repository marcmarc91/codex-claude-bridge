import assert from "node:assert/strict";
import test from "node:test";

import {
  identifyHookHostRuntime,
  readParentProcessCommandLine,
} from "../src/hooks/hookHostRuntime.js";

const sessionId = "3c4b3c10-21a7-4d6f-b964-3c816b9ed8db";
const parentProcessIdentifier = 4242;

async function failingOwningClaudeSessionReader(): Promise<never> {
  throw new Error("metadata unavailable");
}

test("Claude metadata evidence wins over the ambiguity of the remaining evidence", async () => {
  const runtime = await identifyHookHostRuntime(
    {
      sessionId,
      parentProcessIdentifier,
      transcriptPath: "/Users/marc/.codex/sessions/rollout-x.jsonl",
    },
    {
      readOwningClaudeSession: async () => ({
        pid: parentProcessIdentifier,
        sessionId,
        name: "claude-owner",
        cwd: "/private/tmp/project",
      }),
      readParentProcessCommandLine: async () => "/opt/homebrew/bin/codex",
    },
  );

  assert.equal(runtime, "claude");
});

test("identifies 'codex' from the parent process command line when the metadata fails", async () => {
  const runtime = await identifyHookHostRuntime(
    { sessionId, parentProcessIdentifier },
    {
      readOwningClaudeSession: failingOwningClaudeSessionReader,
      readParentProcessCommandLine: async () => "/Users/marc/.local/bin/codex",
      environment: {},
    },
  );

  assert.equal(runtime, "codex");
});

test("identifies 'claude' from a node process whose arguments contain claude", async () => {
  const runtime = await identifyHookHostRuntime(
    { sessionId, parentProcessIdentifier },
    {
      readOwningClaudeSession: failingOwningClaudeSessionReader,
      readParentProcessCommandLine: async () =>
        "node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js",
      environment: {},
    },
  );

  assert.equal(runtime, "claude");
});

test("identifies 'codex' from a transcript_path under .codex when the remaining evidence is unknown", async () => {
  const runtime = await identifyHookHostRuntime(
    {
      sessionId,
      parentProcessIdentifier,
      transcriptPath: "/Users/marc/.codex/sessions/2026/09/rollout-abc.jsonl",
    },
    {
      readOwningClaudeSession: failingOwningClaudeSessionReader,
      readParentProcessCommandLine: async () => undefined,
      environment: {},
    },
  );

  assert.equal(runtime, "codex");
});

test("identifies 'claude' from a transcript_path under the configured Claude directory", async () => {
  const runtime = await identifyHookHostRuntime(
    {
      sessionId,
      parentProcessIdentifier,
      transcriptPath: "/Users/marc/config-claude/projects/foo/session.jsonl",
    },
    {
      readOwningClaudeSession: failingOwningClaudeSessionReader,
      readParentProcessCommandLine: async () => undefined,
      configuredClaudeDirectory: "/Users/marc/config-claude",
      environment: {},
    },
  );

  assert.equal(runtime, "claude");
});

test("the weak CLAUDECODE environment signal identifies 'claude' only when no other evidence identifies the runtime", async () => {
  const runtime = await identifyHookHostRuntime(
    { sessionId, parentProcessIdentifier },
    {
      readOwningClaudeSession: failingOwningClaudeSessionReader,
      readParentProcessCommandLine: async () => undefined,
      environment: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "some-session" },
    },
  );

  assert.equal(runtime, "claude");
});

test("the transcript_path codex evidence stays valid even when the environment contains the weak CLAUDECODE signal", async () => {
  const runtime = await identifyHookHostRuntime(
    {
      sessionId,
      parentProcessIdentifier,
      transcriptPath: "/Users/marc/.codex/sessions/rollout-x.jsonl",
    },
    {
      readOwningClaudeSession: failingOwningClaudeSessionReader,
      readParentProcessCommandLine: async () => "/opt/homebrew/bin/codex",
      environment: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "some-session" },
    },
  );

  assert.equal(runtime, "codex");
});

test("the environment never counts as evidence for codex", async () => {
  const runtime = await identifyHookHostRuntime(
    { sessionId, parentProcessIdentifier },
    {
      readOwningClaudeSession: failingOwningClaudeSessionReader,
      readParentProcessCommandLine: async () => undefined,
      environment: { CODEX_HOME: "/Users/marc/.codex" },
    },
  );

  assert.equal(runtime, "unknown");
});

test("returns 'unknown' without throwing when no evidence identifies the runtime", async () => {
  const runtime = await identifyHookHostRuntime(
    { sessionId, parentProcessIdentifier },
    {
      readOwningClaudeSession: failingOwningClaudeSessionReader,
      readParentProcessCommandLine: async () => undefined,
      environment: {},
    },
  );

  assert.equal(runtime, "unknown");
});

test("readParentProcessCommandLine reads the command line of an existing process without throwing", async () => {
  const commandLine = await readParentProcessCommandLine(process.pid);
  assert.equal(typeof commandLine, "string");
  assert.ok((commandLine ?? "").length > 0);
});

test("readParentProcessCommandLine returns undefined for a nonexistent PID", async () => {
  const commandLine = await readParentProcessCommandLine(999_999);
  assert.equal(commandLine, undefined);
});

test("an argument containing @openai/codex does not turn a Claude Code script into a codex host", async () => {
  const runtime = await identifyHookHostRuntime(
    { sessionId, parentProcessIdentifier },
    {
      readOwningClaudeSession: failingOwningClaudeSessionReader,
      readParentProcessCommandLine: async () =>
        "node /opt/node_modules/@anthropic-ai/claude-code/cli.js --add-dir /tmp/@openai/codex",
      environment: {},
    },
  );

  assert.equal(runtime, "claude");
});

test("a shell whose arguments mention @openai/codex stays 'unknown'", async () => {
  const runtime = await identifyHookHostRuntime(
    { sessionId, parentProcessIdentifier },
    {
      readOwningClaudeSession: failingOwningClaudeSessionReader,
      readParentProcessCommandLine: async () => "/bin/zsh -c echo @openai/codex",
      environment: {},
    },
  );

  assert.equal(runtime, "unknown");
});

test("a node script from the @openai/codex package is identified as 'codex'", async () => {
  const runtime = await identifyHookHostRuntime(
    { sessionId, parentProcessIdentifier },
    {
      readOwningClaudeSession: failingOwningClaudeSessionReader,
      readParentProcessCommandLine: async () =>
        "node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js --cd /tmp/claude-code",
      environment: {},
    },
  );

  assert.equal(runtime, "codex");
});

test("a project directory named codex or a package with a similar prefix is not evidence of a codex host", async () => {
  for (const commandLine of [
    "node /tmp/codex/helper.js",
    "node /tmp/@openai/codex-not-runtime/tool.js",
  ]) {
    const runtime = await identifyHookHostRuntime(
      { sessionId, parentProcessIdentifier },
      {
        readOwningClaudeSession: failingOwningClaudeSessionReader,
        readParentProcessCommandLine: async () => commandLine,
        environment: {},
      },
    );

    assert.equal(runtime, "unknown", commandLine);
  }
});
