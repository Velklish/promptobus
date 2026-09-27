// The pipeline declaration of `promptobus.json`: the default, a declared order on every surface that
// prints it, each refusal with its field, and the schema against the loader on one case list. Run: npm test
import './home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, readlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { captureSplit } from './console.mjs';
import { makeSandbox, resetCliCaches, stubCommand, withStubPath, writeHostConfig } from './sandbox.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'promptobus.js');
const SCHEMA = JSON.parse(readFileSync(path.join(ROOT, 'schemas', 'v1', 'pipeline.schema.json'), 'utf8'));

const bus = await import('../dist/index.js');
const pipe = await import('../dist/pipeline.js');
const store = await import('../lib/store.js');
const { hostOf } = await import('../lib/host.js');
const { models } = await import('../lib/models.js');
const { status } = await import('../lib/status.js');
const { serve } = await import('../lib/server.js');
const { planReview, step } = await import('../lib/review.js');
const { cacheFileOf } = await import('../lib/model-routing/cache.js');
const { claudeDriver } = await import('../lib/driver-claude.js');

const SHIPPED = bus.SHIPPED_REGISTRY;
const GOVERNANCE = SHIPPED.entries.filter((e) => e.layer === 'governance').map((e) => e.name);
const SHIPPED_STEPS = SHIPPED.entries.filter((e) => e.layer === 'step').map(({ name, kind }) => ({ name, kind }));
const SB = makeSandbox('promptobus-test-pipeline-');
const OUTSIDE = path.join(SB, 'outside.md');
writeFileSync(OUTSIDE, 'A file beside every install root, never inside one.\n');
const SECURITY = {
  owner: { name: 'worker', kind: 'edits-tree' },
  gates: [
    { name: 'reviewer', kind: 'reads-diff' },
    { name: 'security', kind: 'reads-diff', instructions: 'security.md' },
    { name: 'approver', kind: 'writes-main-tree' },
  ],
};
const TASK = 'pipeline-t20260926-120000';
const ajv = new Ajv2020({ strict: false, allErrors: true }).compile(SCHEMA);
const noAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

let made = 0;
function workspace(pipeline) {
  const dir = path.join(SB, `ws-${made += 1}`);
  writeHostConfig(dir, pipeline === undefined ? {} : { pipeline });
  writeFileSync(path.join(dir, 'security.md'), 'Read the diff for secrets.\n');
  return dir;
}

function withTask(host) {
  const home = host.promptobusHome();
  store.bus(home, { cli: '0.5.1' });
  store.createTask(home, { id: TASK, title: 'pipeline', owner: null });
  return home;
}

async function taskReply(host, dir) {
  const home = withTask(host);
  const written = [];
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'promptobus_task', arguments: {} } };
  await serve({
    host,
    env: { PROMPTOBUS_HOME: home, PROMPTOBUS_TASK: TASK },
    cwd: dir,
    input: Readable.from([`${JSON.stringify(call)}\n`], { objectMode: false }),
    output: { write: (chunk) => written.push(chunk) },
  });
  return JSON.parse(written[0]).result.content.map((c) => c.text).join('\n');
}

async function validateRefusal(host) {
  let refusal = null;
  const said = await captureSplit(async () => {
    try { await models(host, { subcommand: 'validate' }); } catch (e) { refusal = e; }
  });
  return { err: noAnsi(said.err), refusal };
}

const statusHeader = async (host) => noAnsi((await captureSplit(() => status(host, { task: TASK, sessions: {} }))).out)
  .split('\n').find((l) => l.includes(TASK));

test('with no pipeline key the host declares nothing, and every surface reads the default steps', async () => {
  const dir = workspace();
  const host = hostOf(dir);
  assert.equal(typeof host.pipeline, 'undefined', 'an absent key leaves the member absent: the host is today\'s');
  assert.deepEqual(pipe.pipelineOf(host), SHIPPED_STEPS);
  assert.deepEqual(SHIPPED_STEPS.map((s) => s.name), ['worker', 'reviewer', 'approver']);
  assert.deepEqual(pipe.pipelineOf(null), SHIPPED_STEPS);
  assert.deepEqual(bus.registryOf(host), SHIPPED);
  for (const s of [pipe.DEFAULT_PIPELINE.owner, ...pipe.DEFAULT_PIPELINE.gates]) {
    assert.equal(s.qualityFloor, bus.defaultFloor(SHIPPED, s.name), s.name);
    assert.equal(s.instructions, null, s.name);
  }
  withTask(host);
  assert.match(await statusHeader(host), / · pipeline worker → reviewer → approver$/);
  const other = workspace();
  assert.match(await taskReply(hostOf(other), other), /^pipeline: worker → reviewer → approver$/m);
});

