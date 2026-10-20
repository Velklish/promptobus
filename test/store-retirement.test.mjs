import './home.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as api from '../dist/index.js';

const SB = mkdtempSync(path.join(os.tmpdir(), 'promptobus-retirement-'));
process.on('exit', () => rmSync(SB, { recursive: true, force: true }));
const owner = {
  id: 'owner', role: 'orchestrator', harness: 'fake', mode: 'attached', sessionRef: null,
  capabilities: { spawn: false, attach: false, activation: 'pull', inspect: false, stop: false }, metadata: {},
};
const policy = () => ({ allow: true });
let seq = 0;
const sandbox = () => path.join(SB, String(++seq));
const open = (home, extra = {}) => api.openEngine({ home, policy, ...extra });
const taskFile = (home, id = 'former') => path.join(home, 'tasks', id, 'task.json');
function write(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
const former = (status = 'done') => ({
  id: 'former', title: 'former task', status, participants: [{ address: 'orchestrator', owner: 'old-session' }],
});
function snapshot(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory()
      ? [[file, 'directory'], ...snapshot(file)]
      : [[file, readFileSync(file).toString('base64')]];
  });
}

test('retired API exports are absent from the current package', () => {
  for (const name of ['legacy', 'migrate', 'preflight', 'migrationNeeded', 'splitLegacyRel']) {
    assert.equal(Object.hasOwn(api, name), false, name);
  }
  assert.equal(Object.hasOwn(api.createStandaloneHost({ cwd: SB }), 'legacyLayout'), false);
});

test('former writer headers refuse root and arbitrary home before any current task can be created', async t => {
  for (const status of ['active', 'done']) {
    for (const fromRoot of [false, true]) {
      await t.test(`${status}, ${fromRoot ? 'root' : 'arbitrary home'}`, () => {
        const root = sandbox();
        const home = path.join(root, fromRoot ? '.promptobus' : 'custom-mail');
        write(taskFile(home), former(status));
        const before = snapshot(root);
        assert.throws(() => {
          const engine = api.openEngine({ ...(fromRoot ? { root } : { home }), policy, recover: false });
          engine.createTask({ id: 'replacement', title: 'must not appear', owner });
        }, error => error.code === 'schema-version-unsupported'
          && error.context.file === taskFile(home) && /0\.28\.0/.test(error.message));
        assert.deepEqual(snapshot(root), before);
        assert.equal(existsSync(taskFile(home, 'replacement')), false);
      });
    }
  }
});

test('a former header beside a current task refuses before recovery changes either one', () => {
  const home = path.join(sandbox(), 'custom');
  open(home).createTask({ id: 'current', title: 'current', owner });
  write(taskFile(home), former());
  const before = snapshot(home);
  assert.throws(() => open(home), { code: 'schema-version-unsupported' });
  assert.deepEqual(snapshot(home), before);
});

test('an unfinished conversion mark refuses without reading it or changing the store', () => {
  const home = path.join(sandbox(), 'custom');
  write(path.join(home, 'migrating.json'), '{unfinished');
  const before = snapshot(home);
  assert.throws(() => open(home), error => error.code === 'schema-invalid'
    && error.context.file === path.join(home, 'migrating.json') && /0\.28\.0/.test(error.message));
  assert.deepEqual(snapshot(home), before);
});

test('reserved conversion siblings refuse before an empty replacement appears', async t => {
  for (const suffix of ['.migrating', '.migrating.lock']) {
    await t.test(suffix, () => {
      const root = sandbox();
      const home = path.join(root, '.promptobus');
      mkdirSync(`${home}${suffix}`, { recursive: true });
      const before = snapshot(root);
      for (const spelling of [home, `${home}/`, `${home}/.`]) {
        assert.throws(() => open(spelling), { code: 'schema-invalid' });
      }
      assert.equal(existsSync(home), false);
      assert.deepEqual(snapshot(root), before);
      for (const spelling of [`${home}${suffix}`, `${home}${suffix}/`, `${home}${suffix}/.`]) {
        assert.throws(() => open(spelling), { code: 'schema-invalid' });
      }
    });
  }
});

