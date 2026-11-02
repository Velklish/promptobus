import './home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { hookTrustStatus, inspectHookTrust, parseOptions, parseServer, prepareProject, readPrompt, renderServer, requireEnvironment, runBbRoot } from '../bin/promptobus-bb-root.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-bb-root-command-')));
const scope = { root, project: 'prj_owner', environment: 'env_owner' };
const bb = path.join(root, 'bb');
fs.writeFileSync(bb, '#!/bin/sh\nexit 97\n', { mode: 0o700 });
const transportEnv = { BB_CLI: bb };
const codex = path.join(root, 'codex');
fs.writeFileSync(codex, '#!/bin/sh\nexit 97\n', { mode: 0o700 });
fs.mkdirSync(path.join(root, 'native'));
transportEnv.PATH = root;
const argv = ['--root', root, '--profile', 'owner', '--native-store', path.join(root, 'native'), '--project', scope.project, '--environment', scope.environment];
const environment = () => ({ id: scope.environment, projectId: scope.project, path: root });
const created = () => ({ id: 'thr_created_by_trusted_consumer', providerId: 'codex', projectId: scope.project, environmentId: scope.environment });
const descriptor = { profile: 'owner', root, home: path.join(root, '.promptobus'),
  server: { url: 'http://127.0.0.1:12345/mcp/bus', http_headers_helper: 'node "owner \\ cli" headers\nnext', required: true },
  startHook: { type: 'command', command: 'node owner guard --root-profile owner' } };
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

function nativeHookStatus(cwd, text, trusted = true) {
  const document = JSON.parse(text), file = path.join(cwd, '.codex/hooks.json');
  return { data: [{ cwd, warnings: [], errors: [], hooks: [['SessionStart', 'sessionStart', 'session_start'], ['Stop', 'stop', 'stop']].map(([name, eventName, key], index) => ({
    key: `${file}:${key}:0:0`, eventName, handlerType: 'command', command: document.hooks[name][0].hooks[0].command,
    async: false, matcher: null, timeoutSec: 600, statusMessage: null, additionalContextLimit: null,
    sourcePath: file, source: 'project', pluginId: null, displayOrder: index * 7 + 12, enabled: true, isManaged: false,
    currentHash: `sha256:${String(index + 1).repeat(64)}`, trustStatus: trusted ? 'trusted' : 'untrusted',
  })) }] };
}

