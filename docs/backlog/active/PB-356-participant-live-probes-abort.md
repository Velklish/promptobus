# PB-356 · Own participant live scenarios and clean aborted e2e runs

- **Scope:** [03. CLI](../../reference/03-cli.md), scripts/live-e2e.mjs, scripts/live-cursor.mjs, scripts/live-codex.mjs, scripts/live-mixed.mjs, test/scenario.mjs
- **Created:** 2026-10-03
- **Dependencies:** none
- **Cost:** major
- **Previous order:** 600
- **Taken:** 2026-10-03

## Context

Imported from the workspace mechanism consumer's tracker, audited 2026-09-06 and accepted by its owner 2026-09-12. The participant live scenarios belong to this package; the consumer retains its own layout canary, e2e wrapper and run cleanup helper. This is the package side of the transfer. The consumer must not delete its wrappers until the package side is verified and available to it.

At main bab39b1 on 2026-10-03, scripts/live-cursor.mjs, live-codex.mjs and live-mixed.mjs already exist. Cursor registry routing uses cursorStateHome at live-cursor.mjs:112. However rg onAbort scripts/live-e2e.mjs has no match, and test/scenario.mjs:470 still contains the fixed e2ebus-t20260901-000000 task identifier. A failed run can leave registered sessions which a later run confuses with its own.

## Work to do

- Verify the existing package participant scenarios as the receiving side, preserving standalone imports, package prefixes and the Cursor state-home route; close any measured transfer gap in these files.
- Add cleanup on handled abort signals to live-e2e, distinguishing owned sessions/processes from unrelated sessions. Preserve unknown or surviving processes and avoid deleting their sandbox prematurely. SIGKILL cannot be handled: the next run must not confuse its task/session identity with the previous one.
- Replace the fixed task identifier with the package's canonical fresh identity; make the visible participant task title distinguish consecutive live runs where registry discovery needs it.
- Cover abort wiring, interrupted run followed by a new run, unique identity and unchanged Cursor routing with focused tests and meaningful harmful/equivalent probes. Update package docs and CHANGELOG, following the public-surface rule.

## Out of scope

- Consumer repository changes, deletion of consumer scripts, a package release/tag or a dependency pin.
- Unrelated driver changes and new credentials or login in an owner's home.
- Live Cursor account runs: the owner performs them; live Claude is unavailable until the owner authenticates. Do not present skipped native runs as a pass.

## Verification

- All five gates in backslop.json, with actual codes and no skipped gate counted as green; fresh dependencies and generated tracker adapters are installed before dispatch.
- Independent owned Node fixtures prove abort cleanup and isolation; harmful changes are red, equivalent changes green and all mutations restored after a committed checkpoint.
- Package scripts do not import consumer code. The fixed task id is gone, consecutive identities/titles differ as required, Cursor still uses its state-home route.
- Report the exact scope and remaining live checks; consumer deletion remains a later phase after package acceptance and delivery.
