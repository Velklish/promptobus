import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { executionSchema } from '../.test-build/protocol.js';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const drivers = readFileSync(new URL('../../docs/reference/05-drivers.md', import.meta.url), 'utf8');

test('BB role documentation does not replace explicitly selected ACP providers with Codex', () => {
  assert.equal(readme.includes('New role threads use built-in Codex except reviewers'), false, 'Remove the blanket Codex-only role claim');
  assert.match(readme, /New role threads use their selected provider/);
});

test('BB driver reference names every execution harness and admitted provider', () => {
  for (const harness of executionSchema.shape.harness.options) assert.ok(drivers.includes(`harness: ${harness}`), harness);
  for (const provider of executionSchema.shape.providerId.options) assert.ok(drivers.includes(`| \`${provider}\` |`), provider);
});

test('BB support limits distinguish ACP fixture coverage from the historical Codex live profile', () => {
  assert.match(readme, /Cursor and OpenCode ACP workers; Cursor ACP approver/);
  assert.match(readme, /SDK fixtures/);
  assert.equal(readme.includes('provider substitution and remote environments refuse'), false, 'Qualify the provider refusal by admission policy');
  assert.match(readme, /Unadmitted providers and remote environments refuse/);
});
