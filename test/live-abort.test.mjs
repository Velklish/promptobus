// Abort cleanup and argv of the live scripts, on neutral fixtures: no harness binary is started.
// Run: npm test
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
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
