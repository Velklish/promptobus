# PB-243 · Mail delivery to the orchestrator costs more than it carries

- **Order:** 540
- **Scope:** [reference/04-protocol.md](../../reference/04-protocol.md), [lib/warden.js](../../../lib/warden.js), [lib/store.js](../../../lib/store.js), the `promptobus_mailbox` tool
- **Created:** 2026-09-22
- **Dependencies:** none

## Context

Measured on three orchestrator sessions of the runs between 2026-09-17 and 2026-09-21 — 2270 model turns, 1305M token-turns of carried history. A token that enters a session's transcript is re-read on every later turn, so delivery overhead is paid once per message and again on every turn that follows it.

Three findings, each from the transcripts rather than from reasoning:

- **The mailbox hands over full bodies of everything.** 512 calls, 1.51M characters, 2950 characters per call on average — 25.7% of everything the orchestrator carries. Among them are 398 `status` messages for the window, which the protocol says expect no answer: the orchestrator needs to know they arrived, not to read them.
- **The warden's postcard is mostly boilerplate.** 287 postcards, 363k characters, 84M token-turns. A fixed 712-character tail sits on every one of them (the "fetch the mailbox" line plus the harness paragraph about peer messages), and the median postcard carries 976 characters of which 264 are new. The rest repeats 287 times.
- **Short bodies are delivered twice.** 145 of those postcards carried the message body in full, and the protocol still requires a mailbox fetch to mark it read — so the same 122k characters arrive a second time. The stub form ("text N characters — fetch the mailbox") already exists and is used for long messages.

Postcards arrive in bursts: 143 of 287 landed within 90 seconds of the previous one, the median gap is 89 seconds, the shortest 8. That they are not folded is [PB-229](PB-229-warden-knocks-once-per-message.md)'s subject, and the measurement above is evidence for it; this card makes each postcard smaller, PB-229 makes them fewer.

## Work to do

- Let the mailbox return headers — sender, type, time, size, first line — and fetch a body on request. Reading a header must still mark the message read, otherwise the protocol's "only mailbox marks messages read" stops holding.
- Use the existing stub for every postcard instead of inlining the body: the recipient has to open the mailbox anyway.

## Out of scope

- The routing policy that keeps reviewers on the orchestrator-only route. A direct reviewer-to-worker channel was considered and measured as roughly equal in tokens to this card together with PB-229, while it costs the isolation of review, the arbiter of a disagreement and the visibility of a silent pair. It stays a separate question, and its own reason is latency, not tokens.
- Coalescing the warden's knocks — that is [PB-229](PB-229-warden-knocks-once-per-message.md). The two meet: fewer postcards times a smaller postcard.
- The harness paragraph about peer messages, which is 560 of the 712 fixed characters. This package does not control it; only sending fewer postcards reduces how often it is paid, which is PB-229's half.

## Verification

- A measurement of the same shape before and after, on comparable runs: characters delivered to the orchestrator per message, postcards per run, and the share of them that are the fixed tail. The scripts are the owner's, outside this repository.
- The protocol invariant holds: after the change a message is still marked read only through the mailbox, and a participant that reads only headers is still told it has unread mail.
- A postcard for a short message carries the stub, not the body, and the recipient still learns who wrote, of what type and how large.
