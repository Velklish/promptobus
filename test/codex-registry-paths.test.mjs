import './home.mjs';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeSandbox } from './sandbox.mjs';
import { bindHarnessHomes, harnessStateHome } from '../lib/harness-home.js';
import { publishCodexNativeAdmission, readSession, sessionFile, writeSession } from '../lib/codex-session.js';
import { recordVersion, requireProcess } from '../lib/service-state.js';
import { codexDriver, participantCodexHome, participantHomesRoot, removeParticipantHome, sweepParticipantHomes } from '../lib/driver-codex.js';

function fixture() {
  const root = realpathSync(makeSandbox('promptobus-codex-'));
  const selected = path.join(root, 'selected'), alias = path.join(root, 'alias');
  mkdirSync(selected, { mode: 0o700 });
  symlinkSync(selected, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const kept = ['auth.json', 'config.toml'].map(name => {
    const file = path.join(selected, name), bytes = `owned fixture ${name}\n`;
    writeFileSync(file, bytes, { mode: 0o600 });
    return { file, bytes };
  });
  const env = { PROMPTOBUS_CODEX_HOME: path.join(alias, 'registry', 'codex') };
  const expected = path.join(selected, 'registry', 'codex');
  return { root, selected, alias, env, expected, kept };
}

function publication(f) {
  const identity = requireProcess(), ref = 'owned-alias-admission';
  const record = { ref, launchId: 'owned-generation', home: f.root, task: 'fixture-task', address: 'worker:fixture',
    threadId: 'fixture-native-id', codexHome: f.selected, appPid: identity.pid, appProcess: identity, nativeAdmissionSchema: 1 };
  writeSession(record, f.env);
  const file = sessionFile(ref, f.env);
  const input = () => ({ version: recordVersion(file), launchId: record.launchId, home: record.home, task: record.task,
    address: record.address, nativeStore: f.selected, nativeId: record.threadId, process: identity, method: 'thread/start' });
  return { file, publish: () => publishCodexNativeAdmission(ref, input(), f.env), ref };
}

test('explicit registry environment and host aliases select the same canonical nonexistent tail', () => {
  const f = fixture(), original = f.env.PROMPTOBUS_CODEX_HOME;
  assert.equal(harnessStateHome('codex', f.env), f.expected);
  try {
    bindHarnessHomes(null);
    bindHarnessHomes({ harnessStateHome: () => original });
    assert.equal(harnessStateHome('codex', {}), f.expected);
  } finally { bindHarnessHomes(null); }
  assert.equal(f.env.PROMPTOBUS_CODEX_HOME, original);
  const participant = { task: 'registry-alias', address: 'worker:fixture' };
  assert.equal(participantCodexHome(participant, f.env),
    participantCodexHome(participant, { PROMPTOBUS_CODEX_HOME: f.expected }));
  for (const { file, bytes } of f.kept) assert.equal(readFileSync(file, 'utf8'), bytes);
});

const unsupported = !['darwin', 'linux'].includes(process.platform);

function reviewerContext(f) {
  return { env: f.env, ref: 'registry-preflight', role: 'reviewer', task: 'fixture-task', address: 'reviewer:fixture',
    mcp: { servers: {} }, prompt: 'review', model: null, cwd: f.selected,
    settingsPath: path.join(f.root, 'reviewer.settings.json') };
}

test('Codex review planning refuses an existing 0755 registry before writing launch state', { skip: unsupported }, () => {
  const f = fixture(), directory = path.join(f.expected, 'sessions');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const retained = path.join(directory, 'retained.json'), bytes = '{"ref":"retained"}\n';
  writeFileSync(retained, bytes, { mode: 0o600 });
  chmodSync(directory, 0o755);
  assert.throws(() => codexDriver.prepare(reviewerContext(f)), error =>
    error.message.includes('Codex session registry requires an owned private directory (mode 0700) without symbolic links: ' + directory));
  assert.equal(statSync(directory).mode & 0o777, 0o755);
  assert.equal(readFileSync(retained, 'utf8'), bytes);
  assert.deepEqual(readdirSync(directory), ['retained.json']);
  assert.equal(existsSync(path.join(f.root, 'reviewer.codex-sandbox')), false);
});

for (const existing of [false, true]) {
  test(`Codex review planning accepts ${existing ? 'a private' : 'an absent'} registry without creating launch state`, { skip: unsupported }, () => {
    const f = fixture(), directory = path.join(f.expected, 'sessions');
    if (existing) mkdirSync(directory, { recursive: true, mode: 0o700 });
    assert.equal(codexDriver.prepare(reviewerContext(f)).settings.sandbox, 'read-only');
    assert.equal(existsSync(directory), existing);
    if (existing) assert.deepEqual(readdirSync(directory), []);
  });
}

test('Codex spawn rechecks registry privacy after planning before writing a session or starting a holder', { skip: unsupported }, async () => {
  const f = fixture(), context = reviewerContext(f), plan = codexDriver.prepare(context);
  const directory = path.join(f.expected, 'sessions');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o755);
  await assert.rejects(codexDriver.spawn(plan, { ...context, tool: { bin: '/must-not-launch-codex' } }), error =>
    error.message.includes('Codex session registry requires an owned private directory (mode 0700) without symbolic links: ' + directory));
  assert.equal(statSync(directory).mode & 0o777, 0o755);
  assert.deepEqual(readdirSync(directory), []);
});

