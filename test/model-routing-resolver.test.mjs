// The resolver and the renderer — PB-18. Run: npm test
//
// Two subjects and one contract. `resolve` turns the merged catalog, the
// availability snapshot and a strategy into a decision; `render` turns that
// decision into the text the terminal shows. Both are pinned by the golden pair
// in `fixtures/model-routing/`, and everything else here exists because a golden
// on one snapshot cannot show a rule that the snapshot does not exercise.
//
// The checks are of four kinds:
//
// 1. **The goldens are reproduced.** `decision.json` from `catalog.json` plus
//    `snapshot.json`, normalised exactly as the fixtures README says, and
//    `models.txt` byte-for-byte from that decision.
// 2. **Every rule of ADR-003 on its own inputs.** The nine filter steps, the four
//    weighted components, the three adjustments, the reviewer rules and each of
//    the four tie-break levels — the last three on synthetic catalogs, because a
//    tie has to be built to be tested.
// 3. **The numbers come from the policy, not from the file.** Each weight,
//    penalty, bonus and the reviewer floor is moved by an overlay and the pick
//    moves with it. A literal in the resolver goes red here.
// 4. **Determinism.** The same inputs in another order give the same document,
//    which is the property the whole tie-break exists for.
// Home diversion before any import that is not a Node built-in: a module that
// resolved a home path at load would see the real one. [home.mjs](home.mjs) says
// what it applies; the sentinel in tmpdir-sweep.test.mjs keeps the order.
import './home.mjs';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { CATALOG_FILE, mergeRouting } from '../lib/model-routing/catalog.js';
import { NEUTRAL_REMAINING_PERCENT, resolve } from '../lib/model-routing/resolver.js';
import { render, RUNTIME_ROWS_PER_HARNESS } from '../lib/model-routing/render.js';
import { availabilityOf, routingMetadata } from '../lib/models.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const SCHEMAS = path.join(ROOT, 'schemas', 'model-routing');
const FIXTURES = path.join(here, 'fixtures', 'model-routing');

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const fixture = (name) => readJson(path.join(FIXTURES, name));
const clone = (v) => JSON.parse(JSON.stringify(v));

const CATALOG = fixture('catalog.json');
const SNAPSHOT = fixture('snapshot.json');

// The `balance` pair: three harnesses with real windows, one model-scoped and
// two pools. Its own files rather than the golden pair, because the golden is
// one harness with a window and one with none — which cannot show a pace
// comparison at all. [The fixtures README](fixtures/model-routing/README.md)
// says what is in them and where the numbers come from.
const BALANCE_CATALOG = fixture('balance-catalog.json');
const BALANCE_SNAPSHOT = fixture('balance-snapshot.json');

// The clock the fixtures README freezes: twelve seconds after the snapshot was
// taken, which is where `ageSec: 12` comes from.
const NOW = Date.parse('2026-09-05T09:00:12.000Z');

// Stand-ins for the two paths the README normalises. They are not this machine's
// — the point of the normalisation is that the comparison holds on any machine,
// so the test drives it with paths no machine has.
const HOME = path.join(path.sep, 'home', 'someone');
const WORKSPACE = path.join(path.sep, 'repos', 'thing');

// `strict: false` for the reason the sibling routing files give: the schemas'
// own vocabulary is suspicious to ajv in strict mode, and the subject is the verdict.
const ajv = new Ajv2020({ strict: false, allErrors: true });
for (const name of readdirSync(SCHEMAS).filter((n) => n.endsWith('.schema.json'))) {
  ajv.addSchema(readJson(path.join(SCHEMAS, name)));
}
const ajvDecision = ajv.getSchema('urn:promptobus:model-routing:decision');

const validDecision = (decision, note = '') => assert.equal(ajvDecision(decision), true,
  `${note}${note ? ': ' : ''}${ajv.errorsText(ajvDecision.errors)}`);

/**
 * What `loadCatalog` answers, without the disk: the merged tuples and policy,
 * plus the layers the host named. `user` and `workspace` are overlay documents;
 * `null` is a layer whose file is not there, which is the normal case.
 */
function policyOf({ catalog = CATALOG, user = null, workspace = null, constraints = null, now = NOW } = {}) {
  const layers = [
    { id: 'user', path: path.join(HOME, '.promptobus', 'model-routing.json'), present: user !== null, data: user },
    { id: 'workspace', path: path.join(WORKSPACE, '.promptobus', 'model-routing.json'), present: workspace !== null, data: workspace },
  ];
  const merged = mergeRouting({ canonical: catalog, overlays: layers, constraints, now });
  return {
    ...merged,
    layers: [
      { id: 'catalog', path: CATALOG_FILE, present: true },
      ...layers.map(({ id, path: file, present }) => ({ id, path: file, present })),
    ],
  };
}

/** One decision, with the fixture inputs as defaults. */
function decide({
  role = 'worker', strategy = 'balanced', constraints = {}, snapshot = SNAPSHOT,
  liveParticipants = [], now = NOW, catalog = CATALOG, user = null, workspace = null,
} = {}) {
  return resolve({
    role,
    strategy,
    constraints,
    policy: policyOf({ catalog, user, workspace, constraints, now }),
    snapshot,
    liveParticipants,
    now,
  });
}

const byId = (decision, id) => decision.candidates.find((c) => c.tupleId === id);
const scoredIds = (decision) => decision.candidates.filter((c) => c.score).map((c) => c.tupleId);
const excludedOf = (decision, id) => byId(decision, id).excluded;

/** The overlay path and the workspace path, replaced longest prefix first — the README's rule. */
const normalise = (decision) => JSON.parse(JSON.stringify(decision)
  .split(WORKSPACE).join('<workspaceRoot>')
  .split(HOME).join('~'));

const overlay = (fields) => ({ schemaVersion: 2, ...fields });

// --- the goldens --------------------------------------------------------------

/**
 * The decision the golden files pin: what the resolver answers, plus the
 * availability block the COMMAND attaches (ADR-004).
 *
 * The resolver reads no disk and holds no snapshot beyond the one it was handed,
 * so the block is assembled a layer up — and it is assembled here by the same
 * exported function the command uses, not by a copy, because these two runs
 * reproduce one pair of files and a second description of the projection is
 * exactly how they would stop agreeing.
 */
const golden = (over = {}) => ({ ...decide(over), harnesses: availabilityOf(fixture('snapshot.json')) });

test('the golden decision is reproduced from the golden inputs', () => {
  const decision = golden();
  validDecision(decision, 'the decision the resolver produced');
  assert.deepEqual(normalise(decision), fixture('decision.json'));
});

test('the golden text is rendered from that decision, byte for byte', () => {
  const text = render(golden());
  assert.equal(text, readFileSync(path.join(FIXTURES, 'models.txt'), 'utf8'));
});

// --- the strategies -----------------------------------------------------------

test('each strategy picks what its weights predict, on one snapshot', () => {
  // The three worker candidates differ on every axis: example-quick is fast and
  // cheap, example-deep-high is the best and the slowest, other-steady is in
  // between and pays the unknown-availability penalty.
  const winners = Object.fromEntries(['quality', 'balanced', 'speed', 'economy']
    .map((strategy) => [strategy, decide({ strategy }).chosen.tupleId]));
  assert.deepEqual(winners, {
    quality: 'example-deep-high',
    balanced: 'example-quick',
    speed: 'example-quick',
    economy: 'example-quick',
  });

  // Not only the winner: the whole order turns over between the two ends of the
  // scale, which is what says the weights are actually multiplying something.
  assert.deepEqual(scoredIds(decide({ strategy: 'quality' })),
    ['example-deep-high', 'example-quick', 'other-steady']);
  assert.deepEqual(scoredIds(decide({ strategy: 'economy' })),
    ['example-quick', 'other-steady', 'example-deep-high']);
});

test('a component is its weight over 100 times the normalised rating, and quotaCost is inverted', () => {
  const quick = byId(decide(), 'example-quick').score;
  // ratings 6 / 10 / 3, weights 40 / 25 / 20 / 15, remaining 100 − 40 = 60.
  assert.deepEqual(quick.components, { quality: 22.22, speed: 25, quotaCost: 15.56, remaining: 9 });
  assert.equal(quick.base, 71.78);
  assert.equal(quick.total, 71.78);
  // The inversion is the half a mutation would flip: quotaCost 2 is CHEAP, so it
  // contributes 15.56 of its 20 points. Read as a plain rating it would contribute less.
  const deep = byId(decide(), 'example-deep-high').score;
  assert.equal(deep.components.quotaCost, 0, 'quotaCost 10 is the dearest and contributes nothing');
  assert.ok(quick.components.quotaCost > deep.components.quotaCost,
    'the cheaper tuple must score higher on quotaCost than the dearer one');
});

// --- determinism --------------------------------------------------------------

test('input order does not reach the result', () => {
  const shuffled = { ...clone(CATALOG), tuples: [...clone(CATALOG).tuples].reverse() };
  const snapshot = clone(SNAPSHOT);
  const flipped = {
    ...snapshot,
    harnesses: Object.fromEntries(Object.entries(snapshot.harnesses).reverse()),
  };
  assert.deepEqual(decide({ catalog: shuffled, snapshot: flipped }), decide());
});

