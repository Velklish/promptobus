// Codex availability adapter — the account gate that runs before any session
// exists. Run: npm test
//
// The subject is `lib/model-routing/adapter-codex.js`, reached the way the
// preflight reaches it: `codexDriver.availability.probe`. Nothing here is a
// stand-in adapter — the neighbouring
// [model-routing-preflight.test.mjs](model-routing-preflight.test.mjs) owns those.
// What IS substituted is the binary: `codex` on PATH is the stub app-server
// ([harness-codex.mjs](harness-codex.mjs)), extended for this file with the
// preamble shapes a probe meets — a binary that never answers, a limit read that
// refuses the way an old binary refuses and the way a logged-out account refuses,
// a hidden model, and the stderr line a healthy app-server writes anyway.
//
// The two facts this file exists to hold:
//
//   • **the probe never starts a thread.** Every check below runs against the same
//     stub home, and the last one asserts its `threads/` directory is still empty.
//     A probe that costs a thread costs a run, and the whole point of a preflight
//     is that it does not;
//   • **stderr is not a verdict.** The `base_instructions` cache ERROR is on for
//     every case here, not only its own, so a reading of stderr would redden the
//     file rather than one check in it.
// Home diversion before any import that is not a Node built-in: a module that
// resolved a home path at load would see the real one. [home.mjs](home.mjs) says
// what it applies; the sentinel in tmpdir-sweep.test.mjs keeps the order.
import './home.mjs';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { codexDriver } from '../lib/driver-codex.js';
import { adapterOf } from '../lib/drivers.js';
import { preflight } from '../lib/model-routing/preflight.js';
import { listedModels } from '../lib/codex-session.js';
import { isoStamp, snapshotEntry } from '../lib/model-routing/cache.js';
import {
  rateLimitSnapshot, rateLimitWindows, reachedResetAt, resetIso, unsupportedMethod,
} from '../lib/model-routing/adapter-codex.js';
import { makeSandbox, resolveToolBin } from './sandbox.mjs';
import {
  HARNESS_VERSION, LIMIT_VAR, PROBE_VAR, STUB_RESET_PRIMARY, STUB_RESET_SECONDARY, installHarness,
} from './harness-codex.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const SB = makeSandbox('promptobus-adapter-codex-');
const { home: HARNESS, restore } = await installHarness({ binDir: path.join(SB, 'bin') });

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validSnapshot = ajv.compile(JSON.parse(readFileSync(
  path.join(ROOT, 'schemas', 'model-routing', 'snapshot.schema.json'), 'utf8',
)));
const validates = (doc) => (validSnapshot(doc) ? true : ajv.errorsText(validSnapshot.errors));

/** The one thing the adapter asks a host for. The version is read from the stub's own `--version`. */
const host = { resolveToolBin: (name) => resolveToolBin(name) };

/**
 * Run the probe with the stand in a named shape. The flags reach the app-server
 * child through the environment, which is how the driver hands its isolated
 * environment over — so this is also what proves the probe uses it.
 *
 * `stderr` is on everywhere: the noise a healthy app-server writes must not change
 * a single verdict below.
 */
async function probe({ flags = '', limit = false, timeoutMs = 10_000, using = host } = {}) {
  process.env[PROBE_VAR] = ['stderr', ...(flags ? flags.split(',') : [])].join(',');
  if (limit) process.env[LIMIT_VAR] = '1';
  try {
    // Called the way the preflight calls it: the binary is resolved ONCE, before the
    // probe, and travels in the request ([preflight.js](../lib/model-routing/preflight.js)).
    // A host with no `resolveToolBin`, or one whose call throws, is `null` there —
    // the same reading the preflight applies, so what the checks below see is what
    // a real run would hand this adapter.
    const adapter = codexDriver.availability;
    let toolBin = null;
    try {
      if (typeof using?.resolveToolBin === 'function') toolBin = using.resolveToolBin(adapter.tool);
    } catch {
      toolBin = null;
    }
    return await adapter.probe({ host: using, toolBin, timeoutMs, refresh: false });
  } finally {
    delete process.env[PROBE_VAR];
    delete process.env[LIMIT_VAR];
  }
}

/**
 * A host whose `codex` is a plain shell script rather than the stub app-server.
 * Exactly one check needs it, and it needs it because of how the stub is launched:
 * `stubCommand` writes `exec node …`, so the stub REPLACES the shell and leaves no
 * wrapper behind — the case that does NOT put a grandchild on the inherited pipe. A
 * script whose `sleep` is forked does, which is the shape the live probe hit. POSIX
 * only, like every stub here.
 */
