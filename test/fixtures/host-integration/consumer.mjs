// A host that installed the packed tarball: every operation it needs, through public specifiers only.
// Run with the install directory as cwd; argv[2] is a JSON file `{ expected, sandbox }`; prints verdicts.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const { expected, sandbox } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const integration = await import('promptobus/integration');
const { COMMANDS, runPromptobus } = await import('promptobus/cli');
const { BUS_SERVER } = await import('promptobus/hooks');
const { createStandaloneHost } = await import('promptobus/host');
const { createBbManagedAdmission } = await import('promptobus/bb-host');

const verdicts = [];
async function verdict(name, fn) {
  try {
    const detail = await fn();
    verdicts.push({ name, ok: detail === true, detail: detail === true ? '' : String(detail) });
  } catch (e) {
    verdicts.push({ name, ok: false, detail: e?.stack ?? String(e) });
  }
}
const same = (got, want) => JSON.stringify(got) === JSON.stringify(want)
  || `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`;
const all = (...results) => results.find((r) => r !== true) ?? true;
const filesUnder = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : []);

function refusesMutation(value) {
  try {
    value.push('x');
  } catch {
    return true;
  }
  return 'a frozen array accepted a push';
}

function deepFrozen(value, at = 'value') {
  if (!value || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return `${at} is not frozen`;
  for (const [key, inner] of Object.entries(value)) {
    const found = deepFrozen(inner, `${at}.${key}`);
    if (found !== true) return found;
  }
  return true;
}

function project(name, config) {
  const dir = path.join(sandbox, name);
  mkdirSync(dir, { recursive: true });
  if (config) writeFileSync(path.join(dir, 'promptobus.json'), `${JSON.stringify(config)}\n`);
  return createStandaloneHost({
    cwd: dir, commandName: 'consumer', version: '0.0.0', binPath: path.join(dir, 'bin.js'), nodePath: process.execPath,
  });
}

await verdict('host integration: public imports resolve inside the installed package', () => {
  const packageRoot = path.join(process.cwd(), 'node_modules', 'promptobus');
  const foreign = ['integration', 'cli', 'hooks', 'host', 'bb-host'].filter(name => {
    const resolved = fileURLToPath(import.meta.resolve(`promptobus/${name}`));
    return !resolved.startsWith(`${packageRoot}${path.sep}`);
  });
  return same(foreign, []);
});

await verdict('host integration: PACKAGE_VERSION is the installed manifest version', () => same(
  integration.PACKAGE_VERSION, expected.version,
));

await verdict('host integration: printed values are the package runtime values', () => all(
  same({
    PROMPTOBUS_TOOLS: integration.PROMPTOBUS_TOOLS,
    PROTOCOL_VERSIONS: integration.PROTOCOL_VERSIONS,
    PRUNE_DEFAULT_DAYS: integration.PRUNE_DEFAULT_DAYS,
    KNOCK_TEXT_MAX: integration.KNOCK_TEXT_MAX,
    MAILBOX_UNREAD_MARK: integration.MAILBOX_UNREAD_MARK,
    BRANCH_CHANGED_MARK: integration.BRANCH_CHANGED_MARK,
    WORKTREE_BRANCH_TEMPLATE: integration.WORKTREE_BRANCH_TEMPLATE,
    npmCiCommand: integration.npmCiCommand(),
  }, expected.printed),
  refusesMutation(integration.PROMPTOBUS_TOOLS),
  refusesMutation(integration.PROTOCOL_VERSIONS),
));

await verdict('host integration: BUS_SERVER from promptobus/hooks names the bus server', () => same(
  BUS_SERVER, expected.busServer,
));

await verdict('host integration: DRIVER_DECLARATIONS is a frozen data copy of the shipped drivers', () => all(
  same(integration.DRIVER_DECLARATIONS, expected.drivers),
  deepFrozen(integration.DRIVER_DECLARATIONS, 'DRIVER_DECLARATIONS'),
));

await verdict('host integration: checkWake answers for each shipped harness outside a session', async () => {
  const names = Object.keys(integration.DRIVER_DECLARATIONS.drivers);
  const probes = [];
  for (const name of names) probes.push(await integration.checkWake(name, {}));
  const fallback = await integration.checkWake(undefined, {});
  return all(
    same(probes.map((p) => [p.harness, p.endpoint, p.ok, typeof p.error]), names.map((n) => [n, null, false, 'string'])),
    same(fallback.harness, integration.DRIVER_DECLARATIONS.fallback),
  );
});

await verdict('host integration: INSTALL_TARGETS names each harness hook file and skills directory', () => all(
  same(integration.INSTALL_TARGETS, expected.installTargets),
  deepFrozen(integration.INSTALL_TARGETS, 'INSTALL_TARGETS'),
));

await verdict('host integration: packageSkills lists the shipped skills, each carrying the ownership marker', () => {
  const skills = integration.packageSkills();
  const unmarked = skills.filter((s) => !s.files.find((f) => f.rel === 'SKILL.md')?.text
    .includes(integration.SKILL_OWNERSHIP_MARKER)).map((s) => s.name);
  return all(same(skills.map((s) => s.name), expected.skills), same(unmarked, []));
});

await verdict('host integration: planHookInstall plans for a narrow host and writes nothing', () => {
  const root = path.join(sandbox, 'install-root');
  mkdirSync(root, { recursive: true });
  const host = {
    nodePath: () => process.execPath,
    guardArgv: (args) => [path.join(root, 'consumer-bin.js'), 'bus', ...args],
    busHookRel: () => path.join('.consumer', 'bus.mjs'),
    installManifestRel: () => path.join('.consumer', 'manifest.json'),
  };
  const harnesses = ['claude', 'cursor', 'codex'];
  const plan = integration.planHookInstall(host, root, harnesses);
  const rels = plan.writes.map((w) => w.rel);
  const hookTexts = harnesses.map((h) => plan.writes.find((w) => w.rel === integration.INSTALL_TARGETS[h].hooksRel)?.text ?? '');
  const skillFiles = harnesses.flatMap((h) => expected.skills.map((s) => path.join(integration.INSTALL_TARGETS[h].skillsRel, s, 'SKILL.md')));
  return all(
    same(Object.keys(plan).sort(), ['owned', 'ownedSkills', 'unproven', 'writes']),
    same(skillFiles.filter((rel) => !rels.includes(rel)), []),
    same(hookTexts.map((text) => text.includes('consumer-bin.js') && text.includes(' guard')), harnesses.map(() => true)),
    same(Object.keys(plan.ownedSkills).sort(), [...harnesses].sort()),
    same(filesUnder(root), []),
  );
});

await verdict('host integration: routingDiagnosis reads a declared project without probes or cache writes', async () => {
  const host = project('routing-declared', { tools: ['claude'] });
  const before = filesUnder(sandbox);
  const report = await integration.routingDiagnosis(host, { now: Date.parse('2026-10-04T00:00:00Z') });
  return all(
    same(Object.keys(report).sort(), ['cache', 'errors', 'failure', 'harnesses', 'layers', 'nearLimit', 'skipped', 'strategy', 'warnings']),
    same([report.skipped, report.failure, report.errors], [null, null, []]),
    same(report.layers.map((l) => l.id), ['catalog', 'user', 'workspace']),
    same(report.strategy, { strategy: 'balanced', source: null }),
    same(report.harnesses.map((h) => [h.harness, h.state, h.reason]), [['claude', 'unknown', 'stale_cache']]),
    same([report.cache.present, report.cache.takenAt, path.isAbsolute(report.cache.file)], [false, null, true]),
    same(filesUnder(sandbox), before),
  );
});

await verdict('host integration: routingDiagnosis reads the strategy and no harness when the declared set is empty', async () => {
  const report = await integration.routingDiagnosis(project('routing-undeclared', {}));
  return same([report.skipped, report.strategy, report.harnesses, report.nearLimit, report.failure],
    ['no-declared-harness', { strategy: 'balanced', source: null }, [], [], null]);
});

await verdict('host integration: routingDiagnosis reports a broken layer and stops there', async () => {
  const host = project('routing-broken', { tools: ['claude'] });
  const workspace = host.routingPaths().overlays.find((l) => l.id === 'workspace');
  mkdirSync(path.dirname(workspace.path), { recursive: true });
  writeFileSync(workspace.path, '{ not json');
  const report = await integration.routingDiagnosis(host);
  return same([report.skipped, report.errors.map((e) => [e.layer, e.code]), report.strategy],
    ['layer-errors', [['workspace', 'overlay-invalid']], null]);
});

await verdict('host integration: COMMANDS is the frozen command vocabulary the refusal names', () => {
  const bin = path.join(process.cwd(), 'node_modules', 'promptobus', 'bin', 'promptobus.js');
  const run = spawnSync(process.execPath, [bin, 'no-such-command'], { encoding: 'utf8', cwd: sandbox });
  return all(
    same([...COMMANDS], expected.commands),
    refusesMutation(COMMANDS),
    same([run.status, run.stderr.includes(`unknown command "no-such-command" — ${COMMANDS.join(', ')}`)], [1, true]),
  );
});

await verdict('host integration: runPromptobus runs a command for the host it is given', async () => {
  let out = '';
  const output = new Writable({ write(chunk, _enc, done) { out += chunk; done(); } });
  const host = { kind: 'promptobus-host', commandName: 'consumer', version: '9.9.9' };
  const code = await runPromptobus(['--version'], { host, cwd: sandbox, env: {}, output });
  return same([code, out], [0, 'consumer 9.9.9\n']);
});

await verdict('host integration: root profile API and CLI agree with the default service home', async () => {
  const root = path.join(sandbox, 'root-profile'), nativeStore = path.join(root, 'native-account');
  mkdirSync(nativeStore, { recursive: true });
  writeFileSync(path.join(root, 'promptobus.json'), '{"tools":[]}\n');
  const bb = path.join(root, 'bb');
  writeFileSync(bb, '#!/bin/sh\nexit 93\n', { mode: 0o700 });
  const host = createStandaloneHost({ cwd: root });
  const env = { ...process.env, BB_CLI: bb };
  const input = { id: 'packed-owner', nativeStore };
  const command = async (args) => {
    let text = '';
    const output = new Writable({ write(chunk, _enc, done) { text += chunk; done(); } });
    const code = await runPromptobus(args, { host, cwd: root, env, output });
    return { code, text };
  };
  try {
    const api = await integration.approveCodexRootProfile(host, input, env);
    const cli = await command(['service', 'profile', '--id', input.id, '--native-store', nativeStore]);
    let creates = 0;
    const executionScope = Object.freeze({ project: 'packed-project', environment: 'packed-environment' });
    const createRoot = async descriptor => { creates += 1; return { id: `thr_${descriptor.profile}` }; };
    const created = await integration.approveCodexRootProfile(host, { ...input, executionScope, createRoot }, env);
    const repeated = await integration.approveCodexRootProfile(host, { ...input, executionScope, createRoot }, env);
    let omittedScopeRefused = false;
    try { await integration.approveCodexRootProfile(host, input, env); }
    catch (error) { omittedScopeRefused = /execution scope/.test(error.message); }
    const profiles = filesUnder(path.join(process.env.HOME, '.promptobus', 'services'))
      .filter(name => name.endsWith('root-profile-packed-owner.json'));
    return all(
      same(env.PROMPTOBUS_SERVICE_HOME, undefined),
      same([api.profile, api.root, api.home], [input.id, host.workspaceRoot(), host.promptobusHome()]),
      same(cli.code, 0), same(JSON.parse(cli.text), api), same(profiles.length, 1),
      same(creates, 1), same(omittedScopeRefused, true), same(created.creation, { state: 'bound', bbThreadId: `thr_${input.id}` }), same(repeated.creation, created.creation),
      same([api.server.required, api.server.url === api.busUrl, api.server.http_headers_helper.includes('--profile'),
        api.startHook.command.includes('--root-profile'), api.execPlanCommand.includes('service exec-plan'), JSON.stringify(api).includes('Bearer')], [true, true, true, true, true, false]),
    );
  } finally {
    const stop = await command(['service', 'stop', '--json']);
    if (stop.code !== 0) throw new Error(`Packed root service cleanup failed: ${stop.text}`);
  }
});

await verdict('host integration: installed standalone API CLI and pure supplied-descriptor planning agree', async () => {
  const root = path.join(sandbox, 'standalone-profile'), nativeStore = path.join(root, 'native-account');
  mkdirSync(nativeStore, { recursive: true }); writeFileSync(path.join(root, 'promptobus.json'), '{"tools":[]}\n');
  const nativeExecutable = path.join(root, 'native-node');
  copyFileSync(process.execPath, nativeExecutable); chmodSync(nativeExecutable, 0o700);
  const host = createStandaloneHost({ cwd: root }), env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(BB_|PROMPTOBUS_(CLIENT_|ROOT_|OWNER_ENV_FILE$|ROLE$|TASK$|.*_SESSION$))/.test(name)) delete env[name];
  const command = async args => {
    let text = ''; const output = new Writable({ write(chunk, _enc, done) { text += chunk; done(); } });
    return { code: await runPromptobus(args, { host, cwd: root, env, output }), text };
  };
  try {
    const api = await integration.approveStandaloneRootProfile(host, { id: 'packed-native', harness: 'claude', nativeStore, executable: nativeExecutable }, env);
    const cli = await command(['service', 'profile', '--standalone', '--id', 'packed-native', '--harness', 'claude', '--native-store', nativeStore, '--executable', nativeExecutable]);
    const before = filesUnder(root);
    const plan = integration.planHookInstall(host, root, ['claude'], { rootProfile: api });
    const hooks = JSON.parse(plan.writes.find(write => write.rel === path.join('.claude', 'settings.json')).text).hooks;
    return all(same(cli.code, 0), same(JSON.parse(cli.text), api), same(filesUnder(root), before),
      same(Object.keys(plan).sort(), ['owned', 'ownedSkills', 'unproven', 'writes']),
      same(hooks.SessionStart[0].hooks[0].command, api.startHook.command),
      same([api.mode, api.harness, api.server.type, api.server.headersHelper.includes('--standalone'), api.execPlanCommand.includes('service exec-plan'),
        JSON.stringify(api).includes('Bearer')], ['standalone', 'claude', 'http', true, true, false]));
  } finally { const stopped = await command(['service', 'stop', '--json']); if (stopped.code !== 0) throw new Error('Packed standalone cleanup failed'); }
});

