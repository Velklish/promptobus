# PB-415 · Migrate maintained Promptobus code to strict TypeScript without changing runtime contracts

- **Scope:** [Entry points and runtime](../../reference/01-overview.md#entry-points), [Host](../../reference/02-host.md), [Drivers](../../reference/05-drivers.md)
- **Created:** 2026-10-30
- **Dependencies:** none
- **Cost:** major
- **Previous order:** 380
- **Taken:** 2026-10-30

## Context

The owner requested a migration of maintained Promptobus code to strict TypeScript on 2026-10-30, split into independently accepted tasks. The owner interview selected runtime and CLI first; maintained tests and scripts stay JavaScript in this phase. The runtime currently combines typed source under src/ with unchecked JavaScript under lib/; tsconfig.json includes only src/. The shared MCP and warden change has its own task, PB-416, and must not be hidden inside a language-only migration.

A parallel session owns the the private workspace consumer migration. That consumer imports Promptobus library entry points and supplies a PromptobusHost with callbacks. Its installed dependency remains pinned to 0.31.0 until a complete replacement artifact is ready. Public package specifiers, PromptobusHost signatures, and the emitted paths dist/index.js, dist/host-index.js, lib/cli.js and bin/promptobus.js remain compatible. Production bytes and consumer bundle provenance are updated together only at the final consumer handover.

Use the personally installed codebase-design and typescript-advanced-types skills. Repository terminology and contracts take precedence. Prefer ordinary explicit types and narrowing; advanced type machinery needs an actual contract that benefits from it.

## Work to do

- Migrate maintained runtime and CLI source. Keep tests and scripts in JavaScript for this phase, changing them only where the build layout and verification require it.
- Complete the five independently accepted stages in dependency order: [build and leaf modules](PB-415.1-typescript-build-leaves.md), [common runtime](../queue/PB-415.2-typescript-common-runtime.md), [drivers and lifecycle](../queue/PB-415.3-typescript-drivers-lifecycle.md), [routing and management](../queue/PB-415.4-typescript-routing-management.md), and [orchestration and CLI](../queue/PB-415.5-typescript-orchestration-cli.md). Each stage has its own verification, independent subagent review and acceptance commit.
- Preserve package exports and emitted runtime paths while moving maintained implementation to checked TypeScript. Keep a clean build possible from a fresh checkout without requiring pre-existing generated output.
- Preserve runtime behavior, journal schemas, CLI arguments, child-process launch paths, hook signatures, permissions, routing, lifecycle and error contracts.
- Keep fixtures in JavaScript when their purpose is to exercise JavaScript or an external protocol. Document the explicit exceptions rather than silently excluding maintained source from type checking.
- Preserve test discovery, isolation, mutation probes and source-sensitive checks when source files move; renaming files must not reduce the executed test set.
- Have independent read-only subagents review each child. Fix critical and major findings before acceptance; record minor findings in Backslop with evidence.

## Out of scope

- Rewriting the runtime in Go, C# or another language.
- Unrelated architectural refactoring, dependency replacement, or changes to supported harness behavior.
- Implementing the shared MCP/warden design as an undocumented consequence of the language migration.
- Editing the private workspace consumer, its dependency pin or its trusted production manifest from this repository.
- Converting the maintained test suite and standalone development scripts to TypeScript in this phase.

## Verification

- Strict type checking covers the maintained code selected by the owner without blanket any, ts-nocheck or suppression-based migration escapes.
- Fresh checkout build and packed-package consumer checks resolve every public specifier and the preserved runtime paths.
- Test discovery before and after migration is compared explicitly; all maintained suites remain runnable and no case disappears due to its extension or directory.
- Every accepted child records exact commands, exit codes, counts, commit and remaining limitations. Changed tests carry the repository mutation probe.
- The configured gates pass on the integrated committed source: npm test, npx --no-install backslop lint, npm run audit, npm run pins and npm run codex-schema. An unavailable live resource is named separately and is not reported as runtime proof.
- Final independent review has zero critical and major findings. Minor findings have evidence-bearing backlog entries.
