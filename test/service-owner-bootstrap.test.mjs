import { check } from './check.mjs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { ensureWorkspaceService, stopWorkspaceService } from '../lib/service-client.js';
import { processState, readDiscovery, servicePaths } from '../lib/service-state.js';

const ROOT = realpathSync(makeSandbox('promptobus-shared-service-'));
const PRIVATE = mkdtempSync(path.join(realpathSync('/tmp'), 'pbsvc-'));
const PACKAGE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENTRY = path.join(ROOT, 'consumer.mjs'), TRACE = path.join(ROOT, 'bootstrap.jsonl'), MANAGED_CWD = path.join(ROOT, 'managed-worktree');
const VERSION = JSON.parse(readFileSync(path.join(PACKAGE, 'package.json'), 'utf8')).version;
const ACTOR = ['PROMPTOBUS_ROLE', 'PROMPTOBUS_TASK', 'PROMPTOBUS_ROOT_TASK', 'PROMPTOBUS_CLAUDE_SESSION', 'PROMPTOBUS_CODEX_SESSION',
  'PROMPTOBUS_CURSOR_SESSION', 'PROMPTOBUS_OPENCODE_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CODEX_THREAD_ID', 'BB_THREAD_ID',
  'BB_ENVIRONMENT_ID', 'BB_PROJECT_ID', 'BB_THREAD_STORAGE', 'CURSOR_CONVERSATION_ID', 'AGENT_CLI_SOCKET_PATH', 'AGENT_CLI_LOG_PATH',
  'CURSOR_AGENT_SOCKET', 'OPENCODE_SESSION_ID'];
writeHostConfig(ROOT, { tools: [] }); mkdirSync(MANAGED_CWD);
writeFileSync(ENTRY, `import {appendFileSync} from 'node:fs';
import {createStandaloneHost} from ${JSON.stringify(pathToFileURL(path.join(PACKAGE, 'dist/host-index.js')).href)};
import {runPromptobus} from ${JSON.stringify(pathToFileURL(path.join(PACKAGE, 'lib/cli.js')).href)};
const make=({cwd,env})=>{
 const snapshot={cwd,actor:Object.fromEntries(${JSON.stringify(ACTOR)}.filter(key=>env[key]!==undefined).map(key=>[key,env[key]])),
 codexHome:env.CODEX_HOME,opencodeConfig:env.OPENCODE_CONFIG,consumer:env.ROOT_CONSUMER_SETTING};
 const record=kind=>appendFileSync(${JSON.stringify(TRACE)},JSON.stringify({kind,...snapshot})+'\\n',{mode:0o600});
 record('factory');const host=createStandaloneHost({cwd,binPath:${JSON.stringify(ENTRY)},version:${JSON.stringify(VERSION)}});
 const resolve=host.resolveToolBin;host.resolveToolBin=tool=>{record('resolveToolBin');return resolve(tool);};return host;
};
const code=await runPromptobus(process.argv.slice(2),{host:make({cwd:process.cwd(),env:process.env}),createHost:make,cwd:process.cwd(),env:process.env});
if(code)process.exitCode=code;
`);
const host = createStandaloneHost({ cwd: ROOT, binPath: ENTRY, version: VERSION });
const common = { ...process.env, PROMPTOBUS_SERVICE_HOME: path.join(ROOT, 'unused-wide-service-home'), PROMPTOBUS_SERVICE_IDLE_MS: '10000',
  PROMPTOBUS_WARDEN: 'off', CODEX_HOME: path.join(ROOT, 'common-codex'), OPENCODE_CONFIG: path.join(ROOT, 'common-opencode.json'), ROOT_CONSUMER_SETTING: 'root-common-only' };
for (const key of ACTOR) common[key] = 'root-actor-field-must-be-removed';
common.PROMPTOBUS_ROLE = 'orchestrator';
const managed = { ...common, PROMPTOBUS_SERVICE_HOME: PRIVATE, PROMPTOBUS_ROLE: 'worker:bootstrap',
  CODEX_HOME: path.join(ROOT, 'managed-private-codex'), OPENCODE_CONFIG: path.join(ROOT, 'managed-private-opencode.json'), ROOT_CONSUMER_SETTING: 'managed-private-setting' };
