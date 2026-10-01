import fs, { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import { dropDeadLock, withDirLock, withDirLockAsync } from '../dist/fs/lock.js';

const root = makeSandbox('promptobus-lock-');
const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
const words = {
  waitMs: 0,
  onMissing: () => new Error('missing lock parent'),
  onBusy: held => new Error(`busy ${held?.pid ?? 'unknown'}`),
};
const owner = (lock, pid, nonce) => {
  mkdirSync(lock);
  writeFileSync(path.join(lock, 'owner'), JSON.stringify({ pid, nonce, session: null, since: new Date().toISOString() }));
};
const ordinary = path.join(root, 'ordinary');
owner(ordinary, deadPid, 'dead-original');
let entered = false;
withDirLock(ordinary, () => { entered = true; }, words);
check('an ordinary dead owner is reclaimed and the acquired lock is released', entered && !existsSync(ordinary));

const raced = path.join(root, 'raced');
owner(raced, deadPid, 'dead-original');
const rename = fs.renameSync;
let armed = true;
let movedLiveGeneration = false;
fs.renameSync = (from, to) => {
  if (!armed || from !== raced) return rename(from, to);
  armed = false;
  // Both readers saw the dead generation. The competing reaper completes first,
  // and the next legitimate holder enters before the delayed rename resumes.
  if (dropDeadLock(raced)) {
    return withDirLock(raced, () => {
      const live = JSON.parse(readFileSync(path.join(raced, 'owner'), 'utf8'));
      rename(from, to);
      movedLiveGeneration = live.pid === process.pid && !existsSync(raced);
    }, words);
  }
  return rename(from, to);
};
syncBuiltinESMExports();
try { dropDeadLock(raced); } finally {
  fs.renameSync = rename;
  syncBuiltinESMExports();
}
check('a delayed stale reaper cannot move the replacement holder live generation', !movedLiveGeneration);

const released = path.join(root, 'released-during-claim');
owner(released, deadPid, 'dead-original');
const mkdir = fs.mkdirSync;
let claimArmed = true;
fs.mkdirSync = (dir, options) => {
  if (!claimArmed || dir !== path.join(released, '.reclaim')) return mkdir(dir, options);
  claimArmed = false;
  dropDeadLock(released);
  return withDirLock(released, () => { mkdir(dir, options); }, words);
};
syncBuiltinESMExports();
let releaseRaceError = '';
try { dropDeadLock(released); } catch (error) { releaseRaceError = error.message; } finally {
  fs.mkdirSync = mkdir;
  syncBuiltinESMExports();
}
check('a replacement holder release during claim creation is retried without a filesystem error', !releaseRaceError, releaseRaceError);

for (const asynchronous of [false, true]) {
  const lock = path.join(root, asynchronous ? 'async-release' : 'sync-release');
  const replace = () => {
    rename(lock, `${lock}.old`);
    owner(lock, process.pid, 'replacement-generation');
  };
  if (asynchronous) await withDirLockAsync(lock, async () => { replace(); }, words);
  else withDirLock(lock, replace, words);
  check(`an old ${asynchronous ? 'asynchronous' : 'synchronous'} finalizer preserves a replacement generation`,
    existsSync(lock) && JSON.parse(readFileSync(path.join(lock, 'owner'), 'utf8')).nonce === 'replacement-generation');
}

for (const live of [false, true]) {
  const lock = path.join(root, live ? 'live-reclaimer' : 'crashed-reclaimer');
  owner(lock, deadPid, 'dead-original');
  const claim = path.join(lock, '.reclaim');
  owner(claim, live ? process.pid : deadPid, 'reclaimer-generation');
  const original = readFileSync(path.join(lock, 'owner'), 'utf8');
  const originalClaim = readFileSync(path.join(claim, 'owner'), 'utf8');
  let refusal = '';
  try { withDirLock(lock, () => {}, words); } catch (error) { refusal = error.message; }
  check(`${live ? 'a live' : 'a crashed'} reclaimer prevents automatic deletion of its claimed generation`,
    refusal && existsSync(lock) && existsSync(claim)
    && readFileSync(path.join(lock, 'owner'), 'utf8') === original
    && readFileSync(path.join(claim, 'owner'), 'utf8') === originalClaim,
    refusal);
  if (!live) check('interrupted reclamation explains the addressed manual recovery',
    /reclamation/.test(refusal) && refusal.includes(claim) && refusal.includes('rm -r --'), refusal);
  else check('a live reclaimer refusal identifies its live pid and offers no removal command',
    refusal.includes(`live reclamation holder pid ${process.pid}`) && !refusal.includes('rm -r --'), refusal);
}

const missingOwner = path.join(root, 'claim-before-owner');
owner(missingOwner, deadPid, 'dead-original');
mkdirSync(path.join(missingOwner, '.reclaim'));
let partialRefusal = '';
try { withDirLock(missingOwner, () => {}, words); } catch (error) { partialRefusal = error.message; }
check('a crash before the claim owner write also refuses without deleting the generation',
  /reclamation/.test(partialRefusal) && existsSync(path.join(missingOwner, '.reclaim')), partialRefusal);
