import './home.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { captureRolePrompts } from './role-prompts.mjs';
import { schemaErrors } from '../lib/schema.js';

const baseline = JSON.parse(readFileSync(new URL('./fixtures/participant-prompts/roles.json', import.meta.url), 'utf8'));
const actual = await captureRolePrompts();
for (const [harness, roles] of Object.entries(baseline)) {
  for (const [role, prompt] of Object.entries(roles)) {
    test(`${harness} ${role} retains the complete pre-extraction output`, () => {
      assert.equal(actual[harness][role], prompt);
    });
  }
}
test('the public entry exports six portable role renderers', async () => {
  const instructions = await import('promptobus/instructions');
  for (const role of ['Worker', 'Reviewer', 'Approver', 'Teamlead', 'Reporter', 'Orchestrator']) {
    assert.equal(typeof instructions[`render${role}Instructions`], 'function');
  }
});
test('BB skills retain the shared role protocol outside the dynamic instruction limit', async () => {
  const { BB_ROLE_SKILLS, renderBbInstructionSkill } = await import('promptobus/instructions');
  for (const [role, name] of Object.entries(BB_ROLE_SKILLS)) {
    const body = renderBbInstructionSkill(role);
    const skill = readFileSync(new URL(`../bb-plugin-promptobus/skills/${name}/SKILL.md`, import.meta.url), 'utf8');
    assert.ok(skill.endsWith(body.trimEnd() + '\n'));
    assert.match(body, /not a participant binding or permission grant/);
    assert.doesNotMatch(body, /warden|MCP-server|MCP server|Stop hooks are required|where promptobus\.json lives|\.claude\/worktrees|spawn created/);
    if (role !== 'reporter') assert.match(body, /mailbox|mail.*turn/s);
    if (['worker', 'reviewer', 'approver'].includes(role)) {
      for (const field of ['Done', 'Gate', 'Open', 'Decide']) assert.ok(body.includes(`**${field}**`));
    }
    if (role === 'reviewer') {
      assert.match(body, /critical\|major\|minor/);
      assert.match(body, /no mechanical checks/);
      assert.match(body, /mutation probe|mutationProbe/);
      assert.doesNotMatch(body, /every name is pre-approved/);
    }
  }
  assert.ok(renderBbInstructionSkill('worker').length > 4096);
  assert.ok(renderBbInstructionSkill('reviewer').length > 4096);
});
test('BB runtime context keeps exact task, tools, snapshot and long assignment without changing native prompts', async () => {
  const { createBbInstructionDelivery } = await import('promptobus/instructions');
  const context = { taskId: 'bb-task', address: 'worker:bb', environmentId: 'env_bb', workspace: '/owned',
    assignment: 'Exact long assignment.\n'.repeat(1000), tools: { promptobus_send: 'actual_send', promptobus_mailbox: 'actual_mail', promptobus_task: 'actual_task' },
    snapshot: { head: 'a'.repeat(40), base: 'b'.repeat(40), dirty: false, diffPath: '/evidence/review.diff' }, gateRecords: ['/evidence/gates.json'] };
  const delivery = createBbInstructionDelivery('worker', context);
  assert.ok(delivery.configuration.instructions.length < 4096);
  assert.deepEqual(delivery.configuration.tools, []);
  assert.deepEqual(delivery.configuration.skills, ['promptobus-worker']);
  assert.deepEqual(JSON.parse(delivery.initialPrompt.split('\n\n')[1]), context);
  const changed = createBbInstructionDelivery('worker', { ...context, tools: { ...context.tools, promptobus_send: 'different_send' } });
  assert.notEqual(changed.initialPrompt, delivery.initialPrompt);
  assert.deepEqual(await captureRolePrompts(), actual);
});
test('BB approver contact policy follows registered runtime contacts instead of assuming no worker', async () => {
  const { renderBbInstructionSkill, createBbInstructionDelivery } = await import('promptobus/instructions');
  const body = renderBbInstructionSkill('approver');
  assert.doesNotMatch(body, /There is no worker address registered/);
  assert.match(body, /When the authenticated contacts register a worker/);
  assert.match(body, /Without a registered worker, write to the orchestrator only/);
  const context = { taskId:'task', address:'approver:bb', environmentId:'env', workspace:'/owned', assignment:'Accept this piece and contact its worker directly.',
    tools:{promptobus_send:'actual_send'}, workerAddress:'worker:bb', allowDirectWorkerMessages:true };
  assert.deepEqual(JSON.parse(createBbInstructionDelivery('approver', context).initialPrompt.split('\n\n')[1]), context);
});
test('unknown and inherited object names are refused as instruction roles', async () => {
  const { createBbInstructionDelivery, renderBbInstructionSkill } = await import('promptobus/instructions');
  for (const role of ['unknown', 'toString', '__proto__']) {
    assert.throws(() => renderBbInstructionSkill(role), /Unknown instruction role/);
    assert.throws(() => createBbInstructionDelivery(role, {}), /Unknown instruction role/);
  }
});

