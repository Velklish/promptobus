import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as module from 'node:module';
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';

const original = readFileSync(new URL('../src/fs/lock.ts', import.meta.url), 'utf8');
const source = module.stripTypeScriptTypes ? module.stripTypeScriptTypes(original, { mode: 'transform' })
  : readFileSync(new URL('../dist/fs/lock.js', import.meta.url), 'utf8');
const executable = source.replace("from './proc.js'", `from ${JSON.stringify(new URL('../dist/fs/proc.js', import.meta.url).href)}`);
const locks = await import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`);
const scope = locks.withSynchronousAuthority ?? ((_authorize, fn) => fn());
const root = makeSandbox('promptobus-service-operation-locks-');
const occupied = path.join(root, 'occupied');
mkdirSync(occupied); writeFileSync(path.join(occupied, 'owner'), JSON.stringify({ pid: process.pid, nonce: 'foreign-live' }));
const busy = [];
const options = { waitMs: 8, retryMs: 1, onMissing: () => new Error('fixture missing'),
  onBusy: (_owner, waited) => { busy.push(waited); return new Error('fixture busy'); } };
const contend = () => { try { locks.withDirLock(occupied, () => {}, options); } catch (error) { return error.message; } };
let effects = 0, fences = 0;
const before = scope(() => { fences += 1; }, () => contend());
check('managed lock contention refuses before any effect without consuming the configured wait', before === 'fixture busy'
  && busy.at(-1) < options.waitMs && effects === 0, JSON.stringify({ busy, effects }));
const own = path.join(root, 'own');
const nested = scope(() => { fences += 1; }, () => locks.withDirLock(own, () =>
  locks.withDirLock(own, () => { effects += 1; return contend(); }, options), options));
check('nested owned locks retain their licence while a later target refuses after a possible effect', nested === 'fixture busy'
  && effects === 1 && fences >= 4 && busy.at(-1) < options.waitMs, JSON.stringify({ busy, effects, fences }));
let generation = 1, driftRefused = false;
try {
  scope(() => { if (generation !== 1) throw new Error('record revision drift'); }, () => locks.withDirLock(own, () => {
    generation = 2;
    locks.withDirLock(own, () => { effects += 1; }, options);
  }, options));
} catch (error) { driftRefused = /record revision drift/.test(error.message); }
check('each nested acquisition fences record drift before its next possible effect', driftRefused && effects === 1);
let first = 0, second = 0;
scope(() => { first += 1; }, () => {
  try { scope(() => { second += 1; }, () => { throw new Error('owned synchronous throw'); }); } catch {}
  locks.requireSynchronousAuthority?.();
});
const calls = [first, second];
locks.requireSynchronousAuthority?.();
check('nested scope and throw restore the previous authority, then remove it on return', calls[0] === 2 && calls[1] === 1
  && first === calls[0] && second === calls[1], JSON.stringify({ first, second }));
contend();
check('ordinary synchronous lock callers retain their configured wait after managed return', busy.at(-1) >= options.waitMs, JSON.stringify(busy));
await scope(() => {}, () => Promise.resolve().then(contend));
check('a delayed callback receives no synchronous scope or fresh admission licence', busy.at(-1) >= options.waitMs, JSON.stringify(busy));
let selfRefused = false;
await locks.withDirLockAsync(own, async () => {
  scope(() => {}, () => { try { locks.withDirLock(own, () => {}, options); } catch (error) { selfRefused = /asynchronous holder/.test(error.message); } });
}, options);
check('managed scope preserves asynchronous self-lock refusal', selfRefused);
let rejected = false;
try { scope(() => { throw new Error('revision drift'); }, () => { effects += 1; }); } catch { rejected = true; }
check('a rejected admission fence does not enter the operation and restores default lock policy', rejected && effects === 1);
contend();
check('a rejected admission fence leaves no no-wait policy behind', busy.at(-1) >= options.waitMs, JSON.stringify(busy));
