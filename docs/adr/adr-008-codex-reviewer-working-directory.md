# ADR-008: A Codex reviewer works in a directory of its own, and that directory is trusted

**Status:** Accepted
**Date:** 2026-09-11
**Deciders:** Павел Ким (owner), decision of 2026-09-11 on PB-161.2 of the harness-parity run

## Context

[ADR-007](adr-007-codex-participant-isolated-home.md) gave every Codex participant a
`CODEX_HOME` of its own and wrote a trust record into it — `[projects."<realpath>"]
trust_level = "trusted"` — for a worker and deliberately not for a reviewer. The reason
was the reviewer's working directory: it was the tree UNDER REVIEW, usually a worker's
worktree. A trusted project's own `.codex/config.toml` puts MCP servers into the session
(measured on codex-cli 0.146.0, one stand, three runs: no record — the project's server
does not come up and stderr says the project is untrusted; the realpath record — it comes
up; the unresolved `/var/…` spelling — it does not). A repository must not hand servers
to the session judging it, so the record was withheld.

The same working directory cost the reviewer its skills. The Cursor driver copies its
canon into a `reviewSandbox` of its own precisely so the mechanism writes no files into a
foreign tree; Codex had no such directory, so ADR-007 copied the canon for a worker only.
The review procedure arrives as a module skill, so a Codex reviewer did not have it while
a Claude Code or Cursor reviewer did — a hole in harness parity, not a property of Codex.

Both costs have one cause, and it is not trust: the reviewer was seated in somebody
else's tree. The copy would wipe its destination (`copyLaunchTree` removes the
destination first, so a repeat lift leaves no skill that has since vanished from the
canon) and dirty the branch a worker is still committing to.

## Options

**Decision 1 — where a Codex reviewer works.**
1A, in the tree under review, as before: no new directory to build, no new cleanup, and
both costs stay — no workspace skills, no project layer of any kind.
1B, in a directory of its own, the Cursor driver's `reviewSandbox` shape, with the
reviewed tree attached through `addDirs` → `runtimeWorkspaceRoots` the way the rule
files already are: the copy has somewhere to land that belongs to the mechanism, at the
cost of one more directory in the task store and one more thing to sweep.

**Decision 2 — whether that directory is trusted.**
2A, untrusted, keeping ADR-007's record as written: nothing changes, and the reviewer's
own directory is the only participant working directory the mechanism does not trust.
2B, trusted, like a worker's worktree: the reviewer's session gets the project layer of a
directory the mechanism itself built and filled, and the role branch in the driver
disappears.

**Decision 3 — which `config.toml` the record is written to.**
3A, the participant's own `CODEX_HOME`, as ADR-007 decided for a worker.
3B, the owner's `~/.codex/config.toml`. Named only to be refused: there is no trust
command on codex-cli 0.146.0, the record is a file edit, and a record written to the
owner's file outlives the participant. The owner's home already carries a stale
`[projects]` entry pointing at a deleted spike directory, which is what that costs.

## Decision

**1B.** A Codex reviewer's working directory is
`<participant settings path without .settings.json>.codex-sandbox` — beside the other
participant files in the task store. Deterministic rather than `mkdtemp`, for the reason
the Cursor sandbox and the participant home are: `prepare` writes and launches nothing,
and `--dry-run` must print the path a real lift will use. The skills copy and its
self-ignoring `.gitignore` land there, and the tree under review is attached through
`addDirs`, which the driver hands to `thread/start` as `runtimeWorkspaceRoots`. Approval
containment reads the session record's `cwd` and `addDirs`, so the containment roots
follow the directory without a second decision. `done` sweeps the directory with the rest
of the participant's files: it matches them by the address stem and asks no driver.

**2B.** That directory is trusted, by its realpath, exactly as a worker's worktree is.
The reason for withholding the record died with 1B: what is trusted is no longer the
repository being judged but a directory the mechanism built, filled and will delete. The
tree under review is never trusted — it arrives as a read in `addDirs` and nothing else —
and the driver no longer branches on role to say so. What trust grants is the project
layer of that directory: its own `.codex/config.toml` and `.codex/agents`. The sandbox
has neither today; the mechanism writes only the skills copy into it. So the record buys
the reviewer nothing it can use this release, and is taken for the symmetry: every Codex
participant's working directory is the mechanism's own, and every one of them is trusted.

