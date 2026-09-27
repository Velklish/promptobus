# PB-292 · Keep documentation links usable in the packed package and installed skills

- **Order:** 420
- **Scope:** [01-overview](../../reference/01-overview.md), [Install](../../guides/install.md)
- **Created:** 2026-09-27
- **Dependencies:** none

- **Cost:** major

## Context

Links work in the source checkout but become unresolved in both delivery surfaces. Merely checking repository file existence cannot establish self-contained installed documentation.

## Evidence

- At b3d4a387, `npm pack --dry-run --json --ignore-scripts --cache ../npm-cache` exited 0 and listed 146 entries. The four shipped Markdown files contain 67 relative links; 47 point at files not in that list, including docs/, CHANGELOG.md, backslop.json and .github/workflows/ci.yml. package.json:9-19 excludes those documentation destinations.

- README.md:21,43,69,101 and README.ru.md:38,64,96 are examples. skills/orchestrate/SKILL.md:186,227 points at ../../docs/.

- A disposable workspace with promptobus.json tools=[claude,cursor,codex], followed by `node <checkout>/bin/promptobus.js install --harnesses claude,cursor,codex`, exited 0. The six installed SKILL.md files contain 21 relative links: 9 are missing, the same three orchestrate documentation targets for each harness. They resolve under .claude/docs, .cursor/docs or .codex/docs.

- lib/install.js:532-544 copies each package skill's buffer/text to the harness skills directory unchanged.

## Work to do

- Choose a portable documentation layout or stable versioned destinations for package README and process skills; preserve offline-required instructions inline or alongside installed skills.
- Ensure the installed skills use destinations valid from their installed locations. Shipping docs/ at the package root alone does not repair the harness-directory case.
- Do not include private tracker material merely to satisfy the package inventory.

## Out of scope

- Runtime feature changes, publication, and closing unrelated backlog entries.

## Verification

- Pack and extract the actual package in a temporary directory; every shipped documentation link resolves in the supported delivery context.
- Install all three skill adapters in a fresh disposable workspace and resolve each relative link from its installed file; zero missing destinations.
- Repeat source checkout link checks so fixing installed paths does not break repository readers.
