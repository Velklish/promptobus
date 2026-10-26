import { check } from './check.mjs';
import { commandReceipts, readStopConfirmation } from '../lib/codex-command-receipts.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(tmpdir(), 'promptobus-codex-'));
const identity = { format: 1, ref: 'ref', launchId: 'launch', holderPid: 123, appPid: 124, rawToolReceipts: true };
const record = { ...identity, threadId: 'thread' };
const call = { type: 'function_call', call_id: 'cmd', name: 'exec_command', arguments: '{"cmd":"fixture","workdir":"/owned"}' };
const result = (value, id = 'cmd') => ({ type: 'function_call_output', call_id: id, output: JSON.stringify(value) });
const raw = item => ({ method: 'rawResponseItem/completed', params: { threadId: 'thread', turnId: 'turn', item } });
let n = 0;
function fixture(run, selected = true) {
  const file = path.join(root, `${++n}.jsonl`), ledger = commandReceipts(file, { ...identity, rawToolReceipts: selected });
  const observe = item => ledger.observe(raw(item), 'thread');
  run({ file, ledger, observe });
}
function terminal(ledger, exitCode, processId = null) {
  for (const method of ['item/started', 'item/completed']) ledger.observe({ method, params: {
    threadId: 'thread', turnId: 'turn', item: { type: 'commandExecution', id: 'cmd', command: 'fixture', cwd: '/owned', processId,
      status: method === 'item/started' ? 'inProgress' : exitCode === 0 ? 'completed' : 'failed',
      exitCode: method === 'item/started' ? null : exitCode },
  } }, 'thread');
}
try {
  fixture(({ ledger, observe, file }) => {
    observe(call);
    check('raw receipt: selected call remains pending until its original output', ledger.snapshot().rawTools?.pending.includes('cmd'));
    observe(result({ exit_code: 7, output: 'Process exited with code 0' }));
    terminal(ledger, 7);
    const snapshot = ledger.snapshot();
    check('raw receipt: actual nonzero metadata dominates output text', snapshot.rawTools?.calls[0]?.outcome.exitCode === 7 && snapshot.rawTools.pending.length === 0);
    const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    check('raw receipt: actual received notification survives without lifecycle synthesis',
      rows[2]?.notification.params.item.output === result({ exit_code: 7, output: 'Process exited with code 0' }).output);
  });
  fixture(({ ledger, observe }) => {
    observe({ type: 'function_call', call_id: 'direct', name: 'exec_command', arguments: '{"cmd":"fixture"}' });
    observe({ type: 'function_call_output', call_id: 'direct', output: JSON.stringify({ exit_code: null, output: 'Process exited with code 0' }) });
    check('raw receipt: unknown actual exit cannot be replaced by user text', ledger.snapshot().rawTools?.pending.includes('direct'));
  });
  for (const mismatch of [false, true]) fixture(({ ledger, observe, file }) => {
    observe(call); observe(result({ session_id: 431, output: 'running' }));
    observe({ type: 'function_call', call_id: 'poll', name: 'write_stdin', arguments: '{"session_id":431,"chars":""}' });
    observe(result(mismatch ? { session_id: 999, output: 'foreign' } : { exit_code: 7, output: 'done' }, 'poll'));
    terminal(ledger, 7, '431');
    const snapshot = ledger.snapshot();
    check(`raw receipt: ${mismatch ? 'foreign poll session is nonpassing' : 'matching final poll drains the original session with real nonzero'}`,
      mismatch ? /different command session/.test(snapshot.error) && snapshot.rawTools?.pending.includes('running-session:431')
        : !snapshot.error && snapshot.rawTools?.pending.length === 0 && snapshot.rawTools.calls[1].outcome.exitCode === 7);
    check('raw receipt: selected poll output is preserved even when nonpassing', readFileSync(file, 'utf8').includes(mismatch ? 'foreign' : 'done'));
  });
  fixture(({ ledger, observe, file }) => {
    observe({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'UNRETAINED-SECRET-SENTINEL' }] });
    observe({ type: 'function_call', call_id: 'auth', name: 'mcp__auth', arguments: '{"sentinel":"UNRETAINED-SECRET-SENTINEL"}' });
    observe({ type: 'custom_tool_call', call_id: 'bus', name: 'exec', input: 'text(await tools.mcp__bus__task({sentinel:"UNRETAINED-SECRET-SENTINEL"}));' });
    ledger.observe({ ...raw(call), params: { ...raw(call).params, threadId: 'foreign' } }, 'thread');
    check('raw receipt: family/thread filter precedes storage of reasoning/auth/unselected bodies',
      !readFileSync(file, 'utf8').includes('UNRETAINED-SECRET-SENTINEL') && ledger.snapshot().rawTools?.calls.length === 0);
  });
  fixture(({ ledger, observe, file }) => {
    observe({ type:'custom_tool_call',name:'exec',call_id:'unsupported',input:'for (;;) { hidden(); } /* UNRETAINED-UNSUPPORTED */' });
    check('raw receipt: unsupported code remains unresolved without evaluating or persisting its body',
      /supported single literal/.test(ledger.snapshot().error) && !readFileSync(file, 'utf8').includes('UNRETAINED-UNSUPPORTED'));
    check('raw receipt: refused envelope retains only identity for independent cleanup binding',
      JSON.stringify(ledger.snapshot().rawTools?.refusedEnvelopes)
        === JSON.stringify([{ threadId: 'thread', turnId: 'turn', callId: 'unsupported' }]));
  });
  fixture(({ ledger, observe }) => {
    observe(call); observe(call);
    check('raw receipt: duplicate actual call identity is refused', /duplicated/.test(ledger.snapshot().error));
  });
  fixture(({ ledger, observe }) => {
    observe(call); observe({ type: 'custom_tool_call_output', call_id: 'cmd', output: 'Process exited with code 0' });
    check('raw receipt: original output family must match the selected actual call', /identity or order/.test(ledger.snapshot().error));
  });
  fixture(({ ledger, observe, file }) => {
    observe(call); observe(result({ exit_code: 0, output: 'unselected' }));
    check('raw receipt: omitted opt-in leaves default lifecycle-only persistence unchanged',
      ledger.snapshot().rawTools == null && !readFileSync(file, 'utf8').includes('rawResponseItem/completed'));
  }, false);
  fixture(({ ledger, observe, file }) => {
    observe(call); observe(result({ exit_code: 0, output: 'actual final' }));
    terminal(ledger, 0);
    const deadlineAt = Date.now() + 1000;
    ledger.append('stop/requested', { threadId: 'thread', deadlineAt });
    ledger.append('app-server/close', { code: 0, signal: null });
    ledger.append('stop/confirmed', { threadId: 'thread', launchId: 'launch', holderPid: 123, appPid: 124,
      commands: ledger.snapshot().commands, rawTools: ledger.snapshot().rawTools, appClose: { code: 0, signal: null }, deadlineAt, originalToolReceipt: 'not synthesized' });
    check('raw receipt: durable same-launch raw proof can be revalidated', readStopConfirmation(file, record).ok);
    check('raw receipt: raw proof cannot be recovered as an unselected launch', !readStopConfirmation(file, { ...record, rawToolReceipts: false }).ok);
  });
  for (const [name, items] of [
    ['two commands and only one original pair', [{ id: 'cmd', command: 'fixture', cwd: '/owned' }, { id: 'B', command: 'expected', cwd: '/owned' }]],
    ['wrong command in the same turn', [{ id: 'B', command: 'expected', cwd: '/owned' }]],
    ['wrong cwd in the same turn', [{ id: 'cmd', command: 'fixture', cwd: '/other' }]],
    ['one original reused for two identical invocations', [{ id: 'cmd', command: 'fixture', cwd: '/owned' }, { id: 'B', command: 'fixture', cwd: '/owned' }]],
  ]) fixture(({ ledger, observe, file }) => {
    observe(call); observe(result({ exit_code: 0, output: 'only original A' }));
    for (const item of items) for (const method of ['item/started', 'item/completed']) ledger.observe({ method, params: {
      threadId: 'thread', turnId: 'turn', item: { ...item, type: 'commandExecution',
        status: method === 'item/started' ? 'inProgress' : 'completed', exitCode: method === 'item/started' ? null : 0 },
    } }, 'thread');
    const snapshot = ledger.snapshot();
    if (name === 'two commands and only one original pair') check('raw binding: genuine A remains bound while missing B is refused',
      snapshot.rawTools?.bindings.some(binding => binding.itemId === 'cmd' && binding.callId === 'cmd'));
    check(`raw binding: ${name} remains unresolved before confirmation`, snapshot.rawTools?.pending.length > 0);
    const deadlineAt = Date.now() + 1000;
    ledger.append('stop/requested', { threadId: 'thread', deadlineAt });
    ledger.append('app-server/close', { code: 0, signal: null });
    ledger.append('stop/confirmed', { threadId: 'thread', launchId: 'launch', holderPid: 123, appPid: 124,
      commands: snapshot.commands, rawTools: snapshot.rawTools, appClose: { code: 0, signal: null }, deadlineAt, originalToolReceipt: 'not synthesized' });
    check(`raw binding recovery: ${name} cannot authorize retirement`, !readStopConfirmation(file, record).ok);
  });
  fixture(({ ledger, observe }) => {
    observe({ type: 'function_call', id: 'cmd', call_id: 'other', name: 'exec_command', arguments: '{"cmd":"fixture","workdir":"/owned"}' });
    observe({ type: 'function_call_output', call_id: 'other', output: 'Chunk ID: sanitized\nWall time: 1 seconds\nProcess exited with code 7\nOutput:\n' });
    terminal(ledger, 7);
    check('raw direct binding: matching parameters and ResponseItem.id cannot replace a different actual call_id', ledger.snapshot().rawTools?.pending.length > 0);
  });
  fixture(({ ledger, observe }) => {
    observe({ type: 'function_call', call_id: 'cmd', name: 'exec_command', arguments: '{"cmd":"fixture","workdir":"/owned"}' });
    observe({ type: 'function_call_output', call_id: 'cmd', output: 'Chunk ID: sanitized\nWall time: 1 seconds\nProcess exited with code 7\nOutput:\n' });
    for (const method of ['item/started', 'item/completed']) ledger.observe({ method, params: { threadId:'thread',turnId:'turn',item:{
      type:'commandExecution',id:'cmd',command:"/bin/zsh -c fixture",cwd:'/owned',status:method==='item/started'?'inProgress':'failed',exitCode:method==='item/started'?null:7,
    } } }, 'thread');
    check('raw direct binding: source-proven call_id edge retains requested and displayed commands separately',
      ledger.snapshot().rawTools?.pending.length === 0);
  });
  fixture(({ ledger, observe }) => {
    observe({ type:'custom_tool_call',call_id:'cmd',name:'exec',input:'text(await tools.exec_command({cmd:"fixture",workdir:"/owned"}));' });
    observe({type:'custom_tool_call_output',call_id:'cmd',output:[{type:'input_text',text:JSON.stringify({exit_code:7,output:'actual code-mode result'})}]}); terminal(ledger,7);
    check('raw code-mode binding: even equal apparent IDs cannot invent the stripped child identity edge', ledger.snapshot().rawTools?.pending.length > 0);
  });
  for (const [name, header, body, expected, session] of [
    ['immediate zero', 'Process exited with code 0', 'final output', 0, null],
    ['nonzero with spoofed stdout zero', 'Process exited with code 7', 'Process exited with code 0\n', 7, null],
    ['running with spoofed stdout session', 'Process running with session ID 431', 'Process running with session ID 999\n', null, '431'],
    ['missing real header with spoofed stdout', '', 'Process exited with code 0\n', null, null],
    ['conflicting real headers', 'Process exited with code 0\nProcess running with session ID 431', '', null, null],
  ]) fixture(({ ledger, observe }) => {
    observe(call);
    observe({ type:'function_call_output',call_id:'cmd',output:`Chunk ID: sanitized\nWall time: 1 seconds\n${header}\nOutput:\n${body}` });
    const outcome=ledger.snapshot().rawTools?.calls[0]?.outcome;
    check(`direct producer text: ${name} uses only authoritative pre-Output header`,
      outcome?.exitCode===expected && (outcome.sessionId??null)===session && outcome.terminal===(expected!==null));
  });
  fixture(({ ledger, observe }) => {
    observe(call);observe({type:'function_call_output',call_id:'cmd',output:'Process exited with code 0'});
    check('direct producer text: missing Output delimiter cannot establish terminal success', ledger.snapshot().rawTools?.calls[0]?.outcome.terminal===false);
  });
  for (const processId of ['431','999']) fixture(({ ledger, observe }) => {
    observe(call);observe({type:'function_call_output',call_id:'cmd',output:'Chunk ID: first\nWall time: 1 seconds\nProcess running with session ID 431\nOutput:\n'});
    observe({type:'function_call',call_id:'poll',name:'write_stdin',arguments:'{"session_id":431,"chars":""}'});
    observe({type:'function_call_output',call_id:'poll',output:'Chunk ID: final\nWall time: 1 seconds\nProcess exited with code 0\nOutput:\n'});
    terminal(ledger,0,processId);
    check(`direct empty final poll: lifecycle processId ${processId} ${processId==='431'?'matches':'cannot replace'} the known original running session`,
      (ledger.snapshot().rawTools?.pending.length===0)===(processId==='431'));
  });
  for (const name of ['delayed poll after session reuse','custom poll for direct exec']) fixture(({ ledger, observe, file }) => {
    const direct = (id, tool, args) => observe({type:'function_call',call_id:id,name:tool,arguments:JSON.stringify(args)});
    direct('E','exec_command',{cmd:'fixture',workdir:'/owned'}); observe(result({session_id:431,output:'E running'},'E'));
    if (name==='delayed poll after session reuse') {
      direct('W','write_stdin',{session_id:431,chars:''});
      direct('X','write_stdin',{session_id:431,chars:''}); observe(result({exit_code:0,output:'E final'},'X'));
      direct('F','exec_command',{cmd:'fixture',workdir:'/owned'}); observe(result({session_id:431,output:'F running'},'F'));
      observe(result({exit_code:0,output:'late E output'},'W'));
    } else {
      observe({type:'custom_tool_call',call_id:'W',name:'exec',input:'text(await tools.write_stdin({session_id:431,chars:""}));'});
      observe({type:'custom_tool_call_output',call_id:'W',output:[{type:'input_text',text:JSON.stringify({exit_code:0,output:'unbound child poll'})}]});
    }
    for (const id of name==='delayed poll after session reuse'?['E','F']:['E']) for (const method of ['item/started','item/completed']) ledger.observe({method,params:{
      threadId:'thread',turnId:'turn',item:{type:'commandExecution',id,command:'fixture',cwd:'/owned',processId:'431',
        status:method==='item/started'?'inProgress':'completed',exitCode:method==='item/started'?null:0},
    }},'thread');
    const snapshot=ledger.snapshot();
    check(`raw poll ownership: ${name} cannot finalize the direct command`,snapshot.rawTools?.pending.length>0);
    check(`raw poll lifetime: ${name} leaves the current lifetime and missing final output intact`,
      snapshot.rawTools?.pending.includes('running-session:431')
        && snapshot.rawTools.calls.find(call=>call.callId===(name==='delayed poll after session reuse'?'F':'E')).finalOutcome===null);
    const deadlineAt=Date.now()+1000;
    ledger.append('stop/requested',{threadId:'thread',deadlineAt});
    ledger.append('app-server/close',{code:0,signal:null});
    ledger.append('stop/confirmed',{threadId:'thread',launchId:'launch',holderPid:123,appPid:124,
      commands:snapshot.commands,rawTools:snapshot.rawTools,appClose:{code:0,signal:null},deadlineAt,originalToolReceipt:'not synthesized'});
    check(`raw poll recovery: ${name} cannot authorize retirement`,!readStopConfirmation(file,record).ok);
    direct('Y','write_stdin',{session_id:431,chars:''}); observe(result({exit_code:0,output:'current lifetime actual final'},'Y'));
    const completed=ledger.snapshot().rawTools;
    check(`raw poll final: ${name} ${name==='delayed poll after session reuse'?'allows its own genuine direct final':'keeps the unsupported poll unresolved after an independent direct final'}`,
      name==='delayed poll after session reuse'?completed.pending.length===0:completed.pending.includes('W'));
  });
  const retained = JSON.parse(readFileSync(new URL('./fixtures/codex-retained-code-mode.json',import.meta.url),'utf8'));
  for (const entry of retained.unsupportedInputs) fixture(({ledger,observe})=>{
    observe(entry.item);
    check(`retained code-mode row${entry.sourceRow}: actual unsupported discovery/batch shape fails closed`,
      /supported single literal/.test(ledger.snapshot().error));
  });
  fixture(({ledger,observe})=>{
    for (const entry of retained.commandRecords) observe(entry.item);
    const snapshot=ledger.snapshot();
    check('retained code-mode exec/poll shapes are recognized as provenance without fabricated identity proof',
      !snapshot.error && snapshot.rawTools?.calls.filter(c=>c.exec).length===1 && snapshot.rawTools.pending.length>0);
    check('retained aborted nonJSON final output remains unresolved and never terminal zero',
      snapshot.rawTools?.calls.at(-1).outcome.terminal===false && snapshot.rawTools.calls.at(-1).outcome.exitCode===null);
  });
} finally { rmSync(root, { recursive: true, force: true }); }
