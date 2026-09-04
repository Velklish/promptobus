import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';
import { helpText, runPromptobus } from '../lib/cli.js';

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
