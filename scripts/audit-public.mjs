// Publicity gate. Fails when anything private to the project this package was
// extracted from survives in what we ship.
//
// Two surfaces, and the second is why this script exists at all. Tracked files
// are easy to grep by hand. The npm tarball is not: it carries `dist/`, which is
// built rather than committed, so a leak compiled out of a clean source tree is
// invisible to any check that reads git alone.
//
// The forbidden strings are assembled from fragments on purpose. A gate that
// contained them literally would either flag itself or need an exemption, and an
// exemption is a hole shaped exactly like the thing being looked for.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../lib/exec.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_MAIN = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const say = (s) => process.stdout.write(`${s}\n`);
function checkRun(cmd, args, result) {
  if (!result.error && result.status === 0) return result;
  const detail = result.error?.code === 'ETIMEDOUT'
    ? `timed out: ${result.error.message}`
    : result.error?.message ?? `exited with status ${result.status}`;
  throw new Error(`${cmd} ${args.join(' ')} failed: ${detail}`);
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const LINK_TEXT = /\.(m?js|ts|md)$/;
const BRAND_FRAGMENT = ['A', 'TI'].join('');
const BRAND_WORD = new RegExp(`\\b${BRAND_FRAGMENT}\\b`, 'iu');
const BRAND_CAMEL = new RegExp(`\\b${BRAND_FRAGMENT.toLowerCase()}(?=\\p{Lu})`, 'u');
const BRAND_SNAKE = new RegExp(`\\b${BRAND_FRAGMENT}_`, 'iu');
const HOME_ROOT = ['(?:^|[^\\w])/', '(?:Users|home)', '/'].join('');
// ONE token-boundary grammar, and both halves below are built from it
// ([reference/README](../docs/reference/README.md)).
const TOKEN_STOP = '\\s"\'<>';
const TOKEN_CHARACTER = new RegExp(`[^${TOKEN_STOP}]`, 'u');
const HOME_USER = `[^/${TOKEN_STOP}]*[A-Za-z0-9][^/${TOKEN_STOP}]*`;
const ABSOLUTE_HOME_PATH = new RegExp(
  `${HOME_ROOT}${HOME_USER}(?:/[^${TOKEN_STOP}]+)?`,
  'u',
);

const textFromBytes = (bytes) => {
  if (bytes.includes(0)) return null;
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
};
const isTextContent = (bytes) => textFromBytes(bytes) !== null;
const normalizedName = (name) => name.replace(/^(?:tarball:)?package\//, '');
const syntheticHome = (root, segment, suffix = '') => [root, segment, suffix].join('');
const ABSOLUTE_HOME_PATH_EXEMPTIONS = new Map([
  ['test/model-routing-adapter-claude.test.mjs', [
    syntheticHome('/', 'home', '/someone'),
  ]],
  ['test/model-routing-preflight.test.mjs', [
    syntheticHome('/', 'home', '/someone/promptobus.json'),
  ]],
  ['test/runner.test.mjs', [
    syntheticHome('/', 'Users', '/probe/.local/bin/cursor'),
  ]],
  ['test/session-env.test.mjs', [
    syntheticHome('/', 'home', '/parent/.promptobus'),
    syntheticHome('/', 'home', '/parent'),
  ]],
]);
// Strips a literal only where it is the WHOLE token, and "whole" is read off
// `TOKEN_CHARACTER` — the same class the detector accepts inside a path.
const isPathCharacter = (value) => value !== undefined && TOKEN_CHARACTER.test(value);
const stripSyntheticHomeLiteral = (text, literal) => {
  let cursor = 0;
  let stripped = '';
  while (true) {
    const index = text.indexOf(literal, cursor);
    if (index < 0) return stripped + text.slice(cursor);
    const before = text[index - 1];
    const after = text[index + literal.length];
    stripped += text.slice(cursor, index);
    if (isPathCharacter(before) || isPathCharacter(after)) stripped += literal;
    cursor = index + literal.length;
  }
};
const absoluteOwnerHomePath = (name, text) => {
  const normalized = normalizedName(name);
  const literals = [...(ABSOLUTE_HOME_PATH_EXEMPTIONS.get(normalized) ?? [])]
    .sort((left, right) => right.length - left.length);
  const cleaned = literals.reduce(stripSyntheticHomeLiteral, text);
  return ABSOLUTE_HOME_PATH.test(cleaned);
};
export { absoluteOwnerHomePath, isTextContent };
const FORBIDDEN = [
  ['origin environment prefix', `${BRAND_FRAGMENT}_`],
  ['origin memory service', ['context', '-store'].join('')],
  ['origin tracker ids', new RegExp(['BL', '-[0-9]'].join(''))],
  ['absolute owner home path', absoluteOwnerHomePath],
];
// The organization's identity is read in every tracked text file and packed entry alike:
// tests, docs, the changelog and tracker records answer to it as runtime does, and no path is exempt.
const ORGANIZATION = [
  ['organization brand', (name, text) => [BRAND_WORD, BRAND_CAMEL, BRAND_SNAKE].some((re) => re.test(text))],
  ['organization namespace', new RegExp(['\\bloads', '[_-]search\\b'].join(''), 'iu')],
  ['organization service', ['cargos', '-api'].join('')],
  ['organization forge group', ['agent', '-workspace'].join('')],
  ['organization tracker ids', new RegExp(['\\bLS', '-[0-9]'].join(''), 'u')],
  ['organization tools', new RegExp(['\\b(?:kai', 'ten|team', 'ly)\\b'].join(''), 'iu')],
];
// --- English authoring -------------------------------------------------------
// Every tracked text file and packed entry is English: Cyrillic survives only in a snapshot named below
// or, outside the runtime paths, in a region `english-authoring: input — <reason>` … `english-authoring: end`.
const CYRILLIC = /[\u0400-\u04FF]/u;
const CYRILLIC_ALL = /[\u0400-\u04FF]/gu;
const WHOLE_FILE = /^[\s\S]*$/u;
const REGION_START = /^\s*(?:\/\/|#|<!--)\s*english-authoring: input\b(.*)$/u;
const REGION_END = /^\s*(?:\/\/|#|<!--)\s*english-authoring: end\b/u;
const RUNTIME_PATH = /^(?:bin|lib|src|schemas|templates|dist)\//u;
const LEGACY_V061 = 'test/fixtures/promptobus/legacy-v061/tasks/';
const LEGACY_V061_FILES = [
  't20260830-140000/task.json',
  't20260830-140000/read/orchestrator/20260830T153000000-0002-worker-stale.json',
  't20260830-140000/read/worker-stale/20260830T140100000-0001-orchestrator.json',
  't20260831-090000/task.json',
  't20260831-090000/supervisor.log',
  't20260831-090000/artifacts/demo-diff.patch',
  't20260831-090000/inbox/orchestrator/20260831T100000000-0010-worker-demo.json',
  't20260831-090000/inbox/worker-demo/20260831T090500000-0003-orchestrator.json',
  't20260831-090000/inbox/worker-demo/20260831T095000000-0008-orchestrator.json',
  't20260831-090000/read/orchestrator/20260831T092000000-0004-worker-demo.json',
  't20260831-090000/read/orchestrator/20260831T094000000-0005-worker-demo.json',
  't20260831-090000/read/orchestrator/20260831T094500000-0007-reviewer-demo.json',
  't20260831-090000/read/reviewer-demo/20260831T094200000-0006-orchestrator.json',
];
// [file, the span it excuses, why that span is not authored prose]
const AUTHORING_SNAPSHOTS = [
  ['src/protocol.ts', /const TRANSLIT(?:\s*:\s*Record<string, string>)?\s*=\s*\{[\s\S]*?\n\};/u,
    'the Cyrillic-to-Latin transliteration table is data that slugs are made from'],
  ['docs/archive/LOG.md', WHOLE_FILE,
    'the journal of closed tasks is history: a fold appends to it and nothing rewrites it'],
  [/^docs\/backlog\/[a-z]+\/PB-278\.1-mixed-step7-delivered-after-own-send\.md$/u,
    /^✖ step 7: the worker closed the note and sent a second result .*$/mu,
    'a run trace quoted as captured evidence'],
  ...LEGACY_V061_FILES.map((file) => [`${LEGACY_V061}${file}`, WHOLE_FILE,
    'a frozen v0.61 store snapshot, kept byte for byte (test/fixtures/promptobus/MANIFEST.md)']),
];
const GENERATED_FROM = new Map([
  ['dist/protocol.js', 'src/protocol.ts'],
]);
const failures = [];

const matches = (name, text, needle) => (typeof needle === 'function'
  ? needle(name, text)
  : needle instanceof RegExp ? needle.test(text) : text.includes(needle));
function scan(label, name, text, needle) {
  if (matches(name, text, needle)) failures.push(`${label}: ${name}`);
}

const organizationLeaks = (name, text) => ORGANIZATION
  .filter(([, needle]) => matches(name, text, needle))
  .map(([label]) => label);
export { organizationLeaks };
function scanOrganization(name, text) {
  for (const label of organizationLeaks(name, text)) failures.push(`${label}: ${name}`);
}

const namesFile = (file, name) => (file instanceof RegExp ? file.test(name) : file === name);
const blank = (span) => span.replace(CYRILLIC_ALL, '_');
const regionReason = (line) => line.match(REGION_START)[1].replace(/-->\s*$/u, '').replace(/^\s*[—:-]?\s*/u, '').trim();
/** Findings for one file: the first line of Cyrillic nothing excuses, and every malformed or empty region. */
const authoringFindings = (name, text) => {
  const normalized = normalizedName(name);
  const source = GENERATED_FROM.get(normalized) ?? normalized;
  const excused = AUTHORING_SNAPSHOTS.filter(([file]) => namesFile(file, source))
    .reduce((rest, [, span]) => rest.replace(span, blank), text);
  const findings = [];
  const runtime = RUNTIME_PATH.test(normalized);
  let open = null;
  const lines = excused.split('\n').map((line, index) => {
    const at = `${name}:${index + 1}`;
    if (runtime && (REGION_START.test(line) || REGION_END.test(line))) {
      if (REGION_START.test(line)) findings.push(`english-authoring region in a runtime path: ${at}`);
      return line;
    }
    if (REGION_START.test(line)) {
      if (open) findings.push(`english-authoring region opened inside another: ${at}`);
      if (!regionReason(line)) findings.push(`english-authoring region without a reason: ${at}`);
      open = { at, used: false };
      return line;
    }
    if (REGION_END.test(line)) {
      if (!open) findings.push(`english-authoring end without a region: ${at}`);
      else if (!open.used) findings.push(`english-authoring region excuses nothing: ${open.at}`);
      open = null;
      return line;
    }
    if (!open || !CYRILLIC.test(line)) return line;
    open.used = true;
    return blank(line);
  });
  if (open) findings.push(`english-authoring region never closed: ${open.at}`);
  const first = lines.findIndex((line) => CYRILLIC.test(line));
  if (first >= 0) findings.push(`Cyrillic authored text: ${name}:${first + 1}`);
  return findings;
};
/** Snapshot entries that excuse no Cyrillic in the tracked tree: the list only shrinks with what it names. */
const staleAuthoringSnapshots = (texts) => AUTHORING_SNAPSHOTS
  .filter(([file, span]) => ![...texts].some(([name, text]) => namesFile(file, name)
    && CYRILLIC.test(text.match(span)?.[0] ?? '')))
  .map(([file]) => String(file));
export { authoringFindings, staleAuthoringSnapshots };
function scanAuthoring(name, text) {
  failures.push(...authoringFindings(name, text));
}

if (IS_MAIN) {
// --- surface 1: what git tracks -------------------------------------------
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  let trackedTextCount = 0;
  const trackedTexts = new Map();

  for (const rel of tracked) {
    const text = textFromBytes(readFileSync(path.join(ROOT, rel)));
    if (text === null) continue;
    trackedTextCount += 1;
    trackedTexts.set(rel, text);
    for (const [label, needle] of FORBIDDEN) scan(label, rel, text, needle);
    scanOrganization(rel, text);
    scanAuthoring(rel, text);
  }
  for (const stale of staleAuthoringSnapshots(trackedTexts)) failures.push(`stale authoring snapshot: ${stale}`);

  // Links that point outside this repository are the quieter half of the same
  // problem: they read as documentation and resolve to nothing.
  //
  // Only prose is examined. In a markdown file every line is prose; in code only
  // comment lines are, because `](` also occurs inside regular expressions and
  // string literals, and a gate that reported those would be answered by muting it.
  const LINK = /\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  // In markdown a fenced block or an inline code span is not prose either: a sentence
  // that QUOTES the link pattern would otherwise be read as a link to its example.
  const mdProse = (text) => text
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
  const proseOf = (rel, text) => (rel.endsWith('.md')
    ? mdProse(text)
    : text.split('\n').filter((l) => /^\s*(\/\/|\*)/.test(l)).join('\n'));
  for (const rel of tracked) {
    if (!LINK_TEXT.test(rel)) continue;
    const text = proseOf(rel, readFileSync(path.join(ROOT, rel), 'utf8'));
    for (const m of text.matchAll(LINK)) {
      const target = m[1].trim();
      const file = target.split('#')[0];
      if (!file || /^[a-z]+:/i.test(file)) continue;
      const abs = path.resolve(path.dirname(path.join(ROOT, rel)), file);
      if (!abs.startsWith(ROOT + path.sep)) failures.push(`link leaves the repository: ${rel} → ${target}`);
      else if (!existsSync(abs)) failures.push(`link resolves to nothing: ${rel} → ${target}`);
    }
  }

  // --- surface 2: what npm would ship ---------------------------------------
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'promptobus-audit-'));
  let packedTextCount = 0;
  try {
    const buildArgs = ['run', 'build'];
    checkRun('npm', buildArgs, run('npm', buildArgs, { cwd: ROOT, stdio: 'ignore' }));
    const packArgs = ['pack', '--pack-destination', tmp];
    const packedResult = checkRun('npm', packArgs, run('npm', packArgs, { cwd: ROOT, encoding: 'utf8' }));
    const packed = packedResult.stdout.trim().split('\n').pop();
    const tarball = path.join(tmp, packed);
    const extractArgs = ['-xzf', tarball, '-C', tmp];
    checkRun('tar', extractArgs, run('tar', extractArgs));
    const listArgs = ['-tzf', tarball];
    const listed = checkRun('tar', listArgs, run('tar', listArgs, { encoding: 'utf8' })).stdout.split('\n').filter(Boolean);
    say(`tarball: ${packed} · ${listed.length} entries`);
    for (const entry of listed) {
      if (entry.endsWith('/')) continue;
      const abs = path.join(tmp, entry);
      if (!existsSync(abs)) continue;
      const text = textFromBytes(readFileSync(abs));
      if (text === null) continue;
      packedTextCount += 1;
      for (const [label, needle] of FORBIDDEN) scan(label, 'tarball:' + entry, text, needle);
      scanOrganization('tarball:' + entry, text);
      scanAuthoring('tarball:' + entry, text);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // --- verdict ---------------------------------------------------------------
  const checked = trackedTextCount + ' tracked text files and '
    + packedTextCount + ' packed text entries';
  if (failures.length) {
    for (const f of [...new Set(failures)].sort()) say('✖ ' + f);
    say('✖ publicity audit: ' + new Set(failures).size + ' finding(s) · checked ' + checked);
    process.exit(1);
  }
  say('✔ publicity audit: clean · checked ' + checked);
}
