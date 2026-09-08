# Delivery receipts and timeout semantics

This document describes the reliability implementation. The September 3 design and implementation plan are historical snapshots, not the current monitoring contract. CLI integration and live runtime validation must be reviewed alongside the runtime implementation before release.

## What a receipt proves

Every message has a unique message ID. The conversation ID identifies a route and may cover several messages; it is not sufficient to identify which message received a reply.

| State | Evidence | Does not prove |
| --- | --- | --- |
| `pending` | The bridge persisted an outgoing attempt. | Transport acceptance. |
| `accepted` | The runtime transport accepted the message. | The agent saw the message or started work. |
| `seen` | The addressed agent explicitly acknowledged the message. | A reply or successful task completion. |
| `replied` | An accepted reverse-route reply was correlated to this message. | Correctness or verification of the reply's claims. |

Transport state is tracked separately as `pending`, `accepted`, `unknown`, or `failed`. A timeout after a write can leave delivery unknown; it must not be treated as proof of non-delivery. A late explicit acknowledgement or reply can provide stronger evidence than the initial transport result.

Acknowledgements are idempotent and scoped to the exact recipient runtime, session, and project. A correlated reply implies acknowledgement. Receipts preserve sent, transport-accepted, acknowledged, and replied timestamps separately. An acknowledgement arriving before the sender records transport acceptance does not invent a transport-acceptance timestamp.

On Claude, call `acknowledge_message` with the inbound `message_id` before starting requested work. Use `reply_to_message_id` with `reply_to_codex` to correlate a reply explicitly. When conversation-only correlation is ambiguous, the reply can still be delivered but no individual original receipt is marked replied. Diagnostic notifications are not new task messages and must not be acknowledged or replied to as tasks.

## Timeout and process lifetime

`CODEX_CLAUDE_BRIDGE_TIMEOUT_MINUTES` configures the default deadline. The default is five minutes; valid values range from 0.01 to 1440 minutes. A deadline is not an execution deadline and never cancels another agent's work.

Claude-to-Codex questions and handoffs are monitored by the sending Claude Channel process. It checks overdue receipts approximately every 30 seconds and sends a diagnostic Channel notification when no correlated reply has arrived. Plain informational messages are not included in overdue scans. Monitoring stops when that process exits.

Codex-to-Claude monitoring requires an explicitly waiting CLI invocation or a subsequent status check. No process survives a CLI invocation. The wait helper supports waiting for either `seen` or `replied`; waiting only for `seen` cannot detect a later missing reply. Persisted deadlines can be evaluated lazily after restart, but they do not create an always-on reminder service.

## Diagnosis and safe recovery

Diagnosis inspects the exact target's active registration, process liveness, and socket availability where applicable. It retries read-only inspection at most three times. A reachable socket does not prove that Claude loaded the Channel selector, and accepting `codex queue` does not prove that a queued message became visible to the agent. Those observations remain unknown until there is explicit agent evidence.

A slow transport reply does not unregister a live session. A refused connection or missing socket can remove only the matching stale registration generation, never a replacement session.

The Channel retries failed diagnostic notifications at most three times per message during that process lifetime. Concurrent checks are serialized and successful notifications are deduplicated in memory. Restarting the process resets notification deduplication, so an outstanding message may produce another diagnostic after restart.

Task messages are not retransmitted automatically. The bridge never guesses another recipient, restarts agents, changes approval modes, or interprets silence as permission to execute a repair. Use the diagnosis to distinguish a missing process, a startup/configuration problem, and an agent that has not replied. Fixing configuration and starting a fresh session remain separate actions.

## Storage and limits

Receipts are private, bounded metadata under the bridge state directory. They contain routes, timestamps, state, message type, and a content digest, not message bodies. The default store accepts at most 512 unexpired records and retains records for 24 hours after their deadline. Expired records are pruned lazily. When capacity is exhausted, the bridge refuses new receipt creation instead of silently discarding outstanding records.

Updates use one persistent store lock and atomic replacement. Do not delete lock files to clear a problem: removing a locked inode can let independent writers enter the same critical section. Runtime transcripts and native queues have their own retention policies outside this receipt store.
