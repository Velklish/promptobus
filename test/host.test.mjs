import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

test('createStandaloneHost поднимает два независимых host\'а в одном процессе', async () => {
  const { createStandaloneHost, isPromptobusHost, HOST_KIND } = await import('../dist/host-index.js');
  const dirA = mkdtempSync(path.join(tmpdir(), 'promptobus-host-a-'));
  const dirB = mkdtempSync(path.join(tmpdir(), 'promptobus-host-b-'));
  process.on('exit', () => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });
  const a = createStandaloneHost({ cwd: dirA, commandName: 'alpha', extraEnv: { MARK: 'a' } });
  const b = createStandaloneHost({ cwd: dirB, commandName: 'beta', extraEnv: { MARK: 'b' } });
  assert.equal(a.kind, HOST_KIND);
  assert.equal(isPromptobusHost(a), true);
  assert.notEqual(a, b);
  assert.equal(a.commandName, 'alpha');
  assert.equal(b.commandName, 'beta');
  assert.equal(a.extraEnv().MARK, 'a');
  assert.equal(b.extraEnv().MARK, 'b');
  assert.equal(a.memorySection(() => 'x'), null);
  assert.equal(a.legacyLayout(), null);
  assert.equal(b.legacyLayout(), null);
  assert.equal(b.toolsManifestRel(), 'promptobus.json');
  assert.notEqual(a.workspaceRoot(), b.workspaceRoot());
  assert.equal(a.version, '0.0.0');
  assert.equal(a.locale, 'en');
  assert.equal(a.reposRoot(), dirA);
  assert.equal(a.inWorkspace(dirA), true);
  assert.equal(a.inWorkspace(dirB), false);
  assert.equal(a.findRoot(dirA), path.resolve(dirA));
  assert.equal(a.cloneHint('x'), 'git clone <url> x');
  assert.equal(a.formatNpx(['clone', 'x']), 'npx alpha clone x');
  assert.equal(a.installManifestRel(), path.join('.promptobus', 'manifest.json'));
  assert.equal(a.promptobusHome(), path.join(dirA, '.promptobus'));
});

test('entry point ./hooks отдаёт план без раскладки чужого рабочего места', async () => {
  const { createStandaloneHost } = await import('../dist/host-index.js');
  const { planPromptobusHooks, BUS_HOOK_EVENT } = await import('../dist/hooks.js');
  const host = createStandaloneHost({ cwd: '.', commandName: 'promptobus', binPath: '/bin/pb' });
  const planned = planPromptobusHooks(host);
  assert.equal(planned.rel, path.join('.promptobus', 'hooks', 'bus.mjs'));
  assert.match(planned.text, /Сгенерирован promptobus sync/);
  assert.ok(planned.settings[BUS_HOOK_EVENT]);
});

test('явный cwd читает promptobus.json, options.config ложится сверху', async () => {
  const { createStandaloneHost } = await import('../dist/host-index.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'promptobus-host-json-'));
  process.on('exit', () => { rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(path.join(dir, 'promptobus.json'), `${JSON.stringify({
    commandName: 'fromfile',
    tools: ['alpha'],
    skills: 'skills',
    locale: 'ru',
    version: '1.2.3',
  })}\n`);
  const host = createStandaloneHost({ cwd: dir });
  assert.equal(host.commandName, 'fromfile');
  assert.deepEqual(host.declaredTools(), ['alpha']);
  assert.equal(host.skillsDir(), path.join(dir, 'skills'));
  assert.equal(host.locale, 'ru');
  assert.equal(host.version, '1.2.3');
  const over = createStandaloneHost({ cwd: dir, config: { commandName: 'over' } });
  assert.equal(over.commandName, 'over');
  assert.deepEqual(over.declaredTools(), ['alpha']);
});
