# PB-293 · Align both READMEs, overview and glossary with the current hooks and role contract

- **Order:** 430
- **Scope:** [01-overview](../../reference/01-overview.md), [05-drivers](../../reference/05-drivers.md)
- **Created:** 2026-09-27
- **Dependencies:** none

- **Cost:** major

## Context

Several entry-point descriptions still state the old feedback-hook, tool-count and role contract. They conflict with current implementation and with newer sections on the same pages.

## Evidence

- At b3d4a387, README.md:28,225, README.ru.md:24,199, docs/GLOSSARY.md:68 and docs/reference/01-overview.md:231-234 describe a current bus feedback/feed hook. src/hooks.ts:8-10,48-73 defines Stop and SessionStart; the former PostToolUse feed hook was removed. docs/guides/hooks-and-trust.md:82 requires retaining the runner that :19 says install removes.

- README.md:247 and README.ru.md:220 claim templates/ is shipped; package.json files omits it and test/promptobus-package.test.mjs:426-430 explicitly excludes it.

- README.ru.md:24,150-156 and docs/reference/01-overview.md:195-200 describe three MCP tools; src/mcp/tools.ts:35-126 declares six. RU :152 still has the old address list and :127-144 omits newer primary operations while English already reflects them.

- docs/guides/hooks-and-trust.md:25 says a participant never works at the workspace root, but teamlead/reporter do (lib/spawn.js:726; lib/report.js:47,179-180). docs/GLOSSARY.md:55 limits UNANSWERED to ended turns, omitting immediate user-question debt in lib/status.js:216-221.

## Work to do

- Align EN/RU entry descriptions, Overview and glossary with the real hook, tool, role, routing and package surfaces.
- Separate legacy uninstall/upgrade recognition from current hooks. Explain workspace-root roles and immediate orchestrator question debt.
- Retain English as canonical; make the Russian overview functionally consistent rather than duplicating every internal implementation paragraph.

## Out of scope

- Runtime feature changes, publication, and closing unrelated backlog entries.

## Verification

- Compare planPromptobusHooks (the Claude/Codex Stop and SessionStart hook set), the Cursor stop-only installer and mcpTools(SHIPPED_REGISTRY) (six tools) with their respective descriptions.
- Check declared commands against CLI help and shipping claims against npm pack inventory.
- No current section promises the removed feed hook/runner or excludes supported role exceptions.
