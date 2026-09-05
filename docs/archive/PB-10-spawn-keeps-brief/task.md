# PB-10 · spawn keeps the brief as a task artifact instead of leaving it wherever the orchestrator wrote it

- **Scope:** [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-05
- **Dependencies:** none
- **Taken:** 2026-09-05

## Context

`spawn --brief <file>` reads the brief, embeds it in the participant prompt and forgets the file. The brief is the participant's assignment — the one document that explains a branch months later — yet the bus keeps review diffs and reports under the task's `files/` and not the brief. Orchestrators therefore invent a home for brief files (a scratch directory, a sandbox), and the consumer's workspace accumulated eight directories of stale briefs in a zone meant for experiments (owner's observation, 2026-09-05). `review` has no counterpart: it composes no assignment text of its own — its prompt is generated from the diff, the rules and the harness dictionary — and the diff itself already lands in `files/`.

## Work to do

- `spawn` copies the brief into the task's `files/` as `brief-<worker>.md` (every lift stores the brief it was given, and the next one takes a suffix rather than overwriting); the lift output names the path.
- Docs: the brief file the orchestrator passes is temporary — the bus keeps the copy.

## Out of scope

- Rendering briefs anywhere else (status output, mailbox).

## Verification

- Spawn test: after lift, `files/brief-<worker>.md` equals the brief passed; a second spawn of the same worker with another brief keeps both.
