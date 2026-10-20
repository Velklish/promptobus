import './home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { openEngine, PromptobusError } from '../dist/index.js';
import { makeSandbox } from './sandbox.mjs';

const DIST = new URL('../dist/index.js', import.meta.url).href;
const PAYLOAD = Buffer.from('Public attachment retained across terminal ordering.\n');
const allow = () => ({ allow: true });
const person = (id, role = 'worker') => ({
  id, role, harness: 'fixture', mode: 'managed', sessionRef: id, capabilities: null, metadata: {},
});
const jsonFiles = directory => fs.existsSync(directory)
  ? fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort() : [];

function fixture(t) {
  const root = makeSandbox('promptobus-v1-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = openEngine({ root, recover: false, policy: allow });
  const task = 'terminal-artifacts';
  engine.createTask({ id: task, title: 'Terminal artifacts', owner: person('owner', 'orchestrator') });
  engine.assignParticipant(task, person('w-api'));
  engine.assignParticipant(task, person('w-docs'));
  const directory = path.join(engine.home, 'tasks', task);
  const source = path.join(root, 'source.patch');
  const native = path.join(directory, 'files', 'native.patch');
  fs.writeFileSync(source, PAYLOAD);
  return { root, engine, task, directory, source, native,
    reopen: () => openEngine({ root, recover: false, policy: allow }),
    head: () => fs.readFileSync(path.join(engine.home, 'message-order.json'), 'utf8'),
  };
}

function noPrivateFiles(f) {
  assert.equal(fs.existsSync(path.join(f.directory, '.lock')), false);
  assert.equal(fs.existsSync(path.join(f.directory, '.lock-blobs')), false);
  assert.equal(fs.existsSync(path.join(f.engine.home, '.message-order-lock')), false);
  const blobs = path.join(f.directory, 'blobs');
  assert.deepEqual(fs.existsSync(blobs) ? fs.readdirSync(blobs).filter(name => name.startsWith('.tmp-blob-')) : [], []);
}

function admittedChild(f) {
  const code = `
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { openEngine, PromptobusError } from ${JSON.stringify(DIST)};
const root = ${JSON.stringify(f.root)}, task = ${JSON.stringify(f.task)}, native = ${JSON.stringify(f.native)};
let artifact;
const engine = openEngine({ root, recover: false, policy: () => ({ allow: true }), faults(step, info) {
  if (step !== 'artifact') return;
  artifact = info.artifact;
  fs.writeSync(1, JSON.stringify({ ready: true, artifact }) + '\\n');
  const released = spawnSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify("let input = ''; for await (const chunk of process.stdin) input += chunk; if (input !== 'release' + String.fromCharCode(10)) process.exit(2);")}],
    { stdio: [0, 'pipe', 'pipe'], encoding: 'utf8' });
  if (released.status !== 0) throw new Error('release reader exited ' + released.status + ': ' + released.stderr);
} });
try {
  const sent = engine.sendSync(task, { from: 'owner', to: ['w-api'], type: 'artifact', body: 'A admitted artifact',
    artifact: { path: ${JSON.stringify(f.source)}, name(sha256) { engine.linkBlob(task, sha256, native); return 'native.patch'; } } });
  fs.writeSync(1, JSON.stringify({ success: true, message: sent.message.id, artifact }) + '\\n');
} catch (error) {
  if (!(error instanceof PromptobusError)) throw error;
  fs.writeSync(1, JSON.stringify({ code: error.code, context: error.context, artifact }) + '\\n');
}
`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let stdout = '', stderr = '', ready = false;
  let resolveReady, rejectReady;
  const arrived = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (!ready && stdout.includes('\n')) {
      ready = true;
      resolveReady(JSON.parse(stdout.slice(0, stdout.indexOf('\n'))));
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise(resolve => {
    child.on('error', error => { rejectReady(error); resolve({ code: null, stdout, stderr: String(error) }); });
    child.on('close', code => {
      if (!ready) rejectReady(new Error(`child exited before barrier (${code}): ${stderr}`));
      resolve({ code, stdout, stderr });
    });
  });
  return { arrived, done, release: () => child.stdin.end('release\n') };
}

for (const pending of [false, true]) {
  test(`an artifact adopted by ${pending ? 'a committed intent' : 'a canonical message'} survives the original sender's terminal refusal`, async t => {
    const f = fixture(t);
    let baseline;
    if (pending) {
      baseline = f.engine.sendSync(f.task, { from: 'owner', to: ['w-docs'], type: 'artifact', body: 'baseline',
        artifact: { path: f.source, name(sha256) { f.engine.linkBlob(f.task, sha256, f.native); return 'native.patch'; } } });
    }
    const child = admittedChild(f);
    let exited;
    let adoptedId, artifact, blob, beforeBlob;
    try {
      const arrived = await child.arrived;
      assert.equal(arrived.ready, true);
      artifact = f.engine.readArtifact(f.task, arrived.artifact);
      blob = path.join(f.directory, artifact.blob);
      beforeBlob = fs.statSync(blob);
      assert.equal(fs.statSync(f.native).ino, beforeBlob.ino);
      if (baseline) {
        assert.notEqual(artifact.id, baseline.artifact.id);
        assert.equal(artifact.sha256, baseline.artifact.sha256);
      }
      const committedFault = new Error('B paused after its committed intent');
      const adopter = openEngine({ root: f.root, recover: false, policy: allow, faults(step, info) {
        if (pending && step === 'intent') { adoptedId = info.message; throw committedFault; }
      } });
      const sendB = () => adopter.sendSync(f.task, {
        from: 'owner', to: ['w-api'], type: 'artifact', body: 'B adopted artifact', linkArtifact: artifact.id,
      });
      if (pending) {
        assert.throws(sendB, error => error === committedFault);
        assert.deepEqual(jsonFiles(path.join(f.directory, 'intents')), [`${adoptedId}.json`]);
        assert.equal(fs.existsSync(path.join(f.directory, 'messages', `${adoptedId}.json`)), false);
      } else {
        adoptedId = sendB().message.id;
        assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'messages', `${adoptedId}.json`))).artifact, artifact.id);
      }
      const head = f.head();
      assert.equal(f.engine.closeTask(f.task).status, 'done');
      child.release();
      exited = await child.done;
      assert.equal(exited.code, 0, exited.stderr);
      const refusal = JSON.parse(exited.stdout.trim().split('\n').at(-1));
      assert.equal(refusal.code, 'task-closed');
      assert.deepEqual(refusal.context, { task: f.task, status: 'done' });
      assert.equal(f.head(), head, 'the refused A publication reserves no message ID');
    } finally {
      if (!exited) { child.release(); exited = await child.done; }
      assert.equal(exited.code, 0, exited.stderr);
    }
    const healed = f.reopen();
    const recovery = healed.recover(f.task);
    assert.deepEqual(recovery.failed, []);
    assert.deepEqual(recovery.broken, []);
    if (pending) {
      assert.deepEqual(recovery.events.map(event => event.address), ['w-api']);
      assert.deepEqual(recovery.repairs.map(repair => repair.message), [adoptedId]);
      assert.deepEqual(healed.readArtifact(f.task, baseline.artifact.id), baseline.artifact);
    } else assert.deepEqual(recovery.repairs, []);
    assert.equal(healed.readTask(f.task).status, 'done');
    assert.deepEqual(healed.readArtifact(f.task, artifact.id), artifact);
    assert.deepEqual(healed.readArtifactContent(f.task, artifact.id), PAYLOAD);
    assert.equal(fs.statSync(blob).ino, beforeBlob.ino);
    assert.equal(fs.statSync(f.native).ino, beforeBlob.ino);
    assert.deepEqual(fs.readFileSync(f.native), PAYLOAD);
    assert.deepEqual(healed.read(f.task, 'w-api').messages.map(message => message.id), [adoptedId]);
    const again = healed.recover(f.task);
    assert.deepEqual(again.events, []);
    assert.deepEqual(again.repairs, []);
    assert.equal(healed.unread(f.task, 'w-api'), 0);
    assert.deepEqual(healed.facts(f.task).messages.filter(message => message.body === 'A admitted artifact'), []);
    noPrivateFiles(f);
  });
}

