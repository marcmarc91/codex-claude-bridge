# Codex-Claude Bridge

Codex-Claude Bridge is a local, user-scoped bridge between active Codex and Claude Code sessions on the same macOS account. It is installed once and can be used from any Git repository without adding dependencies or tracked files to application repositories.

The bridge uses supported runtime entry points:

- Codex sends to Claude through a per-session Unix socket owned by a Claude MCP Channel.
- Claude sends to Codex through `codex queue`.
- Claude-to-Claude communication remains on Claude Code's native `ListAgents` and `SendMessage` tools.

There is no standalone daemon, TCP listener, broadcast, or bridge-owned offline queue. Only sessions that are currently running can receive messages. The Claude Channel monitors outstanding messages during its own lifetime; an explicitly waiting CLI command can poll delivery receipts without leaving a background process behind.

## Requirements

- macOS and one local user account for both runtimes
- Node.js 22 or newer
- npm with a writable global prefix whose `bin` directory is present in the `PATH` used by the installer and Codex
- pnpm 9
- Codex 0.149.0 or newer
- Claude Code 2.1.224 or newer
- Optional: VS Code, VS Code Insiders, Cursor, or Windsurf with the Claude Code extension

Custom Claude Channels are experimental. The required development Channel selector is added only to newly started Claude processes:

```text
--dangerously-load-development-channels plugin:codex-claude-bridge@codex-claude-bridge-local
```

This selector loads the Channel. It does not bypass approvals, change a sandbox, or relay permissions between agents.

## Install

Clone the repository and run the installer from its root:

```bash
git clone https://github.com/marcmarc91/codex-claude-bridge.git
cd codex-claude-bridge
pnpm bootstrap
```

Bootstrap installs dependencies, builds the package, and runs setup. Setup checks the installation, runs diagnostics, and prints the next steps. Then start one runtime in each of two terminals, from the same project directory:

```bash
codex-claude-bridge launch claude
codex-claude-bridge launch codex
```

