# PB-26.1 · The README sample output says Claude exposes no limit source, which PB-26 makes false

- **Scope:** `README.md`, `README.ru.md`, [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06
- **Dependencies:** PB-26

## Context

Both READMEs carry a sample `promptobus models` run, and its warning line reads:

```text
  ! unknown-remaining: claude exposes no limit source — remaining counted as 50 % and the candidate penalised 10 points
```

`README.md:138` and `README.ru.md:138`, found with `grep -n "no limit source" README.md README.ru.md` on 2026-09-06.

PB-26 makes the sentence false for a healthy account: the Claude adapter now reads `limits[]` from `/api/oauth/usage` and reports three windows and a tier, so that harness reaches `available` and raises no `unknown-remaining` warning. The line stays true only for the branches where the limit could not be read — no credential record, an expired token, a refused endpoint — which is not what a sample of a working run should show. PB-27 does the same to the Cursor half of any sample that names it.

The sample also predates the `availability:` block PB-24 added to the `models` output, so it is short of two harness lines and their windows whatever is done about the warning.

## Work to do

- Re-take the sample output in both READMEs from a real run once PB-26…PB-29 are in, so the warning list, the candidate scores and the `availability:` block are the ones the shipped version prints.
- Keep the two files in step: the Russian README carries the same block verbatim, and only one of them being re-taken is the drift this entry is about.

## Out of scope

- The reference's own reason-code table — PB-26 already corrected the `quota_unknown` row.

## Verification

- `grep -n "no limit source" README.md README.ru.md` finds nothing.
- The sample matches a real `promptobus models` run on a machine with the three harnesses declared.
