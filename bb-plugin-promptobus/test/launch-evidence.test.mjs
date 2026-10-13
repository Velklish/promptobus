import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openEngine, newTaskIdentity } from 'promptobus';
import { validateLaunchContext, validateControl } from '../.test-build/launch-context.js';
import { validateReviewEvidence } from '../.test-build/review-evidence.js';
import { launchFixture, evidenceFixture, sha256 } from './evidence-fixture.mjs';

const tools = ['promptobus_task', 'promptobus_mailbox', 'promptobus_artifact', 'promptobus_send'];
const binding = { task: 'fixture-task', participant: 'worker', role: 'worker', environmentPath: '/owned', branch: 'main', baseSha: 'a'.repeat(40) };
const context = () => launchFixture(binding.task, binding.participant, binding.role, binding.environmentPath);

test('launch admission names missing role, unreadable declared roots and absent control route', () => {
  for (const [change, field] of [
    [c => { delete c.role; }, /role/],
    [c => { c.role.literal = 'Incomplete declared role'; }, /role literal/],
    [c => { c.readRoots = ['/elsewhere']; }, /readRoots/],
    [c => { delete c.control; }, /control/],
    [c => { c.control = { mode: 'file', path: '/private/control.json' }; }, /control.path/],
  ]) {
    const c = context(); change(c);
    assert.throws(() => validateLaunchContext(binding, c, tools), field);
  }
});

test('a valid literal role and inline constrained reader admit independently of an empty catalog', () => {
  const c = context();
  assert.equal(validateLaunchContext(binding, c, tools).role.name, 'promptobus-worker');
  assert.equal(c.control.mode, 'inline');
  assert.equal(JSON.stringify(c).includes('/private/control'), false);
});

test('ambiguous native or missing BB tool bindings refuse without an alternative identity', () => {
  for (const inventory of [tools.filter(t => t !== 'promptobus_task'), [...tools, 'mcp__native__promptobus_task']]) {
    assert.throws(() => validateLaunchContext(binding, context(), inventory), /binding missing or ambiguous/);
  }
  const c = context(); c.grant.actor = 'other';
  assert.throws(() => validateLaunchContext(binding, c, tools), /actor/);
});

test('an ended token remains terminal while the same actor can receive a fresh bounded phase', () => {
  const c = context(); c.control.snapshot.endedTokens.push(c.grant.token);
  assert.throws(() => validateLaunchContext(binding, c, tools), /ended token/);
  c.grant.token = 'fresh-token'; c.grant.phase = 'evidence-repair';
  c.control.snapshot.grant = structuredClone(c.grant);
  assert.equal(validateLaunchContext(binding, c, tools).grant.phase, 'evidence-repair');
  const changed = structuredClone(c.control.snapshot); changed.grant.token = 'other';
  assert.throws(() => validateControl(c, changed), /current grant mismatch/);
});

async function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pb-evidence-original-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const task = newTaskIdentity('original').id;
  openEngine({ root, recover: false, policy: () => ({ allow: true }) }).createTask({ id: task, title: 'Original opaque evidence fixture', owner: {
    id: 'orchestrator', role: 'orchestrator', harness: 'bb', mode: 'managed', sessionRef: null, capabilities: null, metadata: {},
  } });
  const f = await evidenceFixture(root, task);
  const expected = { source: f.manifest.source, base: f.manifest.base, producer: 'orchestrator', requiredGates: [['fiction', 'gate']], requirePassingGates: true };
  return { ...f, root, task, validate: m => validateReviewEvidence(m ?? f.manifest, expected, async id => {
    const record = f.records.get(id);
    if (!record) throw new Error(`Artifact not found: ${id}`);
    return record;
  }) };
}

test('original manifest is complete before the first review and not-run checks stay not-run', async t => {
  const f = await fixture(t); const admitted = await f.validate();
  assert.equal(admitted.artifacts.length, 7);
  assert.equal(admitted.checks.mutationProbe.status, 'notRun');
  assert.equal(admitted.commands[0].exit, 0);
});

