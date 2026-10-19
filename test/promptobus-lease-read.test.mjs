import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import { leaseLines, readLease } from '../lib/lease.js';

const SB = makeSandbox('promptobus-lease-read-');
const key = fs.realpathSync(SB);
const scope = createHash('sha256').update(key).digest('hex');
const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid;
const record = JSON.stringify({ pid: dead, since: '2026-01-01T00:00:00.000Z' });
const originalLstat = fs.lstatSync;

for (const keyed of [false, true]) {
  const label = keyed ? 'keyed' : 'machine';
  const read = (root) => readLease(root, keyed ? key : null);
  const lines = (root) => leaseLines(root, Date.now(), keyed ? key : null);
  const waiterDir = (root) => keyed ? path.join(root, 'key-waiters', scope) : path.join(root, 'waiters');
  const missing = path.join(SB, `${label}-missing`);
  check(`${label}: reading a missing lease creates no state`,
    read(missing).waiters.length === 0 && !fs.existsSync(missing));
  fs.mkdirSync(missing);
  check(`${label}: reading a lease without waiters creates no waiter directory`,
    read(missing).waiters.length === 0 && !fs.existsSync(waiterDir(missing)));

  for (const [spelling, suffix] of [['slash', '/'], ['dot', '/.']]) {
    for (const [operationName, operation] of [['read', read], ['status', lines]]) {
      const root = path.join(SB, `${label}-${operationName}-${spelling}-alias`);
      const target = `${root}-target`;
      const dir = waiterDir(target);
      fs.mkdirSync(dir, { recursive: true });
      const sentinel = path.join(dir, `${dead}.json`);
      const bytes = Buffer.from(record);
      fs.writeFileSync(sentinel, bytes);
      fs.symlinkSync(target, root, 'dir');
      let error = 'no refusal';
      try { operation(`${root}${suffix}`); } catch (failure) { error = failure.message; }
      check(`${label}: ${operationName} refuses a symlink root ending in ${suffix} and preserves target bytes`,
        /is a symbolic link/.test(error) && fs.existsSync(sentinel)
          && fs.readFileSync(sentinel).equals(bytes), error);
    }
  }

  for (const location of ['root', ...(keyed ? ['key-waiters'] : []), 'waiters']) {
    for (const kind of ['symlink', 'file', ...(process.getuid ? ['foreign'] : [])]) {
      const root = path.join(SB, `${label}-${location}-${kind}`);
      const rejected = location === 'root' ? root
        : location === 'key-waiters' ? path.join(root, 'key-waiters') : waiterDir(root);
      const target = path.join(SB, `${label}-${location}-${kind}-target`);
      const dir = location === 'root' ? waiterDir(target)
        : location === 'key-waiters' ? path.join(target, scope) : target;
      fs.mkdirSync(dir, { recursive: true });
      const sentinel = path.join(dir, `${dead}.json`);
      fs.writeFileSync(sentinel, record);
      fs.mkdirSync(path.dirname(rejected), { recursive: true });
      if (kind === 'symlink') fs.symlinkSync(target, rejected, 'dir');
      else if (kind === 'file') fs.writeFileSync(rejected, 'keep this file');
      else {
        fs.mkdirSync(waiterDir(root), { recursive: true });
        fs.writeFileSync(path.join(waiterDir(root), `${dead}.json`), record);
        // Model another uid only on this task-owned fixture; no foreign-user path is touched.
        fs.lstatSync = (file, ...args) => {
          const stat = originalLstat(file, ...args);
          if (file === rejected) Object.defineProperty(stat, 'uid', { value: (process.getuid?.() ?? 0) + 1 });
          return stat;
        };
        syncBuiltinESMExports();
      }
      const errors = [];
      try {
        for (const operation of [read, lines]) {
          try { operation(root); errors.push('no refusal'); } catch (error) { errors.push(error.message); }
        }
      } finally {
        fs.lstatSync = originalLstat;
        syncBuiltinESMExports();
      }
      const expected = kind === 'symlink' ? /is a symbolic link/
        : kind === 'file' ? /is not a directory/ : /belongs to uid/;
      const ownSentinel = path.join(waiterDir(root), `${dead}.json`);
      check(`${label}: read and status refuse ${kind} ${location} and preserve target bytes`,
        errors.every((error) => expected.test(error)) && fs.existsSync(sentinel)
          && fs.readFileSync(sentinel, 'utf8') === record
          && (kind !== 'foreign' || (fs.existsSync(ownSentinel) && fs.readFileSync(ownSentinel, 'utf8') === record))
          && (kind !== 'file' || fs.readFileSync(rejected, 'utf8') === 'keep this file'),
        JSON.stringify(errors));
    }
  }

  const root = path.join(SB, `${label}-records`);
  const dir = waiterDir(root);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, contents] of [['empty', ''], ['truncated', '{"pid":']]) {
    const file = path.join(dir, `${dead}.json`);
    fs.writeFileSync(file, contents);
    read(root);
    check(`${label}: reading removes a dead ${name} waiter registration`, !fs.existsSync(file));
    const live = path.join(dir, `${process.pid}.json`);
    fs.writeFileSync(live, contents);
    const state = read(root);
    check(`${label}: reading preserves a live ${name} waiter registration`,
      fs.existsSync(live) && fs.readFileSync(live, 'utf8') === contents && state.waiters.length === 0);
    fs.rmSync(live, { force: true });
  }

  const unrelated = path.join(dir, 'notes.json');
  const mismatched = path.join(dir, `${dead}.json`);
  const nonRecord = path.join(dir, `${dead + 1}.json`);
  const target = path.join(SB, `${label}-record-target.json`);
  const link = path.join(dir, `${dead + 2}.json`);
  fs.writeFileSync(unrelated, record);
  fs.writeFileSync(mismatched, JSON.stringify({ pid: process.pid }));
  fs.writeFileSync(nonRecord, '{}');
  fs.writeFileSync(target, record);
  fs.symlinkSync(target, link);
  read(root);
  check(`${label}: cleanup preserves unrecognized names, mismatched records and symlink entries`,
    fs.existsSync(unrelated) && fs.readFileSync(unrelated, 'utf8') === record && fs.existsSync(mismatched)
      && fs.readFileSync(mismatched, 'utf8') === JSON.stringify({ pid: process.pid })
      && fs.existsSync(nonRecord) && fs.readFileSync(nonRecord, 'utf8') === '{}'
      && fs.existsSync(link) && fs.readFileSync(target, 'utf8') === record);
  if (process.getuid) {
    const foreign = path.join(dir, `${dead}.json`);
    const contents = record;
    fs.writeFileSync(foreign, contents);
    fs.lstatSync = (file, ...args) => {
      const stat = originalLstat(file, ...args);
      if (file === foreign) Object.defineProperty(stat, 'uid', { value: process.getuid() + 1 });
      return stat;
    };
    syncBuiltinESMExports();
    try { read(root); } finally {
      fs.lstatSync = originalLstat;
      syncBuiltinESMExports();
    }
    check(`${label}: cleanup preserves a waiter file owned by another uid`,
      fs.existsSync(foreign) && fs.readFileSync(foreign, 'utf8') === contents);
  }
}
