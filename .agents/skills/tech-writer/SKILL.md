---
name: tech-writer
description: Run the technical-writer pass on human-facing documentation before a promptobus release. Load this skill first. It sets which documents are in scope, which files are exempt, and which local rules win over the vendored writing skills.
---

Load this skill before `.agents/skills/technical-documentation/SKILL.md` and `.agents/skills/humanizer/SKILL.md`.

## Precedence

Apply the first source that answers:

1. `AGENTS.md`, `docs/GLOSSARY.md`, `docs/guides/contributing.md`
2. `.agents/skills/technical-documentation/SKILL.md`
3. `.agents/skills/humanizer/SKILL.md`

## Scope

Walk human-facing documentation: `README.md`, `README.ru.md`, `CHANGELOG.md`, `docs/README.md`, `docs/GLOSSARY.md`, `docs/guides/`, `docs/reference/`.

These follow no style rules: skills, prompts, `AGENTS.md`, backlog cards, archive entries.

Check `README.ru.md` as a faithful counterpart of `README.md`. Do not rewrite it with the English skills.

Do not restyle an accepted ADR. Supersede it.

## Local rules

- An inanimate subject is allowed. Write "The command exits with code 2".
- Reference text keeps uniform sentences.
- Bold a flag, a UI string, or a run-in heading.
- Write English without contractions.
- Do not add a "What's next" tail to a procedure.
- Use a spaced em dash for a parenthetical break. Keep the dashes the file already uses. Do not strip them, and do not replace them with a hyphen or an en dash.
- Do not change a behavioural statement until you have checked it against the code.
