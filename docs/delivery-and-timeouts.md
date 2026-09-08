# Delivery receipts and timeout semantics

This document describes the reliability implementation and CLI contract. The September 3 design and implementation plan are historical snapshots, not the current monitoring contract. Automated tests and code review do not replace a live round-trip check after installing and starting fresh runtime processes.

## What a receipt proves

Every message has a unique message ID. The conversation ID identifies a route and may cover several messages; it is not sufficient to identify which message received a reply.

| State | Evidence | Does not prove |
| --- | --- | --- |
| `pending` | The bridge persisted an outgoing attempt. | Transport acceptance. |
| `accepted` | The runtime transport accepted the message. | The agent saw the message or started work. |
| `seen` | The addressed agent explicitly acknowledged the message. | A reply or successful task completion. |
| `replied` | An accepted reverse-route reply was correlated to this message. | Correctness or verification of the reply's claims. |

Transport state is tracked separately as `pending`, `accepted`, `unknown`, or `failed`. A timeout after a write can leave delivery unknown; it must not be treated as proof of non-delivery. A late explicit acknowledgement or reply can provide stronger evidence than the initial transport result.

Transport acceptance can precede visibility to the Codex agent by tens of minutes during a long-running turn. This delay has been observed during bridge development; queue-drain timing is controlled by the runtime, not guaranteed by this bridge. End the current turn after handing off a review or reporting a status when no independent work remains, so the runtime has an opportunity to surface queued messages. This is a coordination practice, not a delivery guarantee. Do not infer non-delivery or automatically resend work just because the agent has not acknowledged it yet.

Acknowledgements are idempotent and scoped to the exact recipient runtime, session, and project. A correlated reply implies acknowledgement. Receipts preserve sent, transport-accepted, acknowledged, and replied timestamps separately. An acknowledgement arriving before the sender records transport acceptance does not invent a transport-acceptance timestamp.

On Claude, call `acknowledge_message` with the inbound `message_id` before starting requested work. Use `reply_to_message_id` with `reply_to_codex` to correlate a reply explicitly. When conversation-only correlation is ambiguous, the reply can still be delivered but no individual original receipt is marked replied. Diagnostic notifications are not new task messages and must not be acknowledged or replied to as tasks.

On Codex, use `codex-claude-bridge ack --message <inbound-message-id>` before work, `status --message <message-id>` to inspect the receipt, and `reply --conversation <conversation-id> --reply-to <inbound-message-id> --message <text>` to correlate the answer. Each command accepts `--json`; `ack` also accepts `--from <receiving-codex-session>`. These checks enforce route identity within the local user account, not cryptographic authentication of an agent process.

## CLI results and errors

Add `--wait-minutes <minutes>` to `send` to wait for `replied` on questions/handoffs or `seen` on informational messages. This duration does not modify the persisted deadline configured by `CODEX_CLAUDE_BRIDGE_TIMEOUT_MINUTES`: a longer wait can still observe a receipt already marked overdue by `status` or `doctor`.

| Exit from `send --wait-minutes` | Meaning |
| --- | --- |
| `0` | The expected explicit receipt arrived. |
| `1` | Missing receipt or command/storage/wait error; not proof of non-delivery. |
| `2` | The wait elapsed without the expected receipt; diagnosis goes to stderr. |
| `3` | Receipt lock remained unavailable through the wait deadline; reason `receipt_lock_timeout`. |

These codes are not a universal contract for every command: `status` returns `0` for an existing receipt even when overdue, `doctor` returns `1` for required failed checks, and `launch` propagates the child process exit code.

If transport succeeds but persisting acceptance or reply correlation fails, the CLI emits a stderr warning and includes `receipt_warning` in JSON. Without an explicit wait, this still exits `0`. If waiting subsequently throws, the CLI exits `1`, includes `wait_error` in JSON, and preserves the original `delivered` and `message_id` fields without inventing an outcome. Human output confirms transport before waiting; JSON is buffered and emitted as one document when waiting ends or errors. Neither warning authorizes automatic retransmission; inspect the original message ID first.

## Timeout and process lifetime

`CODEX_CLAUDE_BRIDGE_TIMEOUT_MINUTES` configures the default deadline. The default is five minutes; valid values range from 0.01 to 1440 minutes. Reaching it triggers diagnosis, not a delivery-failure verdict. A deadline is not an execution deadline and never cancels another agent's work.

Claude-to-Codex questions and handoffs are monitored by the sending Claude Channel process. It checks overdue receipts approximately every 30 seconds and sends a diagnostic Channel notification when no correlated reply has arrived. Plain informational messages are not included in overdue scans. Monitoring stops when that process exits.

Codex-to-Claude monitoring requires an explicitly waiting CLI invocation or a subsequent status check. No process survives a CLI invocation. The wait helper supports waiting for either `seen` or `replied`; waiting only for `seen` cannot detect a later missing reply. Persisted deadlines can be evaluated lazily after restart, but they do not create an always-on reminder service.

An explicit wait retries temporary receipt-lock contention until its deadline. If the receipt remains inaccessible, the result is `unknown` with reason `receipt_lock_timeout`, not `missing`, `seen`, or a proven delivery failure. Other storage errors remain visible. An in-flight lock acquisition may exceed the deadline by up to approximately four seconds.

## Diagnosis and safe recovery

Diagnosis inspects the exact target's active registration, process liveness, and socket availability where applicable. It retries read-only inspection at most three times. A reachable socket does not prove that Claude loaded the Channel selector, and accepting `codex queue` does not prove that a queued message became visible to the agent. Those observations remain unknown until there is explicit agent evidence.

A slow transport reply does not unregister a live session. A refused connection or missing socket can remove only the matching stale registration generation, never a replacement session.

The Channel retries failed diagnostic notifications at most three times per message during that process lifetime. Concurrent checks are serialized and successful notifications are deduplicated in memory. Restarting the process resets notification deduplication, so an outstanding message may produce another diagnostic after restart.

Task messages are not retransmitted automatically. The bridge never guesses another recipient, restarts agents, changes approval modes, or interprets silence as permission to execute a repair. Use the diagnosis to distinguish a missing process, a startup/configuration problem, and an agent that has not replied. Fixing configuration and starting a fresh session remain separate actions.

`doctor` reads overdue receipts without locking, creating their directory, pruning, or writing; corrupt storage remains a reported diagnostic rather than an empty result. `clean [--json]` separately removes eligible orphaned sockets and dead-process registrations. Accepting or uncertain socket probes are skipped, and lock files remain untouched. Prefer cleanup after stopping bridge sessions: project enumeration and the final socket check/removal retain concurrency windows. Neither `doctor` nor `setup` runs this cleanup automatically.

## Storage and limits

Receipts are private, bounded metadata under the bridge state directory. They contain routes, timestamps, state, message type, and a content digest, not message bodies. The default store accepts at most 512 unexpired records and retains records for up to 24 hours after their deadline. Expired records are pruned lazily. At capacity, the oldest completed records are evicted first: replied messages, definite transport failures, and explicitly seen informational messages or replies. Questions and handoffs that are only seen remain outstanding. If all records are outstanding, new receipt creation is refused; uncertain deliveries are never discarded to make room. An evicted receipt is no longer available to status queries.

Updates use one persistent store lock and atomic replacement. Do not delete lock files to clear a problem: removing a locked inode can let independent writers enter the same critical section. Runtime transcripts and native queues have their own retention policies outside this receipt store.
