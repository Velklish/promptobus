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

const TEXT = /\.(m?js|ts|json|md|ya?ml|txt|mjs)$/;
const RUNTIME_PATH = /^(?:bin|lib|src|schemas|templates|dist)\//;
const BRAND_FRAGMENT = ['A', 'TI'].join('');
const BRAND_WORD = new RegExp(`\\b${BRAND_FRAGMENT}\\b`, 'iu');
const BRAND_CAMEL = new RegExp(`\\b${BRAND_FRAGMENT.toLowerCase()}(?=\\p{Lu})`, 'u');
const BRAND_ID = new RegExp(`\\b${BRAND_FRAGMENT.toLowerCase()}-workspace-[0-9a-f]+\\b`, 'iu');
const HOME_ROOT = ['(?:^|[^\\w])/', '(?:Users|home)', '/'].join('');
const HOME_USER = `[^/\\s"'<>]*[A-Za-z0-9][^/\\s"'<>]*`;
const ABSOLUTE_HOME_PATH = new RegExp(
  `${HOME_ROOT}${HOME_USER}(?:/[^\\s"'<>]+)?`,
  'u',
);

const normalizedName = (name) => name.replace(/^(?:tarball:)?package\//, '');
const ABSOLUTE_HOME_PATH_EXEMPTIONS = new Map([
  ['test/model-routing-adapter-claude.test.mjs', 'synthetic home passed to credentialFile'],
  ['test/model-routing-preflight.test.mjs', 'synthetic path in a driver error fixture'],
  ['test/runner.test.mjs', 'synthetic executable path in the trace fixture'],
  ['test/session-env.test.mjs', 'synthetic parent HOME values for environment filtering'],
]);
const absoluteOwnerHomePath = (name, text) => {
  const normalized = normalizedName(name);
  if (ABSOLUTE_HOME_PATH_EXEMPTIONS.has(normalized)) return false;
  return ABSOLUTE_HOME_PATH.test(text);
};
export { absoluteOwnerHomePath };

const FORBIDDEN = [
  ['host of the origin forge', ['gitlab', '.ati', '.st'].join('')],
  ['origin CLI name', ['ati', '-agents'].join('')],
  ['origin package scopes', ['@agent', '-workspace'].join('')],
  ['origin package scopes', ['@ati', '-agents'].join('')],
  ['origin environment prefix', ['ATI', '_'].join('')],
  ['origin memory service', ['context', '-store'].join('')],
  ['origin tracker ids', new RegExp(['BL', '-[0-9]'].join(''))],
  ['absolute owner home path', absoluteOwnerHomePath],
  ['origin brand', (name, text) => {
    const normalized = normalizedName(name);
    const runtime = RUNTIME_PATH.test(normalized);
    const evidenceCard = name.startsWith('docs/archive/') || name.startsWith('docs/backlog/');
    return (runtime && (BRAND_WORD.test(text) || BRAND_CAMEL.test(text)))
      || (!evidenceCard && BRAND_ID.test(text));
  }],
];
const CYRILLIC = /[\u0400-\u04FF]/u;
const CYRILLIC_ALLOWLIST = [
  ['src/protocol.ts', /const TRANSLIT(?:\s*:\s*Record<string, string>)?\s*=\s*\{[\s\S]*?\n\};/u], // transliteration table
];
const GENERATED_FROM = new Map([
  ['dist/protocol.js', 'src/protocol.ts'],
]);
const failures = [];

function scan(label, name, text, needle) {
  const hit = typeof needle === 'function'
    ? needle(name, text)
    : needle instanceof RegExp ? needle.test(text) : text.includes(needle);
  if (hit) failures.push(`${label}: ${name}`);
}

function scanCyrillic(name, text) {
  const normalized = normalizedName(name);
  if (!RUNTIME_PATH.test(normalized)) return;
  const source = GENERATED_FROM.get(normalized) ?? normalized;
  const exemption = CYRILLIC_ALLOWLIST.find(([file]) => file === source);
  const remaining = exemption ? text.replace(exemption[1], '') : text;
  if (CYRILLIC.test(remaining)) failures.push(`Cyrillic runtime text: ${name}`);
}

if (IS_MAIN) {
// --- surface 1: what git tracks -------------------------------------------
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);

  for (const rel of tracked) {
    if (!TEXT.test(rel)) continue;
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    for (const [label, needle] of FORBIDDEN) scan(label, rel, text, needle);
    scanCyrillic(rel, text);
  }

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
    if (!/\.(md|m?js|ts)$/.test(rel)) continue;
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
      if (entry.endsWith('/') || !TEXT.test(entry)) continue;
      const abs = path.join(tmp, entry);
      if (!existsSync(abs)) continue;
      const text = readFileSync(abs, 'utf8');
      for (const [label, needle] of FORBIDDEN) scan(label, `tarball:${entry}`, text, needle);
      scanCyrillic(entry, text);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // --- verdict ---------------------------------------------------------------
  if (failures.length) {
    for (const f of [...new Set(failures)].sort()) say(`✖ ${f}`);
    say(`✖ publicity audit: ${new Set(failures).size} finding(s)`);
    process.exit(1);
  }
  say(`✔ publicity audit: clean · ${tracked.length} tracked files and the packed tarball`);

}
