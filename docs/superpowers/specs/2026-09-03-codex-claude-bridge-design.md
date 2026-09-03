# Codex-Claude Bridge Design

## Purpose

Build a reusable local bridge that lets active Codex and Claude Code sessions on the same macOS user account exchange messages and wake one another. The bridge is installed globally and works from any Git repository without adding application dependencies or tracked configuration to those repositories.

## Scope

The first version supports:

- Codex to Claude Code messages through a custom Claude Channel.
- Claude Code to Codex messages through the official `codex queue` command.
- Claude Code to Claude Code messages through Claude Code's native `ListAgents` and `SendMessage` tools.
- Active-session discovery across projects and Git worktrees.
- Direct replies correlated to the originating conversation.

The first version does not support:

- Offline delivery or a durable bridge-owned message queue.
- A background daemon or scheduled polling.
- Network access, remote machines, or multi-user operation.
- Permission relay, remote approval, or changes to an agent's permission mode.
- Reading agent transcripts, authentication tokens, or Claude `.key` files.
- Broadcast delivery.

## Official Transport Boundaries

The bridge delegates agent wake-up to the supported runtime mechanisms:

- `codex queue --thread <thread> --message <text>` targets a live Codex session by UUID or exact name. Codex owns queue persistence, dispatch, wake-up, and permission restoration.
- A Claude Channel emits `notifications/claude/channel` over MCP stdio. Claude Code owns event injection, turn creation, and permission enforcement.
- Claude's native `ListAgents` and `SendMessage` remain the route for Claude-to-Claude communication.

The bridge does not access Codex SQLite directly and does not connect to Claude's private cross-session socket protocol.

## Architecture

The repository produces one global CLI and two integrations:

```text
Codex session
  -> codex-claude-bridge send --to claude:<session>
  -> active Claude Channel Unix socket
  -> notifications/claude/channel
  -> Claude session

Claude session
  -> MCP tool send_to_codex or reply_to_codex
  -> codex queue --thread <thread-id> --message <envelope>
  -> Codex session
```

There is no shared server. Every active Claude Channel process creates its own Unix socket and publishes an ephemeral registration record. Codex sessions publish registration records through global `SessionStart` and `SessionEnd` hooks. CLI operations inspect these records, reject stale entries, and connect directly to the selected target.

## Repository Layout

```text
codex-claude-bridge/
  .claude-plugin/plugin.json
  .codex-plugin/plugin.json
  hooks/hooks.json
  skills/codex-claude-bridge/SKILL.md
  src/channel/claudeChannelServer.ts
  src/channel/channelSocketServer.ts
  src/cli/commandLine.ts
  src/cli/main.ts
  src/codex/codexQueueClient.ts
  src/protocol/messageEnvelope.ts
  src/registry/activeSessionRegistry.ts
  src/registry/projectIdentity.ts
  src/runtime/filePermissions.ts
  src/runtime/paths.ts
  src/hooks/codexSessionHook.ts
  src/wrapper/claudeProcessWrapper.ts
  tests/
  package.json
  tsconfig.json
  README.md
```

Each file has one responsibility. The Claude plugin and Codex plugin manifests point to the same compiled package rather than duplicating runtime logic.

## Session Identity and Discovery

An active-session record contains:

```ts
type AgentRuntime = "claude" | "codex";

interface ActiveSessionRecord {
  schemaVersion: 1;
  runtime: AgentRuntime;
  sessionId: string;
  displayName: string;
  processId: number;
  workingDirectory: string;
  projectId: string;
  socketPath?: string;
  registeredAt: string;
}
```

`projectId` is derived from `git rev-parse --git-common-dir` when available, so worktrees share one project identity. Outside Git it is derived from the canonical working directory.

Records live under `${XDG_STATE_HOME:-~/.local/state}/codex-claude-bridge/sessions/`. The directory mode is `0700`; record files are `0600`; Claude socket files are `0600`. A record is active only when its process exists and, for Claude, its socket accepts a connection. Stale records are removed during list and send operations.

Codex `SessionStart` registers `session_id`, `cwd`, and the hook process ancestry. `SessionEnd` unregisters the session. Claude Channel registration uses the owning Claude process identity and the Channel socket path. Duplicate display names are never guessed: callers must use the unique session ID.

## Message Contract

Every cross-runtime message uses this envelope:

```ts
interface AgentMessageEnvelope {
  schemaVersion: 1;
  messageId: string;
  conversationId: string;
  sentAt: string;
  messageType: "message" | "question" | "handoff" | "reply";
  sender: AgentAddress;
  recipient: AgentAddress;
  content: string;
  replyRoute?: AgentAddress;
}

interface AgentAddress {
  runtime: "claude" | "codex";
  sessionId: string;
  projectId: string;
}
```

