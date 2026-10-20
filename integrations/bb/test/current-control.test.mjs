import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { newTaskIdentity, openEngine } from 'promptobus';
import { publishControl, readCurrentControl, tokenPath, grantDigest, CURRENT_LIMIT, TOKEN_LIMIT } from '../.test-build/control.js';
import { engineOperation } from '../.test-build/engine-host.js';
import { createHostEntry } from '../.test-build/host-integration.js';
import { launchFixture } from './evidence-fixture.mjs';

async function fixture(t, initialize = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-current-control-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const task = newTaskIdentity('control').id;
  const binding = { task, participant: 'orchestrator', role: 'orchestrator', projectId: 'project',
    environmentId: 'environment', environmentPath: root, hostId: 'local', providerId: 'codex', root,
    token: randomUUID(), threadId: null, phase: 'pending', parentThreadId: null,
    lifecycleOwnerThreadId: null, environmentOwner: 'existing', branch: 'main', baseSha: 'a'.repeat(40),
    launchContext: launchFixture(task, 'orchestrator', 'orchestrator', root) };
  const reference = { directory: path.join(root, 'control'), owner: { task, participant: 'orchestrator',
    projectId: binding.projectId, environmentId: binding.environmentId, hostId: binding.hostId, root }, readRoots: [root] };
  binding.launchContext.control = { mode: 'current', reference };
  const input = { reference, ownerConfirmed: true, STOP: false, noNewStages: false,
    grants: { orchestrator: structuredClone(binding.launchContext.grant) } };
  const engine = openEngine({ root, recover: false, policy: () => ({ allow: true }) });
  const currentFile = path.join(reference.directory, 'current.json');
  const current = () => JSON.parse(fs.readFileSync(currentFile, 'utf8'));
  const update = (patch = {}, options = {}) => {
    const { format, revision, ...previous } = current();
    return publishControl({ ...previous, ...patch }, { initialize: false, expectedRevision: revision, binding, denyOnly: false, ...options });
  };
  const reserve = async () => {
    await engineOperation({ operation: 'reserve', binding, create: true, title: 'Current control fixture' });
    binding.threadId = 'thr-owner'; binding.phase = 'ready';
    await engineOperation({ operation: 'finalize', binding });
  };
  if (initialize) { publishControl(input, { initialize: true, expectedRevision: null }); await reserve(); }
  return { root, task, binding, reference, input, engine, currentFile, current, update, reserve };
}

const denied = (result, reason) => {
  assert.equal(result.outcome, 'blocked', JSON.stringify(result));
  assert.equal(result.reason, reason, JSON.stringify(result));
};
const nextGrant = grant => ({ ...structuredClone(grant), token: `${grant.token}-next`, phase: 'review-repair' });

function observeReads(fn) {
  const open = fs.openSync, read = fs.readSync;
  const descriptors = new Map(), reads = [];
  fs.openSync = (file, ...args) => {
    const fd = open(file, ...args); descriptors.set(fd, String(file)); return fd;
  };
  fs.readSync = (fd, ...args) => {
    const bytes = read(fd, ...args); reads.push({ file: descriptors.get(fd), bytes }); return bytes;
  };
  syncBuiltinESMExports();
  try { return { result: fn(), reads }; }
  finally { fs.openSync = open; fs.readSync = read; syncBuiltinESMExports(); }
}

test('current control explicitly initializes before canonical owner reserve and pins the exact reference', async t => {
  const f = await fixture(t, false);
  denied(readCurrentControl(f.binding), 'missing-current');
  await assert.rejects(f.reserve(), /Current control blocked/);
  assert.equal(f.engine.taskExists(f.task), false);
  assert.equal(fs.existsSync(f.currentFile), false);
  const initialized = publishControl(f.input, { initialize: true, expectedRevision: null });
  assert.deepEqual(initialized, { revision: 1, reference: f.reference });
  assert.equal(f.engine.taskExists(f.task), false);
  assert.deepEqual(readCurrentControl(f.binding), { outcome: 'allowed', revision: 1 });
  await f.reserve();
  assert.deepEqual(f.engine.readTask(f.task).adapter.bb.currentControl, f.reference);
  assert.deepEqual(readCurrentControl(f.binding), { outcome: 'allowed', revision: 1 });
  assert.throws(() => publishControl(f.input, { initialize: true, expectedRevision: null }), /initialization-refused/);
});

