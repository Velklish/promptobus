import { check } from './check.mjs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { copyNodeExecutable, makeSandbox, writeHostConfig } from './sandbox.mjs';
import { createStandaloneHost } from '../dist/host-index.js';
import { claudeDriver } from '../lib/driver-claude.js';
import { bus, createTask, participantRecord, upsertParticipant } from '../lib/store.js';

const root = realpathSync(makeSandbox('promptobus-driver-claude-'));
const home = path.join(root, '.promptobus'), nativeStore = path.join(root, 'native');
mkdirSync(nativeStore);
writeHostConfig(root, { tools: ['claude'] });
const host = createStandaloneHost({ cwd: root });
bus(home, { cli: host.version });
const nativeExecutable = path.join(root, 'owned-native-node');
copyNodeExecutable(nativeExecutable);
const originalSpawn = cp.spawnSync;
let nativeCalls = 0;
cp.spawnSync = function(file, argv, ...rest) {
  if (file === nativeExecutable && argv[0] === '--bg') {
    nativeCalls += 1;
    return { status: 1, stdout: '', stderr: 'owned fixture native launch reached' };
  }
  return originalSpawn.call(this, file, argv, ...rest);
};
syncBuiltinESMExports();
try {
  const cases = ['2.1.294', '2.0.0 (Claude Code)', undefined, '', 'Claude unknown', '2.1.295', '2.1.296 (Claude Code)']
    .map(version => [version, true]);
  cases.push(['2.1.294', false], [undefined, false]);
  for (const [index, [version, managed]] of cases.entries()) {
    const task = `hook-version-t20261109-00000${index}`, address = 'worker:version', ref = `version-${index}`;
    createTask(home, { id: task, title: 'Owned hook capability fixture' });
    upsertParticipant(home, task, participantRecord(address, { harness: 'claude', mode: 'managed', sessionRef: ref }));
    const plan = claudeDriver.prepare({ ref, role: 'worker', cwd: root, model: 'fixture', prompt: 'fixture',
      mcp: { home, task, address, servers: {} }, mcpConfigPath: path.join(root, `${index}.mcp.json`),
      settingsPath: path.join(root, `${index}.settings.json`), guardCommand: 'node owned-fixture guard' });
    let beforeStarts = 0, revokes = 0;
    if (managed) plan.service = { launchId: `owned-version-${index}`, credentialFile: path.join(root, `${index}.client.json`),
      beforeStart: async () => { beforeStarts += 1; }, realize: async () => {}, revoke: async () => { revokes += 1; } };
    plan.env = { PROMPTOBUS_SERVICE_HOME: root };
    claudeDriver.replaceMcpServers(plan, { promptobus: { type: 'http', url: 'http://127.0.0.1/owned-unused' } });
    for (const file of plan.files) {
      mkdirSync(path.dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.text, { mode: file.secret ? 0o600 : 0o644 });
    }
    const callsBefore = nativeCalls;
    let failure;
    try {
      await claudeDriver.spawn(plan, { tool: { ok: true, bin: nativeExecutable, version }, host, ref, role: 'worker', cwd: root,
        home, task, address, env: { ...process.env, CLAUDE_CONFIG_DIR: nativeStore }, persist() {} });
    } catch (error) { failure = error; }
    const supported = !managed || index >= 5;
    check(`${managed ? 'managed' : 'unmanaged'} Claude ${JSON.stringify(version)} ${supported ? 'reaches native launch' : 'refuses before native launch'}`,
      supported ? nativeCalls === callsBefore + 1 && beforeStarts === Number(managed) && /owned fixture native launch reached/.test(failure?.message)
        : nativeCalls === callsBefore && beforeStarts === 0 && revokes === 1 && /Claude Code >=2\.1\.295/.test(failure?.message),
      JSON.stringify({ nativeCalls: nativeCalls - callsBefore, beforeStarts, revokes, error: failure?.message }));
  }
} finally {
  cp.spawnSync = originalSpawn;
  syncBuiltinESMExports();
}
