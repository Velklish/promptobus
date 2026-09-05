// Codex availability adapter: what the account can do with `codex` right now,
// answered from a fresh `codex app-server --stdio` that is closed again without a
// thread and without a turn.
//
// **Why a second gate at all.** The start path in [codex-session.js](../codex-session.js)
// already refuses a lift on a spent limit, but it refuses INSIDE the lift, after
// the holder process, the socket and the thread are being set up. The resolver
// needs the same fact BEFORE it picks a harness, and it must be able to ask about
// three harnesses at once for less than the price of one lift. So the two gates
// stay two, and what they share is the reading of the protocol
// (`rateLimitReached`, `listedModels`), not a copy of it.
//
// **Where the limit comes from, measured on codex-cli 0.146.0.** The
// `account/rateLimits/updated` notification the start path waits for does NOT
// arrive after `initialize` alone — waits of 10 s and 30 s on a live account saw
// only `remoteControl/status/changed`. It is a request that answers:
// `account/rateLimits/read` is in the binary's own method list and replies at once
// with the same snapshot. So the request is the source, and the bounded wait for
// the notification stays as the path for a binary that does not have the method —
// the shape the brief for this task described, kept where it still applies.
//
// **Two neighbouring methods this file must never call.** `getAuthStatus` answers
// `{ authMethod, authToken, requiresOpenaiAuth }` — it would be a crisper auth
// signal and it hands back a TOKEN, and this module's `message` is the one free
// text that reaches disk. `account/read` answers the account e-mail. The verdict
// is built from limits and model names, and neither of those two is asked.
//
// **Stderr is not a channel here.** app-server writes
// `ERROR codex_models_manager::cache: failed to load models cache: missing field
// 'base_instructions'` on a perfectly good run, so a probe that read stderr as a
// verdict would call a working account broken. The child gets no stderr pipe at
// all: what is not connected cannot be misread.
import { spawn } from 'node:child_process';
import { CodexRpc } from '../codex-rpc.js';
import {
  INIT_TIMEOUT_MS, MODEL_LIST_TIMEOUT_MS, limitWaitMs, listedModels, rateLimitReached,
} from '../codex-session.js';

/** Ceiling for one `account/rateLimits/read`. The whole budget still caps it. */
export const LIMIT_READ_TIMEOUT_MS = 10_000;

/** How a step ended when it did not end with a reply. */
const TIMED_OUT = { gone: 'timeout' };
const BROKEN = { gone: 'broken' };
const DIED = { gone: 'exit' };
const NO_START = { gone: 'nostart' };

/**
 * Which of the two a rejected request was.
 *
 * `CodexRpc.request` rejects for exactly two reasons and says which in the text
 * it writes itself (`codex-rpc.js`): `no reply to <method> in <n> ms` is the
 * timeout, and anything else — a closed or broken stream — is a channel that
 * went. Reading that text is the whole handle there is, and it does not travel:
 * what reaches the verdict is a sentence written in this file. Telling them apart
 * matters because a budget that ran out and a pipe that died ask a person for
 * different things — wait, or look at the binary.
 */
const rejection = (e) => (/^no reply to /.test(String(e?.message ?? '')) ? TIMED_OUT : BROKEN);

/** A verdict of this adapter. `source` and `checkedAt` are the same on every one of them. */
function verdict(state, reason, message, extra = {}) {
  return {
    state,
    reason,
    message,
    checkedAt: new Date().toISOString(),
    source: 'probe',
    resetAt: null,
    ...extra,
  };
}

/**
 * The limit snapshot inside whatever carried it. `account/rateLimits/read` wraps
 * it in `rateLimits`; the notification carries it flat, which is the shape
 * `rateLimitReached` has always read.
 */
export function rateLimitSnapshot(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const snap = payload.rateLimits ?? payload;
  return snap && typeof snap === 'object' ? snap : null;
}

/**
 * The last moment a timestamp may name. The snapshot schema wants a four-digit
 * year, and `resetsAt` handed over in MILLISECONDS instead of seconds lands tens
 * of thousands of years out: the entry would then stop validating, and — worse —
 * an exhaustion held by that reset would never expire by itself.
 */
const LATEST_STAMP_MS = Date.UTC(9999, 11, 31);

/**
 * A reset moment as ISO-8601. Codex names it `resetsAt` in unix SECONDS on the
 * request and as an ISO string on the notification; a value that is neither, or
 * one outside the range a timestamp can have, is unknown — which the snapshot
 * writes as `null`. Nothing is repaired here: a millisecond value silently
 * divided by a thousand would be a time this adapter invented.
 */
export function resetIso(value) {
  const ms = typeof value === 'number' ? value * 1000 : (typeof value === 'string' ? Date.parse(value) : NaN);
  if (!Number.isFinite(ms) || ms < 0 || ms > LATEST_STAMP_MS) return null;
  return new Date(ms).toISOString();
}

