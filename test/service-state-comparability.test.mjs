import { check } from './check.mjs';
import cp from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { processIdentity, processState, processStateAsync } from '../lib/service-state.js';
import { observeRootProcess } from '../lib/root-process.js';
import { makeSandbox } from './sandbox.mjs';

// Controlled kernel-view responses exercise the shared parser on both platforms; no real platform certificate.
const platform = Object.getOwnPropertyDescriptor(process, 'platform');
const originals = { readFileSync: fs.readFileSync, readlinkSync: fs.readlinkSync, readFile: fsp.readFile, readlink: fsp.readlink,
  spawn: cp.spawn, spawnSync: cp.spawnSync, kill: process.kill };
const pid = process.pid + 200000, boot = '00000000-0000-4000-8000-000000000001';
const inheritedTrace = process.env.PROMPTOBUS_EXEC_TRACE;
const traceFile = path.join(makeSandbox('pb-observer-trace-'), 'mock-kernel.trace');
const mockTrace = `/bin/ps\t/bin/ps\t${JSON.stringify({ version: 1, platform: 'darwin', shape: 'process-lifetime', pid: String(pid) })}`;
const traceLines = file => file && fs.existsSync(file) ? originals.readFileSync(file, 'utf8').trimEnd().split('\n') : [];
const inheritedMockCount = traceLines(inheritedTrace).filter(line => line === mockTrace).length;
let targetTicks = '800', state = 'S', absent = false, malformed = false, denied = false, namespaceMismatch = false, selfMismatch = false, viewMismatch = false;
let currentBoot = boot, start = 'Sun Nov 1 00:00:00 2026', stderr = '';
const calls = [], signals = [];
const failure = code => Object.assign(new Error('Controlled observer refusal'), { code });
const stat = (id, ticks, status = 'S') => { const fields = Array(20).fill('0'); fields[0] = status; fields[19] = ticks; return `${id} (owned fixture) ${fields.join(' ')}`; };
const read = file => {
  if (file === '/proc/sys/kernel/random/boot_id') return currentBoot;
  if (file === '/proc/self/stat') return stat(selfMismatch ? process.pid + 1 : process.pid, '700');
  if (file === '/proc/self/status') return `Pid:\t${process.pid}\nNSpid:\t${viewMismatch ? '1\t' : ''}${process.pid}\n`;
  if (file === `/proc/${pid}/stat`) {
    if (absent) throw failure('ENOENT'); if (denied) throw failure('EACCES');
    return malformed ? `${pid} (fixture) S incomplete` : stat(pid, targetTicks, state);
  }
  throw new Error(`Unexpected controlled read ${file}`);
};
const link = file => {
  if (file === '/proc/self/ns/pid') return namespaceMismatch ? 'pid:[4026531999]' : 'pid:[4026531836]';
  throw new Error(`Unexpected controlled readlink ${file}`);
};
const ps = (file, args, options) => {
  if (file !== '/bin/ps' || JSON.stringify(args) !== JSON.stringify(['-p', String(pid), '-o', 'stat=', '-o', 'lstart='])) throw new Error('Unexpected controlled process observer');
  calls.push(options);
  return { status: absent || denied ? 1 : 0, stdout: absent ? '' : malformed ? 'S incomparable birth\n' : `${state} ${start}\n`,
    stderr: denied ? 'ps: Operation not permitted\n' : stderr };
};
const parity = async (identity, expected, name) => check(name, processState(identity) === expected && await processStateAsync(identity) === expected);
try {
  process.env.PROMPTOBUS_EXEC_TRACE = traceFile;
  fs.readFileSync = read; fs.readlinkSync = link; fsp.readFile = async file => read(file); fsp.readlink = async file => link(file);
  cp.spawnSync = ps;
  cp.spawn = (file, args, options) => {
    const result = ps(file, args, options), child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = signal => { signals.push({ observer: true, signal }); return true; };
    queueMicrotask(() => { child.stdout.end(result.stdout); child.stderr.end(result.stderr); child.emit('close', result.status, null); });
    return child;
  };
  process.kill = (id, signal) => { signals.push({ id, signal }); if (denied) throw failure('EPERM'); if (absent) throw failure('ESRCH'); return true; };
  syncBuiltinESMExports();
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  const linux = processIdentity(pid);
  check('new Linux captures include versioned verified PID namespace and match async capture', linux?.birth === `v2:linux:${boot}:4026531836:800`
    && JSON.stringify(await observeRootProcess(pid)) === JSON.stringify(linux));
  await parity(linux, 'alive', 'same captured Linux lifetime is alive in both observers');
  targetTicks = '801'; signals.length = 0;
  await parity(linux, 'dead', 'reliable different birth in the same Linux kernel view proves the old lifetime ended');
  check('positive different-birth observation never signals the reused occupant', signals.length === 0);
  state = 'Z'; targetTicks = '800'; await parity(linux, 'dead', 'terminal Z of a comparable Linux lifetime is exited');
  state = 'S'; malformed = true; await parity(linux, 'unknown', 'incomplete Linux stat is unknown while the PID remains present');
  malformed = false; denied = true; await parity(linux, 'unknown', 'permission-refused Linux birth observations remain unknown'); denied = false;
  absent = true; signals.length = 0;
  await parity({ pid, birth: `${boot}:800` }, 'unknown', 'old Linux layouts do not gain death or reclamation from ESRCH in an unproved namespace');
  check('old-layout authority never probes an occupant by PID-only fallback', signals.length === 0);
  await parity(linux, 'dead', 'positive absent PID remains death only in the verified captured Linux view');
  namespaceMismatch = true; signals.length = 0;
  await parity(linux, 'unknown', 'another verified current namespace refuses death even when signal0 would say ESRCH');
  check('namespace mismatch does not fall back to a signal in another numeric view', signals.length === 0);
  namespaceMismatch = false; viewMismatch = true;
  await parity(linux, 'unknown', 'a mounted procfs ancestor PID view is not accepted from self namespace alone'); viewMismatch = false;
  selfMismatch = true;
  await parity(linux, 'unknown', 'procfs self PID mismatch is not guessed into a compatible namespace'); selfMismatch = false;
  currentBoot = '00000000-0000-4000-8000-000000000002';
  await parity(linux, 'unknown', 'another boot namespace is incomparable rather than assumed dead'); currentBoot = boot;
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' }); absent = false;
  const darwin = processIdentity(pid);
  check('new Darwin captures use the full canonical stable UTC C-locale observation', darwin?.birth === 'v2:darwin:utc-c:Sun Nov 1 00:00:00 2026'
    && JSON.stringify(await observeRootProcess(pid)) === JSON.stringify(darwin));
  await parity(darwin, 'alive', 'same captured Darwin lifetime is alive in both observers');
  start = 'Sun Nov 1 00:00:01 2026'; signals.length = 0;
  await parity(darwin, 'dead', 'reliable different full Darwin birth proves only the old lifetime ended');
  check('Darwin different-birth observation never signals the reused occupant', signals.length === 0);
  state = 'Z'; start = 'Sun Nov 1 00:00:00 2026'; await parity(darwin, 'dead', 'terminal Z remains exited under stable Darwin parsing'); state = 'S';
  malformed = true; await parity(darwin, 'unknown', 'arbitrary nonempty Darwin birth output cannot become dead'); malformed = false;
  stderr = 'ps: partial observation\n'; await parity(darwin, 'unknown', 'Darwin output with an observer error is unknown'); stderr = '';
  await parity({ pid, birth: start }, 'unknown', 'old untagged Darwin formatter context remains unknown');
  await parity(linux, 'unknown', 'a different platform birth layout cannot cross namespaces');
  check('every Darwin observation fixes locale and timezone', calls.length > 0 && calls.every(options =>
    options.env.LC_ALL === 'C' && options.env.LANG === 'C' && options.env.TZ === 'UTC'));
} finally {
  if (inheritedTrace === undefined) delete process.env.PROMPTOBUS_EXEC_TRACE;
  else process.env.PROMPTOBUS_EXEC_TRACE = inheritedTrace;
  Object.defineProperty(process, 'platform', platform);
  fs.readFileSync = originals.readFileSync; fs.readlinkSync = originals.readlinkSync;
  fsp.readFile = originals.readFile; fsp.readlink = originals.readlink; cp.spawn = originals.spawn; cp.spawnSync = originals.spawnSync; process.kill = originals.kill;
  syncBuiltinESMExports();
}
const localTrace = traceLines(traceFile);
check('controlled Darwin observations reach only the fixture trace with their exact kernel shape',
  localTrace.length > 0 && localTrace.every(line => line === mockTrace));
check('controlled Darwin observations do not append to the inherited runner trace',
  traceLines(inheritedTrace).filter(line => line === mockTrace).length === inheritedMockCount);
