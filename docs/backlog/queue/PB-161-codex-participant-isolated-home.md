# PB-161 · Codex participant runs in an isolated CODEX_HOME: owner auth copied, mechanism-only MCP, worktree trusted, workspace skills copied into the worktree

- **Order:** 5
- **Scope:** `lib/driver-codex.js` (`SESSION_ENV_DROP`, `mcpConfig`, `capabilities.skillsDir`, lift and done), `lib/codex-session.js` (the `thread/start` config the holder passes), `docs/adr/` (a new ADR), [03-cli](../../reference/03-cli.md) § Codex participant, `test/promptobus-driver-codex.test.mjs`, `test/harness-codex.mjs`
- **Created:** 2026-09-11
- **Dependencies:** none

## Context

Owner decision of 2026-09-11 (harness-parity run): the Codex participant is isolated through `CODEX_HOME` with the owner's auth copied in. The consumer's ADR-037 (ati-agents) had rejected the move because it takes auth away and offered no alternative; the spike ati-agents BL-639 (2026-09-11, codex-cli 0.146.0, no paid turn) measured the missing half: an isolated `CODEX_HOME` holding a copy of `auth.json` (mode 0600) answers `codex login status` with `Logged in using ChatGPT`; an empty home lifts no personal MCP server; `[projects]` records and the marketplace snapshot land in the isolated home, not in the owner's; the only channel the move does not isolate is `~/.agents/skills` — it is bound to `HOME`, not to `CODEX_HOME` (BL-639.1), and the owner accepted that as the boundary (those are the workspace's canonical skills). Codex reads `<cwd>/.codex/skills` always, even for an untrusted directory, and `<cwd>/.codex/config.toml` and `<cwd>/.codex/agents` only when the directory is trusted in the home's config: `[projects."<realpath>"] trust_level = "trusted"`; there is no CLI command for trust, the record is written to the file.

Today the driver drops `CODEX_HOME` from the session environment (`SESSION_ENV_DROP`, `lib/driver-codex.js:54`), so the holder works in the owner's `~/.codex`: every `thread/start` lifts the owner's personal MCP set beside the mechanism's prefixed entries, each run adds a `[projects]` record for the worktree to the owner's `config.toml`, and the participant gets no workspace skills at all (`skillsDir: false`, line 660; no `skillsNote`, unlike Cursor after BL-482). The consumer's `sync` now lays `.codex/skills` at the workspace root (ati-agents BL-641, 2026-09-11), so a copy into the participant's worktree has a source.

## Work to do

- Per participant, before the lift: a home directory (`$TMPDIR`, mode 0700, named by task and address) with a copy of the owner's `auth.json` (0600), a `config.toml` carrying only the mechanism's `[mcp_servers]` entries (the same entries and `disabled_tools` the holder passes today) and `[projects."<realpath of the worktree>"] trust_level = "trusted"`; `CODEX_HOME` set for the app-server process; the home removed on `done` and on a failed lift. The owner's `~/.codex` is never written: no `[projects]` record, no marketplace refresh in it.
- Skills: copy `<workspace root>/.codex/skills` into the worktree's `.codex/skills` before the lift, the way the Cursor driver copies `.cursor/skills` (BL-482 in the consumer); a `skillsNote` when the render is absent; decide and record what happens to the copy at `done` (removed with the worktree; keep the worktree diff clean of it); `capabilities.skillsDir` says the truth.
- A new ADR: what the isolated home contains, what is copied (auth), what stays shared and why (`HOME`-bound skills), cleanup and the lift-failure path; it supersedes the consumer's ADR-037 rejection.
- Tests without a turn: home layout, config contents, the trust key as a resolved path, auth mode, cleanup on `done` and on a failed lift; the harness stub; [03-cli](../../reference/03-cli.md); CHANGELOG.

## Out of scope

- Whether `disabled_tools` withholds a tool from the model — PB-87.3.
- Command approvals and non-approval requests of the holder — PB-88.3, PB-88.4.
- Windows — PB-164.

## Verification

- A participant lifted on this workspace without a paid turn: `codex login status` inside its home reports logged in; the owner's `config.toml` has the same number of `[projects]` sections before and after; the worktree carries `.codex/skills`; `done` leaves no home behind.
- `npm test`, `npx github:Velklish/backslop#v0.4.0 lint`, `npm run audit` green.
