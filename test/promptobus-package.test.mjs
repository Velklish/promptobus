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
import { check } from './check.mjs';
import { run } from '../lib/exec.js';

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

/**
 * Module specifiers of one TypeScript source, read as TOKENS rather than as text.
 *
 * A pattern cannot do this job. `src/mcp/render.ts` holds
 * `export const MESSAGE_FROM = ' from ';` — a message fragment, not an import — and a
 * scan for `from` next to a quote takes it for a specifier. That supposed specifier
 * ends at a `;` rather than a quote, so the rest of the file is read from inside a
 * string that never closes: whatever the gate guarantees, it guarantees only for the
 * part before the first sentence containing the word "from". Nothing raises. The
 * answer is confident and about a file the scanner never finished.
 *
 * Regular expressions carry the same trap: `src/hooks.ts` has `/'/g` and `/"/g`, one
 * quote each, and a scanner that cannot tell a regex literal from division opens a
 * string on that quote and loses the file from there.
 *
 * So the file is read once by a tokenizer that knows comments, strings, template
 * literals with interpolation, and regex literals; then a reader consumes the exact
 * shape of an import or re-export clause and gives up the moment the shape does not
 * hold. The word `from` inside a string is never a token, and a declaration that runs
 * away is never accepted.
 *
 * What it deliberately does not resolve: a specifier written as a template literal
 * (`import(`./${name}.js`)`). Its value is not knowable without running the code, and
 * a guess would be a worse answer than none.
 *
 * The traps live as files in `test/fixtures/import-scan/`, and the two checks below
 * point the scanner at them: a scanner is only as good as the file that breaks it.
 */
const WORD = /[A-Za-z0-9_$]/;
// After these words a `/` opens a regular expression. After a value — an identifier, a
// number, a string, a closing bracket — it is division.
const REGEX_AFTER = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);
const VALUE_END = new Set([')', ']', '}']);

function regexAllowed(prev) {
  if (!prev) return true;
  if (prev.kind === 'word') return REGEX_AFTER.has(prev.value);
  if (prev.kind === 'string' || prev.kind === 'template' || prev.kind === 'regex') return false;
  return !VALUE_END.has(prev.value);
}

// A quoted string from its opening quote. A line break ends it: an unterminated quote
// is a typo in the source, and swallowing the rest of the file over one is the very
// failure this scanner replaces.
function readQuoted(text, start) {
  const quote = text[start];
  let i = start + 1;
  let value = '';
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { value += text.slice(i, i + 2); i += 2; continue; }
    if (c === quote) return { at: i + 1, value };
    if (c === '\n') return { at: i, value };
    value += c;
    i += 1;
  }
  return { at: i, value };
}

// A regular expression literal from its opening slash. `[...]` is tracked because a
// `/` inside a character class does not close the literal — `src/hooks.ts` has one.
function skipRegex(text, start) {
  let i = start + 1;
  let inClass = false;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '\n') return i;
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      i += 1;
      while (i < text.length && /[a-z]/.test(text[i])) i += 1;
      return i;
    }
    i += 1;
  }
  return i;
}

function tokenize(text) {
  const tokens = [];
  let prev = null;
  const push = (kind, value) => { prev = { kind, value }; tokens.push(prev); };
  // Brace depth, and the depths at which an open template interpolation resumes its
  // template: `${` is an opening brace whose match goes back into the string, not into
  // code, and without the pair a `}` inside a template would unbalance the count.
  let depth = 0;
  const templates = [];
  let i = 0;

  // Template body from `start`: it ends either at the closing backtick or at an
  // interpolation, and the caller continues in code from there.
  const template = (start) => {
    let j = start;
    while (j < text.length) {
      const c = text[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') return { at: j + 1, interp: false };
      if (c === '$' && text[j + 1] === '{') return { at: j + 2, interp: true };
      j += 1;
    }
    return { at: j, interp: false };
  };
  const enterTemplate = (start) => {
    const body = template(start);
    i = body.at;
    if (body.interp) { templates.push(depth); depth += 1; }
  };

  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === '/' && regexAllowed(prev)) { i = skipRegex(text, i); push('regex', ''); continue; }
    if (c === "'" || c === '"') {
      const read = readQuoted(text, i);
      push('string', read.value);
      i = read.at;
      continue;
    }
    // A template is a token with no value: it is never a static specifier, and giving
    // it an empty string value would make it read as an unnamed external package.
    if (c === '`') { push('template', ''); enterTemplate(i + 1); continue; }
    if (WORD.test(c)) {
      let j = i;
      while (j < text.length && WORD.test(text[j])) j += 1;
      push('word', text.slice(i, j));
      i = j;
      continue;
    }
    if (c === '{') { depth += 1; push('punct', c); i += 1; continue; }
    if (c === '}') {
      if (templates.length && depth - 1 === templates[templates.length - 1]) {
        templates.pop();
        depth -= 1;
        enterTemplate(i + 1);
        continue;
      }
      depth -= 1;
      push('punct', c);
      i += 1;
      continue;
    }
    if (/\s/.test(c)) { i += 1; continue; }
    push('punct', c);
    i += 1;
  }
  return tokens;
}