test('initialization requires supplied confirmation, active grants and a verified pending owner identity', async t => {
  for (const patch of [{ ownerConfirmed: false }, { STOP: true }, { noNewStages: true }, { grants: {} }]) {
    const f = await fixture(t, false);
    assert.throws(() => publishControl({ ...f.input, ...patch }, { initialize: true, expectedRevision: null }), /initial-confirmation/);
    assert.equal(fs.existsSync(f.currentFile), false);
    assert.equal(f.engine.taskExists(f.task), false);
  }
  const f = await fixture(t, false), incomplete = structuredClone(f.input);
  delete incomplete.ownerConfirmed;
  assert.throws(() => publishControl(incomplete, { initialize: true, expectedRevision: null }), /ownerConfirmed/);
  publishControl(f.input, { initialize: true, expectedRevision: null });
  for (const patch of [{ environmentId: 'different' }, { environmentPath: `${f.root}/elsewhere` }, { threadId: 'already-spawned' }, { phase: 'ready' }]) {
    denied(readCurrentControl({ ...f.binding, ...patch }), 'owner-mismatch');
  }
});

test('host control routes admit the exact immutable token and verify a fresh ended predecessor', async t => {
  const f = await fixture(t), host = createHostEntry(), context = { signal: new AbortController().signal };
  const old = f.binding.launchContext.grant, fresh = nextGrant(old);
  const before = JSON.parse(fs.readFileSync(tokenPath(f.reference, old.token), 'utf8'));
  assert.deepEqual(before, { format: 'promptobus-bb-token-v1', task: f.task, actor: old.actor,
    token: old.token, grantSha256: grantDigest(old), state: 'active' });
  await host.handlers.controlPublish({ publication: { ...f.input, grants: { orchestrator: fresh } },
    initialize: false, expectedRevision: 1, binding: f.binding, denyOnly: false }, context);
  denied(readCurrentControl(f.binding), 'grant-mismatch');
  const next = structuredClone(f.binding); next.launchContext.grant = fresh;
  assert.deepEqual(await host.handlers.launchControl({ binding: next, predecessor: old }, context),
    { outcome: 'allowed', revision: 2, predecessorEnded: true });
  assert.equal(JSON.parse(fs.readFileSync(tokenPath(f.reference, old.token), 'utf8')).state, 'ended');
  const predecessorFile = tokenPath(f.reference, old.token), predecessorBytes = fs.readFileSync(predecessorFile);
  fs.unlinkSync(predecessorFile);
  denied(await host.handlers.launchControl({ binding: next, predecessor: old }, context), 'missing-token');
  fs.writeFileSync(predecessorFile, predecessorBytes);
  const changed = structuredClone(old); changed.scope.operations.push('ungranted extra call');
  denied(readCurrentControl(next, changed), 'token-mismatch');
  denied(readCurrentControl(next, fresh), 'predecessor-mismatch');
  const record = JSON.parse(fs.readFileSync(tokenPath(f.reference, old.token), 'utf8'));
  record.state = 'active'; fs.writeFileSync(tokenPath(f.reference, old.token), JSON.stringify(record));
  denied(readCurrentControl(next, old), 'predecessor-active');
});

test('owner publication uses CAS and current STOP, noNewStages and confirmation at each read', async t => {
  const f = await fixture(t);
  f.update({ STOP: true });
  denied(readCurrentControl(f.binding), 'stopped');
  assert.throws(() => f.update({ STOP: false }, { expectedRevision: 1 }), /stale-revision/);
  assert.equal(f.current().revision, 2);
  f.update({ STOP: false, noNewStages: true }); denied(readCurrentControl(f.binding), 'stopped');
  f.update({ noNewStages: false, ownerConfirmed: false }); denied(readCurrentControl(f.binding), 'stopped');
  f.update({ ownerConfirmed: true });
  assert.deepEqual(readCurrentControl(f.binding), { outcome: 'allowed', revision: 5 });
});

test('grant removal ends its immutable token and denies both revival and changed scope', async t => {
  const f = await fixture(t), grant = f.binding.launchContext.grant;
  const changed = structuredClone(grant); changed.scope.operations.push('extra call');
  assert.throws(() => f.update({ grants: { orchestrator: changed } }), /token-mismatch/);
  assert.equal(f.current().revision, 1);
  f.update({ grants: {} });
  assert.equal(JSON.parse(fs.readFileSync(tokenPath(f.reference, grant.token), 'utf8')).state, 'ended');
  denied(readCurrentControl(f.binding), 'grant-mismatch');
  assert.throws(() => f.update({ grants: { orchestrator: grant } }), /ended-token/);
  assert.equal(f.current().revision, 2);
});

