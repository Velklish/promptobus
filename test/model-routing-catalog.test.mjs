// The catalog, the overlay merge, and `validate` — PB-13. Run: npm test
//
// Three subjects, and they need different kinds of check:
//
// 1. **The shipped catalog is a document.** It validates against its own
//    schema, every harness it names is one this CLI drives, every effort it
//    names is in that driver's own dictionary, and the canonical-priority
//    convention the guide documents actually holds in the file. A catalog that
//    drifts from the drivers is unroutable, and nothing else would say so.
// 2. **The merge is a pure function of the layer ORDER.** Each field is
//    overridden by the layer above it, and swapping two layers changes the
//    result — that second property is what the mutation probe on this file
//    breaks.
// 3. **`validate` refuses.** Production reads no JSON Schema (ajv is a
//    devDependency), so the grammar in `lib/model-routing/validate.js` is
//    hand-written from the same schemas. Two descriptions of one contract
//    drift, so the parity check below runs both over one corpus of documents:
//    edit one, edit the other.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { GateError } from '../dist/index.js';
import {
  CATALOG_FILE, DEFAULT_POLICY, DEFAULTS, STALE_RATING_DAYS, loadCatalog, mergeRouting,
} from '../lib/model-routing/catalog.js';
import {
  checkCatalogShape, checkOverlayShape, effortLevelsOf, knownHarnesses, validate, validateLayers,
} from '../lib/model-routing/validate.js';
import { MODEL_ALIASES, MODEL_IDS } from '../lib/driver-claude.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const SCHEMAS = path.join(ROOT, 'schemas', 'model-routing');
const CURSOR_LISTING = path.join(here, 'fixtures', 'model-catalog', 'cursor-models.txt');

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const CATALOG = readJson(CATALOG_FILE);

// `strict: false` for the same reason the contract file gives: the schemas'
// own vocabulary is suspicious to ajv in strict mode, and the subject is the
// verdict.
const ajv = new Ajv2020({ strict: false, allErrors: true });
for (const name of readdirSync(SCHEMAS).filter((n) => n.endsWith('.schema.json'))) {
  ajv.addSchema(readJson(path.join(SCHEMAS, name)));
}
const ajvCatalog = ajv.getSchema('urn:promptobus:model-routing:catalog');
const ajvOverlay = ajv.getSchema('urn:promptobus:model-routing:overlay');

const clone = (v) => JSON.parse(JSON.stringify(v));

/** Host stand-in: routing needs exactly one method of it, and naming paths is all it does. */
function hostWith(overlays, cacheFile = '/nowhere/cache.json') {
  return {
    kind: 'promptobus-host',
    commandName: 'promptobus',
    routingPaths: () => ({ cacheFile, overlays }),
  };
}

const overlayLayer = (id, data) => ({ id, path: `/layers/${id}.json`, present: true, data });
const absentLayer = (id) => ({ id, path: `/layers/${id}.json`, present: false, data: null });
const canonicalLayer = (doc = CATALOG) => ({ id: 'catalog', path: CATALOG_FILE, present: true, data: doc });

// --- the shipped catalog is a document ---------------------------------------

test('the shipped catalog validates against its own schema', () => {
  assert.equal(ajvCatalog(CATALOG), true, ajv.errorsText(ajvCatalog.errors));
  assert.ok(CATALOG.tuples.length >= 1);
});

test('every shipped tuple names a harness this CLI drives and an effort that driver knows', () => {
  // The catalog is data and the effort dictionaries are code. Nothing else
  // connects them, so a driver that renames a level, or a catalog written
  // against a harness the registry does not hold, is unroutable in silence.
  for (const tuple of CATALOG.tuples) {
    assert.ok(knownHarnesses().includes(tuple.harness),
      `${tuple.id}: harness ${tuple.harness} is not in the driver registry`);
    if (tuple.effort === null) continue;
    assert.ok(effortLevelsOf(tuple.harness).includes(tuple.effort),
      `${tuple.id}: effort ${tuple.effort} is not in the ${tuple.harness} EFFORT_LEVELS`);
  }
});

test('Cursor tuples carry the level inside the model id and no separate effort', () => {
  // lib/driver-cursor.js appends `-<level>` to `--model` when it is given an
  // effort. A Cursor tuple whose model id already holds the level and ALSO
  // named an effort would lift `claude-opus-5-thinking-max-max`.
  for (const tuple of CATALOG.tuples.filter((t) => t.harness === 'cursor')) {
    assert.equal(tuple.effort, null, `${tuple.id}: a Cursor tuple must not name a separate effort`);
  }
});

