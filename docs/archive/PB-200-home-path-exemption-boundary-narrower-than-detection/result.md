# PB-200 · Result

**Closed 2026-09-16, completed.** Detection and stripping now read one grammar for where a path token ends. `TOKEN_STOP` is the single source: the user-name class, the child-path class of the detector and the token-character predicate the stripping code asks are all built from it, so the two sides cannot drift apart again without moving the one constant they share. The alternative the card allowed — exempting the source snippets together with their delimiters — was not taken, because it leaves two grammars in place and pays for the peace with a list that has to be maintained.

**The card's own claim about a live fixture string did not survive measurement, and the hole is real anyway.** The detector was run over every tracked text file — all of them, taken from the index rather than from a walk — and not one match containing a tilde or a backslash came back. So the assertion that such a string sits in a session fixture today is not reproduced on this tree. The defect itself was reproduced directly instead, by calling the rule on the shape the card describes: on the base commit an exempt prefix followed by `~`, `%` or `:` returned no finding, while the same prefix followed by `/` did; after the change all of them are findings, and the bare exempt literal still is not — which is the exemption doing its job.

**Nothing else moved with it.** Before the change, the old and the new grammar were compared over the whole tracked set: no file changes verdict. The set of exempt fixtures is untouched, and the change adds no new findings anywhere.

**Verification.** Two checks in `test/promptobus-package.test.mjs` (46 before, 48 after). The first is the regression the card asks for, run over every exemption in turn against every character the detector accepts — `~ % : \ / . - x` — each of which must still be reported. The second is its opposite and guards the exemption from being widened away: the same literals followed by a delimiter the detector refuses — `"`, `'`, `<`, `>`, space — must stay exempt.

Three mutation probes, taken after the commit, and all three aim at the shared grammar rather than at the fixture list, as the card requires:

- the old narrow stripping class `/[A-Za-z0-9._\/-]/u` restored → red on the longer-path check, naming all twenty leaks, five exemptions times four characters; the second check stayed green.
- `~` added to the shared stop set → the same red.
- the quote characters removed from the stop set → red on the "still exempts the literal against a delimiter the detector refuses" check; the first check stayed green.

The first and third redden opposite checks, which is what shows the two are holding different properties rather than the same one twice.

**Gates of this acceptance, on the merged tree of this commit.** `npx github:Velklish/backslop#v0.8.0 gates --keep-going` exit 0 — gates 4, green 4: `npm test` code 0 over 69 of 69 test files (2203 of 2203 style checks, two more than the previous slice, which is exactly the two checks added here; 882 `node:test` — 873 pass, 0 fail, 9 todo); `backslop lint` code 0, no errors, one warning; `npm run audit` code 0, clean over 134 packed text entries; `npm run pins` code 0.

**Review.** No finding of substance landed on this card. The repository's two-line comment rule took two comment runs in `scripts/audit-public.mjs` and one in `test/promptobus-package.test.mjs` down to two lines each; the reasoning that no longer fits beside the code is in `docs/reference/README.md`, with a pointer to it from the script.

**What is left open.** The card's claim that a live fixture string carries this shape is recorded above as **not reproduced on this tree**, not as false: the check was made on today's tree, and a string present when the card was filed on 2026-09-12 could have gone since. Nobody searched the history for a commit that removed one, and that search is the missing measurement rather than a missing conclusion.

**Documentation in the same pass.** `docs/reference/README.md`, `CHANGELOG.md`.
