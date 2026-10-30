// Codex adapter: what the probe reads.
// [guides/model-routing.md#codex-adapter-what-the-probe-reads](../../docs/guides/model-routing.md#codex-adapter-what-the-probe-reads)
import { spawn } from 'node:child_process';
import { CodexRpc } from '../codex-rpc.js';
import {
  INIT_TIMEOUT_MS, MODEL_LIST_TIMEOUT_MS, codexInitParams, limitWaitMs, listedModels, rateLimitReached,
} from '../codex-session.js';
import { stampAtMs } from './cache.js';
import { verdict } from './adapter-common.js';

import type { ProbeRequest } from '../../dist/index.js';
import type { AdapterModel, AdapterVerdict } from './adapter-common.js';
import type { AvailabilityWindow } from './cache.js';
import type { CodexRateLimits } from '../codex-session.js';

interface ProbeReply { gone?: string; error?: { message?: unknown }; result?: unknown }
interface ProbeRuntime { tool: string; env: NodeJS.ProcessEnv }

/** Ceiling for one `account/rateLimits/read`. The whole budget still caps it. */
export const LIMIT_READ_TIMEOUT_MS = 10_000;

/** How a step ended when it did not end with a reply. */
const TIMED_OUT = { gone: 'timeout' };
const BROKEN = { gone: 'broken' };
const DIED = { gone: 'exit' };
const NO_START = { gone: 'nostart' };

/** Which of the two a rejected request was. Telling them apart matters: a spent budget and a dead
 * pipe ask a person for different things. The text is read here and never travels. */
const rejection = (e: { message?: unknown } | null | undefined) => (/^no reply to /.test(String(e?.message ?? '')) ? TIMED_OUT : BROKEN);

/** The limit snapshot inside whatever carried it: the request wraps it in `rateLimits`, the
 * notification carries it flat. */
export function rateLimitSnapshot(payload: unknown) {
  if (!payload || typeof payload !== 'object') return null;
  const snap = (payload as { rateLimits?: unknown }).rateLimits ?? payload;
  return snap && typeof snap === 'object' ? snap as CodexRateLimits : null;
}

/** A reset moment as ISO-8601; Codex names it in unix SECONDS on the request and as a string on
 * the notification. Nothing is repaired: a divided millisecond value would be an invented time. */
export function resetIso(value: unknown) {
  const ms = typeof value === 'number' ? value * 1000 : (typeof value === 'string' ? Date.parse(value) : NaN);
  return stampAtMs(ms);
}

/** The plan this account is on, or `null`. `source` is `probe` — the harness answered — and not
 * the method it answered on; the shape gate for the name is the cache's. */
export function accountTier(snap: CodexRateLimits | null | undefined) {
  const name = typeof snap?.planType === 'string' ? snap.planType.trim() : '';
  return name ? { name, source: 'probe' } : null;
}

/** Whether the account holds spendable credits, as two booleans — or `null`. **The balance is read
 * and never carried**: a count is a fact about the account, and nothing here reads one. */
export function accountCredits(snap: CodexRateLimits | null | undefined) {
  const raw = snap?.credits;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const balance = Number(raw.balance);
  const available = raw.hasCredits === true || (Number.isFinite(balance) && balance > 0);
  return { available, unlimited: raw.unlimited === true };
}

/** How many "full reset" credits the account may spend, or `null`. It sits at the TOP level of the
 * result, not inside `rateLimits`. **The adapter never spends one** (ADR-005). */
export function resetCreditCount(payload: unknown) {
  const count = (payload as { rateLimitResetCredits?: { availableCount?: unknown } } | null | undefined)?.rateLimitResetCredits?.availableCount;
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? { available: count } : null;
}

// The subscription windows of a snapshot, normalised.
// [guides/model-routing.md#window_kind_by_id--the-subscription-windows-of-a-snapshot-normalised](../../docs/guides/model-routing.md#window_kind_by_id--the-subscription-windows-of-a-snapshot-normalised)
export const WINDOW_KIND_BY_ID: Record<string, string> = { primary: 'session', secondary: 'weekly' };

export function windowKind(id: string, lengthSec: number | null | undefined) {
  if (!Number.isFinite(lengthSec) || lengthSec! < 1) return WINDOW_KIND_BY_ID[id];
  return lengthSec! >= 604_800 ? 'weekly' : 'session';
}

export function rateLimitWindows(snap: CodexRateLimits | null | undefined) {
  const out: AvailabilityWindow[] = [];
  const sources: [string, CodexRateLimits | null | undefined][] = [['primary', snap?.primary], ['secondary', snap?.secondary]];
  if (!snap?.primary && !snap?.secondary) sources[0] = ['primary', snap];
  for (const [id, w] of sources) {
    if (!w || typeof w !== 'object') continue;
    const usedPercent = Number(w.usedPercent);
    if (!Number.isFinite(usedPercent)) continue;
    const mins = w.windowDurationMins == null ? NaN : Number(w.windowDurationMins);
    const seconds = w.lengthSec == null ? NaN : Number(w.lengthSec);
    const lengthSec = Number.isFinite(mins) && mins >= 1 ? Math.round(mins * 60)
      : Number.isFinite(seconds) && seconds >= 1 ? Math.round(seconds) : null;
    if (lengthSec === null) continue;
    out.push({
      id,
      kind: windowKind(id, lengthSec)!,
      lengthSec,
      usedPercent,
      resetAt: resetIso(w.resetsAt),
      scope: null,
    });
  }
  return out;
}