test('wrong IDs, source/base, hashes, producer, missing parts and cropped raw refuse mechanically', async t => {
  const f = await fixture(t);
  for (const [change, error] of [
    [m => { m.source = 'f'.repeat(40); }, /source mismatch/],
    [m => { m.base = 'f'.repeat(40); }, /base mismatch/],
    [m => { m.producer = 'other'; }, /producer mismatch/],
    [m => { m.artifacts[0].sha256 = 'f'.repeat(64); }, /bytes\/hash/],
    [m => { m.artifacts[0].sender = 'other'; }, /producer\/sender/],
    [m => { m.artifacts.shift(); }, /missing.*raw part/],
    [m => { m.commands[0].direct = false; }, /direct/],
    [m => { delete m.checks.treeState; }, /treeState/],
  ]) {
    const m = structuredClone(f.manifest); change(m);
    await assert.rejects(f.validate(m), error);
  }
  const record = f.records.get(f.manifest.artifacts[0].id);
  record.content = record.content.slice(0, -5);
  await assert.rejects(f.validate(), /bytes\/hash/);
});

test('message IDs are not artifact IDs and a delayed original part admits zero reviewers', async t => {
  const f = await fixture(t);
  const engine = openEngine({ root: f.root, recover: false, policy: () => ({ allow: true }) });
  const sent = await engine.send(f.task, { from: 'orchestrator', to: ['orchestrator'], type: 'status', body: 'Normal message fixture.' });
  const m = structuredClone(f.manifest); m.artifacts[0].id = sent.message.id;
  await assert.rejects(f.validate(m), /Artifact not found/);
  const id = f.manifest.artifacts[0].id; const part = f.records.get(id); f.records.delete(id);
  let starts = 0;
  const start = async () => { await f.validate(); starts++; };
  await assert.rejects(start(), /Artifact not found/); assert.equal(starts, 0);
  f.records.set(id, part); await start(); assert.equal(starts, 1);
});

test('unsupported nested or custom verdict inventories cannot be certified as flat complete scopes', async t => {
  const f = await fixture(t);
  const ref = f.manifest.artifacts.find(a => a.kind === 'inventory-source');
  const record = f.records.get(ref.id);
  const payload = JSON.parse(record.content);
  Object.assign(payload, { status: 'complete', format: 'custom', names: ['invented'] });
  record.content = JSON.stringify(payload); record.size = ref.bytes = Buffer.byteLength(record.content);
  record.sha256 = ref.sha256 = sha256(record.content);
  await assert.rejects(f.validate(), /unsupported inventory certification/);
});

test('a pipeline-masked summary cannot replace the original nonzero direct receipt', async t => {
  const f = await fixture(t);
  const ref = f.manifest.artifacts.find(a => a.kind === 'receipt'); const record = f.records.get(ref.id);
  const original = JSON.parse(record.content); original.exit = 7;
  record.content = JSON.stringify(original); record.size = ref.bytes = Buffer.byteLength(record.content);
  record.sha256 = ref.sha256 = sha256(record.content);
  await assert.rejects(f.validate(), /original direct receipt exit mismatch/);
});

test('complete supported inventories preserve duplicate names and refuse a lost verdict occurrence', async t => {
  const f = await fixture(t);
  const raw = '✔ same (name) (1ms)\n✔ same (name) (2ms)\nℹ tests 2\nℹ suites 0\nℹ pass 2\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 3\n';
  const scope = await f.land('raw', raw);
  for (const kind of ['inventory-base', 'inventory-source']) {
    const ref = f.manifest.artifacts.find(a => a.kind === kind), record = f.records.get(ref.id);
    const inventory = { tree: kind === 'inventory-base' ? f.manifest.base : f.manifest.source, by: 'orchestrator',
      status: 'complete', format: 'node-spec-flat', raw: scope, names: ['same (name)', 'same (name)'] };
    record.content = JSON.stringify(inventory); record.size = ref.bytes = Buffer.byteLength(record.content);
    record.sha256 = ref.sha256 = sha256(record.content);
  }
  const checks = f.manifest.checks; checks.verdictNames = { status: 'complete', detail: { removed: [] } };
  const ref = f.manifest.artifacts.find(a => a.kind === 'handover'), record = f.records.get(ref.id);
  const handover = JSON.parse(record.content); handover.checks = checks;
  record.content = JSON.stringify(handover); record.size = ref.bytes = Buffer.byteLength(record.content); record.sha256 = ref.sha256 = sha256(record.content);
  assert.equal((await f.validate()).checks.verdictNames.status, 'complete');
  const inv = f.manifest.artifacts.find(a => a.kind === 'inventory-source'), payload = f.records.get(inv.id);
  const value = JSON.parse(payload.content); value.names.pop(); payload.content = JSON.stringify(value);
  payload.size = inv.bytes = Buffer.byteLength(payload.content); payload.sha256 = inv.sha256 = sha256(payload.content);
  await assert.rejects(f.validate(), /verdict occurrences mismatch/);
});

