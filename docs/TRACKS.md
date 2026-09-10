# Backlog tracks — 2026-09-07

This document records triage decisions and execution boundaries, not a second status board. Status is the task directory; priority is its `Order` field. Use `npx github:Velklish/backslop#v0.4.0 status` for the current queue. Track assignments below are a planning snapshot and do not imply a running worker.

## Scope and evidence

Reviewed all 112 triage definitions, the 9 queued tasks and 4 existing deferrals at `1e0401a` on `main`. A successful `git fetch origin` confirmed the checkout was one local commit ahead and zero behind `origin/main`; that local commit contains only the audit findings, while runtime code remains at `cc1aca8`. Source inspection checked the cited mechanisms and highlighted recipes that need correction. Historical live measurements are retained as prior evidence, not claimed as rerun. No runtime fix, paid harness turn, external system write, worker launch or push belongs to this pass.

The resulting snapshot is **103 queued, 16 deferred, 0 active and 0 triage**, plus **6 records merged into existing tasks**. No finding was rejected. A queue entry with a design checkpoint is queued investigation; it is not blanket approval for the implementation alternatives in its original text.

P0 means possible data loss (PB-63, PB-66). P1 means session safety, broken operation, incorrect decision or a necessary verification prerequisite. P2 means bounded compatibility, diagnostics, documentation or regression coverage. P3 marks work waiting for a stated return condition. Order also respects dependencies: early gate work may precede a higher-impact repair because it makes acceptance meaningful.

## Tracks

Shared files impose sequencing. These are subsystem tracks, **not ten simultaneous workers**. The collision table below is part of their execution contract.

| Track | Outcome | Primary change boundary | Queue / deferred |
|---|---|---|---|
| Q — Verification, shared execution and documentation | Project gates, shared exec, stand/live-script correctness, packaging and final documentation | `backslop.json, package.json, CI, scripts/, test runner/hygiene/package tests, lib/exec.js; shared docs at integration` | 28 / 0 |
| S — Store integrity and public engine | No lost mail, no destructive migration replay, consistent store errors and public types | `src/migrate.ts, src/protocol.ts, src/v1/, lib/store.js, history/dismiss/prune; related v1 tests` | 10 / 0 |
| C — Codex session lifecycle | Diagnosed, isolated Codex sessions and correct RPC / approval handling | `lib/codex-rpc.js, lib/codex-session.js, lib/driver-codex.js; Codex fixtures/tests` | 13 / 0 |
| D — Harness registries and Cursor / Claude drivers | Correct registry refusals, private Cursor delivery, consistent binary discovery and Claude limits | `lib/harness-home.js, lib/cursor-persist.js, lib/driver-cursor.js, lib/driver-claude.js; related driver tests` | 6 / 1 |
| R — Routing policy, overlays and availability | Safe overlays, explainable routing, robust availability and evidence-backed catalog maintenance | `lib/models.js routing paths, lib/model-routing/{catalog,resolver,validate,preflight,cache,render,adapter-*}.js; routing schemas/tests/catalog` | 16 / 1 |
| T — Telemetry and calibration | Fresh spend evidence and meaningful, reviewable calibration writes | `lib/model-routing/{telemetry,calibrate}.js, calibration paths in lib/models.js, lib/done.js, telemetry schema/tests` | 9 / 0 |
| H — Hook installation and host commands | Portable owned hooks and an honest install/check/dry-run contract | `src/hooks.ts, lib/contract.js, lib/install.js, hook template, host seams and install tests` | 8 / 0 |
| L — Spawn, review and command guidance | Bounded spawn/review operations, accurate prompts and host-aware command hints | `lib/spawn.js, lib/review.js, lib/worktree.js, lib/cli.js; spawn/review/CLI tests and skills` | 10 / 0 |
| W — Guard and warden delivery | Correct wake identity, reason transitions and bounded guard input | `src/supervisor.ts, src/sidecar.ts, lib/guard.js, warden/guard tests` | 3 / 0 |
| X — Deferred structural work | Optional structural changes and externally blocked proposals | `See each deferred task; no worker allocation in this pass` | 0 / 14 |

## Execution sequence and shared files

