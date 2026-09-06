# PB-72 · contributing.md has drifted from backslop.json and the shipped code on five points: a stale v0.3.0 pin sentence, one gate named where two exist, a landed publicity gate still called future work, "Four rules" where there are five, and an English-only rule with no gate and violations in scripts/ and test/

- **Order:** 580
- **Scope:** `docs/guides/contributing.md`, `backslop.json`, `scripts/audit-public.mjs`, `docs/ROADMAP.md`
- **Created:** 2026-09-06
- **Dependencies:** PB-71

## Context

Five sentences in docs/guides/contributing.md restate facts that live elsewhere and have drifted from them, re-verified just now:

1. Line 3: "This repository is run entirely through [backslop](https://github.com/Velklish/backslop) `v0.3.0`." — backslop.json:8 pins `"version": "0.4.0"`, and the fenced command block two lines below it (contributing.md:5-8) already uses `#v0.4.0`. Commit 264522b ("backslop v0.4.0: the contributing guide names the current pin") updated every fenced command but missed this one prose sentence.
2. Line 31: "Commands in `backslop.json` `gates` must exit 0. Today that is `npx github:Velklish/backslop#v0.4.0 lint`." — `gates` in backslop.json:5-8 holds two entries (`… lint` and `npm run audit`, package.json:24); the guide still names only one.
3. Line 79: "See the publicity checks in the project gates when they land." — they landed: `npm run audit` → scripts/audit-public.mjs is already a `gates` entry, confirmed running (`node scripts/audit-public.mjs` exits 0, "publicity audit: clean", against 438 tracked files and a 117-entry tarball).
4. Line 61: "Four rules keep a run from reading or touching anything but itself." followed by five bolded rules (lines 63, 65, 67, 69, 73: sweep list, home diversion, machine-wide reads, PATH seal, no process left behind) — counted directly, five.
5. Line 10: "English is the language of new strings, comments, commit messages, and checks. `README.ru.md` is the only file that may use Cyrillic." — contradicted by live Cyrillic in scripts/live-mixed.mjs, scripts/live-cursor.mjs, scripts/live-codex.mjs (`grep -rlP '[\x{0400}-\x{04FF}]' scripts/*.mjs` lists all three) and 60 files under test/. docs/ROADMAP.md:11's own sweep evidence is scoped to `bin/ lib/ src/ schemas/ templates/` and explicitly excludes `scripts/` and `test/`; scripts/audit-public.mjs has no Cyrillic check. So nothing enforces the rule as the guide states it.

No existing backlog or archive entry covers any of these five (`grep -rln "contributing.md\|Four rules\|Five rules" docs/backlog docs/archive` only turns up unrelated archived results that happen to quote the guide).

## Work to do

- Fix all five in one pass, since they share one root cause — the guide restates facts that live in backslop.json / package.json / ROADMAP.md and drifts when those change.
- Line 3 — drop the version number from the prose sentence ("run entirely through backslop; the pin is `backslop.json`") instead of hard-coding a second copy of it.
- Line 31 — say "the commands in `backslop.json` `gates`" without enumerating, or list both current entries explicitly.
- Line 79 — replace "when they land" with a one-line description of what `npm run audit` actually checks (the FORBIDDEN-string and file-leak sweep in scripts/audit-public.mjs).
- Line 61 — "Four rules" → "Five rules".
- Line 10 — either scope the English-only rule to the directories docs/ROADMAP.md:11 actually sweeps (`bin/`, `lib/`, `src/`, `schemas/`, `templates/`) and say `scripts/` and `test/` are exempt today, or extend `npm run audit` with the same Cyrillic sweep over `scripts/` and translate the three live-*.mjs scripts. State which was chosen.

## Out of scope

- Actually translating scripts/live-mixed.mjs, live-cursor.mjs, live-codex.mjs, or the 60 Cyrillic-carrying test files — that is the larger option under point 5 and a separate, sizeable pass if chosen.
- A mechanism that derives the gate list or version references in contributing.md from backslop.json automatically so the file can't drift again — worth naming as a follow-up, not building here.

## Verification

- `grep -n 'v0.3.0' docs/guides/contributing.md` returns nothing.
- The gates sentence (around line 31) names or implies both `lint` and `npm run audit`, not `lint` alone.
- `grep -n 'when they land' docs/guides/contributing.md` returns nothing.
- The Suite isolation section (around line 61) says "Five rules", matching the five bolded rules that follow it.
- `npx github:Velklish/backslop#v0.4.0 lint` stays green (docs-only change).

## Triage — 2026-09-07

- **Track:** Q — Verification, shared execution and documentation.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including the files named in Scope and the current repository configuration. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
