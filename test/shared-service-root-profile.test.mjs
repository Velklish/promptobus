import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { check, skip } from './check.mjs';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { registerServiceClient, revokeServiceClient, serviceControl } from '../lib/service-client.js';
import { approveCodexRootProfile, authorizeCodexRootStart, codexRootExecPlan, codexRootHeaders } from '../lib/root-launch.js';
import { createRootAdmission } from '../lib/root-admission.js';
import { createOwnerEnvironment } from '../lib/service-launch.js';
import { actorIdentityVariables } from '../lib/drivers.js';
import { planHookInstall } from '../lib/integration.js';
import { acquireServiceLock, processStateAsync, requireProcess, readDiscovery, readPrivate, runtimeIdentity, servicePaths, writePrivate } from '../lib/service-state.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

if (!['darwin', 'linux'].includes(process.platform)) {
  skip('BB native root profile', 'This platform has no implemented process-birth observer');
} else {
  const root = realpathSync(makeSandbox('promptobus-root-profile-'));
  const serviceHome = mkdtempSync(path.join(realpathSync('/tmp'), 'pb-root-profile-'));
  const home = path.join(root, '.promptobus'), nativeStore = path.join(root, 'native-store'), nativeOther = path.join(root, 'native-other');
  for (const directory of [nativeStore, nativeOther]) mkdirSync(directory, { recursive: true });
  const bb = path.join(root, 'bb');
  writeFileSync(bb, '#!/bin/sh\nexit 93\n', { mode: 0o700 });
  check('generated BB launcher shell syntax is valid before use', spawnSync('/bin/sh', ['-n', bb]).status === 0);
  const binPath = fileURLToPath(new URL('../bin/promptobus.js', import.meta.url));
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const env = { ...process.env, BB_CLI: bb, PROMPTOBUS_HOME: home,
    PROMPTOBUS_SERVICE_HOME: serviceHome, PROMPTOBUS_SERVICE_IDLE_MS: '60000', PROMPTOBUS_WARDEN: 'off' };
  for (const key of Object.keys(env)) if (/^PROMPTOBUS_(CLIENT_|OWNER_ENV_FILE$|ROLE$|TASK$|.*_SESSION$)/.test(key)) delete env[key];
  writeHostConfig(root, { tools: [] });
  const host = createStandaloneHost({ cwd: root, binPath, version }), paths = servicePaths(host, env);
  const wrapper = fileURLToPath(new URL('../bin/promptobus-root', import.meta.url));
  const launcher = path.join(root, 'launcher-link');
  symlinkSync(wrapper, launcher);
  const run = (args, extra = {}) => {
    const child = spawn('/bin/sh', [launcher, ...args], { cwd: root, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    return new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, out, err, pid: child.pid })));
  };
  let failure;
  let stopped = false;
  const owner = spawn(process.execPath, [binPath, 'service', 'run'], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let ownerError = '';
  owner.stderr.on('data', bytes => { ownerError += bytes; });
  owner.once('error', error => { failure = error; });
  const running = new Promise(resolve => owner.once('close', (code, signal) => resolve({ code, signal })));
  const refused = async (action, pattern) => { try { await action(); return false; } catch (error) { return !pattern || pattern.test(error.message); } };
  try {
    const deadline = Date.now() + 5000;
    while (readDiscovery(paths)?.process.pid !== owner.pid && !failure && owner.exitCode === null && owner.signalCode === null
      && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    if (failure) throw failure;
    const initialOwner = readDiscovery(paths);
    if (initialOwner?.process.pid !== owner.pid) throw new Error(`Root profile fixture service did not become ready: ${ownerError}`);
    const input = { id: 'bb-native', nativeStore };
    check('root profiles refuse unsafe IDs', await refused(() => approveCodexRootProfile(host, { ...input, id: '../escape' }, env)));
    check('root profiles require an absolute native account store', await refused(() => approveCodexRootProfile(host, { ...input, nativeStore: 'native-store' }, env)));
    for (const marker of [{ PROMPTOBUS_ROLE: 'worker:foreign' }, { PROMPTOBUS_CLAUDE_SESSION: '/owned/record' },
      { PROMPTOBUS_CLIENT_FILE: '/owned/client' }]) {
      check('managed launch evidence refuses root approval before snapshot creation', await refused(() => approveCodexRootProfile(host, input, { ...env, ...marker }))
        && !existsSync(path.join(paths.directory, 'root-profile-bb-native.json')));
    }
    const result = await approveCodexRootProfile(host, input, env), file = path.join(paths.directory, 'root-profile-bb-native.json');
    const profile = readPrivate(file), snapshot = readPrivate(profile.ownerEnvironment);
    check('approval records exact canonical root store runtime and native account', profile.root === paths.root && profile.home === paths.home
      && profile.runtime === runtimeIdentity(host) && profile.nativeStore === realpathSync(nativeStore) && path.isAbsolute(profile.bb));
    check('profile and full owner snapshot remain private', (statSync(file).mode & 0o777) === 0o600
      && (statSync(profile.ownerEnvironment).mode & 0o777) === 0o600 && snapshot.root === paths.root && snapshot.home === paths.home);
    check('returned HTTP and ordered hook configuration contain references and no credential', result.server.url === `${readDiscovery(paths).url}mcp/bus`
      && result.server.http_headers_helper.includes('headers') && result.server.http_headers_helper.includes('--profile')
      && result.server.http_headers_helper.includes('bb-native') && result.startHook.command.includes('--root-profile') && result.startHook.command.includes('--service-home')
      && result.execPlanCommand.includes('exec-plan') && result.execPlanCommand.includes('--profile')
      && readdirSync(paths.clients).length === 0 && !JSON.stringify(result).includes('Bearer'));
    const rootBeforePlanning = readdirSync(root, { recursive: true }).sort();
    const planned = planHookInstall(host, root, ['claude', 'codex'], { rootProfile: result });
    const codexHooks = JSON.parse(planned.writes.find(write => write.rel === path.join('.codex', 'hooks.json')).text).hooks;
    const claudeHooks = JSON.parse(planned.writes.find(write => write.rel === path.join('.claude', 'settings.json')).text).hooks;
    check('pure install planning uses one supplied ordered Codex start hook and keeps ordinary Stop',
      codexHooks.SessionStart.length === 1 && codexHooks.SessionStart[0].hooks.length === 1
      && codexHooks.SessionStart[0].hooks[0].command === result.startHook.command
      && !codexHooks.Stop[0].hooks[0].command.includes('--root-profile')
      && !claudeHooks.SessionStart[0].hooks[0].command.includes('--root-profile'));
    check('root hook planning leaves native MCP configuration to the consumer without writing files',
      !planned.writes.some(write => write.rel === path.join('.codex', 'config.toml'))
      && JSON.stringify(rootBeforePlanning) === JSON.stringify(readdirSync(root, { recursive: true }).sort()));
    check('a Codex root descriptor cannot select another root harness', await refused(() => planHookInstall(host, root, ['claude'], { rootProfile: result })));
    const before = readdirSync(paths.directory).filter(name => name.startsWith('owner-environment-'));
    await approveCodexRootProfile(host, input, env);
    check('reapproving the exact profile preserves its original owner snapshot', JSON.stringify(before)
      === JSON.stringify(readdirSync(paths.directory).filter(name => name.startsWith('owner-environment-')))
      && readPrivate(file).ownerEnvironment === profile.ownerEnvironment);
    check('an existing profile cannot switch account stores', await refused(() => approveCodexRootProfile(host, { ...input, nativeStore: nativeOther }, env)));
    check('headers cannot be requested outside a real native app-server ancestry', await refused(() => codexRootHeaders(host, input.id, env))
      && readdirSync(paths.clients).length === 0);
    await authorizeCodexRootStart(host, 'absent-profile', { hook_event_name: 'Stop' }, env);
    check('ordinary Stop does not open a root profile or native capability', readdirSync(paths.clients).length === 0);
    check('inherited native env cannot replace root SessionStart proof', await refused(() => authorizeCodexRootStart(host, input.id,
      { hook_event_name: 'SessionStart' }, { ...env, CODEX_THREAD_ID: 'inherited-native' })));
    for (const change of [{ root: `${root}-foreign` }, { home: `${home}-foreign` }, { runtime: 'foreign-runtime' }]) {
      writePrivate(file, { ...profile, ...change });
      check('root headers refuse a changed canonical profile scope before native ancestry lookup', await refused(() => codexRootHeaders(host, input.id, env), /not approved/));
    }
    writePrivate(file, profile);
    chmodSync(file, 0o644);
    check('public-readable root manifests refuse before credential allocation', await refused(() => codexRootHeaders(host, input.id, env))
      && readdirSync(paths.clients).length === 0);
    chmodSync(file, 0o600);
    for (const exists of [true, false]) {
      const id = exists ? 'first-await-existing' : 'first-await-new', firstFile = path.join(paths.directory, `root-profile-${id}.json`);
      if (exists) await approveCodexRootProfile(host, { id, nativeStore }, env);
      const release = await acquireServiceLock(path.join(paths.directory, 'root-admission.lock'));
      if (!release) throw new Error('First-await fixture did not own the admission lock');
      let calls = 0, settled = false, pending;
      try {
        pending = approveCodexRootProfile(host, { id, nativeStore, createRoot: async () => { calls += 1; return { id: 'thr_foreign_baseline' }; } }, env)
          .then(() => { settled = true; return null; }, error => { settled = true; return error; });
        await new Promise(resolve => setImmediate(resolve));
        check('profile approval actually waits on the held first admission lock', !settled && calls === 0);
        const replacement = { ...profile, id, ownerEnvironment: createOwnerEnvironment(host, { ...env, APPROVAL_FIXTURE: 'replacement' }) };
        writePrivate(firstFile, replacement);
        const changed = readFileSync(firstFile, 'utf8'), state = readFileSync(path.join(paths.directory, 'root-admission', 'state.json'), 'utf8');
        const snapshots = readdirSync(paths.directory).filter(name => name.startsWith('owner-environment-')).sort();
        release();
        const error = await pending;
        check(`${exists ? 'existing' : 'absent'} profile cannot adopt a foreign owner snapshot during its first approval await`,
          /owner or approved profile changed/.test(error?.message ?? '') && calls === 0
          && readFileSync(firstFile, 'utf8') === changed
          && readFileSync(path.join(paths.directory, 'root-admission', 'state.json'), 'utf8') === state
          && JSON.stringify(snapshots) === JSON.stringify(readdirSync(paths.directory).filter(name => name.startsWith('owner-environment-')).sort())
          && readdirSync(paths.clients).length === 0);
      } finally { release(); if (pending) await pending; }
    }
    const driftInput = { id: 'await-profile-drift', nativeStore };
    await approveCodexRootProfile(host, driftInput, env);
    const driftFile = path.join(paths.directory, 'root-profile-await-profile-drift.json');
    const request = http.request;
    let entered, calls = 0, resumed = false;
    const statusEntered = new Promise(resolve => { entered = resolve; });
    http.request = function (...args) {
      const call = request.apply(this, args), end = call.end;
      call.end = function (body, ...rest) {
        if (typeof body === 'string' && JSON.parse(body).operation === 'status') entered();
        return end.call(this, body, ...rest);
      };
      return call;
    };
    syncBuiltinESMExports();
    process.kill(owner.pid, 'SIGSTOP');
    try {
      const pending = approveCodexRootProfile(host, { ...driftInput, createRoot: async () => { calls += 1; return { id: 'thr_stale_approval' }; } }, env).then(() => null, error => error);
      let timer;
      const reached = await Promise.race([statusEntered.then(() => true), pending.then(() => false),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); })]);
      clearTimeout(timer);
      if (!reached) throw new Error('Profile drift fixture did not reach the controlled actual readiness await');
      writePrivate(driftFile, { ...readPrivate(driftFile), nativeStore: nativeOther });
      const changed = readFileSync(driftFile, 'utf8');
      process.kill(owner.pid, 'SIGCONT'); resumed = true;
      const error = await pending;
      check('profile drift during actual owner readiness await cannot become a new baseline for stale approval',
        /owner or approved profile changed/.test(error?.message ?? '') && calls === 0
        && readFileSync(driftFile, 'utf8') === changed && readdirSync(paths.clients).length === 0
        && !readPrivate(path.join(paths.directory, 'root-admission', 'state.json')).profiles.find(value => value.id === driftInput.id).creation);
    } finally {
      if (!resumed) process.kill(owner.pid, 'SIGCONT');
      http.request = request; syncBuiltinESMExports();
    }
    const native = path.join(root, 'native.mjs'), output = path.join(root, 'native-result.json');
    writeFileSync(native, `import{writeFileSync,readdirSync}from'node:fs';
writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,args:process.argv.slice(3),native:process.env.CLAUDE_CODE_SESSION_ID,
token:process.env.PROMPTOBUS_CLIENT_TOKEN,task:process.env.PROMPTOBUS_TASK,bb:process.env.BB_THREAD_ID,
owner:process.env.PROMPTOBUS_OWNER_ENV_FILE,plans:readdirSync(process.env.PROMPTOBUS_SERVICE_HOME,{recursive:true}).filter(name=>/exec-.*\\.sh$/.test(name))}));\n`);
    check('generated native handoff JavaScript syntax is valid before use', spawnSync(process.execPath, ['--check', native]).status === 0);
    const command = { file: process.execPath, args: [native, output, 'literal $(touch NEVER)', ''] };
    for (const marker of [{ PROMPTOBUS_ROLE: 'worker:foreign' }, { PROMPTOBUS_CLIENT_FILE: '/owned/client' }]) {
      check('managed evidence refuses ordinary root preflight before writing a plan',
        await refused(() => codexRootExecPlan(host, input.id, command, { env: { ...env, ...marker } })));
    }
    check('root preflight refuses a missing approved BB profile', await refused(() => codexRootExecPlan(host, 'missing', command, { env })));
    const staged = await codexRootExecPlan(host, input.id, command, { env });
    check('root preflight stages a private plan and grants no native capability',
      path.dirname(staged) === paths.directory && (statSync(staged).mode & 0o777) === 0o600 && readdirSync(paths.clients).length === 0);
    check('private plan consumption does not expose its pathname in transient helper argv',
      !readFileSync(staged, 'utf8').split('\n')[0].includes(staged) && !readFileSync(staged, 'utf8').includes('/bin/rm -f --'));
    check('generated one-shot plan shell syntax is valid before consumption', spawnSync('/bin/sh', ['-n', staged]).status === 0);
    rmSync(staged);
    await serviceControl(paths, { operation: 'stop', runtime: runtimeIdentity(host) });
    const exited = await running;
    stopped = true;
    check('the initial owned service child positively exits before the cold handoff', exited.code === 0 && exited.signal === null
      && await processStateAsync(initialOwner.process) === 'dead', ownerError);
    const retainedDiscovery = readFileSync(paths.discovery, 'utf8');
    const beforePreview = readdirSync(paths.directory, { recursive: true }).sort();
    const preview = await codexRootExecPlan(host, input.id, command, { env, dryRun: true });
    check('a cold dry-run neither ensures the service nor stages an exec plan',
      preview.preflight === 'notRun' && preview.nativeAuthorization === 'notRun' && readFileSync(paths.discovery, 'utf8') === retainedDiscovery
      && JSON.stringify(beforePreview) === JSON.stringify(readdirSync(paths.directory, { recursive: true }).sort()));
    const dry = await run(['--profile', input.id, '--service-home', serviceHome, '--dry-run', '--', ...[command.file, ...command.args]]);
    check('the POSIX launcher dry-run prints only the pure plan without running native code',
      dry.code === 0 && JSON.parse(dry.out).nativeAuthorization === 'notRun' && !existsSync(output)
      && readFileSync(paths.discovery, 'utf8') === retainedDiscovery, dry.err);
    const executed = await run(['--profile', input.id, '--service-home', serviceHome, '--', command.file, ...command.args], {
      CLAUDE_CODE_SESSION_ID: 'ancestor-native', PROMPTOBUS_CLIENT_TOKEN: 'ancestor-token', PROMPTOBUS_TASK: 'ancestor-task', BB_THREAD_ID: 'ancestor-bb',
    });
    check('the POSIX launcher cold preflight hands off through a package-bin symlink', executed.code === 0 && executed.signal === null, executed.err);
    const receipt = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : {};
    check('native exec keeps the launcher PID and exact literal arguments without a Node proxy',
      receipt.pid === executed.pid && JSON.stringify(receipt.args) === JSON.stringify(command.args.slice(2)) && !existsSync(path.join(root, 'NEVER')));
    check('exec removes inherited actor credentials and deletes its private plan before native execution',
      receipt.native === undefined && receipt.token === undefined && receipt.task === undefined && receipt.bb === undefined
      && receipt.owner === profile.ownerEnvironment && receipt.plans?.length === 0);
    check('preflight starts one service without claiming a native binding from the shell PID', readDiscovery(paths) && readdirSync(paths.clients).length === 0);
    for (const ordering of ['normal', 'early']) {
      const id = `created-${ordering}`, bbThreadId = `thr_created_${ordering}`, nativeId = randomUUID();
      const executionScope = { project: 'project-owned', environment: `environment-${ordering}` };
      const admission = createRootAdmission(host, { env }), appServer = requireProcess(), nonce = randomUUID();
      let calls = 0, credential;
      const cacheVerifiedHookFixture = async () => {
        const profile = readPrivate(path.join(paths.directory, `root-profile-${id}.json`));
        const actorEnv = { ...env, PROMPTOBUS_OWNER_ENV_FILE: profile.ownerEnvironment };
        for (const name of [...actorIdentityVariables(), 'BB_THREAD_ID', 'BB_ENVIRONMENT_ID', 'BB_PROJECT_ID', 'BB_THREAD_STORAGE']) delete actorEnv[name];
        credential = await registerServiceClient(host, { cwd: root, env: actorEnv, pollEnv: env,
          lifetime: { kind: 'process', process: appServer }, nativeBinding: { kind: 'codex', state: 'pending' }, bbRootNonce: nonce }, { env, pollEnv: env });
        const transcript = path.join(nativeStore, `${nativeId}.jsonl`);
        writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: nativeId, source: 'vscode' } }) + '\n', { mode: 0o600 });
        const file = path.join(paths.directory, `root-client-${createHash('sha256').update(JSON.stringify([id, appServer])).digest('hex')}.json`);
        // This private fixture represents a previously verified hook; it is not native creation evidence.
        writePrivate(file, { schemaVersion: 1, profile: id, runtime: runtimeIdentity(host), appServer, nonce,
          clientId: credential.clientId, credentialFile: credential.credentialFile, nativeStart: { nativeThreadId: nativeId, transcript } });
        if (ordering === 'early') {
          const original = readFileSync(transcript), launchBefore = readFileSync(file);
          const stateFile = path.join(paths.directory, 'root-admission', 'state.json'), stateBefore = readFileSync(stateFile);
          writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: nativeId, source: 'exec' } }) + '\n');
          const spawnSync0 = childProcess.spawnSync;
          // Only the app-server ancestry query is modeled; birth and service observations stay real.
          childProcess.spawnSync = function(command, args, ...rest) {
            if (command === 'ps' && JSON.stringify(args) === JSON.stringify(['-p', String(process.ppid), '-o', 'ppid=', '-o', 'comm=', '-o', 'args='])) {
              return { status: 0, stdout: `${process.pid} /fixture/bridge /fixture/bridge\n`, stderr: '' };
            }
            if (command === 'ps' && JSON.stringify(args) === JSON.stringify(['-p', String(process.pid), '-o', 'ppid=', '-o', 'comm=', '-o', 'args='])) {
              return { status: 0, stdout: `${process.ppid} /fixture/codex /fixture/codex app-server\n`, stderr: '' };
            }
            return spawnSync0.call(this, command, args, ...rest);
          };
          syncBuiltinESMExports();
          try {
            check('BB hook rejects exec SessionMeta before deferring creation or changing retained proof',
              await refused(() => authorizeCodexRootStart(host, id,
                { hook_event_name: 'SessionStart', session_id: nativeId, transcript_path: transcript }, env), /BB root requires a cli or vscode/)
              && readFileSync(file).equals(launchBefore) && readFileSync(stateFile).equals(stateBefore)
              && readPrivate(credential.credentialFile).nativeBinding.state === 'pending');
          } finally { childProcess.spawnSync = spawnSync0; syncBuiltinESMExports(); writeFileSync(transcript, original); }
        }
        return admission.deferRootCreation(id, file, { nativeThreadId: nativeId, appServer, nonce });
      };
      const createRoot = async descriptor => {
        calls += 1;
        const unlock = await acquireServiceLock(path.join(paths.directory, 'root-admission.lock'));
        check('trusted ordinary create runs outside the owner lock', !!unlock && descriptor.profile === id);
        unlock?.();
        const duplicate = await approveCodexRootProfile(host, { id, nativeStore, executionScope, createRoot: async () => { calls += 1; throw new Error('duplicate spawn'); } }, env);
        check('concurrent approval of a pending operation does not repeat create', duplicate.creation.state === 'pending' && calls === 1);
        if (ordering === 'early') {
          check('an early retained hook remains pending before its actual BB creation returns', await cacheVerifiedHookFixture()
            && readPrivate(credential.credentialFile).nativeBinding.state === 'pending');
          const pending = await fetch(readDiscovery(paths).url + 'mcp/bus', { method: 'POST', headers: {
            authorization: `Bearer ${credential.token}`, accept: 'application/json, text/event-stream',
            'content-type': 'application/json', 'codex-thread-id': nativeId },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'promptobus_status', arguments: {} } }) });
          const pendingBody = await pending.text();
          check('no capability is granted while the early creation is pending', pending.status === 403,
            JSON.stringify({ status: pending.status, body: pendingBody }));
        }
        writeFileSync(bb, '#!/bin/sh\nprintf \'%s\\n\' \'' + JSON.stringify({ root, home, complete: true, eligibility: 'eligible', bbThreadId }) + '\'\n', { mode: 0o700 });
        return { id: bbThreadId };
      };
      const created = await approveCodexRootProfile(host, { id, nativeStore, executionScope, createRoot }, env);
      if (ordering === 'normal') {
        check('a post-bind hook uses the same approved created BB thread', !await cacheVerifiedHookFixture());
        const descriptor = await approveCodexRootProfile(host, { id, nativeStore, executionScope }, env);
        check('callback-free scoped approval cannot realize the retained pending native proof', descriptor.creation === undefined
          && calls === 1 && readPrivate(credential.credentialFile).nativeBinding.state === 'pending');
      }
      if (ordering === 'normal') {
        const transcript = path.join(nativeStore, `${nativeId}.jsonl`), original = readFileSync(transcript);
        const stateFile = path.join(paths.directory, 'root-admission', 'state.json'), stateBefore = readFileSync(stateFile);
        const ledgerFile = path.join(paths.directory, 'native-admission.json'), ledgerBefore = readFileSync(ledgerFile);
        writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: nativeId, source: 'exec' } }) + '\n');
        try {
          check('BB retained-proof realization rejects exec SessionMeta without binding or replacing owner state',
            await refused(() => approveCodexRootProfile(host, { id, nativeStore, executionScope, createRoot }, env), /BB root requires a cli or vscode/)
            && readPrivate(credential.credentialFile).nativeBinding.state === 'pending' && calls === 1
            && readFileSync(stateFile).equals(stateBefore) && readFileSync(ledgerFile).equals(ledgerBefore));
        } finally { writeFileSync(transcript, original); }
      }
      const recovered = await approveCodexRootProfile(host, { id, nativeStore, executionScope, createRoot }, env);
      check(`${ordering} ordering realizes the retained same native proof without repeating ordinary create`, calls === 1
        && created.creation.bbThreadId === bbThreadId && recovered.creation.bbThreadId === bbThreadId
        && readPrivate(credential.credentialFile).nativeBinding.state === 'bound'
        && readPrivate(path.join(paths.directory, 'native-admission.json')).bindings.some(binding =>
          binding.nativeId === nativeId && binding.ownerKey === bbThreadId && binding.nonce === nonce));
      await revokeServiceClient(host, credential.clientId, { env, pollEnv: env });
    }
    const stateFile = path.join(paths.directory, 'root-admission', 'state.json');
    const scopedA = { project: 'project-A', environment: 'environment-A' };
    for (const initialScope of [scopedA, undefined]) {
      for (const phase of ['pending', 'bound', 'uncertain']) {
        const id = `scope-${initialScope ? 'scoped' : 'unscoped'}-${phase}`;
        let calls = 0, entered, complete;
        const started = new Promise(resolve => { entered = resolve; });
        const result = new Promise(resolve => { complete = resolve; });
        const first = approveCodexRootProfile(host, { id, nativeStore, executionScope: initialScope, createRoot: async () => {
          calls += 1; entered();
          if (phase === 'pending') return result;
          if (phase === 'uncertain') throw new Error('scope fixture partial creation');
          return { id: `thr_${id}` };
        } }, env).then(value => value, error => error);
        await started;
        if (phase !== 'pending') await first;
        const request0 = http.request;
        let ownerPreflights = 0;
        http.request = function (...args) {
          const call = request0.apply(this, args), end = call.end;
          call.end = function (body, ...rest) {
            if (typeof body === 'string' && JSON.parse(body).operation === 'status') ownerPreflights += 1;
            return end.call(this, body, ...rest);
          };
          return call;
        };
        syncBuiltinESMExports();
        try {
          const mismatches = initialScope ? [undefined, { ...scopedA, project: 'project-B' }, { ...scopedA, environment: 'environment-B' }] : [scopedA];
          for (const executionScope of mismatches) {
            for (const callback of [false, true]) {
              const before = readFileSync(stateFile, 'utf8'), clients = readdirSync(paths.clients).sort();
              ownerPreflights = 0;
              check(`${phase} ${initialScope ? 'scoped' : 'unscoped'} operation refuses changed or omitted selectors before any preflight`,
                await refused(() => approveCodexRootProfile(host, { id, nativeStore, executionScope,
                  ...(callback ? { createRoot: async () => { calls += 1; return { id: 'thr_forbidden_retarget' }; } } : {}) }, env), /execution scope/)
                && ownerPreflights === 0 && calls === 1 && readFileSync(stateFile, 'utf8') === before
                && JSON.stringify(readdirSync(paths.clients).sort()) === JSON.stringify(clients));
            }
          }
          const repeated = await approveCodexRootProfile(host, { id, nativeStore, executionScope: initialScope,
            createRoot: async () => { calls += 1; throw new Error('duplicate scoped create'); } }, env);
          check(`unchanged ${phase} execution scope retains the same operation without another create`, calls === 1 && repeated.creation.state === phase);
        } finally {
          http.request = request0; syncBuiltinESMExports();
          complete({ id: `thr_${id}` }); await first;
        }
      }
    }
    const mutableScope = { ...scopedA }, mutableInput = { id: 'scope-input-copy', nativeStore, executionScope: mutableScope,
      createRoot: async () => ({ id: 'thr_scope_input_copy' }) };
    const copied = approveCodexRootProfile(host, mutableInput, env);
    mutableScope.project = 'project-B'; mutableScope.environment = 'environment-B'; mutableInput.id = 'scope-input-foreign';
    const copiedResult = await copied;
    check('input object mutation after the first await cannot retarget the copied execution scope', copiedResult.profile === 'scope-input-copy'
      && JSON.stringify(readPrivate(stateFile).profiles.find(value => value.id === 'scope-input-copy').creation.executionScope) === JSON.stringify(scopedA)
      && !existsSync(path.join(paths.directory, 'root-profile-scope-input-foreign.json')));
    for (const executionScope of [null, {}, { project: '', environment: 'environment-A' }, { project: 'project-A', environment: ' environment-A' }]) {
      check('invalid execution scope refuses before publishing an approval', await refused(() => approveCodexRootProfile(host,
        { id: 'invalid-scope', nativeStore, executionScope }, env), /exact project and environment/)
        && !existsSync(path.join(paths.directory, 'root-profile-invalid-scope.json')));
    }
    let uncertainCalls = 0;
    const uncertainInput = { id: 'created-uncertain', nativeStore, createRoot: async () => { uncertainCalls += 1; throw new Error('partial creation unknown'); } };
    check('a partial creation failure is surfaced', await refused(() => approveCodexRootProfile(host, uncertainInput, env), /partial creation unknown/));
    const uncertain = await approveCodexRootProfile(host, uncertainInput, env);
    check('repeating an uncertain operation retains it without auto-spawning', uncertainCalls === 1 && uncertain.creation.state === 'uncertain' && uncertain.creation.bbThreadId === null);
    for (const drift of ['profile', 'operation', 'execution-scope']) {
      const id = `late-${drift}`, stateFile = path.join(paths.directory, 'root-admission', 'state.json');
      let changedFile, changedBytes;
      check('a late callback cannot write after profile or operation replacement', await refused(() => approveCodexRootProfile(host, {
        id, nativeStore, executionScope: scopedA, createRoot: async () => {
          changedFile = drift === 'profile' ? path.join(paths.directory, `root-profile-${id}.json`) : stateFile;
          const current = readPrivate(changedFile);
          if (drift === 'profile') current.nativeStore = nativeOther;
          else if (drift === 'operation') current.profiles.find(value => value.id === id).creation.revision = randomUUID();
          else current.profiles.find(value => value.id === id).creation.executionScope = { ...scopedA, environment: 'environment-B' };
          writePrivate(changedFile, current); changedBytes = readFileSync(changedFile, 'utf8');
          return { id: `thr_late_${drift}` };
        },
      }, env)) && readFileSync(changedFile, 'utf8') === changedBytes);
    }
  } finally {
    if (!stopped && owner.exitCode === null && owner.signalCode === null) {
      if (readDiscovery(paths)?.process.pid === owner.pid) await serviceControl(paths, { operation: 'stop', runtime: runtimeIdentity(host) });
      else owner.kill('SIGTERM');
    }
    await running;
    if (stopped && readDiscovery(paths)) {
      const cleanup = spawn(process.execPath, [binPath, 'service', 'stop', '--json'], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; cleanup.stderr.on('data', chunk => { err += chunk; });
      const code = await new Promise(resolve => cleanup.once('close', resolve));
      if (code !== 0) throw new Error(`Owned root fixture cleanup failed (${code}): ${err}`);
    }
    rmSync(serviceHome, { recursive: true, force: true });
  }
  if (failure) throw failure;
}
