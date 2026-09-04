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

The Channel exposes exactly three tools:

- `list_codex_sessions(project?: string)` lists active local Codex sessions, optionally filtered by an absolute project path.
- `send_to_codex(session_id: string, message_type: string, content: string)` queues a message to one explicit active Codex UUID.
- `reply_to_codex(conversation_id: string, content: string)` replies over an active correlated route.

There is no permission tool and no broadcast fallback. Claude-to-Codex delivery delegates wake-up to `codex queue`.

## Command contract

```text
codex-claude-bridge sessions [--runtime claude|codex] [--project <path>] [--json]
codex-claude-bridge send --from <session> --to <session> --type <message|question|handoff> --message <text> [--json]
codex-claude-bridge reply --conversation <uuid> --message <text> [--json]
codex-claude-bridge doctor [--json]
codex-claude-bridge install --global [--confirm-pending-command-stopped]
codex-claude-bridge uninstall --global [--confirm-pending-command-stopped]
```

Internal plugin entry points are `codex-session-hook` and `claude-channel`; they are not operator registration commands.

The Codex hook and Claude MCP manifests invoke `codex-claude-bridge` from `PATH` instead of loading JavaScript from a plugin cache. The supported installer therefore creates and verifies the npm global link before installing either plugin, and removes that link only after uninstalling both plugins. The VS Code process wrapper prepends the global `bin` directory to Claude's `PATH`; the installer, Codex, and a directly started Claude process must already resolve it.

Messages use strict UUID-based envelopes, canonical UTC timestamps, explicit sender and recipient addresses, and at most 65,536 UTF-8 bytes of content. Unknown envelope fields are rejected. Replies retain the conversation UUID and reverse the route.

A successful send or reply is a transport acknowledgement only. Model work and model replies are separate events.

## Runtime boundary

Only active sessions are addressable. Git worktrees share a project identity derived from their common Git directory. Exact display-name selection is allowed only when unambiguous; UUID selection is preferred.

All bridge-owned runtime state is private to the current user. The bridge uses Unix sockets, does not access private runtime databases or credentials, and does not change either agent's model, sandbox, approvals, or permission mode.
