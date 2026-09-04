// Package boundaries: imports, environment, harness-neutrality, publicity and exports.
// Run with `npm test`. dist is built by pretest.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const SRC = path.join(ROOT, 'src');

const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

const SPECIFIER = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g;

function tsFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) tsFiles(abs, out);
    else if (e.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

function forbiddenSpec(spec, fileAbs) {
  // A specifier is one token. English source now has `from` inside a string
  // (`MESSAGE_FROM = ' from '`), and `\bfrom\s*['"]` would otherwise take the
  // closing quote as the start of an import and swallow the rest of the file.
  if (!spec || /[\n\r;]/.test(spec)) return null;
  if (isBuiltin(spec)) return null;
  if (!spec.startsWith('.')) return 'external package';
  const target = path.resolve(path.dirname(fileAbs), spec);
  if (target === SRC || target.startsWith(SRC + path.sep)) return null;
  return 'path out of src';
}

test('package sources import only Node built-ins and their own files', () => {
  const breaches = [];
  for (const file of tsFiles(SRC)) {
    const text = stripComments(readFileSync(file, 'utf8'));
    for (const m of text.matchAll(SPECIFIER)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
      const reason = forbiddenSpec(spec, file);
      if (reason) breaches.push(`${path.relative(ROOT, file)}: ${spec} — ${reason}`);
    }
  }
  assert.deepEqual(breaches, []);
});

test('package sources do not read the environment and do not write to process streams', () => {
  const ambient = [];
  const checks = [
    ['process.env', /\bprocess\s*\.\s*env\b/],
    ['process.stdout', /\bprocess\s*\.\s*stdout\b/],
    ['process.stderr', /\bprocess\s*\.\s*stderr\b/],
    ['console', /\bconsole\s*\./],
  ];
  for (const file of tsFiles(SRC)) {
    const text = stripComments(readFileSync(file, 'utf8'));
    for (const [name, re] of checks) {
      if (re.test(text)) ambient.push(`${path.relative(ROOT, file)}: ${name}`);
    }
  }
  assert.deepEqual(ambient, []);
});

test('package sources have no harness-specific names', () => {
  // The subject is the raw file text, including comments and string literals: a
  // harness name in a comment is the same knowledge of a particular tool as in
  // the code. `stripComments` is not used here — it would also cut a literal
  // that happened to contain `//` or `/*`.
  const harnessed = [];
  const names = [
    ['claude', /claude/i],
    ['codex', /codex/i],
    ['anthropic', /anthropic/i],
  ];
  for (const file of tsFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const [name, re] of names) {
      if (re.test(text)) harnessed.push(`${path.relative(ROOT, file)}: ${name}`);
    }
  }
  assert.deepEqual(harnessed, []);
});

const CONTOUR = {
  pkg: ['ati', 'agents'].join('-'),
  layout: ['.', 'agents'].join(''),
  env: ['ATI', '_'].join(''),
  memory: ['context', 'store'].join('-'),
  gitlab: ['gitlab', 'ati'].join('.'),
};

test('the standalone host source does not contain another workplace layout', () => {
  const standaloneSrc = readFileSync(path.join(SRC, 'standalone.ts'), 'utf8');
  const forbidden = [CONTOUR.pkg, CONTOUR.layout, CONTOUR.env, CONTOUR.memory, CONTOUR.gitlab]
    .filter((n) => standaloneSrc.includes(n));
  assert.deepEqual(forbidden, []);
});

