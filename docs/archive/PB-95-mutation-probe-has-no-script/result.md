# PB-95 · Result

**Closed except one bullet that cannot be executed in this repository.** `npm run probe --
<file> (--mutate s/<js-regexp>/<replacement>/[gi] | --stdin-patch) [--run <command>]` refuses on a
dirty tree and names what is dirty, snapshots, mutates, runs, restores from the snapshot and runs
again. Four outcomes are kept apart: red-then-green is the only pass; a mutation that changed
nothing is a refusal; a check that stays green **with** the mutation is reported as not seeing the
file; a dirty tree is refused before anything is touched.

**The restore comes from a snapshot and never from git** — that is the subject, not an
implementation detail, because a git restore is exactly what lost the work the script exists to
protect, three times in two days. For the same reason `--stdin-patch` refuses a patch naming any
file other than the one probed, reading **both** sides of the patch: a rename or a delete names
its victim on `---`.

`--run` is why it is not a test-only tool. The loss that returned this card to the queue happened
while probing a **gate** — `check-pins.mjs` against mutations of `package.json` and `ci.yml` —
where a refusal inside a test-shaped probe would never have been called.

Verified: `test/mutation-probe.test.mjs`, 9/9, which builds a throwaway repository with `git init`
and runs a copy of the script there, so the checks depend on neither this tree's cleanliness nor
its files. **That test earned itself on the first run**: it found that the script shelled out to
`sed`, which the suite's PATH does not carry — `spawnSync sed ENOENT` on three of four cases —
while the same script had worked four times running by hand. The substitution moved into node,
which also settles the BSD/GNU split on `sed -i`.

**The bullet that stays open, and it is not a documentation gap:** `AGENTS.md:13` still describes
the four manual steps and cannot be corrected here. The line sits inside the `backslop:start`
block; measured — the line was edited with a marker, `init` reported `AGENTS.md: backslop block
updated` and the marker was gone — and CI runs `init` on every push. Filed upstream as `BS-54`.
Until it lands, an agent reading the block gets the old procedure and an agent reading the guide
gets the script.

---
