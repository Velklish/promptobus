import './home.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULES = readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
const END = '<!-- backslop:end -->';

test('the repository-local mutation rule names npm run probe outside the generated block', () => {
  const end = RULES.indexOf(END);
  assert.notEqual(end, -1, 'the generated backslop block has no end marker');
  const local = RULES.slice(end + END.length);
  const heading = local.indexOf('## Mutation probes');
  assert.notEqual(heading, -1, 'the repository-local mutation section is missing');
  assert.match(local.slice(heading), /\bnpm run probe\b/,
    'the local mutation section must name npm run probe');
});