for (const kind of ['current', 'token']) for (const condition of ['missing', 'malformed', 'oversized']) {
  test(`${condition} ${kind} refuses admission without legacy fallback`, async t => {
    const f = await fixture(t), file = kind === 'current' ? f.currentFile : tokenPath(f.reference, f.binding.launchContext.grant.token);
    if (condition === 'missing') fs.unlinkSync(file);
    else fs.writeFileSync(file, condition === 'malformed' ? '{broken' : ' '.repeat((kind === 'current' ? CURRENT_LIMIT : TOKEN_LIMIT) + 1));
    const measured = observeReads(() => readCurrentControl(f.binding));
    denied(measured.result, `${condition}-${kind}`);
    if (condition === 'oversized') assert.equal(measured.reads.some(read => read.file === file), false, 'oversized bytes must not be read');
  });
}

test('current/token lookup byte counts stay fixed when multi-megabyte retained history is reformatted and appended', async t => {
  const f = await fixture(t), token = tokenPath(f.reference, f.binding.launchContext.grant.token);
  const history = Array.from({ length: 40000 }, (_, sequence) => ({ sequence, body: 'historical bytes '.repeat(2) }));
  const compact = JSON.stringify(history), pretty = JSON.stringify(history, null, 2);
  assert.ok(Buffer.byteLength(compact) > CURRENT_LIMIT);
  fs.writeFileSync(path.join(f.reference.directory, 'tokens', 'unrelated.json'), 'unrelated bytes\n'.repeat(250000));
  const current = fs.readFileSync(f.currentFile), bytes = current.length + fs.statSync(token).size;
  const totals = [];
  for (const retained of [compact, pretty, `${pretty}\n${compact}\n`]) {
    fs.writeFileSync(path.join(f.reference.directory, 'history.jsonl'), retained);
    const measured = observeReads(() => readCurrentControl(f.binding));
    assert.deepEqual(measured.result, { outcome: 'allowed', revision: 1 });
    assert.deepEqual(measured.reads.map(read => read.file), [f.currentFile, token]);
    const readBytes = measured.reads.reduce((total, read) => total + read.bytes, 0);
    totals.push(readBytes);
    t.diagnostic(JSON.stringify({ kind: 'current-token-lookup', historyBytes: Buffer.byteLength(retained),
      currentBytes: current.length, tokenBytes: fs.statSync(token).size, readBytes, filesRead: measured.reads.length }));
    assert.deepEqual(fs.readFileSync(f.currentFile), current);
  }
  assert.deepEqual(totals, [bytes, bytes, bytes]);
});

test('fresh predecessor current/token lookup reads only current and the two exact token records', async t => {
  const f = await fixture(t), old = f.binding.launchContext.grant, fresh = nextGrant(old);
  f.update({ grants: { orchestrator: fresh } });
  const next = structuredClone(f.binding); next.launchContext.grant = fresh;
  fs.writeFileSync(path.join(f.reference.directory, 'history.jsonl'), 'history\n'.repeat(400000));
  const measured = observeReads(() => readCurrentControl(next, old));
  assert.deepEqual(measured.result, { outcome: 'allowed', revision: 2, predecessorEnded: true });
  const files = [f.currentFile, tokenPath(f.reference, fresh.token), tokenPath(f.reference, old.token)];
  assert.deepEqual(measured.reads.map(read => read.file), files);
  assert.equal(measured.reads.reduce((total, read) => total + read.bytes, 0), files.reduce((total, file) => total + fs.statSync(file).size, 0));
  t.diagnostic(JSON.stringify({ kind: 'predecessor-current-token-lookup',
    historyBytes: fs.statSync(path.join(f.reference.directory, 'history.jsonl')).size,
    readBytes: measured.reads.reduce((total, read) => total + read.bytes, 0), filesRead: measured.reads.length }));
});

