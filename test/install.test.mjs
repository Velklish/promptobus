import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { runPromptobus } from '../lib/cli.js';
import {
  HOME_HOOK_DIRS, install, parseHarnessList, uninstall,
} from '../lib/install.js';
import { GateError } from '../lib/store.js';
import { prune } from '../lib/prune.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const BIN = path.join(ROOT, 'bin', 'promptobus.js');
const FIX = path.join(here, 'fixtures', 'install');
const temps = [];
process.on('exit', () => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pb-install-'));
  const home = mkdtempSync(path.join(tmpdir(), 'pb-home-'));
  temps.push(dir, home);
  return { dir, home };
}

function hostOf(dir) {
  return createStandaloneHost({
    cwd: dir,
    commandName: 'promptobus',
    version: '0.1.0',
    binPath: BIN,
    nodePath: process.execPath,
  });
}

function envOf(home) {
  return { ...process.env, HOME: home, USERPROFILE: home };
}

function listRel(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (base, rel = '') => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(base, entry.name), next);
      else out.push(next);
    }
  };
  walk(dir);
  return out.sort();
}

function homeHits(home) {
  return HOME_HOOK_DIRS.filter((name) => existsSync(path.join(home, name)));
}

function readJson(dir, rel) {
  return JSON.parse(readFileSync(path.join(dir, rel), 'utf8'));
}

function fileText(dir, rel) {
  return readFileSync(path.join(dir, rel), 'utf8');
}

function snapshot(dir) {
  const rels = [
    'promptobus.json',
    path.join('.promptobus', 'hooks', 'bus.mjs'),
    path.join('.claude', 'settings.json'),
    path.join('.cursor', 'hooks.json'),
    path.join('.codex', 'hooks.json'),
  ];
  const out = {};
  for (const rel of rels) {
    const abs = path.join(dir, rel);
    out[rel] = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  }
  return out;
}

function putFixture(dir, rel, name) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, readFileSync(path.join(FIX, name)));
}

function doInstall(dir, home, opts) {
  return install(hostOf(dir), { cwd: dir, env: envOf(home), ...opts });
}

function doUninstall(dir, home, opts = {}) {
  return uninstall(hostOf(dir), { cwd: dir, env: envOf(home), ...opts });
}

test('parseHarnessList keeps canonical order and rejects unknown names', () => {
  assert.deepEqual(parseHarnessList('codex,claude,cursor,claude'), ['claude', 'cursor', 'codex']);
  assert.throws(() => parseHarnessList('claude,nope'), (e) => e instanceof GateError && /unknown harness/.test(e.message));
  assert.throws(() => parseHarnessList(''), (e) => e instanceof GateError);
});

test('install each harness alone and all three together; HOME stays empty', () => {
  for (const name of ['claude', 'cursor', 'codex']) {
    const { dir, home } = sandbox();
    assert.equal(doInstall(dir, home, { harnesses: name }), 0);
    assert.deepEqual(homeHits(home), []);
    assert.deepEqual(listRel(home), []);
    assert.deepEqual(readJson(dir, 'promptobus.json').harnesses, [name]);
    if (name === 'claude') {
      const hooks = readJson(dir, path.join('.claude', 'settings.json')).hooks;
      assert.ok(hooks.PostToolUse[0].matcher.includes('promptobus_send'));
      assert.ok(hooks.Stop[0].hooks[0].command.includes('promptobus guard'));
    }
    if (name === 'cursor') {
      const hooks = readJson(dir, path.join('.cursor', 'hooks.json')).hooks;
      assert.ok(hooks.postToolUse[0].command.includes('--output'));
      assert.ok(hooks.postToolUse[0].command.includes('additional_context'));
      assert.ok(hooks.stop[0].command.includes('promptobus guard'));
    }
    if (name === 'codex') {
      const hooks = readJson(dir, path.join('.codex', 'hooks.json')).hooks;
      assert.match(hooks.PostToolUse[0].matcher, /promptobus_send/);
      assert.ok(hooks.Stop);
    }
  }
  const { dir, home } = sandbox();
  assert.equal(doInstall(dir, home, { harnesses: 'claude,cursor,codex' }), 0);
  assert.deepEqual(readJson(dir, 'promptobus.json').harnesses, ['claude', 'cursor', 'codex']);
  assert.ok(existsSync(path.join(dir, '.claude', 'settings.json')));
  assert.ok(existsSync(path.join(dir, '.cursor', 'hooks.json')));
  assert.ok(existsSync(path.join(dir, '.codex', 'hooks.json')));
  assert.ok(existsSync(path.join(dir, '.promptobus', 'hooks', 'bus.mjs')));
  assert.deepEqual(homeHits(home), []);
});

