import './home.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROVEN_CODEX_VERSION } from '../lib/driver-codex.js';
import { readConsumedContract } from '../scripts/codex-schema-contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const directory = path.join(here, 'fixtures', 'codex-app-server', PROVEN_CODEX_VERSION);
test('committed Codex contract requires the consumed steer response schema', () => {
  const schemas = readConsumedContract(directory, PROVEN_CODEX_VERSION);
  assert.ok(schemas.has('v2/TurnSteerResponse.json'));
});