test('src and its own suite have no names of another contour', () => {
  const needles = [CONTOUR.pkg, CONTOUR.layout, CONTOUR.env];
  const hits = [];
  const files = [
    ...walk(SRC),
    ...walk(path.join(ROOT, 'test')).filter((f) => !f.endsWith(`${path.sep}driver.test.mjs`)),
    ...walk(path.join(ROOT, 'schemas')),
    ...walk(path.join(ROOT, 'templates')),
  ];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const needle of needles) {
      if (text.includes(needle)) hits.push(`${path.relative(ROOT, file)}: ${needle}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('declared exports resolve and yield a surface', async () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

  // `./cli` is the runtime-track entry (`lib/cli.js`); the core does not build
  // it and does not resolve it here. The other manifest keys must open.
  const SKIP = new Set(['./cli']);
  for (const [key, spec] of Object.entries(pkg.exports)) {
    if (SKIP.has(key)) continue;
    if (typeof spec === 'string' && spec.includes('*')) {
      assert.equal(key, './schemas/*');
      assert.equal(spec, './schemas/*');
      continue;
    }
    const rel = typeof spec === 'string' ? spec : spec?.default;
    assert.equal(typeof rel, 'string', `export ${key} has no path`);
    const mod = await load(rel);
    assert.equal(typeof mod, 'object', `export ${key} did not open`);
  }

  const index = await load(pkg.exports['.'].default);
  assert.equal(index.PROTOCOL_VERSION, 1);
  assert.equal(index.PACKAGE_NAME, pkg.name);
  assert.equal(typeof index.openEngine, 'function');
  assert.equal(typeof index.createStandaloneHost, 'function');

  const driver = await load(pkg.exports['./driver'].default);
  assert.equal(typeof driver.driverFor, 'function');

  const host = await load(pkg.exports['./host'].default);
  assert.equal(typeof host.createStandaloneHost, 'function');
  assert.equal(typeof host.isPromptobusHost, 'function');
  assert.equal(typeof host.HOST_KIND, 'string');

  const hooks = await load(pkg.exports['./hooks'].default);
  assert.equal(typeof hooks.planPromptobusHooks, 'function');
  assert.equal(typeof hooks.renderBusHook, 'function');

  for (const model of ['task', 'participant', 'message', 'artifact']) {
    const file = path.join(ROOT, 'schemas', 'v1', `${model}.schema.json`);
    JSON.parse(readFileSync(file, 'utf8'));
  }
});

test('LEGACY layout comes from the host: without it there is no migration, two segments are the rel form', async () => {
  const {
    createStandaloneHost, splitLegacyRel, migrationNeeded, preflight, GateError,
  } = await import('../dist/index.js');
  const host = createStandaloneHost({ cwd: '.' });
  assert.equal(host.legacyLayout(), null);
  assert.equal(migrationNeeded('/no/such/root', null), false);
  assert.equal(preflight('/no/such/root', null).needed, false);

  let omitted = null;
  try { migrationNeeded('/no/such/root'); } catch (e) { omitted = e; }
  assert.ok(omitted instanceof GateError);
  omitted = null;
  try { preflight('/no/such/root'); } catch (e) { omitted = e; }
  assert.ok(omitted instanceof GateError);

  assert.deepEqual(splitLegacyRel('old/bus'), ['old', 'bus']);

  const badRel = ['only', '/old/bus', 'old//bus', '../bus', 'old\\bus', 'old/../bus'];
  for (const rel of badRel) {
    let threw = null;
    try { splitLegacyRel(rel); } catch (e) { threw = e; }
    assert.ok(threw instanceof GateError, `rel ${JSON.stringify(rel)} must refuse`);
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'promptobus-legacy-'));
  process.on('exit', () => { rmSync(dir, { recursive: true, force: true }); });
  mkdirSync(path.join(dir, 'old', 'bus'), { recursive: true });
  const layout = { rel: 'old/bus', done: 'oldcli done --task <id>' };
  assert.equal(migrationNeeded(dir, layout), true);
  assert.equal(preflight(dir, layout).legacyHome, path.join(dir, 'old', 'bus'));
  assert.equal(migrationNeeded(dir, null), false);

  let cfg = null;
  try { preflight(dir, { rel: '../bus', done: 'x' }); } catch (e) { cfg = e; }
  assert.ok(cfg instanceof GateError);
  cfg = null;
  try { migrationNeeded(dir, { rel: '../bus', done: 'x' }); } catch (e) { cfg = e; }
  assert.ok(cfg instanceof GateError);
});
