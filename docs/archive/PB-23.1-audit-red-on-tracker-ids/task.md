# PB-23.1 · npm run audit is red on two queued task files: the origin tracker id pattern

- **Scope:** `docs/backlog/`, `scripts/audit-public.mjs`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`npm run audit` was red on the branch this series starts from, before any task of it was taken. Measured 2026-09-06 on `worktree-promptobus-pb-balance-contract-t20260905-233206` at commit `906098b`, a clean tree:

```text
✖ origin tracker ids: docs/backlog/queue/PB-23-adr-004-subscription-balance.md
✖ origin tracker ids: docs/backlog/queue/PB-31-overlay-merge-union-selectors.md
✖ publicity audit: 2 finding(s)
```

The gate is `scripts/audit-public.mjs`, and the pattern is the last row of its `FORBIDDEN` list — the origin tracker's id shape, two letters and a dash and a digit. Both files cited one such id as the evidence for the overlay-union decision: the entry in the first consumer's tracker that recorded the merge problem. The citation was right; the spelling is what the gate forbids in a public tree, because the id names a private tracker nobody outside it can resolve.

The audit is one of the two `gates` in `backslop.json`, so every task of this series would have reported against a gate that was already failing — a worker cannot turn it green from inside its own track, and a worker that ignores it cannot tell its own leak from this one.

## Outcome

Both halves are answered, and the entry is kept only so the approver can close it with the evidence attached.

- **The citations.** Fixed on `main` in commit `b5b110d`: both now read “a finding in its own tracker”, and `npm run audit` is clean on that commit.
- **The scope of the gate.** Asked, and answered by the approver on 2026-09-06: `docs/` is published on GitHub, so the tracker files ARE surface 1 of the audit and the gate scans them rightly. No scope and no exemption; the tarball never sees them either way, because `files` in `package.json` does not ship `docs/`.

## Verification

- `npm run audit` on `b5b110d`: clean, 366 tracked files and the packed tarball.