test('review boundary: env cannot hide a shell pipeline inside a direct collector receipt', async t => {
  const f = await fixture(t), command = ['env', 'CACHE=fixture', 'sh', '-c', 'exit 7 | cat'];
  f.manifest.requiredGates = [command]; f.manifest.commands[0].command = command;
  const ref = f.manifest.artifacts.find(a => a.kind === 'receipt'), record = f.records.get(ref.id);
  const receipt = JSON.parse(record.content); receipt.command = command;
  record.content = JSON.stringify(receipt); record.size = ref.bytes = Buffer.byteLength(record.content); record.sha256 = ref.sha256 = sha256(record.content);
  const expected = { source: f.manifest.source, base: f.manifest.base, producer: 'orchestrator', requiredGates: [command], requirePassingGates: true };
  await assert.rejects(validateReviewEvidence(f.manifest, expected, async id => f.records.get(id)), /shell.*unsupported|runner executable directly/);
});

test('review command launcher: direct env receipt admits and unsupported env split syntax refuses', async t => {
  const f = await fixture(t);
  const ref = f.manifest.artifacts.find(a => a.kind === 'receipt'), record = f.records.get(ref.id);
  const validateCommand = async command => {
    f.manifest.requiredGates = [command]; f.manifest.commands[0].command = command;
    const receipt = JSON.parse(record.content); receipt.command = command;
    record.content = JSON.stringify(receipt); record.size = ref.bytes = Buffer.byteLength(record.content); record.sha256 = ref.sha256 = sha256(record.content);
    return validateReviewEvidence(f.manifest, { source: f.manifest.source, base: f.manifest.base, producer: 'orchestrator',
      requiredGates: [command], requirePassingGates: true }, async id => f.records.get(id));
  };
  assert.equal((await validateCommand(['env', '--', 'CACHE=fixture', 'node', 'gate.mjs'])).commands.length, 1);
  await assert.rejects(validateCommand(['env', '-S', 'sh -c exit']), /Unsupported env launcher/);
  await assert.rejects(validateCommand(['env', 'env', 'sh', '-c', 'exit 7 | cat']), /Unsupported env launcher/);
});

test('review2 boundary: POSIX dash ash ksh shell receipts refuse manifest admission', async t => {
  const f = await fixture(t), ref = f.manifest.artifacts.find(a => a.kind === 'receipt'), record = f.records.get(ref.id);
  for (const shell of ['dash', 'ash', 'ksh']) {
    const command = ['env', 'CACHE=fixture', '/bin/'+shell, '-c', 'exit 7 | /bin/cat'];
    f.manifest.requiredGates = [command]; f.manifest.commands[0].command = command;
    const receipt = JSON.parse(record.content); receipt.command = command;
    record.content = JSON.stringify(receipt); record.size = ref.bytes = Buffer.byteLength(record.content); record.sha256 = ref.sha256 = sha256(record.content);
    await assert.rejects(validateReviewEvidence(f.manifest, { source: f.manifest.source, base: f.manifest.base, producer: 'orchestrator', requiredGates: [command], requirePassingGates: true }, async id => f.records.get(id)), /runner executable directly/);
  }
});
