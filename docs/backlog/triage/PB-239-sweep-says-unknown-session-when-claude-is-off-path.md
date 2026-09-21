# PB-239 · sweep reports session is unknown when claude is simply not on the lifted session's PATH

- **Scope:** [03-cli](../../reference/03-cli.md), [05-drivers](../../reference/05-drivers.md)
- **Created:** 2026-09-22
- **Dependencies:** none

## Context

Cleanup run from inside a lifted participant fails, and the message blames the
session:

- `approver:perf`, 2026-09-21: `npx ati-agents promptobus sweep` → "claude
  agents --json is unreadable".
- `approver:storage-cli-git`, same evening: `sweep worker:storage-cli-git` →
  "session is unknown", while `stop` in the same session answered "no live
  session".

The same commands work from the orchestrator's session. The cause is neither
the session nor the journal: **`claude` is not on the `PATH` of the lifted
session**, so the driver cannot ask the harness for participant state and
reports the absence as ignorance about the session. The third approver of the
same run confirmed it by adding `~/.local/bin` to `PATH` and re-running: the
sweep then completed — worktree removed, branch deleted, artifacts counted,
wake and two configs removed.

Two costs. A participant cannot finish its own cleanup, so the orchestrator
does it by hand. And the message points at the wrong thing: an operator reading
"session is unknown" looks for a dead or mis-addressed participant, which is
not what happened.

## Work to do

- Give the lifted session the `PATH` its driver needs, or resolve the harness
  binary by absolute path rather than through `PATH`.
- Separate the two failures in the message: "the harness binary was not found"
  is not "the session is unknown", and only the first is actionable by the
  caller.
- Check the other places that shell out to the harness from a participant's
  environment; `stop`'s "no live session" in the same situation looks like the
  same confusion wearing different words.

## Out of scope

- Whether a participant should be doing cleanup at all. Today's recipe has the
  approver run `sweep`, and that is the flow this entry is about.

## Verification

- `sweep` from a lifted session completes without the caller adjusting `PATH`.
- With the harness binary genuinely absent, the message says so and names what
  it looked for.
