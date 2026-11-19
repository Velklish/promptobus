import './home.mjs';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { codexDriver } from '../lib/driver-codex.js';
import { readCapture } from '../scripts/codex-schema-contract.mjs';
import { makeSandbox } from './sandbox.mjs';

const fixtures = new URL('./fixtures/codex-app-server/', import.meta.url);
const readme = (version) => readFileSync(new URL(`${version}/README.md`, fixtures), 'utf8');

test('0.164.0 directs readers to the current-contract guide without relabeling native evidence', () => {
  const doc = readme('0.164.0');
  assert.match(doc, /\[parent README\]\(\.\.\/README\.md\) for the current consumed contract/);
  assert.doesNotMatch(doc, /current consumed contract is \[0\.165\.0\]/);
  assert.match(doc, /Live measurements on 2026-10-28/);
});

test('0.165.0 documents the local inventory and the historical 52-schema comparison', () => {
  const doc = readme('0.165.0');
  assert.deepEqual(readdirSync(new URL('0.165.0/', fixtures)).sort(), ['README.md', 'capture-provenance.json']);
  const provenance = JSON.parse(readFileSync(new URL('0.165.0/capture-provenance.json', fixtures), 'utf8'));
  const inventoryCount = Object.keys(provenance.inventory).length;
  assert.match(doc, /retains only this README and the dated `capture-provenance\.json`/);
  assert.match(doc, new RegExp(`\\b${inventoryCount}-file inventory\\b`));
  assert.match(doc, /\]\(https:\/\/github\.com\/Velklish\/promptobus\/commit\/adb620f8\)/);
  assert.match(doc, /`7e0488b7`[^\n]*`4503555d`[^\n]*52 consumed schemas against 0\.164\.0/);
  assert.match(doc, /exact contract comparison against 0\.164\.0 failed/);
  assert.match(doc, /\[parent README\]\(\.\.\/README\.md\) for the current consumed contract/);
  assert.doesNotMatch(doc, /`contract-provenance\.json`|schemas retained here/);
});

test('capture accepts JSON schemas, ignores non-JSON and provenance, and refuses invalid inputs', () => {
  const dir = makeSandbox('codex-capture-contract-');
  const write = (name, text) => writeFileSync(path.join(dir, name), text);
  const marker = 'http://json-schema.org/draft-07/schema#';
  const schema = (body) => JSON.stringify({ $schema: marker, ...body });
  write('Valid.json', schema({ type: 'object' }));
  write('README.md', 'not JSON');
  write('capture-provenance.json', '{}');
  write('contract-provenance.json', '{}');
  assert.deepEqual([...readCapture(dir).keys()], ['Valid.json']);
  write('Valid.json', schema({ type: 'not-a-type' }));
  assert.throws(() => readCapture(dir), /invalid schema/);
  write('Valid.json', schema({ $ref: '#/definitions/missing' }));
  assert.throws(() => readCapture(dir), /unresolved reference/);
  write('Valid.json', schema({ type: 'object' }));
  symlinkSync('Valid.json', path.join(dir, 'link.txt'));
  assert.throws(() => readCapture(dir), /link\.txt: symlink in capture/);
});

test('Codex lift output and instructions make no unmeasured per-call cost claim', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  codexDriver.saidLiftoff({ seen: { role: 'orchestrator', codexHome: 'fixture' } });
  const output = log.mock.calls.map(({ arguments: args }) => args.join(' ')).join('\n');
  assert.match(output, /Codex home: fixture/);
  const instructions = ['worker', 'reviewer', 'approver', 'orchestrator', 'teamlead', 'reporter']
    .map(role => codexDriver.phrases.promptRulesFor(role)).join('\n');
  assert.match(instructions, /Use the already attached persistent MCP servers/);
  for (const text of [output, instructions]) {
    assert.doesNotMatch(text, /auto-reviewer|19 thousand input tokens|3\.4 s|(?:each|every) bus (?:tool )?call[^\n]*costs a turn/i);
  }
});
