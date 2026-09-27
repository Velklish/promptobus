import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from './check.mjs';
import {
  CODEX_TEAMLEAD_ROOT_SERVER, codexDriver, codexHomeConfig,
  installPrivateHomeLayer, makeParticipantHome,
} from '../lib/driver-codex.js';
import { threadStartConfig } from '../lib/codex-session.js';
import { resolveSessionIdentity } from '../lib/drivers.js';
import * as store from '../lib/store.js';

const scratch = mkdtempSync(path.join(os.tmpdir(), 'promptobus-test-teamlead-'));
const root = path.join(scratch, 'install');
const workerCwd = path.join(scratch, 'worker');
const home = path.join(scratch, 'bus');
const ownerHome = path.join(scratch, 'owner-codex');
mkdirSync(path.join(root, '.codex', 'skills', 'root-proof'), { recursive: true });
mkdirSync(workerCwd, { recursive: true });
mkdirSync(ownerHome, { recursive: true });
writeFileSync(path.join(ownerHome, 'auth.json'), '{"test":true}\n');
writeFileSync(path.join(root, '.codex', 'skills', 'root-proof', 'SKILL.md'), '# Root proof\n');
writeFileSync(path.join(root, '.codex', 'hooks.json'), '{"hooks":{"Stop":[]}}\n');
writeFileSync(path.join(root, 'AGENTS.md'), '# Root rules\n');
const projectSnapshot = () => {
  const rows = [];
  const walk = (dir, rel = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const sub = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), sub);
      else if (entry.isFile()) rows.push(`${sub}\0${createHash('sha256').update(readFileSync(path.join(dir, entry.name))).digest('hex')}`);
    }
  };
  walk(root);
  return rows.sort().join('\n');
};
const before = projectSnapshot();
const task = 'root-t20260927-010000';
const childTask = 'child-t20260927-010001';
const rootAddress = 'teamlead:codex-proof';
const mcp = { servers: { promptobus: {
  command: 'node', args: ['mcp'],
  env: { PROMPTOBUS_TASK: childTask, PROMPTOBUS_ROOT_TASK: task, PROMPTOBUS_ROLE: 'orchestrator' },
} } };
const prior = process.env.PROMPTOBUS_CODEX_HOME;
process.env.PROMPTOBUS_CODEX_HOME = path.join(scratch, 'state');
try {
  const ctx = { mcp, prompt: 'Proof', model: 'gpt-5.6-sol', effort: 'medium',
    root, task: childTask, guardCommand: 'guard', env: process.env };
  const planned = codexDriver.prepare({ ...ctx, ref: 'teamlead-proof', role: 'teamlead',
    cwd: root, address: 'orchestrator', rootTask: task, rootAddress });
  const fullAccess = codexDriver.prepare({ ...ctx, ref: 'teamlead-full', role: 'teamlead',
    cwd: root, address: 'orchestrator', rootTask: task, rootAddress,
    permissionMode: 'full-access' });
  const worker = codexDriver.prepare({ ...ctx, ref: 'worker-proof', role: 'worker',
    cwd: workerCwd, address: 'worker:proof' });
  check('only a Codex teamlead thread disables hooks above project config',
    threadStartConfig({ role: 'teamlead', effort: 'medium' })['features.hooks'] === false
    && threadStartConfig({ role: 'teamlead', effort: 'medium' }).model_reasoning_effort === 'medium'
    && !Object.hasOwn(threadStartConfig({ role: 'worker', effort: 'medium' }), 'features.hooks')
    && !Object.hasOwn(threadStartConfig({ role: 'reviewer' }), 'features.hooks'));
  check('dormant Codex teamlead path has its own sandbox choices',
    planned.settings.sandbox === 'workspace-write'
    && fullAccess.settings.sandbox === 'danger-full-access');
  check('Codex teamlead preparation writes no project files at the install root',
    planned.cwd === root && planned.files.length === 0 && planned.trustProject === false
    && planned.privateHomeSkills === path.join(root, '.codex', 'skills')
    && !planned.prelaunchBinding.sessionRecord
    && planned.sessionRecord && planned.rootSessionRecord);
  check('Codex worker preparation retains project hooks and its prelaunch binding',
    worker.trustProject === true && worker.files.some((file) => file.path.endsWith('.codex/hooks.json'))
    && Boolean(worker.prelaunchBinding.sessionRecord)
    && !worker.mcpConfig.mcpServers[CODEX_TEAMLEAD_ROOT_SERVER]
    && worker.rootSessionRecord === null);
  check('Codex teamlead child bus entry keeps the child task',
    planned.mcpConfig.mcpServers.promptobus.env.PROMPTOBUS_TASK === childTask
    && planned.mcpConfig.mcpServers.promptobus.env.PROMPTOBUS_ROOT_TASK === task);
  const rootBus = planned.mcpConfig.mcpServers[CODEX_TEAMLEAD_ROOT_SERVER];
  check('Codex teamlead root bus entry names its own mailbox and pointer',
    rootBus.env.PROMPTOBUS_TASK === task
    && rootBus.env.PROMPTOBUS_ROLE === rootAddress
    && rootBus.env.PROMPTOBUS_CODEX_SESSION === planned.rootSessionRecord);
  const codexHome = planned.codexHome;
  makeParticipantHome({ dir: codexHome, ownerHome,
    config: codexHomeConfig({ trusted: [], hooksEnabled: false }) });
  installPrivateHomeLayer(planned, codexHome);
  const privateConfig = readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  check('Codex teamlead private home disables hooks and receives root skills',
    !existsSync(path.join(codexHome, 'hooks.json'))
    && existsSync(path.join(codexHome, 'skills', 'root-proof', 'SKILL.md'))
    && privateConfig.includes('hooks = false')
    && !privateConfig.includes('[projects.'));
  check('Codex worker private home config keeps hooks eligible',
    !codexHomeConfig().includes('hooks = false'));
  store.bus(home, { cli: 'test' });
  store.createTask(home, { id: task, title: 'Root', owner: 'root-session' });
  store.upsertParticipant(home, task, store.participantRecord(rootAddress, {
    childTask, harness: 'codex', sessionId: 'thread-proof',
  }));
  writeFileSync(planned.rootSessionRecord, JSON.stringify({
    home, task, address: rootAddress, threadId: 'thread-proof',
  }));
  check('Codex root mailbox entry resolves the bound teamlead session',
    resolveSessionIdentity(rootBus.env, { home, task, address: rootAddress }).id === 'thread-proof');
  check('Codex teamlead private layer leaves install root bytes identical',
    projectSnapshot() === before, projectSnapshot());
} finally {
  if (prior === undefined) delete process.env.PROMPTOBUS_CODEX_HOME;
  else process.env.PROMPTOBUS_CODEX_HOME = prior;
}
