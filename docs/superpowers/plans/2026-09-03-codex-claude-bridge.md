# Codex-Claude Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and globally install a local bridge that lets active Codex and Claude Code sessions exchange correlated messages without a custom daemon or offline queue.

**Architecture:** A Claude MCP Channel owns one Unix socket per active Claude session, while Codex session hooks publish ephemeral active-session records. The CLI sends directly to Claude sockets and delegates Claude-to-Codex delivery to `codex queue`, preserving each runtime's wake-up and permission behavior.

**Tech Stack:** Node.js 22+, TypeScript, pnpm 10, `@modelcontextprotocol/sdk`, Zod, Node test runner through `tsx`.

**Spec:** `docs/superpowers/specs/2026-09-03-codex-claude-bridge-design.md`

## Global Constraints

- Install globally for the current macOS user and support every local project.
- Communicate only with active sessions; do not add an offline queue, background daemon, scheduler, or TCP listener.
- Use `codex queue` for Codex delivery and a Claude Channel for Claude delivery.
- Do not access Codex SQLite, Claude `.key` files, transcripts, credentials, or application repositories.
- Do not implement Channel permission relay or alter agent permission modes.
- Use Unix sockets and user-only `0700` directories plus `0600` files.
- Spawn child processes with argument arrays and `shell: false`.
- Use descriptive English identifiers and add no source-code comments or diagnostic logging.
- Make no changes or commits in `/Users/bogdanmarc/Projects/pinvite-ui`.

---

### Task 1: Package foundation and strict protocol

**Files:**

- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `.gitignore`
- Create: `plugins/codex-claude-bridge/package.json`
- Create: `plugins/codex-claude-bridge/tsconfig.json`
- Create: `plugins/codex-claude-bridge/src/protocol/messageEnvelope.ts`
- Create: `plugins/codex-claude-bridge/src/runtime/paths.ts`
- Create: `plugins/codex-claude-bridge/src/registry/projectIdentity.ts`
- Test: `plugins/codex-claude-bridge/tests/messageEnvelope.test.ts`
- Test: `plugins/codex-claude-bridge/tests/projectIdentity.test.ts`

**Interfaces:**

- Produces: `AgentRuntime`, `AgentAddress`, `AgentMessageEnvelope`, `parseAgentMessageEnvelope`, `serializeAgentMessageEnvelope`, `createAgentMessageEnvelope`.
- Produces: `resolveBridgeStateDirectory`, `resolveSessionRegistryDirectory`, `resolveConversationDirectory`.
- Produces: `resolveProjectIdentity(workingDirectory: string): Promise<string>`.

- [ ] **Step 1: Scaffold the pnpm workspace and package scripts**

Use one workspace package and these scripts:

```json
{
  "scripts": {
    "build": "pnpm --filter codex-claude-bridge build",
    "check": "pnpm --filter codex-claude-bridge check",
    "test": "pnpm --filter codex-claude-bridge test",
    "verify": "pnpm check && pnpm test && pnpm build"
  }
}
```

The plugin package exports the global binaries `codex-claude-bridge` and `claude-code-bridge-wrapper`, compiles `src/**/*.ts` to `dist/`, and uses `tsx --test tests/**/*.test.ts`.

- [ ] **Step 2: Write failing envelope tests**

Cover a valid envelope, unknown-field rejection, invalid UUID rejection, empty content, and 65,537 UTF-8 bytes:

```ts
assert.equal(parseAgentMessageEnvelope(validEnvelope).content, "status?");
assert.throws(() => parseAgentMessageEnvelope({ ...validEnvelope, extra: true }));
assert.throws(() => parseAgentMessageEnvelope({ ...validEnvelope, messageId: "bad" }));
assert.throws(() => parseAgentMessageEnvelope({ ...validEnvelope, content: "" }));
assert.throws(() => parseAgentMessageEnvelope({ ...validEnvelope, content: "ă".repeat(32769) }));
```

- [ ] **Step 3: Run the protocol tests and confirm failure**

Run: `pnpm --filter codex-claude-bridge test -- messageEnvelope.test.ts`

