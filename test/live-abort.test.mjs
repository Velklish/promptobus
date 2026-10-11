// Abort cleanup and argv of the live scripts, on neutral fixtures: no harness binary is started.
// Run: npm test
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { listenTestSocket, makeSandbox, makeSockPath } from './sandbox.mjs';
import { harnessSessions, installHarness, pidAlive, planParticipant, stopAll, waitFor } from './harness.mjs';
import { runScenario, store } from './scenario.mjs';
import { liveRun, onAbort as onAwaitedAbort } from '../scripts/live-run.mjs';
import { ABORT_SIGNALS, exitCodeOf, onAbort } from '../scripts/live-abort.mjs';
import { parseLiveArgs } from '../scripts/live-args.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.join(here, '..', 'scripts');
const SB = makeSandbox('promptobus-promptobus-live-abort-');

// --- the helper on injected seams ---------------------------------------------------------------

const table = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };
check('abort: the exit code is 128 + the signal number, and 1 for a signal the table lacks',
  exitCodeOf('SIGTERM', table) === 143 && exitCodeOf('SIGINT', table) === 130 && exitCodeOf('SIGNONE', table) === 1,
  `${exitCodeOf('SIGTERM', table)} ${exitCodeOf('SIGINT', table)} ${exitCodeOf('SIGNONE', table)}`);

const handlers = new Map();
const exits = [];
const cleaned = [];
const said = [];
onAbort((signal) => {
  cleaned.push(signal);
  if (cleaned.length === 1) throw new Error('cleanup fault');
}, {
  on: (sig, fn) => handlers.set(sig, fn), exit: (code) => exits.push(code), say: (line) => said.push(line),
});
handlers.get('SIGHUP')?.();
handlers.get('SIGTERM')?.();
check('abort: handlers on SIGINT, SIGTERM and SIGHUP; the first signal cleans once, a second does not repeat it',
  [...handlers.keys()].join(',') === ABORT_SIGNALS.join(',') && cleaned.join(',') === 'SIGHUP'
  && exits.join(',') === String(exitCodeOf('SIGHUP')),
  `handlers ${[...handlers.keys()]} · cleaned ${cleaned} · exits ${exits}`);
check('abort: a cleanup that throws still exits, and names its fault',
  exits.length === 1 && said.some((line) => line.includes('SIGHUP') && line.includes('cleanup fault')), said.join(''));

// --- a real signal to a real process --------------------------------------------------------------

// The fixture raises a sandbox BEFORE its cleanup, as every live script does: the sandbox helper's
// own handler exits 130 and, registered first, would run first unless the cleanup is prepended.
function writeFixture(dir, register) {
  const file = path.join(dir, 'fixture.mjs');
  writeFileSync(file, `import { existsSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { makeSandbox } from ${JSON.stringify(path.join(here, 'sandbox.mjs'))};
import { onAbort } from ${JSON.stringify(path.join(scriptsDir, 'live-abort.mjs'))};
const dir = ${JSON.stringify(dir)};
const sb = makeSandbox('promptobus-promptobus-live-abort-run-');
writeFileSync(path.join(sb, 'record.json'), '{}');
onAbort((signal) => {
  writeFileSync(path.join(dir, 'trace.json'), JSON.stringify({ signal, sandboxThere: existsSync(path.join(sb, 'record.json')) }));
  rmSync(path.join(dir, 'owned'), { force: true });
}${register ? `, { on: ${register} }` : ''});
writeSync(1, 'READY ' + sb + '\\n');
setInterval(() => {}, 1000);
`);
  return file;
}

