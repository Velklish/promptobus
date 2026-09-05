// Availability adapter contract: how ONE harness answers "can this account run
// right now". The preflight ([preflight.js](../lib/model-routing/preflight.js)) runs every adapter
// in parallel under one budget and turns their verdicts into the availability
// snapshot the resolver reads; the cache keeps that snapshot between commands.
//
// The contract is declared here rather than inside the driver contract because it
// is a different question with a different lifetime: `Driver` is about a session —
// start it, look at it, wake it, stop it — while an adapter answers about the
// ACCOUNT, before any session exists. A driver carries its adapter (`availability`
// in [driver.ts](driver.ts)) and both go out of the same entry point, so an author
// implementing a harness still reads one import.
//
// What is not here, on purpose: the shape on disk. The snapshot is pinned by
// `schemas/model-routing/snapshot.schema.json`, and that schema — not this file —
// is what a written cache is validated against. Every object it declares is
// CLOSED, which is the mechanism that keeps a token off disk: the writer projects
// a verdict onto the declared fields, and anything an adapter added beside them
// never reaches the file.
import type { HostToolBin, PromptobusHost } from './host.js';

/**
 * What the account can do with this harness.
 *
 * `available` — auth, model and limit confirmed; `exhausted` — the limit is
 * confirmably spent; `unavailable` — no binary, no auth, no model, or the harness
 * is broken; `unknown` — the state could not be established. `unknown` is
 * penalised by the resolver, never blocking: no harness exposes a stable quota
 * API, so a blocking `unknown` would leave most runs with no candidate at all.
 */
export const AVAILABILITY_STATES = ['available', 'exhausted', 'unavailable', 'unknown'] as const;
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

/**
 * Stable reason codes. The list is fixed and is written once in prose, in
 * `docs/reference/03-cli.md`; the same nine are the `reason` enum of the snapshot
 * schema, and the suite compares the two lists rather than trusting them.
 *
 * `snake_case` — the snapshot vocabulary keeps the spelling the decision fixed,
 * while package error codes are `kebab-case`.
 */
export const AVAILABILITY_REASONS = [
  'binary_missing',
  'not_authenticated',
  'model_not_available',
  'subscription_exhausted',
  'probe_timeout',
  'probe_failed',
  'quota_unknown',
  'stale_cache',
  'manual_exhaustion',
] as const;
export type AvailabilityReason = (typeof AVAILABILITY_REASONS)[number];

/**
 * How this snapshot got the value: `probe` — this run asked the harness, `cache` —
 * a live entry was reused, `manual` — a person marked it.
 */
export const AVAILABILITY_SOURCES = ['probe', 'cache', 'manual'] as const;
export type AvailabilitySource = (typeof AVAILABILITY_SOURCES)[number];

/** One model the account exposes, as the harness lists it. */
export interface ProbeModel {
  model: string;
  /**
   * Marks the harness prints next to the model. Carried, not judged: a policy that
   * cares denies the model in an overlay.
   */
  flags?: readonly string[];
  /**
   * Whether the merged catalog rates this model. **An adapter does not fill this
   * in** — it knows the harness, not the catalog. The preflight sets it from the
   * predicate its caller supplies, and with no catalog in hand the answer is
   * `false`: an unrated model is shown and never chosen automatically, which is
   * the reading that cannot pick something nobody rated.
   */
  rated?: boolean;
}

/**
 * One normalised subscription window. `usedPercent` is what the resolver turns
 * into `remaining`; a harness that exposes no window at all reports none, and its
 * remaining limit stays unknown rather than being modelled.
 */
export interface ProbeWindow {
  id: string;
  usedPercent: number;
  lengthSec?: number;
  resetAt?: string | null;
}

/** What an adapter is asked. */
export interface ProbeRequest {
  /**
   * The workspace interface, for whatever an adapter needs beyond its binary.
   * **The binary is not asked for here**: `toolBin` below already carries it.
   */
  host: PromptobusHost;
  /**
   * The binary of `AvailabilityAdapter.tool`, resolved by the preflight before any
   * adapter started — or `null` when there was no resolve at all: the adapter
   * declared no `tool`, the host has no `resolveToolBin`, or the call threw.
   *
   * A host may start a process inside its synchronous `resolveToolBin`, so an
   * adapter that called it would block the event loop and stop the very timer that
   * bounds it. Resolving once, up front, takes that call out of the race; an
   * adapter reads the answer and never asks for it again.
   *
   * `ok: false` is the host saying there is no such binary — the `binary_missing`
   * verdict is still the adapter's to write, because the wording is the harness's.
   */
  toolBin: HostToolBin | null;
  /**
   * The adapter's own ceiling in milliseconds. It is what is left of the whole
   * preflight budget when the adapters start: they run in parallel, so each may use
   * all of it. An adapter that misses it is not waited for — the preflight reports
   * `probe_timeout` for that harness and does not hold the command.
   */
  timeoutMs: number;
  /**
   * The person asked for live data. An adapter that keeps a cache of its own
   * ignores it; an adapter with no cache of its own has nothing to do here — the
   * availability cache is upstream and has already been consulted.
   */
  refresh: boolean;
}

/**
 * What an adapter answers. The shape is one harness entry of the availability
 * snapshot, so nothing translates between the probe and the file.
 *
 * `message` is a human diagnosis and **never the harness output verbatim**: that
 * is where a token would arrive, and the message is the one free-text field that
 * reaches disk.
 */
export interface ProbeVerdict {
  state: AvailabilityState;
  /** `null` exactly when the state is `available` and nothing qualifies it. */
  reason: AvailabilityReason | null;
  message: string;
  /** ISO-8601 with milliseconds. The preflight stamps one if the adapter omits it. */
  checkedAt: string;
  source: AvailabilitySource;
  /**
   * When an exhausted limit is known to reset. `null` means unknown — and an
   * exhaustion with no reset is cleared only by `--clear-exhausted`, never by
   * time and never by a later probe.
   */
  resetAt?: string | null;
  /** Harness binary version, when the probe read it. */
  version?: string;
  models?: readonly ProbeModel[];
  windows?: readonly ProbeWindow[];
}

/**
 * The adapter itself. One method: a driver declares it as `availability`, and a
 * driver that declares none is not an error — the registry answers `unknown` /
 * `probe_failed` for it, which the resolver penalises rather than blocks.
 *
 * `probe` may be synchronous. It must not start a session, write anything, or
 * touch the availability cache: the cache is read and written around it.
 */
export interface AvailabilityAdapter {
  /**
   * The binary this adapter answers about, by the name the host resolves. The
   * preflight resolves it ONCE per declared binary before the adapters start and
   * hands the answer over as `ProbeRequest.toolBin`. An adapter that needs none
   * declares none and is handed `null`.
   */
  tool?: string;
  /**
   * **A probe must not block the event loop.** The preflight runs every adapter at
   * once and bounds them with a timer beside their promises; a probe that holds the
   * loop stops that timer from firing, stops its neighbours from making progress,
   * and stops its own kill timer — the ceiling the person was promised then becomes
   * the sum of the blocking probes instead of one budget. So: no `spawnSync`, no
   * synchronous host call, no busy wait. A synchronous RETURN is still lawful and
   * is what an immediate answer looks like — the rule is about holding the loop,
   * not about returning a promise.
   */
  probe(request: ProbeRequest): Promise<ProbeVerdict> | ProbeVerdict;
}
