# PB-135 · `SendSyncInput` (src/v1/engine.ts:94), the parameter type of the public `Engine.sendSync`, is not re-exported from `src/v1/index.ts` or the package entry point

- **Order:** 790
- **Scope:** `src/v1/index.ts`, `src/v1/engine.ts`, `test/v1-engine.test.mjs`, [reference/01](../../reference/01-overview.md) § Entry points
- **Created:** 2026-09-06
- **Dependencies:** PB-131

## Context

src/v1/engine.ts:94 declares `export interface SendSyncInput` and :162 uses it in the public `Engine` interface: `sendSync(task: string, input: SendSyncInput): SendResult`. src/v1/index.ts's re-export block (lines 22-25) lists `Engine, EngineOptions, PruneResult, RecoverResult, RoutingDecision, RoutingPolicy, SendInput, SendResult` from './engine.js' — `SendSyncInput` is the one name missing, even though its async sibling `SendInput` (declared right above at engine.ts:80) sits next to it and is exported. src/index.ts re-exports `* from './v1/index.js'` with no filtering (its own header states the policy: "Names go out FLAT ... the v1 surface is still from the main entry point"), so the gap reaches the package's public '.' entry point too, and dist/v1/index.d.ts / dist/index.d.ts confirm the emitted surface omits it. `grep -rn SendSyncInput src lib dist` finds it only at engine.ts's declaration/usage and the matching dist/v1/engine.d.ts lines — no re-export path anywhere. The MCP server's own sync path (src/v1/artifacts.ts) uses this exact interface shape, so a TypeScript embedder writing a wrapper or a mock around sendSync has to hand-copy the fields rather than import the name, and that copy drifts silently as the interface grows. Not tracked in docs/backlog or docs/archive (grepped for SendSyncInput — no hits). The identical shape of gap was fixed once before for a different type: PB-11.2 added the missing `HostClone` to both host entry points and, instead of re-listing types by hand, widened test/host.test.mjs to parse every `export interface`/`export type` out of src/host.ts and check each against both entry lists. No analogous generic check exists yet for src/v1/engine.ts against src/v1/index.ts, which is exactly the gap this finding fell through.

## Work to do

- Add `SendSyncInput` to the `export type { ... } from './engine.js'` block in src/v1/index.ts, alongside `SendInput`.
- Following the PB-11.2 precedent, add a generic entry-point-parity check (in test/v1-engine.test.mjs or a new test) that parses every `export interface`/`export type` out of src/v1/engine.ts and asserts each name appears in src/v1/index.ts's re-export list, so the next type engine.ts grows cannot be silently left off the surface.
- CHANGELOG.md entry noting SendSyncInput is now exported from the package's '.' entry point.

## Out of scope

- Any change to sendSync's behavior or to the SendSyncInput shape itself — this is an export-list gap only.
- Extending the same generic check to src/host.ts (PB-11.2 already covers that pair) or to the ./hooks and ./driver entry points — scope this pass to src/v1/engine.ts ↔ src/v1/index.ts, the pair that has the gap.

## Verification

- `SendSyncInput` appears in dist/v1/index.d.ts and dist/index.d.ts after `npm run build`.
- Mutation probe: drop `SendSyncInput` from the export list again — the new generic parity test goes red; today's suite passes either way because no such test exists yet.

## Triage — 2026-09-07

- **Track:** S — Store integrity and public engine.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `src/v1/engine.ts:94`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Export the public SendSyncInput type and verify a consumer import compiles. Do not require every internal exported engine type to become public via a generic textual parity test.