1. **Prepare acceptance.** Q takes PB-71/PB-141 and PB-50/PB-122; D takes PB-45; H takes PB-119. Finish each before another track edits its shared files. PB-67/PB-68/PB-69 must land before any live script becomes acceptance evidence.
2. **Repair integrity and routing.** S, the remaining D work, and R's overlay/availability fixes can be separate batches after preparation. Common references and CHANGELOG are integrated by the queue owner. Do not overlap R's PB-116 with C.
3. **Repair Codex lifecycle.** C follows S's shared status/store changes and D's registry prerequisite. H's install-only work can run alongside it after the shared host/driver declarations have settled. Keep its host and fixture edits out of C's files.
4. **Finish dependent tracks.** T follows R because both edit `lib/models.js` and routing contracts. L follows C/H for launch plans and host commands; its PB-55/PB-140 wait for T/S call sites. W follows C's PB-42 and T's PB-48 for status integration. T, L and W are not assumed independent: take the listed shared-file tasks serially.
5. **Align and verify the release surface.** Q finishes documentation, package/link checks, CI, and remaining stand changes after the owning runtime tracks. X has no allocated worker; reevaluate only on each recorded trigger.

| Shared surface | Tracks | Serialization / owner |
|---|---|---|
| `lib/exec.js`, process defaults / environment | Q, L | Q PB-50/PB-122 before L PB-126; callers retain their own outcome contracts |
| `lib/codex-session.js`, `lib/driver-codex.js` | D, C, R | D PB-45, then C, then R PB-116 |
| `lib/driver-claude.js`, `lib/contract.js`, `src/hooks.ts` | H, D | H PB-119 before D PB-148 and other driver changes |
| `src/host.ts`, `src/standalone.ts`, `src/hooks.ts` | H, L, Q | H owns host-command changes; L consumes them; Q's reference updates follow |
| `lib/models.js`, routing schemas, model tests | R, T, L | R then T, then L's command-hint edits; no concurrent patches to the same functions |
| `lib/status.js`, `lib/done.js`, `lib/prune.js`, store facade | S, C, T, L, W | S first; C outcome display, T telemetry/tallies, L hints, W health display follow serially |
| `lib/spawn.js`, `lib/review.js`, CLI/launch tests | C, L, Q | C PB-121, then L; Q updates synopsis/help against final behavior |
| `src/supervisor.ts`, `src/sidecar.ts` | C, W | C PB-42 first, then W PB-64/PB-79 |
| Harness stand modules and driver tests | Q, C, D, R | Q PB-141 before runtime work; diagnostic extraction PB-142 after those fixtures stabilize |
| `docs/reference/`, guides, skills, `CHANGELOG.md`, package/CI configuration | All, Q | Queue owner integrates proposed documentation with each accepted task; final Q pass verifies parity. Workers do not independently edit these shared files in parallel. |

A worker brief must name exact files and exclusions for its selected batch, reproduce the task definitions and acceptance cases, and include the shared-file order. No task moves to active until a worker is actually assigned. Creating workers, selecting harnesses and approving policy/contract alternatives are separate from this triage.

## Consolidation and scope corrections

| Closed record | Receiving task | Reason |
|---|---|---|
| PB-74 | PB-78 | Same incorrect overlay-layer attribution; the broader task covers host-declaration faults as well |
| PB-86, PB-128 | PB-119 | Same server-name duplication; PB-119 also retains its separate guard-event pair |
| PB-111 | PB-76 | Same obsolete Cursor hook documentation |
| PB-92 | PB-113 | Same stale canary procedure; preserve its independent useful home-snapshot check |
| PB-39.1 | PB-42 | Failed-turn visibility already belongs to the event/status watchdog |

The receiving definitions retain the complete source material. Archive results explicitly say **merged**, not implemented. The missing stdout listener stays in PB-149; PB-81 is only the deferred adapter consolidation. Manifest drift belongs solely to PB-100; PB-154 now fixes merged Cursor event validation. These partial overlaps are not whole-task merges.

Corrections that affect implementation:

- PB-63 must protect installations with an already-leftover migration marker; cleaning up future markers alone does not protect their restored legacy data.
- PB-131 needs runtime immutability; TypeScript `as const` alone is erased and cannot fix JavaScript mutation.
- PB-41's elicitation causality and PB-90's proposed effort transport need protocol evidence. PB-97 is a distinct confirmed dispatch hazard, not a proven explanation of every hang.
- PB-57 must resolve throughput versus completion duration before PB-56 changes the calibration input. Pooling effort levels does not resolve the unit mismatch.
- PB-52 must not recognize ownership solely by a command substring. PB-89 must reject symlink escapes as well as accept legitimate symlinked roots. PB-144 must preserve live neighboring runs when sweeping old sockets.
- PB-59/PB-60/PB-105 queue bounded diagnostic repairs; changing floor, fail-closed or strategy-selection policy still needs an explicit decision. PB-87 queues a reviewer capability/contract design, not guessed tool-name classification.
- PB-139 is deferred with a corrected check plan: `@ts-check` on files excluded by tsconfig does not create a CLI type-check gate.
- PB-137's missing repository metadata is confirmed; its registry-rendering consequence remains a hypothesis until a rendered example is checked. PB-151 file visibility depends on umask; the proven omission is an explicit private mode and unconditional cleanup.
- PB-55/PB-70/PB-103/PB-110/PB-112/PB-135/PB-142 exclude unnecessary API expansion, new release automation, concept renaming, cross-repository edits and broad refactors from their default fix.

Consumer identifiers in the touched backlog definitions were replaced with neutral labels to satisfy the existing publication gate. Source paths, mechanisms and prior observations remain traceable; no audit rule was relaxed.

## Task assignments

Within each track, the queued list follows the current global order. Dependencies and design checkpoints in each task remain binding. Deferred items retain a track for later planning, without joining the current batch.

### Q — Verification, shared execution and documentation

Start with PB-71/PB-141 and PB-50/PB-122. Stabilize live evidence with PB-67/PB-68/PB-69 before trusting live verdicts. Documentation alignment and broad audit work finish after runtime tracks.

Queued assignments: [PB-71](archive/PB-71-gates-omit-npm-test/task.md), [PB-141](archive/PB-141-hygiene-drops-claude-config-dir/task.md), [PB-50](archive/PB-50-harness-run-missing-ceilings/task.md), [PB-122](archive/PB-122-windows-path-ignored-by-planrun/task.md), [PB-67](archive/PB-67-live-mixed-matcher-uses-wrong-field/task.md), [PB-68](archive/PB-68-live-cursor-review-verdict-false-green/task.md), [PB-69](archive/PB-69-dead-path-prepend-live-scripts/task.md), [PB-114](archive/PB-114-live-run-sweep-gaps/task.md), [PB-144](archive/PB-144-stray-tmp-sockets-unswept/task.md), [PB-82](archive/PB-82-package-test-missing-catalog-check/task.md), [PB-108](archive/PB-108-exports-map-untested-specifiers/task.md), [PB-70](archive/PB-70-version-drift-changelog-tag/task.md), [PB-72](archive/PB-72-contributing-guide-drifted-facts/task.md), [PB-73](archive/PB-73-forbidden-list-missing-brand/task.md), [PB-75](archive/PB-75-roadmap-cyrillic-check-not-gated/task.md), [PB-94](archive/PB-94-ci-unpinned-ast-grep-backslop/task.md), [PB-107](archive/PB-107-link-check-skips-fragments/task.md), [PB-110](archive/PB-110-harness-vocabulary-missing-from-glossary/task.md), [PB-112](archive/PB-112-reference-docs-lag-current-code/task.md), [PB-113](archive/PB-113-live-canary-narrates-removed-commands/task.md), [PB-137](archive/PB-137-readme-links-need-repository-field/task.md), [PB-138](archive/PB-138-audit-public-portable-launch/task.md), [PB-142](archive/PB-142-harness-duplication-hides-scenario-errors/task.md), [PB-143](archive/PB-143-sweep-list-has-dead-prefixes/task.md), [PB-46](archive/PB-46-roadmap-catalog-numbers-stale/task.md), [PB-47](backlog/queue/PB-47-orchestrate-skill-cli-drift.md), [PB-84](archive/PB-84-cli-help-strategy-default-stale/task.md), [PB-104](archive/PB-104-hidden-models-reference-mismatch/task.md).

