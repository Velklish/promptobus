# Reference

How promptobus works today — from the code, not intention. Intent and rationale are in [ADRs](../README.md); this reference describes only the behaviour of the running version. It is organised by subsystem so each file can be edited independently. The “Scope” field of tasks links here.

| Section | About |
|---|---|
| [01-overview.md](01-overview.md) | Package surface, store home, MCP tools, entry points |
| [02-host.md](02-host.md) | `PromptobusHost`, standalone host, session identity, the host integration entry point |
| [03-cli.md](03-cli.md) | Commands, harness flags, shared HTTP service, warden and guard |
| [04-protocol.md](04-protocol.md) | Addresses, message types, engine, artifacts, when a new record field can be sent, and what `send` refuses in a handover record, including a performed probe with no `coverage` |
| [05-drivers.md](05-drivers.md) | Harness driver contracts, pinned Codex executable and private-home system-skill ownership, and what was measured on each binary |
| [reporter-channel.md](reporter-channel.md) | Human questions to the retained read-only Codex reporter |

The [shared MCP request matrix](../evidence/shared-mcp-request.md) maps the bus and reviewer-file session responses, proof checkpoints and receipt lifetimes to their witnesses.

The [handover record reference](04-protocol.md#the-handover-record) distinguishes the probe wrapper's pass, failure and refusal statuses from the mutated command's `mutatedRunExit`.
It also describes the single-object and list forms of `checks.mutationProbe`, and how `send` and `review` handle each list entry.

A performed probe's boundary is the sentence [The handover record](04-protocol.md#the-handover-record) states:

<!-- quote:04-protocol.md -->
A performed mutation probe carries `coverage`: `establishes` names what the reddened verdicts establish, and `doesNotEstablish` names what they do not.
<!-- /quote -->

The [contributing guide](../guides/contributing.md) describes the verification gates; `npm run audit` also enforces the English authoring claim in the [roadmap](../ROADMAP.md).

The managed-retirement fixture checks the shutdown boundary with an actual held
worker observation and confirmed service exit; see
[suite isolation](../guides/contributing.md#suite-isolation).
The same section describes the keyed-publication diagnostics and the history and reviewer stdio portability checks.

<!-- quote:03-cli.md -->
Pending lifetime observations remain active work after client revocation.
The owner refuses shutdown until those observations settle.
<!-- /quote -->

`npm run test:local -- --base <commit>` selects local iteration groups from an
explicit Git base plus current dirty input. It reports selected and omitted groups
and test files, and unknown or shared inputs fall back to the full suite. `--list`
prints the plan without execution. The runner retains its isolation and nonzero
exit codes; `npm test`, acceptance gates and CI retain full acceptance coverage.
The path mapping and fallback rules are in
[Local test groups](../guides/contributing.md#local-test-groups).

`npm run test:one -- <file.test.mjs>` builds both TypeScript projects and
runs only the named test with the isolated test home. It refuses orphaned
JavaScript and declarations for TypeScript, ESM and CommonJS sources. The
runtime project includes all three source families under `lib/` and `bin/`,
including unreferenced modules. See
[Suite isolation](../guides/contributing.md#suite-isolation) for the separate
delivery-order and Cursor session-identity checks.

The POSIX native launch fixture creates its FIFO with `mkfifo` through the
sealed test `PATH`. Integration preflight checks access to that utility before
starting the suite.

Use the existing `promptobus-test-` prefix for new suite fixture directories in
the system temporary directory. The suite sweep uses that prefix to recognize
stale test directories and checks for an active owner before removal.

[test/docs-links.test.mjs](../../test/docs-links.test.mjs) resolves every tracked Markdown link in the checkout, in the files `npm pack` ships and at the skill paths `install` writes. Package inventory and the role-instruction consumer use owned snapshots so npm preparation cannot rewrite the runtime used by parallel tests; original bytes and timestamps are checked. `npm run docs-links:external` classifies an auth, rate-limit or transport failure as unverified and is not a gate. Task links and delivery misses are held by [the baseline](../../test/fixtures/docs-links-baseline.json), which can only shrink.

The publicity audit checks tracked text and packed-tarball text for absolute owner-home paths. Five named synthetic literals in four fixtures are removed before matching; other paths in those files remain findings. Live cards and cleaned archive records use workspace-relative wording. The organization's identity — the `ORGANIZATION` list in `scripts/audit-public.mjs` — is a finding in every tracked text file and packed entry, with no directory exempt. Cyrillic is read the same way: it is a finding in any tracked text file or packed entry unless a snapshot named in `AUTHORING_SNAPSHOTS` or a reasoned `english-authoring` region outside the runtime paths excuses it. Remove a named snapshot in the same change that removes its last matching text, including when a card is archived. The audit reports unused entries as stale.

Consumer documentation states a contract, a measurement with its version and date, or the code it rests on. The set is the list in [test/docs-task-independence.test.mjs](../../test/docs-task-independence.test.mjs): the root readers, the glossary, the roadmap, the guides, the reference, the skills, the project skill tree and the fixture READMEs. Architectural decisions are outside that list.

A `.json`, `.jsonl` or `.txt` file that the set names concretely must be tracked at the referenced path. A bare name in code formatting can refer to a file at the repository root or beside the document; a bare link resolves only beside the document. A same-named file elsewhere does not count. Templates such as `gates-<slug>.json` and `handover-*.json`, documented product locations, and the inline product names and naming examples listed for individual documents are exceptions. An inline exception does not make an untracked link valid. A concrete run capture, such as a named gate record of one run or a file under `.promptobus/tasks/`, is refused.

[The comment length check](../../test/comment-length.test.mjs) uses the same two-line limit for tracked JavaScript and TypeScript in `lib/`, `src/`, `bin/` and `scripts/`. The pending list applies to specific existing runs and cannot grow to admit new script comments. [The publicity refusal test](../../test/audit-public.test.mjs) drives the audit CLI on isolated tracked and packed inputs and checks the exit status and reported findings, not just the detection predicates.

**Detection and stripping read one token boundary, from one source.** `TOKEN_STOP` in `scripts/audit-public.mjs` says where a path token ends — whitespace, a quote, an angle bracket — and it builds both the detector's character classes and the `isPathCharacter` the exemption uses to decide whether a literal is the whole token. A literal is removed only when nothing on either side of it would have continued the path; an exempt prefix followed by anything the detector accepts is still a finding. Two grammars over the same text drifted once already: the detector took `~` into a child path while the stripper did not, so a longer path on an exempt prefix had its prefix removed and reported nothing.