// --- explicit constraints ------------------------------------------------------

test('an explicit harness narrows and is never replaced', () => {
  const decision = decide({ constraints: { harness: 'other' } });
  // example-quick scores higher and is still not chosen: a named value is a
  // constraint, not a wish.
  assert.equal(decision.chosen.tupleId, 'other-steady');
  assert.equal(excludedOf(decision, 'example-quick').code, 'constraint-mismatch');
  assert.match(excludedOf(decision, 'example-quick').detail, /--harness "other"/);
  assert.equal(decision.constraints.harness, 'other');
  assert.equal(decision.constraints.applied, true);
});

test('an explicit effort narrows to the tuple that carries it', () => {
  const decision = decide({ constraints: { effort: 'high' } });
  assert.equal(decision.chosen.tupleId, 'example-deep-high');
  assert.equal(excludedOf(decision, 'example-quick').code, 'constraint-mismatch');
});

test('a constraint that leaves no candidate ends with no chosen tuple, and the reasons say why', () => {
  const decision = decide({ constraints: { model: 'nothing-like-this' } });
  validDecision(decision, 'the empty-candidate decision');
  assert.equal(decision.chosen, null);
  assert.equal(scoredIds(decision).length, 0);
  for (const c of decision.candidates) assert.equal(c.excluded.code, 'constraint-mismatch', c.tupleId);
  assert.equal(decision.constraints.applied, true);
  // The document is still complete: the runtime rows and the layers are there for
  // the diagnostics PB-21 prints before it refuses.
  assert.equal(decision.runtime.length, 1);
  assert.equal(decision.overlays.length, 2);
});

test('constraints.applied is false when nothing was narrowed', () => {
  assert.equal(decide().constraints.applied, false);
  assert.deepEqual(decide().constraints,
    { harness: null, model: null, effort: null, allowPayg: false, applied: false });
});

// --- pay-as-you-go -------------------------------------------------------------

test('PAYG is dropped by default and admitted by the flag', () => {
  assert.equal(excludedOf(decide(), 'other-metered').code, 'payg-not-allowed');
  const opted = decide({ constraints: { allowPayg: true } });
  // ratings 5 / 4 / 1 on a harness whose remaining is unknown: 40 + 18.75 + 20 + 7.5 − 10.
  assert.equal(byId(opted, 'other-metered').score.total, 76.94);
  assert.equal(opted.chosen.tupleId, 'other-metered');
  assert.equal(opted.constraints.allowPayg, true);
});

test('an overlay that opts pay-as-you-go in is enough on its own', () => {
  const opted = decide({ workspace: overlay({ payg: { allow: true } }) });
  assert.equal(opted.chosen.tupleId, 'other-metered');
  // The flag was not passed, and the echoed constraint says so: the field is what
  // the caller pinned by hand, not what the merged policy decided.
  assert.equal(opted.constraints.allowPayg, false);
  assert.deepEqual(opted.overlays.map((o) => o.applied), [false, true]);
});

// --- the inventory, and models the catalog does not rate ------------------------

test('a model the catalog does not rate is a runtime row and never a candidate', () => {
  const decision = decide();
  assert.deepEqual(decision.runtime, [{ harness: 'example', model: 'example-runtime-only', flags: ['no-zdr'] }]);
  assert.equal(decision.candidates.some((c) => c.model === 'example-runtime-only'), false);
});

test('a rated tuple the account does not expose is excluded, and its harness keeps the rest', () => {
  const snapshot = clone(SNAPSHOT);
  snapshot.harnesses.example.models = snapshot.harnesses.example.models
    .filter((m) => m.model !== 'example-quick');
  const decision = decide({ snapshot });
  assert.equal(excludedOf(decision, 'example-quick').code, 'model-not-in-inventory');
  assert.match(excludedOf(decision, 'example-quick').detail, /example account does not expose/);
  // The harness itself is untouched — that is the whole reason the state is not
  // set to `unavailable` for a missing model.
  assert.ok(byId(decision, 'example-deep-high').score);
  assert.equal(decision.chosen.tupleId, 'other-steady');
});

test('a harness with no inventory at all excludes nothing — silence is not absence', () => {
  const snapshot = clone(SNAPSHOT);
  delete snapshot.harnesses.example.models;
  const decision = decide({ snapshot });
  assert.equal(byId(decision, 'example-quick').excluded, null);
  assert.equal(decision.runtime.length, 0);
});

// --- availability --------------------------------------------------------------

test('unavailable and exhausted harnesses take their tuples with them', () => {
  const snapshot = clone(SNAPSHOT);
  snapshot.harnesses.example = {
    ...snapshot.harnesses.example, state: 'unavailable', reason: 'not_authenticated', models: undefined,
  };
  delete snapshot.harnesses.example.models;
  snapshot.harnesses.other = {
    ...snapshot.harnesses.other,
    state: 'exhausted',
    reason: 'subscription_exhausted',
    resetAt: '2026-09-05T13:00:00.000Z',
  };
  const decision = decide({ snapshot });
  assert.equal(decision.chosen, null);
  assert.equal(excludedOf(decision, 'example-quick').code, 'harness-unavailable');
  assert.equal(excludedOf(decision, 'other-steady').code, 'harness-exhausted');
  assert.match(excludedOf(decision, 'other-steady').detail, /resets at 2026-09-05T13:00:00\.000Z/);
});

test('unknown availability is penalised, never blocking, and it says so once per harness', () => {
  const decision = decide();
  const steady = byId(decision, 'other-steady');
  assert.equal(steady.availability.state, 'unknown');
  assert.deepEqual(steady.score.adjustments, [{ code: 'unknown-availability', points: -10 }]);
  assert.equal(steady.score.components.remaining, (NEUTRAL_REMAINING_PERCENT * 15) / 100);
  // Once per harness, and once only. The golden inputs also raise a `near-limit`
  // line about the OTHER harness, which is a different subject — so the count of
  // this code is what the test is about, not the length of the list.
  assert.deepEqual(decision.warnings.filter((w) => w.code === 'unknown-remaining').map((w) => w.code),
    ['unknown-remaining']);
});

test('remaining is what the most spent window leaves, not the roomiest one', () => {
  // Two windows on one harness: a five-hour one barely touched and a weekly one
  // nearly gone. The run is stopped by the second, so it is the second that the
  // score has to read.
  const snapshot = clone(SNAPSHOT);
  snapshot.harnesses.example.windows = [
    { id: '5h', usedPercent: 10, lengthSec: 18000, resetAt: null },
    { id: 'week', usedPercent: 70, lengthSec: 604800, resetAt: null },
  ];
  const quick = byId(decide({ snapshot }), 'example-quick').score;
  assert.equal(quick.components.remaining, 4.5, '100 − 70 of the weekly window, at a weight of 15');
  assert.equal(quick.total, 67.28);
});

test('an available harness with no limit window is unknown remaining too', () => {
  const snapshot = clone(SNAPSHOT);
  delete snapshot.harnesses.example.windows;
  const decision = decide({ snapshot });
  const quick = byId(decision, 'example-quick');
  assert.equal(quick.availability.state, 'available', 'the harness is still available — only its remaining is not');
  assert.deepEqual(quick.score.adjustments, [{ code: 'unknown-availability', points: -10 }]);
  assert.equal(quick.score.components.remaining, 7.5);
  assert.deepEqual(decision.warnings.map((w) => w.code).sort(), ['unknown-remaining', 'unknown-remaining']);
});

test('a stale entry and a timed-out probe each say so in the warnings', () => {
  // `near-limit` is filtered out of both: the golden inputs raise one, and this
  // test is about the two codes a harness entry's own `reason` produces.
  const codes = (d) => d.warnings.map((w) => w.code).filter((c) => c !== 'near-limit');
  const stale = clone(SNAPSHOT);
  stale.harnesses.other.reason = 'stale_cache';
  assert.deepEqual(codes(decide({ snapshot: stale })), ['unknown-remaining', 'snapshot-stale']);
  const timedOut = clone(SNAPSHOT);
  timedOut.harnesses.other.reason = 'probe_timeout';
  assert.deepEqual(codes(decide({ snapshot: timedOut })), ['unknown-remaining', 'probe-incomplete']);
});

test('the snapshot block carries the age from the clock and the source from the entries', () => {
  assert.deepEqual(decide().snapshot,
    { takenAt: '2026-09-05T09:00:00.000Z', ageSec: 12, source: 'cache' });
  const mixed = clone(SNAPSHOT);
  mixed.harnesses.other.source = 'probe';
  assert.equal(decide({ snapshot: mixed }).snapshot.source, 'mixed');
  assert.equal(decide({ now: NOW + 3_000 }).snapshot.ageSec, 15);
});

// --- live participants ----------------------------------------------------------

