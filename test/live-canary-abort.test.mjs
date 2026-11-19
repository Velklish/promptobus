import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox, stubCommand } from './sandbox.mjs';
import { readCompleteJson, waitFor } from './harness.mjs';
import { processTable } from '../scripts/live-run.mjs';
import { CANARY_PREFIX, MIN_AGE_MS, RUN_OWNER_FILE, runOwnerIsLive } from '../scripts/canary-runs.mjs';

const root = makeSandbox('canary-abort-fixture-'), scripts = path.join(root, 'scripts'), bins = path.join(root, 'bin');
const runs = makeSandbox('canary-abort-runs-');
mkdirSync(scripts);
for (const dir of ['test', 'lib']) symlinkSync(path.resolve(dir), path.join(root, dir));
for (const file of ['live-canary.mjs', 'live-entry.mjs', 'live-abort.mjs', 'canary-runs.mjs']) {
  copyFileSync(path.resolve('scripts', file), path.join(scripts, file));
}
writeFileSync(path.join(scripts, 'live-e2e.mjs'), `await import(process.env.PROMPTOBUS_E2E_ROOT+'/loop.mjs');`);
writeFileSync(path.join(root, 'loop.mjs'), `
  import {writeFileSync, appendFileSync, existsSync} from 'node:fs';
  const {receipt, mode} = process.env;
  console.log('mechanism as the process said: '+process.env.PROMPTOBUS_E2E_ROOT+'/bin/promptobus.js');
  if (['parent','group','pending'].includes(mode)) {
    const insurance = setTimeout(()=>process.exit(19), 25000);
    process.on('SIGTERM', () => {
      appendFileSync(receipt+'.signals', 'SIGTERM\\n');
      if(mode!=='pending') {
        const held=setInterval(()=>{if(!existsSync(receipt+'.release')) return;
          writeFileSync(receipt+'.ended','done');clearInterval(held);clearTimeout(insurance);},20);
      }
    });
  }
  writeFileSync(receipt,JSON.stringify({pid:process.pid,parent:process.ppid,tree:process.env.PROMPTOBUS_E2E_ROOT}));
  console.log('1/1 verdicts passed');
  console.log('▸ cleanup: '+JSON.stringify({safe:mode!=='unsafe'}));
  if(mode==='unsafe') process.exitCode=1;
`);
stubCommand(bins, 'npm', `
  import {mkdirSync,writeFileSync,copyFileSync} from 'node:fs';
  if(process.argv[2]==='pack') writeFileSync(process.argv.at(-1)+'/fake.tgz','fixture');
  else if(process.argv[2]==='install') {
    const pkg='node_modules/promptobus';
    for(const sub of ['bin','lib'])mkdirSync(pkg+'/'+sub,{recursive:true});
    writeFileSync(pkg+'/bin/promptobus.js','console.log("fixture version"); if(process.env.mode==="version-error") process.exitCode=1;');
    writeFileSync(pkg+'/lib/liftoff.js','export const bgSessions=()=>process.env.mode==="unknown-registry"?null:[{cwd:"/foreign-fixture"}];');
    copyFileSync(${JSON.stringify(path.join(root, 'loop.mjs'))},pkg+'/loop.mjs');
  } else process.exitCode=1;
`);
const foreign = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
try {
  const stands = {}, held = [];
  for (const mode of ['normal', 'unsafe', 'unknown-registry', 'parent', 'group', 'pending', 'sweep', 'version-error']) {
    const receipt = path.join(runs, mode+'.json');
    if (mode === 'sweep') {
      const complete = readCompleteJson(path.join(stands.normal, RUN_OWNER_FILE));
      for (const kind of ['unmarked', 'foreign-path', 'unfinished']) {
        const dir = path.join(runs, CANARY_PREFIX + kind);
        mkdirSync(dir);
        for (const file of ['live-canary.md', 'live-e2e.out']) copyFileSync(path.join(stands.normal, file), path.join(dir, file));
        if (kind !== 'unmarked') writeFileSync(path.join(dir, RUN_OWNER_FILE), JSON.stringify(kind === 'foreign-path' ? {...complete,path:runs} : {pid:complete.pid,path:dir}));
        held.push(dir);
      }
      held.push(...Object.values(stands).filter(dir => dir !== stands.normal));
      const old = new Date(Date.now() - MIN_AGE_MS - 60000);
      for (const dir of [stands.normal,...held]) utimesSync(dir, old, old);
      for (let i=0;i<3;i++) mkdirSync(path.join(runs, CANARY_PREFIX+'recent-'+i));
    }
    const parent = spawn(process.execPath, [path.join(scripts, 'live-canary.mjs')], { detached: true,
      env: { ...process.env, PATH: `${bins}:${process.env.PATH}`, TMPDIR: runs, receipt, mode, PROMPTOBUS_TASK: 'foreign-fixture' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', owned;
    for (const stream of [parent.stdout, parent.stderr]) stream.on('data', c => { output += c; });
    try {
      const child = await waitFor(() => readCompleteJson(receipt), { timeoutMs: 5000 });
      if (!child || child.parent !== parent.pid) throw Error(`no owned child receipt: ${output}`);
      const stand = path.resolve(child.tree, '../../..');
      stands[mode] = stand;
      if (['parent','group','pending'].includes(mode)) {
        const rows = processTable();
        owned = rows.find(row => row.pid === child.pid && row.parent === parent.pid);
        if (!owned || !rows.some(row => row.pid === parent.pid && row.group === parent.pid)
          || rows.some(row => row.group === parent.pid && ![parent.pid, child.pid].includes(row.pid))) throw Error('group ownership unknown');
        if (mode === 'group') process.kill(-parent.pid, 'SIGTERM'); else parent.kill('SIGTERM');
        if (mode !== 'pending') {
          const forwarded = await waitFor(() => existsSync(receipt+'.signals'), { timeoutMs: 3000 });
          check(`canary ${mode}: wrapper is still waiting while owned termination is held`,
            forwarded && processTable().some(row => row.pid === parent.pid && row.group === parent.pid));
          writeFileSync(receipt+'.release', 'allow the child to terminate');
        }
      }
      await waitFor(() => parent.exitCode !== null || parent.signalCode !== null, { timeoutMs: 18000 });
      if (mode === 'version-error') {
        check('canary version failure: report stays red although owned cleanup was confirmed',
          parent.exitCode === 1 && !existsSync(child.tree) && readCompleteJson(path.join(stand,RUN_OWNER_FILE))?.canaryReport === 'complete'
          && readFileSync(path.join(stand,'live-canary.md'),'utf8').includes('canary — RED'), output);
        continue;
      }
      if (mode === 'unsafe' || mode === 'unknown-registry') {
        check(`canary ${mode}: no-signal failure retains the workspace, pack, report and unresolved marker`,
          parent.exitCode === 1 && !parent.signalCode && existsSync(child.tree) && existsSync(path.join(stand,'pack'))
          && existsSync(path.join(stand,'live-canary.md')) && readCompleteJson(path.join(stand,RUN_OWNER_FILE))?.cleanup?.state === 'unresolved'
          && output.includes('cleanup unconfirmed; stand retained'), output);
        continue;
      }
      if (mode === 'sweep') {
        check('canary sweep past age and count thresholds removes only the completed owned report',
          parent.exitCode === 0 && !existsSync(stands.normal) && held.every(dir => existsSync(path.join(dir,'live-e2e.out')))
          && output.includes(`swept: 1 (${path.basename(stands.normal)})`), output);
        continue;
      }
      if (mode === 'normal') {
        check('canary normal: installed fake, clean environment, home and cleanup verdicts pass',
          parent.exitCode === 0 && /sessions in the harness registry after the run: 1/.test(output) && !existsSync(child.tree), output);
        continue;
      }
      const alive = processTable().some(row => row.pid === owned.pid && row.birth === owned.birth);
      const signals = existsSync(receipt+'.signals') && readFileSync(receipt+'.signals', 'utf8');
      console.log('canary receipt:', JSON.stringify({ mode, owned, exit: parent.exitCode, signals, alive, stand }));
      check(`canary ${mode}: one forwarded signal, bounded and truthful owned-child outcome`,
        parent.exitCode === 143 && signals === 'SIGTERM\n' && alive === (mode === 'pending')
        && existsSync(receipt+'.ended') === !alive && output.includes(alive ? 'termination UNKNOWN' : 'terminated;')
        && existsSync(child.tree) && runOwnerIsLive(stand) && foreign.exitCode === null && foreign.signalCode === null, output);
    } finally {
      parent.kill('SIGKILL');
      if (owned && processTable().some(row => row.pid === owned.pid && row.birth === owned.birth)) {
        process.kill(owned.pid, 'SIGKILL');
        if (!await waitFor(() => !processTable().some(row => row.pid === owned.pid && row.birth === owned.birth),
          { timeoutMs: 2000 })) throw Error('owned canary child death unconfirmed');
      }
    }
  }
} finally { foreign.kill(); }