test('repeat install is byte-identical; later call without --harnesses uses the saved list', () => {
  const { dir, home } = sandbox();
  doInstall(dir, home, { harnesses: 'claude,cursor' });
  const first = snapshot(dir);
  doInstall(dir, home, { harnesses: 'claude,cursor' });
  assert.deepEqual(snapshot(dir), first);
  doInstall(dir, home, {});
  assert.deepEqual(snapshot(dir), first);
  assert.deepEqual(homeHits(home), []);
});

test('merge keeps foreign settings, hook groups and unknown fields', () => {
  const { dir, home } = sandbox();
  putFixture(dir, path.join('.claude', 'settings.json'), 'foreign-claude.json');
  putFixture(dir, path.join('.cursor', 'hooks.json'), 'foreign-cursor.json');
  putFixture(dir, path.join('.codex', 'hooks.json'), 'foreign-codex.json');
  doInstall(dir, home, { harnesses: 'claude,cursor,codex' });
  const claude = readJson(dir, path.join('.claude', 'settings.json'));
  assert.equal(claude.customField, true);
  assert.deepEqual(claude.permissions, { allow: ['Bash'] });
  assert.equal(claude.hooks.PostToolUse.some((g) => g.matcher === 'Bash'), true);
  assert.equal(claude.hooks.Notification[0].hooks[0].command, 'echo foreign-note');
  assert.equal(claude.hooks.PostToolUse.some((g) => g.matcher.includes('promptobus_send')), true);
  const cursor = readJson(dir, path.join('.cursor', 'hooks.json'));
  assert.equal(cursor.extra, 'keep-me');
  assert.equal(cursor.hooks.sessionStart[0].command, 'echo foreign-start');
  assert.equal(cursor.hooks.stop.some((g) => g.command === 'echo foreign-cursor-stop'), true);
  assert.equal(cursor.hooks.stop.some((g) => String(g.command).includes('promptobus guard')), true);
  const codex = readJson(dir, path.join('.codex', 'hooks.json'));
  assert.equal(codex.keep, 1);
  assert.equal(codex.hooks.PostToolUse.some((g) => g.matcher === 'ApplyPatch'), true);
  assert.deepEqual(homeHits(home), []);
});

test('a new harness list replaces the previous one and removes only owned records', () => {
  const { dir, home } = sandbox();
  putFixture(dir, path.join('.cursor', 'hooks.json'), 'foreign-cursor.json');
  putFixture(dir, path.join('.codex', 'hooks.json'), 'foreign-codex.json');
  doInstall(dir, home, { harnesses: 'claude,cursor,codex' });
  doInstall(dir, home, { harnesses: 'claude' });
  assert.deepEqual(readJson(dir, 'promptobus.json').harnesses, ['claude']);
  assert.ok(readJson(dir, path.join('.claude', 'settings.json')).hooks.PostToolUse);
  const cursor = readJson(dir, path.join('.cursor', 'hooks.json'));
  assert.equal(cursor.extra, 'keep-me');
  assert.equal(cursor.hooks.sessionStart[0].command, 'echo foreign-start');
  assert.equal((cursor.hooks.stop || []).some((g) => String(g.command).includes('promptobus guard')), false);
  assert.equal((cursor.hooks.stop || []).some((g) => g.command === 'echo foreign-cursor-stop'), true);
  assert.equal((cursor.hooks.postToolUse || []).length, 0);
  const codex = readJson(dir, path.join('.codex', 'hooks.json'));
  assert.equal(codex.keep, 1);
  assert.equal(codex.hooks.PostToolUse.every((g) => g.matcher === 'ApplyPatch'), true);
  assert.deepEqual(homeHits(home), []);
});

test('uninstall removes only owned records and leaves foreign settings', () => {
  const { dir, home } = sandbox();
  putFixture(dir, path.join('.claude', 'settings.json'), 'foreign-claude.json');
  doInstall(dir, home, { harnesses: 'claude' });
  assert.equal(doUninstall(dir, home), 0);
  const claude = readJson(dir, path.join('.claude', 'settings.json'));
  assert.equal(claude.customField, true);
  assert.deepEqual(claude.permissions, { allow: ['Bash'] });
  assert.equal(claude.hooks.PostToolUse.length, 1);
  assert.equal(claude.hooks.PostToolUse[0].matcher, 'Bash');
  assert.equal(claude.hooks.Notification[0].hooks[0].command, 'echo foreign-note');
  assert.equal(Object.hasOwn(readJson(dir, 'promptobus.json'), 'harnesses'), false);
  assert.deepEqual(homeHits(home), []);
});