test('a live participant costs its harness points, and the cost is capped', () => {
  const one = decide({ liveParticipants: [{ harness: 'example', model: 'example-deep', role: 'worker' }] });
  assert.deepEqual(byId(one, 'example-quick').score.adjustments, [{ code: 'live-participant', points: -5 }]);
  assert.equal(byId(one, 'example-quick').score.total, 66.78);
  // The other harness pays nothing for a participant that is not on it.
  assert.deepEqual(byId(one, 'other-steady').score.adjustments, [{ code: 'unknown-availability', points: -10 }]);

  const crowd = Array.from({ length: 5 }, () => ({ harness: 'example', model: 'example-deep', role: 'worker' }));
  const many = decide({ liveParticipants: crowd });
  assert.deepEqual(byId(many, 'example-quick').score.adjustments, [{ code: 'live-participant', points: -20 }],
    'five participants at 5 points each are capped at 20, not 25');
});

test('the per-participant cost and the cap both come from the policy', () => {
  const crowd = Array.from({ length: 5 }, () => ({ harness: 'example', model: 'example-deep', role: 'worker' }));
  const raised = decide({
    liveParticipants: crowd,
    workspace: overlay({ penalties: { liveParticipantPerHarness: 5, liveParticipantCap: 30 } }),
  });
  assert.deepEqual(byId(raised, 'example-quick').score.adjustments, [{ code: 'live-participant', points: -25 }]);
  const doubled = decide({
    liveParticipants: [{ harness: 'example', model: 'example-deep', role: 'worker' }],
    workspace: overlay({ penalties: { liveParticipantPerHarness: 9 } }),
  });
  assert.deepEqual(byId(doubled, 'example-quick').score.adjustments, [{ code: 'live-participant', points: -9 }]);
});

// --- the reviewer rules ----------------------------------------------------------

test('a reviewer is routed from the tuples rated for it', () => {
  const decision = decide({ role: 'reviewer' });
  validDecision(decision, 'the reviewer decision');
  assert.equal(excludedOf(decision, 'example-quick').code, 'role-not-allowed');
  assert.equal(excludedOf(decision, 'example-quick').detail, 'rated for worker only');
  assert.deepEqual(scoredIds(decision), ['other-steady', 'example-deep-high', 'example-deep-max']);
  // The pick is not the top scorer, and the reviewer floor of 5 (ADR-004,
  // raised from ADR-003's 4) is why: `other-steady` rates 4 and keeps its place
  // at the head of the list with its score — the floor is a choice rule.
  assert.equal(decision.chosen.tupleId, 'example-deep-high');
  assert.equal(byId(decision, 'other-steady').excluded, null, 'the floor is a choice rule, not a filter');
  assert.equal(decision.warnings.some((w) => w.code === 'reviewer-floor-not-met'), false);
});

test('a reviewer that differs from the live worker gains the diversity bonus', () => {
  const decision = decide({
    role: 'reviewer',
    liveParticipants: [{ harness: 'example', model: 'example-deep', role: 'worker' }],
  });
  // Same harness AND same model as the worker: no bonus, and the live-participant
  // penalty on top.
  assert.deepEqual(byId(decision, 'example-deep-high').score.adjustments,
    [{ code: 'live-participant', points: -5 }]);
  assert.deepEqual(byId(decision, 'other-steady').score.adjustments,
    [{ code: 'unknown-availability', points: -10 }, { code: 'reviewer-diversity', points: 5 }]);
  // The bonus puts other-steady at the head of the list; the floor of 5 still
  // moves the pick past it, which is the two rules composing as ADR-004 says.
  assert.equal(scoredIds(decision)[0], 'other-steady');
  assert.equal(decision.chosen.tupleId, 'example-deep-high');
});

test('a different model on the same harness is diverse enough', () => {
  const decision = decide({
    role: 'reviewer',
    liveParticipants: [{ harness: 'example', model: 'example-quick', role: 'worker' }],
  });
  assert.deepEqual(byId(decision, 'example-deep-high').score.adjustments,
    [{ code: 'live-participant', points: -5 }, { code: 'reviewer-diversity', points: 5 }]);
});

test('with no live worker there is nothing to differ from, and no bonus', () => {
  const decision = decide({ role: 'reviewer', liveParticipants: [{ harness: 'other', model: 'other-steady' }] });
  assert.equal(decision.candidates.some((c) => c.score?.adjustments.some((a) => a.code === 'reviewer-diversity')),
    false);
});

test('the bonus comes from the policy', () => {
  const decision = decide({
    role: 'reviewer',
    liveParticipants: [{ harness: 'example', model: 'example-deep', role: 'worker' }],
    workspace: overlay({ bonuses: { reviewerDiversity: 12 } }),
  });
  assert.deepEqual(byId(decision, 'other-steady').score.adjustments.at(-1),
    { code: 'reviewer-diversity', points: 12 });
});

test('the quality floor moves the pick without excluding anyone', () => {
  // other-steady is made the top scorer and put below the floor at the same time:
  // it stays in the list, first and scored, and the pick goes past it.
  const decision = decide({
    role: 'reviewer',
    workspace: overlay({
      qualityFloor: { reviewer: 9 },
      ratings: { 'other-steady': { quality: 8, speed: 10, quotaCost: 1 } },
    }),
  });
  assert.equal(scoredIds(decision)[0], 'other-steady');
  assert.equal(byId(decision, 'other-steady').score.total, 73.61);
  assert.equal(byId(decision, 'other-steady').excluded, null, 'the floor is a choice rule, not a filter');
  assert.equal(decision.chosen.tupleId, 'example-deep-high');
  assert.equal(byId(decision, 'other-steady').chosen, false);
  assert.equal(decision.warnings.some((w) => w.code === 'reviewer-floor-not-met'), false);
});

test('nothing reaching the floor is a warning and the best remaining one, not a refusal', () => {
  const decision = decide({
    role: 'reviewer',
    workspace: overlay({
      ratings: {
        'other-steady': { quality: 8 }, 'example-deep-high': { quality: 8 }, 'example-deep-max': { quality: 6 },
      },
    }),
  });
  assert.equal(decision.chosen.tupleId, scoredIds(decision)[0], 'the soft fallback takes the top of the list');
  const warning = decision.warnings.find((w) => w.code === 'reviewer-floor-not-met');
  assert.ok(warning, 'the fallback must say it happened');
  assert.match(warning.message, /quality floor of 9 of 10/);
});

test('the worker has a floor too, and its own warning code', () => {
  // ADR-005 gives the worker a floor of 5 —
  // "a worker on a cheap model where the task needed the expensive one is paid
  // for in review rounds" describes one. Same shape as the reviewer's: a choice
  // rule, and a soft fallback with a warning of its own.
  const catalog = catalogOf([
    { id: 'alpha-cheap', harness: 'alpha', model: 'cheap', ratings: { quality: 4, speed: 10, quotaCost: 1 }, priority: 10 },
    { id: 'alpha-sound', harness: 'alpha', model: 'sound', ratings: { quality: 5, speed: 3, quotaCost: 8 }, priority: 20 },
  ]);
  const moved = decide({ catalog, snapshot: TIE_SNAPSHOT });
  assert.equal(scoredIds(moved)[0], 'alpha-cheap', 'it is still the top scorer');
  assert.equal(moved.chosen.tupleId, 'alpha-sound', 'the worker floor of 5 moved the pick');
  assert.equal(byId(moved, 'alpha-cheap').excluded, null, 'a choice rule, not a filter');
  assert.equal(moved.warnings.some((w) => w.code === 'worker-floor-not-met'), false);

  const floorless = catalogOf([
    { id: 'alpha-cheap', harness: 'alpha', model: 'cheap', ratings: { quality: 4, speed: 10, quotaCost: 1 }, priority: 10 },
    { id: 'alpha-cheaper', harness: 'alpha', model: 'cheaper', ratings: { quality: 1, speed: 3, quotaCost: 8 }, priority: 20 },
  ]);
  const fallback = decide({ catalog: floorless, snapshot: TIE_SNAPSHOT });
  assert.equal(fallback.chosen.tupleId, 'alpha-cheap');
  const warning = fallback.warnings.find((w) => w.code === 'worker-floor-not-met');
  assert.ok(warning, fallback.warnings.map((w) => w.code).join(' | '));
  assert.match(warning.message, /quality floor of 5 of 10/);
  validDecision(fallback, 'a decision carrying the worker floor fallback');
});

test('reviewerQualityFloor is still read, as an alias for qualityFloor.reviewer', () => {
  // An overlay written for v1 keeps its meaning (ADR-004).
  const aliased = decide({ role: 'reviewer', workspace: overlay({ reviewerQualityFloor: 8 }) });
  assert.equal(aliased.chosen.tupleId, 'other-steady', 'a floor of 8 admits the quality-8 top scorer');

  // Stated both ways in one layer, the explicit key wins and validate warns.
  const both = decide({
    role: 'reviewer',
    workspace: overlay({ reviewerQualityFloor: 8, qualityFloor: { reviewer: 9 } }),
  });
  assert.equal(both.chosen.tupleId, 'example-deep-high', 'the explicit qualityFloor.reviewer wins');
});