test('identical grants from a second source cannot replace the canonical owner reference', async t => {
  const f = await fixture(t), replacement = structuredClone(f.reference);
  const host = createHostEntry(), context = { signal: new AbortController().signal };
  replacement.directory = path.join(f.root, 'control-b');
  fs.cpSync(f.reference.directory, replacement.directory, { recursive: true });
  const current = f.current(); current.reference = replacement;
  fs.writeFileSync(path.join(replacement.directory, 'current.json'), JSON.stringify(current));
  f.update({ STOP: true });
  const files = [f.currentFile, path.join(replacement.directory, 'current.json'),
    tokenPath(f.reference, f.binding.launchContext.grant.token), tokenPath(replacement, f.binding.launchContext.grant.token)];
  const before = files.map(file => fs.readFileSync(file));
  const forged = structuredClone(f.binding); forged.launchContext.control.reference = replacement;
  denied(await host.handlers.launchControl({ binding: forged }, context), 'reference-mismatch');
  denied(await host.handlers.launchControl({ binding: f.binding }, context), 'stopped');
  await assert.rejects(host.handlers.controlPublish({ publication: { ...f.input, reference: replacement },
    initialize: false, expectedRevision: 1, binding: forged, denyOnly: false }, context), /reference-mismatch/);
  await assert.rejects(host.handlers.controlPublish({ publication: { ...f.input, STOP: true },
    initialize: false, expectedRevision: 2, binding: forged, denyOnly: false }, context), /reference-mismatch|owner-mismatch/);
  assert.deepEqual(files.map(file => fs.readFileSync(file)), before, 'rejected A/B substitution must preserve both sources byte-for-byte');
  f.engine.patchTask(f.task, { adapter: { bb: { ...f.engine.readTask(f.task).adapter.bb, currentControl: replacement } } });
  denied(readCurrentControl(f.binding), 'reference-mismatch');
});

test('supplied owner roots and persisted owner identity reject mismatched declarations', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  const wrongRoots = structuredClone(f.binding); wrongRoots.launchContext.control.reference.readRoots = [outside];
  denied(readCurrentControl(wrongRoots), 'reference-mismatch');
  const expandedRoots = structuredClone(f.binding); expandedRoots.launchContext.control.reference.readRoots.push(outside);
  denied(readCurrentControl(expandedRoots), 'reference-mismatch');
  for (const field of ['projectId', 'environmentId', 'hostId']) {
    const changed = structuredClone(f.binding); changed.launchContext.control.reference.owner[field] = 'different';
    denied(readCurrentControl(changed), 'owner-mismatch');
  }
  const movedOwner = structuredClone(f.binding); movedOwner.launchContext.control.reference.owner.root = outside;
  denied(readCurrentControl(movedOwner), 'owner-mismatch');
  const unpublished = await fixture(t, false);
  assert.throws(() => publishControl({ ...unpublished.input, reference: { ...unpublished.reference, readRoots: [outside] } },
    { initialize: true, expectedRevision: null }), /reference-mismatch/);
});

test('initialization refuses symlink control directories and noncanonical owner roots', async t => {
  const f = await fixture(t, false), real = path.join(f.root, 'real-control'), linked = path.join(f.root, 'linked-control');
  fs.mkdirSync(real); fs.symlinkSync(real, linked, 'dir');
  assert.throws(() => publishControl({ ...f.input, reference: { ...f.reference, directory: linked } },
    { initialize: true, expectedRevision: null }), /reference-mismatch/);
  const ownerAlias = path.join(f.root, 'owner-alias'); fs.symlinkSync(f.root, ownerAlias, 'dir');
  assert.throws(() => publishControl({ ...f.input, reference: { ...f.reference, owner: { ...f.reference.owner, root: ownerAlias } } },
    { initialize: true, expectedRevision: null }), /reference-mismatch/);
  assert.equal(fs.existsSync(path.join(real, 'current.json')), false);
  assert.equal(f.engine.taskExists(f.task), false);
});

test('an existing canonical task cannot reinitialize either source after current is removed', async t => {
  const f = await fixture(t), taskBytes = fs.readFileSync(f.engine.taskFile(f.task));
  fs.unlinkSync(f.currentFile);
  for (const directory of [f.reference.directory, path.join(f.root, 'source-b')]) {
    assert.throws(() => publishControl({ ...f.input, reference: { ...f.reference, directory } },
      { initialize: true, expectedRevision: null }), /initialization-refused/);
    assert.equal(fs.existsSync(path.join(directory, 'current.json')), false);
  }
  assert.deepEqual(fs.readFileSync(f.engine.taskFile(f.task)), taskBytes);
  assert.equal(fs.existsSync(path.join(f.root, 'source-b')), false);
});