Expected: FAIL because `messageEnvelope.ts` does not exist.

- [ ] **Step 4: Implement the strict envelope schema**

Use `.strict()` Zod objects, UUID validation, ISO datetime validation, and a UTF-8 byte refinement:

```ts
const contentSchema = z.string().min(1).refine(
  (content) => Buffer.byteLength(content, "utf8") <= 65_536,
  "Message content exceeds 65536 UTF-8 bytes",
);
```

Generate IDs with `randomUUID()` and timestamps with `new Date().toISOString()`.

- [ ] **Step 5: Write failing project identity and path tests**

Create a temporary Git repository plus a linked worktree and assert both resolve to the same project ID. Assert a non-Git directory resolves deterministically and every runtime path stays below the selected XDG state root.

- [ ] **Step 6: Implement project identity and runtime paths**

Resolve the canonical Git common directory with:

```ts
execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
  cwd: workingDirectory,
});
```

Hash the canonical path with SHA-256 and expose the first 24 hexadecimal characters. Fall back to the canonical working directory when Git returns non-zero.

- [ ] **Step 7: Verify Task 1**

Run: `pnpm --filter codex-claude-bridge check`

Run: `pnpm --filter codex-claude-bridge test -- messageEnvelope.test.ts projectIdentity.test.ts`

Expected: both commands exit `0`.

- [ ] **Step 8: Commit Task 1**

```bash
git add package.json pnpm-workspace.yaml .gitignore plugins/codex-claude-bridge/package.json plugins/codex-claude-bridge/tsconfig.json plugins/codex-claude-bridge/src plugins/codex-claude-bridge/tests
git commit -m "feat: add bridge protocol foundation"
```

---

### Task 2: Active-session registry and Codex lifecycle hooks

**Files:**

- Create: `plugins/codex-claude-bridge/src/registry/activeSessionRegistry.ts`
- Create: `plugins/codex-claude-bridge/src/hooks/codexSessionHook.ts`
- Create: `plugins/codex-claude-bridge/hooks/hooks.json`
- Test: `plugins/codex-claude-bridge/tests/activeSessionRegistry.test.ts`
- Test: `plugins/codex-claude-bridge/tests/codexSessionHook.test.ts`

**Interfaces:**

- Consumes: `AgentRuntime`, `resolveSessionRegistryDirectory`, `resolveProjectIdentity`.
- Produces: `ActiveSessionRecord`, `registerActiveSession`, `unregisterActiveSession`, `listActiveSessions`, `findActiveSession`.
- Produces: `runCodexSessionHook(input: unknown): Promise<void>`.

- [ ] **Step 1: Write failing registry tests**

Test atomic registration, modes `0700` and `0600`, runtime/project filtering, unique-ID lookup, ambiguous-name rejection, dead-process cleanup, and Claude socket cleanup.

```ts
await registerActiveSession(record);
const stored = await listActiveSessions({ runtime: "codex", projectId: record.projectId });
assert.deepEqual(stored.map(({ sessionId }) => sessionId), [record.sessionId]);
```

- [ ] **Step 2: Run registry tests and confirm failure**

Run: `pnpm --filter codex-claude-bridge test -- activeSessionRegistry.test.ts`

Expected: FAIL because the registry module does not exist.

- [ ] **Step 3: Implement atomic registration and stale cleanup**

Write JSON to a same-directory temporary file opened with mode `0600`, rename it atomically, and reapply mode `0600`. Consider a process active only when `process.kill(processId, 0)` succeeds or returns `EPERM`. For Claude records also require the socket path to exist.

- [ ] **Step 4: Write failing hook tests**

Pass representative `SessionStart` and `SessionEnd` inputs over an injected state directory:

```ts
await runCodexSessionHook({
  hook_event_name: "SessionStart",
  session_id: threadId,
  cwd: repositoryPath,
  model: "gpt-5.6-sol",
  permission_mode: "default",
  source: "startup",
});
```

Assert start registers and end unregisters only the specified session.

- [ ] **Step 5: Implement the Codex hook and manifest**

