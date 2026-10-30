import './home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { makeSandbox, stubCommand, writeHostConfig } from './sandbox.mjs';
import { expectFail, quiet } from './console.mjs';
import { hostOf } from '../lib/host.js';
import * as store from '../lib/store.js';
import { REGISTRY } from '../lib/drivers.js';
import { bindHandshake, claudeDriver, SESSION_RECORD_VAR } from '../lib/driver-claude.js';
import { codexDriver } from '../lib/driver-codex.js';
import { requireNativeIdle, requireNativeTerminal, reserveNativeParticipant } from '../lib/native-lifecycle.js';
import { bindBeforeLaunch, liftoffParticipant } from '../lib/liftoff.js';
import { findSessionByAddress, writeSession, sessionFile, sessionKey } from '../lib/codex-session.js';
import { commandReceipts } from '../lib/codex-command-receipts.js';
import { retainNativeStop } from '../lib/native-lifecycle.js';
import { done } from '../lib/done.js';
import { spawn as spawnParticipant } from '../lib/spawn.js';
import { review } from '../lib/review.js';
import { approverLift } from '../lib/approver.js';
import { planReport, report } from '../lib/report.js';
import { sweep } from '../lib/sweep.js';
import { createRegistry } from '../dist/index.js';
import { sessionLogOf } from '../lib/model-routing/telemetry.js';

process.env.CLAUDE_CODE_SESSION_ID = 'closure-owner';
process.env.PROMPTOBUS_WARDEN = 'off';
let sequence = 0;
function fixture() {
  const root = realpathSync(makeSandbox('promptobus-lifecycle-closure-'));
  writeHostConfig(root, { tools: ['claude', 'codex'] });
  const host = hostOf(root), home = host.promptobusHome();
  process.env.PROMPTOBUS_CODEX_HOME = path.join(root, 'native');
  const task = 'closure-t20261024-' + String(++sequence).padStart(6, '0');
  store.createTask(home, { id: task, title: 'Lifecycle closure', owner: 'closure-owner' });
  return { root, host, home, task, file: store.taskFile(home, task) };
}
const seat = (address, harness='codex') => store.participantRecord(address, {
  harness, mode: 'managed', sessionRef: 'ref-' + address.replace(':','-'), sessionId: 'actual-thread',
});
const current = (f,address) => store.participantOf(store.readTask(f.home,f.task),address);
const close = f => done(f.host,{task:f.task,'keep-sessions':true,snapshot:()=>({}),
  adapterFor:()=>({probe:()=>({available:'unknown'})})});
