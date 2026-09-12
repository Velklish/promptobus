// The gate record (PB-201): shape by ajv, and the bounds against lib/handoff.js.
// Why there is no second validator here: 04-protocol.md § The gate record.
import './home.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { check } from './check.mjs';
import { GATE_RECORD_SCHEMA, GATE_RECORD_STEM, GATE_TAIL_MAX, RESULT_BODY_MAX } from '../lib/handoff.js';
import { validate } from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const schema = JSON.parse(readFileSync(path.join(ROOT, GATE_RECORD_SCHEMA), 'utf8'));

// `strict: false` for the reason the neighbouring routing and v1 files give: the own
// vocabulary reads as suspicious to ajv in strict mode, and the subject is the verdict.
const ajv = new Ajv2020({ strict: false, allErrors: true });
const accepts = ajv.compile(schema);

const record = (over = {}) => ({
  command: 'npx github:Velklish/backslop#v0.7.0 gates',
  exit: 0,
  counts: { gates: 4, green: 4 },
  tree: '93c140dc3c583bb74ec5c1ad8b7f26e6187c45c9',
  dirty: false,
  at: '2026-09-12T20:41:07.000Z',
  by: 'worker:pb-prompts',
  tail: 'gates 4, green 4',
  ...over,
});
const doc = (...records) => ({ schemaVersion: 1, records });

const refuses = (value) => !accepts(value);

check('PB-201: the record the preambles ask for is a document this schema accepts',
  accepts(doc(record())), JSON.stringify(accepts.errors));

check('PB-201: one entry per gate command — four commands are four entries, not four documents',
  accepts(doc(
    record({ command: 'npm test', counts: { files: 64, tests: 1902 } }),
    record({ command: 'npm run audit', counts: { files: 872 } }),
    record({ command: 'npm run pins', exit: 1, tail: 'pins: 871 of 872' }),
    record(),
  )), JSON.stringify(accepts.errors));

// Each required field, one at a time: a schema that required only some of them would
// still accept the good document above and prove nothing.
const required = ['command', 'exit', 'tree', 'dirty', 'at', 'by'];
const dropped = required.filter((field) => {
  const one = record();
  delete one[field];
  return refuses(doc(one));
});
check('PB-201: every field the record is defined by is required, not merely documented',
  dropped.length === required.length, `not required: ${required.filter((f) => !dropped.includes(f)).join(', ')}`);

// An abbreviation is schema-valid hex and is never equal to what `rev-parse HEAD` prints,
// so a record carrying one could pass the schema and fail the comparison for ever.
check('PB-201: the sha is full length — an abbreviation is a record that can never match',
  accepts(doc(record({ tree: 'a'.repeat(40) })))
  && accepts(doc(record({ tree: 'a'.repeat(64) })))
  && refuses(doc(record({ tree: '1966ace' })))
  && refuses(doc(record({ tree: '1966aceb629304e23519ca4eef1d7ef98e65b6d' })))
  && refuses(doc(record({ tree: 'a'.repeat(41) }))),
  'a sha no comparison could ever match was accepted');

check('PB-201: the sha is a sha and the exit code is a number — a claim in prose is refused',
  refuses(doc(record({ tree: 'HEAD' })))
  && refuses(doc(record({ tree: 'zzzz140dc3c583bb74ec5c1ad8b7f26e6187c45c9' })))
  && refuses(doc(record({ exit: '0' })))
  && refuses(doc(record({ exit: -1 })))
  && refuses(doc(record({ dirty: 'no' }))),
  'a malformed record was accepted');

check('PB-201: the address is an address, in bus spelling and not as a participant id',
  accepts(doc(record({ by: 'orchestrator' })))
  && accepts(doc(record({ by: 'reviewer:pb-prompts' })))
  && refuses(doc(record({ by: 'worker-pb-prompts' })))
  && refuses(doc(record({ by: 'Worker:PB' }))),
  'an address outside the protocol spelling was accepted');

check('PB-201: counts are open by name and closed by type — the next runner names its own',
  accepts(doc(record({ counts: { 'test-files': 64 } })))
  && refuses(doc(record({ counts: { files: '64' } })))
  && refuses(doc(record({ counts: { Files: 64 } }))),
  JSON.stringify(accepts.errors));

check('PB-201: an unfamiliar field is refused rather than carried — the record has no free-text seam',
  refuses(doc(record({ note: 'trust me' })))
  && refuses({ schemaVersion: 1, records: [record()], note: 'trust me' })
  && refuses({ records: [record()] })
  && refuses(doc()),
  'the document took a field it does not define');

// The size bound is the whole answer to "small enough to read", and nothing else in the
// package bounds an artifact — so it has to hold here or it holds nowhere.
check(`PB-201: the tail is bounded at ${GATE_TAIL_MAX} characters, and the document at 16 entries`,
  accepts(doc(record({ tail: 'x'.repeat(GATE_TAIL_MAX) })))
  && refuses(doc(record({ tail: 'x'.repeat(GATE_TAIL_MAX + 1) })))
  && accepts({ schemaVersion: 1, records: Array.from({ length: 16 }, () => record()) })
  && refuses({ schemaVersion: 1, records: Array.from({ length: 17 }, () => record()) }),
  'the bound the reference states is not the bound the schema holds');

check('PB-201: the bound the schema publishes is the bound lib/handoff.js hands the preambles',
  schema.$defs.record.properties.tail.maxLength === GATE_TAIL_MAX
  && schema.properties.records.maxItems === 16
  && GATE_RECORD_STEM === 'gates',
  `${schema.$defs.record.properties.tail.maxLength} vs ${GATE_TAIL_MAX}`);

// The trap this file exists to keep shut: `schemas/v1/` is where the four engine models
// live, and a fifth file there invites the reading that the engine validates it too.
check('PB-201: the engine does not know this model — an artifact payload stays opaque bytes',
  validate('gate-record', doc(record())).ok === false
  && /unknown model/.test(validate('gate-record', doc(record())).note ?? ''),
  JSON.stringify(validate('gate-record', doc(record()))));

check('PB-204: the body bound is a number the package states once',
  Number.isInteger(RESULT_BODY_MAX) && RESULT_BODY_MAX === 2400,
  String(RESULT_BODY_MAX));
