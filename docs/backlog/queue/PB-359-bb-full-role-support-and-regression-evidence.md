# PB-359 · Verify the complete BB role workflow and publish an explicit runtime support contract

- **Scope:** [Protocol](../../reference/04-protocol.md), [Drivers](../../reference/05-drivers.md), [CLI](../../reference/03-cli.md)
- **Created:** 2026-10-08
- **Dependencies:** [PB-366 · Prove and define BB reviewer sandbox and tool restrictions before full runtime support](../../archive/LOG.md#pb-366), [PB-365 · Export portable role instruction renderers while preserving native harness behavior](../../archive/LOG.md#pb-365), [PB-364 · Add a local BB plugin entry point with engine-backed tools and authenticated participants](../../archive/LOG.md#pb-364), [PB-363 · Launch and inspect BB participants with one owner for each environment](../../archive/LOG.md#pb-363), [PB-362 · Deliver BB wake hints with durable recovery, bounded continuation and explicit stop handling](../../archive/LOG.md#pb-362), [PB-361 · Route BB execution by actual provider and filter inherited parent runtime identity](../../archive/LOG.md#pb-361), [PB-360 · Deliver Host rules, skills and canonical tools into BB participant environments](../../archive/LOG.md#pb-360), [PB-358 · Separate harness-specific prompt sources from shared contracts](../../archive/LOG.md#pb-358)
- **Cost:** —
- **Order:** 60

## Context

Full BB support means portable roles, authenticated bus operations, enforced reviewer isolation, environment preservation and recoverable lifecycle all work together. Passing store/SDK fixture tests alone does not establish that behavior. Current pipeline prerequisites record canonical results and their currency; they do not judge the truth of verdicts or test evidence.

Evidence: Source snapshot `9a2a758209802e0b9632aad958f862d15e2e4c30`: `lib/review.js:119-146` checks result/subject/assignment currency; `lib/approver.js:212` states that the package records gate facts but does not judge their content. The 2026-10-08 analysis used four baseline suites (233 tests) and five contract-probe assertions; it launched no live BB role workflow.

## Work to do

- Exercise worker, reviewer, approver, teamlead, reporter and orchestrator roles through the implemented BB entry point on each claimed profile.
- Run a representative assignment -> work -> isolated review -> approver -> result flow with actual snapshot/base/head references, retained artifacts and existing pipeline preconditions.
- Combine restart, queued interaction, explicit stop/resume, replacement participant and final cleanup in integration scenarios; prove there is one execution/resource owner.
- Publish versioned setup, ownership, recovery, permissions and provider support documentation in the package/plugin delivery surfaces.
- Retain the existing result-currency and fact-recording semantics. Any stricter verdict/commit acceptance feature requires separate scope and authorization.
- Compare native harness behavior and run required project gates on the final commits, reporting exact commands, exits, test counts and remaining limitations.

## Out of scope

- No full-BB support label for a mixed native-reviewer pilot, or undocumented unsupported provider.
- No new content/verdict acceptance engine, remote-host support claim without live evidence, or release/publication during backlog creation.

## Verification

- Keep reproducible live captures for every supported role/provider profile, including mechanical reviewer denials and artifact preservation.
- Show recovery from duplicate/ambiguous notifications and interruption without duplicate executors, lost unread messages or unauthorized revival.
- Run native regression and project gates on the final implementation commit; packed/installed docs and skills work from a clean consumer setup.
- The published support matrix states versions, full/mixed/unsupported status, measured limitations and unresolved gates; no claim relies solely on mocks or analysis probe results.
