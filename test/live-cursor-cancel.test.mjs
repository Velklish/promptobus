// Execute the production cleanup boundary with held participant outcomes, without native binaries.
import { readFileSync } from 'node:fs';
import { check } from './check.mjs';

const source = readFileSync(new URL('../scripts/live-cursor.mjs', import.meta.url), 'utf8');
const begin = source.includes('const PARTICIPANT_STOP_MS =') ? source.indexOf('const PARTICIPANT_STOP_MS =') : source.indexOf('onAbort((signal)');
const block = source.slice(begin, source.indexOf('const t0 = Date.now();', begin));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
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