/** When the spent window comes back, or `null`. Without `rateLimitReachedType` the reached window
 * is whichever is at 100 %. A reset that is not read leaves the exhaustion sticky. */
export function reachedResetAt(snap: CodexRateLimits | null | undefined) {
  const order = ['primary', 'secondary'] as const;
  const reached = order.find((id) => Number(snap?.[id]?.usedPercent) >= 100);
  // The window the harness NAMED comes first: with both windows spent it is the
  // only thing that says which one the refusal was about.
  for (const id of [snap?.rateLimitReachedType, reached, ...order]) {
    if (!id) continue;
    const iso = resetIso((snap?.[id] as CodexRateLimits | null | undefined)?.resetsAt);
    if (iso) return iso;
  }
  return resetIso(snap?.resetsAt);
}

/** Whether an error says this binary lacks the method rather than refusing to answer it. Both are
 * `-32600`, so only the text can tell them apart, and the text is never carried. */
export function unsupportedMethod(error: { message?: unknown } | null | undefined) {
  return /unknown variant/i.test(String(error?.message ?? ''));
}

/** What the account holds beside its windows, as a tail on the diagnosis. Unused reset credits
 * beside a spent window are worth knowing, and **this adapter never spends one**. */
function creditNote(credits: ReturnType<typeof accountCredits>, resetCredits: ReturnType<typeof resetCreditCount>, spendControlReached: unknown) {
  const parts = [];
  if (resetCredits?.available) {
    parts.push(`${resetCredits.available} reset credit${resetCredits.available === 1 ? '' : 's'} available`);
  }
  if (credits?.unlimited) parts.push('credits unlimited');
  else if (credits?.available) parts.push('credits available');
  if (spendControlReached === true) parts.push('the account spend control is at its ceiling');
  return parts.length ? `; ${parts.join('; ')}` : '';
}

/** A window count and a model count, in words that are ours rather than the harness's. */
function inventoryNote(windows: readonly AvailabilityWindow[] | null, models: readonly AdapterModel[] | null) {
  const parts = [];
  if (windows?.length) parts.push(`${windows.length} limit window${windows.length === 1 ? '' : 's'}`);
  if (models?.length) parts.push(`${models.length} model${models.length === 1 ? '' : 's'} listed`);
  return parts.length ? parts.join(', ') : 'nothing listed';
}

/** Ask Codex about the account. The driver's launch context comes in so the probe runs under the
 * same isolated config a lift would use. Never throws: a throw loses the text with it. */