test('a synchronous file callback keeps its public native link when close wins after validation', t => {
  const f = fixture(t);
  const head = f.head();
  let named = 0, published;
  const sending = openEngine({ root: f.root, recover: false, policy: allow, faults(step, info) {
    if (step === 'validate') f.engine.closeTask(f.task);
    if (step === 'artifact') published = info.artifact;
  } });
  assert.throws(() => sending.sendSync(f.task, {
    from: 'owner', to: ['w-api'], type: 'artifact', body: 'rejected fresh file',
    artifact: { path: f.source, name(sha256) { named += 1; sending.linkBlob(f.task, sha256, f.native); return 'native.patch'; } },
  }), error => error instanceof PromptobusError && error.code === 'task-closed');
  assert.equal(named, 1);
  assert.equal(f.head(), head);
  const healed = f.reopen();
  const artifact = healed.readArtifact(f.task, published);
  assert.equal(fs.statSync(f.native).ino, fs.statSync(path.join(f.directory, artifact.blob)).ino);
  assert.deepEqual(fs.readFileSync(f.native), PAYLOAD);
  assert.deepEqual(healed.recover(f.task).events, []);
  assert.deepEqual(healed.facts(f.task).messages, []);
  noPrivateFiles(f);
});

for (const close of [false, true]) {
  test(`a failed artifact stream preserves its original error ${close ? 'after close' : 'while active'}`, async t => {
    const f = fixture(t);
    const original = new Error('source failed after its first chunk');
    let entered, release;
    const barrier = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const source = Readable.from((async function* () {
      yield Buffer.from('partial bytes');
      entered();
      await gate;
      throw original;
    })());
    const outcome = f.engine.send(f.task, { from: 'owner', to: ['w-api'], type: 'artifact', body: 'failed source',
      artifact: { filename: 'failed.patch', stream: source } }).then(value => ({ value }), error => ({ error }));
    await barrier;
    if (close) assert.equal(f.engine.closeTask(f.task).status, 'done');
    release();
    assert.equal((await outcome).error, original);
    const healed = f.reopen();
    assert.deepEqual(healed.listArtifacts(f.task), { artifacts: [], broken: [] });
    assert.deepEqual(healed.facts(f.task).messages, []);
    assert.equal(healed.readTask(f.task).status, close ? 'done' : 'active');
    noPrivateFiles(f);
    if (!close) assert.equal(healed.sendSync(f.task, {
      from: 'owner', to: ['w-api'], type: 'status', body: 'after source failure',
    }).message.body, 'after source failure');
  });
}

