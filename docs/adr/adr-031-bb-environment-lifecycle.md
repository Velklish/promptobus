# ADR-031: BB owns thread environments; the coordinator retains unaccepted results

**Status:** Accepted
**Date:** 2026-10-08
**Deciders:** Repository owner (local BB integration scope); implementation: Codex

## Context

Native spawn and cleanup create and remove their own worktrees. Registering an
async BB Driver there would duplicate environment ownership and put Promises into
synchronous session decisions. Plugin SDK 0.6.15 supports environment selection in
threads.spawn; BB 0.45.0 provisions a new worktree only after its first prompt.
Stop can return while the thread is still stopping. Archiving the last thread can
retire its managed environment without accepting the participant's changes.

## Options

- Reconstruct native worktree lifecycle for BB: introduces two resource owners.
- Reuse only precreated environments: avoids provisioning, but cannot launch a
  participant with a fresh BB-managed workspace.
- Keep an SDK lifecycle adapter with stable coordinator storage: permits BB
  creation and separates environment retirement from canonical result retention.

## Decision

BB owns environment selection, actual allocation and archive/retirement. The
adapter records returned path, branch, host, environment id, base HEAD SHA and
explicit parent/lifecycle owner thread refs. It never creates or removes a BB
environment through native git worktree operations. The coordinator is an existing
local unmanaged Git environment, so its canonical engine store survives retirement.

A new environment first admits only a bound nonce-bearing preparation prompt,
without assignment or plugin tools. After it finishes, fresh SDK observations and
Stop must confirm an available idle thread without background work. Only then does
the adapter clear the preparation model context, reserve/finalize canonical
participant metadata and send its first
assignment with the actual workspace. A fresh native Codex thread receives the
new tool catalog; native resume would retain the empty preparation catalog. BB
history is retained. Preparation failure leaves an orphan.

SDK observations are awaited before projecting a plain SessionView. Logical
availability is separate from native process liveness; offline, pending, stopping
and errors remain unknown. Archive holds adapter dispatches, confirms Stop and
verifies the SDK merge base is the recorded SHA with zero behind count and
preserves a complete SDK patch manifest relative to that SHA in the canonical
coordinator. It rechecks stopped and unchanged state before SDK archive. Incomplete,
unsupported or unstable preservation leaves the environment in place. Lifecycle
children must be preserved and archived first, including non-plugin children.

## Consequences

Native done/sweep/journal cleanup excludes BB tasks. The adapter retains binding
refs and snapshot digests across reload; stop/archive never imply acceptance or
close the canonical task. BB owns the managed-environment grace and retirement.
An operator can bypass the adapter through direct BB controls; explicit Send now,
archive/delete, external dependent creation and environment cleanup require prior
preservation. Concurrent
external edits after the final check are outside this adapter's transaction.

Bindings created before base-SHA capture require operator preservation. Preexisting
work in reused environments remains its original owner's responsibility. Binary
marker-only and submodule patches are retained in place rather than silently lost.