async function abortRun(name, register = null, signal = 'SIGTERM') {
  const dir = path.join(SB, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'owned'), 'resource the run owns\n');
  writeFileSync(path.join(dir, 'neighbour'), 'resource another run owns\n');
  const child = spawn(process.execPath, [writeFixture(dir, register)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 15000);
    child.stdout.on('data', (c) => {
      out += c;
      const m = /READY (\S+)/.exec(out);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on('exit', () => { clearTimeout(timer); resolve(null); });
  });
  const traceBefore = existsSync(path.join(dir, 'trace.json'));
  const exited = new Promise((resolve) => child.on('exit', (code, sig) => resolve({ code, sig })));
  if (ready) child.kill(signal);
  else child.kill('SIGKILL');
  const { code, sig } = await exited;
  let trace = null;
  try { trace = JSON.parse(readFileSync(path.join(dir, 'trace.json'), 'utf8')); } catch { trace = null; }
  return {
    ready, traceBefore, code, sig, trace, err,
    sandboxLeft: ready ? existsSync(ready) : null,
    owned: existsSync(path.join(dir, 'owned')),
    neighbour: existsSync(path.join(dir, 'neighbour')),
  };
}

const term = await abortRun('prepended');
check('abort: before the signal the fixture is up and has cleaned nothing',
  !!term.ready && term.traceBefore === false, JSON.stringify(term));
check('abort: SIGTERM runs the cleanup while the sandbox is still there, and exits 143 — its own handler ended the process',
  term.code === 143 && term.trace?.signal === 'SIGTERM' && term.trace?.sandboxThere === true, JSON.stringify(term));
check('abort: the cleanup removed only what the run owns; the neighbour is intact and the exit hook took the sandbox',
  term.owned === false && term.neighbour === true && term.sandboxLeft === false, JSON.stringify(term));

const hup = await abortRun('hangup', null, 'SIGHUP');
check('abort: SIGHUP takes the same cleanup and exits 129',
  hup.code === 129 && hup.trace?.signal === 'SIGHUP' && hup.owned === false && hup.neighbour === true, JSON.stringify(hup));

// Negative control: the same cleanup appended with `process.on` loses to the sandbox handler.
const appended = await abortRun('appended', '(sig, fn) => process.on(sig, fn)');
check('abort: control — an appended cleanup never runs, the sandbox handler exits 130 first',
  appended.code === 130 && appended.trace === null && appended.owned === true, JSON.stringify(appended));

// --- argv of every live script, before anything is raised ---------------------------------------

check('args: values by flag, --help, and refusals for an unknown flag and a flag without a value',
  JSON.stringify(parseLiveArgs(['--model', 'm1'], { '--model': { key: 'model' } }).values) === '{"model":"m1"}'
  && parseLiveArgs(['--help'], {}).help === true
  && parseLiveArgs(['--bogus'], {}).errors[0] === 'unknown argument "--bogus"'
  && parseLiveArgs(['--model', '--help'], { '--model': { key: 'model' } }).errors[0] === 'flag --model needs a value',
  JSON.stringify(parseLiveArgs(['--model', '--help'], { '--model': { key: 'model' } })));

const LIVE = {
  'live-codex.mjs': '--model',
  'live-cursor.mjs': '--model',
  'live-mixed.mjs': '--codex-model',
  'live-e2e.mjs': null,
};
for (const [script, flag] of Object.entries(LIVE)) {
  const tmp = path.join(SB, `tmp-${script}`);
  mkdirSync(tmp, { recursive: true });
  const run = (...args) => spawnSync(process.execPath, [path.join(scriptsDir, script), ...args], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
  });
  const help = run('--help');
  check(`args: ${script} --help prints purpose and price and exits 0 with nothing created`,
    help.status === 0 && /^Purpose: /m.test(help.stdout) && /^Price of a run: /m.test(help.stdout)
    && (!flag || help.stdout.includes(flag)) && readdirSync(tmp).length === 0,
    `${help.status} · ${help.stdout}${help.stderr} · tmp: ${readdirSync(tmp).join(', ')}`);
  const bogus = run('--bogus');
  check(`args: ${script} refuses an unknown flag with exit 1, naming the known ones, with nothing created`,
    bogus.status === 1 && bogus.stderr.includes('unknown argument "--bogus"') && bogus.stderr.includes('--help')
    && readdirSync(tmp).length === 0,
    `${bogus.status} · ${bogus.stderr} · tmp: ${readdirSync(tmp).join(', ')}`);
}

