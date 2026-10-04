# PB-315 · Start and resume a managed Codex root orchestrator with native wake and owner binding

- **Order:** 160
- **Scope:** [reference/03-cli § Lead](../../reference/03-cli.md#lead), [reference/05-drivers](../../reference/05-drivers.md), `lib/lead.js`, `lib/codex-session.js`, installed skills
- **Created:** 2026-10-01
- **Dependencies:** none
- **Cost:** major

## Context

The owner requires a Codex root orchestrator after losing Claude Code access. An arbitrary Desktop chat has no supported autonomous wake contract through the bus. The existing managed Codex holder can bind a native root owner, receive postcards and preserve thread history on recovery.

The work landed on main before release 0.22.0 (`fa1b5a18` … `a7c76f98`; CHANGELOG `[0.22.0]`, "A managed Codex root can start from a brief"). What remains is the approver's acceptance pass: review, archive and fold.

## Work to do

- Start a new root from a brief and bind its native owner before the first model turn.
- Refuse invalid ids and existing task takeover before session preparation.
- Resume only an active retained managed root with a matching native thread, private home and dead holder/app-server; preserve task creation and mailbox ownership.
- Retain bound first-turn failure history; refuse attached, closed, mismatched and live owners.
- Disable native shell execution for Codex reviewers and supply bounded file-read MCP tools.
- Name the actual owner harness in warden status, expose reporter harnesses and update installed workflows.
- Capture full protocol schemas for 0.158.0 and Desktop 0.159.2, validate holder requests against both, and retain historical evidence with its own version.

## Out of scope

- Converting arbitrary Desktop chats into managed owners.
- Perpetual subscription auth refresh, or resuming a closed task whose private home was retired.
- Command execution through external MCP servers beyond the classified write-tool denial.

## Verification

- Native 0.158.0 root: task metadata on first turn, warden wake, user answer, managed owner stopped on close. [Evidence](../../../test/fixtures/codex-app-server/0.158.0/ManagedRoot-0.158.0-2026-10-01.json).
- Native 0.159.2 resume: same thread, owner and creation time; original brief removed; model remembered its first-turn marker; four successful bus reads, exit 0. [Evidence](../../../test/fixtures/codex-app-server/0.159.2/ManagedRootResume-0.159.2-2026-10-01.json).
- Native reviewers on both 0.158.0 and 0.159.2 completed all three local MCP reads with zero command-execution items and no native execution tools.
- Focused lifecycle, identity and CLI regressions, full suite and mutation outcomes are reported on the worker commit; acceptance remains the approver's pass.
