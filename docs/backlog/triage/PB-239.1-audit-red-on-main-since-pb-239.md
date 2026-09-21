# PB-239.1 · The publicity audit has been red on main since PB-239 was filed: the card names the origin CLI

- **Order:** 480
- **Area:** `scripts/audit-public.mjs`, `docs/backlog/triage/PB-239-*`
- **Created:** 2026-09-22
- **Cost:** major — a gate in `gates` is red on the main branch, so every later task starts on a red tree and has to prove the red is not its own.
- **Parent:** PB-239
- **Depends on:** none

## Context

`npm run audit` exits 1 on `main` as it stands. Measured 2026-09-22 on a clean tree — the working
changes stashed, `git stash push -u`, then `npm run audit`:

```
✖ origin CLI name: docs/backlog/triage/PB-239-sweep-says-unknown-session-when-claude-is-off-path.md
✖ publicity audit: 1 finding(s) · checked 1006 tracked text files and 136 packed text entries
exit 1
```

The file was added by `0be6fcba` ("PB-237..PB-241: filed"), and the forbidden string is in the
card's own slug and title: the finding is about the origin CLI being off `PATH`, and naming it is
how the finding is stated.

Two ways out, and the choice is the owner's. Either the audit skips task cards the way
`check-pins.mjs` already skips `CHANGELOG.md`, `docs/adr/**`, the archive and the cards — they
cite a moment rather than instruct — or the card is renamed to describe the symptom without the
vendor's name. The first is a contract change to what the audit protects; the second loses the
searchable name in the tracker.

## What is not established

Whether any other tracked file trips the same rule: the run names one finding, and it was not
re-run after a rename.
