# PB-191 · A Codex participant can never use apply_patch: fileChange approval carries no path, so containment fails closed on every write

- **Order:** 1
- **Scope:** `lib/codex-session.js` (`pathsOfApproval`, the `MUTATION_APPROVALS` branch at :874-884), [03-cli](../../reference/03-cli.md) § The Codex holder, [guides/hooks-and-trust](../../guides/hooks-and-trust.md)
- **Created:** 2026-09-12, orchestrator's measurement during the 0912c backlog run
- **Dependencies:** none

## What happens

A Codex participant's `apply_patch` is refused every time, for every patch, including a diagnostic
no-op. The text it gets back names a person who was never asked:

```
Script failed
Script error:
patch rejected by user
```

Nobody rejected anything. The refusal comes from the holder's own containment check,
`lib/codex-session.js:874-884`:

```js
const raws = pathsOfApproval(params);
if (!raws.length) {
  const why = method === 'item/fileChange/requestApproval'
    ? 'item/fileChange/requestApproval carries no path to contain'
    : 'action target is unreadable';
  return { allow: false, why };
}
```

**The check is right and stays.** A mutation whose bounds cannot be established is a mutation the
holder must not approve, and failing closed is the correct answer. The break is at the other end:
`item/fileChange/requestApproval` on codex-cli 0.146.0 **carries no path at all**, so the guard's
first branch is the only branch that ever runs for a file change.

## The measurement

Three live Codex participants, 0912c run, holder journals in `~/.agents/codex/sessions/`:

```
worker:codex   approval deny  item/fileChange/requestApproval  × 9
worker:pamyat  approval deny  item/fileChange/requestApproval  × 8
               approval allow item/commandExecution/requestApproval × 39
```

Both participants hit it. One of them never got out: `git status --porcelain` in its worktree stayed
at **0 lines with 0 commits for twenty minutes** while it retried the patch route. The other wrote
its file anyway — through a shell command, which goes through
`item/commandExecution/requestApproval`, carries a path, passes containment and is allowed.

Everything else about the two participants is identical: their `CODEX_HOME/config.toml` files differ
only in `PROMPTOBUS_ROLE` and `PROMPTOBUS_CODEX_SESSION` (`diff` of the rest is empty), both carry
`[projects."<worktree>"] trust_level = "trusted"`, and both worktree paths equal their own
`realpath`. So the difference is not configuration, not trust and not a symlink — it is which door
the model happened to knock on.

## Why this is worse than one refused tool

- **The cost is silent and total.** A participant that only ever reaches for `apply_patch` produces
  nothing at all, and its journal shows a running turn the whole time. From outside, `promptobus
  status` says the session is alive and the turn is running — which is true and useless.
- **The message blames the wrong party.** "patch rejected by user" reads as a human decision in a
  session that has no human. Twenty minutes went into investigating a sandbox policy that was never
  involved.
- **The working route is undocumented.** That a Codex participant must write through shell commands
  rather than the harness's own patch tool appears in no reference, no guide and no participant
  prompt. Both participants found it by accident or by being told.

## Work to do

- Decide what the holder does when a mutation approval carries no path. Two shapes, and the choice
  is the package's: derive the paths from the request some other way for this method (the request
  carries the change itself, and the holder knows the participant's cwd), or keep failing closed and
  **say so in the refusal text** — a `why` that names the method and the reason instead of
  "rejected by user", which the holder does not author but does forward.
- Whatever is chosen, tell the participant how to write. If shell is the supported route, it belongs
  in the participant prompt and in 03-cli § The Codex holder, not in an orchestrator's message.
- Measure whether the same hole exists for the other mutation methods in `MUTATION_APPROVALS`:
  today only `item/fileChange/requestApproval` is known to arrive without a path, and "only that
  one" is an assumption, not a measurement.

## Out of scope

- The containment check itself and `pathsOfApproval` — both correct; this card does not weaken them.
- The two-generation approval protocol of codex-cli 0.146.0 as such.
- Hook firing for a Codex participant — `PB-185`, a different silence with a different cause.