test('a role rating override is what the role being routed is scored on', () => {
  // The shipped catalog uses this (`claude-opus-max` rates its quotaCost one
  // point lower for a reviewer), and the golden fixture has no row that carries
  // one — so without these two checks the override could be dropped and every
  // other check would stay green.
  const catalog = catalogOf([
    { id: 'alpha-generalist', harness: 'alpha', model: 'generalist', ratings: { quality: 4, speed: 5, quotaCost: 3 }, priority: 10 },
    {
      id: 'alpha-reviewly',
      harness: 'alpha',
      model: 'reviewly',
      ratings: { quality: 4, speed: 2, quotaCost: 3 },
      roleRatings: { reviewer: { speed: 5, quotaCost: 1 } },
      priority: 20,
    },
  ]);
  // As a worker the override is not read at all: the slow, dear tuple loses.
  const worker = decide({ catalog, snapshot: TIE_SNAPSHOT });
  assert.equal(worker.chosen.tupleId, 'alpha-generalist');
  assert.equal(byId(worker, 'alpha-reviewly').score.total, 46.67);
  // As a reviewer the same tuple is a different set of ratings, and it wins.
  const reviewer = decide({ catalog, snapshot: TIE_SNAPSHOT, role: 'reviewer' });
  assert.equal(reviewer.chosen.tupleId, 'alpha-reviewly');
  assert.equal(byId(reviewer, 'alpha-reviewly').score.total, 59.44);
  assert.equal(byId(reviewer, 'alpha-generalist').score.total, 55, 'the tuple with no override is scored the same in both roles');
});

test('a role rating override is what the reviewer floor reads too', () => {
  // Under `speed` the quality weight is small, so the tuple can be the top
  // scorer and still be below the floor — which is the only arrangement that
  // tells "the floor read the override" from "the score did".
  const catalog = catalogOf([
    {
      id: 'alpha-fast',
      harness: 'alpha',
      model: 'fast',
      ratings: { quality: 5, speed: 5, quotaCost: 3 },
      roleRatings: { reviewer: { quality: 3 } },
      priority: 10,
    },
    { id: 'alpha-solid', harness: 'alpha', model: 'solid', ratings: { quality: 4, speed: 3, quotaCost: 3 }, priority: 20 },
  ]);
  const worker = decide({ catalog, snapshot: TIE_SNAPSHOT, strategy: 'speed' });
  assert.equal(worker.chosen.tupleId, 'alpha-fast',
    'no override for a worker: it is scored at quality 5 and clears the worker floor of 3');

  // The reviewer floor is pinned at 4 here rather than left at ADR-004's 5,
  // because the arrangement needs exactly one of the two tuples above it —
  // with nothing above the floor the soft fallback fires and the check would
  // pass for the wrong reason.
  const reviewer = decide({
    catalog, snapshot: TIE_SNAPSHOT, strategy: 'speed', role: 'reviewer',
    workspace: overlay({ qualityFloor: { reviewer: 4 } }),
  });
  assert.equal(scoredIds(reviewer)[0], 'alpha-fast', 'it is still the top scorer');
  assert.equal(byId(reviewer, 'alpha-fast').score.total, 50);
  assert.equal(reviewer.chosen.tupleId, 'alpha-solid', 'the reviewer quality of 3 is below the floor');
  assert.equal(reviewer.warnings.some((w) => w.code === 'reviewer-floor-not-met'), false,
    'alpha-solid reaches the floor, so this is not the fallback');
});

test('the floor itself is a policy value', () => {
  // Lowered to 8, other-steady's quality of 8 clears it and the pick is the top
  // scorer again; raised back, the pick moves to the first tuple that does.
  const lowered = decide({ role: 'reviewer', workspace: overlay({ qualityFloor: { reviewer: 8 } }) });
  assert.equal(lowered.chosen.tupleId, 'other-steady');

  const decision = decide({ role: 'reviewer', workspace: overlay({ qualityFloor: { reviewer: 9 } }) });
  assert.equal(decision.chosen.tupleId, 'example-deep-high');
  assert.equal(scoredIds(decision)[0], 'other-steady', 'the order is untouched — only the pick moved');
});

// --- the weights are the policy's ------------------------------------------------

test('an overlay weight set changes the pick and is what the decision publishes', () => {
  const decision = decide({
    workspace: overlay({ weights: { balanced: { quality: 100, speed: 0, quotaCost: 0, remaining: 0 } } }),
  });
  assert.deepEqual(decision.weights, { quality: 100, speed: 0, quotaCost: 0, remaining: 0 });
  assert.equal(decision.chosen.tupleId, 'example-deep-high');
  assert.equal(byId(decision, 'example-deep-high').score.base, 100);
});

test('the unknown-availability penalty is a policy number', () => {
  const decision = decide({ workspace: overlay({ penalties: { unknownAvailability: 0 } }) });
  const steady = byId(decision, 'other-steady');
  assert.deepEqual(steady.score.adjustments, [{ code: 'unknown-availability', points: 0 }]);
  assert.equal(steady.score.total, 66.94);
  assert.match(decision.warnings[0].message, /penalised 0 points/);
});

test('a warning from the merge is copied with its two fields and nothing else', () => {
  // `warnings` in the decision schema is closed on `code` and `message`, while
  // the merge's own warning also carries the tuple id, the age in days and the
  // threshold. Carrying those through would produce a document ajv rejects.
  const ninetyOneDays = NOW + 91 * 24 * 60 * 60 * 1000;
  const decision = decide({ now: ninetyOneDays });
  validDecision(decision, 'the decision with stale ratings');
  const stale = decision.warnings.filter((w) => w.code === 'stale-rating');
  assert.equal(stale.length, CATALOG.tuples.length, 'every tuple of the fixture is assessed on the same day');
  for (const w of decision.warnings) assert.deepEqual(Object.keys(w), ['code', 'message'], w.code);
  assert.match(stale[0].message, /was assessed 91 days ago/);
});

// --- the tie-break, one level at a time -------------------------------------------

/** A catalog of exactly the tuples a tie-break check needs. */
const catalogOf = (tuples) => ({
  schemaVersion: 2,
  updated: '2026-09-05T00:00:00.000Z',
  tuples: tuples.map((t) => ({
    roles: ['worker', 'reviewer'],
    prices: { inputPerMTok: null, cachedInputPerMTok: null, outputPerMTok: null },
    billing: 'subscription',
    assessedAt: '2026-09-05T00:00:00.000Z',
    source: 'suite fixture — placeholder names, not a rating of any real model',
    effort: null,
    ...t,
  })),
});

/** Two harnesses: one confirmed with a full allowance, one that cannot say. */
const TIE_SNAPSHOT = {
  schemaVersion: 1,
  takenAt: '2026-09-05T09:00:00.000Z',
  harnesses: {
    alpha: {
      state: 'available',
      reason: null,
      message: 'authenticated',
      checkedAt: '2026-09-05T09:00:00.000Z',
      source: 'cache',
      resetAt: null,
      windows: [{ id: '5h', kind: 'session', usedPercent: 0, lengthSec: 18000, resetAt: null, scope: null }],
    },
    beta: {
      state: 'unknown',
      reason: 'quota_unknown',
      message: 'no limit source',
      checkedAt: '2026-09-05T09:00:00.000Z',
      source: 'cache',
      resetAt: null,
    },
  },
};

test('tie-break 1: the higher effective score wins, adjustments included', () => {
  // Same ratings on both harnesses: the only difference is the unknown penalty
  // and the neutral remaining, and that is enough to order them.
  const catalog = catalogOf([
    { id: 'beta-one', harness: 'beta', model: 'beta-one', ratings: { quality: 3, speed: 3, quotaCost: 3 }, priority: 10 },
    { id: 'alpha-one', harness: 'alpha', model: 'alpha-one', ratings: { quality: 3, speed: 3, quotaCost: 3 }, priority: 20 },
  ]);
  const decision = decide({ catalog, snapshot: TIE_SNAPSHOT });
  assert.deepEqual(scoredIds(decision), ['alpha-one', 'beta-one']);
  assert.equal(decision.chosen.tupleId, 'alpha-one');
});

test('tie-break 2: at an equal score, confirmed availability wins', () => {
  // Built to tie exactly at 15.00: alpha keeps its full allowance, beta pays the
  // unknown penalty and makes it up on speed and quotaCost.
  const catalog = catalogOf([
    { id: 'beta-two', harness: 'beta', model: 'beta-two', ratings: { quality: 1, speed: 3, quotaCost: 4 }, priority: 10 },
    { id: 'alpha-two', harness: 'alpha', model: 'alpha-two', ratings: { quality: 1, speed: 1, quotaCost: 5 }, priority: 20 },
  ]);
  const decision = decide({
    catalog, snapshot: TIE_SNAPSHOT,
    workspace: overlay({ penalties: { unknownAvailability: 0.28 } }),
  });
  assert.equal(byId(decision, 'alpha-two').score.total, byId(decision, 'beta-two').score.total,
    'the check is only meaningful while the two totals are equal');
  // beta-two has the lower canonical priority and the earlier id, so it would win
  // every later level. Confirmed availability is what puts alpha-two first.
  assert.equal(decision.chosen.tupleId, 'alpha-two');
});

