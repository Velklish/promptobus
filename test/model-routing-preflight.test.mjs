// Availability preflight and cache: the adapter contract, the budget, the TTLs,
// and the rules that keep the cache file honest. Run: npm test
//
// The neighbouring [model-routing.test.mjs](model-routing.test.mjs) pins the
// CONTRACT — schemas, code lists, golden fixtures. This file is the first
// BEHAVIOUR under it, and the two do not overlap: what is asserted here is what
// running code does, and the shapes it produces are handed to the same schema the
// contract file pins rather than to a second copy of it.
//
// Nothing here starts a harness binary. Every probe is a stand-in adapter
// ([routing-stubs.mjs](routing-stubs.mjs)) — the states a preflight must handle
// (never answers, limit spent, nobody logged in) are states no live account is
// asked to be in for a test run.
//
// Two checks exist to be broken rather than to pass, and the mutation probes
// (result.md) name them: raising `PREFLIGHT_BUDGET_MS` reddens the budget check,
// dropping the `0600` reddens the permissions check, and making `dryRun` write
// reddens the no-write checks. The leak check has a substitution probe of its own:
// replace the closed-shape projection with a spread and the fake token appears on
// disk.
// Home diversion before any import that is not a Node built-in: a module that
// resolved a home path at load would see the real one. [home.mjs](home.mjs) says
// what it applies; the sentinel in tmpdir-sweep.test.mjs keeps the order.
import './home.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import {
  AUTH_TTL_MS, CACHE_MODE, LOCK_STALE_MS, LOCK_SUFFIX, LOCK_WAIT_MS, NEVER_CHECKED, TRANSIENT_TTL_MS,
  WINDOW_TTL_MS,
  clearExhausted, entryLive, isoStamp, markExhausted, readSnapshot, snapshotEntry, stickyExhaustion,
  writeEntries,
} from '../lib/model-routing/cache.js';
import { PREFLIGHT_BUDGET_MS, preflight } from '../lib/model-routing/preflight.js';
import { REGISTRY, adapterOf, standInAdapter } from '../lib/drivers.js';
import {
  FAKE_TOKEN, adapterMap, answeringStub, availableStub, counter, exhaustedStub, slowStub,
  throwingStub, toolStub, unauthenticatedStub,
} from './routing-stubs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const SNAPSHOT_SCHEMA = path.join(ROOT, 'schemas', 'model-routing', 'snapshot.schema.json');

// `strict: false` for the reason the contract file states: the schema's own
// vocabulary (`$defs` cross-references, `oneOf` beside `null`) is suspicious to ajv
// in strict mode, and the subject is the verdict.
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validSnapshot = ajv.compile(JSON.parse(readFileSync(SNAPSHOT_SCHEMA, 'utf8')));
const validates = (doc) => (validSnapshot(doc) ? true : ajv.errorsText(validSnapshot.errors));

/**
 * A host that answers nothing but the routing paths. The preflight and the cache
 * ask for exactly one thing — `routingPaths().cacheFile` — and a stand-in that
 * answers more would hide a module reaching for the store home.
 */
function sandboxHost() {
  const dir = mkdtempSync(path.join(tmpdir(), 'promptobus-routing-'));
  return {
    kind: 'promptobus-host',
    dir,
    cacheFile: path.join(dir, 'model-routing', 'cache.json'),
    routingPaths() {
      return { cacheFile: path.join(dir, 'model-routing', 'cache.json'), overlays: [] };
    },
  };
}

/** Seed the cache directly — the only way to age an entry without waiting out its TTL. */
function seed(host, harnesses, at = Date.now()) {
  writeEntries(host, harnesses, { at });
  return readSnapshot(host);
}

const entry = (over = {}) => ({
  state: 'available',
  reason: null,
  message: 'seeded',
  checkedAt: isoStamp(),
  source: 'probe',
  resetAt: null,
  ...over,
});

// --- the contract ------------------------------------------------------------

test('the adapter contract names the same states and reasons as the snapshot schema', async () => {
  // Two lists that must not drift: one is what an adapter author reads
  // (src/model-routing.ts), the other is what a written cache is validated
  // against. The reference table is compared to the schema by the contract file,
  // so all three are one list through this pair.
  const { AVAILABILITY_REASONS, AVAILABILITY_SOURCES, AVAILABILITY_STATES } = await import('../dist/index.js');
  const schema = JSON.parse(readFileSync(SNAPSHOT_SCHEMA, 'utf8'));
  assert.deepEqual([...AVAILABILITY_STATES], schema.$defs.state.enum);
  assert.deepEqual([...AVAILABILITY_REASONS], schema.$defs.reason.enum);
  assert.deepEqual([...AVAILABILITY_SOURCES], schema.$defs.harness.properties.source.enum);
});

test('a driver that declares no availability adapter answers unknown / probe_failed', async () => {
  // The subject is the registry's stand-in, not the shipped drivers: those gain
  // real adapters one by one (PB-15…PB-17), so the check pins the stand-in on a
  // bare driver and, separately, that every shipped driver WITHOUT an adapter
  // still gets it. It must be a state rather than a crash: the resolver
  // penalises `unknown`, and a throwing registry would take every routed command
  // with it.
  const request = { host: null, timeoutMs: 1, refresh: false };
  const bare = await standInAdapter({ id: 'stand-in' }).probe(request);
  assert.equal(bare.state, 'unknown');
  assert.equal(bare.reason, 'probe_failed');
  assert.match(bare.message, /stand-in/);
  for (const [harness, driver] of Object.entries(REGISTRY.drivers)) {
    if (driver.availability) continue;
    const verdict = await adapterOf(harness).probe(request);
    assert.equal(verdict.state, 'unknown', harness);
    assert.equal(verdict.reason, 'probe_failed', harness);
  }
});

// --- the budget --------------------------------------------------------------

test('the preflight budget is the 15 s ADR-003 fixed', () => {
  // A number in prose and a number in code are two numbers until something
  // compares them. This is the one that reddens when the budget is raised.
  assert.equal(PREFLIGHT_BUDGET_MS, 15_000);
});

