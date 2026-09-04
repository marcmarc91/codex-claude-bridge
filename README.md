# Codex-Claude Bridge

Codex-Claude Bridge is a local, user-scoped bridge between active Codex and Claude Code sessions on the same macOS account. It is installed once and can be used from any Git repository without adding dependencies or tracked files to application repositories.

The bridge uses supported runtime entry points:

- Codex sends to Claude through a per-session Unix socket owned by a Claude MCP Channel.
- Claude sends to Codex through `codex queue`.
- Claude-to-Claude communication remains on Claude Code's native `ListAgents` and `SendMessage` tools.

There is no daemon, scheduler, polling loop, TCP listener, broadcast, or bridge-owned offline queue. Only sessions that are currently running can receive messages.

## Requirements

- macOS and one local user account for both runtimes
- Node.js 22 or newer
- npm with a writable global prefix
- pnpm 9
- Codex 0.149.0 or newer
- Claude Code 2.1.224 or newer
- Visual Studio Code with the Claude Code extension for automatic wrapper activation

Custom Claude Channels are experimental. The required development Channel selector is added only to newly started Claude processes:

```text
--dangerously-load-development-channels plugin:codex-claude-bridge@codex-claude-bridge-local
```

This selector loads the Channel. It does not bypass approvals, change a sandbox, or relay permissions between agents.

## Install

Run from the repository root:

```bash
pnpm install
pnpm verify
pnpm --filter codex-claude-bridge bridge install --global
codex-claude-bridge doctor
```

Before mutating global state, the installer prints the build, commands, paths, VS Code setting, and receipt it will manage. Installation:

- builds the TypeScript package;
- creates npm global links for `codex-claude-bridge` and `claude-code-bridge-wrapper`;
- registers and installs the local Codex marketplace plugin;
- registers and installs the local Claude marketplace plugin at user scope;
- sets `claudeCode.claudeProcessWrapper` in the VS Code user settings;
- records owned changes in a private installation receipt.

The installer does not write to application repositories.

## Activate new sessions

Installation is not retroactive for processes that are already running.

1. Reload the VS Code window, then open a new Claude Code session.
2. Start a new Codex process, or resume a Codex thread in a new process.
3. Accept the normal Codex hook-trust prompt if one is shown. Do not use `--dangerously-bypass-hook-trust`.
4. Run `codex-claude-bridge doctor` again.

The Codex session hook runs on `SessionStart`, while the Claude Channel and process wrapper are loaded when the Claude process starts. A chat reset inside an existing process is not sufficient.

## CLI

List active sessions:

```bash
codex-claude-bridge sessions
codex-claude-bridge sessions --runtime claude --project /absolute/project/path
codex-claude-bridge sessions --runtime codex --json
```

Human output is tab-separated. JSON output has this shape:

```json
{
  "sessions": [
    {
      "runtime": "claude",
      "session_id": "00000000-0000-4000-8000-000000000000",
      "display_name": "example",
      "project_id": "0123456789abcdef01234567",
      "working_directory": "/absolute/project/path"
    }
  ]
}
```

The listing omits process and socket details. A listed Claude session has already passed the bridge's process and socket liveness checks.

Send from one active Codex session to one active Claude session:

```bash
codex-claude-bridge send \
  --from <codex-session-uuid-or-exact-name> \
  --to <claude-session-uuid-or-exact-name> \
  --type question \
  --message "What is your current status?"
```

`--type` accepts `message`, `question`, or `handoff`. Use UUIDs when possible. Exact display names are scoped to the source project and are rejected when ambiguous; the bridge never guesses or broadcasts.

Reply to a correlated inbound message:

```bash
codex-claude-bridge reply \
  --conversation <conversation-uuid> \
  --message "The requested work is complete."
```

Add `--json` to `send` or `reply` for structured output. A successful result contains `acknowledgement: "transport acknowledgement only"`: it confirms that the target runtime accepted the message, not that the target model processed it.

Inspect the installation:

```bash
codex-claude-bridge doctor
codex-claude-bridge doctor --json
```

No active sessions is informational. Missing requirements, unsafe state permissions, receipt drift, or integration drift make `doctor` exit non-zero.