await verdict('host integration: installed recovery CLI refuses native-id without a trusted actual binding', async () => {
  const root = path.join(sandbox, 'standalone-recovery'), nativeStore = path.join(root, 'native-account');
  mkdirSync(nativeStore, { recursive: true }); writeFileSync(path.join(root, 'promptobus.json'), '{"tools":[]}\n');
  const nativeExecutable = path.join(root, 'native-node');
  copyFileSync(process.execPath, nativeExecutable); chmodSync(nativeExecutable, 0o700);
  const host = createStandaloneHost({ cwd: root }), id = 'packed-recovery';
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(BB_|PROMPTOBUS_(CLIENT_|ROOT_|OWNER_ENV_FILE$|ROLE$|TASK$|.*_SESSION$))/.test(name)) delete env[name];
  let text = ''; const output = new Writable({ write(chunk, _enc, done) { text += chunk; done(); } });
  try {
    const approved = await integration.approveStandaloneRootProfile(host, { id, harness: 'claude', nativeStore, executable: nativeExecutable }, env);
    const child = spawnSync(process.execPath, [host.binPath(), 'service', 'preflight', '--standalone', '--profile', id, '--native-id', 'unproved-id'],
      { cwd: root, env, encoding: 'utf8' });
    return all(same([approved.mode, approved.harness, approved.profile, approved.root, approved.home],
      ['standalone', 'claude', id, host.workspaceRoot(), host.promptobusHome()]),
    same(child.status, 1), same(child.signal, null), same(/Recovery requires exactly one owner-realized native binding/.test(child.stderr), true),
    same(/not approved|Bearer|credentialFile|PROMPTOBUS_ROOT_LAUNCH_FILE/.test(`${child.stdout}${child.stderr}`), false));
  } finally {
    const code = await runPromptobus(['service', 'stop', '--json'], { host, cwd: root, env, output });
    if (code !== 0) throw new Error('Packed recovery refusal cleanup failed');
  }
});

