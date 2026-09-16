# PB-190 · Result

**Closed 2026-09-16, completed for this repository.** `AGENTS.md` now names the tool the rule demands: the "Mutation probes" section at `:21-23` states that test changes use `npm run probe` after the change is committed, and that the restore comes from the pre-mutation snapshot rather than from Git. The local section sits outside the generated backslop block, so a future `backslop init` preserves it. Guards for the local rule landed in `31d6dbd`, `a4e542c` and `941a6b9`.

**Verification.** `grep -n "probe" AGENTS.md` on `main` at `578cd1c` → the rule at `:13` and the section that names `npm run probe` at `:23`. `npx github:Velklish/backslop#v0.8.0 lint` exit 0.

**What is not closed by this, and where it moved.** The upstream generated template still names the obligation without the tool — `backslop`, `templates/agents-section.md:13`: "Правку теста проверяй мутационной пробой: сначала коммит, потом проба". That is a foreign repository's generator and cannot be fixed from here; every repository seeded by it needs its own local bridge until then. Carded in backslop as `BS-58`.

**Documentation in the same pass.** Not required — `AGENTS.md` is the documentation this card changed.
