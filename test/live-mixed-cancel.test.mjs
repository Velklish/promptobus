// Execute the production scenario and abort block with a held hello and stop, without binaries.
import { readFileSync } from 'node:fs';
import { check } from './check.mjs';

const source = readFileSync(new URL('../scripts/live-mixed.mjs', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('const ABORT_STOP_MS ='), source.indexOf('if (!aborted) {\n  // --- hygiene:'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

async function runCase(boundary) {
  const hello = deferred(), stop = deferred(), waiting = deferred(), stopping = deferred();
  const actions = [], lines = [];
  let abort, waits = 0, aborted = false, stopCalls = 0;
  const context = {
    onAbort: (fn) => { abort = fn; },
    writeSync: (_fd, line) => lines.push(line),
    wardenDemand: { status: 0, out: '' },
    taskService: { status: async () => ({ running: true, process: { pid: 42, birth: 'owned-fixture' } }) },
    closeService: async () => { actions.push('warden stop'); return { stopped: true }; },
    waitFor: async (probe) => {
      waits += 1;
      if (waits === 2) { waiting.resolve(); await hello.promise; }
      return probe();
    },
    store: {
      createTask: () => actions.push('task create'),
      liveWarden: () => ({ pid: 42 }), readTask: () => ({}),
      participantOf: (_task, address) => ({ sessionRef: address === 'worker:live' ? 'owned-worker' : 'owned-reviewer',
        metadata: { harness: 'cursor', worktree: '/fixture' } }),
      tailWardenLog: () => [], sendMessage: () => actions.push('bus send'),
    },
    cli: ([command]) => { actions.push(command); return { status: 0, out: 'worker worker:live lifted reviewer reviewer:live started' }; },
    cursorDriver: { id: 'cursor', inspect: () => ({ state: 'alive' }), stop: async (ref) => {
      stopCalls += 1; actions.push(`worker stop ${ref}`); stopping.resolve();
      if (stopCalls === 1) await stop.promise;
      return { ok: true, stopped: true };
    } },
    codexDriver: { stop: async (ref) => { actions.push(`reviewer stop ${ref}`); return { ok: true, stopped: true }; } },
    cursorPersist: { readSession: () => ({ sessionName: 'pane' }), pidAlive: () => false },
    codexSession: { readSession: () => ({ threadId: 'thread', state: 'alive', holderPid: 44, sandbox: 'read-only' }),
      pidAlive: () => false, tailLog: () => '' },
    keepLogs: () => {}, keepCommandReceipts: () => {}, panePidOf: () => 43, holderPidsOf: () => [44, 45], existsSync: () => true,
    rememberTranscript: () => {}, rememberProbeMark: () => {}, at_: () => {},
    check: (name) => actions.push(`check ${name}`),
    commitSubject: () => { actions.push('commit subject'); return { status: 0 }; },
    said: () => boundary === 'timeout' ? null : { body: 'hello' },
    orchInbox: () => [], listing: () => [], sentBy: () => false, messageKey: () => '',
    unseenResult: () => null, reportMentionsDiff: () => false,
    rmSync: () => actions.push('remove sandbox'), retainSandbox: () => actions.push('retain sandbox'), path: { join: (...parts) => parts.join('/') },
    requiredTmuxSessions: () => [],
  };
  const prelude = `let workerRef = '', reviewerRef = '', codexStateBeforeCleanup = [];
    const SB = '/sandbox', KEPT_LOGS = '/logs', WORKER = 'worker:live', REVIEWER = 'reviewer:live';
    const home = '/home', TASK = 'fixture', repo = 'repo', repoAbs = '/fixture', ws = '/fixture', ORCH_SESSION = 'orch-fixture';
    const env = {}, wardenEnv = {}, workerBrief = '/brief', identity = { title: 'fixture' }, CURSOR_MODEL = 'stub', CODEX_MODEL = 'stub';
    const CODEX_STATE = '/codex', MARK = { hello: 'hello', reviewA: 'a', fix: 'fix', reviewB: 'b' };
  `;
  const execute = new AsyncFunction(...Object.keys(context), prelude + block);
  const main = execute(...Object.values(context));
  await waiting.promise;
  const cleanup = abort('SIGTERM');
  aborted = true;
  await stopping.promise;
  const atAbort = actions.length;
  hello.resolve();
  await main;
  const afterHello = actions.slice(atAbort);
  const held = stopCalls === 1 && !actions.includes('remove sandbox');
  const retainedBeforeStop = actions.includes('retain sandbox');
  stop.resolve();
  await main;
  await cleanup;
  return { aborted, held, retainedBeforeStop, stopCalls, afterHello, actions, lines };
}

for (const boundary of ['result', 'timeout']) {
  const run = await runCase(boundary);
  check(`mixed pending retention: ${boundary} transfers owned sandbox exit cleanup before awaiting the held native Stop`,
    run.retainedBeforeStop && run.actions.filter(action => action === 'retain sandbox').length === 1, JSON.stringify(run));
  check(`mixed cancellation: ${boundary} released while worker stop is held cannot raise a reviewer or perform later actions`,
    run.aborted && run.held && run.afterHello.length === 0
    && !run.actions.includes('review') && !run.actions.includes('bus send'), JSON.stringify(run));
  check(`mixed cancellation: ${boundary} leaves cleanup with the owned worker and sandbox until its stop completes`,
    run.stopCalls === 1 && run.held && run.lines.some((line) => line.includes('"ref":"owned-worker"')),
    JSON.stringify(run));
}

const abortBlock = source.slice(source.indexOf('const ABORT_STOP_MS ='), source.indexOf('const t0 = Date.now();'));
for (const unavailable of ['status', 'close']) {
  const actions = [], lines = [];
  let abort;
  const context = {
    onAbort: (fn) => { abort = fn; }, writeSync: (_fd, line) => lines.push(line),
    keepLogs: () => {}, keepCommandReceipts: () => {}, panePidOf: () => 43, holderPidsOf: () => [44, 45],
    taskService: { status: async () => { throw new Error('service status unavailable'); } },
    closeService: async () => {
      actions.push('service close');
      if (unavailable === 'close') throw new Error('service close unavailable');
      return { stopped: true, process: { pid: 42, birth: 'owned-fixture' } };
    },
    cursorDriver: { stop: async (ref) => { actions.push(`worker stop ${ref}`); return { ok: true, stopped: true }; } },
    codexDriver: { stop: async (ref) => { actions.push(`reviewer stop ${ref}`); return { ok: true, stopped: true }; } },
    cursorPersist: { pidAlive: () => false }, codexSession: { pidAlive: () => false },
    existsSync: () => true, store: { liveWarden: () => null }, retainSandbox: () => actions.push('retain sandbox'),
    rmSync: () => actions.push('remove sandbox'),
  };
  const prelude = `const workerRef = 'owned-worker', reviewerRef = 'owned-reviewer';
    const SB = '/sandbox', KEPT_LOGS = '/logs', home = '/home', TASK = 'fixture';`;
  await new AsyncFunction(...Object.keys(context), prelude + abortBlock)(...Object.values(context));
  let error = null;
  await abort('SIGTERM').catch((failure) => { error = failure.message; });
  check(`mixed abort: unavailable service ${unavailable} still attempts both native stops and service close`,
    error === null && actions.includes('worker stop owned-worker') && actions.includes('reviewer stop owned-reviewer')
    && actions.includes('service close') && lines.some((line) => line.includes('stop returned for the Cursor worker owned-worker'))
    && lines.some((line) => line.includes('stop returned for the Codex reviewer owned-reviewer')),
    JSON.stringify({ error, actions, lines }));
}

for (const [abortDuringClose, failClose] of [[true, false], [true, true], [false, true], [false, false]]) {
  const closing = deferred(), closed = deferred();
  const actions = [], lines = [];
  let abort, workerStops = 0, serviceCloses = 0;
  const context = {
    onAbort: (fn) => { abort = fn; }, writeSync: (_fd, line) => lines.push(line), keepLogs: () => {}, keepCommandReceipts: () => {},
    panePidOf: () => 43, holderPidsOf: () => [44, 45],
    taskService: {
      status: async () => ({ running: true, process: { pid: 42, birth: 'owned-fixture' } }),
      close: async () => { serviceCloses += 1; closing.resolve(); await closed.promise; return { stopped: true, process: { pid: 42, birth: 'owned-fixture' } }; },
    },
    cursorDriver: { stop: async () => {
      workerStops += 1;
      return { ok: true, stopped: true };
    } },
    codexDriver: { stop: async () => ({ ok: true, stopped: true }) },
    cursorPersist: { pidAlive: () => false }, codexSession: { pidAlive: () => false },
    existsSync: () => true, store: { liveWarden: () => null }, listing: () => [],
    rmSync: () => actions.push('remove sandbox'), retainSandbox: () => actions.push('retain sandbox'),
  };
  const hygiene = source.indexOf('if (!aborted) {\n  // --- hygiene:');
  const cleanupBlock = source.slice(source.lastIndexOf('} finally {', hygiene) + 2, hygiene);
  const closeBlock = source.slice(source.indexOf('let serviceClosed ='), source.indexOf("process.once('exit'"));
  const prelude = `const workerRef = 'owned-worker', reviewerRef = 'owned-reviewer';
    const SB = '/sandbox', KEPT_LOGS = '/logs', home = '/home', TASK = 'fixture', CODEX_STATE = '/codex';
    let codexStateBeforeCleanup = [], runFailed = false, runFailure;`;
  const cleanup = await new AsyncFunction(...Object.keys(context),
    prelude + closeBlock + abortBlock + `return async () => { try {} ${cleanupBlock} };`)(...Object.values(context));
  const normal = cleanup().then(() => ({ ok: true }), (error) => ({ ok: false, error: error.message }));
  await closing.promise;
  let cancelling;
  if (abortDuringClose) cancelling = abort('SIGTERM');
  const heldBeforeClose = !actions.includes('remove sandbox');
  if (failClose) closed.reject(new Error('held service close failed'));
  else closed.resolve();
  const normalResult = await normal;
  if (cancelling) await cancelling;
  const sandboxKept = !actions.includes('remove sandbox');
  const name = abortDuringClose
    ? (failClose ? 'mixed abort: rejected shared service close cannot escape normal teardown or claim a physical stop'
      : 'mixed abort: a signal during normal service close keeps the sandbox until abort stops complete')
    : (failClose ? 'mixed normal cleanup: rejected service close still fails the run and preserves the sandbox'
      : 'mixed normal cleanup: successful service close removes the sandbox without an abort');
  check(name,
    serviceCloses === 1 && workerStops === 1
    && normalResult.ok === (!failClose || abortDuringClose) && heldBeforeClose && sandboxKept === failClose
    && (!failClose || !abortDuringClose || (lines.some((line) => line.includes('owned service stop unconfirmed: held service close failed'))
      && !lines.some((line) => line.includes('physically stopped')))), JSON.stringify({ actions, workerStops, serviceCloses, normalResult, lines }));
}

{
  const workerStarted = deferred(), reviewerStarted = deferred(), released = deferred();
  const actions = [], budgets = [], lines = [];
  let abort, workerStops = 0, reviewerStops = 0;
  const context = {
    onAbort: (fn) => { abort = fn; }, writeSync: (_fd, line) => lines.push(line),
    keepLogs: () => {}, keepCommandReceipts: () => {}, panePidOf: () => 43, holderPidsOf: () => [44, 45],
    closeService: async () => { actions.push('service close'); return { stopped: true }; },
    cursorDriver: { stop: async (_ref, options) => {
      workerStops += 1; budgets.push(options.timeoutMs); workerStarted.resolve(); await released.promise;
      return { ok: true, stopped: true };
    } },
    codexDriver: { stop: async (_ref, options) => {
      reviewerStops += 1; budgets.push(options.timeoutMs); reviewerStarted.resolve(); return { ok: true, stopped: true };
    } },
    cursorPersist: { pidAlive: () => false }, codexSession: { pidAlive: () => false },
    existsSync: () => true, store: { liveWarden: () => null }, listing: () => [],
    rmSync: () => actions.push('remove sandbox'), retainSandbox: () => actions.push('retain sandbox'),
  };
  const hygiene = source.indexOf('if (!aborted) {\n  // --- hygiene:');
  const cleanupBlock = source.slice(source.lastIndexOf('} finally {', hygiene) + 2, hygiene);
  const prelude = `const workerRef = 'owned-worker', reviewerRef = 'owned-reviewer';
    const SB = '/sandbox', KEPT_LOGS = '/logs', home = '/home', TASK = 'fixture', CODEX_STATE = '/codex';
    let codexStateBeforeCleanup = [], runFailed = false, runFailure;`;
  const cleanup = await new AsyncFunction(...Object.keys(context),
    prelude + abortBlock + `return async () => { try {} ${cleanupBlock} };`)(...Object.values(context));
  const normal = cleanup();
  await Promise.all([workerStarted.promise, reviewerStarted.promise]);
  check('mixed normal cleanup: both native Stops start within one 5s allowance while Cursor remains held',
    workerStops === 1 && reviewerStops === 1 && budgets.length === 2 && budgets.every(ms => ms > 4000 && ms <= 5000)
    && actions.includes('retain sandbox')
    && !actions.includes('service close') && !actions.includes('remove sandbox'), JSON.stringify({ workerStops, reviewerStops, budgets, actions }));
  const cancelling = abort('SIGTERM');
  await Promise.resolve();
  const sameStops = workerStops === 1 && reviewerStops === 1 && !actions.includes('remove sandbox');
  released.resolve();
  await Promise.all([normal, cancelling]);
  check('mixed abort: a signal during normal native Stop reuses both outcomes without another Stop or early sandbox removal',
    sameStops && workerStops === 1 && reviewerStops === 1 && actions.filter(action => action === 'remove sandbox').length === 1,
    JSON.stringify({ workerStops, reviewerStops, budgets, actions, lines }));
}

check('mixed cancellation docs: pending waits and synchronous lift ownership are explicit',
  readFileSync(new URL('../docs/guides/contributing.md', import.meta.url), 'utf8')
    .includes('Each synchronous lift records its owned session reference before the event loop can deliver a signal.')
  && readFileSync(new URL('../docs/guides/contributing.md', import.meta.url), 'utf8')
    .includes('Service inspection cannot prevent either native stop attempt.'));
