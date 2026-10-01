import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { installHarness } from './harness-codex.mjs';
import { hostOf } from '../lib/host.js';
import { planLead } from '../lib/lead.js';
import { codexDriver } from '../lib/driver-codex.js';
import { pidAlive, readSession, reapHolder, writeSession } from '../lib/codex-session.js';

const root = makeSandbox('promptobus-lead-rollback-');
writeHostConfig(root, { tools: ['codex'] });
const harness = await installHarness({ binDir: path.join(root, 'bin') });
const ownerHome = path.join(root, 'owner');
mkdirSync(ownerHome);
writeFileSync(path.join(ownerHome, 'auth.json'), '{"stub":"credentials"}');
const env = { ...process.env, CODEX_HOME: ownerHome, PROMPTOBUS_CODEX_OWNER_HOME: ownerHome, PROMPTOBUS_WARDEN: 'off' };
const host = hostOf(root);
const brief = path.join(root, 'brief.md');
writeFileSync(brief, '# Protected launch\nPreserve another launch on rollback.\n');
const plan = await planLead(host, { brief, task: 'lead-rollback-t20261001-000001' });
let replacement, refused = '';
try {
  await codexDriver.spawn(plan.launch, { tool: { ok: true, bin: 'codex', version: '0.159.2' },
    host, home: host.promptobusHome(), task: plan.task, address: 'orchestrator', cwd: root,
    env, ref: plan.name, role: 'orchestrator', persist: () => {
      replacement = { ...readSession(plan.name, env), launchId: 'replacement-launch', prompt: 'Different authorized assignment' };
      writeSession(replacement, env);
      throw new Error('controlled binding failure');
    },
  });
} catch (error) { refused = error.message; }
const retained = readSession(plan.name, env);
check('failed original binding cannot remove or restore a replacement launch record',
  refused === 'controlled binding failure' && retained?.launchId === replacement.launchId
  && retained.prompt === replacement.prompt && existsSync(replacement.codexHome)
  && pidAlive(replacement.holderPid) && pidAlive(replacement.appPid), refused);
check('replacement launch credentials remain intact after another launch rollback',
  readFileSync(path.join(replacement.codexHome, 'auth.json'), 'utf8') === '{"stub":"credentials"}');
await reapHolder(plan.name, env);
await codexDriver.stop(plan.name);
harness.restore();