function matchBrace(tokens, open) {
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    const value = tokens[i].kind === 'punct' ? tokens[i].value : null;
    if (value === '{') depth += 1;
    else if (value === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The specifier of the declaration starting at token `i`, or `null` when the tokens
 * there are not an import or a re-export.
 *
 * The reader consumes the exact clause shape — an optional `type`, then `*` with an
 * optional alias, a braced list, or a bare name, in the combinations the grammar
 * allows — and returns `null` the moment the shape does not hold. That is what keeps
 * `export const MESSAGE_FROM = ' from ';` from ever reaching a `from`: the reader
 * stops at `MESSAGE_FROM` instead of scanning ahead for the word.
 */
function declarationSpecifier(tokens, i) {
  const head = tokens[i].value;
  if (head === 'require' || head === 'import') {
    if (tokens[i + 1]?.value === '(' && tokens[i + 2]?.kind === 'string') return tokens[i + 2].value;
  }
  if (head !== 'import' && head !== 'export') return null;
  let j = i + 1;
  if (tokens[j]?.kind === 'string') return tokens[j].value;
  if (tokens[j]?.value === 'type') j += 1;
  let clause = false;
  for (;;) {
    const t = tokens[j];
    if (!t) return null;
    if (t.kind === 'punct' && t.value === '*') {
      j += 1;
      if (tokens[j]?.value === 'as') j += 2;
    } else if (t.kind === 'punct' && t.value === '{') {
      const end = matchBrace(tokens, j);
      if (end < 0) return null;
      j = end + 1;
    } else if (t.kind === 'word' && t.value !== 'from') {
      j += 1;
    } else break;
    clause = true;
    if (tokens[j]?.value === ',') { j += 1; continue; }
    break;
  }
  if (!clause || tokens[j]?.value !== 'from') return null;
  return tokens[j + 1]?.kind === 'string' ? tokens[j + 1].value : null;
}

function specifiersOf(text) {
  const tokens = tokenize(text);
  const found = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].kind !== 'word') continue;
    const spec = declarationSpecifier(tokens, i);
    if (spec) found.push(spec);
  }
  return found;
}

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

// The scanner's own gate, on files rather than on inline strings: the trap is a file
// SHAPE — a constant, then declarations after it — and a file is what the scanner is
// pointed at everywhere else.
const TRAPS = path.join(here, 'fixtures', 'import-scan');
const TRAP_SPECS = ['node:fs', 'node:path', 'node:os', './neighbour.js', './lazy.js', 'node:url'];
const trapSeen = specifiersOf(readFileSync(path.join(TRAPS, 'trap.ts'), 'utf8'));
check('import scan reads every declaration past strings, regexes and comments that look like imports',
  trapSeen.length === TRAP_SPECS.length && trapSeen.every((s, k) => s === TRAP_SPECS[k]),
  `saw: ${trapSeen.join(', ')} · wanted: ${TRAP_SPECS.join(', ')}`);

// The half that matters for the gate: seeing the file is worth nothing if the verdict
// about it is still green. `forbidden` is asked about a path INSIDE src — the fixture
// stands in for a package source, and its own directory would change the answer.
const afterTrap = specifiersOf(readFileSync(path.join(TRAPS, 'external-after-trap.ts'), 'utf8'));
const caught = afterTrap.filter((spec) => forbidden(spec, path.join(SRC, 'stand-in.ts')));
check('an external import placed after such a string is reported, not passed over',
  caught.length === 1 && caught[0] === 'zod', `saw: ${afterTrap.join(', ')} · reported: ${caught.join(', ')}`);

const breaches = [];
for (const file of tsFiles(SRC)) {
  for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
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
