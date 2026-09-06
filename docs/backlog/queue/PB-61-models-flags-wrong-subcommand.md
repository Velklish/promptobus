# PB-61 · `models` accepts `--set`, `--clear`, `--write` and `--yes` outside the subcommands that own them and silently ignores all four

- **Order:** 860
- **Scope:** `lib/models.js` (`models`), `lib/cli.js` (the `models` case), [03-cli](../../reference/03-cli.md) § Commands
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Current tree, promptobus v0.5.0, HEAD cc1aca8. `lib/cli.js:228-256` declares `set`, `clear`, `write` and `yes` at the top level of the `models` case and forwards them to `models()` unconditionally, alongside `subcommand: positionals[0]`. `lib/models.js:895-912` dispatches purely on `subcommand`:

    if (clearHarness) return clearCommand(host, clearHarness);
    if (subcommand === 'validate') return validateCommand(host, { catalogFile, now });
    if (subcommand === 'calibrate') { return calibrateCommand(host, { json, write, yes, ... }); }
    if (subcommand === 'strategy') { return strategyCommand(host, { set: setStrategy, clear: clearStrategy, ... }); }
    if (subcommand) {
      throw new GateError(`models: unknown subcommand "${subcommand}" — ...`);
    }

When `subcommand` is absent, execution falls straight through this block to the routing-decision print, without ever inspecting `set`, `clear`, `write` or `yes`. Probe on a scratch workspace declaring three harnesses (HOME diverted): `promptobus models --set economy` exits 0, prints the routing decision with `overlays: user (absent) · workspace (absent)`, and writes no overlay; `--clear`, `--write` and `--yes` each behave identically — exit 0, same first line, nothing written.

The usage text (`lib/cli.js:59-63`) and docs/reference/03-cli.md:67-72 pair `--set`/`--clear` only with `strategy` and `--write`/`--yes` only with `calibrate`; nothing enforces that pairing. The principle is already stated one level down: `lib/models.js:699-702` refuses `models calibrate --yes` without `--write` with the explicit reasoning "silently ignoring it would let `calibrate --yes` read as 'applied' in a script that lost its `--write`", and docs/reference/03-cli.md:100 documents that refusal — the same rule was simply never applied at the subcommand boundary, one level up.

## Work to do

- In `models()` (lib/models.js), before the fall-through at line ~913, raise a `GateError` when `set` or `clear` is present and `subcommand !== 'strategy'`, and when `write` or `yes` is present and `subcommand !== 'calibrate'` — each naming the correct form (`models strategy --set <s>` / `models calibrate --write`).
- Put the guard inside `models()` rather than in lib/cli.js's parser, so a library caller of `models()` gets the same protection, and it sits beside the existing `--yes`-without-`--write` refusal at lib/models.js:699-702.
- Add the four cases (`--set`, `--clear`, `--write`, `--yes` with no matching subcommand) to test/model-routing-command.test.mjs beside the existing `strategy --set`/`--clear` tests.
- State the rule in docs/reference/03-cli.md next to the sentence that already states it for `--yes`/`--write` (around line 100).

## Out of scope

- `models --clear-exhausted <harness>` — it already has its own dedicated branch (`if (clearHarness) return clearCommand(...)`) and is not part of this defect.
- Any change to what `strategy` or `calibrate` themselves do with these flags.

## Verification

- New tests: `models --set economy` with no subcommand raises a `GateError` naming `models strategy --set`; same pattern for `--clear`, `--write`, `--yes`. `npm test` green.
- Manual: `promptobus models --write` on a scratch workspace now refuses with the message instead of exiting 0 silently.

## Triage — 2026-09-07

- **Track:** R — Routing policy, overlays and availability.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/cli.js:228`, `lib/models.js:895`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
