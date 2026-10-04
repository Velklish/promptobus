# Reference

How promptobus works today — from the code, not intention. Intent and rationale are in [ADRs](../README.md); this reference describes only the behaviour of the running version. It is organised by subsystem so each file can be edited independently. The “Scope” field of tasks links here.

| Section | About |
|---|---|
| [01-overview.md](01-overview.md) | Package surface, store home, MCP tools, entry points |
| [02-host.md](02-host.md) | `PromptobusHost`, standalone host, session identity, `legacyLayout()` |
| [03-cli.md](03-cli.md) | Commands, harness flags, warden and guard |
| [04-protocol.md](04-protocol.md) | Addresses, message types, engine, artifacts, when a new record field can be sent, and what `send` refuses in a handover record |
| [05-drivers.md](05-drivers.md) | Harness driver contracts and what was measured on each binary |
| [reporter-channel.md](reporter-channel.md) | Human questions to the retained read-only Codex reporter |

The [contributing guide](../guides/contributing.md) describes the verification gates; `npm run audit` also enforces the English authoring claim in the [roadmap](../ROADMAP.md).
[test/docs-links.test.mjs](../../test/docs-links.test.mjs) resolves every tracked Markdown link in the checkout, in the files `npm pack` ships and at the skill paths `install` writes. `npm run docs-links:external` classifies an auth, rate-limit or transport failure as unverified and is not a gate. Task links and delivery misses are held by [the baseline](../../test/fixtures/docs-links-baseline.json), which can only shrink.

The publicity audit checks tracked text and packed-tarball text for absolute owner-home paths. Five named synthetic literals in four fixtures are removed before matching; other paths in those files remain findings. Live cards and cleaned archive records use workspace-relative wording. The organization's identity — the `ORGANIZATION` list in `scripts/audit-public.mjs` — is a finding in every tracked text file and packed entry, with no directory exempt. Cyrillic is read the same way: it is a finding in any tracked text file or packed entry unless a snapshot named in `AUTHORING_SNAPSHOTS` or a reasoned `english-authoring` region outside the runtime paths excuses it.

Consumer documentation states a contract, a measurement with its version and date, or the code it rests on. The set is the list in [test/docs-task-independence.test.mjs](../../test/docs-task-independence.test.mjs): the root readers, the glossary, the roadmap, the guides, the reference, the skills, the project skill tree and the fixture READMEs. Architectural decisions are outside that list.

A `.json`, `.jsonl` or `.txt` file that the set names concretely must be tracked. The exceptions are a template that spells its variable part (`gates-<slug>.json`, `handover-*.json`), a bare product file name such as `promptobus.json`, a product location from the test's `productLocations` list, and the gate-record naming examples of [04-protocol § Artifacts](04-protocol.md#artifacts). A concrete run capture, such as a named gate record of one run or a file under `.promptobus/tasks/`, is refused.

**Detection and stripping read one token boundary, from one source.** `TOKEN_STOP` in `scripts/audit-public.mjs` says where a path token ends — whitespace, a quote, an angle bracket — and it builds both the detector's character classes and the `isPathCharacter` the exemption uses to decide whether a literal is the whole token. A literal is removed only when nothing on either side of it would have continued the path; an exempt prefix followed by anything the detector accepts is still a finding. Two grammars over the same text drifted once already: the detector took `~` into a child path while the stripper did not, so a longer path on an exempt prefix had its prefix removed and reported nothing.
