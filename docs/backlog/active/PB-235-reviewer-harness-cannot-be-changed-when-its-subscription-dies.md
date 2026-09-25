# PB-235 · A reviewer whose harness runs out of quota cannot be re-raised on another tool, and the piece becomes unreviewable

- **Scope:** [03-cli § Review](../../reference/03-cli.md#review)
- **Created:** 2026-09-17
- **Dependencies:** none
- **Cost:** major
- **Previous order:** 90
- **Taken:** 2026-09-25

## Context

A reviewer address is bound to the harness that first started it, and nothing can move it.
When that harness stops answering for a reason no retry fixes — a subscription quota with a
reset date days away — the piece under review has no reviewer and no route to get one.

Measured on 2026-09-17, on a live run. The reviewer had completed seven rounds; the eighth was
sent with a fresh diff snapshot; the harness then began failing every turn with its own hard
limit and a reset date two days out.

Both refusals, in the order they were hit:

```
$ review <worktree> --harness claude
✖ reviewer:<slug> in task <id> was started by harness codex, and --harness asks for claude:
  a repeat call sends a NEW DIFF to the reviewer already started, and there is no way to
  change its tool on the fly. Need a reviewer of another tool — open it its own task:
  --title <name>.

$ review <worktree> --harness claude --title "…" --task <a new id>
✖ there is no task <a new id>
```

The refusal names the remedy — a task of its own — and the command cannot reach it: `review`
resolves `--task` against existing tasks and has no flag that creates one, unlike `spawn`
(`--new-task`). `--title` on its own changes the title of the task already resolved. So the
advice is correct and unreachable from the tool that gives it.

`dismiss` does not help either, and its own output says why: it stops reports about the
session, "a new assignment to the same address puts them back under watch on its own" — the
binding is to the address, not to the watch.

What this costs is specific to the role. A worker can be replaced by hand: its branch is on
disk and another participant can take the work. A reviewer's value is a context that has not
seen the code being written, and the only door that produces one is this command. So the
choice at that moment is between waiting for someone else's subscription to reset and having
the author or the orchestrator judge the work — which is the one thing the role exists to
prevent.

## Work to do

- **The owner's decision, 2026-09-25:** an address whose session is gone may be re-bound to another harness by `review --harness <h>`; the invariant becomes one live session per address. A live session still refuses a harness change. `review --new-task` and "lost for the run" are not taken.
- Decide what a dead harness means for a reviewer address and make the decision reachable from
  the command. The options are not equal and the owner should pick: let `review` open its own
  task the way its refusal already advises (`--new-task`, mirroring `spawn`); or allow the
  harness of an address with no live session to be re-bound, which trades the "one address, one
  tool" invariant for recoverability; or keep the binding and say in the reference that a
  reviewer lost this way is lost for the run, so the run plans for it.
- Whichever is chosen, the refusal should stop advising a route the command cannot take.

## Out of scope

- Detecting the quota condition itself. That is the warden's side and is filed separately.
- Re-binding a worker's harness. A worker's branch survives its session; the recovery problem
  is not the same one.

## Verification

- A reviewer whose session cannot be revived can be replaced on another tool by a documented
  command, or the reference states plainly that it cannot and what to do instead.
- No refusal names a remedy that the command refusing it cannot perform.

## Re-triage, 2026-09-23

Checked on `39316bc2` from the repository root. **Cost `major`**: once a reviewer's harness is quota-dead, the piece has no route to a reviewer except waiting or self-review, and the refusal advises a route the command cannot take.

- The refusal holds: `lib/review.js:368-370`, "… open it its own task: --title <name>." So does "there is no task <id>" (`:159`).
- `review` has no flag that creates a task: `new-task` appears only in the `spawn` block of `lib/cli.js` (`:45`, `:53`, `:348`, `:366`), and the review options are the twelve PB-238 lists.
- **Correction:** `--title` on a resolved task is not applied. It is ignored with a notice: `lib/review.js:213` (`titleIgnored`) and `:779-781`, "--title is not applied — the name is taken from the journal of task <id>". The conclusion stands.
- `dismiss` says what the card quotes: `lib/dismiss.js:49-50`.
- The reference does not say a lost reviewer is lost for the run: `grep -n -i "lost for the run\|reviewer of another tool" docs/reference/03-cli.md` → exit 1.
- Not tree-checkable: the live run of 2026-09-17 (seven rounds, a quota with a reset two days out).
