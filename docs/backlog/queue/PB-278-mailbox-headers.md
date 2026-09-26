# PB-278 · The mailbox returns headers and the postcard carries the stub

- **Order:** 150
- **Scope:** [04-protocol](../../reference/04-protocol.md), `src/mcp/tools.ts`, `src/mcp/server.ts`, `lib/notification.js`, `orderBody` of each driver, `lib/warden.js`
- **Created:** 2026-09-26; merges the card «Mail delivery to the orchestrator costs more than it carries» ([PB-243](../../archive/LOG.md#pb-243)) of 2026-09-22
- **Dependencies:** none
- **Cost:** major

## Context

The merged card measured three orchestrator sessions of the runs between 2026-09-17 and 2026-09-21 — 2270 model turns, 1305M token-turns of carried history — from the transcripts: the mailbox handed over full bodies in 512 calls, 1.51M characters, 25.7% of everything the orchestrator carried, 398 of them `status` messages that expect no answer; 287 postcards carried 363k characters, the median postcard 976 characters of which 264 were new; 145 postcards carried a short body in full and the protocol still required a mailbox fetch to mark it read, so 122k characters arrived twice.

Its re-triage of 2026-09-23 on `39316bc2` holds: `promptobus_mailbox` takes `claim` and the task argument only (`src/mcp/tools.ts`) and the handler renders every message in full (`src/mcp/server.ts`); `previewBlock` in `lib/notification.js` inlines each body that fits the remaining 2000-character budget (`KNOCK_TEXT_MAX`, `lib/contract.js`) and otherwise uses the stub `text N characters — fetch the mailbox`; the package's own fixed tail for the Claude frame is 169 characters, the rest of the tail is the harness's own paragraph and outside this repository. The 712-character split of the original card did not decompose and is not carried forward.

With the tree of ADR-021 the top orchestrator carries a teamlead's traffic as well; the owner took this card into the feedback phase on 2026-09-26.

## Work to do

- `promptobus_mailbox` returns headers — sender, type, time, size, first line — and a body on request by message id; reading a header marks the message read, so "only the mailbox marks messages read" keeps holding.
- Every postcard carries the stub, never the body: the recipient has to open the mailbox anyway.
- `status` and `digest` (PB-280) count unread by header without rendering bodies.

## Out of scope

- The routing policy that keeps reviewers on the orchestrator-only route: measured by the merged card as roughly equal in tokens to this change together with knock coalescing, at the price of review isolation; a separate question whose reason is latency.
- Coalescing the warden's knocks — PB-229 and the deferred PB-229.1; the two meet as fewer postcards times a smaller postcard.
- The harness's own peer-message paragraph: not this package's text.

## Verification

- The same-shape measurement before and after on comparable runs — characters delivered to the orchestrator per message, postcards per run, the share of fixed tail — with the owner's scripts outside this repository.
- After the change a message is still marked read only through the mailbox, and a participant that read only headers is still told it has unread mail until it does.
- A postcard for a short message carries the stub and still names sender, type and size.
