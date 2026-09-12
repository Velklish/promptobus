# PB-189 · A live measurement records what happened but not which copy produced it

- **Order:** 220
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
