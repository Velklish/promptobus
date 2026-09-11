# ADR-007: A Codex participant runs in an isolated CODEX_HOME

**Status:** Accepted
**Date:** 2026-09-11
**Deciders:** Павел Ким (owner), decision of 2026-09-11 on PB-161 of the harness-parity run

## Context

Until this change a Codex participant's `app-server` ran in the owner's `~/.codex`.
The driver dropped `CODEX_HOME` from the session environment and passed the
mechanism's MCP set as a `config.mcp_servers` override on `thread/start`. Three
things followed from that, and all three were measured rather than assumed.

**The owner's personal MCP set was lifted into every participant thread.** The
override merges with the personal config, it does not replace it, so ~25 personal
servers came up beside the mechanism's entries. The mechanism cannot even name them:
`config/read` returns `http_headers` in the clear and is forbidden to the mechanism
client. The reviewer's mechanical write deny (PB-87.1) therefore covered only the
servers the mechanism supplied, and a personal entry under a canonical name carried
the same write tools undenied.

**Every run wrote into the owner's home.** A `[projects]` record for each worktree,
and a marketplace snapshot refresh that rewrites `config.toml` without a turn and
without `exec`.

**The participant got no workspace skills at all.** `options.skillsDir` was false and
there was no note in its place, unlike the Cursor driver, which copies the
`.cursor/skills` canon into the participant worktree.

The consumer's own driver decision had rejected an isolated home because it takes the
account's credentials away and offered no replacement. A no-turn spike on
codex-cli 0.146.0 measured the missing half, and this run re-measured all of it on the
shipped code:

| question | measurement (codex-cli 0.146.0, no model turn) |
|---|---|
| does an isolated home hold the account? | a home with a copy of `auth.json` at mode 0600 answers `codex login status` with `Logged in using ChatGPT`, exit 0; an empty home answers `Not logged in`, exit 1 |
| does it drop the personal MCP set? | an empty home answers `codex mcp list` with `No MCP servers configured yet` |
| are `[mcp_servers]` of the home loaded into a thread? | `initialize` + `thread/start` with no `turn/start`: the mechanism's entry goes `starting` → `ready` on `mcpServer/startupStatus/updated` |
| what opens a project's own `.codex` layer? | a `[projects."<path>"] trust_level = "trusted"` record in the home's `config.toml`; there is no CLI command for it |
| which spelling does that key need? | the realpath. One stand, three runs: the resolved `/private/var/…` spelling lifted the project's own server; the unresolved `/var/…` spelling did not, and stderr said the project is untrusted |
| is anything left in the owner's home? | section by section before and after a worker, a reviewer and a stop: 89 sections both times, `[projects]` 20 both times, the section lists identical, no `sessions/` created |
| what does the home NOT isolate? | `~/.agents/skills` — that root follows `HOME`, not `CODEX_HOME`, so the workspace's canonical skills reach the participant anyway |

The last row is checked section by section on purpose. A file hash is not a usable
gate here: the marketplace snapshot rewrites the owner's `config.toml` on its own
schedule with no turn involved, so a changed hash proves nothing about the mechanism.

## Options

**Decision 1 — where the participant's Codex home lives.**
1A, the owner's `~/.codex`: nothing to build, and every problem above stays.
1B, an isolated home per participant with the owner's `auth.json` copied in: the
personal set, the `[projects]` records and the marketplace snapshot all stop reaching
the owner, at the cost of a credentials copy on disk for the life of the session.
1C, an isolated `HOME` as well: the only thing that also isolates `~/.agents/skills`,
but those are the workspace's canonical skills, which the participant is meant to
have, and a substituted `HOME` changes far more than Codex reads.

**Decision 2 — where the mechanism's MCP entries go.**
2A, keep the `config.mcp_servers` override on `thread/start`. 2B, write them into the
home's `config.toml` and drop the override. 2C, both.

**Decision 3 — which working directory is trusted.**
3A, none: the project's own `.codex/config.toml` and `.codex/agents` never load.
3B, the participant's working directory, for both roles. 3C, the worker's worktree
only.

**Decision 4 — how workspace skills reach the participant.**
4A, nothing, as before. 4B, a copy of the workspace `.codex/skills` canon into the
participant's working directory, the way the Cursor driver copies `.cursor/skills`.

## Decision

