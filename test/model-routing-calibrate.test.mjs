// `models calibrate` — reading the local telemetry back against the shipped
// catalog. Run: npm test
//
// Two halves, and they are checked apart because they fail apart.
//
// **The pure half** ([calibrate.js](../lib/model-routing/calibrate.js)) is a
// function of records and a catalog, so every property is asserted on the
// fixture with no host, no disk and no clock: the grouping key, the alias
// resolution, the threshold, the medians, and the arithmetic of a proposed band.
// A fixture of 32 records ([fixtures/model-routing/telemetry.jsonl]
// (fixtures/model-routing/telemetry.jsonl)) carries one case of each shape the
// ADR names — an aliased key, a key below the threshold, a key nothing rates, a
// dismissed run, runs with no usable window, and a run whose windows reset
// mid-flight. The telemetry file of whoever runs the suite is deliberately never
// read: a suite that read a person's own history would go red on the day they
// close a task, and the file is theirs.
//
// **The command half** is the part with a consequence, and it is checked by what
// is on disk afterwards. `--write` is the one exception ADR-005 makes to the
// user layer being read-only for the tool, and the exception is only as narrow
// as these checks keep it: nothing without an agreement, nothing but `ratings`,
// and every other key of the person's file still there.
//
// Mutation probes for this file: lower `EVIDENCE_THRESHOLD` to 1 (the threshold
// checks go red); make `moveFor` return 0 always (the band arithmetic goes red);
// drop the `dismissedBeforeDone` half of `acceptedPiece` (the dismissed-run
// median goes red); let `--write` skip the TTY refusal (the non-interactive
// check goes red).
// Home diversion before any import that is not a Node built-in: a module that
// resolved a home path at load would see the real one. [home.mjs](home.mjs) says
// what it applies; the sentinel in tmpdir-sweep.test.mjs keeps the order.
import './home.mjs';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { GateError } from '../dist/index.js';
import {
  BAND_RATIO, EVIDENCE_THRESHOLD, MAX_MOVE, SURPRISE_ONE, SURPRISE_TWO,
  acceptedPiece, calibrate, median, moveFor, renderCalibration, resolveModel, windowDelta,
} from '../lib/model-routing/calibrate.js';
import { CATALOG_FILE } from '../lib/model-routing/catalog.js';
import { telemetryFileOf } from '../lib/model-routing/telemetry.js';
import { hostOf } from '../lib/host.js';
import { models } from '../lib/models.js';
import { writeHostConfig } from './sandbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'model-routing', 'telemetry.jsonl');
const RECORDS = readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const TUPLES = JSON.parse(readFileSync(CATALOG_FILE, 'utf8')).tuples;

// The Claude dictionary as the driver hands it over. Written out rather than
// imported from `driver-claude.js`: this file stands on the shape of the
// argument, and the parity between it and the driver is the catalog suite's
// check, not this one's.
const ALIASES = {
  claude: { fable: ['claude-fable-5'], opus: ['claude-opus-5'], sonnet: ['claude-sonnet-5'] },
};

const report = () => calibrate(RECORDS, { tuples: TUPLES, aliases: ALIASES });
const keyOf = (r, harness, model, effort = null) => r.keys
  .find((k) => k.harness === harness && k.model === model && k.effort === effort);

/** A stream that keeps what a command wrote. */
function sink() {
  const chunks = [];
  return { write: (c) => chunks.push(c), get text() { return chunks.join(''); } };
}

test('median takes the middle, and the mean of the middle pair', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  // A sample that is only nulls is no sample: the ADR's "a measurement that is
  // not there omits its rating" starts here.
  assert.equal(median([null, undefined, NaN]), null);
});

test('a run contributes the LARGEST of its windows, and a window that went backwards contributes nothing', () => {
  assert.equal(windowDelta({
    windows: [
      { usedPercentAtSpawn: 20, usedPercentAtEnd: 30 },
      { usedPercentAtSpawn: 5, usedPercentAtEnd: 7 },
    ],
  }), 10);
  // A stale cache entry left no end reading — not a delta of zero.
  assert.equal(windowDelta({ windows: [{ usedPercentAtSpawn: 20, usedPercentAtEnd: null }] }), null);
  // The window reset mid-run: dropped rather than clamped to zero, which would
  // read as "this run spent nothing".
  assert.equal(windowDelta({ windows: [{ usedPercentAtSpawn: 20, usedPercentAtEnd: 8 }] }), null);
  assert.equal(windowDelta({ windows: [] }), null);
});

