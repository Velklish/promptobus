# PB-259 · Codex participant homes copy the owner's auth.json, and a lift can start with a refresh token that no longer refreshes

- **Scope:** `lib/driver-codex.js` (`makeParticipantHome`), [05-drivers](../../reference/05-drivers.md), [03-cli](../../reference/03-cli.md) § The Codex holder
- **Created:** 2026-09-26
- **Dependencies:** none
- **Cost:** major
- **Previous order:** 150
- **Taken:** 2026-10-26

## Context

Measured on 2026-09-25 during a backlog run, codex-cli 0.156.1, installed promptobus 0.17.0. A worker ran two scratch runs of three Codex participants each, about twenty minutes apart, both with `CODEX_HOME=~/.codex` as the owner's home. In the first run all three participants finished their turn. In the second, all three first turns ended before the model with:

    Your access token could not be refreshed because you have since logged out or signed in to another account

`codex login status` printed `Logged in using ChatGPT` afterwards, and `~/.codex/auth.json` had not been written since 2026-09-18 (its mtime).

`makeParticipantHome` copies the owner's `auth.json` into every home (`lib/driver-codex.js`, `copyFileSync(path.join(ownerHome, 'auth.json'), target)`), so every copy holds the same refresh token. **Hypothesis, not measured:** the refresh token rotates, and the first copy that refreshes leaves the token in every other copy — the owner's own file included — unable to refresh. A new lift then starts from a dead token, and so does the owner's own `codex`. Nothing established which process refreshed first.

## Work to do

- Keep access-only private snapshots; do not copy or use the owner's refresh token.
- If the original owner's access snapshot changes, refuse before the next model turn with a clear owner-sign-in/snapshot-change reason and require a fresh lift. Do not silently accept the changed file or promise that `account/read(refreshToken: false)` reloads an existing app-server's credentials.
- Preserve expiry, account-identity, active-turn and current-launch checks. A fresh lift follows the existing Stop and admission rules; no automatic restart or unresolved-seat recovery is added.
- Update 05-drivers and 03-cli § The Codex holder with this contract and the separate historical version boundaries. Test only disposable synthetic homes; the real owner authorization remains unchanged.
- Keep the destructive rotation experiment open in PB-259.1. Its hypothesis is neither measured nor refuted by this mitigation.

## Out of scope

- The homes sweep (PB-258).
- Forcing real-owner refresh, login/logout, rotating credentials or claiming acceptance of the historical OAuth hypothesis.

## Verification

- A meaningful regression shows a changed same-account access snapshot cannot enter `turn/start`; the fixed holder refuses before a model turn and requires a fresh lift.
- Unchanged snapshots retain the normal path. Missing/expired/changed-identity snapshots and active turns keep their existing protections; repeated requests do not revive the rejected snapshot or weaken Stop/admission.
- Synthetic owner files remain unchanged and tokens do not appear in output. A supported fresh lift uses a fresh access-only snapshot without bypassing an unresolved prior lifecycle.
- Focused checks, a committed meaningful mutation probe, repository gates and independent review pass on the exact accepted source.
- The Codex 0.164.0 account-metadata observation remains bounded: it does not prove a real-account model-turn failure or measure refresh-token rotation. The historical 0.159.2 fixture is preserved.

## Owner decision · 2026-10-26

The owner approved fail-closed behavior and a fresh lift through AskUserQuestion. These criteria replace the destructive experiment as this card's acceptance. PB-259.1 retains that separate open hypothesis and requires a person present to sign in again before any real-owner rotation experiment.

## Measured mitigation · 2026-10-01

The 2026-10-01 migration introduced access-only private snapshots, expiry checks and a
durable owner-home path. Its holder attempted idle snapshot replacement through public
`account/read(refreshToken: false)`; that historical implementation is not a current hot-reload
guarantee. The newly approved work above replaces that promise with refusal and a fresh lift.

On native 0.159.2 an invalid cached access failed HTTP 401; after a disposable owner received
fresh access, the same thread, holder and app-server completed the next turn. Both owner
files remained unchanged. [Evidence](../../../test/fixtures/codex-app-server/0.159.2/ParticipantAuthReload-0.159.2-2026-10-01.json).
Focused tests cover stale private expiry, missing owner files, identity changes, pending
reload retry and serialized overlapping turns. The destructive OAuth rotation hypothesis
was not forced on the user's real account; this mitigation prevents participants from
rotating that token rather than claiming to have measured which process rotated it historically.
