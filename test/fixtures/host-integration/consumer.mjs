// A host that installed the packed tarball: every operation it needs, through public specifiers only.
// Run with the install directory as cwd; argv[2] is a JSON file `{ expected, sandbox }`; prints verdicts.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const { expected, sandbox } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const integration = await import('promptobus/integration');
const { COMMANDS, runPromptobus } = await import('promptobus/cli');
const { BUS_SERVER } = await import('promptobus/hooks');
const { createStandaloneHost } = await import('promptobus/host');

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

await verdict('host integration: the entry exports exactly the documented names, runtime and types alike', () => {
  const dts = readFileSync(fileURLToPath(new URL('integration.d.ts', import.meta.resolve('promptobus/integration'))), 'utf8');
  const declared = [...dts.matchAll(/^export declare (?:const|function) ([A-Za-z_]\w*)/gm)].map((m) => m[1]).sort();
  return all(same(Object.keys(integration).sort(), expected.names), same(declared, expected.names));
});

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
