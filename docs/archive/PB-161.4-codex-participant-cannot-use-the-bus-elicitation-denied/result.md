# PB-161.4 · Result

**Closed 2026-09-12, completed — with the live verification that the closure of PB-41 had owed.**
The defect was not what the card named it: a Codex participant does reach the bus, and lost its
calls on codex-cli's **own per-call approval**, which arrives over the elicitation channel and
which the holder was declining as a question for a person.

The difference between the two stands was established before any code changed: the server name is
the host's label (`${host.commandName}-`), and behind it stood different mechanism versions and
different SOURCES of the participant's configuration — an override on top of the personal
`~/.codex` at v0.6.0 against an isolated `CODEX_HOME`. `approvalPolicy`, the transport, the tool
set and the `mcp_servers` keys were each ruled out with evidence: no configuration carries an
approval key. What codex-cli asks was read out of the 0.146.0 binary's strings and the vendored
`ServerRequest` schema.

The decision is written as a **positive allow-list**: an automatic accept is issued only when the
marker `_meta.codex_approval_kind === "mcp_tool_call"`, `mode === "form"` and a schema upstream
treats as message-only (`null`, or `type: "object"` with an explicitly present empty `properties`)
all hold together. Everything else is declined, including shapes not yet known. A missing required
field is distinguished from an explicit `null` and fails closed. `serverRequestSummary` reports the
shape fields `kind` and `schema` rather than the message, and the checks moved from the deciding
function's return value to the REPLY that goes on the wire.

**Verification.** One paid live turn, 2026-09-12: three bus calls, three
`approval allow … kind=mcp_tool_call schema=true`, three `item/completed … completed`, zero
`failed`, and the reviewer's `result` in `inbox/orchestrator`. Mutation probes, each restored:
removing the split 7/16; an empty `content` 12/16; truthiness instead of the string 10/15;
`String()` before the comparison 19/20; the marker without the schema check 23/27; removing `mode`
32/35. `codex-elicitation` 35/35 on the merged tree; `npm test` 62/62 files, exit 0.

**Which copy produced that live turn, established after the fact rather than assumed.** The run
went on a separate stand in `$TMPDIR` — its own `promptobus.json`, its own `.promptobus`,
`PROMPTOBUS_CODEX_HOME` inside the sandbox — raised by `bin/promptobus.js` of the working branch.
That the change itself ran, and not the installed copy, is proved by the **shape of the journal
line**: `approval allow … kind=mcp_tool_call schema=true`. The installed 0.6.0 cannot print it —
its elicitation branch refuses unconditionally (`allow: false, why: 'the participant has no person
to answer an elicitation'`) and carries neither `kind=` nor `schema=` anywhere in its output. The
resolve chain that explains WHY the branch copy ran is reasoning, not evidence: the sandbox is
gone and no `ps` of that moment was kept. The line's shape is the fact, and it is enough.

**Documentation in the same pass.** `docs/reference/03-cli.md` § Review and the Codex driver's
header carry the approval shape and the allow-list; `CHANGELOG` records it.

**What the card does not close.** The request shape was read from the codex-rs sources
(`mcp_server_elicitation.rs`, tag `rust-v0.146.0`) and from the binary's strings — **neither half
was observed on the wire**, because the holder does not write the payload and that edition stands.
Why the personal codex home does not raise the approval question at all is not established: both
sides are measured, the suppressing mechanism is not. The keys `default_tools_approval_mode` and
`tools.<tool>.approval_mode` (`auto|prompt|writes|approve`) were found and **deliberately not
applied**: `auto` against `approve` does not follow from the help text, and they would treat a
cause that is not established.