test('an accepted piece is a run that was not dismissed and sent a result', () => {
  assert.equal(acceptedPiece({ dismissedBeforeDone: false, resultCount: 1 }), true);
  assert.equal(acceptedPiece({ dismissedBeforeDone: true, resultCount: 1 }), false);
  assert.equal(acceptedPiece({ dismissedBeforeDone: false, resultCount: 0 }), false);
});

test('an alias resolves through the driver dictionary, and only on its own harness', () => {
  assert.deepEqual(resolveModel('claude', 'opus', ALIASES), { model: 'claude-opus-5', alias: 'opus' });
  assert.deepEqual(resolveModel('claude', 'claude-opus-5', ALIASES), { model: 'claude-opus-5', alias: null });
  // The same word at a harness that publishes no such alias is a model name.
  assert.deepEqual(resolveModel('cursor', 'opus', ALIASES), { model: 'opus', alias: null });
  // An alias naming two ids is not a resolution.
  assert.deepEqual(resolveModel('claude', 'both', { claude: { both: ['a', 'b'] } }), { model: 'both', alias: null });
});

test('records group by (harness, model, effort) with aliases folded in — never by tuple', () => {
  const r = report();
  // Every record of the fixture carries `tuple: null`, which is the shape of an
  // explicit-flag lift. Grouping by tuple would have produced one key.
  assert.equal(RECORDS.every((x) => x.tuple === null), true);
  assert.equal(r.keys.length, 6);
  const opus = keyOf(r, 'claude', 'claude-opus-5', 'xhigh');
  // Four runs typed `--model opus` and four typed the full id: one key of eight.
  assert.equal(opus.runs, 8);
  assert.deepEqual(opus.aliasesSeen, ['opus']);
  assert.equal(opus.tuple, 'claude-opus-xhigh');
});

test('a dismissed run counts as a run and as spend, and never as a finished piece', () => {
  const sonnet = keyOf(report(), 'claude', 'claude-sonnet-5', 'xhigh');
  assert.equal(sonnet.runs, 6);
  assert.equal(sonnet.dismissed, 1);
  assert.equal(sonnet.acceptedPieces, 5);
  // The dismissed run lasted 9000 s — the time until someone stopped it, not the
  // time to a finished piece. Its window delta of 24 pp is still real spend.
  assert.equal(sonnet.durationSamples, 5);
  assert.equal(sonnet.durationSec, 2000);
  assert.equal(sonnet.windowSamples, 6);
  assert.equal(sonnet.windowDelta, 20);
});

test('below the threshold nothing is proposed, and the line says how far short it is', () => {
  const fable = keyOf(report(), 'claude', 'claude-fable-5', 'xhigh');
  assert.equal(fable.runs, 2);
  assert.equal(fable.eligible, false);
  assert.equal(fable.proposal, null);
  assert.equal(fable.note, `insufficient data: 2 of ${EVIDENCE_THRESHOLD}`);
  assert.match(renderCalibration(report()), /insufficient data: 2 of 5 — nothing proposed/);
});

test('runs on a model the catalog does not rate get medians and no proposal', () => {
  const haiku = keyOf(report(), 'claude', 'claude-haiku-9', 'high');
  assert.equal(haiku.runs, 6);
  assert.equal(haiku.catalog, null);
  assert.equal(haiku.tuple, null);
  assert.equal(haiku.proposal, null);
  assert.match(haiku.note, /no catalog row rates claude\/claude-haiku-9\/high/);
  // And it cannot become the pivot, however many runs it has.
  assert.notEqual(report().pivot.model, 'claude-haiku-9');
});

