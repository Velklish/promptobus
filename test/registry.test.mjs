// The role registry and every surface that reads it, walked per entry with steps declared in this
// file and handed over as a value: 04-protocol § The role registry names the surfaces. Run: npm test
import './home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { trackedCode } from './comment-scan.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { capture } from './console.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMAS = path.join(ROOT, 'schemas');
const readJson = (rel) => JSON.parse(readFileSync(path.join(SCHEMAS, rel), 'utf8'));

const bus = await import('../dist/index.js');
const { mcpTools } = await import('../dist/mcp/tools.js');
const store = await import('../lib/store.js');
const { hostOf } = await import('../lib/host.js');
const { refuseParticipantPrefix, spawn } = await import('../lib/spawn.js');
const { status } = await import('../lib/status.js');
const { sweep } = await import('../lib/sweep.js');
const { stop } = await import('../lib/stop.js');
const { dismiss } = await import('../lib/dismiss.js');
const { declaredParticipant } = await import('../lib/guard.js');
const { helpText } = await import('../lib/cli.js');
const { serviceFor } = await import('../lib/server.js');
const catalog = await import('../lib/model-routing/catalog.js');

const SHIPPED = bus.SHIPPED_REGISTRY;
const STEPS = [
  { name: 'worker', kind: bus.EDITS_TREE },
  { name: 'security', kind: bus.READS_DIFF },
  { name: 'merge', kind: bus.WRITES_MAIN_TREE },
];
const SB = makeSandbox('promptobus-test-registry-');
const WS = path.join(SB, 'ws');
writeHostConfig(WS);
const PLAIN = hostOf(WS);
const DECLARING = { ...PLAIN, pipeline: () => STEPS };
const REG = bus.registryOf(DECLARING);
const FOUR_STEPS = [
  { name: 'worker', kind: bus.EDITS_TREE },
  { name: 'security', kind: bus.READS_DIFF },
  { name: 'compliance', kind: bus.READS_DIFF },
  { name: 'merge', kind: bus.WRITES_MAIN_TREE },
];
const FOUR_HOST = { ...PLAIN, pipeline: () => FOUR_STEPS };
const FOUR_REG = bus.registryOf(FOUR_HOST);

test('the governance roles are the closed set the package fixes, and each has its address shape', () => {
  const governance = SHIPPED.entries.filter((e) => e.layer === 'governance');
  assert.deepEqual(governance.map((e) => [e.name, e.slug]), [
    ['orchestrator', false], ['teamlead', true], ['peer', true], ['reporter', false], ['user', false],
  ]);
  for (const e of governance) {
    assert.deepEqual(
      [e.kind, e.deny, e.hostDenyRole, e.floor, e.catalogRole, e.routed, e.lift],
      [null, 'none', null, null, null, false, null],
      `${e.name}: a governance role has no lift yet, so it carries no deny list, floor or catalog role`,
    );
  }
});

test('the shipped pipeline is today\'s three roles, stems, deny lists and floors', () => {
  assert.deepEqual([...bus.STEP_KINDS], ['edits-tree', 'reads-diff', 'writes-main-tree']);
  const steps = SHIPPED.entries.filter((e) => e.layer === 'step')
    .map((e) => [e.name, e.kind, e.stem, e.deny, e.hostDenyRole, e.floor, e.catalogRole, e.routed, e.lift]);
  assert.deepEqual(steps, [
    ['worker', 'edits-tree', 'slug', 'none', null, 5, 'worker', true, 'worker'],
    ['reviewer', 'reads-diff', 'prefixed', 'write-tools', 'reviewer', 9, 'reviewer', true, 'reviewer'],
    ['approver', 'writes-main-tree', 'prefixed', 'none', 'approver', 7, 'approver', true, 'approver'],
  ]);
  assert.deepEqual([bus.WORKER, bus.REVIEWER, bus.APPROVER], ['worker', 'reviewer', 'approver']);
  assert.equal(bus.addressList(SHIPPED), 'orchestrator, worker:<slug>, reviewer:<slug> or approver:<slug>');
  assert.ok(Object.isFrozen(SHIPPED) && Object.isFrozen(SHIPPED.entries), 'the shipped registry is a value');
});

