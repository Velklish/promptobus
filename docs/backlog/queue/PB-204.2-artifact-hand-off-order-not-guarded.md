# PB-204.2 · artifact-hand-off-order-not-guarded

- **Order:** 300
- **Scope:** [protocol Artifacts](../../reference/04-protocol.md#artifacts)
- **Created:** 2026-09-13
- **Dependencies:** none

## Context

Finding discovered in review of PB-204.1. The accepted workaround makes the worker send an artifact first, but no bus invariant rejects a result sent first.
The MCP acknowledgement exposes the landed filename; it does not correlate a later result with that artifact or enforce the order.

<!-- quote:../../../lib/spawn.js -->
7. A file to pass (a diff, an export, a schema) — send with ${bus('promptobus_send')} and artifactPath as an absolute path; it will go into the task artifacts directory.
<!-- /quote -->

<!-- quote:../../../src/mcp/server.ts -->
+ ` · id ${message.id}${artifact ? ` · artifact ${artifact.filename}` : ''}`
<!-- /quote -->

<!-- quote:../../../test/promptobus-spawn.test.mjs -->
const mcpHeader = 'Gate: ' + mcpSecondName;
<!-- /quote -->

This test proves the reply name and collision suffix, but it cannot catch a participant that sends the result before the artifact.
The claim is verified by these source paths; no stronger machine-level ordering claim is made here.

## Work to do

- **Scope the invariant to results that claim an artifact.** A result whose header names an artifact filename is the only kind this rule may judge. A result with no artifact claim is lawful and must stay lawful: a rule phrased as "reject a result with no preceding artifact" would refuse ordinary artifactless results, which is a wider ban than the defect.
- **Cover both order violations, not one.** Result sent before the artifact is the obvious one. The other is the artifact sent and the turn ended with no result at all — and it is invisible to any rule built on answer expectation, because any send clears `answerOwedSince`. An artifact with no following result needs its own observable case.
- Choose one closure: a stem unique per attempt, or machine-visible correlation between the artifact message and its result. Note that the unique stem removes the name mismatch **without** enforcing order, so on its own it does not satisfy the first bullet — it closes the symptom, not the invariant.
- Add a regression per covered case, and keep the existing landed-name collision check.
- Document the chosen contract in the protocol reference and preambles if it changes what a participant must send.

## Out of scope

- The accepted PB-204.1 send-first workaround and its current preamble wording.
- Changing placeFile or numberedName; their collision protection is correct.
- Changing the frozen v1 message schema without an owner decision.

## Verification

- Current evidence: env -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID -u CURSOR_CONVERSATION_ID node test/promptobus-spawn.test.mjs exited 0 with 132/132 passed.
- The test sends the same artifact twice through createMcpServer and verifies the landed names handoff-gate.patch and handoff-gate-2.patch.
- No test currently proves either order violation. The acceptance condition is two assertions, not one: a result claiming an artifact that has not landed, and an artifact that no result ever follows.
- A negative control belongs beside them: an ordinary artifactless result stays green.
