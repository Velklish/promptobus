# PB-134 · Result

**Closed 2026-09-12.** Done. The read → parse → validate → isolate loop, written three times in
`messages.ts` and already drifted between the copies, is one body: `readRecord`.

**The split is written down by line, because the first description of it was wrong.** `readRecord`
reads the file (`src/v1/messages.ts:306`) and owns parse, validate and isolate. What stays with each
caller is its **error policy**: the call sits inside the caller's own `catch`, and that is what keeps
the three behaviours apart — `readInbox` skips `ENOENT` and rethrows the rest, `peekInbox` swallows
everything, `history` classifies. The card's first note claimed reading stayed with the callers; it
did not, and the note was corrected to the measurement rather than left as the nicer story.

**The rejected alternative is named:** a helper that owns the read and takes a policy flag, enum or
callback. That moves the copies inside one branching body and guarantees a fourth branch the next
time a caller appears — the same move that was rejected earlier in this batch for `writeJsonAtomic`
and its boolean `secret`.

**One of the three policies is wrong, and this card deliberately did not fix it.** `peekInbox`
swallows every read refusal while its own comment names only the harmless one. That is `PB-193`, filed
separately: whether a copy is correct is a different question from whether there are three of it, and
smuggling the first into a deduplication is how behaviour changes arrive unannounced.

**Checks.** `env -u … node test/v1-engine.test.mjs` → 0, **128 → 129**; history 21/21;
`npm run build` → 0. Mutation probes, each restored: the shared schema-note literal mutated → the new
malformed-record check reddens; a note divergence introduced on the history path only → the strict
byte-equality parity verdict reddens. Two probes, two different verdicts.

**Docs in the same pass.** `CHANGELOG`.

**Not closed.** `PB-193` — the inherited catch-all in `peek` — is open by design, not by omission.
