// The handover record (PB-213): the five pre-handover checks by ajv, the bounds against
// lib/handoff.js, and the shipped reader `send` refuses by: 04-protocol.md § the handover record.
import './home.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { check } from './check.mjs';
import { HANDOVER_CHECKS, HANDOVER_RECORD_SCHEMA, HANDOVER_RECORD_STEM } from '../lib/handoff.js';
import { schemaErrors, unsupportedKeywords } from '../lib/schema.js';
import { validate } from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const schema = JSON.parse(readFileSync(path.join(ROOT, HANDOVER_RECORD_SCHEMA), 'utf8'));

// `strict: false` for the reason the neighbouring gate-record file gives: the own
// vocabulary reads as suspicious to ajv in strict mode, and the subject is the verdict.
const ajv = new Ajv2020({ strict: false, allErrors: true });
const accepts = ajv.compile(schema);
const refuses = (value) => !accepts(value);

const BRANCH = '93c140dc3c583bb74ec5c1ad8b7f26e6187c45c9';
const BASE = '1966aceb629304e23519ca4eef1d7ef98e65b6de';

const probe = (over = {}) => ({
  tree: BRANCH,
  mutated: 'lib/handoff.js:14',
  mutatedRunExit: 1,
  applied: true,
  // 26 − 25 − 1 = 0: one name in `reddened`. A copied fixture is what `send` accepts.
  verdicts: { baseTotal: 26, passed: 25, unaccounted: 0 },
  reddened: ['PB-201: the bound the schema publishes is the bound lib/handoff.js hands the preambles'],
  ...over,
});

const checks = (over = {}) => ({
  verdictNames: { removed: [] },
  mutationProbe: probe(),
  treeState: { beforeProbe: '', afterRestore: '' },
  environmentalRed: { claims: [] },
  gatesNotRun: { gates: [] },
  ...over,
});

const doc = (over = {}) => ({
  schemaVersion: 1,
  tree: BRANCH,
  base: BASE,
  at: '2026-09-16T14:41:07.000Z',
  by: 'worker:t5pb',
  checks: checks(),
  ...over,
});

const notRun = { notRun: 'this repository has no runner that prints verdict names' };

check('PB-213: the record the preambles ask for is a document this schema accepts',
  accepts(doc()), JSON.stringify(accepts.errors));

// The rule PB-201 wrote for a gate that was not run, held here per check: the record has
// no silent gap, and the only way past a check is the branch that says so out loud.
const missing = HANDOVER_CHECKS.filter((name) => {
  const one = checks();
  delete one[name];
  return refuses(doc({ checks: one }));
});
check('PB-213: all five checks are required — a check left out is not a check passed',
  missing.length === HANDOVER_CHECKS.length && HANDOVER_CHECKS.length === 5,
  `not required: ${HANDOVER_CHECKS.filter((n) => !missing.includes(n)).join(', ')}`);

// The negative control the card names: a form with no honest way to say "impossible here"
// is a form that rewards invented numbers — the very defect the gate record was written against.
const declarable = HANDOVER_CHECKS.filter((name) => accepts(doc({ checks: checks({ [name]: notRun }) })));
check('PB-213: a check honestly declared impossible with a reason passes, on every one of the five',
  declarable.length === HANDOVER_CHECKS.length,
  `refused a declared check: ${HANDOVER_CHECKS.filter((n) => !declarable.includes(n)).join(', ')}`);

check('PB-213: the declaration carries a reason — `notRun` alone, or empty, is not a declaration',
  refuses(doc({ checks: checks({ mutationProbe: { notRun: '' } }) }))
  && refuses(doc({ checks: checks({ mutationProbe: { notRun: true } }) }))
  && refuses(doc({ checks: checks({ mutationProbe: { notRun: 'no' } }) }))
  && refuses(doc({ checks: checks({ mutationProbe: { notRun: 'ran out of time', tree: BRANCH } }) })),
  'a reasonless declaration was accepted');

check('PB-213: a removed verdict name carries why it went — an empty list is the explicit `none`',
  accepts(doc({ checks: checks({ verdictNames: { removed: [] } }) }))
  && accepts(doc({ checks: checks({ verdictNames: { removed: [{ name: 'a stale case', reason: 'the contract it asserted was removed by this change' }] } }) }))
  && refuses(doc({ checks: checks({ verdictNames: { removed: ['a stale case'] } }) }))
  && refuses(doc({ checks: checks({ verdictNames: { removed: [{ name: 'a stale case' }] } }) }))
  && refuses(doc({ checks: checks({ verdictNames: {} }) }))
  && refuses(doc({ checks: checks({ verdictNames: { removed: [], added: ['a new case'] } }) })),
  'a guarantee went missing without a word and the schema took it');