for (const condition of ['missing', 'malformed']) test(`${condition} canonical task JSON cannot be reinitialized`, async t => {
  const f = await fixture(t), taskFile = f.engine.taskFile(f.task);
  if (condition === 'missing') fs.unlinkSync(taskFile);
  else fs.writeFileSync(taskFile, '{broken');
  const current = fs.readFileSync(f.currentFile);
  assert.throws(() => publishControl(f.input, { initialize: true, expectedRevision: null }), /unreadable-task|initialization-refused/);
  assert.equal(readCurrentControl(f.binding).outcome, 'blocked');
  assert.deepEqual(fs.readFileSync(f.currentFile), current);
});

test('malformed bounded records and invalid references return small diagnostics without echoing unknown payloads or paths', async t => {
  const marker = `UNTRUSTED_DIAGNOSTIC_${'x'.repeat(100000)}`;
  for (const kind of ['current', 'token', 'reference', 'path']) {
    const f = await fixture(t), binding = structuredClone(f.binding);
    if (kind === 'reference') binding.launchContext.control.reference[marker] = 'unknown key';
    else if (kind === 'path') binding.launchContext.control.reference.directory = `relative/${marker}`;
    else {
      const file = kind === 'current' ? f.currentFile : tokenPath(f.reference, binding.launchContext.grant.token);
      const record = JSON.parse(fs.readFileSync(file, 'utf8')); record[marker] = 'untrusted payload';
      fs.writeFileSync(file, JSON.stringify(record));
    }
    const result = readCurrentControl(binding), encoded = JSON.stringify(result);
    denied(result, kind === 'current' || kind === 'token' ? `malformed-${kind}` : 'unreadable-current');
    assert.ok(Buffer.byteLength(encoded) <= 1024, `diagnostic must be bounded: ${Buffer.byteLength(encoded)} bytes`);
    assert.equal(encoded.includes('UNTRUSTED_DIAGNOSTIC_'), false);
    assert.equal(encoded.includes(f.root), false);
  }
});

test('historical file or inline bindings and canonical tasks without a reference remain blocked', async t => {
  const f = await fixture(t);
  for (const control of [{ mode: 'file', path: f.currentFile }, launchFixture(f.task, 'orchestrator', 'orchestrator', f.root).control]) {
    const legacy = structuredClone(f.binding); legacy.launchContext.control = control;
    denied(readCurrentControl(legacy), 'migration-required');
  }
  const adapter = { ...f.engine.readTask(f.task).adapter.bb }; delete adapter.currentControl;
  f.engine.patchTask(f.task, { adapter: { bb: adapter } });
  denied(readCurrentControl(f.binding), 'migration-required');
  assert.throws(() => f.update(), /migration-required/);
});

for (const phase of ['closed', 'orphan']) test(`${phase} owner can still revoke through persisted identity but cannot regrant`, async t => {
  const f = await fixture(t), host = createHostEntry(), context = { signal: new AbortController().signal };
  if (phase === 'closed') f.engine.closeTask(f.task);
  else f.binding.phase = 'orphan';
  await assert.rejects(engineOperation({ operation: 'check', binding: f.binding }), /closed|Canonical binding mismatch/);
  await host.handlers.controlPublish({ publication: { ...f.input, STOP: true, noNewStages: true, ownerConfirmed: false, grants: {} },
    initialize: false, expectedRevision: 1, binding: f.binding, denyOnly: true }, context);
  denied(readCurrentControl(f.binding), 'stopped');
  for (const patch of [{ STOP: false }, { noNewStages: false }, { ownerConfirmed: true }, { grants: f.input.grants }]) {
    assert.throws(() => f.update(patch), /deny-only/);
    assert.equal(f.current().revision, 2);
  }
  f.update(); assert.equal(f.current().revision, 3);
  assert.equal(f.engine.readTask(f.task).status, phase === 'closed' ? 'done' : 'active');
});

test('owner publication rejects changed persisted token, provider or session before granting authority', async t => {
  const f = await fixture(t);
  for (const patch of [{ token: randomUUID() }, { providerId: 'other' }, { threadId: 'thr-foreign' }]) {
    assert.throws(() => f.update({ STOP: true }, { binding: { ...f.binding, ...patch } }), /owner-mismatch/);
    assert.equal(f.current().revision, 1);
  }
});

test('omitted internal denyOnly conservatively permits revocation and refuses fresh authority', async t => {
  const f = await fixture(t), fresh = nextGrant(f.binding.launchContext.grant);
  const host = createHostEntry(), context = { signal: new AbortController().signal };
  const publication = { ...f.input, grants: { orchestrator: fresh } };
  assert.throws(() => publishControl(publication, { initialize: false, expectedRevision: 1, binding: f.binding }), /deny-only/);
  await assert.rejects(host.handlers.controlPublish({ publication, initialize: false, expectedRevision: 1, binding: f.binding }, context), /deny-only/);
  await host.handlers.controlPublish({ publication: { ...f.input, STOP: true },
    initialize: false, expectedRevision: 1, binding: f.binding }, context);
  assert.equal(f.current().revision, 2);
  denied(readCurrentControl(f.binding), 'stopped');
});

