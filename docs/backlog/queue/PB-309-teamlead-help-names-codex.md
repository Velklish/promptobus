# PB-309 · Name the Codex teamlead in the spawn help and the orchestration skill

- **Order:** 590
- **Scope:** [03-cli § Spawn](../../reference/03-cli.md#spawn)
- **Created:** 2026-09-27
- **Dependencies:** none
- **Cost:** major

## Context

Release 0.20.0 admits a Codex teamlead at the install root under `full-access`. The code, `README.md` and `docs/reference/03-cli.md` say so. The terminal help of `spawn --teamlead` and the shipped orchestration skill still say the opposite. A consumer's re-pin review found this on 2026-09-27. The technical-writer pass of 0.20.0 did not cover CLI help or skills.

Evidence: the help names only Claude Code and says Codex is refused.

<!-- quote:../../../lib/cli.js -->
  ${cmd} spawn --teamlead --brief <file> --task <root> [--slug <s>]
            [--strategy <s>] [--harness claude] [--model <m>] [--effort <e>] [--dry-run]
                              lifts a child-task orchestrator at the install root on Claude Code;
                              Cursor and Codex are refused before start
<!-- /quote -->

The code refuses Cursor and admits Claude Code and Codex:

<!-- quote:../../../lib/spawn.js -->
  if (opts.harness === 'cursor') throw new GateError(`--harness cursor: ${cursorRefusal}`);
  if (opts.harness && !['claude', 'codex'].includes(opts.harness)) {
    throw new GateError(`--harness ${opts.harness}: teamlead lift is supported only on Claude Code and Codex`);
  }
<!-- /quote -->

`skills/orchestrate/SKILL.md` shows `[--harness claude]` in its teamlead usage line and says "The teamlead runs at the install root on Claude Code." The Codex teamlead's `--permission-mode full-access` goes through its own path in `planTeamlead`, outside the driver's `permissionModes`. Neither the help nor the skill names it.

## Work to do

- The `spawn --teamlead` help names both admitted harnesses, the Cursor refusal, and `--permission-mode full-access` for a Codex teamlead.
- The orchestration skill's usage line and teamlead paragraph say the same.
- A check ties the help's harness list to the list `planTeamlead` admits, so the next change of admission turns it red.

## Out of scope

- A change of which harnesses a teamlead may use.
- The writer-pass scope, filed separately.

## Verification

- The new check is red on the current help and green after the fix; a mutation probe that restores `[--harness claude]` turns it red.
- `03-cli.md`, `README.md`, the help and the skill agree on the admitted harnesses.