test('tie-break 3: at an equal score and state, the lower canonical priority wins', () => {
  const catalog = catalogOf([
    { id: 'alpha-late', harness: 'alpha', model: 'alpha-late', ratings: { quality: 3, speed: 3, quotaCost: 3 }, priority: 90 },
    { id: 'zeta-early', harness: 'alpha', model: 'zeta-early', ratings: { quality: 3, speed: 3, quotaCost: 3 }, priority: 10 },
  ]);
  const decision = decide({ catalog, snapshot: TIE_SNAPSHOT });
  // The id order would put alpha-late first; priority is read before the id.
  assert.equal(decision.chosen.tupleId, 'zeta-early');
  assert.deepEqual(scoredIds(decision), ['zeta-early', 'alpha-late']);
});

test('tie-break 4: the tuple id is the last word, so the pick is total', () => {
  const catalog = catalogOf([
    { id: 'alpha-second', harness: 'alpha', model: 'm-two', ratings: { quality: 3, speed: 3, quotaCost: 3 }, priority: 10 },
    { id: 'alpha-first', harness: 'alpha', model: 'm-one', ratings: { quality: 3, speed: 3, quotaCost: 3 }, priority: 10 },
  ]);
  const decision = decide({ catalog, snapshot: TIE_SNAPSHOT });
  assert.equal(decision.chosen.tupleId, 'alpha-first');
  const reversed = decide({
    catalog: { ...catalog, tuples: [...catalog.tuples].reverse() }, snapshot: TIE_SNAPSHOT,
  });
  assert.deepEqual(scoredIds(reversed), scoredIds(decision), 'a total tie-break cannot depend on input order');
});

// --- allow and deny ---------------------------------------------------------------

test('a deny rule excludes and names the layer and the rule that wrote it', () => {
  const decision = decide({ workspace: overlay({ deny: { models: ['example-quick'] } }) });
  assert.deepEqual(excludedOf(decision, 'example-quick'), {
    code: 'denied-by-policy',
    detail: 'denied by deny.models of overlay "workspace" — a ban is lifted only in the layer that wrote it',
  });
  assert.equal(decision.chosen.tupleId, 'other-steady');
});

test('a ban two layers wrote names both of them — neither file alone lifts it', () => {
  const decision = decide({
    user: overlay({ deny: { models: ['example-quick'] } }),
    workspace: overlay({ deny: { models: ['example-quick', 'other-metered'] } }),
  });
  assert.match(excludedOf(decision, 'example-quick').detail,
    /deny\.models of overlay "user", deny\.models of overlay "workspace"/,
    'a diagnostic naming one of two files sends the reader to do half the edit');
  // And the ban only one of them wrote names only that one.
  assert.match(excludedOf(decision, 'other-metered').detail, /^denied by deny\.models of overlay "workspace"/);
});

test('an allow list that intersected to nothing admits no tuple', () => {
  // Two layers narrowing different ways. `validate` calls this
  // `allow-intersection-empty`; the resolver's job is only to be honest about
  // it — an empty allow list is not an absent one.
  const decision = decide({
    user: overlay({ allow: { harnesses: ['example'] } }),
    workspace: overlay({ allow: { harnesses: ['other'] } }),
  });
  assert.equal(decision.chosen, null);
  for (const c of decision.candidates) assert.equal(c.excluded.code, 'denied-by-policy', c.tupleId);
});

test('an allow rule keeps only what it names', () => {
  const decision = decide({ user: overlay({ allow: { harnesses: ['other'] } }) });
  assert.deepEqual(excludedOf(decision, 'example-quick'),
    { code: 'denied-by-policy', detail: 'not named by allow.harnesses of overlay "user"' });
  assert.equal(decision.chosen.tupleId, 'other-steady');
});

test('allow lists of different kinds hold at once — a tuple must be named by every one of them', () => {
  const decision = decide({ user: overlay({ allow: { harnesses: ['example'], models: ['example-deep'] } }) });
  assert.match(excludedOf(decision, 'example-quick').detail, /allow\.models/,
    'the right harness is not enough while another allow list is unmet');
  assert.match(excludedOf(decision, 'other-steady').detail, /allow\.harnesses/);
  assert.equal(decision.chosen.tupleId, 'example-deep-high', 'the one tuple both lists name');
});

// --- ADR-004: the balance strategy -------------------------------------------

/** One decision on the balance pair. */
const paced = (over = {}) => decide({ catalog: BALANCE_CATALOG, snapshot: BALANCE_SNAPSHOT, ...over });

/** The pace block of one candidate. */
const paceOf = (decision, id) => byId(decision, id).pace;

/** The balance snapshot with one harness's windows taken away. */
function windowless(...harnesses) {
  const snapshot = clone(BALANCE_SNAPSHOT);
  for (const harness of harnesses) delete snapshot.harnesses[harness].windows;
  return snapshot;
}

test('the balance fixtures are documents their own schemas accept', () => {
  // The pair is hand-written to ADR-004's shapes, and a hand-written fixture
  // that the schema would refuse is a fixture the rest of this section proves
  // things about a document nothing else in the package would ever see.
  const ajvSnapshot = ajv.getSchema('urn:promptobus:model-routing:snapshot');
  const ajvCatalog = ajv.getSchema('urn:promptobus:model-routing:catalog');
  assert.equal(ajvSnapshot(BALANCE_SNAPSHOT), true, ajv.errorsText(ajvSnapshot.errors));
  assert.equal(ajvCatalog(BALANCE_CATALOG), true, ajv.errorsText(ajvCatalog.errors));
  assert.equal(BALANCE_SNAPSHOT.schemaVersion, 2, 'the pace layer reads a v2 snapshot and nothing else');
});

test('the pace of a candidate is its binding window, in percentage points', () => {
  const decision = paced({ strategy: 'balance' });
  validDecision(decision, 'a balance decision');

  // Codex: the weekly window is the more spent of the two, so it binds. 46 % of
  // it is gone and 62.5 % of it has elapsed, so the account is 16.5 POINTS
  // behind its own pace and has that much room. quotaCost 4 gives up
  // 5 × (4 − 1) / 4 = 3.75 of them before harnesses are compared.
  assert.deepEqual(paceOf(decision, 'codex-sol'), {
    window: { id: 'secondary', kind: 'weekly', scope: null },
    usedShare: 0.46,
    elapsedShare: 0.625,
    underspend: 16.5,
    spendPenalty: 3.89,
    effective: 12.61,
    eligible: true,
    note: null,
    representative: true,
  });

  // Both shares are published beside the result, so the ×100 can be recomputed.
  const pace = paceOf(decision, 'cursor-composer');
  assert.equal(Math.round((pace.elapsedShare - pace.usedShare) * 100 * 100) / 100, -14.08);
  assert.equal(pace.underspend, -14.08, 'the unit is percentage points, not the share');
});

test('the binding window is chosen per TUPLE, and a scope is what makes it differ', () => {
  const decision = paced({ strategy: 'balance' });
  // Two tuples, one harness, one snapshot — and different binding windows,
  // because the weekly window scoped to the Fable family covers only one of
  // them and is the more spent of the two that do.
  assert.equal(paceOf(decision, 'claude-opus').window.id, '7d');
  assert.equal(paceOf(decision, 'claude-fable').window.id, '7d-fable');
  assert.equal(paceOf(decision, 'claude-opus').underspend, 10.48);
  assert.equal(paceOf(decision, 'claude-fable').underspend, 2.48);

  // Cursor's two pools are the same fact in its own shape: the auto pool names
  // its models, and the api pool is the complement — every model in no auto
  // list falls there, which is the owner's rule and the harness's own.
  assert.deepEqual(paceOf(decision, 'cursor-composer').window,
    { id: 'cycle-auto', kind: 'monthly', scope: { pool: 'auto', models: ['composer-2.5'] } });
  assert.deepEqual(paceOf(decision, 'cursor-api').window,
    { id: 'cycle-api', kind: 'monthly', scope: { pool: 'api' } });
});

test('balance picks a different harness from balanced, on one snapshot', () => {
  // The whole point of ADR-004 in one pair of runs. `balanced` sends the work to
  // the best-rated tuple; `balance` sends it to the account with room, because
  // Cursor's auto pool is fourteen points AHEAD of its own cycle while Codex is
  // sixteen behind its week.
  const scored = paced({ strategy: 'balanced' });
  assert.equal(scored.chosen.tupleId, 'claude-fable', 'the best balanced score');
  assert.equal(scored.candidates.every((c) => c.pace === undefined), true,
    'only balance publishes a pace block — a number no rule of this strategy used invites a wrong reading');

  const balanced = paced({ strategy: 'balance' });
  assert.equal(balanced.chosen.tupleId, 'codex-sol', 'the largest effective underspend');
  assert.deepEqual(balanced.weights, { quality: 40, speed: 25, quotaCost: 20, remaining: 15 },
    'balance has no weight set of its own — it orders tuples inside a harness by balanced');
  assert.deepEqual(balanced.balance, { band: 5, spendUnit: 5 });
  // A choice layer, not a filter: the order and the scores are untouched.
  assert.deepEqual(scoredIds(balanced), scoredIds(scored));
  assert.equal(byId(balanced, 'claude-fable').score.total, byId(scored, 'claude-fable').score.total);
  assert.equal(byId(balanced, 'claude-fable').excluded, null);
});

