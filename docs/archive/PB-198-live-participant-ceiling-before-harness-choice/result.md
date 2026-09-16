# PB-198 · Result

**Closed 2026-09-16, completed — and the behaviour the card asks for was already in the tree, which is the more interesting half of this result.** The gate arrived with the archived card on the harness live-participant cap, closed 2026-09-11, a day before this card was filed against the same package. The evidence is at three named places: `lib/model-routing/resolver.js` filters the balance representatives through `!atCap` **before** `pickOf` runs, so a harness that has reached its ceiling is never in the field the pace comparison ranks; the overlay schema carries `caps.liveParticipants` as a per-harness object; and the decision schema carries `atCap` on the row. The mechanism was not rewritten — a rewrite would have replaced a working gate with the same gate.

**What was missing was everything the card's "Verification" section asks for, and that is what this pass added.** The reference now names **where** the ceiling sits in the `balance` order — it *is* step 3, after the representatives are picked and before the pace comparison — and what happens at it: the pick moves to the next candidate under its own ceiling, there is no refusal, and the fallback to a comparison made as though no ceiling were set is reached only when **every** paced harness is at its cap. The key stays separate per harness, because the three subscriptions have different capacities and one number for all three is wrong for at least two.

**Verification.** A routing case per harness in `test/model-routing-resolver.test.mjs` (103 checks before, 104 after): each of `claude`, `codex` and `cursor` in turn is given a snapshot where its windows are unspent and it leads on pace; with one live participant and a ceiling of 1 the pick leaves that harness, while `scoredIds`, `score.total`, `excluded === null` and `pace.representative === true` all match the run with no ceiling — the harness was **out of the field**, not penalised inside it, which is the distinction the card is about. With the ceiling at 2 the harness returns to the field, `atCap` disappears and no warning is raised.

Three mutation probes, each taken after the commit and each run under the new case's name pattern:

- the gate removed — `const under = balanceRepresentatives;` → red: `claude: at its ceiling it must be out of the field`.
- the comparison loosened — `liveOf(harness) >= cap` to `> cap` → red.
- `capOf` returning `caps[harness] + 1` → red. This is the probe the card names by hand: raising the ceiling by one must bring the harness back into the field, and a green probe here would have condemned the check.

**Gates of this acceptance, on the merged tree of this commit.** `npx github:Velklish/backslop#v0.8.0 gates --keep-going` exit 0 — gates 4, green 4: `npm test` code 0 over 69 of 69 test files (2197 of 2197 style checks, 880 `node:test` — 871 pass, 0 fail, 9 todo, one more than the previous slice, which is the case added here); `backslop lint` code 0, no errors, one warning; `npm run audit` code 0, clean; `npm run pins` code 0.

**Review.** One finding landed on this card, major, and it was a real contradiction rather than a wording preference: the added paragraph placed the ceiling *between* steps 3 and 4 while the procedure list twenty lines above already carried it **as** step 3. The code agreed with the list, not with the new paragraph. The text now says "it IS step 3", and the CHANGELOG entry was corrected with it.

**What is left open.** No probe was taken on the two documentation edits of the review round — they change text, not behaviour, and the three probes above stand for the gate itself. The card's own framing — that the ceiling is "a penalty inside a chosen lane" — was refuted by measurement rather than implemented; the card text is left as it was filed, because a closed card is a record of what was asked, not of what was found.

**Documentation in the same pass.** `docs/reference/03-cli.md` § the `balance` procedure, `CHANGELOG.md`.