test('a slow adapter does not hold the preflight: the run ends by the budget and that harness is probe_timeout', async () => {
  const host = sandboxHost();
  const count = counter();
  const budgetMs = 200;
  const started = Date.now();
  const snapshot = await preflight({
    host,
    harnesses: ['quick', 'slow', 'spent'],
    adapterFor: adapterMap({
      quick: availableStub(count),
      slow: slowStub(count, { delayMs: 30_000 }),
      spent: exhaustedStub(count, { resetAt: isoStamp(Date.now() + 3_600_000) }),
    }),
    budgetMs,
  });
  const elapsed = Date.now() - started;

  // Twenty-five-fold, the margin `fresh.test.mjs` uses for the same reason: the
  // file runs in the pool, and a tight wall-clock threshold measures the
  // machine's neighbours rather than the budget. The slow stub answers at 30 s,
  // so five seconds still proves the preflight did not wait for it.
  assert.ok(elapsed < budgetMs * 25, `the preflight ran ${elapsed} ms on a ${budgetMs} ms budget`);
  assert.equal(snapshot.harnesses.slow.state, 'unknown');
  assert.equal(snapshot.harnesses.slow.reason, 'probe_timeout');
  // The neighbours are not punished for it: they answered, and their answers stand.
  assert.equal(snapshot.harnesses.quick.state, 'available');
  assert.equal(snapshot.harnesses.spent.state, 'exhausted');
  assert.equal(count.probes, 3, 'all three adapters were started, in parallel');
  assert.equal(validates(snapshot), true);
});

test('a probe in flight does not stop the budget timer beside it', async () => {
  // The contract's rule, from the preflight's side: a probe must not block the
  // event loop. What is asserted is not the probe's own duration but that OTHER
  // work ran while it was in flight — a timer set for 20 ms fires long before a
  // 400 ms probe answers. The shipped adapters are pinned against the same rule in
  // their own files; this one pins the mechanism that would have to survive a third
  // party's adapter.
  // Counted rather than timed: the file runs in the pool, and a threshold in
  // milliseconds would measure the machine's neighbours. A blocked loop fires a
  // 20 ms interval once, however long the block — node coalesces the periods it
  // missed into a single callback — while a run that yields lets it tick on every
  // turn.
  const host = sandboxHost();
  const started = Date.now();
  let ticks = 0;
  const beat = setInterval(() => { ticks += 1; }, 20);
  const snapshot = await preflight({
    host,
    harnesses: ['slowish'],
    adapterFor: adapterMap({ slowish: toolStub('slowish-bin', { delayMs: 400 }) }),
    budgetMs: 5_000,
  });
  clearInterval(beat);
  const took = Date.now() - started;
  assert.equal(snapshot.harnesses.slowish.reason, 'quota_unknown');
  assert.ok(took > 250, `the stub answered in ${took} ms — too fast to prove anything`);
  assert.ok(ticks >= 5, `a 20 ms interval ticked ${ticks} times while a ${took} ms run took place`);
});

test('a harness the registry cannot answer for is one probe_failed, and its neighbours are still probed', async () => {
  // `adapterFor` is the caller's map, and the names reaching it come from
  // `host.declaredTools()` — a workspace declaration nothing here validated. A name
  // no driver answers for makes that call throw, and a map taken in one expression
  // sends that throw out of the whole preflight: three harnesses lost to one bad
  // line in a config file.
  //
  // Mutation probe: take the per-name `try` out of `adaptersOf` and this rejects
  // instead of answering, carrying the healthy neighbour down with it.
  const host = sandboxHost();
  const count = counter();
  const good = adapterMap({ ok: availableStub(count) });
  const snapshot = await preflight({
    host,
    harnesses: ['ok', 'not-a-harness'],
    adapterFor: (harness) => {
      if (harness === 'not-a-harness') throw new Error('no driver for /home/someone/promptobus.json');
      return good(harness);
    },
    budgetMs: 500,
  });
  const missing = snapshot.harnesses['not-a-harness'];
  assert.equal(missing.state, 'unknown');
  assert.equal(missing.reason, 'probe_failed');
  assert.match(missing.message, /no adapter could be taken/);
  // The registry's own text does not travel: it is free to name a path or a config
  // line, and `message` is the one free-text field that reaches disk.
  assert.ok(!missing.message.includes('promptobus.json'), missing.message);
  assert.equal(snapshot.harnesses.ok.state, 'available', 'the neighbour was still probed');
  assert.equal(count.probes, 1, 'and it was probed once — the broken one never reached a probe');
  assert.equal(validates(snapshot), true);
});

// --- the binaries, resolved before the race ----------------------------------

test('each declared binary is resolved once, before the adapters, and handed to its probe', async () => {
  // `resolveToolBin` is synchronous and a host may start a process inside it, so an
  // adapter calling it would hold the event loop and stop the budget timer that
  // bounds the run — no adapter can fix that from its own side (PB-16.2). The
  // resolve therefore happens here, once per binary, before anything races.
  //
  // Mutation probe: take the resolve out of the preflight and hand the adapters the
  // host instead — `calls` comes back empty and this reddens.
  const host = sandboxHost();
  const calls = [];
  const seen = [];
  const resolving = {
    ...host,
    resolveToolBin(name) {
      calls.push(name);
      return { ok: true, bin: path.join(host.dir, name), version: '1.2.3' };
    },
  };
  const snapshot = await preflight({
    host: resolving,
    harnesses: ['alpha', 'beta'],
    adapterFor: adapterMap({
      alpha: toolStub('alpha-bin', { seen }),
      beta: toolStub('beta-bin', { seen }),
    }),
    budgetMs: 5_000,
  });
  assert.deepEqual(calls, ['alpha-bin', 'beta-bin'], 'one resolve per declared binary, and no probe asked again');
  assert.deepEqual(seen.map((s) => s.toolBin?.bin),
    [path.join(host.dir, 'alpha-bin'), path.join(host.dir, 'beta-bin')]);
  assert.equal(seen[0].toolBin.version, '1.2.3', 'the whole HostToolBin travels, version included');
  assert.equal(snapshot.harnesses.alpha.reason, 'quota_unknown');
});

