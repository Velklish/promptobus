import { check } from './check.mjs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { copyNodeExecutable, makeSandbox, makeSockDir, stubCommand, withStubPath, writeHostConfig } from './sandbox.mjs';

const runtimeDirectory = process.argv[2];
const runtime = runtimeDirectory ? pathToFileURL(`${path.resolve(runtimeDirectory)}/`) : new URL('../', import.meta.url);
const { createStandaloneHost } = await import(new URL('dist/host-index.js', runtime));
const { guardHookCommand, managedGuardHookCommand, guardHookSettings } = await import(new URL('dist/hooks.js', runtime));
const { shellQuote } = await import(new URL('dist/fs/shell.js', runtime));
const { claudeDriver } = await import(new URL('lib/driver-claude.js', runtime));
const { createOwnerEnvironment, finalizeManagedServiceLaunch } = await import(new URL('lib/service-launch.js', runtime));
const { runWorkspaceService } = await import(new URL('lib/service.js', runtime));
const { serviceControl } = await import(new URL('lib/service-client.js', runtime));
const { readDiscovery, readPrivate, recordVersion, runtimeIdentity, servicePaths } = await import(new URL('lib/service-state.js', runtime));
const { bus, createTask, lastTurnAt, participantRecord, readWake, upsertParticipant, writeJsonAtomic } = await import(new URL('lib/store.js', runtime));

// Actual owned Node parent, CLI hook and service; effect markers stand for model/tool work.
const root = realpathSync(makeSandbox('promptobus-admission-claude-'));
const nativeExecutable = path.join(root, 'owned-native-node'), parentScript = path.join(root, 'native-parent.mjs');
copyNodeExecutable(nativeExecutable);
writeFileSync(parentScript, `import{spawn}from'node:child_process';
const active=new Set();
process.on('message',input=>{
  const hook=input.command?spawn(input.command,{cwd:input.cwd,env:input.env,shell:true,stdio:['pipe','pipe','pipe']})
    :spawn(input.nodePath,input.argv,{cwd:input.cwd,env:input.env,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';hook.stdout.on('data',b=>{stdout+=b});hook.stderr.on('data',b=>{stderr+=b});
  const closed=new Promise(resolve=>hook.once('close',code=>{active.delete(entry);process.send({id:input.id,code,stdout,stderr});resolve()}));
  const entry={hook,closed};active.add(entry);hook.stdin.end(JSON.stringify(input.event));
});
process.once('SIGTERM',async()=>{for(const entry of active)entry.hook.kill('SIGTERM');await Promise.all([...active].map(entry=>entry.closed));process.exit(0)});
process.send({ready:true});
`);
const serviceHome = path.join(makeSockDir('a2h-').dir, 'service'), nativeStore = path.join(root, 'native');
const bin = path.join(root, 'bin'), home = path.join(root, '.promptobus');
mkdirSync(nativeStore); mkdirSync(bin);
stubCommand(bin, 'claude', `import{readFileSync}from'node:fs';if(process.argv[2]==='agents')console.log(readFileSync(${JSON.stringify(path.join(root, 'sessions.json'))},'utf8'));else process.exitCode=1;`);
writeFileSync(path.join(root, 'sessions.json'), '[]');
const restorePath = withStubPath(bin);
writeHostConfig(root, { tools: ['claude'] });
const binPath = fileURLToPath(new URL('bin/promptobus.js', runtime));
const version = JSON.parse(readFileSync(new URL('package.json', runtime))).version;
const env = { ...process.env, PROMPTOBUS_HOME: home, PROMPTOBUS_SERVICE_HOME: serviceHome, CLAUDE_CONFIG_DIR: nativeStore, PROMPTOBUS_WARDEN: 'off' };
for (const key of Object.keys(env)) if (/^PROMPTOBUS_(CLIENT_|OWNER_ENV_FILE$|ROLE$|TASK$|.*_SESSION$)/.test(key)) delete env[key];
const host = createStandaloneHost({ cwd: root, binPath, version }), paths = servicePaths(host, env);
const layoutEntry = path.join(root, 'installed-layout.mjs');
writeFileSync(layoutEntry, `import {runPromptobus} from ${JSON.stringify(new URL('lib/cli.js', runtime).href)};
import {createStandaloneHost} from ${JSON.stringify(new URL('dist/host-index.js', runtime).href)};
const host=createStandaloneHost({cwd:process.cwd(),binPath:${JSON.stringify(layoutEntry)},version:${JSON.stringify(version)}});
process.exitCode=await runPromptobus(process.argv.slice(2),{host,input:process.stdin,output:process.stdout,env:process.env});\n`);
host.guardArgv = args => [layoutEntry, ...args];
const launches = [], children = [], sessions = [], nativeParents = [];
let serviceError;
const running = runWorkspaceService({ host, env, createHost: context => createStandaloneHost({ cwd: context.cwd, binPath, version }) })
  .catch(error => { serviceError = error; });
