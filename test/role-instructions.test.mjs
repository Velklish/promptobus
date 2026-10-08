import './home.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { captureRolePrompts } from './role-prompts.mjs';

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