test('a binary two harnesses name is resolved once, not once per adapter', async () => {
  // A host resolve can cost seconds — this package's own Cursor driver says its
  // host asks `--version` with a 15 s ceiling — so the answer is memoised by tool
  // name. Blocking the loop for a second is what that costs, and the check is that
  // the run pays it once rather than once per adapter.
  //
  // Mutation probe: drop the `byTool` memo and this pays 1 s three times.
  const host = sandboxHost();
  const calls = [];
  const blocking = {
    ...host,
    resolveToolBin(name) {
      calls.push(name);
      // Spun rather than awaited on purpose: this is what a synchronous
      // `spawnSync` inside a host's resolve costs the event loop.
      const until = Date.now() + 1000;
      while (Date.now() < until) { /* held, exactly as spawnSync holds it */ }
      return { ok: true, bin: path.join(host.dir, name) };
    },
  };
  const started = Date.now();
  const snapshot = await preflight({
    host: blocking,
    harnesses: ['one', 'two', 'three'],
    adapterFor: adapterMap({
      one: toolStub('shared-bin'), two: toolStub('shared-bin'), three: toolStub('shared-bin'),
    }),
    budgetMs: 10_000,
  });
  const elapsed = Date.now() - started;
  assert.deepEqual(calls, ['shared-bin'], 'three adapters, one binary, one resolve');
  assert.ok(elapsed < 2_000, `three adapters paid the 1 s resolve ${elapsed} ms worth of times`);
  for (const harness of ['one', 'two', 'three']) {
    assert.equal(snapshot.harnesses[harness].reason, 'quota_unknown', harness);
  }
});

test('a resolve that spends the budget stops the run, and the harness it never reached says so', async () => {
  // The resolve is paid under the same deadline as the probes, because it is the
  // half nothing else bounds. Three binaries at 400 ms of blocked loop each against
  // a 500 ms budget: the first two are resolved — the second one overshoots, since
  // nothing interrupts a synchronous call — and the third is never asked at all.
  //
  // It is reported rather than waited for, and it is reported as a resolve: an
  // adapter that missed the budget is a slow harness, a resolve that missed it is a
  // slow HOST, and the person would look in different places.
  //
  // Mutation probe: drop the deadline check from `resolveBins` and all three
  // binaries are resolved — `calls` grows and the third harness answers a verdict
  // instead of saying it was never asked.
  const host = sandboxHost();
  const calls = [];
  const blocking = {
    ...host,
    resolveToolBin(name) {
      calls.push(name);
      const until = Date.now() + 400;
      while (Date.now() < until) { /* held */ }
      return { ok: true, bin: path.join(host.dir, name) };
    },
  };
  const started = Date.now();
  const snapshot = await preflight({
    host: blocking,
    harnesses: ['alpha', 'beta', 'gamma'],
    adapterFor: adapterMap({
      alpha: toolStub('alpha-bin'), beta: toolStub('beta-bin'), gamma: toolStub('gamma-bin'),
    }),
    budgetMs: 500,
  });
  const elapsed = Date.now() - started;
  assert.deepEqual(calls, ['alpha-bin', 'beta-bin'], 'the third binary was never resolved');
  assert.equal(snapshot.harnesses.gamma.state, 'unknown');
  assert.equal(snapshot.harnesses.gamma.reason, 'probe_timeout');
  assert.match(snapshot.harnesses.gamma.message, /resolving harness binaries/);
  // The two that were resolved still answered: a budget spent on the tail does not
  // throw away the head.
  assert.equal(snapshot.harnesses.alpha.reason, 'quota_unknown');
  assert.equal(validates(snapshot), true);
  // A loose guard beside the deterministic assertions above: the run may outlive
  // its budget by the one resolve already in flight, and by no more.
  assert.ok(elapsed < 2_000, `the run took ${elapsed} ms on a 500 ms budget with 400 ms resolves`);
});

test('a host that throws while resolving is not a crash: the adapter is asked with no binary', async () => {
  // The host is somebody else's implementation. A throw from it must not take the
  // command down, and it must not become a verdict here either: what a missing
  // binary means is the adapter's sentence to write, so `null` travels and the
  // adapter answers.
  const host = sandboxHost();
  const seen = [];
  const throwing = { ...host, resolveToolBin: () => { throw new Error('the host blew up'); } };
  const snapshot = await preflight({
    host: throwing,
    harnesses: ['alpha'],
    adapterFor: adapterMap({ alpha: toolStub('alpha-bin', { seen }) }),
    budgetMs: 5_000,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].toolBin, null);
  assert.equal(snapshot.harnesses.alpha.reason, 'quota_unknown');
  assert.ok(!snapshot.harnesses.alpha.message.includes('blew up'), 'the host text must not travel');
});

test('an adapter that throws, and one that answers outside the contract, are both probe_failed', async () => {
  const host = sandboxHost();
  const snapshot = await preflight({
    host,
    harnesses: ['broken', 'confused', 'locked'],
    adapterFor: adapterMap({
      broken: throwingStub(),
      confused: { probe: () => ({ state: 'fine, thanks', message: 'nonsense' }) },
      locked: unauthenticatedStub(),
    }),
    budgetMs: 500,
  });
  for (const harness of ['broken', 'confused']) {
    assert.equal(snapshot.harnesses[harness].state, 'unknown', harness);
    assert.equal(snapshot.harnesses[harness].reason, 'probe_failed', harness);
  }
  assert.equal(snapshot.harnesses.locked.state, 'unavailable');
  assert.equal(snapshot.harnesses.locked.reason, 'not_authenticated');
  assert.equal(validates(snapshot), true);
});

test('an answer outside the three closed lists is refused, and the diagnosis names the field', async () => {
  // The written cache promises to validate against the snapshot schema. A
  // misspelt reason or a source the enum does not carry would break that promise
  // from inside — the run would report success and leave a document nothing can
  // read back. This is the gate a typo in an adapter meets.
  const stamp = isoStamp();
  const breaches = {
    'misspelt-reason': { state: 'unknown', reason: 'quota-unknown', message: 'x', checkedAt: stamp, source: 'probe' },
    'unknown-source': { state: 'unknown', reason: 'quota_unknown', message: 'x', checkedAt: stamp, source: 'disk' },
    'reason-missing': { state: 'exhausted', reason: null, message: 'x', checkedAt: stamp, source: 'probe' },
    'stamp-unreadable': { state: 'available', reason: null, message: 'x', checkedAt: 'yesterday', source: 'probe' },
    'nothing-at-all': null,
  };
  const host = sandboxHost();
  const snapshot = await preflight({
    host,
    harnesses: [...Object.keys(breaches), 'fine'],
    adapterFor: adapterMap({
      ...Object.fromEntries(Object.entries(breaches).map(([k, v]) => [k, answeringStub(v)])),
      // An answer that omits what the contract lets it omit is not a breach: the
      // preflight stamps `checkedAt` and defaults `source`, as the contract says.
      fine: answeringStub({ state: 'available', reason: null, message: 'ok' }),
    }),
    budgetMs: 500,
  });

  for (const harness of Object.keys(breaches)) {
    assert.equal(snapshot.harnesses[harness].state, 'unknown', harness);
    assert.equal(snapshot.harnesses[harness].reason, 'probe_failed', harness);
  }
  assert.match(snapshot.harnesses['misspelt-reason'].message, /reason "quota-unknown"/);
  assert.match(snapshot.harnesses['unknown-source'].message, /source "disk"/);
  assert.match(snapshot.harnesses['reason-missing'].message, /exhausted with no reason/);
  assert.match(snapshot.harnesses['stamp-unreadable'].message, /checkedAt/);

  assert.equal(snapshot.harnesses.fine.state, 'available');
  assert.equal(snapshot.harnesses.fine.source, 'probe');
  assert.notEqual(snapshot.harnesses.fine.checkedAt, NEVER_CHECKED);
  assert.equal(validates(snapshot), true);
  assert.equal(validates(readSnapshot(host)), true, 'and what reached the file validates too');
});

