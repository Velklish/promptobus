import './home.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createStandaloneHost } from '../dist/host-index.js';
import { install, uninstall } from '../lib/install.js';
import { makeSandbox } from './sandbox.mjs';

const sandbox = realpathSync(makeSandbox('pb-legacy-feedback-alias-'));
const nodeAlias = path.join(sandbox, `node-alias${path.extname(process.execPath)}`);
symlinkSync(process.execPath, nodeAlias, 'file');
const foreignExecutable = path.join(sandbox, 'foreign-executable');
writeFileSync(foreignExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.PATH = `${sandbox}${path.delimiter}${process.env.PATH ?? ''}`;
const matcher = 'mcp__promptobus__(promptobus_send|promptobus_mailbox)';
const specs = [
  { harness: 'claude', file: '.claude/settings.json', event: 'PostToolUse', stop: 'Stop', nested: true },
  { harness: 'cursor', file: '.cursor/hooks.json', event: 'postToolUse', stop: 'stop', nested: false },
  { harness: 'codex', file: '.codex/hooks.json', event: 'PostToolUse', stop: 'Stop', nested: true },
];

for (const spec of specs) {
  for (const action of ['install', 'uninstall', 'drop']) {
    test(`${spec.harness}: ${action} removes only the legacy runner through a root alias`, () => {
      const root = path.join(sandbox, `${spec.harness}-${action}`), alias = `${root}-alias`;
      mkdirSync(root);
      symlinkSync(root, alias, 'dir');
      const host = createStandaloneHost({ cwd: root, nodePath: action === 'uninstall' ? path.basename(nodeAlias) : process.execPath });
      const runner = path.join(alias, host.busHookRel());
      const foreignRoot = path.join(sandbox, 'foreign');
      mkdirSync(foreignRoot, { recursive: true });
      const command = `"${process.execPath}" "${runner}"`;
      const group = (value) => spec.nested
        ? { matcher, hooks: [{ type: 'command', command: value }] }
        : { command: value, matcher };
      const foreign = [
        group(`"${foreignExecutable}" "${runner}"`),
        group(`echo "${runner}"`),
        group(`${command} --extra`),
        group(`${command} && echo foreign`),
        group(`"${process.execPath}" "${runner}.backup"`),
        group(`"${process.execPath}" "${path.join(foreignRoot, host.busHookRel())}"`),
      ];
      if (spec.nested) foreign.push({ matcher, hooks: [
        { type: 'command', command }, { type: 'command', command: 'echo foreign-handler' },
      ] });
      const foreignStop = spec.nested
        ? { hooks: [{ type: 'command', command: 'echo foreign-stop' }], keep: 'unchanged' }
        : { command: 'echo foreign-stop', keep: 'unchanged' };
      const file = path.join(root, spec.file);
      mkdirSync(path.dirname(file), { recursive: true });
      mkdirSync(path.dirname(runner), { recursive: true });
      writeFileSync(runner, 'export {};\n');
      writeFileSync(path.join(root, 'promptobus.json'), JSON.stringify({
        tools: ['claude', 'cursor', 'codex'], harnesses: [spec.harness],
      }));
      writeFileSync(file, JSON.stringify({ ...(spec.nested ? {} : { version: 1 }), keep: 'foreign-setting',
        hooks: { [spec.event]: [group(command), group(`"${nodeAlias}" "${runner}"`),
          group(`"${path.basename(nodeAlias)}" "${runner}"`), ...foreign], [spec.stop]: [foreignStop] } }));

      const options = { harnesses: spec.harness, cwd: root };
      if (action === 'install') assert.equal(install(host, options), 0);
      else if (action === 'uninstall') assert.equal(uninstall(host, options), 0);
      else assert.equal(install(host, { ...options, harnesses: spec.harness === 'claude' ? 'codex' : 'claude' }), 0);

      const after = JSON.parse(readFileSync(file, 'utf8'));
      assert.ok(after.hooks[spec.event].some((record) => JSON.stringify(record) === JSON.stringify(foreign[0])),
        'the quoted absolute foreign executable remains');
      assert.equal(JSON.stringify(after.hooks[spec.event]), JSON.stringify(foreign));
      assert.equal(JSON.stringify(after.hooks[spec.stop][0]), JSON.stringify(foreignStop));
      assert.equal(after.keep, 'foreign-setting');
      assert.equal(existsSync(runner), false);
      assert.equal(after.hooks[spec.stop].length, action === 'install' ? 2 : 1);
    });
  }
}