test('the pivot is the most-observed eligible key and keeps its catalog bands', () => {
  const r = report();
  assert.deepEqual(r.pivot, {
    harness: 'claude', model: 'claude-opus-5', effort: 'xhigh', tuple: 'claude-opus-xhigh', runs: 8,
  });
  const opus = keyOf(r, 'claude', 'claude-opus-5', 'xhigh');
  assert.equal(opus.proposal.pivot, true);
  assert.equal(opus.proposal.speed.band, opus.catalog.speed);
  assert.equal(opus.proposal.quotaCost.band, opus.catalog.quotaCost);
  // And it is therefore never in the merge payload.
  assert.equal(Object.hasOwn(r.ratings, 'claude-opus-xhigh'), false);
});

test('a ratio moves a band only when it surprises the catalog, and never by more than two', () => {
  assert.equal(moveFor(1), 0);
  assert.equal(moveFor(SURPRISE_ONE), 1);
  assert.equal(moveFor(SURPRISE_ONE - 0.01), 0);
  assert.equal(moveFor(SURPRISE_TWO), MAX_MOVE);
  assert.equal(moveFor(100), MAX_MOVE);
  assert.equal(moveFor(1 / SURPRISE_ONE), -1);
  assert.equal(moveFor(1 / SURPRISE_TWO), -MAX_MOVE);
  assert.equal(moveFor(0), 0);
  assert.equal(moveFor(NaN), 0);
});

test('a key twice as slow as the pivot at the same speed band loses one band; its spend gains two', () => {
  const sonnet = keyOf(report(), 'claude', 'claude-sonnet-5', 'xhigh');
  // speed: both rows band 2, so the catalog implies the same duration. Measured
  // 2000 s against the pivot's 1000 s is a 2× surprise — one band down.
  assert.equal(sonnet.catalog.speed, 2);
  assert.equal(sonnet.proposal.speed.ratio, 2);
  assert.equal(sonnet.proposal.speed.implied, 1);
  assert.equal(sonnet.proposal.speed.band, 1);
  // quotaCost: band 2 against the pivot's 5 implies 1.25^-3 of its window
  // movement; the run actually moved twice as much — two bands up.
  assert.equal(sonnet.catalog.quotaCost, 2);
  assert.equal(sonnet.proposal.quotaCost.implied, BAND_RATIO ** -3);
  assert.equal(sonnet.proposal.quotaCost.band, 4);
});

test('a key the local runs agree with keeps every band, and writes no overlay line', () => {
  const r = report();
  const sol = keyOf(r, 'codex', 'gpt-5.6-sol', 'max');
  assert.equal(sol.proposal.speed.move, 0);
  assert.equal(sol.proposal.quotaCost.move, 0);
  assert.equal(sol.proposal.speed.band, sol.catalog.speed);
  assert.equal(Object.hasOwn(r.ratings, 'codex-sol-max'), false);
});

test('no usable window evidence omits quotaCost alone and says why', () => {
  const gemini = keyOf(report(), 'cursor', 'gemini-3.8-flash-high', null);
  assert.equal(gemini.runs, 5);
  assert.equal(gemini.windowSamples, 0);
  assert.equal(gemini.withoutWindows, 5);
  assert.equal(gemini.proposal.quotaCost.band, null);
  assert.match(gemini.proposal.quotaCost.why, /no usable window delta/);
  // The duration evidence is untouched by the missing windows.
  assert.equal(gemini.proposal.speed.band, 9);
  assert.deepEqual(report().ratings['cursor-gemini-38-high'], { speed: 9 });
});

test('the merge payload carries only ratings that moved', () => {
  assert.deepEqual(report().ratings, {
    'claude-sonnet-xhigh': { speed: 1, quotaCost: 4 },
    'cursor-gemini-38-high': { speed: 9 },
  });
});

test('the printed proposal carries the numbers behind it and never a quality rating', () => {
  const text = renderCalibration(report());
  assert.match(text, /pivot \(local anchor\): claude · claude-opus-5 · xhigh — 8 run\(s\)/);
  assert.match(text, /speed: 2 → 1 \(catalog 2\)/);
  assert.match(text, /quotaCost: 2 → 4 \(catalog 2\)/);
  assert.match(text, /median duration 2000s over 5 sample\(s\)/);
  assert.match(text, /median window delta 20 pp over 6 sample\(s\)/);
  assert.match(text, /quality is not proposed from telemetry/);
  // The overlay block is what a person pastes, and it is the merge payload.
  assert.match(text, /"ratings"/);
  assert.equal(text.includes('"quality"'), false);
});

