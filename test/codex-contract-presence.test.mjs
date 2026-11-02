import './home.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { PROVEN_CODEX_VERSION } from '../lib/driver-codex.js';
import { readConsumedContract } from '../scripts/codex-schema-contract.mjs';
import { holderParams } from './codex-contract-witnesses.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const directory = path.join(here, 'fixtures', 'codex-app-server', PROVEN_CODEX_VERSION);
test('committed Codex contract requires the consumed steer response schema', () => {
  const schemas = readConsumedContract(directory, PROVEN_CODEX_VERSION);
  assert.ok(schemas.has('v2/TurnSteerResponse.json'));
});

test('proven Codex review contract accepts the inline witness and rejects removed detached delivery', () => {
  const schemas = readConsumedContract(directory, PROVEN_CODEX_VERSION);
  const ajv = new Ajv({ strict: false, allErrors: true, formats: {
    int64: true, uint64: true, uint32: true, uint: true, double: true, int32: true, uint16: true,
  } });
  const inline = holderParams.ReviewStartParams, detached = { ...inline, delivery: 'detached' };
  for (const [name, accepted, rejected] of [
    ['v2/ReviewStartParams.json', inline, detached],
    ['ClientRequest.json', { id: 1, method: 'review/start', params: inline }, { id: 1, method: 'review/start', params: detached }],
  ]) {
    const validate = ajv.compile(schemas.get(name));
    assert.equal(validate(accepted), true, `${name}: ${ajv.errorsText(validate.errors)}`);
    assert.equal(validate(rejected), false, `${name}: removed detached delivery was accepted`);
  }
});
