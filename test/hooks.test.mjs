// Home diversion before any import that is not a Node built-in: a module that
// resolved a home path at load would see the real one. [home.mjs](home.mjs) says
// what it applies; the sentinel in tmpdir-sweep.test.mjs keeps the order.
import './home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { BUS_HOOK_EVENT } from '../dist/hooks.js';
import { capture } from './console.mjs';
import { GUARD_BLOCK_LIMIT } from '../lib/guard.js';
import { CURSOR_HOOK_EVENTS, HOME_HOOK_DIRS, install } from '../lib/install.js';
import { liftHarness } from '../lib/spawn.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const BIN = path.join(ROOT, 'bin', 'promptobus.js');
const temps = [];
process.on('exit', () => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pb-hooks-'));
  const home = mkdtempSync(path.join(tmpdir(), 'pb-hooks-home-'));
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

function runCommand(command, { cwd, home, input }) {
  return spawnSync(command, {
    shell: true,
    cwd,
    env: envOf(home),
    input,
    encoding: 'utf8',
  });
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

test('PB-173: install writes no feed hook for any harness, and no runner script', () => {
  const { dir, home } = sandbox();
  assert.equal(install(hostOf(dir), { harnesses: 'claude,cursor,codex', cwd: dir, env: envOf(home) }), 0);
  const claude = JSON.parse(readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  const cursor = JSON.parse(readFileSync(path.join(dir, '.cursor', 'hooks.json'), 'utf8'));
  const codex = JSON.parse(readFileSync(path.join(dir, '.codex', 'hooks.json'), 'utf8'));
  for (const [label, doc] of [['claude', claude], ['codex', codex]]) {
    assert.equal(Object.hasOwn(doc.hooks, BUS_HOOK_EVENT), false, label);
  }
  assert.equal(Object.hasOwn(cursor.hooks, 'postToolUse'), false);
  for (const event of Object.keys(cursor.hooks)) {
    assert.ok(CURSOR_HOOK_EVENTS.includes(event), event);
  }
  // The guard is the half that stays. Without this the check would pass on an
  // install that wrote nothing at all.
  assert.ok(cursor.hooks.stop[0].command.includes('promptobus guard'));
  assert.ok(claude.hooks.Stop[0].hooks[0].command.includes('promptobus guard'));
  assert.ok(codex.hooks.Stop[0].hooks[0].command.includes('promptobus guard'));
  assert.equal(existsSync(path.join(dir, hostOf(dir).busHookRel())), false);
  assert.deepEqual(listRel(home), []);
  assert.deepEqual(HOME_HOOK_DIRS.filter((name) => existsSync(path.join(home, name))), []);
});

test('PB-173: a feed hook an older install wrote is taken out, and a foreign hook beside it is not', () => {
  const { dir, home } = sandbox();
  const runner = path.join(dir, hostOf(dir).busHookRel());
  mkdirSync(path.dirname(runner), { recursive: true });
  writeFileSync(runner, 'process.exit(0);\n');
  const foreign = { type: 'command', command: 'echo someone-elses-hook' };
  mkdirSync(path.join(dir, '.claude'), { recursive: true });
  writeFileSync(path.join(dir, '.claude', 'settings.json'), `${JSON.stringify({
    hooks: {
      [BUS_HOOK_EVENT]: [
        { matcher: 'mcp__promptobus__(promptobus_send|promptobus_mailbox)',
          hooks: [{ type: 'command', command: `"${process.execPath}" "${runner}"` }] },
        { matcher: 'Write', hooks: [foreign] },
      ],
    },
  }, null, 2)}\n`);

  assert.equal(install(hostOf(dir), { harnesses: 'claude', cwd: dir, env: envOf(home) }), 0);

  const claude = JSON.parse(readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  const left = claude.hooks[BUS_HOOK_EVENT] ?? [];
  // Ours is gone…
  assert.equal(left.some((g) => g.hooks?.[0]?.command?.includes(runner)), false, JSON.stringify(left));
  // …and the stranger's is still there, byte for byte. A strip that took the whole
  // event would satisfy the first assertion and fail this one.
  assert.deepEqual(left, [{ matcher: 'Write', hooks: [foreign] }]);
  // The runner script goes with the entry: leaving it is the same file with nothing
  // left to regenerate it.
  assert.equal(existsSync(runner), false);
});

test('PB-177: a successful install says that tools is still undeclared, and the refusal says why', () => {
  const { dir, home } = sandbox();
  // The documented order from install.md: promptobus.json first, then install. `tools`
  // is absent here exactly as it is on a workspace someone just created.
  writeFileSync(path.join(dir, 'promptobus.json'), `${JSON.stringify({ commandName: 'promptobus' })}\n`);
  const said = capture(() => {
    assert.equal(install(hostOf(dir), { harnesses: 'codex', cwd: dir, env: envOf(home) }), 0);
  });
  const cfg = JSON.parse(readFileSync(path.join(dir, 'promptobus.json'), 'utf8'));
  // install wrote one key and not the other — the gap the note is about is real.
  assert.deepEqual(cfg.harnesses, ['codex']);
  assert.equal(Object.hasOwn(cfg, 'tools'), false);
  // …and it said so, naming the key, the harness, and that install does not write it.
  assert.match(said, /"tools"/);
  assert.match(said, /codex/);
  assert.match(said, /install does not write it/);

  // The refusal a person meets next names the same two keys against each other.
  let refusal = '';
  try {
    liftHarness(hostOf(dir), 'codex');
  } catch (e) {
    refusal = e.message;
  }
  assert.match(refusal, /declared: none/);
  assert.match(refusal, /"harnesses"/);
  assert.match(refusal, /never "tools"/);
});

test('PB-177: with tools declared, install is silent about it and the harness lifts', () => {
  const { dir, home } = sandbox();
  writeFileSync(path.join(dir, 'promptobus.json'), `${JSON.stringify({ tools: ['codex'] })}\n`);
  const said = capture(() => {
    assert.equal(install(hostOf(dir), { harnesses: 'codex', cwd: dir, env: envOf(home) }), 0);
  });
  // Negative control: the note is conditional. Without this, a note printed
  // unconditionally would satisfy the check above and say nothing.
  assert.doesNotMatch(said, /install does not write it/);
  assert.equal(liftHarness(hostOf(dir), 'codex').id, 'codex');
});

test('Stop guard command is promptobus guard and a clean mailbox does not loop', () => {
  const { dir, home } = sandbox();
  assert.equal(install(hostOf(dir), { harnesses: 'claude', cwd: dir, env: envOf(home) }), 0);
  const claude = JSON.parse(readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  const stopCmd = claude.hooks.Stop[0].hooks[0].command;
  assert.match(stopCmd, /promptobus guard/);
  assert.doesNotMatch(stopCmd, /promptobus install/);
  assert.ok(Number.isFinite(GUARD_BLOCK_LIMIT) && GUARD_BLOCK_LIMIT >= 1);
  const event = `${JSON.stringify({ hook_event_name: 'Stop', cwd: dir })}\n`;
  const first = runCommand(stopCmd, { cwd: dir, home, input: event });
  const second = runCommand(stopCmd, { cwd: dir, home, input: event });
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(first.stdout.trim(), '');
  assert.equal(second.stdout.trim(), '');
  assert.deepEqual(listRel(home), []);
});