Inputs are validated before transport. IDs must be UUIDs, timestamps must be ISO-8601 values, and `content` must contain between 1 and 65,536 UTF-8 bytes. Unknown fields are rejected. A reply retains `conversationId`, generates a new `messageId`, uses `messageType: "reply"`, and reverses the sender and recipient.

The transport acknowledges only that the target runtime accepted the message. It does not claim that the model processed it. Model replies are separate messages.

## CLI and Tool Interfaces

The global binary is `codex-claude-bridge` and supports:

```text
codex-claude-bridge sessions [--runtime claude|codex] [--project <path>] [--json]
codex-claude-bridge send --from <session> --to <session> --type <type> --message <text> [--json]
codex-claude-bridge reply --conversation <uuid> --message <text> [--json]
codex-claude-bridge register-codex-hook
codex-claude-bridge unregister-codex-hook
codex-claude-bridge doctor [--json]
```

The Claude Channel exposes only:

```text
list_codex_sessions(project?: string)
send_to_codex(session_id: string, message_type: string, content: string)
reply_to_codex(conversation_id: string, content: string)
```

It does not expose a permission tool. The Codex skill uses the CLI for listing, sending, and replying.

## Claude Integration

The repository is installed as a local Claude plugin containing the MCP Channel configuration. Because custom Channels are in research preview, Claude must start with:

```text
--dangerously-load-development-channels plugin:codex-claude-bridge@local
```

A global process wrapper receives the bundled Claude executable path and original arguments, adds this exact Channel flag once, and replaces itself with the real executable. The VS Code machine-level `claudeCode.claudeProcessWrapper` setting points to this wrapper. Existing Claude sessions must be restarted after installation.

The Channel instructions tell Claude that inbound content comes from another local agent, is not permission escalation, and should be answered through `reply_to_codex` when a reply route is present.

## Codex Integration

The repository is installed as a global Codex plugin. Its hooks register and unregister sessions, while its skill describes how to select a target and invoke the bridge CLI. Inbound text sent through `codex queue` includes a compact, deterministic prefix identifying it as a bridge message and providing the conversation ID and reply command.

The bridge never passes `--dangerously-bypass-approvals-and-sandbox`, never changes the target thread's model, and never overrides its active permission profile.

## Security

- All bridge-owned transport uses Unix sockets; no TCP port is opened.
- Runtime state is contained in a user-only directory.
- Child processes use argument arrays with `shell: false`.
- Session IDs, paths, and message content are validated before use.
- Socket paths are resolved below the bridge state directory and cannot contain traversal segments.
- Messages are never executed by the bridge.
- No credential is stored in registration records or message envelopes.
- No implicit broadcast or fallback target exists.
- Custom Channel permission relay is omitted.
- Agent messages retain the receiving runtime's sandbox and approval requirements.

## Failure Behavior

- Missing target: fail with a non-zero status and list matching active sessions.
- Ambiguous display name: fail and require a session ID.
- Stale registration: remove it, fail cleanly, and do not retry another session.
- Invalid envelope: reject before opening a transport.
- Channel write failure: close the socket, remove the stale record, and report non-delivery.
- `codex queue` failure: preserve its exit status and return sanitized stderr.
- Unsupported Codex or Claude version: `doctor` reports the required minimum and the detected version.

## Installation

The source repository lives at `/Users/bogdanmarc/Projects/codex-claude-bridge`. Installation builds the TypeScript package, links the CLI globally, registers local plugin marketplace entries, installs the Codex hook integration, installs the Claude plugin, and configures the VS Code process wrapper. Every global file mutation is enumerated before it is applied, and the installer provides a reversible uninstall command.

Pinvite and other application repositories remain unchanged.

## Verification

Automated tests cover:

- Strict message validation and byte limits.
- Git common-directory project identity.
- Atomic registration, stale cleanup, ambiguity, and project filtering.
- Unix socket delivery and refusal when the target is offline.
- Safe `codex queue` argument construction and error propagation using a fake executable.
- Wrapper argument preservation and single Channel-flag insertion.
- Hook registration and unregistration against temporary configuration.

The live smoke test must demonstrate:

1. A restarted Claude VS Code session registers its Channel.
2. The current Codex session appears in `sessions`.
3. Codex sends a question that wakes Claude.
4. Claude replies through `codex queue` and wakes the originating Codex thread.
5. Both agents retain their existing permission modes.
6. `git status --short` in Pinvite is byte-for-byte unchanged from the pre-install snapshot.

## Acceptance Criteria

- The CLI is callable from any working directory.
- Only currently active sessions are addressable.
- Direct Codex-to-Claude and Claude-to-Codex round trips succeed.
- Claude-to-Claude traffic remains on native cross-session messaging.
- No daemon, poller, TCP listener, offline queue, permission relay, credential access, Pinvite dependency, commit, or push is introduced.