test('an empty file proposes nothing and refuses nothing', () => {
  const r = calibrate([], { tuples: TUPLES, aliases: ALIASES });
  assert.equal(r.keys.length, 0);
  assert.equal(r.pivot, null);
  assert.deepEqual(r.ratings, {});
  assert.match(renderCalibration(r), /no key reaches the threshold/);
});

test('the comparison is against the SHIPPED catalog, so a second run on one file proposes the same thing', () => {
  // The walk this prevents: with the merged stack as the base, the person's own
  // override becomes the next comparison's starting band, and each run steps
  // again — up to two bands a run — until the rating reaches whatever the
  // measured ratio implies, with nothing new measured in between.
  const first = report();
  assert.deepEqual(first.ratings['claude-sonnet-xhigh'], { speed: 1, quotaCost: 4 });

  // The overlay a `--write` of that first run leaves behind.
  const overlaid = JSON.parse(JSON.stringify(TUPLES));
  for (const t of overlaid) {
    if (t.id === 'claude-sonnet-xhigh') Object.assign(t.ratings, first.ratings['claude-sonnet-xhigh']);
  }
  const second = calibrate(RECORDS, { tuples: TUPLES, overlayTuples: overlaid, aliases: ALIASES });
  assert.deepEqual(second.ratings['claude-sonnet-xhigh'], { speed: 1, quotaCost: 4 },
    'the second run must propose what the first did, not a step past it');

  const key = keyOf(second, 'claude', 'claude-sonnet-5', 'xhigh');
  assert.deepEqual(key.catalog, { quality: 7, speed: 2, quotaCost: 2 }, 'catalog bands, not overlaid ones');
  assert.deepEqual(key.override, { speed: 1, quotaCost: 4 });
  // …and the person is told both numbers rather than one standing in for the other.
  const text = renderCalibration(second);
  assert.match(text, /quotaCost: 2 → 4 \(catalog 2, your overlay 4\)/);
  assert.match(text, /compared against the SHIPPED catalog/);

  // Had the merged stack been the base, quotaCost would have walked 2 → 4 → 5.
  const walked = calibrate(RECORDS, { tuples: overlaid, aliases: ALIASES });
  assert.equal(walked.ratings['claude-sonnet-xhigh'].quotaCost, 5,
    'the fixture must actually distinguish the two bases, or this test proves nothing');
});

test('a key with no overlay reports none, and the line stays a plain catalog band', () => {
  const r = calibrate(RECORDS, { tuples: TUPLES, overlayTuples: TUPLES, aliases: ALIASES });
  assert.equal(keyOf(r, 'claude', 'claude-sonnet-5', 'xhigh').override, null);
  assert.match(renderCalibration(r), /quotaCost: 2 → 4 \(catalog 2\)/);
});

test('a median of zero is below the measurement resolution, and proposes nothing', () => {
  // `usedPercent` arrives as whole percent and `durationSec` as whole seconds,
  // so a median of 0 says the runs were too small to register. Reading it as
  // "far cheaper than the catalog" would propose a two-band drop from an
  // absence of evidence — the zero-pivot case seen from the other side.
  const flat = RECORDS.filter((r) => r.model === 'claude-sonnet-5').map((r) => ({
    ...r,
    windows: r.windows.map((w) => ({ ...w, usedPercentAtEnd: w.usedPercentAtSpawn })),
  }));
  const r = calibrate([...RECORDS.filter((x) => x.model !== 'claude-sonnet-5'), ...flat],
    { tuples: TUPLES, aliases: ALIASES });
  const key = keyOf(r, 'claude', 'claude-sonnet-5', 'xhigh');
  assert.equal(key.windowDelta, 0);
  assert.equal(key.windowSamples, 6, 'the zeros are samples — they are read, and then declined');
  assert.equal(key.proposal.quotaCost.band, null);
  assert.match(key.proposal.quotaCost.why, /below what this measurement can resolve/);
  assert.equal(Object.hasOwn(r.ratings['claude-sonnet-xhigh'] ?? {}, 'quotaCost'), false);
  // The duration evidence is untouched by it.
  assert.equal(key.proposal.speed.band, 1);
});

