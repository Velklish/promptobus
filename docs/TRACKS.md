# Backlog tracks — 2026-09-07

This document records triage decisions and execution boundaries, not a second status board. Status is the task directory; priority is its `Order` field. Use `npx github:Velklish/backslop#v0.10.1 status` for the current queue. Track assignments below are a planning snapshot and do not imply a running worker.

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

Queued assignments: [PB-71](archive/LOG.md#pb-71), [PB-141](archive/LOG.md#pb-141), [PB-50](archive/LOG.md#pb-50), [PB-122](archive/LOG.md#pb-122), [PB-67](archive/LOG.md#pb-67), [PB-68](archive/LOG.md#pb-68), [PB-69](archive/LOG.md#pb-69), [PB-114](archive/LOG.md#pb-114), [PB-144](archive/LOG.md#pb-144), [PB-82](archive/LOG.md#pb-82), [PB-108](archive/LOG.md#pb-108), [PB-70](archive/LOG.md#pb-70), [PB-72](archive/LOG.md#pb-72), [PB-73](archive/LOG.md#pb-73), [PB-75](archive/LOG.md#pb-75), [PB-94](archive/LOG.md#pb-94), [PB-107](archive/LOG.md#pb-107), [PB-110](archive/LOG.md#pb-110), [PB-112](archive/LOG.md#pb-112), [PB-113](archive/LOG.md#pb-113), [PB-137](archive/LOG.md#pb-137), [PB-138](archive/LOG.md#pb-138), [PB-142](archive/LOG.md#pb-142), [PB-143](archive/LOG.md#pb-143), [PB-46](archive/LOG.md#pb-46), [PB-47](archive/LOG.md#pb-47), [PB-84](archive/LOG.md#pb-84), [PB-104](archive/LOG.md#pb-104).

Added after this snapshot: [PB-50.1](archive/LOG.md#pb-50.1) — the shared output budget kept a git-specific name when PB-50 widened its reach.

Added after this snapshot (triage of 2026-09-10): [PB-159](archive/LOG.md#pb-159) — the preflight test's wall-clock checks go red in the pooled suite under machine load; it joins the serial group and the runner keeps a red file's last lines.

### S — Store integrity and public engine

PB-63 and PB-66 are P0. PB-66 precedes PB-65 and reader taxonomy. PB-101 follows the version/error fixes; PB-147 tests its cleanup boundary.

Queued assignments: [PB-63](archive/LOG.md#pb-63), [PB-66](archive/LOG.md#pb-66), [PB-65](archive/LOG.md#pb-65), [PB-132](archive/LOG.md#pb-132), [PB-146](archive/LOG.md#pb-146), [PB-102](archive/LOG.md#pb-102), [PB-101](archive/LOG.md#pb-101), [PB-131](archive/LOG.md#pb-131), [PB-135](archive/LOG.md#pb-135), [PB-147](archive/LOG.md#pb-147).

Added after this snapshot (triage of 2026-09-10, findings of this track's own run): [PB-146.1](archive/LOG.md#pb-146.1), [PB-65.1](archive/LOG.md#pb-65.1), [PB-63.1](archive/LOG.md#pb-63.1), [PB-146.2](archive/LOG.md#pb-146.2), [PB-66.1](archive/LOG.md#pb-66.1), in that order.

### C — Codex session lifecycle

PB-97 before PB-41; PB-49/PB-99 before PB-42. Do not conflate a protocol collision with the unproven cause of the historical elicitation hang. PB-90 requires protocol evidence.

Queued assignments: [PB-97](archive/LOG.md#pb-97), [PB-49](archive/LOG.md#pb-49), [PB-41](archive/LOG.md#pb-41), [PB-99](archive/LOG.md#pb-99), [PB-42](archive/LOG.md#pb-42), [PB-115](archive/LOG.md#pb-115), [PB-152](archive/LOG.md#pb-152), [PB-88](archive/LOG.md#pb-88), [PB-89](archive/LOG.md#pb-89), [PB-90](archive/LOG.md#pb-90), [PB-150](archive/LOG.md#pb-150), [PB-98](archive/LOG.md#pb-98), [PB-121](archive/LOG.md#pb-121).

Added after this snapshot: [PB-156](archive/LOG.md#pb-156) — the Codex thread takes a machine name and never receives the readable session name the mechanism chose.

Added after this snapshot (triage of 2026-09-10): [PB-88.2](archive/LOG.md#pb-88.2) — the approval params measured from the generated app-server schema of codex-cli 0.146.0 — then [PB-88.1](archive/LOG.md#pb-88.1); [PB-116](archive/LOG.md#pb-116) moves here from R and follows them, because all three edit `lib/codex-session.js`.

### D — Harness registries and Cursor / Claude drivers

PB-45 is a cross-driver prerequisite and edits Codex too: finish it before C. PB-151 is the first Cursor repair. PB-120 is deferred.

Queued assignments: [PB-45](archive/LOG.md#pb-45), [PB-151](archive/LOG.md#pb-151), [PB-148](archive/LOG.md#pb-148), [PB-153](archive/LOG.md#pb-153), [PB-85](archive/LOG.md#pb-85), [PB-93](archive/LOG.md#pb-93).

Added after this snapshot: [PB-45.1](archive/LOG.md#pb-45.1) — the snapshot path degrades a registry refusal to a reasonless `unknown`, so the operator still sees silence; it reaches into the shared `src/driver.ts` / `lib/status.js` seam.

Deferred assignments: [PB-120](archive/LOG.md#pb-120).

### R — Routing policy, overlays and availability

PB-155/PB-78/PB-58 first. PB-43 precedes PB-59/PB-105. Keep their policy choices explicit. PB-116 waits for C; PB-38.2 is deferred. PB-34.1/PB-37.3 are evidence work, not permission to run paid probes or invent ratings.

Triage of 2026-09-10: PB-37.5 is closed by the owner's decision (validate-only stays); PB-116 is executed under C; [PB-104.1](archive/LOG.md#pb-104.1) — amend ADR-004 to the shipped hidden-row behaviour — is added, documentation only.

Queued assignments: [PB-155](archive/LOG.md#pb-155), [PB-78](archive/LOG.md#pb-78), [PB-58](archive/LOG.md#pb-58), [PB-60](archive/LOG.md#pb-60), [PB-43](archive/LOG.md#pb-43), [PB-59](archive/LOG.md#pb-59), [PB-149](archive/LOG.md#pb-149), [PB-136](archive/LOG.md#pb-136), [PB-37.1](archive/LOG.md#pb-37.1), [PB-61](archive/LOG.md#pb-61), [PB-105](archive/LOG.md#pb-105), [PB-125](archive/LOG.md#pb-125), [PB-124](archive/LOG.md#pb-124), [PB-116](archive/LOG.md#pb-116), [PB-37.3](archive/LOG.md#pb-37.3), [PB-34.1](archive/LOG.md#pb-34.1).

Deferred assignments: [PB-38.2](backlog/deferred/PB-38.2-cursor-tier-unknown-until-first-turn.md).

### T — Telemetry and calibration

PB-77 plus PB-37.2 before PB-57; resolve the throughput-versus-duration contract before PB-56 or changing speed ratings. PB-62/PB-91/PB-106 protect the write workflow. PB-48 comes after timestamp/tally semantics.

Queued assignments: [PB-77](archive/LOG.md#pb-77), [PB-37.2](archive/LOG.md#pb-37.2), [PB-57](archive/LOG.md#pb-57), [PB-56](archive/LOG.md#pb-56), [PB-62](archive/LOG.md#pb-62), [PB-91](archive/LOG.md#pb-91), [PB-106](archive/LOG.md#pb-106), [PB-145](archive/LOG.md#pb-145), [PB-48](archive/LOG.md#pb-48).

Deferred after this snapshot (triage of 2026-09-10): [PB-57.1](backlog/deferred/PB-57.1-harness-throughput-producers-absent.md) — no harness reports a complete throughput observation; it returns when one exposes tokens with model-active generation time.

### H — Hook installation and host commands

PB-119 first, then PB-103/PB-52. PB-53 precedes PB-100, then PB-154. PB-76 includes PB-111. PB-109 fixes regeneration guidance without changing config policy.

Queued assignments: [PB-119](archive/LOG.md#pb-119), [PB-103](archive/LOG.md#pb-103), [PB-52](archive/LOG.md#pb-52), [PB-53](archive/LOG.md#pb-53), [PB-100](archive/LOG.md#pb-100), [PB-154](archive/LOG.md#pb-154), [PB-76](archive/LOG.md#pb-76), [PB-109](archive/LOG.md#pb-109).

Added after this snapshot: [PB-119.1](archive/LOG.md#pb-119.1) — `lib/install.js` writes the hook event names as literals while importing the matcher from `dist`, leaving `GUARD_HOOK_EVENT` an untied third door.

### L — Spawn, review and command guidance

PB-126 uses Q process fixes. PB-121 in C precedes changes to launch rendering. PB-87 is a design/capability checkpoint. PB-55 and PB-140 integrate after their shared model/store call sites stabilize.

Queued assignments: [PB-87](archive/LOG.md#pb-87), [PB-126](archive/LOG.md#pb-126), [PB-83](archive/LOG.md#pb-83), [PB-44](archive/LOG.md#pb-44), [PB-51](archive/LOG.md#pb-51), [PB-54](archive/LOG.md#pb-54), [PB-55](archive/LOG.md#pb-55), [PB-80](archive/LOG.md#pb-80), [PB-96](archive/LOG.md#pb-96), [PB-140](archive/LOG.md#pb-140).

Added after this snapshot: [PB-158](archive/LOG.md#pb-158) — `done` removes a worktree on proven squash containment but leaves its own branch, because the branch check falls back to an ancestry test a squash cannot satisfy.

Added after this snapshot: [PB-157](archive/LOG.md#pb-157) — the review snapshot is taken from the working tree, so a mandated post-commit mutation probe removes the reviewed change from the diff. Ordered near the top: it is a verification prerequisite for every track.

Added after this snapshot (triage of 2026-09-10): [PB-140.1](archive/LOG.md#pb-140.1) — the fourteen default literals behind hint parameters go, the gate's allowlist empties — then [PB-87.1](archive/LOG.md#pb-87.1) — the Codex reviewer's mechanical MCP deny through `disabled_tools` and a completeness signal on the host answer; it follows the C additions. Deferred: [PB-87.2](backlog/deferred/PB-87.2-cursor-mcp-deny-syntax-live-lift.md) — the Cursor deny syntax waits for a live lift after the Cursor window is restored.

### W — Guard and warden delivery

After PB-42, fix PB-64, then PB-79, then PB-123. Preserve the distinction between a new turn and a restarted session.

Queued assignments: [PB-64](archive/LOG.md#pb-64), [PB-79](archive/LOG.md#pb-79), [PB-123](archive/LOG.md#pb-123).

### X — Deferred structural work

Every deferred item has its own return condition. This is a future track, not part of the executable batch; PB-120 stays mapped to D and PB-38.2 to R.


Deferred assignments: [PB-81](archive/LOG.md#pb-81), [PB-95](archive/LOG.md#pb-95), [PB-117](archive/LOG.md#pb-117), [PB-118](archive/LOG.md#pb-118), [PB-127](archive/LOG.md#pb-127), [PB-129](archive/LOG.md#pb-129), [PB-130](archive/LOG.md#pb-130), [PB-133](archive/LOG.md#pb-133), [PB-134](archive/LOG.md#pb-134), [PB-139](archive/LOG.md#pb-139), [PB-13.2](backlog/minor/PB-13.2-catalog-has-no-payg-row.md), [PB-16.1](backlog/deferred/PB-16.1-cursor-start-path-names-no-limit.md), [PB-24.1](backlog/deferred/PB-24.1-codex-notification-window-duration.md), [PB-24.2](backlog/deferred/PB-24.2-snapshot-model-has-no-efforts-or-speed-tiers.md).

## Verification of this triage

Baseline `backslop lint` passed. Baseline `npm run audit` failed on 21 publication findings in the existing backlog text. The local cached Backslop executable was verified as version 0.4.0; npm used a scratch cache because the sandbox cannot write the normal cache.

Final results:

- Backslop 0.4.0 `lint`: passed.
- `npm run audit` with a scratch npm cache: passed on 557 tracked files and a 117-entry packed tarball; its build step passed.
- Inventory check: all 125 original open IDs survive exactly once; all 103 queued tasks have a single track assignment and unique order; all 16 deferrals have return conditions; triage and active are empty; all six merge results are complete.
- `git diff --check`: passed. Changes are confined to task documentation, the documentation index, backlog guidance, the track plan and CHANGELOG. Runtime, schemas, tests, package settings and adapters are unchanged.
- No full runtime suite or live harness run was needed for this documentation-only pass. The individual defect claims still require their task-specific regression and acceptance checks when implemented.

Workspace tooling observation: the resolver initially printed a freshness label even though fetch had failed. A later successful fetch and explicit ahead/behind check resolved that uncertainty here. The workspace CLI should suppress that label when fetch fails, or clearly label it as based on cached remote refs.