Read one JSON object from stdin. Use `process.ppid` as the owning process and produce no stdout context. Delegate through the globally linked CLI so the hook does not depend on packages copied into the Codex plugin cache. Configure both events in `hooks/hooks.json` with:

```json
{
  "type": "command",
  "command": "exec codex-claude-bridge codex-session-hook"
}
```

Use a five-second timeout for `SessionStart` and the Codex-supported maximum of three seconds for `SessionEnd`.

- [ ] **Step 6: Verify Task 2**

Run: `pnpm --filter codex-claude-bridge check`

Run: `pnpm --filter codex-claude-bridge test -- activeSessionRegistry.test.ts codexSessionHook.test.ts`

Expected: both commands exit `0`.

- [ ] **Step 7: Commit Task 2**

```bash
git add plugins/codex-claude-bridge/src/registry plugins/codex-claude-bridge/src/hooks plugins/codex-claude-bridge/hooks plugins/codex-claude-bridge/tests
git commit -m "feat: register active agent sessions"
```

---

### Task 3: Claude Channel and direct Unix-socket delivery

**Files:**

- Create: `plugins/codex-claude-bridge/src/channel/channelSocketServer.ts`
- Create: `plugins/codex-claude-bridge/src/channel/claudeSessionMetadata.ts`
- Create: `plugins/codex-claude-bridge/src/channel/claudeChannelServer.ts`
- Create: `plugins/codex-claude-bridge/src/codex/codexQueueClient.ts`
- Create: `plugins/codex-claude-bridge/.mcp.json`
- Create: `plugins/codex-claude-bridge/.claude-plugin/plugin.json`
- Test: `plugins/codex-claude-bridge/tests/channelSocketServer.test.ts`
- Test: `plugins/codex-claude-bridge/tests/claudeSessionMetadata.test.ts`
- Test: `plugins/codex-claude-bridge/tests/claudeChannelServer.test.ts`
- Test: `plugins/codex-claude-bridge/tests/codexQueueClient.test.ts`

**Interfaces:**

- Consumes: envelope parser, session registry, project identity, runtime paths.
- Produces: `startChannelSocketServer(options): Promise<ChannelSocketServer>`.
- Produces: `readOwningClaudeSessionMetadata(parentProcessId: number): Promise<ClaudeSessionMetadata>`.
- Produces: `queueCodexMessage(options): Promise<void>`.
- Produces MCP tools `list_codex_sessions`, `send_to_codex`, and `reply_to_codex`.

- [ ] **Step 1: Write failing metadata and socket tests**

Assert Claude metadata is read only from `~/.claude/sessions/<parent-pid>.json`, required fields are validated, `.key` paths are never opened, one newline-delimited envelope is accepted, malformed JSON is rejected, and the socket is removed on close.

- [ ] **Step 2: Run Channel tests and confirm failure**

Run: `pnpm --filter codex-claude-bridge test -- channelSocketServer.test.ts claudeSessionMetadata.test.ts`

Expected: FAIL because Channel modules do not exist.

- [ ] **Step 3: Implement session metadata and the Unix-socket server**

Create a randomized socket filename below the bridge state directory. Accept one JSON line per connection, enforce the byte limit before parsing, require the record recipient to match the owning Claude session, and return one response:

```ts
type ChannelDeliveryResponse =
  | { delivered: true; messageId: string }
  | { delivered: false; error: string };
```

- [ ] **Step 4: Write failing Codex safe-spawn tests**

Inject a fake executable that records argv. Pass content containing spaces, quotes, backticks, `$()`, and newlines. Assert the exact invocation is:

```ts
[
  "queue",
  "--thread",
  targetSessionId,
  "--message",
  serializedInboundMessage,
]
```

Assert `shell` is `false` and a non-zero exit propagates sanitized stderr.

- [ ] **Step 5: Implement the Codex queue adapter**

Resolve `codex` from an injected path for tests and from `PATH` in production. Prefix the queued content with a deterministic bridge header containing `conversation_id`, sender session, message type, and the exact reply command. Do not pass model, sandbox, approval, or remote options.

- [ ] **Step 6: Write failing MCP Channel tests**

