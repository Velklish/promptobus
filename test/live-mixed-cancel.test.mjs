// Execute the production scenario and abort block with a held hello and stop, without binaries.
import { readFileSync } from 'node:fs';
import { check } from './check.mjs';

const source = readFileSync(new URL('../scripts/live-mixed.mjs', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('const ABORT_STOP_MS ='), source.indexOf('if (!aborted) {\n  // --- hygiene:'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function runCase(boundary) {
  const hello = deferred(), stop = deferred(), waiting = deferred(), stopping = deferred();
  const actions = [], lines = [];
  let abort, waits = 0, aborted = false, stopCalls = 0;
  const context = {
    onAbort: (fn) => { abort = fn; },
    writeSync: (_fd, line) => lines.push(line),
    process: { kill: () => actions.push('warden stop') }, warden: { pid: 42 },
    waitFor: async (probe) => {
      waits += 1;
      if (waits === 2) { waiting.resolve(); await hello.promise; }
      return probe();
    },
    store: {
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
    keepLogs: () => {}, panePidOf: () => 43, holderPidsOf: () => [44, 45], existsSync: () => true,
    rememberTranscript: () => {}, rememberProbeMark: () => {}, at_: () => {},
    check: (name) => actions.push(`check ${name}`),
    commitSubject: () => { actions.push('commit subject'); return { status: 0 }; },
    said: () => boundary === 'timeout' ? null : { body: 'hello' },
    orchInbox: () => [], listing: () => [], sentBy: () => false, messageKey: () => '',
    unseenResult: () => null, reportMentionsDiff: () => false,
    rmSync: () => actions.push('remove sandbox'), path: { join: (...parts) => parts.join('/') },
    requiredTmuxSessions: () => [],
  };
  const prelude = `let workerRef = '', reviewerRef = '', codexStateBeforeCleanup = [];
    const SB = '/sandbox', KEPT_LOGS = '/logs', WORKER = 'worker:live', REVIEWER = 'reviewer:live';
    const home = '/home', TASK = 'fixture', repo = 'repo', repoAbs = '/fixture', ws = '/fixture';
    const env = {}, workerBrief = '/brief', identity = { title: 'fixture' }, CURSOR_MODEL = 'stub', CODEX_MODEL = 'stub';
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
  stop.resolve();
  await main;
  await cleanup;
  return { aborted, held, stopCalls, afterHello, actions, lines };
}

for (const boundary of ['result', 'timeout']) {
  const run = await runCase(boundary);
  check(`mixed cancellation: ${boundary} released while worker stop is held cannot raise a reviewer or perform later actions`,
    run.aborted && run.held && run.afterHello.length === 0
    && !run.actions.includes('review') && !run.actions.includes('bus send'), JSON.stringify(run));
  check(`mixed cancellation: ${boundary} leaves cleanup with the owned worker and sandbox until its stop completes`,
    run.stopCalls === 1 && run.lines.some((line) => line.includes('"ref":"owned-worker"'))
    && !run.actions.includes('remove sandbox'), JSON.stringify(run));
}

check('mixed cancellation docs: pending waits and synchronous lift ownership are explicit',
  readFileSync(new URL('../docs/guides/contributing.md', import.meta.url), 'utf8')
    .includes('Each synchronous lift records its owned session reference before the event loop can deliver a signal.'));
