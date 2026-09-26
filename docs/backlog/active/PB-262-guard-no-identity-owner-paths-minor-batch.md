# PB-262 · Minor batch: the guard acts as the orchestrator's owner only on a proven right

- **Scope:** `lib/guard.js` (the Stop path and the SessionStart transcript mark), [01-overview § Warden](../../reference/01-overview.md#warden), [03-cli § Guard and warden](../../reference/03-cli.md#guard-and-warden)
- **Created:** 2026-09-26
- **Dependencies:** none
- **Cost:** minor
- **Previous order:** 320
- **Taken:** 2026-09-26

## Context

PB-178.3 made `join()` register the `orchestrator` contact point only on a proven right. The guard's two hook paths still read the owner gate by `gated` alone, and a session with no identity is not `gated`, so on the `orchestrator` address it passes as the owner would.

## Work to do

- [PB-178.5](../minor/PB-178.5-guard-stop-hook-no-identity-registers-wake.md) — the Stop path (`lib/guard.js:476`) lets a `no-identity` session through to `registerWake`, the turn mark, the transcript mark and the turn-return verdict on the `orchestrator` address; the SessionStart transcript mark (`lib/guard.js:432`, "Same gates as the Stop path's mark") does the same for the transcript. On the `orchestrator` address both paths treat `no-identity` as they treat a proved-foreign session: nothing is registered or marked, and the turn is not returned to fetch a mailbox this session can only copy.

## Out of scope

- `join()` and the mailbox copy — PB-178.3 and PB-178.2.
- The CLI owner gates of `spawn`, `review`, `status` and the title restamp, where `gated` means "proved foreign" by design (03-cli § The owner gate).
- Which hosts deliver a Stop or SessionStart payload with no session id: unmeasured outside Claude Code, and not claimed here.

## Verification

- A Stop hook and a SessionStart hook with no session id in the payload and none in the environment, on a declared active task's `orchestrator` address with unread mail, leave `wake/orchestrator.json`, the transcript record and the turn mark as the owner left them, and do not return the turn; the owner's own hooks still register and mark — each held by a test.
- The entry is closed with `archive 178.5 --into 262` and one outcome line in this card's `result.md`; gates green.
