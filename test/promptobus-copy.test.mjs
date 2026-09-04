// Runtime helpers inside the bus boundary: win32 resolve, quoting, env substitution.
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
