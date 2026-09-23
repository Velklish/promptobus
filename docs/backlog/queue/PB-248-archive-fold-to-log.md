# PB-248 · The archive folds into docs/archive/LOG.md in full

- **Order:** 590
- **Scope:** `docs/archive/`, [guides/contributing](../../guides/contributing.md)
- **Created:** 2026-09-23
- **Dependencies:** PB-247 — `fold` and the log gate arrive with v0.10.0

## Context

v0.10.0 folds a closed task into a log line: `fold` removes `docs/archive/<id>-<slug>/`, appends a line to `docs/archive/LOG.md` and moves incoming links to its anchor; the body stays in git history and `show N` prints it. Without a number, `fold` folds the accumulated archive and checks every body with `git cat-file` before removing it. The v0.10.0 migration only creates the empty log — folding is the owner's move.

The owner's decision of 2026-09-23: fold the whole accumulated archive in this run, as a piece of its own. On 2026-09-23 the archive holds 309 closed tasks.

## Work to do

- `fold` without a number on the tree after PB-247; links to folded tasks anywhere in the repository move to `LOG.md` anchors.
- Align `docs/archive/README.md` and any text describing the archive as directories with the new record form.

## Out of scope

- Tasks closed after this piece's base.

## Verification

- Gates, including `lint`'s log gate.
- The log has one line per folded directory; `show N` prints the body for five numbers from different periods.
- No link to a removed directory remains.