// --- every live script wires the abort cleanup and owns its sandbox ------------------------------

const sourceOf = (script) => readFileSync(path.join(scriptsDir, script), 'utf8').replace(/^\s*\/\/.*$/gm, '');
for (const script of Object.keys(LIVE).filter((script) => script !== 'live-e2e.mjs')) {
  const src = sourceOf(script);
  check(`wiring: ${script} registers an abort cleanup, marks its sandbox and sweeps only its own prefix`,
    /\bonAbort\(\(signal\) =>/.test(src) && /markRunOwner\(SB\)/.test(src)
    && /sweepLiveRuns\((?:os\.)?tmpdir\(\), \{ prefix: RUN_PREFIX, current: SB \}\)/.test(src)
    && /const SB = makeSandbox\(RUN_PREFIX\)/.test(src),
    script);
}

const e2eSource = sourceOf('live-e2e.mjs');
check('wiring: live-e2e awaits owned cleanup and preserves uncertain prior runs',
  /onAbort\(async \(signal\) => \{\s*const result = await cleanup\(\)/.test(e2eSource)
  && /cleanupResult = await run\.cleanup\(\)/.test(e2eSource)
  && /liveRun\(\{ sandbox: SB, socketDir: sockDir/.test(e2eSource)
  && /prefix: RUN_PREFIX, current: SB/.test(e2eSource)
  && /isLive: priorRunIsLive, held: refusedRuns/.test(e2eSource)
  && !/\b(?:makeSandbox|sweepLiveRuns|markRunOwner)\(/.test(e2eSource), 'live-e2e.mjs');

// The ported fixes that no stand reaches are pinned by source, the way the suite already reads these scripts.
const PORTED = {
  'live-cursor.mjs': {
    'probe marks taken at both lifts': /\?\.sessionId\}`\);\s*rememberProbeMarks\(\);[\s\S]*reviewer reviewer:live started[^\n]*\n\s*rememberProbeMarks\(\);/,
    'the review subject signed with its own marker': /live-note\.md'\), `# \$\{MARK\.review\}/,
    'a verdict that the report names the round diff': /reviewSaid && reportMentionsDiff\(reviewSaid\.body, diffs\[0\]\)/,
    'fail-closed tmux lists': /requiredTmuxSessions\(readTmuxSessions\)[\s\S]*tmuxAbsenceVerdict\(readTmuxSessions, sessionsBefore\)/,
    'an unread tmux list refused by name before the run': /try \{\s*sessionsBefore = new Set\(requiredTmuxSessions\(readTmuxSessions\)[^\n]*\n\} catch \(error\) \{\s*console\.error\([^\n]*\$\{error\.message\}[^\n]*\n\s*process\.exit\(1\);/,
    'a ps listing that must show this process': /maxBuffer: 32 \* 1024 \* 1024[\s\S]*ps\.status === 0 && seesSelf/,
  },
  'live-mixed.mjs': {
    'the Codex home under the sandbox before its registry is read': /const CODEX_HOME = path\.join\(SB, 'codex-state'\);\s*process\.env\.PROMPTOBUS_CODEX_HOME = CODEX_HOME;\s*const CODEX_STATE = codexSession\.sessionsDir\(\);/,
    'both review rounds by an unseen result naming the round diff': /unseenResult\(orchInbox\(\), seenA[\s\S]*reportMentionsDiff\(reviewA\.body, diffsA\[0\]\)[\s\S]*unseenResult\(orchInbox\(\), seenB[\s\S]*reportMentionsDiff\(reviewB\.body, diffsB\[0\]\)/,
    'the person\'s Codex registry compared, the run\'s own emptied': /listing\(USER_CODEX_STATE\)[\s\S]*codexStateBeforeCleanup\.length === 0/,
    'fail-closed tmux lists': /requiredTmuxSessions\(cursorPersist\.readTmuxSessions\)[\s\S]*tmuxAbsenceVerdict\(cursorPersist\.readTmuxSessions, panesBefore\)/,
    'an unread tmux list refused by name before the run': /try \{\s*panesBefore = new Set\(requiredTmuxSessions\(cursorPersist\.readTmuxSessions\)[^\n]*\n\} catch \(error\) \{\s*console\.error\([^\n]*\$\{error\.message\}[^\n]*\n\s*process\.exit\(1\);/,
    'a ps listing that must show this process': /maxBuffer: 32 \* 1024 \* 1024[\s\S]*ps\.status === 0 && seesSelf/,
    'the config hash without refresh timestamps': /codexConfigSha\(CODEX_CONFIG\)/,
  },
  'live-codex.mjs': {
    'the config hash without refresh timestamps': /codexConfigSha\(CONFIG\)/,
  },
  'live-e2e.mjs': {
    'a fresh registry read before the cleanup stops': /readSessions: \(\) => \{\s*const \{ r, missing \} = runClaude\(\['agents', '--json'\]\);[\s\S]*return parseLiveSessions\(r\);/,
  },
};
for (const [script, wants] of Object.entries(PORTED)) {
  const src = sourceOf(script);
  const missing = Object.entries(wants).filter(([, re]) => !re.test(src)).map(([name]) => name);
  check(`ported: ${script} keeps ${Object.keys(wants).join('; ')}`, missing.length === 0, `missing: ${missing.join('; ')}`);
}

const guide = readFileSync(path.join(here, '..', 'docs', 'guides', 'contributing.md'), 'utf8');
check('guide: no real-binary run is in npm test or the gates, while the --help and stand runs are',
  guide.includes('no run against a real binary is in `npm test` or in the gates')
  && !guide.includes('none of them is in `npm test`'));
check('guide: the live-cursor review verdict is the report naming the round diff file, not a marker echo',
  guide.includes("the reviewer's report has to name that diff file")
  && !guide.includes("and the reviewer's report has to name it."));

// Hold an actual scenario postcard until awaited native-stop cleanup has begun.
async function scenarioPostcardCase(abort) {
  const dir = path.join(SB, abort ? 'scenario-abort' : 'scenario-normal');
  mkdirSync(dir);
  const sock = makeSockPath('a2e-');
  const installed = await installHarness({ binDir: path.join(dir, 'bin'), sock });
  const nativeCwd = path.join(dir, 'native');
  mkdirSync(nativeCwd);
  const native = { sessionId: 'fixture-native', id: 'fixture-native-id', cwd: nativeCwd, pid: 31001 };
  let registry = [native];
  let rows = [{ pid: 31001, parent: 1, group: 31001, birth: 'fixture-native-birth' }];
  let releaseStop;
  let cleanupHeld = false;
  let aborted = false;
  const run = liveRun({ sandbox: dir, readSessions: () => registry, readProcesses: () => rows,
    stopSession: async () => {
      cleanupHeld = true;
      await new Promise((resolve) => { releaseStop = resolve; });
      registry = []; rows = [];
      return { ok: true, stopped: true };
    }, kill: () => {}, remove: () => {}, timeoutMs: 0 });
  run.start({ workspace: dir, participants: () => [{ metadata: { sessionId: native.sessionId, worktree: nativeCwd } }] });
  const emitter = new EventEmitter();
  const dispose = onAwaitedAbort(async () => { aborted = true; await run.cleanup(); }, { emitter, exit: () => {} });
  const children = [];
  const resources = [];
  const held = [];
  const calls = [];
  let firstStatus = false;
  let context;
  let releaseCards = false;
  const complete = new Error('scenario fixture complete');
  const harness = {
    scripted: true, sock, spawnFlags: [], reviewFlags: [],
    plan: (address, script) => planParticipant(installed.home, address, script),
    sessions: () => harnessSessions(installed.home),
    liveSessions: (refs) => harnessSessions(installed.home).filter((s) => refs.includes(s.name) && pidAlive(s.pid)),
    pidsOf: (refs) => harnessSessions(installed.home).filter((s) => refs.includes(s.name)).map((s) => s.pid),
    pidAlive, diagnose: () => '', assertRunning: run.assertRunning,
    start: (value) => { context = value; }, resource: (close) => resources.push(close),
    child: (child) => {
      children.push(child);
      if (!child.spawnargs.includes('mcp')) return;
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk, ...args) => {
        const message = JSON.parse(String(chunk));
        if (message.method === 'tools/call') calls.push({ name: message.params.name, aborted, cleanupHeld });
        return write(chunk, ...args);
      };
    }, cleanup: () => {},
  };
  const scenario = runScenario({ harness, sandbox: dir, timeouts: { step: 30_000, stall: 30_000 },
    listenSocket: (server, file) => {
      server.on('connection', (connection) => {
        if (!releaseCards) { connection.pause(); held.push(connection); }
      });
      return listenTestSocket(server, file);
    },
    check: (name, condition, detail) => {
      if (!condition) throw new Error(`${name}: ${detail ?? ''}`);
      if (name.startsWith('step 3: the first worker status')) firstStatus = true;
      if (name.startsWith('step 5: the worker fetched the mailbox')) throw complete;
    },
  }).then((report) => ({ report }), (error) => ({ error }));
  try {
    const ready = await waitFor(() => firstStatus && held.length > 0, { timeoutMs: 30_000 });
    if (!ready) throw new Error('scenario never held its step 3 postcard');
    const worktree = context.participants().find((p) => store.addressOf(p) === 'worker:e2e')?.metadata.worktree;
    const note = path.join(worktree, 'e2e/note.md');
    const before = existsSync(note);
    if (abort) {
      emitter.emit('SIGTERM');
      if (!cleanupHeld || !releaseStop) throw new Error('native-stop barrier was not entered');
    }
    releaseCards = true;
    for (const connection of held) connection.resume();
    const ended = await scenario;
    const answered = calls.some((call) => call.name === 'promptobus_send');
    if (answered) await waitFor(() => existsSync(note), { timeoutMs: 30_000 });
    return { before, after: existsSync(note), calls, cleanupHeld,
      ended: ended.error?.message ?? ended.report?.skipped ?? 'scenario completed' };
  } finally {
    releaseStop?.();
    dispose();
    for (const connection of held) connection.destroy();
    await stopAll(installed.home);
    for (const close of resources.reverse()) await close();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await waitFor(() => children.every((child) => child.exitCode !== null || child.signalCode !== null), { timeoutMs: 10_000 });
    installed.restore();
  }
}

const normalScenario = await scenarioPostcardCase(false);
check('scenario abort: normal queued postcard dispatches the mailbox/body/answer flow and edits the worker note',
  normalScenario.before === false && normalScenario.after === true && normalScenario.ended === 'scenario fixture complete'
  && normalScenario.calls.map((call) => call.name).join(',') === 'promptobus_mailbox,promptobus_mailbox,promptobus_send'
  && normalScenario.calls.every((call) => !call.aborted), JSON.stringify(normalScenario));

const abortedScenario = await scenarioPostcardCase(true);
check('scenario abort: queued postcard cannot dispatch MCP while native stop is held',
  abortedScenario.cleanupHeld && abortedScenario.ended === 'live run aborted'
  && abortedScenario.calls.length === 0, JSON.stringify(abortedScenario));
check('scenario abort: queued postcard cannot mutate the worker note while native stop is held',
  abortedScenario.before === false && abortedScenario.after === false
  && abortedScenario.cleanupHeld, JSON.stringify(abortedScenario));
