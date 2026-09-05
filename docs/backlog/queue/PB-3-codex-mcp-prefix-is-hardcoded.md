# PB-3 · The Codex MCP key prefix is baked into the package, not asked of the host

- **Order:** 180
- **Scope:** [reference/02](../../reference/02-host.md)
- **Created:** 2026-09-04
- **Dependencies:** none

## Context

`lib/codex-session.js` fixes the prefix as a constant:

```js
export const CODEX_MCP_PREFIX = 'promptobus-';
```

The prefix exists for a good reason, spelled out above that line: the Codex config override merges with the operator's personal file **by field**, so one name carrying two transports fails the whole config load. The prefix moves our entries into a namespace the personal config does not use.

That reason is about collision, not about the word. The word itself is the consumer's identity, and the consumer already declares it — `host.commandName()`. A prefix of `${commandName}-` would give `promptobus-` standing alone and the consumer's own name inside a larger tool, which is what the participant would expect to read in `mcp__<key>__<tool>`.

Found while moving a consumer onto this package: its participants had been seeing one prefix and now see another. The change is harmless — both names avoid the collision equally, and the config key and the prompt are built by the same function, so they cannot drift — but it was a behaviour change decided by a constant rather than by the host, which is where every other piece of consumer identity lives.

Deliberately not done during the migration: `codexMcpName` is a pure function with no host in scope, and its second caller is the driver's phrase table, which does not receive one either. Threading a host through both late in a move would have cost more than the name is worth.

## Work to do

- Give `codexMcpName` the prefix instead of letting it reach for a constant, and let the driver pass what the host says.
- Keep both call sites — the config key and `phrases.tool` — fed from that one value. They agree today only because they call one function; that property is the actual invariant and should survive the change.

## Out of scope

- The reason the prefix exists. Field-wise merging of the Codex override is not in question here.

## Verification

- Two hosts with different command names produce different keys in one process, and in each case the prompt names the same key the config declares.
