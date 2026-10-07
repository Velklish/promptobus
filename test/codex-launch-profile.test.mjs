import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { installHarness, PROBE_VAR } from './harness-codex.mjs';
import { verifyThreadProfile } from '../lib/codex-session.js';

const request = { model: 'gpt-6-astra', effort: 'high', sandbox: 'workspace-write', approvalPolicy: 'on-request' };
const response = { model: request.model, reasoningEffort: request.effort,
  sandbox: { type: 'workspaceWrite', networkAccess: false }, approvalPolicy: request.approvalPolicy };
let log = '';
verifyThreadProfile(request, response, line => { log = line; });
check('matching native profile logs requested and effective values with restricted network',
  /requested=.*high.*effective=.*high.*network=restricted/.test(log));
verifyThreadProfile({ ...request, model: null, effort: null }, { ...response, reasoningEffort: null });
check('unspecified model and effort preserve native defaults', true);
for (const [field, change] of [
  ['model', { model: 'other' }], ['effort', { reasoningEffort: 'xhigh' }],
  ['sandbox', { sandbox: { type: 'dangerFullAccess' } }], ['approvalPolicy', { approvalPolicy: 'never' }],
  ['effort', { reasoningEffort: null }], ['model', { model: null }],
]) {
  assert.throws(() => verifyThreadProfile(request, { ...response, ...change }),
    new RegExp(`profile mismatch: ${field}.*no model turn started`));
  check(`native response rejects unexpected ${field}: ${JSON.stringify(change)}`, true);
}
verifyThreadProfile({ ...request, sandbox: 'danger-full-access' },
  { ...response, sandbox: { type: 'dangerFullAccess' } }, line => { log = line; });
check('explicit full access reports unrestricted network', /network=unrestricted/.test(log));

const root = makeSandbox('promptobus-codex-');
writeHostConfig(root, { tools: ['codex'] });
const harness = await installHarness({ binDir: path.join(root, 'bin') });
const ownerHome = path.join(root, 'owner');
mkdirSync(ownerHome);
writeFileSync(path.join(ownerHome, 'auth.json'), '{"stub":"credentials"}');
const brief = path.join(root, 'brief.md');
writeFileSync(brief, '# Verify effective profile\nKeep the requested model and effort.\n');
try {
  for (const [index, probe] of ['profile-model-mismatch', 'profile-effort-mismatch'].entries()) {
    const ran = spawnSync(process.execPath, [path.resolve('bin/promptobus.js'), 'lead',
      '--brief', brief, '--task', `profile-t20261007-00000${index + 1}`,
      '--model', request.model, '--effort', request.effort, '--permission-mode', 'full-access'], {
      cwd: root, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, CODEX_HOME: ownerHome, PROMPTOBUS_CODEX_OWNER_HOME: ownerHome,
        PROMPTOBUS_WARDEN: 'off', [PROBE_VAR]: probe },
    });
    const threads = readdirSync(path.join(harness.home, 'threads')).map(file =>
      JSON.parse(readFileSync(path.join(harness.home, 'threads', file), 'utf8')));
    check(`holder refuses ${probe} before its first turn/start`,
      ran.status === 1 && /execution profile mismatch/.test(ran.stdout + ran.stderr)
      && threads.length === index + 1 && threads.every(thread => !thread.firstRpc && !thread.turns?.length),
      `${ran.status} ${ran.stdout}${ran.stderr}`);
  }
} finally { harness.restore(); }