Added after this snapshot: [PB-50.1](archive/PB-50.1-git-max-output-names-a-process-wide-budget/task.md) — the shared output budget kept a git-specific name when PB-50 widened its reach.

### S — Store integrity and public engine

PB-63 and PB-66 are P0. PB-66 precedes PB-65 and reader taxonomy. PB-101 follows the version/error fixes; PB-147 tests its cleanup boundary.

Queued assignments: [PB-63](archive/PB-63-migrate-mark-never-removed/task.md), [PB-66](archive/PB-66-recovery-misreads-errno-as-corruption/task.md), [PB-65](archive/PB-65-recovery-open-failure-bricks-store/task.md), [PB-132](archive/PB-132-task-id-grammar-two-homes/task.md), [PB-146](archive/PB-146-unreadable-record-taxonomy-gap/task.md), [PB-102](archive/PB-102-mixed-version-diagnosis-unreachable/task.md), [PB-101](archive/PB-101-four-commands-bypass-host-home/task.md), [PB-131](archive/PB-131-message-types-mutable-array/task.md), [PB-135](archive/PB-135-sendsyncinput-not-exported/task.md), [PB-147](archive/PB-147-prune-remove-seam-untested/task.md).

### C — Codex session lifecycle

PB-97 before PB-41; PB-49/PB-99 before PB-42. Do not conflate a protocol collision with the unproven cause of the historical elicitation hang. PB-90 requires protocol evidence.

Queued assignments: [PB-97](archive/PB-97-codex-rpc-id-collision/task.md), [PB-49](archive/PB-49-codex-holder-spawn-error-unhandled/task.md), [PB-41](archive/PB-41-codex-reviewer-hangs-after-elicitation-allow/task.md), [PB-99](archive/PB-99-codex-rising-branch-ignores-error-age/task.md), [PB-42](archive/PB-42-codex-activity-watchdog/task.md), [PB-115](archive/PB-115-codex-socket-fallback-collision/task.md), [PB-152](archive/PB-152-codex-session-record-env-leak/task.md), [PB-88](archive/PB-88-codex-approval-text-match-false-positive/task.md), [PB-89](archive/PB-89-codex-approval-symlink-paths/task.md), [PB-90](archive/PB-90-codex-reviewer-effort-dropped/task.md), [PB-150](archive/PB-150-currenttime-read-approve-table/task.md), [PB-98](archive/PB-98-codex-sessions-phrase-wrong-home/task.md), [PB-121](archive/PB-121-codex-dry-run-prompt-via-argv/task.md).

Added after this snapshot: [PB-156](archive/PB-156-codex-thread-name-ignores-chosen-session-name/task.md) — the Codex thread takes a machine name and never receives the readable session name the mechanism chose.

### D — Harness registries and Cursor / Claude drivers

PB-45 is a cross-driver prerequisite and edits Codex too: finish it before C. PB-151 is the first Cursor repair. PB-120 is deferred.

Queued assignments: [PB-45](archive/PB-45-registry-read-swallows-refusal/task.md), [PB-151](archive/PB-151-cursor-inject-buffer-file-mode/task.md), [PB-148](archive/PB-148-limit-regex-alternation-order/task.md), [PB-153](archive/PB-153-cursor-status-turn-count-wrong/task.md), [PB-85](archive/PB-85-driver-cursor-tmux-path-only/task.md), [PB-93](archive/PB-93-cursor-bin-name-order-mismatch/task.md).

Added after this snapshot: [PB-45.1](archive/PB-45.1-snapshot-path-hides-registry-refusal/task.md) — the snapshot path degrades a registry refusal to a reasonless `unknown`, so the operator still sees silence; it reaches into the shared `src/driver.ts` / `lib/status.js` seam.

Deferred assignments: [PB-120](backlog/deferred/PB-120-dead-effort-map-and-fresh-flag.md).

### R — Routing policy, overlays and availability

PB-155/PB-78/PB-58 first. PB-43 precedes PB-59/PB-105. Keep their policy choices explicit. PB-116 waits for C; PB-38.2 is deferred. PB-34.1/PB-37.3 are evidence work, not permission to run paid probes or invent ratings.