test('a declaration with security between reviewer and approver loads, in order, on every surface', async () => {
  const dir = workspace(SECURITY);
  const host = hostOf(dir);
  const four = [
    { name: 'worker', kind: 'edits-tree' }, { name: 'reviewer', kind: 'reads-diff' },
    { name: 'security', kind: 'reads-diff', instructions: path.join(dir, 'security.md') },
    { name: 'approver', kind: 'writes-main-tree' },
  ];
  assert.deepEqual(host.pipeline(), four);
  assert.deepEqual(pipe.pipelineOf(host), four);
  assert.ok(bus.admitsAddress(bus.registryOf(host), 'security:x'), 'the registry admits the declared step');
  assert.ok(!bus.admitsAddress(bus.registryOf(host), 'boss:x'));

  const { pipeline, findings } = pipe.readPipeline(SECURITY, { root: dir, file: 'f' });
  assert.deepEqual(findings, []);
  const security = pipeline.gates[1];
  assert.equal(security.instructions, path.join(dir, 'security.md'), 'instructions resolve against the install root');
  assert.equal(security.qualityFloor, bus.defaultFloor(SHIPPED, 'reviewer'), 'absent, the floor is its kind\'s');
  assert.equal(pipeline.gates[2].qualityFloor, bus.defaultFloor(SHIPPED, 'approver'));
  const floored = structuredClone(SECURITY);
  floored.gates[1].qualityFloor = 6;
  assert.equal(pipe.readPipeline(floored, { root: dir, file: 'f' }).pipeline.gates[1].qualityFloor, 6);

  withTask(host);
  assert.match(await statusHeader(host), / · pipeline worker → reviewer → security → approver$/);
  const other = workspace(SECURITY);
  assert.match(await taskReply(hostOf(other), other), /^pipeline: worker → reviewer → security → approver$/m);
  const said = await captureSplit(() => models(host, { subcommand: 'validate' }));
  assert.equal(said.value, 0);
  assert.match(noAnsi(said.out), /pipeline: worker → reviewer → security → approver/);
});