test('every Cursor model id appears verbatim in the listing the binary printed', () => {
  // Nothing validates a Cursor model id before liftoff: lib/driver-cursor.js
  // records that a bad id is refused in about two seconds with empty stdout,
  // without opening a chat. So a mistyped or re-pointed id is a routed spawn
  // that fails silently and reads as a harness fault. This is where it goes
  // red instead. The listing and how to recapture it are the README beside it.
  //
  // The id, not the display name: `claude-opus-5-thinking-high` is displayed as
  // "Claude Opus 5 1M Thinking" with no level word, while `gpt-5.6-sol-high` is
  // displayed as "GPT-5.6 Sol 1M High". A row copied from a display name would
  // be wrong in the first case and right in the second.
  const ids = new Set(readFileSync(CURSOR_LISTING, 'utf8')
    .split('\n')
    .map((line) => line.split(' - ')[0].trim())
    .filter(Boolean));
  assert.ok(ids.size > 100, `the captured listing has only ${ids.size} ids — it did not parse`);

  const cursorTuples = CATALOG.tuples.filter((t) => t.harness === 'cursor');
  assert.ok(cursorTuples.length, 'no Cursor tuple to check');
  for (const tuple of cursorTuples) {
    assert.ok(ids.has(tuple.model),
      `${tuple.id}: model "${tuple.model}" is not an id in ${path.relative(ROOT, CURSOR_LISTING)}`);
  }
});

test('every Claude model id is one the driver reports, and no Claude row names an alias', () => {
  // The Claude sibling of the Cursor check above, and it needs a different source
  // because the harness has none: `claude` publishes no model listing at all — no
  // `models` subcommand, no `--list-models` (measured 2026-09-05 on 2.1.251) — so
  // what a row is checked against is the set the DRIVER accepts and reports as its
  // inventory. That set is the one the adapter hands the preflight, so a row and an
  // inventory that drifted apart would exclude every Claude tuple as
  // `model-not-in-inventory` and send the person to the catalog for it.
  //
  // The second half is PB-13.1 itself. `claude --model` takes an alias ('fable',
  // 'opus', 'sonnet') as readily as a full name, and a row keyed on one is a rating
  // of whatever the vendor points that alias at today: when it moves, the row keeps
  // its ratings, its `assessedAt` and its evidence and starts describing a model
  // nobody assessed, with nothing going red — the staleness warning fires on the
  // calendar, not on a re-point. This is where a row that goes back to an alias
  // reddens instead.
  const accepted = new Set(MODEL_IDS);
  const claudeTuples = CATALOG.tuples.filter((t) => t.harness === 'claude');
  assert.ok(claudeTuples.length, 'no Claude tuple to check');
  for (const tuple of claudeTuples) {
    assert.ok(!MODEL_ALIASES.includes(tuple.model),
      `${tuple.id}: model "${tuple.model}" is an alias, and an alias re-points under the rating`);
    assert.ok(accepted.has(tuple.model),
      `${tuple.id}: model "${tuple.model}" is not one of MODEL_IDS in lib/driver-claude.js (${[...accepted].join(', ')})`);
  }
});

test('the shipped catalog passes validate with no overlay present', () => {
  const verdict = validate({ host: hostWith([{ id: 'user', path: '/nowhere/user.json' }]) });
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.ok, true);
  const priorityWarnings = verdict.warnings.filter((w) => w.code.startsWith('priority-'));
  assert.deepEqual(priorityWarnings, [], 'the shipped catalog breaks its own canonical-priority convention');
});

test('a model the harness exposes but the catalog does not rate produces no tuple', () => {
  // Measured 2026-09-05: `model/list` over `codex app-server` returns
  // gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5 and gpt-5.4-mini, and
  // `claude --help` publishes the aliases fable, opus and sonnet. The rows the
  // maintainers could not rate from a named source are absent by decision, and
  // an absent row is an `unrated` runtime line (PB-14), never a tuple.
  const models = new Set(CATALOG.tuples.map((t) => t.model));
  for (const unrated of ['gpt-5.5', 'fable']) {
    assert.equal(models.has(unrated), false,
      `${unrated} has no maintainer rating and must not appear as a tuple`);
  }
  assert.equal(models.has('gpt-5.6-sol'), true, 'the rated inventory should still be there');
});

// --- the merge ---------------------------------------------------------------

