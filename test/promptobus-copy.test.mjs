// Runtime helpers inside the bus boundary: win32 resolve, quoting, env substitution.
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
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

check('exec.quoteCmdArg quotes spaces and JSON',
  String(exec.quoteCmdArg('--print')).includes('--print')
  && exec.quoteCmdArg('C:\\Users\\Ivan Petrov\\ws').includes('Ivan Petrov')
  && exec.quoteCmdArg('{"deny":["Bash"]}').includes('deny'),
  exec.quoteCmdArg('{"deny":["Bash"]}'));

const posix = exec.planRun('git', ['status'], { platform: 'linux' });
check('exec.planRun on POSIX is a direct spawn',
  posix.ok === true && posix.shell !== true,
  JSON.stringify(posix));

const exe = exec.planRun('claude', ['-p', 'многострочный\nпромпт'], WIN);
check('exec.planRun win .exe stays a direct spawn',
  exe.ok === true, JSON.stringify(exe));

const bat = exec.planRun('npm', ['publish', '--userconfig', 'C:\\tmp\\a b\\.npmrc'], WIN);
check('exec.planRun win .cmd is ok for paths with spaces',
  bat.ok === true, JSON.stringify(bat));

const percent = exec.planRun('npm', ['run', '%PATH%'], WIN);
check('exec.planRun win .cmd refuses %',
  percent.ok === false && percent.code !== undefined, JSON.stringify(percent));

// A copy shortens only the two shared ceilings: exercising the production minute
// would add a minute to every suite run, while a caller that forgot the defaults
// must still go red rather than hang the probe. liftoff.js is the production reader,
// with only its unrelated imports pointed back at this tree.
// `bgSessions` also maps empty stdout to null, so the elapsed bound — not `timed`
// alone — is the discriminating half of the timeout verdict.
const PROBE = path.join(SB, 'exec-ceilings');
mkdirSync(PROBE, { recursive: true });
const execSource = readFileSync(new URL('../lib/exec.js', import.meta.url), 'utf8');
const probeExec = execSource
  .replace('export const PROC_TIMEOUT_MS = 60_000;', 'export const PROC_TIMEOUT_MS = 1_000;')
  .replace('export const GIT_MAX_OUTPUT = 32 * 1024 * 1024;', 'export const GIT_MAX_OUTPUT = 64;');
check('exec ceiling probe shortens both production defaults',
  probeExec !== execSource
  && probeExec.includes('export const PROC_TIMEOUT_MS = 1_000;')
  && probeExec.includes('export const GIT_MAX_OUTPUT = 64;'));
writeFileSync(path.join(PROBE, 'exec.js'), probeExec);

const liftoffSource = readFileSync(new URL('../lib/liftoff.js', import.meta.url), 'utf8');
const probeLiftoff = liftoffSource
  .replace("'../dist/index.js'", JSON.stringify(new URL('../dist/index.js', import.meta.url).href))
  .replace("'./util.js'", JSON.stringify(new URL('../lib/util.js', import.meta.url).href));
check('bgSessions probe keeps the production reader and redirects only its neighbours',
  probeLiftoff !== liftoffSource
  && !probeLiftoff.includes("'../dist/index.js'")
  && !probeLiftoff.includes("'./util.js'"));
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
  fuzzy.normalize('ATI Search') === fuzzy.normalize('ati.search')
  && fuzzy.normalize('ati.search') === 'ati-search',
  fuzzy.normalize('ATI Search'));
