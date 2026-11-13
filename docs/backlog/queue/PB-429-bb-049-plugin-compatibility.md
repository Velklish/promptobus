# PB-429 · Ship Promptobus BB plugins compatible with BB 0.49

- **Order:** 180
- **Scope:** [BB integration](../../reference/05-drivers.md)
- **Created:** 2026-11-13
- **Dependencies:** none
- **Cost:** major

## Context

Evidence: private workspace consumer inspection on 2026-11-13 (2026-11-12 UTC). `bb status` and `bb plugin list` each exited 0 and reported both `promptobus@0.2.0` and `promptobus-native-panel@0.2.0` as `incompatible`, with the exact reason `requires bb 0.48.1, this is 0.49.0`.

The child diagnostic session recorded `bb plugin source promptobus --json` exit 0: tag `bb/v0.2.0`, SHA `4e77d3b67df5306e5d19b78b90f75b760ea2ef22`, `engines.bb: "0.48.1"`, `engines.bbPluginSdk: "0.6.104"`. It also recorded `bb plugin outdated --json` exit 0 with both plugins `outcome:current`, and `git ls-remote --tags https://github.com/Velklish/promptobus.git 'bb/*'` exit 0 with only rc.2, rc.3 and 0.2.0. These are attributed diagnostic observations at that date, not a claim that no later release exists.

The configured source was `git:https://github.com/Velklish/promptobus.git@semver:bb/:>=0.2.0-rc.3 <0.3.0`. The native CLI smoke on Promptobus 0.32.9 succeeded independently; that does not validate the BB plugins. Original local run summary: `/private/tmp/promptobus-smoke-20261113/report.md`.

## Work to do

- Check the current supported BB/SDK contract and the two plugin entry points against BB 0.49 before selecting compatible pins.
- Apply only the required compatibility changes, qualify both plugins and publish a compatible release through the existing plugin channel when publication is authorized.
- Keep compatibility refusal for unsupported host/SDK combinations. Do not merely widen the manifest version range to suppress the refusal.

## Acceptance criteria

- The configured source can resolve a released compatible version on BB 0.49; the normal plugin update route installs it and both plugins reach `running`.
- A bounded BB-native task/participant, message, panel and Stop smoke passes on the declared supported combination with exact versions and receipts.
- Existing supported combinations retain their documented behavior; unsupported combinations still fail with a useful compatibility diagnostic.

## Out of scope

- Downgrading the user's whole BB installation, bypassing compatibility checks, changing unrelated native shared-service state or redesigning the plugins.
- Treating native CLI success as BB integration proof. This task registration grants no release or installation action.

## Verification

Record exact host/SDK/plugin revisions, plugin checks and exit codes, normal source resolution/update readback and the bounded BB-native smoke. A manifest-only edit is insufficient. All proposed post-change checks, release and installed-runtime validation are **notRun**.

## Next step

Execute the minimal compatibility work separately from native shared-service recovery. Installation and publication retain the task's explicit authorization boundary.

## Incorporated finding PB-419.5

Include the current provider-version documentation in this compatible BB release. The target versions are the selected and qualified manifest pins, not a preselected 0.48.1 value.

### Additional acceptance criteria

- Align current roadmap wording with the BB/SDK versions actually selected and qualified by this release, preserving earlier dated runtime observations as history.
- Add a documentation regression that fails on the obsolete current-version wording; retain the original build/docs-link/task-independence checks below.
- A wording update neither grants runtime compatibility nor replaces the original installed plugin/source resolution and native smoke acceptance.

### Preserved original record

The complete finding below was incorporated by the owner-approved backlog audit of 2026-11-13; its measurements keep their original dates, versions and limitations.

> # PB-419.5 · Align current BB provider version documentation
>
> - **Scope:** [Drivers reference](../../reference/05-drivers.md)
> - **Created:** 2026-11-05
> - **Parent:** PB-419
> - **Cost:** minor
>
> <!-- quality-audit-import:2026-11-05:PB/PQA-103 -->
>
> ## Evidence
>
> `integrations/bb/README.md:544` presents BB `>=0.45.0 <0.47.0` and SDK 0.6.15 as current; `docs/reference/05-drivers.md:2040-2045` says 0.47.1 and SDK 0.6.79 are the current package pair. `integrations/bb/package.json` pins BB 0.48.1 and SDK 0.6.104. Both locations share the same stale current-pin cause.
>
> ## Context
>
> Evidence: `integrations/bb/README.md:544` presents BB `>=0.45.0 <0.47.0` and SDK 0.6.15 as current; `docs/reference/05-drivers.md:2040-2045` says 0.47.1 and SDK 0.6.79 are the current package pair. `integrations/bb/package.json` pins BB 0.48.1 and SDK 0.6.104. Both locations share the same stale current-pin cause.
>
> ## Work to do
>
> Align both present-tense descriptions with the existing manifest while preserving dated historical observations and their live-proof limits.
>
> ## Acceptance criteria
>
> Current documentation agrees with the manifest; historical measurements are retained and no wider compatibility is claimed.
>
> ## Verification
>
> After implementation run `npm run build` and `npm --prefix integrations/bb test` from the repository root; **notRun**. For documentation changes also run `node test/docs-links.test.mjs` and `node test/docs-task-independence.test.mjs`; **notRun**.
>
> Additional audit-proposed checks, **notRun**: `npm test`.
>
> ## Dependencies and limits
>
> None. The audit did not run the proposed post-change checks, full gates, native or live workflows. Do not infer runtime proof from source inspection.

## Triage disposition, 2026-11-13

The owner requested completion of the remaining triage. This is a scoped queued task with work and verification defined above. Decision/investigation steps precede any dependent implementation; unmeasured claims and explicit authority boundaries remain unchanged.
