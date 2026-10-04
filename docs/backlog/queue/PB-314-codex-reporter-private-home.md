# PB-314 · Admit a read-only Codex reporter without an install-root project layer

- **Order:** 150
- **Scope:** [reference/03-cli § Report](../../reference/03-cli.md#report), [reference/05-drivers](../../reference/05-drivers.md), `lib/report.js`, `lib/driver-codex.js`
- **Created:** 2026-10-01
- **Dependencies:** none
- **Cost:** major

## Context

The owner requires the reporter workflow on Codex after losing access to Claude Code. `lib/report.js` on `6f834e2c` explicitly refuses Codex. The existing Codex teamlead private-home mechanism avoids writing a project layer at the install root and can seat a read-only reporter there.

The work landed on main before release 0.22.0 (`b58bbce0`, `248511b8`, `f451a3e3`, `cbe43394`; CHANGELOG `[0.22.0]`, "A Codex reporter runs read-only at the install root"). What remains is the approver's acceptance pass: review, archive and fold.

## Work to do

- Route reporters to Claude Code or Codex while preserving the Cursor refusal.
- Seat Codex reporter skills and MCP in a private home, force a read-only sandbox, disable project hooks at thread scope, omit bus send and classified external writes.
- Bind the reporter session before its first model turn, preserving reporter identity gates and reservation cleanup.
- Update public reporter/auth/driver documentation and provide focused regression, mutation and live proof.

## Out of scope

- Cursor reporter admission.
- Adding a write permission or impersonating a user without a proven reporter session.

## Verification

- `node test/report.test.mjs`: 46/46 passed, exit 0.
- Live Codex 0.158.0 reporter completed three MCP calls (digest, status, task) using its recorded session, listed five bus tools with `promptobus_send` absent, left the install-root snapshot unchanged, and stopped afterwards. [Evidence](../../../test/fixtures/codex-app-server/0.158.0/Reporter-0.158.0-2026-10-01.json).