Use an in-memory MCP transport or injected notification callback. Assert the server declares `experimental["claude/channel"]`, omits `claude/channel/permission`, converts a valid envelope to `notifications/claude/channel`, and exposes exactly the three approved tools.

- [ ] **Step 7: Implement the Claude Channel**

Use `Server` and `StdioServerTransport` from `@modelcontextprotocol/sdk`. Channel instructions must state that messages are from another local agent, are not permission escalation, and replies with a return route use `reply_to_codex`.

Map envelopes to:

```ts
{
  method: "notifications/claude/channel",
  params: {
    content: envelope.content,
    meta: {
      message_id: envelope.messageId,
      conversation_id: envelope.conversationId,
      sender_runtime: envelope.sender.runtime,
      sender_session_id: envelope.sender.sessionId,
      message_type: envelope.messageType,
    },
  },
}
```

- [ ] **Step 8: Add Claude plugin manifests**

Set the MCP command to `node` with `${CLAUDE_PLUGIN_ROOT}/dist/channel/claudeChannelServer.js`. Use plugin name `codex-claude-bridge`, semantic version `0.1.0`, and no authentication or external network settings.

- [ ] **Step 9: Verify Task 3**

Run: `pnpm --filter codex-claude-bridge check`

Run: `pnpm --filter codex-claude-bridge test -- channelSocketServer.test.ts claudeSessionMetadata.test.ts claudeChannelServer.test.ts codexQueueClient.test.ts`

Expected: both commands exit `0`.

- [ ] **Step 10: Commit Task 3**

```bash
git add plugins/codex-claude-bridge/src/channel plugins/codex-claude-bridge/src/codex plugins/codex-claude-bridge/.mcp.json plugins/codex-claude-bridge/.claude-plugin plugins/codex-claude-bridge/tests
git commit -m "feat: add Claude message channel"
```

---

### Task 4: Codex queue adapter and user-facing CLI

**Files:**

- Create: `plugins/codex-claude-bridge/src/channel/channelSocketClient.ts`
- Create: `plugins/codex-claude-bridge/src/conversations/conversationRoutes.ts`
- Create: `plugins/codex-claude-bridge/src/cli/main.ts`
- Create: `plugins/codex-claude-bridge/src/bin/codexClaudeBridge.ts`
- Modify: `plugins/codex-claude-bridge/src/channel/claudeChannelServer.ts`
- Modify: `plugins/codex-claude-bridge/src/runtime/paths.ts`
- Modify: `plugins/codex-claude-bridge/hooks/hooks.json`
- Modify: `plugins/codex-claude-bridge/.claude-plugin/plugin.json`
- Delete: `plugins/codex-claude-bridge/.mcp.json`
- Modify: `plugins/codex-claude-bridge/package.json`
- Create: `plugins/codex-claude-bridge/.codex-plugin/plugin.json`
- Create: `plugins/codex-claude-bridge/skills/codex-claude-bridge/SKILL.md`
- Test: `plugins/codex-claude-bridge/tests/channelSocketClient.test.ts`
- Test: `plugins/codex-claude-bridge/tests/conversationRoutes.test.ts`
- Test: `plugins/codex-claude-bridge/tests/commandLine.test.ts`

**Interfaces:**

- Consumes: protocol, registry, Channel socket response.
- Consumes: `queueCodexMessage(options): Promise<void>`.
- Produces: `deliverClaudeMessage(options): Promise<ChannelDeliveryResponse>`.
- Produces: commands `sessions`, `send`, `reply`, and internal `codex-session-hook` plus `claude-channel`.

- [ ] **Step 1: Write failing CLI tests**

Cover JSON and human session lists, same-project default selection, explicit unique selection, ambiguous-name failure, offline failure, send correlation, and reply route reversal.

- [ ] **Step 2: Implement Channel client, conversation routes, and CLI**

