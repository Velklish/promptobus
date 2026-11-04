/** What the account can do with this harness. `unknown` is penalised by the resolver, never blocking:
 * no harness exposes a stable quota API, and a blocking unknown would leave runs with no candidate. */
export const AVAILABILITY_STATES = ['available', 'exhausted', 'unavailable', 'unknown'];
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
];
/** How this snapshot got the value: `probe` — this run asked the harness, `cache` — a live entry was
 * reused, `manual` — a person marked it. */
export const AVAILABILITY_SOURCES = ['probe', 'cache', 'manual'];