test('malformed or non-object hooks config fails with no partial write', () => {
  const { dir, home } = sandbox();
  putFixture(dir, path.join('.cursor', 'hooks.json'), 'foreign-cursor.json');
  const cursorBefore = fileText(dir, path.join('.cursor', 'hooks.json'));
  mkdirSync(path.join(dir, '.claude'), { recursive: true });
  writeFileSync(path.join(dir, '.claude', 'settings.json'), '{not-json');
  assert.throws(
    () => doInstall(dir, home, { harnesses: 'claude,cursor' }),
    (e) => e instanceof GateError && /not valid JSON/.test(e.message),
  );
  assert.equal(existsSync(path.join(dir, '.promptobus', 'hooks', 'bus.mjs')), false);
  assert.equal(existsSync(path.join(dir, 'promptobus.json')), false);
  assert.equal(fileText(dir, path.join('.cursor', 'hooks.json')), cursorBefore);
  writeFileSync(path.join(dir, '.claude', 'settings.json'), `${JSON.stringify({ hooks: [] }, null, 2)}\n`);
  assert.throws(
    () => doInstall(dir, home, { harnesses: 'claude,cursor' }),
    (e) => e instanceof GateError && /not an object/.test(e.message),
  );
  assert.equal(existsSync(path.join(dir, '.promptobus', 'hooks', 'bus.mjs')), false);
  assert.equal(fileText(dir, path.join('.cursor', 'hooks.json')), cursorBefore);
  assert.deepEqual(homeHits(home), []);
});

test('--dry-run writes nothing; --check reports drift and returns non-zero', async () => {
  const { dir, home } = sandbox();
  assert.equal(doInstall(dir, home, { harnesses: 'claude', dryRun: true }), 0);
  assert.equal(existsSync(path.join(dir, '.claude', 'settings.json')), false);
  assert.equal(existsSync(path.join(dir, 'promptobus.json')), false);
  assert.equal(doInstall(dir, home, { check: true }), 1);
  assert.equal(doInstall(dir, home, { harnesses: 'claude' }), 0);
  assert.equal(doInstall(dir, home, { check: true }), 0);
  const settings = path.join(dir, '.claude', 'settings.json');
  writeFileSync(settings, fileText(dir, path.join('.claude', 'settings.json')).replace('PostToolUse', 'XPostToolUse'));
  assert.equal(doInstall(dir, home, { check: true }), 1);
  const h = hostOf(dir);
  const code = await runPromptobus(['install', '--check'], {
    host: h, cwd: dir, env: envOf(home),
  });
  assert.equal(code, 1);
  assert.deepEqual(homeHits(home), []);
});

test('install from a subdirectory writes the project root; prune keeps the runner directory', () => {
  const { dir, home } = sandbox();
  const sub = path.join(dir, 'nested', 'deeper');
  mkdirSync(sub, { recursive: true });
  writeFileSync(path.join(dir, 'promptobus.json'), `${JSON.stringify({ tools: ['alpha'] }, null, 2)}\n`);
  assert.equal(install(hostOf(dir), { harnesses: 'claude', cwd: sub, env: envOf(home) }), 0);
  assert.ok(existsSync(path.join(dir, '.claude', 'settings.json')));
  assert.equal(existsSync(path.join(sub, '.claude')), false);
  assert.deepEqual(readJson(dir, 'promptobus.json').tools, ['alpha']);
  const hooksDir = path.join(dir, '.promptobus', 'hooks');
  assert.equal(statSync(hooksDir).isDirectory(), true);
  prune(hostOf(dir), { yes: true });
  assert.equal(statSync(hooksDir).isDirectory(), true);
  assert.ok(existsSync(path.join(hooksDir, 'bus.mjs')));
  assert.deepEqual(homeHits(home), []);
});

test('first install without --harnesses fails; unknown harness does not write', () => {
  const { dir, home } = sandbox();
  assert.throws(() => doInstall(dir, home, {}), (e) => e instanceof GateError && /first install/.test(e.message));
  assert.throws(() => doInstall(dir, home, { harnesses: 'nope' }), (e) => e instanceof GateError);
  assert.equal(existsSync(path.join(dir, '.claude')), false);
  assert.deepEqual(homeHits(home), []);
});

test('no install path writes into the HOME sandbox or the real user hook dirs', () => {
  const { dir, home } = sandbox();
  doInstall(dir, home, { harnesses: 'claude,cursor,codex' });
  doInstall(dir, home, { harnesses: 'cursor' });
  doUninstall(dir, home, { harnesses: 'cursor' });
  assert.deepEqual(listRel(home), []);
  for (const name of HOME_HOOK_DIRS) {
    assert.equal(existsSync(path.join(home, name)), false);
  }
  const realHome = process.env.HOME;
  if (realHome && realHome !== home) {
    for (const name of HOME_HOOK_DIRS) {
      const marker = path.join(realHome, name, '.promptobus-install-test');
      assert.equal(existsSync(marker), false);
    }
  }
});
