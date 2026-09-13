# ADR-014: MCP session identity is a bound driver record

**Status:** Accepted
**Date:** 2026-09-13
**Deciders:** the run's worker under the assignment's delegated decision on the proof shape. **Not reviewed by the owner**: the line distinguishes implementation authority from an owner decision.

## Context

The direct worker–approver route from [ADR-013](adr-013-approver-is-a-fourth-addressed-participant.md)
is intentionally fail-closed. Its sender must already be registered in the target task and
the calling session must hold that address. The MCP adapter supplied the latter only through
`DriverOptions.identityVar`.

That member cannot answer on every path. A measured Codex MCP child receives eleven generic
variables — `HOME LOGNAME PATH PWD SHELL SHLVL TERM TMPDIR USER _ __CF_USER_TEXT_ENCODING`
— and no harness session variable. The old integration test replaced that real shape with
`CLAUDE_CODE_SESSION_ID`, so 109/109 checks passed while every real Codex direct send would
reach the existing “calling harness supplied no session identity” refusal.

Codex already puts `PROMPTOBUS_CODEX_SESSION`, an absolute pointer to its session record, in
the generated bus MCP entry. Cursor gives the same kind of pointer to its session but replaces
an MCP child's environment, so its generated entry must carry the pointer explicitly. Both
records share `home`, `task` and `address`; their session-id fields differ
(`threadId` and `chatId`). The id also has a lifecycle: a Codex record is written before
the holder starts, and `threadId` is patched after `thread/start`. An MCP child can
therefore connect while its pointer is valid and its id is still null.

A session writer can persist the host's `home` through a symlink while process identity
canonicalizes that same path. Comparing those strings would reject an honest record for
the same physical bus. Normalization therefore belongs at the read boundary rather than
only in current writers: records already on disk and records written by another compatible
writer receive the same check.

## Options

**A — add one required record descriptor to the driver contract.** Each driver declares the
pointer variable and id field, or `null`. The registry reads the record and applies one
home/task/address proof rule. Cost: one filesystem read when an MCP tool call refreshes
identity, and every driver must answer one more required member.

**B — add a driver operation that resolves its own MCP identity.** This keeps record fields
private, but duplicates the security-critical binding check in every driver. A driver could
return an id without proving the same task or address, and the common route could not tell.

**C — inject the raw harness id as another environment variable.** This makes the MCP child
look like the command path, but the id is not known when Codex's MCP config is written. It
would also create a second value beside the record and a drift rule for deciding which one
is authoritative.

**D — remove or weaken the direct-route identity gate.** This makes the call work by letting
an unproven process borrow a registered address. It reverses ADR-013's boundary and is
rejected.

## Decision

Choose A. `DriverOptions.mcpIdentity` is
`{ recordVar: string, idField: string } | null`, beside `identityVar` but answering a
different path. Codex declares `PROMPTOBUS_CODEX_SESSION`/`threadId`; Cursor declares
`PROMPTOBUS_CURSOR_SESSION`/`chatId`; Claude declares `null` because its current MCP
path uses the ordinary harness identity.

The registry considers the record proof only when the environment supplies no command-path
identity candidate. A record proves a session only when its id is non-empty, its `home`
and the MCP process's declared home resolve through the same physical-path normalizer,
and its `task` and `address` match exactly. Path normalization applies only to `home`:
task ids and addresses have closed grammars and no path aliases. Missing, unreadable,
stale or differently bound records produce no identity, so the existing route refusal
remains. Two valid record proofs are contested and refused, the same rule ADR-010 applies
to two environment claimants.

The MCP connection resolves its stable coordinates at handshake, then refreshes identity
for every `tools/call`. This lets a record gain its harness id after the child connected
without allowing a tool call to rely on the earlier null. Task selection remains per call,
as before; the proof is bound to the MCP process's declared task rather than to whichever
foreign task an argument asks to reach.

The descriptor is data rather than a per-driver function because the persisted records
already share the three binding fields. Only the pointer variable and id field vary by
harness. Keeping the comparison in the registry makes that one invariant testable and
prevents a driver from silently weakening it.

## Consequences

- Real-shape Codex and Cursor MCP children can use direct worker–approver traffic when their
  session holds the registered address.
- Cursor's generated bus MCP entry now carries its session-record pointer explicitly; the
  harness's replaced child environment no longer loses it.
- Canonical and symlink spellings of one existing home prove the same binding; another
  physical home, task or address does not.
- Removing the pointer or presenting a record before its id exists leaves the route closed.
- A future harness must declare both identity paths independently. It can use
  `mcpIdentity: null`, but cannot disappear from the contract by omission.
- Record field renames now cross a declared contract. Contract and integration tests cover
  both production record shapes and the measured eleven-variable child environment.
- [ADR-010](adr-010-session-identity-is-a-driver-member.md) remains in force for commands a
  session runs; this ADR fills the MCP-child path it explicitly left unanswered.
