import { check } from './check.mjs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { approveStandaloneRootProfile } from '../lib/integration.js';
import { runWorkspaceService } from '../lib/service.js';
import { registerServiceClient, serviceControl } from '../lib/service-client.js';
import { privateDirectory, processStateAsync, readDiscovery, readPrivate, requireProcess, runtimeIdentity, servicePaths, writePrivate } from '../lib/service-state.js';
import { observeRootProcess } from '../lib/root-process.js';
import { copyNodeExecutable, makeSandbox, writeHostConfig } from './sandbox.mjs';

// Real owned exec/hook/client paths with private known-binding seeds, not native genesis or Claude compatibility.
const root = realpathSync(makeSandbox('promptobus-service-stores-'));
const nativeExecutable = path.join(root, 'native-node');
copyNodeExecutable(nativeExecutable);
const base = mkdtempSync(path.join(realpathSync('/tmp'), 'pb-service-stores-'));
const bin = fileURLToPath(new URL('../bin/promptobus.js', import.meta.url)), wrapper = fileURLToPath(new URL('../bin/promptobus-root', import.meta.url));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const env = { ...process.env,
  PROMPTOBUS_SERVICE_HOME: base, PROMPTOBUS_WARDEN: 'off', PROMPTOBUS_SERVICE_IDLE_MS: '60000' };
