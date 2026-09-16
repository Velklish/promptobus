# PB-193 · Result

**Closed 2026-09-16, completed.** The read in `peekInbox` no longer answers every refusal with the same silence. `ENOENT` keeps the behaviour the old comment explained and deserved — the file went between the listing and the read because its owner claimed it, and that owner will deliver it. Every other refusal now becomes a `BrokenNote` carrying its errno code, so a caller that could not open a message is told the inbox holds one, rather than being told the inbox holds one fewer.

**The decision the card asks for, made and written down: an unreadable ref counts as present and broken, never as absent, and never as an error of the peek itself.** The note carries `attic: null`, which is the difference between this case and the parse and validate branches below it: a record that does not parse is moved aside, because what is wrong with it will still be wrong on the next pass; a record that could not be *opened* is left exactly where it is, because the refusal may be the environment's and not the file's, and the next pass may read it. This is already the policy `read` and `glance` carry, so the change ends with the three inbox readers agreeing rather than with a fourth rule.

**Verification.** Two checks in `test/store.test.mjs` (32 before, 34 after), one per half, because a single check over both would not show the split:

- the `ENOENT` half is a dangling symlink in the inbox — the listing sees the name and the read does not find the file, which is the race itself with no seam to inject through. `peek` returns three messages and an empty `broken`.
- the other half is a file at mode `000` — `broken` carries a note with `code: 'EACCES'` and `attic: null`, the file is still in the inbox afterwards, and the readable mail is untouched.

Two mutation probes, taken after the commit, and each reddens exactly one half — which is precisely what the card demands, since one probe reddening both would mean the split was never made:

- the reporting branch removed, leaving the bare `continue` → only the `EACCES` half red, 32 of 34; the `ENOENT` half green.
- the `ENOENT` skip removed → only the `ENOENT` half red, 32 of 34; the `EACCES` half green.

**Gates of this acceptance, on the merged tree of this commit.** `npx github:Velklish/backslop#v0.8.0 gates --keep-going` exit 0 — gates 4, green 4: `npm test` code 0 over 69 of 69 test files (2201 of 2201 style checks, 882 `node:test` — 873 pass, 0 fail, 9 todo, two more than the previous slice, which is exactly the two checks added here); `backslop lint` code 0, no errors, one warning; `npm run audit` code 0, clean; `npm run pins` code 0.

**Review.** One finding landed on this card, major and correct. The mode-`000` check was guarded against Windows alone, where the case is unreachable; under `uid 0` the mode does not forbid the read either, so the read would succeed, the record would fail validation instead, the note would come back with the wrong code and a non-null attic, and — worse than the three failed assertions — the cleanup `chmod` afterwards would throw `ENOENT` **outside** the subtest and take the whole enclosing test down with every check that had already passed. The guard is now `process.platform !== 'win32' && process.getuid?.() !== 0`, the same shape a neighbouring suite file already used. Evidence that the skip branch works and drags nothing with it: a run with `process.getuid` replaced by one returning 0 gives 33 of 33 green — the `EACCES` subtest drops out, the `ENOENT` subtest stays, and there is no cascade. Without the replacement, 34 of 34.

**What is left open, and it is the part worth reading.**

- **The probes were taken on the compiled `dist/`, not on the TypeScript source.** The mutation was applied through a patch on stdin against the compiled module, because the same mutation in the `.ts` file does not compile — the red would then have come from the build and not from the check. The evidence about behaviour is real, since the compiled code is what the test executes; it does not establish that a mutation of the same meaning in the source would redden the same checks.
- **The failure chain under a real `uid 0` was not reproduced.** It is set out above from reading the code, and the skip branch itself was measured with a replaced `getuid`; no session with real root was available. Treat the chain as analysis, not as a measurement.
- **`peekInbox` still has no `FaultHook` seam**, unlike `readInbox` and `glanceInbox`, which is why the `ENOENT` half had to be built from a dangling symlink instead of an injected errno. The seam belongs in `src/v1/engine.ts`, a file owned by a neighbouring track in this run, and an edit wider than a line or two in another track's file is not a worker's move. It carries over to the run orchestrator as a finding rather than to a card on this branch; no card for it exists at the time of closing, and this paragraph is where it is written down.
- One trap found on the way and worth keeping: `rmSync(path, { force: true })` does **not** remove a dangling symlink — `force` swallows the `ENOENT` from the very `stat` the decision is made on. The cleanup uses `unlinkSync`.

**Documentation in the same pass.** `docs/reference/01-overview.md` § Store home, `CHANGELOG.md`.
