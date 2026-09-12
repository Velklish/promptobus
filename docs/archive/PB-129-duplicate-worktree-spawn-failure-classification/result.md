# PB-129 · Result

**Closed 2026-09-12.** Done. `installWorktreeDeps` and `runRepoGenerator` no longer repeat the
run-log-classify sequence by hand: both go through a shared `runLogged`.

The copy had already drifted — the two `ENOENT` wordings differed — which is exactly what the card
was written about: a duplicate that nobody keeps in step stops being a duplicate and becomes two
behaviours.

**Checks.** `env -u CODEX_THREAD_ID -u CLAUDE_CODE_SESSION_ID node test/promptobus-spawn.test.mjs`
→ 0, **125/125**. Mutation probe: the `was not found in PATH` wording mutated in `lib/util.js` →
mutated 1, restored 0, and the red named **both** updated `ENOENT` checks — one probe, two verdicts,
which is what a shared body should give.

The environment discrimination is worth keeping with this card: the same file gave **121/125**
without masking and **125/125** with `env -u CODEX_THREAD_ID -u CLAUDE_CODE_SESSION_ID`. The four
reds were inherited session identity, proven by construction rather than asserted — the first case in
the run where that class was demonstrated rather than suspected.

**Docs in the same pass.** `CHANGELOG`.

**Not closed.** Nothing in this card's subject.