// "26/26 → 0/1" beside a base of 26 reads as catastrophe and means interruption. The
// subtraction is the author's and the remainder is stated, because JSON Schema cannot do it.
check('PB-213: a probe that stopped before the base total is refused — the remainder is stated, not inferred',
  accepts(doc({ checks: checks({ mutationProbe: probe() }) }))
  && refuses(doc({ checks: checks({ mutationProbe: probe({ verdicts: { baseTotal: 26, passed: 0, unaccounted: 25 } }) }) }))
  && refuses(doc({ checks: checks({ mutationProbe: probe({ verdicts: { baseTotal: 26, passed: 24 } }) }) }))
  && refuses(doc({ checks: checks({ mutationProbe: probe({ verdicts: { baseTotal: 0, passed: 0, unaccounted: 0 } }) }) })),
  'an interrupted run was accepted as a probe');

check('PB-213: a mutation that never applied is not a probe, and neither is one that reddened nothing',
  refuses(doc({ checks: checks({ mutationProbe: probe({ applied: false }) }) }))
  && refuses(doc({ checks: checks({ mutationProbe: probe({ applied: 'yes' }) }) }))
  && refuses(doc({ checks: checks({ mutationProbe: probe({ reddened: [] }) }) }))
  && refuses(doc({ checks: checks({ mutationProbe: probe({ reddened: 'the bound check' }) }) })),
  'a run that measured the unmutated tree was accepted as evidence');

// PB-234: `expected` is the intent, `reddened` the outcome. The SHAPE is the schema's; the
// comparison of the two is `recordRefusal`'s, and the send door asserts it in the adapter file.
const TARGET = 'PB-201: the bound the schema publishes is the bound lib/handoff.js hands the preambles';

check('PB-234: the probe may name what it was made to redden, as one name or as several',
  accepts(doc({ checks: checks({ mutationProbe: probe({ expected: [TARGET] }) }) }))
  && accepts(doc({ checks: checks({ mutationProbe: probe({ expected: [TARGET, 'a second verdict'] }) }) }))
  && refuses(doc({ checks: checks({ mutationProbe: probe({ expected: [] }) }) }))
  && refuses(doc({ checks: checks({ mutationProbe: probe({ expected: TARGET }) }) }))
  && refuses(doc({ checks: checks({ mutationProbe: probe({ expected: [{ name: TARGET }] }) }) })),
  'the declared target was accepted in a shape nothing can be compared against');

// The consumer holds records written by the previous version and is mid-run. A field that
// refused them would break the mechanism reading them, so absence is the old record, not a gap.
check('PB-234: a record written before the field keeps passing — the field is optional, not a migration',
  accepts(doc()) && doc().checks.mutationProbe.expected === undefined,
  'a record of the previous version was refused by a field it could not have carried');

// The restored run: `passed` equals `baseTotal`, `reddened` is non-empty, `unaccounted` is 0.
// Schema-valid on purpose — the subtraction is `recordRefusal`'s, asserted at send.
check('PB-234.4: the schema still accepts counts that do not subtract to the stated remainder',
  accepts(doc({ checks: checks({ mutationProbe: probe({
    verdicts: { baseTotal: 26, passed: 26, unaccounted: 0 },
  }) }) })),
  'the schema compared two of its own fields');

check('PB-213: the probe names a sha and a `file:line`, not a description of either',
  refuses(doc({ checks: checks({ mutationProbe: probe({ tree: 'HEAD' }) }) }))
  && refuses(doc({ checks: checks({ mutationProbe: probe({ tree: '1966ace' }) }) }))
  && refuses(doc({ checks: checks({ mutationProbe: probe({ mutated: 'the bound constant' }) }) }))
  && refuses(doc({ checks: checks({ mutationProbe: probe({ mutated: 'lib/handoff.js' }) }) }))
  && refuses(doc({ checks: checks({ mutationProbe: probe({ mutatedRunExit: '1' }) }) })),
  'a probe claim in prose was accepted');

// Two exit codes meet here and only one belongs in the record. `npm run probe` leaves 0 on
// its single passing outcome; the run made WITH the mutation is the one the numbers describe.
check('PB-213: the exit recorded is the mutated run\'s, and a mutated run that exited 0 saw nothing',
  refuses(doc({ checks: checks({ mutationProbe: probe({ mutatedRunExit: 0 }) }) }))
  && refuses(doc({ checks: checks({ mutationProbe: probe({ exit: 1 }) }) }))
  && accepts(doc({ checks: checks({ mutationProbe: probe({ mutatedRunExit: 255 }) }) }))
  && refuses(doc({ checks: checks({ mutationProbe: probe({ mutatedRunExit: 256 }) }) })),
  'the probe tool\'s own exit code was accepted in place of the mutated run\'s');

