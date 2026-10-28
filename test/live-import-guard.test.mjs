// Accidental import of a live script, and a stand that lacks stub isolation.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { proveStandIsolation, STUB_BIN } from '../scripts/live-entry.mjs';
import { makeSandbox, stubCommand } from './sandbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const scriptsDir = path.join(root, 'scripts');
const SCRIPTS = ['live-mixed.mjs', 'live-cursor.mjs', 'live-codex.mjs', 'live-e2e.mjs', 'live-canary.mjs'];
const HELP_SCRIPTS = ['live-mixed.mjs', 'live-cursor.mjs', 'live-codex.mjs', 'live-e2e.mjs'];
const SB = makeSandbox('promptobus-promptobus-live-import-guard-');
const NAMES = ['cursor', 'codex', 'claude', 'agent', 'cursor-agent', 'tmux'];

function detector(log) {
  const dir = path.join(SB, `bin-${path.basename(log, '.log')}`);
  mkdirSync(dir, { recursive: true });
  const body = 'import { appendFileSync } from \'node:fs\';\n'
    + 'appendFileSync(process.env.DETECTOR_LOG, `${process.argv.slice(1).join(\' \')}\\n`);\n';
  for (const name of NAMES) stubCommand(dir, name, body);
  return dir;
}

function readLog(log) {
  try { return readFileSync(log, 'utf8'); } catch { return ''; }
}

function childEnv(bin, log) {
  const env = { ...process.env, PATH: bin, DETECTOR_LOG: log };
  delete env[STUB_BIN];
  return env;
}

const syntaxLog = path.join(SB, 'syntax.log');
writeFileSync(syntaxLog, '');
const syntaxBin = detector(syntaxLog);
const syntaxFaults = [];
for (const name of SCRIPTS) {
  const ran = spawnSync(process.execPath, ['--check', path.join(scriptsDir, name)], {
    encoding: 'utf8', env: childEnv(syntaxBin, syntaxLog),
  });
  if (ran.status !== 0) syntaxFaults.push(`${name} exit ${ran.status}: ${ran.stderr}`);
}
check('syntax: node --check parses every live script and starts no harness binary',
  syntaxFaults.length === 0 && readLog(syntaxLog) === '',
  `${syntaxFaults.join(' · ')} · log ${JSON.stringify(readLog(syntaxLog))}`);

const importLog = path.join(SB, 'import.log');
writeFileSync(importLog, '');
const importBin = detector(importLog);
const childFile = path.join(SB, 'import-child.mjs');
writeFileSync(childFile, `
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const log = process.env.DETECTOR_LOG;
for (const file of process.env.LIVE_SCRIPTS.split(',')) {
  try {
    await import(pathToFileURL(file).href);
    appendFileSync(log, 'IMPORT_OK ' + file + '\\n');
  } catch (error) {
    appendFileSync(log, 'IMPORT_REJECTED ' + (error.code ?? '') + ' ' + file + '\\n');
  }
}
`);
const imported = spawnSync(process.execPath, [childFile], {
  encoding: 'utf8',
  timeout: 120000,
  env: {
    ...childEnv(importBin, importLog),
    LIVE_SCRIPTS: SCRIPTS.map((name) => path.join(scriptsDir, name)).join(','),
  },
});
const importText = readLog(importLog);
const harnessLines = importText.split('\n').filter((line) => line && !line.startsWith('IMPORT_'));
check('import: loading a live script starts no harness binary',
  imported.status === 0 && harnessLines.length === 0,
  `exit ${imported.status} signal ${imported.signal} · ${importText} · ${(imported.stderr ?? '').slice(-500)}`);
check('import: the load is refused as not a syntax check',
  SCRIPTS.every((name) => importText.includes(`IMPORT_REJECTED LIVE_SCRIPT_IMPORT ${path.join(scriptsDir, name)}`)),
  importText);

const helpLog = path.join(SB, 'help.log');
writeFileSync(helpLog, '');
const helpBin = detector(helpLog);
const helpFaults = [];
for (const name of HELP_SCRIPTS) {
  const ran = spawnSync(process.execPath, [path.join(scriptsDir, name), '--help'], {
    encoding: 'utf8', timeout: 60000, env: childEnv(helpBin, helpLog),
  });
  if (ran.status !== 0 || !/^Purpose: /m.test(ran.stdout)) helpFaults.push(`${name} ${ran.status} ${ran.stdout} ${ran.stderr}`);
}
check('cli: node scripts/live-*.mjs --help remains the live route and starts no harness binary',
  helpFaults.length === 0 && readLog(helpLog) === '',
  `${helpFaults.join(' · ')} · log ${JSON.stringify(readLog(helpLog))}`);

