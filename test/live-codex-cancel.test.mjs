// Execute the entire production script with deterministic dependency seams, without binaries.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';

const source = readFileSync(new URL('../scripts/live-codex.mjs', import.meta.url), 'utf8');
const executable = source.replace(/^#![^\n]*\n/, '')
  .replace(/^import[\s\S]*?from '[^']+';$/gm, '')
  .replace(/^const \{[^\n]+\} = await import\([^\n]+\);$/gm, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function runCase(boundary) {
  const reached = deferred(), release = deferred(), abortEntered = deferred(), abortRelease = deferred();
  const actions = [], lines = [];
  let abort, stopCalls = 0, waits = 0, sandbox = false, record = true;
  const ownedRef = 'owned-stream';
  const session = () => record ? { threadId: 'thread', state: 'alive', holderPid: 44, appPid: 45,
    sandbox: 'read-only', methodsCalled: ['initialize'] } : null;
  const context = {
    path, process: { argv: ['node', 'live-codex.mjs'], env: {}, pid: 42,
      stdout: { write: (line) => { lines.push(line); actions.push('stdout'); } },
      exit: (code) => { throw new Error('unexpected exit ' + code); } },
    existsSync: () => sandbox, writeFileSync: () => {}, writeSync: (_fd, line) => lines.push(line),
    rmSync: () => { sandbox = false; actions.push('remove sandbox'); },
    spawnSync: () => { actions.push('pgrep'); return { status: 1, stdout: '' }; },
    homedir: () => '/private-home', tmpdir: () => '/private-tmp',
    finishLiveArgs: (args) => args, parseLiveArgs: () => ({}),
    makeSandbox: (_prefix, options) => {
      if (options.signalCleanup !== false) throw new Error('sandbox must opt out of signal cleanup');
      sandbox = true; return '/sandbox';
    },
    writeHostConfig: () => {}, resolveToolBin: () => ({ ok: true, path: '/private-stub' }),
    dropSessionLeaks: () => {}, SESSION_LEAK_VARS: [], freshScenarioIdentity: () => ({ id: 'owned-task', title: 'fixture' }),
    buildWorkspace: () => ({ ws: '/workspace', repo: '/repo' }), MECHANISM_ROOT: '/private-stub',
    cli: ([command]) => { actions.push(command); return { status: 0, out: 'worker worker:live lifted' }; },
    store: { createTask: () => {}, readTask: () => ({}),
      participantOf: () => ({ sessionRef: ownedRef }), glanceInbox: () => [{ body: 'LIVE-CODEX-HELLO' }] },
    waitFor: async (probe) => {
      waits += 1;
      if (boundary === (waits === 1 ? 'hello' : 'idle')) { reached.resolve(); await release.promise; }
      return probe();
    },
    markRunOwner: () => {}, sweepLiveRuns: () => [],
    onAbort: (fn) => { abort = fn; }, codexConfigSha: () => { actions.push('config sha'); return 'unchanged'; },
    codexCatalogEntries: () => [], pickCodexModel: () => ({ model: 'stub' }), DEFAULT_MODEL: 'stub',
    readSession: session, pidAlive: () => false,
    codexDriver: { inspect: () => record ? { state: 'alive', busy: false } : { state: 'gone' },
      stop: async (ref, options) => {
        stopCalls += 1;
        actions.push('stop ' + ref);
        if (ref !== ownedRef) throw new Error('foreign ref');
        if (options?.timeoutMs === 5_000) { abortEntered.resolve(); await abortRelease.promise; }
        else if ((boundary === 'normal stop' && stopCalls === 1)
          || (boundary === 'normal finally' && stopCalls === 2)) {
          reached.resolve(); await release.promise;
        }
        record = false;
        return { ok: true, stopped: true, note: 'owned stop completed' };
      } },
  };
  const main = new AsyncFunction(...Object.keys(context), executable)(...Object.values(context));
  if (boundary === 'normal') {
    await main;
    return { stopCalls, actions, lines, sandbox };
  }
  await reached.promise;
  const cleanup = abort('SIGTERM');
  await abortEntered.promise;
  const atAbort = actions.length;
  release.resolve();
  await main;
  const duringAbort = { sandbox, laterActions: actions.slice(atAbort), sampled: lines.some((line) => line.includes('pre-exit:')) };
  abortRelease.resolve();
  await cleanup;
  const sample = JSON.parse(lines.find((line) => line.startsWith('  · pre-exit: '))?.slice('  · pre-exit: '.length) ?? 'null');
  return { stopCalls, actions, lines, sandbox, duringAbort, sample };
}

for (const boundary of ['hello', 'idle', 'normal stop', 'normal finally']) {
  const run = await runCase(boundary);
  check(`codex cancellation: ${boundary} keeps the sandbox and withholds the sample while abort stop is held`,
    run.duringAbort.sandbox && !run.duringAbort.sampled, JSON.stringify(run));
  check(`codex cancellation: ${boundary} resumes no normal verdicts, cleanup or hygiene after cancellation`,
    run.duringAbort.laterActions.length === 0 && !run.actions.includes('remove sandbox'), JSON.stringify(run));
  check(`codex cancellation: ${boundary} samples the owned stream only after abort stop completes`,
    run.sample?.sandboxPresent === true && run.sample.stream.ref === 'owned-stream'
    && run.sample.stream.stop?.stopped === true
    && run.stopCalls === (boundary === 'normal finally' ? 3 : boundary === 'normal stop' ? 2 : 1)
    && (boundary !== 'normal stop' || JSON.stringify(run.sample.stream.pids) === '[44,45]'), JSON.stringify(run));
}
const normal = await runCase('normal');
check('codex cancellation: the uninterrupted production script still stops, removes its sandbox and reports hygiene',
  normal.stopCalls === 2 && !normal.sandbox && normal.actions.includes('remove sandbox')
  && normal.lines.some((line) => line.includes('11/11 verdicts passed')), JSON.stringify(normal));

check('codex cancellation docs: normal stop overlap transfers sandbox ownership before cleanup yields',
  readFileSync(new URL('../docs/guides/contributing.md', import.meta.url), 'utf8')
    .includes('Codex cancellation is latched synchronously, including when a normal stop or normal cleanup stop is already awaiting.')
  && readFileSync(new URL('../docs/reference/05-drivers.md', import.meta.url), 'utf8')
    .includes('An already\npending normal stop retains its owned reference')
  && readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    .includes('normal cleanup cannot remove the sandbox while abort cleanup is awaiting its stop.'));
