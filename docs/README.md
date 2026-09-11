# promptobus documentation

The canonical project documentation. For current work, use `npx github:Velklish/backslop#v0.6.0 status`; for project direction, see [ROADMAP.md](ROADMAP.md); for why the system is arranged this way, see the ADRs in the table below.

| Document | Topic | Status |
|---|---|---|
| [../README.md](../README.md) | What Promptobus is, why it exists, install, first commands | Living |
| [guides/install.md](guides/install.md) | Package install and `promptobus install --harnesses …` | Living |
| [guides/hooks-and-trust.md](guides/hooks-and-trust.md) | Hooks, trust, and troubleshooting for Claude Code, Cursor, and Codex | Living |
| [guides/model-routing.md](guides/model-routing.md) | The model catalog, the overlay layers, and the file a person copies | Living |
| [guides/contributing.md](guides/contributing.md) | Contribution workflow through backslop | Living |
| [reference/](reference/README.md) | Subsystem reference: how the current code works | Living |
| [GLOSSARY.md](GLOSSARY.md) | Normative terminology: one concept, one name | Living |
| [ROADMAP.md](ROADMAP.md) | Direction and goals; tasks are in the backlog | Living |
| [TRACKS.md](TRACKS.md) | Triage decisions, subsystem assignments and shared-file execution order | Planning snapshot |
| [backlog/](backlog/README.md) | Task tracker: one file per task, status is the directory, summary is `npx github:Velklish/backslop#v0.6.0 status` | Living |
| [archive/](archive/README.md) | Closed tasks: task definition and result in separate files | Living |
| [adr/adr-001-process.md](adr/adr-001-process.md) | Tasks and decisions are managed with backslop | Accepted |
| [adr/adr-002-standalone-host-contract.md](adr/adr-002-standalone-host-contract.md) | The bus does not know the workspace; the caller passes a host | Accepted |
| [adr/adr-003-model-routing.md](adr/adr-003-model-routing.md) | Model routing: strategies, catalog, availability snapshot, resolver | Accepted |
| [adr/adr-004-subscription-balance.md](adr/adr-004-subscription-balance.md) | Subscription balance: the tier and every window per harness, the `balance` strategy, quality floors per role, overlay lists by union | Accepted |
| [adr/adr-005-ten-point-scale-absolute-bands-calibrate.md](adr/adr-005-ten-point-scale-absolute-bands-calibrate.md) | Ratings on a 1–10 scale with absolute benchmark bands and local calibration proposals | Accepted |
| [adr/adr-006-guard-hook-ownership-by-command-signature.md](adr/adr-006-guard-hook-ownership-by-command-signature.md) | Guard hook ownership by rendered command signature; no committed manifest | Accepted |
| [adr/adr-007-codex-participant-isolated-home.md](adr/adr-007-codex-participant-isolated-home.md) | A Codex participant runs in an isolated `CODEX_HOME`: the owner's auth copied in, mechanism-only MCP in its `config.toml`, the worker worktree trusted by realpath, workspace skills copied into that worktree | Accepted |
| [adr/adr-008-codex-reviewer-working-directory.md](adr/adr-008-codex-reviewer-working-directory.md) | A Codex reviewer works in a directory of its own beside the participant files, trusted by realpath like a worker's worktree; the tree under review is attached as a read and never trusted | Accepted |
| [adr/adr-009-session-identity-is-a-driver-member.md](adr/adr-009-session-identity-is-a-driver-member.md) | Session identity is a driver member (`identityVar`) answering for the session's own commands, injected into the core rather than imported by it; two claimants are refused instead of picked | Accepted |

## Cross-cutting principles

1. **An undocumented change is incomplete.** Update the reference, subsystem README, and CHANGELOG in the same pass as the code.
2. **An accepted decision is not edited; it is superseded.** A new decision on the same question gets a new ADR; the replaced ADR retains a “superseded by ADR-NNN” note.
3. **Use only terms from the glossary.** If a required name is missing, propose it rather than silently inventing it.
4. **Evidence is stronger than intuition.** Put a number, file path, or command output in task definitions, results, and ADRs; state unverified claims as hypotheses.

Create a new ADR with `npx github:Velklish/backslop#v0.6.0 adr <slug>` **and add a row to the table above**: without the row, `npx github:Velklish/backslop#v0.6.0 lint` fails.
