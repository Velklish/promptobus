// The routing contract types.
// [guides/model-routing.md#the-routing-contract-types](../docs/guides/model-routing.md#the-routing-contract-types)
import type { HostToolBin, PromptobusHost } from './host.js';

/** What the account can do with this harness. `unknown` is penalised by the resolver, never blocking:
 * no harness exposes a stable quota API, and a blocking unknown would leave runs with no candidate. */
export const AVAILABILITY_STATES = ['available', 'exhausted', 'unavailable', 'unknown'] as const;
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

/** Stable reason codes, written once in prose in the CLI reference and as the snapshot schema's
 * `reason` enum; the suite compares the two. `snake_case` is the snapshot vocabulary. */
export const AVAILABILITY_REASONS = [
  'binary_missing',
  'not_authenticated',
  'subscription_exhausted',
  'probe_timeout',
  'probe_failed',
  'quota_unknown',
  'stale_cache',
  'manual_exhaustion',
] as const;
export type AvailabilityReason = (typeof AVAILABILITY_REASONS)[number];

/** How this snapshot got the value: `probe` — this run asked the harness, `cache` — a live entry was
 * reused, `manual` — a person marked it. */
export const AVAILABILITY_SOURCES = ['probe', 'cache', 'manual'] as const;
export type AvailabilitySource = (typeof AVAILABILITY_SOURCES)[number];

/** One model the account exposes, as the harness lists it. */
export interface ProbeModel {
  model: string;
  /** Marks the harness prints next to the model. Carried, not judged: a policy that cares denies
   * the model in an overlay. */
  flags?: readonly string[];
  /** Whether the merged catalog rates this model. **An adapter does not fill this in** — it knows
   * the harness, not the catalog. The default `false` can only fail to pick something unrated. */
  rated?: boolean;
}

/** One normalised subscription window. A harness that exposes none reports none, and its remaining
 * limit stays unknown rather than being modelled. */
export interface ProbeWindow {
  id: string;
  usedPercent: number;
  lengthSec?: number;
  resetAt?: string | null;
}

/** What an adapter is asked. */
export interface ProbeRequest {
  /** The workspace interface, for whatever an adapter needs beyond its binary. **The binary is not
   * asked for here**: `toolBin` below already carries it. */
  host: PromptobusHost;
  /** The binary of the adapter's `tool`, resolved by the preflight before any adapter started — or
   * `null`. Resolving once takes a synchronous host call out of the race. */
  toolBin: HostToolBin | null;
  /** The adapter's own ceiling in milliseconds: what is left of the whole preflight budget, which
   * they may each use in full. One that misses it is not waited for. */
  timeoutMs: number;
  /** The person asked for live data. An adapter with no cache of its own has nothing to do here —
   * the availability cache is upstream and has already been consulted. */
  refresh: boolean;
}

/** What an adapter answers — one harness entry of the availability snapshot, so nothing translates.
 * `message` is a human diagnosis and **never the harness output verbatim**: it reaches disk. */
export interface ProbeVerdict {
  state: AvailabilityState;
  /** `null` exactly when the state is `available` and nothing qualifies it. */
  reason: AvailabilityReason | null;
  message: string;
  /** ISO-8601 with milliseconds. The preflight stamps one if the adapter omits it. */
  checkedAt: string;
  source: AvailabilitySource;
  /** When an exhausted limit is known to reset. `null` is unknown — and an exhaustion with no reset
   * is cleared only by `--clear-exhausted`, never by time and never by a later probe. */
  resetAt?: string | null;
  /** Harness binary version, when the probe read it. */
  version?: string;
  models?: readonly ProbeModel[];
  windows?: readonly ProbeWindow[];
}

/** The adapter itself: one method, declared by a driver as `availability`. `probe` may be synchronous,
 * but must not start a session, write anything, or touch the availability cache. */
export interface AvailabilityAdapter {
  /** The binary this adapter answers about, by the name the host resolves. The preflight resolves it
   * ONCE before the adapters start; an adapter that needs none declares none and is handed `null`. */
  tool?: string;
  /** **A probe must not block the event loop** — that would stop the budget timer and turn the
   * promised ceiling into the sum of the probes. A synchronous RETURN is still lawful. */
  probe(request: ProbeRequest): Promise<ProbeVerdict> | ProbeVerdict;
}
