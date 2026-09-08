import assert from "node:assert/strict";
import test from "node:test";

import {
  identifyHookHostRuntime,
  readParentProcessCommandLine,
} from "../src/hooks/hookHostRuntime.js";

const sessionId = "3c4b3c10-21a7-4d6f-b964-3c816b9ed8db";
const parentProcessIdentifier = 4242;

async function failingOwningClaudeSessionReader(): Promise<never> {
  throw new Error("metadata indisponibilă");
}

test("evidența metadatelor Claude câștigă în fața ambiguității restului dovezilor", async () => {
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

test("identifică 'codex' din linia de comandă a procesului părinte când metadata eșuează", async () => {
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

test("identifică 'claude' dintr-un proces node ai cărui parametri conțin claude", async () => {
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

test("identifică 'codex' dintr-un transcript_path aflat sub .codex când restul dovezilor sunt necunoscute", async () => {
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

test("identifică 'claude' dintr-un transcript_path aflat sub directorul Claude configurat", async () => {
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

test("semnalul slab de mediu CLAUDECODE identifică 'claude' numai când nicio altă dovadă nu identifică rulanța", async () => {
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

test("dovada codex a transcript_path rămâne validă chiar dacă mediul ambiant conține semnalul slab CLAUDECODE", async () => {
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

test("environment nu constituie niciodată dovadă pentru codex", async () => {
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

test("returnează 'unknown' fără să arunce eroare când nicio dovadă nu identifică rulanța", async () => {
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

test("readParentProcessCommandLine citește linia de comandă a unui proces existent fără să arunce eroare", async () => {
  const commandLine = await readParentProcessCommandLine(process.pid);
  assert.equal(typeof commandLine, "string");
  assert.ok((commandLine ?? "").length > 0);
});

test("readParentProcessCommandLine se întoarce cu undefined pentru un PID inexistent", async () => {
  const commandLine = await readParentProcessCommandLine(999_999);
  assert.equal(commandLine, undefined);
});

test("un argument care conține @openai/codex nu transformă un script Claude Code într-un host codex", async () => {
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

test("un shell ale cărui argumente menționează @openai/codex rămâne 'unknown'", async () => {
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

test("un script node din pachetul @openai/codex este identificat drept 'codex'", async () => {
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

test("un director de proiect numit codex sau un pachet cu prefix asemănător nu este dovadă de host codex", async () => {
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