// The card's own grep, widened to the `'<role>:'` and `<role>:<slug>` shapes and to every quote: a
// role word spelled outside the registry is a second copy of the contract, and this names its line.
test('no role word is spelled as a literal in lib/ or src/ outside the registry', () => {
  const { files } = trackedCode(ROOT, ['lib', 'src']);
  const LITERAL = /(['"`])(?:worker|reviewer|approver):?\1|\b(?:worker|reviewer|approver):<slug>/;
  const hits = [];
  for (const rel of files.filter((f) => f !== 'src/registry.ts')) {
    readFileSync(path.join(ROOT, rel), 'utf8').split('\n').forEach((line, i) => {
      if (LITERAL.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.ok(files.includes('lib/store.js') && files.includes('src/protocol.ts'), 'the walk read lib/ and src/');
  assert.deepEqual(hits, [], 'surfaces that keep their own copy of a role word');
});

test('catalog role enums agree with the shipped registry and record addresses have step grammar', () => {
  const roles = bus.routedCatalogRoles(SHIPPED);
  assert.deepEqual(roles, ['worker', 'reviewer', 'approver']);
  const catalogSchema = readJson('model-routing/catalog.schema.json');
  const overlay = readJson('model-routing/overlay.schema.json');
  const surfaces = {
    'catalog roles enum': catalogSchema.$defs.tuple.properties.roles.items.enum,
    'catalog roleRatings properties': Object.keys(catalogSchema.$defs.tuple.properties.roleRatings.properties),
    'overlay qualityFloor properties': Object.keys(overlay.properties.qualityFloor.properties),
    'overlay byRole properties': Object.keys(overlay.$defs.selectors.properties.byRole.properties),
    'decision role enum': readJson('model-routing/decision.schema.json').properties.role.enum,
    'telemetry role enum': readJson('model-routing/telemetry.schema.json').properties.role.enum,
  };
  for (const [name, value] of Object.entries(surfaces)) assert.deepEqual([...value], roles, name);
  const floors = Object.fromEntries(roles.map((role) => [role, bus.defaultFloor(SHIPPED, role)]));
  assert.deepEqual(overlay.examples.find((e) => e.qualityFloor)?.qualityFloor, floors, 'overlay example qualityFloor');
  const pattern = '^(orchestrator|[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*)$';
  assert.equal(readJson('v1/gate-record.schema.json').$defs.record.properties.by.pattern, pattern, 'gate-record by');
  assert.equal(readJson('v1/handover-record.schema.json').properties.by.pattern, pattern, 'handover-record by');
  for (const by of ['worker:x', 'security:x', 'compliance:x', 'merge:x']) {
    assert.match(by, new RegExp(pattern));
    assert.ok(bus.admitsAddress(FOUR_REG, by));
  }
  assert.match('stranger:x', new RegExp(pattern), 'the schema checks grammar, and send checks the registry');
  assert.ok(!bus.admitsAddress(FOUR_REG, 'stranger:x'));
});

test('the shipped texts print the shipped list, byte for byte', () => {
  const list = bus.addressList(SHIPPED);
  const send = mcpTools(SHIPPED).find((t) => t.name === 'promptobus_send');
  assert.ok(send.description.includes(`Address: ${list}.`), send.description);
  assert.equal(send.inputSchema.properties.to.description, `recipient address: ${list}`);
  assert.ok(helpText(PLAIN).includes('[--role <worker|reviewer|approver|step-name>]'));
  assert.deepEqual([...catalog.ROUTED_ROLES], bus.routedCatalogRoles(SHIPPED));
  assert.deepEqual({ ...catalog.DEFAULT_POLICY.qualityFloor }, { worker: 5, reviewer: 9, approver: 7 });
  assert.throws(() => bus.addrDir('boss'), (e) => e.message.endsWith(list));
});

test('the door refuses a name a declaration may not use, and never touches the registry it was given', () => {
  const refused = (name, kind) => assert.throws(() => bus.withSteps(SHIPPED, [{ name, kind }]), Error, `${name} ${kind}`);
  refused('Security', 'reads-diff');
  refused('9lives', 'reads-diff');
  refused('security', 'reviews');
  refused('teamlead', 'reads-diff');
  refused('reviewer', 'writes-main-tree');
  refused('reviewer-two', 'reads-diff');
  refused('peer-review', 'reads-diff');
  refused('worker-foo', 'edits-tree');
  assert.throws(() => bus.withSteps(SHIPPED, [{ name: 'worker-foo', kind: 'edits-tree' }]),
    /worker-foo:x and worker:foo-x would share one participant id/);
  for (const reg of [SHIPPED, REG]) {
    assert.ok(!(bus.admitsAddress(reg, 'worker-foo:x') && bus.admitsAddress(reg, 'worker:foo-x')),
      'one registry never admits two addresses with one participant id');
    const slugged = reg.entries.filter((e) => e.slug).map((e) => e.name);
    for (const x of slugged) for (const y of slugged) assert.ok(x === y || !y.startsWith(`${x}-`), `${y} overlaps ${x}`);
  }
  assert.equal(bus.withSteps(SHIPPED, [{ name: 'reviewer', kind: 'reads-diff' }]).entries.length, SHIPPED.entries.length);
  assert.equal(SHIPPED.entries.length, 8, 'the shipped value is unchanged by every call above');
});

test('a host that declares no pipeline, or no host, answers the shipped registry; a declaring host adds its steps', () => {
  assert.equal(typeof PLAIN.pipeline, 'undefined', 'no host answers pipeline() yet');
  assert.deepEqual(bus.registryOf(PLAIN), SHIPPED);
  assert.deepEqual(bus.registryOf(null), SHIPPED);
  assert.deepEqual(REG.entries.map((e) => e.name).slice(-2), ['security', 'merge']);
  for (const { name, kind } of STEPS) {
    const e = bus.roleEntry(REG, name);
    const model = SHIPPED.entries.find((m) => m.layer === 'step' && m.kind === kind);
    assert.deepEqual(
      [e.kind, e.slug, e.stem, e.deny, e.hostDenyRole, e.floor, e.catalogRole, e.routed, e.lift],
      [kind, true, name === 'worker' ? 'slug' : 'prefixed', model.deny, model.hostDenyRole, model.floor, model.catalogRole, model.routed, model.lift],
      name,
    );
  }
  assert.deepEqual(bus.routedCatalogRoles(REG), bus.routedCatalogRoles(SHIPPED), 'a step adds no catalog role');
});

test('the grammar admits every entry of any registry without an edit, and the registry decides who is known', () => {
  for (const e of REG.entries) {
    const address = e.slug ? `${e.name}:x-1` : e.name;
    assert.ok(bus.isAddress(address), `${address} parses`);
    assert.ok(!bus.isAddress(e.slug ? e.name : `${e.name}:x-1`), `${e.name}: only its own shape parses`);
    assert.equal(bus.roleOf(address), e.name);
    assert.equal(bus.addrDir(address), e.slug ? `${e.name}-x-1` : e.name);
    if (e.slug) assert.equal(bus.participantFileStem(address), e.stem === 'slug' ? 'x-1' : `${e.name}-x-1`);
    else assert.throws(() => bus.participantFileStem(address), new RegExp(e.name));
    const active = e.layer !== 'step' || STEPS.some((step) => step.name === e.name);
    assert.equal(bus.admitsAddress(REG, address), active, `${address} admission follows the active pipeline`);
  }
  assert.ok(bus.isAddress('boss:x') && !bus.admitsAddress(REG, 'boss:x'), 'an undeclared step parses and is not admitted');
  assert.ok(!bus.admitsAddress(SHIPPED, 'security:x'), 'a declared step is unknown to the shipped registry');
  assert.ok(!bus.isAddress('boss') && !bus.isAddress('user:x') && !bus.isAddress('orchestrator:x'),
    'a bare stranger and a slug on a slugless name stay refused by the grammar');
});

test('every entry passes through the reserved worker names, the record write, the deny list, the floor and the lift words', () => {
  for (const e of REG.entries) {
    const address = e.slug ? `${e.name}:x-1` : e.name;
    const taken = e.stem === 'prefixed' ? `${e.name}-x-1` : e.stem === 'name' ? e.name : null;
    const active = e.layer !== 'step' || !REG.activeSteps || REG.activeSteps.includes(e.name);
    if (taken && active) {
      assert.throws(() => refuseParticipantPrefix(taken, 'route', REG), new RegExp(`taken by the ${e.name}`), taken);
      assert.equal(bus.stemOwner(REG, taken), e);
    } else {
      assert.equal(refuseParticipantPrefix(taken ?? 'x-1', 'route', REG), taken ?? 'x-1');
    }
    if (active) {
      assert.equal(store.participantRecord(address, {}, REG).role, e.name);
    } else {
      assert.throws(() => store.participantRecord(address, {}, REG), /invalid participant address/);
    }
    const tools = ['Edit', 'Bash'];
    assert.equal(bus.packageDenyTools(REG, e.name, tools) === tools, e.deny === 'write-tools', e.name);
    assert.equal(bus.defaultFloor(REG, e.name), e.floor, e.name);
    if (e.routed) assert.equal(catalog.DEFAULT_POLICY.qualityFloor[e.catalogRole], e.floor, `${e.name} floor`);
    assert.deepEqual(bus.liftWords(REG, e.name), e.lift ? { nom: e.lift, acc: `the ${e.lift}` } : null, e.name);
  }
  assert.deepEqual(bus.liftWords(REG, 'security'), { nom: 'reviewer', acc: 'the reviewer' }, 'a step is announced with its kind\'s words');
  assert.throws(() => store.participantRecord('security:x'), /invalid participant address "security:x" — expected orchestrator/);
  assert.throws(() => store.participantRecord('boss:x', {}, REG), /invalid participant address/);
  for (const name of ['security', 'compliance', 'merge']) {
    assert.throws(() => refuseParticipantPrefix(`${name}-x`, 'route', FOUR_REG),
      new RegExp(`taken by the ${name}`));
  }
  assert.equal(refuseParticipantPrefix('reviewer-x', 'route', FOUR_REG), 'reviewer-x',
    'a shipped gate omitted by the declaration does not reserve an owner slug');
});

test('spawn refuses a departed step prefix while its participant still owns the file stem', async () => {
  const root = path.join(SB, 'spawn-collision');
  writeHostConfig(root);
  const host = { ...hostOf(root), pipeline: () => FOUR_STEPS };
  const repo = path.join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
    { cwd: repo, encoding: 'utf8' });
  assert.equal(git('init', '-q', '-b', 'main').status, 0);
  writeFileSync(path.join(repo, 'base.txt'), 'base');
  assert.equal(git('add', '.').status, 0);
  assert.equal(git('commit', '-qm', 'base').status, 0);
  const brief = path.join(root, 'brief.md');
  writeFileSync(brief, 'A new owner piece');
  const home = host.promptobusHome();
  store.bus(home, { cli: '0.5.1' });
  const task = store.createTask(home, {
    id: 'registry-spawn-collision-t20260926-120000', title: 'changed pipeline', owner: null,
  });
  store.upsertParticipant(home, task.id, store.participantRecord('reviewer:x', {}, SHIPPED));
  const mcp = store.participantMcpPath(home, task.id, 'reviewer:x');
  const settings = store.participantSettingsPath(home, task.id, 'reviewer:x');
  mkdirSync(path.dirname(mcp), { recursive: true });
  writeFileSync(mcp, 'old reviewer config');
  writeFileSync(settings, 'old reviewer settings');
  await assert.rejects(() => spawn(host, {
    repo: 'repo', brief, task: task.id, worker: 'reviewer-x',
    tool: { ok: false, reason: 'fixture tool must not run' },
  }), /owner step name "reviewer-x" shares workers\/reviewer-x\.mcp\.json with existing participant reviewer:x/);
  assert.equal(readFileSync(mcp, 'utf8'), 'old reviewer config');
  assert.equal(readFileSync(settings, 'utf8'), 'old reviewer settings');
  assert.ok(!store.participantOf(store.readTask(home, task.id), 'worker:reviewer-x'));
  const allowed = await capture(() => spawn(host, {
    repo: 'repo', brief, task: task.id, worker: 'reviewer-y', dryRun: true,
  }));
  assert.match(allowed, /worker address: worker:reviewer-y/);

  const secondRepo = path.join(root, 'reviewer');
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', secondRepo], { encoding: 'utf8' }).status, 0);
  store.upsertParticipant(home, task.id, store.participantRecord('worker:reviewer', { repo: 'other/repo' }, SHIPPED));
  store.upsertParticipant(home, task.id, store.participantRecord('reviewer:2', {}, SHIPPED));
  await assert.rejects(() => spawn(host, {
    repo: 'reviewer', brief, task: task.id,
    tool: { ok: false, reason: 'fixture tool must not run' },
  }), /owner step name "reviewer-2" shares workers\/reviewer-2\.mcp\.json with existing participant reviewer:2/);
});

test('a renamed owner checks the file stem of its declared address', () => {
  const registry = bus.registryOf({ ...PLAIN, pipeline: () => [
    { name: 'builder', kind: bus.EDITS_TREE }, ...FOUR_STEPS.slice(1),
  ] });
  const participants = [store.participantRecord('worker:builder-x', {}, SHIPPED)];
  assert.throws(() => refuseParticipantPrefix('x', 'route', registry, participants,
    (slug) => `builder:${slug}`),
  /owner step name "x" shares workers\/builder-x\.mcp\.json with existing participant worker:builder-x/);
});

test('the host-bearing doors follow the host\'s registry: identity, the MCP send, the texts', () => {
  const home = path.join(SB, 'doors', '.promptobus');
  store.bus(home, { cli: '0.5.1' });
  const task = store.createTask(home, { id: 'doors-t20260926-120000', title: 'doors', owner: null });
  store.upsertParticipant(home, task.id, store.participantRecord('security:x', { repo: 'ns/repo' }, REG));
  const identity = (host) => store.resolveIdentity(
    { PROMPTOBUS_HOME: home, PROMPTOBUS_ROLE: 'security:x' }, SB, { move: false, host },
  );
  assert.equal(identity(DECLARING).role, 'security:x');
  assert.throws(() => identity(PLAIN), /PROMPTOBUS_ROLE="security:x" — expected orchestrator, worker:<slug>, reviewer:<slug> or approver:<slug>$/);
  const send = (host, to) => serviceFor(host).send(home, task.id, { from: 'orchestrator', to, type: 'status', body: 'x' });
  assert.ok(send(DECLARING, 'security:x').message.id, 'a declared step receives mail');
  assert.throws(() => send(PLAIN, 'security:x'), /unknown recipient address "security:x"/);
  assert.throws(() => send(DECLARING, 'boss:x'), (e) => e.message.endsWith(`"boss:x" — ${bus.addressList(REG)}`));
  assert.equal(bus.addressList(REG), 'orchestrator, worker:<slug>, security:<slug> or merge:<slug>');
  const declaredSend = mcpTools(REG).find((tool) => tool.name === 'promptobus_send');
  assert.ok(declaredSend.description.includes(`Address: ${bus.addressList(REG)}.`));
  assert.equal(declaredSend.inputSchema.properties.to.description, `recipient address: ${bus.addressList(REG)}`);
  assert.ok(!declaredSend.description.includes('reviewer:<slug>'));
});

test('the record-bearing surfaces stay on the shipped step names until rights are keyed by kind', () => {
  assert.ok(declaredParticipant({ role: 'worker:x' }) && !declaredParticipant({ role: 'security:x' }));
  for (const e of SHIPPED.entries) {
    assert.equal(declaredParticipant({ role: e.slug ? `${e.name}:x` : e.name }), e.layer === 'step', e.name);
  }
  assert.equal(bus.readableName(null, 'reviewer:x-1'), 'x-1');
  assert.equal(bus.readableName(null, 'teamlead:x-1'), 'teamlead:x-1', 'a governance address prints whole');
  assert.equal(bus.readableName(null, 'security:x-1'), 'security:x-1');
});

test('routing: declared steps use the vertical route; governance exceptions stay closed without links', () => {
  const home = path.join(SB, 'routes', '.promptobus');
  store.bus(home, { cli: '0.5.1' });
  const task = store.createTask(home, { id: 'registry-t20260926-120000', title: 'registry', owner: null });
  for (const address of ['worker:x', 'security:x', 'teamlead:x', 'peer:x', 'reporter', 'user']) {
    store.upsertParticipant(home, task.id, store.participantRecord(address, {
      repo: 'ns/repo', ...(address === 'peer:x' ? { sessionId: 'peer-session', peerTask: 'other-root' } : {}),
    }, REG));
  }
  const send = (from, to, type = 'status') => {
    try {
      store.sendMessage(home, task.id, {
        from, to, type, body: `${from} → ${to}`,
        ...(from === 'peer:x' ? { session: 'peer-session' } : {}),
      });
      return 'sent';
    } catch (e) {
      return e.message.includes('root orchestrator') || e.message.includes('do not write to each other')
        ? 'refused' : e.message;
    }
  };
  for (const address of ['security:x', 'teamlead:x']) {
    assert.equal(send(address, store.ORCHESTRATOR), 'sent', `${address} → orchestrator`);
    assert.equal(send(store.ORCHESTRATOR, address), 'sent', `orchestrator → ${address}`);
    assert.equal(send(address, 'worker:x'), 'refused', `${address} → worker`);
    assert.equal(send('worker:x', address), 'refused', `worker → ${address}`);
  }
  assert.equal(send('peer:x', store.ORCHESTRATOR), 'refused', 'an unlinked peer cannot write to the orchestrator');
  assert.equal(send(store.ORCHESTRATOR, 'peer:x'), 'refused', 'the orchestrator cannot write to an unlinked peer');
  assert.equal(send('reporter', store.ORCHESTRATOR), 'refused', 'reporter sends nothing');
  assert.equal(send(store.ORCHESTRATOR, 'reporter'), 'sent', 'reporter can receive');
  assert.equal(send('user', store.ORCHESTRATOR, 'question'), 'sent', 'user asks');
  assert.equal(send('user', store.ORCHESTRATOR), 'refused', 'user cannot send status');
  assert.equal(send(store.ORCHESTRATOR, 'user'), 'sent', 'user receives status');
  assert.equal(send(store.ORCHESTRATOR, 'user', 'question'), 'refused', 'user does not receive question');
});

test('status groups each piece and prints four declared steps in pipeline order with session state', () => {
  const home = FOUR_HOST.promptobusHome();
  store.bus(home, { cli: '0.5.1' });
  const task = store.createTask(home, {
    id: 'registry-order-t20260926-120000', title: 'pipeline order', owner: null,
  });
  const addresses = [
    'worker:a', 'worker:b', 'merge:a', 'compliance:a', 'security:b',
    'compliance:b', 'security:a', 'merge:b',
  ];
  for (const address of addresses) {
    store.upsertParticipant(home, task.id, store.participantRecord(address, {
      name: `session-${address}`, sessionRef: `ref-${address}`, harness: 'claude',
    }, FOUR_REG));
  }
  const output = capture(() => status(FOUR_HOST, { task: task.id, sessions: {} }));
  const actual = output.split('\n').flatMap((line) => {
    const address = addresses.find((candidate) => line.includes(`${candidate} ·`));
    return address ? [address] : [];
  });
  assert.deepEqual(actual, [
    'worker:a', 'security:a', 'compliance:a', 'merge:a',
    'worker:b', 'security:b', 'compliance:b', 'merge:b',
  ], output);
  assert.match(output, /security:a ·.*session "session-security:a" is not in the list/);
});

test('send checks both record by fields against the declared registry after generic schema validation', () => {
  const home = path.join(SB, 'records', '.promptobus');
  store.bus(home, { cli: '0.5.1' });
  const task = store.createTask(home, {
    id: 'registry-records-t20260926-120000', title: 'record addresses', owner: null,
  });
  store.upsertParticipant(home, task.id, store.participantRecord('security:x', {}, FOUR_REG));
  const at = '2026-09-26T12:00:00.000Z';
  const sha = 'a'.repeat(40);
  const gate = (by) => ({ schemaVersion: 1, records: [
    { command: 'npm test', exit: 0, tree: sha, dirty: false, at, by: 'security:x' },
    { command: 'npm run audit', exit: 0, tree: sha, dirty: false, at, by },
  ] });
  const checks = Object.fromEntries(['verdictNames', 'mutationProbe', 'treeState',
    'environmentalRed', 'gatesNotRun'].map((name) => [name, { notRun: 'No run in this fixture' }]));
  const handover = (by) => ({ schemaVersion: 1, tree: sha, base: sha, at, by, checks });
  const send = (name, document, registry = FOUR_REG) => {
    const file = path.join(SB, 'records', name);
    writeFileSync(file, JSON.stringify(document));
    return store.sendMessage(home, task.id, {
      from: 'security:x', to: 'orchestrator', type: 'artifact', body: name, artifactPath: file,
    }, { status: 'status', registry });
  };
  assert.ok(send('gates-security.json', gate('security:x')).artifact);
  assert.ok(send('handover-security.json', handover('security:x')).artifact);
  assert.throws(() => send('gates-stranger.json', gate('stranger:x')),
    /by address «stranger:x», which this task's registry does not admit/);
  assert.throws(() => send('handover-stranger.json', handover('stranger:x')),
    /by address «stranger:x», which this task's registry does not admit/);
  assert.throws(() => send('gates-inactive.json', gate('security:x'), SHIPPED),
    /by address «security:x», which this task's registry does not admit/);
  assert.equal(readdirSync(store.artifactsDir(home, task.id)).filter((name) => name.endsWith('.json')).length, 2);

  const builderHost = { ...PLAIN, pipeline: () => [
    { name: 'builder', kind: bus.EDITS_TREE },
    ...FOUR_STEPS.slice(1),
  ] };
  const builderRegistry = bus.registryOf(builderHost);
  const builderTask = store.createTask(home, {
    id: 'registry-builder-t20260926-120000', title: 'renamed owner records', owner: null,
  });
  store.upsertParticipant(home, builderTask.id, store.participantRecord('builder:x', {}, builderRegistry));
  const sendBuilder = (name, document, registry) => {
    const file = path.join(SB, 'records', name);
    writeFileSync(file, JSON.stringify(document));
    return store.sendMessage(home, builderTask.id, {
      from: 'builder:x', to: 'orchestrator', type: 'artifact', body: name, artifactPath: file,
    }, { status: 'status', registry });
  };
  assert.ok(sendBuilder('gates-builder.json', gate('builder:x'), builderRegistry).artifact);
  assert.ok(sendBuilder('handover-builder.json', handover('builder:x'), builderRegistry).artifact);
  assert.throws(() => sendBuilder('gates-builder-undeclared.json', gate('builder:x'), FOUR_REG),
    /by address «builder:x», which this task's registry does not admit/);
  assert.throws(() => sendBuilder('handover-builder-undeclared.json', handover('builder:x'), FOUR_REG),
    /by address «builder:x», which this task's registry does not admit/);
});

test('dismiss, stop and sweep accept a declared gate and sweep keeps its owner tree', async () => {
  const root = path.join(SB, 'cleanup');
  writeHostConfig(root);
  const host = { ...hostOf(root), pipeline: () => FOUR_STEPS };
  const registry = bus.registryOf(host);
  const home = host.promptobusHome();
  store.bus(home, { cli: '0.5.1' });
  const ownerSession = 'registry-owner-session';
  const task = store.createTask(home, {
    id: 'registry-cleanup-t20260926-120000', title: 'declared gate cleanup', owner: ownerSession,
  });
  const repo = path.join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
    { cwd: repo, encoding: 'utf8' });
  assert.equal(git('init', '-q', '-b', 'main').status, 0);
  writeFileSync(path.join(repo, 'base.txt'), 'base');
  assert.equal(git('add', '.').status, 0);
  assert.equal(git('commit', '-qm', 'base').status, 0);
  const ownerTree = path.join(root, 'owner-tree');
  const ownerBranch = 'worktree-promptobus-owner';
  assert.equal(git('worktree', 'add', '-q', '-b', ownerBranch, ownerTree).status, 0);
  store.upsertParticipant(home, task.id, store.participantRecord('worker:x', {
    worktree: ownerTree, repoAbs: repo,
  }, registry));
  store.upsertParticipant(home, task.id, store.participantRecord('security:x', {
    harness: 'claude', mode: 'managed', sessionRef: 'security-session',
    worktree: ownerTree, repoAbs: repo,
  }, registry));
  let alive = true;
  const calls = [];
  const driver = {
    id: 'claude',
    capabilities: { spawn: true, attach: false, activation: 'push', inspect: true, stop: true,
      denyTools: true, systemPrompt: true, sessionList: true, enter: true },
    phrases: { sessions: 'sessions', unreadable: 'unreadable' },
    inspect: () => ({ state: alive ? 'alive' : 'gone', busy: false, stall: null,
      id: 'security-session', note: null }),
    stop: (ref) => { calls.push(ref); alive = false; return { ok: true, stopped: true, note: 'closed' }; },
  };
  const drivers = bus.createRegistry({ drivers: { claude: driver }, fallback: 'claude' });
  const proof = path.join(root, 'security-proof.txt');
  writeFileSync(proof, 'security proof');
  const artifact = store.sendMessage(home, task.id, {
    from: 'security:x', to: 'orchestrator', type: 'artifact', body: 'proof', artifactPath: proof,
  }, { status: 'status', registry });
  const mcp = store.participantMcpPath(home, task.id, 'security:x');
  const settings = store.participantSettingsPath(home, task.id, 'security:x');
  mkdirSync(path.dirname(mcp), { recursive: true });
  writeFileSync(mcp, '{}');
  writeFileSync(settings, '{}');
  store.bindSessionIdentity(() => ({ id: ownerSession }));
  try {
    assert.match(capture(() => dismiss(host, { task: task.id, address: 'security:x' })),
      /security:x dismissed from watch/);
    assert.match(await capture(() => stop(host, { task: task.id, address: 'security:x' },
      { registry: drivers })), /session of participant security:x closed/);
    assert.deepEqual(calls, ['security-session']);
    assert.match(capture(() => sweep(host, { task: task.id, address: 'security:x' },
      { registry: drivers })), /artifacts of security:x removed/);
  } finally {
    store.bindSessionIdentity(null);
  }
  assert.ok(existsSync(path.join(ownerTree, 'base.txt')));
  assert.equal(git('show-ref', '--verify', `refs/heads/${ownerBranch}`).status, 0);
  assert.ok(!existsSync(mcp) && !existsSync(settings));
  assert.ok(!existsSync(path.join(store.artifactsDir(home, task.id), `${artifact.artifact.id}.json`)));
  assert.equal(readdirSync(store.blobsDir(home, task.id)).filter((name) => !name.startsWith('.')).length, 0);
});

function gateSweepFixture(label, ownerName) {
  const root = path.join(SB, `gate-sweep-${label}`);
  writeHostConfig(root);
  const steps = [{ name: ownerName, kind: bus.EDITS_TREE }, ...FOUR_STEPS.slice(1)];
  const host = { ...hostOf(root), pipeline: () => steps };
  const registry = bus.registryOf(host);
  const home = host.promptobusHome();
  store.bus(home, { cli: '0.5.1' });
  const ownerSession = `registry-owner-${label}`;
  const task = store.createTask(home, {
    id: `registry-gate-sweep-${label}-t20260926-120000`, title: 'main-tree gate cleanup', owner: ownerSession,
  });
  const repo = path.join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
    { cwd: repo, encoding: 'utf8' });
  assert.equal(git('init', '-q', '-b', 'main').status, 0);
  writeFileSync(path.join(repo, 'base.txt'), 'base');
  assert.equal(git('add', '.').status, 0);
  assert.equal(git('commit', '-qm', 'base').status, 0);
  const ownerTree = path.join(root, 'owner-tree');
  const ownerBranch = `worktree-promptobus-owner-${label}`;
  assert.equal(git('worktree', 'add', '-q', '-b', ownerBranch, ownerTree).status, 0);
  store.upsertParticipant(home, task.id, store.participantRecord(`${ownerName}:x`, {
    worktree: ownerTree, repoAbs: repo,
  }, registry));
  const ownerMcp = store.participantMcpPath(home, task.id, `${ownerName}:x`);
  mkdirSync(path.dirname(ownerMcp), { recursive: true });
  writeFileSync(ownerMcp, 'owner config');
  const driver = {
    id: 'claude', capabilities: { inspect: true }, phrases: { sessions: 'sessions', unreadable: 'unreadable' },
    inspect: () => ({ state: 'gone', busy: false, stall: null, id: null, note: null }),
  };
  const drivers = bus.createRegistry({ drivers: { claude: driver }, fallback: 'claude' });
  const addGate = (address, worktree) => {
    store.upsertParticipant(home, task.id, store.participantRecord(address, {
      harness: 'claude', mode: 'managed', sessionRef: `session-${address}`,
      worktree, repoAbs: repo,
    }, registry));
    const proof = path.join(root, `${address.replace(':', '-')}-proof.txt`);
    writeFileSync(proof, 'gate proof');
    const artifact = store.sendMessage(home, task.id, {
      from: address, to: 'orchestrator', type: 'artifact', body: 'proof', artifactPath: proof,
    }, { status: 'status', registry });
    const mcp = store.participantMcpPath(home, task.id, address);
    const settings = store.participantSettingsPath(home, task.id, address);
    mkdirSync(path.dirname(mcp), { recursive: true });
    writeFileSync(mcp, 'gate config');
    writeFileSync(settings, 'gate settings');
    return { artifact, mcp, settings };
  };
  const sweepGate = (address) => {
    store.bindSessionIdentity(() => ({ id: ownerSession }));
    try { return capture(() => sweep(host, { task: task.id, address }, { registry: drivers })); }
    finally { store.bindSessionIdentity(null); }
  };
  const filesGone = ({ artifact, mcp, settings }) => {
    assert.ok(!existsSync(mcp) && !existsSync(settings));
    assert.ok(!existsSync(path.join(store.artifactsDir(home, task.id), `${artifact.artifact.id}.json`)));
    assert.equal(readdirSync(store.blobsDir(home, task.id)).filter((name) => !name.startsWith('.')).length, 0);
  };
  return { root, repo, git, home, task, ownerTree, ownerBranch, ownerMcp, addGate, sweepGate, filesGone };
}

for (const ownerName of ['worker', 'builder']) {
  test(`sweep of a main-tree gate keeps the ${ownerName} owner tree and clears gate files`, () => {
    const fixture = gateSweepFixture(`owner-${ownerName}`, ownerName);
    const gateTree = ownerName === 'builder' ? path.join(fixture.root, 'owner-alias') : fixture.ownerTree;
    if (ownerName === 'builder') {
      symlinkSync(fixture.ownerTree, gateTree, 'dir');
      assert.notEqual(gateTree, fixture.ownerTree);
      assert.equal(realpathSync(gateTree), realpathSync(fixture.ownerTree));
    }
    const gate = fixture.addGate('merge:x', gateTree);
    const output = fixture.sweepGate('merge:x');
    assert.match(output, /belongs to the owner step and stays in place/);
    assert.match(output, /artifacts of merge:x removed/);
    assert.ok(existsSync(path.join(fixture.ownerTree, 'base.txt')));
    assert.equal(fixture.git('show-ref', '--verify', `refs/heads/${fixture.ownerBranch}`).status, 0);
    assert.equal(readFileSync(fixture.ownerMcp, 'utf8'), 'owner config');
    fixture.filesGone(gate);
  });
}

test('sweep of a main-tree gate removes its own separate accepted tree and branch', () => {
  const fixture = gateSweepFixture('separate', 'worker');
  const gateTree = path.join(fixture.root, 'gate-tree');
  const gateBranch = 'worktree-promptobus-gate-separate';
  assert.equal(fixture.git('worktree', 'add', '-q', '-b', gateBranch, gateTree).status, 0);
  const gate = fixture.addGate('merge:x', gateTree);
  const output = fixture.sweepGate('merge:x');
  assert.match(output, /worktree .* removed .*branch worktree-promptobus-gate-separate deleted/);
  assert.ok(!existsSync(gateTree));
  assert.notEqual(fixture.git('show-ref', '--verify', `refs/heads/${gateBranch}`).status, 0);
  assert.ok(existsSync(fixture.ownerTree));
  fixture.filesGone(gate);
});
