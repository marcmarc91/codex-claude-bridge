# Codex-Claude Bridge Plugin

This package contains the shared runtime for the user-scoped Codex-Claude Bridge. See the [operator guide](../../README.md) for requirements, installation, activation, updates, recovery, and removal.

## Components

- `codex-claude-bridge`: session discovery, explicit delivery, correlated replies, installation, uninstallation, and diagnostics
- `claude-code-bridge-wrapper`: starts the real Claude executable with the bridge development Channel selected exactly once
- Codex `SessionStart` and `SessionEnd` hooks: delegate to the globally linked CLI to publish and remove ephemeral Codex session registrations
- Codex skill: instructs Codex to list sessions, select one target, and preserve the user's task and permission scope
- Claude MCP Channel: owns one Unix socket per active Claude session and injects accepted messages as Channel notifications

The plugin identifier is:

```text
codex-claude-bridge@codex-claude-bridge-local
```

## Claude tools

The Channel exposes four tools:

- `list_codex_sessions(project?: string)` lists active local Codex sessions, optionally filtered by an absolute project path.
- `send_to_codex(session_id: string, message_type: string, content: string)` queues a message to one explicit active Codex UUID.
- `reply_to_codex(conversation_id: string, content: string, reply_to_message_id?: string)` replies over an active correlated route. Include the inbound message ID when multiple messages share a conversation.
- `acknowledge_message(message_id: string)` explicitly records that the receiving Claude agent has seen the message.

There is no permission tool and no broadcast fallback. Claude-to-Codex delivery delegates wake-up to `codex queue`.

## Command contract

```text
codex-claude-bridge sessions [--runtime claude|codex] [--project <path>] [--json]
codex-claude-bridge send --from <session> --to <session> --type <message|question|handoff> --message <text> [--wait-minutes <minutes>] [--json]
codex-claude-bridge reply --conversation <uuid> --message <text> [--reply-to <message-id>] [--json]
codex-claude-bridge ack --message <message-id> [--from <session>] [--json]
codex-claude-bridge status --message <message-id> [--json]
codex-claude-bridge clean [--json]
codex-claude-bridge doctor [--json]
codex-claude-bridge setup [--no-vscode] [--vscode-settings <path>] [--confirm-pending-command-stopped]
codex-claude-bridge launch claude|codex [--] [args...]
codex-claude-bridge install --global [--confirm-pending-command-stopped]
codex-claude-bridge uninstall --global [--confirm-pending-command-stopped]
```

Internal plugin entry points are `codex-session-hook` and `claude-channel`; they are not operator registration commands.

The Codex hook and Claude MCP manifests invoke `codex-claude-bridge` from `PATH` instead of loading JavaScript from a plugin cache. The supported installer therefore creates and verifies the npm global link before installing either plugin, and removes that link only after uninstalling both plugins. The VS Code process wrapper prepends the global `bin` directory to Claude's `PATH`; the installer, Codex, and a directly started Claude process must already resolve it.

Messages use strict UUID-based envelopes, canonical UTC timestamps, explicit sender and recipient addresses, and at most 65,536 UTF-8 bytes of content. Unknown envelope fields are rejected. Replies retain the conversation UUID and reverse the route.

A successful send or reply initially confirms transport acceptance only. Persistent receipts separately track explicit agent acknowledgement and correlated replies. See [delivery and timeout semantics](../../docs/delivery-and-timeouts.md). A reply is not evidence that the requested work passed verification.

For `send --wait-minutes`, exits are `0` for the requested receipt, `1` for a missing receipt or command/storage error, `2` for an elapsed wait, and `3` for `receipt_lock_timeout`. A post-delivery `receipt_warning` or `wait_error` does not prove non-delivery; retain the message ID and inspect status before considering another send. JSON wait output is one buffered document. `clean` mutates orphaned state explicitly; it is not part of `doctor` or `setup`.

## Runtime boundary

Only active sessions are addressable. Git worktrees share a project identity derived from their common Git directory. Exact display-name selection is allowed only when unambiguous; UUID selection is preferred.

All bridge-owned runtime state is private to the current user. The bridge uses Unix sockets, does not access private runtime databases or credentials, and does not change either agent's model, sandbox, approvals, or permission mode.
