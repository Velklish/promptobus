# PB-62 · `models calibrate --write` asks for agreement before it prints the proposal, and its non-interactive refusal is gated on whether anything moved

- **Scope:** `lib/models.js` (`calibrateCommand`), [ADR-005](../../adr/adr-005-ten-point-scale-absolute-bands-calibrate.md) § `models calibrate`, [02-host](../../reference/02-host.md) § The writable layer, [03-cli](../../reference/03-cli.md) § Commands
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Current tree, promptobus v0.5.0, HEAD cc1aca8. `lib/models.js:722-733` carries two defects in one block:

    const layer = write ? userLayer(host) : null;
    let agreed = !write || Boolean(yes);
    if (write && !yes && moved) {
      if (!stdin?.isTTY) { throw new GateError('models calibrate --write: stdin is not a terminal, …'); }
      const answer = await ask(`merge ${moved} rating override(s) into overlay "${layer.id}" (${layer.path})? [y/N] `);
      ...
    }

The proposal is printed only afterward, at `lib/models.js:771-772` (`info('telemetry file: …')`, `emit(output, renderCalibration(report))`), which runs after the merge block at lines 740-752.

**Ordering.** Probe (fixture telemetry, `write: true`, `stdin.isTTY: true`, no `--yes`) recorded the interleaving of `ask` and `output.write`:

    ASK  merge 2 rating override(s) into overlay "user" (…/model-routing.json)? [y/N]
    OUT  telemetry: 32 record(s) over 6 key(s); evidence threshold 5 run(s) …

A person agrees to a bare count before seeing which tuples move, from which band to which, or against which pivot — those print only after the overlay is already on disk.

**Gating.** Second probe: two telemetry records only (`report.ratings` empty, `moved === 0`), `write: true`, `stdin.isTTY: false`, no `yes` — exit 0, no refusal, nothing written. The refusal is data-dependent on `moved`, which contradicts docs/reference/02-host.md:59 ("only after the person agreed to the exact lines it printed"), docs/adr/adr-005-…:173 ("Without a TTY the command refuses unless `--yes` is also present") and :175 ("only after confirmation"), and docs/reference/03-cli.md:100 ("The command asks on the terminal first … without a terminal it refuses unless `--yes`") — none of these state a `moved` condition.

The suite does not catch either half, all green at 35/35 with the defect in place: the interactive test `--write on a terminal asks, and a no writes nothing` (line 409) asserts only the question text, never the order relative to output; the refusal test `--write without a terminal and without --yes refuses, and leaves no file` (line 396) always runs against the full fixture where two ratings move; the nothing-to-write test `--write with nothing to write creates no file and says so` (line 478) always passes `yes: true`, so `--write` + non-TTY + no-`--yes` + nothing-moved is never exercised.

## Work to do

- Hoist the two text-path print lines (`info('telemetry file: …')`, `emit(output, renderCalibration(report))`) above the confirmation block, guarded by `!json` so the `--json` early return (line ~759) keeps producing the single document on stdout and every refusal still precedes it — the two existing `--json` tests ('a refused write prints nothing at all…', line 593, and 'a declined write still prints the report…', line 609) must stay green.
- Add a test that records the interleaving of `output.write` and `ask`, and reddens if `ask` fires before the proposal is printed.
- Owner's fork on the gating half: either lift the TTY check out of the `moved` guard so `--write` without `--yes` and without a terminal always refuses — matching adr-005:173 and 03-cli.md:100 as written — or keep today's behaviour and write the `moved` exception explicitly into ADR-005 § `models calibrate` and 03-cli.md § commands.
- Whichever way, add a test pinning the chosen rule for `--write` + non-TTY + no-`--yes` + nothing eligible to move.

## Out of scope

- The `--json` path's own ordering — refusals there already precede the single stdout document, and this entry does not touch `--json`.
- The wording of the confirmation prompt or the evidence threshold (5 runs) itself.

## Verification

- New ordering test in test/model-routing-calibrate.test.mjs asserting the proposal prints before the confirmation is asked; `npm test` green, including the two `--json` tests at lines 593 and 609.
- New test for `--write` + non-TTY + no-`--yes` + nothing eligible to move, asserting whichever rule (b) settles on.
- Manual: `promptobus models calibrate --write` on fixture telemetry with a TTY shows the full proposal before the confirmation question.
