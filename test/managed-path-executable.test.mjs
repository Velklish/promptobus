import { check, skip } from './check.mjs';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createStandaloneHost } from '../dist/host-index.js';
import { claudeDriver } from '../lib/driver-claude.js';
import { opencodeDriver } from '../lib/driver-opencode.js';
import { createTask, participantRecord, participantSessionPath, upsertParticipant } from '../lib/store.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

if (process.platform === 'win32') {
  skip('default host managed executable PATH capture', 'This regression exercises POSIX PATH lookup; Windows resolution has its own fixtures');
} else {
  const root = realpathSync(makeSandbox('pb-managed-path-')), bin = path.join(root, 'bin');
  const nativeStore = path.join(root, 'native-store'), dataHome = path.join(root, 'native-data');
  for (const directory of [bin, nativeStore, dataHome]) mkdirSync(directory);
  writeHostConfig(root, { tools: ['claude', 'opencode'] });
  const host = createStandaloneHost({ cwd: root }), home = host.promptobusHome(), task = 'path-t20261101-000000';
  createTask(home, { id: task, title: 'default Host bare executable capture' });
  for (const driver of [claudeDriver, opencodeDriver]) {
    const name = driver.id, ref = `path-${name}`, address = `worker:${name}`, launchId = `${ref}-launch`;
    symlinkSync(process.execPath, path.join(bin, name));
    // A cwd entry is deliberately not the executable selected by the child's PATH.
    writeFileSync(path.join(root, name), '#!/bin/sh\nexit 94\n', { mode: 0o700 });
    const env = { ...process.env, PATH: bin, CLAUDE_CONFIG_DIR: nativeStore, XDG_DATA_HOME: dataHome,
      OPENCODE_DB: path.join(dataHome, 'owned.db'), PROMPTOBUS_OPENCODE_HOME: path.join(root, 'opencode-registry') };
    const tool = host.resolveToolBin(name), file = participantSessionPath(home, task, address);
    upsertParticipant(home, task, participantRecord(address, { harness: name, mode: 'managed', sessionRef: ref, sessionRecord: file }));
    const original = new Error(`${name} reached its captured-image prelaunch seam`);
    let staged, revokes = 0, revoked = false, failure;
    const plan = { argv: name === 'claude' ? ['--bg', 'fixture prompt'] : ['serve', '--port', '0', '--hostname', '127.0.0.1'],
      files: [], cwd: root, env, prompt: 'fixture', holder: { password: 'fixture' },
      prelaunchBinding: { sessionRecord: file }, service: { launchId,
        beforeStart: async record => { staged = JSON.parse(readFileSync(record, 'utf8')); throw original; },
        realize: async () => { throw new Error('prelaunch refusal must not realize'); },
        revoke: async () => { if (!revoked) { revoked = true; revokes += 1; } } } };
    try { await driver.spawn(plan, { tool, host, home, task, address, ref, role: 'worker', cwd: root, env, persist: () => {} }); }
    catch (error) { failure = error; }
    check(`default Host bare ${name} resolves the actual child PATH before native creation`, tool.bin === name
      && failure === original && revokes === 1 && staged?.nativeCommand.executable.file === realpathSync(process.execPath)
      && staged.nativeCommand.executable.file !== path.join(root, name), failure?.stack);
    const missing = { ...env, PATH: path.join(root, 'absent-path') };
    let reached = false;
    plan.env = missing;
    plan.service.beforeStart = async () => { reached = true; };
    try { await driver.spawn(plan, { tool, host, home, task, address, ref, role: 'worker', cwd: root, env: missing, persist: () => {} }); }
    catch { /* Missing PATH must refuse before the creation seam. */ }
    check(`missing ${name} PATH entry cannot fall back to the executable in cwd`, !reached);
  }
}
