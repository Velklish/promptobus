# PB-161.3 · Result

**Closed 2026-09-12.** Measured, positively, on one paid Codex turn: **Codex reads a project's `.codex/skills` from a directory that is NOT a git repository.** The control run was therefore never needed and never spent.

**The chain, in order, all from the participant's own rollout.** The sandbox is not a repository — `git rev-parse --is-inside-work-tree` answers `fatal: not a git repository (or any of the parent directories)`, verified before the lift, so the condition is "none anywhere up the tree" rather than "no `.git` here". The harness built its own skill-roots table and put the sandbox first, listing the stub among available skills. The model then read the body by the path from that table. It obeyed: the final message opens with the marker.

**Two steps, kept apart on purpose.** The harness enumerates name, description and path; the model reads the body when it wants it. Stated so that nobody later reads this as "the body was injected".

**The stand was built so that only the measured thing could answer.** The host declares no module review skill, so the review prompt takes the built-in procedure and mentions no skill, no skill path and no directory — verified in the dry-run prompt text before anything was spent. Had the prompt named the path, the measurement would have proven delivery by prompt rather than the harness's own discovery.

**Cost:** one turn, 33.9 s, a four-line diff.

**And the same turn found what the card did not ask about.** The reviewer produced a correct review and **could not deliver it**: all four of its bus calls failed identically with `approval deny mcpServer/elicitation/request` → `user rejected MCP tool call`, the fourth being the `promptobus_send` carrying the result. The marker was therefore read off the rollout, not off the bus — **the observable this card names never reached the bus**, and that is said here rather than smoothed over.

The mechanism is one line: `decideApproval` declines `mcpServer/elicitation/request` unconditionally. The judgement is right — there is no person behind a background session. The assumption behind it is not: the suite's own test opens with "the holder declines … so the turn continues". The turn continues; the tool call does not. That line is the closure of PB-41, which removed a **hang** — so PB-41 traded a visible hang for a silent lost report, and a reviewer that finishes having delivered nothing looks like a reviewer with nothing to say.

**The sender was then established free of charge**, without a model: the bus MCP server was started exactly as the participant's `config.toml` starts it — same command, same four environment variables read off the live stand — and driven by a client that **declares the elicitation capability**, so a server wanting one was free to ask. Through `initialize`, `tools/list` and a real `tools/call` of `promptobus_send`: zero server→client requests, the call succeeded, the message landed. So this package neither elicits nor needs to, and the elicitation originates in codex-cli, which attributes it to that server while asking something of its own. **What** it asks is not established — the fields are deliberately unlogged — and "per-call MCP approval" remains the reading the evidence fits, not a measurement. Filed as [PB-161.4](../../backlog/active/PB-161.4-codex-participant-cannot-use-the-bus-elicitation-denied.md).

**Weight, and it is why this matters beyond one card:** `promptobus_send` is the same tool on the same server for a **worker**. If this reproduces beyond the stand, a Codex worker cannot report either, and the premise that a Codex participant is a participant does not hold. Phase 3.5 of the parity effort — lifting the ban on Codex reviewers — was owed exactly this live verification, and this is it, failed.

**No mutation probe.** The pass changed no test and no runtime code; inventing one would be theatre.

**Gates on `ae2d9e6`.** `npm test` exit 0, 55/55 test files; `backslop lint` exit 0; `npm run audit` exit 0, 770 tracked files. No `gates N, green N` summary — the pinned backslop has no such command (exit 1, `unknown command`), so the three commands the `gates` key names were run separately with their own exit codes; the fabricated summary was refused. That gap is [BS-51](https://github.com/Velklish/backslop) in backslop's tracker and [PB-167](../PB-167-raise-backslop-pin/task.md) on this side.

**Left open.** The `git init` control was never exercised — unspent, not confirmed; nothing depends on it, but it is an unmeasured half. The measurement rests on one turn of one version (codex-cli 0.146.0, `gpt-5.6-sol`): the skill-roots table is harness behaviour and can change with a release, which is why the reference names the version.

**Docs in the same pass.** `docs/reference/03-cli.md` § Review and `docs/adr/adr-008-…` § Consequences carry the measurement **and the broken channel side by side** — the first without the second would read as a working reviewer. `CHANGELOG.md`.
