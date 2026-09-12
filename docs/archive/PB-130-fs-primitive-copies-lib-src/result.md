# PB-130 · Result

**Closed 2026-09-12 by merging into `PB-117`.** Not completed as separate work: the two cards issued
contradictory instructions for the same two files.

**Why merged.** PB-117 asks for `pidAlive` to live in a new `harness-registry.js`; PB-130 asks for
the two local bodies in `lib/cursor-persist.js` and `lib/codex-session.js` to be deleted and
imported from `../dist/index.js`. Both cannot hold. The same collision runs through
`writeJsonAtomic`, which PB-117 treats as a `store.js` export to build a registry on and PB-130
treats as a `src/fs/atomic.ts` primitive to publish. One decision — package export or `lib/` leaf —
governs every name in both cards, and a split answer rebuilds the problem one level down.

**What carried over.** PB-117 now holds the four `writeFileAtomic` / `writeJsonAtomic` /
`shellQuote` / `pidAlive` findings with their line references and the drift evidence
(`preserveMode` never reached the `src/` copy), the correction owed to the false comment at
`src/index.ts:7-10` and `src/fs/atomic.ts:3-5`, and PB-130's out-of-scope boundaries.

**Verification.** None claimed — no code changed. The merge is editorial; `backslop lint` on the
tree after it.
