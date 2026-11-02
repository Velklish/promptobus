import { check, skip } from './check.mjs';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { processHasOpenFile } from '../lib/root-process.js';
import { requireProcess } from '../lib/service-state.js';

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
    const stat = fsPromises.stat, physical = await stat(file, { bigint: true }), high = 2n ** 60n;
    check('precision fixture uses distinct exact inodes that collide as Numbers', high !== high + 1n && Number(high) === Number(high + 1n));
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
