# PB-88.3 · A worker's command approval carrying networkApprovalContext or proposedNetworkPolicyAmendments is accepted like an in-root command, so network egress is never weighed
- **Scope:** `lib/codex-session.js` (`decideApproval`), `test/harness-codex.mjs`, `test/fixtures/codex-app-server/0.146.0/CommandExecutionRequestApprovalParams.json`, [03-cli](../../reference/03-cli.md) § The Codex holder
- **Created:** 2026-09-10
- **Dependencies:** PB-88.2
- **Taken:** 2026-09-11

## Context

**Decision (owner, 2026-09-11):** deny — a worker does not leave the network sandbox on request; every command approval carrying `networkApprovalContext` or `proposedNetworkPolicyAmendments` gets the holder's refusal, the same line as for a reviewer; one sentence in 03-cli.

Finding of the PB-88.2 security review (isolated reviewer, run `pb-run-0910-t20260910-085454`), made provable by the measured schema. `item/commandExecution/requestApproval` carries `networkApprovalContext` (a host and a protocol) and `proposedNetworkPolicyAmendments` — a command asking to leave the network sandbox — beside `proposedExecpolicyAmendment`. The holder reads none of them: for a worker it approves the request whenever `cwd` is inside the roots, so a network escalation is answered `accept` like an in-root command. Nothing in the deny vocabulary or in 03-cli names network egress. The plain `accept` reply never applies an amendment (the reply enum has separate `acceptWithExecpolicyAmendment` / `applyNetworkPolicyAmendment` arms), so no policy is widened for later commands — but the one command runs with the network it asked for. Not introduced by PB-88.2: nothing read those fields before either.

## Work to do

- Decide (owner) whether a worker may leave the network sandbox on request: deny every command approval that carries `networkApprovalContext` or `proposedNetworkPolicyAmendments` (the holder's line for a reviewer already), or allow it and say so.
- Implement with a regression from the fixture shape and one sentence in 03-cli § The Codex holder.

## Out of scope

- The measured shapes and the reply rows — PB-88.2.

## Verification

- A command approval with `networkApprovalContext` from a worker gets the decided answer, asserted against the fixture; `npm test` green.
