# PB-346 · An opencode shell cannot own a root task or lift a teamlead

- **Scope:** [05-drivers § OPENCODE]
- **Created:** 2026-10-06
- **Dependencies:** none
- **Cost:** major

## Context

Attempted a two-teamlead tree (backslop + promptobus groups, all lifts `--harness opencode --model opencode-go/muse-spark-1.3-contributor --strategy balanced`) from an opencode shell (`OPENCODE_SESSION_ID` set, no `CLAUDE_CODE_SESSION_ID`/`CODEX_THREAD_ID`/`CURSOR_CONVERSATION_ID`). Root task `opencode-tree-bs-233-235-t20261006-130546` was created via `spawn --new-task`, but its orchestrator record carries no owner (`harness: claude, mode: attached, sessionRef: null`), and every ownership-gated call from the same shell is refused.

Evidence:
- `promptobus spawn --teamlead --brief <file> --task opencode-tree-bs-233-235-t20261006-130546 --slug backslop --harness opencode --model opencode-go/muse-spark-1.3-contributor --strategy balanced --dry-run` → exit 1: `root task ... is bound to session null, this one is null — only the root orchestrator lifts a teamlead`.
- `promptobus_mailbox` on the root task → `records no mailbox owner, and this call carries no session identity`.
- Same shell lifted a flat worker fine (`worker:placeholder`, session `ses_eeeae018dffe8nA9Hgv9k3aKHO`, holder `opencode serve --port 0`), so worker lifts do not need the missing identity — only root ownership/teamlead lifts do.
- `lib/driver-opencode.js`: `identityVar: null`; `docs/reference/05-drivers.md`: an opencode session carries no CLI owner identity.

## Work to do

- [ ] Decide how an opencode shell proves root ownership (e.g. read `OPENCODE_SESSION_ID` as CLI identity, or an explicit bind/claim step for root creation), keeping the ADR-019 contested-identity guarantees.
- [ ] Implement it in the opencode driver + store wiring.
- [ ] Cover with a test: root created from an opencode-identity shell is ownable, `spawn --teamlead` passes planning on opencode.
- [ ] Update `02-host`/`05-drivers` docs.

## Out of scope

- Flat worker lifts (already work); model routing/pricing changes.

## Verification

- [ ] From an opencode shell with no Claude/Codex/Cursor identity: create a root task, `mailbox claim` succeeds, `spawn --teamlead --dry-run` and a real teamlead lift on opencode pass; Claude/Codex/Cursor ownership behavior unchanged.
