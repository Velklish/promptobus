import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox, stubCommand } from './sandbox.mjs';
import { readCompleteJson, waitFor } from './harness.mjs';
import { processTable } from '../scripts/live-run.mjs';
import { CANARY_PREFIX, MIN_AGE_MS, RUN_OWNER_FILE, runOwnerIsLive } from '../scripts/canary-runs.mjs';

const root = makeSandbox('promptobus-test-canary-abort-fixture-'), scripts = path.join(root, 'scripts'), bins = path.join(root, 'bin');
const runs = makeSandbox('promptobus-test-canary-abort-runs-');
mkdirSync(scripts);
// Each simulated run owns at most the socket directory its provider names in its receipt.
const socketView = path.join(root, 'fixture-socket-view.mjs');
writeFileSync(socketView, `
  import fs from 'node:fs';
  import path from 'node:path';
  import { syncBuiltinESMExports } from 'node:module';
  const list = fs.readdirSync;
  fs.readdirSync = function(dir, ...args) {
    const entries = list.call(this, dir, ...args);
    if (dir !== '/tmp') return entries;
    const receipt = process.env.receipt;
    if (!fs.existsSync(receipt)) return [];
    const { socket } = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    return socket ? entries.filter(name => name === path.basename(path.dirname(socket))) : [];
  };
  syncBuiltinESMExports();
`);
const wrapperArgv = ['--import', socketView, path.join(scripts, 'live-canary.mjs')];
symlinkSync(path.resolve('lib'), path.join(root, 'lib'));
mkdirSync(path.join(root, 'test'));
for (const file of ['sandbox.mjs', 'hygiene.mjs', 'harness.mjs']) {
  symlinkSync(path.resolve('test', file), path.join(root, 'test', file));
}
for (const file of ['live-canary.mjs', 'live-entry.mjs', 'live-abort.mjs', 'live-run.mjs', 'live-home.mjs', 'canary-runs.mjs']) {
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
  if (mode === 'bad-final') writeFileSync(process.env.market, '{');
  if (mode === 'changed-home') writeFileSync(process.env.market, '{"new-market": {}}');
  console.log('1/1 verdicts passed');
  if (mode === 'malformed-receipt') console.log('▸ cleanup: {"safe":true,');
  else console.log('▸ cleanup: '+JSON.stringify({safe:mode!=='unsafe',failures:mode==='unsafe'?['owned processes remain']:[],scenario:{completed:true,passed:1,total:1}}));
  if(mode==='unsafe') process.exitCode=1;
`);
stubCommand(bins, 'claude', `
  import {readFileSync,writeFileSync} from 'node:fs';
  if (process.argv.slice(2).join(' ') !== 'agents --json') process.exit(2);
  const raw=readFileSync(${JSON.stringify(path.join(root,'registry-response'))},'utf8');
  writeFileSync(${JSON.stringify(path.join(root,'registry-read'))},raw);
  process.stdout.write(raw);
`);
stubCommand(bins, 'npm', `
  import {mkdirSync,writeFileSync,copyFileSync,symlinkSync} from 'node:fs';
  if(process.argv[2]==='pack') writeFileSync(process.argv.at(-1)+'/fake.tgz','fixture');
  else if(process.argv[2]==='install') {
    const pkg='node_modules/promptobus';
    mkdirSync(pkg+'/bin',{recursive:true});
    symlinkSync(${JSON.stringify(path.resolve('lib'))},pkg+'/lib','dir');
    writeFileSync(pkg+'/bin/promptobus.js','console.log("fixture version"); if(process.env.mode==="version-error") process.exitCode=1;');
    copyFileSync(${JSON.stringify(path.join(root, 'loop.mjs'))},pkg+'/loop.mjs');
  } else process.exitCode=1;
`);
const foreign = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
try {
  const stands = {}, held = [];
  for (const mode of ['normal', 'unsafe', 'unknown-registry', 'parent', 'group', 'pending', 'sweep', 'version-error', 'empty-registry', 'malformed-receipt']) {
    const receipt = path.join(runs, mode+'.json');
    const raw = JSON.stringify(mode === 'unknown-registry' ? {} : mode === 'empty-registry' ? [] : mode === 'sweep' ? {sessions:[]}
      : {agents:[{sessionId:'foreign-control',pid:foreign.pid,cwd:'/foreign-fixture'}]});
    writeFileSync(path.join(root,'registry-response'),raw);
    writeFileSync(path.join(root,'registry-read'),'not called');
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
    const parent = spawn(process.execPath, wrapperArgv, { detached: true,
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
      if (mode === 'empty-registry') {
        check('canary registry: actual agents --json returned [] and confirmed cleanup completed',
          readFileSync(path.join(root,'registry-read'),'utf8') === '[]' && parent.exitCode === 0 && !existsSync(child.tree)
          && output.includes('sessions in the harness registry after the run: 0') && readCompleteJson(path.join(stand,RUN_OWNER_FILE))?.canaryReport === 'complete', output);
        continue;
      }
      if (mode === 'malformed-receipt') {
        const log = readFileSync(path.join(stand, 'live-e2e.out'), 'utf8').trimEnd();
        const report = readFileSync(path.join(stand, 'live-canary.md'), 'utf8');
        check('canary: malformed terminal receipt refuses functional success and retains the stand',
          log.endsWith('1/1 verdicts passed\n▸ cleanup: {"safe":true,') && parent.exitCode === 1 && !parent.signalCode
          && report.includes('canary — RED') && !report.includes('✔ canary: the live orchestration loop passed in full')
          && existsSync(child.tree) && existsSync(path.join(stand, 'pack'))
          && readCompleteJson(path.join(stand, RUN_OWNER_FILE))?.cleanup?.state === 'unresolved', output);
        continue;
      }
      if (mode === 'version-error') {
        check('canary version failure: report stays red although owned cleanup was confirmed',
          parent.exitCode === 1 && !existsSync(child.tree) && readCompleteJson(path.join(stand,RUN_OWNER_FILE))?.canaryReport === 'complete'
          && readFileSync(path.join(stand,'live-canary.md'),'utf8').includes('canary — RED'), output);
        continue;
      }
      if (mode === 'unsafe' || mode === 'unknown-registry') {
        if (mode === 'unsafe') check('canary: a surviving owned process keeps cleanup unconfirmed after a successful scenario',
          output.includes('✔ canary: the live orchestration loop passed in full')
          && output.includes('✖ cleanup: the child confirmed its process tree and sessions are gone — owned processes remain'), output);
        if (mode === 'unknown-registry') check('canary registry: actual agents --json returned {} and its envelope was rejected',
          readFileSync(path.join(root,'registry-read'),'utf8') === '{}' && output.includes('malformed session registry'), output);
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
  for (const mode of ['bad-baseline', 'bad-final', 'changed-home', 'clean-home']) {
    const home = path.join(root, mode), plugins = path.join(home, '.claude', 'plugins');
    mkdirSync(plugins, { recursive: true });
    const market = path.join(plugins, 'known_marketplaces.json'), receipt = path.join(runs, mode + '.json');
    writeFileSync(market, mode === 'bad-baseline' ? '{' : '{}');
    const wrapper = spawn(process.execPath, wrapperArgv, {
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bins}:${process.env.PATH}`, TMPDIR: runs, receipt, mode, market },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [wrapper.stdout, wrapper.stderr]) stream.on('data', chunk => { output += chunk; });
    const code = await new Promise(resolve => wrapper.once('close', resolve));
    const reason = mode === 'changed-home' ? 'new-market' : mode === 'clean-home' ? '✔ the person home' : market;
    check(`canary home: ${mode} reaches the report and exit status`, code === (mode === 'clean-home' ? 0 : 1)
      && output.includes(reason) && existsSync(receipt) === (mode !== 'bad-baseline'), output);
  }
  // Exercise both production entrypoints. Only the paid Claude scenario is replaced.
  for (const file of ['live-args.mjs', 'live-e2e.mjs']) copyFileSync(path.resolve('scripts', file), path.join(scripts, file));
  writeFileSync(path.join(root, 'test', 'scenario.mjs'), `
    import { spawn } from 'node:child_process';
    import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
    import { LIVE_RECORD } from '../scripts/live-run.mjs';
    import { once } from 'node:events';
    export const MECHANISM_ROOT = process.env.PROMPTOBUS_E2E_ROOT, STEPS = ['fake provider turn'];
    export async function runScenario({ check, harness, sandbox }) {
      const provider = spawn(process.execPath, ['-e', "process.stdin.resume(); console.log('ready')"], { stdio: ['pipe', 'pipe', 'ignore'] });
      const closed = once(provider, 'close');
      try {
        await once(provider.stdout, 'data');
        harness.child(provider);
        check('fake provider completed the turn', true);
      } finally { provider.stdin.end(); await closed; }
      writeFileSync(process.env.receipt, JSON.stringify({ sandbox, socket: harness.sock('fixture') }));
      if (process.env.mode === 'cleanup-io') {
        const record = sandbox + '/' + LIVE_RECORD;
        unlinkSync(record);
        mkdirSync(record);
      }
      try {
        if (process.env.mode === 'partial') throw Error('interrupted after first check');
      } finally { await harness.cleanup(); }
      return { timings: [], totalMs: 1, mechanism: {reported: MECHANISM_ROOT+'/bin/promptobus.js'} };
    }
  `);
  for (const mode of ['completed', 'partial', 'cleanup-io']) {
    const receipt = path.join(runs, mode + '.json');
    const wrapper = spawn(process.execPath, wrapperArgv, {
      env: { ...process.env, PATH: `${bins}:${process.env.PATH}`, TMPDIR: runs, receipt, mode },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [wrapper.stdout, wrapper.stderr]) stream.on('data', chunk => { output += chunk; });
    const code = await new Promise(resolve => wrapper.once('close', resolve));
    const owned = readCompleteJson(receipt);
    const reportPath = /^▸ report: (.+)$/m.exec(output)?.[1];
    const report = reportPath && readFileSync(reportPath, 'utf8');
    const stamp = mode === 'partial' ? '✖' : '✔';
    check(`canary ${mode}: report the actual functional outcome and retain unconfirmed cleanup`,
      code === 1 && report?.includes(`${stamp} canary: the live orchestration loop passed in full`)
      && report.includes('✖ cleanup: the child confirmed its process tree and sessions are gone')
      && report.includes(mode === 'cleanup-io' ? 'EISDIR' : 'process ancestry became unobservable')
      && owned && existsSync(owned.sandbox)
      && existsSync(path.join(path.dirname(reportPath), 'ws')), output);
    // The fake provider exited through its stdin and started no descendants.
    if (owned?.socket) rmSync(path.dirname(owned.socket), { recursive: true, force: true });
  }
} finally { foreign.kill(); }
