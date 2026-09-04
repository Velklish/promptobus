# promptobus documentation

The canonical project documentation. For current work, use `npx github:Velklish/backslop#v0.3.0 status`; for project direction, see [ROADMAP.md](ROADMAP.md); for why the system is arranged this way, see the ADRs in the table below.

| Document | Topic | Status |
|---|---|---|
| [reference/](reference/README.md) | Subsystem reference: how the current code works | Living |
| [GLOSSARY.md](GLOSSARY.md) | Normative terminology: one concept, one name | Living |
| [ROADMAP.md](ROADMAP.md) | Direction and goals; tasks are in the backlog | Living |
| [backlog/](backlog/README.md) | Task tracker: one file per task, status is the directory, summary is `npx github:Velklish/backslop#v0.3.0 status` | Living |
| [archive/](archive/README.md) | Closed tasks: task definition and result in separate files | Living |
| [adr/adr-001-process.md](adr/adr-001-process.md) | Tasks and decisions are managed with backslop | Accepted |

## Cross-cutting principles

1. **An undocumented change is incomplete.** Update the reference, subsystem README, and CHANGELOG in the same pass as the code.
2. **An accepted decision is not edited; it is superseded.** A new decision on the same question gets a new ADR; the replaced ADR retains a “superseded by ADR-NNN” note.
3. **Use only terms from the glossary.** If a required name is missing, propose it rather than silently inventing it.
4. **Evidence is stronger than intuition.** Put a number, file path, or command output in task definitions, results, and ADRs; state unverified claims as hypotheses.

Create a new ADR with `npx github:Velklish/backslop#v0.3.0 adr <slug>` **and add a row to the table above**: without the row, `npx github:Velklish/backslop#v0.3.0 lint` fails.
