# PB-190 · AGENTS.md requires a mutation probe but never names the tool that runs one, so a participant hand-rolls it

- **Order:** 50
- **Scope:** `AGENTS.md` (the backslop block, gate 4), [guides/contributing](../../guides/contributing.md) § the probe
- **Created:** 2026-09-12, orchestrator's measurement during the 0912c backlog run
- **Dependencies:** none

## What happens

`AGENTS.md` is the file an agent loads as rules. Its gate 4 says:

> Verify a test change with a mutation probe: commit first, then run the probe.

It names the **obligation** and not the **tool**. `npm run probe` exists —
`package.json` `"probe": "node scripts/mutation-probe.mjs"` — and it is documented, but one level
away, in `docs/guides/contributing.md:24`, which the rules protocol does not make an agent read:

> **`npm run probe` keeps four outcomes apart, and three of them are ones a person cannot be
> trusted to notice by hand.** Red with the mutation and green without it is the only pass. A
> mutation that changed nothing is a refusal — the probe proved nothing, and that is not green. A
> check that stays GREEN with the mutation in place is reported as not seeing the file… A dirty
> tree is refused before anything is touched… The restore comes from a snapshot taken before the
> mutation, never from git — a git restore is exactly what lost the work the script exists to
> protect.

## The measurement

Asked directly during the 0912c run, a Codex participant that had read `AGENTS.md` in full answered:

> Проверил именно AGENTS.md репозитория promptobus. В нём нет ни упоминания `npm run probe`, ни
> правил о том, когда probe отказывает/как восстанавливает снимок … Из относящегося к процессу там
> есть только: «Documentation in the same pass» … и gate «Verify a test change with a mutation
> probe: commit first, then run the probe».

The participant is right about the file, and it had already planned to hand-roll the probe:
corrupt the subject by hand, run the single test, restore by hand. That is the exact procedure the
guide says a person cannot be trusted with — three of the four outcomes it separates are invisible
by eye, and the hand restore is the failure mode that cost this repository work once already.

## Why this is not "add a sentence"

The gap is structural, not a missing word. The rules file states obligations and the guide holds
the tools that discharge them, and nothing connects the two for a reader who only loads the rules —
which is every bus participant, in every harness. The probe is the sharpest instance because its
hand-rolled substitute is actively dangerous, but the class is wider: a gate whose executor lives
only in a guide is a gate the participant re-implements.

## Work to do

- Name `npm run probe` in the `AGENTS.md` gate itself, with the one fact that changes behaviour —
  the restore comes from a snapshot, never from git — and a pointer to the guide for the four
  outcomes. Two lines, not a copy of the guide.
- Sweep the rest of `AGENTS.md` for the same shape: an obligation whose tool is named only in
  `docs/`. Report the count even if it is one; a sweep that finds nothing is an answer.
- Decide whether the participant's own rules bundle should carry the guide section at all, or
  whether the rules file naming the command is enough. That decision belongs with whoever owns the
  rules protocol, not with this card.

## Out of scope

- `scripts/mutation-probe.mjs` itself: it works and its refusals are correct.
- The consumer's own `AGENTS.md`: it has no `npm run probe`, and the order its probe follows is
  stated there rather than here. A participant working in the consumer was asked the same question
  in the same run and quoted both of its rules correctly, so the consumer does not show this defect
  today.
