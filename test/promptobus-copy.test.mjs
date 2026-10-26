// Runtime helpers inside the bus boundary: win32 resolve, quoting, env substitution.
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { check } from './check.mjs';

const util = await import('../lib/util.js');
const exec = await import('../lib/exec.js');
const fuzzy = await import('../lib/fuzzy.js');

check('exec does not export pathExtensions',
  !('pathExtensions' in exec));

const SB = mkdtempSync(path.join(os.tmpdir(), 'promptobus-copy-'));
const BIN = path.join(SB, 'Program Files', 'bin');
mkdirSync(BIN, { recursive: true });
for (const f of ['claude.exe', 'npm.cmd', 'npm.ps1', 'tool.bat', 'tool.cmd', 'plain']) {
  writeFileSync(path.join(BIN, f), '');
}
const WIN = {
  platform: 'win32',
  env: { PATH: BIN, PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' },
};

check('exec.resolveCommand on win32 finds PATHEXT hits',
  exec.resolveCommand('claude', WIN) === path.join(BIN, 'claude.exe')
  && exec.resolveCommand('npm', WIN) === path.join(BIN, 'npm.cmd')
  && exec.resolveCommand('tool', WIN) === path.join(BIN, 'tool.bat')
  && exec.resolveCommand('plain', WIN) === null
  && exec.resolveCommand('claude', { platform: 'darwin', env: {} }) === 'claude',
  String(exec.resolveCommand('claude', WIN)));

for (const [name, argument, expected] of [
  ['quotes a safe flag', '--print', '"--print"'],
  ['quotes spaces', 'a b', '"a b"'],
  ['quotes a path with spaces', 'C:\\Users\\Ivan Petrov\\ws', '"C:\\Users\\Ivan Petrov\\ws"'],
  ['doubles an embedded quote', 'a"b', '"a""b"'],
  ['doubles a trailing backslash', 'a\\', '"a\\\\"'],
  ['doubles two trailing backslashes', 'a\\\\', '"a\\\\\\\\"'],
  ['doubles a backslash before a quote', 'a\\"b', '"a\\\\""b"'],
  ['doubles two backslashes before a quote', 'a\\\\"b', '"a\\\\\\\\""b"'],
  ['keeps cmd metacharacters quoted', 'a&b|c<d>e^f!g(h)', '"a&b|c<d>e^f!g(h)"'],
  ['quotes JSON', '{"deny":["Bash"]}', '"{""deny"":[""Bash""]}"'],
]) {
  const actual = exec.quoteCmdArg(argument);
  check(`exec.quoteCmdArg ${name} exactly`, actual === expected,
    JSON.stringify({ argument, expected, actual }));
}

const posix = exec.planRun('git', ['status'], { platform: 'linux' });
check('exec.planRun on POSIX is a direct spawn',
  isDeepStrictEqual(posix, { ok: true, file: 'git', args: ['status'], verbatim: false }),
  JSON.stringify(posix));

// english-authoring: input — a non-ASCII multi-line prompt on the Windows direct-spawn path
const multilinePrompt = 'многострочный\nпромпт';
// english-authoring: end
const exe = exec.planRun('claude', ['-p', multilinePrompt], WIN);
check('exec.planRun win .exe stays a direct spawn',
  isDeepStrictEqual(exe, {
    ok: true, file: path.join(BIN, 'claude.exe'), args: ['-p', multilinePrompt], verbatim: false,
  }), JSON.stringify(exe));

const bat = exec.planRun('npm', ['publish', '--userconfig', 'C:\\tmp\\a b\\.npmrc'], WIN);
check('exec.planRun win .cmd is ok for paths with spaces',
  isDeepStrictEqual(bat, {
    ok: true,
    file: WIN.env.ComSpec,
    args: [`/v:off /d /s /c ""${path.join(BIN, 'npm.cmd')}" "publish" "--userconfig" "C:\\tmp\\a b\\.npmrc""`],
    verbatim: true,
  }), JSON.stringify(bat));

for (const [name, argument] of [['%', '%PATH%'], ['CR', 'a\rb'], ['LF', 'a\nb']]) {
  const refusal = exec.planRun('npm', ['run', argument], WIN);
  check(`exec.planRun win .cmd refuses ${name} without an executable plan`,
    refusal.ok === false && refusal.code === 'ERR_UNCARRIABLE_ARG'
    && !('file' in refusal) && !('args' in refusal) && !('verbatim' in refusal),
    JSON.stringify(refusal));
}

// A copy shortens only the two shared ceilings: exercising the production minute
// would add a minute to every suite run, while a caller that forgot the defaults
// must still go red rather than hang the probe. liftoff.js is the production reader,
// with only its unrelated imports pointed back at this tree.
// `bgSessions` also maps empty stdout to null, so the elapsed bound — not `timed`
// alone — is the discriminating half of the timeout verdict.
const PROBE = path.join(SB, 'exec-ceilings');
mkdirSync(PROBE, { recursive: true });
const execSource = readFileSync(new URL('../lib/exec.js', import.meta.url), 'utf8');

// Force the production defaults to win32 in a copy and stop at the spawn boundary.
// The parent and caller PATHs contain the same command at different paths, so the
// returned plan says which environment run() actually handed to planRun. The same
// call writes the production trace and exposes whether PATHEXT was used there too.
const WIN_PROBE = path.join(SB, 'win32-env');
const PARENT_BIN = path.join(WIN_PROBE, 'parent-bin');
const CALLER_BIN = path.join(WIN_PROBE, 'caller-bin');
mkdirSync(PARENT_BIN, { recursive: true });
mkdirSync(CALLER_BIN, { recursive: true });
writeFileSync(path.join(PARENT_BIN, 'chosen.exe'), 'parent');
writeFileSync(path.join(CALLER_BIN, 'chosen.exe'), 'caller');
const spawnImport = "import { spawnSync } from 'node:child_process';";
const winExecSource = execSource
  .replace(spawnImport,
    'const spawnSync = (file, args, options) => ({ status: 0, file, args, options });')
  .replaceAll('process.platform', "'win32'");
check('win32 env probe forces the production defaults and stops at spawn',
  winExecSource !== execSource
  && !winExecSource.includes(spawnImport)
  && !winExecSource.includes('process.platform'));
const WIN_EXEC = path.join(WIN_PROBE, 'exec.js');
writeFileSync(WIN_EXEC, winExecSource);
const winExec = await import(pathToFileURL(WIN_EXEC).href);
const WIN_TRACE = path.join(WIN_PROBE, 'trace.tsv');
const savedParentPath = process.env.PATH;
const savedTrace = process.env.PROMPTOBUS_EXEC_TRACE;
try {
  process.env.PATH = PARENT_BIN;
  process.env.PROMPTOBUS_EXEC_TRACE = WIN_TRACE;
  const callerEnv = { PATH: CALLER_BIN, PATHEXT: '.EXE' };
  const planned = winExec.run('chosen', [], { env: callerEnv });
  check('exec.run win32 plans against the caller PATH, not process PATH',
    planned.file === path.join(CALLER_BIN, 'chosen.exe'), JSON.stringify(planned));
  let winTrace = '';
  try { winTrace = readFileSync(WIN_TRACE, 'utf8'); } catch { /* trace failure is the verdict */ }
  check('exec trace win32 resolves the caller PATHEXT binary',
    winTrace === `chosen\t${path.join(CALLER_BIN, 'chosen.exe')}\n`, winTrace || '(missing)');
} finally {
  if (savedParentPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedParentPath;
  if (savedTrace === undefined) delete process.env.PROMPTOBUS_EXEC_TRACE;
  else process.env.PROMPTOBUS_EXEC_TRACE = savedTrace;
}

const probeExec = execSource
  .replace('export const PROC_TIMEOUT_MS = 60_000;', 'export const PROC_TIMEOUT_MS = 1_000;')
  .replace('export const PROC_MAX_OUTPUT = 32 * 1024 * 1024;', 'export const PROC_MAX_OUTPUT = 64;');
check('exec ceiling probe shortens both production defaults',
  probeExec !== execSource
  && probeExec.includes('export const PROC_TIMEOUT_MS = 1_000;')
  && probeExec.includes('export const PROC_MAX_OUTPUT = 64;'));
writeFileSync(path.join(PROBE, 'exec.js'), probeExec);
const asyncExec = await import(pathToFileURL(path.join(PROBE, 'exec.js')).href);
let ticks = 0;
const tick = setInterval(() => { ticks += 1; }, 10);
const asyncStarted = Date.now();
const asyncTimed = await asyncExec.runAsync('node', ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 200, encoding: 'utf8' });
clearInterval(tick);
check('exec.runAsync cuts off a hung command without blocking the caller loop',
  asyncTimed.error?.code === 'ETIMEDOUT' && asyncTimed.signal === 'SIGKILL'
  && ticks > 0 && Date.now() - asyncStarted < 5000, JSON.stringify({ asyncTimed, ticks }));
const asyncBuffered = await asyncExec.runAsync('node', ['-e', "process.stdout.write('x'.repeat(10000))"], { encoding: 'utf8' });
check('exec.runAsync refuses output beyond the byte ceiling',
  asyncBuffered.error?.code === 'ENOBUFS' && Buffer.byteLength(asyncBuffered.stdout) === 64, JSON.stringify(asyncBuffered));
const asyncOk = await exec.runAsync('node', ['-e', "process.stdout.write('ok'); process.stderr.write('detail')"], { encoding: 'utf8' });
check('exec.runAsync preserves successful stdout, stderr and exit status',
  asyncOk.status === 0 && asyncOk.stdout === 'ok' && asyncOk.stderr === 'detail' && asyncOk.error === null, JSON.stringify(asyncOk));


const liftoffSource = readFileSync(new URL('../lib/liftoff.js', import.meta.url), 'utf8');
const probeLiftoff = liftoffSource
  .replace("'../dist/index.js'", JSON.stringify(new URL('../dist/index.js', import.meta.url).href))
  .replace("'./util.js'", JSON.stringify(new URL('../lib/util.js', import.meta.url).href))
  .replace("'./harness-home.js'", JSON.stringify(new URL('../lib/harness-home.js', import.meta.url).href))
  .replace("'./native-lifecycle.js'", JSON.stringify(new URL('../lib/native-lifecycle.js', import.meta.url).href))
  .replace("'./store.js'", JSON.stringify(new URL('../lib/store.js', import.meta.url).href));
check('bgSessions probe keeps the production reader and redirects only its neighbours',
  probeLiftoff !== liftoffSource
  && !probeLiftoff.includes("'../dist/index.js'")
  && !probeLiftoff.includes("'./util.js'")
  && !probeLiftoff.includes("'./harness-home.js'")
  && !probeLiftoff.includes("'./native-lifecycle.js'")
  && !probeLiftoff.includes("'./store.js'"));
writeFileSync(path.join(PROBE, 'liftoff.js'), probeLiftoff);

const SLOW_BIN = path.join(PROBE, 'bin');
mkdirSync(SLOW_BIN, { recursive: true });
writeFileSync(path.join(SLOW_BIN, 'claude'), `#!/bin/sh
if [ "$PB_EXEC_PROBE" = "timeout" ]; then
  exec sleep 30
fi
printf '["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]\\n'
`, { mode: 0o755 });

const probe = await import(pathToFileURL(path.join(PROBE, 'liftoff.js')).href);
const savedPath = process.env.PATH;
try {
  process.env.PATH = `${SLOW_BIN}${path.delimiter}${savedPath ?? ''}`;
  process.env.PB_EXEC_PROBE = 'timeout';
  const started = Date.now();
  const timed = probe.bgSessions({ fresh: true });
  const elapsed = Date.now() - started;
  check('bgSessions returns null when its stand-in binary crosses the run timeout',
    timed === null && elapsed < 10_000, `result=${JSON.stringify(timed)} · ${elapsed} ms`);

  process.env.PB_EXEC_PROBE = 'buffer';
  const buffered = probe.bgSessions({ fresh: true });
  check('bgSessions returns null when its stand-in binary crosses the run output budget',
    buffered === null, JSON.stringify(buffered));
} finally {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  delete process.env.PB_EXEC_PROBE;
}

process.env.PB_COPY_GATE = 'yes';
try {
  const input = { a: '${PB_COPY_GATE}', b: '${MISSING_COPY_GATE}' };
  const out = util.substituteEnvVars(input);
  check('util.substituteEnvVars fills known names and leaves missing ones',
    out.a === 'yes' && out.b === '${MISSING_COPY_GATE}',
    JSON.stringify(out));
} finally {
  delete process.env.PB_COPY_GATE;
}

check('util.shellQuote quotes a space',
  util.shellQuote('a b') !== 'a b' && util.shellQuote('safe_ok') === 'safe_ok',
  util.shellQuote('a b'));

check('fuzzy.normalize folds separators',
  fuzzy.normalize('Demo Search') === fuzzy.normalize('demo.search')
  && fuzzy.normalize('demo.search') === 'demo-search',
  fuzzy.normalize('Demo Search'));
