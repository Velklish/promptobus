# PB-170 · Result

**Closed 2026-09-12, completed as to its subject — and the card's own verification rests on a
premise the measurement refuted.** The flag removes the trust blocker and only that.

`--dangerously-bypass-hook-trust` is a GLOBAL option of codex-cli 0.146.0, and both argv assembly
points put `app-server` first, so the flag was nowhere. One constant, `PARTICIPANT_ARGV`, now
carries argv for the holder and for the driver's plan; `CODEX_DRY_RUN_COMMAND` no longer prints a
command without the flag, and the lift line matches the measurement. The stand
`test/harness-codex.mjs` was taught to answer `exit 2` to the flag placed AFTER the subcommand, the
way the real binary does.

**Verification.** Measured on 0.146.0: `codex --dangerously-bypass-hook-trust app-server --help`
→ 0; `codex app-server --dangerously-bypass-hook-trust --help` → 2;
`app-server --help | grep -ci bypass` → 0. The checks assert the POSITION, not the presence of a
string — `argv.includes(flag)` is green on the broken form too. Mutation probe: the flag moved
behind the subcommand → `codex-participant-argv` 2/4 and `promptobus-driver-codex` 32 red,
including `app-server exited (2)` from the stand. The same pass found and repaired a blindness in
the hygiene gate: `APP_PATTERN` was a literal and stopped matching once the flag stood between the
binary and the subcommand; it is derived from `PARTICIPANT_ARGV` now, and a separate check proves
the pattern SEES a live process (probe with the old literal: `found []` against a live pid).

**Documentation in the same pass.** `docs/reference/03-cli.md`, the Codex driver's header and
`ADR-007` were brought to one answer; `CHANGELOG` records the flag and its position.

**The half of the verification that was not reached, and why it is not held open here.** The card
asked that a lifted participant run the memory hook and the turn guard, shown by hook events in the
holder's journal. On a live reviewer, `grep -c "hook/started"` = **0**. That criterion assumed
trust was the only gate; the measurement refuted the assumption rather than the work. Whether hooks
run at all is a different subject and is carried by **`PB-185`**, where the enablement question is
open with its evidence. For a worker it was not measured at all.
