# Security

## Reporting a vulnerability

Use the repository's private vulnerability reporting option if it is available. Otherwise, open an issue requesting a private contact method, without exploit details or sensitive attachments.

Include the affected commit or version, operating system and runtime versions, a minimal reproduction using synthetic data, and the expected and observed behavior. Never attach credentials, agent transcripts, private message content, or an unredacted state directory. No response-time guarantee or supported-version schedule is currently published.

## Local trust boundary

The bridge connects local agent sessions under one operating-system account. It is not a remote service or an isolation boundary against other software running as that user.

Runtime state uses private directories and files. Delivery receipts retain routing identifiers, timestamps, state and an envelope digest; they do not retain message text. Message content is passed to the recipient runtime, whose own retention policy still applies.

Incoming agent messages do not grant permission to execute tools, change sandbox settings, or approve another agent's actions. A transport acknowledgement does not establish that an agent received or acted on the message. Explicit agent acknowledgements are distinct from replies and successful task completion.

## Changes requiring security review

Review changes to state paths, ownership and permission checks, symlink handling, locks, process lifecycle, message routing, or retry behavior. Keep filesystem operations scoped to bridge-owned state, preserve user settings, and treat uncertain delivery as uncertain. Do not introduce automatic task retransmission that can duplicate side effects or redirect work to a different session.

Test with synthetic sessions and temporary directories. Do not delete persistent lock files to recover an active installation: competing processes can otherwise lock different files at the same path.
