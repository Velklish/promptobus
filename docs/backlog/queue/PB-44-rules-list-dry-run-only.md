# PB-44 · Spawn and review print the rules list only under --dry-run, so the orchestrator's mandated check against a participant's first status has nothing printed to compare on a real lift

- **Order:** 970
- **Scope:** [reference/03-cli](../../reference/03-cli.md) (Spawn, Review), `lib/spawn.js`, `lib/review.js`
- **Created:** 2026-09-06
- **Dependencies:** PB-121

## Context

`lib/spawn.js:1188-1189` prints `worker rules:` and loops `plan.rules` — but only inside the `if (opts.dryRun)` branch, opened at `lib/spawn.js:1164` and returning at `lib/spawn.js:1199`. The real lift never reaches that branch, and the code says so at its own next appearance: `lib/spawn.js:1216-1219` reads `// There is no rules list on the real run: the set the participant is lifted with is announced by these two lines` followed by `sayModule(plan); sayMcp(plan);`. `sayModule` (`lib/spawn.js:904-906`) prints `plan.module.text`, one sentence about the module — never a file list. `lib/review.js` mirrors this exactly: `reviewer rules:` at `lib/review.js:584-585` sits inside `if (opts.dryRun)` opened at `lib/review.js:569`. The participant record written after a real spawn (`lib/spawn.js:1270-1291`) carries harness, repo, worktree, branch, model, routing, name and `started`, but no rules field, and only the brief is kept to disk (`keepBrief`, `lib/spawn.js:1147-1149`) — the prompt itself is not. So nothing on disk or in the terminal after a real lift reproduces the list.

The consumer of that output is a mandated step in consumer-cli: `skills/workspace-orchestrate/SKILL.md:137` reads "Первый `status` участника сверь с перечнем правил, который напечатал его spawn" (`consumer finding 187`), and `docs/reference/03-rules-protocol.md:21` repeats the same premise — "сверка перечня из первого `status` с тем, что напечатал spawn". `docs/archive/consumer finding 187-participant-rules-unverified/result.md:7` records the decision this step was built on: a cheap, code-free comparison against "перечнем правил, который напечатал его спавн". That premise no longer holds on a real run — only on `--dry-run`, which orchestration never uses to lift a participant.

What the orchestrator does today: hold the dry-run-only list in memory from nowhere (it was never printed) and eyeball the participant's first `status` reply against it — a comparison against a blank. What the code does instead: prints two summary lines (`sayModule`, `sayMcp`) that name the module and MCP servers, not the rules files.

## Work to do

- Move the `worker rules:` print (`lib/spawn.js:1188-1189`) out of the `if (opts.dryRun)` guard so it also runs on the real lift, next to `sayModule(plan); sayMcp(plan);` at `lib/spawn.js:1218-1219`.
- Do the same for `reviewer rules:` in `lib/review.js:584-585`, next to its real-lift `sayModule`/`sayMcp` pair.
- Update `docs/reference/03-cli.md` (Spawn, Review sections) to say the lift names the rules files it hands the participant, not only `--dry-run` does.
- Flag to the consumer-cli owner as a fork, not a silent fix: the two-line summary at `lib/spawn.js:1216-1219` was a deliberate compaction of dry-run output. Either restore the print here, or correct `skills/workspace-orchestrate/SKILL.md:137` and `docs/reference/03-rules-protocol.md:21` to stop citing a list spawn does not produce on a real run and name what the orchestrator actually has to compare against instead.

## Out of scope

- Machine-readable variants — rules recorded in the participant's `metadata`, a fixed-form block required in the participant's first reply, or a diff surfaced by `promptobus status`. Each would constrain the participant's free-text answer, which is exactly the non-determinism `consumer finding 187` rejected when it chose the cheap comparison over a canary participant in `smoke`. Restoring the existing print is enough.

## Verification

- `promptobus spawn --repo <path> --brief <file> --dry-run` and a real `promptobus spawn` on the same repo print an identical `worker rules:` block with the same file list; today only the dry-run one does.
- Same check for `promptobus review <path> --dry-run` vs. a real `promptobus review`.

## Triage — 2026-09-07

- **Track:** L — Spawn, review and command guidance.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/spawn.js:1188`, `lib/review.js:584`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
