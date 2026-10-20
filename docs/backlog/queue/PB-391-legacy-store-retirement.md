# PB-391 · Retire the legacy store and its obsolete tests

- **Order:** 40
- **Scope:** [Legacy store and migration](../../reference/01-overview.md), [Host contract](../../reference/02-host.md)
- **Created:** 2026-10-20
- **Dependencies:** coordinated consumer retirement and a verified old-workspace upgrade route before its dependency pin changes
- **Cost:** major

## Context

The owner requested near-term removal of the former store and the tests that exist only to support it. The current `src/v1` engine is the working protocol/store implementation and remains in use.

Evidence at `d9554a080f6a4e746033184c2be27b0843e1d8b4`: `src/legacy-store.ts`, `src/migrate.ts`, package-root migration exports, `PromptobusHost.legacyLayout`, migration branches in `lib/store.js` and pending-migration suppression in `lib/guard.js`. The Agent Workspace consumer still calls `migrate`/`preflight` and declares a former-store layout, so removing the package exports alone would break a current consumer. The read-only inventory is retained in the recovery audit; no deletion or migration was performed while creating this task.

There is no current evidence that every real former journal has already migrated. Removing runtime support needs an explicit, verified upgrade path for those installations, including active tasks and interrupted conversion. Preserve original journals; never silently replace an unsupported store with an empty current one.

Priority: near-term queue, ahead of general test pruning once the consumer and upgrade prerequisites are ready.

## Work to do

- Coordinate the consumer change before its package pin advances. Use an existing legacy-capable release to complete any required conversion before removing support; document the exact supported upgrade route and diagnostics for an unsupported remaining layout.
- Remove `src/legacy-store.ts` and `src/migrate.ts`, the root exports `legacy`, `migrate`, `migrationNeeded`, `preflight`, `splitLegacyRel`, and migration-only report/options types.
- Remove `HostLegacyLayout`, `PromptobusHost.legacyLayout` and the standalone declaration from public root/host surfaces. Remove former-home recognition, migration cache/reporting, migration-specific identity handling and pending-migration branches from the current adapter and guard. Keep the rest of those modules.
- Delete the exclusively legacy test files `test/promptobus-legacy-fixture.test.mjs` and `test/promptobus-migration.test.mjs`, their frozen `legacy-v061` fixture/MANIFEST and dedicated audit exemptions.
- Remove only legacy-specific cases from mixed boundary, Host, MCP, owner-gate, sweep, ambient, guard and documentation tests. Preserve each current guarantee and explain every removed test name. A name containing legacy is not sufficient evidence for deletion.
- Update the existing architectural decision, references, glossary, install/upgrade guidance, public API documentation and CHANGELOG. Clean emitted legacy modules before packaging: deleting TypeScript source does not remove stale JavaScript/declarations from `dist`.

## Out of scope

- Removing or renaming the active `src/v1` engine, current record schemas/protocol, sidecars or shared filesystem/lock primitives.
- Removing current ownerless-v1 handling, causal assignment boundaries, unread-mail protection, unresolved provenance, unstamped-contact safety or the adapter's cache suspender merely because a nearby test mentions legacy.
- Deleting actual journals or introducing another permanent duplicate legacy implementation.
- Unrelated cleanup or expanding permission/ownership policy.

## Verification

- Record the remaining production imports/exports and consumer call sites before removal; afterward no production path relies on the retired runtime or Host member.
- Prove the coordinated consumer works with the new package pin. Document and verify the supported upgrade route for an old installation, preserving its tasks/messages/artifacts and handling interrupted conversion or stale home configuration without silent data loss.
- Fresh current-format workspaces pass the required package and consumer checks. Retain current v1/owner/identity/locking/mail/provenance safeguards in the mixed suites.
- Record each deleted test name and its obsolete behavior, plus surviving coverage for every shared guarantee. Use meaningful mutation proof for changed surviving tests; do not remove tests solely to reduce a count.
- Build/package from a clean output directory and inspect the actual distribution: no stale legacy runtime or declarations remain, public root/host exports agree, and current v1 entry points remain available.
- Independent review and the normal source gates pass with exact commands, exit codes, counts and source identity. A missing upgrade or consumer proof remains an explicit blocker.
