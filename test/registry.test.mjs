// The role registry and every surface that reads it, walked per entry with steps declared in this
// file and handed over as a value: 04-protocol § The role registry names the surfaces. Run: npm test
import './home.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { trackedCode } from './comment-scan.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMAS = path.join(ROOT, 'schemas');
const readJson = (rel) => JSON.parse(readFileSync(path.join(SCHEMAS, rel), 'utf8'));

const bus = await import('../dist/index.js');
const { MCP_TOOLS } = await import('../dist/mcp/tools.js');
const store = await import('../lib/store.js');
const { hostOf } = await import('../lib/host.js');
const { refuseParticipantPrefix } = await import('../lib/spawn.js');
const { declaredParticipant } = await import('../lib/guard.js');
const { helpText } = await import('../lib/cli.js');
const { serviceFor } = await import('../lib/server.js');
const catalog = await import('../lib/model-routing/catalog.js');

const SHIPPED = bus.SHIPPED_REGISTRY;
const STEPS = [{ name: 'security', kind: bus.READS_DIFF }, { name: 'merge', kind: bus.WRITES_MAIN_TREE }];
const SB = makeSandbox('promptobus-test-registry-');
const WS = path.join(SB, 'ws');
writeHostConfig(WS);
const PLAIN = hostOf(WS);
const DECLARING = { ...PLAIN, pipeline: () => STEPS };
const REG = bus.registryOf(DECLARING);

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

test('every schema role enum and address pattern agrees with the shipped registry', () => {
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
  const names = bus.pipelineAddressNames(SHIPPED);
  const bare = names.filter((n) => !bus.roleEntry(SHIPPED, n).slug);
  const slugged = names.filter((n) => bus.roleEntry(SHIPPED, n).slug);
  const pattern = `^(${bare.join('|')}|(?:${slugged.join('|')}):[a-z0-9][a-z0-9-]*)$`;
  assert.equal(readJson('v1/gate-record.schema.json').$defs.record.properties.by.pattern, pattern, 'gate-record by');
  assert.equal(readJson('v1/handover-record.schema.json').properties.by.pattern, pattern, 'handover-record by');
});

test('the shipped texts print the shipped list, byte for byte', () => {
  const list = bus.addressList(SHIPPED);
  const send = MCP_TOOLS.find((t) => t.name === 'promptobus_send');
  assert.ok(send.description.includes(`Address: ${list}.`), send.description);
  assert.equal(send.inputSchema.properties.to.description, `recipient address: ${list}`);
  assert.ok(helpText(PLAIN).includes('[--role <worker|reviewer|approver>]'));
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
      [kind, true, 'prefixed', model.deny, model.hostDenyRole, model.floor, model.catalogRole, model.routed, model.lift],
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
    assert.ok(bus.admitsAddress(REG, address), `${address} is admitted by the declaring registry`);
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
    if (taken) {
      assert.throws(() => refuseParticipantPrefix(taken, 'route', REG), new RegExp(`taken by the ${e.name}`), taken);
      assert.equal(bus.stemOwner(REG, taken), e);
    } else {
      assert.equal(refuseParticipantPrefix('x-1', 'route', REG), 'x-1');
    }
    assert.equal(store.participantRecord(address, {}, REG).role, e.name);
    const tools = ['Edit', 'Bash'];
    assert.equal(bus.packageDenyTools(REG, e.name, tools) === tools, e.deny === 'write-tools', e.name);
    assert.equal(bus.defaultFloor(REG, e.name), e.floor, e.name);
    if (e.routed) assert.equal(catalog.DEFAULT_POLICY.qualityFloor[e.catalogRole], e.floor, `${e.name} floor`);
    assert.deepEqual(bus.liftWords(REG, e.name), e.lift ? { nom: e.lift, acc: `the ${e.lift}` } : null, e.name);
  }
  assert.deepEqual(bus.liftWords(REG, 'security'), { nom: 'reviewer', acc: 'the reviewer' }, 'a step is announced with its kind\'s words');
  assert.throws(() => store.participantRecord('security:x'), /invalid participant address "security:x" — expected orchestrator/);
  assert.throws(() => store.participantRecord('boss:x', {}, REG), /invalid participant address/);
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
  assert.equal(bus.addressList(REG), 'orchestrator, worker:<slug>, reviewer:<slug>, approver:<slug>, security:<slug> or merge:<slug>');
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

test('routing: a reads-diff step and every governance role stay on the orchestrator route', () => {
  const home = path.join(SB, 'routes', '.promptobus');
  store.bus(home, { cli: '0.5.1' });
  const task = store.createTask(home, { id: 'registry-t20260926-120000', title: 'registry', owner: null });
  for (const address of ['worker:x', 'security:x', 'teamlead:x', 'peer:x', 'reporter', 'user']) {
    store.upsertParticipant(home, task.id, store.participantRecord(address, { repo: 'ns/repo' }, REG));
  }
  const send = (from, to) => {
    try {
      store.sendMessage(home, task.id, { from, to, type: 'status', body: `${from} → ${to}` });
      return 'sent';
    } catch (e) {
      return /do not write to each other/.test(e.message) ? 'refused' : e.message;
    }
  };
  for (const address of ['security:x', 'teamlead:x', 'peer:x', 'reporter', 'user']) {
    assert.equal(send(address, store.ORCHESTRATOR), 'sent', `${address} → orchestrator`);
    assert.equal(send(store.ORCHESTRATOR, address), 'sent', `orchestrator → ${address}`);
    assert.equal(send(address, 'worker:x'), 'refused', `${address} → worker`);
    assert.equal(send('worker:x', address), 'refused', `worker → ${address}`);
  }
});
