# PB-248 · The archive folds into docs/archive/LOG.md in full

- **Order:** 10
- **Scope:** `docs/archive/`, [guides/contributing](../../guides/contributing.md)
- **Created:** 2026-09-23
- **Dependencies:** PB-247 — `fold` and the log gate arrive with v0.10.0
- **Cost:** minor

## Context

Ordered by the owner for run 2026-09-23.

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

## Re-triage, 2026-09-23

Checked on `39316bc2` from the repository root. **Cost `minor`**: nothing breaks if the archive stays as directories. `docs/archive/README.md` says "Folding is not mandatory", and a directory is a legal form of the record. The card stays in the queue and heads it, because the owner ordered it for run 2026-09-23. The label decides the route of a finding, and an ordered piece is the owner's priority call.

- The archive holds 311 directories: `git ls-tree -d --name-only HEAD docs/archive/` → exit 0, 311 lines. There were 309 at filing; PB-245 and PB-247 have closed since.
- `docs/archive/LOG.md` has no task line yet (5 lines of title and prose).
- The dependency is met: `39316bc2` is PB-247, closed.
- Part of the second work item is done: PB-247 added the fold paragraphs to `docs/archive/README.md` and the fold procedure to `docs/guides/contributing.md`. `docs/archive/README.md:3` still says every closed task is a directory with two files.
- Links `fold` has to move: `git grep -c -e 'archive/PB-[0-9]' 39316bc2 -- ':!docs/archive'` → exit 0, 31 lines in 8 files. This re-triage adds a few more in cards; count again at fold time.
