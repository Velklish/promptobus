import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');

function exportedString(src, name) {
  const m = src.match(new RegExp(`export const ${name} = '([^']*)'`));
  assert.ok(m, `core constant ${name} is missing`);
  return m[1];
}

function templateConst(src, name) {
  const m = src.match(new RegExp(`^const ${name} = '([^']*)'`, 'm'));
  assert.ok(m, `template constant ${name} is missing`);
  return m[1];
}

test('bus-hook template searches the marks the core prints', () => {
  // The hook is a generated leaf: it cannot import the core, so it copies the
  // literals. If either side changes alone, the hook goes silent — it does not
  // throw, and no other gate sees it. This check is the gate.
  const core = readFileSync(path.join(ROOT, 'src', 'mcp', 'render.ts'), 'utf8');
  const hook = readFileSync(path.join(ROOT, 'templates', 'bus-hook.mjs'), 'utf8');
  const pairs = [
    ['ADDR_MARK', 'ADDR'],
    ['SENT_PREFIX', 'SENT'],
    ['MAILBOX_EMPTY', 'EMPTY'],
  ];
  for (const [coreName, hookName] of pairs) {
    assert.equal(templateConst(hook, hookName), exportedString(core, coreName), hookName);
  }
  const from = exportedString(core, 'MESSAGE_FROM').trim();
  assert.ok(hook.includes(`\\s+${from}\\s+`), 'mailbox heading regex uses MESSAGE_FROM');
  assert.ok(hook.includes(`^${exportedString(core, 'SENT_PREFIX').trim()}\\s+`), 'sent regex uses SENT_PREFIX');
});

test('createStandaloneHost lifts two independent hosts in one process', async () => {
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
  assert.equal(a.inWorkspace(dirA), true);
  assert.equal(a.inWorkspace(dirB), false);
  // cloneOf: a clone below the root by its path, the root itself and the outside — null.
  mkdirSync(path.join(dirA, 'g', 'r', '.git'), { recursive: true });
  assert.deepEqual(a.cloneOf(path.join(dirA, 'g', 'r', 'src')), { abs: path.join(dirA, 'g', 'r'), nsPath: 'g/r' });
  assert.equal(a.cloneOf(path.join(dirA, 'g')), null);
  assert.equal(a.cloneOf(dirA), null);
  assert.equal(a.cloneOf(dirB), null);
  assert.equal(a.findRoot(dirA), path.resolve(dirA));
  assert.equal(a.cloneHint('x'), 'git clone <url> x');
  assert.equal(a.formatNpx(['clone', 'x']), 'npx alpha clone x');
  assert.equal(a.installManifestRel(), path.join('.promptobus', 'manifest.json'));
  assert.equal(a.promptobusHome(), path.join(dirA, '.promptobus'));
});

test('the routing types leave the package through both entry points', () => {
  // A type declared in `src/host.ts` and forgotten in an entry point is invisible
  // to `tsc` — the interface compiles, the package builds, and only a consumer
  // writing `import type { … } from 'promptobus/host'` finds out. That is the
  // same shape of drift the `bin` field of HostToolBin carries a comment about.
  // Checked on the emitted declarations, not the source: the entry point's job
  // is what reaches `dist/`.
  for (const entry of ['host-index.d.ts', 'index.d.ts']) {
    const text = readFileSync(path.join(ROOT, 'dist', entry), 'utf8');
    for (const name of ['HostRoutingPaths', 'HostRoutingOverlay']) {
      assert.match(text, new RegExp(`\\b${name}\\b`), `${entry} does not re-export ${name}`);
    }
  }
});

test('routingPaths keeps the account files out of the per-workspace store', async () => {
  // Two hosts, two workspace roots, one machine account. The cache and the
  // `user` overlay must be the SAME file for both — that is what makes the
  // preflight of the second checkout free — while the `workspace` overlay
  // follows the root. A routing path that drifted into `promptobusHome()`
  // would pass every other check in this file and only show up as three
  // harnesses re-probed per clone.
  const { createStandaloneHost } = await import('../dist/host-index.js');
  const dirA = mkdtempSync(path.join(tmpdir(), 'promptobus-routing-a-'));
  const dirB = mkdtempSync(path.join(tmpdir(), 'promptobus-routing-b-'));
  process.on('exit', () => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });
  const a = createStandaloneHost({ cwd: dirA, commandName: 'alpha' });
  const b = createStandaloneHost({ cwd: dirB, commandName: 'beta' });
  const pa = a.routingPaths();
  const pb = b.routingPaths();

  assert.equal(pa.cacheFile, path.join(homedir(), '.promptobus', 'model-routing', 'cache.json'));
  assert.equal(pa.cacheFile, pb.cacheFile);
  assert.equal(pa.cacheFile.startsWith(a.promptobusHome()), false);

  assert.deepEqual(pa.overlays.map((o) => o.id), ['user', 'workspace']);
  assert.equal(pa.overlays[0].path, path.join(homedir(), '.promptobus', 'model-routing.json'));
  assert.equal(pa.overlays[0].path, pb.overlays[0].path);
  assert.equal(pa.overlays[1].path, path.join(dirA, 'model-routing.local.json'));
  assert.equal(pb.overlays[1].path, path.join(dirB, 'model-routing.local.json'));
});

