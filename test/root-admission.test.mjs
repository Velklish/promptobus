import { check, skip } from './check.mjs';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { createRootAdmission } from '../lib/root-admission.js';
import { contained, readPrivate, requireProcess, runtimeIdentity, servicePaths } from '../lib/service-state.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

if (!['darwin', 'linux'].includes(process.platform)) {
  skip('root admission across process locks', 'This platform has no implemented process-birth observer');
} else {
  const base = realpathSync(makeSandbox('promptobus-root-admission-'));
  const root = path.join(base, 'workspace'), nativeStore = path.join(base, 'native-store');
  mkdirSync(root); mkdirSync(nativeStore);
  writeHostConfig(root, { tools: [] });
  const host = createStandaloneHost({ cwd: root });
  const env = { ...process.env, PROMPTOBUS_SERVICE_HOME: path.join(base, 'private') };
  const owner = createRootAdmission(host, { env });
  const paths = servicePaths(host, env);
  const directory = path.join(paths.directory, 'root-admission');
  const stateFile = path.join(directory, 'state.json');
  const generation = { nativeThreadId: 'native-root-one', appServer: requireProcess(), nonce: 'generation-one' };
  const request = { profileId: 'ordinary', nativeStore, generation };
  const eligible = bbThreadId => ({ complete: true, eligibility: 'eligible', bbThreadId });
  let lookups = 0, realizations = 0;
  const lookup = async () => { lookups += 1; return eligible('thr_root_one'); };
  const realize = async proof => { realizations += 1; return proof.bbThreadId; };
  async function refusal(fn) {
    try { await fn(); return ''; } catch (error) { return error.message; }
  }
  const fresh = name => {
    const isolatedEnv = { ...env, PROMPTOBUS_SERVICE_HOME: path.join(base, name) };
    return { owner: createRootAdmission(host, { env: isolatedEnv }), env: isolatedEnv,
      state: path.join(servicePaths(host, isolatedEnv).directory, 'root-admission', 'state.json') };
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(predicate) {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Root admission fixture timed out');
      await wait(20);
    }
  }
  const actors = [];
  const childPrelude = `import {existsSync,writeFileSync} from 'node:fs';
import {createStandaloneHost} from ${JSON.stringify(pathToFileURL(path.resolve('dist/host-index.js')).href)};
import {createRootAdmission} from ${JSON.stringify(pathToFileURL(path.resolve('lib/root-admission.js')).href)};
const owner=createRootAdmission(createStandaloneHost({cwd:${JSON.stringify(root)}}),{env:${JSON.stringify(env)}});
const wait=async predicate=>{const end=Date.now()+10000;while(!predicate()){if(Date.now()>end)throw Error('child timeout');await new Promise(resolve=>setTimeout(resolve,20))}};
`;
  function actor(source, prefix = childPrelude) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', prefix + source], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const done = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, output })));
    actors.push(child);
    return { child, done };
  }
  try {
    check('a private native store without explicit approval refuses before lookup or realization',
      !!await refusal(() => owner.realizeRoot(request, lookup, realize)) && lookups === 0 && realizations === 0);
    await owner.approveProfile({ id: 'ordinary', nativeStore });
    const approvedBytes = readFileSync(stateFile, 'utf8');
    await owner.approveProfile({ id: 'ordinary', nativeStore });
    check('an explicit profile ID is idempotent for its exact canonical scope', readFileSync(stateFile, 'utf8') === approvedBytes);
    const storeAlias = path.join(base, 'native-alias'); symlinkSync(nativeStore, storeAlias);
    await owner.approveProfile({ id: 'ordinary', nativeStore: storeAlias });
    check('account store aliases resolve to the same approved canonical profile', readFileSync(stateFile, 'utf8') === approvedBytes);
    const otherRuntime = createRootAdmission({ ...host, version: `${host.version}-other` }, { env });
    check('another runtime cannot reuse the approved profile or reach either root callback',
      !!await refusal(() => otherRuntime.realizeRoot(request, lookup, realize)) && lookups === 0 && realizations === 0
      && !!await refusal(() => otherRuntime.approveProfile({ id: 'ordinary', nativeStore })));
    const alternateStore = path.join(base, 'alternate-store'); mkdirSync(alternateStore);
    check('reusing an approved ID with another account store refuses',
      !!await refusal(() => owner.approveProfile({ id: 'ordinary', nativeStore: alternateStore })));
    for (const [label, changed] of [['path-shaped profile ID', { profileId: '../ordinary' }], ['another native account store', { nativeStore: alternateStore }],
      ['malformed native generation', { generation: { ...generation, nonce: '' } }]]) {
      const before = [lookups, realizations];
      const denied = await refusal(() => owner.realizeRoot({ ...request, ...changed }, lookup, realize));
      check(`${label} refuses without callbacks`,
        !!denied && before[0] === lookups && before[1] === realizations, denied);
    }
    check('profile and exclusion records stay under the service private tree with private modes',
      contained(paths.base, directory) && !contained(root, directory)
      && (statSync(directory).mode & 0o077) === 0 && (statSync(stateFile).mode & 0o077) === 0);
    check('the approved profile records canonical workspace store runtime and native account store',
      readPrivate(stateFile).root === paths.root && readPrivate(stateFile).home === paths.home
      && readPrivate(stateFile).profiles[0].runtime === runtimeIdentity(host)
      && readPrivate(stateFile).profiles[0].nativeStore === nativeStore);
    for (const result of [null, {}, { complete: false, eligibility: 'eligible', bbThreadId: 'thr_root_one' },
      { complete: true, eligibility: 'managed', bbThreadId: 'thr_root_one' },
      { complete: true, eligibility: 'ambiguous', bbThreadId: 'thr_root_one' },
      eligible(' thr_root_one'), { ...eligible('thr_root_one'), bbThreadId: ['thr_root_one', 'thr_root_two'] }]) {
      const before = realizations;
      check(`incomplete or ineligible authoritative lookup ${JSON.stringify(result)} refuses realization`,
        !!await refusal(() => owner.realizeRoot(request, async () => result, realize)) && realizations === before);
    }
    check('unavailable authoritative lookup refuses realization',
      !!await refusal(() => owner.realizeRoot(request, async () => { throw new Error('authoritative lookup unavailable'); }, realize))
      && realizations === 0);
    check('an approved complete eligible correspondence runs owner realization',
      await owner.realizeRoot(request, lookup, realize) === 'thr_root_one' && realizations === 1);
    await owner.realizeRoot(request, lookup, realize);
    check('the same admitted native generation is idempotent', readPrivate(stateFile).roots.length === 1 && realizations === 2);
    check('an admitted native generation cannot change its BB correspondence',
      !!await refusal(() => owner.realizeRoot(request, async () => eligible('thr_other'), realize)) && realizations === 2);

    const queryEntered = path.join(base, 'query-entered'), releaseQuery = path.join(base, 'release-query');
    const realizeEntered = path.join(base, 'realize-entered'), releaseRealize = path.join(base, 'release-realize');
    const managedStarted = path.join(base, 'managed-started'), managedPublished = path.join(base, 'managed-published');
    const rootActor = actor(`await owner.realizeRoot(${JSON.stringify({ ...request, generation: { ...generation, nonce: 'concurrent-root' } })},async()=>{
writeFileSync(${JSON.stringify(queryEntered)},'entered');await wait(()=>existsSync(${JSON.stringify(releaseQuery)}));
return {complete:true,eligibility:'eligible',bbThreadId:'thr_concurrent_root'}},async()=>{
writeFileSync(${JSON.stringify(realizeEntered)},'entered');await wait(()=>existsSync(${JSON.stringify(releaseRealize)}));});`);
    await until(() => existsSync(queryEntered));
    const managedActor = actor(`writeFileSync(${JSON.stringify(managedStarted)},'started');
await owner.beginManagedLaunch('concurrent-launch');writeFileSync(${JSON.stringify(managedPublished)},'published');`);
    await until(() => existsSync(managedStarted));
    await wait(100);
    check('a concurrent managed begin waits while the negative lookup holds the canonical lock',
      !existsSync(managedPublished) && readPrivate(stateFile).managed.length === 0);
    writeFileSync(releaseQuery, 'continue');
    await until(() => existsSync(realizeEntered));
    check('managed publication cannot occur between the negative lookup and root realization commit',
      !existsSync(managedPublished) && readPrivate(stateFile).managed.length === 0
      && readPrivate(stateFile).roots.some(value => value.bbThreadId === 'thr_concurrent_root'));
    writeFileSync(releaseRealize, 'continue');
    const rootResult = await rootActor.done, managedResult = await managedActor.done;
    check('both real processes complete after root commit releases the lock',
      rootResult.code === 0 && managedResult.code === 0 && existsSync(managedPublished), JSON.stringify({ rootResult, managedResult }));
    const beforeIntent = realizations;
    check('a persisted intent denies root realization before a BB thread exists',
      !!await refusal(() => owner.realizeRoot(request, lookup, realize)) && realizations === beforeIntent);
    check('duplicate managed begin refuses instead of authorizing another provider spawn',
      !!await refusal(() => owner.beginManagedLaunch('concurrent-launch')));
    await owner.completeManagedLaunch('concurrent-launch', 'thr_managed');
    const completeBytes = readFileSync(stateFile, 'utf8');
    await owner.completeManagedLaunch('concurrent-launch', 'thr_managed');
    check('managed completion is idempotent for one exact intent and BB thread', readFileSync(stateFile, 'utf8') === completeBytes);
    for (const phase of ['preparation', 'starting', 'ready', 'orphan', 'archived']) {
      const excluded = fresh(`excluded-${phase}`);
      await excluded.owner.approveProfile({ id: 'ordinary', nativeStore });
      await excluded.owner.beginManagedLaunch('managed-phase');
      await excluded.owner.completeManagedLaunch('managed-phase', 'thr_managed');
      check(`permanent exclusion ignores claimed ${phase} phase in a later native generation`,
        !!await refusal(() => excluded.owner.realizeRoot({ ...request, generation: { ...generation, nonce: `later-${phase}` } },
          async () => ({ ...eligible('thr_managed'), phase }), realize)) && realizations === beforeIntent);
    }
    check('a completed intent cannot be rebound to another BB thread',
      !!await refusal(() => owner.completeManagedLaunch('concurrent-launch', 'thr_replacement')));
    await owner.beginManagedLaunch('root-adoption');
    check('managed completion refuses adoption of an already admitted root and retains its intent',
      !!await refusal(() => owner.completeManagedLaunch('root-adoption', 'thr_root_one'))
      && readPrivate(stateFile).managed.some(value => value.id === 'root-adoption' && value.bbThreadId === null));

    const crashed = fresh('crashed');
    await crashed.owner.approveProfile({ id: 'ordinary', nativeStore });
    const crashActor = actor(`await owner.beginManagedLaunch('crash-launch');process.exit(23);`, childPrelude.replace(JSON.stringify(env), JSON.stringify(crashed.env)));
    const crashResult = await crashActor.done;
    check('a process crash after intent persistence retains a global exclusion', crashResult.code === 23
      && !!await refusal(() => crashed.owner.realizeRoot(request, lookup, realize))
      && readPrivate(crashed.state).managed[0].bbThreadId === null);
    const otherProfile = { ...request, profileId: 'second', nativeStore: alternateStore };
    await crashed.owner.approveProfile({ id: 'second', nativeStore: alternateStore });
    check('an orphan intent blocks another approved account profile in the same workspace and store',
      !!await refusal(() => crashed.owner.realizeRoot(otherProfile, lookup, realize)));
    await crashed.owner.completeManagedLaunch('crash-launch', 'thr_crashed_managed');
    check('owned recovery can finish an exact intent while retaining its permanent deny',
      await crashed.owner.realizeRoot(request, lookup, realize) === 'thr_root_one'
      && !!await refusal(() => crashed.owner.realizeRoot({ ...request, generation: { ...generation, nonce: 'recovered-managed' } },
        async () => eligible('thr_crashed_managed'), realize)));

    const uncertain = fresh('uncertain-root');
    await uncertain.owner.approveProfile({ id: 'ordinary', nativeStore });
    check('a failed owner realization retains the root classification for an ambiguous callback outcome',
      !!await refusal(() => uncertain.owner.realizeRoot(request, lookup, async () => { throw new Error('realization result unavailable'); }))
      && readPrivate(uncertain.state).roots[0].bbThreadId === 'thr_root_one');
    await uncertain.owner.beginManagedLaunch('uncertain-adoption');
    check('an ambiguous root realization cannot later be adopted as managed',
      !!await refusal(() => uncertain.owner.completeManagedLaunch('uncertain-adoption', 'thr_root_one'))
      && readPrivate(uncertain.state).managed[0].bbThreadId === null);

    const corrupt = fresh('corrupt');
    await corrupt.owner.approveProfile({ id: 'ordinary', nativeStore });
    const valid = readFileSync(corrupt.state, 'utf8');
    for (const [label, value] of [['malformed JSON', '{'], ['foreign canonical scope', JSON.stringify({ ...JSON.parse(valid), root: alternateStore })],
      ['malformed managed exclusion', JSON.stringify({ ...JSON.parse(valid), managed: [{ id: 'broken', bbThreadId: [] }] })]]) {
      writeFileSync(corrupt.state, value, { mode: 0o600 });
      const before = [lookups, realizations];
      check(`${label} in private state refuses both root callbacks`,
        !!await refusal(() => corrupt.owner.realizeRoot(request, lookup, realize))
        && before[0] === lookups && before[1] === realizations);
    }
    writeFileSync(corrupt.state, valid);
    chmodSync(corrupt.state, 0o644);
    check('nonprivate admission state refuses without a root callback',
      !!await refusal(() => corrupt.owner.realizeRoot(request, lookup, realize)));
    chmodSync(corrupt.state, 0o600);
    rmSync(corrupt.state);
    check('missing initialized admission state refuses instead of recreating empty eligibility',
      !!await refusal(() => corrupt.owner.approveProfile({ id: 'ordinary', nativeStore })));
    symlinkSync(stateFile, corrupt.state);
    check('a symlinked admission record refuses private-state access',
      !!await refusal(() => corrupt.owner.realizeRoot(request, lookup, realize)));
  } finally {
    for (const child of actors) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(actors.filter(child => child.exitCode === null && child.signalCode === null)
      .map(child => new Promise(resolve => child.once('close', resolve))));
  }
}