test('a value the adapter garbled is dropped, and only that value', () => {
  // Dropped, never repaired: the resolver reads `usedPercent` as a measurement,
  // and a number invented here would validate while saying what no harness said.
  // Dropped by element, never by verdict: an adapter that garbles one row of an
  // inventory still knows whether the account is logged in.
  const projected = snapshotEntry({
    state: 'available',
    reason: null,
    message: 'still a usable answer',
    checkedAt: isoStamp(),
    source: 'probe',
    models: [
      { model: 'kept', flags: ['no-zdr', 'no-zdr', 'no-zdrr', ' '] },
      { model: 'withheld', hidden: true },
      { model: 'shown', hidden: false },
      { model: '   ' }, { model: null }, { model: 42 }, {},
    ],
    windows: [
      { id: 'kept', kind: 'session', lengthSec: 18000, usedPercent: 40 },
      { id: '', kind: 'session', lengthSec: 1, usedPercent: 1 },
      { id: 'nan', kind: 'session', lengthSec: 1, usedPercent: Number.NaN },
      { id: 'missing', kind: 'session', lengthSec: 1 },
      { id: 'over', kind: 'session', lengthSec: 1, usedPercent: 101 },
      { id: 'under', kind: 'session', lengthSec: 1, usedPercent: -1 },
      // ADR-004 makes kind and lengthSec required: a window with no length has no
      // PACE, and one that silently never paces is worse than one dropped here.
      { id: 'no-kind', lengthSec: 1, usedPercent: 1 },
      { id: 'bad-kind', kind: 'daily', lengthSec: 1, usedPercent: 1 },
      { id: 'no-length', kind: 'session', usedPercent: 1 },
      { id: 'zero-length', kind: 'session', lengthSec: 0, usedPercent: 1 },
      // A garbled scope takes its window with it rather than widening into
      // `null`: null is the CLAIM "this binds the whole account", and it would
      // apply somebody's per-model cap to every tuple of the harness.
      { id: 'bad-scope', kind: 'weekly', lengthSec: 1, usedPercent: 1, scope: 'everything' },
      { id: 'auto-no-models', kind: 'monthly', lengthSec: 1, usedPercent: 1, scope: { pool: 'auto' } },
      { id: 'api-with-models', kind: 'monthly', lengthSec: 1, usedPercent: 1, scope: { pool: 'api', models: ['x'] } },
      { id: 'third-shape', kind: 'weekly', lengthSec: 1, usedPercent: 1, scope: { bucket: 'everything' } },
      {
        id: 'scoped', kind: 'weekly', lengthSec: 604800, usedPercent: 12,
        scope: { model: 'Example Deep', models: ['example-deep', 'example-deep', ' '] },
      },
      // A display name the adapter could not resolve keeps its window: it is
      // printed for a person and binds nothing.
      { id: 'unresolved', kind: 'weekly', lengthSec: 604800, usedPercent: 3, scope: { model: 'Mystery' } },
      { id: 'unreadable-reset', kind: 'session', lengthSec: 18000, usedPercent: 5, resetAt: 'soon' },
    ],
  });
  // The flag list is closed (ADR-004): an overlay may deny by a flag, so a name
  // checked against nothing would let `no-zdrr` validate, match no model, and
  // read to whoever wrote it as a rule that holds.
  assert.deepEqual(projected.models, [
    { model: 'kept', rated: false, flags: ['no-zdr'] },
    { model: 'withheld', rated: false, hidden: true },
    { model: 'shown', rated: false },
  ]);
  assert.deepEqual(projected.windows, [
    { id: 'kept', kind: 'session', lengthSec: 18000, usedPercent: 40, scope: null },
    {
      id: 'scoped', kind: 'weekly', lengthSec: 604800, usedPercent: 12,
      scope: { model: 'Example Deep', models: ['example-deep'] },
    },
    { id: 'unresolved', kind: 'weekly', lengthSec: 604800, usedPercent: 3, scope: { model: 'Mystery' } },
    { id: 'unreadable-reset', kind: 'session', lengthSec: 18000, usedPercent: 5, resetAt: null, scope: null },
  ]);
  assert.equal(projected.message, 'still a usable answer', 'the verdict itself survives');
  assert.equal(validates({ schemaVersion: 2, takenAt: isoStamp(), harnesses: { h: projected } }), true);
});

test('the tier is projected like a code, and an unreadable one becomes null rather than free text', () => {
  // ADR-004 puts a second adapter-authored string on disk beside `message`. It is
  // shaped like a code — no spaces, no `@` — so it cannot become a second route
  // for harness output or for an account address, and a value outside that shape
  // is dropped rather than repaired. Losing a tier costs a line of output:
  // nothing scores it.
  const base = { ...entry(), tier: { name: 'example-plan', source: 'credentials' } };
  assert.deepEqual(snapshotEntry(base).tier, { name: 'example-plan', source: 'credentials' });
  assert.deepEqual(snapshotEntry({ ...base, tier: { name: 'included:1234', source: 'derived' } }).tier,
    { name: 'included:1234', source: 'derived' });

  for (const [why, tier] of [
    ['a source outside the closed list', { name: 'plus', source: 'guess' }],
    ['a name with a space', { name: 'Team Plan', source: 'user' }],
    ['an address', { name: 'someone@example.invalid', source: 'probe' }],
    ['no source at all', { name: 'plus' }],
    ['not an object', 'plus'],
  ]) {
    assert.equal(snapshotEntry({ ...base, tier }).tier, null, why);
  }
  assert.equal('tier' in snapshotEntry(entry()), false, 'a harness that names none carries no key');
  assert.equal(validates({ schemaVersion: 2, takenAt: isoStamp(), harnesses: { h: snapshotEntry(base) } }), true);
});