test('reserved conversion home names refuse even before those paths exist', async t => {
  for (const name of ['.promptobus.migrating', '.promptobus.migrating.lock']) {
    await t.test(name, () => {
      const root = sandbox();
      const home = path.join(root, name);
      for (const spelling of [home, `${home}/`, `${home}/.`]) {
        assert.throws(() => {
          const engine = open(spelling, { recover: false });
          engine.createTask({ id: 'replacement', title: 'must not appear', owner });
        }, { code: 'schema-invalid' });
      }
      assert.equal(existsSync(root), false);
    });
  }
});

test('unrelated siblings and completed conversion output do not block a current home', () => {
  const root = sandbox();
  const home = path.join(root, 'custom');
  mkdirSync(`${home}.migrating`, { recursive: true });
  mkdirSync(path.join(root, '.promptobus.migrating'), { recursive: true });
  write(path.join(home, 'migrated.json'), '{historical completed marker');
  write(path.join(home, 'migration-broken', 'former', 'task.json'), former());
  const engine = open(home);
  engine.createTask({ id: 'current', title: 'current', owner });
  assert.equal(engine.readTask('current').title, 'current');
  assert.equal(existsSync(path.join(home, 'migrated.json')), true);
  assert.equal(existsSync(path.join(home, 'migration-broken', 'former', 'task.json')), true);
});

test('malformed and unversioned current records keep task-local broken classification', () => {
  const home = path.join(sandbox(), 'custom');
  const engine = open(home);
  engine.createTask({ id: 'current', title: 'current', owner });
  const unversioned = JSON.parse(readFileSync(taskFile(home, 'current'), 'utf8'));
  delete unversioned.schemaVersion;
  write(taskFile(home, 'unversioned'), { ...unversioned, id: 'unversioned' });
  write(taskFile(home, 'malformed'), '{unparseable');
  write(taskFile(home, 'empty'), { id: 'empty', status: 'active', participants: [] });
  const reopened = open(home);
  assert.deepEqual(reopened.listTasks().tasks.map(task => task.id), ['current']);
  assert.deepEqual(reopened.listTasks().broken.map(({ id, code }) => ({ id, code })), [
    { id: 'empty', code: 'task-broken' }, { id: 'malformed', code: 'task-broken' },
    { id: 'unversioned', code: 'task-broken' },
  ]);
});

test('malformed address headers remain task-local while a healthy task stays usable', async t => {
  for (const address of ['', 'not an address', 'worker:']) {
    await t.test(JSON.stringify(address), () => {
      const home = path.join(sandbox(), 'custom');
      open(home).createTask({ id: 'healthy', title: 'healthy', owner });
      const file = taskFile(home, 'damaged');
      write(file, { id: 'damaged', status: 'active', participants: [{ address }] });
      const before = readFileSync(file, 'utf8');
      const engine = open(home);
      assert.deepEqual(engine.listTasks().tasks.map(task => task.id), ['healthy']);
      assert.deepEqual(engine.listTasks().broken.map(({ id, code }) => ({ id, code })), [
        { id: 'damaged', code: 'task-broken' },
      ]);
      engine.patchTask('healthy', { title: 'still usable' });
      assert.equal(engine.readTask('healthy').title, 'still usable');
      assert.equal(readFileSync(file, 'utf8'), before);
    });
  }
});

test('former writer addresses still refuse, including custom step names', async t => {
  for (const address of ['orchestrator', 'worker:orders-api', 'qa-gate:old-run']) {
    await t.test(address, () => {
      const home = path.join(sandbox(), 'custom');
      const header = former();
      if (address !== 'orchestrator') header.participants.push({ address });
      write(taskFile(home), header);
      const before = snapshot(home);
      assert.throws(() => open(home), { code: 'schema-version-unsupported' });
      assert.deepEqual(snapshot(home), before);
    });
  }
});

test('explicit schema versions keep their existing read-time verdicts', async t => {
  for (const [version, code] of [[null, 'task-broken'], [0, 'task-broken'], [1, 'task-broken'], [2, 'schema-version-unsupported']]) {
    await t.test(String(version), () => {
      const home = path.join(sandbox(), 'custom');
      write(taskFile(home), { ...former(), schemaVersion: version });
      const engine = open(home, { recover: false });
      assert.throws(() => engine.readTask('former'), { code });
    });
  }
});
