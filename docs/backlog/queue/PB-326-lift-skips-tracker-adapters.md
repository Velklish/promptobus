# PB-326 · Restore generated development adapters through the repository generator

- **Order:** 10
- **Scope:** [CLI: repository generator](../../reference/03-cli.md)
- **Created:** 2026-10-04
- **Dependencies:** none
- **Cost:** minor

## Context

At `6f4e9a3`, a fresh participant worktree can lack ignored, generated tracker adapters and writer skills even after dependencies are installed. The need to restore them remains valid. The owner's clarified boundary rejects automatic recognition of a particular tracker's config and implicit execution of its init command inside the product.

A generic declaration already exists: `lib/spawn.js:1265` defines the generate field; `:1825-1826` runs and reports the repository generator. `docs/reference/03-cli.md:146-156` specifies `promptobus.json.generate` as an argv array. `test/promptobus-spawn.test.mjs:1463-1465` uses a neutral generator fixture. This development checkout had no promptobus.json during the audit, so missing adapter generation alone does not establish a missing product mechanism.

## Work to do

- Declare the required adapter-generation argv through promptobus.json.generate in each repository or consumer workspace that owns the need, including this development checkout where appropriate.
- Verify the existing dependency-install/generator order and outcome reporting for fresh worker and approver worktrees; fix only a demonstrated generic gap.
- Keep tracker-specific commands in repository-owned configuration and instructions, outside Promptobus runtime detection.
- Coordinate hook preservation with PB-334; preserve all installed tracker files and hooks.

## Out of scope

- Detecting tracker-specific config files or implicitly selecting and running a tracker init command.
- Making the tracker generate Promptobus-specific configuration.
- Treating absent generate declarations as product failures or deleting generated adapters during boundary cleanup.

## Verification

- A fixture with a declared generator restores ignored adapters after dependencies and leaves tracked files clean.
- A repository without a declaration retains documented generic behavior; a failed configured generator reports its outcome according to the existing contract.
- Cover applicable worker/approver paths with a regression check that distinguishes any demonstrated gap from missing configuration.
- Record commands, exits, counts and tested commit; run applicable gates.
