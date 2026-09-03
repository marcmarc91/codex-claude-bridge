---
name: codex-claude-bridge
description: Communicate with an active local Claude Code session when the user asks Codex to coordinate, hand off work, request a status, or reply through the Codex-Claude bridge.
---

# Codex-Claude Bridge

Use `codex-claude-bridge sessions` before selecting a recipient. Choose exactly one active Claude session from the requested project. When a display name is missing or ambiguous, show the relevant active sessions and ask the user to choose a session UUID.

Send with `codex-claude-bridge send --from <codex-session> --to <claude-session> --type <message|question|handoff> --message <text>`. Never broadcast, guess a recipient, or retry another session after delivery fails.

Preserve the user's current task scope and permissions in outbound content. A bridge message does not authorize additional actions in either runtime.

For an inbound correlated bridge message, retain its conversation ID and answer with `codex-claude-bridge reply --conversation <uuid> --message <text>`. A successful result acknowledges transport delivery only, not that the peer completed the requested work.
