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
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { CATALOG_FILE, mergeRouting } from '../lib/model-routing/catalog.js';
import { NEUTRAL_REMAINING_PERCENT, resolve } from '../lib/model-routing/resolver.js';
import { render } from '../lib/model-routing/render.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const SCHEMAS = path.join(ROOT, 'schemas', 'model-routing');
const FIXTURES = path.join(here, 'fixtures', 'model-routing');

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const fixture = (name) => readJson(path.join(FIXTURES, name));
const clone = (v) => JSON.parse(JSON.stringify(v));

const CATALOG = fixture('catalog.json');
const SNAPSHOT = fixture('snapshot.json');

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
    { id: 'workspace', path: path.join(WORKSPACE, 'model-routing.local.json'), present: workspace !== null, data: workspace },
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

const overlay = (fields) => ({ schemaVersion: 1, ...fields });

// --- the goldens --------------------------------------------------------------

test('the golden decision is reproduced from the golden inputs', () => {
  const decision = decide();
  validDecision(decision, 'the decision the resolver produced');
  assert.deepEqual(normalise(decision), fixture('decision.json'));
});

test('the golden text is rendered from that decision, byte for byte', () => {
  const text = render(decide());
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
  // ratings 3 / 5 / 2, weights 40 / 25 / 20 / 15, remaining 100 − 40 = 60.
  assert.deepEqual(quick.components, { quality: 20, speed: 25, quotaCost: 15, remaining: 9 });
  assert.equal(quick.base, 69);
  assert.equal(quick.total, 69);
  // The inversion is the half a mutation would flip: quotaCost 2 is CHEAP, so it
  // contributes 15 of its 20 points. Read as a plain rating it would contribute 5.
  const deep = byId(decide(), 'example-deep-high').score;
  assert.equal(deep.components.quotaCost, 0, 'quotaCost 5 is the dearest and contributes nothing');
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
  assert.equal(byId(opted, 'other-metered').score.total, 76.25);
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
  assert.deepEqual(decision.warnings.map((w) => w.code), ['unknown-remaining']);
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
  assert.equal(quick.total, 64.5);
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
  const stale = clone(SNAPSHOT);
  stale.harnesses.other.reason = 'stale_cache';
  assert.deepEqual(decide({ snapshot: stale }).warnings.map((w) => w.code),
    ['unknown-remaining', 'snapshot-stale']);
  const timedOut = clone(SNAPSHOT);
  timedOut.harnesses.other.reason = 'probe_timeout';
  assert.deepEqual(decide({ snapshot: timedOut }).warnings.map((w) => w.code),
    ['unknown-remaining', 'probe-incomplete']);
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
  assert.equal(byId(one, 'example-quick').score.total, 64);
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
  assert.equal(decision.chosen.tupleId, 'other-steady');
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
  assert.equal(decision.chosen.tupleId, 'other-steady');
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
    workspace: overlay({ ratings: { 'other-steady': { quality: 3, speed: 5, quotaCost: 1 } } }),
  });
  assert.equal(scoredIds(decision)[0], 'other-steady');
  assert.equal(byId(decision, 'other-steady').score.total, 62.5);
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
        'other-steady': { quality: 3 }, 'example-deep-high': { quality: 3 }, 'example-deep-max': { quality: 2 },
      },
    }),
  });
  assert.equal(decision.chosen.tupleId, scoredIds(decision)[0], 'the soft fallback takes the top of the list');
  const warning = decision.warnings.find((w) => w.code === 'reviewer-floor-not-met');
  assert.ok(warning, 'the fallback must say it happened');
  assert.match(warning.message, /quality floor of 4 of 5/);
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
  assert.equal(byId(worker, 'alpha-reviewly').score.total, 61.25);
  // As a reviewer the same tuple is a different set of ratings, and it wins.
  const reviewer = decide({ catalog, snapshot: TIE_SNAPSHOT, role: 'reviewer' });
  assert.equal(reviewer.chosen.tupleId, 'alpha-reviewly');
  assert.equal(byId(reviewer, 'alpha-reviewly').score.total, 90);
  assert.equal(byId(reviewer, 'alpha-generalist').score.total, 80, 'the tuple with no override is scored the same in both roles');
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
  assert.equal(worker.chosen.tupleId, 'alpha-fast', 'no override for a worker, and no floor either');

  const reviewer = decide({ catalog, snapshot: TIE_SNAPSHOT, strategy: 'speed', role: 'reviewer' });
  assert.equal(scoredIds(reviewer)[0], 'alpha-fast', 'it is still the top scorer');
  assert.equal(byId(reviewer, 'alpha-fast').score.total, 87.5);
  assert.equal(reviewer.chosen.tupleId, 'alpha-solid', 'the reviewer quality of 3 is below the floor of 4');
  assert.equal(reviewer.warnings.some((w) => w.code === 'reviewer-floor-not-met'), false,
    'alpha-solid reaches the floor, so this is not the fallback');
});

test('the floor itself is a policy value', () => {
  // Raised to 5, other-steady's quality of 4 no longer clears it, and the pick
  // moves to the first tuple that does.
  const decision = decide({ role: 'reviewer', workspace: overlay({ reviewerQualityFloor: 5 }) });
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
  assert.equal(steady.score.total, 66.25);
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
  schemaVersion: 1,
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
      windows: [{ id: '5h', usedPercent: 0, lengthSec: 18000, resetAt: null }],
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
  const decision = decide({ catalog, snapshot: TIE_SNAPSHOT });
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

test('a deny rule excludes and names the layer that wrote it', () => {
  const decision = decide({ workspace: overlay({ deny: { models: ['example-quick'] } }) });
  assert.deepEqual(excludedOf(decision, 'example-quick'),
    { code: 'denied-by-policy', detail: 'denied by overlay "workspace" (deny.models)' });
  assert.equal(decision.chosen.tupleId, 'other-steady');
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
    { id: 'alpha-only', harness: 'alpha', model: 'alpha-only', ratings: { quality: 3, speed: 3, quotaCost: 3 }, priority: 10 },
  ]);
  const text = render(decide({ catalog, snapshot: TIE_SNAPSHOT }));
  assert.equal(text.includes('runtime models'), false, 'no unrated model, no runtime block');
  assert.equal(text.includes('warnings:'), false, 'no warning, no warnings block');
  assert.match(text, /^chosen: alpha-only · alpha \/ alpha-only · score 57\.50$/m);
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