Queued assignments: [PB-155](archive/PB-155-catalog-merge-proto-guard-gap/task.md), [PB-78](archive/PB-78-catalog-layer-attribution-wrong/task.md), [PB-58](archive/PB-58-preflight-cache-write-throws/task.md), [PB-60](archive/PB-60-strategy-default-silent-drop/task.md), [PB-43](archive/PB-43-balance-representative-hides-better-paced-pool/task.md), [PB-59](archive/PB-59-balance-floor-warning-false/task.md), [PB-149](archive/PB-149-cursor-stdout-error-listener/task.md), [PB-136](archive/PB-136-overlay-parity-corpus-gap/task.md), [PB-37.1](archive/PB-37.1-promotional-price-band-has-no-expiry-signal/task.md), [PB-61](archive/PB-61-models-flags-wrong-subcommand/task.md), [PB-105](archive/PB-105-near-limit-strategy-mismatch/task.md), [PB-125](archive/PB-125-unvalidated-harness-cache-key/task.md), [PB-124](archive/PB-124-routing-vocab-parity-gap/task.md), [PB-116](backlog/queue/PB-116-codex-initialize-handshake-duplicated.md), [PB-37.3](archive/PB-37.3-terminal-bench-4-0-has-no-anchor-pair/task.md), [PB-34.1](archive/PB-34.1-claude-inventory-narrower-than-baked-table/task.md).

Deferred assignments: [PB-38.2](backlog/deferred/PB-38.2-cursor-tier-unknown-until-first-turn.md).

### T — Telemetry and calibration

PB-77 plus PB-37.2 before PB-57; resolve the throughput-versus-duration contract before PB-56 or changing speed ratings. PB-62/PB-91/PB-106 protect the write workflow. PB-48 comes after timestamp/tally semantics.

Queued assignments: [PB-77](archive/PB-77-telemetry-end-reading-stale-exhausted/task.md), [PB-37.2](archive/PB-37.2-done-does-not-refresh-windows-so-calibrate-loses-spend/task.md), [PB-57](archive/PB-57-calibrate-speed-per-effort-rung/task.md), [PB-56](archive/PB-56-calibrate-speed-shared-end-stamp/task.md), [PB-62](archive/PB-62-calibrate-confirm-before-print/task.md), [PB-91](archive/PB-91-calibrate-write-shadowed-silently/task.md), [PB-106](archive/PB-106-calibrate-write-overlay-gaps/task.md), [PB-145](archive/PB-145-pivot-tie-break-untested/task.md), [PB-48](archive/PB-48-review-rounds-not-exposed-mid-run/task.md).

### H — Hook installation and host commands

PB-119 first, then PB-103/PB-52. PB-53 precedes PB-100, then PB-154. PB-76 includes PB-111. PB-109 fixes regeneration guidance without changing config policy.

Queued assignments: [PB-119](archive/PB-119-duplicate-server-and-hook-constants/task.md), [PB-103](archive/PB-103-guard-hook-hardcodes-promptobus-word/task.md), [PB-52](archive/PB-52-guard-ownership-machine-local/task.md), [PB-53](archive/PB-53-install-rewrites-unselected-files/task.md), [PB-100](archive/PB-100-install-dry-run-check-mismatch/task.md), [PB-154](archive/PB-154-install-check-gates-blind/task.md), [PB-76](archive/PB-76-cursor-hooks-doc-mismatch/task.md), [PB-109](archive/PB-109-bus-hook-sync-command-missing/task.md).

Added after this snapshot: [PB-119.1](archive/PB-119.1-install-writes-hook-event-names-by-hand/task.md) — `lib/install.js` writes the hook event names as literals while importing the matcher from `dist`, leaving `GUARD_HOOK_EVENT` an untied third door.

### L — Spawn, review and command guidance

PB-126 uses Q process fixes. PB-121 in C precedes changes to launch rendering. PB-87 is a design/capability checkpoint. PB-55 and PB-140 integrate after their shared model/store call sites stabilize.

