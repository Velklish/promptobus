// Shared participant-trace diagnosis. The three stands read traces from different
// homes, but the trace records and the diagnosis contract are the same.

// Scenario errors do not stop a participant: a later assertion can be the first red
// verdict while the cause sits earlier in the trace. Keep this vocabulary in one place
// so every stand surfaces the same cause before its tail.
const AUTHOR_ERROR_KINDS = new Set(['unknown-action', 'action-failed', 'turn-failed']);

export function authorErrors(trace) {
  return trace.filter((e) => AUTHOR_ERROR_KINDS.has(e?.kind));
}

export function diagnoseTrace(trace, address, tail) {
  const errs = authorErrors(trace);
  const head = errs.length ? `scenario errors for ${address} (the cause is usually here): ${JSON.stringify(errs)} · ` : '';
  return `${head}trace for ${address}: ${JSON.stringify(trace.slice(-tail))}`;
}
