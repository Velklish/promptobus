// Model routing contract: the schemas, the code lists, and the golden output —
// all of it before the resolver exists. Run: npm test
//
// The subject is a CONTRACT, not behaviour: nine tasks (PB-13…PB-21) implement
// against these files, and a shape decided wrong here is decided wrong nine
// times. So the checks are of three kinds, and the kinds do not mix.
//
// 1. What is green today: every schema validates its own examples, the golden
//    fixtures validate against their schemas, and the code lists in the schemas
//    and in the reference are the SAME list read from two places. The last one
//    is the "listed once" rule of the reference made mechanical — a code added
//    to an enum and forgotten in the table (or the reverse) goes red here.
// 2. What is green today and must stay green: argv with none of the new flags
//    takes exactly today's path. That is the legacy check the plan asks for,
//    and PB-21 is the task that must not break it.
// 3. What is deliberately pending: the golden comparisons of `models --json`
//    and of `models` text output, and the help text. Those are `node:test`
//    todo entries — the runner reports them as todo and the file still exits 0
//    (see the runner header in run.mjs). Their titles say which task turns them
//    green, so a reader can tell "not written yet" from "forgotten".
//
// The golden pair is input-and-output: `catalog.json` and `snapshot.json` are
// the pinned inputs, `decision.json` and `models.txt` the pinned outputs. A
// golden output with no pinned input cannot be reproduced by the task that has
// to make it green. Two fields cannot be compared raw — the overlay paths and
// the clock-derived `ageSec` — so the fixtures carry placeholders and the
// comparison normalises them; which run produces the files, and exactly what is
// normalised, is [README.md](fixtures/model-routing/README.md) next to them.
// Normalised, not excluded: an excluded field is an unpinned field.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { liftHarness, resolveEffort, resolvePermissionMode } from '../lib/spawn.js';
import { REGISTRY, liftDriver } from '../lib/drivers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const SCHEMAS = path.join(ROOT, 'schemas', 'model-routing');
const FIXTURES = path.join(here, 'fixtures', 'model-routing');
const CLI_DOC = path.join(ROOT, 'docs', 'reference', '03-cli.md');

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const schemaFiles = readdirSync(SCHEMAS).filter((n) => n.endsWith('.schema.json')).sort();

// `strict: false` for the same reason as the protocol v1 parity file: the own
// vocabulary (`$defs` cross-references between sibling schemas, `oneOf` beside
// `null`) is suspicious to ajv in strict mode, and the subject is the verdict.
const ajv = new Ajv2020({ strict: false, allErrors: true });
for (const name of schemaFiles) ajv.addSchema(readJson(path.join(SCHEMAS, name)));
const validatorFor = (id) => {
  const v = ajv.getSchema(id);
  assert.ok(v, `no schema registered under ${id}`);
  return v;
};

// --- schemas validate their own examples ------------------------------------

test('every routing schema validates the examples it carries', () => {
  assert.ok(schemaFiles.length >= 4, `expected the four routing schemas, found ${schemaFiles.join(', ')}`);
  for (const name of schemaFiles) {
    const schema = readJson(path.join(SCHEMAS, name));
    for (const [i, example] of (schema.examples ?? []).entries()) {
      const validate = validatorFor(schema.$id);
      assert.equal(validate(example), true,
        `${name} example ${i}: ${ajv.errorsText(validate.errors)}`);
    }
  }
});

test('no routing schema is left without a document that exercises it', () => {
  // A schema with neither examples nor a fixture is a shape nobody has read
  // back. The fixture side of the pairing is named here so that adding a fifth
  // schema forces a decision rather than passing in silence.
  const byFixture = {
    'catalog.schema.json': 'catalog.json',
    'snapshot.schema.json': 'snapshot.json',
    'decision.schema.json': 'decision.json',
  };
  for (const name of schemaFiles) {
    const schema = readJson(path.join(SCHEMAS, name));
    const examples = (schema.examples ?? []).length;
    assert.ok(examples > 0 || byFixture[name],
      `${name} has no examples and no fixture — nothing validates this schema`);
  }
});

test('the golden fixtures validate against their schemas', () => {
  const pairs = [
    ['catalog.json', 'urn:promptobus:model-routing:catalog'],
    ['snapshot.json', 'urn:promptobus:model-routing:snapshot'],
    ['decision.json', 'urn:promptobus:model-routing:decision'],
  ];
  for (const [file, id] of pairs) {
    const validate = validatorFor(id);
    assert.equal(validate(readJson(path.join(FIXTURES, file))), true,
      `${file}: ${ajv.errorsText(validate.errors)}`);
  }
});

// --- the code lists are one list, read from two places -----------------------