test('Codex review planning refuses a symlink registry without changing its target', { skip: unsupported }, () => {
  const f = fixture(), directory = path.join(f.expected, 'sessions');
  mkdirSync(f.expected, { recursive: true, mode: 0o700 });
  symlinkSync(f.selected, directory);
  assert.throws(() => codexDriver.prepare(reviewerContext(f)), /Codex session registry requires an owned private directory/);
  assert.equal(lstatSync(directory).isSymbolicLink(), true);
  for (const { file, bytes } of f.kept) assert.equal(readFileSync(file, 'utf8'), bytes);
});

test('participant-home removal accepts only direct selected-root spellings and never follows a leaf link', { skip: unsupported }, () => {
  const f = fixture(), previousTmp = process.env.TMPDIR;
  try {
    process.env.TMPDIR = f.alias;
    const home = participantCodexHome({ task: 'owned-removal', address: 'worker:fixture' }, f.env);
    mkdirSync(path.join(home, 'nested'), { recursive: true, mode: 0o700 });
    const auth = path.join(home, 'auth.json');
    writeFileSync(auth, 'retained until owned removal\n', { mode: 0o600 });
    const root = participantHomesRoot(), canonicalHome = realpathSync(home);
    const foreignParent = path.join(f.root, 'unselected-parent');
    symlinkSync(realpathSync(root), foreignParent);
    for (const refused of [root, realpathSync(root), f.root, f.selected,
      path.join(home, 'nested'), path.join(foreignParent, path.basename(home))]) {
      assert.equal(removeParticipantHome(refused), false, refused);
      assert.equal(readFileSync(auth, 'utf8'), 'retained until owned removal\n');
    }
    const foreign = path.join(f.root, 'foreign-target');
    mkdirSync(foreign, { mode: 0o700 });
    writeFileSync(path.join(foreign, 'auth.json'), 'foreign bytes\n', { mode: 0o600 });
    const leaf = path.join(root, 'owned-leaf-link');
    symlinkSync(foreign, leaf);
    assert.equal(removeParticipantHome(leaf), true);
    assert.equal(lstatSync(foreign).isDirectory(), true);
    assert.equal(readFileSync(path.join(foreign, 'auth.json'), 'utf8'), 'foreign bytes\n');
    assert.equal(removeParticipantHome(canonicalHome), true);
    assert.equal(existsSync(home), false);
    mkdirSync(home, { mode: 0o700 });
    assert.equal(removeParticipantHome(home), true);
    assert.equal(existsSync(home), false);
    for (const { file, bytes } of f.kept) assert.equal(readFileSync(file, 'utf8'), bytes);
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
  }
});