const phase = async (fixture, event, configured = false, input = null) => {
  const command = configured ? fixture.plan.settings.hooks[event.hook_event_name]?.[0]?.hooks?.[0]?.command : null;
  if (configured && !command) return { code: 0, stdout: '', stderr: '', missing: true };
  const argv = [binPath, 'guard', '--home', home, '--task', fixture.task, '--role', fixture.address,
    '--client-file', fixture.service.credentialFile, '--service-home', serviceHome];
  if (fixture.nativeParent) {
    const parent = fixture.nativeParent.child, id = randomUUID();
    return new Promise((resolve, reject) => {
      const receive = value => { if (value.id !== id) return; parent.off('message', receive); parent.off('close', gone); resolve(value); };
      const gone = code => { parent.off('message', receive); reject(new Error(`Owned native parent exited ${code} before hook result`)); };
      parent.on('message', receive); parent.once('close', gone);
      parent.send({ id, argv, command, event, cwd: root, env: fixture.env, nodePath: process.execPath });
    });
  }
  const child = configured
    ? spawn(command, { shell: true, cwd: root, env: fixture.env, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(process.execPath, argv, { cwd: root, env: fixture.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); });
  children.push({ child, closed });
  const raw = input?.raw ?? JSON.stringify(event);
  if (input?.keepOpen) child.stdin.write(raw); else child.stdin.end(raw);
  return closed;
};
const blocked = result => {
  try { return JSON.parse(result.stdout).continue === false; } catch { return result.code === 2; }
};
const connect = async fixture => {
  const credential = readPrivate(fixture.service.credentialFile), url = fixture.plan.mcpConfig.mcpServers.promptobus.url;
  const headers = { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const initialized = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1,
    method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'owned-no-model', version: '1' } } }) });
  const body = await initialized.text();
  if (initialized.status !== 200) throw new Error(`Owned MCP initialize HTTP ${initialized.status}: ${body}`);
  const ready = await fetch(url, { method: 'POST', headers: { ...headers, 'mcp-session-id': initialized.headers.get('mcp-session-id') },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  await ready.text();
  if (ready.status !== 202) throw new Error(`Owned MCP initialized HTTP ${ready.status}`);
};
const fresh = async (name, ownedNative = false) => {
  const task = `${name}-t20261109-000001`, address = 'worker:admission', ref = name, nativeId = randomUUID();
  let nativeParent;
  if (ownedNative) {
    const child = spawn(nativeExecutable, [parentScript], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
    const closed = new Promise(resolve => child.once('close', resolve));
    nativeParent = { child, closed }; nativeParents.push(nativeParent);
    await new Promise((resolve, reject) => {
      child.once('message', value => value.ready ? resolve() : reject(new Error('Owned native parent did not become ready')));
      child.once('error', reject); child.once('exit', code => reject(new Error(`Owned native parent exited ${code}: ${stderr}`)));
    });
  }
  createTask(home, { id: task, title: 'Owned Claude admission fixture' });
  const plan = claudeDriver.prepare({ ref, role: 'worker', model: 'fixture', prompt: 'fixture', cwd: root,
    mcp: { home, task, address, servers: { promptobus: { command: 'unused' } } },
    mcpConfigPath: path.join(root, `${name}.mcp.json`), settingsPath: path.join(root, `${name}.settings.json`),
    guardCommand: managedGuardHookCommand(host, { home, taskId: task, address }) });
  const finalized = await finalizeManagedServiceLaunch(host, { launch: plan, driver: claudeDriver, home, task, address, ref, cwd: root,
    env: { ...env, PROMPTOBUS_OWNER_ENV_FILE: createOwnerEnvironment(host, env) }, commonEnv: env });
  launches.push(finalized.service);
  const record = plan.prelaunchBinding.sessionRecord;
  mkdirSync(path.dirname(record), { recursive: true });
  writeJsonAtomic(record, { home, task, address, ref, launchId: finalized.service.launchId, sessionId: null,
    nativeCommand: { executable: recordVersion(ownedNative ? nativeExecutable : realpathSync(process.execPath)), nativeStore, argv: ['--bg', 'fixture'] } }, { mode: 0o600 });
  upsertParticipant(home, task, participantRecord(address, { harness: 'claude', mode: 'managed', sessionRef: ref, sessionRecord: record }));
  sessions.push({ name: ref, sessionId: nativeId, id: nativeId.slice(0, 8), pid: nativeParent?.child.pid ?? process.pid, status: 'idle' });
  writeFileSync(path.join(root, 'sessions.json'), JSON.stringify(sessions));
  await finalized.service.beforeStart(record);
  const transcript = path.join(nativeStore, `${nativeId}.jsonl`);
  return { plan, service: finalized.service, env: finalized.env, record, transcript, task, address, nativeId, nativeParent,
    event: { hook_event_name: 'SessionStart', source: 'startup', session_id: nativeId, cwd: root, transcript_path: transcript } };
};
try {
  const edge = Date.now() + 5000;
  while (!readDiscovery(paths) && !serviceError && Date.now() < edge) await new Promise(resolve => setTimeout(resolve, 10));
  if (serviceError) throw serviceError;
  if (!readDiscovery(paths)) throw new Error('Owned admission fixture service did not start');
  bus(home, { cli: version });
  const immediate = await fresh('immediate');
  writeFileSync(immediate.transcript, '{}\n', { mode: 0o600 });
  const started = await phase(immediate, immediate.event, true);
  check('actual fresh SessionStart producer admits its exact owned native parent and store', started.code === 0
    && readPrivate(immediate.service.credentialFile).nativeBinding.state === 'bound', JSON.stringify(started));
  const immediatePrompt = { hook_event_name: 'UserPromptSubmit', session_id: immediate.nativeId, cwd: root, transcript_path: immediate.transcript };
  const setupFailed = await phase(immediate, immediatePrompt, true);
  const setupEffect = path.join(root, 'failed-mcp-model-write');
  if (!blocked(setupFailed)) writeFileSync(setupEffect, 'model work would start');
  check('admitted startup with failed MCP setup blocks before model writes', blocked(setupFailed) && !existsSync(setupEffect), JSON.stringify(setupFailed));
  await connect(immediate);
  const readyPrompt = await phase(immediate, immediatePrompt, true);
  check('native startup and initialized owned MCP connection allow the first prompt', readyPrompt.code === 0 && !blocked(readyPrompt), JSON.stringify(readyPrompt));
  check('persisted hook settings still use the installed layout entry', guardHookSettings(host).Stop[0].hooks[0].command.includes(layoutEntry));
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']) {
    const command = immediate.plan.settings.hooks[event][0].hooks[0].command;
    check(`owned managed ${event} uses the current bus entry instead of the installed layout`, command.includes(`"${binPath}"`)
      && !command.includes(layoutEntry), command);
  }
  const matchingTool = await phase(immediate, { ...immediatePrompt, hook_event_name: 'PreToolUse' }, true);
  check('configured current runtime accepts the matching credential for tool admission', matchingTool.code === 0 && !blocked(matchingTool), JSON.stringify(matchingTool));
  const matchingStop = await phase(immediate, { ...immediatePrompt, hook_event_name: 'Stop' }, true);
  check('configured current runtime executes Stop with its matching managed credential', matchingStop.code === 0 && !blocked(matchingStop), JSON.stringify(matchingStop));
  const foreignRuntime = await phase({ ...immediate, plan: { settings: { hooks: { UserPromptSubmit: [{ hooks: [{
    command: guardHookCommand(host, { home, taskId: immediate.task, address: immediate.address })
      + ' ' + ['--client-file', immediate.service.credentialFile, '--service-home', serviceHome].map(shellQuote).join(' '),
  }] }] } } } }, immediatePrompt, true);
  check('installed foreign runtime still rejects the current managed credential', blocked(foreignRuntime)
    && /Managed client has no native launch binding/.test(foreignRuntime.stderr + foreignRuntime.stdout), JSON.stringify(foreignRuntime));
  for (const hook of ['UserPromptSubmit', 'PreToolUse']) {
    const event = { ...immediatePrompt, hook_event_name: hook };
    for (const [name, input] of [
      ['empty input', { raw: '' }],
      ['malformed JSON', { raw: '{' }],
      ['array input', { raw: '[]' }],
      ['null input', { raw: 'null' }],
      ['missing phase', { raw: '{}' }],
      ['unknown phase', { raw: JSON.stringify({ ...event, hook_event_name: 'Unknown' }) }],
      ['non-string phase', { raw: JSON.stringify({ ...event, hook_event_name: [hook] }) }],
      ['incomplete stdin timeout', { raw: '{"hook_event_name":', keepOpen: true }],
      ['complete JSON without stdin completion', { raw: JSON.stringify(event), keepOpen: true }],
    ]) {
      const beforeTurn = lastTurnAt(home, immediate.task, immediate.address);
      const result = await phase(immediate, event, true, input);
      const effect = path.join(root, `${hook}-${name.replaceAll(' ', '-')}-effect`);
      if (!blocked(result)) writeFileSync(effect, 'model/tool work would start');
      check(`${hook} rejects ${name} before model or tool effects`, blocked(result) && !existsSync(effect)
        && lastTurnAt(home, immediate.task, immediate.address) === beforeTurn, JSON.stringify(result));
    }
  }
  const missing = await fresh('missing-start');
  const foreignCredential = await phase({ ...immediate, plan: { settings: { hooks: { UserPromptSubmit: [{ hooks: [{
    command: immediate.plan.settings.hooks.UserPromptSubmit[0].hooks[0].command.replace(immediate.service.credentialFile, missing.service.credentialFile),
  }] }] } } } }, immediatePrompt, true);
  check('configured current runtime refuses another managed task credential', blocked(foreignCredential), JSON.stringify(foreignCredential));
  const prompt = { hook_event_name: 'UserPromptSubmit', session_id: missing.nativeId, cwd: root, transcript_path: missing.transcript };
  const unstarted = await phase(missing, prompt, true);
  const modelEffect = path.join(root, 'unadmitted-model-write');
  if (!blocked(unstarted)) writeFileSync(modelEffect, 'model work would start');
  check('configured first prompt blocks model writes without verified SessionStart admission', blocked(unstarted) && !existsSync(modelEffect), JSON.stringify(unstarted));
  const delayed = await fresh('delayed-transcript');
  delayed.env = { ...delayed.env, CLAUDE_CODE_MESSAGING_SOCKET: path.join(root, 'delayed-native.sock'),
    CLAUDE_CODE_MESSAGING_TOKEN: 'owned-delayed-contact' };
  const early = await phase(delayed, delayed.event);
  const wakeBeforePrompt = readWake(home, delayed.task, delayed.address), delayedTurn = lastTurnAt(home, delayed.task, delayed.address);
  const candidateRecord = readPrivate(delayed.record);
  for (const [name, patch] of [
    ['changed launch generation', { launchId: randomUUID() }],
    ['foreign native store', { nativeStore: root }],
    ['replaced process birth', { process: { pid: process.pid, birth: 'foreign-process-birth' } }],
    ['changed executable revision', { executable: { file: realpathSync(process.execPath), version: 'foreign-revision' } }],
  ]) {
    writeJsonAtomic(delayed.record, { ...candidateRecord, nativeStartupCandidate: { ...candidateRecord.nativeStartupCandidate, ...patch } }, { mode: 0o600 });
    const denied = await phase(delayed, { ...prompt, session_id: delayed.nativeId, transcript_path: delayed.transcript }, true);
    check(`deferred startup refuses ${name} before first native admission`, blocked(denied)
      && readPrivate(delayed.service.credentialFile).nativeBinding.state === 'pending', JSON.stringify(denied));
  }
  writeJsonAtomic(delayed.record, candidateRecord, { mode: 0o600 });
  writeFileSync(delayed.transcript, '{}\n', { mode: 0o600 });
  await connect(delayed);
  const late = await phase(delayed, { ...prompt, session_id: delayed.nativeId, transcript_path: delayed.transcript }, true);
  check('startup before transcript creation completes the same verified producer at the first prompt', early.code === 0 && late.code === 0 && !blocked(late)
    && readPrivate(delayed.service.credentialFile).nativeBinding.state === 'bound', JSON.stringify({ early, late }));
  const deferredWake = readWake(home, delayed.task, delayed.address);
  check('deferred admission hands off its exact native wake contact before the first prompt completes', !wakeBeforePrompt
    && deferredWake?.session === delayed.nativeId && deferredWake.socket === delayed.env.CLAUDE_CODE_MESSAGING_SOCKET
    && deferredWake.token === delayed.env.CLAUDE_CODE_MESSAGING_TOKEN
    && lastTurnAt(home, delayed.task, delayed.address) === delayedTurn, JSON.stringify({ deferredWake, delayedTurn }));
  const resume = await fresh('unknown-resume');
  writeFileSync(resume.transcript, '{}\n', { mode: 0o600 });
  const resumed = await phase(resume, { ...resume.event, source: 'resume' });
  const resumedPrompt = await phase(resume, { ...prompt, session_id: resume.nativeId, transcript_path: resume.transcript }, true);
  check('unknown resume cannot become fresh admission or reach model work', blocked(resumedPrompt)
    && readPrivate(resume.service.credentialFile).nativeBinding.state === 'pending', JSON.stringify({ resumed, resumedPrompt }));
  const foreign = await phase(immediate, { ...prompt, hook_event_name: 'PreToolUse', session_id: randomUUID(), transcript_path: immediate.transcript }, true);
  const toolEffect = path.join(root, 'foreign-tool-write');
  if (!blocked(foreign)) writeFileSync(toolEffect, 'tool work would start');
  check('configured tool barrier refuses a foreign session before tool writes', blocked(foreign) && !existsSync(toolEffect), JSON.stringify(foreign));
  const lateProducer = await fresh('late-producer', true);
  writeFileSync(lateProducer.transcript, '{}\n', { mode: 0o600 });
  const originalSpawnSync = cp.spawnSync;
  let produced, producerRun, launched, launchError, premature = false;
  const realize = lateProducer.service.realize.bind(lateProducer.service);
  lateProducer.service.realize = async id => {
    if (!readPrivate(lateProducer.record).nativeAdmissionEvidence) premature = true;
    return realize(id);
  };
  cp.spawnSync = function(file, argv, ...rest) {
    if (file === nativeExecutable && argv[0] === '--bg') {
      producerRun = new Promise(resolve => setTimeout(resolve, 100)).then(async () => { produced = await phase(lateProducer, lateProducer.event); });
      return { status: 0, stdout: `backgrounded · ${lateProducer.nativeId.slice(0, 8)} · late-producer`, stderr: '' };
    }
    return originalSpawnSync.call(this, file, argv, ...rest);
  };
  syncBuiltinESMExports();
  try {
    launched = await claudeDriver.spawn(lateProducer.plan, { tool: { bin: nativeExecutable }, host, home, task: lateProducer.task,
      address: lateProducer.address, ref: 'late-producer', role: 'worker', cwd: root, env: lateProducer.env, persist() {},
      awaitOptions: { sessions: () => sessions, tries: 1 } });
  } catch (error) { launchError = error; }
  finally { cp.spawnSync = originalSpawnSync; syncBuiltinESMExports(); await producerRun; }
  check('launcher waits for the actual delayed startup producer before first realization', Boolean(launched) && !launchError && !premature
    && produced?.code === 0 && readPrivate(lateProducer.service.credentialFile)?.nativeBinding.state === 'bound', JSON.stringify({ error: launchError?.stack, produced, premature }));
  check('owned prompt and tool barriers fail closed if their command cannot run', ['UserPromptSubmit', 'PreToolUse'].every(event =>
    immediate.plan.settings.hooks[event]?.[0]?.hooks?.[0]?.onFailure === 'block'));
  for (const replace of [false, true]) {
    const failed = await fresh(replace ? 'replaced-failure' : 'owned-failure', true);
    writeFileSync(failed.transcript, '{}\n', { mode: 0o600 });
    const stops = [], error = new Error('fixture first realization refused');
    let startup, failure;
    failed.service.realize = async () => {
      if (replace) writeJsonAtomic(failed.record, { ...readPrivate(failed.record), launchId: 'replacement-launch' }, { mode: 0o600 });
      throw error;
    };
    cp.spawnSync = function(file, argv, ...rest) {
      if (file === nativeExecutable && argv[0] === '--bg') {
        startup = phase(failed, failed.event);
        return { status: 0, stdout: `backgrounded · ${failed.nativeId.slice(0, 8)} · ${replace ? 'replaced-failure' : 'owned-failure'}`, stderr: '' };
      }
      if (argv[0] === 'stop') {
        stops.push(argv[1]);
        if (argv[1] === failed.nativeId.slice(0, 8)) failed.nativeParent.child.kill('SIGTERM');
        const index = sessions.findIndex(value => value.id === argv[1]);
        if (index >= 0) sessions.splice(index, 1);
        writeFileSync(path.join(root, 'sessions.json'), JSON.stringify(sessions));
        return { status: 0, stdout: 'owned fixture stop acknowledged', stderr: '' };
      }
      return originalSpawnSync.call(this, file, argv, ...rest);
    };
    syncBuiltinESMExports();
    try {
      await claudeDriver.spawn(failed.plan, { tool: { bin: nativeExecutable }, host, home, task: failed.task,
        address: failed.address, ref: replace ? 'replaced-failure' : 'owned-failure', role: 'worker', cwd: root, env: failed.env,
        persist() {}, awaitOptions: { sessions: () => sessions, tries: 1 } });
    } catch (caught) { failure = caught; }
    finally { cp.spawnSync = originalSpawnSync; syncBuiltinESMExports(); await startup; }
    let stoppedParent = false;
    if (!replace && stops.length === 1) {
      let timer;
      stoppedParent = await Promise.race([failed.nativeParent.closed.then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
      clearTimeout(timer);
    }
    check(replace ? 'failed admission preserves a replacement generation and reports unresolved cleanup'
      : 'failed first realization revokes the grant and stops only its exact owned native session',
    replace ? failure instanceof AggregateError && /changed ownership/.test(failure.message) && stops.length === 0
      : failure === error && stoppedParent && stops.length === 1 && stops[0] === failed.nativeId.slice(0, 8)
        && !existsSync(failed.service.credentialFile), JSON.stringify({ error: failure?.stack, startup: await startup, stops }));
  }
} finally {
  for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await Promise.all(children.map(value => value.closed));
  for (const { child } of nativeParents) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await Promise.all(nativeParents.map(value => value.closed));
  for (const launch of launches) if (existsSync(launch.credentialFile)) await launch.revoke();
  if (!serviceError && readDiscovery(paths)) {
    const deadline = Date.now() + 5000;
    let status = await serviceControl(paths, { operation: 'status', runtime: runtimeIdentity(host) });
    while (status.warden.observations > 0) {
      if (Date.now() >= deadline) throw new Error('Owned admission observations did not drain');
      await new Promise(resolve => setTimeout(resolve, 10));
      status = await serviceControl(paths, { operation: 'status', runtime: runtimeIdentity(host) });
    }
    await serviceControl(paths, { operation: 'stop', runtime: runtimeIdentity(host) });
  }
  await running; restorePath();
}
if (serviceError) throw serviceError;
