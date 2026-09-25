# PB-257 · Minor batch: reference and stub drift — stop in the command list, done's unknown reason, the doubled version read, the stub's startedAt

- **Scope:** [03-cli](../../reference/03-cli.md), [02-host](../../reference/02-host.md), `lib/done.js`, `test/cli.test.mjs`, `test/promptobus-done.test.mjs`, `test/harness.mjs`
- **Created:** 2026-09-26
- **Dependencies:** none
- **Cost:** minor
- **Previous order:** 260
- **Taken:** 2026-09-26

## Context

Four minor entries in which the reference or the Claude stub disagrees with the code or with the live binary. Each is a sentence or a line, and none needs a paid turn.

## Work to do

- [PB-251.1](../minor/PB-251.1-reference-cli-commands-list-omits-stop.md) — 03-cli's `Commands:` list names 15 commands and omits `stop`, while it calls itself the whole vocabulary (`docs/reference/03-cli.md:3`; `lib/cli.js:314` `case 'stop':`).
- [PB-239.3](../minor/PB-239.3-done-leaves-worktree-unknown-without-reason.md) — `done` leaves a worktree saying "participant session is unknown" without the reason that `sweep` and `stop` already print (`lib/done.js:141`).
- [PB-245.4](../minor/PB-245.4-doubled-version-read-bound.md) — 02-host names the preflight read, the lift-time read and the 5 s ceiling, but not their sum: a hung `claude --version` can hold a routed lift up to 2 × 5 s.
- [PB-245.2](../minor/PB-245.2-claude-stub-startedat-iso-vs-live-epoch.md) — the stub claude writes `startedAt` as an ISO string (`test/harness.mjs:442`), while claude 2.1.280 writes epoch milliseconds.

## Out of scope

- 03-cli § Codex availability and § ownership; 02-host § Session identity and the host API table — other pieces edit them.

## Verification

- Each entry's own evidence re-checked on the tree, closed with `archive N.k --into 257` and one outcome line per entry in this card's `result.md`; gates green.