test('every layer overrides the one below it, field by field', () => {
  const canonical = canonicalLayer();
  const first = overlayLayer('user', {
    schemaVersion: 1,
    weights: { balanced: { quality: 50, speed: 20, quotaCost: 15, remaining: 15 } },
    penalties: { unknownAvailability: 20 },
    bonuses: { reviewerDiversity: 9 },
    reviewerQualityFloor: 3,
    deny: { models: ['claude-opus-5'] },
    ratings: { 'codex-sol-high': { quality: 2 } },
    priority: { 'codex-sol-high': 999 },
    payg: { allow: true },
  });
  const second = overlayLayer('workspace', {
    schemaVersion: 1,
    penalties: { unknownAvailability: 30 },
    reviewerQualityFloor: 5,
    deny: { models: ['claude-sonnet-5'] },
    ratings: { 'codex-sol-high': { speed: 1 } },
  });

  const merged = mergeRouting({ canonical: canonical.data, overlays: [first, second] });

  // Taken from the higher layer.
  assert.equal(merged.policy.penalties.unknownAvailability, 30);
  assert.equal(merged.policy.reviewerQualityFloor, 5);
  assert.deepEqual(merged.policy.deny.models, ['claude-sonnet-5']);
  // Left alone by the higher layer, so the lower one still holds.
  assert.deepEqual(merged.policy.weights.balanced, { quality: 50, speed: 20, quotaCost: 15, remaining: 15 });
  assert.equal(merged.policy.bonuses.reviewerDiversity, 9);
  assert.equal(merged.policy.payg.allow, true);
  // Untouched by either: the default stands.
  assert.deepEqual(merged.policy.weights.quality, DEFAULT_POLICY.weights.quality);
  assert.equal(merged.policy.penalties.liveParticipantCap, DEFAULT_POLICY.penalties.liveParticipantCap);
  // Ratings merge per named rating; priority replaces.
  const tuple = merged.tuples.find((t) => t.id === 'codex-sol-high');
  assert.equal(tuple.ratings.quality, 2, 'the lower layer set quality and nobody overrode it');
  assert.equal(tuple.ratings.speed, 1, 'the higher layer set speed');
  assert.equal(tuple.ratings.quotaCost, CATALOG.tuples.find((t) => t.id === 'codex-sol-high').ratings.quotaCost,
    'a rating nobody named keeps its catalog value');
  assert.equal(tuple.priority, 999);
  assert.deepEqual(merged.appliedOverlays, ['user', 'workspace']);
});

test('the layer order IS the precedence order', () => {
  // This is the check the mutation probe breaks: swap the two layers in the
  // call and the assertions below must go red. A merge that folded layers into
  // a set rather than a sequence would pass everything above and fail here.
  const canonical = canonicalLayer();
  const low = overlayLayer('user', { schemaVersion: 1, reviewerQualityFloor: 2, deny: { harnesses: ['cursor'] } });
  const high = overlayLayer('workspace', { schemaVersion: 1, reviewerQualityFloor: 5, deny: { harnesses: ['codex'] } });

  const upward = mergeRouting({ canonical: canonical.data, overlays: [low, high] });
  const swapped = mergeRouting({ canonical: canonical.data, overlays: [high, low] });

  assert.equal(upward.policy.reviewerQualityFloor, 5);
  assert.deepEqual(upward.policy.deny.harnesses, ['codex']);
  assert.equal(swapped.policy.reviewerQualityFloor, 2);
  assert.deepEqual(swapped.policy.deny.harnesses, ['cursor']);
  assert.notDeepEqual(upward.policy, swapped.policy, 'the two orders must not produce one policy');
});

test('a weight set is replaced whole, not field by field', () => {
  // Half-replacing a weight set is how it silently stops summing to 100, and
  // the resolver would then divide a component back by a weight nobody chose.
  const overlay = overlayLayer('user', {
    schemaVersion: 1,
    weights: { speed: { quality: 25, speed: 25, quotaCost: 25, remaining: 25 } },
  });
  const merged = mergeRouting({ canonical: CATALOG, overlays: [overlay] });
  assert.deepEqual(merged.policy.weights.speed, { quality: 25, speed: 25, quotaCost: 25, remaining: 25 });
  assert.deepEqual(merged.policy.weights.economy, DEFAULT_POLICY.weights.economy);
});

test('a missing overlay file is normal, not an error', () => {
  const merged = mergeRouting({ canonical: CATALOG, overlays: [absentLayer('user'), absentLayer('workspace')] });
  assert.deepEqual(merged.policy, JSON.parse(JSON.stringify(DEFAULT_POLICY)));
  assert.deepEqual(merged.appliedOverlays, []);
  assert.equal(merged.tuples.length, CATALOG.tuples.length);
});

