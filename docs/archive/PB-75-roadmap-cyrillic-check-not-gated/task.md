# PB-75 · ROADMAP goal 5's English-output claim is verified by a hand-run grep, and audit-public.mjs already has the exact two-surface scanning machinery to gate it instead

- **Scope:** [reference/README](../../reference/README.md), docs/ROADMAP.md, scripts/audit-public.mjs, docs/guides/contributing.md, .github/workflows/ci.yml
- **Created:** 2026-09-06
- **Dependencies:** PB-72
- **Taken:** 2026-09-10

## Context

docs/ROADMAP.md:11 states goal 5, English runtime output, with its evidence as a command a person is expected to run by hand: grep -rlP '[Cyrillic-range]' bin/ lib/ src/ schemas/ templates/ reports only src/protocol.ts's Cyrillic-to-Latin transliteration table and templates/bus-hook.mjs's address-prefix regex, calling both functional data, not output text. Re-ran it today with the equivalent grep -rl over the same directories: it still returns exactly those two files, so the claim currently holds - but nothing besides a person choosing to run it keeps it true. This has already gone stale once. docs/archive/PB-11.1-roadmap-english-goal-evidence-stale/task.md (closed by commit 8a13ac8, 2026-09-05) found the same evidence line citing lib/cli.js as still carrying Russian - already false by the time PB-11 noticed it. PB-11.1's result re-ran the grep by hand and rewrote the line; nothing about how the claim is checked changed, so it can go stale the same way again. scripts/audit-public.mjs (101 lines) is a publicity gate run in CI (.github/workflows/ci.yml:51-52, step Publicity audit running npm run audit). It already has the shape this needs: a FORBIDDEN array of [label, needle] pairs (scripts/audit-public.mjs:20-27) scanned through one scan() helper (line 32) over two surfaces - every git-tracked text file (lines 35-41) and every file inside the packed npm tarball after a real npm run build plus npm pack (lines 76-92). The file's own header (lines 4-7) explains why the second surface matters: dist/ is built, not committed, so a leak compiled out of a clean source tree is invisible to a git-only check - exactly the gap a Cyrillic literal could exploit today. Searched the whole script, package.json's scripts, and .github/workflows/ci.yml for any existing Cyrillic-range check: none exists yet.

## Work to do

- Add a third check to scripts/audit-public.mjs: a Cyrillic regex run through the same tracked-files and tarball loops the script already has, with a two-entry allowlist (src/protocol.ts, templates/bus-hook.mjs) and a one-line comment beside each entry naming why it is exempt (transliteration table; bilingual address-prefix regex).
- On a hit outside the allowlist, push a failure naming the file into the same failures array the other checks use, so it reports and exits 1 the same way as every existing finding.
- Update docs/ROADMAP.md:11's evidence line to say the check runs in npm run audit / CI, rather than describing a command a reader must run themselves.
- Add one sentence to docs/guides/contributing.md, beside its existing English is the language of new strings line, that npm run audit enforces it.

## Out of scope

- Translating any existing text - the allowlist covers the two known functional-data exceptions; a new occurrence the gate finds is triaged (allowlist if functional data, translate if output text) as its own later change.
- Extending the check to test/ or schemas/v1/*.json, which PB-9 and PB-12.1 already track as their own remaining Russian; this only gates the roadmap's claim about bin/, lib/, src/, schemas/, templates/.

## Verification

- npm run audit fails when a Cyrillic literal is added to a file outside the allowlist (e.g. lib/models.js), naming that file, and exits 0 clean on the current tree.
- npm run audit still passes with src/protocol.ts and templates/bus-hook.mjs unchanged.

## Triage — 2026-09-07

- **Track:** Q — Verification, shared execution and documentation.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `scripts/audit-public.mjs:20`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Scope the runtime-language scan to the declared shipped runtime directories, not all Markdown and not README.ru.md. Functional Cyrillic data needs narrow literal exemptions; allowing a whole source file would also hide new output strings in it.