test('aliased registry publishes the owned UNIT admission into the selected canonical record', { skip: unsupported }, () => {
  const f = fixture(), p = publication(f);
  p.publish();
  assert.equal(path.dirname(p.file), path.join(f.expected, 'sessions'));
  assert.equal(realpathSync(p.file), p.file);
  const published = readSession(p.ref, f.env);
  assert.equal(published.nativeAdmission.nativeStore, f.selected);
  assert.equal(published.nativeAdmission.process.pid, process.pid);
  assert.deepEqual(readSession(p.ref, { PROMPTOBUS_CODEX_HOME: f.expected }), published);
  for (const { file, bytes } of f.kept) assert.equal(readFileSync(file, 'utf8'), bytes);
});

test('aliased registry admission refuses an unsafe record without repairing its mode or bytes', { skip: unsupported }, () => {
  const f = fixture(), p = publication(f), before = readFileSync(p.file);
  chmodSync(p.file, 0o666);
  assert.throws(p.publish, /owned private regular file/);
  assert.deepEqual(readFileSync(p.file), before);
  assert.equal(statSync(p.file).mode & 0o777, 0o666);
});

test('aliased registry admission never follows a symlink record or alters its target', { skip: unsupported }, () => {
  const f = fixture(), p = publication(f), target = path.join(f.root, 'retained-record.json');
  renameSync(p.file, target);
  const before = readFileSync(target);
  symlinkSync(target, p.file);
  assert.throws(p.publish, error => error.code === 'ELOOP');
  assert.equal(lstatSync(p.file).isSymbolicLink(), true);
  assert.deepEqual(readFileSync(target), before);
});

test('aliased registry admission retains refusal for an unsafe parent directory', { skip: unsupported }, () => {
  const f = fixture(), p = publication(f), before = readFileSync(p.file), parent = path.dirname(p.file);
  chmodSync(parent, 0o777);
  assert.throws(p.publish, /private directory changed/);
  assert.deepEqual(readFileSync(p.file), before);
  assert.equal(statSync(parent).mode & 0o777, 0o777);
});

for (const aliasDirectory of [true, false]) {
  test(`participant-home sweep preserves referenced bytes with ${aliasDirectory ? 'an aliased directory' : 'an aliased record'}`, { skip: unsupported }, () => {
    const f = fixture(), previousTmp = process.env.TMPDIR;
    try {
      process.env.TMPDIR = aliasDirectory ? f.alias : f.selected;
      const live = participantCodexHome({ task: 'retained', address: 'worker:fixture' }, f.env);
      const orphan = participantCodexHome({ task: 'orphan', address: 'worker:fixture' }, f.env);
      const foreign = participantCodexHome({ task: 'foreign', address: 'worker:fixture' },
        { PROMPTOBUS_CODEX_HOME: path.join(f.root, 'foreign-registry') });
      const unscoped = path.join(participantHomesRoot(), 'retained-old-name');
      for (const dir of [live, orphan, foreign, unscoped]) mkdirSync(dir, { recursive: true, mode: 0o700 });
      const kept = [live, foreign, unscoped].flatMap(dir => ['auth.json', 'config.toml', 'history.jsonl'].map(name => {
        const file = path.join(dir, name), bytes = `retained ${name}\n`;
        writeFileSync(file, bytes, { mode: 0o600 });
        return { file, bytes };
      }));
      const codexHome = aliasDirectory ? realpathSync(live) : path.join(f.alias, path.relative(f.selected, live));
      writeSession({ ref: 'retained-home-ref', codexHome }, f.env);
      const record = sessionFile('retained-home-ref', f.env), before = readFileSync(record);
      assert.deepEqual(sweepParticipantHomes(f.env), [orphan]);
      assert.equal(existsSync(orphan), false);
      assert.deepEqual(readFileSync(record), before);
      for (const { file, bytes } of kept) {
        assert.equal(readFileSync(file, 'utf8'), bytes);
        assert.equal(statSync(file).mode & 0o777, 0o600);
      }
    } finally {
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
    }
  });
}
