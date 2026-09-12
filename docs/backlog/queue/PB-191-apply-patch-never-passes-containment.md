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

## The workaround does not stick, measured 2026-09-12

A participant told the working route in plain words — with the refusal explained, the code quoted and
the shell alternative spelled out — **went back to `apply_patch` an hour and a half later**, on the
next piece of work, and reported the same refusal again as if it were new. It had not tried a shell
write at all: "bash heredoc, python3 и sed не запускал".

This is not inattention. `apply_patch` is the harness's own tool for editing a file, and a
participant reaches for it by default; a sentence in a message competes with that default once and
loses on the next turn. Two consequences follow, and the second is the reason this section exists:

- an orchestrator has to repeat the instruction per piece of work, not per participant;
- **any fix that lives only in a prompt will decay the same way.** If the answer to this card is
  "tell participants to use shell", it must be carried by something the participant re-reads each
  turn — its own rules bundle or the refusal text itself — and not by a message.

That makes the refusal's wording load-bearing. "patch rejected by user" sends the reader to look for
a human and a permission policy; it names neither the real gate nor the working route. A refusal that
said which gate closed and what to use instead would have cost this run nothing.

## The shell route is not universally open either, and the difference is unexplained

The card says shell writes are the working route. On one participant of the 0912c run they were
**not**: an ordinary `exec_command` running a `python3` heredoc that wrote a file **inside its own
worktree** was refused with

```
PermissionError: [Errno 1] Operation not permitted
```

and the edit only went through on the escalated route. A sibling participant of the same run wrote
its own worktree files through the ordinary route for two hours without escalation.

**What was compared and found identical** (orchestrator's measurement, 2026-09-12):

- sandbox mode in both session records: `workspace-write`;
- both worktrees sit at `<repo>/.claude/worktrees/<name>` — same shape, different zone
  (one under the consumer's clone area, one under the personal-projects area);
- file permissions on both targets: `-rw-r--r--`, no macOS file flags (`ls -lO` flag column `-`);
- the refused file was not immutable: the escalated write succeeded on it minutes later.

**What is not established:** why one refusal happened. Zone, path depth, an extended attribute
(`com.apple.provenance` is present on the refused file) and a transient condition all remain
possible, and none was tested. The orchestrator is not sandboxed and cannot reproduce the refusal
from outside, so the discriminating measurement has to be made from inside a participant.

**Why it matters to this card.** The card's remedy is "write through shell". If shell is itself
refused for some participants, that remedy is not a remedy but a second thing to discover by
failure. Whoever answers this card must say which route is guaranteed, for which participants, and
what a participant should do when the guaranteed one is refused — the answer today is "escalate",
and nothing tells a participant that.

## The fallback changes the shape of the failure, measured 2026-09-12

A third participant of run 0912c hit the full sequence in one edit, and reported each step:

1. `apply_patch` — refused by containment, as this card already records.
2. Fallback to the documented remedy, a shell run of `/usr/bin/patch`.
3. That patch was mis-assembled, so `patch` applied the hunks it could and **rejected the rest**,
   leaving `.rej` files beside a half-edited source.

The participant caught it, deleted the artefacts and re-read the diff hunk by hunk. But the third
step is the one this card has to record, because it is not the same kind of failure as the first:

- `apply_patch` refused **loudly and completely**. Nothing changed on disk, and the participant could
  not mistake it for success.
- Shell `patch` failed **partially**. The file was left syntactically valid and semantically half
  finished — a call present with no implementation behind it is exactly the shape this produces —
  and `node --check` on such a file returns 0.

So the remedy this card hands a participant trades a refusal it cannot miss for a failure it can.
Anyone writing the fix must say what the participant runs **after** the fallback to know the edit
landed whole: a reject-file sweep, a rejected-hunk exit code read rather than ignored, or a diff
re-read. "Write through shell" alone is not a complete instruction.

## The refusal blames the user, measured 2026-09-12

Three participants of run 0912c reported the refusal, and one of them quoted its text:

```
patch rejected by user
```

No user rejected anything. The containment gate refused, for the reason this card is about: the
approval carries no path to contain. The wording hands the participant a false attribution, and the
two readings lead to opposite actions — "a human said no" means stop and ask, while "the gate closed
because it cannot see a path" means take the other route.

This compounds the cost the card already records. A participant that believes a person refused its
edit has no reason to look for a workaround at all, and the ones that found the shell route today
found it by trying, not by being told.

Whoever closes this card must say what the participant is shown when containment closes. If the text
stays as it is, the remedy it points at is the wrong one.

## The boundary is the worktree itself, not the write method — measured 2026-09-12

A participant of run 0912c took four plain-shell writes, no escalation, in its own worktree, and a
fifth and sixth outside it. The orchestrator asked for them to test whether the refusal depends on
depth — the repository root against a subdirectory. It does not.

```
printf 'x\n' >> AGENTS.md        → 1   operation not permitted   (root)
printf 'x\n' >> docs/README.md   → 1   operation not permitted   (subdirectory)
touch ./probe-root-check.tmp      → 1   operation not permitted   (root)
touch docs/probe-sub-check.tmp    → 1   operation not permitted   (subdirectory)

mkdir -p /tmp/pb-orch-probe       → 0   created, then removed
mkdir -p "$PWD/.probe-here"       → 1   operation not permitted

git checkout -- AGENTS.md docs/README.md
                                  → 128 EPERM creating .git/worktrees/…/index.lock
```

**The participant's plain shell cannot write anywhere inside its own worktree, and can write to
`/tmp`.** Depth makes no difference; the boundary is the worktree. Even `git checkout` fails, because
git needs its own lock file inside `.git`.

This inverts the picture the card carried until now. The card's remedy — "write through shell" — was
inferred from participants that did write successfully, and the natural reading was that the plain
route works and `apply_patch` alone is blocked. The measurement says the plain route does **not**
work at all here: every successful edit in this run went through the escalated route, and the
escalation is what made it look like shell worked.

**Two things follow, and neither is guesswork.**

1. **The remedy in this card is wrong as written.** Telling a participant to "write through shell"
   describes a route its plain shell does not have. What it actually needs is the escalated route,
   by name, with the note that ordinary writes will be refused with `operation not permitted` and
   that the refusal is not about the file.
2. **`/tmp` is writable while the worktree is not**, which is the opposite of what the recorded
   sandbox mode `workspace-write` suggests by its name. Either the mode is not what the name says, or
   the participant is not running under the mode the session record claims. Both are checkable, and
   neither has been checked.

**Still not established.** Whether this was true from the first minute of the session or changed
partway — the same participant committed repeatedly earlier in the run, and whether those commits
went through escalation was not recorded at the time. The next measurement worth taking is the
cheapest one: the same four commands at the start of a participant's life, before any work.

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
