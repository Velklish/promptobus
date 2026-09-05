# Glossary

The normative vocabulary for promptobus. Project texts use only names from this glossary: one concept, one name. When a second spelling appears, either add it to “Retired terms” as a replacement or remove it from the text.

The “Term” column gives the spelling for prose; EN is the name in code and English text. Evidence identifies where the term lives: a file path, table, event, or document. A term without evidence is a hypothesis and is marked `[?]` until the owner confirms it.

## Terms

| Term | EN | Definition | Evidence |
|---|---|---|---|
| host | host | Declared workspace interface. The caller passes it into the bus on every call that needs a workspace. | `src/host.ts` (`PromptobusHost`) |
| standalone host | standalone host | Host built from the current directory, Git, and `promptobus.json`. It does not know another product's layout. | `src/standalone.ts` (`createStandaloneHost`) |
| task | task | On-disk unit of work: title, status, participants, mail, and artifacts. | `schemas/v1/task.schema.json`, `src/v1/model.ts` |
| mailbox | mailbox | Unread messages for one participant. Reading moves them to history. | `src/mcp/tools.ts` (`promptobus_mailbox`) |
| participant | participant | Address on a task: `orchestrator`, `worker:<slug>`, or `reviewer:<slug>`. | `src/protocol.ts` (`isAddress`) |
| orchestrator | orchestrator | Session that owns the task mailbox and routes work. | `src/protocol.ts` (`ORCHESTRATOR`) |
| worker | worker | Session that edits one git worktree and reports on the bus. | `src/protocol.ts` (`workerAddress`) |
| reviewer | reviewer | Read-only session that inspects a diff. | `src/protocol.ts` (`reviewerAddress`) |
| harness | harness | Agent runtime a driver talks to. This CLI ships `claude`, `cursor`, and `codex`. | `lib/drivers.js`, `lib/driver-claude.js` |
| driver | driver | Adapter that starts, inspects, wakes, and stops one harness. | `src/driver.ts` |
| warden | warden | Per-task listener that wakes a participant when mail arrives. | `lib/cli.js` (`warden`), `lib/warden.js` |
| guard | guard | Stop-hook helper. It blocks ending a turn while the mailbox still has unread mail. | `lib/cli.js` (`guard`) |
| artifact | artifact | File copied into the task store and attached to a message. | `src/mcp/tools.ts` (`artifactPath`) |
| message | message | Typed bus payload. Types: `task`, `status`, `question`, `answer`, `artifact`, `result`, `review`. | `src/protocol.ts` (`MESSAGE_TYPES`) |
| worktree | worktree | Isolated git checkout a worker edits. The main tree stays untouched. | `lib/worktree.js` |
| legacy layout | legacy layout | Former store location the host may declare. `null` means there is nothing to migrate. | `src/host.ts` (`legacyLayout`) |
| hook | hook | Project-level harness callback for bus feedback and the loop guard. | `src/hooks.ts` |
| harnesses field | harnesses | Array in `promptobus.json` written by `promptobus install`: the last installed hook list. Not the same as `tools`. | [guides/install.md](guides/install.md) |
| claim | claim | Take ownership of the orchestrator mailbox after the previous session dies. | `src/mcp/tools.ts` (`claim`) |
| store | store | On-disk home of tasks, usually `<workspace>/.promptobus`. | `src/v1/layout.ts` (`ROOT_DIR`) |
| strategy | strategy | Named priority of quality, speed and subscription spend a routed run is picked by: `quality`, `balanced`, `speed`, `economy`. `auto` is a skill decision, never a CLI value. | [adr-003-model-routing.md](adr/adr-003-model-routing.md) |
| model catalog | model catalog | The maintainers' rating of tuples, shipped with the package. Only rated tuples enter automatic selection. | [adr-003-model-routing.md](adr/adr-003-model-routing.md) |
| tuple | tuple | The unit of the catalog and of a routing decision: `role + harness + model + effort`, with a stable id. | [adr-003-model-routing.md](adr/adr-003-model-routing.md) |
| availability snapshot | availability snapshot | What the local account can run right now, per harness: state `available`, `exhausted`, `unavailable` or `unknown` with a reason code and `checkedAt`. | [adr-003-model-routing.md](adr/adr-003-model-routing.md) |
| subscription limit | subscription limit | The remaining allowance of a harness account in its own windows. Unknown is a state, not zero: it is penalised, never blocking. | [adr-003-model-routing.md](adr/adr-003-model-routing.md) |
| overlay | overlay | A JSON layer above the catalog that changes weights, ratings, allow/deny rules or PAYG policy. The host names the layers and their order. | `src/host.ts` (`routingPaths`) |

## Retired terms

| Do not use | Use | Why |
|---|---|---|
| singleton host | host | The contract forbids a process-wide host. Pass a host on each call. |
| inbox | mailbox | The MCP tool and the CLI talk about a mailbox. `inbox/` is a store directory, not the prose name. |
