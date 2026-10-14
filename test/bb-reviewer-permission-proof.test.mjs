import './home.mjs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { verifyToolInventory, verifyPatchDenial, permissionExecSource, finalizeCanaries, main } from '../scripts/prove-bb-reviewer-permissions.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/bb-reviewer/tool-inventory-array.json', import.meta.url)));
const expected = ['apply_patch', 'clock__curr_time', 'list_mcp_resource_templates', 'list_mcp_resources',
  'pb_review_list_files', 'pb_review_read_file', 'pb_review_read_files', 'pb_review_search_text', 'read_mcp_resource'];
const output = text => [{ payload: { type: 'custom_tool_call_output', output: [{ type: 'input_text', text }] } }];

test('permission proof accepts the captured evaluated inventory array and the evaluated object form', () => {
  assert.deepEqual(verifyToolInventory(fixture, expected), [...expected].sort());
  assert.deepEqual(verifyToolInventory(output(JSON.stringify({ ALL_TOOLS: expected })), expected), [...expected].sort());
});

test('permission proof rejects malformed, missing, ambiguous and unclassified inventory without assistant prose', () => {
  for (const items of [output('malformed'), [], output(JSON.stringify({ ALL_TOOLS: [...expected, 'exec_command'] })),
    output(JSON.stringify({ ALL_TOOLS: [...expected, 'mcp__canonical__write'] })),
    output(JSON.stringify({ ALL_TOOLS: [...expected, 42] })), [...fixture, ...fixture],
    [{ payload: { type: 'message', output: [{ type: 'input_text', text: JSON.stringify({ ALL_TOOLS: expected }) }] } }]]) {
    assert.throws(() => verifyToolInventory(items, expected));
  }
});