const missingLog = path.join(SB, 'missing.log');
writeFileSync(missingLog, '');
const missingBin = detector(missingLog);
const emptyBin = path.join(SB, 'empty-bin');
mkdirSync(emptyBin);
const missing = spawnSync(process.execPath, [path.join(scriptsDir, 'live-codex.mjs')], {
  encoding: 'utf8',
  timeout: 60000,
  env: { ...childEnv(missingBin, missingLog), [STUB_BIN]: emptyBin },
});
const missingOut = `${missing.stdout ?? ''}${missing.stderr ?? ''}`;
check('isolation: a stand bin with no stub refuses before a scenario and does not call an installed binary',
  missing.status === 1 && missingOut.includes('✖ live run not started:')
  && missingOut.includes('refusing to search PATH') && !/^▸ sandbox: /m.test(missingOut)
  && readLog(missingLog) === '',
  `exit ${missing.status} · ${missingOut.slice(-600)} · log ${JSON.stringify(readLog(missingLog))}`);

const homeLog = path.join(SB, 'home.log');
writeFileSync(homeLog, '');
const homeDecoy = detector(homeLog);
const stubBin = path.join(SB, 'real-stub');
stubCommand(stubBin, 'codex', 'process.stdout.write(`stub-version harness\\n`);\n');
const userCodex = path.join(homedir(), '.codex', 'promptobus-import-guard-unset');
const homeRun = spawnSync(process.execPath, [path.join(scriptsDir, 'live-codex.mjs')], {
  encoding: 'utf8',
  timeout: 60000,
  env: {
    ...childEnv(homeDecoy, homeLog),
    [STUB_BIN]: stubBin,
    PROMPTOBUS_E2E_CODEX: userCodex,
    PROMPTOBUS_CODEX_HOME: userCodex,
  },
});
const homeOut = `${homeRun.stdout ?? ''}${homeRun.stderr ?? ''}`;
check('isolation: a state home under the user harness directory refuses and does not call an installed binary',
  homeRun.status === 1 && homeOut.includes('under the user home') && !/^▸ sandbox: /m.test(homeOut)
  && readLog(homeLog) === '',
  `exit ${homeRun.status} · ${homeOut.slice(-600)} · log ${JSON.stringify(readLog(homeLog))}`);

const provedLog = path.join(SB, 'proved.log');
writeFileSync(provedLog, '');
const provedDecoy = detector(provedLog);
const isolatedHome = path.join(SB, 'isolated-home');
mkdirSync(isolatedHome);
const proved = proveStandIsolation({
  binDir: emptyBin,
  names: ['codex'],
  homes: { PROMPTOBUS_CODEX_HOME: isolatedHome },
  env: { ...childEnv(provedDecoy, provedLog), PROMPTOBUS_CODEX_HOME: isolatedHome },
});
check('isolation: proveStandIsolation refuses a missing stub without calling a later PATH entry',
  proved.ok === false && proved.reason.includes('refusing to search PATH') && readLog(provedLog) === '',
  `${proved.reason} · log ${JSON.stringify(readLog(provedLog))}`);

const aheadLog = path.join(SB, 'detector-ahead.log');
const installLog = path.join(SB, 'detector-install.log');
const stubLog = path.join(SB, 'sealed-stub.log');
writeFileSync(aheadLog, '');
writeFileSync(installLog, '');
writeFileSync(stubLog, '');
const aheadBin = path.join(SB, 'detector-ahead');
const installBin = path.join(SB, 'detector-install');
const sealedBin = path.join(SB, 'sealed-stub');
const recordBody = (log) => 'import { appendFileSync } from \'node:fs\';\n'
  + `appendFileSync(${JSON.stringify(log)}, process.argv[1] + ' ' + process.argv.slice(2).join(' ') + '\\n');\n`;
