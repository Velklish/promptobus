// Package packing gates for the public promptobus repo. Does not recurse into npm test.
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isBuiltin } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from '../lib/exec.js';
import { check } from './check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const SRC = path.join(REPO, 'src');

const SB = mkdtempSync(path.join(os.tmpdir(), 'promptobus-package-'));
process.on('exit', () => rmSync(SB, { recursive: true, force: true }));

const DEPS = path.join(REPO, 'node_modules', 'typescript');
const depsReady = existsSync(DEPS);
check('build dependencies are installed',
  depsReady, `missing ${DEPS} — run npm install at the repo root`);
if (!depsReady) process.exit(1);

const COPY_ROOT = path.join(SB, 'repo');
cpSync(REPO, COPY_ROOT, {
  recursive: true,
  filter: (s) => {
    const base = path.basename(s);
    if (base === 'node_modules' || base === '.git' || base === 'dist') return false;
    return true;
  },
});
symlinkSync(path.join(REPO, 'node_modules'), path.join(COPY_ROOT, 'node_modules'), 'junction');
const BIN = path.join(REPO, 'node_modules', '.bin');
const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
const env = {
  ...process.env,
  [PATH_KEY]: `${BIN}${path.delimiter}${process.env[PATH_KEY] ?? ''}`,
};
const npm = (args, cwd) => run('npm', args, { cwd, encoding: 'utf8', env });

const tsconfig = JSON.parse(readFileSync(path.join(REPO, 'tsconfig.json'), 'utf8'));
check('package tsconfig does not emit dist on type errors',
  tsconfig.compilerOptions?.noEmitOnError === true,
  JSON.stringify(tsconfig.compilerOptions ?? {}));

const tail = (text, lines) => (text || '').split('\n')
  .filter((l) => l.trim() && !l.startsWith('npm notice'))
  .slice(-lines).join('\n');
const why = (r) => (r.error ? r.error.message
  : [tail(r.stderr, 8), tail(r.stdout, 30)].filter(Boolean).join('\n'));

const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
// Import/export forms only. A bare `\bfrom` hits `MESSAGE_FROM = ' from '`
// and `export const … = ' from '` in src/mcp/render.ts.
const SPECIFIER = /\b(?:import|export)(?:\s+type)?\s+(?:\*\s+(?:as\s+\w+\s+)?|[\w$]+\s+|\{[\s\S]*?\}\s+)from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g;

function tsFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) tsFiles(abs, out);
    else if (e.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

function forbidden(spec, fileAbs) {
  if (isBuiltin(spec)) return null;
  if (!spec.startsWith('.')) return 'external package';
  const target = path.resolve(path.dirname(fileAbs), spec);
  if (target === SRC || target.startsWith(SRC + path.sep)) return null;
  return 'path outside src';
}

const breaches = [];
for (const file of tsFiles(SRC)) {
  const text = stripComments(readFileSync(file, 'utf8'));
  for (const m of text.matchAll(SPECIFIER)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    const reason = forbidden(spec, file);
    if (reason) breaches.push(`${path.relative(REPO, file)}: ${spec} — ${reason}`);
  }
}
check('package sources import only Node built-ins and their own files',
  breaches.length === 0, breaches.join('; '));

const built = npm(['run', 'build'], COPY_ROOT);
check('copy of the repo builds', built.status === 0, why(built));

function packList() {
  const r = npm(['pack', '--dry-run', '--json'], COPY_ROOT);
  if (r.status !== 0) return { ok: false, files: [], detail: why(r) };
  try {
    return { ok: true, files: JSON.parse(r.stdout)[0].files.map((f) => f.path), detail: '' };
  } catch (e) {
    return { ok: false, files: [], detail: `${e.message}: ${r.stdout.slice(0, 300)}` };
  }
}

const packed = packList();
check('npm pack --dry-run --json succeeded', packed.ok, packed.detail);
const files = packed.files;

check('tarball contains package.json',
  files.includes('package.json'), files.join(', '));
check('tarball contains built dist with declarations',
  files.includes('dist/index.js') && files.includes('dist/index.d.ts')
  && files.includes('dist/driver.js') && files.includes('dist/host-index.js')
  && files.includes('dist/hooks.js'),
  files.filter((f) => f.startsWith('dist/')).join(', '));
check('tarball contains the bus-hook template',
  packed.ok && files.includes('templates/bus-hook.mjs'),
  files.filter((f) => f.includes('template')).join(', ') || files.join(', '));
const SCHEMAS_V1 = ['task', 'participant', 'message', 'artifact']
  .map((model) => `schemas/v1/${model}.schema.json`);
const missingSchemas = SCHEMAS_V1.filter((f) => !files.includes(f));
check('tarball contains all four protocol v1 schemas',
  packed.ok && missingSchemas.length === 0, `missing: ${missingSchemas.join(', ')}`);

const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const runtimeDeps = ['dependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies']
  .flatMap((field) => Object.keys(pkg[field] ?? {}));
check('package has no runtime dependencies', runtimeDeps.length === 0, runtimeDeps.join(', '));
check('package.json declares ./host and ./hooks entry points',
  Boolean(pkg.exports?.['./host']) && Boolean(pkg.exports?.['./hooks']),
  JSON.stringify(pkg.exports ?? {}));

const leaked = files.filter((f) => f.startsWith('src/') || f.startsWith('test/') || f === 'tsconfig.json');
check('tarball does not include source, tests, or tsconfig',
  packed.ok && leaked.length === 0, leaked.join(', '));

const packDir = path.join(SB, 'pack');
const target = path.join(SB, 'install');
mkdirSync(packDir);
mkdirSync(target);
const packedTgz = npm(['pack', '--pack-destination', packDir], COPY_ROOT);
const tgz = readdirSync(packDir).find((n) => n.endsWith('.tgz'));
check('npm pack produced a tarball', packedTgz.status === 0 && !!tgz, why(packedTgz));

const installed = tgz
  ? npm(['install', '--no-audit', '--no-fund', '--ignore-scripts', '--offline',
    path.join(packDir, tgz)], target)
  : { status: 1, stderr: 'tarball was not built' };
check('tarball installs into an empty directory', installed.status === 0, why(installed));

const installedPkg = path.join(target, 'node_modules', 'promptobus');
const entry = path.join(installedPkg, 'dist', 'index.js');
const targetModules = path.join(target, 'node_modules');
const strangers = existsSync(targetModules)
  ? readdirSync(targetModules).filter((n) => !n.startsWith('.') && n !== 'promptobus')
  : ['no node_modules'];
check('reference validator and compiler do not ship in the tarball',
  installed.status === 0 && strangers.length === 0, strangers.join(', '));
check('installed tree has no package source or tests',
  existsSync(installedPkg) && !existsSync(path.join(installedPkg, 'src'))
  && !existsSync(path.join(installedPkg, 'test')), installedPkg);

const probe = existsSync(entry)
  ? spawnSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(pathToFileURL(entry).href)});`
    + 'process.stdout.write(`${m.PACKAGE_NAME} ${m.PROTOCOL_VERSION}`);'], { encoding: 'utf8' })
  : { stdout: '', stderr: `missing ${entry}` };
check('package imports from the installed tree',
  probe.stdout.trim() === 'promptobus 1',
  `${probe.stdout.trim()} ${why(probe)}`);
