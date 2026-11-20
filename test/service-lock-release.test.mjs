import { check, skip } from './check.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireServiceLock, readPrivate, requireProcess, writePrivate } from '../lib/service-state.js';
import { makeSandbox } from './sandbox.mjs';

if (!['darwin', 'linux'].includes(process.platform)) {
  skip('service lock release across processes', 'This platform has no implemented process-birth observer');
} else {
  const base = realpathSync(makeSandbox('promptobus-service-lock-'));
  const directory = path.join(base, 'active.lock'), ownerFile = path.join(directory, 'owner.json');
  const moduleUrl = pathToFileURL(path.resolve('lib/service-state.js')).href;
  const actors = [];
  const marker = name => path.join(base, name);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(predicate) {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('Service lock fixture timed out');
      await wait(10);
    }
  }
  function actor(source) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const directory=${JSON.stringify(directory)}, ownerFile=${JSON.stringify(ownerFile)}, base=${JSON.stringify(base)};
const marker=name=>base+'/'+name;
const pause=new Int32Array(new SharedArrayBuffer(4));
const until=predicate=>{const end=Date.now()+10000;while(!predicate()){if(Date.now()>=end)throw Error('child barrier timed out');Atomics.wait(pause,0,0,5)}};
${source}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const done = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, output })));
    actors.push(child);
    return { child, done };
  }
  try {
    const holder = actor(`
const mkdir=fs.mkdirSync;
let releasing=false;
fs.mkdirSync=(file,...args)=>{if(releasing&&file===directory+'.gate')fs.writeFileSync(marker('release-gate'),'attempted');return mkdir(file,...args)};
syncBuiltinESMExports();
const {acquireServiceLock,readPrivate}=await import(${JSON.stringify(moduleUrl)});
const release=await acquireServiceLock(directory);
fs.writeFileSync(marker('ready.tmp'),JSON.stringify(readPrivate(ownerFile)));
fs.renameSync(marker('ready.tmp'),marker('ready'));
until(()=>fs.existsSync(marker('release')));
fs.writeFileSync(marker('release-started'),'started');
releasing=true;
const result=release();
fs.writeFileSync(marker('released'),JSON.stringify({synchronous:result===undefined}));
`);
    await until(() => existsSync(marker('ready')));
    const proof = JSON.parse(readFileSync(marker('ready'), 'utf8'));
    check('the barrier holder publishes real process birth and nonce proof',
      proof.pid === holder.child.pid && typeof proof.birth === 'string' && !!proof.birth && typeof proof.nonce === 'string' && !!proof.nonce);
    const contender = actor(`
const open=fs.openSync;
let observed=false;
fs.openSync=(file,...args)=>{if(file===ownerFile&&!observed){observed=true;fs.writeFileSync(marker('observed'),'directory checked');until(()=>fs.existsSync(marker('read-owner')))}return open(file,...args)};
syncBuiltinESMExports();
const {acquireServiceLock}=await import(${JSON.stringify(moduleUrl)});
let result;
try {const release=await acquireServiceLock(directory);result={kind:release?'acquired':'busy'};release?.()}
catch(error){result={kind:'refused',error:error.message}}
fs.writeFileSync(marker('contender'),JSON.stringify(result));
`);
    await until(() => existsSync(marker('observed')));
    check('the contender pauses after active directory checks while holding the core gate', existsSync(`${directory}.gate`));
    writeFileSync(marker('release'), 'release now');
    await until(() => existsSync(marker('release-started')));
    await until(() => existsSync(marker('released')) || existsSync(marker('release-gate')));
    writeFileSync(marker('read-owner'), 'read now');
    const [held, contended] = await Promise.all([holder.done, contender.done]);
    check('both owned barrier actors finish without process errors', held.code === 0 && contended.code === 0, JSON.stringify({ held, contended }));
    const result = JSON.parse(readFileSync(marker('contender'), 'utf8'));
    check('release cannot erase owner proof between contender observation and owner read', result.kind === 'busy', JSON.stringify(result));
    check('release remains synchronous and removes its own generation',
      JSON.parse(readFileSync(marker('released'), 'utf8')).synchronous && !existsSync(directory));
    const release = await acquireServiceLock(directory);
    check('a contender can acquire after the previous release finishes', typeof release === 'function');
    release?.();

    for (const mode of ['write-error', 'rename-error', 'replacement', 'nonempty', 'before-cutover']) {
      const writer = actor(`
const mode=${JSON.stringify(mode)}, rename=fs.renameSync, failure=new Error('injected publication failure');
fs.renameSync=(from,to)=>{
  if (to===directory && mode==='rename-error') throw failure;
  if (!to.endsWith('/owner.json')) return rename(from,to);
  fs.writeFileSync(marker('preparation'),JSON.stringify({public:fs.existsSync(directory), file:to}));
  if (mode==='rename-error') return rename(from,to);
  if (mode==='write-error') throw failure;
  if (fs.existsSync(directory)) rename(directory, marker('retired-'+mode));
  fs.mkdirSync(directory, {mode:0o700});
  fs.writeFileSync(marker('replacement-inode'), String(fs.statSync(directory).ino));
  if (mode==='nonempty') fs.writeFileSync(directory+'/foreign', 'keep');
  if (mode==='before-cutover') return rename(from,to);
  throw failure;
};
syncBuiltinESMExports();
const {acquireServiceLock}=await import(${JSON.stringify(moduleUrl)});
try { await acquireServiceLock(directory); }
catch (error) { process.stdout.write(error===failure?'original error':error.message); }
`);
      const result = await writer.done;
      const expected = mode === 'before-cutover' ? 'Shared service lock changed before owner publication' : 'original error';
      check(`publication refusal for ${mode} names its cause`, result.code === 0 && result.output === expected, result.output);
      const preparation = JSON.parse(readFileSync(marker('preparation'), 'utf8'));
      check(`owner preparation for ${mode} stays private and its staging is released`,
        !preparation.public && !existsSync(preparation.file) && !existsSync(`${directory}.gate`));
      if (mode === 'write-error' || mode === 'rename-error') {
        let retry;
        try { retry = await acquireServiceLock(directory); } catch {}
        check(`a normal retry after ${mode} takes the service lock`, typeof retry === 'function');
        retry?.();
      } else {
        check(`publication preserves the ${mode} directory`, existsSync(directory) && !existsSync(ownerFile)
          && String(statSync(directory).ino) === readFileSync(marker('replacement-inode'), 'utf8')
          && (mode !== 'nonempty' || readFileSync(path.join(directory, 'foreign'), 'utf8') === 'keep'));
      }
      rmSync(directory, { recursive: true, force: true });
    }

    let completed = 0;
    for (let turn = 0; turn < 16; turn += 1) {
      const ownRelease = await acquireServiceLock(directory);
      const pending = acquireServiceLock(directory);
      ownRelease();
      const nextRelease = await pending;
      nextRelease?.();
      completed += 1;
    }
    check('same-process acquisition and synchronous release finish without gate self-refusal', completed === 16 && !existsSync(directory));

    const oldRelease = await acquireServiceLock(directory);
    const original = readPrivate(ownerFile);
    const replacement = { ...requireProcess(), nonce: 'replacement-generation' };
    renameSync(directory, `${directory}.replaced`);
    mkdirSync(directory, { mode: 0o700 });
    writePrivate(ownerFile, replacement);
    oldRelease();
    check('an old release preserves replacement nonce and owner proof',
      JSON.stringify(readPrivate(ownerFile)) === JSON.stringify(replacement));
    rmSync(directory, { recursive: true });
    renameSync(`${directory}.replaced`, directory);
    check('the retired original generation retains its owner proof', JSON.stringify(readPrivate(ownerFile)) === JSON.stringify(original));
    oldRelease();

    mkdirSync(directory, { mode: 0o700 });
    const unknownProof = { ...requireProcess(), nonce: 'unknown-observation' };
    writePrivate(ownerFile, unknownProof);
    const unknown = actor(`
import cp from 'node:child_process';
const run=cp.spawnSync, read=fs.readFileSync;
const pid=${JSON.stringify(unknownProof.pid)};
cp.spawnSync=(command,args,...rest)=>command==='/bin/ps'&&JSON.stringify(args)===JSON.stringify(['-p',String(pid),'-o','stat=','-o','lstart='])?{status:1,stdout:''}:run(command,args,...rest);
fs.readFileSync=(file,...args)=>{if(file==='/proc/'+pid+'/stat')throw Error('fixture observation unavailable');return read(file,...args)};
syncBuiltinESMExports();
const {acquireServiceLock,processState}=await import(${JSON.stringify(moduleUrl)});
const state=processState(${JSON.stringify(unknownProof)}), release=await acquireServiceLock(directory);
fs.writeFileSync(marker('unknown'),JSON.stringify({state,busy:release===null}));
release?.();
`);
    const unknownResult = await unknown.done;
    const observation = JSON.parse(readFileSync(marker('unknown'), 'utf8'));
    check('an unavailable birth observation retains a live process lock and exact proof',
      unknownResult.code === 0 && observation.state === 'unknown' && observation.busy
      && JSON.stringify(readPrivate(ownerFile)) === JSON.stringify(unknownProof), JSON.stringify({ unknownResult, observation }));
    rmSync(directory, { recursive: true });

    mkdirSync(directory, { mode: 0o700 });
    let missing = '';
    try { await acquireServiceLock(directory); } catch (error) { missing = error.message; }
    check('a truly missing owner refuses and retains the unowned lock',
      missing === 'Shared service lock has no valid owner; inspect it before retrying' && existsSync(directory), missing);
    writeFileSync(ownerFile, '{invalid', { mode: 0o600 });
    let corrupt = '';
    try { await acquireServiceLock(directory); } catch (error) { corrupt = error.message; }
    check('a corrupt owner refuses without changing its proof',
      corrupt === `Shared service private record is invalid: ${ownerFile}` && readFileSync(ownerFile, 'utf8') === '{invalid', corrupt);
    rmSync(directory, { recursive: true });
  } finally {
    for (const child of actors) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(actors.map(child => child.exitCode !== null || child.signalCode !== null ? null
      : new Promise(resolve => child.once('close', resolve))));
  }
}
