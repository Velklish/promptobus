import './home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { markLimitAtStart } from '../lib/driver-claude.js';
import { liftoffParticipant } from '../lib/liftoff.js';
import { readSnapshot } from '../lib/model-routing/cache.js';
import { loadCatalog } from '../lib/model-routing/catalog.js';
import { readTelemetry, telemetryFileOf } from '../lib/model-routing/telemetry.js';
import { preflight } from '../lib/model-routing/preflight.js';
import * as store from '../lib/store.js';
import { liveRoutingEnv } from '../scripts/live-entry.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

const bin = fileURLToPath(new URL('../bin/promptobus.js', import.meta.url));

async function exercise(t, isolated) {
  const root = makeSandbox('promptobus-telemetry-');
  const userHome = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const routingStateDir = path.join(root, 'model-routing');
  const userRouting = path.join(userHome, '.promptobus', 'model-routing');
  const userOverlay = path.join(userHome, '.promptobus', 'model-routing.json');
  mkdirSync(path.dirname(userOverlay), { recursive: true });
  mkdirSync(workspace);
  writeHostConfig(workspace);
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  process.env.HOME = process.env.USERPROFILE = userHome;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
  });

  const options = { cwd: workspace };
  const base = createStandaloneHost(options);
  const host = isolated ? createStandaloneHost({ ...options, routingStateDir }) : base;
  const stateDir = isolated ? routingStateDir : userRouting;
  const home = host.promptobusHome();
  assert.deepEqual(host.routingPaths().overlays, [
    { id: 'user', path: userOverlay },
    { id: 'workspace', path: path.join(home, 'model-routing.json'), writable: true },
  ]);
  assert.equal(host.harnessStateHome('claude'), path.join(userHome, '.promptobus', 'claude'));

  const overlay = (strategy) => `${JSON.stringify({ schemaVersion: 1, defaults: { strategy } })}\n`;
  writeFileSync(userOverlay, overlay('economy'));
  assert.equal(loadCatalog({ host }).policy.defaults.strategy, 'economy');
  mkdirSync(home, { recursive: true });
  const workspaceOverlay = path.join(home, 'model-routing.json');
  writeFileSync(workspaceOverlay, overlay('speed'));
  assert.equal(loadCatalog({ host }).policy.defaults.strategy, 'speed');
  assert.equal(existsSync(userRouting), false);
  assert.equal(existsSync(routingStateDir), false);
  t.diagnostic(`before: neither ${userRouting} nor ${routingStateDir} exists`);
  await preflight({ host, harnesses: ['claude'], adapterFor: () => ({ probe: () => ({
    state: 'available', reason: null, message: 'fixture', source: 'probe',
    checkedAt: new Date().toISOString(), resetAt: null,
  }) }) });
  assert.equal(readSnapshot(host).harnesses.claude.state, 'available');

  await assert.rejects(liftoffParticipant({
    tool: { bin: process.execPath }, argv: ['-e', 'console.error("You hit your fixture limit"); process.exit(7)'],
    cwd: workspace, env: process.env, name: 'fixture', role: 'worker',
    sayLimit: (output) => markLimitAtStart(host, output),
  }), /exited with code 7.*now marked exhausted/);
  assert.equal(readSnapshot(host).harnesses.claude.state, 'exhausted');

  const id = 'routing-fixture';
  const owner = 'fixture-owner';
  store.createTask(home, { id, title: 'Fixture', owner });
  store.upsertParticipant(home, id, store.participantRecord('worker:fixture', {
    harness: 'claude', model: 'fake-model', sessionId: 'fixture-session',
  }));
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: owner, CODEX_HOME: path.join(userHome, 'codex-auth') };
  const isolatedEnv = liveRoutingEnv(root, { ...env, PROMPTOBUS_ROUTING_STATE_DIR: path.join(root, 'foreign') });
  assert.deepEqual(isolatedEnv, { ...env, PROMPTOBUS_ROUTING_STATE_DIR: routingStateDir });
  const closed = spawnSync(process.execPath, [bin, 'done', '--task', id, '--keep-sessions'], {
    cwd: workspace, encoding: 'utf8', timeout: 5000,
    env: isolated ? isolatedEnv : env,
  });
  assert.equal(closed.status, 0, `${closed.error ?? ''}\n${closed.stdout}${closed.stderr}`);
  t.diagnostic(`done CLI exited ${closed.status}: ${closed.stdout.trim()}`);
  assert.equal(host.routingPaths().cacheFile, path.join(stateDir, 'cache.json'));
  assert.equal(path.dirname(telemetryFileOf(host)), stateDir);
  assert.deepEqual(readTelemetry(host).records.filter((row) => row.role === 'worker').map((row) => row.model), ['fake-model']);
  assert.deepEqual(readdirSync(stateDir).sort(), ['cache.json', 'telemetry.jsonl']);
  assert.equal(existsSync(isolated ? userRouting : routingStateDir), false);
  assert.deepEqual(readdirSync(path.dirname(userOverlay)).sort(), isolated
    ? ['model-routing.json'] : ['model-routing', 'model-routing.json']);
  assert.equal(readFileSync(userOverlay, 'utf8'), overlay('economy'));
  assert.equal(readFileSync(workspaceOverlay, 'utf8'), overlay('speed'));
  t.diagnostic(`after: cache.json and telemetry.jsonl in ${stateDir}; fixture overlay unchanged`);
}

test('standalone defaults put preflight, refused-lift and done state in the fixture home', (t) => exercise(t, false));
test('standalone explicit routing state isolates the same writes from the fixture home', (t) => exercise(t, true));

test('standalone refuses a relative routing state directory instead of falling back', () => {
  assert.throws(() => createStandaloneHost({ routingStateDir: 'relative-fixture' }), /must be absolute/);
});