export async function probeCodex({ toolBin: bin, timeoutMs }: ProbeRequest, { tool, env }: ProbeRuntime): Promise<AdapterVerdict> {
  // The binary arrives already resolved: `resolveToolBin` is synchronous and would stop the timer
  // that bounds the preflight. A host with no such method reaches here as `null`.
  if (!bin) {
    return verdict('unknown', 'probe_failed', `the host could not resolve the ${tool} binary`);
  }
  if (!bin.ok || !bin.bin) {
    return verdict('unavailable', 'binary_missing', `no ${tool} binary on this machine`);
  }
  const version = typeof bin.version === 'string' && bin.version ? { version: bin.version } : {};
  const deadline = Date.now() + Math.max(0, timeoutMs);

  let child;
  try {
    child = spawn(bin.bin, ['app-server', '--stdio'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    return verdict('unknown', 'probe_failed', 'app-server did not start', version);
  }

  // The pipes get their own error listeners: `resolveToolBin` may say `ok` about a binary that is
  // not there, and an unlistened pipe error is an uncaught exception that ends the command.
  child.stdin.on('error', () => {});
  child.stdout.on('error', () => {});

  // Resolves only if the process goes before we are done with it: a dead app-server would
  // otherwise hold the whole shared budget waiting for a reply nobody will send.
  const died = new Promise<ProbeReply>((resolve) => {
    child.on('error', () => resolve(NO_START));
    child.on('exit', () => resolve(DIED));
  });
  const rpc = CodexRpc({ stdin: child.stdin, stdout: child.stdout });
  // The notification arrives unbidden, so it is collected from the first byte
  // rather than waited for from the point where it is needed.
  let notified: unknown = null;
  rpc.onNotification((raw) => {
    const msg = raw as { method?: string; params?: unknown };
    if (msg.method === 'account/rateLimits/updated' && notified === null) notified = msg.params ?? null;
  });

  const left = () => deadline - Date.now();
  const ask = (method: string, capMs: number, params: unknown = {}): Promise<ProbeReply> => {
    const ms = Math.min(capMs, left());
    if (ms <= 0) return Promise.resolve(TIMED_OUT);
    return Promise.race([(rpc.request(method, params, ms) as Promise<ProbeReply>).catch(rejection), died]);
  };
  const stopped = (answer: ProbeReply) => {
    if (answer.gone === 'timeout') {
      return verdict('unknown', 'probe_timeout',
        `app-server did not answer within the ${timeoutMs} ms left of the preflight budget`, version);
    }
    const why = ({
      broken: 'the app-server channel broke before it answered',
      // The shipped standalone host says `ok` about any name, so this is also
      // where a `codex` that is not installed at all arrives.
      nostart: `app-server could not be started — there may be no ${tool} binary at that path`,
    } as Record<string, string>)[answer.gone!] ?? 'app-server exited before it answered';
    return verdict('unknown', 'probe_failed', why, version);
  };

  try {
    const init = await ask('initialize', INIT_TIMEOUT_MS, codexInitParams(null, env));
    if (init.gone) return stopped(init);
    if (init.error) return verdict('unknown', 'probe_failed', 'app-server refused initialize', version);

    const limits = await ask('account/rateLimits/read', LIMIT_READ_TIMEOUT_MS);
    if (limits.gone) return stopped(limits);
    let snap = null;
    // The payload as well as the snapshot inside it: `rateLimitResetCredits` sits at the top
    // level, so a reader of the snapshot alone cannot see the reset credits at all.
    let payload = null;
    if (!limits.error) {
      payload = limits.result;
      snap = rateLimitSnapshot(payload);
    } else if (!unsupportedMethod(limits.error)) {
      return verdict('unavailable', 'not_authenticated',
        'the binary is there; this account is not logged into Codex', version);
    } else {
      payload = notified ?? await waitForNotification(rpc, Math.min(limitWaitMs(), left()));
      snap = rateLimitSnapshot(payload);
    }

    const listed = await ask('model/list', MODEL_LIST_TIMEOUT_MS, { includeHidden: true });
    if (listed.gone) return stopped(listed);
    // **Hidden models are KEPT, with the mark on them** (ADR-005): the resolver filters them, and
    // dropping them made `models` show an inventory the harness itself contradicts.

    // Inventory retains the model/list protocol's string model-id assumption, without validation.
    const models = listed.error
      ? null
      : listedModels(listed.result).map((m) => (m.hidden ? { model: m.model as string, hidden: true as const } : { model: m.model as string }));

    return limitVerdict({
      snap, payload, models, version,
    });
  } catch (caught) {
    const e = caught as { constructor?: { name?: unknown } } | null;
    // The contract's channel is a verdict, so even a bug in this file answers one.
    return verdict('unknown', 'probe_failed',
      `the Codex probe failed with ${e?.constructor?.name ?? typeof e}`, version);
  } finally {
    rpc.close();
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    // The kill does not release the pipes, and the verdict is already written — this is about the
    // process: [guides/model-routing.md](../../docs/guides/model-routing.md#killing-a-probes-child-why-three-lines-and-not-one).
    try { child.stdout.destroy(); child.stdin.destroy(); child.unref(); } catch { /* already gone */ }
  }
}

/** The second half of the probe: what the account holds, purely from what the lifecycle above
 * already fetched — no further call leaves the process, unlike the other two adapters' own. */
function limitVerdict({
  snap, payload, models, version,
}: { snap: CodexRateLimits | null; payload: unknown; models: AdapterModel[] | null; version: { version?: string } }): AdapterVerdict {
  const inventory = models ? { models } : {};
  if (!snap) {
    return verdict('unknown', 'quota_unknown',
      `app-server named no limit window; ${inventoryNote(null, models)}`,
      { ...version, ...inventory });
  }
  // What the account says about itself beside its windows, all of it
  // informational: nothing here is scored, and nothing spends a credit.
  const tier = accountTier(snap);
  const credits = accountCredits(snap);
  const resetCredits = resetCreditCount(payload);
  const said = {
    ...version,
    ...inventory,
    ...(tier ? { tier } : {}),
    ...(credits ? { credits } : {}),
    ...(resetCredits ? { resetCredits } : {}),
    ...(typeof snap.spendControlReached === 'boolean'
      ? { spendControlReached: snap.spendControlReached }
      : {}),
  };
  const note = creditNote(credits, resetCredits, snap.spendControlReached);

  const windows = rateLimitWindows(snap);
  if (rateLimitReached(snap)) {
    const which = snap.rateLimitReachedType === 'primary' || snap.rateLimitReachedType === 'secondary'
      ? ` (${snap.rateLimitReachedType} window)`
      : '';
    return verdict('exhausted', 'subscription_exhausted',
      `the Codex limit is spent${which}; a turn is refused until it resets${note}`,
      { ...said, windows, resetAt: reachedResetAt(snap) });
  }
  return verdict('available', null, `authenticated; ${inventoryNote(windows, models)}${note}`,
    { ...said, windows });
}

/** The bounded wait the start path does: a notification that does not come is not a refusal. */
function waitForNotification(rpc: ReturnType<typeof CodexRpc>, ms: number) {
  if (!(ms > 0)) return Promise.resolve(null);
  return rpc.waitNotification('account/rateLimits/updated', () => true, ms)
    .then((msg) => (msg as { params?: unknown }).params ?? null)
    .catch(() => null);
}
