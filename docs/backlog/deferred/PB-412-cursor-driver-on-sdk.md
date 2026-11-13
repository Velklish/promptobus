# PB-412 · Cursor driver on the Cursor SDK, after the decision on a Cursor API key

- **Scope:** [reference/05-drivers § Cursor: the persist session](../../reference/05-drivers.md#cursor-the-persist-session), `lib/driver-cursor.ts`, `lib/cursor-persist.ts`
- **Created:** 2026-10-29
- **Dependencies:** the owner's decision to provide a Cursor API key as a secret, with its provenance
- **Cost:** minor

## Context

A consumer workspace's spike of 2026-09-03 reported that `@cursor/sdk` 1.0.30 addressed three CLI-path gaps. At that spike baseline, the driver lifted a Cursor participant through `agent persist` in a tmux pane (`lib/driver-cursor.js`, `lib/cursor-persist.js`), and the SDK offered instead:

- `mcpServers` passed as an argument, in place of the three conditions the CLI path needs (a `.cursor/mcp.json` in the git directory plus `--approve-mcps`);
- `disallowedTools` with `askQuestion`, `shell`, `edit` and `delete`, in place of forbidding questions in the prompt and a deny list in `.cursor/cli.json`;
- `Agent.list` and `Agent.get` with a status and `run.cancel()`, in place of walking `~/.cursor/chats` and killing a process and collecting its orphan.

The 2026-09-03 spike recorded these tradeoffs for SDK 1.0.30: `CURSOR_API_KEY` as a new secret (local IDE login returned `logged-out`); `engines.node >= 22.13` against the then-current `>=20` (`package.json:32`); 49 MB of dependencies with native binaries against this package's no runtime dependencies; and a local agent in the host process without detaching. It ran no live SDK turn because no key was set. These SDK capabilities, auth and footprint observations are historical, not current-version verification. The repository now requires Node `>=26` after PB-416.14, so the former Node-floor blocker is resolved.

The current source still uses the CLI/persist path and does not depend on the SDK.

## Work to do

- After the owner decides to provide the key and names its provenance, run a fresh current-version SDK spike with live turns. Re-evaluate auth, MCP configuration, denied tools, status/cancel, detach/lifetime and the no-runtime-dependencies tradeoff before deciding whether to replace the driver's internals. The driver contract does not change its set of operations; this deferred card does not start replacement.

## Out of scope

- The CLI-path driver while the decision is not made.

## Verification

- The spike records live SDK turns: a lift with `mcpServers` as an argument, a refused `askQuestion`, `Agent.get` status and `run.cancel()`.
- The driver's existing suite passes on the SDK-backed operations.

## Deferred

- **Deferred:** 2026-10-29
- **Reason:** the owner has not selected the Cursor API key and its provenance, and the first spike ran no live turn. Current SDK capabilities and tradeoffs need a fresh live spike; the CLI path works. Raising the Node floor is no longer a blocker.
- **Return condition:** the owner decides to provide a Cursor API key as a secret and names where it comes from; qualify the current SDK with the live spike and original MCP/deny/status/cancel criteria before a driver-replacement decision.

## Audit limits, 2026-11-13

The current CLI/persist path remains the source implementation; no SDK replacement was established. Current SDK version, auth, detach support and dependency footprint, live SDK turns, driver suites and gates were not verified by this audit.

## Incorporated finding PB-419.15

The former Node-floor prerequisite is resolved: root and BB integration manifests require Node >=26. Current dependency, work and Deferred fields now depend on the owner-selected Cursor API key and its provenance plus a current-version live SDK spike. Preserve the dated Node 20/SDK 1.0.30 spike and all original capability/lifetime/dependency tradeoffs.

### Additional acceptance criteria

- Do not request a redundant Node >=22.13 upgrade in the current prerequisites, work or return condition. Preserve the historical Node comparison with its original date.
- Retain deferred status, the key/provenance decision, live MCP/deny/status/cancel verification and the no-runtime-dependencies/detach/cancel tradeoffs. No driver replacement or account probe is authorized by this merge.
- Check the updated prerequisite wording and its original documentation assertions when implementing the SDK task; this metadata correction does not count as live SDK qualification.

### Preserved original record

The complete finding below was incorporated by the owner-approved backlog audit of 2026-11-13; its measurements keep their original dates, versions and limitations.

> # PB-419.15 · Correct obsolete Node prerequisite in deferred SDK task
>
> - **Scope:** [CLI reference](../../reference/03-cli.md)
> - **Created:** 2026-11-05
> - **Parent:** PB-419
> - **Cost:** minor
>
> <!-- quality-audit-import:2026-11-05:PB/PQA-608 -->
>
> ## Evidence
>
> `docs/backlog/deferred/PB-412-cursor-driver-on-sdk.md` currently requires the owner to decide to raise the Node floor to 22.13 in its Dependencies, Work to do, deferred reason and return condition. `package.json` now requires Node `>=26`, so that prerequisite has already been met. The comparison to Node `>=20` in the dated spike describes its historical context and remains useful. The SDK key, dependencies, lifecycle and unmeasured live turn remain separate questions.
>
> ## Context
>
> Evidence: `docs/backlog/deferred/PB-412-cursor-driver-on-sdk.md` currently requires the owner to decide to raise the Node floor to 22.13 in its Dependencies, Work to do, deferred reason and return condition. `package.json` now requires Node `>=26`, so that prerequisite has already been met. The comparison to Node `>=20` in the dated spike describes its historical context and remains useful. The SDK key, dependencies, lifecycle and unmeasured live turn remain separate questions.
>
> ## Work to do
>
> Correct the current dependency, work and return-condition wording in the existing deferred task to reflect the already satisfied Node minimum. Retain the dated spike and the remaining owner decision about the API key and SDK contract. Do not close or move the deferred task merely because the Node prerequisite is satisfied.
>
> ## Acceptance criteria
>
> - The current conditions do not ask for another decision to raise the floor to a version below the existing minimum.
> - The historical spike, the key decision, the unmeasured live work and the deferred status remain intact.
>
> ## Verification
>
> After the change, compare the task's current conditions with `package.json` and run `npx --no-install backslop lint` from the repository root. **notRun**.
>
> Additional audit-proposed checks, **notRun**: `node test/docs-links.test.mjs`; `node test/docs-task-independence.test.mjs`.
>
> ## Dependencies and limits
>
> None for this documentation correction. Do not request a key, change the Node floor, install the SDK or run a live SDK turn as part of this task.
