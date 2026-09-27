# PB-304 · Make a technical-writer pass a release step, with vendored writing skills

- **Order:** 540
- **Scope:** [Contributing](../../guides/contributing.md), [Documentation index](../../README.md)
- **Created:** 2026-09-27
- **Dependencies:** none

- **Cost:** major

## Context

The owner made a technical-writer pass a permanent step of every promptobus release. Before the release commit, the step walks the human-facing documentation. It checks that the docs are current and reflect the changes since the previous release, and it removes recognisable AI-generated prose ("slop"). The pass uses writing skills vendored into this repository, under their licences and with attribution.

Research on 2026-09-27 compared Anthropic's public skill repositories and community skills; every SKILL.md compared byte-for-byte with its upstream HEAD, and every licence file was opened:

- Anthropic ships no humanizer and no technical-documentation editing skill. `doc-coauthoring` in anthropics/skills has no licence file; the docx/pdf/pptx/xlsx skills are proprietary; neither may be copied.
- Chosen:
  - **technical-documentation** by Wondel.ai: github.com/wondelai/skills, `plugins/code-craftsmanship/skills/technical-documentation/`, MIT © 2025 Wondel.ai sp. z o.o. Its content adapts Google's developer documentation style guide under CC BY 4.0. It covers reference docs, CLI help, changelogs per Keep a Changelog, and verifying every fact against the code.
  - **humanizer** by Siqi Chen: github.com/blader/humanizer, `SKILL.md` at commit 9862685f57, MIT © 2025 Siqi Chen. It removes AI-writing patterns derived from Wikipedia's "Signs of AI writing". In file mode it leaves code, commands and paths alone, and it keeps reference text neutral.
- Rejected:
  - hardikpandya/stop-slop — it forbids passive voice and inanimate subjects, which breaks reference prose;
  - dripips/plain-prose — its "name the actor" rule has the same problem, and its CI checker was not requested;
  - conorbronsdon/avoid-ai-writing — a 357 KB context cost;
  - obra/the-elements-of-style — no licence file;
  - Epicenter's google-devdocs-style — its directory is not covered by the licence;
  - interfold's asd-ste100 — LGPL-3.0;
  - skills tied to one project's house style (Nx, Angular, Pulumi, Supabase, Mendix).

## Work to do

- **Vendor the two skills** under `.agents/skills/technical-documentation/` and `.agents/skills/humanizer/`, copied from a pinned upstream commit. Each directory carries:
  - the upstream `LICENSE`, verbatim;
  - a `SOURCE.md` with the upstream URL, the full commit sha it was copied from, the copy date, and the list of modifications.
- **technical-documentation:** copy `SKILL.md` and its `references/` in full.
  - Keep the "About the Source" section unchanged: it is the CC BY 4.0 attribution to Google.
  - Remove the affiliate query parameter (`?tag=wondelai00-20`) from the Further Reading links. Record that removal as a modification: CC BY 4.0 requires indicating changes.
- **humanizer:** copy `SKILL.md` and `LICENSE`.
- **Project overlay.** Add `.agents/skills/tech-writer/SKILL.md`, the skill a technical-writer pass loads first. It states:
  - which documents are human-facing and in scope, and which are agent-facing and exempt. Skills, prompts, `AGENTS.md`, backlog cards and archive entries follow no style rules.
  - the precedence: this repository's own rules (`AGENTS.md`, GLOSSARY, `docs/guides/contributing.md`) > technical-documentation > humanizer;
  - the local resolutions of the known conflicts:
    - inanimate subjects are allowed ("The command exits with code 2");
    - reference text keeps uniform sentences;
    - bold is for flags, UI strings and run-in headings;
    - no contractions;
    - no per-procedure "What's next" tail;
    - a stated rule for the em dash;
  - that the pass never changes a behavioural statement without checking it against the code;
  - that `README.ru.md` is checked as a faithful counterpart of `README.md`, not rewritten by the English skills.
- **Release procedure.** No written release procedure exists; the steps of 0.18.0 and 0.19.0 live in orchestration briefs. Add `docs/guides/releasing.md` with the steps as they are done today:
  - the `[Unreleased]` heading becomes the dated version heading;
  - the version is updated in `docs/reference/01-overview.md` and `package.json`, together with the pinned documentation links and install examples;
  - build and gates;
  - the release commit `promptobus X.Y.Z`;
  - the annotated tag `vX.Y.Z`;
  - the push.

  Insert the technical-writer pass as a step before the release commit. Its inputs are the diff since the previous tag and the documentation; its output is a commit of documentation fixes, reviewed like any other piece. Link the guide from `docs/README.md` and `docs/guides/contributing.md`.
- **Regression check,** red at the base and green after:
  - every directory under `.agents/skills/` that is not generated output has a `LICENSE` and a `SOURCE.md` with an upstream URL and a 40-hex commit sha;
  - `docs/guides/releasing.md` exists, names the technical-writer step before the release commit, and points at the overlay skill.
- Check that `npm run audit` stays green on the vendored text. It refuses foreign tracker names and consumer names, and a vendored file may contain some. A conflict is a `question`, not an audit exception added on your own.

## Out of scope

- The first technical-writer pass over the documentation (PB-305).
- A mechanical prose checker in CI.
- Runtime changes, publication, and closing unrelated backlog entries.

## Verification

- The two vendored skills match their upstream files at the recorded sha, except for the listed modifications. Check with a diff against the files fetched at that sha.
- The licence and attribution requirements hold: MIT notices are kept verbatim, and the CC BY 4.0 attribution and change note are present.
- The regression check fails at the base and passes after the change. `npm run audit` and `backslop lint` pass.
