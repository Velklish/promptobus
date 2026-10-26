import { check } from './check.mjs';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeSandbox, stubCommand } from './sandbox.mjs';
import { expectFail, expectThrow } from './console.mjs';
import { codexDriver, codexHomeConfig, participantCodexHome } from '../lib/driver-codex.js';
import { readSession, reapHolder, dropSession, holderLogFile } from '../lib/codex-session.js';
import { readStopConfirmation } from '../lib/codex-command-receipts.js';
import { createStandaloneHost } from '../dist/host-index.js';
import { bus, createTask, participantOf, participantRecord, readTask } from '../lib/store.js';
import { persistNativeParticipant, requireNativeTerminal, reserveNativeParticipant } from '../lib/native-lifecycle.js';
import { done } from '../lib/done.js';
import { spawn as spawnParticipant } from '../lib/spawn.js';
import { REGISTRY } from '../lib/drivers.js';

const root = makeSandbox('promptobus-codex-');
process.env.CLAUDE_CODE_SESSION_ID = 'raw-profile-owner';
process.env.PROMPTOBUS_WARDEN = 'off';
const binDir = path.join(root, 'bin');
mkdirSync(binDir);
const bin = path.join(binDir, 'codex');
stubCommand(binDir, 'codex', `
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
let raw = false;
const emit = msg => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...msg})+'\\n');
for await (const line of readline.createInterface({input:process.stdin})) {
  const {id,method,params={}}=JSON.parse(line);
  appendFileSync(process.env.FIXTURE_TRACE,line+'\\n');
  if(method==='initialize') {
    emit({id,result:{userAgent:'fixture'}});
    emit({method:'account/rateLimits/updated',params:{primary:{usedPercent:0}}});
  } else if(method==='model/list') emit({id,result:{data:[{model:'gpt-6.1-sol'}]}});
  else if(method==='thread/start') { raw=params.experimentalRawEvents===true; emit({id,result:{thread:{id:'thread',turns:[]},model:'gpt-6.1-sol',reasoningEffort:'xhigh',sandbox:{type:'workspaceWrite',networkAccess:false},approvalPolicy:'on-request'}}); }
  else if(method==='turn/start') {
    emit({id,result:{turn:{id:'turn',status:'inProgress'}}});
    emit({method:'turn/started',params:{id:'turn'}});
    const event=(method,item)=>emit({method,params:{threadId:'thread',turnId:'turn',item}});
    if(raw) event('rawResponseItem/completed',{type:'function_call',call_id:'cmd',name:'exec_command',arguments:JSON.stringify({cmd:'fixture',workdir:process.cwd()})});
    const command={type:'commandExecution',id:'cmd',command:'/bin/zsh -c fixture',cwd:process.cwd()};
    event('item/started',{...command,status:'inProgress',exitCode:null});
    event('item/completed',{...command,status:'completed',exitCode:0});
    if(raw && process.env.FIXTURE_MISSING!=='1') event('rawResponseItem/completed',{type:'function_call_output',call_id:'cmd',output:'Chunk ID: fixture\\nWall time: 1 seconds\\nProcess exited with code 0\\nOutput:\\nfixture output'});
    emit({method:'turn/completed',params:{id:'turn',status:'completed'}});
  } else emit({id,result:{}});
}
`);

const direct = '[features.code_mode]\ndirect_only_tool_namespaces = ["functions"]';
const normal = codexHomeConfig();
check('raw profile: default home configuration remains unchanged', normal === '[features]\napps = false\n');
check('raw profile: explicit capture requests the whole functions namespace directly',
  codexHomeConfig({ rawToolReceipts: true }).includes(direct));
check('raw profile: presentation configuration adds no authority or tier override',
  codexHomeConfig({ rawToolReceipts: true }).replace(`\n\n${direct}`, '') === normal);