const harnessNames = ['cursor-agent', 'agent', 'cursor', 'tmux', 'codex', 'claude'];
for (const name of harnessNames) {
  stubCommand(aheadBin, name, recordBody(aheadLog) + 'process.stdout.write(`detector harness\\n`);\n');
  stubCommand(installBin, name, recordBody(installLog) + 'process.stdout.write(`detector harness\\n`);\n');
}
const stubBody = 'import { appendFileSync } from \'node:fs\';\n'
  + `appendFileSync(${JSON.stringify(stubLog)}, process.argv.slice(2).join(' ') + '\\n');\n`
  + 'process.stdout.write(`stub harness\\n`);\n';
for (const name of harnessNames) stubCommand(sealedBin, name, stubBody);
const sealedHomes = {
  PROMPTOBUS_CURSOR_HOME: path.join(SB, 'cursor-home'),
  PROMPTOBUS_CURSOR_USER_HOME: path.join(SB, 'cursor-user'),
  PROMPTOBUS_E2E_CURSOR: path.join(SB, 'e2e-cursor'),
  PROMPTOBUS_E2E_CODEX: path.join(SB, 'e2e-codex'),
  PROMPTOBUS_CODEX_HOME: path.join(SB, 'codex-home'),
  PROMPTOBUS_E2E_HARNESS: path.join(SB, 'e2e-harness'),
  CLAUDE_CONFIG_DIR: path.join(SB, 'claude-config'),
};
for (const dir of Object.values(sealedHomes)) mkdirSync(dir);
const sealChild = path.join(SB, 'seal-child.mjs');
writeFileSync(sealChild, `
import { spawnSync } from 'node:child_process';
import { guardStubLaunch } from ${JSON.stringify(path.join(root, 'scripts', 'live-entry.mjs'))};
import { findCursorBin } from ${JSON.stringify(path.join(root, 'lib', 'driver-cursor.js'))};
const guarded = guardStubLaunch(process.env, {
  names: ['cursor-agent', 'agent', 'cursor', { name: 'tmux', probe: ['-V'] }, 'codex', 'claude'],
  homes: ${JSON.stringify(Object.keys(sealedHomes))},
});
if (!guarded.stub || !guarded.ok) {
  console.error(guarded.reason ?? 'stub guard did not pass');
  process.exit(2);
}
process.stdout.write('SEALED_PATH ' + process.env.PATH + '\\n');
process.stdout.write('SEALED_INSTALL ' + JSON.stringify(process.env.PROMPTOBUS_CURSOR_INSTALL_DIRS) + '\\n');
const found = findCursorBin({ env: process.env });
if (found?.path) spawnSync(found.path, ['--version'], { env: process.env, encoding: 'utf8' });
for (const name of ['cursor-agent', 'agent', 'cursor', 'codex', 'claude']) {
  spawnSync(name, ['--version'], { env: process.env, encoding: 'utf8' });
}
spawnSync('tmux', ['-V'], { env: process.env, encoding: 'utf8' });
`);
const sealEnv = {
  ...process.env,
  PATH: `${aheadBin}${path.delimiter}${process.env.PATH ?? ''}`,
  PROMPTOBUS_CURSOR_INSTALL_DIRS: installBin,
  [STUB_BIN]: sealedBin,
  ...sealedHomes,
};
delete sealEnv.PROMPTOBUS_TEST_PATH_SEAL;
const sealed = spawnSync(process.execPath, [sealChild], { encoding: 'utf8', timeout: 60000, env: sealEnv });
const sealedOut = `${sealed.stdout ?? ''}${sealed.stderr ?? ''}`;
const sealedPath = sealedOut.match(/^SEALED_PATH (.*)$/m)?.[1] ?? '';
const sealedInstall = sealedOut.match(/^SEALED_INSTALL (.*)$/m)?.[1] ?? '';
check('isolation: a detector ahead on PATH and in a Cursor install directory is not executed',
  sealed.status === 0 && readLog(aheadLog) === '' && readLog(installLog) === ''
  && readLog(stubLog).includes('--version') && readLog(stubLog).includes('-V')
  && sealedPath.split(path.delimiter).includes(sealedBin) && !sealedPath.split(path.delimiter).includes(aheadBin)
  && !sealedPath.split(path.delimiter).includes(installBin) && sealedInstall === '""',
  `exit ${sealed.status} path ${sealedPath} install ${sealedInstall} ahead ${JSON.stringify(readLog(aheadLog))} install-log ${JSON.stringify(readLog(installLog))} stub ${JSON.stringify(readLog(stubLog))} ${sealedOut.slice(-500)}`);

