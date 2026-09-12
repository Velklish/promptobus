# PB-172 · Move long comments into the documentation and gate the length of an inline comment

- **Order:** 5
- **Scope:** `lib/**`, `src/**`, `bin/**`, `templates/**`; a new check in the gates;
  [contributing](../../guides/contributing.md)
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

Owner's decision of 2026-09-12, taken after seeing how much comment this code carries:

> Code must be self-documenting, an inline comment longer than two lines is forbidden, and a
> nuance is either not written or moved into the documentation where it is useful there. The
> point is that agents understand it without spending a pile of tokens reading code files.

The rule is recorded in `AGENTS.md` in the same pass. This card is about what is already
written, and about what holds the rule afterwards.

**Measured 2026-09-12 over tracked `lib/*.js`, `src/*.ts`, `bin/*.js`, `templates/*.mjs`:**

```
files with a run longer than two lines: 70 of 74
such runs: 1381, lines in them: 10343
longest:
   76 lines  lib/model-routing/adapter-claude.js:1
   66 lines  lib/model-routing/adapter-cursor.js:1
   45 lines  lib/model-routing/telemetry.js:1
   44 lines  lib/model-routing/calibrate.js:1
   43 lines  lib/model-routing/adapter-codex.js:1
```

A run is consecutive lines beginning with `//`, `*` or `/*`. File headers count, and they are a
large share of the total; they are treated like the rest — what serves a reader goes into the
reference, the remainder goes.

**The cost the rule exists for is measured in tokens.** An agent opening
`lib/model-routing/adapter-claude.js` pays for a 76-line preamble on every read of the file, and
pays again in every new session. Hence order 5, ahead of the rest of the queue.

## Work to do

- **Walk the files and split each long run three ways:** what serves a reader of the
  documentation goes to `docs/reference/`, the affected README, or an ADR; what retells the
  lines below it or the history of the change goes; what names a constraint invisible from the
  code is cut to two lines.
- **Lose nothing silently.** A fact held nowhere else moves into the documentation rather than
  disappearing. A removed paragraph that was the only carrier of a measurement is a loss, not
  tidying.
- **Gate the length.** A check counting consecutive comment lines with a threshold of two.
  Declare any exception explicitly and verifiably if one is needed (licence headers, generated
  files).
- **A red probe on both sides:** a three-line run is red; two single-line comments separated by
  code are green.

## Out of scope

- Comments in `docs/**` and other prose: the rule is about inline comments in code.
- Changing behaviour. This pass is comments and documentation only — mixing it with a change of
  substance leaves a review unable to tell them apart.

## Verification

- The gate is red on a run longer than two lines and green on code without one.
- For every long run that carried a measurement or a constraint, the diff shows where it went.