Pass runtime arguments after the runtime name; `--` is supported. Accept the normal Channel and hook-trust prompts. Starting the processes is not yet a verified connection: use the [live round-trip check](#live-round-trip-check) below.

Keep this checkout at the same path while the bridge is installed. The npm global link and both local marketplace registrations refer to this checkout. Run `codex-claude-bridge uninstall --global` before moving or deleting it.

Setup is repeatable and refreshes an existing installation. Editor integration is optional and auto-detected. Configure an explicit settings file or skip editor integration with:

```bash
codex-claude-bridge setup --vscode-settings /absolute/path/to/settings.json
codex-claude-bridge setup --no-vscode
```

Setup has no confirmation prompts of its own. Runtime approvals and permission modes remain unchanged.

Only existing settings files are auto-detected. Create an editor's user settings first if it has never saved any, or use an explicit existing settings file during initial setup. Refresh does not overwrite a wrapper changed by the user and does not take ownership of a previously unowned setting. `--no-vscode` skips editor changes; it does not uninstall existing editor integration or discard its restoration record. Diagnostics can still report retained editor settings that differ from the recorded installation.

Before mutating global state, the installer prints the build, commands, paths, VS Code setting, and receipt it will manage. Installation:

- builds the TypeScript package;
- creates npm global links for `codex-claude-bridge` and `claude-code-bridge-wrapper`;
- registers and installs the local Codex marketplace plugin;
- registers and installs the local Claude marketplace plugin at user scope;
- optionally sets `claudeCode.claudeProcessWrapper` in the selected editor's user settings;
- records owned changes in a private installation receipt.

The installer does not write to application repositories. It also verifies that the global `codex-claude-bridge` command resolves from the installer's `PATH`. The VS Code process wrapper prepends that global `bin` directory to Claude's `PATH`; a Claude process started directly in a terminal must already inherit it.

## Activate new sessions

Installation is not retroactive for processes that are already running.

For the VS Code extension:

1. Reload the VS Code window, then open a new Claude Code session. The configured process wrapper adds the development Channel selector.
2. Approve Claude Code's development Channel confirmation when prompted.
3. Start a new Codex process, or resume a Codex thread in a new process.
4. Accept the normal Codex hook-trust prompt if one is shown. Do not use `--dangerously-bypass-hook-trust`.
5. Run `codex-claude-bridge doctor` again.

For Claude Code in a terminal, the launcher selects the Channel:

```bash
codex-claude-bridge launch claude
```

The equivalent direct runtime command is:

```bash
claude --dangerously-load-development-channels \
  plugin:codex-claude-bridge@codex-claude-bridge-local
```

The Codex session hook runs on `SessionStart`, while the Claude Channel and process wrapper are loaded when the Claude process starts. A chat reset such as `/clear` inside an existing process is not sufficient.

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
  --reply-to <inbound-message-uuid> \
  --message "The requested work is complete."
```

Add `--json` to `send` or `reply` for structured output. A successful result contains `acknowledgement: "transport acknowledgement only"`: it confirms that the target runtime accepted the message, not that the target model processed it.

Record explicit receipt of an inbound message and inspect its status:

```bash
codex-claude-bridge ack --message <message-uuid>
codex-claude-bridge status --message <message-uuid>
```

Use the message UUID, not the conversation UUID. Add `--wait-minutes 5` to `send` to keep that invocation waiting: questions and handoffs wait for a correlated reply; informational messages wait for an explicit acknowledgement. A seen-but-unreplied question still reaches the reply deadline. Without a waiting invocation, no CLI background monitor remains running.

`--reply-to` correlates the reply to one inbound message. Without it, an ambiguous conversation can receive a reply without any original message being marked `replied`. `ack` and `status` also accept `--json`; `ack --from <codex-session>` explicitly selects the receiving session.

`CODEX_CLAUDE_BRIDGE_TIMEOUT_MINUTES` sets the stored receipt deadline in minutes (default `5`). `--wait-minutes` controls only how long this CLI invocation waits; it does not change that stored deadline. Both accept 0.01–1440 minutes.

For `send --wait-minutes`, exit codes are `0` for the expected acknowledgement/reply, `1` for a missing receipt or command/storage error, `2` for an elapsed wait with diagnosis, and `3` for receipt-lock contention through the deadline (`receipt_lock_timeout`). `status` returns `0` when a receipt exists, even if overdue, and `1` when it is missing.

After transport acceptance, `receipt_warning` means receipt persistence failed, not delivery. A later wait error returns exit `1` with `wait_error`, preserving `delivered` and `message_id`. Do not resend solely because of either field. Human output confirms transport before waiting; `--json` buffers one document until the wait finishes or errors. See [delivery and timeout semantics](docs/delivery-and-timeouts.md) for the complete contract.

Inspect the installation:

```bash
codex-claude-bridge doctor
codex-claude-bridge doctor --json
```

No active sessions is informational. Missing requirements, unsafe state permissions, receipt drift, or integration drift make `doctor` exit non-zero.

`doctor` inspects overdue receipts without creating or changing their store. Cleanup is a separate, explicit operation:

```bash
codex-claude-bridge clean --json
```

This removes eligible orphaned bridge sockets and dead-process registrations, reporting skipped paths and reasons. It does not delete persistent lock files or restart agents. Prefer running it after stopping bridge sessions: concurrent registration and the final socket check/removal are not one atomic operation.

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

From the original checkout, update the source and refresh the installation:

```bash
git pull
pnpm bootstrap
```

Restart both Codex and Claude processes after setup. Existing processes do not reload the new hooks or Channel. Preserve any local changes before updating; do not force-reset the checkout to resolve an update conflict.

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

Message receipts distinguish transport acceptance, explicit agent acknowledgement, and a correlated reply. None of these states proves that the requested work succeeded. See [delivery and timeout semantics](docs/delivery-and-timeouts.md) for the state model, monitoring limits, and safe recovery policy.

Bridge state is stored below `${XDG_STATE_HOME:-~/.local/state}/codex-claude-bridge`. Directories use mode `0700`; records, locks, receipts, and sockets use mode `0600`.

Channel socket paths must fit within 103 UTF-8 bytes, including the filename. If the default location is too long, choose a shorter absolute `XDG_STATE_HOME` consistently for setup and both runtimes, then start fresh processes. Changing this variable selects a different state location; it does not migrate an existing installation receipt or active sessions. Do not change it for only one side of the bridge.

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
- **The global bridge command is unavailable through `PATH`:** add the npm global `bin` directory to the terminal environment used by the installer, Codex, or a directly started Claude process, then reinstall and start fresh sessions. The VS Code wrapper adds it to Claude automatically.
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

## Distribution scope

The current distribution is a source-checkout installation for macOS. It can be cloned and installed by another user who meets the requirements, but the package is intentionally marked private and is not prepared for publication to npm. Repository visibility and source-code reuse rights are separate concerns; add an explicit open-source license before presenting the project as generally reusable software.