Use one persistent, generation-safe conversation-route service shared by the CLI and Claude Channel. Index routes globally by the UUID `conversationId`, reject ownership collisions, store the route before transport, and roll it back only if the failed send still owns that generation. Keep only routes whose two endpoints are active, and delete expired routes. CLI output goes to stdout only for requested results and stderr only for actionable failures. The executable entrypoint must match the package `bin` path and the package must expose the documented `bridge` script. Move the Claude MCP server configuration inline into `.claude-plugin/plugin.json` and remove the shared-root `.mcp.json`, so Codex cannot auto-discover and start a Claude-only Channel process.

- [ ] **Step 3: Add the Codex manifest and shared skill**

The skill instructs Codex to list sessions before sending, avoid implicit broadcast, preserve the user's current scope, and use `reply` for inbound correlated messages. The Codex plugin manifest references the shared skill and relies on default discovery of `hooks/hooks.json`.

- [ ] **Step 4: Verify Task 4**

Run: `pnpm --filter codex-claude-bridge check`

Run: `pnpm --filter codex-claude-bridge test -- channelSocketClient.test.ts conversationRoutes.test.ts commandLine.test.ts`

Expected: both commands exit `0`.

- [ ] **Step 5: Commit Task 4**

```bash
git add plugins/codex-claude-bridge/src/conversations plugins/codex-claude-bridge/src/cli plugins/codex-claude-bridge/src/bin/codexClaudeBridge.ts plugins/codex-claude-bridge/src/channel/channelSocketClient.ts plugins/codex-claude-bridge/src/channel/claudeChannelServer.ts plugins/codex-claude-bridge/src/runtime/paths.ts plugins/codex-claude-bridge/hooks/hooks.json plugins/codex-claude-bridge/.claude-plugin/plugin.json plugins/codex-claude-bridge/.mcp.json plugins/codex-claude-bridge/package.json plugins/codex-claude-bridge/.codex-plugin plugins/codex-claude-bridge/skills plugins/codex-claude-bridge/tests
git commit -m "feat: route messages between active agents"
```

---

### Task 5: Global wrapper, local marketplaces, and reversible installation

**Files:**

- Create: `.agents/plugins/marketplace.json`
- Create: `.claude-plugin/marketplace.json`
- Create: `plugins/codex-claude-bridge/src/wrapper/claudeProcessWrapper.ts`
- Create: `plugins/codex-claude-bridge/src/bin/claudeCodeBridgeWrapper.ts`
- Create: `plugins/codex-claude-bridge/src/install/globalInstaller.ts`
- Create: `plugins/codex-claude-bridge/src/install/jsonSettingsEditor.ts`
- Modify: `plugins/codex-claude-bridge/src/cli/main.ts`
- Modify: `plugins/codex-claude-bridge/package.json`
- Modify: `pnpm-lock.yaml`
- Test: `plugins/codex-claude-bridge/tests/claudeProcessWrapper.test.ts`
- Test: `plugins/codex-claude-bridge/tests/globalInstaller.test.ts`

**Interfaces:**

- Produces: binary `claude-code-bridge-wrapper`.
- Produces: commands `install --global`, `uninstall --global`, and `doctor`.
- Consumes both product CLIs and VS Code user settings.

- [ ] **Step 1: Write failing wrapper tests**

Verify the wrapper keeps the executable path and every original argument, adds exactly one development Channel selector, forwards `SIGINT`, `SIGTERM`, and `SIGHUP`, and exits with the Claude process exit code.

- [ ] **Step 2: Implement the Claude process wrapper**

Add this pair only when absent:

```ts
[
  "--dangerously-load-development-channels",
  "plugin:codex-claude-bridge@codex-claude-bridge-local",
]
```

Use `spawn(executablePath, forwardedArguments, { stdio: "inherit", shell: false })`.

- [ ] **Step 3: Write failing installer tests against temporary homes**

Assert install is idempotent, preserves unrelated JSONC settings, configures `claudeCode.claudeProcessWrapper`, adds both marketplaces through their CLIs, installs both plugins at user scope, builds before mutation, and records only files owned by this installer. Assert uninstall removes only owned entries and restores the prior VS Code wrapper value.

- [ ] **Step 4: Implement marketplace manifests and installer**