**1B.** One `CODEX_HOME` per participant, built before the lift and removed with the
session. It is a directory under `$TMPDIR` at mode 0700, named by task and address, and
it holds exactly three things: a copy of the owner's `auth.json` at mode 0600, the
mechanism's `[mcp_servers]` entries, and the trust record of decision 3. The owner's
home is opened for exactly one read — that credentials file — and is never written.
`sessionEnv` drops an inherited `CODEX_HOME` from the base environment and then honours
the one the lift names, so an ancestor's value can never put a participant back in the
owner's home. The availability probe, which runs before any participant exists, is
pointed at the owner's home deliberately: the account whose limit it reads is the one
every participant home will copy.

1C is rejected for the reason the spike gives: the skills under `~/.agents/skills` are
the workspace's canon, addressed to the participant on purpose. The owner accepted that
root as the boundary of this isolation.

**2B.** The entries live in the home's `config.toml`, and `thread/start` no longer
carries `config.mcp_servers`. The override existed for a collision that the isolated
home removes: it merged with the personal config by FIELDS, not by records, so one name
with two transports killed the whole config load. With no personal set in the home there
is nothing to merge with, and 2C would leave two sources free to drift. The key prefix
stays, because it also does something the home does not replace — the tool name the
model sees is derived from the config key, and moving the key would rename every bus
tool the participant was told about. `ThreadStartParams.config` keeps
`model_reasoning_effort`, which is per-turn rather than per-home.

**3C.** The trust record names the worker's worktree, by its realpath. A reviewer's
working directory is the tree UNDER REVIEW, and trusting it would let the repository
being judged put MCP servers into the session that judges it — measured: a trusted
project's own `.codex/config.toml` server comes up in the thread. For a worker that
same effect is the point: the repository is already executing in that session, and the
isolated home keeps its project layer away from the owner's set.

**4B.** The worker's worktree gets a copy of the workspace `.codex/skills` canon, plus
a self-ignoring `.gitignore` inside `.codex/` so the copy stays out of the worker's diff
and goes away with the worktree at `done`. Codex reads a project's `.codex/skills`
always, trusted or not, so the copy alone is enough. A reviewer gets no copy and is told
so in its lift output.

## Consequences

- A Codex participant no longer sees the owner's personal MCP servers. The reviewer's
  mechanical deny now covers every server the participant has, because the mechanism
  supplies all of them.
- The participant path does not write the owner's `~/.codex`: `[projects]` records and
  session rollouts land in the participant's own home. The claim stops there. The
  availability probe of the routing gate still starts `codex app-server --stdio` in
  the owner's home before any participant exists, and `initialize` loads that home's
  configuration — so the marketplace snapshot refresh this ADR names above is not
  something the isolation removes, and the integrity check stays per section.
- A copy of the owner's credentials sits on disk at mode 0600 for the life of the
  session. `stop` — and `done` through it — removes the home, and so does a failed lift.
  The removal guard only ever removes a direct child of the homes root, so a record
  naming the owner's home cannot take it with it.
- The home lives in `$TMPDIR`. A long-lived participant is therefore exposed to the
  system's own temporary-file reaping; nothing observed it during this run, and the
  alternative — the mechanism's registry home — was not taken because the owner's
  decision named `$TMPDIR`.
- A worker's repository can now put MCP servers and exec policies into its own
  participant session through its `.codex/config.toml`. Hooks stay off: hook trust is a
  second, separate record keyed by the hook's own hash, and the mechanism writes none.
- The session rollout an operator may want to read is inside the participant home and
  goes away with it. `phrases.logs` names that home rather than `~/.codex`.
- A repository that tracks `.codex/skills` of its own would have it overwritten by the
  copy and its worktree left dirty. `spawn` warns about that for `.cursor` paths and
  not for `.codex`; closing that is PB-161.1.
- A Codex reviewer gets no workspace skills, because it has no working directory of its
  own to put them in. Giving it one — the Cursor driver's `reviewSandbox` shape — is
  PB-161.2.
- Future changes to the home's contents must move together: `codexHomeConfig`, the
  narrow TOML writer beside it, `03-cli` § Spawn and § The Codex holder, and this ADR.
  The writer's vocabulary is strings, string arrays and one level of string-valued
  table, and it must stay that narrow — a config Codex refuses to load does not degrade,
  it takes the participant's whole MCP set with it.
