import { check } from './check.mjs';
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { makeSandbox } from './sandbox.mjs';
import { codexDriver, participantCodexHome } from '../lib/driver-codex.js';
import { dropSession, readSession, sessionFile, sessionKey, writeSession } from '../lib/codex-session.js';
import { createStandaloneHost } from '../dist/host-index.js';

const root = makeSandbox('promptobus-codex-');
const holderScript = fileURLToPath(new URL('../lib/codex-hold.js', import.meta.url));
const originalRead = fs.readFileSync;
const originalSpawn = cp.spawn;
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
const wait = predicate => {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('owned publication fixture deadline');
    pause();
  }
};
const selected = r => ({ launchId:r?.launchId, holderPid:r?.holderPid,
  rawToolReceipts:r?.rawToolReceipts, commandReceiptFile:r?.commandReceiptFile });

const fixture = path.join(root, 'holder.mjs');
fs.writeFileSync(fixture, `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readSession, patchSession, withSessionLaunch } from ${JSON.stringify(new URL('../lib/codex-session.js', import.meta.url).href)};
const [ref, launch, dir]=process.argv.slice(2), env=process.env;
const wait=file=>{ const until=Date.now()+4000; while(!existsSync(dir+'/'+file)) {
  if(Date.now()>=until) throw new Error('owned holder fixture deadline');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
}};
wait('publish');
withSessionLaunch(ref,env,()=>{
  const before=readSession(ref,env);
  if(before?.launchId!==launch) throw new Error('fixture launch changed');
  patchSession(ref,{rawToolReceipts:true,commandReceiptFile:dir+'/selected.jsonl'},env);
  writeFileSync(dir+'/published.json',JSON.stringify({before,after:readSession(ref,env)}));
});
wait('parent-done');
withSessionLaunch(ref,env,()=>{
  if(readSession(ref,env)?.launchId===launch)
    patchSession(ref,{state:'alive',threadId:'fixture-thread'},env);
});
`);

for (const mode of ['concurrent-publish', 'replacement']) {
  const dir = path.join(root, mode);
  fs.mkdirSync(dir);
  const env = { ...process.env, PROMPTOBUS_CODEX_HOME:path.join(dir,'registry'),
    PROMPTOBUS_CODEX_OWNER_HOME:path.join(dir,'owner'), PROMPTOBUS_CODEX_RAW_TOOL_RECEIPTS:'1',
    PROMPTOBUS_CODEX_READY_MS:'4000' };
  const ref = mode, launchId = mode+'-launch';
  const file = sessionFile(ref,env);
  const lockOwner = path.join(path.dirname(file), sessionKey(ref)+'.transition','owner');
  const home = participantCodexHome({task:'fixture',address:'worker:fixture'},env);
  const host = createStandaloneHost({cwd:dir,config:{tools:['codex'],rules:[]},extraEnv:env});
  const plan = codexDriver.prepare({cwd:dir,ref,role:'worker',prompt:'fixture',
    model:'gpt-6.1-sol',effort:'xhigh',permissionMode:'workspace-write',mcp:{servers:{}},env});
  plan.launchId = launchId;
  let child, exited, intercepted = false, initial, published, record, error, persisted = 0;
  cp.spawn = (bin,args,options) => {
    if (args[0] !== holderScript || args[1] !== file || args[2] !== launchId)
      throw new Error('unexpected process in owned spawn fixture');
    initial = readSession(ref,env);
    const actual = originalSpawn(bin,[fixture,ref,launchId,dir],options);
    child = actual;
    exited = new Promise(resolve=>actual.once('exit',(code,signal)=>resolve({code,signal})));
    if (mode==='replacement') {
      writeSession({...initial,launchId:'foreign-launch',state:'alive',threadId:'replacement-thread',
        holderPid:null,rawToolReceipts:true,commandReceiptFile:'replacement-receipt'},env);
      fs.writeFileSync(path.join(dir,'publish'),'');
      fs.writeFileSync(path.join(dir,'parent-done'),'');
    }
    return actual;
  };
  fs.readFileSync = (name,...args) => {
    const bytes = originalRead(name,...args);
    if (name !== file || mode!=='concurrent-publish') return bytes;
    const stack = new Error().stack;
    if (!intercepted && stack.includes('patchSession') && stack.includes('lib/driver-codex.js')) {
      intercepted = true;
      fs.writeFileSync(path.join(dir,'publish'),'');
      let locked = false;
      try { locked=JSON.parse(originalRead(lockOwner,'utf8')).pid===process.pid; } catch {}
      if (!locked) {
        wait(()=>fs.existsSync(path.join(dir,'published.json')));
        published=JSON.parse(originalRead(path.join(dir,'published.json'),'utf8'));
      }
    } else if (intercepted && stack.includes('waitReady')) {
      fs.writeFileSync(path.join(dir,'parent-done'),'');
    }
    return bytes;
  };
  syncBuiltinESMExports();
  try {
    await codexDriver.spawn(plan,{tool:{bin:'fixture-not-executed'},ref,role:'worker',cwd:dir,
      env,host,persist:()=>{persisted++;}});
  } catch (e) { error=e.message; }
  finally {
    cp.spawn=originalSpawn;
    fs.readFileSync=originalRead;
    syncBuiltinESMExports();
  }
  try {
    record=readSession(ref,env);
    child.ref();
    const result = await exited;
    if (mode==='concurrent-publish') {
      published??=JSON.parse(fs.readFileSync(path.join(dir,'published.json'),'utf8'));
      check('launch publication: actual spawn reaches initial record before holder publication',
        initial?.state==='starting' && initial.launchId===launchId && initial.holderPid===null
        && initial.rawToolReceipts===undefined && initial.commandReceiptFile===undefined);
      check('launch publication: child commits both raw fields for the same launch',
        published.after.launchId===launchId && published.after.rawToolReceipts===true
        && published.after.commandReceiptFile===path.join(dir,'selected.jsonl'));
      check('launch publication: actual parent update preserves both child-published fields',
        !error && intercepted && persisted===1 && record.holderPid===child.pid
        && record.rawToolReceipts===true && record.commandReceiptFile===published.after.commandReceiptFile,
        JSON.stringify({error,before:selected(initial),child:selected(published.after),after:selected(record)}));
      check('launch publication: owned fake holder exits without a model or app-server',result.code===0 && !result.signal);
    } else {
      check('launch publication: actual parent refuses a replacement generation before persistence',
        !!error && error.includes('launch ownership') && persisted===0,JSON.stringify({error,persisted}));
      check('launch publication: replacement record receives no old holder PID or cleanup',
        record.launchId==='foreign-launch' && record.holderPid===null
        && record.rawToolReceipts===true && record.commandReceiptFile==='replacement-receipt');
      check('launch publication: replaced owned fake holder exits without touching replacement',result.code!==0 && !result.signal);
    }
    console.log(JSON.stringify({mode,before:selected(initial),child:published?selected(published.after):null,
      after:selected(record),fixtureExit:result}));
  } finally {
    dropSession(ref,env);
    fs.rmSync(home,{recursive:true,force:true});
  }
}
fs.rmSync(root,{recursive:true,force:true});