test('credits are carried as flags and a count, never as an amount', () => {
  // Informational (ADR-004): nothing scores them and nothing spends a reset.
  // The balance is deliberately not carried — what an account holds is a fact
  // about that account, and this file promises to hold no identity.
  const projected = snapshotEntry({
    ...entry(),
    credits: { available: false, unlimited: false, balance: '12345' },
    resetCredits: { available: 2, credits: [{ title: 'full reset' }] },
  });
  assert.deepEqual(projected.credits, { available: false, unlimited: false });
  assert.deepEqual(projected.resetCredits, { available: 2 });
  assert.equal(JSON.stringify(projected).includes('12345'), false, 'an amount reached the snapshot');
  for (const bad of [{ available: 'no', unlimited: false }, null, 'yes']) {
    assert.equal('credits' in snapshotEntry({ ...entry(), credits: bad }), false);
  }
  assert.equal('resetCredits' in snapshotEntry({ ...entry(), resetCredits: { available: -1 } }), false);
  assert.equal(validates({ schemaVersion: 2, takenAt: isoStamp(), harnesses: { h: projected } }), true);
});

test('a cache of an older schemaVersion is discarded, and the diagnosis says so', async () => {
  // ADR-004 decision D: discarded, never migrated. The shortest fact in this file
  // lives sixty seconds and the longest an hour, so a reader for the old shape
  // would buy one hour of not asking and be kept forever.
  //
  // Mutation probe: drop the version check in `readSnapshot` and the first
  // assertion below goes green on a document this build cannot read.
  const host = sandboxHost();
  mkdirSync(path.dirname(host.cacheFile), { recursive: true });
  writeFileSync(host.cacheFile, `${JSON.stringify({
    schemaVersion: 1,
    takenAt: isoStamp(),
    harnesses: { legacy: { ...entry(), windows: [{ id: '5h', usedPercent: 40 }] } },
  }, null, 2)}\n`, { mode: CACHE_MODE });

  assert.equal(readSnapshot(host), null, 'a document of another version is a cache that holds nothing');

  // A dry run asks nothing, so the discard is the whole answer — and it reads as
  // a discard rather than as "no cache entry", which is where a person would
  // otherwise go looking for a bug that is not there.
  const snapshot = await preflight({
    host, harnesses: ['legacy'], adapterFor: adapterMap({}), dryRun: true, budgetMs: 500,
  });
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.harnesses.legacy.reason, 'stale_cache');
  assert.match(snapshot.harnesses.legacy.message, /older version \(schemaVersion 1\)/);
  assert.equal(validates(snapshot), true);
});

test('a stamp that cannot be read is expired, never fresh', () => {
  // Both halves of the same rule. On the way in, an unreadable stamp becomes the
  // epoch rather than "now" — "now" would hold the entry live for a whole TTL on
  // a value nobody can date. On the way out, an entry the cache is already
  // holding with such a stamp is not live at any moment.
  const projected = snapshotEntry({ ...entry(), checkedAt: 'yesterday' });
  assert.equal(projected.checkedAt, NEVER_CHECKED);
  assert.equal(entryLive(projected, Date.now()), false);
  assert.equal(entryLive(entry({ checkedAt: 'yesterday' }), Date.now()), false);
  assert.equal(entryLive(entry({ checkedAt: NEVER_CHECKED }), Date.now()), false);
  // A resetAt nobody can read is unknown, not "now": the sticky kind, cleared by
  // hand, rather than an exhaustion that quietly expires a moment later.
  const spent = snapshotEntry({ ...entry({ state: 'exhausted', reason: 'subscription_exhausted' }), resetAt: 'soon' });
  assert.equal(spent.resetAt, null);
  assert.equal(entryLive(spent, Date.now() + 10 * AUTH_TTL_MS), true);
});

// --- the cache file ----------------------------------------------------------

test('the cache is 0600, is written whole, and carries nothing the adapter attached beside the contract', async () => {
  const host = sandboxHost();
  await preflight({
    host,
    harnesses: ['leaky', 'broken'],
    adapterFor: adapterMap({ leaky: availableStub(), broken: throwingStub() }),
    budgetMs: 500,
  });

  // The literal, not the constant: comparing the file to `CACHE_MODE` would pass
  // for any value both moved to at once, which is exactly what a mutation probe
  // does. The constant is pinned to the same literal on its own line.
  const mode = statSync(host.cacheFile).mode & 0o777;
  assert.equal(mode, 0o600, `cache mode is 0${mode.toString(8)}`);
  assert.equal(CACHE_MODE, 0o600);

  const text = readFileSync(host.cacheFile, 'utf8');
  // Both stubs handed the token over, and by two different routes: one attached it
  // to the verdict in undeclared fields, the other threw it inside an error.
  assert.equal(text.includes(FAKE_TOKEN), false, 'the fake token reached the cache file');
  assert.equal(text.includes('example.invalid'), false, 'an account address reached the cache file');
  assert.equal(text.includes('rawOutput'), false, 'raw harness output reached the cache file');
  assert.equal(validates(JSON.parse(text)), true);

  // tmp+rename leaves nothing behind: a stray temp neighbour is a half-written
  // snapshot the next reader would have to guess about.
  const strays = readdirSync(path.dirname(host.cacheFile)).filter((n) => n.startsWith('.tmp-'));
  assert.deepEqual(strays, []);
});

