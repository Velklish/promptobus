# PB-88 · Two approval rules in codex-session.js match text anywhere in the serialized request params instead of named fields, so a diff, command or reason merely containing "config/read" or an escalation-sounding phrase is denied with the wrong reason recorded in the warden journal

- **Scope:** `lib/codex-session.js`, `test/promptobus-driver-codex.test.mjs`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`looksLikeConfigRead()` (`lib/codex-session.js:449-452`): `if (method === 'config/read') return true; const blob = JSON.stringify(params ?? {}); return /config\/read/.test(blob);`. `decideApproval()` (`lib/codex-session.js:498-500`) calls it FIRST, ahead of the unknown-method check and the reviewer branch. A second rule at `lib/codex-session.js:535` runs `/danger-full-access|dangerously-bypass|workspace-write.*outside/i` over the same `JSON.stringify(params ?? {})` blob; `.*` crosses JSON field boundaries because the serialized object carries no newlines.

Re-verified now against the current exported function (HEAD cc1aca8) with a worker record `{ cwd: '/tmp/wk', addDirs: [], role: 'worker' }`:
- `decideApproval('applyPatchApproval', { changes: { '/tmp/wk/README.md': { type:'edit', diff:'do not use --dangerously-bypass-approvals' } } }, rec)` → `{"allow":false,"why":"privilege escalation denied"}` — a patch inside the worker's own cwd, denied for text inside the diff body.
- `decideApproval('execCommandApproval', { cwd:'/tmp/wk', command:'grep -rn config/read lib/' }, rec)` → `{"allow":false,"why":"config/read returns secrets from the personal config — the mechanism client does not call it and does not approve it"}` — an ordinary grep, denied and mis-described as a secrets read.
- `decideApproval('execCommandApproval', { cwd:'/tmp/wk', command:'echo workspace-write', note:'outside' }, rec)` → `{"allow":false,"why":"privilege escalation denied"}` — two unrelated fields, bridged by `.*`.

The denial is not a no-op: `known.no` is answered back to app-server and `logWarden(rec.home, rec.task, 'Codex: approval denied <method>: <why>')` (`lib/codex-session.js:797`) writes the wrong accusation into the task's warden journal — the record a person reviewing the run actually sees.

Approvals reach this code in practice: workers and reviewers both run with `approvalPolicy: 'on-request'` (`lib/driver-codex.js:100`, `:402`), and `docs/backlog/queue/PB-41-codex-reviewer-hangs-after-elicitation-allow.md` quotes a real holder log line, `approval allow mcpServer/elicitation/request`, confirming server-raised approvals are live traffic.

No guard sits upstream of either rule and neither carries a rationale comment. `test/promptobus-driver-codex.test.mjs:79-95` (the `applyPatchApproval`/`item/fileChange/requestApproval` containment tests) exercises only the path-containment rules; neither `looksLikeConfigRead`'s blob fallback nor the escalation regex has a test naming it.

Caveat on impact, corrected from the raw finding: these probes call `decideApproval` directly, proving the DECISION is wrong for such params — they do not show app-server routinely raises approvals for an ordinary in-cwd grep or file edit. Under `workspace-write` with `on-request`, most in-workspace reads and patches never reach an approval request at all; the practical trigger needs an approval to be raised for some other reason AND its params to happen to carry the literal or phrase. That narrows expected frequency without changing that the rule, once triggered, answers on the wrong basis.

## Work to do

- `looksLikeConfigRead`: keep only `method === 'config/read'`; drop the `JSON.stringify` blob fallback — a `config/read` substring inside a diff or command line is not a call of that method.
- Replace the escalation regex at `lib/codex-session.js:535` with a check of the named params that actually carry a sandbox/permission mode — `params.sandbox`, `params.approvalPolicy`, and `params.permissions` (the field `item/permissions/requestApproval` sends, and the one approval type reaching line 535 without a path check) — deciding by value rather than by matching wording.
- If a blob scan is still wanted as a safety net, keep it only behind a `log()` warning, never as the basis for `allow: false`.
- Add two regression cases to `test/promptobus-driver-codex.test.mjs`, next to the existing containment checks: a patch inside `cwd` whose diff text names an escalation flag is allowed; a permissions request naming `danger-full-access` in `params.permissions` is denied.

## Out of scope

- The path-containment rules (`insideRoots`, `pathsOfApproval`) — already tested, not touched.
- Codex's `approvalPolicy: 'on-request'` design and the elicitation-answer bug — that is PB-41/PB-42's territory.

## Verification

- The three re-verification probes above (`--dangerously-bypass-approvals` inside a diff, `config/read` inside a `grep` command, `workspace-write` and `outside` in unrelated fields) all return `{ allow: true }` after the fix, for actions otherwise inside `cwd`.
- The two new regression tests in `test/promptobus-driver-codex.test.mjs` pass; `npm test` green.
- A permissions request whose `params.permissions` (or `params.sandbox`) actually names `danger-full-access` is still denied.
