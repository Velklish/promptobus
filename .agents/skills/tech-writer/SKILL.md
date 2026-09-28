---
name: tech-writer
description: Run the technical-writer pass on human-facing documentation, the CLI help and the shipped skills before a promptobus release. Load this skill first. It sets which files are in scope for currency and for style, which files are exempt, and which local rules win over the vendored writing skills.
---

Load this skill before `.agents/skills/technical-documentation/SKILL.md` and `.agents/skills/humanizer/SKILL.md`.

## Precedence

Apply the first source that answers:

1. `AGENTS.md`, `docs/GLOSSARY.md`, `docs/guides/contributing.md`
2. `.agents/skills/technical-documentation/SKILL.md`
3. `.agents/skills/humanizer/SKILL.md`

## Scope

**Currency.** Check against the code changed since the previous release tag: the documentation listed under Style, `docs/adr/` and `docs/ROADMAP.md`, the terminal help text in `lib/cli.js` (`helpText`), and every shipped skill under `skills/`. The currency ledger, defined in the release guide, has one row for the CLI help and one row per shipped skill, each naming the change it was checked against or stating that none touches it.

**Style.** Walk human-facing documentation: `README.md`, `README.ru.md`, `CHANGELOG.md`, `docs/README.md`, `docs/GLOSSARY.md`, `docs/guides/`, `docs/reference/`, and the terminal help text in `lib/cli.js`.

These follow no style rules: skills, prompts, `AGENTS.md`, backlog cards, archive entries. Skills are written for agents, so they get the currency check and no style pass.

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
