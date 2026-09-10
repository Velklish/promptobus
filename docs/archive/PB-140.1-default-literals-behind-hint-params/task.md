# PB-140.1 · Fourteen low-level seams keep a `promptobus <verb>` literal as the default behind an optional hint parameter, so the literal-command gate carries an allowlist instead of being empty

- **Order:** 100
- **Scope:** `lib/store.js`, `lib/driver-claude.js`, `lib/driver-codex.js`, `lib/driver-cursor.js`, `lib/codex-session.js`, `lib/model-routing/adapter-claude.js`, `lib/model-routing/resolver.js`, `test/cli.test.mjs`, [03-cli](../../reference/03-cli.md) § the literal-command gate
- **Created:** 2026-09-10
- **Dependencies:** PB-140

## Context

PB-140 moved every refusal and stall hint that names a bus subcommand onto `host.busCommand(...)`: the callers that have a host format the command and pass the finished string down as a hint. Fourteen seams have no host of their own — the store's task-resolution and send refusals, the drivers' stall routes and option refusals, the detached Codex holder, the Claude availability adapter and the pure resolver — and each keeps its former `promptobus <verb>` text as the default value of the new hint parameter, so a direct low-level call (today only tests) still prints the old spelling. The gate in `test/cli.test.mjs` therefore carries an explicit allowlist of those fourteen `{ file, command, text, reason }` entries; every real command path passes a formatted hint, measured by the consumer-host stubs in the suite.

## Work to do

- Make the hint a required argument on those seams (or resolve the text at the one place that has a host, the CLI catch or the bus service), delete the fourteen default literals, and empty the allowlist so the gate is a plain "no literal outside a formatter" check.
- Keep the consumer-host stub tests that prove the formatted spelling reaches a person.

## Out of scope

- Any wording change of the messages themselves — only where the command spelling comes from.
- The holder's own hint: it is carried in the session record at launch (PB-140) and stays.

## Verification

- `test/cli.test.mjs`'s literal gate passes with an empty allowlist; a new `promptobus <verb>` literal anywhere under `lib/` turns it red.
- `npm test` green.

## Triage — 2026-09-10

- **Track:** L — Spawn, review and command guidance.
- **Priority:** P2.
- **Evidence level:** `test/cli.test.mjs:245-260` at `3ccdf27` — fourteen allowlist entries, one per seam named in Scope.
- **Decision:** the hint is a required argument on the fourteen seams and the default literals go; the tests that call a seam directly pass a formatted hint; the allowlist is emptied and the gate keeps only its plain "no literal outside a formatter" check. The alternative — resolving the text at the CLI catch — is not taken: PB-140 kept module contracts free of a host object. A `Changed` CHANGELOG line only if the signature of a function the package exports changes; otherwise none.
- **Next step:** implement as decided.