test('entry point ./hooks returns a plan without a foreign workspace layout', async () => {
  const { createStandaloneHost } = await import('../dist/host-index.js');
  const { planPromptobusHooks, BUS_HOOK_EVENT } = await import('../dist/hooks.js');
  const host = createStandaloneHost({ cwd: '.', commandName: 'promptobus', binPath: '/bin/pb' });
  const planned = planPromptobusHooks(host);
  assert.equal(planned.rel, path.join('.promptobus', 'hooks', 'bus.mjs'));
  assert.match(planned.text, /Generated by promptobus sync/);
  assert.ok(planned.settings[BUS_HOOK_EVENT]);
});

test('an explicit cwd reads promptobus.json; options.config overlays it', async () => {
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

// --- harness state homes: named, or refused ------------------------------------------
//
// The package used to fall back to `~/.promptobus/<harness>` when
// `PROMPTOBUS_CURSOR_HOME` / `PROMPTOBUS_CODEX_HOME` were unset. A consumer that had
// named its own variables instead therefore had the Cursor and Codex registries writing
// into the operator's REAL home while `inspect` read the sandbox — two halves of one
// test in different directories, with no error anywhere (PB-2). The fallback is gone;
// the host answers, and a host that answers nothing gets a refusal by name.

test('standalone answers harnessStateHome for every harness it is asked about', async () => {
  const { createStandaloneHost } = await import('../dist/host-index.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'promptobus-harness-home-'));
  process.on('exit', () => { rmSync(dir, { recursive: true, force: true }); });
  const host = createStandaloneHost({ cwd: dir });
  // The same path the package used to guess: a single-user checkout sets no variable
  // and notices no change. What moved is WHO says it.
  assert.equal(host.harnessStateHome('cursor'), path.join(homedir(), '.promptobus', 'cursor'));
  assert.equal(host.harnessStateHome('codex'), path.join(homedir(), '.promptobus', 'codex'));
});

test('the environment wins over the host, and a host that names none refuses by name', async () => {
  const { bindHarnessHomes, harnessStateHome } = await import('../lib/harness-home.js');
  const { cursorStateHome } = await import('../lib/cursor-persist.js');
  const { codexStateHome } = await import('../lib/codex-session.js');
  try {
    bindHarnessHomes({ harnessStateHome: (h) => `/from-host/${h}` });
    assert.equal(cursorStateHome({ PROMPTOBUS_CURSOR_HOME: '/from-env' }), '/from-env',
      'the environment is the most local thing anyone said, and it wins');
    assert.equal(cursorStateHome({}), '/from-host/cursor');
    assert.equal(codexStateHome({}), '/from-host/codex');

    // The FIRST binding of a process wins: a second host is ignored rather than
    // moving the registries out from under a run already going. `hostOf` builds a
    // standalone host for a bare root string, and inside a process that entered
    // through `runPromptobus` with a consumer's host that overwrite would send
    // `inspect` somewhere the writes never went.
    bindHarnessHomes({ harnessStateHome: () => '/second-host' });
    assert.equal(cursorStateHome({}), '/from-host/cursor', 'the second binding is ignored');

    // A host that answers `null` is the consumer case the refusal exists for: it named
    // its own variables, the package sees neither, and a guess would land in the real
    // home in silence. Unbinding first is how a caller that MEANS to rebind says so.
    bindHarnessHomes(null);
    bindHarnessHomes({ harnessStateHome: () => null });
    assert.throws(() => cursorStateHome({}), (e) => {
      assert.equal(e.constructor.name, 'GateError');
      assert.match(e.message, /PROMPTOBUS_CURSOR_HOME/, 'the refusal names the variable');
      assert.match(e.message, /harnessStateHome\('cursor'\)/, 'and the host method');
      return true;
    });
    assert.throws(() => codexStateHome({}), /PROMPTOBUS_CODEX_HOME/);
    // No host bound at all is the same refusal: a host was never asked, not asked and
    // silent — the reader needs the same two names either way.
    bindHarnessHomes(null);
    assert.throws(() => harnessStateHome('cursor', {}), /PROMPTOBUS_CURSOR_HOME/);
  } finally {
    bindHarnessHomes(null);
  }
});
