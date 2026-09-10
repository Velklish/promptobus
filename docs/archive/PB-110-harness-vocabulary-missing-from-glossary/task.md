# PB-110 · The Cursor/Codex vocabulary — holder, contact point, persist session, thread, session record — is used a hundred times over in code and reference and defined in zero rows of the glossary the project's own rule requires it to come from

- **Order:** 640
- **Scope:** `docs/GLOSSARY.md`, `lib/codex-session.js`, `lib/codex-hold.js`, `lib/driver-codex.js`, `lib/cursor-persist.js`, `lib/driver-cursor.js`, [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06
- **Dependencies:** PB-42, PB-153

## Context

Re-counted now against current HEAD with `grep -ric` over `lib/` and `docs/reference/` versus `docs/GLOSSARY.md`: `holder` 101/0, `wake` 138/2, `thread` 80/0, `contact point` 33/0, `persist session` 32/0, `session record` 19/0 — all five terms still have zero glossary hits despite heavy use in code and reference.

`AGENTS.md:11` states the rule verbatim: "Use terms from the glossary; if a required term is missing, propose it rather than silently inventing it." `docs/reference/03-cli.md:687` carries a section headed "## The Codex holder" that uses `holder`, `thread` and `session record` as load-bearing concepts without ever defining them. The concepts are instead defined informally, once each, in file-comment headers: `lib/codex-session.js` ("Why the holder is a separate process"), `lib/cursor-persist.js` ("What `agent persist` is"), `lib/driver-cursor.js` ("Contact point of a Cursor participant"). `docs/GLOSSARY.md`'s own "Retired terms" table shows the project already treats drifting vocabulary as worth a row — that is exactly what happened with `inbox` → `mailbox`.

## Work to do

- Add glossary rows for `holder`, `contact point`, `persist session`, `thread` and `session record`, in the existing `| Term | EN | Definition | Evidence |` shape, each evidenced by the file that currently defines the concept informally
- Decide in the same pass whether `thread` and `persist session` are one concept named twice; if so, add the loser to "Retired terms"
- Point `docs/reference/03-cli.md`'s "## The Codex holder" section at the new glossary rows instead of re-explaining the concepts inline

## Out of scope

- Renaming any of the five terms in code or CLI output — this documents vocabulary already in use, it does not change it
- A broader terminology audit beyond these five terms

## Verification

- `docs/GLOSSARY.md` has one row each for holder, contact point, persist session, thread, session record
- `grep -ic <term> docs/GLOSSARY.md` returns nonzero for all five
- `03-cli.md`'s "The Codex holder" section matches or links to the glossary's definitions

## Triage — 2026-09-07

- **Track:** Q — Verification, shared execution and documentation.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including the files named in Scope and the current repository configuration. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep thread and persist session as distinct harness-specific concepts unless evidence proves otherwise; do not retire one merely because both represent sessions.
