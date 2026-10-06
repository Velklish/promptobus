# PB-341 · Lift worker sessions through opencode

- **Scope:** [05-drivers](../../reference/05-drivers.md)
- **Created:** 2026-10-06
- **Dependencies:** none
- **Cost:** major
- **Previous order:** 270
- **Taken:** 2026-10-06

## Context

The bus lifts sessions through three harnesses (claude, cursor, codex); opencode has zero mentions in the tree (grep 2026-10-06, excluding node_modules/dist) — no driver, no registry entry, no allow-list slot. Owner order 2026-10-06: opencode becomes a supported harness, model everywhere is muse spark 1.3 contributor; three tasks in order — worker (this), reviewer+approver (PB-342), orchestrator (PB-343).

opencode 2.0.20 headless paths, measured on this host: per-participant `serve` holder
(`--port 0`, port off the holder log, basic auth by generated password) with HTTP API `GET
/api/session`, `POST /api/session`, `POST /api/session/:id/prompt`, `GET .../message?limit=N`,
`DELETE /api/session/:id`; the turn model comes from the config `model` default (create/prompt
model keys are ignored). Config injection without worktree writes: `OPENCODE_CONFIG` env points
at a custom config file, `OPENCODE_CONFIG_DIR` at skills/agents dir (opencode.ai/docs/config).
Auth on this host: provider stored under `opencode auth list` as OpenCode Go.

## Work to do

- `lib/driver-opencode.js`: capabilities spawn/inspect/stop; `prepare` builds argv (`run --format json`, cwd = participant worktree, `-m` model, prompt last) + opencode.json config file (MCP servers) via `OPENCODE_CONFIG` + skills dir via `OPENCODE_CONFIG_DIR`; session record with opencode session id parsed from JSON events; `inspect` off `session list --format json` or process liveness; `stop` kills the run and deletes the session; availability probe off `opencode --version` with a minimum version.
- Register in `lib/drivers.js` REGISTRY; name the `tools` allow-list slot in docs.
- Docs in the same pass: `docs/reference/05-drivers.md`, subsystem README if it names the harness set, CHANGELOG.
- Tests: prepare/argv unit checks plus availability fixture that goes red without the driver entry.

## Out of scope

- Reviewer lift and approverLift — PB-342.
- Orchestrator/teamlead through opencode — PB-343.
- npm publication, Windows, changes to claude/cursor/codex drivers.

## Verification

- `npx --no-install backslop gates` green; `npm run probe` on the new checks (commit first).
- `prepare` dry-run print for a worker lift.
- One live worker lift through opencode end to end (spends model limits once).