// --- the command ---------------------------------------------------------

/** A workspace with the fixture as this host's telemetry file. */
function workspace() {
  const sb = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'promptobus-routing-calibrate-')));
  const ws = path.join(sb, 'ws');
  mkdirSync(ws, { recursive: true });
  writeFileSync(path.join(ws, 'AGENTS.md'), 'workspace\n');
  writeHostConfig(ws, { tools: ['claude', 'cursor', 'codex'] });
  const host = hostOf(ws);
  const file = telemetryFileOf(host);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, readFileSync(FIXTURE, 'utf8'));
  // The user layer lives under HOME, which the suite diverts ONCE per file — so
  // it is shared by every test here and a leftover from the write checks would
  // make the next one's "no file" assertion meaningless. Cleared on both ends.
  const user = host.routingPaths().overlays.find((l) => l.id === 'user');
  mkdirSync(path.dirname(user.path), { recursive: true });
  rmSync(user.path, { force: true });
  return {
    sb,
    host,
    user,
    drop: () => {
      rmSync(user.path, { force: true });
      rmSync(sb, { recursive: true, force: true });
    },
  };
}

const never = () => { throw new Error('the command asked when it must not'); };

test('calibrate prints the proposal and writes nothing', async () => {
  const w = workspace();
  try {
    const out = sink();
    const code = await models(w.host, {
      subcommand: 'calibrate', output: out, ask: never, stdin: { isTTY: false },
    });
    assert.equal(code, 0);
    assert.match(out.text, /claude-sonnet-xhigh/);
    assert.match(out.text, /speed: 2 → 1/);
    assert.equal(existsSync(w.user.path), false);
  } finally { w.drop(); }
});

test('--json prints the report as one document', async () => {
  const w = workspace();
  try {
    const out = sink();
    await models(w.host, {
      subcommand: 'calibrate', json: true, output: out, ask: never, stdin: { isTTY: false },
    });
    const doc = JSON.parse(out.text);
    assert.equal(doc.threshold, EVIDENCE_THRESHOLD);
    assert.equal(doc.records, RECORDS.length);
    assert.equal(doc.keys.length, 6);
    assert.deepEqual(doc.ratings, {
      'claude-sonnet-xhigh': { speed: 1, quotaCost: 4 },
      'cursor-gemini-38-high': { speed: 9 },
    });
    assert.equal(doc.file, telemetryFileOf(w.host));
    assert.equal(existsSync(w.user.path), false);
  } finally { w.drop(); }
});

test('--write without a terminal and without --yes refuses, and leaves no file', async () => {
  const w = workspace();
  try {
    await assert.rejects(
      models(w.host, {
        subcommand: 'calibrate', write: true, output: sink(), ask: never, stdin: { isTTY: false },
      }),
      (e) => e instanceof GateError && /stdin is not a terminal/.test(e.message) && /--yes/.test(e.message),
    );
    assert.equal(existsSync(w.user.path), false);
  } finally { w.drop(); }
});