/**
 * The subscription windows of a snapshot, normalised.
 *
 * `id` is the name the payload gives the window — `primary` and `secondary` — and
 * nothing here renames them into hours and days: the length is a number the
 * harness states (`windowDurationMins`), and a label invented from it would be a
 * second, quieter claim about the same fact. A window whose `usedPercent` is not a
 * number is not a window and is left out; the projection would drop it anyway.
 *
 * A snapshot that names no window at all but carries the numbers at its own top
 * level is one window, and it is `primary`. That shape is not invented here:
 * `rateLimitReached` counts the snapshot itself among the windows it checks, and
 * `rateLimitNote` reads `snap.primary?.usedPercent ?? snap.usedPercent` — the
 * flat form has always been the primary window written without its name. Losing
 * it would turn an exhaustion the harness DID time into a sticky one that only
 * `--clear-exhausted` lifts.
 */
export function rateLimitWindows(snap) {
  const out = [];
  const sources = [['primary', snap?.primary], ['secondary', snap?.secondary]];
  if (!snap?.primary && !snap?.secondary) sources[0] = ['primary', snap];
  for (const [id, w] of sources) {
    if (!w || typeof w !== 'object') continue;
    const usedPercent = Number(w.usedPercent);
    if (!Number.isFinite(usedPercent)) continue;
    const window = { id, usedPercent };
    const mins = Number(w.windowDurationMins);
    if (Number.isFinite(mins) && mins >= 1) window.lengthSec = Math.round(mins * 60);
    window.resetAt = resetIso(w.resetsAt);
    out.push(window);
  }
  return out;
}

/**
 * When the spent window comes back, or `null` when the snapshot does not say.
 *
 * `rateLimitReachedType` names which window was reached; without it the reached
 * window is whichever is at 100 %. The snapshot's OWN `resetsAt` is the last
 * candidate, for the flat form that names no window — the same shape
 * `rateLimitNote` has always read. A reset that is not read leaves the exhaustion
 * sticky — cleared by `--clear-exhausted` and by nothing else — which is the
 * honest reading when the harness named no time.
 */
export function reachedResetAt(snap) {
  const order = ['primary', 'secondary'];
  const reached = order.find((id) => Number(snap?.[id]?.usedPercent) >= 100);
  // The window the harness NAMED comes first: with both windows spent it is the
  // only thing that says which one the refusal was about.
  for (const id of [snap?.rateLimitReachedType, reached, ...order]) {
    if (!id) continue;
    const iso = resetIso(snap?.[id]?.resetsAt);
    if (iso) return iso;
  }
  return resetIso(snap?.resetsAt);
}

/**
 * Whether an error says this binary does not have the method, rather than
 * refusing to answer it.
 *
 * Both come back as `-32600`, so the code cannot tell them apart; the text can.
 * `unknown variant` is serde's own wording for a method name the binary does not
 * parse, and every OTHER refusal of `account/rateLimits/read` is the one measured
 * on a logged-out account. The text is read here and never carried: what reaches
 * the verdict is a sentence written in this file.
 */
export function unsupportedMethod(error) {
  return /unknown variant/i.test(String(error?.message ?? ''));
}

/** A window count and a model count, in words that are ours rather than the harness's. */
function inventoryNote(windows, models) {
  const parts = [];
  if (windows?.length) parts.push(`${windows.length} limit window${windows.length === 1 ? '' : 's'}`);
  if (models?.length) parts.push(`${models.length} model${models.length === 1 ? '' : 's'} listed`);
  return parts.length ? parts.join(', ') : 'nothing listed';
}

/**
 * Ask Codex about the account.
 *
 * The second argument is the driver's launch context — the tool name it resolves
 * by and the environment it starts app-server in. It comes from the driver rather
 * than being rebuilt here so that the probe runs under exactly the isolated
 * config a lift would use; the adapter contract's own request carries neither.
 *
 * Never throws: a thrown error reaches the preflight as `probe_failed` with its
 * text discarded, and the text is the only thing a person would have wanted.
 */
