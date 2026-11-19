import './home.mjs';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { throws } from 'node:assert/strict';
import { PARTICIPANT_MCP_POLICY_VERSION, createStandaloneHost } from '../dist/host-index.js';
import { participantMcp, writeLaunchFiles } from '../lib/spawn.js';
import { participantAudience } from '../lib/participant-context.js';
import { createOwnerEnvironment, readOwnerEnvironment } from '../lib/service-launch.js';
import { claudeDriver } from '../lib/driver-claude.js';
import { opencodeDriver } from '../lib/driver-opencode.js';
import { assertMcpRoot, cursorDriver } from '../lib/driver-cursor.js';
import { codexDriver, codexHomeConfig, trustPath } from '../lib/driver-codex.js';
import { codexMcpServers } from '../lib/codex-session.js';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';

const root = makeSandbox('participant-mcp-policy-');
const home = path.join(root, '.promptobus');
const scope = path.join(root, 'scope');
mkdirSync(scope);
const contexts = [];
const canonical = { type: 'http', url: 'https://canonical.invalid/mcp' };
const personal = { type: 'stdio', command: 'probe-command' };
const host = {
  ...createStandaloneHost({ cwd: root }),
  participantServers: (dir, context) => {
    contexts.push([dir, context.audience]);
    return context.audience === 'worker' ? { servers: { canonical, personal }, external: [] }
      : { servers: { canonical }, external: [], isolateProject: true };
  },
};
const base = { address: 'reviewer:repo', taskId: 'task', home, repoDir: scope };
const env = { PROMPTOBUS_SERVICE_HOME: path.join(root, 'service'), PERSONAL_TOKEN: 'fixture-private-token', SHARED_TOKEN: 'fixture-shared-token' };
const envHost = { ...host, privateEnvironmentKeys: candidate => new Set(Object.keys(candidate).filter(key => key.startsWith('PERSONAL_'))) };
const ownerFile = createOwnerEnvironment(envHost, env);
check('Owner snapshots retain shared values without persisting private host variables',
  !readFileSync(ownerFile, 'utf8').includes(env.PERSONAL_TOKEN)
  && readOwnerEnvironment(envHost, ownerFile, { env }).SHARED_TOKEN === env.SHARED_TOKEN);
const oldOwnerFile = createOwnerEnvironment(host, env);
check('A pre-policy owner snapshot cannot be handed to a managed participant', (() => {
  throws(() => readOwnerEnvironment(envHost, oldOwnerFile, { env: { PROMPTOBUS_SERVICE_HOME: env.PROMPTOBUS_SERVICE_HOME } }), /predates the host private environment policy/);
  return true;
})());
const scoped = participantMcp(host, base, claudeDriver).descriptor;
const worker = participantMcp(host, { ...base, address: 'worker:repo', audience: 'worker' }, claudeDriver).descriptor;
check('The host gets an explicit audience and only the worker receives the personal server',
  PARTICIPANT_MCP_POLICY_VERSION === 1 && JSON.stringify(contexts) === JSON.stringify([[scope, 'control'], [scope, 'worker']])
  && scoped.isolateProject && !scoped.servers.personal && worker.servers.personal.command === 'probe-command');

const planFor = (driver, mcp) => driver.prepare({
  ref: 'scope-probe', address: base.address, role: 'reviewer', cwd: scope, root, mcp, prompt: 'probe', model: 'test',
  guardCommand: 'true', mcpConfigPath: path.join(home, 'mcp.json'), settingsPath: path.join(home, 'review.settings.json'),
});
const claude = planFor(claudeDriver, scoped);
check('Claude isolates inherited MCP only for an opted-in descriptor',
  claude.argv.includes('--strict-mcp-config') && claude.argv.includes('--mcp-config')
  && !planFor(claudeDriver, worker).argv.includes('--strict-mcp-config'));

const renamed = { ...createStandaloneHost({ cwd: root }), pipeline: () => [
  { name: 'builder', kind: 'edits-tree' }, { name: 'reviewer', kind: 'reads-diff' }, { name: 'approver', kind: 'writes-main-tree' }] };
check('The MCP audience follows the step kind, not the step name',
  participantAudience(renamed, 'builder') === 'worker' && participantAudience(renamed, 'reviewer') === 'control'
  && participantAudience(host, 'worker') === 'worker' && participantAudience(host, 'reviewer') === 'control');
const hostReference = readFileSync(new URL('../docs/reference/02-host.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
check('The MCP audience needs only the Host pipeline, as the reference states',
  participantAudience({ pipeline: renamed.pipeline }, 'builder') === 'worker'
  && participantAudience({ pipeline: renamed.pipeline }, 'reviewer') === 'control'
  && hostReference.includes("`participantAudience` needs only the Host's `pipeline` field"));

const repeated = planFor(opencodeDriver, { servers: { repeated: { type: 'stdio', command: 'node', args: ['node', 'x.js'] } } });
check('OpenCode keeps a personal command whose first argument repeats it',
  JSON.stringify(repeated.mcpConfig.mcp.repeated.command) === JSON.stringify(['node', 'node', 'x.js']));

const opencode = planFor(opencodeDriver, scoped);
check('OpenCode disables project discovery but retains its explicit MCP file',
  opencode.env.OPENCODE_CONFIG_PROJECT_DISABLE === '1' && opencode.env.OPENCODE_DISABLE_PROJECT_CONFIG === '1'
  && opencode.env.OPENCODE_CONFIG === path.join(home, 'mcp.json')
  && !('OPENCODE_CONFIG_PROJECT_DISABLE' in planFor(opencodeDriver, worker).env));

const cursor = planFor(cursorDriver, scoped);
check('Cursor checks the dedicated Git root only for an opted-in descriptor',
  typeof cursor.prepareMcpRoot === 'function' && cursor.cwd !== root && cursor.cwd !== scope
  && !planFor(cursorDriver, worker).prepareMcpRoot);
const init = cwd => spawnSync('git', ['init', '-q'], { cwd }).status === 0;
check('Cursor rejects the ancestor Git root and accepts a standalone sandbox', init(root) && (() => {
  throws(() => assertMcpRoot(scope), /own Git root/);
  const guarded = path.join(scope, '.cursor', 'mcp.json');
  throws(() => writeLaunchFiles([{ path: guarded, text: '{}\n', secret: true }], [], () => assertMcpRoot(scope)), /own Git root/);
  if (existsSync(guarded)) return false;
  if (!init(scope)) return false;
  assertMcpRoot(scope);
  return true;
})());
const codex = codexDriver.prepare({
  ref: 'scope-probe', address: 'orchestrator', task: 'task', role: 'orchestrator', home, cwd: root, root,
  mcp: scoped, prompt: 'probe', model: 'test', settingsPath: path.join(home, 'codex-settings.json'), env: {},
});
check('Codex rejects colliding normalized MCP keys without replacing an entry', (() => {
  throws(() => codexMcpServers({ canonical, 'host-canonical': personal }, 'host-'), /collide after normalization/);
  return true;
})());
const codexConfig = codexHomeConfig({ trusted: [trustPath(root)], untrusted: [codex.untrustedMcpRoot] });
check('Codex root control launches mark the host workspace untrusted',
  codex.untrustedMcpRoot === trustPath(root) && !codexConfig.includes('trust_level = "trusted"')
  && codexConfig.includes('trust_level = "untrusted"'));