test('the projection is field-by-field: an undeclared field cannot reach the snapshot', () => {
  const projected = snapshotEntry({
    ...entry(),
    token: FAKE_TOKEN,
    models: [{ model: 'm', flags: ['no-zdr'], secret: FAKE_TOKEN }],
    windows: [{ id: '5h', kind: 'session', usedPercent: 10, lengthSec: 18000, secret: FAKE_TOKEN }],
    tier: { name: 'example-plan', source: 'credentials', token: FAKE_TOKEN },
  });
  assert.equal(JSON.stringify(projected).includes(FAKE_TOKEN), false);
  assert.deepEqual(Object.keys(projected.models[0]).sort(), ['flags', 'model', 'rated']);
  assert.deepEqual(Object.keys(projected.windows[0]).sort(), ['id', 'kind', 'lengthSec', 'scope', 'usedPercent']);
  assert.deepEqual(Object.keys(projected.tier).sort(), ['name', 'source']);
});

// --- two commands writing at once --------------------------------------------

test('a writer waits for a lock somebody else holds, and takes it back when that lock is litter', () => {
  // The write is already a temp-file-plus-rename, so nobody ever reads half a
  // document. What the rename cannot do is make the READ-merge-write one step: two
  // commands probing at once both read the same document and the second rename
  // wins, and the loser's entries are gone. The lock is what makes those three one
  // step, and this is the check that the writer respects one it did not take.
  //
  // Mutation probe: take `withCacheLock` out of `writeEntries` and the wait is 0 ms.
  const host = sandboxHost();
  const lock = `${host.cacheFile}${LOCK_SUFFIX}`;
  mkdirSync(path.dirname(host.cacheFile), { recursive: true });
  writeFileSync(lock, '');
  // Held by somebody alive: the writer waits it out rather than walking through it.
  const started = Date.now();
  writeEntries(host, { held: entry() });
  const waited = Date.now() - started;
  assert.ok(waited >= LOCK_WAIT_MS - 100, `the writer waited ${waited} ms for a lock it did not take`);
  // And it writes anyway: a cache that refused to write because a neighbour is slow
  // would lose the entries the lock exists to keep.
  assert.equal(readSnapshot(host).harnesses.held.state, 'available');
  // The lock it did not take is not removed by it either.
  assert.equal(existsSync(lock), true, 'a lock the writer never took must not be cleared by it');

  // A lock older than the ceiling is a process that died between its read and its
  // rename. Waiting the full ceiling for it on every command afterwards would be a
  // permanent tax for a crash that happened once.
  utimesSync(lock, new Date(Date.now() - LOCK_STALE_MS - 1000), new Date(Date.now() - LOCK_STALE_MS - 1000));
  const again = Date.now();
  writeEntries(host, { fresh: entry() });
  assert.ok(Date.now() - again < LOCK_WAIT_MS / 2, 'a stale lock was waited out instead of broken');
  assert.equal(readSnapshot(host).harnesses.fresh.state, 'available');
  assert.equal(existsSync(lock), false, 'the lock it broke and took is released again');
});

