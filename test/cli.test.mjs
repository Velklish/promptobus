// Home diversion before any import that is not a Node built-in: a module that
// resolved a home path at load would see the real one. [home.mjs](home.mjs) says
// what it applies; the sentinel in tmpdir-sweep.test.mjs keeps the order.
import './home.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { GateError as ProtocolGateError, PromptobusError } from '../dist/index.js';
import { HostResolveError } from '../dist/host.js';
import { helpText, runPromptobus } from '../lib/cli.js';
import { expectFail } from './console.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(here, '..', 'lib');

function jsFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) jsFiles(abs, out);
    else if (e.name.endsWith('.js')) out.push(abs);
  }
  return out;
}

function collect() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

function fakeHost(commandName, version = '0.0.0') {
  return {
    kind: 'promptobus-host',
    commandName,
    version,
  };
}

function cliHost(root, workspaceRoot) {
  return {
    ...fakeHost('promptobus'),
    workspaceRoot,
    promptobusHome: () => path.join(root, '.promptobus'),
  };
}

test('runPromptobus accepts two different hosts in one process', async () => {
  const a = collect();
  const b = collect();
  const hostA = fakeHost('alpha', '1.2.3');
  const hostB = fakeHost('beta', '9.9.9');

  const codeA = await runPromptobus(['--help'], {
    host: hostA, cwd: '.', env: {}, input: null, output: a.stream,
  });
  const codeB = await runPromptobus(['--version'], {
    host: hostB, cwd: '.', env: {}, input: null, output: b.stream,
  });

  assert.equal(codeA, 0);
  assert.equal(codeB, 0);
  assert.match(a.text(), /Usage: alpha /);
  assert.doesNotMatch(a.text(), /Usage: beta /);
  assert.equal(b.text().trim(), 'beta 9.9.9');
  assert.doesNotMatch(b.text(), /alpha/);
});

test('helpText takes the command name from the host, not a literal', () => {
  const text = helpText(fakeHost('gamma'));
  assert.match(text, /Usage: gamma /);
  assert.match(text, /gamma spawn /);
  const banned = ['ati', 'agents'].join('-');
  assert.equal(text.includes(banned), false);
});

