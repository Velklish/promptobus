# PB-14.1 · Nothing in the CLI reference says its § Model routing is machine-read

- **Scope:** [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-05
- **Dependencies:** none

## Context

`test/model-routing.test.mjs` reads `docs/reference/03-cli.md` as data. `docSection` slices the file between four exact headings — `### Reason codes`, `### Exclusion, adjustment and warning codes`, `### Error codes`, `### Files` — and `tableCodes` then reads every table row inside a slice as a declared code, comparing the result to the schema enums. Nothing in the document itself says so.

An editor who adds a `###` heading between those four, or renames one, feeds their own tables into a code list. PB-14 met this while writing its section and placed it after `### Files` for that reason; PB-15…PB-21 will each add prose to the same section.

The original scope of this entry — the preamble claiming the whole section was unimplemented — was fixed inside PB-14 after review, so only this is left.

**The payoff is small and it should be weighed before queueing.** The failure is loud, not silent: the suite goes red with `a code table came back empty — the headings moved`, which points at the cause in its own words. What a note would save is one confused run, not a wrong document.

Evidence, at commit `ddd697d`: `grep -n "docSection('" test/model-routing.test.mjs` gives ten calls naming those four headings, at lines 135-139, 151-157 and 276; `grep -n "^###" docs/reference/03-cli.md` gives the headings themselves.

## Work to do

- Decide whether the note is worth its noise. If it is, one sentence where an editor looks — the end of the § Model routing preamble is the only place a person reads before editing the section.
- If it is not, close this as rejected rather than leaving it: the reasoning above is the whole of what a later reader would need.

## Out of scope

- The slicing itself. It is what makes "the list is written once" mechanical, and it works.

## Verification

- `npm test` stays green, and a heading added inside the sliced range still reddens `test/model-routing.test.mjs` — a note must not become a reason to loosen the check.