test('the reviewer is inside the balance, and nothing pins it to one harness', () => {
  // ADR-004 decision 4. The reviewer is routed by pace like a worker, with the
  // floor of 5 above it, and the harness it lands on is whichever is furthest
  // behind its own pace — here Codex, not Claude.
  const decision = paced({ strategy: 'balance', role: 'reviewer' });
  assert.equal(decision.chosen.tupleId, 'codex-sol');
  assert.equal(decision.chosen.harness, 'codex');
  assert.equal(decision.warnings.some((w) => w.code === 'reviewer-floor-not-met'), false,
    'codex-sol rates 5 and reaches the floor');
});

test('the band ties two harnesses and the balanced score then decides', () => {
  // Codex leads on pace at +12.75 and Claude's representative is at −0.02, so
  // nothing is tied at the default band of 5. Widened past the gap, the two are
  // equal-spent by policy and the better-scoring tuple wins — which is exactly
  // what the band is for: "these accounts are about equally spent, so take the
  // better model".
  const wide = paced({ strategy: 'balance', workspace: overlay({ balance: { band: 20 } }) });
  assert.equal(wide.chosen.tupleId, 'claude-fable', 'inside the band the balanced score decides');
  assert.equal(byId(wide, 'claude-fable').score.total > byId(wide, 'codex-sol').score.total, true);

  // And the band is measured from the leader's NUMBER, so the tied set does not
  // depend on which candidate arrived first.
  const shuffled = clone(BALANCE_CATALOG);
  shuffled.tuples.reverse();
  const same = decide({
    catalog: shuffled, snapshot: BALANCE_SNAPSHOT, strategy: 'balance', workspace: overlay({ balance: { band: 20 } }),
  });
  assert.equal(same.chosen.tupleId, 'claude-fable');
});

test('the spend penalty is what keeps a heavy tuple from oscillating the strategy', () => {
  // ADR-004 option C2: the discount is in the units of the underspend. With the
  // unit at zero the penalty vanishes and the raw underspend decides; the
  // default makes a quotaCost of 5 give up exactly one band against a 1.
  const free = paced({ strategy: 'balance', workspace: overlay({ balance: { spendUnit: 0 } }) });
  for (const c of free.candidates.filter((x) => x.pace)) assert.equal(c.pace.spendPenalty, 0);
  assert.equal(paceOf(free, 'codex-sol').effective, paceOf(free, 'codex-sol').underspend);

  const dear = paced({ strategy: 'balance', workspace: overlay({ balance: { spendUnit: 8 } }) });
  assert.equal(paceOf(dear, 'claude-opus').spendPenalty, 8, 'quotaCost 10: the whole unit');
  assert.equal(paceOf(dear, 'cursor-composer').spendPenalty, 1.78, 'quotaCost 3: two ninths of it');
});

test('the spend penalty reads the ROLE\'s quotaCost, the same rating the score component does', () => {
  // A tuple that costs less of the subscription as a reviewer than as a worker.
  // If the penalty read `tuple.ratings` while the score read `roleRatings`, the
  // two halves of one decision would disagree about what this tuple spends —
  // and with the numbers below the harness choice flips on it.
  const catalog = clone(BALANCE_CATALOG);
  const opus = catalog.tuples.find((t) => t.id === 'claude-opus');
  opus.roleRatings = { reviewer: { quotaCost: 1 } };

  const asWorker = decide({
    catalog, snapshot: BALANCE_SNAPSHOT, strategy: 'balance', role: 'worker',
  });
  assert.equal(paceOf(asWorker, 'claude-opus').spendPenalty, 5, 'quotaCost 5 as a worker');
  assert.equal(paceOf(asWorker, 'claude-opus').effective, 5.48);

  const asReviewer = decide({
    catalog, snapshot: BALANCE_SNAPSHOT, strategy: 'balance', role: 'reviewer',
  });
  assert.equal(paceOf(asReviewer, 'claude-opus').spendPenalty, 0, 'quotaCost 1 as a reviewer: nothing given up');
  assert.equal(paceOf(asReviewer, 'claude-opus').effective, 10.48);
  // And the score component beside it reads the same override, which is the
  // agreement the fix is about.
  assert.equal(byId(asReviewer, 'claude-opus').score.components.quotaCost, 20);
  assert.equal(byId(asWorker, 'claude-opus').score.components.quotaCost, 0);
});

test('the representative is named in the document, and the renderer marks that row', () => {
  // The rule is the resolver's — best eligible tuple meeting the role's floor —
  // and the renderer reads the answer rather than repeating the rule. Under the
  // reviewer floor of 5 the two would part: claude-opus represents Claude, and
  // it is not the harness's best-scoring eligible tuple in the worker's list.
  const decision = paced({ strategy: 'balance', role: 'reviewer' });
  const named = decision.candidates.filter((c) => c.pace?.representative).map((c) => c.tupleId);
  assert.deepEqual([...named].sort(), ['claude-opus', 'codex-sol', 'cursor-api']);
  for (const c of decision.candidates) {
    if (!c.pace?.representative) assert.equal(c.pace?.representative, undefined, c.tupleId);
  }
  const rows = render(decision).split('\npace — ')[1].split('\n\n')[0].split('\n').slice(1).filter(Boolean);
  assert.equal(rows.length, 3);
  assert.match(rows.find((r) => r.includes('claude')), /claude-opus/);
  assert.equal(rows.filter((r) => r.trimStart().startsWith('*')).length, 1, 'exactly one row carries the pick marker');
});

test('a harness with no window has no pace and does not take part', () => {
  const decision = paced({ strategy: 'balance', snapshot: windowless('codex') });
  const pace = paceOf(decision, 'codex-sol');
  assert.equal(pace.eligible, false);
  assert.equal(pace.note, 'no-pace');
  assert.equal(pace.window, null);
  assert.equal(byId(decision, 'codex-sol').excluded, null, 'not paced is not excluded — the pick moves, the list does not');
  assert.equal(decision.chosen.harness, 'claude', 'the pick goes to the best-paced harness that is left');
});

test('a window at or past its limit is spent for that tuple', () => {
  const snapshot = clone(BALANCE_SNAPSHOT);
  snapshot.harnesses.codex.windows.find((w) => w.id === 'secondary').usedPercent = 100;
  const decision = paced({ strategy: 'balance', snapshot });
  const pace = paceOf(decision, 'codex-sol');
  assert.equal(pace.eligible, false);
  assert.equal(pace.note, 'window-spent');
  assert.equal(pace.window.id, 'secondary');
  assert.equal(pace.usedShare, 1);
  assert.notEqual(decision.chosen.harness, 'codex');
});

test('a window whose reset has passed is not paced — the fact has expired', () => {
  const snapshot = clone(BALANCE_SNAPSHOT);
  for (const w of snapshot.harnesses.codex.windows) w.resetAt = '2026-09-05T08:00:00.000Z';
  const decision = paced({ strategy: 'balance', snapshot });
  assert.equal(paceOf(decision, 'codex-sol').note, 'no-pace');
  assert.equal(paceOf(decision, 'codex-sol').window.id, 'secondary', 'the window is still named, it is just not paced');
});

test('no harness can be paced — the pick is the best score, with balance-fallback', () => {
  const decision = paced({ strategy: 'balance', snapshot: windowless('claude', 'codex', 'cursor') });
  // Every harness now reports no window at all, so `remaining` is the neutral
  // 50 for all three and each pays the unknown-availability penalty — the pick
  // is the best score under those inputs, which is not the same tuple as with
  // the windows in place.
  assert.equal(decision.chosen.tupleId, 'cursor-composer', 'the best balanced score, as the fallback says');
  const warning = decision.warnings.find((w) => w.code === 'balance-fallback');
  assert.ok(warning, decision.warnings.map((w) => w.code).join(' | '));
  assert.match(warning.message, /no harness could be paced/);
  validDecision(decision, 'a decision carrying the balance fallback');
});

test('remaining is per tuple for every strategy, not per harness', () => {
  // ADR-004 refines ADR-003's own word: the applicable windows are the
  // account-wide ones PLUS the scope covering this tuple. Two Cursor tuples on
  // one snapshot therefore differ, because their pools do — 100 − 62 against
  // 100 − 72 — and that reaches the score under quality, balanced, speed and
  // economy alike.
  for (const strategy of ['quality', 'balanced', 'speed', 'economy']) {
    const decision = paced({ strategy });
    const weight = decision.weights.remaining;
    assert.equal(byId(decision, 'cursor-composer').score.components.remaining,
      Math.round((100 - 62) * weight) / 100, `${strategy}: the auto pool`);
    assert.equal(byId(decision, 'cursor-api').score.components.remaining,
      Math.round((100 - 72) * weight) / 100, `${strategy}: the api pool`);
  }
});