const foreign = path.join(SB, 'foreign-session.json');
writeFileSync(foreign, '{"address":"worker:foreign","owned":false}\n');
const marker = path.join(SB, 'owned-path.txt');
const cleanupChild = path.join(SB, 'cleanup-child.mjs');
writeFileSync(cleanupChild, `
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeSandbox } from ${JSON.stringify(path.join(root, 'test', 'sandbox.mjs'))};
const owned = makeSandbox('promptobus-promptobus-live-import-guard-owned-');
const record = path.join(owned, 'session.json');
writeFileSync(record, '{"address":"worker:owned"}\\n');
writeFileSync(process.env.OWNED_MARKER, record);
setInterval(() => {}, 1000);
`);
const cleaner = spawn(process.execPath, [cleanupChild], {
  env: { ...process.env, OWNED_MARKER: marker },
  stdio: 'ignore',
});
const ownedRecord = await new Promise((resolve) => {
  const timer = setInterval(() => {
    if (!existsSync(marker)) return;
    clearInterval(timer);
    resolve(readFileSync(marker, 'utf8').trim());
  }, 20);
  setTimeout(() => { clearInterval(timer); resolve(''); }, 5000);
});
const ownedReady = ownedRecord !== '' && existsSync(ownedRecord);
cleaner.kill('SIGTERM');
const cleaned = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 5000);
  cleaner.on('close', () => { clearTimeout(timer); resolve(true); });
});
check('cleanup: an interrupted fixture removes its own record and leaves an unrelated session',
  ownedReady && cleaned && cleaner.exitCode === 130 && !existsSync(ownedRecord) && existsSync(foreign)
  && readFileSync(foreign, 'utf8').includes('worker:foreign'),
  `ready ${ownedReady} cleaned ${cleaned} exit ${cleaner.exitCode} owned ${ownedRecord} exists ${existsSync(ownedRecord)} foreign ${existsSync(foreign)}`);

const docs = {
  'docs/guides/contributing.md': readFileSync(path.join(root, 'docs/guides/contributing.md'), 'utf8'),
  'docs/reference/02-host.md': readFileSync(path.join(root, 'docs/reference/02-host.md'), 'utf8'),
  'docs/reference/03-cli.md': readFileSync(path.join(root, 'docs/reference/03-cli.md'), 'utf8'),
  'README.md': readFileSync(path.join(root, 'README.md'), 'utf8'),
};
const required = ['node --check', 'PROMPTOBUS_STUB_BIN'];
const docFaults = [];
for (const [file, text] of Object.entries(docs)) {
  for (const phrase of required) if (!text.includes(phrase)) docFaults.push(`${file} lacks ${phrase}`);
}
if (!docs['docs/guides/contributing.md'].includes('LIVE_SCRIPT_IMPORT')) docFaults.push('contributing lacks LIVE_SCRIPT_IMPORT');
if (!docs['docs/reference/02-host.md'].includes('refusing to search PATH')) docFaults.push('02-host lacks the PATH refusal');
if (!docs['docs/reference/02-host.md'].includes('PROMPTOBUS_CURSOR_INSTALL_DIRS')) docFaults.push('02-host lacks the install-directory seal');
if (!docs['docs/guides/contributing.md'].includes('PROMPTOBUS_CURSOR_INSTALL_DIRS')) docFaults.push('contributing lacks the install-directory seal');
check('docs: syntax check, stub bin and PATH refusal are stated where a reader meets the live scripts',
  docFaults.length === 0, docFaults.join('; '));
const guardFaults = [];
for (const [file, needle] of [
  ['scripts/live-mixed.mjs', 'cursor-agent'],
  ['scripts/live-cursor.mjs', 'tmux'],
  ['scripts/live-codex.mjs', 'codex'],
  ['scripts/live-e2e.mjs', 'claude'],
]) {
  if (!readFileSync(path.join(root, file), 'utf8').includes(needle)) guardFaults.push(`${file} lacks ${needle}`);
}
check('isolation: cursor, codex and claude stands guard the names a raise searches',
  guardFaults.length === 0, guardFaults.join('; '));