check('PB-213: the tree is empty at both ends of the probe, and anything else is refused',
  accepts(doc({ checks: checks({ treeState: { beforeProbe: '', afterRestore: '' } }) }))
  && refuses(doc({ checks: checks({ treeState: { beforeProbe: ' M lib/handoff.js', afterRestore: '' } }) }))
  && refuses(doc({ checks: checks({ treeState: { beforeProbe: '', afterRestore: ' M lib/handoff.js' } }) }))
  && refuses(doc({ checks: checks({ treeState: { beforeProbe: '' } }) })),
  'a probe on a dirty tree, or one that left the mutation behind, was accepted');

const claim = (over = {}) => ({
  name: 'PB-9: the holder answers a wake inside the budget',
  assertion: 'AssertionError [ERR_ASSERTION]: no thread id after 133 s',
  onBase: { command: 'node --test test/promptobus-codex-hold.test.mjs', exit: 1, red: true },
  failures: { branchOnly: [], baseOnly: [] },
  ...over,
});

check('PB-213: a red called environmental comes with the base run and the symmetric difference',
  accepts(doc({ checks: checks({ environmentalRed: { claims: [] } }) }))
  && accepts(doc({ checks: checks({ environmentalRed: { claims: [claim()] } }) }))
  && refuses(doc({ checks: checks({ environmentalRed: { claims: [claim({ onBase: undefined })] } }) }))
  && refuses(doc({ checks: checks({ environmentalRed: { claims: [claim({ failures: undefined })] } }) }))
  && refuses(doc({ checks: checks({ environmentalRed: { claims: [claim({ failures: { branchOnly: [] } })] } }) }))
  && refuses(doc({ checks: checks({ environmentalRed: { claims: ['flaky on CI'] } }) })),
  'a claim of "environmental" was accepted on the word');

check('PB-213: red on the branch and green on base is the author\'s own change, not an environment',
  refuses(doc({ checks: checks({ environmentalRed: { claims: [claim({ onBase: { command: 'npm test', exit: 0, red: false } })] } }) }))
  && refuses(doc({ checks: checks({ environmentalRed: { claims: [claim({ onBase: { command: 'npm test', exit: 0 } })] } }) })),
  'a green base run was accepted as evidence that the red is not the author\'s');

check('PB-213: a gate that was not run carries its reason — the machine half of "not run, because …"',
  accepts(doc({ checks: checks({ gatesNotRun: { gates: [] } }) }))
  && accepts(doc({ checks: checks({ gatesNotRun: { gates: [{ command: 'npm run pins', because: 'the registry is unreachable from this sandbox' }] } }) }))
  && refuses(doc({ checks: checks({ gatesNotRun: { gates: [{ command: 'npm run pins' }] } }) }))
  && refuses(doc({ checks: checks({ gatesNotRun: { gates: ['npm run pins'] } }) }))
  && refuses(doc({ checks: checks({ gatesNotRun: {} }) })),
  'a gate skipped in silence was accepted');

check('PB-213: the record binds to one tree and one base, both at full length',
  refuses(doc({ tree: undefined }))
  && refuses(doc({ base: undefined }))
  && refuses(doc({ tree: '1966ace' }))
  && refuses(doc({ base: 'main' }))
  && accepts(doc({ tree: 'a'.repeat(64) })),
  'a record that could never be compared with a reviewed tree was accepted');

check('PB-213: the address is an address, in bus spelling and not as a participant id',
  accepts(doc({ by: 'approver:t5pb' }))
  && refuses(doc({ by: 'worker-t5pb' }))
  && refuses(doc({ by: undefined }))
  && refuses(doc({ at: '2026-09-16T14:41:07Z' })),
  'a record with no answerable author was accepted');

check('PB-213: an unfamiliar field is refused rather than carried — the record has no free-text seam',
  refuses(doc({ note: 'trust me' }))
  && refuses(doc({ checks: { ...checks(), note: 'trust me' } }))
  && refuses(doc({ schemaVersion: 2 }))
  && refuses(doc({ schemaVersion: undefined })),
  'the document took a field it does not define');

check('PB-213: the five names the schema requires are the five lib/handoff.js hands the preambles',
  Object.keys(schema.properties.checks.properties).join() === HANDOVER_CHECKS.join()
  && schema.properties.checks.required.join() === HANDOVER_CHECKS.join()
  && HANDOVER_RECORD_STEM === 'handover',
  `${Object.keys(schema.properties.checks.properties).join()} vs ${HANDOVER_CHECKS.join()}`);

// The trap the gate-record file keeps shut, kept shut for the second record too: `schemas/v1/`
// is where the engine models live, and a file there invites the reading that the engine checks it.
check('PB-213: the engine does not know this model either — an artifact payload stays opaque bytes',
  validate('handover-record', doc()).ok === false
  && /unknown model/.test(validate('handover-record', doc()).note ?? ''),
  JSON.stringify(validate('handover-record', doc())));

