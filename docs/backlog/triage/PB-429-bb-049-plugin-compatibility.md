# PB-429 · Ship Promptobus BB plugins compatible with BB 0.49

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

Triage the minimal compatibility release separately from native shared-service recovery.
