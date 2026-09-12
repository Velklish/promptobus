# Reference

How promptobus works today — from the code, not intention. Intent and rationale are in [ADRs](../README.md); this reference describes only the behaviour of the running version. It is organised by subsystem so each file can be edited independently. The “Scope” field of tasks links here.

| Section | About |
|---|---|
| [01-overview.md](01-overview.md) | Package surface, store home, MCP tools, entry points |
| [02-host.md](02-host.md) | `PromptobusHost`, standalone host, `legacyLayout()` |
| [03-cli.md](03-cli.md) | Commands, harness flags, warden and guard |
| [04-protocol.md](04-protocol.md) | Addresses, message types, engine, artifacts |
| [05-drivers.md](05-drivers.md) | Harness driver contracts and what was measured on each binary |

The [contributing guide](../guides/contributing.md) describes the verification gates; `npm run audit` also enforces the English runtime-output claim in the [roadmap](../ROADMAP.md).
The publicity audit checks tracked text and packed-tarball text for absolute owner-home paths. Four named synthetic test fixtures are exempt for their stated inputs; live cards and cleaned archive records use workspace-relative wording.