test('a lift records the applicable windows of the tuple it chose', () => {
  // The starting value a later reader needs to say what this run SPENT: the
  // delta of these windows between the lift and the finish (PB-36). The set is
  // the resolver's own `applicableWindows`, so a run is measured against the
  // windows its pick was scored on and not against a second reading of the word.
  const decision = paced({ strategy: 'balance' });
  const meta = routingMetadata(decision, BALANCE_SNAPSHOT);
  assert.equal(meta.tupleId, 'codex-sol');
  assert.deepEqual(meta.windows, [
    { id: 'primary', kind: 'session', scope: null, usedPercent: 0 },
    { id: 'secondary', kind: 'weekly', scope: null, usedPercent: 46 },
  ]);

  // A scoped window is in the set exactly when it covers the tuple.
  const fable = decide({
    catalog: BALANCE_CATALOG, snapshot: BALANCE_SNAPSHOT, strategy: 'balanced',
  });
  assert.equal(fable.chosen.tupleId, 'claude-fable');
  assert.deepEqual(routingMetadata(fable, BALANCE_SNAPSHOT).windows.map((w) => w.id), ['5h', '7d', '7d-fable']);

  // And a harness with no window records an empty list rather than nothing.
  const bare = paced({ strategy: 'balance', snapshot: windowless('claude', 'codex', 'cursor') });
  assert.deepEqual(routingMetadata(bare, windowless('claude', 'codex', 'cursor')).windows, []);
  assert.deepEqual(routingMetadata(bare).windows, [], 'no snapshot in reach is an empty list too');
});

test('a hidden row is carried and never chosen, and is not a runtime row either', () => {
  // ADR-004: the harness lists it and declines to offer it. The resolver's
  // inventory is the rows without the mark, so a tuple naming one is excluded by
  // the existing code and no new one is added.
  const decision = paced({ strategy: 'balance' });
  assert.deepEqual(byId(decision, 'codex-preview').excluded, {
    code: 'model-not-in-inventory',
    detail: 'the codex account does not expose "gpt-5.6-preview"',
  });
  assert.deepEqual(decision.runtime, [],
    'a hidden UNRATED row is not offered either, so it is not a runtime row a person could pick');
});

test('the pace table prints one row per harness, with the numbers the document carries', () => {
  const decision = paced({ strategy: 'balance' });
  const table = render(decision).split('\npace — ')[1].split('\n\n')[0].split('\n');
  assert.match(table[0], /percentage points of each binding window · band 5\.0 · spend unit 5\.0/);
  const rows = table.slice(1).filter(Boolean);
  assert.equal(rows.length, 3, `one row per harness, not per candidate:\n${rows.join('\n')}`);
  assert.match(rows.find((r) => r.includes('codex')),
    /\* codex .*codex-sol · secondary weekly · 46\.0% used · 62\.5% elapsed · underspend \+16\.50 · penalty -3\.89 · effective \+12\.61/);
  // Two decimals, because one would print an underspend of −0.02 as "-0.0".
  assert.match(rows.find((r) => r.includes('claude')), /effective -0\.30/);

  // And no table at all under a strategy whose candidates carry no pace.
  assert.equal(render(paced({ strategy: 'balanced' })).includes('pace — '), false);
});

test('a harness that cannot be paced prints its note rather than empty columns', () => {
  const text = render(paced({ strategy: 'balance', snapshot: windowless('codex') }));
  const row = text.split('\n').find((l) => l.includes('codex') && l.includes('no-pace'));
  assert.ok(row, text);
  assert.match(row, /no-pace: no window that can be paced/);
});

// --- ADR-004: the near-limit signal ------------------------------------------

const nearLimits = (decision) => decision.warnings.filter((w) => w.code === 'near-limit');

test('a harness ahead of its own pace raises near-limit, and the line names which test tripped', () => {
  // Cursor's auto pool is 62 % used with 47.9 % of the cycle elapsed — 14.08
  // points ahead of pace. Nowhere near the 80 % LEVEL threshold, and the account
  // is still spending faster than the window refills, which is the whole reason
  // the signal reads both.
  const decision = paced({ workspace: overlay({ nearLimit: { underspend: -10 } }) });
  const lines = nearLimits(decision);
  assert.equal(lines.length, 1, lines.map((w) => w.message).join('\n'));
  assert.match(lines[0].message, /^cursor is running short/);
  assert.match(lines[0].message, /monthly window "cycle-auto"/);
  assert.match(lines[0].message, /resets at 2026-09-21T00:00:00\.000Z/);
  assert.match(lines[0].message, /14\.08 points ahead of its own pace/);
  assert.match(lines[0].message, /Propose --strategy balance/);
  assert.equal(/% of it is used/.test(lines[0].message), false, 'the level test did not trip, so it is not claimed');
  validDecision(decision, 'a decision carrying a near-limit line');
});

test('the level test alone raises it, and says so in those words', () => {
  const decision = paced({ workspace: overlay({ nearLimit: { usedPercent: 50 } }) });
  const cursor = nearLimits(decision).find((w) => w.message.startsWith('cursor'));
  assert.ok(cursor, nearLimits(decision).map((w) => w.message).join('\n'));
  assert.match(cursor.message, /62\.0 % of it is used, at or past the 50 % threshold/);
});

test('economy is proposed only when EVERY paced harness is past the threshold', () => {
  // At 50 % only Cursor is over, so at least one other account has room and the
  // answer is to spend it there: `balance`.
  const some = paced({ workspace: overlay({ nearLimit: { usedPercent: 50 } }) });
  for (const w of nearLimits(some)) assert.match(w.message, /Propose --strategy balance/);

  // At 25 % all three are over — the set as a whole is short, and the answer is
  // to spend less per run.
  const all = paced({ workspace: overlay({ nearLimit: { usedPercent: 25 } }) });
  assert.equal(nearLimits(all).length, 3);
  for (const w of nearLimits(all)) assert.match(w.message, /Propose --strategy economy/);
});

test('no line when the strategy it would propose is the one already running', () => {
  // A warning that recommends what is already happening is noise.
  const already = paced({ strategy: 'economy', workspace: overlay({ nearLimit: { usedPercent: 25 } }) });
  assert.deepEqual(nearLimits(already), []);
  const other = paced({ strategy: 'balanced', workspace: overlay({ nearLimit: { usedPercent: 25 } }) });
  assert.equal(nearLimits(other).length, 3);
});

test('the signal is raised under every strategy, not only under balance', () => {
  // A person running `models --strategy quality` is owed the same warning about
  // their windows — which is why the pace is computed for every scored candidate
  // and only PUBLISHED under balance.
  for (const strategy of ['quality', 'balanced', 'speed', 'economy']) {
    const decision = paced({ strategy, workspace: overlay({ nearLimit: { underspend: -10 } }) });
    assert.equal(nearLimits(decision).length, 1, `${strategy}: the line is missing`);
    assert.equal(decision.candidates.every((c) => c.pace === undefined), true,
      `${strategy}: the pace block must not be published`);
  }

  // `balance` is the one that is quiet here, and not because it is exempt: the
  // strategy the line would propose is the one already running. Give the account
  // set a reason to propose `economy` instead and the line arrives.
  const quiet = paced({ strategy: 'balance', workspace: overlay({ nearLimit: { underspend: -10 } }) });
  assert.deepEqual(nearLimits(quiet), []);
  const loud = paced({ strategy: 'balance', workspace: overlay({ nearLimit: { usedPercent: 25 } }) });
  assert.equal(nearLimits(loud).length, 3);
  for (const w of nearLimits(loud)) assert.match(w.message, /Propose --strategy economy/);
});

test('a harness that cannot be paced raises no near-limit line — a threshold needs a number', () => {
  const decision = paced({
    snapshot: windowless('cursor'),
    workspace: overlay({ nearLimit: { usedPercent: 1 } }),
  });
  assert.equal(nearLimits(decision).some((w) => w.message.startsWith('cursor')), false);
  assert.equal(nearLimits(decision).length, 2, 'the other two are still measured');
});

test('the thresholds are policy values, and the defaults are ADR-004\'s', () => {
  // The defaults raise nothing on this fixture: Cursor at 62 % is under 80, and
  // its −14.08 is inside the −15 band. One point either way turns each on.
  assert.deepEqual(nearLimits(paced({})), []);
  assert.equal(nearLimits(paced({ workspace: overlay({ nearLimit: { usedPercent: 62 } }) })).length >= 1, true);
  assert.equal(nearLimits(paced({ workspace: overlay({ nearLimit: { underspend: -14 } }) })).length, 1);
});

// --- ADR-004: the two new selectors ------------------------------------------

/** The fixture snapshot with a flag put on a RATED model, which the golden has on an unrated one. */
function flaggedSnapshot(model = 'example-quick', flags = ['no-zdr']) {
  const snapshot = clone(SNAPSHOT);
  const row = snapshot.harnesses.example.models.find((m) => m.model === model);
  row.flags = flags;
  return snapshot;
}