const options = { cwd: MANAGED_CWD, env: managed };
const paths = servicePaths(host, managed), originalSpawn = childProcess.spawn;
let launches = 0, running = null;
childProcess.spawn = (bin, args, ...rest) => {
  if (args?.[0] === ENTRY && args[1] === 'service' && args[2] === 'run') launches += 1;
  return originalSpawn(bin, args, ...rest);
};
syncBuiltinESMExports();
try {
  for (const mode of ['non-root-role', 'session-record']) {
    const caller = { ...managed };
    for (const key of ['PROMPTOBUS_CLAUDE_SESSION', 'PROMPTOBUS_CODEX_SESSION', 'PROMPTOBUS_CURSOR_SESSION', 'PROMPTOBUS_OPENCODE_SESSION']) delete caller[key];
    if (mode === 'session-record') { caller.PROMPTOBUS_ROLE = 'orchestrator'; caller.PROMPTOBUS_CODEX_SESSION = path.join(ROOT, 'managed-session.json'); }
    const before = launches;
    const refused = await ensureWorkspaceService(host, { ...options, env: caller }).then(value => { running = value; return null; }, error => error.message);
    check(`managed cold bootstrap ${mode} requires owner preflight before any child is spawned`, /common.*owner|owner.*preflight/i.test(refused ?? '')
      && launches === before && !existsSync(TRACE), refused ?? 'owner was started from managed context');
    if (running) { await stopWorkspaceService(host, { ...options, env: caller }); running = null; }
    rmSync(TRACE, { force: true });
  }
  running = await ensureWorkspaceService(host, { ...options, pollEnv: common });
  const rows = readFileSync(TRACE, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  check('explicit common bootstrap preserves the full root consumer/account environment for actual owner callbacks', rows.some(row => row.kind === 'resolveToolBin')
    && rows.every(row => row.consumer === 'root-common-only' && row.codexHome === common.CODEX_HOME && row.opencodeConfig === common.OPENCODE_CONFIG));
  check('owner factory and callbacks receive canonical workspace cwd and no actor identity from either environment', rows.every(row => row.cwd === ROOT && Object.keys(row.actor).length === 0), JSON.stringify(rows));
  const reused = await ensureWorkspaceService(host, options);
  check('a managed caller can reuse the already ready owner without changing its factory context', reused.process.pid === running.process.pid
    && reused.process.birth === running.process.birth && readFileSync(TRACE, 'utf8').trim().split('\n').length === rows.length);
  const firstOwner = running.process;
  await stopWorkspaceService(host, options); running = null;
  check('the controlled first owner physically exits', processState(firstOwner) === 'dead');
  rmSync(TRACE);
  const rootEnv = { ...managed, ROOT_CONSUMER_SETTING: 'ordinary-root-default' };
  for (const key of ACTOR) delete rootEnv[key];
  rootEnv.PROMPTOBUS_ROLE = 'orchestrator'; rootEnv.PROMPTOBUS_TASK = 'ordinary-root-task'; rootEnv.CLAUDE_CODE_SESSION_ID = 'ordinary-root-native';
  running = await ensureWorkspaceService(host, { cwd: ROOT, env: rootEnv });
  const rootRows = readFileSync(TRACE, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  check('ordinary unbound root bootstrap still works and neutralizes task/role/native fields', rootRows.some(row => row.kind === 'resolveToolBin')
    && rootRows.every(row => row.consumer === 'ordinary-root-default' && row.cwd === ROOT && Object.keys(row.actor).length === 0));
  await stopWorkspaceService(host, { cwd: ROOT, env: rootEnv }); running = null;
} finally {
  if (running) await stopWorkspaceService(host, options);
  childProcess.spawn = originalSpawn; syncBuiltinESMExports();
  const retained = readDiscovery(paths);
  if (!retained || processState(retained.process) === 'dead') rmSync(PRIVATE, { recursive: true, force: true });
}
