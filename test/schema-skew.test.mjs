// The running bus reads record schemas from the installed package. Two small schema
// directories stand in for the checkout and that package; resolution is the real one.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts', 'check-schema-skew.mjs');
const recordNames = ['gate-record.schema.json', 'handover-record.schema.json'];
const RELEASE = 'the record can carry that field from the next release on';

function writeTree(dir, schema) {
  const folder = path.join(dir, 'schemas', 'v1');
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'sample-record.schema.json'), `${JSON.stringify(schema, null, 2)}\n`);
}

function run(args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '' },
  });
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function pair(checkoutSchema, installedSchema) {
  const root = mkdtempSync(path.join(tmpdir(), 'schema-skew-'));
  const checkout = path.join(root, 'checkout');
  const installed = path.join(root, 'node_modules', 'promptobus');
  try {
    writeTree(checkout, checkoutSchema);
    mkdirSync(installed, { recursive: true });
    writeFileSync(
      path.join(installed, 'package.json'),
      `${JSON.stringify({ name: 'promptobus', version: '0.0.0-fixture' })}\n`,
    );
    if (installedSchema) writeTree(installed, installedSchema);
    const result = run(['--checkout', checkout, '--resolve-from', checkout]);
    return { ...result, checkout, installed };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function refused(result, fragment) {
  return result.code === 1
    && result.out.includes(fragment)
    && result.out.includes(RELEASE)
    && result.out.includes('resolved: Node resolve.paths("promptobus") from ')
    && result.out.includes(`${result.installed} (0.0.0-fixture)`);
}

const closed = { type: 'object', additionalProperties: false };

const property = pair(
  { ...closed, properties: { note: { type: 'string' } } },
  { ...closed, properties: {} },
);
check('schema-skew: a property the installed schema does not define exits red',
  refused(property, 'schemas/v1/sample-record.schema.json: /note — property the installed schema does not define'),
  property.out);

const required = pair(
  { ...closed, required: ['id'], properties: { id: { type: 'string' } } },
  { ...closed, properties: {} },
);
check('schema-skew: a required property the installed schema does not define exits red',
  refused(required, 'schemas/v1/sample-record.schema.json: /id — required property the installed schema does not define'),
  required.out);

const typed = pair(
  { ...closed, properties: { count: { type: 'number' } } },
  { ...closed, properties: { count: { type: 'string' } } },
);
check('schema-skew: a changed type the installed schema does not accept exits red',
  refused(typed, 'schemas/v1/sample-record.schema.json: /count — type the installed schema does not accept'),
  typed.out);

const fixed = pair(
  { ...closed, properties: { n: { const: 2 } } },
  { ...closed, properties: { n: { const: 1 } } },
);
check('schema-skew: a const the installed schema does not accept exits red',
  refused(fixed, 'schemas/v1/sample-record.schema.json: /n — const 2 the installed schema does not accept'),
  fixed.out);

const branched = pair(
  {
    oneOf: [
      { ...closed, required: ['a'], properties: { a: { const: 1 } } },
      { ...closed, required: ['b'], properties: { b: { const: 2 } } },
    ],
  },
  { oneOf: [{ ...closed, required: ['a'], properties: { a: { const: 1 } } }] },
);
check('schema-skew: a oneOf shape the installed schema does not accept exits red',
  refused(branched, 'schemas/v1/sample-record.schema.json: / — shape the installed schema does not accept'),
  branched.out);

const grammar = { type: 'string', pattern: '^[0-9a-f]{40}$' };
const namesNow = { ...closed, required: ['tree'], properties: { tree: grammar } };
const namesThen = { ...closed, required: ['removed'], properties: { removed: { type: 'array' } } };
const skipped = { ...closed, required: ['notRun'], properties: { notRun: { type: 'string', minLength: 8 } } };
const widened = pair(
  { oneOf: [namesNow, skipped] },
  { oneOf: [namesThen, skipped] },
);
check('schema-skew: an unmatched oneOf branch with a pattern the installed branches refuse exits red',
  refused(widened, 'schemas/v1/sample-record.schema.json: / — shape the installed schema does not accept')
    && widened.out.includes('1 record schema(s) compared, 1 the running bus would refuse'),
  widened.out);

const kept = { ...closed, required: ['x'], properties: { x: { const: 1 }, y: grammar } };
const tightened = { ...closed, required: ['x', 'y'], properties: { x: { const: 1 }, y: grammar } };
const otherShape = { ...closed, required: ['z'], properties: { z: { const: true } } };
const stillAccepted = pair(
  { oneOf: [kept, otherShape, tightened] },
  { oneOf: [kept, otherShape] },
);
check('schema-skew: an unmatched oneOf branch the installed schema still accepts exits green',
  stillAccepted.code === 0
    && stillAccepted.out.includes('agrees with the installed schema')
    && stillAccepted.out.includes('0 the running bus would refuse')
    && !stillAccepted.out.includes(RELEASE),
  stillAccepted.out);

const plain = { ...closed, required: ['a'], properties: { a: { type: 'integer' } } };
const acceptedAsOneOf = pair(
  {
    ...closed,
    properties: {
      verdicts: {
        oneOf: [
          { ...closed, required: ['a'], properties: { a: { const: 1 } } },
          { ...closed, required: ['a'], properties: { a: { const: 2 } } },
        ],
      },
    },
  },
  { ...closed, properties: { verdicts: plain } },
);
check('schema-skew: an installed node without oneOf that accepts every checkout branch exits green',
  acceptedAsOneOf.code === 0
    && acceptedAsOneOf.out.includes('agrees with the installed schema')
    && acceptedAsOneOf.out.includes('0 the running bus would refuse')
    && !acceptedAsOneOf.out.includes(RELEASE),
  acceptedAsOneOf.out);

const rows = pair(
  {
    ...closed,
    properties: {
      rows: {
        type: 'array',
        items: { ...closed, properties: { note: { type: 'string' } } },
      },
    },
  },
  {
    ...closed,
    properties: {
      rows: { type: 'array', items: { ...closed, properties: {} } },
    },
  },
);
check('schema-skew: a property on an array item the installed schema does not define exits red',
  refused(rows, 'schemas/v1/sample-record.schema.json: /rows/0/note — property the installed schema does not define'),
  rows.out);

const stillRequired = pair(
  { ...closed, properties: { keep: { type: 'string' } } },
  { ...closed, required: ['keep'], properties: { keep: { type: 'string' } } },
);
check('schema-skew: a required field the installed schema still requires exits red',
  refused(stillRequired, 'schemas/v1/sample-record.schema.json: /keep — required field the installed schema still requires'),
  stillRequired.out);

const same = { ...closed, properties: { a: { type: 'string' } } };
const agreed = pair(same, same);
check('schema-skew: agreeing record schemas exit green',
  agreed.code === 0
    && agreed.out.includes('✔ schemas/v1/sample-record.schema.json agrees with the installed schema')
    && agreed.out.includes('0 the running bus would refuse')
    && !agreed.out.includes(RELEASE),
  agreed.out);

const described = pair(
  { ...same, description: 'checkout wording' },
  { ...same, description: 'installed wording' },
);
check('schema-skew: a description change is not a refusal',
  described.code === 0 && described.out.includes('agrees with the installed schema') && !described.out.includes(RELEASE),
  described.out);

const opened = pair(
  { type: 'object', additionalProperties: true, properties: { a: { type: 'string' }, note: { type: 'string' } } },
  { type: 'object', additionalProperties: true, properties: { a: { type: 'string' } } },
);
check('schema-skew: a property the installed schema allows exits green',
  opened.code === 0 && opened.out.includes('0 the running bus would refuse') && !opened.out.includes(RELEASE),
  opened.out);

const alreadyThere = pair(
  { ...closed, required: ['a'], properties: { a: { type: 'string' } } },
  { ...closed, properties: { a: { type: 'string' } } },
);
check('schema-skew: a newly required property the installed schema already defines exits green',
  alreadyThere.code === 0 && !alreadyThere.out.includes(RELEASE),
  alreadyThere.out);

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeRecords(dir) {
  const folder = path.join(dir, 'schemas', 'v1');
  mkdirSync(folder, { recursive: true });
  for (const name of recordNames) copyFileSync(path.join(repo, 'schemas', 'v1', name), path.join(folder, name));
  return folder;
}

const realRoot = mkdtempSync(path.join(tmpdir(), 'schema-skew-'));
const realInstalled = path.join(realRoot, 'node_modules', 'promptobus');
const realFrom = path.join(realRoot, 'x');
try {
  mkdirSync(realFrom, { recursive: true });
  mkdirSync(realInstalled, { recursive: true });
  writeFileSync(path.join(realInstalled, 'package.json'), `${JSON.stringify({ name: 'promptobus', version: '0' })}\n`);
  const installedRecords = writeRecords(realInstalled);
  const handoverFile = path.join(installedRecords, 'handover-record.schema.json');
  const handover = readJson(handoverFile);
  delete handover.$defs.mutationProbe.properties.expected;
  writeFileSync(handoverFile, JSON.stringify(handover));
  const dropped = run(['--checkout', repo, '--resolve-from', realFrom]);
  check('schema-skew: a field added under mutationProbe on the real handover schema exits red',
    dropped.code === 1
      && dropped.out.includes('schemas/v1/handover-record.schema.json: /checks/mutationProbe/expected — property the installed schema does not define')
      && dropped.out.includes(RELEASE)
      && dropped.out.includes('2 record schema(s) compared, 1 the running bus would refuse'),
    dropped.out);

  const checkout = path.join(realRoot, 'checkout');
  const checkoutRecords = writeRecords(checkout);
  const gateFile = path.join(checkoutRecords, 'gate-record.schema.json');
  const gate = readJson(gateFile);
  gate.$defs.record.properties.skewMark = { type: 'string' };
  writeFileSync(gateFile, JSON.stringify(gate));
  writeRecords(realInstalled);
  const added = run(['--checkout', checkout, '--resolve-from', realFrom]);
  check('schema-skew: a new field on the real gate-record entry exits red',
    added.code === 1
      && added.out.includes('schemas/v1/gate-record.schema.json: /records/0/skewMark — property the installed schema does not define')
      && added.out.includes(RELEASE)
      && added.out.includes('2 record schema(s) compared, 1 the running bus would refuse'),
    added.out);
} finally {
  rmSync(realRoot, { recursive: true, force: true });
}

const missing = pair({ ...closed, properties: { note: { type: 'string' } } }, null);
check('schema-skew: a record schema missing from the installed package exits red',
  missing.code === 1
    && missing.out.includes('schemas/v1/sample-record.schema.json: no copy in the installed package')
    && missing.out.includes(RELEASE),
  missing.out);

const nowhere = mkdtempSync(path.join(tmpdir(), 'schema-skew-missing-'));
try {
  const absent = run(['--resolve-from', nowhere, '--checkout', nowhere]);
  check('schema-skew: no installed package prints not run and exits green',
    absent.code === 0
      && absent.out.split('\n').includes('not run: no installed promptobus package found')
      && absent.out.includes(`resolved: Node resolve.paths("promptobus") from ${nowhere} upward`)
      && !absent.out.includes('agrees with the installed schema'),
    absent.out);
} finally {
  rmSync(nowhere, { recursive: true, force: true });
}
