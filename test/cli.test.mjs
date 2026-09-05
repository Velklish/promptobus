// Home diversion before any import that is not a Node built-in: a module that
// resolved a home path at load would see the real one. [home.mjs](home.mjs) says
// what it applies; the sentinel in tmpdir-sweep.test.mjs keeps the order.
import './home.mjs';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { helpText, runPromptobus } from '../lib/cli.js';

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

/**
 * Commands the dispatcher answers. `lib/cli.js` is the truth and the only one: a list
 * written down anywhere else is a copy that drifts, and this gate exists because a copy
 * drifted.
 */
function subcommands() {
  const cli = readFileSync(path.join(LIB, 'cli.js'), 'utf8');
  return new Set([...cli.matchAll(/^\s*case '([^']+)':/gm)].map((m) => m[1]));
}

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
