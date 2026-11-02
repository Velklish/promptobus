import { check } from './check.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { approveStandaloneRootProfile } from '../lib/integration.js';
import { serviceControl } from '../lib/service-client.js';
import { processState, readDiscovery, readPrivate, runtimeIdentity, servicePaths, writePrivate } from '../lib/service-state.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

// Synthetic native image and owned service processes prove crash behavior, not Claude compatibility.
const root = realpathSync(makeSandbox('promptobus-owner-recovery-'));
const base = mkdtempSync(path.join(realpathSync('/tmp'), 'pb-recovery-'));
const bin = fileURLToPath(new URL('../bin/promptobus.js', import.meta.url));
const wrapper = fileURLToPath(new URL('../bin/promptobus-root', import.meta.url));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
  PROMPTOBUS_SERVICE_HOME: base, PROMPTOBUS_WARDEN: 'off', PROMPTOBUS_SERVICE_IDLE_MS: '60000' };
for (const key of Object.keys(env)) if (/^(BB_|PROMPTOBUS_(CLIENT_|ROOT_|OWNER_ENV_FILE$|ROLE$|TASK$|.*_SESSION$))/.test(key)) delete env[key];
writeHostConfig(root, { tools: [] });
const host = createStandaloneHost({ cwd: root, binPath: bin, version }), paths = servicePaths(host, env), runtime = runtimeIdentity(host);
const nativeStore = path.join(root, 'native'); mkdirSync(nativeStore);
const entry = path.join(root, 'owned-owner.mjs'), native = path.join(root, 'owned-native.mjs');
const gate = path.join(root, 'crash-phase.json'), entered = path.join(root, 'phase-entered'), ready = path.join(root, 'native-ready');
const nativeId = randomUUID(), owned = new Set();
let owner = null, nativeChild = null;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => { const deadline = Date.now() + 5000; while (!await predicate()) {
  if (Date.now() >= deadline) throw new Error('Owned recovery fixture did not reach its exact phase'); await pause(10);
} };
const start = (file, args) => {
  const child = spawn(file, args, { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.failure = ''; child.stderr.on('data', bytes => { child.failure += bytes; });
  child.closed = new Promise(resolve => child.once('close', resolve)); owned.add(child); return child;
};
const startOwner = async () => {
  owner = start(process.execPath, [entry]);
  await until(() => readDiscovery(paths)?.process.pid === owner.pid || owner.exitCode !== null);
  if (owner.exitCode !== null) throw new Error(`Owned recovery service exited: ${owner.failure}`);
};
const crashOwner = async () => {
  const identity = readDiscovery(paths).process;
  if (identity.pid !== owner.pid || processState(identity) !== 'alive') throw new Error('Refusing to stop an unowned recovery process');
  owner.kill('SIGKILL'); await owner.closed;
};
const cli = args => new Promise(resolve => {
  const child = spawn(process.execPath, [bin, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  owned.add(child); let out = '', error = '';
  child.stdout.on('data', bytes => { out += bytes; }); child.stderr.on('data', bytes => { error += bytes; });
  child.closed = new Promise(done => child.once('close', code => { done(); resolve({ code, out, error }); }));
});
const control = input => serviceControl(paths, { runtime, ...input });
const currentLaunch = () => readdirSync(paths.directory).filter(name => /^standalone-launch-.*\.json$/.test(name))
  .map(name => readPrivate(path.join(paths.directory, name))).find(value => value.process.pid === nativeChild.pid);
let sequence = 0;
const rpc = async (grant, session, method, params = {}, notification = false) => {
  const response = await fetch(`${readDiscovery(paths).url}mcp/bus`, { method: 'POST', headers: {
    authorization: `Bearer ${grant.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
    ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': '2025-06-18' } : {}),
  }, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++sequence }), method, params }) });
  await response.text(); return { status: response.status, session: response.headers.get('mcp-session-id') };
};
const tool = async grant => {
  const session = (await rpc(grant, null, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'crash-fixture', version: '1' } })).session;
  await rpc(grant, session, 'notifications/initialized', {}, true);
  return { ...await rpc(grant, session, 'tools/call', { name: 'promptobus_status', arguments: {} }), session };
};
writeFileSync(entry, `import fs from 'node:fs';import {syncBuiltinESMExports}from'node:module';
import{createStandaloneHost}from${JSON.stringify(fileURLToPath(new URL('../dist/host-index.js', import.meta.url)))};
import{runWorkspaceService}from${JSON.stringify(fileURLToPath(new URL('../lib/service.js', import.meta.url)))};
const rename=fs.renameSync;
fs.renameSync=function(from,to){const result=rename(from,to);if(!fs.existsSync(${JSON.stringify(gate)}))return result;
const phase=JSON.parse(fs.readFileSync(${JSON.stringify(gate)},'utf8')).phase,value=JSON.parse(fs.readFileSync(to,'utf8'));
const match=phase==='pending'?String(to).includes('standalone-recovery-')&&value.phase==='pending':
phase==='revoked'?String(to).includes('standalone-revoked-'):
phase==='bound'?String(to).includes('/clients/')&&value.nativeBinding?.state==='bound':
phase==='completed'?String(to).includes('standalone-recovery-')&&value.phase==='completed':false;
if(match){fs.writeFileSync(${JSON.stringify(entered)},phase,{mode:0o600});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);}return result;};syncBuiltinESMExports();
const make=({cwd})=>createStandaloneHost({cwd,binPath:${JSON.stringify(bin)},version:${JSON.stringify(version)}});
await runWorkspaceService({host:make({cwd:process.cwd()}),env:process.env,createHost:make});
`);
writeFileSync(native, `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';
import{readPrivate,writePrivate}from${JSON.stringify(fileURLToPath(new URL('../lib/service-state.js', import.meta.url)))};
const launch=readPrivate(process.env.PROMPTOBUS_ROOT_LAUNCH_FILE),file=${JSON.stringify(path.join(paths.directory, 'native-admission.json'))},ledger=readPrivate(file);
writePrivate(file,{...ledger,bindings:[...ledger.bindings,{harness:'claude',nativeStore:${JSON.stringify(nativeStore)},nativeId:${JSON.stringify(nativeId)},
source:'standalone',runtime:launch.runtime,ownerKey:launch.nonce,process:launch.process,nonce:launch.nonce,profile:'recovery',phase:'pending'}]});
const hook=spawn(process.execPath,[${JSON.stringify(bin)},'guard','--standalone-profile','recovery','--service-home',process.env.PROMPTOBUS_SERVICE_HOME],{stdio:['pipe','ignore','inherit']});
hook.stdin.end(JSON.stringify({hook_event_name:'SessionStart',session_id:${JSON.stringify(nativeId)},cwd:process.cwd()}));
const code=await new Promise(resolve=>hook.once('close',resolve));if(code!==0)process.exit(code??1);
writeFileSync(${JSON.stringify(ready)},'ready',{mode:0o600});setInterval(()=>{},1000);
`);
for (const file of [entry, native]) {
  check('generated recovery owner/native JavaScript parses before process start', spawnSync(process.execPath, ['--check', file]).status === 0, file);
}
try {
  await startOwner();
  await approveStandaloneRootProfile(host, { id: 'recovery', harness: 'claude', nativeStore, executable: process.execPath }, env);
  nativeChild = start('/bin/sh', [wrapper, '--profile', 'recovery', '--service-home', base, '--', process.execPath, native]);
  await until(() => existsSync(ready) || nativeChild.exitCode !== null);
  if (!existsSync(ready)) throw new Error(`Owned native fixture exited: ${nativeChild.failure}`);
  const original = currentLaunch(), processIdentity = original.process;
  let grant = readPrivate(path.join(paths.clients, `${original.clientId}.json`));
  check('fixture-seeded known binding and actual hook complete a small HTTP workflow', (await tool(grant)).status === 200);
  const oldOwner = owner.pid; await crashOwner(); await startOwner();
  check('same native PID and capability reconnect after an actual owner process restart', owner.pid !== oldOwner
    && JSON.stringify(currentLaunch().process) === JSON.stringify(processIdentity) && (await tool(grant)).status === 200);
  for (const phase of ['pending', 'revoked', 'bound', 'completed']) {
    const oldGrant = grant;
    await control({ operation: 'revoke', clientId: grant.id });
    rmSync(entered, { force: true }); writeFileSync(gate, JSON.stringify({ phase }), { mode: 0o600 });
    const interrupted = control({ operation: 'standalone-preflight', profile: 'recovery', nativeId }).then(() => null, error => error);
    await until(() => existsSync(entered));
    await crashOwner(); await interrupted; rmSync(gate);
    await startOwner();
    const completed = await cli(['service', 'preflight', '--standalone', '--profile', 'recovery', '--native-id', nativeId, '--service-home', base]);
    grant = readPrivate(path.join(paths.clients, `${currentLaunch().clientId}.json`));
    check(`explicit recovery resumes durable state after owner crash at ${phase}`, completed.code === 0 && grant.id !== oldGrant.id
      && JSON.stringify(currentLaunch().process) === JSON.stringify(processIdentity) && (await tool(grant)).status === 200, completed.error);
    check(`old capability stays revoked after ${phase} recovery`, (await rpc(oldGrant, null, 'initialize', {})).status === 401);
  }
  const recoveryFile = path.join(paths.directory, `standalone-recovery-${original.nonce}.json`), recovery = readPrivate(recoveryFile);
  writePrivate(recoveryFile, null);
  const corrupt = await cli(['service', 'preflight', '--standalone', '--profile', 'recovery', '--native-id', nativeId, '--service-home', base]);
  check('literal null recovery checkpoint cannot be replaced as a fresh attempt', corrupt.code !== 0
    && readFileSync(recoveryFile, 'utf8').trim() === 'null' && currentLaunch().clientId === grant.id, corrupt.error);
  for (const phase of [['pending'], ['completed'], { value: 'pending' }, null]) {
    writePrivate(recoveryFile, { ...recovery, phase });
    const bytes = readFileSync(recoveryFile, 'utf8');
    const refused = await cli(['service', 'preflight', '--standalone', '--profile', 'recovery', '--native-id', nativeId, '--service-home', base]);
    check('nonprimitive recovery phase cannot resume or replace a capability', refused.code !== 0
      && readFileSync(recoveryFile, 'utf8') === bytes && currentLaunch().clientId === grant.id, refused.error);
  }
  writePrivate(recoveryFile, recovery);
  const session = (await tool(grant)).session, receipt = path.join(paths.requests, `root-${original.nonce}`, session, `${'a'.repeat(64)}.json`);
  writePrivate(receipt, { digest: 'owned-uncertain-fixture', state: 'started', readOnly: false });
  await control({ operation: 'revoke', clientId: grant.id }); await crashOwner(); await startOwner();
  const uncertain = await cli(['service', 'preflight', '--standalone', '--profile', 'recovery', '--native-id', nativeId, '--service-home', base]);
  check('owner restart and a new client cannot discard unknown mutation outcome', uncertain.code !== 0 && /uncertain/.test(uncertain.error) && existsSync(receipt), uncertain.error);
  const retainedClient = currentLaunch().clientId, retainedClients = readdirSync(paths.clients).sort();
  for (const state of [['started'], ['completed'], { value: 'started' }, null]) {
    writePrivate(receipt, { digest: 'owned-uncertain-fixture', state, readOnly: false });
    const bytes = readFileSync(receipt, 'utf8');
    const refused = await cli(['service', 'preflight', '--standalone', '--profile', 'recovery', '--native-id', nativeId, '--service-home', base]);
    check('nonprimitive mutation receipt state cannot mint a recovery capability after owner restart', refused.code !== 0
      && /uncertain/.test(refused.error) && currentLaunch().clientId === retainedClient
      && JSON.stringify(readdirSync(paths.clients).sort()) === JSON.stringify(retainedClients) && readFileSync(receipt, 'utf8') === bytes, refused.error);
  }
} finally {
  rmSync(gate, { force: true });
  for (const child of owned) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.all([...owned].map(child => child.closed));
  rmSync(base, { recursive: true, force: true });
}
