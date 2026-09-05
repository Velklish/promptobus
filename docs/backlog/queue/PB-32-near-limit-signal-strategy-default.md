# PB-32 · Near-limit signal in models and the strategy default kept in the workspace overlay

- **Order:** 100
- **Scope:** `lib/models.js`, `lib/model-routing/{render,catalog}.js`, `lib/spawn.js`, `schemas/model-routing/overlay.schema.json`, `skills/orchestrate/SKILL.md`, [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06
- **Dependencies:** PB-25 (the writable layer), PB-30 (pace)

## Context

The owner wants the agent that runs a task to notice when a subscription window is running short and to **propose** a more economical strategy, and that proposal — once the person agrees — to hold for the following spawns without repeating a flag. ADR-004 decisions 6 and 7 give this two halves: a `near-limit` signal computed from the snapshot, and `defaults.strategy` in the writable overlay that `spawn` and `review` take when `--strategy` is absent.

## Work to do

- **Signal**: `models` (text and `--json`) prints a `near-limit` warning per harness whose binding window's `usedPercent` is at or past the threshold (`nearLimit.usedPercent`, default 80, an overlay key) or whose underspend is below `nearLimit.underspend` (default −0.15, i.e. 15 points ahead of pace); the warning names the window, the reset time and the strategy it would switch to — `economy` when every paced harness is past the threshold, `balance` otherwise (ADR-004); no line when the proposed strategy is already the effective one. Exhausted harnesses are already reported and are not repeated as near-limit.
- **`models strategy`**: without arguments prints the effective default and where it comes from (the layer); `--set <strategy>` writes `defaults.strategy` into the writable layer (PB-25), creating the file with `schemaVersion` when absent and keeping every other key; `--clear` removes it. Writes are atomic (temp file and rename), mode `0600`, and refuse when no layer is writable.
- **Default**: `spawn` and `review` with no `--strategy` read `defaults.strategy` from the merged overlays (scalars: the highest layer that names one wins; `auto` is not a value); when set, they route with it and the decision's `metadata.routing` says `strategySource: "overlay:<layer>"`; when absent, the legacy path is unchanged. `--strategy` on the command line always wins. The one-time answered question (Cursor plan name, PB-27) lives under `account: { "<harness>": { plan } }` in the **user** overlay and has **no writer** (ADR-004): `models` prints the key, the value and the layer path, and a person or agent adds the line; the value is display only and enters no score.
- **Rubric**: `skills/orchestrate/SKILL.md` gains the rule — a `near-limit` line in `models` means the orchestrator proposes the switch to the person and, on agreement, runs `models strategy --set`; it never switches silently; `solo-review` follows the same default for the reviewer.
- Reference: the keys, the command, the source precedence (flag → overlay default → none).

## Out of scope

- Consumer skills (the first consumer adds its own policy on top of the rubric).
- Any automatic change of strategy without the person.

## Verification

- `npm test`: threshold from the default and from an overlay; the strategy the warning names; `models strategy --set` writes only that key and keeps the rest; `spawn --dry-run` without `--strategy` routes with the overlay default and reports the source; with no default it takes the legacy path; refusal when no layer is writable.
- Mutation probe after commit: flag no longer wins over the default → the precedence test fails.
- `npm run audit`, `backslop lint`.