test('gate instructions reach real lifts, live re-review, and dead-session relifts without partial refusals', async () => {
  const declared = {
    owner: { name: 'worker', kind: 'edits-tree' },
    gates: [
      { name: 'security', kind: 'reads-diff', instructions: 'security.md' },
      { name: 'plain', kind: 'reads-diff' },
      { name: 'release', kind: 'writes-main-tree', instructions: 'release.md' },
    ],
  };
  const dir = realpathSync(workspace(declared));
  const securityFile = path.join(dir, 'security.md');
  const releaseFile = path.join(dir, 'release.md');
  writeFileSync(securityFile, 'SECURITY-INITIAL\n');
  writeFileSync(releaseFile, 'RELEASE-INITIAL\n');
  const repo = path.join(dir, 'repos', 'team', 'app');
  mkdirSync(repo, { recursive: true });
  const git = (...args) => {
    const run = spawnSync('git', ['-C', repo, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  git('init', '-b', 'main');
  writeFileSync(path.join(repo, 'a.txt'), 'before\n');
  git('add', '.');
  git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(path.join(repo, 'a.txt'), 'after\n');
  const host = hostOf(dir);
  const home = host.promptobusHome();
  const task = 'gate-instructions-t20260927-000001';
  store.bus(home, { cli: '0.5.1' });
  store.createTask(home, { id: task, title: 'gate instructions', owner: null });
  const assigned = '2020-01-01T00:00:00.000Z';
  const recordResult = (address, metadata, taskId = task) => {
    store.upsertParticipant(home, taskId, store.participantRecord(address, {
      harness: 'claude', repo: 'repos/team/app', repoAbs: repo, started: assigned,
      ...metadata,
    }, bus.registryOf(host)));
    store.sendMessage(home, taskId, { from: address, to: 'orchestrator', type: 'result', body: 'done' });
  };
  recordResult('worker:app', { worktree: repo, baseSha: base });
  const standDir = path.join(dir, 'stand');
  const launched = path.join(standDir, 'launched.jsonl');
  const live = path.join(standDir, 'live.json');
  stubCommand(standDir, 'claude', `import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('2.1.280\\n'); process.exit(0); }
if (args[0] === '--bg') {
  const name = args[args.indexOf('--name') + 1];
  appendFileSync(${JSON.stringify(launched)}, JSON.stringify(args) + '\\n');
  const names = existsSync(${JSON.stringify(live)}) ? JSON.parse(readFileSync(${JSON.stringify(live)}, 'utf8')) : [];
  writeFileSync(${JSON.stringify(live)}, JSON.stringify([...names, name]));
  process.stdout.write('backgrounded · cafe34 · ' + name + '\\n');
  process.exit(0);
}
if (args[0] === 'agents') {
  const names = existsSync(${JSON.stringify(live)}) ? JSON.parse(readFileSync(${JSON.stringify(live)}, 'utf8')) : [];
  process.stdout.write(JSON.stringify(names.map((name, i) => ({ id: 'sess-' + i, name, status: 'running' }))));
  process.exit(0);
}
process.exit(0);`);
  const restorePath = withStubPath(standDir);
  const priorWarden = process.env.PROMPTOBUS_WARDEN;
  process.env.PROMPTOBUS_WARDEN = 'off';
  const tool = { ok: true, bin: path.join(standDir, 'claude'), version: '2.1.280' };
  const lift = (stepName, taskId = task, extra = {}) => step(host, {
    target: repo, task: taskId, stepName, harness: 'claude', tool, ...extra,
  });
  const launches = () => existsSync(launched)
    ? readFileSync(launched, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  const snapshotTree = (root) => {
    if (!existsSync(root)) return null;
    const visit = (at) => {
      const stat = lstatSync(at);
      if (stat.isSymbolicLink()) return `link:${readlinkSync(at)}`;
      if (stat.isDirectory()) return Object.fromEntries(readdirSync(at).sort()
        .map((name) => [name, visit(path.join(at, name))]));
      return readFileSync(at).toString('hex');
    };
    return visit(root);
  };
  const withLivenessFlip = async (fn) => {
    const inspect = claudeDriver.inspect;
    let reads = 0;
    claudeDriver.inspect = (ref, sessions) => {
      reads += 1;
      if (reads === 1) return inspect(ref, [{ id: 'first-alive', name: ref, status: 'running' }]);
      if (reads === 2) return inspect(ref, []);
      return inspect(ref, sessions);
    };
    try {
      const result = await fn();
      assert.ok(reads >= 2, `expected two liveness reads, got ${reads}`);
      return result;
    } finally {
      claudeDriver.inspect = inspect;
    }
  };
  try {
    const firstReview = (await captureSplit(() => lift('security'))).value;
    assert.match(launches()[0].join(' '), /## Gate instructions[\s\S]*SECURITY-INITIAL/);
    assert.equal(firstReview.instructions.text, 'SECURITY-INITIAL\n');
    assert.equal(store.participantOf(store.readTask(home, task), 'security:app').metadata.gateInstructions.text,
      'SECURITY-INITIAL\n');

    store.sendMessage(home, task, { from: 'security:app', to: 'orchestrator', type: 'result', body: 'done' });
    const plainPrompt = planReview(host, { target: repo, task, stepName: 'plain', dryRun: true });
    assert.doesNotMatch(plainPrompt.prompt, /## Gate instructions/);
    assert.doesNotMatch(plainPrompt.reReview, /## Gate instructions/);
    assert.match(plainPrompt.prompt, /## Review subject[\s\S]*\n\n## Isolation — hold it yourself/);
    recordResult('plain:app', { reviewSubject: repo, reviewAssignedAt: assigned });

    const firstApproval = (await captureSplit(() => lift('release'))).value;
    assert.match(launches()[1].join(' '), /## Gate instructions[\s\S]*RELEASE-INITIAL/);
    assert.equal(firstApproval.instructions.text, 'RELEASE-INITIAL\n');
    assert.equal(store.participantOf(store.readTask(home, task), 'release:app').metadata.gateInstructions.text,
      'RELEASE-INITIAL\n');

    writeFileSync(securityFile, 'SECURITY-CHANGED\n');
    writeFileSync(releaseFile, 'RELEASE-CHANGED\n');
    const repeatReview = (await captureSplit(() => lift('security'))).value;
    assert.equal(repeatReview.reuse, true);
    assert.equal(launches().length, 2);
    const reReview = store.peekInbox(home, task, 'security:app').messages.filter((m) => m.type === 'task').at(-1);
    assert.match(reReview.body, /## Gate instructions[\s\S]*SECURITY-INITIAL/);
    assert.doesNotMatch(reReview.body, /SECURITY-CHANGED/);
    const repeatApproval = (await captureSplit(() => lift('release'))).value;
    assert.equal(repeatApproval.reuse, true);
    assert.equal(repeatApproval.instructions.text, 'RELEASE-INITIAL\n');
    assert.equal(launches().length, 2);

    writeFileSync(live, '[]');
    resetCliCaches();
    const deadReview = (await captureSplit(() => lift('security'))).value;
    const deadApproval = (await captureSplit(() => lift('release'))).value;
    assert.equal(deadReview.reuse, false);
    assert.equal(deadApproval.reuse, false);
    assert.match(launches()[2].join(' '), /## Gate instructions[\s\S]*SECURITY-CHANGED/);
    assert.match(launches()[3].join(' '), /## Gate instructions[\s\S]*RELEASE-CHANGED/);
    assert.equal(store.participantOf(store.readTask(home, task), 'security:app').metadata.gateInstructions.text,
      'SECURITY-CHANGED\n');
    assert.equal(store.participantOf(store.readTask(home, task), 'release:app').metadata.gateInstructions.text,
      'RELEASE-CHANGED\n');

    writeFileSync(securityFile, 'SECURITY-TRANSITION\n');
    writeFileSync(live, '[]');
    resetCliCaches();
    const transitionReview = (await withLivenessFlip(() => captureSplit(() => lift('security')))).value;
    assert.equal(transitionReview.reuse, false);
    assert.match(launches()[4].join(' '), /## Gate instructions[\s\S]*SECURITY-TRANSITION/);
    assert.equal(store.participantOf(store.readTask(home, task), 'security:app').metadata.gateInstructions.text,
      'SECURITY-TRANSITION\n');

    writeFileSync(releaseFile, 'RELEASE-TRANSITION\n');
    writeFileSync(live, '[]');
    resetCliCaches();
    const transitionApproval = (await withLivenessFlip(() => captureSplit(() => lift('release')))).value;
    assert.equal(transitionApproval.reuse, false);
    assert.match(launches()[5].join(' '), /## Gate instructions[\s\S]*RELEASE-TRANSITION/);
    assert.equal(store.participantOf(store.readTask(home, task), 'release:app').metadata.gateInstructions.text,
      'RELEASE-TRANSITION\n');

    const freshTask = 'gate-instructions-t20260927-000002';
    store.createTask(home, { id: freshTask, title: 'missing instructions', owner: null });
    recordResult('worker:app', { worktree: repo, baseSha: base }, freshTask);
    const freshApprovalTask = 'gate-instructions-t20260927-000003';
    store.createTask(home, { id: freshApprovalTask, title: 'unreadable approval instructions', owner: null });
    recordResult('worker:app', { worktree: repo, baseSha: base }, freshApprovalTask);
    recordResult('security:app', { reviewSubject: repo, reviewAssignedAt: assigned }, freshApprovalTask);
    recordResult('plain:app', { reviewSubject: repo, reviewAssignedAt: assigned }, freshApprovalTask);
    const cacheFile = cacheFileOf(host);
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, 'cache sentinel\n');
    const worktrees = path.join(repo, '.claude', 'worktrees');
    const refusesWithoutWrites = async (stepName, taskId, file) => {
      const before = { journal: snapshotTree(home), worktrees: snapshotTree(worktrees),
        cache: readFileSync(cacheFile), launches: launches().length };
      let probes = 0;
      await assert.rejects(() => captureSplit(() => lift(stepName, taskId, {
        strategy: 'balanced', refresh: true,
        adapterFor: () => ({ probe: () => { probes += 1; return { state: 'available' }; } }),
      })), (error) => error.message.includes(file) && /cannot be read/.test(error.message));
      assert.equal(probes, 0);
      assert.deepEqual({ journal: snapshotTree(home), worktrees: snapshotTree(worktrees),
        cache: readFileSync(cacheFile), launches: launches().length }, before);
    };
    chmodSync(securityFile, 0);
    try {
      assert.throws(() => readFileSync(securityFile, 'utf8'));
      writeFileSync(live, '[]');
      resetCliCaches();
      await withLivenessFlip(() => refusesWithoutWrites('security', task, securityFile));
    } finally {
      chmodSync(securityFile, 0o644);
    }
    chmodSync(releaseFile, 0);
    try {
      assert.throws(() => readFileSync(releaseFile, 'utf8'));
      writeFileSync(live, '[]');
      resetCliCaches();
      await withLivenessFlip(() => refusesWithoutWrites('release', task, releaseFile));
    } finally {
      chmodSync(releaseFile, 0o644);
    }
    unlinkSync(securityFile);
    await refusesWithoutWrites('security', freshTask, securityFile);
    unlinkSync(releaseFile);
    writeFileSync(live, '[]');
    resetCliCaches();
    await refusesWithoutWrites('release', freshApprovalTask, releaseFile);
    await refusesWithoutWrites('release', task, releaseFile);
    writeFileSync(releaseFile, 'RELEASE-UNREADABLE\n');
    chmodSync(releaseFile, 0);
    try {
      assert.throws(() => readFileSync(releaseFile, 'utf8'));
      await refusesWithoutWrites('release', freshApprovalTask, releaseFile);
    } finally {
      chmodSync(releaseFile, 0o644);
    }
  } finally {
    restorePath();
    if (priorWarden === undefined) delete process.env.PROMPTOBUS_WARDEN;
    else process.env.PROMPTOBUS_WARDEN = priorWarden;
  }
});

// Each case: the declaration, the field the refusal must name, and the words that say why.
const REFUSED = [
  ['a second edits-tree step', { gates: [{ name: 'builder', kind: 'edits-tree' }] },
    'pipeline.gates[0].kind', /a second edits-tree step/],
  ['a duplicate name', { gates: [{ name: 'reviewer', kind: 'reads-diff' }, { name: 'reviewer', kind: 'reads-diff' }] },
    'pipeline.gates[1].name', /«reviewer» is already the name of pipeline\.gates\[0\]\.name/],
  ['a name outside the grammar', { gates: [{ name: 'Security', kind: 'reads-diff' }] },
    'pipeline.gates[0].name', /«Security» is not a step name: a step name is \^\[a-z\]/],
  ...GOVERNANCE.map((name) => [`the governance name ${name}`, { gates: [{ name, kind: 'reads-diff' }] },
    'pipeline.gates[0].name', new RegExp(`«${name}» is a governance role`)]),
  ['a missing instructions file', { gates: [{ name: 'security', kind: 'reads-diff', instructions: 'nowhere.md' }] },
    'pipeline.gates[0].instructions', /«nowhere\.md» is not a file/],
  ['an instructions path outside the install root',
    { gates: [{ name: 'security', kind: 'reads-diff', instructions: '../outside.md' }] },
    'pipeline.gates[0].instructions', /«\.\.\/outside\.md» is outside the install root/],
  ['a kind outside the three', { gates: [{ name: 'security', kind: 'reviews' }] },
    'pipeline.gates[0].kind', /«reviews» is not a step kind/],
  ['a floor outside 1–10', { gates: [{ name: 'security', kind: 'reads-diff', qualityFloor: 11 }] },
    'pipeline.gates[0].qualityFloor', /«11» is not a quality floor/],
  ['a shipped name under another kind',
    { owner: { name: 'builder', kind: 'edits-tree' }, gates: [{ name: 'worker', kind: 'reads-diff' }] },
    'pipeline.gates[0].name', /already admitted as edits-tree/],
  ['a name overlapping a step name', { gates: [{ name: 'reviewer-two', kind: 'reads-diff' }] },
    'pipeline.gates[0].name', /overlaps «reviewer»/],
  ['an owner of another kind', { owner: { name: 'worker', kind: 'reads-diff' }, gates: [] },
    'pipeline.owner.kind', /the owner step is of kind edits-tree/],
];

for (const [label, part, at, why] of REFUSED) {
  test(`refused, with the field named: ${label}`, async () => {
    const declaration = { owner: { name: 'worker', kind: 'edits-tree' }, ...part };
    const dir = workspace(declaration);
    const host = hostOf(dir);
    const expected = `pipeline-invalid · ${path.join(dir, 'promptobus.json')} · ${at}: `;
    let refusal = null;
    try { host.pipeline(); } catch (e) { refusal = e; }
    assert.ok(refusal instanceof bus.PromptobusError, 'the refusal is a PromptobusError');
    assert.equal(refusal.code, 'pipeline-invalid');
    const lines = refusal.message.split('\n');
    assert.deepEqual(lines.filter((l) => l.startsWith(expected)).length, 1, refusal.message);
    assert.match(lines.find((l) => l.startsWith(expected)), why);
    assert.throws(() => bus.registryOf(host), (e) => e.message === refusal.message, 'the registry is refused alike');

    const { err, refusal: closing } = await validateRefusal(host);
    const printed = err.split('\n').filter((l) => l.includes('pipeline-invalid · ')).map((l) => l.replace(/^✖ /, ''));
    assert.deepEqual(printed, lines, '`models validate` prints the load refusal\'s own lines');
    assert.equal(closing?.message, `the pipeline declaration does not hold: ${lines.length} finding(s) above`);
  });
}

test('the CLI speaks the refusal as lines: `models validate` and a command that asks for the registry', () => {
  const dir = workspace({ owner: { name: 'worker', kind: 'edits-tree' }, gates: [{ name: 'user', kind: 'reads-diff' }] });
  withTask(hostOf(dir));
  const line = `pipeline-invalid · ${path.join(realpathSync(dir), 'promptobus.json')} · pipeline.gates[0].name: «user» is a governance role`;
  const run = (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, env: process.env, encoding: 'utf8' });
  const validated = run(['models', 'validate']);
  assert.equal(validated.status, 1, validated.stderr);
  assert.ok(noAnsi(validated.stderr).includes(`✖ ${line}`), validated.stderr);
  const listed = run(['status', '--task', TASK]);
  assert.equal(listed.status, 1, listed.stderr);
  assert.ok(noAnsi(listed.stderr).includes(`✖ ${line}`), listed.stderr);
  assert.doesNotMatch(listed.stderr, /^\s+at /m, 'a refusal carries no stack');
});

test('the closing line of `models validate` names what does not hold: the stack, the declaration, or both', async () => {
  const bad = { owner: { name: 'worker', kind: 'edits-tree' }, gates: [{ name: 'user', kind: 'reads-diff' }] };
  const broken = (pipeline) => {
    const host = hostOf(workspace(pipeline));
    const layer = host.routingPaths().overlays.find((o) => o.writable);
    mkdirSync(path.dirname(layer.path), { recursive: true });
    writeFileSync(layer.path, 'not json');
    return host;
  };
  const stack = await validateRefusal(broken());
  assert.equal(stack.refusal?.message, 'the routing catalog stack does not hold: 1 finding(s) above');
  const both = await validateRefusal(broken(bad));
  assert.equal(both.refusal?.message, 'the routing catalog stack and the pipeline declaration do not hold: 2 finding(s) above');
  assert.equal(both.refusal?.code, 'overlay-invalid', 'the code is still the first finding\'s');
});

test('a host that answers steps the registry refuses is a finding on host · pipeline()', () => {
  const verdict = pipe.pipelineVerdict({ pipeline: () => [{ name: 'teamlead', kind: 'reads-diff' }] });
  assert.equal(verdict.steps, null);
  assert.match(verdict.findings[0].line, /^pipeline-invalid · host · pipeline\(\): step name «teamlead» is a governance role/);
  assert.deepEqual(pipe.pipelineVerdict(null), { steps: SHIPPED_STEPS, findings: [] });
});

test('the schema and the loader agree on shape; the loader alone refuses what JSON Schema cannot say', () => {
  const root = path.join(SB, 'schema-root');
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'security.md'), 'x\n');
  writeFileSync(path.join(root, 'docs', 'security-review.md'), 'x\n');
  const loads = (v) => pipe.readPipeline(v, { root, file: 'f' }).findings.length === 0;
  const owner = { name: 'worker', kind: 'edits-tree' };
  const gate = (fields) => ({ owner, gates: [{ name: 'security', kind: 'reads-diff', ...fields }] });
  const valid = [SECURITY, ...SCHEMA.examples, { owner, gates: [] }, { owner: { name: 'builder', kind: 'edits-tree' }, gates: [] }];
  const invalid = [
    null, [], { owner }, { gates: [] }, { owner, gates: [], extra: 1 }, { owner, gates: {} },
    { owner: { name: 'worker', kind: 'reads-diff' }, gates: [] },
    { owner: { ...owner, instructions: 'security.md' }, gates: [] },
    { owner: { name: 'worker' }, gates: [] },
    gate({ kind: 'edits-tree' }), gate({ kind: 'reviews' }), gate({ name: 'Security' }), gate({ name: '9lives' }),
    gate({ name: 'a'.repeat(33) }), ...GOVERNANCE.map((name) => gate({ name })),
    gate({ qualityFloor: 0 }), gate({ qualityFloor: 11 }), gate({ qualityFloor: 7.5 }), gate({ qualityFloor: '7' }),
    gate({ instructions: '' }), gate({ extra: true }),
  ];
  for (const v of valid) assert.deepEqual([ajv(v), loads(v)], [true, true], JSON.stringify(v));
  for (const v of invalid) assert.deepEqual([ajv(v), loads(v)], [false, false], JSON.stringify(v));
  const loaderOnly = [
    { owner, gates: [{ name: 'reviewer', kind: 'reads-diff' }, { name: 'reviewer', kind: 'reads-diff' }] },
    { owner: { name: 'security', kind: 'edits-tree' }, gates: [{ name: 'security', kind: 'reads-diff' }] },
    gate({ instructions: 'nowhere.md' }),
    gate({ instructions: '../outside.md' }),
    gate({ instructions: OUTSIDE }),
    { owner: { name: 'builder', kind: 'edits-tree' }, gates: [{ name: 'worker', kind: 'reads-diff' }] },
    { owner, gates: [{ name: 'reviewer-two', kind: 'reads-diff' }] },
  ];
  for (const v of loaderOnly) assert.deepEqual([ajv(v), loads(v)], [true, false], JSON.stringify(v));

  assert.equal(SCHEMA.$defs.name.pattern, pipe.STEP_NAME_PATTERN);
  assert.deepEqual(SCHEMA.$defs.name.not.enum, GOVERNANCE, 'the schema\'s governance names are the registry\'s');
  assert.deepEqual([SCHEMA.properties.owner.properties.kind.const, ...SCHEMA.$defs.gate.properties.kind.enum], [...bus.STEP_KINDS]);
  const floors = SCHEMA.$defs.gate.properties.qualityFloor.description;
  for (const kind of SCHEMA.$defs.gate.properties.kind.enum) {
    const e = SHIPPED.entries.find((x) => x.layer === 'step' && x.kind === kind);
    assert.ok(floors.includes(`${e.floor} for \`${kind}\``), `${kind}: ${floors}`);
  }
});

test('the declaration\'s name grammar is the registry door\'s', () => {
  const names = ['a', 'security', 'sec-2', 'a'.repeat(32), 'a'.repeat(33), 'Security', '9lives', '-x', 'sec_x', 'sec:x', ''];
  for (const name of names) {
    const loader = pipe.readPipeline({ owner: { name: 'worker', kind: 'edits-tree' }, gates: [{ name, kind: 'reads-diff' }] },
      { root: SB, file: 'f' }).findings.some((f) => /is not a step name/.test(f.message));
    let door = false;
    try { bus.withSteps(SHIPPED, [{ name, kind: 'reads-diff' }]); } catch (e) { door = /is not admitted/.test(e.message); }
    assert.equal(loader, door, `«${name}»: the loader and the door disagree`);
  }
});

test('a brief is accepted by a writes-main-tree step alone, a fact of the kind', () => {
  assert.deepEqual(bus.STEP_KINDS.map((kind) => pipe.acceptsBrief({ name: 'x', kind })), [false, false, true]);
  assert.deepEqual(pipe.pipelineOf(null).filter(pipe.acceptsBrief).map((s) => s.name), ['approver']);
});

test('the package entry carries what a consumer host needs to answer pipeline() from its own source', () => {
  for (const name of ['readPipeline', 'DEFAULT_PIPELINE', 'pipelineFinding', 'pipelineRefusal', 'pipelineOf', 'acceptsBrief']) {
    assert.equal(bus[name], pipe[name], `${name} is not exported from the package entry`);
  }
  const refusal = bus.pipelineRefusal([bus.pipelineFinding('host', 'pipeline()', 'x')]);
  assert.equal(refusal.code, bus.PIPELINE_INVALID);
  assert.equal(refusal.message, 'pipeline-invalid · host · pipeline(): x');
});