// --- the reader `send` refuses by, against the reference it must not drift from --------
//
// The same pairing the gate-record file makes: `ajv` is a devDependency and the package
// ships with none, so the check that runs at send reads the schema FILE. One fixture set,
// two verdicts, and a disagreement means the shipped reader refuses the wrong documents.

check('PB-217: the reader implements every keyword this schema uses',
  unsupportedKeywords(schema).length === 0, unsupportedKeywords(schema).join(', '));

const fixtures = [
  doc(),
  doc({ tree: 'a'.repeat(64) }),
  doc({ tree: '1966ace' }),
  doc({ base: 'main' }),
  doc({ by: 'approver:t5pb' }),
  doc({ by: 'worker-t5pb' }),
  doc({ at: '2026-09-16T14:41:07Z' }),
  doc({ note: 'trust me' }),
  doc({ schemaVersion: 2 }),
  ...HANDOVER_CHECKS.map((name) => { const one = checks(); delete one[name]; return doc({ checks: one }); }),
  ...HANDOVER_CHECKS.map((name) => doc({ checks: checks({ [name]: notRun }) })),
  doc({ checks: checks({ mutationProbe: { notRun: '' } }) }),
  doc({ checks: checks({ mutationProbe: { notRun: 'ran out of time', tree: BRANCH } }) }),
  doc({ checks: checks({ mutationProbe: probe({ applied: false }) }) }),
  doc({ checks: checks({ mutationProbe: probe({ reddened: [] }) }) }),
  doc({ checks: checks({ mutationProbe: probe({ mutatedRunExit: 0 }) }) }),
  doc({ checks: checks({ mutationProbe: probe({ mutatedRunExit: 255 }) }) }),
  doc({ checks: checks({ mutationProbe: probe({ exit: 1 }) }) }),
  doc({ checks: checks({ mutationProbe: probe({ verdicts: { baseTotal: 26, passed: 0, unaccounted: 25 } }) }) }),
  doc({ checks: checks({ mutationProbe: probe({ mutated: 'lib/handoff.js' }) }) }),
  doc({ checks: checks({ mutationProbe: probe({ expected: [TARGET] }) }) }),
  doc({ checks: checks({ mutationProbe: probe({ expected: [] }) }) }),
  doc({ checks: checks({ mutationProbe: probe({ expected: TARGET }) }) }),
  // Schema-valid and self-contradicting: the agreement is about SHAPE, and the two fields
  // are compared one layer up. A fixture here that both readers refused would hide that.
  doc({ checks: checks({ mutationProbe: probe({ expected: ['a verdict that never reddened'] }) }) }),
  // 26 − 26 − 1 is not the stated 0. Same split: both readers accept it, `send` does not.
  doc({ checks: checks({ mutationProbe: probe({
    verdicts: { baseTotal: 26, passed: 26, unaccounted: 0 },
  }) }) }),
  doc({ checks: checks({ treeState: { beforeProbe: ' M lib/handoff.js', afterRestore: '' } }) }),
  doc({ checks: checks({ treeState: { beforeProbe: '' } }) }),
  doc({ checks: checks({ verdictNames: { removed: [{ name: 'a stale case', reason: 'the contract it asserted was removed' }] } }) }),
  doc({ checks: checks({ verdictNames: { removed: ['a stale case'] } }) }),
  doc({ checks: checks({ verdictNames: { removed: [], added: ['a new case'] } }) }),
  doc({ checks: checks({ environmentalRed: { claims: [claim()] } }) }),
  doc({ checks: checks({ environmentalRed: { claims: [claim({ onBase: { command: 'npm test', exit: 0, red: false } })] } }) }),
  doc({ checks: checks({ environmentalRed: { claims: ['flaky on CI'] } }) }),
  doc({ checks: checks({ gatesNotRun: { gates: [{ command: 'npm run pins', because: 'the registry is unreachable' }] } }) }),
  doc({ checks: checks({ gatesNotRun: { gates: [{ command: 'npm run pins' }] } }) }),
  doc({ checks: { ...checks(), note: 'trust me' } }),
  'handover done',
];
const disagreed = fixtures.filter((f) => accepts(f) !== (schemaErrors(schema, f).length === 0));
check(`PB-217: the shipped reader and the reference agree on all ${fixtures.length} fixtures`,
  disagreed.length === 0, JSON.stringify(disagreed.slice(0, 2)));

check('PB-217: the fixture set holds documents of both verdicts',
  fixtures.some((f) => accepts(f)) && fixtures.some((f) => !accepts(f)),
  `${fixtures.filter((f) => accepts(f)).length} accepted of ${fixtures.length}`);