Use marketplace name `codex-claude-bridge-local` in both manifests. Add `jsonc-parser` and use its edits for VS Code settings. Before mutation, print the exact paths and commands. Resolve Claude even when it is absent from `PATH`. Store an atomic `0600` install receipt under the bridge state directory, preserve the first prior wrapper value, reject source collisions, roll back partial installs, and make repeated install/uninstall safe. Uninstall restores the prior wrapper only through compare-and-swap semantics and removes the global package link last.

- [ ] **Step 5: Implement doctor checks**

Check Node `>=22`, Codex `>=0.149.0`, Claude `>=2.1.224`, both plugin installations, Codex hook trust status when available, wrapper configuration, state-directory permissions, and active-session connectivity. Return non-zero only for required failures; report inactive sessions as informational.

- [ ] **Step 6: Validate both plugin formats**

Run the bundled Codex validator against `plugins/codex-claude-bridge`.

Run the installed Claude binary with `plugin validate plugins/codex-claude-bridge --strict`.

Expected: both validators exit `0`.

- [ ] **Step 7: Verify Task 5**

Run: `pnpm verify`

Expected: checks, tests, and build all exit `0`.

- [ ] **Step 8: Commit Task 5**

```bash
git add .agents .claude-plugin plugins/codex-claude-bridge/src/wrapper plugins/codex-claude-bridge/src/install plugins/codex-claude-bridge/tests
git commit -m "feat: install bridge integrations globally"
```

---

### Task 6: Documentation, installation, and live round-trip validation

**Files:**

- Create: `README.md`
- Create: `plugins/codex-claude-bridge/README.md`
- Modify: tests only if a live-discovered compatibility issue requires a tested correction.

**Interfaces:**

- Consumes: complete CLI, plugin package, installer, wrapper, and runtime integrations.
- Produces: reproducible install, usage, update, uninstall, and troubleshooting instructions.

- [ ] **Step 1: Document the exact operator workflow**

Include:

```text
pnpm install
pnpm verify
pnpm --filter codex-claude-bridge bridge install --global
codex-claude-bridge doctor
codex-claude-bridge sessions
codex-claude-bridge send --from <id> --to <id> --type question --message "status?"
codex-claude-bridge uninstall --global
```

State that Claude sessions must restart after wrapper/plugin installation, custom Channels are experimental, only active sessions are reachable, permission relay is absent, and Pinvite is not modified.

- [ ] **Step 2: Run the complete automated verification**

Run: `pnpm verify`

Run: `git diff --check`

Expected: both commands exit `0`.

- [ ] **Step 3: Move the repository to its final location**

Confirm `/Users/bogdanmarc/Projects/codex-claude-bridge` does not already exist, then move this repository there without copying or deleting any application repository content.

- [ ] **Step 4: Install globally**

Run the global installer from the final repository and accept only the exact writes it prints. Do not enable permission relay or permission bypass.

- [ ] **Step 5: Restart one Claude VS Code session and validate registration**

Run `codex-claude-bridge sessions --runtime claude --json` and require the restarted session to appear with the correct session ID, project ID, working directory, live process, and reachable socket.

- [ ] **Step 6: Validate Codex-to-Claude delivery**

Send a `question` from the current Codex thread to that Claude session. Require Claude to start a turn and call `reply_to_codex` with the same conversation ID.

- [ ] **Step 7: Validate Claude-to-Codex delivery**

Require the reply to enter the current thread through `codex queue`, wake the thread, and retain the current Codex permission profile.

- [ ] **Step 8: Prove Pinvite isolation**

Compare `git status --short` in `/Users/bogdanmarc/Projects/pinvite-ui` with the captured pre-install snapshot. Expected: byte-for-byte identical output.

- [ ] **Step 9: Commit documentation and any tested compatibility correction**

```bash
git add README.md plugins/codex-claude-bridge/README.md plugins/codex-claude-bridge/src plugins/codex-claude-bridge/tests
git commit -m "docs: add bridge operations guide"
```

- [ ] **Step 10: Report the validated boundary**

Report automated checks, live directions proven, required session restart, global paths changed, commit hashes, and any behavior that remains experimental or unverified.