## Live round-trip check

After starting fresh Codex and Claude sessions in the same project, list both sides:

```bash
codex-claude-bridge sessions --runtime codex --project /absolute/project/path --json
codex-claude-bridge sessions --runtime claude --project /absolute/project/path --json
```

From the newly started Codex session, send a question to the listed Claude UUID:

```bash
codex-claude-bridge send \
  --from <codex-session-uuid> \
  --to <claude-session-uuid> \
  --type question \
  --message "Confirm receipt and reply through reply_to_codex." \
  --json
```

The check passes when:

1. `send` returns a conversation UUID and a transport-only acknowledgement.
2. Claude starts a turn and calls `reply_to_codex` with that conversation UUID.
3. The reply wakes the originating Codex thread through `codex queue`.
4. Both runtimes retain their existing permission modes.

## Update

For a deterministic update, uninstall with the currently installed checkout before replacing its contents, update the checkout, and reinstall:

```bash
codex-claude-bridge uninstall --global
pnpm install
pnpm verify
pnpm --filter codex-claude-bridge bridge install --global
```

Restart both Codex and Claude processes after reinstalling. Re-running `install --global` against an intact installed receipt verifies the installation and returns without replacing already installed integrations.

## Uninstall

```bash
codex-claude-bridge uninstall --global
```

Uninstall removes only entries recorded as installer-owned. The prior VS Code wrapper value is restored with compare-and-swap semantics. If that setting was changed after installation, the newer user-owned value is left unchanged. The npm global link is removed last.

## Interrupted install recovery

Installation and removal are serialized and use an atomic receipt. Normally, re-run the command that failed and the installer will recover or finish the remaining rollback steps.

If the error explicitly reports missing termination proof, first verify that the previous npm, Codex plugin, or Claude plugin command is no longer running. Then acknowledge that fact on the same operation:

```bash
codex-claude-bridge install --global --confirm-pending-command-stopped
codex-claude-bridge uninstall --global --confirm-pending-command-stopped
```

Do not use this flag preemptively. It can recover an unconfirmed command for which no process-group identifier was captured, but only on the user's explicit assertion that the process stopped. A known process group that is still active cannot be bypassed. A known process group that is no longer active is detected and recovered automatically. Do not edit or delete the receipt manually.

## State and security boundary

Bridge state is stored below `${XDG_STATE_HOME:-~/.local/state}/codex-claude-bridge`. Directories use mode `0700`; records, locks, receipts, and sockets use mode `0600`.

The bridge:

- uses Unix sockets only and opens no network port;
- validates message IDs, routes, timestamps, paths, and payload sizes;
- limits message content to 65,536 UTF-8 bytes;
- never reads Codex SQLite, Claude transcripts, Claude `.key` files, or credentials;
- invokes child processes with argument arrays and `shell: false`;
- does not execute message content;
- does not alter model, sandbox, approval, or permission settings.

Conversation routes expire and are removed when either endpoint is no longer active.

## Troubleshooting

- **A session is missing:** verify `doctor`, start a fresh runtime process, accept normal Codex hook trust, and confirm the project filter.
- **A target name is ambiguous:** repeat the command with the session UUID shown by `sessions`.
- **Claude does not register:** reload the VS Code window and open a new Claude Code session so the process wrapper can load the Channel.
- **Codex does not register:** start or resume the thread in a new Codex process; hooks are not injected into an already running process.
- **A transport acknowledgement has no model reply:** the acknowledgement does not mean the model completed a turn. Confirm that the target remains active.
- **Recovery is refused for an active process group:** wait for or stop the exact prior installer child process, then re-run the operation. The confirmation flag cannot override a live known process group.
- **`doctor` reports drift:** inspect the reported integration or user-owned setting. The installer deliberately refuses destructive takeover.

## Development verification

```bash
pnpm install --frozen-lockfile
pnpm verify
git diff --check
claude plugin validate plugins/codex-claude-bridge --strict
claude plugin validate .claude-plugin/marketplace.json --strict
```

The Codex plugin can also be checked with the validator bundled with a local Codex installation:

```bash
python3 "$HOME/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py" \
  plugins/codex-claude-bridge
```