await verdict('host integration: BB managed admission preserves its explicit owner scope', async () => {
  const root = path.join(sandbox, 'managed-admission');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'promptobus.json'), '{"tools":[]}\n');
  const host = createStandaloneHost({ cwd: root });
  const paths = [];
  const admission = createBbManagedAdmission(executionPath => { paths.push(executionPath); return host; }, process.env);
  const expectedScope = { root: host.workspaceRoot(), home: host.promptobusHome() };
  const scoped = await admission.scope(root);
  const started = await admission.begin(root, 'packed-managed-intent');
  let changedScope;
  try { await admission.complete(root, 'packed-managed-intent', 'thr_packed_owned', { ...started, home: `${started.home}-foreign` }); }
  catch (error) { changedScope = error; }
  const completed = await admission.complete(root, 'packed-managed-intent', 'thr_packed_owned', started);
  return all(same(scoped, expectedScope), same(started, expectedScope), same(completed, expectedScope),
    same(Object.keys(admission).sort(), ['begin', 'complete', 'scope']),
    same(changedScope?.message, 'Canonical owner workspace or store changed during admission'),
    same(paths.every(executionPath => executionPath === host.workspaceRoot()), true));
});

await verdict('host integration: the runtime entry exports exactly the documented names', () =>
  same(Object.keys(integration).sort(), expected.names));

await verdict('host integration: private package paths stay unexported', async () => {
  const opened = [];
  for (const specifier of expected.privateSpecifiers) {
    try {
      await import(specifier);
      opened.push(`${specifier} imported`);
    } catch (e) {
      if (e?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') opened.push(`${specifier}: ${e?.code ?? e}`);
    }
  }
  return same(opened, []);
});

process.stdout.write(JSON.stringify(verdicts));