function shellHost(body) {
  const dir = path.join(SB, `shell-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'codex');
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return { resolveToolBin: () => ({ ok: true, bin, version: HARNESS_VERSION }) };
}

const names = (verdict) => (verdict.models ?? []).map((m) => m.model);
const windowById = (verdict, id) => (verdict.windows ?? []).find((w) => w.id === id);

// --- the parts, before the process ------------------------------------------

test('the limit snapshot is found whether it came wrapped or flat', () => {
  // `account/rateLimits/read` wraps it in `rateLimits`; the notification carries
  // it flat, which is the shape `rateLimitReached` has always read. One
  // classification, two carriers.
  const flat = { primary: { usedPercent: 3 } };
  assert.deepEqual(rateLimitSnapshot({ rateLimits: flat }), flat);
  assert.deepEqual(rateLimitSnapshot(flat), flat);
  assert.equal(rateLimitSnapshot(null), null);
});

test('a reset moment is read from unix seconds and from an ISO string, and from nothing else', () => {
  // Codex names the field `resetsAt` and gives seconds on the request, an ISO
  // string on the notification. A value that is neither is unknown — `null` is
  // the snapshot's own word for that, and a number invented here would read as a
  // measurement.
  assert.equal(resetIso(STUB_RESET_PRIMARY), '2100-01-01T00:00:00.000Z');
  assert.equal(resetIso('2099-01-01T00:00:00Z'), '2099-01-01T00:00:00.000Z');
  assert.equal(resetIso('soon'), null);
  assert.equal(resetIso(undefined), null);
});

test('a reset outside the range a timestamp can have is unknown, not a repaired one', () => {
  // The trap is `resetsAt` handed over in MILLISECONDS: multiplied again it lands
  // tens of thousands of years out, the entry stops validating against the
  // schema's four-digit year, and an exhaustion held by that reset would never
  // expire by itself. Dividing it by a thousand here would be a time this file
  // invented, so the answer is `null` — the snapshot's own word for unknown.
  assert.equal(resetIso(STUB_RESET_PRIMARY * 1000), null);
  assert.equal(resetIso(-1), null);
  assert.equal(resetIso(0), '1970-01-01T00:00:00.000Z');
});

test('windows keep the harness names and the harness numbers', () => {
  const windows = rateLimitWindows({
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: STUB_RESET_PRIMARY },
    secondary: { usedPercent: 46, windowDurationMins: 10080, resetsAt: null },
    tertiary: { usedPercent: 1 },
  });
  assert.deepEqual(windows, [
    { id: 'primary', kind: 'session', lengthSec: 18_000, usedPercent: 12, resetAt: '2100-01-01T00:00:00.000Z', scope: null },
    { id: 'secondary', kind: 'weekly', lengthSec: 604_800, usedPercent: 46, resetAt: null, scope: null },
  ]);
});

test('a snapshot that names no window is the primary window, and it needs a length like any other', () => {
  // `rateLimitReached` counts the snapshot itself among the windows it checks and
  // `rateLimitNote` reads `snap.usedPercent` — the flat form has always been the
  // primary window, so it is READ as one.
  //
  // What it is not given is a length it did not state. ADR-004 made `lengthSec`
  // required, because without it there is no pace and the cache projection drops
  // the window on the way to disk — invisibly. So a flat form that names a
  // duration is a window, and one that does not is none.
  assert.deepEqual(rateLimitWindows({ usedPercent: 100, windowDurationMins: 300, resetsAt: '2099-01-01T00:00:00Z' }),
    [{ id: 'primary', kind: 'session', lengthSec: 18_000, usedPercent: 100, resetAt: '2099-01-01T00:00:00.000Z', scope: null }]);
  assert.deepEqual(rateLimitWindows({ usedPercent: 100, resetsAt: '2099-01-01T00:00:00Z' }), []);

  // And the fear that made the flat reading matter is answered elsewhere, which
  // is why dropping a lengthless one costs nothing: the exhaustion's reset comes
  // from `reachedResetAt(snap)`, not from the window list, so a timed limit stays
  // timed and does not turn into the sticky kind.
  assert.equal(reachedResetAt({ usedPercent: 100, resetsAt: '2099-01-01T00:00:00Z' }),
    '2099-01-01T00:00:00.000Z');
  // A named window still wins: the flat reading is the fallback, not the rule.
  assert.deepEqual(rateLimitWindows({ usedPercent: 99, primary: { usedPercent: 12, windowDurationMins: 300 } }),
    [{ id: 'primary', kind: 'session', lengthSec: 18_000, usedPercent: 12, resetAt: null, scope: null }]);
});

test('the reset of an exhaustion is the reset of the window that was reached', () => {
  const snap = {
    primary: { usedPercent: 100, resetsAt: STUB_RESET_PRIMARY },
    secondary: { usedPercent: 46, resetsAt: STUB_RESET_SECONDARY },
  };
  assert.equal(reachedResetAt({ ...snap, rateLimitReachedType: 'secondary' }), '2100-01-02T00:00:00.000Z');
  assert.equal(reachedResetAt(snap), '2100-01-01T00:00:00.000Z');
  assert.equal(reachedResetAt({ primary: { usedPercent: 100 } }), null);
});

test('an unknown method and a refusal to answer are told apart by serde\'s own words', () => {
  // Both come back as -32600 on codex-cli 0.146.0, so the code cannot separate
  // them: `unknown variant` is a binary WITHOUT the method, and every other
  // refusal of that call is an account nobody is logged into.
  assert.equal(unsupportedMethod({ message: 'Invalid request: unknown variant `account/rateLimits/read`' }), true);
  assert.equal(unsupportedMethod({ message: 'codex account authentication required to read rate limits' }), false);
  assert.equal(unsupportedMethod(undefined), false);
});

test('hidden is carried by the shared model parse, not filtered inside it', () => {
  // The start path checks a NAMED model against these names and must still see a
  // hidden one; the adapter is what drops them. One parse, two readings.
  const parsed = listedModels({ data: [{ id: 'a' }, { id: 'b', hidden: true }, 'c'] });
  assert.deepEqual(parsed, [
    { model: 'a', hidden: false },
    { model: 'b', hidden: true },
    { model: 'c', hidden: false },
  ]);
  assert.deepEqual(listedModels({ data: 'not a list' }), []);
});

// --- the probe, against the stub app-server ---------------------------------

test('no binary is unavailable / binary_missing, and nothing is started', async () => {
  const verdict = await probe({ using: { resolveToolBin: () => ({ ok: false, reason: 'not on PATH' }) } });
  assert.equal(verdict.state, 'unavailable');
  assert.equal(verdict.reason, 'binary_missing');
  assert.equal(verdict.source, 'probe');
  assert.equal(verdict.windows, undefined);
});

test('a host that says ok about a binary that is not there answers, and does not crash', async () => {
  // The SHIPPED standalone host answers `{ ok: true, bin: name }` for any name at
  // all, so a machine without `codex` reaches `spawn` with the host's blessing.
  // ENOENT then arrives on the child and on its pipes, and a pipe error with no
  // listener is an uncaught exception — the command dies instead of reporting.
  const verdict = await probe({
    using: { resolveToolBin: (name) => ({ ok: true, bin: path.join(SB, 'nowhere', name) }) },
    timeoutMs: 4_000,
  });
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.reason, 'probe_failed');
  assert.match(verdict.message, /could not be started/);
});

test('a binary the preflight could not resolve is answered with a verdict, not with a throw', async () => {
  // The adapter no longer resolves anything itself: a synchronous `resolveToolBin`
  // holds the event loop, so the preflight makes that call once, before the race,
  // and a host with no method — or one whose call threw — arrives here as `null`.
  // The contract's channel is still a verdict, and the text is the adapter's own:
  // the host's would be the one thing a person wanted and the one thing that must
  // not travel into the field that reaches disk.
  const verdict = await probe({
    using: { resolveToolBin: () => { throw new Error('the host blew up'); } },
  });
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.reason, 'probe_failed');
  assert.ok(!verdict.message.includes('blew up'), 'foreign text must not reach the message');
});

test('an authenticated account is available, with both windows and the model inventory', async () => {
  const verdict = await probe();
  assert.equal(verdict.state, 'available');
  assert.equal(verdict.reason, null, verdict.message);
  assert.equal(verdict.version, HARNESS_VERSION);
  assert.deepEqual(names(verdict), ['gpt-5.6-sol', 'gpt-5.4-mini']);
  assert.deepEqual(windowById(verdict, 'primary'),
    { id: 'primary', kind: 'session', lengthSec: 18_000, usedPercent: 12, resetAt: '2100-01-01T00:00:00.000Z', scope: null });
  assert.deepEqual(windowById(verdict, 'secondary'),
    { id: 'secondary', kind: 'weekly', lengthSec: 604_800, usedPercent: 46, resetAt: '2100-01-02T00:00:00.000Z', scope: null });
  // The one field an `available` verdict may not carry: a reason on `available`
  // is a contract breach, and the preflight turns it into `probe_failed`.
  assert.equal(verdict.reason, null);
});

test('a model app-server hides is not in the inventory', async () => {
  const verdict = await probe({ flags: 'hidden' });
  assert.equal(verdict.state, 'available');
  assert.deepEqual(names(verdict), ['gpt-5.6-sol', 'gpt-5.4-mini']);
});

test('a spent limit is exhausted / subscription_exhausted, with the reset that clears it', async () => {
  const verdict = await probe({ limit: true });
  assert.equal(verdict.state, 'exhausted');
  assert.equal(verdict.reason, 'subscription_exhausted');
  assert.equal(verdict.resetAt, '2100-01-01T00:00:00.000Z');
  assert.equal(windowById(verdict, 'primary').usedPercent, 100);
  // A reset is what keeps the entry from being the sticky kind: with one, the
  // cache expires it by itself instead of waiting for --clear-exhausted.
  assert.ok(verdict.resetAt, 'an exhaustion with no reset is cleared only by hand');
});

test('an account nobody is logged into is unavailable / not_authenticated', async () => {
  // Measured on codex-cli 0.146.0 with an empty CODEX_HOME: `model/list` still
  // answers a full catalog, so the model list proves nothing about auth — the
  // limit read is what refuses.
  const verdict = await probe({ flags: 'unauthenticated' });
  assert.equal(verdict.state, 'unavailable');
  assert.equal(verdict.reason, 'not_authenticated');
  assert.equal(verdict.models, undefined, 'a logged-out account exposes no inventory of its own');
});

test('a binary without the limit read falls back to the notification, and that payload names no length', async () => {
  // The path the brief for this task described, kept for the binary it still
  // applies to. The notification carries the snapshot flat and with an ISO reset
  // — and, in the shape this stand-in models, no `windowDurationMins`.
  //
  // Since ADR-004 that means NO WINDOW rather than a window without a length: a
  // window with no length has no pace, and a length derived from the id would be
  // a number app-server never stated. The verdict is otherwise untouched — the
  // account is still known to be authenticated and still `available`. What it
  // costs is named rather than hidden: with no window, `remaining` is unknown for
  // this harness and the entry ages at the auth TTL rather than the window one.
  // Whether a real notification carries the duration is a question for the
  // adapters track (PB-24.1); if it does, reading it puts the window back.
  const verdict = await probe({ flags: 'unsupported' });
  assert.equal(verdict.state, 'available');
  assert.equal(verdict.reason, null, verdict.message);
  assert.deepEqual(verdict.windows, [], 'a payload with no duration states no window');
});

test('a flat notification of a spent limit keeps its RESET, which is the half that decides stickiness', async () => {
  // The fear this check was written for is unchanged and is still answered: an
  // exhaustion with `resetAt: null` is the sticky kind, which only
  // `--clear-exhausted` lifts, and reading a timed limit as one would be a
  // regression. It is answered by `reachedResetAt(snap)`, which reads the
  // snapshot and not the window list — so the reset survives even though the
  // payload states no duration and therefore states no window (ADR-004).
  const verdict = await probe({ flags: 'unsupported,flat', limit: true });
  assert.equal(verdict.state, 'exhausted');
  assert.equal(verdict.reason, 'subscription_exhausted');
  assert.equal(verdict.resetAt, '2099-01-01T00:00:00.000Z', 'a timed limit must not become the sticky kind');
  assert.deepEqual(verdict.windows, []);
});

test('a model list that refuses costs the inventory and nothing else', async () => {
  const verdict = await probe({ flags: 'no-models' });
  assert.equal(verdict.state, 'available');
  assert.equal(verdict.reason, null, verdict.message);
  assert.equal(verdict.models, undefined, 'an inventory that was refused is absent, not empty');
  assert.equal(windowById(verdict, 'primary').usedPercent, 12, 'the limit was known and stays known');
});

test('no limit source at all is unknown / quota_unknown, and the inventory still comes back', async () => {
  // "No notification" is not a refusal — that is the meaning the start path has
  // always given it, and the preflight must not turn it into one. `unknown` is
  // penalised by the resolver, never blocking.
  const verdict = await probe({ flags: 'unsupported,no-notify' });
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.reason, 'quota_unknown');
  assert.equal(verdict.windows, undefined, 'no stable limit source means no windows, not invented ones');
  assert.deepEqual(names(verdict), ['gpt-5.6-sol', 'gpt-5.4-mini']);
});

test('an app-server that never answers ends on the budget as unknown / probe_timeout', async () => {
  // The one wall-clock threshold in this file, and it is written the way
  // `fresh.test.mjs` writes its own: a 400 ms budget against a 10 000 ms verdict,
  // a twenty-five-fold margin. What it catches is a probe that spent its OWN
  // ceiling instead of the preflight's budget — `INIT_TIMEOUT_MS`, 30 s, three
  // times past the verdict — so load has to move the measurement by an order of
  // magnitude before it touches either side. The register of who is outside the
  // serial group and why ([run.mjs](run.mjs)) carries the same numbers.
  const started = Date.now();
  const verdict = await probe({ flags: 'hang', timeoutMs: 400 });
  const spent = Date.now() - started;
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.reason, 'probe_timeout');
  assert.ok(spent < 10_000, `the probe held ${spent} ms past a 400 ms budget`);
});

test('the probe does not block the event loop, so the preflight budget can still fire', async () => {
  // The contract says a probe must not hold the event loop, and the preflight holds
  // ONE budget for every adapter as a timer racing their promises: an adapter that
  // blocked would stop that timer while it worked, and the ceiling of the run would
  // become the sum of the blocking adapters instead of one budget. What is asserted
  // is not this probe's duration but that OTHER work ran while it was in flight.
  //
  // Mutation probe: make the app-server exchange synchronous and this goes red
  // while every other check in the file stays green.
  // Counted rather than timed: the file runs in the pool, and a threshold in
  // milliseconds would measure the machine's neighbours. A blocked loop fires a
  // 20 ms interval once, however long the block — node coalesces the periods it
  // missed into a single callback — while a probe that yields lets it tick on every
  // turn. Five is a fifth of what an unloaded run counts here.
  const started = Date.now();
  let ticks = 0;
  const beat = setInterval(() => { ticks += 1; }, 20);
  const verdict = await probe();
  clearInterval(beat);
  const took = Date.now() - started;
  assert.equal(verdict.state, 'available', verdict.message);
  assert.ok(took > 150, `app-server answered in ${took} ms — too fast to prove anything`);
  assert.ok(ticks >= 5, `a 20 ms interval ticked ${ticks} times while a ${took} ms probe ran`);
});

test('the deadline holds when a grandchild keeps the pipe open, and the pipes are let go', async () => {
  // `close` fires when the last stdio pipe closes, not when the child dies, so a
  // process app-server left behind holding the inherited pipe keeps that pipe open
  // past the kill. Measured 2026-09-05 against this wrapper: the verdict was
  // already answered on the deadline — the RPC request rejects on its own timer —
  // and the RUN was held 5.2 s past it by pipes nobody was reading any more
  // (`rpc.close()` settles the pending requests and touches no stream). Whether
  // `/bin/sh` has forked its `sleep` by the deadline is a race, so the hold is
  // intermittent and this check is green when it did not happen at all.
  //
  // Mutation probe: take `stdout.destroy()` / `stdin.destroy()` / `unref()` out of
  // the `finally` and the pipe count goes red on the runs where the fork happened.
  // A destroyed stream does not leave the list on the next tick: measured, the
  // handle goes within ~50 ms, so the settle is a short timer rather than
  // `setImmediate`. A pipe a grandchild still holds is there for five seconds and
  // no settle hides it.
  const settled = () => new Promise((r) => { setTimeout(r, 150); });
  await settled();
  // `PipeWrap` is what libuv calls a child's stdio pipe in this list; a stream
  // destroyed and unref'd leaves none behind, an unread one that a grandchild still
  // holds stays until that process dies.
  const pipes = () => process.getActiveResourcesInfo().filter((r) => r === 'PipeWrap').length;
  const before = pipes();
  const started = Date.now();
  const verdict = await probe({ timeoutMs: 700, using: shellHost('sleep 5') });
  const took = Date.now() - started;
  await settled();
  assert.equal(verdict.reason, 'probe_timeout', verdict.message);
  assert.ok(took < 2000, `the probe answered ${took} ms after a 700 ms deadline`);
  assert.equal(pipes(), before, 'the probe left unread pipes holding the event loop open');
});

test('the stderr line a healthy app-server writes is never a verdict', async () => {
  // Every check in this file runs with that line on. This one says so out loud:
  // the same run, and the verdict is the authenticated one.
  const verdict = await probe();
  assert.equal(verdict.state, 'available');
  assert.ok(!verdict.message.includes('base_instructions'), 'harness output must not reach the message');
  assert.ok(!verdict.message.includes('codex_models_manager'), 'harness output must not reach the message');
});

// --- through the preflight, onto disk ---------------------------------------

test('the verdict passes the contract gate and validates as a snapshot entry', async () => {
  // `verdictOf` turns anything outside the closed lists into `probe_failed` with
  // the field named, so a `probe_failed` here IS the failure: the adapter would
  // have answered a state, a reason or a source the schema does not have.
  const dir = path.join(SB, 'snapshot');
  const routingHost = {
    ...host,
    routingPaths: () => ({ cacheFile: path.join(dir, 'cache.json'), overlays: [] }),
  };
  process.env[PROBE_VAR] = 'stderr';
  let snapshot;
  try {
    snapshot = await preflight({
      host: routingHost, harnesses: ['codex'], adapterFor: adapterOf, budgetMs: 10_000,
    });
  } finally {
    delete process.env[PROBE_VAR];
  }
  const entry = snapshot.harnesses.codex;
  assert.notEqual(entry.reason, 'probe_failed', entry.message);
  assert.equal(entry.state, 'available');
  assert.ok(validSnapshot(snapshot), ajv.errorsText(validSnapshot.errors));
  // What the projection let onto disk is what the schema declares, and the file
  // is the document, not the verdict.
  const written = JSON.parse(readFileSync(path.join(dir, 'cache.json'), 'utf8'));
  assert.ok(validSnapshot(written), ajv.errorsText(validSnapshot.errors));
  assert.equal(written.harnesses.codex.state, 'available');
});

test('not one of those probes started a thread', async () => {
  // The whole preflight is worth nothing if it costs what it is meant to avoid.
  // The stub writes a file per thread; after every check above there must be none.
  let threads = [];
  try {
    threads = readdirSync(path.join(HARNESS, 'threads'));
  } catch {
    threads = [];
  }
  assert.deepEqual(threads, [], `the probe started ${threads.length} thread(s)`);
  restore();
});

test('a Codex window survives the cache projection — kind, length and scope are stated, not guessed', () => {
  // The regression this exists for is silent: `windowOf` requires `kind`,
  // `lengthSec` and an explicit `scope` since ADR-004, and an adapter still
  // emitting the old shape would have every window DROPPED on the way to disk.
  // Nothing would go red — `remaining` would quietly become 50 for every
  // candidate, each would take the −10 unknown penalty, and the entry would fall
  // out of the 60 s window TTL into the 1 h auth one, so a spent Codex account
  // would look fine for an hour.
  //
  // So the check is the ROUND TRIP, adapter into projection, and not the
  // adapter's own output compared with a fixture that moves when the code does.
  //
  // Mutation probe: drop `kind` (or `scope`) from `rateLimitWindows` and the
  // projected list below comes back empty.
  const snap = rateLimitSnapshot({
    rateLimits: {
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1788668319 },
      secondary: { usedPercent: 46, windowDurationMins: 10080, resetsAt: 1789040909 },
    },
  });
  const windows = rateLimitWindows(snap);
  assert.deepEqual(windows.map((w) => [w.id, w.kind, w.lengthSec, w.scope]), [
    ['primary', 'session', 18000, null],
    ['secondary', 'weekly', 604800, null],
  ]);

  const projected = snapshotEntry({
    state: 'available', reason: null, message: 'ok', checkedAt: isoStamp(), source: 'probe', windows,
  });
  assert.deepEqual(projected.windows, windows, 'the projection dropped a window the adapter reported');
  assert.equal(validates({ schemaVersion: 2, takenAt: isoStamp(), harnesses: { codex: projected } }), true);

  // A window whose length app-server did not state is left out by the adapter
  // rather than given one: without a length there is no pace, and a number
  // invented here would be one the harness never said.
  assert.deepEqual(rateLimitWindows(rateLimitSnapshot({
    rateLimits: { primary: { usedPercent: 12, resetsAt: 1788668319 } },
  })), []);
});
