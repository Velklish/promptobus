# PB-259 · Codex participant homes copy the owner's auth.json, and a lift can start with a refresh token that no longer refreshes

- **Order:** 280
- **Scope:** `lib/driver-codex.js` (`makeParticipantHome`), [05-drivers](../../reference/05-drivers.md), [03-cli](../../reference/03-cli.md) § The Codex holder
- **Created:** 2026-09-26
- **Dependencies:** none
- **Cost:** major (hypothesis)

## Context

Measured on 2026-09-25 during a backlog run, codex-cli 0.156.1, installed promptobus 0.17.0. A worker ran two scratch runs of three Codex participants each, about twenty minutes apart, both with `CODEX_HOME=~/.codex` as the owner's home. In the first run all three participants finished their turn. In the second, all three first turns ended before the model with:

    Your access token could not be refreshed because you have since logged out or signed in to another account

`codex login status` printed `Logged in using ChatGPT` afterwards, and `~/.codex/auth.json` had not been written since 2026-09-18 (its mtime).

`makeParticipantHome` copies the owner's `auth.json` into every home (`lib/driver-codex.js`, `copyFileSync(path.join(ownerHome, 'auth.json'), target)`), so every copy holds the same refresh token. **Hypothesis, not measured:** the refresh token rotates, and the first copy that refreshes leaves the token in every other copy — the owner's own file included — unable to refresh. A new lift then starts from a dead token, and so does the owner's own `codex`. Nothing established which process refreshed first.

## Work to do

- Measure the rotation with a person present to sign in again: two homes copied from one `auth.json`, a refresh forced in the first, then a turn in the second. Cite the refresh path in codex-rs at the tag of the installed binary.
- If it holds, a lift must not leave the owner's own credentials unable to refresh, and a lift whose copy cannot refresh refuses before any turn with a reason naming the owner's sign-in. The owner decides the shape.
- 05-drivers and 03-cli § The Codex holder say what a participant's credentials are and what a refresh in one home does to the others.

## Out of scope

- The homes sweep (PB-258).

## Verification

- The rotation measured, or the hypothesis refuted by the measurement that refutes it.
- After the owner's session has refreshed, a lift either works or refuses before any turn with the reason above.