test('four preflights writing at once all land, each with its own harness', async () => {
  // The failure this closes: `spawn` and `models --refresh` in another terminal
  // both read the same document, both merge their own harness into it, and the
  // second rename wins. One process cannot reproduce it — the race is between
  // processes — so four are started and told to write at the same instant.
  //
  // Mutation probe: take `withCacheLock` out of `writeEntries` and at least one
  // harness is missing from the file. That probe is a race and not a certainty,
  // which is why four writers are used rather than two.
  const host = sandboxHost();
  const script = path.join(host.dir, 'writer.mjs');
  writeFileSync(script, `
import { preflight } from ${JSON.stringify(path.join(ROOT, 'lib', 'model-routing', 'preflight.js'))};
const [cacheFile, harness, startAt] = process.argv.slice(2);
const host = { routingPaths: () => ({ cacheFile, overlays: [] }) };
const probe = () => ({
  state: 'available', reason: null, message: 'concurrent stand-in',
  checkedAt: new Date().toISOString(), source: 'probe', resetAt: null,
});
// Slept off first and spun only at the very end: four processes spinning for a
// second would starve the machine the suite shares and measure that instead.
const left = Number(startAt) - Date.now() - 20;
if (left > 0) await new Promise((r) => { setTimeout(r, left); });
while (Date.now() < Number(startAt)) { /* line up on one instant */ }
await preflight({ host, harnesses: [harness], adapterFor: () => ({ probe }), budgetMs: 2000 });
`);
  const names = ['alpha', 'beta', 'gamma', 'delta'];
  // Far enough ahead that every child is up and spinning before any of them writes.
  const startAt = Date.now() + 1500;
  const runs = names.map((name) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, host.cacheFile, name, String(startAt)], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`))));
  }));
  await Promise.all(runs);

  const stored = readSnapshot(host);
  assert.deepEqual(Object.keys(stored.harnesses).sort(), names.slice().sort(),
    'a writer lost its entry to a neighbour that renamed second');
  assert.equal(validates(stored), true);
  assert.equal(existsSync(`${host.cacheFile}${LOCK_SUFFIX}`), false, 'the last writer left its lock behind');
});

// --- the TTLs ----------------------------------------------------------------

test('each TTL is the one the reference states', () => {
  assert.equal(AUTH_TTL_MS, 60 * 60 * 1000);
  assert.equal(WINDOW_TTL_MS, 60 * 1000);
  assert.equal(TRANSIENT_TTL_MS, 5 * 60 * 1000);

  const now = Date.parse('2026-09-05T12:00:00.000Z');
  const ago = (ms) => isoStamp(now - ms);

  // auth and model inventory — an hour
  const auth = entry({ checkedAt: ago(AUTH_TTL_MS - 1000) });
  assert.equal(entryLive(auth, now), true);
  assert.equal(entryLive(entry({ checkedAt: ago(AUTH_TTL_MS + 1000) }), now), false);

  // limit windows — a minute. An entry carrying any ages at that speed, even
  // though its auth half would have held for an hour: an entry is only as fresh
  // as the fastest fact inside it.
  const windowed = { windows: [{ id: '5h', usedPercent: 40 }] };
  assert.equal(entryLive(entry({ checkedAt: ago(WINDOW_TTL_MS - 1000), ...windowed }), now), true);
  assert.equal(entryLive(entry({ checkedAt: ago(WINDOW_TTL_MS + 1000), ...windowed }), now), false);
  assert.equal(entryLive(entry({ checkedAt: ago(WINDOW_TTL_MS + 1000) }), now), true,
    'without windows the same age is still inside the auth TTL');

  // a transient failure — five minutes
  for (const reason of ['probe_timeout', 'probe_failed']) {
    const fresh = entry({ state: 'unknown', reason, checkedAt: ago(TRANSIENT_TTL_MS - 1000) });
    const old = entry({ state: 'unknown', reason, checkedAt: ago(TRANSIENT_TTL_MS + 1000) });
    assert.equal(entryLive(fresh, now), true, reason);
    assert.equal(entryLive(old, now), false, reason);
  }

  // a confirmed exhaustion — until its reset, whatever its TTL would have been
  const resetting = entry({
    state: 'exhausted', reason: 'subscription_exhausted',
    checkedAt: ago(2 * AUTH_TTL_MS), resetAt: isoStamp(now + 60_000),
  });
  assert.equal(entryLive(resetting, now), true, 'held past every TTL while the reset is in the future');
  assert.equal(entryLive(resetting, now + 120_000), false, 'and expired once the reset has passed');

  // an exhaustion with no reset — until a person clears it
  const sticky = entry({
    state: 'exhausted', reason: 'manual_exhaustion', checkedAt: ago(2 * AUTH_TTL_MS), resetAt: null,
  });
  assert.equal(entryLive(sticky, now + 100 * 365 * 24 * 3600 * 1000), true);
});

test('a live entry is reused without a probe; an expired one is probed again', async () => {
  const host = sandboxHost();
  const count = counter();
  seed(host, { warm: entry({ message: 'from the cache' }), cold: entry({ checkedAt: isoStamp(Date.now() - AUTH_TTL_MS - 1000) }) });

  const snapshot = await preflight({
    host,
    harnesses: ['warm', 'cold'],
    adapterFor: adapterMap({ warm: availableStub(count), cold: availableStub(count) }),
    budgetMs: 500,
  });
  assert.equal(count.probes, 1, 'only the expired harness was asked');
  assert.equal(snapshot.harnesses.warm.source, 'cache');
  assert.equal(snapshot.harnesses.warm.message, 'from the cache');
  assert.equal(snapshot.harnesses.cold.source, 'probe');
});

// --- refresh and clear-exhausted ---------------------------------------------

test('--refresh probes past a live entry, and does not clear an exhaustion with no reset', async () => {
  const host = sandboxHost();
  const count = counter();
  seed(host, {
    warm: entry({ message: 'from the cache' }),
    sticky: entry({ state: 'exhausted', reason: 'manual_exhaustion', message: 'spent, no reset', resetAt: null }),
    resetting: entry({
      state: 'exhausted', reason: 'subscription_exhausted', message: 'spent until noon',
      resetAt: isoStamp(Date.now() + 3_600_000),
    }),
  });

  const snapshot = await preflight({
    host,
    harnesses: ['warm', 'sticky', 'resetting'],
    adapterFor: adapterMap({
      warm: availableStub(count),
      sticky: availableStub(count),
      resetting: availableStub(count),
    }),
    refresh: true,
    budgetMs: 500,
  });

  assert.equal(snapshot.harnesses.warm.source, 'probe', 'a live entry gives way to --refresh');
  assert.equal(snapshot.harnesses.resetting.source, 'probe', 'so does an exhaustion that names its reset');
  // The one exception: nothing but --clear-exhausted lifts a reset-less
  // exhaustion, so that harness is not even asked.
  assert.equal(snapshot.harnesses.sticky.state, 'exhausted');
  assert.equal(snapshot.harnesses.sticky.reason, 'manual_exhaustion');
  assert.equal(snapshot.harnesses.sticky.source, 'cache');
  assert.equal(count.probes, 2);
});

test('clearExhausted drops a reset-less exhaustion and nothing else, and the harness is probed next time', async () => {
  const host = sandboxHost();
  const count = counter();
  seed(host, {
    sticky: entry({ state: 'exhausted', reason: 'manual_exhaustion', resetAt: null }),
    resetting: entry({
      state: 'exhausted', reason: 'subscription_exhausted', resetAt: isoStamp(Date.now() + 3_600_000),
    }),
    fine: entry(),
  });

  assert.equal(clearExhausted(host, 'fine'), false, 'a harness that is not exhausted holds nothing to clear');
  assert.equal(clearExhausted(host, 'resetting'), false, 'an exhaustion that names its reset expires by itself');
  assert.equal(clearExhausted(host, 'nobody'), false, 'a harness the cache never heard of');
  assert.equal(clearExhausted(host, 'sticky'), true);
  assert.equal(readSnapshot(host).harnesses.sticky, undefined);
  assert.equal(readSnapshot(host).harnesses.resetting.state, 'exhausted', 'the neighbours are untouched');

  const snapshot = await preflight({
    host, harnesses: ['sticky'], adapterFor: adapterMap({ sticky: availableStub(count) }), budgetMs: 500,
  });
  assert.equal(count.probes, 1);
  assert.equal(snapshot.harnesses.sticky.state, 'available');
});

// --- the late-start hook -----------------------------------------------------

test('a limit hit at start marks the harness exhausted: with a reset by evidence, without one until it is cleared', async () => {
  const host = sandboxHost();
  const count = counter();
  const resetAt = isoStamp(Date.now() + 3_600_000);

  const known = markExhausted(host, 'metered', { resetAt });
  assert.equal(known.state, 'exhausted');
  assert.equal(known.reason, 'subscription_exhausted');
  assert.equal(known.resetAt, resetAt);
  assert.equal(known.source, 'probe', 'the harness itself said so — it was asked to start and answered');

  const blind = markExhausted(host, 'quiet', {});
  assert.equal(blind.reason, 'manual_exhaustion');
  assert.equal(blind.resetAt, null);

  // The evidence a caller has and this helper cannot see: a harness that said the
  // limit RESETS and named the time in a person's words ("resets at 3pm") is a
  // subscription limit with a reset nothing may parse. Derivation alone reads
  // `resetAt` and would call that a `manual_exhaustion`; the stated reason is what
  // keeps the one caller with that evidence — the Claude driver's late-start mark —
  // from opening a second door into the cache.
  //
  // Mutation probe: drop `reason` from `markExhausted` and this line goes red, and
  // so does the driver's own `subscription_exhausted` check next door.
  const said = markExhausted(host, 'worded', { reason: 'subscription_exhausted' });
  assert.equal(said.reason, 'subscription_exhausted');
  assert.equal(said.resetAt, null, 'a reason states the evidence; it invents no reset');
  assert.equal(stickyExhaustion(said), true, 'with no reset it is the sticky kind, whichever reason it carries');
  // A reason outside the two is not a third state: it falls back to the derivation
  // rather than writing a code the snapshot schema does not have.
  assert.equal(markExhausted(host, 'wrong', { reason: 'quota_unknown' }).reason, 'manual_exhaustion');

  assert.equal(validates(readSnapshot(host)), true);

  // Both are held past a probe; only the reset-less one is held past --refresh.
  const snapshot = await preflight({
    host,
    harnesses: ['metered', 'quiet'],
    adapterFor: adapterMap({ metered: availableStub(count), quiet: availableStub(count) }),
    refresh: true,
    budgetMs: 500,
  });
  assert.equal(snapshot.harnesses.quiet.state, 'exhausted');
  assert.equal(snapshot.harnesses.metered.state, 'available');
  assert.equal(count.probes, 1);

  assert.equal(clearExhausted(host, 'quiet'), true);
  assert.equal(readSnapshot(host).harnesses.quiet, undefined);
});

// --- dry run -----------------------------------------------------------------

test('a dry run without --refresh asks nothing and reports stale_cache on a cold cache', async () => {
  const host = sandboxHost();
  const count = counter();
  seed(host, { stale: entry({ checkedAt: isoStamp(Date.now() - AUTH_TTL_MS - 1000) }) });

  const snapshot = await preflight({
    host,
    harnesses: ['stale', 'absent'],
    adapterFor: adapterMap({ stale: availableStub(count), absent: availableStub(count) }),
    dryRun: true,
    budgetMs: 500,
  });

  assert.equal(count.probes, 0, 'a dry run without --refresh starts nothing');
  for (const harness of ['stale', 'absent']) {
    assert.equal(snapshot.harnesses[harness].state, 'unknown', harness);
    assert.equal(snapshot.harnesses[harness].reason, 'stale_cache', harness);
    assert.equal(snapshot.harnesses[harness].source, 'cache', harness);
  }
  // The age of what the cache held is reported, not replaced by "just now": a
  // decision prints it next to its snapshot-stale warning. A harness the cache
  // never held has no age at all and says so — the run stamp would have given it
  // the freshest reading on the page.
  assert.equal(snapshot.harnesses.absent.checkedAt, NEVER_CHECKED);
  assert.notEqual(snapshot.harnesses.stale.checkedAt, NEVER_CHECKED);
  assert.notEqual(snapshot.harnesses.stale.checkedAt, snapshot.harnesses.absent.checkedAt);
  assert.equal(validates(snapshot), true);
});

test('a dry run writes nothing — in either mode', async () => {
  const cold = sandboxHost();
  await preflight({
    host: cold,
    harnesses: ['a'],
    adapterFor: adapterMap({ a: availableStub() }),
    dryRun: true,
    refresh: true,
    budgetMs: 500,
  });
  assert.equal(readSnapshot(cold), null, '--refresh --dry-run probes and still writes nothing');
  assert.deepEqual(readdirSync(cold.dir), [], 'not even the directory is created');

  const warm = sandboxHost();
  seed(warm, { a: entry({ message: 'untouched' }) });
  const before = readFileSync(warm.cacheFile, 'utf8');
  await preflight({
    host: warm,
    harnesses: ['a', 'b'],
    adapterFor: adapterMap({ a: availableStub(), b: availableStub() }),
    dryRun: true,
    refresh: true,
    budgetMs: 500,
  });
  assert.equal(readFileSync(warm.cacheFile, 'utf8'), before, 'an existing cache is left byte for byte');

  markExhausted(warm, 'c', { dryRun: true });
  assert.equal(readFileSync(warm.cacheFile, 'utf8'), before, 'the late-start hook honours it too');
  clearExhausted(warm, 'a', { dryRun: true });
  assert.equal(readFileSync(warm.cacheFile, 'utf8'), before, 'and so does clearing an exhaustion');
});

// --- state transitions -------------------------------------------------------

test('one harness through every state: available, exhausted at start, cleared, available again', async () => {
  const host = sandboxHost();
  const count = counter();
  const states = [];
  const ask = async (stub, options = {}) => {
    const snapshot = await preflight({
      host, harnesses: ['one'], adapterFor: adapterMap({ one: stub }), budgetMs: 500, ...options,
    });
    states.push([snapshot.harnesses.one.state, snapshot.harnesses.one.reason]);
    return snapshot;
  };

  await ask(availableStub(count));
  markExhausted(host, 'one', {});
  await ask(availableStub(count), { refresh: true });
  clearExhausted(host, 'one');
  await ask(unauthenticatedStub(count), { refresh: true });
  await ask(throwingStub(count), { refresh: true });

  assert.deepEqual(states, [
    ['available', null],
    ['exhausted', 'manual_exhaustion'],
    ['unavailable', 'not_authenticated'],
    ['unknown', 'probe_failed'],
  ]);
  assert.equal(count.probes, 3, 'the exhausted round asked nothing');
  assert.equal(validates(readSnapshot(host)), true);
});

// --- the file the host names --------------------------------------------------

test('the cache lives where the host says and nowhere else', async () => {
  // A hard-coded path is the failure this check exists for: the cache is
  // account-scoped, the store home is per workspace, and a module that assembled
  // one from the other would re-probe every harness for every checkout.
  const host = sandboxHost();
  const elsewhere = path.join(host.dir, 'named', 'by', 'the', 'host.json');
  host.routingPaths = () => ({ cacheFile: elsewhere, overlays: [] });
  await preflight({
    host, harnesses: ['a'], adapterFor: adapterMap({ a: availableStub() }), budgetMs: 500,
  });
  assert.equal(validates(JSON.parse(readFileSync(elsewhere, 'utf8'))), true);
  assert.equal(statSync(elsewhere).mode & 0o777, 0o600);
});

test('a cache that cannot be read is the same as no cache', () => {
  // Not a crash and not an empty snapshot taken as fact: a half-written or
  // hand-edited file must send the next run back to the adapters.
  const host = sandboxHost();
  assert.equal(readSnapshot(host), null, 'no file at all');

  mkdirSync(path.dirname(host.cacheFile), { recursive: true });
  for (const junk of ['', 'not json at all', '[]', '{"schemaVersion":1}']) {
    writeFileSync(host.cacheFile, junk);
    assert.equal(readSnapshot(host), null, JSON.stringify(junk));
  }
});
