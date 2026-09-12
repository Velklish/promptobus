# PB-189 · A live measurement records what happened but not which copy produced it

- **Scope:** `lib/spawn.js` and `lib/review.js` (the lift line), `lib/codex-session.js` /
  `lib/cursor-persist.js` (the holder's journal header),
  [contributing](../../guides/contributing.md) § what the stands prove
- **Created:** 2026-09-12, release run
- **Dependencies:** none

## What happens

A live run writes a holder journal, a lift line and a task store. None of them records **which
copy of the mechanism executed**. The tree is one thing, the installed package another, and a
sandbox raised from a branch a third; the journal looks the same in all three.

This is not hypothetical. In one night the same gap produced both outcomes:

- **A paid turn spent for nothing.** A participant was lifted to decide whether a flag changes
  behaviour, in a tree where the flag existed — while the process that lifts participants comes
  from `node_modules/promptobus` at the previous version, which carries neither the flag nor the
  constant that builds it. `ps -eo args | grep -c dangerously-bypass-hook-trust` across the live
  `app-server` processes: **0**. The measurement could not distinguish its own branches, and the
  turn repeated an earlier inconclusive one.
- **A verification that survived only by luck.** Another live turn was asked, afterwards, which
  copy had produced it. It was answerable **only because the change had altered the shape of the
  journal line**: `approval allow … kind=mcp_tool_call schema=true`, where the installed version
  refuses unconditionally and has neither field. Had the change not touched the output format,
  there would have been nothing to tell the copies apart, and the honest answer would have been
  "cannot be established" — with a live verification already written into a card's result.

## What to do

- Make a lift record the copy it runs: the resolved path of the CLI entry and the `version` of the
  package it resolves from, in the lift line and in the holder journal's first line. Both places,
  because one is read by a person at the moment and the other by whoever reconstructs later.
- Record the same for a participant's own binary where it is already known (`codex --version` is
  read at lift today and printed nowhere durable).
- Say in the contributing guide, beside what the stands prove, that a live measurement without the
  executing copy recorded is **not attributable**, and that a precondition check for this class has
  three parts: the state under test, the state of the participant's home, and the version of the
  copy that raised the process.

## Out of scope

- Which copy *should* run — that is the workspace's pin and a release matter, not this card's.
- `PB-177` and the missing workspace manifest, which is a different reason for the same surprise.

## Verification

- A holder journal and a lift line from a fresh run name a path and a version, and a check fails
  when either is absent.
- The claim "this measurement was produced by this code" in any result rests on that record rather
  than on the shape of an output that happened to change.

## One measured trap for whoever writes the check

`grep dangerously-bypass` over an installed copy returns **six** matches that are approval-policy
values (`'dangerously-bypass-approvals'`, `'dangerously-bypass-approvals-and-sandbox'`), not the
hook-trust flag. A substring probe answers the wrong question here; match `PARTICIPANT_ARGV` or the
full `dangerously-bypass-hook-trust`.

## Follow-up observation from the live Codex run, 2026-09-12

The installed copy was later measured at version `0.7.0`, and three live holders carried
`/opt/homebrew/bin/codex --dangerously-bypass-hook-trust app-server --stdio`. Each participant
took two turns; all three journals had `turn/started=2` and `hook/started=0`. The installed
`lib/codex-hold.js` still returned `grep -c PARTICIPANT_ARGV` = 0, so the marker proposed above
cannot identify the route by which the flag reached argv. The result is therefore attributable
only after the new header is present, while the cause of the silent hook remains open.

The fixture verdicts close the writing half of this card: provenance is emitted at both points, and
five verdicts cover the lift and holder paths. They do **not** demonstrate that the reported CLI path
is the executable copy on a live lift. Live attribution remains unresolved until the installed copy is
re-pinned/synchronized and a fresh lift records that executing copy; the card stays open.

A version alone is not enough to distinguish the copies. The tree copy and the installed copy
were both measured at `0.7.0`; only the `package.json` path taken from the executing `import.meta.url`
separates them. The incident this card records was exactly that ambiguity: the flag lived in the
tree while `node_modules/promptobus` raised the participants.

Exact code identity is a separate unresolved point. A path and reported version do not distinguish
two revisions at that same location, including an in-place replacement; closing that gap would
require a commit and dirty-tree marker for the tree and an equivalent identity for the installed
package. The new fields deliberately do not claim that stronger fact.

The new provenance fields do not reuse the protocol's `mechanismVersion`: that older field keeps
the host's writer-version numbering, which journal readers use for mixed-version detection. The
package path/version and host version therefore remain separate facts.

## Deferred

- **Deferred:** 2026-09-12, backlog run 0912c.
- **Reason:** the writing half is done and measured — `provenanceLine` is emitted at the lift
  (`lib/spawn.js:1308`, `lib/review.js:699`) and in both holder journal headers
  (`lib/codex-session.js:153`, `lib/cursor-persist.js:245`), the participant binary and its version
  are in the line, and [contributing](../../guides/contributing.md) states that a measurement
  without the executing copy is not attributable. What is **not** done is the only check that would
  prove the field names the copy that actually ran: a live lift whose header points at the
  installed copy. That check is unreachable today — the installed copy is the released `0.7.0`,
  which carries no provenance, so a live lift now would measure the absence of the feature rather
  than its correctness. Repinning the consumer to an unreleased tree mid-run would move every live
  participant onto it, which is a mechanism decision and not this card's to take.
- **Return condition:** the consumer is repinned to a promptobus carrying provenance. Then one live
  lift, and the header read: it must name the installed copy's `package.json` path, not the tree's.
  Path is the only discriminator — both copies report the same `version`.