for (const key of Object.keys(env)) if (/^(BB_|PROMPTOBUS_(CLIENT_|ROOT_|OWNER_ENV_FILE$|ROLE$|TASK$|.*_SESSION$))/.test(key)) delete env[key];
writeHostConfig(root, { tools: [] });
const host = createStandaloneHost({ cwd: root, binPath: bin, version }), paths = servicePaths(host, env), runtime = runtimeIdentity(host);
const native = path.join(root, 'native.mjs'), children = [];
writeFileSync(native, `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';
import{acquireServiceLock,readPrivate,writePrivate}from${JSON.stringify(fileURLToPath(new URL('../lib/service-state.js', import.meta.url)))};
const[output,bin,profile,id,transcriptStore]=process.argv.slice(2),directory=${JSON.stringify(paths.directory)};
const launch=readPrivate(process.env.PROMPTOBUS_ROOT_LAUNCH_FILE),approved=readPrivate(directory+'/root-profile-'+profile+'.json');
let release=null;const deadline=Date.now()+5000;
while(!release){release=await acquireServiceLock(directory+'/root-admission.lock');if(!release){if(Date.now()>=deadline)throw new Error('Owned seed transaction stayed busy');await new Promise(resolve=>setTimeout(resolve,10));}}
try{const file=directory+'/native-admission.json',ledger=readPrivate(file);writePrivate(file,{...ledger,bindings:[...ledger.bindings,{
harness:'claude',nativeStore:approved.nativeStore,nativeId:id,source:'standalone',runtime:launch.runtime,ownerKey:launch.nonce,
process:launch.process,nonce:launch.nonce,profile,phase:'pending'}]});}finally{release();}
const transcript=(transcriptStore??approved.nativeStore)+'/'+id+'.jsonl';writeFileSync(transcript,JSON.stringify({sessionId:id})+'\\n',{mode:0o600});
const hook=spawn(${JSON.stringify(process.execPath)},[bin,'guard','--standalone-profile',profile,'--service-home',process.env.PROMPTOBUS_SERVICE_HOME],{stdio:['pipe','ignore','pipe']});
let error='';hook.stderr.on('data',bytes=>{error+=bytes});hook.stdin.end(JSON.stringify({hook_event_name:'SessionStart',source:'startup',session_id:id,cwd:process.cwd(),transcript_path:transcript}));
const code=await new Promise(resolve=>hook.once('close',resolve));writeFileSync(output,JSON.stringify({code,error}),{mode:0o600});setInterval(()=>{},1000);
`);
const until = async test => { const deadline = Date.now() + 5000; while (!test()) { if (Date.now() >= deadline) throw new Error('Owned native-store fixture did not reach its hook receipt'); await new Promise(resolve => setTimeout(resolve, 10)); } };
const launch = async (profile, id, transcriptStore) => {
  const output = path.join(root, `result-${randomUUID()}.json`);
  const child = spawn('/bin/sh', [wrapper, '--profile', profile, '--service-home', base, '--', nativeExecutable, native, output, bin, profile, id, ...(transcriptStore ? [transcriptStore] : [])],
    { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.failure = ''; child.stderr.on('data', bytes => { child.failure += bytes; }); child.closed = new Promise(resolve => child.once('close', resolve)); children.push(child);
  await until(() => existsSync(output) || child.exitCode !== null);
  if (!existsSync(output)) throw new Error(`Owned store launch failed before hook: ${child.failure}`);
  const saved = readdirSync(paths.directory).filter(name => /^standalone-launch-.*\.json$/.test(name))
    .map(name => readPrivate(path.join(paths.directory, name))).find(value => value.process.pid === child.pid);
  return { ...JSON.parse(readFileSync(output)), launch: saved };
};
const credential = launched => readPrivate(path.join(paths.clients, `${launched.launch.clientId}.json`));
let ownerError;
const running = runWorkspaceService({ host, env, createHost: context => createStandaloneHost({ cwd: context.cwd, binPath: bin, version }) }).catch(error => { ownerError = error; });
try {
  await until(() => readDiscovery(paths) || ownerError); if (ownerError) throw ownerError;
  for (const profile of ['store-a', 'store-b', 'store-c']) {
    const store = path.join(root, profile); mkdirSync(store);
    await approveStandaloneRootProfile(host, { id: profile, harness: 'claude', nativeStore: store, executable: nativeExecutable }, env);
  }
  for (const order of [['store-a', 'store-b'], ['store-b', 'store-a']]) {
    const id = randomUUID(), first = await launch(order[0], id), second = await launch(order[1], id);
    check(`${order.join(' then ')}: live same native ID binds independently in two approved stores`, first.code === 0 && second.code === 0
      && credential(first).nativeBinding.sessionId === id && credential(second).nativeBinding.sessionId === id, second.error);
  }
  const id = randomUUID(), pair = await Promise.all([launch('store-a', id), launch('store-b', id)]);
  check('concurrent same-ID roots in distinct proved stores both reach bound clients', pair.every(value => value.code === 0
    && credential(value).nativeBinding.state === 'bound'), JSON.stringify(pair.map(value => ({ code: value.code, error: value.error }))));
  const foreignTranscript = await launch('store-a', randomUUID(), path.join(root, 'store-b'));
  check('an owned same-ID transcript in another approved store cannot realize this launch', foreignTranscript.code !== 0
    && /actual session transcript inside the approved account store/.test(foreignTranscript.error)
    && foreignTranscript.launch.revoked === true && foreignTranscript.launch.nativeId === null
    && !existsSync(path.join(paths.clients, `${foreignTranscript.launch.clientId}.json`)), foreignTranscript.error);
  const bbId = randomUUID(), stateDirectory = path.join(paths.directory, 'root-admission'); privateDirectory(stateDirectory);
  writePrivate(path.join(stateDirectory, 'state.json'), { schemaVersion: 2, root: paths.root, home: paths.home,
    profiles: [{ id: 'bb-fixture', runtime, nativeStore: path.join(root, 'store-a') }], managed: [], roots: [{ profileId: 'bb-fixture', bbThreadId: 'thr_store_fixture',
      generation: { nativeThreadId: bbId, appServer: requireProcess(), nonce: randomUUID() } }] });
  const otherHarness = await launch('store-b', bbId);
  check('standalone owner realization uses scoped ledger checks instead of a raw BB same-ID precheck', otherHarness.code === 0,
    otherHarness.error);
  const unknown = await registerServiceClient(host, { cwd: root, env: { ...env, CLAUDE_CONFIG_DIR: path.join(root, 'store-a') }, pollEnv: env,
    lifetime: { kind: 'process', process: requireProcess() }, nativeBinding: { kind: 'claude', state: 'pending' } }, { env, pollEnv: env });
  await serviceControl(paths, { operation: 'realize', runtime, clientId: unknown.clientId, threadId: id });
  const refused = await launch('store-c', id);
  check('unknown-store bound client still blocks related root ID despite a raw native-store hint', refused.code !== 0
    && /already binds this actual identity/.test(refused.error) && !existsSync(path.join(paths.clients, `${refused.launch.clientId}.json`)), refused.error);
  const occupant = await observeRootProcess(children[0].pid);
  if (!occupant) throw new Error('Owned replacement occupant has no comparable identity');
  let oldBirth;
  if (occupant.birth.startsWith('v2:linux:')) oldBirth = occupant.birth.replace(/:(\d+)$/, (_, ticks) => `:${BigInt(ticks) > 0n ? BigInt(ticks) - 1n : 1n}`);
  else {
    const date = new Date(`${occupant.birth.slice('v2:darwin:utc-c:'.length)} GMT`); date.setUTCSeconds(date.getUTCSeconds() - 1);
    const [weekday, , month, year, time] = date.toUTCString().split(' ');
    oldBirth = `v2:darwin:utc-c:${weekday.slice(0, -1)} ${month} ${date.getUTCDate()} ${time} ${year}`;
  }
  const oldId = randomUUID(), token = randomUUID().replaceAll('-', '').repeat(2);
  writePrivate(path.join(paths.clients, `${oldId}.json`), { schemaVersion: 1, id: oldId, token, runtime, cwd: root, env, pollEnv: env, files: null,
    lifetime: { kind: 'process', process: { pid: occupant.pid, birth: oldBirth } }, nativeBinding: { kind: 'claude', state: 'bound', sessionId: randomUUID() } });
  const oldRequest = await fetch(`${readDiscovery(paths).url}mcp/bus`, { method: 'POST', headers: { authorization: `Bearer ${token}`,
    accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
  await oldRequest.text();
  check('old token cannot borrow a reused PID with a reliable different birth and does not terminate its occupant', oldRequest.status === 401
    && await processStateAsync(occupant) === 'alive');
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.all(children.map(child => child.closed));
  for (const name of existsSync(paths.clients) ? readdirSync(paths.clients) : []) if (/^[a-f0-9-]{36}\.json$/.test(name)) {
    await serviceControl(paths, { operation: 'revoke', runtime, clientId: name.slice(0, -5) });
  }
  if (!ownerError && readDiscovery(paths)) await serviceControl(paths, { operation: 'stop', runtime });
  await running; rmSync(base, { recursive: true, force: true });
}
if (ownerError) throw ownerError;
