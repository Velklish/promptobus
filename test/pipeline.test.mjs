// The pipeline declaration of `promptobus.json`: the default, a declared order on every surface that
// prints it, each refusal with its field, and the schema against the loader on one case list. Run: npm test
import './home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { captureSplit } from './console.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

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
    { name: 'security', kind: 'reads-diff' }, { name: 'approver', kind: 'writes-main-tree' },
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
