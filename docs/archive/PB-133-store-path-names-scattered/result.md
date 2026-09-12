# PB-133 · Result

**Closed 2026-09-12.** Done. Store directory and path names are assembled in one place again.

**Four of the five went to `src/v1/layout.ts`; the fifth did not, and that is deliberate.** The
record-id timestamp is a **name shape, not a path**, so `compactStamp` lives in `src/v1/model.ts` —
one definition, one hand-rolled `toISOString().replace(…)` in the whole tree, four callers. Saying
this out loud matters: the card lists five places "assembled outside `layout.ts`", and closing it in
silence would send the next reader to `layout.ts` to look for a fifth that is not there.

**A behaviour change was caught inside a card that excludes behaviour changes.** Routing the
compatibility sidecar lock through the v1 `lockDir` moved its refusal class: `lockDir` reaches
`safeTask` and throws `PromptobusError` **before** `withDirLock` can use the sidecar's `GateError`
callbacks. The class is not cosmetic — the neighbouring contract says it decides whether a lawful
refusal is rendered with a stack. The sidecar now validates the id itself with `requireTaskId`
before the canonical builder, and a verdict holds it.

**Checks.** `env -u … node test/store.test.mjs` → 0, **31 → 32** (the new invalid-id verdict);
migration 83/83; history 21/21; v1-engine 128 → 129; `npm run build` → 0. Scans: one `.promptobus`
literal, in `layout.ts` as `ROOT_DIR`; one hand-rolled stamp, in `model.ts`. Mutation probes:
`lockDir(home, id)` replaced by another path reddens the new lock-parity verdict;
`requireTaskId(id)` replaced by `id` reddens **exactly** `an invalid task id is a GateError…`.

**Docs in the same pass.** `CHANGELOG`.

**Not closed.** Nothing in this card's subject.