Queued assignments: [PB-87](archive/PB-87-reviewer-mcp-write-isolation/task.md), [PB-126](archive/PB-126-review-git-spawn-no-timeout/task.md), [PB-83](archive/PB-83-spawn-preamble-missing-deps-line/task.md), [PB-44](backlog/queue/PB-44-rules-list-dry-run-only.md), [PB-51](backlog/queue/PB-51-standalone-plugin-warning-wrong.md), [PB-54](backlog/queue/PB-54-review-refusals-plain-error.md), [PB-55](backlog/queue/PB-55-bus-hint-wraps-wrong-command.md), [PB-80](backlog/queue/PB-80-cli-catch-instanceof-not-name.md), [PB-96](backlog/queue/PB-96-reviewer-worktree-pickup-fallback.md), [PB-140](backlog/queue/PB-140-refusal-messages-hardcode-bare-command.md).

Added after this snapshot: [PB-158](archive/PB-158-done-keeps-a-branch-it-proved-merged/task.md) — `done` removes a worktree on proven squash containment but leaves its own branch, because the branch check falls back to an ancestry test a squash cannot satisfy.

Added after this snapshot: [PB-157](archive/PB-157-review-snapshot-reads-dirty-worktree/task.md) — the review snapshot is taken from the working tree, so a mandated post-commit mutation probe removes the reviewed change from the diff. Ordered near the top: it is a verification prerequisite for every track.

### W — Guard and warden delivery

After PB-42, fix PB-64, then PB-79, then PB-123. Preserve the distinction between a new turn and a restarted session.

Queued assignments: [PB-64](archive/PB-64-warden-fingerprint-conflates-restart/task.md), [PB-79](archive/PB-79-self-wake-missing-contact-reason/task.md), [PB-123](archive/PB-123-guard-verdict-and-stdin-deadline/task.md).

### X — Deferred structural work

Every deferred item has its own return condition. This is a future track, not part of the executable batch; PB-120 stays mapped to D and PB-38.2 to R.


Deferred assignments: [PB-81](backlog/deferred/PB-81-cursor-stdout-guard-and-dedupe.md), [PB-95](backlog/deferred/PB-95-mutation-probe-has-no-script.md), [PB-117](backlog/deferred/PB-117-registry-and-driver-duplication.md), [PB-118](backlog/deferred/PB-118-done-triple-listtasks-walk.md), [PB-127](backlog/deferred/PB-127-dead-file-citations-in-comments.md), [PB-129](backlog/deferred/PB-129-duplicate-worktree-spawn-failure-classification.md), [PB-130](backlog/deferred/PB-130-fs-primitive-copies-lib-src.md), [PB-133](backlog/deferred/PB-133-store-path-names-scattered.md), [PB-134](backlog/deferred/PB-134-messages-read-loop-dedup.md), [PB-139](backlog/deferred/PB-139-tsc-lib-untyped-unused-code.md), [PB-13.2](backlog/deferred/PB-13.2-catalog-has-no-payg-row.md), [PB-16.1](backlog/deferred/PB-16.1-cursor-start-path-names-no-limit.md), [PB-24.1](backlog/deferred/PB-24.1-codex-notification-window-duration.md), [PB-24.2](backlog/deferred/PB-24.2-snapshot-model-has-no-efforts-or-speed-tiers.md).

## Verification of this triage

Baseline `backslop lint` passed. Baseline `npm run audit` failed on 21 publication findings in the existing backlog text. The local cached Backslop executable was verified as version 0.4.0; npm used a scratch cache because the sandbox cannot write the normal cache.

Final results:

- Backslop 0.4.0 `lint`: passed.
- `npm run audit` with a scratch npm cache: passed on 557 tracked files and a 117-entry packed tarball; its build step passed.
- Inventory check: all 125 original open IDs survive exactly once; all 103 queued tasks have a single track assignment and unique order; all 16 deferrals have return conditions; triage and active are empty; all six merge results are complete.
- `git diff --check`: passed. Changes are confined to task documentation, the documentation index, backlog guidance, the track plan and CHANGELOG. Runtime, schemas, tests, package settings and adapters are unchanged.
- No full runtime suite or live harness run was needed for this documentation-only pass. The individual defect claims still require their task-specific regression and acceptance checks when implemented.

Workspace tooling observation: the resolver initially printed a freshness label even though fetch had failed. A later successful fetch and explicit ahead/behind check resolved that uncertainty here. The workspace CLI should suppress that label when fetch fails, or clearly label it as based on cached remote refs.
