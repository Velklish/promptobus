# PB-243 · Mail delivery to the orchestrator costs more than it carries

- **Order:** 130
- **Scope:** [reference/04-protocol.md](../../reference/04-protocol.md), [lib/warden.js](../../../lib/warden.js), [lib/store.js](../../../lib/store.js), [lib/notification.js](../../../lib/notification.js) (the postcard), the `promptobus_mailbox` tool
- **Created:** 2026-09-22
- **Dependencies:** none
- **Cost:** major

## Context

Measured on three orchestrator sessions of the runs between 2026-09-17 and 2026-09-21 — 2270 model turns, 1305M token-turns of carried history. A token that enters a session's transcript is re-read on every later turn, so delivery overhead is paid once per message and again on every turn that follows it.

Three findings, each from the transcripts rather than from reasoning:

- **The mailbox hands over full bodies of everything.** 512 calls, 1.51M characters, 2950 characters per call on average — 25.7% of everything the orchestrator carries. Among them are 398 `status` messages for the window, which the protocol says expect no answer: the orchestrator needs to know they arrived, not to read them.
- **The warden's postcard is mostly boilerplate.** 287 postcards, 363k characters, 84M token-turns. A fixed 712-character tail sits on every one of them (the "fetch the mailbox" line plus the harness paragraph about peer messages), and the median postcard carries 976 characters of which 264 are new. The rest repeats 287 times.
- **Short bodies are delivered twice.** 145 of those postcards carried the message body in full, and the protocol still requires a mailbox fetch to mark it read — so the same 122k characters arrive a second time. The stub form ("text N characters — fetch the mailbox") already exists and is used for long messages.

Postcards arrive in bursts: 143 of 287 landed within 90 seconds of the previous one, the median gap is 89 seconds, the shortest 8. That they are not folded is [PB-229](../../archive/LOG.md#pb-229)'s subject, and the measurement above is evidence for it; this card makes each postcard smaller, PB-229 makes them fewer.

## Work to do

- Let the mailbox return headers — sender, type, time, size, first line — and fetch a body on request. Reading a header must still mark the message read, otherwise the protocol's "only mailbox marks messages read" stops holding.
- Use the existing stub for every postcard instead of inlining the body: the recipient has to open the mailbox anyway.

## Out of scope

- The routing policy that keeps reviewers on the orchestrator-only route. A direct reviewer-to-worker channel was considered and measured as roughly equal in tokens to this card together with PB-229, while it costs the isolation of review, the arbiter of a disagreement and the visibility of a silent pair. It stays a separate question, and its own reason is latency, not tokens.
- Coalescing the warden's knocks — that is [PB-229](../../archive/LOG.md#pb-229). The two meet: fewer postcards times a smaller postcard.
- The harness paragraph about peer messages, which is 560 of the 712 fixed characters. This package does not control it; only sending fewer postcards reduces how often it is paid, which is PB-229's half.

## Verification

- A measurement of the same shape before and after, on comparable runs: characters delivered to the orchestrator per message, postcards per run, and the share of them that are the fixed tail. The scripts are the owner's, outside this repository.
- The protocol invariant holds: after the change a message is still marked read only through the mailbox, and a participant that reads only headers is still told it has unread mail.
- A postcard for a short message carries the stub, not the body, and the recipient still learns who wrote, of what type and how large.

## Re-triage, 2026-09-23

Checked on `39316bc2` from the repository root. **Cost `major`**: mail delivery puts boilerplate and bodies the orchestrator has already read into its context, and every later turn re-reads them. The card puts that at about 26% of the orchestrator's carried history.

- The mailbox has no headers mode: `promptobus_mailbox` takes `claim` and the task argument only (`src/mcp/tools.ts:57-68`), and the handler renders every message in full (`src/mcp/server.ts:160-175`).
- The protocol side holds: `status` expects no answer (`docs/reference/04-protocol.md:38`), and "only mailbox marks messages read" is the postcard's own line (`lib/driver-claude.js:269`).
- **More precise than the card:** the stub has no per-message threshold. The postcard's preview block has a budget of 2000 characters (`KNOCK_TEXT_MAX`, `lib/contract.js:22`). `previewBlock` (`lib/notification.js:25-43`) inlines each body that fits in what is left, and otherwise uses the stub `text N characters — fetch the mailbox` (`:20`). So "short" means "fits in the remaining budget".
- **Assumption, not tree-checkable:** the 712-character fixed tail. The package's own tail for the Claude frame is 169 characters (the `fetchLine` and working-order line at `lib/driver-claude.js:266-272`, measured with `node --input-type=module -e` over `orderBody`). The harness paragraph that makes up the rest is not in this repository. The package's own tail (169) exceeds the 152 that the card's split leaves for it (712 − 560) by 17, so 712 does not decompose as stated.
- The Scope misses where the postcard text is built: `lib/notification.js` and each driver's `orderBody`.
- Not tree-checkable: the transcript counts of 2026-09-17 to 2026-09-21. The scripts are the owner's.
