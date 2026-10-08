# ADR-033: BB selects its provider without changing native routing

**Status:** Accepted
**Date:** 2026-10-08
**Deciders:** Repository owner (Codex-only scope); implementation: Codex

## Context

BB is the execution runtime; provider/model/effort and provider-account windows
are distinct routing inputs. Treating BB as one native harness would erase those
distinctions. Native child processes also inherit parent BB identity unless the
driver boundary removes it. SDK 0.6.15 exposes scoped catalogs/health and
host/provider usage, but the constrained reviewer declares no usage API.

## Options

- Add a native BB harness and map native strategies automatically: mixes runtime
  and provider identity and can silently weaken a harness or reviewer constraint.
- Keep an explicit BB facade selection: its admitted provider follows the role,
  SDK inventory supplies the model/effort, and native routing keeps its contract.

## Decision

Use explicit facade selection. Support regular Codex for executable/observer roles
and the constrained Codex provider for reviewer. Explicit provider mismatch fails.
Require a reported model; validate explicit reasoning or select the model catalog
default. Reject cross-provider model routes and selected-only stale models.
Record SDK model id separately from the native model name and keep the launch
snapshot distinct from SDK current execution options.
Store that snapshot both in plugin bindings and canonical `metadata.bb.execution`.
Canonical `harness: bb` continues to identify the adapter's lifecycle ownership;
the underlying model harness is explicitly `execution.harness: codex`.

Probe existing environments with their catalog/health context. For new managed
worktrees use their host and require a host-scoped catalog. Unavailable resources
and failed model inventory refuse before task/participant reservation or spawn.
Known invalid provider health refuses; missing health remains unknown.
Usage belongs to the selected provider account on its host. Empty, missing,
failed or unsupported usage remains unknown with no fabricated percentage.
No quota threshold or fallback is introduced. Omit account email and cost.

The facade rejects native harness/strategy/effort flags rather than translating
or relaxing them. Native catalog, overlays, account caches and defaults remain
unchanged. The shared native driver filter removes inherited BB thread,
environment, project and thread-storage identity. It preserves connection/config
values, and intentional caller-supplied child identity still wins.
This filter does not run on authenticated SDK-managed thread context; the
reviewer app-server retains its independent private environment boundary.

## Consequences

An SDK catalog default may differ from a native effort default. Availability and
quota are time-stamped observations, not continuing guarantees or per-task budgets.
Regular Codex settings may change after launch; the reviewer requires a fresh
session for a model/effort change. A new provider needs a separate support and
permission proof before being admitted.
