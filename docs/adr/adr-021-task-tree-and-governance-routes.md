# ADR-021: A task tree of two levels with governance routes

**Status:** Accepted
**Date:** 2026-09-26
**Deciders:** the owner, in the planning dialogue of 2026-09-26.

## Context

One orchestrator carries every participant's traffic. The owner's measurement of 33 task journals on 2026-09-26 puts the five largest runs at 400 to 832 messages to the orchestrator and 344 to 877 thousand characters of inbound mail, more than one session context. The owner's structure: a top orchestrator (the owner calls the role TGM) lifts teamleads, each running its own group of workers; teamleads of one group talk to each other about small matters and bring a change of logic or of requirements to the top; teamleads of different tops do not talk; tops lifted by the person may ask each other questions. The person changes only the steps below a teamlead ([ADR-020](adr-020-role-registry-and-declared-pipeline.md)); the layer above them is fixed by the package.

## Options

**Decision 1 — the shape of a run.**
- 1A. A tree of tasks: a root task owned by the top, one child task per teamlead with a `parent` link, the teamlead recorded as `teamlead:<slug>` in the root and as `orchestrator` of its child — one session, two addresses ([ADR-019](adr-019-session-address-per-task-lands.md)).
- 1B. One task with every level's participants. Rejected: the one-orchestrator-per-task rule, the claim, the warden and every route would be rewritten for a tree inside one journal.

**Decision 2 — depth.**
- 2A. Exactly two levels. 2B. Arbitrary depth. Rejected: every "who may write to whom" check would carry a recursion for a case nobody has measured.

**Decision 3 — the small/large boundary between siblings.**
- 3A. By message type: `question`, `answer`, `status`, `artifact` between siblings; `task`, `result`, `review` only on the vertical; what is large is written in the teamlead's instruction.
- 3B. Text only. Rejected: a violation would be visible to nobody.
- 3C. 3A plus a new upward-only type. Not taken now: the type list is frozen and no case needs it yet.

**Decision 4 — peers.**
- 4A. An explicit `link` on both sides, each peer bound to the other's owner session, and only the sibling types. 4B. Any orchestrator writes to any task by name. Rejected: an address that can be named can be borrowed (ADR-019).

**Decision 5 — where a teamlead sits.**
- 5A. At the install root, like the top; its group is the set of repositories in its brief. 5B. In one repository's directory. Rejected: awkward for a group of several.

## Decision

1A, 2A, 3A, 4A, 5A. `done` on a root refuses over an active child rather than cascading. A teamlead and a reporter lift on Claude Code. Codex teamlead admission is the amendment below. Cursor stays refused as a teamlead for the project-layer reason in [ADR-024](adr-024-approver-acceptance-in-own-worktree.md).

## Consequences

- Routing gains a closed table with a decision column; every pair outside it is refused naming the vertical route.
- The top orchestrator's inbound traffic becomes the teamleads' summaries instead of every worker's mail.
- Thresholds for raising a tree — up to 5 pieces and 3 concurrent workers for one orchestrator, from 8 pieces or 4 concurrent workers or two groups for a tree — ship in the package skill and are the owner's reading of the measurement, to be re-read against later telemetry.

## Amendment: Codex at the install root

**Amendment status:** Accepted by the owner on 2026-09-27. The limits below were measured on codex-cli 0.156.1.

`live.PM5Iux` showed two Codex teamlead lifts with byte-identical tracked and untracked install-root content, first status from `teamlead:<slug>`, and a second holder-driven turn after root wake. The install root's `SessionStart` hook ran. `live.E5Q8vs` showed that the root project config overrode a private-home `hooks = false`, and that the child MCP entry could not read the teamlead's root mailbox; its holder still started and completed the wake turn. `live.rVcwVK` showed no foreign hook marker with `features.hooks = false` in `thread/start`, and the separate root MCP entry read the root message as the teamlead. Its script stopped at a server-name assertion before the second lift or a worker lift.

The Codex path copies skills into the teamlead's own `CODEX_HOME`, writes no project layer at the install root, binds a second MCP entry to the root teamlead address, and uses holder-driven turns. At codex-cli 0.156.1, [app-server makes request config a CLI override](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/config_manager.rs#L355-L382), and [session flags follow project config](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/config/src/loader/mod.rs#L395-L416).

`live.XtOh7N` stopped on a proof repository outside the install root; `live.3Acln1` received the worker result but completed its handling in the first holder turn. The corrected `live.ej1Piv` exited 0. Both teamlead lifts left the install-root snapshot and git status unchanged. The first received root mail through its own MCP entry and woke for a second holder turn. The second lifted a Cursor worker, received its result on the child task, then woke for a second turn and ran `review --dry-run` for Claude Code, Cursor and Codex, each exiting 0 on a clean tracked tree. The admitted Codex teamlead keeps the same two-address task tree; Cursor teamleads remain refused under ADR-024.

The clean run proves an absent foreign-hook marker but does not isolate the thread override's effect: both holder logs report an untrusted install root with project hooks disabled. Its proof skill file lacked YAML frontmatter and did not load. The worker operation ran after a `full-access` request; no live artifact records the applied `danger-full-access` sandbox, and `workspace-write` was not tried for that worker operation. The three review commands were dry-runs, not reviewer lifts.

The later `live.6c7hS6` attempted worker lifts on all three harnesses under `workspace-write`; all refused before reviews were attempted (exit 2). Under `full-access`, `live.Tz69RX` received committed worker results from Claude Code, Cursor and Codex and real review results from Claude Code and Cursor. Its Codex reviewer lifted but asked for file access under the old shared prompt; the run timed out (exit 124). The direct control `live.aLXxuF` returned a Codex reviewer result under the same host (exit 0), so the host did not lack file access in general.

With a Codex-specific reviewer prompt permitting read-only shell commands, `live.Ezz5vp` returned a Codex review result after the reviewer read the committed diff and current file (exit 0). That result woke the Codex teamlead's second turn; it reported the reviewer's message id through its root MCP entry. The install-root snapshot and git status remained unchanged, no foreign hook marker appeared, and the reviewer config and session record were captured. `full-access` is the narrowest completing profile measured. The hook isolation, unloaded proof skill and unrecorded applied sandbox mode remain limits of the evidence. The original task-tree status remains Accepted.
