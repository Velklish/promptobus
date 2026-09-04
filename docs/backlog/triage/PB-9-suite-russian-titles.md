# PB-9 · Suite check titles and comments are still Russian in an English package

- **Scope:** [README](../../reference/README.md)
- **Created:** 2026-09-05
- **Dependencies:** none

## Context

Noted while the package output was being translated: the suite's `check()` titles and inline comments are still Russian, while the package, its docs and its output are English. A contributor reading a red verdict gets it in a language the project does not otherwise speak.

## Work to do

- Translate `check()` titles and comments in `test/` to English; keep the verdict count and names one-to-one so history stays searchable.
- Fixtures that stand in for a human stay as they are; fixtures that stand in for mechanism output follow the output.

## Out of scope

- Nothing named yet.

## Verification

- No Cyrillic in `test/**` outside fixtures that model human input; the verdict count is unchanged.
