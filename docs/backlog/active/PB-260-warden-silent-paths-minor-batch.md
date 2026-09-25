# PB-260 · Minor batch: silent paths of the warden and the protocol — a malformed ref named, the transcript path at SessionStart, the artifact seam's reach stated

- **Scope:** `src/v1/messages.ts`, `src/supervisor.ts`, `lib/guard.js`, [04-protocol](../../reference/04-protocol.md) § Message types and § Fault injection, [hooks-and-trust](../../guides/hooks-and-trust.md)
- **Created:** 2026-09-26
- **Dependencies:** none
- **Cost:** minor
- **Previous order:** 290
- **Taken:** 2026-09-26

## Context

Three minor entries where the warden or the protocol is silent about something it cannot see. Two of them waited for an owner's choice; the owner delegated these choices on 2026-09-26, and the decisions are recorded under each entry below.

## Work to do

- [PB-66.2](../minor/PB-66.2-malformed-ref-keeps-knocking-in-silence.md) — the glance skips an unparsable mailbox record in silence while the count keeps it, so the warden knocks with an empty preview. **Decision: name it** — the postcard line and the health mark carry the parse error with the ref name, as PB-66.1 does for a refused ref; the glance stays non-consuming.
- [PB-243.2](../minor/PB-243.2-transcript-path-recorded-only-at-stop.md) — `transcript_path` is recorded only on the Stop path, so a question in a session's first turn gets the old re-knocks. Record it on SessionStart as well.
- [PB-146.3](../minor/PB-146.3-list-artifacts-without-faults-seam.md) — the bulk artifact listing takes no fault hook. **Decision: documentation** — 04-protocol § Fault injection says the artifact seam covers the direct reads only.

## Out of scope

- The consuming read and the `broken/` isolation; the artifact code itself.

## Verification

- Each entry's own Verification for the decision above, closed with `archive N.k --into 260` and one outcome line per entry in this card's `result.md`; gates green.
