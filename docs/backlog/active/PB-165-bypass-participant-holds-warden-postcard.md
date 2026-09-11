# PB-165 · A participant lifted with bypassPermissions holds the warden's postcard as a Held peer message and reads as stalled on a permission prompt

- **Scope:** `lib/driver-claude.js` (the participant settings file passed with `--settings`, `stallOf`/`waitingFor` classification), `src/supervisor.ts` (the postcard delivery), [03-cli](../../reference/03-cli.md) § Spawn, `test/promptobus-driver-claude.test.mjs`
- **Created:** 2026-09-11
- **Dependencies:** none
- **Taken:** 2026-09-11

## Context

Filed from the consumer's finding ati-agents BL-640 (run 0911a, 2026-09-11, claude 2.1.263). Three workers were lifted with `--permission-mode bypassPermissions`. The warden's first postcard to one of them was not delivered but held by the session as a dialog — `claude logs` of the worker, ANSI stripped:

```
Held peer message — from an unidentified session [verified pid <warden pid>]; preview: «Promptobus service notification. The mailbox for address worker:codex-agents on task … has unread: …» — not delivered to Claude (1 held): sender did not attest its permission mode and this session bypasses prompts. Review it below, or set "crossSessionInbound" to "accept".
```

The same postcard reaches a participant lifted in `auto` mode (run 0910a, injection proven on claude 2.1.263). Consequences measured in the same run: `claude agents --json` reports the session as `waitingFor: "permission prompt"`, `state: "blocked"`, and `promptobus status` plus the tail of `promptobus_mailbox` call a person to a session that keeps working (its shell-command counter grew 40 → 45 in 45 s) — the stall mark is false; a participant that has ended its turn (a worker after `question`) does not wake from the postcard at all and its answer sits in the mailbox until a manual `claude attach`. The consumer worked around it by lifting later runs without `bypassPermissions`.

## Work to do

- Decide the layer and implement one of: the participant settings file written by the Claude driver carries the key the dialog names (`crossSessionInbound: "accept"`) when the permission mode bypasses prompts, so the warden's injection is accepted; or the warden attests its permission mode in the injection; or `spawn` refuses `bypassPermissions` naming the deaf participant. Measure the chosen fix on a live lift (no paid model turn needed: the postcard is the warden's).
- The stall predicate distinguishes a held peer message from a real permission prompt: a session with a held postcard and a running turn is not `blocked`, and the mailbox tail does not call a person to it.
- One paragraph in 03-cli § Spawn on the price of `bypassPermissions`; CHANGELOG; tests on the settings content per permission mode and on the stall classification.

## Out of scope

- The consumer's rule text about when to use `bypassPermissions` (ati-agents BL-640 keeps that).

## Verification

- A participant lifted with `bypassPermissions` receives the warden's postcard without a dialog (journal line `delivered … mailbox was taken` without a manual attach) — live check on this workspace.
- `npm test`, `npx github:Velklish/backslop#v0.4.0 lint`, `npm run audit` green.
