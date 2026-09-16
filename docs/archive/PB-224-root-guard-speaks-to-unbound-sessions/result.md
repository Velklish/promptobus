# PB-224 · Result

**Closed 2026-09-16, completed. The behaviour did not change; what changed is that it is now written down, and the writing corrected the card's own description of it.** The card recorded an owner decision — the dead-warden advice reaches a session that owns nothing, and that is right, because the arrangement the guard exists for is a live owner who makes no move while waiting for a delivery that has nobody left to make it. In that state the owner's own hook never fires, and a session standing beside it in the same workspace root is the only one able to notice. What was missing was any text saying so, which left a deliberate decision reading as an accident of implementation.

**The circle is narrower than the card states, and the reference now names it exactly.** The card describes the recipients as "every session in the workspace root carrying an identity, whether or not it owns the task". The predicate in the guard holds back four classes rather than the one that phrasing implies: a declared participant, a session with a task binding on disk, the owner of **any** active task, and a session named on a participant record — the last being a worker or reviewer that carries no role variable in its environment but stands in the journal, on the bus by record rather than by variable. So the recipients are every session in the root **not already on the bus**, and the owner of the task is, by that predicate, not among them.

**The owner is not left without the advice, and that is the other half of the boundary.** It reaches them through the loop-guard branch instead, which is the same place that returns their turn. Hence the line the reference now carries: the advice goes to everyone, the turn comes back only to the owner. A stranger gets the `NO WARDEN` line with the raise route and exit 0; the owner gets the line and exit 2. This is the separation the card asks to be made explicit — the first would take a person's turn away inside their own work, the second is a line of output.

**Verification.** Four checks in `test/promptobus-guard.test.mjs` (103 before, 107 after), all on one task fixture with a live owner, a dead warden and unread mail: a live warden is silence for the stranger too; the stranger receives the advice with the raise route; the same stranger exits 0 with an empty stderr and no turn mark — no turn return; and the owner, at its own end of turn, exits 2 with the turn mark, the `NO WARDEN` line and the raise route all present. The card's fourth verification item — a session outside the workspace root stays silent whatever the warden's state — is held by a check that was already in this file before the task and was left untouched.

Two mutation probes, each taken after the commit, and the point of them is that each reddens exactly one half:

- the circle narrowed to owners in `deadWardenItems` → the "receives the advice" half red, 96 of 107; the "does not get the turn back" half stayed green.
- the successor hint returning code 2 instead of 0 → the "does not get the turn back" half red, 88 of 107; the "receives the advice" half stayed green.

A single probe reddening both halves would have meant the two were never separated. Neither does.

**Gates of this acceptance, on the merged tree of this commit.** `npx github:Velklish/backslop#v0.8.0 gates --keep-going` exit 0 — gates 4, green 4: `npm test` code 0 over 69 of 69 test files (2201 of 2201 style checks, four more than the previous slice, which is exactly the four checks added here; 880 `node:test` — 871 pass, 0 fail, 9 todo); `backslop lint` code 0, no errors, one warning; `npm run audit` code 0, clean; `npm run pins` code 0.

**Review.** Three findings landed on this card, all minor and all closed. Two are the same defect caught twice: the reference described the circle as wider than the predicate holds — first "every session with an identity", corrected to "not already on the bus"; then the enumeration of what the predicate holds back listed three doors where the code has four, corrected by naming the fourth. The third removed a redundant conjunct from a check, and carried a probe of its own to show the simplification did not weaken it: with the successor hint mutated to return code 2, the simplified check still goes red.

**What is left open.** No probe stands behind the documentation edits of the two review rounds — they change text, not behaviour, and the two probes above were not re-run for them. The card's own wording of the circle is left as it was filed; the correction lives in the reference and in this result, where a reader looking for the rule will find it.

**Documentation in the same pass.** `docs/reference/01-overview.md` § Warden, `docs/reference/03-cli.md` § Guard and warden, `CHANGELOG.md`.