for (const step of ['intent', 'canonical', 'ref', 'close']) {
  test(`a committed artifact survives the ${step} fault and done-task recovery`, async t => {
    const f = fixture(t);
    const original = new Error(`committed ${step} failure`);
    let artifactId, messageId;
    const broken = openEngine({ root: f.root, recover: false, policy: allow, faults(which, info) {
      if (which === 'artifact') artifactId = info.artifact;
      if (which === 'intent') messageId = info.message;
      if (which === step) throw original;
    } });
    await assert.rejects(() => broken.send(f.task, {
      from: 'owner', to: ['w-api', 'w-docs'], type: 'artifact', body: `committed ${step}`,
      artifact: { filename: 'committed.patch', stream: Readable.from([PAYLOAD]) },
    }), error => error === original);
    const head = f.head();
    if (step === 'ref') assert.deepEqual(broken.read(f.task, 'w-api').messages.map(message => message.id), [messageId]);
    f.engine.closeTask(f.task);
    const healed = f.reopen();
    assert.equal(healed.readTask(f.task).status, 'done');
    assert.deepEqual(healed.readArtifactContent(f.task, artifactId), PAYLOAD);
    const recovery = healed.recover(f.task);
    assert.deepEqual(recovery.failed, []);
    assert.deepEqual(recovery.broken, []);
    if (step === 'ref') {
      assert.deepEqual(recovery.repairs[0].recipients, ['w-docs']);
      assert.deepEqual(recovery.events.map(event => event.address), ['w-docs']);
      assert.equal(healed.unread(f.task, 'w-api'), 0);
    } else assert.equal(healed.unread(f.task, 'w-api'), 1);
    assert.deepEqual(healed.read(f.task, 'w-docs').messages.map(message => message.id), [messageId]);
    assert.equal(healed.facts(f.task).messages.find(message => message.id === messageId).artifact, artifactId);
    assert.equal(f.head(), head);
    const again = healed.recover(f.task);
    assert.deepEqual(again.repairs, []);
    assert.deepEqual(again.events, []);
    noPrivateFiles(f);
  });
}

test('artifact and committed intent survive assignment task.json EIO before finish returns', async t => {
  const f = fixture(t);
  const original = Object.assign(new Error('assignment task.json replacement failed'), { code: 'EIO' });
  const rename = fs.renameSync;
  let refused = 0, artifactId;
  const broken = openEngine({ root: f.root, recover: false, policy: allow, faults(step, info) {
    if (step === 'artifact') artifactId = info.artifact;
  } });
  fs.renameSync = (source, target) => {
    if (String(target) === f.engine.taskFile(f.task) && refused === 0) { refused += 1; throw original; }
    return rename(source, target);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => broken.send(f.task, {
      from: 'owner', to: ['w-api'], type: 'task', body: 'assignment committed before EIO',
      artifact: { filename: 'assignment.patch', stream: Readable.from([PAYLOAD]) },
    }), error => error === original);
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(refused, 1);
  const retained = f.reopen();
  const intents = jsonFiles(path.join(f.directory, 'intents'));
  assert.equal(intents.length, 1);
  const committed = JSON.parse(fs.readFileSync(path.join(f.directory, 'intents', intents[0])));
  assert.equal(committed.artifact, artifactId);
  assert.equal(committed.type, 'task');
  assert.deepEqual(jsonFiles(path.join(f.directory, 'messages')), []);
  assert.deepEqual(retained.readArtifactContent(f.task, artifactId), PAYLOAD);
  const head = f.head();
  retained.closeTask(f.task);
  const healed = f.reopen();
  const recovery = healed.recover(f.task);
  assert.deepEqual(recovery.events.map(event => event.address), ['w-api']);
  const facts = healed.facts(f.task);
  assert.equal(facts.task.status, 'done');
  assert.deepEqual(facts.messages, [committed]);
  assert.deepEqual(healed.readArtifactContent(f.task, artifactId), PAYLOAD);
  assert.equal(f.head(), head);
  assert.deepEqual(healed.recover(f.task).events, []);
  noPrivateFiles(f);
});
