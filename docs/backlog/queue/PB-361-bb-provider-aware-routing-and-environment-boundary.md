# PB-361 · Route BB execution by actual provider and filter inherited parent runtime identity

- **Scope:** [Drivers and routing](../../reference/05-drivers.md), [Host identity](../../reference/02-host.md)
- **Created:** 2026-10-08
- **Dependencies:** [PB-364 · Add a local BB plugin entry point with engine-backed tools and authenticated participants](PB-364-bb-plugin-engine-and-participant-binding.md)
- **Cost:** —
- **Order:** 40

## Context

BB is an execution runtime; its providers are the harnesses that supply models and session permissions. Existing model-routing tuples and account windows are keyed by harness. Collapsing every BB provider into one harness would lose model/effort and quota distinctions. Mixed native children may also inherit BB parent identity because the current ancestor environment filter lists native identities but not BB identities.

Evidence: Source snapshot `9a2a758209802e0b9632aad958f862d15e2e4c30`: `src/model-routing.ts`, `lib/model-routing/resolver.js`, `lib/session-env.js` (PARENT_SESSION_ENV). BB SDK 0.6.15 `bundled-types/bb-plugin-sdk.d.ts:16032` providers/models and `:16491` providerStates/usageLimits. The analysis probe confirmed BB_THREAD_ID and BB_ENVIRONMENT_ID are absent from the filter; no live wrong-parent action was observed.

## Work to do

- Keep runtime, underlying provider, selected model and reasoning selection explicit in the BB facade and participant/decision metadata.
- Read actual BB provider/model availability and account-window information with the appropriate host/environment context; represent unavailable quota as unknown.
- Define the user-facing BB selection and routing-policy mapping without silently relaxing an explicit native harness constraint or changing native defaults.
- Strip inherited BB parent identity from native child processes in the mixed-runtime boundary. Preserve unrelated environment values and normal authenticated BB thread context.
- Document the support matrix and routing evidence for each claimed provider; keep the native catalog and routing defaults.

## Out of scope

- No global bb model/quota bucket, automatic permission elevation, new native models, or inferred per-task quota cost.
- No broad environment-variable purge or synthetic native session identity.

## Verification

- BB requests resolve the intended provider/model/reasoning; explicit policy restrictions and offline/unknown availability are preserved.
- Quota evidence is account-window/provider scoped, and unknown quota is reported as unknown rather than a fabricated number.
- Native children do not inherit BB parent thread/environment identity, while non-identity configuration remains intact.
- Existing native routing and session-env regressions pass; capture at least the actual provider choices used by the integration scenario.
