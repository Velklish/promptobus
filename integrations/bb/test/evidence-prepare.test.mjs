import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { newTaskIdentity, openEngine } from 'promptobus';
import { recordBbDirectCommand } from 'promptobus/bb-host';
import { prepareCurrentReviewEvidence, currentEvidenceFiles } from '../.test-build/evidence-builder.js';
import { evidenceMain } from '../.test-build/evidence-prepare.js';
import { digest, evidenceManifestSchema, validateReviewEvidence } from '../.test-build/review-evidence.js';
import { publishControl, commandDigest } from '../.test-build/control.js';
import { engineOperation } from '../.test-build/engine-host.js';
import { launchFixture } from './evidence-fixture.mjs';

const runner = fileURLToPath(new URL('../.test-build/command-runner.js', import.meta.url));
async function fixture(t, { admitted = false, exit = 0 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-direct-receipt-'))), repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString().trim();
  git('init', '--quiet'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'Fixture');
  fs.appendFileSync(path.join(repo, '.git/info/exclude'), '\n.promptobus/\n');
  const source = git('rev-parse', 'HEAD'), task = newTaskIdentity('evidence').id;
  const binding = { task, participant: 'orchestrator', role: 'orchestrator', projectId: 'project', environmentId: 'environment', environmentPath: repo,
    hostId: 'local', providerId: 'codex', root: repo, token: randomUUID(), threadId: null, phase: 'pending', parentThreadId: null,
    lifecycleOwnerThreadId: null, environmentOwner: 'existing', branch: 'main', baseSha: source,
    launchContext: launchFixture(task, 'orchestrator', 'orchestrator', root, 'main', source) };
  const grant = binding.launchContext.grant; grant.scope.repository = repo; grant.token = randomUUID();
  const reference = { directory: path.join(root, 'control'), owner: { task, participant: 'orchestrator', projectId: 'project', environmentId: 'environment', hostId: 'local', root: repo }, readRoots: [root] };
  binding.launchContext.control = { mode: 'current', reference };
  const counter = path.join(root, 'counter'), output = path.join(root, 'gate');
  const argv = [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(counter)},'one\\n');process.stdout.write('\u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0430\\n');process.stderr.write('original assertion\\n');process.exitCode=${exit}`];
  if (admitted) {
    const tmp = path.join(root, 'tmp'), cache = path.join(root, 'cache'), build = path.join(root, 'build'), leases = path.join(root, 'leases');
    for (const file of [tmp, cache, build, leases]) fs.mkdirSync(file);
    const env = Object.fromEntries(['TMPDIR', 'TMP', 'TEMP'].map(key => [key, tmp]));
    for (const key of ['XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'npm_config_cache', 'NPM_CONFIG_CACHE', 'npm_config_logs_dir', 'NPM_CONFIG_LOGS_DIR']) env[key] = cache;
    env.PROMPTOBUS_LEASE_DIR = leases;
    grant.execution = { commands: [{ id: 'gate', argv, cwd: repo, env, output, buildRoot: build, tmpRoot: tmp, cacheRoot: cache, exclusiveKeys: [], measurementScope: root }] };
  }
  publishControl({ reference, ownerConfirmed: true, STOP: false, noNewStages: false, grants: { orchestrator: grant } }, { initialize: true, expectedRevision: null });
  await engineOperation({ operation: 'reserve', binding, create: true, title: 'Actual evidence originals fixture' });
  binding.threadId = 'thr-owner'; binding.phase = 'ready'; await engineOperation({ operation: 'finalize', binding });
  const engine = openEngine({ root: repo, recover: false, policy: () => ({ allow: true }) }), uploads = {}, records = new Map();
  let retained = 0;
  t.after(() => {
    if (process.env.PB_FIXTURE_EVIDENCE_DIR) {
      const destination = path.join(process.env.PB_FIXTURE_EVIDENCE_DIR, path.basename(root)); fs.mkdirSync(destination, { recursive: true });
      for (const file of fs.readdirSync(root).filter(file => /\.(?:txt|json)$/.test(file))) fs.copyFileSync(path.join(root, file), path.join(destination, file));
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (name, value) => { const file = path.join(root, name); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  const upload = async file => {
    if (uploads[file]) return uploads[file];
    const result = await engineOperation({ operation: 'uploadEvidence', binding, file, to: 'orchestrator' });
    uploads[file] = result;
    for (const part of result.parts) records.set(part.id, { ...part, content: engine.readArtifactContent(task, part.id).toString('utf8') });
    return result;
  };
  const checks = Object.fromEntries(['verdictNames', 'mutationProbe', 'treeState', 'environmentalRed', 'gatesNotRun'].map(name => [name, { status: 'notRun', reason: 'This fixture exercises originals, not repository acceptance.' }]));
  const baseInventory = write('inventory-base.txt', { tree: source, by: 'orchestrator', status: 'notMeasured', reason: 'No verdict inventory measured in fixture.' });
  const sourceInventory = write('inventory-source.txt', { tree: source, by: 'orchestrator', status: 'notMeasured', reason: 'No verdict inventory measured in fixture.' });
  const input = { source, base: source, producer: 'orchestrator', relayer: 'orchestrator', requiredGates: [argv], requirePassingGates: true,
    checks, commands: [{ receipt: `${output}.receipt.txt`, kind: 'gate' }], inventories: { base: baseInventory, source: sourceInventory }, derived: path.join(root, 'derived') };
  let original;
  if (admitted) {
    const admission = write('admission.json', { binding, commandId: 'gate' }), outerStem = path.join(root, 'launcher');
    const invocation = [process.execPath, runner, '--admission', admission, '--output', output, '--by', 'orchestrator', '--', ...argv];
    original = await recordBbDirectCommand({ command: invocation, stem: outerStem, by: 'orchestrator', cwd: repo });
    input.commands[0].finalization = { receipt: `${outerStem}.receipt.txt`, admission };
    input.commands.push({ receipt: `${outerStem}.receipt.txt`, kind: 'verification' });
  } else original = await recordBbDirectCommand({ command: argv, stem: output, by: 'orchestrator', cwd: repo });
  const expected = { source, base: source, producer: 'orchestrator', requiredGates: [argv], requirePassingGates: true };
  const prepare = async (value = input) => prepareCurrentReviewEvidence(value, { readOriginal: async file => fs.readFileSync(file, 'utf8'), uploaded: upload });
  const stage = async (value = input) => {
    const { files, derived } = await currentEvidenceFiles(value, { readOriginal: async file => fs.readFileSync(file, 'utf8') });
    fs.mkdirSync(value.derived, { recursive: true });
    for (const [file, content] of derived) fs.writeFileSync(file, content);
    for (const file of files.keys()) await upload(file);
    return prepare(value);
  };
  const change = (manifest, id, edit) => {
    const record = records.get(id), ref = manifest.artifacts.find(ref => ref.id === id) ?? manifest.support.artifacts.find(ref => ref.id === id);
    record.content = edit(record.content); record.size = ref.bytes = Buffer.byteLength(record.content); record.sha256 = ref.sha256 = digest(record.content);
  };
  const validate = (manifest, read = async id => { if (!records.has(id)) throw new Error(`Missing actual uploaded original ${id}`); return records.get(id); }) => validateReviewEvidence(manifest, expected, read);
  return { root, repo, source, binding, original, input, uploads, records, engine, task, write, upload, prepare, stage, validate, expected, change,
    counter, output, next: () => retained++, grant };
}

test('canonical preparation uses actual recorder/uploader originals, UTF8 bytes and zero packaging suite replay', async t => {
  const f = await fixture(t), manifest = await f.stage();
  assert.equal(manifest.commands.length, 1); assert.equal(manifest.artifacts.length, 7);
  assert.equal(fs.readFileSync(f.counter, 'utf8'), 'one\n');
  assert.equal(manifest.commands[0].stdout.bytes, Buffer.byteLength('\u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0430\n'));
  const again = await f.prepare(); assert.deepEqual(again, manifest);
  assert.equal(fs.readFileSync(f.counter, 'utf8'), 'one\n');
  assert.equal((await f.validate(manifest)).commands[0].exit, 0);
});

test('legacy manifest parse preserves exact serialization and owner declaration hash without optional defaults', async t => {
  const f = await fixture(t), manifest = await f.stage();
  const canonical = JSON.stringify({ version: manifest.version, source: manifest.source, base: manifest.base, producer: manifest.producer,
    relayer: manifest.relayer, dirty: manifest.dirty, requiredGates: manifest.requiredGates,
    artifacts: manifest.artifacts.map(ref => ({ id: ref.id, kind: ref.kind, sender: ref.sender, producer: ref.producer, bytes: ref.bytes, sha256: ref.sha256 })),
    commands: manifest.commands.map(command => ({ command: command.command, exit: command.exit, direct: command.direct, complete: command.complete,
      tree: command.tree, dirty: command.dirty, by: command.by, timestamp: command.timestamp, kind: command.kind, stdout: command.stdout, stderr: command.stderr, receipt: command.receipt })),
    checks: manifest.checks });
  const parsed = evidenceManifestSchema.parse(JSON.parse(canonical));
  assert.equal(JSON.stringify(parsed), canonical); assert.equal(digest(JSON.stringify(parsed)), digest(canonical));
  assert.equal(Object.hasOwn(parsed, 'support'), false); assert.equal(Object.hasOwn(parsed.commands[0], 'finalization'), false);
});

test('admitted inner complete receipt without terminal launcher finalization is refused', async t => {
  const f = await fixture(t), manifest = await f.stage();
  const stem = path.join(f.root, 'failed-finalization'), admission = { task: f.task, token: 'original-token', phase: 'initial', commandId: 'gate', commandSha256: 'a'.repeat(64) };
  await assert.rejects(recordBbDirectCommand({ command: f.input.requiredGates[0], stem, by: 'orchestrator', cwd: f.repo,
    receiptFields: { admission }, onReceipt: () => { throw new Error('original terminal finalization failure'); } }), /original terminal finalization failure/);
  const original = JSON.parse(fs.readFileSync(`${stem}.receipt.txt`, 'utf8')); assert.equal(original.complete, true);
  const landed = {};
  manifest.artifacts = manifest.artifacts.filter(ref => !['raw', 'receipt'].includes(ref.kind));
  for (const stream of ['stdout', 'stderr', 'receipt']) {
    const upload = await f.upload(`${stem}.${stream}.txt`);
    landed[stream] = { parts: upload.parts.map(part => part.id), bytes: upload.bytes, sha256: upload.sha256 };
    manifest.artifacts.push(...upload.parts.map(part => ({ id: part.id, kind: stream === 'receipt' ? 'receipt' : 'raw', sender: part.sender,
      producer: 'orchestrator', bytes: part.size, sha256: part.sha256 })));
  }
  for (const field of ['command', 'exit', 'direct', 'complete', 'tree', 'dirty', 'by', 'timestamp']) manifest.commands[0][field] = original[field];
  Object.assign(manifest.commands[0], { stdout: landed.stdout, stderr: landed.stderr, receipt: landed.receipt.parts[0] });
  const validator = process.env.PB_BASE_REVIEW_EVIDENCE ? (await import(pathToFileURL(process.env.PB_BASE_REVIEW_EVIDENCE))).validateReviewEvidence : validateReviewEvidence;
  await assert.rejects(validator(manifest, f.expected, async id => f.records.get(id)), /requires original terminal launcher proof/);
});

test('plain original with finalizationComplete false refuses despite complete true and matching exits', async t => {
  const f = await fixture(t), manifest = await f.stage();
  f.change(manifest, manifest.commands[0].receipt, raw => JSON.stringify({ ...JSON.parse(raw), finalizationComplete: false }));
  await assert.rejects(f.validate(manifest), /incomplete/);
});

test('real checked launcher original terminal JSON links gate, admission and outer verification', async t => {
  const f = await fixture(t, { admitted: true }); assert.equal(f.original.exitCode, 0);
  const manifest = await f.stage(); assert.equal(manifest.commands.length, 2);
  assert.equal(manifest.commands[1].kind, 'verification'); assert.equal(fs.readFileSync(f.counter, 'utf8'), 'one\n');
  assert.equal((await f.validate(manifest)).commands[0].exit, 0);
  await f.prepare(); assert.equal(fs.readFileSync(f.counter, 'utf8'), 'one\n');
  for (const [field, value] of [['commandId', 'other-command'], ['commandSha256', 'f'.repeat(64)], ['token', 'other-token']]) {
    const changed = structuredClone(manifest), id = manifest.commands[0].receipt, saved = structuredClone(f.records.get(id));
    f.change(changed, id, raw => { const receipt = JSON.parse(raw); receipt.admission[field] = value; return JSON.stringify(receipt); });
    await assert.rejects(f.validate(changed), /admission mismatch/); f.records.set(id, saved);
  }
});

test('matching launcher exits cannot replace exact terminal frame or exact checked invocation', async t => {
  const f = await fixture(t, { admitted: true }), manifest = await f.stage();
  const outer = manifest.commands[1], id = outer.stdout.parts[0], saved = structuredClone(f.records.get(id));
  const changed = structuredClone(manifest);
  f.change(changed, id, raw => JSON.stringify({ ...JSON.parse(raw), finalizationComplete: false }));
  const scope = changed.commands[1].stdout; scope.bytes = f.records.get(id).size; scope.sha256 = f.records.get(id).sha256;
  f.change(changed, outer.receipt, raw => { const receipt = JSON.parse(raw); Object.assign(receipt.stdout, { bytes: scope.bytes, sha256: scope.sha256 }); return JSON.stringify(receipt); });
  await assert.rejects(f.validate(changed), /terminal launcher frame/); f.records.set(id, saved);
  const originalOuter = JSON.parse(fs.readFileSync(path.join(f.root, 'launcher.receipt.txt'), 'utf8'));
  f.records.set(outer.receipt, { ...f.records.get(outer.receipt), content: JSON.stringify(originalOuter, null, 2) + '\n', size: manifest.artifacts.find(ref => ref.id === outer.receipt).bytes,
    sha256: manifest.artifacts.find(ref => ref.id === outer.receipt).sha256 });
  const invocation = structuredClone(manifest); invocation.commands[1].command[4] = '--wrong-output';
  f.change(invocation, outer.receipt, raw => { const receipt = JSON.parse(raw); receipt.command = invocation.commands[1].command; return JSON.stringify(receipt); });
  await assert.rejects(f.validate(invocation), /invocation/);
});

test('nonzero checked child stays exit 7 and cannot become a passing gate', async t => {
  const f = await fixture(t, { admitted: true, exit: 7 }); assert.equal(f.original.exitCode, 7);
  await assert.rejects(f.stage(), /mandatory gates are not all passing/);
  const manifest = await f.prepare({ ...f.input, requirePassingGates: false });
  assert.deepEqual(manifest.commands.map(command => command.exit), [7, 7]); assert.equal(fs.readFileSync(f.counter, 'utf8'), 'one\n');
});

test('unfinished recorder originals and changed original raw refuse without command replay', async t => {
  const f = await fixture(t), file = f.input.commands[0].receipt, original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), complete: false }));
  await assert.rejects(f.prepare(), /not finalized/); fs.writeFileSync(file, original);
  fs.appendFileSync(`${f.output}.stdout.txt`, 'cropped replacement');
  await assert.rejects(f.prepare(), /stream bytes\/hash/); assert.equal(fs.readFileSync(f.counter, 'utf8'), 'one\n');
});

test('actual ordered uploader parts retain UTF8 boundaries and size maps to manifest bytes', async t => {
  const f = await fixture(t), raw = '\u044f'.repeat(450000) + '\u044e', file = f.write('unicode-original.txt', raw), upload = await f.upload(file);
  assert.equal(upload.parts.length, 2); assert.deepEqual(upload.parts.map(part => part.size), [900000, 2]);
  assert.equal(upload.bytes, Buffer.byteLength(raw));
  const scope = { parts: upload.parts.map(part => part.id), bytes: upload.bytes, sha256: upload.sha256 };
  const inventory = JSON.parse(fs.readFileSync(f.input.inventories.source, 'utf8')); inventory.raw = scope;
  fs.writeFileSync(f.input.inventories.source, JSON.stringify(inventory)); f.input.inventoryRaw = [file];
  const manifest = await f.stage();
  assert.deepEqual(manifest.artifacts.filter(ref => scope.parts.includes(ref.id)).map(ref => ref.bytes), [900000, 2]);
  const saved = f.uploads[file]; f.uploads[file] = { ...saved, parts: [...saved.parts].reverse() };
  await assert.rejects(f.prepare(), /upload part hash/); f.uploads[file] = saved;
});

test('local upload-response consistency rejects missing IDs, hashes, sizes and wrong sender', async t => {
  const f = await fixture(t); await f.stage();
  const file = `${f.output}.stdout.txt`, saved = structuredClone(f.uploads[file]);
  for (const change of [upload => { upload.parts[0].sha256 = 'f'.repeat(64); }, upload => { upload.parts[0].size--; }, upload => { upload.parts[0].sender = 'wrong-relayer'; }]) {
    const changed = structuredClone(saved); change(changed); f.uploads[file] = changed;
    await assert.rejects(f.prepare(), /hash|size|producer\/sender/);
  }
  f.uploads[file] = saved;
  await assert.rejects(prepareCurrentReviewEvidence(f.input, { readOriginal: async file => fs.readFileSync(file, 'utf8'), uploaded: async file => file.endsWith('.stdout.txt') ? undefined : f.uploads[file] }));
});

test('two-phase CLI stages immutable files and reuses actual upload results without another child', async t => {
  const f = await fixture(t), input = f.write('preparation.json', f.input);
  const plan = await evidenceMain(['--input', input, '--stage', f.input.derived]);
  assert.equal(plan.files.length, 7); assert.equal(plan.files.includes(path.join(f.input.derived, 'gate.txt')), true);
  await assert.rejects(evidenceMain(['--input', input, '--stage', f.input.derived]), /EEXIST/);
  for (const file of plan.files) await f.upload(file);
  const results = f.write('uploads.json', f.uploads), manifest = await evidenceMain(['--input', input, '--uploads', results]);
  assert.equal(manifest.commands.length, 1); assert.equal(fs.readFileSync(f.counter, 'utf8'), 'one\n');
});

test('large retained multipart history reads only current, index and required historical failure originals', async t => {
  const f = await fixture(t), compact = await f.stage();
  const artifacts = [], entries = [], historicalBase = 'b'.repeat(40), oldProducer = 'earlier-worker';
  const refs = (upload, source = f.source, producer = 'orchestrator') => upload.parts.map(part => ({ id: part.id, sender: part.sender, producer,
    source, base: historicalBase, bytes: part.size, sha256: part.sha256 }));
  const scope = upload => ({ parts: upload.parts.map(part => part.id), bytes: upload.bytes, sha256: upload.sha256 });
  for (let i = 0; i < 1000; i++) {
    const file = f.write(`history-${i}.txt`, `Unselected immutable historical read ${i}: \u0438\u0441\u0442\u043e\u0440\u0438\u044f\n`), upload = await f.upload(file);
    artifacts.push(...refs(upload)); entries.push({ id: `history-${i}`, kind: 'raw', source: f.source, base: historicalBase,
      producer: 'orchestrator', raw: scope(upload) });
  }
  const stem = path.join(f.root, 'historical-failure');
  const failed = await recordBbDirectCommand({ command: [process.execPath, '-e', "process.stderr.write('AssertionError: original historical failure\\n');process.exitCode=7"],
    stem, by: oldProducer, cwd: f.repo });
  assert.equal(failed.exitCode, 7);
  const selected = [];
  const old = {};
  for (const stream of ['receipt', 'stdout', 'stderr']) {
    const file = `${stem}.${stream}.txt`, upload = await f.upload(file); selected.push(file);
    artifacts.push(...refs(upload, f.source, oldProducer)); old[stream] = scope(upload);
  }
  entries.push({ id: 'relevant-old-failure', kind: 'receipt', source: f.source, base: historicalBase, producer: oldProducer,
    raw: old.receipt, streams: { stdout: old.stdout, stderr: old.stderr } });
  const indexFile = f.write('historical-index.txt', JSON.stringify({ version: 1, artifacts, entries }, null, 4));
  const indexUpload = await f.upload(indexFile); assert.equal(indexUpload.parts.length >= 2, true);
  const input = { ...f.input, support: { index: indexFile, originals: selected, required: [{ id: 'relevant-old-failure', reason: 'Retain the earlier failed assertion for this closure.' }] } };
  const manifest = await f.prepare(input); assert.deepEqual(manifest.artifacts, compact.artifacts);
  assert.deepEqual(manifest.commands, compact.commands); assert.equal(manifest.commands.filter(command => command.kind === 'gate').length, 1);
  const readIds = [], counts = { currentPayloadBytes: 0, indexPayloadBytes: 0, selectedPayloadBytes: 0, provenanceMetadataScans: 0 };
  const current = new Set(manifest.artifacts.map(ref => ref.id)), index = new Set(manifest.support.index.parts);
  const read = async id => {
    readIds.push(id); counts.provenanceMetadataScans++;
    const record = await engineOperation({ operation: 'artifact', binding: f.binding, args: { id } });
    counts[current.has(id) ? 'currentPayloadBytes' : index.has(id) ? 'indexPayloadBytes' : 'selectedPayloadBytes'] += Buffer.byteLength(record.content);
    return record;
  };
  await f.validate(manifest, read);
  const needed = [...current, ...index, ...old.receipt.parts, ...old.stdout.parts, ...old.stderr.parts];
  assert.deepEqual(readIds, needed); assert.equal(readIds.some(id => entries[0].raw.parts.includes(id)), false);
  assert.equal((await engineOperation({ operation: 'artifact', binding: f.binding, args: { id: entries[0].raw.parts[0] } })).content,
    'Unselected immutable historical read 0: \u0438\u0441\u0442\u043e\u0440\u0438\u044f\n');
  assert.equal(JSON.parse(f.records.get(old.receipt.parts[0]).content).exit, 7);
  assert.equal(f.records.get(old.stderr.parts[0]).content, 'AssertionError: original historical failure\n');
  t.diagnostic(JSON.stringify({ retainedHistoricalEntries: entries.length, currentArtifacts: current.size, indexParts: index.size,
    selectedParts: needed.length - current.size - index.size, payloadReads: readIds.length, ...counts,
    metadataBoundary: 'One provenance history/inbox scan per engine artifact operation; journal entry I/O not measured.' }));
  const absent = structuredClone(manifest); absent.support.required[0].id = 'omitted-relevant-failure';
  await assert.rejects(f.validate(absent), /required historical entry missing/);
  const missing = f.records.get(old.stderr.parts[0]); f.records.delete(old.stderr.parts[0]);
  await assert.rejects(f.validate(manifest), /Missing actual uploaded original/); f.records.set(old.stderr.parts[0], missing);
  const changed = structuredClone(manifest), indexPartId = manifest.support.index.parts.at(-1);
  const saved = structuredClone(f.records.get(indexPartId));
  f.change(changed, indexPartId, raw => raw.replace('earlier-worker', 'another-worker'));
  changed.support.index.bytes += f.records.get(indexPartId).size - saved.size;
  changed.support.index.sha256 = digest(changed.support.index.parts.map(id => f.records.get(id).content).join(''));
  await assert.rejects(f.validate(changed), /source\/base\/producer mismatch/); f.records.set(indexPartId, saved);
  const bad = structuredClone(f.records.get(old.stdout.parts[0])); f.records.get(old.stdout.parts[0]).content = 'changed historical original';
  await assert.rejects(f.validate(manifest), /identity\/sender\/bytes\/hash/); f.records.set(old.stdout.parts[0], bad);
  const reordered = structuredClone(manifest); reordered.support.index.parts.reverse();
  await assert.rejects(f.validate(reordered), /wrong ordered bytes\/hash/);
});