**3A.** The record goes into the participant's disposable `CODEX_HOME` and dies with it
at `done`, `stop`, or a failed lift. Never the owner's `~/.codex/config.toml`: that
boundary is ADR-007's whole point, and the suite asserts the file the record landed in —
the participant home's `config.toml` — and not merely the text of the record.

## Consequences

- A Codex reviewer reads the workspace skills canon, so the review procedure that arrives
  as a module skill now reaches every one of the three harnesses.
- The reviewed tree gains no file from a reviewer lift, and loses none: the copy that
  wipes its destination now points at the mechanism's own directory.
- `review` prints `reviewer home: <path>` on a real lift as well as in `--dry-run`. It had
  to: the `reviewer … started in <repo>` line names the repository under review, which for
  Cursor and Codex is not the session's working directory.
- One more directory per Codex reviewer lives in the task store until `done`. It holds a
  copy of the skills canon and nothing secret.
- **The lift does not wipe that directory whole, and trust is not withheld when something
  unexpected is in it.** `copyLaunchTree` erases `<sandbox>/.codex/skills` and nothing
  above it, so anything that ever landed elsewhere under `<sandbox>/.codex/` — a
  `config.toml`, an `agents/` — would survive a repeat lift and enter the trusted project
  layer. Neither a wipe nor a refusal is shipped, for a stated reason rather than an
  oversight: inside the mechanism nothing can write there. A Codex worker's writable roots
  are its worktree and its `addDirs`, which are rule directories; a reviewer is
  `read-only` and every mutation approval is denied to it before containment is even
  consulted; `done` removes the directory with the participant's other files, so it does
  not cross tasks. What is left is a writer outside the mechanism, and unlike the
  participant home — whose path guard exists because `$TMPDIR` is shared with every other
  user of the machine — the task store is the owner's own. Somebody who can write into it
  can edit the mechanism's code instead, which is a larger door through a smaller wall.
  The claim is pinned by a check rather than left as a sentence: after a reviewer lift the
  suite asserts that the directory holds exactly what the lift put there — its root and
  its `.codex/` both, because the root is the working directory of the trusted session
  and a file beside `.codex` is as much a foreign write as one inside it. **Revisit
  when any of those stops holding** — the mechanism writing anything else into a
  reviewer's directory, a participant gaining the task store as a writable root, or the
  store moving somewhere shared. The check is what will say so first.
- **Measured (2026-09-12, PB-161.3):** Codex reads a project's `.codex/skills` from a
  directory that is not a git repository, so the sandbox stays without a `git init` — unlike
  the Cursor sandbox, which is `git init`-ed because `.cursor/mcp.json` is read only inside a
  repository, while Codex takes its MCP set from the participant home's `config.toml` and
  needs no repository for that. The stand was a standalone-host workspace inside no repository
  at all, one stub skill carrying a marker, and one live reviewer turn: Codex put the sandbox
  first in its own skill-roots table, listed the stub, and the model read `SKILL.md` at that
  path and returned the marker. The refusal to invent the precondition before measuring it
  held — the precondition does not exist.
- **Open, found by that same turn (PB-161.4):** the reviewer could not deliver its report.
  Every bus call of the turn died on a declined `mcpServer/elicitation/request`, so the marker
  had to be read from the session rollout rather than from the `result` message. The bus
  server is not the source — driven directly it issues no elicitation and its `promptobus_send`
  succeeds. Until that is settled a Codex reviewer has its workspace skills and no channel to
  report through, and the two facts are recorded together on purpose: the first without the
  second reads as a working reviewer.
- Future changes to what a reviewer's directory holds must move together: the driver's
  `reviewSandbox` and `prepare`, the trust record in its `spawn`, `03-cli` § Review, and
  this file.
