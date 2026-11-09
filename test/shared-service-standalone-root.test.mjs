import { check } from './check.mjs';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const selectedRuntime = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2]) + '/') : new URL('../', import.meta.url);
const { createStandaloneHost } = await import(new URL('dist/host-index.js', selectedRuntime));
const { approveStandaloneRootProfile, authorizeStandaloneRootStart, standaloneRootExecPlan } = await import(new URL('lib/standalone-root.js', selectedRuntime));
const { planHookInstall } = await import(new URL('lib/integration.js', selectedRuntime));
const { runWorkspaceService } = await import(new URL('lib/service.js', selectedRuntime));
const { serviceControl } = await import(new URL('lib/service-client.js', selectedRuntime));
const { processState, readDiscovery, readPrivate, runtimeIdentity, servicePaths, writePrivate } = await import(new URL('lib/service-state.js', selectedRuntime));
const { copyNodeExecutable, makeSandbox, writeHostConfig } = await import(new URL('test/sandbox.mjs', selectedRuntime));

const root = realpathSync(makeSandbox('promptobus-standalone-root-'));
const runnerExecutable = statSync(process.execPath);
process.stdout.write(`  · fixture runner executable: ${JSON.stringify({ isFile: runnerExecutable.isFile(), mode: (runnerExecutable.mode & 0o777).toString(8) })}\n`);
const nativeExecutable = path.join(root, 'native-node');
copyNodeExecutable(nativeExecutable);
const base = mkdtempSync(path.join(realpathSync('/tmp'), 'pb-root-'));
const bin = fileURLToPath(new URL('bin/promptobus.js', selectedRuntime));
const wrapper = fileURLToPath(new URL('bin/promptobus-root', selectedRuntime));
const version = JSON.parse(readFileSync(new URL('package.json', selectedRuntime))).version;
const env = { ...process.env,
  PROMPTOBUS_HOME: path.join(root, '.promptobus'), PROMPTOBUS_SERVICE_HOME: base,
  PROMPTOBUS_WARDEN: 'off', PROMPTOBUS_SERVICE_IDLE_MS: '60000' };
