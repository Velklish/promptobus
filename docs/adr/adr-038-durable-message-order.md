# ADR-038: Durable message order and current assignments

**Status:** Accepted
**Date:** 2026-10-20
**Deciders:** Maintainer-approved recovery plan

## Context

Message IDs previously combined wall-clock time, a process-memory counter and a
random tail. A controlled clock rollback reversed two sends in mailbox ID order.
Native and BB consumers also compared result/assignment timestamps. These values
cannot establish which assignment a result follows when clocks move backward.

An intent commits before its canonical/inbox references are all visible. A later
visible result can therefore hide a newer live assignment intent. A greatest-ID
wake cutoff can likewise miss an older committed message whose ref appears late.
Immutable retained evidence and opaque history cursors must remain readable.

## Options

- Wall-clock or process-local ordering keeps the demonstrated ambiguity.
- Per-task sequence fields require a second cursor protocol and do not establish
  order across existing same-store peer/child journals.
- Store-local logical IDs preserve the existing grammar and scalar comparisons,
  at the cost of a short filesystem commit lock and a durable head.
- Serializing every fan-out ref globally could close visibility gaps but holds a
  shared lock across unrelated filesystem work. Strict facts and current unread
  membership address the distinct gate and notification questions locally.
- Full unread snapshots on every change fit the driver acknowledgement contract
  but repeat previously shown stubs. Current membership preserves delta previews
  and costs state proportional to current unread mail.

## Decision

1. Reserve each new message ID above the versioned store-local head under task
   then commit lock. Persist the bounded head before intent publication. Preserve
   wall-clock `ts`, ID grammar, existing bytes and history cursors. Reservation
   gaps are legal. Artifact streaming and recipient ref placement stay outside
   this short section; intent retirement takes the same commit lock.
2. Trust a valid bounded head on normal allocation. Explicit rebuild scans raw
   canonical records, open intents and every retained causal assignment boundary,
   preserving a higher valid head. Only a strictly empty retained ordering domain
   permits automatic initialization. Unreadable/partial/unsupported state refuses;
   tolerant task/history views cannot establish an empty store.
3. Persist `metadata.assignmentAfterId` before an initial worker/reviewer/approver
   launch or fresh BB phase. It is a causal boundary, not a synthetic message.
   Actual task/review assignment sends update the recipient boundary under the
   same serialization after intent commit; recovered canonical assignments still
   raise it if the metadata write was interrupted. Current-result gates require the exact participant/subject and a result
   after the current boundary, using strict task-local committed facts. Recovery
   runs outside commit locks; unresolved intents/broken records refuse the facts
   snapshot instead of hiding a newer assignment. Corrupt-intent quarantine uses
   the commit lock so its namespace transition cannot disappear between snapshot
   listings. Wall-clock telemetry is separate.
4. Track successful current unread coverage and observed identities per wake
   session. Diff tuple membership, not IDs or counts, for new mail. Prune only
   complete listings, retain unreadable-ref eligibility, and cover the actual
   successful sampled hint. Preserve retry pacing, coalescing, status filtering
   and holds. A legacy/new session without coverage gets a conservative first hint.

## Consequences

New same-store commits remain ordered through equal clocks, rollback and process
restart. Current-result proof includes initial prompts and cannot accept an old
result merely because a newer committed assignment lacks a visible ref. Late refs
and equal-count replacement do not disappear behind a wake watermark.

Normal head reads are bounded; reconstruction is explicit retained-store work.
Wake state is O(current unread), plus last verified slot coverage while listing
fails, rather than constant-space. A failed activation does not cover mail or
turn a persistent delta into a new arrival every beat. Activation success remains
a hint; mailbox take is the delivery acknowledgement.

All live writers sharing the store must use this protocol. Retained legacy IDs
keep deterministic prior ID order; lost historical causal order cannot be
reconstructed. Missing legacy assignment boundaries require a supported fresh
assignment before live freshness proof. A coherent external rollback of a valid
head cannot be detected by the normal bounded read; explicit rebuild is the
recovery boundary. Existing atomic replacement supports process-crash reasoning,
not fsync/power-loss claims. This decision does not define terminal-task send
fencing, physical Stop or provider permissions.
