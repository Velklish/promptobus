import { check, skip } from './check.mjs';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { processHasOpenFile } from '../lib/root-process.js';
import { requireProcess } from '../lib/service-state.js';

const source = readFileSync(new URL('../lib/root-process.js', import.meta.url), 'utf8');
check('Darwin file proof documents numeric descriptors and refusal of timed-out output',
  readFileSync(new URL('../docs/reference/05-drivers.md', import.meta.url), 'utf8').includes('`/usr/sbin/lsof -b -p PID -FpiD`')
  && readFileSync(new URL('../docs/reference/05-drivers.md', import.meta.url), 'utf8').includes('failed or timed-out output\ncannot establish admission.'));
const observerSource = source.slice(source.indexOf('export async function processHasOpenFile')).replace('export ', '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const observedFile = '/private/tmp/native-observation/store.db', observedProcess = { pid: 123, birth: 'current-birth' };
const output = 'p123\nf4\nD0x1\ni2\n';
const high = 2n ** 60n;
check('precision fixture uses distinct exact inodes that collide as Numbers', high !== high + 1n && Number(high) === Number(high + 1n));
for (const [name, result, expected, initialInode = 2n, finalInode = initialInode] of [
  ['exact high inode', { status: 0, error: null, stdout: output.replace('i2', `i${high}`) }, true, high],
  ['a different inode with the same Number', { status: 0, error: null, stdout: output.replace('i2', `i${high + 1n}`) }, false, high],
  ['high-inode replacement after observation', { status: 0, error: null, stdout: output.replace('i2', `i${high}`) }, false, high, high + 1n],
  ['completed observation', { status: 0, error: null, stdout: output }, true],
  ['timeout without output', { status: null, error: { code: 'ETIMEDOUT' }, stdout: '' }, false],
  ['timeout after matching output', { status: null, error: { code: 'ETIMEDOUT' }, stdout: output }, false],
  ['failed observation with matching output', { status: 1, error: null, stdout: output }, false],
  ['another process', { status: 0, error: null, stdout: output.replace('p123', 'p456') }, false],
  ['another device', { status: 0, error: null, stdout: output.replace('D0x1', 'D0x2') }, false],
  ['another inode', { status: 0, error: null, stdout: output.replace('i2', 'i3') }, false],
  ['device and inode from separate descriptors', { status: 0, error: null, stdout: 'p123\nf4\nD0x1\ni3\nf5\nD0x2\ni2\n' }, false],
  ['another process after the requested process', { status: 0, error: null, stdout: 'p123\nf4\nD0x2\ni3\np456\nf5\nD0x1\ni2\n' }, false],
  ['a mapped image without an open descriptor', { status: 0, error: null, stdout: output.replace('f4', 'ftxt') }, false],
]) {
  const calls = [], statOptions = [];
  const observe = await new AsyncFunction('path', 'process', 'stat', 'runAsync', 'processStateAsync',
    `${observerSource}; return processHasOpenFile;`)(path, { platform: 'darwin' },
    async (file, options) => { statOptions.push(options); return { dev: 1n, ino: statOptions.length === 1 ? initialInode : finalInode }; },
    async (command, args, options) => { calls.push({ command, args, options }); return result; }, async () => 'alive');
  check(`Darwin file proof: ${name} ${expected ? 'establishes' : 'cannot establish'} admission`,
    await observe(observedProcess, observedFile) === expected && calls.length === 1
    && statOptions.length === 2 && statOptions.every(options => options.bigint === true)
    && calls[0].options.timeoutMs === 2000 && calls[0].command === '/usr/sbin/lsof'
    && JSON.stringify(calls[0].args) === JSON.stringify(['-b', '-p', '123', '-FpiD']), JSON.stringify({ result, calls }));
}

if (!['darwin', 'linux'].includes(process.platform)) {
  skip('native database file descriptor proof', 'No implemented observer on this platform');
} else {
  const directory = mkdtempSync(path.join(realpathSync('/tmp'), 'pb-native-file-'));
  const file = path.join(directory, 'store.db'), identity = requireProcess();
  writeFileSync(file, 'SQLite format 3\0', { mode: 0o600 });
  let fd;
  try {
    check('a regular initialized-looking file alone is not an open native database proof', !await processHasOpenFile(identity, file));
    fd = openSync(file, 'r+');
    check('the exact live process holds the actual current file', await processHasOpenFile(identity, file));
    if (process.platform === 'linux') {
      const stat = fsPromises.stat, physical = await stat(file, { bigint: true });
      for (const changed of [false, true]) {
        let targetReads = 0; const optionsSeen = [];
        fsPromises.stat = async (name, options) => {
          const actual = await stat(name, { bigint: true }); optionsSeen.push(options?.bigint === true);
          let inode;
          if (name === file) inode = changed && ++targetReads > 1 ? high + 1n : high;
          else if (actual.dev === physical.dev && actual.ino === physical.ino) inode = high;
          else return options?.bigint ? actual : stat(name, options);
          return { ...actual, dev: options?.bigint ? physical.dev : Number(physical.dev), ino: options?.bigint ? inode : Number(inode) };
        };
        syncBuiltinESMExports();
        try {
          const opened = await processHasOpenFile(identity, file);
          check(changed ? 'exact high-inode recheck refuses a replacement despite Number collision'
            : 'actual owned FD reaches detection with exact high-inode identity', opened === !changed && optionsSeen.length >= 2 && optionsSeen.every(Boolean));
        } finally { fsPromises.stat = stat; syncBuiltinESMExports(); }
      }
    }
    check('a replaced process birth cannot borrow that file descriptor', !await processHasOpenFile({ ...identity, birth: 'not-the-current-birth' }, file));
    rmSync(file); writeFileSync(file, 'SQLite format 3\0', { mode: 0o600 });
    check('an old open inode cannot prove a replacement path', !await processHasOpenFile(identity, file));
    closeSync(fd); fd = undefined;
    check('a closed file cannot remain a native database proof', !await processHasOpenFile(identity, file));
    const traps = path.join(directory, 'traps'), marker = path.join(directory, 'forged-lsof-used'); mkdirSync(traps);
    writeFileSync(path.join(traps, 'lsof'), '#!/bin/sh\nprintf forged >> "$PB_BAD_OBSERVER"\nprintf "p%s\\nn%s\\n" "$PB_FAKE_PID" "$PB_FAKE_FILE"\n', { mode: 0o700 });
    const previous = { PATH: process.env.PATH, PB_BAD_OBSERVER: process.env.PB_BAD_OBSERVER, PB_FAKE_PID: process.env.PB_FAKE_PID, PB_FAKE_FILE: process.env.PB_FAKE_FILE };
    try {
      Object.assign(process.env, { PATH: `${traps}${path.delimiter}${previous.PATH ?? ''}`, PB_BAD_OBSERVER: marker, PB_FAKE_PID: String(identity.pid), PB_FAKE_FILE: file });
      check('actor PATH cannot turn a closed file into an owned native FD', !await processHasOpenFile(identity, file) && !existsSync(marker));
    } finally {
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(directory, { recursive: true, force: true });
  }
}
