#!/usr/bin/env node
// One-shot transfer helper. Not part of the published suite — deleted after the copy.
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEST = path.join(here, '..');
const SRC = '/Users/kim.p/AtiWorkspace/workspace/repos/agent-workspace/ati-agents';
const SRC_TEST = path.join(SRC, 'cli/test');
const SRC_SCRIPTS = path.join(SRC, 'cli/scripts');

const TEST_FILES = [
  'check.mjs', 'sandbox.mjs', 'hygiene.mjs', 'console.mjs',
  'sock-prefixes.mjs', 'tmpdir-sweep.mjs', 'run.mjs',
  'harness.mjs', 'harness-cursor.mjs', 'harness-codex.mjs',
  'participant.mjs', 'scenario.mjs',
  'runner.test.mjs', 'tmpdir-sweep.test.mjs',
];

const PROMPTOBUS_TESTS = readdirSync(SRC_TEST)
  .filter((n) => n.startsWith('promptobus-') && n.endsWith('.test.mjs'))
  .sort();

const LIVE_SCRIPTS = readdirSync(SRC_SCRIPTS)
  .filter((n) => n.startsWith('live-') && n.endsWith('.mjs'))
  .concat(['canary-runs.mjs']);

function remap(s, file) {
  s = s.replaceAll('../lib/promptobus/copy/util.js', '../lib/util.js');
  s = s.replaceAll('../lib/promptobus/copy/exec.js', '../lib/exec.js');
  s = s.replaceAll('../lib/promptobus/copy/fuzzy.js', '../lib/fuzzy.js');
  s = s.replaceAll("path.join(here, '..', 'lib', 'promptobus',", "path.join(here, '..', 'lib',");
  s = s.replaceAll('path.join(MECHANISM_ROOT, \'lib\', \'promptobus\',', 'path.join(MECHANISM_ROOT, \'lib\',');
  s = s.replaceAll('path.join(MECHANISM_ROOT, \'packages\', \'promptobus\', \'dist\'', 'path.join(MECHANISM_ROOT, \'dist\'');
  s = s.replaceAll("path.join(here, '..', 'packages', 'promptobus', 'dist'", "path.join(here, '..', 'dist'");
  s = s.replaceAll("path.join(here, '..', 'packages', 'promptobus', 'src'", "path.join(here, '..', 'src'");
  s = s.replaceAll("path.join(CLI, 'packages', 'promptobus'", 'path.join(REPO');
  s = s.replaceAll("'../packages/promptobus/dist/", "'../dist/");
  s = s.replaceAll("'../../packages/promptobus/dist/", "'../dist/");
  s = s.replaceAll('../lib/promptobus/', '../lib/');
  s = s.replaceAll('cli/lib/promptobus/', 'lib/');
  s = s.replaceAll("'bin', 'agents.js'", "'bin', 'promptobus.js'");
  s = s.replaceAll('"bin", "agents.js"', '"bin", "promptobus.js"');
  s = s.replaceAll("'agents.js'", "'promptobus.js'");
  s = s.replaceAll('"agents.js"', '"promptobus.js"');

  s = s.replaceAll("[AGENTS_BIN, 'promptobus',", '[AGENTS_BIN,');
  s = s.replaceAll("[BIN, 'promptobus',", '[BIN,');
  s = s.replaceAll("[CLI, 'promptobus',", '[CLI,');
  s = s.replaceAll("cli(['promptobus',", 'cli([');
  s = s.replaceAll("cliRun(['promptobus',", 'cliRun([');
  s = s.replaceAll("[BIN, 'promptobus', 'mcp']", "[BIN, 'mcp']");
  s = s.replaceAll("?? [BIN, 'promptobus', 'mcp']", "?? [BIN, 'mcp']");
  s = s.replaceAll("'promptobus.js'), 'promptobus',", "'promptobus.js'),");
  s = s.replaceAll('"promptobus.js"), "promptobus",', '"promptobus.js"),');
  s = s.replaceAll('promptobus.js" promptobus ', 'promptobus.js" ');
  s = s.replaceAll("promptobus.js' promptobus ", "promptobus.js' ");
  s = s.replaceAll('promptobus.js` promptobus ', 'promptobus.js` ');

  s = s.replaceAll('AGENTS_BIN', 'PROMPTOBUS_BIN');

  s = s.replaceAll('ati-agents', 'promptobus');
  s = s.replaceAll('@agent-workspace/promptobus', 'promptobus');
  s = s.replaceAll('@ati-agents/promptobus', 'promptobus');
  s = s.replaceAll('@agent-workspace/', '');

  s = s.replaceAll('ATI_COPY_GATE', 'PB_COPY_GATE');
  s = s.replaceAll("'ATI_AGENTS_ROOT'", "['ATI', 'AGENTS_ROOT'].join('_')");
  s = s.replaceAll('"ATI_AGENTS_ROOT"', "['ATI', 'AGENTS_ROOT'].join('_')");

  s = s.replaceAll('https://gitlab.ati.st/agent-workspace/ati-agents.git', 'https://example.invalid/promptobus.git');
  s = s.replaceAll('gitlab.ati.st', 'example.invalid');
  s = s.replaceAll('context-store', 'memory-hooks');

  s = s.replaceAll('.agents/tools.json', 'promptobus.json');
  s = s.replaceAll('.agents/a2a', 'legacy/a2a');
  s = s.replaceAll('.agents/manifest.json', 'promptobus.json');
  s = s.replaceAll('.agents/', 'legacy/');

  s = s.replace(/`BL-\d+`/g, '');
  s = s.replace(/\bBL-\d+\b/g, '');
  s = s.replace(/`ADR-\d+(?:[^\s`]*)?`/g, '');
  s = s.replace(/\bADR-\d+\b/g, '');
  s = s.replace(/ \((?:, )?\)/g, '');
  s = s.replace(/\(, /g, '(');
  s = s.replace(/, \)/g, ')');
  s = s.replace(/\]\([^)\n]*\/docs\/[^)\n]+\)/g, ']');

  if (file === 'run.mjs') {
    s = s.replace(
      /const RUN_TMP = mkdtempSync\(path\.join\(os\.tmpdir\(\), '[^']+'\)\);/,
      "const RUN_TMP = mkdtempSync(path.join(os.tmpdir(), 'promptobus-test-run-'));",
    );
  }

  if (file === 'tmpdir-sweep.test.mjs') {
    s = s.replace(
      /const SCAN = \[here, path\.join\(here, '\.\.', 'packages', 'promptobus', 'test'\)\];/,
      'const SCAN = [here];',
    );
  }

  if (file === 'scenario.mjs') {
    s = s.replace(
      "export const PROMPTOBUS_BIN = path.join(MECHANISM_ROOT, 'bin', 'promptobus.js');",
      "export const PROMPTOBUS_BIN = path.join(MECHANISM_ROOT, 'bin', 'promptobus.js');",
    );
  }

  if (file === 'sandbox.mjs') {
    s = s.replace(
      /import \{ resetVersionCache \} from '\.\.\/lib\/tools\.js';\n/,
      '',
    );
    s = s.replace(
      /import \{ resetAstGrepCache \} from '\.\.\/lib\/astgrep\.js';\n/,
      '',
    );
    s = s.replace(
      'export function resetCliCaches() {\n  resetVersionCache();\n  resetAstGrepCache();\n  resetBgSessionsCache();\n}',
      'export function resetCliCaches() {\n  resetBgSessionsCache();\n}',
    );
  }

  return s;
}

function write(rel, body) {
  const abs = path.join(DEST, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body.endsWith('\n') ? body : `${body}\n`);
}

function copyTransformed(from, toRel) {
  const raw = readFileSync(from, 'utf8');
  const name = path.basename(from);
  write(toRel, remap(raw, name));
}

mkdirSync(path.join(DEST, 'test'), { recursive: true });
mkdirSync(path.join(DEST, 'scripts'), { recursive: true });

for (const n of TEST_FILES) {
  copyTransformed(path.join(SRC_TEST, n), path.join('test', n));
}
for (const n of PROMPTOBUS_TESTS) {
  copyTransformed(path.join(SRC_TEST, n), path.join('test', n));
}
for (const n of LIVE_SCRIPTS) {
  copyTransformed(path.join(SRC_SCRIPTS, n), path.join('scripts', n));
}

cpSync(path.join(SRC_TEST, 'fixtures/promptobus'), path.join(DEST, 'test/fixtures/promptobus'), {
  recursive: true,
});
const manifest = path.join(DEST, 'test/fixtures/promptobus/MANIFEST.md');
writeFileSync(manifest, remap(readFileSync(manifest, 'utf8'), 'MANIFEST.md'));

console.log(`tests: ${PROMPTOBUS_TESTS.length}`);
console.log(`helpers: ${TEST_FILES.length}`);
console.log(`scripts: ${LIVE_SCRIPTS.length}`);