test('an orphan with no finalized canonical session retains only the persisted deny route', async t => {
  const f = await fixture(t, false);
  publishControl(f.input, { initialize: true, expectedRevision: null });
  await engineOperation({ operation: 'reserve', binding: f.binding, create: true, title: 'Orphan without finalization' });
  f.binding.phase = 'orphan'; f.binding.threadId = 'thr-unconfirmed';
  assert.equal(f.engine.readTask(f.task).participants[0].sessionRef, null);
  f.update({ STOP: true, grants: {} });
  denied(readCurrentControl(f.binding), 'stopped');
  assert.throws(() => f.update({ STOP: false, grants: f.input.grants }), /deny-only/);
  assert.equal(f.current().revision, 2);
  assert.equal(f.engine.readTask(f.task).participants[0].sessionRef, null);
});

test('initialization needs its exact owner grant and cannot reuse one token for two actors', async t => {
  const f = await fixture(t, false), worker = { ...structuredClone(f.input.grants.orchestrator), actor: 'worker' };
  assert.throws(() => publishControl({ ...f.input, grants: { worker } },
    { initialize: true, expectedRevision: null }), /initial-confirmation/);
  assert.throws(() => publishControl({ ...f.input, grants: { ...f.input.grants, worker } },
    { initialize: true, expectedRevision: null }), /token-mismatch/);
  assert.equal(fs.existsSync(f.currentFile), false);
  assert.equal(fs.existsSync(tokenPath(f.reference, worker.token)), false);
});

for (const point of ['tokens', 'current']) test(`publication interrupted after ${point} retains fail-closed token state and exact CAS recovery`, async t => {
  const f = await fixture(t), old = f.binding.launchContext.grant, fresh = nextGrant(old);
  const publication = { ...f.input, grants: { orchestrator: fresh } };
  assert.throws(() => publishControl(publication, { initialize: false, expectedRevision: 1, binding: f.binding, denyOnly: false },
    at => { if (at === point) throw new Error(`interrupted after ${point}`); }), /interrupted after/);
  const next = structuredClone(f.binding); next.launchContext.grant = fresh;
  denied(readCurrentControl(f.binding), point === 'tokens' ? 'ended-token' : 'grant-mismatch');
  if (point === 'tokens') {
    denied(readCurrentControl(next, old), 'grant-mismatch');
    assert.equal(f.current().revision, 1);
    assert.equal(publishControl(publication, { initialize: false, expectedRevision: 1, binding: f.binding, denyOnly: false }).revision, 2);
  } else {
    assert.equal(f.current().revision, 2);
    assert.throws(() => publishControl(publication, { initialize: false, expectedRevision: 1, binding: f.binding, denyOnly: false }), /stale-revision/);
  }
  assert.deepEqual(readCurrentControl(next, old), { outcome: 'allowed', revision: 2, predecessorEnded: true });
});

test('publication takes canonical task lock before current lock and a busy current source stays unavailable', async t => {
  const f = await fixture(t), mkdir = fs.mkdirSync, locks = [];
  fs.mkdirSync = (file, ...args) => { if (path.basename(String(file)) === '.lock') locks.push(String(file)); return mkdir(file, ...args); };
  syncBuiltinESMExports();
  try { f.update(); }
  finally { fs.mkdirSync = mkdir; syncBuiltinESMExports(); }
  const currentLock = path.join(f.reference.directory, '.lock');
  assert.deepEqual(locks, [path.join(path.dirname(f.engine.taskFile(f.task)), '.lock'), currentLock]);
  fs.mkdirSync(currentLock);
  fs.writeFileSync(path.join(currentLock, 'owner'), JSON.stringify({ pid: process.pid, session: 'held-current', since: new Date().toISOString() }));
  const result = readCurrentControl(f.binding);
  assert.equal(result.outcome, 'unavailable'); assert.equal(result.reason, 'lock-busy');
  assert.equal(fs.existsSync(path.join(currentLock, 'owner')), true);
  fs.rmSync(currentLock, { recursive: true });
  assert.deepEqual(readCurrentControl(f.binding), { outcome: 'allowed', revision: 2 });
});