// Codes are taken from the reference by table, not by a grep of the whole file:
// the prose around the tables also mentions codes in backticks, and a grep would
// count those as declarations. A row's code is the first backticked token after
// the row's leading column.
function docSection(from, to) {
  const text = readFileSync(CLI_DOC, 'utf8');
  const start = text.indexOf(from);
  assert.notEqual(start, -1, `${CLI_DOC} has no heading ${from}`);
  const end = to ? text.indexOf(to, start) : text.length;
  assert.notEqual(end, -1, `${CLI_DOC} has no heading ${to}`);
  return text.slice(start, end);
}

function tableCodes(section, kind = null) {
  const codes = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|') || line.startsWith('|---') || line.startsWith('| Code')
      || line.startsWith('| Kind') || line.startsWith('| What')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (kind !== null && cells[0] !== kind) continue;
    const cell = kind === null ? cells[0] : cells[1];
    const m = cell.match(/^`([^`]+)`$/);
    if (m) codes.push(m[1]);
  }
  return codes;
}

test('the reference lists every code exactly once', () => {
  const sections = [
    tableCodes(docSection('### Reason codes', '### Exclusion')),
    tableCodes(docSection('### Exclusion', '### Error codes'), 'exclusion'),
    tableCodes(docSection('### Exclusion', '### Error codes'), 'adjustment'),
    tableCodes(docSection('### Exclusion', '### Error codes'), 'warning'),
    tableCodes(docSection('### Error codes', '### Files')),
  ];
  for (const codes of sections) {
    assert.ok(codes.length, 'a code table came back empty — the headings moved');
    assert.deepEqual([...new Set(codes)], codes, `duplicate code in one table: ${codes.join(', ')}`);
  }
});

test('the schema enums and the reference tables are the same lists', () => {
  const decision = readJson(path.join(SCHEMAS, 'decision.schema.json'));
  const snapshot = readJson(path.join(SCHEMAS, 'snapshot.schema.json'));
  const pairs = [
    ['reason', snapshot.$defs.reason.enum, tableCodes(docSection('### Reason codes', '### Exclusion'))],
    ['exclusion', decision.$defs.exclusionCode.enum,
      tableCodes(docSection('### Exclusion', '### Error codes'), 'exclusion')],
    ['adjustment', decision.$defs.adjustmentCode.enum,
      tableCodes(docSection('### Exclusion', '### Error codes'), 'adjustment')],
    ['warning', decision.$defs.warningCode.enum,
      tableCodes(docSection('### Exclusion', '### Error codes'), 'warning')],
  ];
  for (const [kind, fromSchema, fromDoc] of pairs) {
    assert.deepEqual([...fromDoc].sort(), [...fromSchema].sort(),
      `${kind} codes drifted between the schema and 03-cli.md`);
  }
});

// --- the golden decision says what the ADR says ------------------------------

test('the golden decision is the ADR arithmetic, not a shape with numbers in it', () => {
  // The golden exists to be reproduced by PB-18. A fixture whose components do
  // not add up to its own base would be reproduced by nothing, and the task
  // would "fix" the resolver until it matched a wrong number.
  const d = readJson(path.join(FIXTURES, 'decision.json'));
  assert.equal(d.strategy, 'balanced');
  assert.deepEqual(d.weights, { quality: 40, speed: 25, quotaCost: 20, remaining: 15 });
  assert.equal(Object.values(d.weights).reduce((a, b) => a + b, 0), 100);

  const scored = d.candidates.filter((c) => c.score);
  assert.ok(scored.length >= 2, 'the golden needs more than one scored candidate to pin an order');
  for (const c of scored) {
    const sum = Object.values(c.score.components).reduce((a, b) => a + b, 0);
    assert.equal(c.score.base, Math.round(sum * 100) / 100, `${c.tupleId}: components do not sum to base`);
    const adj = c.score.adjustments.reduce((a, x) => a + x.points, 0);
    assert.equal(c.score.total, Math.round((c.score.base + adj) * 100) / 100,
      `${c.tupleId}: base plus adjustments is not the total`);
  }
  const totals = scored.map((c) => c.score.total);
  assert.deepEqual(totals, [...totals].sort((a, b) => b - a), 'scored candidates are not in descending order');
  assert.equal(d.candidates.findIndex((c) => c.excluded) > d.candidates.findLastIndex((c) => c.score), true,
    'excluded candidates must follow the scored ones');

  const chosen = d.candidates.filter((c) => c.chosen);
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].score.total, Math.max(...totals));
  assert.equal(d.chosen.tupleId, chosen[0].tupleId);
  // Every excluded candidate says why, and every unknown-availability candidate
  // carries the penalty the ADR fixed.
  for (const c of d.candidates.filter((x) => x.excluded)) assert.equal(c.score, null, c.tupleId);
  for (const c of scored.filter((x) => x.availability.state === 'unknown')) {
    assert.deepEqual(c.score.adjustments, [{ code: 'unknown-availability', points: -10 }], c.tupleId);
  }
});

test('the golden text output renders the golden decision, same order and same numbers', () => {
  const d = readJson(path.join(FIXTURES, 'decision.json'));
  const text = readFileSync(path.join(FIXTURES, 'models.txt'), 'utf8');
  assert.ok(text.endsWith('\n'), 'the golden text must end with exactly one newline');
  assert.equal(/[ \t]+\n/.test(text), false, 'the golden text has trailing whitespace on a line');
  // Rows are taken from the `candidates:` block only, up to the blank line that
  // ends it. A regex over the whole file would also catch the runtime-model
  // lines, which are indented the same way — and that false positive is exactly
  // what the first run of this check produced.
  const block = text.split('\ncandidates:\n')[1].split('\n\n')[0];
  const rows = block.split('\n').filter(Boolean);
  assert.deepEqual(rows.map((l) => l.trim().replace(/^[*-] /, '').split(/\s+/)[0]),
    d.candidates.map((c) => c.tupleId), 'the text prints candidates in a different order than the decision');
  for (const c of d.candidates.filter((x) => x.score)) {
    assert.ok(text.includes(c.score.total.toFixed(2)), `${c.tupleId}: its score is not in the text output`);
  }
});

// --- legacy behaviour: no new flags, today's path ----------------------------

test('argv with none of the routing flags takes exactly today\'s path', () => {
  // `lib/spawn.js` states its gate order — "two gates, both before any write to
  // disk" — and routing joins that order in PB-21. This check is what PB-21
  // must not break: with no flag there is no gate at all, and the values are
  // the driver's own.
  //
  // The host handed in throws from `declaredTools`. That is the point: without
  // `--harness` the declaration is not consulted, and a routing preflight that
  // started asking the host on every call would go red here rather than in a
  // live run.
  const poisoned = {
    kind: 'promptobus-host',
    commandName: 'poisoned',
    declaredTools() { throw new Error('declaredTools consulted without --harness'); },
    toolsManifestRel() { throw new Error('toolsManifestRel consulted without --harness'); },
  };

  const driver = liftHarness(poisoned);
  assert.equal(driver.id, REGISTRY.fallback, 'no --harness must resolve to the registry fallback');
  assert.equal(driver.id, liftDriver().id);

  assert.equal(resolveEffort(undefined, driver), null,
    'no --effort must stay null — the driver is not given one');
  assert.equal(resolvePermissionMode(undefined, driver), driver.options.defaultPermissionMode,
    'no --permission-mode must fall back to the driver default');
  assert.equal(typeof driver.options.defaultModel, 'string');
  assert.ok(driver.options.defaultModel.length,
    'no --model resolves to driver.options.defaultModel (lib/spawn.js) — it must exist');

  // The gates themselves are unchanged: a value outside the driver's list still
  // refuses, and it refuses before anything is written.
  assert.throws(() => resolveEffort('no-such-effort', driver), /unknown value/);
  assert.throws(() => resolvePermissionMode('no-such-mode', driver), /unknown value/);
});

// --- pending: what PB-21 turns green -----------------------------------------

test('PENDING until PB-21 — `models --json` matches decision.json, normalised as the fixtures README says',
  { todo: 'the models command does not exist yet; PB-21 wires it and turns this green' },
  () => {
    assert.fail('no models command to run yet');
  });

test('PENDING until PB-21 — `models` text matches models.txt, normalised as the fixtures README says',
  { todo: 'the models command does not exist yet; PB-21 wires it and turns this green' },
  () => {
    assert.fail('no models command to run yet');
  });

test('PENDING until PB-21 — the reference error-code table is a subset of ERROR_CODES',
  { todo: 'PB-21 registers the routing codes in src/v1/errors.ts with the implementation; '
    + 'registering them now would publish nine codes nothing can raise' },
  async () => {
    const { ERROR_CODES } = await import('../dist/index.js');
    const documented = tableCodes(docSection('### Error codes', '### Files'));
    assert.ok(documented.length, 'the error-code table came back empty');
    assert.deepEqual(documented.filter((c) => !ERROR_CODES.includes(c)), []);
  });

test('PENDING until PB-21 — --help names models, --strategy and --allow-payg',
  { todo: 'help must not advertise a command that answers "unknown command"; PB-21 adds both together' },
  async () => {
    const { helpText } = await import('../lib/cli.js');
    const text = helpText({ kind: 'promptobus-host', commandName: 'promptobus', version: '0.0.0' });
    assert.match(text, /promptobus models /);
    assert.match(text, /--strategy /);
    assert.match(text, /--allow-payg/);
  });
