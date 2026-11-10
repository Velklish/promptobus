import './home.mjs';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { check } from './check.mjs';
import { buildWorkspace } from './scenario.mjs';
import { quiet } from './console.mjs';
import { ownedServiceFixture, stubCommand } from './sandbox.mjs';
import { TMUX_VERSION } from './harness-cursor.mjs';
import { hostOf } from '../lib/host.js';
import { REGISTRY } from '../lib/drivers.js';
import { spawn, spawnTeamlead } from '../lib/spawn.js';
import { planReview, review } from '../lib/review.js';
import { models } from '../lib/models.js';
import { reservationFile } from '../lib/live-reservation.js';
import * as store from '../lib/store.js';

ownedServiceFixture();
const root = fs.mkdtempSync(path.join(tmpdir(), 'promptobus-routing-live-cap-entrypoints-'));
const { ws, repoAbs } = buildWorkspace(root, { tools: ['claude', 'cursor', 'codex', 'opencode'] });
fs.appendFileSync(path.join(repoAbs, 'AGENTS.md'), '\nSynthetic tracked review subject.\n');
for (const args of [['add', 'AGENTS.md'], ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'synthetic review subject']]) {
  const result = spawnSync('git', ['-C', repoAbs, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`synthetic git ${args[0]} failed: ${result.stderr}`);
}
const host = hostOf(ws), home = host.promptobusHome();
const brief = path.join(root, 'brief.md');
fs.writeFileSync(brief, '# Synthetic launch boundary\n');
process.env.CLAUDE_CODE_SESSION_ID = 'synthetic-owner';
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
const syntheticTools = path.join(homedir(), '.local', 'bin');
stubCommand(syntheticTools, 'tmux', `if (process.argv[2] !== '-V') process.exit(1); console.log(${JSON.stringify(TMUX_VERSION)});`);
let serial = 0;
try {
  for (const harness of ['claude', 'cursor', 'codex', 'opencode']) {
    const driver = REGISTRY.drivers[harness], original = driver.spawn;
    const version = harness === 'claude' ? '2.1.300' : harness === 'cursor' ? '2026.09.02' : '1.0.0';
    stubCommand(syntheticTools, harness, `if (process.argv[2] !== '--version') process.exit(1); console.log(${JSON.stringify(version)});`);
    const tool = { ok: true, bin: path.join(syntheticTools, harness), version };
    let calls = 0;
    driver.spawn = async () => { calls++; throw new Error('synthetic native boundary was crossed'); };
    try {
      const overlay = path.join(root, 'overlay.json');
      fs.writeFileSync(overlay, JSON.stringify({ schemaVersion: 2, caps: { liveParticipants: { [harness]: 0 } } }));
      host.routingPaths = () => ({ overlays: [{ id: 'owned', path: overlay, writable: true }], cacheFile: path.join(root, 'cache.json') });
      for (const role of ['worker', 'reviewer', ...(harness === 'cursor' ? [] : ['teamlead'])]) {
        const task = `boundary-t20261110-${String(++serial).padStart(6, '0')}`;
        store.createTask(home, { id: task, title: 'Synthetic boundary', owner: 'synthetic-owner' });
        const options = { task, harness, tool, ...(role === 'worker'
          ? { brief, worker: `${role}-${serial}`, repo: repoAbs, title: 'Synthetic work' }
          : role === 'reviewer' ? { target: repoAbs, title: 'Synthetic work' }
            : { brief, slug: `${role}-${serial}` }) };
        const lift = () => role === 'worker' ? spawn(host, options)
          : role === 'reviewer' ? review(host, options) : spawnTeamlead(host, options);
        if (role === 'reviewer') check(`${harness} reviewer subject contains the committed fixture diff`,
          !!planReview(host, options).diff.trim());
        let refusal = '';
        await quiet(async () => { try { await lift(); } catch (error) { refusal = error.message; } });
        check(`${harness} ${role} actual entrypoint refuses cap zero before its driver`,
          calls === 0 && refusal.includes(`caps.liveParticipants.${harness}=0`) && refusal.includes(overlay), refusal);
      }
      const task = `preview-t20261110-${String(++serial).padStart(6, '0')}`;
      store.createTask(home, { id: task, title: 'Synthetic preview', owner: 'synthetic-owner' });
      await quiet(() => spawn(host, { task, harness, brief, repo: repoAbs, worker: 'preview', dryRun: true }));
      await quiet(() => review(host, { task, harness, target: repoAbs, title: 'Synthetic preview', dryRun: true }));
      await quiet(() => models(host, { strategy: 'balance', noProbe: true, output: { write: () => {} } }));
      check(`${harness} models and worker reviewer dry runs create no reservation`,
        !fs.existsSync(reservationFile(home, task)) && calls === 0);
    } finally { driver.spawn = original; }
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