for (const kind of ['default','selected','selected-recovery','missing-original']) {
  const selected=kind!=='default', missing=kind==='missing-original';
  const registry = path.join(root, kind);
  const store = path.join(root, kind+'-store');
  bus(store,{cli:'0.29.0'});
  createTask(store,{id:'profile',owner:'raw-profile-owner'});
  const owner = path.join(root, 'owner');
  mkdirSync(owner, { recursive: true });
  writeFileSync(path.join(owner,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'fixture-not-a-real-credential'}));
  const env = { ...process.env, PROMPTOBUS_CODEX_HOME: registry, PROMPTOBUS_CODEX_OWNER_HOME: owner,
    PROMPTOBUS_CODEX_RAW_TOOL_RECEIPTS: selected ? '1' : '', PROMPTOBUS_CODEX_LIMIT_MS:'20', FIXTURE_TRACE:path.join(root,kind+'.jsonl'), FIXTURE_MISSING:missing?'1':'' };
  const ref = kind;
  const {record:reserved}=reserveNativeParticipant(store,'profile',
    participantRecord(`worker:${ref}`,{harness:'codex',sessionRef:ref}),null,REGISTRY);
  const home = participantCodexHome({ task:'profile', address:`worker:${ref}` }, env);
  const host = createStandaloneHost({ cwd:root, home:store, config:{tools:['codex'],rules:[]}, extraEnv:env });
  const plan = codexDriver.prepare({ cwd:root,ref,task:'profile',address:`worker:${ref}`,role:'worker',
    prompt:'fixture',model:'gpt-6.1-sol',effort:'xhigh',permissionMode:'workspace-write',
    mcp:{servers:{catalog:{command:'fixture-not-executed'}}},denyTools:[{server:'catalog',tool:'delete'}],env });
  plan.launchId=reserved.metadata.nativeLaunchId;
  try {
    const spawned = await codexDriver.spawn(plan, { tool:{bin}, ref, role:'worker', cwd:root, env, host,
      home:store,task:'profile', address:`worker:${ref}`, persist:id=>persistNativeParticipant(store,'profile',reserved,{sessionId:id}) });
    const trace=readFileSync(env.FIXTURE_TRACE,'utf8').trim().split('\n').map(JSON.parse);
    const config = readFileSync(path.join(home, 'config.toml'), 'utf8');
    const record = readSession(ref, env);
    check(`raw profile: production ${ref} launch writes only its selected presentation`,
      config.includes(direct) === selected && record?.rawToolReceipts === selected, JSON.stringify({config,record}));
    check(`raw profile: production ${ref} keeps requested sandbox/approval and fixture identity`,
      record?.sandbox === 'workspace-write' && record.approvalPolicy === 'on-request' && spawned.session === 'thread');
    const request=trace.find(msg=>msg.method==='thread/start')?.params;
    check(`raw profile: production ${ref} pins model, effort, roots, raw request and role denials`,
      record?.model==='gpt-6.1-sol' && record.effort==='xhigh' && record.addDirs.join()===root
      && request?.config?.model_reasoning_effort==='xhigh' && request?.model==='gpt-6.1-sol' && request.sandbox==='workspace-write' && request.approvalPolicy==='on-request'
      && !!request.experimentalRawEvents===selected && config.includes('disabled_tools = ["delete"]')
      && readFileSync(holderLogFile(ref,env),'utf8').includes('network=restricted'));
    check(`raw profile: production ${ref} does not create owner configuration`, !existsSync(path.join(owner,'config.toml')));
    const prior=process.env.PROMPTOBUS_CODEX_HOME;
    process.env.PROMPTOBUS_CODEX_HOME=registry;
    let stop;
    try { stop=await codexDriver.stop(ref,{timeoutMs:missing?100:3000}); }
    finally { if(prior===undefined) delete process.env.PROMPTOBUS_CODEX_HOME; else process.env.PROMPTOBUS_CODEX_HOME=prior; }
    check(`raw profile: production ${ref} Stop preserves the selected receipt requirement`,
      missing ? !stop.ok && stop.attempted && !stop.stopped && existsSync(home) && readSession(ref,env)?.launchId===record.launchId
        : stop.ok && !readSession(ref,env) && !existsSync(home),JSON.stringify(stop));
    const proof=readStopConfirmation(record.commandReceiptFile,record);
    check(`raw profile: production ${ref} recovery revalidates actual selected proof`,missing?!proof.ok:proof.ok,JSON.stringify(proof));
    if(selected&&!missing) check('raw profile: recovery cannot omit the selected original requirement',
      !readStopConfirmation(record.commandReceiptFile,{...record,rawToolReceipts:false}).ok);
    if(!missing) {
      const meta=readTask(store,'profile'), participant=participantOf(meta,`worker:${ref}`);
      check(`raw profile: production ${ref} retains the actual receipt selection after Stop`,
        participant.metadata.nativeStop?.rawToolReceipts===selected);
      const terminal=expectThrow(()=>requireNativeTerminal(store,meta,participant,env));
      check(`raw profile: production ${ref} retained proof admits terminal readback`,!terminal.threw,terminal.msg);
      if(selected) for(const rawToolReceipts of [undefined,false]) {
        const altered={...participant,metadata:{...participant.metadata,nativeStop:{...participant.metadata.nativeStop,rawToolReceipts}}};
        check(`raw profile: retained ${ref} proof refuses omitted or false selection ${rawToolReceipts}`,
          expectThrow(()=>requireNativeTerminal(store,meta,altered,env)).threw);
      }
      const before=process.env.PROMPTOBUS_CODEX_HOME;
      process.env.PROMPTOBUS_CODEX_HOME=registry;
      try {
        if(kind==='selected-recovery') {
          const repo=path.join(root,'fixture');
          mkdirSync(repo);
          for(const args of [['init','-q','-b','main'],['-c','user.name=fixture','-c','user.email=fixture@invalid','commit','-q','--allow-empty','-m','base']]) {
            const git=spawnSync('git',['-C',repo,...args],{encoding:'utf8'});
            check('raw profile: recovery fixture Git setup succeeds',git.status===0,git.stderr);
          }
          writeFileSync(path.join(repo,'AGENTS.md'),'Fixture rules.\n');
          const brief=path.join(root,'brief.md');
          writeFileSync(brief,'Do not execute model work.\n');
          let resources=0;
          const recoveryHost={...host,resolveRepo:async()=>({nsPath:'fixture',via:'fixture'}),
            repoAbsPath:()=>repo,isClone:()=>true,defaultBranch:()=> 'main',reportFresh:()=>{},
            freshenRepo:()=>{ resources++; throw new Error('fixture resource boundary'); }};
          const stoppedTrace=readFileSync(env.FIXTURE_TRACE,'utf8');
          const recovered=await expectFail(()=>spawnParticipant(recoveryHost,{repo:'fixture',task:'profile',worker:ref,brief,harness:'codex',
            tool:{ok:true,bin,version:'0.163.0',source:'fixture'},sessions:{}}));
          const current=participantOf(readTask(store,'profile'),`worker:${ref}`);
          check('raw profile: public recovery validates strict Stop before reserving a fresh launch',
            recovered.failed && resources===1 && current.metadata.nativeLaunchId!==record.launchId
            && current.metadata.nativeUnlaunched===current.metadata.nativeLaunchId && !current.metadata.nativeStop,recovered.out);
          check('raw profile: recovery stops at the fixture resource boundary without another app-server',
            !readSession(ref,env) && readFileSync(env.FIXTURE_TRACE,'utf8')===stoppedTrace);
        } else {
          const closed=await expectFail(()=>done(host,{task:'profile','keep-sessions':true,snapshot:()=>({}),
            adapterFor:()=>({probe:()=>({available:'unknown'})})}));
          check(`raw profile: public ${ref} done accepts the actual retained Stop`,
            !closed.failed && readTask(store,'profile').status==='done',closed.out);
        }
      } finally { if(before===undefined) delete process.env.PROMPTOBUS_CODEX_HOME; else process.env.PROMPTOBUS_CODEX_HOME=before; }
    }
  } finally {
    await reapHolder(ref, env);
    dropSession(ref, env);
    rmSync(home, {recursive:true,force:true});
  }
}
rmSync(root, { recursive:true,force:true });
