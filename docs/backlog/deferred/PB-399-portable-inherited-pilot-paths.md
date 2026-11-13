# PB-399 · Require owned portable paths in inherited native pilot sources

- **Scope:** [Public surface](../../guides/contributing.md#public-surface)
- **Created:** 2026-10-23
- **Dependencies:** none
- **Cost:** major

## Context

The source audit scans all tracked text. On the unchanged native-observer baseline, `npm run audit` reports six inherited experimental files with absolute owner-specific paths, although those files are excluded from the packed package. Current isolated repeats and an exact-base worktree reproduce the same six findings.

## Work to do

- Replace owner-specific temporary, evidence and observer-root constants only in the inherited experimental copy with explicit operator-supplied absolute paths.
- Refuse missing configuration before host creation, capture output writes or observer store access. Keep the UI projection read-only and its task fixed.
- Use a portable evidence description in the copied README; keep the audit unchanged.

## Out of scope

- Executing copied controller/capture helpers, changing the retained pilot source/build/plugin/evidence, default-plugin changes, source gate exemptions and permission changes.

## Verification

- Focused tests exercise actual pure path guards and the observer's missing-root boundary with a store-access spy; copied native/capture helpers are never executed.
- Preserve red-on-old-source behavior, prove no implicit historical path fallback, then run the unweakened audit and committed mutation probes.
- Source review covers the exact local copy changes; no native model or live Stop result is implied.

## Transfer to main

Recovered on 2026-11-13 from `acceptance-ru46-rest-reserved-ids` at `0dcf219ef5ad7c7ef73e079a26a4bf686f8c5090`. This transfers the recorded finding only. Historical verification and approval apply to the named source and run; no implementation, current reproduction or acceptance is implied. Next step: compare the finding with current source and accepted work, then prioritize or merge an established duplicate. Previous active status is not carried into this metadata transfer.

## Deferred

- **Deferred:** 2026-11-13
- **Reason:** The inherited experimental pilot target is absent from current HEAD. Historical commit 7526d8fb is not an ancestor of HEAD, so a repair in that other branch does not prove delivery and there is no current experimental copy to edit.
- **Return condition:** The owner again selects the inherited experimental pilot as a delivery target and its exact source/copy becomes available; then re-establish the six path findings and preserve the original pure-guard/no-native acceptance scope.

## Audit disposition, 2026-11-13

Keep deferred. The owner has not rejected the task; absence of the target does not mean implemented or closed. Archiving would require a separate explicit owner decision.
