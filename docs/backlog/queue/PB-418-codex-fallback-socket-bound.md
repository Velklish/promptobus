# PB-418 · Keep Codex fallback sockets within the Unix path bound

- **Order:** 470
- **Scope:** [The Codex holder](../../reference/03-cli.md#the-codex-holder)
- **Created:** 2026-11-03
- **Dependencies:** none
- **Cost:** major

## Context

The fallback contact point can exceed the Darwin Unix socket path bound when the process has a long canonical temporary root. Launching a holder then fails with `listen EINVAL` before its scenario can run.

Evidence: `lib/codex-session.ts:209-217` checks the nested registry socket against `SOCK_MAX`, but returns a fallback under `tmpdir()` without checking that result. On official Node 26.13.0/macOS, `TMPDIR=<owned canonical directory longer than 110 bytes> node test/codex-holder-admission.test.mjs` exited 1 twice on the registry-preflight candidate and once on base `084683ee`. All three holder checks failed with `listen EINVAL`. The same file with `TMPDIR=/private/tmp` passed 3/3, exit 0. The full release attempt using the long system temporary root showed the same refusal across holder scenarios.

Next step: review and queue a dedicated fallback-path repair. Release qualification uses a short canonical temporary root; it does not establish arbitrary temporary-root compatibility.

## Work to do

- Keep the fallback socket within the platform byte bound independently of the process temporary-root length.
- Preserve registry/ref separation, owned holder cleanup and refusal of another listener.
- Check the holder documentation against the selected fallback location.

## Out of scope

- Registry ownership or permission migration, native Stop proof and admission policy.
- Changes to test timeouts or omission of holder scenarios.

## Verification

- A long canonical temporary-root regression fails on the current fallback and passes after the repair, with a successful real local Unix listener.
- Two registries with the same ref retain different fallback contacts.
- `node test/codex-holder-admission.test.mjs` passes with both long and short temporary roots; verify the regression with a mutation probe.

## Audit next step, 2026-11-13

Implement the dedicated bounded Unix fallback-path repair with a real listener under long canonical TMPDIR, registry/ref separation and owned/foreign-listener controls. Verify both long and short roots and the mutation regression; update holder location docs. Keep Windows named-pipe acceptance separate in PB-357.