test('permission proof records both real after hashes before refusing a mutated canary', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'promptobus-review-files-bb-version-'));
  const files = { canary: path.join(directory, 'canary'), outside: path.join(directory, 'outside') };
  const hash = text => createHash('sha256').update(text).digest('hex');
  const evidence = { beforeHashes: { canary: hash('UNCHANGED'), outside: hash('OUTSIDE') }, verdict: 'FAIL', error: 'original assertion' };
  try {
    writeFileSync(files.canary, 'MUTATED'); writeFileSync(files.outside, 'OUTSIDE');
    assert.throws(() => finalizeCanaries(evidence, files), /Scratch canaries unchanged/);
    assert.deepEqual(evidence.afterHashes, { canary: hash('MUTATED'), outside: hash('OUTSIDE') });
    assert.equal(evidence.verdict, 'FAIL'); assert.equal(evidence.error, 'original assertion');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('permission proof records an unavailable after hash as unknown alongside the measured file', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'promptobus-review-files-bb-version-'));
  const files = { canary: path.join(directory, 'absent'), outside: path.join(directory, 'outside') };
  const hash = createHash('sha256').update('OUTSIDE').digest('hex');
  const evidence = { beforeHashes: { canary: 'unmeasured', outside: hash }, verdict: 'FAIL' };
  try {
    writeFileSync(files.outside, 'OUTSIDE');
    assert.throws(() => finalizeCanaries(evidence, files), /canary.*unavailable/);
    assert.deepEqual(evidence.afterHashes, { canary: null, outside: hash });
    assert.match(evidence.hashErrors.canary, /ENOENT/);
    assert.equal(evidence.verdict, 'FAIL');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('permission proof failure cleanup records real hashes and preserves the original refusal before scratch removal', async () => {
  const spawn = childProcess.spawn;
  const log = console.log;
  const argv = process.argv;
  const exitCode = process.exitCode;
  const control = process.env.PB_TEST_CONTROL;
  let evidence;
  childProcess.spawn = (_, args, options) => spawn(process.execPath,
    [new URL('./fixtures/bb-reviewer/app-server.mjs', import.meta.url).pathname, ...args], options);
  syncBuiltinESMExports();
  console.log = text => { evidence = JSON.parse(text); };
  process.argv = [process.execPath, 'proof-test', '--before'];
  process.env.PB_TEST_CONTROL = 'home';
  try {
    await main();
    assert.equal(evidence.verdict, 'FAIL');
    assert.equal(evidence.error.message, 'Codex reviewer did not use its private home; no thread started');
    assert.deepEqual(evidence.afterHashes, evidence.beforeHashes);
    assert.equal(evidence.scratchRemoved, true);
    assert.equal(evidence.childReaped, true);
  } finally {
    childProcess.spawn = spawn; syncBuiltinESMExports(); console.log = log;
    process.argv = argv; process.exitCode = exitCode;
    if (control === undefined) delete process.env.PB_TEST_CONTROL;
    else process.env.PB_TEST_CONTROL = control;
  }
});

const denialFixture = JSON.parse(readFileSync(new URL('./fixtures/bb-reviewer/native-patch-denial.json', import.meta.url)));

test('permission proof rejects denial text without a runtime-linked canary patch call', () => {
  const { canary, outside, turnId, stderr } = denialFixture;
  const text = 'writing is blocked by read-only sandbox';
  for (const items of [
    [{ payload: { type: 'custom_tool_call', name: 'exec', input: '// ' + text } }],
    [{ payload: { type: 'message', content: [{ type: 'output_text', text }] } }],
    output(JSON.stringify({ denial: text })),
    [{ payload: { type: 'custom_tool_call', name: 'exec', input: 'text(' + JSON.stringify(text) + ');' } }],
  ]) {
    assert.throws(() => verifyPatchDenial(items, canary, outside, turnId, stderr),
      undefined, 'Model denial text without an attributable patch must fail');
  }
});

test('permission proof accepts the captured work03 exec denial with isolated router stderr', () => {
  const { items, canary, outside, turnId, stderr } = denialFixture;
  assert.doesNotThrow(() => verifyPatchDenial(items, canary, outside, turnId, stderr));
});

test('permission proof rejects mismatched calls, targets and missing runtime patch denial', () => {
  const { items, canary, outside, turnId, stderr } = denialFixture;
  const clone = () => JSON.parse(JSON.stringify(items));
  const unmatched = clone(); unmatched[1].payload.call_id = 'other-call';
  const wrongTurn = clone(); wrongTurn[1].payload.internal_chat_message_metadata_passthrough.turn_id = 'other-turn';
  const wrongTarget = clone(); wrongTarget[0].payload.input = wrongTarget[0].payload.input.replaceAll('canary.txt', 'outside.txt');
  const changedCode = clone(); changedCode[0].payload.input += '// extra code';
  const noId = clone(); delete noId[0].payload.call_id;
  const wrongCallTurn = clone(); wrongCallTurn[0].payload.internal_chat_message_metadata_passthrough.turn_id = 'other-turn';
  const duplicated = [...clone(), clone()[0]];
  const noRuntimeDenial = clone(); noRuntimeDenial[1].payload.output = [{ type: 'input_text', text: 'Printed denial: writing is blocked by read-only sandbox' }];
  for (const [rows, log] of [[unmatched, stderr], [wrongTurn, stderr], [wrongTarget, stderr],
    [noRuntimeDenial, stderr], [changedCode, stderr], [noId, stderr], [wrongCallTurn, stderr], [duplicated, stderr],
    [items, ''], [items, 'writing is blocked by read-only sandbox']]) {
    assert.throws(() => verifyPatchDenial(rows, canary, outside, turnId, log));
  }
});

test('permission proof accepts the exact canonical exec source and rejects printed or commented substitutes', () => {
  const { items, canary, outside, turnId, stderr } = denialFixture;
  const canonical = structuredClone(items);
  canonical[0].payload.input = permissionExecSource(canary, outside);
  assert.equal(verifyPatchDenial(canonical, canary, outside, turnId, stderr).sourceKind, 'canonical');
  for (const input of ['// ' + canonical[0].payload.input, 'text(' + JSON.stringify(canonical[0].payload.input) + ');']) {
    const forged = structuredClone(canonical); forged[0].payload.input = input;
    assert.throws(() => verifyPatchDenial(forged, canary, outside, turnId, stderr));
  }
});
