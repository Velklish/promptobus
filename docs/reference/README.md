# Reference

How promptobus works today — from the code, not intention. Intent and rationale are in [ADRs](../README.md); this reference describes only the behaviour of the running version. It is organised by subsystem so each file can be edited independently. The “Scope” field of tasks links here.

| Section | About |
|---|---|
| [01-overview.md](01-overview.md) | Package surface, store home, MCP tools, entry points |
| [02-host.md](02-host.md) | `PromptobusHost`, standalone host, `legacyLayout()` |
| [03-cli.md](03-cli.md) | Commands, harness flags, warden and guard |
| [04-protocol.md](04-protocol.md) | Addresses, message types, engine, artifacts |
