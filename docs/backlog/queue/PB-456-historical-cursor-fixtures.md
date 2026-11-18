# PB-456 · Classify two historical Cursor fixture failures

- **Order:** 790
- **Scope:** [Fixture isolation](../../reference/README.md)
- **Created:** 2026-11-18
- **Dependencies:** none
- **Cost:** major (hypothesis)

## Work to do

- [PB-278.1 · promptobus-mixed step 7 goes red when the warden's deliveredAt is stamped by the round the worker's own send triggers](../minor/PB-278.1-mixed-step7-delivered-after-own-send.md).
- [PB-325.1 · Investigate historical Cursor fixture-session loss](../minor/PB-325.1-cursor-test-shared-tmux.md).

## Verification

Check current fixture enablement first. Record event ordering and resolved session identity separately. Passing runs alone cannot classify a historical failure. Record the outcome against each original finding before archiving it.
