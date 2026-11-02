// Execute the production cleanup boundary with held participant outcomes, without native binaries.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import * as cursorPersist from '../lib/cursor-persist.js';
import { recordVersion, sameRecordVersion } from '../lib/service-state.js';

const source = readFileSync(new URL('../scripts/live-cursor.mjs', import.meta.url), 'utf8');
const begin = source.includes('const PARTICIPANT_STOP_MS =') ? source.indexOf('const PARTICIPANT_STOP_MS =') : source.indexOf('onAbort((signal)');
const block = source.slice(begin, source.indexOf('const t0 = Date.now();', begin));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const transcriptStart = source.indexOf('function rememberTranscript(addr) {');
const transcriptEnd = source.indexOf('\n}', transcriptStart) + 2;
const callsStart = source.indexOf('  const toolCalls = () => {');
const callsEnd = source.indexOf('  const calledBus =', callsStart);
if (transcriptStart < 0 || transcriptEnd <= transcriptStart || callsStart < 0 || callsEnd <= callsStart) {
  throw new Error('Cursor transcript read boundaries are missing');
}
const transcriptRoot = makeSandbox('promptobus-promptobus-live-cursor-cleanup-');
const transcriptEnv = { ...process.env, PROMPTOBUS_CURSOR_HOME: path.join(transcriptRoot, 'state'),
  PROMPTOBUS_CURSOR_USER_HOME: path.join(transcriptRoot, 'user') };
const chatId = 'owned-transcript', ref = 'owned transcript bookkeeping';
const transcript = path.join(transcriptEnv.PROMPTOBUS_CURSOR_USER_HOME, 'projects', 'owned', 'agent-transcripts', chatId, `${chatId}.jsonl`);
mkdirSync(path.dirname(transcript), { recursive: true });
writeFileSync(transcript, JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'promptobus_send' }] } }) + '\n');
const transcriptContext = {
  ref, home: transcriptRoot, TASK: 'fixture', transcripts: new Map(), existsSync, readFileSync,
  store: { readTask: () => ({}), participantOf: () => ({ sessionRef: ref }) },
  readSession: owned => cursorPersist.readSession(owned, transcriptEnv),
  transcriptOf: record => cursorPersist.transcriptOf(record, transcriptEnv),
  findTranscript: id => cursorPersist.findTranscript(id, transcriptEnv),
};
const remember = new AsyncFunction(...Object.keys(transcriptContext),
  source.slice(transcriptStart, transcriptEnd) + '; return rememberTranscript("worker:live");');
const calls = new AsyncFunction(...Object.keys(transcriptContext), source.slice(callsStart, callsEnd) + '; return toolCalls();');
for (const cache of ['known', 'absent', 'deleted']) {
  for (const [name, read] of [['logs', remember], ['tool evidence', calls]]) {
    cursorPersist.writeSession({ ref, chatId, transcript: cache === 'known' ? transcript
      : cache === 'deleted' ? path.join(transcriptRoot, 'deleted.jsonl') : undefined }, transcriptEnv);
    const file = cursorPersist.sessionFile(ref, transcriptEnv), before = readFileSync(file), revision = recordVersion(file);
    const result = await read(...Object.values(transcriptContext));
    check(`live Cursor ${name}: ${cache} cache reads the actual transcript without changing registry bytes or revision`,
      (name === 'logs' ? result === transcript : result.length === 1 && result[0].includes('promptobus_send'))
      && sameRecordVersion(revision) && readFileSync(file).equals(before), JSON.stringify({ cache, result, unchanged: sameRecordVersion(revision) }));
  }
}
for (const unknown of [false, true]) {
  let release, abort, finished = false;
  const held = new Promise(resolve => { release = resolve; });
  const actions = [], budgets = [], lines = [];
  const context = {
    onAbort: callback => { abort = callback; }, writeSync: (_fd, line) => lines.push(line),
    keepTranscripts: () => {}, rememberProbeMarks: () => {},
    cursorDriver: { stop: async (ref, options) => {
      actions.push(`Stop ${ref}`); budgets.push(options.timeoutMs); await held;
      return { ok: !unknown, stopped: !unknown, note: unknown ? 'identity observation unavailable' : 'owned pane stopped' };
    } },
    store: { readTask: () => ({}), participantOf: (_task, address) => ({ sessionRef: `${address}-owned` }), liveWarden: () => null },
    readSession: () => ({ panePid: 43 }), pidAlive: () => false,
    taskService: { close: async () => { actions.push('service close'); return { stopped: true, process: { pid: 42, birth: 'owned' } }; } },
    processState: () => 'dead', existsSync: () => true, retainSandbox: () => actions.push('retain sandbox'),
    rmSync: () => actions.push('remove sandbox'),
    process: { kill: () => actions.push('legacy CLI group kill') },
  };
  const prelude = `const WORKER='worker:live', REVIEWER='reviewer:live', TASK='fixture', home='/home', SB='/sandbox', KEPT_LOGS='/logs';
    const warden={pid:42}; let ref='worker:live-owned', reviewerRef='reviewer:live-owned', taskCreated=true, serviceClosed=false;
    const serviceDirectory='/service';`;
  const exposed = await new AsyncFunction(...Object.keys(context), prelude + block
    + `return { cleanup: typeof cleanupRun === 'function' ? cleanupRun : null };`)(...Object.values(context));
  const normal = !unknown ? exposed.cleanup?.() : null;
  const result = abort('SIGTERM');
  const awaited = !!result && typeof result.then === 'function';
  const done = Promise.resolve(result).then(() => { finished = true; });
  await Promise.resolve(); await Promise.resolve();
  check(`live Cursor cleanup: ${unknown ? 'unknown' : 'positive'} starts both native Stops with one positive allowance and waits before service close`,
    awaited && !finished && budgets.length === 2 && budgets.every(ms => ms > 4000 && ms <= 5000)
    && !actions.includes('service close') && !actions.includes('legacy CLI group kill'), JSON.stringify({ awaited, finished, budgets, actions }));
  release(); await done;
  if (normal) await normal;
  check(`live Cursor cleanup: ${unknown ? 'unknown' : 'positive'} closes only its owned service and retains uncertainty`,
    actions.filter(action => action === 'service close').length === 1
    && actions.filter(action => action.startsWith('Stop ')).length === 2
    && actions.includes('retain sandbox') && actions.includes('remove sandbox') === !unknown
    && !actions.includes('legacy CLI group kill'), JSON.stringify({ actions, lines }));
}
