# PB-117 · Result

**Closed 2026-09-12** (`PB-130` was merged into it). Done. The Cursor and Codex session registries
became one factory in `lib/harness-registry.js`, the driver helpers moved to `lib/driver-common.js`,
and the shared wake frame to `lib/notification.js`.

**The decision `PB-130` contradicted was taken first, and it held for all four names.** The canonical
body of `writeFileAtomic`, `writeJsonAtomic`, `shellQuote` and `pidAlive` lives in `src`; a new
`lib/` leaf was rejected, because a second body beside the `src → dist` implementation reproduces the
same drift one level down. A `lib/` leaf remains only for logic that has no TypeScript counterpart —
the registry factory and the driver helpers — and that is not a second copy, it is the only home.

**Three words kept apart, and the card says so because conflating them cost two review rounds:**
**body** is one, in `src`; the **route** inside the package is free — `lib` imports from the built
module it needs, not from the public barrel; the **boundary** is a separate decision, taken
deliberately, never as a side effect of a name being needed in `lib`. The export list of all five
entry points in the `exports` map equals `main`.

**Checks.** `npm test` → 0, **63/63 files**. `npm run audit` → 0, clean, 847 tracked files.
`npm run pins` → 0, 847/847. Per file: adapter 70 → **73** (three full-body notification snapshots),
Codex driver 195 → **198**, Cursor driver 122 → **125**, warden 256 → **256**, host 10/10,
spawn 125/125, review 225/225.

Mutation probes, each restored: a declared `HostToolBin` field read from the new leaf reddens the
reader count; an **undeclared** field reddens the field verdict itself (two probes, two different
verdicts); the old anchored regex reddens the `v0.9.0` refusal; disabling the parse refusal reddens
the unparseable-version check.

**Docs in the same pass.** `README`, [01-overview](../../reference/01-overview.md),
[02-host](../../reference/02-host.md), [05-drivers](../../reference/05-drivers.md), `CHANGELOG`.

## What this card cost, and why it is written down

Three defects were introduced by the consolidation itself and caught only by review, never by the
gates:

- **The version parser would have refused every Codex lift.** `HostToolBin.version` carries the raw
  `--version` line — `codex-cli 0.146.0` — and a parse anchored at the start yielded no version, so
  every spawn and review would have been refused as older than the proven release, the more surely
  the newer the binary. The fix then opened the opposite hole: an unanchored parse read `v0.9.0` as
  `9.0` and let an old binary through. The gate now holds both forms, and an unparseable non-empty
  version refuses **in its own words** instead of pretending to have compared.
- **The public boundary widened twice**, each time silently: first `compactStamp`, `filesDir` and
  `historyRoot` through the `.` barrel, then `shellQuote` through `./hooks`. The second slipped past
  a check that compared only one entry point of five.
- **An oracle was edited to match the new code.** The warden's golden tail was rewritten to the
  shared default, so it stopped asserting anything. Two snapshots written from the new branch had the
  same property: green by construction.

**The rule that follows, and it belongs to every consolidation:** oracles and snapshots are not
edited while copies are being merged. A golden that reddens means behaviour changed — that is either
a defect or a decision recorded in the card. There is no third case. Proving "same output" needs a
comparison against the **old** copy, never a snapshot of the new one; the exact command is in the
card.

**Not closed.** Nothing in this card's subject. `PB-189` (live attribution) stays deferred and
`PB-185` stays in the queue; neither is closed by this work.