function repository(f) {
  const repo=path.join(f.root,'fixture');mkdirSync(repo);
  for(const args of [['init','-q','-b','main'],['-c','user.name=fixture','-c','user.email=fixture@invalid','commit','-qm','base','--allow-empty']]) {
    const r=spawnSync('git',args,{cwd:repo,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  }
  writeFileSync(path.join(repo,'AGENTS.md'),'Fixture rules.\n');
  const brief=path.join(f.root,'brief.md');writeFileSync(brief,'Fixture: no model execution.\n');
  const bin=path.join(f.root,'bin');
  stubCommand(bin,'claude',"process.stdout.write('2.1.221\\n');");
  stubCommand(bin,'codex',"process.stdout.write('codex-cli 0.163.0\\n');");
  const host={...f.host,resolveRepo:async()=>({nsPath:'fixture',via:'fixture'}),repoAbsPath:()=>repo,
    isClone:()=>true,defaultBranch:()=> 'main',freshenRepo:()=>({}),reportFresh:()=>{}};
  const tool=harness=>({ok:true,bin:path.join(bin,harness),version:harness==='codex'?'0.163.0':'2.1.221',source:'fixture'});
  return {repo,brief,host,tool};
}
function approvalResults(f, repo) {
  const bus=store.bus(f.home,{cli:'0.29.0'});
  for(const role of ['worker','reviewer']) {
    const from=role+':fixture';
    bus.assignParticipant(f.task,store.participantRecord(from,{harness:'claude',repoAbs:repo,worktree:repo}));
    store.sendMessage(f.home,f.task,{from,to:store.ORCHESTRATOR,type:'result',body:'Owned fixture result.'});
  }
}
function confirmed(f,address,expected) {
  const p=seat(address);
  const {record}=reserveNativeParticipant(f.home,f.task,p,expected,REGISTRY);
  const stopped={ref:record.sessionRef,home:f.home,task:f.task,address,launchId:record.metadata.nativeLaunchId,
    threadId:'actual-thread',holderPid:2147483646,appPid:2147483645};
  const file=path.join(process.env.PROMPTOBUS_CODEX_HOME,'receipts',sessionKey(stopped.ref),sessionKey(stopped.launchId)+'.jsonl');
  const receipt=commandReceipts(file,{format:1,...stopped});
  const deadlineAt=Date.now()+5000;
  receipt.append('stop/requested',{threadId:stopped.threadId,deadlineAt});
  receipt.append('app-server/close',{code:0,signal:null});
  receipt.append('stop/confirmed',{...stopped,commands:[],appClose:{code:0,signal:null},deadlineAt,originalToolReceipt:'not synthesized'});
  store.withTaskLock(f.home,f.task,()=>retainNativeStop(stopped,file));
  return stopped;
}

function aliasHost(f) {
  const aliasHome = `${f.home}-alias`;
  symlinkSync(f.home, aliasHome, 'dir');
  return { ...f, aliasHome, host: { ...f.host, promptobusHome: () => aliasHome } };
}

test('an alias Host cannot close past an unbound record from its canonical native plan', async () => {
  const f = aliasHost(fixture());
  const plan = await planReport(f.host, { task: f.task, harness: 'codex', dryRun: true });
  writeSession({ ref: plan.name, home: plan.home, task: f.task, address: 'reporter',
    launchId: 'owned-unbound-root', holderPid: process.pid, state: 'starting' });
  const before = readFileSync(f.file), retained = readFileSync(sessionFile(plan.name));
  await assert.rejects(() => close(f), /unresolved/);
  assert.deepEqual(readFileSync(f.file), before);
  assert.deepEqual(readFileSync(sessionFile(plan.name)), retained);
});

test('an alias Host closes after its planned native Stop without rewriting the original receipt', async () => {
  const f = aliasHost(fixture());
  const plan = await planReport(f.host, { task: f.task, harness: 'codex', dryRun: true });
  f.home = plan.home;
  confirmed(f, 'reporter');
  const proof = current(f, 'reporter').metadata.nativeStop, bytes = readFileSync(proof.receiptFile);
  await quiet(() => close(f));
  assert.equal(store.readTask(f.home, f.task).status, 'done');
  assert.deepEqual(readFileSync(proof.receiptFile), bytes);
});

test('legacy alias Stop roots retain exact receipt proof while a foreign physical root is refused', async () => {
  const f = aliasHost(fixture()), canonical = f.home;
  f.home = f.aliasHome;
  confirmed(f, 'worker:legacy');
  const p = current(f, 'worker:legacy'), proof = p.metadata.nativeStop, bytes = readFileSync(proof.receiptFile);
  assert.doesNotThrow(() => requireNativeTerminal(canonical, store.readTask(canonical, f.task), p));
  const foreign = path.join(f.root, 'foreign-store'), foreignAlias = `${foreign}-alias`;
  mkdirSync(foreign); symlinkSync(foreign, foreignAlias, 'dir');
  assert.throws(() => requireNativeTerminal(canonical, store.readTask(canonical, f.task), {
    ...p, metadata: { ...p.metadata, nativeStop: { ...proof, home: foreignAlias } },
  }), /unresolved/);
  await quiet(() => close({ ...f, host: { ...f.host, promptobusHome: () => canonical } }));
  assert.equal(store.readTask(canonical, f.task).status, 'done');
  assert.deepEqual(readFileSync(proof.receiptFile), bytes);
});

test('retained registry lookup and root launch compare physical store identity and keep foreign records separate', () => {
  const f = aliasHost(fixture());
  const record = { ref: 'legacy-root', home: f.aliasHome, task: f.task, address: 'orchestrator',
    launchId: 'legacy-generation', holderPid: process.pid, state: 'starting' };
  writeSession(record);
  assert.equal(findSessionByAddress(f.home, f.task, 'orchestrator')?.ref, record.ref);
  assert.throws(() => requireNativeIdle(f.home, store.readTask(f.home, f.task)), /unresolved/);
  const before = readFileSync(sessionFile(record.ref));
  assert.throws(() => codexDriver.prepareRootLaunch({ home: f.home, task: f.task, env: process.env }), /live unbound/);
  assert.deepEqual(readFileSync(sessionFile(record.ref)), before);
  const foreign = path.join(f.root, 'foreign-root'); mkdirSync(foreign);
  const foreignAlias = `${foreign}-alias`; symlinkSync(foreign, foreignAlias, 'dir');
  writeSession({ ...record, home: foreignAlias });
  assert.equal(findSessionByAddress(f.home, f.task, 'orchestrator'), null);
  assert.doesNotThrow(() => requireNativeIdle(f.home, store.readTask(f.home, f.task)));
  assert.doesNotThrow(() => codexDriver.prepareRootLaunch({ home: f.home, task: f.task, env: process.env }));
  assert.equal(existsSync(sessionFile(record.ref)), true);
  for (const home of ['', '.', null, 7]) {
    writeSession({ ...record, home });
    assert.equal(findSessionByAddress(process.cwd(), f.task, 'orchestrator'), null);
  }
});

test('native telemetry accepts legacy store aliases but rejects foreign or malformed roots', () => {
  const f = aliasHost(fixture()), p = seat('worker:telemetry');
  const rolloutPath = path.join(f.root, 'rollout.jsonl'); writeFileSync(rolloutPath, '{}\n');
  const host = { ...f.host, harnessStateHome: harness => harness === 'codex'
    ? process.env.PROMPTOBUS_CODEX_HOME : f.host.harnessStateHome(harness) };
  const record = { ref: p.sessionRef, home: f.aliasHome, task: f.task, address: 'worker:telemetry',
    threadId: p.metadata.sessionId, rolloutPath };
  writeSession(record);
  assert.deepEqual(sessionLogOf(host, f.home, f.task, p), { sessionId: p.metadata.sessionId, path: rolloutPath });
  for (const home of [f.root, '', '.', null, 7]) {
    writeSession({ ...record, home });
    assert.equal(sessionLogOf(host, f.home, f.task, p), null);
  }
});

test('stale legacy admission cannot erase a current native reservation',()=>{
  const f=fixture(),address='worker:one';
  reserveNativeParticipant(f.home,f.task,seat(address),undefined,REGISTRY);
  const before=readFileSync(f.file);
  assert.throws(()=>reserveNativeParticipant(f.home,f.task,seat(address,'claude'),undefined,REGISTRY),/unresolved/);
  assert.deepEqual(readFileSync(f.file),before);
});
test('legacy undo cannot erase a current native binding',()=>{
  const f=fixture(),address='worker:one';
  store.upsertParticipant(f.home,f.task,seat(address,'claude'));
  const undo=bindBeforeLaunch(f.home,f.task,address,{sessionId:'pending',sessionRecord:'stable'});
  const old=current(f,address);
  const {record}=reserveNativeParticipant(f.home,f.task,seat(address),old,REGISTRY);
  store.upsertParticipant(f.home,f.task,{...record,metadata:{...record.metadata,sessionId:'native-thread',sessionRecord:'stable'}});
  const before=readFileSync(f.file);undo();assert.deepEqual(readFileSync(f.file),before);
});
for(const command of ['spawn','review','approver']) {
  test('delayed legacy '+command+' callback preserves a newer native seat',async()=>{
    const f=fixture(),r=repository(f),address=command==='spawn'?'worker:one':command==='approver'?'approver:fixture':'reviewer:fixture';
    if(command==='approver') approvalResults(f,r.repo);
    const oldSpawn=claudeDriver.spawn;let before,invoked=0;
    claudeDriver.spawn=async(plan,ctx)=>{
      invoked++;
      await Promise.resolve();
      const {record}=reserveNativeParticipant(f.home,f.task,seat(address),current(f,address),REGISTRY);
      store.upsertParticipant(f.home,f.task,{...record,metadata:{...record.metadata,nativeStop:{launchId:record.metadata.nativeLaunchId}}});
      before=readFileSync(f.file);ctx.persist('old-session','alive','old-session');
      return {output:'fixture',session:'old-session',seen:{state:'alive'}};
    };
    try {
      const opts=command==='spawn'?{repo:'fixture',worker:'one',brief:r.brief}:{target:r.repo,sessions:{}};
      let errorText='';
      const run=command==='spawn'?spawnParticipant:command==='approver'?approverLift:review;
      const result=await expectFail(async()=> {try {return await run(r.host,{
        ...opts,task:f.task,harness:'claude',tool:r.tool('claude'),
      });} catch(error) {errorText=error.message;throw error;} });
      assert.equal(invoked,1,'fake legacy driver must reach its real production persistence callback: '+errorText+' '+result.out);
      assert.equal(result.failed,true,'stale legacy callback must refuse');
      assert.deepEqual(readFileSync(f.file),before);
    } finally {claudeDriver.spawn=oldSpawn;}
  });
}
test('native approver callback cannot overwrite a stopped reservation',async()=>{
  const f=fixture(),r=repository(f),address='approver:fixture';approvalResults(f,r.repo);
  const old=codexDriver.spawn;let before,invoked=0;
  codexDriver.spawn=async(plan,ctx)=>{
    invoked++;
    const reserved=current(f,address);
    assert.equal(plan.launchId,reserved.metadata.nativeLaunchId);
    store.upsertParticipant(f.home,f.task,{...reserved,metadata:{...reserved.metadata,nativeStop:{launchId:plan.launchId}}});
    before=readFileSync(f.file);
    ctx.persist('stale-session','alive','stale-session');
    return {output:'fixture',session:'stale-session',seen:{state:'alive'}};
  };
  try {
    const result=await expectFail(()=>approverLift(r.host,{target:r.repo,task:f.task,harness:'codex',tool:r.tool('codex')}));
    assert.equal(invoked,1,result.out);assert.equal(result.failed,true);
    assert.deepEqual(readFileSync(f.file),before);
  } finally {codexDriver.spawn=old;}
});
test('native approver setup refusal releases only its never-invoked reservation',async()=>{
  const f=fixture(),r=repository(f),address='approver:fixture';approvalResults(f,r.repo);
  const old=codexDriver.refuseForeignProjectLayer;let calls=0;
  codexDriver.refuseForeignProjectLayer=()=>{
    calls++;
    if(current(f,address)?.metadata.nativeLaunchId) throw new Error('owned setup refusal');
  };
  try {
    await assert.rejects(()=>approverLift(r.host,{target:r.repo,task:f.task,harness:'codex',tool:r.tool('codex')}),/owned setup refusal/);
    const reserved=current(f,address);
    assert.ok(calls>=2);assert.ok(reserved.metadata.nativeLaunchId);
    assert.equal(reserved.metadata.nativeUnlaunched,reserved.metadata.nativeLaunchId);
    const base=spawnSync('git',['rev-parse','HEAD'],{cwd:r.repo,encoding:'utf8'}).stdout.trim();
    assert.equal(reserved.metadata.baseSha,base,'setup refusal must retain the created worktree base');
    assert.equal(existsSync(sessionFile(reserved.sessionRef)),false);
  } finally {codexDriver.refuseForeignProjectLayer=old;}
});
test('native task-owned registry blocks done even without a canonical Codex seat',async()=>{
  const f=fixture();store.upsertParticipant(f.home,f.task,seat('worker:one','claude'));
  writeSession({ref:'unbound',home:f.home,task:f.task,address:'worker:lost',launchId:'active',state:'dead'});
  const before=readFileSync(f.file),record=readFileSync(sessionFile('unbound'));
  assert.equal((await expectFail(()=>close(f))).failed,true);
  assert.deepEqual(readFileSync(f.file),before);assert.deepEqual(readFileSync(sessionFile('unbound')),record);
});
for(const newer of [null,'generation','stop']) {
  test('known pre-driver failure '+(newer?'preserves current '+newer:'permits same-address retry and close'),async()=>{
    const f=fixture(),r=repository(f);let resources=0,newerBytes,mail;
    const host={...r.host,freshenRepo:()=>{
      resources++;
      const p=current(f,'worker:one');
      if(newer) {
        store.upsertParticipant(f.home,f.task,{...p,metadata:{...p.metadata,
          ...(newer==='generation'?{nativeLaunchId:'newer-generation'}:{nativeStop:{kept:true}})}});
        newerBytes=readFileSync(f.file);
      } else {
        mail=store.sendMessage(f.home,f.task,{from:'orchestrator',to:'worker:one',type:'task',body:'queued during failed preparation',session:'closure-owner'}).message.id;
      }
      throw new Error('known pre-driver fixture failure');
    }};
    const opts={repo:'fixture',worker:'one',brief:r.brief,task:f.task,harness:'codex',tool:r.tool('codex')};
    await expectFail(()=>spawnParticipant(host,opts));
    if(newer) {assert.deepEqual(readFileSync(f.file),newerBytes);return;}
    await expectFail(()=>spawnParticipant(host,opts));
    assert.equal(resources,2,'repaired preparation must reach the same address again');
    assert.ok(store.glanceInbox(f.home,f.task,'worker:one').some(m=>m.id===mail));
    const result=await expectFail(()=>close(f));assert.equal(result.failed,false,'known never-invoked launch must permit close');
  });
}
test('stale legacy review admission leaves current native record and config unchanged',async()=>{
  const f=fixture(),r=repository(f),address='reviewer:fixture';
  const file=store.participantMcpPath(f.home,f.task,address);mkdirSync(path.dirname(file),{recursive:true});
  writeFileSync(file,'foreign current config');
  const tool=r.tool('claude');let before,seeded=false,invoked=0;
  Object.defineProperty(tool,'version',{get(){
    if(!seeded){seeded=true;reserveNativeParticipant(f.home,f.task,seat(address),undefined,REGISTRY);before=readFileSync(f.file);}
    return '2.1.221';
  }});
  const old=claudeDriver.spawn;claudeDriver.spawn=async()=>{invoked++;throw new Error('unexpected legacy dispatch');};
  try {
    await expectFail(()=>review(r.host,{target:r.repo,task:f.task,harness:'claude',tool,sessions:{}}));
    assert.equal(seeded,true);assert.equal(invoked,0,'obsolete legacy plan must stop before dispatch');
    assert.deepEqual(readFileSync(f.file),before);assert.equal(readFileSync(file,'utf8'),'foreign current config');
  } finally {claudeDriver.spawn=old;}
});
test('known rebuild failure retains its real dirty worktree while permitting close',async()=>{
  const f=fixture(),r=repository(f);const oldPrepare=codexDriver.prepare,oldSpawn=codexDriver.spawn;
  let prepares=0,invoked=0,patch;
  codexDriver.prepare=ctx=>{
    if(++prepares===2){patch=path.join(ctx.cwd,'dirty.patch');writeFileSync(patch,'retained dirty patch');throw new Error('known rebuild failure');}
    return oldPrepare(ctx);
  };
  codexDriver.spawn=async()=>{invoked++;throw new Error('unexpected dispatch');};
  try {
    await expectFail(()=>spawnParticipant(r.host,{repo:'fixture',worker:'one',brief:r.brief,task:f.task,harness:'codex',tool:r.tool('codex')}));
    assert.equal(prepares,2);assert.equal(invoked,0);
    assert.equal((await expectFail(()=>close(f))).failed,false,'known pre-driver rebuild refusal can close');
    assert.equal(readFileSync(patch,'utf8'),'retained dirty patch');
  } finally {codexDriver.prepare=oldPrepare;codexDriver.spawn=oldSpawn;}
});
test('invoked native driver failure cannot be released from registry absence',async()=>{
  const f=fixture(),r=repository(f),old=codexDriver.spawn;let invoked=0;
  codexDriver.spawn=async()=>{invoked++;throw new Error('unknown invoked outcome');};
  try {
    await expectFail(()=>spawnParticipant(r.host,{repo:'fixture',worker:'one',brief:r.brief,task:f.task,harness:'codex',tool:r.tool('codex')}));
    assert.equal(invoked,1);assert.equal(current(f,'worker:one').metadata.nativeUnlaunched,undefined);
    const before=readFileSync(f.file);assert.equal((await expectFail(()=>close(f))).failed,true);
    assert.deepEqual(readFileSync(f.file),before);
  } finally {codexDriver.spawn=old;}
});
test('real process exit on worktree refusal releases only its never-invoked reservation',async()=>{
  const f=fixture(),r=repository(f),foreign=path.join(f.root,'other-worktree'),dispatch=path.join(f.root,'unexpected-dispatch');
  const script=`
import {writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {hostOf} from ${JSON.stringify(new URL('../lib/host.js',import.meta.url).href)};
import * as store from ${JSON.stringify(new URL('../lib/store.js',import.meta.url).href)};
import {spawn} from ${JSON.stringify(new URL('../lib/spawn.js',import.meta.url).href)};
import {codexDriver} from ${JSON.stringify(new URL('../lib/driver-codex.js',import.meta.url).href)};
const root=${JSON.stringify(f.root)},repo=${JSON.stringify(r.repo)},task=${JSON.stringify(f.task)};
const host={...hostOf(root),resolveRepo:async()=>({nsPath:'fixture',via:'fixture'}),repoAbsPath:()=>repo,isClone:()=>true,defaultBranch:()=> 'main',reportFresh:()=>{},
freshenRepo:()=>{const p=store.participantOf(store.readTask(${JSON.stringify(f.home)},task),'worker:one');
 const taken=spawnSync('git',['-C',repo,'worktree','add','-qb',p.metadata.branch,${JSON.stringify(foreign)}],{encoding:'utf8'});
 if(taken.status!==0)throw new Error(taken.stderr);return {};}};
codexDriver.spawn=async()=>{writeFileSync(${JSON.stringify(dispatch)},'unexpected');throw new Error('unexpected dispatch');};
await spawn(host,{repo:'fixture',worker:'one',brief:${JSON.stringify(r.brief)},task,harness:'codex',tool:${JSON.stringify(r.tool('codex'))}}).catch(error=>{console.error(error.message);process.exitCode=1;});
`;
  const ran=spawnSync(process.execPath,['--input-type=module','-e',script],{env:process.env,encoding:'utf8'});
  assert.equal(ran.status,1,ran.stdout+ran.stderr);assert.match(ran.stderr,/git worktree add/);
  assert.equal(existsSync(dispatch),false);
  const p=current(f,'worker:one');
  assert.equal(p.metadata.nativeUnlaunched,p.metadata.nativeLaunchId,'real exit must not bypass known pre-driver release');
  await quiet(()=>close(f));assert.equal(existsSync(foreign),true,'another worktree stays owned by its creator');
});
test('unresolved dead native reporter refuses before canonical or driver mutation',async()=>{
  const f=fixture(),r=repository(f),p=seat('reporter');
  store.upsertParticipant(f.home,f.task,{...p,metadata:{...p.metadata,nativeLaunchId:'unresolved',pending:false}});
  writeSession({ref:p.sessionRef,home:f.home,task:f.task,address:'reporter',launchId:'unresolved',state:'dead'});
  const before=readFileSync(f.file),registry=readFileSync(sessionFile(p.sessionRef));
  const old=codexDriver.spawn;let invoked=0;
  codexDriver.spawn=async()=>{invoked++;throw new Error('unexpected fake driver invocation');};
  try {
    await expectFail(()=>report(r.host,{task:f.task,harness:'codex',sessions:{reporter:{state:'gone'}},tool:r.tool('codex')}));
    assert.equal(invoked,0,'unresolved reporter must refuse before driver invocation');
    assert.deepEqual(readFileSync(f.file),before);assert.deepEqual(readFileSync(sessionFile(p.sessionRef)),registry);
  } finally {codexDriver.spawn=old;}
});
test('confirmed old native reporter recovers with a new actual launch ID',async()=>{
  const f=fixture(),r=repository(f),stopped=confirmed(f,'reporter');
  const old=codexDriver.spawn;let actual;
  codexDriver.spawn=async(plan,ctx)=>{
    actual=plan.launchId;ctx.persist('new-thread','alive','new-thread');
    return {output:'fixture',session:'new-thread',seen:{}};
  };
  try {
    await quiet(()=>report(r.host,{task:f.task,harness:'codex',sessions:{reporter:{state:'gone'}},tool:r.tool('codex')}));
    assert.equal(typeof actual,'string');assert.notEqual(actual,stopped.launchId);
    assert.equal(current(f,'reporter').metadata.nativeLaunchId,actual);
    assert.equal(current(f,'reporter').metadata.nativeStop,undefined);
  } finally {codexDriver.spawn=old;}
});
test('known reporter config failure can retry while the caller process remains alive',async()=>{
  const f=fixture(),r=repository(f),oldPrepare=codexDriver.prepare,oldSpawn=codexDriver.spawn;
  const blocked=path.join(f.root,'blocked-file');mkdirSync(blocked);let invoked=0;
  codexDriver.prepare=ctx=>({...oldPrepare(ctx),files:[{path:blocked,text:'cannot write a directory'}]});
  codexDriver.spawn=async(plan,ctx)=>{invoked++;ctx.persist('new-thread','alive','new-thread');return {output:'fixture',session:'new-thread',seen:{}};};
  try {
    const opts={task:f.task,harness:'codex',sessions:{reporter:{state:'gone'}},tool:r.tool('codex')};
    await expectFail(()=>report(r.host,opts));assert.equal(invoked,0);
    codexDriver.prepare=oldPrepare;
    const retried=await expectFail(()=>report(r.host,opts));
    assert.equal(retried.failed,false,'known unlaunched reporter can retry without waiting for caller exit');assert.equal(invoked,1);
  } finally {codexDriver.prepare=oldPrepare;codexDriver.spawn=oldSpawn;}
});
test('public native sweep removes only a proven terminal participant resource',async()=>{
  const f=fixture(),address='worker:one';confirmed(f,address);
  const home=codexDriver.participantCodexHome({task:f.task,address});mkdirSync(home,{recursive:true});
  writeFileSync(path.join(home,'leftover'),'terminal fixture resource');
  const sentinel=path.join(f.root,'foreign-sentinel');writeFileSync(sentinel,'foreign');
  await quiet(()=>sweep(f.host,{task:f.task,address}));
  assert.equal(existsSync(home),false);assert.equal(readFileSync(sentinel,'utf8'),'foreign');
  assert.equal(store.readTask(f.home,f.task).status,'active');
});
for(const route of ['public-sweep','driver-sweep']) {
  test(route+' retains unresolved native resources',async()=>{
    const f=fixture(),address='worker:one',p=seat(address);
    store.upsertParticipant(f.home,f.task,p);
    const home=codexDriver.participantCodexHome({task:f.task,address});
    mkdirSync(home,{recursive:true});const sentinel=path.join(home,'owned-receipt');writeFileSync(sentinel,'retained');
    writeSession({ref:p.sessionRef,home:f.home,task:f.task,address,launchId:'unresolved',codexHome:home,state:'dead'});
    const file=store.participantMcpPath(f.home,f.task,address);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,'private fixture config');
    const before=readFileSync(f.file),record=readFileSync(sessionFile(p.sessionRef));
    const result=await expectFail(()=>route==='public-sweep'?sweep(f.host,{task:f.task,address}):codexDriver.sweepParticipant(p,f.task));
    assert.equal(result.failed,true,'unresolved native cleanup must refuse');
    assert.equal(readFileSync(sentinel,'utf8'),'retained');assert.equal(readFileSync(file,'utf8'),'private fixture config');
    assert.deepEqual(readFileSync(f.file),before);assert.deepEqual(readFileSync(sessionFile(p.sessionRef)),record);
  });
}
for (const sameAddress of [true,false]) {
  test('piece sweep '+(sameAddress?'refuses':'preserves')+' an owned native record behind a legacy canonical seat',async()=>{
    const f=fixture(),address='worker:one',p=seat(address,'claude');store.upsertParticipant(f.home,f.task,p);
    writeSession({ref:'native-without-seat',home:f.home,task:f.task,address:sameAddress?address:'worker:two',launchId:'unresolved',state:'dead'});
    const file=store.participantMcpPath(f.home,f.task,address);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,'owned config');
    let swept=0;
    const registry=createRegistry({drivers:{claude:{...claudeDriver,inspect:()=>({state:'gone'}),sweepParticipant:()=>{swept++;}}},fallback:'claude'});
    const before=readFileSync(f.file),record=readFileSync(sessionFile('native-without-seat'));
    const result=await expectFail(()=>sweep(f.host,{task:f.task,address},{registry}));
    assert.equal(result.failed,sameAddress,'native ownership must be checked for the selected piece');
    assert.equal(swept,sameAddress?0:1);
    assert.equal(existsSync(file),sameAddress);assert.deepEqual(readFileSync(f.file),before);
    assert.deepEqual(readFileSync(sessionFile('native-without-seat')),record);
  });
}

