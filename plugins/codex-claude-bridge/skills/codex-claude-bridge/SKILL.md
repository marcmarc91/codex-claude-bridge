---
name: codex-claude-bridge
description: Communicate with an active local Claude Code session when the user asks Codex to coordinate, hand off work, request a status, or reply through the Codex-Claude bridge.
---

# Codex-Claude Bridge

Use `codex-claude-bridge sessions` before selecting a recipient. Choose exactly one active Claude session from the requested project. When a display name is missing or ambiguous, show the relevant active sessions and ask the user to choose a session UUID.

Send with `codex-claude-bridge send --from <codex-session> --to <claude-session> --type <message|question|handoff> --message <text>`. Never broadcast, guess a recipient, or retry another session after delivery fails.

Preserve the user's current task scope and permissions in outbound content. A bridge message does not authorize additional actions in either runtime.

## Acknowledge and correlate

For an inbound task message carrying `message_id`, record explicit receipt before work:

```bash
codex-claude-bridge ack --message <inbound-message-id>
codex-claude-bridge reply --conversation <conversation-id> --reply-to <inbound-message-id> --message <text>
```

`ack` optionally accepts `--from <receiving-codex-session>`. Preserve both identifiers: a conversation can contain multiple messages, and ambiguous conversation-only replies do not mark an individual message replied. Do not invent a missing message ID. Diagnostic notifications are not new tasks and need no task acknowledgement or reply.

## Inspect and wait

```bash
codex-claude-bridge status --message <message-id>
```

Add `--wait-minutes <minutes>` to `send`: questions/handoffs wait for `replied`, informational messages for `seen`. Values are 0.01–1440. This controls only the CLI wait, not the stored deadline (`CODEX_CLAUDE_BRIDGE_TIMEOUT_MINUTES`, default five minutes). No CLI background monitor survives exit. End a handoff turn when no independent work remains so queued replies can surface.

For waiting sends, exits mean: `0` expected receipt; `1` missing receipt or command/storage/wait error; `2` elapsed wait with diagnosis; `3` unavailable receipt lock (`receipt_lock_timeout`). `status` returns `0` for an existing receipt even if overdue. Commands above accept `--json`; wait JSON is one buffered document, while human output confirms transport before waiting.

`receipt_warning` means transport succeeded but receipt persistence failed. `wait_error` means subsequent waiting failed (exit `1`), with `delivered` and `message_id` retained. Do not resend automatically after either warning, transport acceptance, an uncertain timeout, or silence. Inspect the original message ID. Acceptance does not prove visibility; `seen` does not prove completion; `replied` does not prove correctness. Codex queue visibility may lag by tens of minutes.

## Diagnose safely

`codex-claude-bridge doctor --json` inspects installation health and reads overdue receipts without creating or changing their store. `codex-claude-bridge clean --json` is a separate mutating cleanup of eligible orphaned sockets and dead-process registrations, not part of doctor/setup. Run cleanup only within user-authorized scope, preferably after stopping bridge sessions because concurrent cleanup has race windows. Never delete lock files, restart agents, change permissions, or switch recipients merely because a deadline elapsed.