export async function probeCodex({ host, timeoutMs }, { tool, env }) {
  // The host is somebody else's implementation, and the contract's rule is that an
  // adapter ANSWERS: a throw from here would reach the preflight as `probe_failed`
  // with its text dropped, which is the one thing a person needed.
  let bin = null;
  try {
    bin = host?.resolveToolBin?.(tool);
  } catch {
    return verdict('unknown', 'probe_failed', `the host could not resolve the ${tool} binary`);
  }
  if (!bin?.ok || !bin.bin) {
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

  // The pipes get their own error listeners, and they get them here rather than
  // where they are written to. `resolveToolBin` may say `ok` about a binary that
  // is not there — the SHIPPED standalone host answers `{ ok: true, bin: name }`
  // for any name at all — and then ENOENT arrives on the streams, not as a
  // return value. A pipe error with no listener is an uncaught exception that
  // takes the whole command down, which is the one thing an adapter may never do;
  // the same trap is named in `test/races.test.mjs` for the child doors there.
  child.stdin.on('error', () => {});
  child.stdout.on('error', () => {});

  // Resolves only if the process goes before we are done with it. A dead
  // app-server would otherwise hold the whole shared budget waiting for a reply
  // nobody is going to send.
  const died = new Promise((resolve) => {
    child.on('error', () => resolve(NO_START));
    child.on('exit', () => resolve(DIED));
  });
  const rpc = CodexRpc({ stdin: child.stdin, stdout: child.stdout });
  // The notification arrives unbidden, so it is collected from the first byte
  // rather than waited for from the point where it is needed.
  let notified = null;
  rpc.onNotification((msg) => {
    if (msg.method === 'account/rateLimits/updated' && notified === null) notified = msg.params ?? null;
  });

  const left = () => deadline - Date.now();
  const ask = (method, capMs, params = {}) => {
    const ms = Math.min(capMs, left());
    if (ms <= 0) return Promise.resolve(TIMED_OUT);
    return Promise.race([rpc.request(method, params, ms).catch(rejection), died]);
  };
  const stopped = (answer) => {
    if (answer.gone === 'timeout') {
      return verdict('unknown', 'probe_timeout',
        `app-server did not answer within the ${timeoutMs} ms preflight budget`, version);
    }
    const why = {
      broken: 'the app-server channel broke before it answered',
      // The shipped standalone host says `ok` about any name, so this is also
      // where a `codex` that is not installed at all arrives.
      nostart: `app-server could not be started — there may be no ${tool} binary at that path`,
    }[answer.gone] ?? 'app-server exited before it answered';
    return verdict('unknown', 'probe_failed', why, version);
  };

  try {
    const init = await ask('initialize', INIT_TIMEOUT_MS, {
      clientInfo: { name: 'promptobus', version: '0.0.0' },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: ['mcpServer/startupStatus/updated'],
      },
    });
    if (init.gone) return stopped(init);
    if (init.error) return verdict('unknown', 'probe_failed', 'app-server refused initialize', version);

    const limits = await ask('account/rateLimits/read', LIMIT_READ_TIMEOUT_MS);
    if (limits.gone) return stopped(limits);
    let snap = null;
    if (!limits.error) {
      snap = rateLimitSnapshot(limits.result);
    } else if (!unsupportedMethod(limits.error)) {
      return verdict('unavailable', 'not_authenticated',
        'the binary is there; this account is not logged into Codex', version);
    } else {
      snap = rateLimitSnapshot(notified ?? await waitForNotification(rpc, Math.min(limitWaitMs(), left())));
    }

    const listed = await ask('model/list', MODEL_LIST_TIMEOUT_MS);
    if (listed.gone) return stopped(listed);
    // Hidden models are left out: app-server marks them as ones it does not offer,
    // and an inventory that carries them would hand the resolver candidates the
    // harness itself declines to show. A `model/list` that refuses costs the
    // inventory and nothing else — the limit is still known.
    const models = listed.error
      ? null
      : listedModels(listed.result).filter((m) => !m.hidden).map((m) => ({ model: m.model }));
    const inventory = models ? { models } : {};

    if (!snap) {
      return verdict('unknown', 'quota_unknown',
        `app-server named no limit window; ${inventoryNote(null, models)}`,
        { ...version, ...inventory });
    }
    const windows = rateLimitWindows(snap);
    if (rateLimitReached(snap)) {
      const which = snap.rateLimitReachedType === 'primary' || snap.rateLimitReachedType === 'secondary'
        ? ` (${snap.rateLimitReachedType} window)`
        : '';
      return verdict('exhausted', 'subscription_exhausted',
        `the Codex limit is spent${which}; a turn is refused until it resets`,
        { ...version, ...inventory, windows, resetAt: reachedResetAt(snap) });
    }
    return verdict('available', null, `authenticated; ${inventoryNote(windows, models)}`,
      { ...version, ...inventory, windows });
  } catch (e) {
    // The contract's channel is a verdict, so even a bug in this file answers one.
    return verdict('unknown', 'probe_failed',
      `the Codex probe failed with ${e?.constructor?.name ?? typeof e}`, version);
  } finally {
    rpc.close();
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/** The bounded wait the start path does: a notification that does not come is not a refusal. */
function waitForNotification(rpc, ms) {
  if (!(ms > 0)) return Promise.resolve(null);
  return rpc.waitNotification('account/rateLimits/updated', () => true, ms)
    .then((msg) => msg.params ?? null)
    .catch(() => null);
}