test('CLI constraints are the top layer: --allow-payg changes policy, the named values are carried through', () => {
  const optedIn = overlayLayer('user', { schemaVersion: 1, payg: { allow: true } });
  const constraints = { harness: 'codex', model: 'gpt-5.6-sol', effort: 'high', allowPayg: true };

  const merged = mergeRouting({ canonical: CATALOG, overlays: [], constraints });
  assert.equal(merged.policy.payg.allow, true);
  assert.deepEqual(merged.constraints, { harness: 'codex', model: 'gpt-5.6-sol', effort: 'high' });

  // The flag is opt-in only: its absence must not undo an overlay that opted in.
  const quiet = mergeRouting({ canonical: CATALOG, overlays: [optedIn], constraints: { harness: 'codex' } });
  assert.equal(quiet.policy.payg.allow, true);
  assert.deepEqual(quiet.constraints, { harness: 'codex', model: null, effort: null });
});

test('loadCatalog reads the host layers in the host order and reports which were there', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'promptobus-routing-'));
  try {
    const userFile = path.join(dir, 'user.json');
    const wsFile = path.join(dir, 'workspace.json');
    writeFileSync(userFile, JSON.stringify({ schemaVersion: 1, reviewerQualityFloor: 2 }));
    const host = hostWith([{ id: 'user', path: userFile }, { id: 'workspace', path: wsFile }]);

    const loaded = loadCatalog({ host });
    assert.equal(loaded.policy.reviewerQualityFloor, 2);
    assert.deepEqual(loaded.layers.map((l) => [l.id, l.present]),
      [['catalog', true], ['user', true], ['workspace', false]]);

    writeFileSync(wsFile, JSON.stringify({ schemaVersion: 1, reviewerQualityFloor: 4 }));
    assert.equal(loadCatalog({ host }).policy.reviewerQualityFloor, 4,
      'the workspace layer sits above the user layer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- validate ----------------------------------------------------------------

test('validate refuses a catalog whose shape is wrong', () => {
  const cases = [
    ['schemaVersion', (c) => { c.schemaVersion = 2; }],
    ['updated', (c) => { c.updated = '2026-09-05'; }],
    ['unknown field', (c) => { c.notes = 'hello'; }],
    ['rating out of range', (c) => { c.tuples[0].ratings.quality = 6; }],
    ['rating not an integer', (c) => { c.tuples[0].ratings.speed = 2.5; }],
    ['role unknown', (c) => { c.tuples[0].roles = ['architect']; }],
    ['billing unknown', (c) => { c.tuples[0].billing = 'invoice'; }],
    ['price negative', (c) => { c.tuples[0].prices.inputPerMTok = -1; }],
    ['source empty', (c) => { c.tuples[0].source = ''; }],
    ['id grammar', (c) => { c.tuples[0].id = 'Not An Id'; }],
  ];
  for (const [name, mutate] of cases) {
    const doc = clone(CATALOG);
    mutate(doc);
    const verdict = validateLayers({ canonical: canonicalLayer(doc) });
    assert.equal(verdict.ok, false, `${name}: validate accepted it`);
    assert.equal(verdict.errors[0].code, 'catalog-invalid', name);
  }
});

test('validate refuses a catalog whose references do not hold', () => {
  const duplicate = clone(CATALOG);
  duplicate.tuples.push(clone(duplicate.tuples[0]));
  const dupVerdict = validateLayers({ canonical: canonicalLayer(duplicate) });
  assert.equal(dupVerdict.ok, false);
  assert.ok(dupVerdict.errors.some((e) => e.message.includes('duplicate tuple id')), 'duplicate id not caught');

  const foreignHarness = clone(CATALOG);
  foreignHarness.tuples[0].harness = 'aider';
  const harnessVerdict = validateLayers({ canonical: canonicalLayer(foreignHarness) });
  assert.equal(harnessVerdict.ok, false);
  assert.ok(harnessVerdict.errors.some((e) => e.message.includes('unknown harness')), 'foreign harness not caught');

  const foreignEffort = clone(CATALOG);
  const claudeTuple = foreignEffort.tuples.find((t) => t.harness === 'claude');
  claudeTuple.effort = 'deep-think';
  const effortVerdict = validateLayers({ canonical: canonicalLayer(foreignEffort) });
  assert.equal(effortVerdict.ok, false);
  assert.ok(effortVerdict.errors.some((e) => e.at.endsWith('.effort')),
    'an effort outside the driver EFFORT_LEVELS not caught');
});

test('validate refuses an overlay whose shape is wrong', () => {
  const cases = [
    ['schemaVersion', { schemaVersion: 2 }],
    ['unknown field', { schemaVersion: 1, weight: {} }],
    ['unknown strategy', { schemaVersion: 1, weights: { thorough: { quality: 25, speed: 25, quotaCost: 25, remaining: 25 } } }],
    ['half a weight set', { schemaVersion: 1, weights: { speed: { quality: 50, speed: 50 } } }],
    ['floor out of range', { schemaVersion: 1, reviewerQualityFloor: 9 }],
    ['empty rule', { schemaVersion: 1, deny: {} }],
    ['empty name list', { schemaVersion: 1, deny: { models: [] } }],
    ['unknown selector', { schemaVersion: 1, deny: { providers: ['x'] } }],
    ['payg not a boolean', { schemaVersion: 1, payg: { allow: 'yes' } }],
    ['empty rating override', { schemaVersion: 1, ratings: { 'codex-sol-high': {} } }],
  ];
  for (const [name, doc] of cases) {
    const verdict = validateLayers({ canonical: canonicalLayer(), overlays: [overlayLayer('user', doc)] });
    assert.equal(verdict.ok, false, `${name}: validate accepted it`);
    assert.equal(verdict.errors[0].code, 'overlay-invalid', name);
    assert.equal(verdict.errors[0].layer, 'user', `${name}: the finding must name the layer`);
  }
});

test('validate refuses an overlay that names something the catalog does not have', () => {
  const cases = [
    ['ratings', { schemaVersion: 1, ratings: { 'no-such-tuple': { quality: 3 } } }],
    ['priority', { schemaVersion: 1, priority: { 'no-such-tuple': 10 } }],
    ['deny.tuples', { schemaVersion: 1, deny: { tuples: ['no-such-tuple'] } }],
    ['deny.harnesses', { schemaVersion: 1, deny: { harnesses: ['aider'] } }],
    ['deny.models', { schemaVersion: 1, deny: { models: ['gpt-4'] } }],
    ['allow.efforts', { schemaVersion: 1, allow: { efforts: ['deep-think'] } }],
  ];
  for (const [name, doc] of cases) {
    const verdict = validateLayers({ canonical: canonicalLayer(), overlays: [overlayLayer('workspace', doc)] });
    assert.equal(verdict.ok, false, `${name}: validate accepted it`);
    assert.equal(verdict.errors[0].code, 'overlay-invalid', name);
  }
});

test('validate refuses weights that do not sum to 100, and rules that both allow and deny a name', () => {
  const weights = validateLayers({
    canonical: canonicalLayer(),
    overlays: [overlayLayer('user', {
      schemaVersion: 1,
      weights: { economy: { quality: 20, speed: 10, quotaCost: 50, remaining: 15 } },
    })],
  });
  assert.equal(weights.ok, false);
  assert.ok(weights.errors.some((e) => e.message.includes('sum to 95')), weights.errors.map((e) => e.message).join(' | '));

  const contradiction = validateLayers({
    canonical: canonicalLayer(),
    overlays: [overlayLayer('user', {
      schemaVersion: 1,
      allow: { harnesses: ['codex', 'claude'] },
      deny: { harnesses: ['codex'] },
    })],
  });
  assert.equal(contradiction.ok, false);
  assert.ok(contradiction.errors.some((e) => e.message.includes('both allowed and denied')));

  // Across layers, too: the contradiction is between the MERGED lists.
  const acrossLayers = validateLayers({
    canonical: canonicalLayer(),
    overlays: [
      overlayLayer('user', { schemaVersion: 1, allow: { models: ['claude-opus-5'] } }),
      overlayLayer('workspace', { schemaVersion: 1, deny: { models: ['claude-opus-5'] } }),
    ],
  });
  assert.equal(acrossLayers.ok, false);
  assert.ok(acrossLayers.errors.some((e) => e.message.includes('both allowed and denied')));
});

test('a stale assessedAt is a warning and never an exclusion', () => {
  const stale = clone(CATALOG);
  const old = new Date(Date.parse('2026-09-05T00:00:00.000Z') - (STALE_RATING_DAYS + 10) * 86_400_000);
  stale.tuples[0].assessedAt = old.toISOString();
  const now = Date.parse('2026-09-05T00:00:00.000Z');

  const merged = mergeRouting({ canonical: stale, now });
  assert.equal(merged.tuples.length, stale.tuples.length, 'a stale rating must not drop a tuple');
  const warning = merged.warnings.find((w) => w.code === 'stale-rating');
  assert.ok(warning, 'no stale-rating warning');
  assert.equal(warning.tupleId, stale.tuples[0].id);
  assert.equal(warning.ageDays, STALE_RATING_DAYS + 10);

  const verdict = validateLayers({ canonical: canonicalLayer(stale), now });
  assert.equal(verdict.ok, true, 'a stale rating must not make the catalog invalid');
  assert.ok(verdict.warnings.some((w) => w.code === 'stale-rating'));

  // Freshly assessed: no warning at all.
  assert.deepEqual(mergeRouting({ canonical: CATALOG, now }).warnings, []);
});

test('the canonical-priority convention is enforced as a warning, not an error', () => {
  const duplicate = clone(CATALOG);
  duplicate.tuples[1].priority = duplicate.tuples[0].priority;
  const dup = validateLayers({ canonical: canonicalLayer(duplicate) });
  assert.equal(dup.ok, true, 'a priority collision still routes — it is a convention, not a schema rule');
  assert.ok(dup.warnings.some((w) => w.code === 'priority-duplicate'));

  // Quality must not rise as priority rises inside a harness block.
  const inverted = clone(CATALOG);
  const claudeTuples = inverted.tuples.filter((t) => t.harness === 'claude').sort((a, b) => a.priority - b.priority);
  const top = claudeTuples[0].priority;
  claudeTuples[0].priority = claudeTuples[claudeTuples.length - 1].priority;
  claudeTuples[claudeTuples.length - 1].priority = top;
  const order = validateLayers({ canonical: canonicalLayer(inverted) });
  assert.equal(order.ok, true);
  assert.ok(order.warnings.some((w) => w.code === 'priority-not-canonical'));
});

test('validate reports a broken file instead of throwing — that is when it is run', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'promptobus-routing-'));
  try {
    const file = path.join(dir, 'user.json');
    writeFileSync(file, '{ "schemaVersion": 1, ');
    const verdict = validate({ host: hostWith([{ id: 'user', path: file }]) });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.errors[0].code, 'overlay-invalid');
    assert.equal(verdict.errors[0].layer, 'user');
    assert.ok(verdict.errors[0].message.startsWith('not valid JSON'));

    const missing = validate({ host: hostWith([]), catalogFile: path.join(dir, 'nowhere.json') });
    assert.equal(missing.ok, false);
    assert.equal(missing.errors[0].code, 'catalog-invalid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an overlay that is present and unreadable stops the load — it does not become "absent"', () => {
  // Absent and broken must not look alike. A person edited that file and got
  // the syntax wrong; treating it as missing would apply a policy they believe
  // is in force, and nothing would say otherwise.
  const dir = mkdtempSync(path.join(tmpdir(), 'promptobus-routing-'));
  try {
    const file = path.join(dir, 'user.json');
    writeFileSync(file, '{ "schemaVersion": 1, "reviewerQualityFloor": ');
    const host = hostWith([{ id: 'user', path: file }]);
    assert.throws(() => loadCatalog({ host }), GateError);
    assert.throws(() => loadCatalog({ host }), /is not valid JSON/);

    // The same file, readable again: the load goes through, so the refusal was
    // about the content and not about the path.
    writeFileSync(file, '{ "schemaVersion": 1, "reviewerQualityFloor": 2 }');
    assert.equal(loadCatalog({ host }).policy.reviewerQualityFloor, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every warning carries code and message, the two fields a decision may copy', () => {
  // `warnings` in decision.schema.json is closed on `code` and `message`. A
  // warning without both would need PB-18 to translate it, and a translation
  // is where a code quietly becomes a different code.
  const doctored = clone(CATALOG);
  doctored.tuples[0].assessedAt = '2020-01-01T00:00:00.000Z';
  doctored.tuples[2].priority = doctored.tuples[1].priority;
  const verdict = validateLayers({ canonical: canonicalLayer(doctored), now: Date.parse('2026-09-05T00:00:00.000Z') });

  const codes = new Set(verdict.warnings.map((w) => w.code));
  assert.ok(codes.has('stale-rating'), 'no stale-rating warning to check');
  assert.ok(codes.has('priority-duplicate'), 'no priority-duplicate warning to check');
  for (const warning of verdict.warnings) {
    assert.equal(typeof warning.code, 'string', JSON.stringify(warning));
    assert.ok(warning.code.length, JSON.stringify(warning));
    assert.equal(typeof warning.message, 'string', JSON.stringify(warning));
    assert.ok(warning.message.length, `${warning.code}: an empty message is not a message`);
  }
});

test('a finding names the layer that wrote the key it is about', () => {
  // 03-cli and ADR-003 promise a layer id — "denied by overlay \"workspace\"" —
  // so the merge records who last wrote each weight set and each allow/deny
  // list. Without that the only honest answer would be the whole stack.
  const weights = validateLayers({
    canonical: canonicalLayer(),
    overlays: [
      overlayLayer('user', { schemaVersion: 1, reviewerQualityFloor: 3 }),
      overlayLayer('workspace', {
        schemaVersion: 1,
        weights: { economy: { quality: 20, speed: 10, quotaCost: 50, remaining: 15 } },
      }),
    ],
  });
  const weightError = weights.errors.find((e) => e.at === 'weights.economy');
  assert.ok(weightError, 'no weight-sum finding');
  assert.equal(weightError.layer, 'workspace', 'the finding must name the layer that wrote that set');

  const contradiction = validateLayers({
    canonical: canonicalLayer(),
    overlays: [
      overlayLayer('user', { schemaVersion: 1, allow: { models: ['claude-opus-5'] } }),
      overlayLayer('workspace', { schemaVersion: 1, deny: { models: ['claude-opus-5'] } }),
    ],
  });
  const denyError = contradiction.errors.find((e) => e.at === 'deny.models');
  assert.ok(denyError, 'no contradiction finding');
  assert.equal(denyError.layer, 'workspace', 'deny is applied last, so the deny layer is named');
  assert.ok(denyError.message.includes('"user"'), 'the message must also name where the allow came from');

  // Nobody touched `quality`, so a finding about it would name the defaults.
  const untouched = mergeRouting({ canonical: CATALOG, overlays: [] });
  assert.equal(untouched.sources.weights.quality, DEFAULTS);
  assert.equal(untouched.sources.deny.models, DEFAULTS);
});

test('a tuple whose id is a prototype key is not patched by an overlay that never named it', () => {
  // `ratings` and `priority` are plain objects keyed by a tuple id, and
  // TUPLE_ID_RE admits `constructor` — it is lower-case, and the schema has no
  // reason to forbid it. A bare `priority[tuple.id]` on such a tuple returns
  // Object.prototype.constructor, which is not undefined, so the tuple's
  // priority silently becomes a FUNCTION and the tie-break stops being a
  // number. The overlay below names a different tuple entirely.
  const doctored = clone(CATALOG);
  doctored.tuples[0] = { ...doctored.tuples[0], id: 'constructor' };
  const merged = mergeRouting({
    canonical: doctored,
    overlays: [overlayLayer('user', {
      schemaVersion: 1,
      ratings: { 'codex-sol-high': { speed: 1 } },
      priority: { 'codex-sol-high': 7 },
    })],
  });

  const trap = merged.tuples.find((t) => t.id === 'constructor');
  assert.equal(typeof trap.priority, 'number', 'the prototype leaked into priority');
  assert.equal(trap.priority, doctored.tuples[0].priority, 'a tuple nobody named must keep its priority');
  assert.equal(typeof trap.ratings.quality, 'number', 'the prototype leaked into ratings');
  // The tuple that WAS named still gets its patch, so the guard did not simply
  // switch patching off.
  const named = merged.tuples.find((t) => t.id === 'codex-sol-high');
  assert.equal(named.priority, 7);
  assert.equal(named.ratings.speed, 1);
});

// --- parity: the hand-written grammar and the schema are one grammar ----------

test('the hand-written grammar agrees with the JSON Schema on the same documents', () => {
  // Production has no ajv. The corpus below is deliberately the same set of
  // mutations the refusal checks above use: what those prove is refused, this
  // one proves is refused for the SAME reason the schema would refuse it.
  const catalogDocs = [
    CATALOG,
    { ...clone(CATALOG), schemaVersion: 2 },
    { ...clone(CATALOG), updated: '2026-09-05' },
    { ...clone(CATALOG), notes: 'hello' },
    { schemaVersion: 1, updated: CATALOG.updated, tuples: [] },
  ];
  for (const mutate of [
    (c) => { c.tuples[0].ratings.quality = 6; },
    (c) => { c.tuples[0].ratings.speed = 2.5; },
    (c) => { c.tuples[0].roles = ['architect']; },
    (c) => { c.tuples[0].roles = []; },
    (c) => { c.tuples[0].billing = 'invoice'; },
    (c) => { c.tuples[0].prices.inputPerMTok = -1; },
    (c) => { delete c.tuples[0].prices.outputPerMTok; },
    (c) => { c.tuples[0].source = ''; },
    (c) => { c.tuples[0].id = 'Not An Id'; },
    (c) => { c.tuples[0].harness = 'Claude'; },
    (c) => { c.tuples[0].effort = ''; },
    (c) => { c.tuples[0].roleRatings = { architect: { quality: 3 } }; },
    (c) => { c.tuples[0].roleRatings = { reviewer: {} }; },
    (c) => { delete c.tuples[0].assessedAt; },
  ]) {
    const doc = clone(CATALOG);
    mutate(doc);
    catalogDocs.push(doc);
  }

  for (const [i, doc] of catalogDocs.entries()) {
    const bySchema = ajvCatalog(doc) === true;
    const byHand = checkCatalogShape(doc).length === 0;
    assert.equal(byHand, bySchema,
      `catalog document ${i}: schema says ${bySchema}, the hand-written grammar says ${byHand} `
      + `(${ajv.errorsText(ajvCatalog.errors)})`);
  }

  const overlayDocs = [
    { schemaVersion: 1 },
    { schemaVersion: 1, note: 'a person wrote this' },
    { schemaVersion: 1, weights: { balanced: { quality: 50, speed: 20, quotaCost: 15, remaining: 15 } } },
    { schemaVersion: 1, allow: { harnesses: ['claude'] }, deny: { models: ['claude-opus-5'] } },
    { schemaVersion: 1, ratings: { 'codex-sol-high': { speed: 4 } }, priority: { 'codex-sol-high': 5 } },
    { schemaVersion: 1, payg: { allow: true } },
    { schemaVersion: 2 },
    { schemaVersion: 1, weight: {} },
    { schemaVersion: 1, weights: { thorough: { quality: 25, speed: 25, quotaCost: 25, remaining: 25 } } },
    { schemaVersion: 1, weights: { speed: { quality: 50, speed: 50 } } },
    { schemaVersion: 1, weights: { speed: { quality: 150, speed: 0, quotaCost: 0, remaining: 0 } } },
    { schemaVersion: 1, reviewerQualityFloor: 9 },
    { schemaVersion: 1, reviewerQualityFloor: 2.5 },
    { schemaVersion: 1, deny: {} },
    { schemaVersion: 1, deny: { models: [] } },
    { schemaVersion: 1, deny: { models: ['claude-opus-5', 'claude-opus-5'] } },
    { schemaVersion: 1, deny: { providers: ['x'] } },
    { schemaVersion: 1, payg: { allow: 'yes' } },
    { schemaVersion: 1, payg: { enabled: true } },
    { schemaVersion: 1, ratings: {} },
    { schemaVersion: 1, ratings: { 'codex-sol-high': {} } },
    { schemaVersion: 1, ratings: { 'Codex Sol': { quality: 3 } } },
    { schemaVersion: 1, priority: { 'codex-sol-high': -1 } },
    { schemaVersion: 1, penalties: { unknownAvailability: -1 } },
    { schemaVersion: 1, penalties: { unknown: 1 } },
    { schemaVersion: 1, bonuses: { reviewerDiversity: 5 } },
    { schemaVersion: 1, bonuses: { somethingElse: 5 } },
  ];
  for (const [i, doc] of overlayDocs.entries()) {
    const bySchema = ajvOverlay(doc) === true;
    const byHand = checkOverlayShape(doc).length === 0;
    assert.equal(byHand, bySchema,
      `overlay document ${i}: schema says ${bySchema}, the hand-written grammar says ${byHand} `
      + `(${ajv.errorsText(ajvOverlay.errors)})`);
  }
});

test('the documented example overlay is a document the mechanism accepts', () => {
  // The guide hands a person a file to copy. A copyable example that does not
  // validate is worse than none: they would learn the shape from a broken one.
  const guide = readFileSync(path.join(ROOT, 'docs', 'guides', 'model-routing.md'), 'utf8');
  const blocks = [...guide.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length, 'the guide carries no JSON example');
  const examples = blocks.map((b) => JSON.parse(b)).filter((d) => d.schemaVersion === 1 && !d.tuples);
  assert.ok(examples.length, 'the guide carries no overlay example');
  for (const doc of examples) {
    assert.equal(ajvOverlay(doc), true, ajv.errorsText(ajvOverlay.errors));
    const verdict = validateLayers({ canonical: canonicalLayer(), overlays: [overlayLayer('workspace', doc)] });
    assert.deepEqual(verdict.errors, [], 'the example overlay does not survive validate');
  }
});

test('the package ships the catalog', () => {
  const pkg = readJson(path.join(ROOT, 'package.json'));
  assert.ok(pkg.files.includes('models'), 'models/ is not in package.json files — the catalog would not ship');
  assert.ok(CATALOG_FILE.endsWith(path.join('models', 'catalog.json')));
});