test('--write on a terminal asks, and a no writes nothing', async () => {
  const w = workspace();
  try {
    let asked = null;
    const code = await models(w.host, {
      subcommand: 'calibrate',
      write: true,
      output: sink(),
      stdin: { isTTY: true },
      ask: (q) => { asked = q; return 'n'; },
    });
    assert.equal(code, 0);
    assert.match(asked, /merge 2 rating override\(s\)/);
    assert.match(asked, new RegExp(w.user.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(existsSync(w.user.path), false);
  } finally { w.drop(); }
});

test('--write on a terminal with a yes merges only ratings, and keeps every other key', async () => {
  const w = workspace();
  try {
    // The person's own file: a strategy default, a deny list, and a rating they
    // set by hand on a tuple calibrate also proposes.
    writeFileSync(w.user.path, `${JSON.stringify({
      schemaVersion: 2,
      note: 'the person wrote this',
      defaults: { strategy: 'balance' },
      deny: { models: ['gpt-5.4-mini'] },
      ratings: { 'claude-sonnet-xhigh': { quality: 8 }, 'codex-sol-max': { speed: 4 } },
    }, null, 2)}\n`);
    const code = await models(w.host, {
      subcommand: 'calibrate', write: true, output: sink(), stdin: { isTTY: true }, ask: () => 'y',
    });
    assert.equal(code, 0);
    const doc = JSON.parse(readFileSync(w.user.path, 'utf8'));
    assert.equal(doc.note, 'the person wrote this');
    assert.deepEqual(doc.defaults, { strategy: 'balance' });
    assert.deepEqual(doc.deny, { models: ['gpt-5.4-mini'] });
    assert.equal(doc.schemaVersion, 2);
    // Per tuple AND per rating: the hand-set `quality` survives beside the two
    // calibrated ones, and a tuple calibrate did not propose is untouched.
    assert.deepEqual(doc.ratings, {
      'claude-sonnet-xhigh': { quality: 8, speed: 1, quotaCost: 4 },
      'codex-sol-max': { speed: 4 },
      'cursor-gemini-38-high': { speed: 9 },
    });
  } finally { w.drop(); }
});

test('--yes writes with no terminal, and raises a version 1 overlay to 2 with the ratings', async () => {
  const w = workspace();
  try {
    // A policy-only v1 overlay is lawful today (ADR-005). The moment it carries
    // ratings it must be version 2, or the stack it belongs to stops loading.
    writeFileSync(w.user.path, `${JSON.stringify({ schemaVersion: 1, defaults: { strategy: 'balance' } }, null, 2)}\n`);
    const code = await models(w.host, {
      subcommand: 'calibrate', write: true, yes: true, output: sink(), stdin: { isTTY: false }, ask: never,
    });
    assert.equal(code, 0);
    const doc = JSON.parse(readFileSync(w.user.path, 'utf8'));
    assert.equal(doc.schemaVersion, 2);
    assert.deepEqual(doc.defaults, { strategy: 'balance' });
    assert.deepEqual(doc.ratings, {
      'claude-sonnet-xhigh': { speed: 1, quotaCost: 4 },
      'cursor-gemini-38-high': { speed: 9 },
    });
  } finally { w.drop(); }
});

test('--write with nothing to write creates no file and says so', async () => {
  const w = workspace();
  try {
    // Two records only: nothing reaches the threshold, so nothing moves.
    writeFileSync(telemetryFileOf(w.host), RECORDS.slice(0, 2).map((r) => JSON.stringify(r)).join('\n'));
    const code = await models(w.host, {
      subcommand: 'calibrate', write: true, yes: true, output: sink(), stdin: { isTTY: false }, ask: never,
    });
    assert.equal(code, 0);
    assert.equal(existsSync(w.user.path), false);
  } finally { w.drop(); }
});

test('no telemetry file at all is a report, not a refusal', async () => {
  const w = workspace();
  try {
    rmSync(telemetryFileOf(w.host));
    const out = sink();
    const code = await models(w.host, {
      subcommand: 'calibrate', output: out, ask: never, stdin: { isTTY: false },
    });
    assert.equal(code, 0);
    assert.match(out.text, /0 record\(s\) over 0 key\(s\)/);
  } finally { w.drop(); }
});

test('a truncated last line is skipped and the rest of the history is still read', async () => {
  const w = workspace();
  try {
    writeFileSync(telemetryFileOf(w.host), `${readFileSync(FIXTURE, 'utf8')}{"harness":"claude","mod`);
    const out = sink();
    await models(w.host, {
      subcommand: 'calibrate', json: true, output: out, ask: never, stdin: { isTTY: false },
    });
    const doc = JSON.parse(out.text);
    assert.equal(doc.skipped, 1);
    assert.equal(doc.records, RECORDS.length);
  } finally { w.drop(); }
});

test('the COMMAND compares against the shipped catalog even when the user overlay already overrides', async () => {
  // The pure half of this is pinned above; what this one holds is the wiring —
  // `calibrateCommand` reads the shipped catalog and the merged stack
  // separately and hands them over in that order. With no overlay on disk the
  // two are the same document, so every other command test here would stay
  // green if the merged stack were passed as the comparison base. This is the
  // case where they differ.
  const w = workspace();
  try {
    // Exactly what a first `--write` leaves behind.
    writeFileSync(w.user.path, `${JSON.stringify({
      schemaVersion: 2,
      ratings: { 'claude-sonnet-xhigh': { speed: 1, quotaCost: 4 } },
    }, null, 2)}\n`);
    const out = sink();
    await models(w.host, {
      subcommand: 'calibrate', json: true, output: out, ask: never, stdin: { isTTY: false },
    });
    const doc = JSON.parse(out.text);
    const key = doc.keys.find((k) => k.tuple === 'claude-sonnet-xhigh');

    // The bands compared against are the shipped ones…
    assert.deepEqual(key.catalog, { quality: 7, speed: 2, quotaCost: 2 });
    // …the person's override is reported beside them, not instead of them…
    assert.deepEqual(key.override, { speed: 1, quotaCost: 4 });
    // …and the proposal is what the first run proposed, not a step past it.
    assert.deepEqual(doc.ratings['claude-sonnet-xhigh'], { speed: 1, quotaCost: 4 });

    // Applying it again is a no-op on the file rather than another step.
    const before = readFileSync(w.user.path, 'utf8');
    await models(w.host, {
      subcommand: 'calibrate', write: true, yes: true, output: sink(), stdin: { isTTY: false }, ask: never,
    });
    assert.deepEqual(
      JSON.parse(readFileSync(w.user.path, 'utf8')).ratings['claude-sonnet-xhigh'],
      JSON.parse(before).ratings['claude-sonnet-xhigh'],
      'a second --write on unchanged records must not move the rating again',
    );
  } finally { w.drop(); }
});

test('--yes without --write refuses rather than being ignored', async () => {
  const w = workspace();
  try {
    await assert.rejects(
      models(w.host, { subcommand: 'calibrate', yes: true, output: sink(), ask: never, stdin: { isTTY: false } }),
      (e) => e instanceof GateError && /there is no write to agree to/.test(e.message),
    );
    assert.equal(existsSync(w.user.path), false);
  } finally { w.drop(); }
});

test('--json puts exactly one document on stdout, write outcome included', async () => {
  const w = workspace();
  try {
    const out = sink();
    const code = await models(w.host, {
      subcommand: 'calibrate', json: true, write: true, yes: true, output: out, ask: never, stdin: { isTTY: false },
    });
    assert.equal(code, 0);
    // Parses whole: nothing was appended to it. `ok()` and `info()` write to the
    // console rather than to this stream, so prose after the document would not
    // show up here at all — what this pins is that the outcome IS in the
    // document, which is the only way a machine reader can see it.
    const doc = JSON.parse(out.text);
    assert.deepEqual(doc.write, {
      layer: 'user', path: w.user.path, tuples: 2, applied: true,
    });
    assert.deepEqual(JSON.parse(readFileSync(w.user.path, 'utf8')).ratings, {
      'claude-sonnet-xhigh': { speed: 1, quotaCost: 4 },
      'cursor-gemini-38-high': { speed: 9 },
    });
  } finally { w.drop(); }
});

test('a refused write prints nothing at all — the refusal comes before the document', async () => {
  const w = workspace();
  try {
    const out = sink();
    await assert.rejects(
      models(w.host, {
        subcommand: 'calibrate', json: true, write: true, output: out, ask: never, stdin: { isTTY: false },
      }),
      (e) => e instanceof GateError && /stdin is not a terminal/.test(e.message),
    );
    assert.equal(out.text, '',
      'a complete report on stdout beside a non-zero exit says two different things');
    assert.equal(existsSync(w.user.path), false);
  } finally { w.drop(); }
});

test('a declined write still prints the report, and the document says it was not applied', async () => {
  const w = workspace();
  try {
    const out = sink();
    const code = await models(w.host, {
      subcommand: 'calibrate', json: true, write: true, output: out, stdin: { isTTY: true }, ask: () => 'n',
    });
    assert.equal(code, 0);
    assert.equal(JSON.parse(out.text).write.applied, false);
    assert.equal(existsSync(w.user.path), false);
  } finally { w.drop(); }
});

test('an unknown subcommand names all three', async () => {
  const w = workspace();
  try {
    await assert.rejects(
      models(w.host, { subcommand: 'calibrat', output: sink() }),
      (e) => e instanceof GateError && /"validate", "strategy" and "calibrate"/.test(e.message),
    );
  } finally { w.drop(); }
});
