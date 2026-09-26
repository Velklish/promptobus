// Shared participant-trace diagnosis. The three stands read traces from different
// homes, but the trace records and the diagnosis contract are the same.
import { readFileSync } from 'node:fs';

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

// A model's first tool call comes seconds after its lift, and a stand plays turn 0 at once;
// before its first send it waits, at most BIND_WAIT_MS, for the lift to bind its record.
export const BIND_WAIT_MS = 10_000;

export async function awaitBinding({ home, task, address, note }) {
  const { boundSessionOf } = await import('../dist/protocol.js');
  const { taskFile } = await import('../dist/v1/layout.js');
  const deadline = Date.now() + BIND_WAIT_MS;
  for (;;) {
    let bound = null;
    try {
      const meta = JSON.parse(readFileSync(taskFile(home, task), 'utf8'));
      bound = boundSessionOf((meta.participants ?? []).find((p) => p?.metadata?.address === address));
    } catch {
      bound = null;
    }
    if (bound) return note({ kind: 'bound', session: bound });
    if (Date.now() > deadline) {
      return note({ kind: 'bind-timeout', ms: BIND_WAIT_MS, why: 'TIMEOUT: the lift had not bound the record; this says nothing about the product' });
    }
    await new Promise((r) => { setTimeout(r, 100); });
  }
}