for (const role of ['worker', 'reviewer', 'approver']) {
  test(`BB ${role}: w-pb3502 uses truthful UTF-8 opaque evidence, not native schema validation`, async () => {
    const { BB_ROLE_SKILLS, renderBbInstructionSkill, createBbInstructionDelivery } = await import('promptobus/instructions');
    const context = { taskId: 'bb-evidence', address: 'w-pb3502', environmentId: 'env_evidence', workspace: '/owned',
      assignment: 'Keep the authenticated participant id in evidence.', tools: { promptobus_send: 'authenticated_send' } };
    const delivery = createBbInstructionDelivery(role, context);
    assert.deepEqual(JSON.parse(delivery.initialPrompt.split('\n\n')[1]), context);
    assert.deepEqual(delivery.configuration.skills, [BB_ROLE_SKILLS[role]]);
    const rendered = renderBbInstructionSkill(role);
    const skill = readFileSync(new URL(`../bb-plugin-promptobus/skills/${BB_ROLE_SKILLS[role]}/SKILL.md`, import.meta.url), 'utf8');
    for (const [surface, body] of [['canonical', rendered], ['delivered skill', skill]]) {
      const label = `${role} ${surface}`;
      assert.match(body, /UTF-8 opaque|opaque UTF-8/, label);
      assert.match(body, /authenticated[^.\n]*participant id/i, label);
      assert.match(body, /not schema validation/i, label);
      assert.match(body, /\.txt/, label);
      assert.doesNotMatch(body, /artifactPath/, label);
      assert.match(body, /colon-address alias|substitute the orchestrator/, label);
      assert.doesNotMatch(body, /schemas\/v1\/(?:gate|handover)-record\.schema\.json/, label);
      assert.doesNotMatch(body, /bus checks (?:the record|the SHAPE)[^.\n]*schema|record is checked against its schema/i, label);
      for (const field of ['tree', 'dirty', 'exit']) assert.ok(body.includes(`\`${field}\``), `${label}: ${field}`);
      assert.match(body, /not run|notRun/, label);
    }
    assert.ok(skill.endsWith(rendered.trimEnd() + '\n'));
    if (role === 'worker') {
      assert.match(rendered, /artifact: \{ filename, content \}/);
      const protocol = readFileSync(new URL('../docs/reference/04-protocol.md', import.meta.url), 'utf8');
      assert.match(protocol, /Gate and handover evidence in BB uses UTF-8 opaque `\.txt` attachments/);
      assert.match(protocol, /Attachment acceptance is not schema validation/);
    }
  });
}

test('native evidence schemas: colon addresses remain valid; w-pb3502 is not a native alias', () => {
  const gateSchema = JSON.parse(readFileSync(new URL('../schemas/v1/gate-record.schema.json', import.meta.url), 'utf8'));
  const handoverSchema = JSON.parse(readFileSync(new URL('../schemas/v1/handover-record.schema.json', import.meta.url), 'utf8'));
  const tree = 'a'.repeat(40);
  const at = '2026-10-09T12:50:00.000Z';
  const checks = Object.fromEntries(['verdictNames', 'mutationProbe', 'treeState', 'environmentalRed', 'gatesNotRun']
    .map(name => [name, { notRun: 'Fixture only; no checks were executed.' }]));
  for (const by of ['worker:pb3502', 'approver:pb3502', 'orchestrator', 'w-pb3502']) {
    const gate = { schemaVersion: 1, records: [{ command: 'npm test', exit: 0, tree, dirty: false, at, by }] };
    const handover = { schemaVersion: 1, tree, base: 'b'.repeat(40), at, by, checks };
    const native = by !== 'w-pb3502';
    assert.equal(schemaErrors(gateSchema, gate).length === 0, native, `gate by=${by}`);
    assert.equal(schemaErrors(handoverSchema, handover).length === 0, native, `handover by=${by}`);
    if (native) {
      assert.ok(schemaErrors(gateSchema, { ...gate, records: [{ ...gate.records[0], exit: -1 }] }).length > 0);
      assert.ok(schemaErrors(handoverSchema, { ...handover, checks: {} }).length > 0);
    }
  }
});