for(const state of ['alive','unknown']) for(const instructions of [false,true]) {
  test('stale legacy reuse '+state+' instructions='+instructions+' preserves the complete native assignment',async()=>{
    const f=fixture(),r=repository(f),address='reviewer:fixture';
    const p=seat(address,'claude');
    store.upsertParticipant(f.home,f.task,{...p,metadata:{...p.metadata,repo:'fixture',repoAbs:r.repo,name:p.sessionRef}});
    const instruction=path.join(f.root,'instructions.md');writeFileSync(instruction,'Owned gate instructions.\n');
    let before,changed=0,activated=0;
    const inspect=claudeDriver.inspect,activate=claudeDriver.activate;
    claudeDriver.inspect=()=>({state:state==='alive'?'alive':'unknown',id:'old-legacy'});
    claudeDriver.activate=()=>{activated++;return {ok:true};};
    const host={...r.host,...(instructions?{pipeline:()=>[{name:'worker',kind:'edits-tree'},{name:'reviewer',kind:'reads-diff',instructions:instruction}]}:{}),
      collectRules:()=>{
        if(!changed++){
          confirmed(f,address,current(f,address));
          before=readFileSync(f.file);
        }
        return [];
      }};
    try {
      const ran=await expectFail(()=>review(host,{target:r.repo,task:f.task,tool:r.tool('claude')}));
      assert.equal(changed,1,'the real reuse plan must pause after capturing its old participant');
      assert.equal(ran.failed,true,'stale reuse must refuse the whole assignment publication');
      assert.deepEqual(readFileSync(f.file),before,'current generation, Stop, subject, snapshot and mailbox stay byte-identical');
      assert.equal(activated,0,'stale reuse must not activate the newer participant');
    } finally {claudeDriver.inspect=inspect;claudeDriver.activate=activate;}
  });
}
for(const replacement of ['stop','generation']) {
  test('stale native reuse preserves current '+replacement,async()=>{
    const f=fixture(),r=repository(f),address='reviewer:fixture',stopped=confirmed(f,address);
    const p=current(f,address),{nativeStop,...metadata}=p.metadata;
    store.upsertParticipant(f.home,f.task,{...p,metadata:{...metadata,repo:'fixture',repoAbs:r.repo,name:p.sessionRef}});
    let before,changed=0,activated=0;
    const inspect=codexDriver.inspect,activate=codexDriver.activate;
    codexDriver.inspect=()=>({state:'alive',id:'old-native'});
    codexDriver.activate=()=>{activated++;return {ok:true};};
    const host={...r.host,collectRules:()=>{
      if(!changed++){
        retainNativeStop(stopped,nativeStop.receiptFile);
        if(replacement==='generation')reserveNativeParticipant(f.home,f.task,seat(address),current(f,address),REGISTRY);
        before=readFileSync(f.file);
      }
      return [];
    }};
    try {
      const ran=await expectFail(()=>review(host,{target:r.repo,task:f.task,tool:r.tool('codex')}));
      assert.equal(changed,1);assert.equal(ran.failed,true,'an old native reuse plan cannot publish after Stop or recovery');
      assert.deepEqual(readFileSync(f.file),before);assert.equal(activated,0);
    } finally {codexDriver.inspect=inspect;codexDriver.activate=activate;}
  });
}
test('native reuse accepts ordinary late mail without changing its launch binding',async()=>{
  const f=fixture(),r=repository(f),address='reviewer:fixture';
  const {record}=reserveNativeParticipant(f.home,f.task,seat(address),undefined,REGISTRY);
  store.upsertParticipant(f.home,f.task,{...record,metadata:{...record.metadata,repo:'fixture',repoAbs:r.repo,name:record.sessionRef}});
  let changed=0,mail;
  const inspect=codexDriver.inspect,activate=codexDriver.activate;
  codexDriver.inspect=()=>({state:'alive',id:'same-native'});codexDriver.activate=()=>({ok:true});
  const host={...r.host,collectRules:()=>{
    if(!changed++)mail=store.sendMessage(f.home,f.task,{from:'orchestrator',to:address,type:'task',body:'ordinary late mail',session:'closure-owner'}).message.id;
    return [];
  }};
  try {
    const ran=await expectFail(()=>review(host,{target:r.repo,task:f.task,tool:r.tool('codex')}));
    assert.equal(ran.failed,false,ran.out);assert.equal(changed,1);
    assert.equal(current(f,address).metadata.nativeLaunchId,record.metadata.nativeLaunchId);
    assert.ok(store.glanceInbox(f.home,f.task,address).some(m=>m.id===mail));
    assert.notEqual(current(f,address).metadata.assignmentAfterId,mail);
  } finally {codexDriver.inspect=inspect;codexDriver.activate=activate;}
});
for(const replacement of ['generation','stop']) {
  test('real initial legacy bind refuses a newer native '+replacement,async()=>{
    const f=fixture(),r=repository(f),address='reviewer:fixture',p=seat(address,'claude');
    store.upsertParticipant(f.home,f.task,p);
    const plan=claudeDriver.prepare({home:f.home,task:f.task,address,ref:p.sessionRef,role:'reviewer',cwd:r.repo,
      env:process.env,mcp:{servers:{}},prompt:'fixture',settingsPath:path.join(f.root,'settings.json'),mcpConfigPath:path.join(f.root,'mcp.json')});
    if(replacement==='stop')confirmed(f,address,p);
    else reserveNativeParticipant(f.home,f.task,seat(address),p,REGISTRY);
    const before=readFileSync(f.file),dispatch=path.join(f.root,'dispatch');
    stubCommand(path.join(f.root,'bin'),'stale-launch',"import {writeFileSync} from 'node:fs';writeFileSync("+JSON.stringify(dispatch)+",'unexpected');");
    const ran=await expectFail(()=>claudeDriver.spawn(plan,{tool:{bin:path.join(f.root,'bin','stale-launch')},
      home:f.home,task:f.task,address,ref:p.sessionRef,role:'reviewer',cwd:r.repo,env:process.env,host:r.host,
      persist:()=>{throw new Error('unexpected persist');},awaitOptions:{tries:1,delayMs:0,sessions:()=>[]}}));
    assert.equal(ran.failed,true);assert.deepEqual(readFileSync(f.file),before,'initial bind cannot corrupt native sessionId or pointer');
    assert.equal(existsSync(dispatch),false,'initial bind guard must run before launching even the fake executable');
  });
}
test('real legacy handshake mismatch writer preserves a newly reserved native binding',async()=>{
  const f=fixture(),r=repository(f),address='reviewer:fixture',p=seat(address,'claude');
  store.upsertParticipant(f.home,f.task,p);
  const pointer=store.participantSessionPath(f.home,f.task,address);
  mkdirSync(path.dirname(pointer),{recursive:true});
  const bound='11111111-1111-4111-8111-111111111111',named='22222222-2222-4222-8222-222222222222';
  writeFileSync(pointer,JSON.stringify({home:f.home,task:f.task,address,sessionId:bound}));
  let before,persisted=0;
  const ran=await expectFail(()=>liftoffParticipant({tool:r.tool('claude'),argv:[],cwd:r.repo,env:process.env,
    name:p.sessionRef,role:'reviewer',home:f.home,task:f.task,address,preboundSessionId:'old-prebound',preboundSessionRecord:pointer,
    persist:()=>{persisted++;},awaitOptions:{tries:1,delayMs:0,sessions:()=>{
      const {record}=reserveNativeParticipant(f.home,f.task,seat(address),current(f,address),REGISTRY);
      store.upsertParticipant(f.home,f.task,{...record,metadata:{...record.metadata,sessionId:bound,sessionRecord:pointer}});
      before=readFileSync(f.file);
      return [{name:p.sessionRef,id:named.slice(0,8),sessionId:named,pid:process.pid}];
    }}}));
  assert.equal(ran.failed,true);assert.ok(before);assert.deepEqual(readFileSync(f.file),before);
  assert.equal(persisted,0);
});
for(const expectedId of [undefined,42,'stale-launch']) {
  test('native initial bind refuses invalid expected launch '+expectedId,()=>{
    const f=fixture(),address='worker:one';
    const {record}=reserveNativeParticipant(f.home,f.task,seat(address),undefined,REGISTRY);
    const before=readFileSync(f.file);
    assert.throws(()=>bindBeforeLaunch(f.home,f.task,address,{sessionRecord:'old-pointer'},
      {...record,metadata:{...record.metadata,nativeLaunchId:expectedId}}),/unresolved/);
    assert.deepEqual(readFileSync(f.file),before);
  });
}
test('legacy handshake cannot bind a current native seat through a retained pointer',()=>{
  const f=fixture(),address='worker:one',stopped=confirmed(f,address),p=current(f,address);
  const pointer=store.participantSessionPath(f.home,f.task,address);
  mkdirSync(path.dirname(pointer),{recursive:true});writeFileSync(pointer,JSON.stringify({home:f.home,task:f.task,address,sessionId:null}));
  store.upsertParticipant(f.home,f.task,{...p,metadata:{...p.metadata,sessionRecord:pointer}});
  const before=readFileSync(f.file),record=readFileSync(pointer);
  assert.equal(bindHandshake(f.home,f.task,address,{[SESSION_RECORD_VAR]:pointer},'late-legacy'),null);
  assert.deepEqual(readFileSync(f.file),before);assert.deepEqual(readFileSync(pointer),record);
  assert.equal(current(f,address).metadata.nativeStop.launchId,stopped.launchId);
});
