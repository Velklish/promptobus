# PB-53 · `promptobus install` rewrites the config file of every harness it was not asked to install, and `install --check` then reports permanent drift on it

- **Order:** 340
- **Scope:** `lib/install.js`, `test/install.test.mjs`, `docs/guides/install.md`
- **Created:** 2026-09-06
- **Dependencies:** PB-52

## Context

`planHookInstall` (lib/install.js:312-357) loops over `INSTALL_HARNESSES` (`['claude', 'cursor', 'codex']`, line 20), not over `wanted`. The only skip for a non-selected harness is line 335, `if (!selected && existing.missing && !prevIds.size) { …; continue; }`, which fires only when the file does not exist yet; an existing foreign file falls through to the unconditional `writes.push({ …, text: jsonText(spec.wrap(existing.doc, hooks)) })` at line 354, where `hooks = mergeHookEvents(existing.doc.hooks, {}, …)` for a non-selected harness. `install()` (from line 420) compares this generated text byte-for-byte against the file on disk before writing (`if (current !== write.text) pending.push(write)`), but `jsonText` always re-serialises with `JSON.stringify(doc, null, 2)`, so any file not already in that exact 2-space shape is judged different and gets rewritten regardless of selection.

Reproduced today running the real CLI from inside the project directory: (1) a project with a hand-formatted 4-space `.claude/settings.json` (a `PreToolUse` hook plus a `permissions` block, no promptobus records, claude never selected) — `promptobus install --harnesses cursor` prints `✔ configured` and rewrites `.claude/settings.json` to 2-space indentation with the arrays exploded, confirmed byte-for-byte with `cat -e` and `git diff` before/after; restoring the original 4-space formatting afterwards makes `promptobus install --check` print `⚠ drift: .claude/settings.json` and exit 1, on a project where claude hooks were never installed. (2) A project with a foreign `.codex/hooks.json` (`{"notification":[...]}`, no `hooks` key) and a foreign `.cursor/hooks.json` (`{"version":1,"hooks":{...}}`) — `promptobus install --harnesses claude` adds `"hooks": {}` to `.codex/hooks.json` and reformats `.cursor/hooks.json`, though neither harness was selected.

`test/install.test.mjs` (14 tests, all passing on this tree) covers semantic preservation of foreign hook groups (`merge keeps foreign settings, hook groups and unknown fields`, line 160) but no test asserts that a non-selected harness's file is left byte-identical.

## Work to do

- In `planHookInstall`, when a harness is not selected, push a write only if the merged `hooks` actually differ from `existing.doc.hooks` (a real removal of a leftover owned group) — skip the push, not just the disk write, when there is nothing of ours to strip, so a file the command was not asked to manage is never re-serialised and never gains an injected `hooks: {}` / `version: 1`.
- Add a test to test/install.test.mjs: install one harness in a project holding hand-formatted config files for the other two, assert those files are byte-identical afterwards, and that `install --check` then exits 0.

## Out of scope

- The byte-equality guard already in `install()` (around line 467) — it already does the right thing once `planHookInstall` stops generating a spurious write for a non-selected harness; this only fixes what feeds it.

## Verification

- The new test in test/install.test.mjs passes: hand-formatted foreign config files for unselected harnesses stay byte-identical across `install --harnesses <one>`.
- Manual repeat of probe 1 above (a 4-space `.claude/settings.json`, `install --harnesses cursor`) leaves the file untouched, confirmed with `git diff`.

## Triage — 2026-09-07

- **Track:** H — Hook installation and host commands.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/install.js:312`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
