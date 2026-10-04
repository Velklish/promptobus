# PB-334 · Replace tracker-specific hook admission with a neutral project hook contract

- **Scope:** [Hooks and trust](../../guides/hooks-and-trust.md)
- **Created:** 2026-10-04
- **Dependencies:** none
- **Cost:** major
- **Previous order:** 60
- **Taken:** 2026-10-04

## Context

At `6f4e9a3`, Promptobus makes a development tracker part of participant launch. `lib/project-hooks.js:5,20-34` reads `backslop.json.cli` and admits only that CLI's `hook session-start|stop --harness ...` commands. Codex refuses other records (`lib/driver-codex.js:154-167`) and names the tracker config in consumer errors (`:197-203`); Cursor filters project hooks through the same rule (`lib/driver-cursor.js:322-325`). The module ships in the package. `node test/project-hooks.test.mjs` exited 0 with 7/7 assertions, including refusal without that config. This proves the current special case, not compliance with the product boundary.

## Work to do

- Replace tracker-specific parsing and command synthesis with a product-neutral, explicit project-hook trust and preservation contract.
- Keep harness hook mechanics in Promptobus; keep tool-specific configuration in the development repository or an external adapter.
- Update the driver messages, `docs/guides/hooks-and-trust.md:77-89`, ADR-025 and tests to describe that contract.
- Preserve installed tracker hooks and their execution; do not require the tracker to know Promptobus.

## Out of scope

- Removing installed tracker files, hooks or skills.
- Silently trusting arbitrary project commands or exporting all internal hook helpers.
- Tracker initialization; PB-326 covers the repository generator declaration.

## Verification

- A fixture with an unrelated explicitly trusted hook and one with current tracker hooks both preserve execution without duplicates; an untrusted record remains refused or omitted under the documented policy.
- No runtime code reads tracker-specific config or constructs tracker subcommands; consumer errors describe only the generic contract.
- A packed-package regression check rejects today's special case. Record commands, exits, counts and tested commit; run applicable gates.
