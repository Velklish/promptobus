# PB-107 · The publicity gate's link check skips every markdown link that carries a fragment, so a path that no longer exists passes as long as the link ends in `#something`

- **Order:** 620
- **Scope:** `scripts/audit-public.mjs`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

scripts/audit-public.mjs:54 — `const LINK = /\]\(([^)#\s]+?)\)/g;` — is the only pattern the publicity gate uses to find markdown links, consumed by the loop at lines 65-72 that resolves each captured target against the filesystem and fails the gate on a missing or repo-escaping target. Because the character class excludes `#`, a captured group can never contain one — probed directly: ``x`` → no match at all, `[x](#sec)` → no match, ``x`` → matches `docs/A.md`, `[x](../triage/docs/A.md "T")` → no match (a titled link is excluded by the same class). Two consequences: (1) `target.startsWith('#')` at line 68 is dead code — `m[1]` can never start with `#` — which is itself evidence the fragment exclusion was accidental rather than intended, since the author clearly meant to special-case a pure-fragment link there; (2) any `path#anchor` link is never existence-checked or checked for leaving the repository — renaming or deleting the target file leaves `npm run audit` green.

Exposure today, measured by re-running the gate's own proseOf pass with a #-tolerant version of the regex over the tracked tree: exactly one anchored file link exists, README.md:166 → docs/reference/03-cli.md#model-routing, and it currently resolves (confirmed: docs/reference/03-cli.md exists). README.ru.md:165 carries the Russian equivalent of the same link but is a separate, already-known gap (the inline-code-span stripper eats that whole line — not this entry's subject). Every other ](#…) occurrence in the tree (docs/reference/03-cli.md, skills/orchestrate/SKILL.md, skills/solo-review/SKILL.md) is a pure in-file fragment, rightly outside the existence check's scope. No title-form ](path "Title") link exists in the tree today. So the hole is real and latent, not live: nothing is broken right now, but the gate would not catch it if it were.

PB-22 (archived) fixed the other half of this same pass — code spans and fenced blocks being read as prose — and its result.md scopes itself to that half only; the fragment/title hole was not part of it.

## Work to do

- Widen the pattern to capture the whole parenthesized target and split the fragment off before resolving: `const LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;` then, before resolving, `const file = target.split('#')[0]; if (!file) continue;` (a pure #anchor link has nothing to resolve), and resolve `file` while keeping the original `target` in the failure message so the reader sees the link as written.
- Remove the now-fully-redundant `target.startsWith('#')` guard at line 68 — `!file` covers it, and leaving both would re-hide the intent the dead code already obscured once.

## Out of scope

- Checking that an anchor names an actual heading in its target file — this entry only makes the file half of a path#anchor link resolve; the anchor half is unchecked before and after.
- The README.ru.md inline-code-span interaction that currently hides its line from the pass entirely — a different bug in the same script, already out of PB-22's stated scope and not touched here.

## Verification

- A constructed negative case: a link to a non-existent file with a fragment (`x`) turns npm run audit red; the same link without the fragment turns it red identically.
- npm run audit stays green on the current tree (the one real anchored link, README.md:166, still resolves).

## Triage — 2026-09-07

- **Track:** Q — Verification, shared execution and documentation.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `scripts/audit-public.mjs:54`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
