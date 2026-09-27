# promptobus documentation

The canonical project documentation. For current work, use `npx github:Velklish/backslop#v0.10.1 status`; for project direction, see [ROADMAP.md](ROADMAP.md); for why the system is arranged this way, see the ADRs in the table below.

| Document | Topic | Status |
|---|---|---|
| [../README.md](../README.md) | What Promptobus is, why it exists, install, first commands | Living |
| [guides/install.md](guides/install.md) | Package install and `promptobus install --harnesses …` | Living |
| [guides/hooks-and-trust.md](guides/hooks-and-trust.md) | Hooks, trust, and troubleshooting for Claude Code, Cursor, and Codex | Living |
| [guides/model-routing.md](guides/model-routing.md) | The model catalog, the overlay layers, and the file a person copies | Living |
| [guides/contributing.md](guides/contributing.md) | Contribution workflow through backslop | Living |
| [guides/releasing.md](guides/releasing.md) | How a release is cut, including the technical-writer pass | Living |
| [reference/](reference/README.md) | Subsystem reference: how the current code works | Living |
| [GLOSSARY.md](GLOSSARY.md) | Normative terminology: one concept, one name | Living |
| [ROADMAP.md](ROADMAP.md) | Direction and goals; tasks are in the backlog | Living |
| `backlog/` | Task tracker: one file per task, status is the directory, summary is `npx github:Velklish/backslop#v0.10.1 status` | Living |
| `archive/` | Closed tasks: one `LOG.md` journal line each, the body in history; a task not yet folded keeps its definition and result in separate files | Living |
| [adr/adr-001-process.md](adr/adr-001-process.md) | Tasks and decisions are managed with backslop | Accepted |
| [adr/adr-002-standalone-host-contract.md](adr/adr-002-standalone-host-contract.md) | The bus does not know the workspace; the caller passes a host | Accepted |
| [adr/adr-005-ten-point-scale-absolute-bands-calibrate.md](adr/adr-005-ten-point-scale-absolute-bands-calibrate.md) | Model routing: five strategies including balance, subscription windows, and ratings on a 1–10 absolute scale with local calibration | Accepted |
| [adr/adr-006-guard-hook-ownership-by-command-signature.md](adr/adr-006-guard-hook-ownership-by-command-signature.md) | Guard hook ownership by rendered command signature; no committed manifest | Accepted |
| [adr/adr-008-codex-reviewer-working-directory.md](adr/adr-008-codex-reviewer-working-directory.md) | A Codex participant runs in an isolated `CODEX_HOME`; a reviewer works in a mechanism-owned directory trusted by realpath, and the tree under review is never trusted | Accepted |
| [adr/adr-009-reviewer-resolves-no-discrepancy.md](adr/adr-009-reviewer-resolves-no-discrepancy.md) | A reviewer is given no second immovable artefact: a snapshot-versus-tree discrepancy is handed to the orchestrator unresolved, with the verification command already in the report | Accepted |
| [adr/adr-012-stopping-one-participant-is-a-verb-of-its-own.md](adr/adr-012-stopping-one-participant-is-a-verb-of-its-own.md) | Stopping one participant is a verb of its own — `promptobus stop <address>` — and not a flag on `done` or `dismiss`; an artefact written at birth is erased by nothing but the mechanism that wrote it | Accepted |
| [adr/adr-017-the-owner-gate-is-a-positive-proof.md](adr/adr-017-the-owner-gate-is-a-positive-proof.md) | `promptobus sweep` cleans up after one accepted piece; the owner gate of `done`, `stop` and `dismiss` grants the right only by positive proof | Accepted |
| [adr/adr-018-the-bus-leases-the-machine-for-measurements.md](adr/adr-018-the-bus-leases-the-machine-for-measurements.md) | The bus leases the machine for measurements: `promptobus lease -- <command…>` holds one per-user directory under `/tmp` by the wrapper's pid, a waiter names the holder and gives up at a bound, `status` names holder and waiters, and the worker and approver preambles carry the command | Accepted |
| [adr/adr-019-session-address-per-task-lands.md](adr/adr-019-session-address-per-task-lands.md) | Session identity is a driver member, the address is per task, and a positive binding gates the registered send command | Accepted |
| [adr/adr-020-role-registry-and-declared-pipeline.md](adr/adr-020-role-registry-and-declared-pipeline.md) | Roles and steps come from one registry; the delivery pipeline is declared in `promptobus.json` as one owner step and ordered gate steps of three kinds, lifted by name on a machine precondition | Accepted |
| [adr/adr-021-task-tree-and-governance-routes.md](adr/adr-021-task-tree-and-governance-routes.md) | A task tree of two levels: a root task, child tasks owned by teamleads holding two addresses, a closed route table, peers by explicit link, teamlead and reporter at the install root on Claude Code first | Accepted |
| [adr/adr-022-user-addressee-and-orchestrator-debt.md](adr/adr-022-user-addressee-and-orchestrator-debt.md) | The person is the address `user`, asks by `promptobus ask` from a terminal, and the orchestrator owes that question an answer; a model-free digest and a read-only reporter beside it | Accepted |
| [adr/adr-023-install-owns-process-skills.md](adr/adr-023-install-owns-process-skills.md) | `promptobus install` lays out the package's process skills into each harness's project skill location and owns them: drift is a `--check` failure, `uninstall` removes owned files only | Accepted |
| [adr/adr-024-approver-acceptance-in-own-worktree.md](adr/adr-024-approver-acceptance-in-own-worktree.md) | The approver is the fourth addressed role, lifted on Claude Code, Cursor and Codex after a reviewer result, and accepts in its own worktree; Cursor stays refused as a teamlead | Accepted |

## Cross-cutting principles

1. **An undocumented change is incomplete.** Update the reference, subsystem README, and CHANGELOG in the same pass as the code.
2. **The ADR directory holds current decisions only.** A new decision on a question already decided rewrites that question's ADR, keeping its number and the rationale that still holds. A record that no longer governs anything is deleted; its text stays in Git history.
3. **Use only terms from the glossary.** If a required name is missing, propose it rather than silently inventing it.
4. **Evidence is stronger than intuition.** Put a number, file path, or command output in task definitions, results, and ADRs; state unverified claims as hypotheses.

Create a new ADR with `npx github:Velklish/backslop#v0.10.1 adr <slug>` **and add a row to the table above**: without the row, `npx github:Velklish/backslop#v0.10.1 lint` fails.
