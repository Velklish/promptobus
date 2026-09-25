# Reference

How promptobus works today — from the code, not intention. Intent and rationale are in [ADRs](../README.md); this reference describes only the behaviour of the running version. It is organised by subsystem so each file can be edited independently. The “Scope” field of tasks links here.

| Section | About |
|---|---|
| [01-overview.md](01-overview.md) | Package surface, store home, MCP tools, entry points |
| [02-host.md](02-host.md) | `PromptobusHost`, standalone host, `legacyLayout()` |
| [03-cli.md](03-cli.md) | Commands, harness flags, warden and guard |
| [04-protocol.md](04-protocol.md) | Addresses, message types, engine, artifacts, when a new record field can be sent, and what `send` refuses in a handover record |
| [05-drivers.md](05-drivers.md) | Harness driver contracts and what was measured on each binary |

The [contributing guide](../guides/contributing.md) describes the verification gates; `npm run audit` also enforces the English runtime-output claim in the [roadmap](../ROADMAP.md).
The publicity audit checks tracked text and packed-tarball text for absolute owner-home paths. Five named synthetic literals in four fixtures are removed before matching; other paths in those files remain findings. Live cards and cleaned archive records use workspace-relative wording.

**Detection and stripping read one token boundary, from one source.** `TOKEN_STOP` in `scripts/audit-public.mjs` says where a path token ends — whitespace, a quote, an angle bracket — and it builds both the detector's character classes and the `isPathCharacter` the exemption uses to decide whether a literal is the whole token. A literal is removed only when nothing on either side of it would have continued the path; an exempt prefix followed by anything the detector accepts is still a finding. Two grammars over the same text drifted once already: the detector took `~` into a child path while the stripper did not, so a longer path on an exempt prefix had its prefix removed and reported nothing.
