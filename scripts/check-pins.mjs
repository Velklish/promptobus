// Pin gate: the local command must resolve the declared backslop release.
// Historical tracker records keep the command that was current then.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = 'backslop.json';
const PACKAGE = 'package.json';
const LOCK = 'package-lock.json';
const SPEC = ['github:Velklish', 'backslop'].join('/');
const CLI = ['npx', '--no-install', 'backslop'].join(' ');
const say = (line) => process.stdout.write(line + '\n');
const escape = (value) => value.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));

const cfg = readJson(CONFIG);
const pkg = readJson(PACKAGE);
const lock = readJson(LOCK);
const failures = [];
const declared = pkg.devDependencies?.backslop;
const version = typeof declared === 'string'
  ? declared.match(new RegExp('^' + escape(SPEC) + '#v(\\d+\\.\\d+\\.\\d+)$'))?.[1]
  : null;

if (!version) {
  failures.push(PACKAGE + ': devDependencies.backslop must be an exact ' + SPEC
    + '#vX.Y.Z release, got ' + JSON.stringify(declared ?? null));
}
if (cfg.cli !== CLI) {
  failures.push(CONFIG + ': cli must be ' + JSON.stringify(CLI)
    + ', got ' + JSON.stringify(cfg.cli ?? null));
}
if (version && cfg.version !== version) {
  failures.push(CONFIG + ': version ' + JSON.stringify(cfg.version ?? null)
    + ' differs from ' + PACKAGE + ' backslop v' + version);
}
if (!cfg.gates?.some((entry) => (typeof entry === 'string' ? entry : entry?.command) === CLI + ' lint')) {
  failures.push(CONFIG + ': gates do not contain ' + JSON.stringify(CLI + ' lint'));
}

const lockedSpec = lock.packages?.['']?.devDependencies?.backslop;
if (lockedSpec !== declared || !version) {
  failures.push(LOCK + ': root devDependencies.backslop ' + JSON.stringify(lockedSpec ?? null)
    + ' differs from ' + PACKAGE + ' ' + JSON.stringify(declared ?? null));
}
const locked = lock.packages?.['node_modules/backslop'];
const resolved = locked?.resolved;
const resolvedCommit = typeof resolved === 'string'
  ? resolved.match(/^git\+(?:ssh:\/\/git@|https:\/\/)github\.com\/Velklish\/backslop(?:\.git)?#([0-9a-f]{40}|[0-9a-f]{64})$/)?.[1]
  : null;
if (version && locked?.version !== version) {
  failures.push(LOCK + ': node_modules/backslop version ' + JSON.stringify(locked?.version ?? null)
    + ' differs from declared v' + version);
}
if (!resolvedCommit) {
  failures.push(LOCK + ': node_modules/backslop resolved must name a commit of ' + SPEC
    + ', got ' + JSON.stringify(resolved ?? null));
}

const installedPackage = path.join(ROOT, 'node_modules', 'backslop', 'package.json');
const installedLock = path.join(ROOT, 'node_modules', '.package-lock.json');
let installed = 'not checked (node_modules/backslop absent)';
if (existsSync(installedPackage) || existsSync(installedLock)) {
  if (!existsSync(installedPackage)) {
    failures.push('node_modules/backslop/package.json: missing while the installed lock exists');
  } else {
    const installedVersion = JSON.parse(readFileSync(installedPackage, 'utf8')).version;
    if (version && installedVersion !== version) {
      failures.push('node_modules/backslop/package.json: version '
        + JSON.stringify(installedVersion) + ' differs from declared v' + version);
    }
    installed = existsSync(installedLock)
      ? 'manifest and resolved commit checked'
      : 'version checked; resolved commit not checked (node_modules/.package-lock.json absent)';
  }
  if (existsSync(installedLock)) {
    const entry = JSON.parse(readFileSync(installedLock, 'utf8')).packages?.['node_modules/backslop'];
    if (entry?.resolved !== resolved || !resolvedCommit) {
      failures.push('node_modules/.package-lock.json: backslop resolved '
        + JSON.stringify(entry?.resolved ?? null) + ' differs from ' + LOCK
        + ' ' + JSON.stringify(resolved ?? null));
    }
    if (version && entry?.version !== version) {
      failures.push('node_modules/.package-lock.json: backslop version '
        + JSON.stringify(entry?.version ?? null) + ' differs from declared v' + version);
    }
  }
}

// ADRs, task cards and archive records retain citations to their own time.
// The archive rules and journal header are live instructions.
const DOCS = cfg.docs ?? 'docs';
const PREFIX = cfg.prefix ?? '';
const ARCHIVE = new RegExp('^' + escape(DOCS) + '/archive/' + escape(PREFIX) + '-\\d');
const ARCHIVE_LOG = DOCS + '/archive/LOG.md';
const CARD = new RegExp('^' + escape(PREFIX) + '-\\d+(?:\\.\\d+)?-.+\\.md$');
const historical = (rel) => rel === 'CHANGELOG.md'
  || rel.startsWith(DOCS + '/adr/')
  || ARCHIVE.test(rel)
  || CARD.test(path.posix.basename(rel));
const legacy = new RegExp(escape(SPEC) + '(?:\\.git)?(?:#[^\\s\\x27\\x22\\x60)\\],;]+)?', 'g');
const localCall = /\bnpx\s+--no-install\s+backslop\b/g;
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean);

let read = 0;
let guarded = 0;
let historicalRefs = 0;
for (const rel of tracked) {
  let content;
  try {
    content = readFileSync(path.join(ROOT, rel), 'utf8');
  } catch (error) {
    failures.push(rel + ': unreadable (' + (error.code ?? error.message)
      + ') — the gate cannot vouch for it');
    continue;
  }
  read += 1;
  const old = [...content.matchAll(legacy)];
  if (historical(rel)) {
    historicalRefs += old.length;
    continue;
  }
  if (![CONFIG, PACKAGE, LOCK, 'scripts/check-pins.mjs'].includes(rel)) {
    guarded += [...content.matchAll(localCall)].length;
  }
  let dependencyAllowance = rel === PACKAGE || rel === LOCK ? 1 : 0;
  const firstLogRow = rel === ARCHIVE_LOG ? content.search(/^- <a id=/m) : -1;
  for (const match of old) {
    if (rel === ARCHIVE_LOG && firstLogRow >= 0 && match.index >= firstLogRow) {
      historicalRefs += 1;
      continue;
    }
    if (dependencyAllowance && match[0] === declared) {
      dependencyAllowance -= 1;
      continue;
    }
    const line = content.slice(0, match.index).split('\n').length;
    failures.push(rel + ':' + line + ': live GitHub backslop ref ' + match[0]
      + ' — use ' + CLI + '; the dependency pin belongs in ' + PACKAGE);
  }
}
if (!guarded) {
  failures.push('pin gate: no live ' + CLI
    + ' call outside the config, dependency files and this gate — the scan may have missed the project');
}

const seen = read + ' of ' + tracked.length + ' tracked file(s) read · '
  + guarded + ' local call(s) outside config/dependency files · '
  + historicalRefs + ' historical GitHub ref(s) left alone · installed: ' + installed;
for (const failure of failures) say('✖ ' + failure);
if (failures.length) {
  say('✖ pin gate: ' + failures.length + ' finding(s) · ' + seen);
  process.exit(1);
}
say('✔ pin gate: ' + declared + ', lock commit ' + resolvedCommit + ' · ' + seen);
