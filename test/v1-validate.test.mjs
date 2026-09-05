// Runtime validation protocol v1: parity of the own validators and the JSON Schemas.
//
// The mechanism has two validators, and this is not a duplicate for reliability:
// in production the own TypeScript validators run WITH NO runtime dependency, and
// the schemas live in `schemas/v1` and are not read in production at all. If they
// drifted, the validator would stop checking what the schema declares, and the
// first to learn it would be the consumer of the schema, not the author of the
// change. So both are run against ONE fixture set: valid must be accepted by
// both, invalid — rejected by both.
//
// The reference validator is `ajv`, a package devDependency
// pinned exactly. It does not ship in the tarball, and the package still has
// zero runtime dependencies — that is a separate gate of the package suite.
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

import { ERROR_CODES, MESSAGE_TYPES, validate } from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS = path.join(here, '..', 'schemas', 'v1');
const FIXTURES = path.join(here, 'fixtures', 'v1');

const MODELS = ['task', 'participant', 'message', 'artifact'];

const schemaOf = (model) => JSON.parse(readFileSync(path.join(SCHEMAS, `${model}.schema.json`), 'utf8'));

// `strict: false`: the own schema vocabulary (`$defs/timestamp`, `not` next to
// `enum`) ajv in strict mode treats as suspicious, and the subject of the check
// is the verdict, not the taste of the reference. `allErrors` gives the diagnosis
// whole: a red parity is read by the reason of the refusal.
const ajv = new Ajv2020({ strict: false, allErrors: true });
for (const model of MODELS) ajv.addSchema(schemaOf(model));
const reference = Object.fromEntries(MODELS.map((m) => [m, ajv.getSchema(`urn:promptobus:v1:${m}`)]));

// Fixtures are read from disk, not assembled in the file: the same set is run by
// both validators, and assembled in memory it would be THIS test's set, not the
// shared one.
function fixtures(verdict, model) {
  const dir = path.join(FIXTURES, verdict, model);
  return readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
    .map((name) => ({ name, value: JSON.parse(readFileSync(path.join(dir, name), 'utf8')) }));
}

test('parity: valid fixtures are accepted by both validators', () => {
  for (const model of MODELS) {
    const set = fixtures('valid', model);
    assert.ok(set.length, `model ${model} has no valid fixture`);
    for (const { name, value } of set) {
      const mine = validate(model, value);
      const theirs = reference[model](value);
      assert.equal(mine.ok, true, `${model}/${name}: own validator rejected — ${mine.code} ${mine.at} ${mine.note}`);
      assert.equal(theirs, true, `${model}/${name}: ajv rejected — ${ajv.errorsText(reference[model].errors)}`);
    }
  }
});

test('parity: invalid fixtures are rejected by both validators', () => {
  for (const model of MODELS) {
    const set = fixtures('invalid', model);
    assert.ok(set.length, `model ${model} has no invalid fixture`);
    for (const { name, value } of set) {
      const mine = validate(model, value);
      const theirs = reference[model](value);
      assert.equal(mine.ok, false, `${model}/${name}: own validator let it through`);
      assert.equal(theirs, false, `${model}/${name}: ajv let it through`);
      // The refusal must carry a code: the human text is the adapter's business,
      // and the consumer must parse the refusal by the code.
      assert.ok(ERROR_CODES.includes(mine.code), `${model}/${name}: code «${mine.code}» is not in the list`);
    }
  }
});

test('parity: a newer schema version is a separate code, not generic invalidity', () => {
  // Distinguishing this from corruption is the code's job: a record from the
  // future is blocked without changing the store, and a corrupt one goes to
  // `broken`. One code for both cases would erase the boundary.
  for (const [model, name] of [['task', 'version-newer.json'], ['message', 'version-newer.json'],
    ['artifact', 'version-newer.json']]) {
    const value = JSON.parse(readFileSync(path.join(FIXTURES, 'invalid', model, name), 'utf8'));
    assert.equal(validate(model, value).code, 'schema-version-unsupported', `${model}/${name}`);
  }
  // A version OLDER than the supported one is ordinary invalidity: there is no
  // migration into v1.
  const older = JSON.parse(readFileSync(path.join(FIXTURES, 'invalid', 'task', 'version-older.json'), 'utf8'));
  assert.equal(validate('task', older).code, 'schema-invalid');
});

test('a refusal about unfamiliar fields carries their list as a separate verdict field', () => {
  // The list is for the journal reader: by it "a record written by a mechanism
  // newer than me" is distinct from corruption. A separate field, not a parse of
  // `note`: the refusal text is prose, and a matcher on it would drift with the
  // first wording change.
  for (const [model, extra] of [['task', 'stamp'], ['participant', 'address']]) {
    const value = JSON.parse(readFileSync(path.join(FIXTURES, 'invalid', model, 'extra-field.json'), 'utf8'));
    const verdict = validate(model, value);
    assert.equal(verdict.ok, false, model);
    assert.deepEqual([...verdict.extra], [extra], model);
  }
  // A refusal that is not about extra fields carries no list at all — otherwise
  // the reader would take ordinary corruption for a mix of versions.
  const older = JSON.parse(readFileSync(path.join(FIXTURES, 'invalid', 'task', 'version-older.json'), 'utf8'));
  assert.deepEqual([...validate('task', older).extra], []);
});

test('parity of schema and constant: message types in the schema are the same as in the code', () => {
  // There is no second type list in the code (`VALUE_HOMES`, key `message-types`),
  // but the schema is not code, and the literal-copies gate does not read it.
  // This check holds them together.
  assert.deepEqual(schemaOf('message').properties.type.enum, MESSAGE_TYPES);
});
