# PB-366 · Prove and define BB reviewer sandbox and tool restrictions before full runtime support

- **Scope:** [Drivers](../../reference/05-drivers.md)
- **Created:** 2026-10-08
- **Dependencies:** none
- **Cost:** —
- **Order:** 1

## Context

The owner requested highest-priority BB integration work on 2026-10-08. A read-only reviewer is part of the existing role contract. BB messaging and provider selection alone do not enforce that contract. The inspected public SDK offers accept-edits, auto and full permission modes, while agent configuration selects only the plugin's own tools and skills. No public spawn field was found for per-session read-only sandbox, provider shell/edit denial or canonical MCP write denial. This is a public-contract gap, not a captured provider escape.

Evidence: Source snapshot `9a2a758209802e0b9632aad958f862d15e2e4c30`: `lib/review.js:86-99` and `src/driver.ts:18-48`. Official `@get-bb/plugin-sdk@0.6.15`, `bundled-types/bb-plugin-sdk.d.ts`: permission modes at 3936, create-thread schema at 12176, plugin agent configuration at 21818. Reproduce the declaration inspection with `npm pack @get-bb/plugin-sdk@0.6.15 --ignore-scripts`; inspect the complete spawn schema and provider restrictions before relying on a capability.

## Work to do

- Capture the supported BB version and exact SDK/provider versions; verify available public restriction APIs with a minimal live capability probe.
- Choose and document the smallest enforceable contract: upstream role-scoped sandbox/tool restrictions, or a constrained provider if no public upstream route exists. Identify implementation ownership and supported providers before broad integration.
- Cover provider built-in shell/edit tools and external canonical MCP write tools, not only this plugin's bus tools. Declare capabilities only when mechanically enforced.
- Record a clear full-support gate for the final integration task. A native external reviewer may be a documented mixed-runtime pilot fallback; it does not satisfy full-BB support.

## Out of scope

- No weakening of existing native reviewer restrictions or declaration of enforcement based on prompt text.
- No general provider framework, automatic permission elevation, or claim that the public schema proves a live security failure.

## Verification

- On each claimed provider, attempts to mutate the review snapshot, execute denied shell/edit tools and call canonical MCP write tools are mechanically denied; authorized bounded reads work.
- Retain exact versions, commands, exit codes and observed denials. Refuse the reviewer launch when required restrictions are unavailable.
- The documented support matrix distinguishes full support, explicit mixed-runtime pilot and unsupported profiles; the final integration gate consumes this result.
- Existing native reviewer capability and deny-list regressions remain passing.
