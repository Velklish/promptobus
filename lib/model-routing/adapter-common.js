// Availability-adapter helpers shared by the three harness adapters, the preflight and the driver
// stand-ins: one spawn-and-capture dance, one HTTP-JSON call, one keychain read, one verdict shape.
import { spawn } from 'node:child_process';
import { planRun } from '../exec.js';
import { isoStamp } from './cache.js';

/** The credential store on macOS, by absolute path — a `security` off `PATH` is a poor thing to
 * hand a request for a token. */
export const SECURITY_BIN = '/usr/bin/security';

/** Spawn a binary and capture its stdout, resolving exactly once and never rejecting: every outcome
 * becomes a field of the result. [guides/model-routing.md](../../docs/guides/model-routing.md#killing-a-probes-child-why-three-lines-and-not-one). */
export function spawnAndCapture(bin, argv, timeoutMs) {
  const plan = planRun(bin, argv);
  if (!plan.ok) return Promise.resolve({ launched: false, error: { code: plan.code } });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(plan.file, plan.args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (error) {
      resolve({ launched: false, error });
      return;
    }
    let stdout = '';
    let settled = false;
    const done = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out);
    };
    // The kill alone does not end the wait, and these are three jobs, not one repeated:
    // [guides/model-routing.md](../../docs/guides/model-routing.md#killing-a-probes-child-why-three-lines-and-not-one).
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({
        launched: true, timedOut: true, status: null, signal: 'SIGKILL', stdout,
      });
      child.stdout.destroy();
      child.unref();
    }, timeoutMs);
    // Decoded before it is concatenated: a multibyte character split across a chunk boundary would
    // become replacement characters.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    // A stream error is not an adapter failure to report twice: `close` follows
    // and carries the outcome. Unhandled, it would be thrown at the process.
    child.stdout.on('error', () => {});
    child.on('error', (error) => done({ launched: false, error }));
    child.on('close', (status, signal) => done({
      launched: true, timedOut: false, status, signal, stdout,
    }));
  });
}

/** One keychain secret on macOS via `security find-generic-password`: the trimmed value, or `null`
 * on any refusal, timeout, non-zero exit or empty answer — the caller decides what that means. */
export async function readKeychainSecret(service, { timeoutMs }) {
  if (!(timeoutMs > 0)) return null;
  const r = await spawnAndCapture(SECURITY_BIN, ['find-generic-password', '-s', service, '-w'], timeoutMs);
  if (!r.launched || r.timedOut || r.status !== 0) return null;
  const text = String(r.stdout ?? '').trim();
  return text || null;
}

/** One HTTP call, JSON in hand or a word for why not. `timeout` and `network` are different
 * verdicts; the response text is parsed and dropped, never carried past this call. */
export async function requestJson(url, {
  method = 'GET', headers = {}, body, timeoutMs,
}) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetch(url, {
      method, headers, ...(body === undefined ? {} : { body }), signal: control.signal,
    });
    const text = await res.text();
    let doc = null;
    try {
      doc = JSON.parse(text);
    } catch {
      doc = null;
    }
    return { status: res.status, doc };
  } catch (error) {
    return { error: error?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** One verdict, of any adapter or of the preflight itself. `source` is `probe` by default —
 * override it in `extra` for a cache-sourced verdict, along with the `checkedAt` it keeps. */
export function verdict(state, reason, message, extra = {}) {
  return {
    state,
    reason,
    message,
    checkedAt: isoStamp(),
    source: 'probe',
    resetAt: null,
    ...extra,
  };
}