test('CLI recognizes expected errors by class, not constructor name', async () => {
  const expectedErrors = [
    new ProtocolGateError('gate refusal'),
    new PromptobusError('strategy-unknown', 'routing refusal'),
    new HostResolveError('host resolution refusal'),
  ];

  for (const error of expectedErrors) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'promptobus-test-run-'));
    try {
      const host = cliHost(root, () => { throw error; });
      const result = await expectFail(() => runPromptobus(['spawn'], {
        host, cwd: root, env: {}, input: null, output: collect().stream,
      }));
      assert.equal(result.failed, true);
      assert.equal(result.out, `✖ ${error.message}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  class GateError extends Error {}
  const root = mkdtempSync(path.join(os.tmpdir(), 'promptobus-test-run-'));
  try {
    const host = cliHost(root, () => { throw new GateError('name collision'); });
    const result = await expectFail(() => runPromptobus(['spawn'], {
      host, cwd: root, env: {}, input: null, output: collect().stream,
    }));
    assert.equal(result.failed, true);
    assert.match(result.out, /Error: name collision/);
    assert.match(result.out, /at runPromptobus \(.*lib\/cli\.js:/);
    assert.match(result.out, /✖ name collision\n$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Commands the dispatcher answers. `lib/cli.js` is the truth and the only one: a list
 * written down anywhere else is a copy that drifts, and this gate exists because a copy
 * drifted.
 */
function subcommands() {
  const cli = readFileSync(path.join(LIB, 'cli.js'), 'utf8');
  return new Set([...cli.matchAll(/^\s*case '([^']+)':/gm)].map((m) => m[1]));
}

function optionNames(command) {
  const cli = readFileSync(path.join(LIB, 'cli.js'), 'utf8');
  const start = cli.indexOf(`case '${command}':`);
  assert.notEqual(start, -1, `dispatcher case for ${command} was not found`);
  const end = cli.indexOf('\n      case ', start + 1);
  const body = cli.slice(start, end === -1 ? cli.length : end);
  const options = body.indexOf('options: {');
  assert.notEqual(options, -1, `${command} has no parseArgs options object`);
  const open = body.indexOf('{', options);
  let depth = 0;
  let close = -1;
  for (let i = open; i < body.length; i += 1) {
    const char = body[i];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  assert.notEqual(close, -1, `${command} options object is not closed`);
  const object = body.slice(open + 1, close);
  return new Set([...object.matchAll(/(?:'([^']+)'|([A-Za-z][\w-]*))\s*:/g)]
    .filter((match) => {
      const before = object.slice(0, match.index);
      return (before.match(/{/g)?.length ?? 0) === (before.match(/}/g)?.length ?? 0);
    })
    .map((match) => match[1] ?? match[2]));
}

function skillSynopsisFlags() {
  const skills = path.join(LIB, '..', 'skills');
  const flags = new Map();
  for (const entry of readdirSync(skills, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(skills, entry.name, 'SKILL.md');
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const block of text.matchAll(/```bash\s*\n([\s\S]*?)```/g)) {
      for (const line of block[1].split('\n')) {
        const command = line.match(/^\s*promptobus\s+(\w+)/)?.[1];
        if (!command) continue;
        const commandFlags = flags.get(command) ?? new Set();
        for (const flag of line.matchAll(/--[a-z][a-z-]*/g)) commandFlags.add(flag[0].slice(2));
        flags.set(command, commandFlags);
      }
    }
  }
  return flags;
}

test('skill CLI synopses stay aligned with parseArgs options', () => {
  const documented = skillSynopsisFlags();
  const mismatches = [];
  for (const command of ['spawn', 'done', 'review']) {
    const cli = optionNames(command);
    const skill = documented.get(command) ?? new Set();
    const missing = [...cli].filter((flag) => !skill.has(flag)).sort();
    const extra = [...skill].filter((flag) => !cli.has(flag)).sort();
    if (missing.length || extra.length) mismatches.push({ command, missing, extra });
  }
  assert.deepEqual(mismatches, []);
});

/**
 * Commands the CONSUMER CLI owns, which the package prints through the host without
 * having them itself. The list is one entry long and each entry names the task that
 * will decide it — an exemption with nowhere to lead is a hole shaped exactly like the
 * thing being looked for.
 */

test('no message names a command the CLI does not have', () => {
  // `promptobus tools add <harness>` was printed at the one moment an operator most
  // needs a true instruction — an undeclared harness — and there is no `tools`
  // subcommand at all. The message looked helpful and complete, which is why nobody
  // caught it until someone tried to document the command (PB-1).
  //
  // The subject is the FIRST element of the argument list: `busCommand(['done', …])`
  // names `done`, and everything after it is that command's flags.
  const known = subcommands();
  const HEAD = /\b(?:busCommand|formatCommand|formatNpx)\(\s*\[\s*'([^']+)'/g;
  const stray = [];
  // Recursive: `lib/model-routing/` is a whole subsystem, and a gate that read only the
  // top level would be green about the half of the runtime it never opened.
  for (const file of jsFiles(LIB)) {
    for (const m of readFileSync(file, 'utf8').matchAll(HEAD)) {
      if (!known.has(m[1])) {
        stray.push(`${path.relative(path.join(LIB, '..'), file)}: ${m[1]}`);
      }
    }
  }
  assert.deepEqual(stray, []);
});

test('the gate above reads a command list that is not empty and holds the real commands', () => {
  // Without this the gate is green on a `lib/cli.js` whose shape changed under it: an
  // empty `known` set would report every call site, and a `known` set that swallowed
  // the whole file would report none. Both are the same failure — the gate stopped
  // reading the dispatcher — and only the second is silent.
  const known = subcommands();
  for (const cmd of ['spawn', 'review', 'status', 'done', 'mcp', 'install']) {
    assert.ok(known.has(cmd), `dispatcher case for ${cmd} was not found`);
  }
  assert.equal(known.has('tools'), false);
  assert.equal(known.has('clone'), false);
  // …and the walk itself: an empty file list reports no stray command for the same
  // reason an empty command list reports every one of them.
  const walked = jsFiles(LIB).map((f) => path.relative(LIB, f));
  assert.ok(walked.includes('cli.js'), walked.join(', '));
  assert.ok(walked.some((f) => f.includes(path.sep)), `no subdirectory was walked: ${walked.join(', ')}`);
});