async function withHookRpc(reply, action) {
  const original = childProcess.spawn, requests = [], launches = [];
  childProcess.spawn = (file, args, options) => {
    if (args.length !== 1 || args[0] !== 'app-server') return original(file, args, options);
    const child = new EventEmitter(), stdout = new PassThrough(), stderr = new PassThrough();
    let buffer = '', stopped = false;
    const stop = () => { if (!stopped) { stopped = true; queueMicrotask(() => child.emit('close', 0, null)); } };
    child.stdout = stdout; child.stderr = stderr; child.kill = () => { stop(); return true; };
    launches.push({ file, args, options });
    child.stdin = new Writable({
      write(chunk, _encoding, done) {
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf('\n'); if (end < 0) break;
          const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (!message.method) continue;
          requests.push(message);
          if (message.id !== undefined) queueMicrotask(() => {
            const answer = reply(message, options);
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...answer })}\n`);
          });
        }
        done();
      },
      final(done) { done(); stop(); },
    });
    return child;
  };
  syncBuiltinESMExports();
  try { return await action({ requests, launches }); }
  finally { childProcess.spawn = original; syncBuiltinESMExports(); }
}

async function withBb(reply, action) {
  const original = childProcess.execFile, calls = [];
  childProcess.execFile = (file, args, options, callback) => {
    const call = { file, args, options, prompt: null, complete: value => callback(value.error ?? null,
      value.stdout ?? JSON.stringify(value.body), value.stderr ?? '') };
    const stdin = new EventEmitter();
    stdin.end = text => { call.prompt = text; };
    calls.push(call);
    queueMicrotask(() => {
      const response = reply(args, calls, call);
      if (response) call.complete(response);
    });
    return { stdin };
  };
  syncBuiltinESMExports();
  try { return await action(calls); }
  finally { childProcess.execFile = original; syncBuiltinESMExports(); }
}

test('owner invocation command and input contract', async t => {
  await t.test('requires explicit selectors and rejects duplicate or adoption flags', () => {
    assert.equal(parseOptions(argv).project, scope.project);
    for (const extra of [['--project', 'other'], ['--parent-self'], ['--source-thread', 'thr_old'], ['--origin-kind', 'fork'], ['resume']]) {
      assert.throws(() => parseOptions([...argv, ...extra]));
    }
    assert.throws(() => parseOptions(argv.slice(0, -2)), /Required --environment/);
    assert.deepEqual(parseOptions(['--help']), { help: true });
  });
  await t.test('bounds prompt bytes and preserves multiline input without argv interpolation', async () => {
    const prompt = 'Owner task\n`literal` $(literal) "quotes"\n';
    assert.equal(await readPrompt(Readable.from([Buffer.from(prompt)])), prompt);
    assert.equal((await readPrompt(Readable.from([Buffer.alloc(64 * 1024, 97)]))).length, 64 * 1024);
    await assert.rejects(readPrompt(Readable.from([Buffer.alloc(64 * 1024 + 1, 97)])), /64 KiB/);
    for (const bytes of [Buffer.from(' \n'), Buffer.from('a\0b'), Buffer.from([0xff])]) {
      await assert.rejects(readPrompt(Readable.from([bytes])));
    }
  });
  await t.test('actual environment project/path changes refuse before preparation', async () => {
    for (const value of [{ ...environment(), projectId: 'foreign' }, { ...environment(), path: null }, { ...environment(), path: os.tmpdir() }]) {
      await withBb(() => ({ body: value }), () => assert.rejects(requireEnvironment(scope, transportEnv)));
    }
  });
  await t.test('fixed TOML subset round-trips exact strings and the required boolean', () => {
    const text = renderServer(descriptor);
    assert.deepEqual(parseServer(text, descriptor), descriptor.server);
    const fields = Object.fromEntries(text.split('\n').filter(line => line.includes(' = ')).map(line => {
      const at = line.indexOf(' = ');
      return [line.slice(0, at), JSON.parse(line.slice(at + 3))];
    }));
    assert.deepEqual(fields, descriptor.server);
    assert.equal(typeof fields.required, 'boolean');
    assert.throws(() => parseServer(text.replace('Owned by', 'Unowned by'), descriptor), /not owned/);
    assert.throws(() => renderServer({ ...descriptor, server: { ...descriptor.server, token: 'unexpected' } }), /exact approved/);
  });
  await t.test('owned project preparation accepts an absent canonical bus home without creating bus state', async () => {
    const { createStandaloneHost } = await import('../dist/host-index.js');
    const area = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-bb-root-new-owner-')));
    fs.writeFileSync(path.join(area, 'promptobus.json'), '{"tools":[]}\n');
    const host = createStandaloneHost({ cwd: area }), home = host.promptobusHome();
    const profile = { ...descriptor, root: area, home };
    try {
      assert.equal(fs.existsSync(home), false);
      const verify = await prepareProject(host, profile, { create: true });
      verify();
      assert.equal(fs.existsSync(home), false);
      await assert.rejects(prepareProject(host, { ...profile, home: path.join(area, 'foreign') }), /owner scope/);
      await assert.rejects(prepareProject(host, { ...profile, root: path.dirname(area) }), /owner scope/);
    } finally { fs.rmSync(area, { recursive: true, force: true }); }
  });
  await t.test('native trust requires both exact owned handlers and their current native hashes', () => {
    const text = JSON.stringify({ hooks: { SessionStart: [{ hooks: [descriptor.startHook] }], Stop: [{ hooks: [{ type: 'command', command: 'node owner stop' }] }] } });
    const status = nativeHookStatus(root, text);
    status.data[0].hooks.push({ key: '/unrelated/global:stop:0:0', sourcePath: '/unrelated/global', trustStatus: 'untrusted' });
    assert.equal(hookTrustStatus(status, descriptor, text).ready, true);
    const untrusted = nativeHookStatus(root, text, false);
    assert.equal(hookTrustStatus(untrusted, descriptor, text).ready, false);
    for (const change of [hook => { hook.enabled = false; }, hook => { hook.trustStatus = 'unknown'; }]) {
      const value = nativeHookStatus(root, text); change(value.data[0].hooks[1]);
      assert.equal(hookTrustStatus(value, descriptor, text).ready, false);
    }
    const mutations = [
      value => { value.data[0].hooks = []; }, value => { value.data[0].hooks.pop(); },
      value => { value.data[0].hooks.push({ ...value.data[0].hooks[0] }); },
      value => { value.data[0].hooks[0].eventName = 'stop'; }, value => { value.data[0].hooks[0].command = 'foreign'; },
      value => { value.data[0].hooks[0].source = 'user'; }, value => { value.data[0].hooks[0].sourcePath = '/foreign'; },
      value => { value.data[0].hooks[0].currentHash = 'file-sha-is-not-native-hook-hash'; },
      value => { value.data[0].hooks[0].isManaged = true; }, value => { value.data[0].hooks[0].async = true; },
      value => { value.data[0].hooks[0].matcher = '*'; }, value => { value.data[0].hooks[0].timeoutSec = 30; },
      value => { value.data[0].hooks[1].displayOrder = value.data[0].hooks[0].displayOrder; },
      value => { value.data[0].warnings = ['incomplete']; }, value => { value.data[0].errors = ['failed']; },
      value => { value.data[0].cwd = '/foreign'; },
    ];
    for (const mutate of mutations) {
      const value = nativeHookStatus(root, text); mutate(value);
      assert.throws(() => hookTrustStatus(value, descriptor, text));
    }
  });
  await t.test('isolated native status is preparatory and never proves a BB provider context', async () => {
    const directory = path.join(root, '.codex'); fs.mkdirSync(directory);
    const file = path.join(directory, 'hooks.json');
    const text = `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [descriptor.startHook] }], Stop: [{ hooks: [{ type: 'command', command: 'node owner stop' }] }] } })}\n`;
    fs.writeFileSync(file, text, { mode: 0o600 });
    const env = { ...transportEnv, CODEX_HOME: '/actor-home-is-not-the-approved-probe-home' }, before = { ...env };
    const reply = message => ({ result: message.method === 'initialize' ? { userAgent: 'fixture', codexHome: '/independent-probe-A' } : nativeHookStatus(root, text) });
    await withHookRpc(reply, async ({ requests, launches }) => {
      const result = await inspectHookTrust(descriptor, path.join(root, 'native'), env);
      assert.equal(result.ready, true); result.verify();
      assert.deepEqual(requests.map(message => message.method), ['initialize', 'initialized', 'hooks/list']);
      assert.deepEqual(requests.at(-1).params, { cwds: [root] });
      assert.deepEqual(launches[0].args, ['app-server']);
      assert.equal(launches[0].file, codex);
      assert.equal(launches[0].options.cwd, root);
      assert.equal(launches[0].options.env.CODEX_HOME, path.join(root, 'native'));
      assert.deepEqual(env, before);
      fs.writeFileSync(file, `${text} `, { mode: 0o600 });
      assert.throws(result.verify, /hook bytes changed/);
    });
    fs.writeFileSync(file, text, { mode: 0o600 });
    await withHookRpc(() => ({ error: { code: -32601, message: 'unsupported' } }), () => assert.rejects(inspectHookTrust(descriptor, path.join(root, 'native'), env)));
  });
  await t.test('package metadata ships a separate installed binary without a new export', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
    assert.equal(pkg.bin['promptobus-bb-root'], './bin/promptobus-bb-root.js');
    assert(pkg.files.includes('bin'));
    assert(!Object.keys(pkg.exports).some(key => key.includes('bb-root')));
  });
});

async function ownerFixture(action) {
  const { createStandaloneHost } = await import('../dist/host-index.js');
  const { serviceControl } = await import('../lib/service-client.js');
  const { readDiscovery, runtimeIdentity, servicePaths } = await import('../lib/service-state.js');
  const area = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-bb-root-owner-')));
  const serviceHome = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'pb-br-'));
  const home = path.join(area, '.promptobus'), nativeStore = path.join(area, 'native');
  fs.mkdirSync(nativeStore);
  fs.writeFileSync(path.join(area, 'promptobus.json'), '{"tools":[]}\n');
  const bb = path.join(area, 'bb');
  fs.writeFileSync(bb, '#!/bin/sh\nexit 97\n', { mode: 0o700 });
  fs.writeFileSync(path.join(area, 'codex'), '#!/bin/sh\nexit 97\n', { mode: 0o700 });
  const env = { ...process.env, BB_CLI: bb, PROMPTOBUS_HOME: home, PROMPTOBUS_SERVICE_HOME: serviceHome,
    PROMPTOBUS_WARDEN: 'off', PROMPTOBUS_SERVICE_IDLE_MS: '60000', OWNER_SENTINEL: 'retained', PATH: `${area}${path.delimiter}${process.env.PATH ?? ''}` };
  for (const name of Object.keys(env)) if (/^PROMPTOBUS_(CLIENT_|OWNER_ENV_FILE$|ROLE$|TASK$|.*_SESSION$)/.test(name)) delete env[name];
  const bin = path.join(repo, 'bin/promptobus.js'), version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
  const host = createStandaloneHost({ cwd: area, binPath: bin, version, nodePath: process.execPath }), paths = servicePaths(host, env);
  const owner = childProcess.spawn(process.execPath, [bin, 'service', 'run'], { cwd: area, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '', failure;
  owner.stderr.on('data', bytes => { stderr += bytes; });
  owner.once('error', error => { failure = error; });
  const running = new Promise(resolve => owner.once('close', resolve));
  const options = ['--root', area, '--profile', 'owner', '--native-store', nativeStore, '--project', scope.project, '--environment', scope.environment];
  const changedScopes = [{ environment: 'env_same_root' }, { project: 'prj_other', environment: 'env_other_project' }];
  const retained = () => {
    const manifest = path.join(paths.directory, 'root-profile-owner.json');
    const ownerEnvironment = JSON.parse(fs.readFileSync(manifest, 'utf8')).ownerEnvironment;
    return Object.fromEntries([manifest, ownerEnvironment, ...['root-admission/state.json', 'native-admission.json', 'native-admission.initialized.json']
      .map(file => path.join(paths.directory, file))].map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
  };
  const replies = args => ({ body: args[0] === 'thread' ? created() : {
    id: args[2], projectId: args[2] === 'env_other_project' ? 'prj_other' : scope.project, path: area,
  } });
  const run = async (selectors = {}) => {
    let stdout = '';
    const selected = [...options];
    selected[7] = selectors.project ?? scope.project;
    selected[9] = selectors.environment ?? scope.environment;
    const code = await runBbRoot(selected, { env, input: Readable.from(['owner fixture prompt\n']), output: { write: text => { stdout += text; } } });
    return { ...JSON.parse(stdout), code: code ?? 0 };
  };
  try {
    const edge = Date.now() + 5000;
    while (readDiscovery(paths)?.process.pid !== owner.pid && !failure && owner.exitCode === null && Date.now() < edge) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(readDiscovery(paths)?.process.pid, owner.pid, failure?.message ?? stderr);
    await withHookRpc((message, options) => ({ result: message.method === 'initialize' ? { userAgent: 'fixture' }
      : nativeHookStatus(options.cwd, fs.readFileSync(path.join(options.cwd, '.codex/hooks.json'), 'utf8')) }),
    native => action({ area, home, env, host, paths, nativeStore, retained, run, replies, changedScopes, native }));
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      if (readDiscovery(paths)?.process.pid === owner.pid) await serviceControl(paths, { operation: 'stop', runtime: runtimeIdentity(host) });
      else owner.kill('SIGTERM');
    }
    await running;
    fs.rmSync(area, { recursive: true, force: true });
    fs.rmSync(serviceHome, { recursive: true, force: true });
  }
}

test('shipped owner invocation retains preparation and refuses unavailable provider context',
  { skip: !['darwin', 'linux'].includes(process.platform) }, async t => {
    const assertUnavailable = result => {
      assert.equal(result.ready, false, JSON.stringify(result));
      assert.equal(result.code, 2);
      assert.equal(result.reason, 'provider-context-unavailable');
      assert.equal(result.creation, 'notAttempted');
      assert.equal(result.operator, undefined);
      assert.equal(result.requiresAction, undefined);
      assert.equal(result.handlers, undefined);
    };
    await t.test('trusted independent probe A cannot start a provider probe or public BB creation', async () => ownerFixture(async fixture => {
      const before = { ...fixture.env };
      await withHookRpc((message, options) => ({ result: message.method === 'initialize'
        ? { userAgent: 'trusted-probe-A', codexHome: fixture.nativeStore }
        : nativeHookStatus(options.cwd, fs.readFileSync(path.join(options.cwd, '.codex/hooks.json'), 'utf8')) }), async native => {
        await withBb(fixture.replies, async calls => {
          const result = await fixture.run();
          assertUnavailable(result);
          assert.equal(calls.filter(call => call.args[0] === 'thread').length, 0);
          assert.deepEqual(native.requests, []);
          assert.deepEqual(native.launches, []);
          const stateFile = path.join(fixture.paths.directory, 'root-admission/state.json');
          assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).profiles[0].creation, undefined);
          const config = fs.readFileSync(path.join(fixture.area, '.codex/config.toml'), 'utf8');
          const hooks = fs.readFileSync(path.join(fixture.area, '.codex/hooks.json'), 'utf8');
          assert.match(config, /\[mcp_servers\.promptobus\]/);
          assert.equal(JSON.parse(hooks).hooks.SessionStart.length, 1);
          assertUnavailable(await fixture.run());
          assert.equal(fs.readFileSync(path.join(fixture.area, '.codex/config.toml'), 'utf8'), config);
          assert.equal(fs.readFileSync(path.join(fixture.area, '.codex/hooks.json'), 'utf8'), hooks);
          assert.equal(calls.filter(call => call.args[0] === 'thread').length, 0);
          assert.equal(native.launches.length, 0);
          assert.deepEqual(fixture.env, before);
          assert.equal(fs.readdirSync(fixture.paths.clients).length, 0);
        });
      });
    }));
    await t.test('library pending operation remains byte-exact while the shipped caller refuses', async () => ownerFixture(async fixture => {
      const { approveCodexRootProfile } = await import('../lib/integration.js');
      const input = { id: 'owner', nativeStore: fixture.nativeStore, executionScope: scope };
      let entered, complete, callbacks = 0;
      const reached = new Promise(resolve => { entered = resolve; });
      const first = approveCodexRootProfile(fixture.host, { ...input, createRoot: async () => {
        callbacks += 1; entered(); await new Promise(resolve => { complete = resolve; }); return created();
      } }, fixture.env);
      let timer;
      try {
        await Promise.race([reached, first.then(() => { throw new Error('Trusted creation did not hold pending'); }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Trusted consumer did not reach its controlled callback')), 10_000); })]);
      } finally { clearTimeout(timer); }
      let finished;
      try {
        const stateFile = path.join(fixture.paths.directory, 'root-admission/state.json'), beforeState = fs.readFileSync(stateFile, 'utf8');
        assert.equal(JSON.parse(beforeState).profiles[0].creation.state, 'pending');
        const descriptor = await approveCodexRootProfile(fixture.host, input, fixture.env);
        assert.equal(descriptor.creation, undefined);
        const retained = fixture.retained();
        await withBb(fixture.replies, async calls => {
          assertUnavailable(await fixture.run());
          assert.equal(fs.readFileSync(stateFile, 'utf8'), beforeState);
          for (const selectors of fixture.changedScopes) await assert.rejects(fixture.run(selectors), /execution scope|project|environment/);
          assert.equal(fs.readFileSync(stateFile, 'utf8'), beforeState);
          assert.equal(calls.filter(call => call.args[0] === 'thread').length, 0);
          assert.equal(fixture.native.launches.length, 0);
          assert.equal(callbacks, 1);
          assert.deepEqual(fixture.retained(), retained);
        });
      } finally { complete(); finished = await first; }
      assert.deepEqual(finished.creation, { state: 'bound', bbThreadId: created().id });
      assert.equal(callbacks, 1);
    }));
    for (const state of ['uncertain', 'bound']) await t.test(`library ${state} operation remains byte-exact while the shipped caller refuses`, async () => ownerFixture(async fixture => {
      const { approveCodexRootProfile } = await import('../lib/integration.js');
      const input = { id: 'owner', nativeStore: fixture.nativeStore, executionScope: scope };
      let callbacks = 0;
      const createRoot = async () => { callbacks += 1; if (state === 'uncertain') throw new Error('trusted creation outcome unknown'); return created(); };
      if (state === 'uncertain') await assert.rejects(approveCodexRootProfile(fixture.host, { ...input, createRoot }, fixture.env), /trusted creation outcome unknown/);
      else assert.equal((await approveCodexRootProfile(fixture.host, { ...input, createRoot }, fixture.env)).creation.state, state);
      const stateFile = path.join(fixture.paths.directory, 'root-admission/state.json'), beforeState = fs.readFileSync(stateFile, 'utf8');
      assert.equal(JSON.parse(beforeState).profiles[0].creation.state, state);
      assert.equal((await approveCodexRootProfile(fixture.host, input, fixture.env)).creation, undefined);
      const retained = fixture.retained();
      await withBb(fixture.replies, async calls => {
        assertUnavailable(await fixture.run()); assertUnavailable(await fixture.run());
        assert.equal(fs.readFileSync(stateFile, 'utf8'), beforeState);
        for (const selectors of fixture.changedScopes) await assert.rejects(fixture.run(selectors), /execution scope|project|environment/);
        assert.equal(fs.readFileSync(stateFile, 'utf8'), beforeState);
        assert.equal(callbacks, 1);
        assert.deepEqual(fixture.retained(), retained);
        assert.equal(calls.filter(call => call.args[0] === 'thread').length, 0);
        assert.equal(fixture.native.launches.length, 0);
        assert.equal(fs.readdirSync(fixture.paths.clients).length, 0);
      });
    }));
    await t.test('owned preparatory helpers keep endpoint and successor configuration checks', async () => ownerFixture(async fixture => {
      const { approveCodexRootProfile } = await import('../lib/integration.js');
      const descriptor = await approveCodexRootProfile(fixture.host, { id: 'owner', nativeStore: fixture.nativeStore }, fixture.env);
      const verify = await prepareProject(fixture.host, descriptor, { create: true }); verify();
      const config = fs.readFileSync(path.join(fixture.area, '.codex/config.toml'), 'utf8');
      const hooks = fs.readFileSync(path.join(fixture.area, '.codex/hooks.json'), 'utf8');
      assert.deepEqual(parseServer(config, descriptor), descriptor.server);
      assert.deepEqual(JSON.parse(hooks).hooks.SessionStart, [{ hooks: [descriptor.startHook] }]);
      const changedPort = new URL(descriptor.server.url); changedPort.port = changedPort.port === '32123' ? '32124' : '32123';
      const moved = { ...descriptor, server: { ...descriptor.server, url: changedPort.href } };
      await assert.rejects(prepareProject(fixture.host, moved), /endpoint changed/);
      const verifyMoved = await prepareProject(fixture.host, moved, { update: true }); verifyMoved();
      assert.deepEqual(parseServer(fs.readFileSync(path.join(fixture.area, '.codex/config.toml'), 'utf8'), moved), moved.server);
      assert.equal(fs.readFileSync(path.join(fixture.area, '.codex/hooks.json'), 'utf8'), hooks);
      const successor = '{"hooks":{"SessionStart":[]},"successor":true}\n';
      fs.writeFileSync(path.join(fixture.area, '.codex/hooks.json'), successor, { mode: 0o600 });
      assert.throws(verifyMoved, /configuration changed/);
      await assert.rejects(prepareProject(fixture.host, moved), /unowned|unordered|differs/);
      assert.equal(fs.readFileSync(path.join(fixture.area, '.codex/hooks.json'), 'utf8'), successor);
    }));
    await t.test('partial preparation retains a raced foreign hook without attempting creation', async () => ownerFixture(async fixture => {
      const original = fs.openSync, hooks = path.join(fixture.area, '.codex/hooks.json'), foreign = '{"foreign":true}\n';
      let injected = false;
      fs.openSync = (file, flags, ...rest) => {
        if (file === hooks && flags === 'wx' && !injected) { injected = true; fs.writeFileSync(hooks, foreign, { mode: 0o600 }); }
        return original(file, flags, ...rest);
      };
      syncBuiltinESMExports();
      try {
        await withBb(fixture.replies, async calls => {
          await assert.rejects(fixture.run(), /EEXIST/);
          const state = JSON.parse(fs.readFileSync(path.join(fixture.paths.directory, 'root-admission/state.json'), 'utf8'));
          assert.equal(state.profiles[0].creation, undefined);
          assert.equal(fs.readFileSync(hooks, 'utf8'), foreign);
          const config = fs.readFileSync(path.join(fixture.area, '.codex/config.toml'), 'utf8');
          await assert.rejects(fixture.run());
          assert.equal(fs.readFileSync(hooks, 'utf8'), foreign);
          assert.equal(fs.readFileSync(path.join(fixture.area, '.codex/config.toml'), 'utf8'), config);
          assert.equal(calls.filter(call => call.args[0] === 'thread').length, 0);
          assert.equal(fixture.native.launches.length, 0);
        });
      } finally { fs.openSync = original; syncBuiltinESMExports(); }
    }));
    await t.test('the scoped caller refuses an existing unscoped operation before preparation', async () => ownerFixture(async fixture => {
      const { approveCodexRootProfile } = await import('../lib/integration.js');
      let callbacks = 0;
      await approveCodexRootProfile(fixture.host, { id: 'owner', nativeStore: fixture.nativeStore,
        createRoot: async () => { callbacks += 1; return created(); } }, fixture.env);
      const stateFile = path.join(fixture.paths.directory, 'root-admission/state.json'), beforeState = fs.readFileSync(stateFile, 'utf8');
      await withBb(fixture.replies, async calls => {
        await assert.rejects(fixture.run(), /execution scope|scoped/);
        assert.equal(calls.filter(call => call.args[0] === 'thread').length, 0);
        assert.equal(fs.readFileSync(stateFile, 'utf8'), beforeState);
        assert.equal(fs.readdirSync(fixture.paths.clients).length, 0);
        assert.equal(fixture.native.launches.length, 0);
      });
      assert.equal(callbacks, 1);
    }));
  });
