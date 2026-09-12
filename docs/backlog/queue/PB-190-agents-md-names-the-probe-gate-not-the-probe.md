# PB-190 · AGENTS.md requires a mutation probe but never names the tool that runs one, so a participant hand-rolls it

- **Order:** 40
- **Scope:** `AGENTS.md` repository-local process rules after the generated backslop block, [guides/contributing](../../guides/contributing.md) § the probe
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

## Decision and change

The generated backslop block is deliberately unchanged. It occupies lines 1–19 of
`AGENTS.md`, between `backslop:start` and `backslop:end`; `PB-95` measured that `backslop init`
rewrites that block and removes a manual edit placed inside it. The durable fix is the
repository-local `## Mutation probes` section at lines 21–23, outside the generated block. It
names `npm run probe`, says to run it after the change is committed, records snapshot restore
rather than Git restore, and points to the guide for the four outcomes and input forms.

This boundary is measured in the file itself: `## Comments` has already lived outside the block
and survived prior regeneration. The rule therefore belongs in the repository-owned part, while
the generated block remains owned by the backslop package. The guide is not copied into
`AGENTS.md`; the short bridge names the executable and its safety boundary.

## Sweep result

A full sweep found exactly one obligation/tool gap in this rules file: gate 4 required a mutation
probe but did not name `npm run probe`. The other executable obligations name their `npx
github:Velklish/backslop#v0.6.0` command in the generated block. The count is a count of
obligations whose executor was only in documentation, not a count of commands in the file.

## Verification

The repository-local rule is now visible without opening the guide. The existing guide remains the
canonical source for the four probe outcomes and `--mutate`/`--stdin-patch` forms. The successful
mutation probes for this run are recorded in the worker report; the no-op probe was refused rather
than counted as evidence.

## What remains open

The upstream generated backslop template still does not name `npm run probe`, and this task does
not change that foreign generator. A future `backslop init` should preserve the local section
because it is outside the generated block, but other repositories will need their own local bridge
or an upstream template change. This card remains in the queue for the approver; it is not archived
here.

## Out of scope

- `scripts/mutation-probe.mjs` itself: it works and its refusals are correct.
- The consumer's own `AGENTS.md`: it has no `npm run probe`, and the order its probe follows is
  stated there rather than here. A participant working in the consumer was asked the same question
  in the same run and quoted both of its rules correctly, so the consumer does not show this defect
  today.