test('a byRole rule excludes for that role and leaves the other alone', () => {
  const rule = overlay({ deny: { byRole: { reviewer: { harnesses: ['other'] } } } });
  const asReviewer = decide({ role: 'reviewer', workspace: rule });
  assert.deepEqual(excludedOf(asReviewer, 'other-steady'), {
    code: 'denied-by-policy',
    detail: 'denied by deny.byRole.reviewer.harnesses of overlay "workspace" — '
      + 'a ban is lifted only in the layer that wrote it',
  });

  const asWorker = decide({ role: 'worker', workspace: rule });
  assert.equal(excludedOf(asWorker, 'other-steady'), null, 'a rule scoped to the reviewer must not reach the worker');
  assert.ok(scoredIds(asWorker).includes('other-steady'));
});

test('an unscoped ban and a byRole ban are both in force for that role', () => {
  const decision = decide({
    role: 'reviewer',
    workspace: overlay({
      deny: { tuples: ['example-deep-max'], byRole: { reviewer: { harnesses: ['other'] } } },
    }),
  });
  assert.match(excludedOf(decision, 'example-deep-max').detail, /deny\.tuples/);
  assert.match(excludedOf(decision, 'other-steady').detail, /deny\.byRole\.reviewer\.harnesses/);
  assert.equal(decision.chosen.tupleId, 'example-deep-high', 'the one reviewer tuple neither rule reaches');
});

test('a flag rule excludes the tuple whose model the snapshot marks', () => {
  const decision = decide({
    snapshot: flaggedSnapshot(),
    workspace: overlay({ deny: { flags: ['no-zdr'] } }),
  });
  assert.deepEqual(excludedOf(decision, 'example-quick'), {
    code: 'denied-by-policy',
    detail: 'denied by deny.flags of overlay "workspace" — a ban is lifted only in the layer that wrote it',
  });
  assert.equal(excludedOf(decision, 'example-deep-high'), null, 'an unmarked model of the same harness is untouched');
});

test('the flag selector runs after the inventory step, so it never speaks for a model the account lacks', () => {
  // A tuple the account does not expose is `model-not-in-inventory` and stays
  // that, whatever a flag rule says: the flag needs the row the inventory step
  // consulted, so it cannot be the reason reported before that step ran.
  const snapshot = clone(SNAPSHOT);
  snapshot.harnesses.example.models = snapshot.harnesses.example.models.filter((m) => m.model !== 'example-quick');
  const decision = decide({ snapshot, workspace: overlay({ deny: { flags: ['no-zdr'] } }) });
  assert.equal(excludedOf(decision, 'example-quick').code, 'model-not-in-inventory');
});

test('silence is not absence: a flag deny excludes nothing on a harness that listed no models', () => {
  // ADR-004 states the limit rather than implying it. A person who must never
  // run outside zero-data-retention does not get that guarantee from a harness
  // with no inventory, and the decision says so with a warning instead of
  // appearing to.
  // The golden snapshot marks one UNRATED row, so the mark is stripped first:
  // the subject here is a rule whose flag nothing in the run carries.
  const snapshot = clone(SNAPSHOT);
  for (const model of snapshot.harnesses.example.models) delete model.flags;
  const decision = decide({ snapshot, workspace: overlay({ deny: { flags: ['no-zdr'] } }) });
  assert.equal(excludedOf(decision, 'other-steady'), null);
  const warning = decision.warnings.find((w) => w.code === 'flag-not-in-inventory');
  assert.ok(warning, decision.warnings.map((w) => w.code).join(' | '));
  assert.match(warning.message, /no-zdr/);
  assert.match(warning.message, /deny\.flags of overlay "workspace"/);
});

test('allow.flags is the same fact read the other way — an unmarked tuple is not one of \"only these\"', () => {
  const decision = decide({
    snapshot: flaggedSnapshot(),
    workspace: overlay({ allow: { flags: ['no-zdr'] } }),
  });
  assert.deepEqual(excludedOf(decision, 'example-deep-high'),
    { code: 'denied-by-policy', detail: 'not named by allow.flags of overlay "workspace"' });
  assert.ok(scoredIds(decision).includes('example-quick'), 'the marked model is the one the allow list admits');
});

test('a flag the snapshot does carry raises no warning', () => {
  const decision = decide({
    snapshot: flaggedSnapshot(),
    workspace: overlay({ deny: { flags: ['no-zdr'] } }),
  });
  assert.equal(decision.warnings.find((w) => w.code === 'flag-not-in-inventory'), undefined);
  validDecision(decision, 'a decision carrying the new selectors');
});

// --- the text output ----------------------------------------------------------------

test('every candidate row is on the same grid, however long the names are', () => {
  const catalog = catalogOf([
    {
      id: 'a-very-long-tuple-identifier-here',
      harness: 'alpha',
      model: 'a-model-with-a-genuinely-long-name',
      effort: 'high',
      ratings: { quality: 3, speed: 3, quotaCost: 3 },
      priority: 10,
    },
    { id: 'short', harness: 'alpha', model: 'm', ratings: { quality: 2, speed: 2, quotaCost: 2 }, priority: 20 },
  ]);
  const text = render(decide({ catalog, snapshot: TIE_SNAPSHOT }));
  const rows = text.split('\ncandidates:\n')[1].split('\n\n')[0].split('\n').filter(Boolean);
  const columns = rows.map((line) => line.search(/(available|unknown|exhausted|unavailable)/));
  assert.ok(columns[0] > 0, `no state word was printed at all, so there is no column to compare:\n${text}`);
  assert.equal(new Set(columns).size, 1, `the state column moved between rows:\n${text}`);
  assert.equal(/[ \t]+\n/.test(text), false, 'a rendered line must not end in whitespace');
  assert.ok(text.endsWith('\n'));
});

test('a decision with nothing to say prints no empty blocks', () => {
  const catalog = catalogOf([
    { id: 'alpha-only', harness: 'alpha', model: 'alpha-only', ratings: { quality: 5, speed: 3, quotaCost: 3 }, priority: 10 },
  ]);
  const text = render(decide({ catalog, snapshot: TIE_SNAPSHOT }));
  assert.equal(text.includes('runtime models'), false, 'no unrated model, no runtime block');
  assert.equal(text.includes('warnings:'), false, 'no warning, no warnings block');
  assert.match(text, /^chosen: alpha-only · alpha \/ alpha-only · score 53\.90$/m);
});

test('a decision with no candidate says so where the pick would be', () => {
  const text = render(decide({ constraints: { model: 'nothing-like-this' } }));
  assert.match(text, /^chosen: none · nothing survived filtering$/m);
  assert.match(text, /^ {2}- example-quick .* {2}constraint-mismatch: /m);
});

test('a bonus keeps its sign, and several adjustments print as one list', () => {
  const text = render(decide({
    role: 'reviewer',
    liveParticipants: [{ harness: 'example', model: 'example-quick', role: 'worker' }],
  }));
  assert.match(text, /\(-5 live-participant, \+5 reviewer-diversity\)/);
});

test('render names the field a document is missing rather than failing halfway down the page', () => {
  const decision = decide();
  assert.throws(() => render({ ...decision, snapshot: undefined }), /has no snapshot$/);
  assert.throws(() => render({ ...decision, snapshot: { takenAt: decision.snapshot.takenAt } }),
    /has no snapshot\.ageSec$/);
  assert.throws(() => render({ ...decision, warnings: undefined }), /has no warnings$/);
  assert.throws(() => render({ ...decision, runtime: 'not an array' }), /runtime \(expected an array\)/);
  assert.throws(() => render(null), /expected a decision document/);
  // `chosen: null` is a document, not a missing field — it is the empty-candidate case.
  assert.doesNotThrow(() => render({ ...decision, chosen: null }));
});

// --- the inputs the resolver refuses ---------------------------------------------------

test('an unknown strategy or role is refused before anything is scored', () => {
  assert.throws(() => decide({ strategy: 'auto' }), /unknown strategy "auto"/);
  assert.throws(() => decide({ role: 'orchestrator' }), /unknown role "orchestrator"/);
});


test('the text form caps the unrated rows per harness and counts the rest; the document keeps every row', () => {
  // PB-20.1: an account that lists two hundred models the catalog does not rate
  // would push the decision and the warnings to the two ends of a page. The cap
  // is the text form's alone — `--json` is the contract and keeps every row.
  const many = Array.from({ length: RUNTIME_ROWS_PER_HARNESS + 4 }, (_, i) => `example / unrated-${i}`);
  const snapshot = structuredClone(SNAPSHOT);
  snapshot.harnesses.example.models = [...snapshot.harnesses.example.models,
    ...many.map((m) => ({ model: m.split(' / ')[1], rated: false }))];
  const decision = decide({ snapshot });
  const printed = decision.runtime.filter((r) => r.harness === 'example').length;
  assert.ok(printed >= RUNTIME_ROWS_PER_HARNESS + 4, `the document carries ${printed} example rows`);
  const text = render(decision);
  const rows = text.split('\n').filter((l) => /^    example \/ /.test(l));
  assert.equal(rows.length, RUNTIME_ROWS_PER_HARNESS, text);
  assert.match(text, new RegExp(`^    example: … and ${printed - RUNTIME_ROWS_PER_HARNESS} more — every row is in --json$`, 'm'));
});