for (const key of Object.keys(env)) if (/^(BB_|PROMPTOBUS_(CLIENT_|ROOT_|OWNER_ENV_FILE$|ROLE$|TASK$|.*_SESSION$))/.test(key)) delete env[key];
writeHostConfig(root, { tools: [] });
const nativeStore = path.join(root, 'native'); mkdirSync(nativeStore);
const host = createStandaloneHost({ cwd: root, binPath: bin, version }), paths = servicePaths(host, env), runtime = runtimeIdentity(host);
const native = path.join(root, 'synthetic-native.mjs'), output = path.join(root, 'result.json'), headerProbe = path.join(root, 'headers-state-probe.mjs');
const hookProbe = path.join(root, 'hook-observation-probe.mjs');
const headerSecurityProbe = path.join(root, 'headers-security-probe.mjs');
const actualId = randomUUID(), unknownId = randomUUID(), unknownNative = path.join(root, 'unknown-native.mjs');
const children = new Set();
const run = (file, args, extra = {}, input) => {
  const child = spawn(file, args, { cwd: root, env: { ...env, ...extra }, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  if (input !== undefined) child.stdin.end(input);
  children.add(child);
  let out = '', err = '';
  child.stdout.on('data', bytes => { out += bytes; }); child.stderr.on('data', bytes => { err += bytes; });
  return new Promise(resolve => child.once('close', (code, signal) => {
    children.delete(child); resolve({ code, signal, pid: child.pid, out, err });
  }));
};
const refused = async action => { try { await action(); return false; } catch { return true; } };
let ownerError;
const factories = [];
const running = runWorkspaceService({ host, env, createHost: async context => {
  factories.push(context);
  if (existsSync(path.join(root, 'hold-factory'))) {
    writeFileSync(path.join(root, 'factory-entered'), 'entered');
    while (!existsSync(path.join(root, 'release-factory'))) await new Promise(resolve => setTimeout(resolve, 10));
  }
  return createStandaloneHost({ cwd: context.cwd, binPath: bin, version });
} }).catch(error => { ownerError = error; });
try {
  const deadline = Date.now() + 5000;
  while (!readDiscovery(paths) && !ownerError && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  if (ownerError) throw ownerError;
  if (!readDiscovery(paths)) throw new Error('Owned standalone fixture service did not start');
  const input = { id: 'ordinary', harness: 'claude', nativeStore, executable: nativeExecutable };
  for (const mode of [0o720, 0o702]) {
    chmodSync(nativeExecutable, mode);
    check(`standalone approval refuses an owned executable with mode ${mode.toString(8)}`,
      await refused(() => approveStandaloneRootProfile(host, { ...input, id: 'writable-' + mode.toString(8) }, env)));
  }
  chmodSync(nativeExecutable, 0o700);
  const descriptor = await approveStandaloneRootProfile(host, input, env);
  const ownerHome = path.join(root, 'claude-owner-home'), actorHome = path.join(root, 'claude-actor-home');
  const defaultStore = path.join(ownerHome, '.claude'), customStore = path.join(root, 'claude-custom-store');
  const actorStore = path.join(actorHome, 'foreign-config');
  for (const directory of [defaultStore, customStore, actorStore]) mkdirSync(directory, { recursive: true });
  const ownerDefault = { ...env, HOME: ownerHome };
  delete ownerDefault.CLAUDE_CONFIG_DIR;
  const selectorNative = path.join(root, 'selector-native.mjs');
  writeFileSync(selectorNative, `import {readFileSync} from 'node:fs';
const launch=JSON.parse(readFileSync(process.env.PROMPTOBUS_ROOT_LAUNCH_FILE,'utf8'));
process.stdout.write(JSON.stringify({home:process.env.HOME,selector:process.env.CLAUDE_CONFIG_DIR??null,
 selectorPresent:Object.hasOwn(process.env,'CLAUDE_CONFIG_DIR'),pid:process.pid,launcherPid:launch.process.pid,
 profile:launch.profile,nativeId:launch.nativeId,phase:launch.phase}));
`);
  for (const account of [
    { id: 'claude-default', nativeStore: defaultStore, owner: ownerDefault, defaultRoute: true },
    { id: 'claude-explicit-default', nativeStore: defaultStore, owner: { ...ownerDefault, CLAUDE_CONFIG_DIR: defaultStore }, defaultRoute: false },
    { id: 'claude-custom', nativeStore: customStore, owner: ownerDefault, defaultRoute: false },
  ]) {
    await approveStandaloneRootProfile(host, { ...input, id: account.id, nativeStore: account.nativeStore }, account.owner);
    const profileFile = path.join(paths.directory, 'root-profile-' + account.id + '.json');
    const profileBytes = readFileSync(profileFile), profile = JSON.parse(profileBytes);
    const snapshotBytes = readFileSync(profile.ownerEnvironment);
    const executed = await run('/bin/sh', [wrapper, '--profile', account.id, '--service-home', base, '--', nativeExecutable, selectorNative],
      { HOME: actorHome, CLAUDE_CONFIG_DIR: actorStore });
    let selected = null;
    try { selected = JSON.parse(executed.out); } catch {}
    check(`Claude ${account.id} exec plan preserves the approved owner account selector against actor overrides`,
      executed.code === 0 && selected?.pid === executed.pid && selected.launcherPid === executed.pid
      && selected.profile === account.id && selected.nativeId === null && selected.phase === 'pending'
      && (account.defaultRoute ? selected.home === ownerHome && !selected.selectorPresent && selected.selector === null
        : selected.home === actorHome && selected.selectorPresent && selected.selector === realpathSync(account.nativeStore))
      && readFileSync(profileFile).equals(profileBytes) && readFileSync(profile.ownerEnvironment).equals(snapshotBytes)
      && readPrivate(path.join(paths.directory, 'native-admission.json')).bindings.length === 0 && factories.length === 0,
      JSON.stringify({ selected, error: executed.err }));
  }

  const outsideLaunch = path.join(root, 'outside-launch.json');
  writeFileSync(outsideLaunch, 'owned fixture target', { mode: 0o600 });
  const outsideBytes = readFileSync(outsideLaunch);
  check('standalone hook refuses an out-of-scope reference before creating a lock', await refused(() =>
    authorizeStandaloneRootStart(host, input.id, { hook_event_name: 'SessionStart', session_id: actualId },
      { ...env, PROMPTOBUS_ROOT_LAUNCH_FILE: outsideLaunch }))
    && !existsSync(outsideLaunch + '.lock') && readFileSync(outsideLaunch).equals(outsideBytes));
  const linkedLaunch = path.join(paths.directory, 'standalone-launch-' + randomUUID() + '.json');
  symlinkSync(outsideLaunch, linkedLaunch);
  check('standalone hook refuses a launch leaf symlink before creating a lock', await refused(() =>
    authorizeStandaloneRootStart(host, input.id, { hook_event_name: 'SessionStart', session_id: actualId },
      { ...env, PROMPTOBUS_ROOT_LAUNCH_FILE: linkedLaunch }))
    && !existsSync(linkedLaunch + '.lock') && readFileSync(outsideLaunch).equals(outsideBytes));
  rmSync(linkedLaunch);
  check('standalone approval returns the harness native helper and ordered hook without credentials', descriptor.mode === 'standalone'
    && descriptor.server.type === 'http' && descriptor.server.headersHelper.includes('--standalone')
    && descriptor.startHook.command.includes('--standalone-profile') && !JSON.stringify(descriptor).includes('Bearer'));
  const plan = planHookInstall(host, root, ['claude'], { rootProfile: descriptor });
  const hooks = JSON.parse(plan.writes.find(write => write.rel === path.join('.claude', 'settings.json')).text).hooks;
  check('standalone Claude uses exactly one ordered admission/start guard and keeps ordinary Stop', hooks.SessionStart.length === 1
    && hooks.SessionStart[0].hooks[0].command === descriptor.startHook.command && !hooks.Stop[0].hooks[0].command.includes('--standalone-profile'));
  check('unsupported script chains refuse approval without an inferred native profile', await refused(() =>
    approveStandaloneRootProfile(host, { ...input, id: 'cursor', harness: 'cursor' }, env)));
  check('a profile cannot switch its approved native store', await refused(() =>
    approveStandaloneRootProfile(host, { ...input, nativeStore: root }, env)));
  const before = readdirSync(paths.directory, { recursive: true }).sort();
  const preview = await standaloneRootExecPlan(host, input.id, { file: nativeExecutable, args: [native] }, { env, dryRun: true });
  check('standalone dry-run does not reserve a generation or write an exec plan', preview.nativeAuthorization === 'notRun'
    && JSON.stringify(before) === JSON.stringify(readdirSync(paths.directory, { recursive: true }).sort()));
  check('a non-parent shell cannot register another process as its launcher', await refused(() =>
    standaloneRootExecPlan(host, input.id, { file: nativeExecutable, args: [native] }, { env, launcherPid: process.pid })));
  // Inject only the helper's parsed input; a malformed live grant file would also exercise the owner's independent sweep.
  writeFileSync(headerProbe, `const parse=JSON.parse,state=parse(process.env.PB_HEADER_STATE),client=process.env.PB_HEADER_CLIENT;
JSON.parse=function(source,...args){const value=parse(source,...args);return value?.schemaVersion===1&&value.id===client&&typeof value.token==='string'&&value.nativeBinding?
{...value,nativeBinding:{...value.nativeBinding,state}}:value;};\n`);
  writeFileSync(headerSecurityProbe, `import fs from 'node:fs';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const probe=process.env.PB_HEADER_CASE,parse=JSON.parse;
JSON.parse=function(source,...args){const value=parse(source,...args);
 if(value?.schemaVersion===1&&value.nonce===process.env.PB_HEADER_NONCE){
  if(probe==='revoked')return {...value,revoked:true};
  if(probe==='expired')return {...value,expiresAt:0};
  if(probe==='foreign-runtime')return {...value,runtime:value.runtime+'-foreign'};
  if(probe==='foreign-profile')return {...value,profile:'foreign'};
  if(probe==='foreign-cwd')return {...value,cwd:'/'};
 }
 if(probe==='unknown-birth'&&value?.id===process.env.PB_HEADER_CLIENT&&value.lifetime?.process)
  return {...value,lifetime:{...value.lifetime,process:{...value.lifetime.process,birth:'unknown-fixture-birth'}}};
 return value;};
const readdir=fs.readdirSync;
if(probe==='missing')fs.readdirSync=function(file,...args){const names=readdir.call(this,file,...args);
 return file===process.env.PB_HEADER_CLIENTS?names.filter(name=>name!==process.env.PB_HEADER_CLIENT+'.json'):names;};
if(probe==='unknown-process'){
 const readFile=fs.promises.readFile;
 fs.promises.readFile=async function(file,...args){
  if(file==='/proc/'+process.ppid+'/stat')throw Object.assign(new Error('Owned native stat observation unavailable'),{code:'EACCES'});
  return readFile.call(this,file,...args);
 };
}
const spawn=cp.spawn;let changed=false;
cp.spawn=function(file,args,...rest){
 if(probe==='unknown-process'&&file==='/bin/ps')return spawn.call(this,'/usr/bin/false',[],...rest);
 const child=spawn.call(this,file,args,...rest);
 if(probe==='changed-credential'&&file==='/usr/bin/osascript'&&args.at(-1)===String(process.ppid)){
  const emit=child.emit;child.emit=function(event,...values){
   if(event==='close'&&values[0]===0&&!changed){changed=true;fs.appendFileSync(process.env.PB_HEADER_CREDENTIAL,'\\n');}
   return emit.call(this,event,...values);};
 }
 return child;};
if(probe==='changed-credential'&&process.platform==='linux'){
 const readlink=fs.promises.readlink;fs.promises.readlink=async function(file,...args){const value=await readlink.call(this,file,...args);
  if(file==='/proc/'+process.ppid+'/exe'&&!changed){changed=true;fs.appendFileSync(process.env.PB_HEADER_CREDENTIAL,'\\n');}return value;};
}
syncBuiltinESMExports();
`);
  writeFileSync(hookProbe, `import fs from 'node:fs';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const role=process.env.PB_HOOK_ROLE,launch=process.env.PROMPTOBUS_ROOT_LAUNCH_FILE;
const observed=launch+'.observed',released=launch+'.released',timedOut=launch+'.timed-out';
const release=value=>{if(!fs.existsSync(released))fs.writeFileSync(released,JSON.stringify(value));};
if(role==='fast'){
 const mkdir=fs.mkdirSync,rename=fs.renameSync;
 fs.mkdirSync=function(file,...args){try{return mkdir.call(this,file,...args);}catch(error){
  if(file===launch+'.lock'&&error.code==='EEXIST')release({kind:'lock-contention'});throw error;}};
 fs.renameSync=function(from,to,...args){const value=rename.call(this,from,to,...args);
  if(to===launch){const current=JSON.parse(fs.readFileSync(launch));release({kind:'launch-published',nativeId:current.nativeId});
   if(current.revoked&&current.identityInvalid&&!fs.existsSync(launch+'.sweep')){
    const status=cp.spawnSync(process.execPath,[process.argv[1],'service','status','--json'],{env:process.env,encoding:'utf8'});
    const directory=launch.replace(/[^/]+$/,'');
    fs.writeFileSync(launch+'.sweep',JSON.stringify({statusExit:status.status,credentialAbsent:!fs.existsSync(directory+'clients/'+current.clientId+'.json'),
     revocationMarker:fs.existsSync(directory+'standalone-revoked-'+current.clientId+'.json')}));
   }}return value;};
}
let held=false;
const pause=async image=>{
 if(held)return;held=true;fs.writeFileSync(observed,JSON.stringify({nativePid:process.ppid,image}));
 const deadline=Date.now()+1000;
 while(!fs.existsSync(released)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
 if(!fs.existsSync(released))fs.writeFileSync(timedOut,'timeout');
};
if(role==='slow'&&process.platform==='darwin'){
 const spawn=cp.spawn;
 cp.spawn=function(file,args,...rest){const child=spawn.call(this,file,args,...rest);
  if(file==='/usr/bin/osascript'&&args.at(-1)===String(process.ppid)&&!held){
   let image='';child.stdout.on('data',bytes=>{image+=bytes});const emit=child.emit;
   child.emit=function(event,...values){if(event==='close'&&values[0]===0&&!held){
    void pause(image.trim()).then(()=>emit.call(this,event,...values));return true;}return emit.call(this,event,...values);};
  }return child;};
}
if(role==='slow'&&process.platform==='linux'){
 const readlink=fs.promises.readlink;
 fs.promises.readlink=async function(file,...args){const value=await readlink.call(this,file,...args);
  if(file==='/proc/'+process.ppid+'/exe')await pause(String(value));return value;};
}
syncBuiltinESMExports();
`);
  writeFileSync(native, `import {existsSync,readFileSync,writeFileSync,readdirSync,mkdirSync,unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {shellQuote} from ${JSON.stringify(fileURLToPath(new URL('dist/fs/shell.js', selectedRuntime)))};
import {spawn} from 'node:child_process';
import {serviceControl} from ${JSON.stringify(fileURLToPath(new URL('lib/service-client.js', selectedRuntime)))};
import {readPrivate,writePrivate} from ${JSON.stringify(fileURLToPath(new URL('lib/service-state.js', selectedRuntime)))};
const [output,bin,profile,actualId,...literal]=process.argv.slice(2);
const launch=JSON.parse(readFileSync(process.env.PROMPTOBUS_ROOT_LAUNCH_FILE));
const directory=process.env.PROMPTOBUS_ROOT_LAUNCH_FILE.replace(/[^/]+$/,'');
const headerEnv=Object.fromEntries(['HOME','LOGNAME','PATH','SHELL','USER','__CF_USER_TEXT_ENCODING','LANG','LC_ALL','TERM','TMPDIR','TZ']
 .filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
const preHeaderLaunch=readFileSync(process.env.PROMPTOBUS_ROOT_LAUNCH_FILE,'utf8');
const preHeaderCredential=readFileSync(directory+'clients/'+launch.clientId+'.json','utf8');
const preHeaderLedger=readFileSync(directory+'native-admission.json','utf8');
const headerCommand=${JSON.stringify(descriptor.server.headersHelper)};
const cleanHeaders=(extra={},route='default')=>new Promise(resolve=>{
 const helperArgs=[bin,'service','headers','--standalone','--profile',profile,'--service-home',process.env.PROMPTOBUS_SERVICE_HOME];
 const retainedShell=headerCommand+'; header_status=$?; exit "$header_status"';
 const nested='/bin/sh -c '+shellQuote(retainedShell)+'; header_status=$?; exit "$header_status"';
 const foreignCode='import {spawn} from "node:child_process";const p=spawn("/bin/sh",["-c",'+JSON.stringify(headerCommand)+'],{stdio:"inherit"});p.once("close",code=>{process.exitCode=code??1});';
 const file=route==='direct'?${JSON.stringify(process.execPath)}:route==='foreign-parent'?process.execPath:'/bin/sh';
 const args=route==='direct'?helperArgs:route==='foreign-parent'?['--input-type=module','-e',foreignCode]:['-c',route==='shell'?retainedShell:route==='nested-shell'?nested:headerCommand];
 const child=spawn(file,args,{env:{...headerEnv,...extra},stdio:['ignore','pipe','pipe']});
 let out='',error='';child.stdout.on('data',bytes=>{out+=bytes});child.stderr.on('data',bytes=>{error+=bytes});
 child.once('close',code=>{let matches=false;try{matches=JSON.parse(out).Authorization==='Bearer '+JSON.parse(preHeaderCredential).token;}catch{}
 resolve({code,error:error.split('\\n')[0],matches,referenceAbsent:!Object.hasOwn(headerEnv,'PROMPTOBUS_ROOT_LAUNCH_FILE'),codexHomeAbsent:!Object.hasOwn(headerEnv,'CODEX_HOME'),
 retained:readFileSync(process.env.PROMPTOBUS_ROOT_LAUNCH_FILE,'utf8')===preHeaderLaunch&&readFileSync(directory+'clients/'+launch.clientId+'.json','utf8')===preHeaderCredential
 &&readFileSync(directory+'native-admission.json','utf8')===preHeaderLedger});});
});
const sanitizedHeaders=await cleanHeaders();
const headerControls=[];
if(literal.length){
 for(const route of ['direct','shell','nested-shell','foreign-parent'])headerControls.push({name:route,...await cleanHeaders({},route)});
 for(const [name,reference] of [['explicit-empty',''],['explicit-missing',directory+'standalone-launch-'+randomUUID()+'.json'],['explicit-foreign','/outside/standalone-launch-'+randomUUID()+'.json']])
  headerControls.push({name,...await cleanHeaders({PROMPTOBUS_ROOT_LAUNCH_FILE:reference})});
 for(const probe of ['missing','revoked','expired','foreign-runtime','foreign-profile','foreign-cwd','unknown-birth','unknown-process','changed-credential']){
  const extra={NODE_OPTIONS:'--import '+${JSON.stringify(headerSecurityProbe)},PB_HEADER_CASE:probe,PB_HEADER_NONCE:launch.nonce,
   PB_HEADER_CLIENT:launch.clientId,PB_HEADER_CLIENTS:directory+'clients',PB_HEADER_CREDENTIAL:directory+'clients/'+launch.clientId+'.json',
   ...(probe==='changed-credential'?{PROMPTOBUS_ROOT_LAUNCH_FILE:process.env.PROMPTOBUS_ROOT_LAUNCH_FILE}:{})};
  const result=await cleanHeaders(extra,'direct');
  if(probe==='changed-credential'){
   result.actualRevisionChanged=readFileSync(extra.PB_HEADER_CREDENTIAL,'utf8')!==preHeaderCredential;
   writeFileSync(extra.PB_HEADER_CREDENTIAL,preHeaderCredential,{mode:0o600});
   result.restored=readFileSync(extra.PB_HEADER_CREDENTIAL,'utf8')===preHeaderCredential;
  }
  headerControls.push({name:probe,...result});
 }
 const nonce=randomUUID(),clientId=randomUUID(),file=directory+'standalone-launch-'+nonce+'.json',credential=directory+'clients/'+clientId+'.json';
 try{
  writePrivate(file,{...launch,nonce,clientId,plan:null});
  writePrivate(credential,{...JSON.parse(preHeaderCredential),id:clientId,rootLaunch:{file,nonce}});
  headerControls.push({name:'multiple-current',...await cleanHeaders()});
 }finally{unlinkSync(credential);unlinkSync(file);}
}
const ledgerFile=directory+'native-admission.json',ledger=readPrivate(ledgerFile);
writePrivate(ledgerFile,{...ledger,bindings:[...ledger.bindings,{harness:'claude',nativeStore:${JSON.stringify(nativeStore)},nativeId:actualId,
 source:'standalone',runtime:launch.runtime,ownerKey:launch.nonce,process:launch.process,nonce:launch.nonce,profile,phase:'pending'}]});
let grant=JSON.parse(readFileSync(directory+'clients/'+launch.clientId+'.json'));
const oldGrant=grant;
const discovery=JSON.parse(readFileSync(directory+'service.json'));
const paths=${JSON.stringify(paths)};
let sequence=0,session;
async function rpc(method,params={},notification=false){
 const response=await fetch(discovery.url+'mcp/bus',{method:'POST',headers:{authorization:'Bearer '+grant.token,
 accept:'application/json, text/event-stream','content-type':'application/json',...(session?{'mcp-session-id':session,'mcp-protocol-version':'2025-06-18'}:{})},
 body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id:++sequence}),method,params})});
 const body=await response.text();return {status:response.status,session:response.headers.get('mcp-session-id'),body};
}
const initialized=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'owned-synthetic',version:'1'}});
session=initialized.session;
await rpc('notifications/initialized',{},true);
const before=await rpc('tools/call',{name:'promptobus_status',arguments:{}});
const headers=(state)=>new Promise(resolve=>{
 const child=spawn(${JSON.stringify(process.execPath)},[...(state===undefined?[]:['--import',${JSON.stringify(headerProbe)}]),bin,'service','headers','--standalone','--profile',profile,'--service-home',process.env.PROMPTOBUS_SERVICE_HOME],
 {env:{...process.env,...(state===undefined?{}:{PB_HEADER_STATE:JSON.stringify(state),PB_HEADER_CLIENT:grant.id})},stdio:['ignore','ignore','pipe']});
 let error='';child.stderr.on('data',bytes=>{error+=bytes});child.once('close',code=>resolve({code,error}));
});
const pendingHeaders=await headers(),credential=directory+'clients/'+grant.id+'.json',originalCredential=readFileSync(credential,'utf8');
const corruptHeaders=[];
for(const state of [['pending'],['bound'],{value:'pending'},null]){
 corruptHeaders.push({...await headers(state),retained:readFileSync(credential,'utf8')===originalCredential});
}
const hook=(role)=>new Promise(resolve=>{
 const child=spawn(${JSON.stringify(process.execPath)},['--import',${JSON.stringify(hookProbe)},bin,'guard','--standalone-profile',profile,'--service-home',process.env.PROMPTOBUS_SERVICE_HOME],{env:{...process.env,PB_HOOK_ROLE:role},stdio:['pipe','ignore','pipe']});
 let error='';child.stderr.on('data',bytes=>{error+=bytes});child.once('close',code=>resolve({code,error}));
 child.stdin.end(JSON.stringify({hook_event_name:'SessionStart',session_id:actualId,cwd:process.cwd()}));
});
const slowHook=hook('slow'),observedFile=process.env.PROMPTOBUS_ROOT_LAUNCH_FILE+'.observed';
const observationDeadline=Date.now()+1000;
while(!existsSync(observedFile)&&Date.now()<observationDeadline)await new Promise(resolve=>setTimeout(resolve,5));
const hooks=await Promise.all([slowHook,hook('fast')]);
const race={observed:existsSync(observedFile)?JSON.parse(readFileSync(observedFile)):null,
 released:existsSync(process.env.PROMPTOBUS_ROOT_LAUNCH_FILE+'.released')?JSON.parse(readFileSync(process.env.PROMPTOBUS_ROOT_LAUNCH_FILE+'.released')):null,
 timedOut:existsSync(process.env.PROMPTOBUS_ROOT_LAUNCH_FILE+'.timed-out')};
const cliPreflight=()=>new Promise(resolve=>{
 const child=spawn(${JSON.stringify(process.execPath)},[bin,'service','preflight','--standalone','--profile',profile,'--native-id',actualId,'--service-home',process.env.PROMPTOBUS_SERVICE_HOME],{stdio:['ignore','pipe','pipe']});
 let out='',error='';child.stdout.on('data',bytes=>{out+=bytes});child.stderr.on('data',bytes=>{error+=bytes});
 child.once('close',code=>resolve({code,out,error}));
});
writeFileSync('hold-factory','hold');
const pending=rpc('tools/call',{name:'promptobus_status',arguments:{}});
while(!existsSync('factory-entered'))await new Promise(resolve=>setTimeout(resolve,10));
const inFlight=await cliPreflight();
writeFileSync('release-factory','release');
const after=await pending;
await serviceControl(paths,{operation:'revoke',runtime:launch.runtime,clientId:oldGrant.id});
const oldDenied=await rpc('tools/call',{name:'promptobus_status',arguments:{}});
const recovery=await Promise.all([cliPreflight(),cliPreflight()]);
const current=JSON.parse(readFileSync(process.env.PROMPTOBUS_ROOT_LAUNCH_FILE));
grant=JSON.parse(readFileSync(directory+'clients/'+current.clientId+'.json'));
const newId=grant.id;session=undefined;
const reconnect=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'recovered',version:'1'}});session=reconnect.session;
await rpc('notifications/initialized',{},true);
const recoveredTool=await rpc('tools/call',{name:'promptobus_status',arguments:{}});
const receiptDir=directory+'requests/root-'+launch.nonce+'/'+session;mkdirSync(receiptDir,{recursive:true});
writeFileSync(receiptDir+'/'+'a'.repeat(64)+'.json',JSON.stringify({digest:'uncertain-owned-test',state:'started',readOnly:false}),{mode:0o600});
await serviceControl(paths,{operation:'revoke',runtime:launch.runtime,clientId:newId});
const uncertain=await cliPreflight();
const result={pid:process.pid,cwd:process.cwd(),literal,before:before.status,after:after.status,hooks,race,sanitizedHeaders,headerControls,pendingHeaders,corruptHeaders,
 inFlight,oldDenied:oldDenied.status,recovery,newIdChanged:newId!==oldGrant.id,recoveredTool:recoveredTool.status,uncertain,
 receiptRetained:existsSync(receiptDir+'/'+'a'.repeat(64)+'.json'),
 inherited:process.env.CLAUDE_CODE_SESSION_ID??null,clientToken:process.env.PROMPTOBUS_CLIENT_TOKEN??null,
 plans:readdirSync(directory).filter(name=>/^exec-.*\\.sh$/.test(name)).length};
writeFileSync(output,JSON.stringify(result));
`);
  writeFileSync(unknownNative, `import{spawn}from'node:child_process';
const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(bin)},'guard','--standalone-profile','ordinary','--service-home',process.env.PROMPTOBUS_SERVICE_HOME],{stdio:['pipe','ignore','pipe']});
child.stderr.pipe(process.stderr);
child.stdin.end(JSON.stringify({hook_event_name:'SessionStart',session_id:${JSON.stringify(unknownId)},cwd:process.cwd()}));
process.exitCode=await new Promise(resolve=>child.once('close',code=>resolve(code??1)));
`);
  const lookup = path.join(root, 'pending-reference.mjs');
  writeFileSync(lookup, `import{readdirSync,readFileSync}from'node:fs';import path from'node:path';
for(const name of readdirSync(process.argv[2])){if(!/^standalone-launch-.*\\.json$/.test(name))continue;
const file=path.join(process.argv[2],name),value=JSON.parse(readFileSync(file));
if(value.process.pid===Number(process.argv[3]))process.stdout.write(file);}\n`);
  const premature = path.join(root, 'before-exec.sh');
  writeFileSync(premature, `#!/bin/sh
plan=$(exec "$PB_NODE" "$PB_BIN" service exec-plan --launcher-pid "$$" --profile ordinary --service-home "$PB_BASE" -- "$PB_NATIVE_NODE" "$PB_NATIVE") || exit $?
reference=$("$PB_NODE" "$PB_LOOKUP" "$PB_DIRECTORY" "$$") || exit $?
PROMPTOBUS_ROOT_LAUNCH_FILE="$reference" "$PB_NODE" "$PB_BIN" guard --standalone-profile ordinary --service-home "$PB_BASE" <<'EVENT'
{"hook_event_name":"SessionStart","session_id":"premature-before-exec"}
EVENT
result=$?
/bin/rm -f -- "$plan"
exit "$result"
`);
  for (const file of [headerProbe, headerSecurityProbe, native, unknownNative, lookup]) {
    check('every generated native/helper JavaScript variant parses before use', spawnSync(process.execPath, ['--check', file]).status === 0, file);
  }
  check('generated premature-hook shell variant parses before use', spawnSync('/bin/sh', ['-n', premature]).status === 0);
  const observerInput = spawnSync(process.execPath, ['--import', headerSecurityProbe, '--input-type=module', '-e', `
import {readFile} from 'node:fs/promises';
let exact=false,neighbor=false;
try{await readFile('/proc/'+process.ppid+'/stat');}catch(error){exact=error.code==='EACCES';}
try{await readFile('/proc/'+process.ppid+'/stat-not-target');}catch(error){neighbor=error.code==='ENOENT';}
const owned=await readFile(${JSON.stringify(outsideLaunch)},'utf8')==='owned fixture target';
process.stdout.write(JSON.stringify({exact,neighbor,owned}));
`], { env: { ...env, PB_HEADER_CASE: 'unknown-process' }, encoding: 'utf8' });
  check('unknown-process fixture faults only the exact parent proc stat through the real async read binding',
    observerInput.status === 0 && observerInput.stdout === JSON.stringify({ exact: true, neighbor: true, owned: true }), observerInput.stderr || observerInput.stdout);

  const beforeExec = await run('/bin/sh', [premature], { PB_NODE: process.execPath, PB_NATIVE_NODE: nativeExecutable, PB_BIN: bin, PB_BASE: base,
    PB_NATIVE: native, PB_LOOKUP: lookup, PB_DIRECTORY: paths.directory });
  check('a hook from the registered shell before native exec cannot realize or create an actor', beforeExec.code !== 0
    && factories.length === 0 && readPrivate(path.join(paths.directory, 'native-admission.json')).bindings.length === 0
    && readdirSync(paths.directory).filter(name => /^standalone-launch-.*\.json$/.test(name)).every(name =>
      readPrivate(path.join(paths.directory, name)).nativeId === null), beforeExec.err);
  const unknownNativeResult = await run('/bin/sh', [wrapper, '--profile', input.id, '--service-home', base, '--', nativeExecutable, unknownNative]);
  check('an actual new-process hook identity alone cannot create the first native binding', unknownNativeResult.code !== 0
    && /creation proof is unavailable/.test(unknownNativeResult.err) && factories.length === 0
    && readPrivate(path.join(paths.directory, 'native-admission.json')).bindings.length === 0, unknownNativeResult.err);
  // The remaining HTTP/recovery cases seed a known binding, not a fresh-native proof.
  const executed = await run('/bin/sh', [wrapper, '--profile', input.id, '--service-home', base, '--', nativeExecutable,
    native, output, bin, input.id, actualId, 'literal $(touch NEVER)', ''], {
    CLAUDE_CODE_SESSION_ID: 'inherited-hint', PROMPTOBUS_CLIENT_TOKEN: 'inherited-token',
  });
  check('fixture-seeded known native handoff exits through the launcher', executed.code === 0 && existsSync(output), executed.err);
  const result = existsSync(output) ? JSON.parse(readFileSync(output)) : {};
  check('actual exec retains PID cwd literal argv and removes private plan before native code', result.pid === executed.pid && result.cwd === root
    && JSON.stringify(result.literal) === JSON.stringify(['literal $(touch NEVER)', '']) && result.plans === 0 && !existsSync(path.join(root, 'NEVER')));
  check('inherited native hints and client bearer are stripped from the new native process', result.inherited === null && result.clientToken === null);
  check('sanitized MCP headers resolve only the already owned pending native launch without creating identity',
    result.sanitizedHeaders?.code === 0 && result.sanitizedHeaders.matches && result.sanitizedHeaders.referenceAbsent
    && result.sanitizedHeaders.codexHomeAbsent && result.sanitizedHeaders.retained, JSON.stringify(result.sanitizedHeaders));
  const headerRefusals = {
    'nested-shell': /native command ancestry changed/, 'foreign-parent': /exactly one current owned native launch/,
    'explicit-empty': /requires its owned launcher reference/, 'explicit-missing': /ENOENT: no such file or directory, stat .*standalone-launch-/,
    'explicit-foreign': /launch reference escaped its owner scope/, missing: /exactly one current owned native launch/,
    revoked: /admission expired or was revoked/, expired: /admission expired or was revoked/,
    'foreign-runtime': /launch generation is missing or changed/, 'foreign-profile': /exactly one current owned native launch/,
    'foreign-cwd': /credential does not match its owned native generation/, 'unknown-birth': /exactly one current owned native launch/,
    'unknown-process': /native parent identity is unavailable/, 'changed-credential': /owned generation changed during observation/,
    'multiple-current': /exactly one current owned native launch/,
  };
  for (const control of result.headerControls ?? []) {
    const positive = ['direct', 'shell'].includes(control.name), changed = control.name === 'changed-credential';
    check(`sanitized headers ${control.name}: exact native ancestry and generation remain required`,
      (positive ? control.code === 0 && control.matches : control.code !== 0 && !control.matches && headerRefusals[control.name]?.test(control.error))
      && (changed ? control.actualRevisionChanged && control.restored : control.retained), JSON.stringify(control));
  }
  check('native headers accept primitive pending state but refuse nonprimitive credential states without rewriting them',
    result.pendingHeaders?.code === 0 && result.corruptHeaders?.length === 4
    && result.corruptHeaders.every(receipt => receipt.code !== 0 && receipt.retained && /absent or revoked/.test(receipt.error)),
    JSON.stringify(result.corruptHeaders));
  check('concurrent hooks cross an actual native-image observation and owned publication or lock boundary',
    result.race?.observed?.nativePid === result.pid && result.race.observed.image === realpathSync(nativeExecutable)
    && result.race.timedOut === false && ['lock-contention','launch-published'].includes(result.race.released?.kind), JSON.stringify(result.race));
  check('same-generation native observation starts only after its existing hook lock is held',
    result.race?.released?.kind === 'lock-contention', JSON.stringify(result.race));
  check('known binding stays pending before its hook and exact concurrent hooks bind idempotently', result.before === 403
    && result.hooks?.length === 2 && result.hooks.every(hook => hook.code === 0) && result.after === 200, JSON.stringify({hooks:result.hooks,race:result.race}));
  check('capability recovery refuses while an old-token mutation is in flight', result.inFlight?.code !== 0
    && /in flight/.test(result.inFlight?.error ?? ''), result.inFlight?.error);
  check('explicit concurrent owner preflight restores one capability on the same native process', result.oldDenied === 401
    && result.recovery?.every(receipt => receipt.code === 0) && result.newIdChanged && result.recoveredTool === 200, JSON.stringify(result.recovery));
  check('an unknown mutation survives session removal and blocks new capability recovery', result.uncertain?.code !== 0
    && /uncertain/.test(result.uncertain?.error ?? '') && result.receiptRetained, result.uncertain?.error);
  check('actor factories receive only the actual hook ID after realization and recovery', factories.length === 2
    && factories.every(context => context.env.CLAUDE_CODE_SESSION_ID === actualId));
  const conflictingNative = path.join(root, 'conflicting-native.mjs'), conflictOutput = path.join(root, 'conflict.json'), conflictId = randomUUID();
  let conflictScript = readFileSync(native, 'utf8').split('const cliPreflight=')[0];
  conflictScript = conflictScript.replace('session_id:actualId', "session_id:role==='fast'?'different-'+actualId:actualId");
  writeFileSync(conflictingNative, conflictScript + `const retained=readPrivate(process.env.PROMPTOBUS_ROOT_LAUNCH_FILE);
const denied=await rpc('tools/call',{name:'promptobus_status',arguments:{}});
writeFileSync(output,JSON.stringify({hooks,race,clientId:retained.clientId,oldTokenStatus:denied.status,nativeId:retained.nativeId,revoked:retained.revoked,identityInvalid:retained.identityInvalid,sweep:existsSync(process.env.PROMPTOBUS_ROOT_LAUNCH_FILE+'.sweep')?JSON.parse(readFileSync(process.env.PROMPTOBUS_ROOT_LAUNCH_FILE+'.sweep')):null}));
`);
  const conflictRun = await run('/bin/sh', [wrapper, '--profile', input.id, '--service-home', base, '--', nativeExecutable,
    conflictingNative, conflictOutput, bin, input.id, conflictId]);
  const conflict = existsSync(conflictOutput) ? JSON.parse(readFileSync(conflictOutput)) : null;
  check('a concurrent different native hook identity refuses and revokes without replacing the first binding',
    conflictRun.code === 0 && conflict?.hooks[0].code === 0 && conflict.hooks[1].code !== 0
    && /cannot change its bound/.test(conflict.hooks[1].error) && conflict.nativeId === conflictId
    && conflict.revoked === true && conflict.identityInvalid === true && factories.length === 2
    && conflict.sweep?.statusExit === 0 && conflict.sweep.credentialAbsent && conflict.sweep.revocationMarker && conflict.oldTokenStatus === 401,
    JSON.stringify({ conflict, error: conflictRun.err }));
  const repeatedRevoke = await serviceControl(paths, { operation: 'revoke', runtime, clientId: conflict.clientId }).catch(error => ({ error: error.message }));
  check('an owner revoke of the exact already removed client returns the usual acknowledgement',
    repeatedRevoke.clientId === conflict.clientId && repeatedRevoke.operation === 'revoke');
  const deniedControl = async input => { try { await serviceControl(paths, input); return null; } catch (error) { return error.message; } };
  check('missing clients still refuse bind and realize instead of creating authority',
    (await Promise.all(['bind', 'realize'].map(operation => deniedControl({ operation, runtime, clientId: conflict.clientId }))))
      .every(message => message === 'Client binding not found'));
  check('idempotent missing-client revoke still requires current runtime and exact client ID',
    await deniedControl({ operation: 'revoke', runtime: runtime + '-foreign', clientId: conflict.clientId }) === 'Owner request belongs to a different shared service runtime'
    && await deniedControl({ operation: 'revoke', runtime, clientId: '../foreign' }) === 'Invalid client id');
  const deferredStart = async mode => {
    const deferredId = randomUUID(), deferredOutput = path.join(root, `deferred-start-${mode}.json`);
    const deferredTranscript = path.join(nativeStore, 'projects', `future-${mode}`, `${deferredId}.jsonl`);
    const deferredNative = `(async()=>{
const {spawn}=await import('node:child_process');
const {existsSync,readFileSync,writeFileSync,mkdirSync,symlinkSync}=await import('node:fs');
const launchFile=process.env.PROMPTOBUS_ROOT_LAUNCH_FILE;
const launch=JSON.parse(readFileSync(launchFile)),directory=launchFile.replace(/[^/]+$/,'');
const grant=JSON.parse(readFileSync(directory+'clients/'+launch.clientId+'.json'));
const discovery=JSON.parse(readFileSync(directory+'service.json'));
const transcript=${JSON.stringify(deferredTranscript)},nativeId=${JSON.stringify(deferredId)},output=${JSON.stringify(deferredOutput)},mode=${JSON.stringify(mode)};
if(mode==='symlink'){const link=transcript.replace(/[^/]+$/,'').slice(0,-1);mkdirSync(link.replace(/[^/]+$/,''),{recursive:true});symlinkSync(${JSON.stringify(path.join(root, 'foreign-future'))},link);}
const hook=await new Promise(resolve=>{
 const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(bin)},'guard','--standalone-profile','ordinary','--service-home',process.env.PROMPTOBUS_SERVICE_HOME],{stdio:['pipe','ignore','pipe']});
 let error='';child.stderr.on('data',bytes=>{error+=bytes});child.once('close',code=>resolve({code,error}));
 child.stdin.end(JSON.stringify({hook_event_name:'SessionStart',source:'startup',session_id:nativeId,transcript_path:transcript,cwd:process.cwd()}));
});
let session,sequence=0;
async function rpc(method,params={},notification=false){
 const response=await fetch(discovery.url+'mcp/bus',{method:'POST',headers:{authorization:'Bearer '+grant.token,
 accept:'application/json, text/event-stream','content-type':'application/json',...(session?{'mcp-session-id':session,'mcp-protocol-version':'2025-06-18'}:{})},
 body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id:++sequence}),method,params})});
 return {status:response.status,session:response.headers.get('mcp-session-id'),body:await response.text()};
}
const ledger=()=>JSON.parse(readFileSync(directory+'native-admission.json')).bindings;
const binding=()=>existsSync(directory+'clients/'+launch.clientId+'.json')?JSON.parse(readFileSync(directory+'clients/'+launch.clientId+'.json')).nativeBinding:null;
const result={hook,pid:process.pid,launcherPid:launch.process.pid,args:launch.nativeCommand.args,launchFile,
 absent:mode==='symlink'||(!existsSync(transcript)&&!existsSync(transcript.replace(/[^/]+$/,''))),launch:JSON.parse(readFileSync(launchFile))};
if(hook.code===0){
 const initialized=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'deferred-start',version:'1'}});
 session=initialized.session;await rpc('notifications/initialized',{},true);
 result.initialize=initialized.status;result.list=(await rpc('tools/list')).status;
 result.before=await rpc('tools/call',{name:'promptobus_status',arguments:{}});
 result.pending=JSON.parse(readFileSync(launchFile));result.binding=binding();result.ledger=ledger().length;
 writeFileSync(output+'.ready',JSON.stringify(result));
 const deadline=Date.now()+5000;
 while(!existsSync(output+'.release')&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
 if(!existsSync(output+'.release'))throw new Error('Deferred fixture publication was not released');
 result.expiredList=(await rpc('tools/list')).status;
 result.expiredBefore=await rpc('tools/call',{name:'promptobus_status',arguments:{}});
 mkdirSync(transcript.replace(/[^/]+$/,''),{recursive:true});writeFileSync(transcript,JSON.stringify({sessionId:nativeId})+'\\n',{mode:0o600});
 result.after=await rpc('tools/call',{name:'promptobus_status',arguments:{}});
 result.final=JSON.parse(readFileSync(launchFile));result.finalBinding=binding();result.finalLedger=ledger();
}
writeFileSync(output,JSON.stringify(result));
})().catch(error=>{process.stderr.write(error.stack);process.exitCode=1});`;
    const deferredFactories = factories.length, deferredLedger = readPrivate(path.join(paths.directory, 'native-admission.json')).bindings.length;
    const deferredRun = run('/bin/sh', [wrapper, '--profile', input.id, '--service-home', base, '--', nativeExecutable], {}, deferredNative);
    const deferredDeadline = Date.now() + 5000;
    while (!existsSync(deferredOutput + '.ready') && !existsSync(deferredOutput) && Date.now() < deferredDeadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const before = existsSync(deferredOutput + '.ready') ? JSON.parse(readFileSync(deferredOutput + '.ready')) : null;
    const candidate = before?.pending?.startupCandidate;
    let launch = null;
    if (candidate && ['positive', 'forged'].includes(mode)) {
      launch = readPrivate(before.launchFile);
      writePrivate(before.launchFile, mode === 'forged'
        ? { ...launch, expiresAt: candidate.capturedAt - 1 } : { ...launch, expiresAt: candidate.capturedAt + 1 });
      while (Date.now() <= candidate.capturedAt + 1) await new Promise(resolve => setTimeout(resolve, 5));
    }
    const drifted = { 'owner-drift': candidate?.revisions[1].file, 'profile-drift': candidate?.revisions[0].file }[mode];
    if (drifted) writePrivate(drifted, readPrivate(drifted));
    writeFileSync(deferredOutput + '.release', 'publish');
    const exit = await deferredRun;
    const result = existsSync(deferredOutput) ? JSON.parse(readFileSync(deferredOutput)) : null;
    if (mode === 'forged' && launch) writePrivate(before.launchFile, launch);
    return { deferredId, deferredFactories, deferredLedger, before, candidate, exit, result,
      evidence: JSON.stringify({ before, result, error: exit.err }) };
  };
  const positive = await deferredStart('positive');
  check('actual fresh Claude startup before transcript publication stays pending without actor or native admission',
    positive.before?.hook.code === 0 && positive.before.absent && positive.before.pid === positive.before.launcherPid
      && positive.before.args.length === 0 && positive.before.initialize === 200 && positive.before.list === 200
      && positive.before.before.status === 403 && positive.before.pending.phase === 'pending' && !positive.before.pending.nativeStart
      && positive.before.pending.nativeId === null && positive.candidate?.sessionId === positive.deferredId
      && positive.candidate.capturedAt < positive.before.launch.expiresAt
      && positive.before.binding.state === 'pending' && positive.before.ledger === positive.deferredLedger, positive.evidence);
  check('captured startup outlives its preflight deadline only as discovery until the owned transcript exists',
    positive.result?.expiredList === 200 && positive.result.expiredBefore.status === 403
      && /pending owner realization/.test(positive.result.expiredBefore.body), positive.evidence);
  check('first authenticated read after owned transcript publication realizes only the captured current startup',
    positive.exit.code === 0 && positive.result?.after?.status === 200 && positive.result.final.phase === 'bound'
      && positive.result.final.nativeId === positive.deferredId && positive.result.finalBinding.sessionId === positive.deferredId
      && positive.result.final.nativeStart?.source === 'startup' && positive.result.finalLedger.length === positive.deferredLedger + 1
      && positive.result.finalLedger.some(binding => binding.nativeId === positive.deferredId && binding.nonce === positive.result.final.nonce)
      && factories.length === positive.deferredFactories + 1, positive.evidence);
  const forged = await deferredStart('forged');
  check('a candidate not captured inside its preflight deadline neither keeps discovery nor realizes a published transcript',
    forged.before?.hook.code === 0 && forged.result?.expiredList === 401 && forged.result.expiredBefore.status === 401
      && forged.result.after.status === 401 && forged.result.final.phase === 'pending' && forged.result.final.nativeId === null
      && forged.result.finalLedger.length === forged.deferredLedger && factories.length === forged.deferredFactories, forged.evidence);
  for (const mode of ['owner-drift', 'profile-drift']) {
    const drift = await deferredStart(mode);
    check(`${mode}: a captured startup refuses discovery and realization after its fenced owner revision changes`,
      drift.before?.hook.code === 0 && drift.candidate?.revisions.length === 2 && drift.result?.expiredList === 401
        && drift.result.expiredBefore.status === 401 && /changed after startup capture/.test(drift.result.expiredBefore.body)
        && drift.result.after.status === 401 && drift.result.final.phase === 'pending' && drift.result.final.nativeId === null
        && !drift.result.final.revoked && drift.result.final.startupCandidate?.sessionId === drift.deferredId
        && drift.result.finalLedger.length === drift.deferredLedger && factories.length === drift.deferredFactories, drift.evidence);
  }
  const symlinked = await deferredStart('symlink');
  check('a symlinked future transcript component is refused at startup instead of waiting', symlinked.exit.code === 0
    && symlinked.result?.hook.code !== 0 && !symlinked.candidate && /not owned native state/.test(symlinked.result.hook.error)
    && readPrivate(symlinked.result.launchFile).revoked === true && !readPrivate(symlinked.result.launchFile).startupCandidate
    && factories.length === symlinked.deferredFactories, symlinked.evidence);
  await approveStandaloneRootProfile(host, { id: 'codex-exec', harness: 'codex', nativeStore, executable: nativeExecutable }, env);
  const execEntry = path.join(root, 'exec'), execOutput = path.join(root, 'codex-exec-result.json');
  writeFileSync(execEntry, `(async()=>{
const {spawn}=await import('node:child_process');
const {existsSync,readFileSync,writeFileSync,mkdirSync}=await import('node:fs');
const launchFile=process.env.PROMPTOBUS_ROOT_LAUNCH_FILE,launch=JSON.parse(readFileSync(launchFile));
const directory=launchFile.replace(/[^/]+$/,''),nativeId=process.env.PB_EXEC_NATIVE_ID;
const transcript=${JSON.stringify(nativeStore)}+'/sessions/'+nativeId+'.jsonl';
mkdirSync(${JSON.stringify(nativeStore)}+'/sessions',{recursive:true});
if(!existsSync(transcript))writeFileSync(transcript,JSON.stringify({type:'session_meta',payload:{id:nativeId,source:process.env.PB_EXEC_SOURCE}})+'\\n',{mode:0o600});
const hook=await new Promise(resolve=>{
 const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(bin)},'guard','--standalone-profile','codex-exec','--service-home',process.env.PROMPTOBUS_SERVICE_HOME],{stdio:['pipe','ignore','pipe']});
 let error='';child.stderr.on('data',bytes=>{error+=bytes});child.once('close',code=>resolve({code,error}));
 child.stdin.end(JSON.stringify({hook_event_name:'SessionStart',session_id:nativeId,transcript_path:transcript,cwd:process.cwd()}));
});
const result={hook,pid:process.pid,launcherPid:launch.process.pid,args:launch.nativeCommand.args,
 launch:JSON.parse(readFileSync(launchFile)),ledger:JSON.parse(readFileSync(directory+'native-admission.json')).bindings};
if(hook.code===0){
 const grant=JSON.parse(readFileSync(directory+'clients/'+launch.clientId+'.json')),discovery=JSON.parse(readFileSync(directory+'service.json'));
 let session,sequence=0;
 const rpc=async(method,params={},notification=false)=>{
 const response=await fetch(discovery.url+'mcp/bus',{method:'POST',headers:{authorization:'Bearer '+grant.token,
 accept:'application/json, text/event-stream','content-type':'application/json',...(session?{'mcp-session-id':session,'mcp-protocol-version':'2025-06-18'}:{})},
 body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id:++sequence}),method,params})});
 return {status:response.status,session:response.headers.get('mcp-session-id'),body:await response.text()};};
 const initialized=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'codex-exec-fixture',version:'1'}});
 session=initialized.session;await rpc('notifications/initialized',{},true);
 result.tool=await rpc('tools/call',{name:'promptobus_status',arguments:{},_meta:{threadId:nativeId}});
 result.binding=grant.nativeBinding;
}
writeFileSync(${JSON.stringify(execOutput)},JSON.stringify(result));
})().catch(error=>{process.stderr.write(error.stack);process.exitCode=1});`);
  const execRoot = async (source, nativeId = randomUUID(), resume = false, controls = null) => {
    if (existsSync(execOutput)) unlinkSync(execOutput);
    const count = readPrivate(path.join(paths.directory, 'native-admission.json')).bindings.length, actorCount = factories.length;
    const args = controls ?? (resume ? ['exec', 'resume', nativeId] : ['exec', '--', 'owned frozen fixture read']);
    const exit = await run('/bin/sh', [wrapper, '--profile', 'codex-exec', '--service-home', base, '--', nativeExecutable, ...args],
      { PB_EXEC_SOURCE: source, PB_EXEC_NATIVE_ID: nativeId });
    const result = existsSync(execOutput) ? JSON.parse(readFileSync(execOutput)) : null;
    return { nativeId, count, actorCount, exit, result, evidence: JSON.stringify({ result, error: exit.err }) };
  };
  const freshExec = await execRoot('exec');
  check('actual standalone Codex exec argv admits its first exec SessionMeta without a seeded binding',
    freshExec.exit.code === 0 && freshExec.result?.hook.code === 0 && freshExec.result.pid === freshExec.result.launcherPid
      && JSON.stringify(freshExec.result.args) === JSON.stringify(['exec', '--', 'owned frozen fixture read'])
      && freshExec.result.launch.phase === 'bound' && freshExec.result.launch.nativeStart.source === 'exec'
      && freshExec.result.binding.threadId === freshExec.nativeId && freshExec.result.tool.status === 200
      && freshExec.result.ledger.length === freshExec.count + 1 && factories.length === freshExec.actorCount + 1,
    freshExec.evidence);
  for (const source of ['cli', 'vscode', 'unknown']) {
    const denied = await execRoot(source);
    check(`new exec argv refuses mismatched native source ${source} without creating an actor or binding`,
      denied.exit.code === 0 && denied.result?.hook.code !== 0 && denied.result.launch.phase === 'pending'
        && denied.result.launch.revoked && denied.result.ledger.length === denied.count && factories.length === denied.actorCount,
      denied.evidence);
  }
  const knownExec = await execRoot('exec', freshExec.nativeId, true);
  check('known current-version exec-origin identity resumes through its explicit owned reservation',
    knownExec.exit.code === 0 && knownExec.result?.hook.code === 0 && knownExec.result.launch.resumeNativeId === freshExec.nativeId
      && knownExec.result.launch.nativeStart.source === 'exec' && knownExec.result.tool.status === 200
      && knownExec.result.ledger.length === knownExec.count && knownExec.result.ledger.some(binding => binding.nativeId === freshExec.nativeId
        && binding.previousNonce === freshExec.result.launch.nonce && binding.nonce === knownExec.result.launch.nonce), knownExec.evidence);
  const unknownExec = await execRoot('exec', randomUUID(), true);
  check('an unknown exec-origin native ID refuses explicit resume before the native child starts', unknownExec.exit.code !== 0
    && unknownExec.result === null && /known current-version native binding/.test(unknownExec.exit.err)
    && readPrivate(path.join(paths.directory, 'native-admission.json')).bindings.length === unknownExec.count
    && factories.length === unknownExec.actorCount, unknownExec.evidence);
  const controls = ['exec', '--strict-config', '--ignore-user-config', '--dangerously-bypass-hook-trust', '--skip-git-repo-check',
    '--sandbox', 'read-only', '--json', '--model', 'fixture-model', '-c', 'model_reasoning_effort="xhigh"',
    '-c', `projects={${JSON.stringify(realpathSync(root))}={trust_level="trusted"}}`,
    '-c', `hooks.state={${JSON.stringify(`${nativeStore}/hooks.json:stop:0:0`)}={enabled=false}}`,
    '-c', 'mcp_servers.promptobus.tools={promptobus_status={approval_mode="approve"}}',
    '-c', 'mcp_servers.promptobus.enabled_tools=["promptobus_status"]', 'owned frozen fixture read'];
  const controlled = await execRoot('exec', randomUUID(), false, controls);
  check('approved exec controls admit their first exec SessionMeta as NEW and the exposed tool call succeeds',
    controlled.exit.code === 0 && controlled.result?.hook.code === 0 && JSON.stringify(controlled.result.args) === JSON.stringify(controls)
      && controlled.result.launch.phase === 'bound' && controlled.result.launch.nativeStart.source === 'exec'
      && controlled.result.binding.threadId === controlled.nativeId && controlled.result.tool.status === 200
      && controlled.result.ledger.length === controlled.count + 1 && factories.length === controlled.actorCount + 1,
    controlled.evidence);
  const unsupported = await execRoot('exec', randomUUID(), false, ['exec', '--ephemeral', 'owned frozen fixture read']);
  check('an unsupported NEW exec argv refuses in preflight before the native child starts or a grant appears', unsupported.exit.code !== 0
    && unsupported.result === null && /not a supported NEW form or resume selection/.test(unsupported.exit.err)
    && readPrivate(path.join(paths.directory, 'native-admission.json')).bindings.length === unsupported.count
    && factories.length === unsupported.actorCount, unsupported.evidence);
  const unsupportedPreview = await standaloneRootExecPlan(host, 'codex-exec', { file: nativeExecutable, args: ['exec', '--ephemeral', 'owned frozen fixture read'] },
    { env, dryRun: true, cwd: root }).then(() => null, error => error);
  check('the same unsupported exec argv also refuses in a dry run', /not a supported NEW form or resume selection/.test(String(unsupportedPreview?.message)),
    String(unsupportedPreview?.message));

  const malformedRoot = path.join(root, 'malformed-owner');
  mkdirSync(malformedRoot);
  writeHostConfig(malformedRoot, { tools: [] });
  const malformedBase = mkdtempSync(path.join(realpathSync('/tmp'), 'pb-root-'));
  const malformedEnv = { ...env, HOME: malformedRoot, USERPROFILE: malformedRoot,
    PROMPTOBUS_HOME: path.join(malformedRoot, '.promptobus'), PROMPTOBUS_SERVICE_HOME: malformedBase };
  const malformedHost = createStandaloneHost({ cwd: malformedRoot, binPath: bin, version });
  const malformedPaths = servicePaths(malformedHost, malformedEnv), malformedRuntime = runtimeIdentity(malformedHost);
  let malformedSpawnError, malformedExit, malformedTerminal = false, malformedError = '';
  const malformedProcess = spawn(process.execPath, [bin, 'service', 'run'],
    { cwd: malformedRoot, env: malformedEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  children.add(malformedProcess);
  malformedProcess.stderr.on('data', bytes => { malformedError += bytes; });
  malformedProcess.once('error', error => { malformedSpawnError = error; });
  const malformedRunning = new Promise(resolve => malformedProcess.once('close', (code, signal) => {
    malformedTerminal = true; malformedExit = { code, signal }; children.delete(malformedProcess); resolve(malformedExit);
  }));
  const healthyOwner = { paths, runtime }, malformedOwner = { paths: malformedPaths, runtime: malformedRuntime };
  const corruptOwner = malformedOwner;
  const corruptId = randomUUID(), corruptFile = path.join(corruptOwner.paths.clients, corruptId + '.json');
  try {
    const readyEdge = Date.now() + 5000;
    while (readDiscovery(malformedPaths)?.process.pid !== malformedProcess.pid && !malformedTerminal && !malformedSpawnError
      && Date.now() < readyEdge) await new Promise(resolve => setTimeout(resolve, 10));
    if (malformedSpawnError) throw malformedSpawnError;
    const malformedIdentity = readDiscovery(malformedPaths)?.process;
    if (malformedIdentity?.pid !== malformedProcess.pid) throw new Error(`Owned malformed fixture service did not start: ${malformedError}`);
    const healthyBefore = await serviceControl(healthyOwner.paths, { operation: 'status', runtime: healthyOwner.runtime });
    const malformedDenial = async () => {
      try { await serviceControl(corruptOwner.paths, { operation: 'revoke', runtime: corruptOwner.runtime, clientId: corruptId }); return null; }
      catch (error) { return error.message; }
    };
    const missingTarget = path.join(malformedRoot, 'absent-credential-target.json');
    try {
      symlinkSync(missingTarget, corruptFile);
      const denial = await malformedDenial();
      check('owner revoke refuses a dangling credential symlink without following or removing it', typeof denial === 'string'
        && lstatSync(corruptFile).isSymbolicLink() && readlinkSync(corruptFile) === missingTarget && !existsSync(missingTarget), denial);
    } finally { unlinkSync(corruptFile); }
    try {
      writeFileSync(corruptFile, 'null', { mode: 0o600 });
      const denial = await malformedDenial();
      check('owner revoke refuses and retains an existing private JSON null credential', denial === 'Client binding not found'
        && readFileSync(corruptFile, 'utf8') === 'null' && (lstatSync(corruptFile).mode & 0o777) === 0o600, denial);
      const terminalEdge = Date.now() + 1500;
      while (!malformedTerminal && Date.now() < terminalEdge) await new Promise(resolve => setTimeout(resolve, 5));
      const healthyAfter = await serviceControl(healthyOwner.paths, { operation: 'status', runtime: healthyOwner.runtime }).catch(error => ({ error: error.message }));
      const healthyAlive = !ownerError && healthyAfter.url === healthyBefore.url
        && healthyAfter.process?.pid === healthyBefore.process.pid && healthyAfter.process?.birth === healthyBefore.process.birth;
      const receipt = { isolatedHomes: malformedPaths.home !== paths.home, isolatedServices: malformedPaths.directory !== paths.directory,
        malformedTerminal, malformedExit, malformedFailClosed: malformedError.includes('Invalid shared service client grant'),
        malformedProcessDead: processState(malformedIdentity) === 'dead', malformedSocketAbsent: !existsSync(malformedPaths.controlSocket),
        healthyAlive, healthyError: ownerError?.message ?? null };
      writeSync(1, '  · malformed-owner-receipt: ' + JSON.stringify(receipt) + '\n');
      check('malformed owner fails closed while the separate healthy admission owner survives the same stimulus',
        receipt.isolatedHomes && receipt.isolatedServices && receipt.malformedTerminal
        && receipt.malformedExit?.code === 1 && receipt.malformedExit.signal === null && receipt.malformedFailClosed
        && receipt.malformedProcessDead && receipt.malformedSocketAbsent && receipt.healthyAlive,
        JSON.stringify(receipt));
    } finally { unlinkSync(corruptFile); }
  } finally {
    if (!malformedTerminal) {
      if (readDiscovery(malformedPaths)?.process.pid === malformedProcess.pid) await serviceControl(malformedPaths, { operation: 'stop', runtime: malformedRuntime });
      else malformedProcess.kill('SIGTERM');
    }
    await malformedRunning;
    rmSync(malformedBase, { recursive: true, force: true });
  }

} finally {
  await Promise.all([...children].map(child => new Promise(resolve => { child.once('close', resolve); child.kill('SIGTERM'); })));
  if (!ownerError) {
    for (const name of existsSync(paths.clients) ? readdirSync(paths.clients) : []) {
      if (/^[a-f0-9-]{36}\.json$/.test(name)) await serviceControl(paths, { operation: 'revoke', clientId: name.slice(0, -5), runtime });
    }
    if (readDiscovery(paths)) await serviceControl(paths, { operation: 'stop', runtime });
  }
  await running;
  rmSync(base, { recursive: true, force: true });
}
check('healthy admission owner completes without a service failure', !ownerError, ownerError?.message);
