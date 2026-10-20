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
test('worker milestone status and native/BB references retain the progress delivery contract', async () => {
  const { renderBbInstructionSkill } = await import('promptobus/instructions');
  const body = renderBbInstructionSkill('worker');
  assert.match(body, /Send milestone status/);
  assert.match(body, /blocker needing a decision is a question/);
  assert.doesNotMatch(body, /status at every notable step/);
  const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  assert.match(read('skills/orchestrate/SKILL.md'), /milestone `status`/);
  assert.match(read('docs/reference/01-overview.md'), /only `status` does not receive a knock/);
  assert.match(read('docs/reference/03-cli.md'), /does not knock or retry a knock/);
  assert.match(read('docs/reference/02-host.md'), /does not produce a BB bus wake/);
  assert.match(read('integrations/bb/README.md'), /without its own bus wake/);
});
test('BB skills retain the shared role protocol outside the dynamic instruction limit', async () => {
  const { BB_ROLE_SKILLS, renderBbInstructionSkill } = await import('promptobus/instructions');
  for (const [role, name] of Object.entries(BB_ROLE_SKILLS)) {
    const body = renderBbInstructionSkill(role);
    const skill = readFileSync(new URL(`../integrations/bb/skills/${name}/SKILL.md`, import.meta.url), 'utf8');
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
    const skill = readFileSync(new URL(`../integrations/bb/skills/${BB_ROLE_SKILLS[role]}/SKILL.md`, import.meta.url), 'utf8');
    assert.match(rendered, /UTF-8 opaque|opaque UTF-8/, role);
    assert.match(rendered, /authenticated[^.\n]*participant id/i, role);
    assert.match(rendered, /not schema validation/i, role);
    assert.match(rendered, /\.txt/, role);
    assert.match(rendered, /colon-address alias|substitute the orchestrator/, role);
    for (const field of ['tree', 'dirty', 'exit']) assert.ok(rendered.includes(`\`${field}\``), `${role}: ${field}`);
    assert.match(rendered, /not run|notRun/, role);
    assert.match(rendered, /exact test names, order and repeated occurrences/, role);
    assert.match(rendered, /only the terminal numeric duration/, role);
    assert.match(rendered, /gate status separate from test names/, role);
    assert.match(rendered, /raw output authoritative/, role);
    assert.match(rendered, /unsupported formats.*explicitly incomplete/, role);
    assert.match(rendered, /checkout-only reference helper `scripts\/bb-evidence-verdict-names\.mjs`/, role);
    assert.match(rendered, /manual lossless opaque UTF-8 evidence/, role);
    assert.doesNotMatch(skill, /artifactPath/, role);
    assert.doesNotMatch(skill, /schemas\/v1\/(?:gate|handover)-record\.schema\.json/, role);
    assert.doesNotMatch(skill, /bus checks (?:the record|the SHAPE)[^.\n]*schema|record is checked against its schema/i, role);
    assert.ok(skill.endsWith(rendered.trimEnd() + '\n'));
    if (role === 'worker') {
      assert.match(rendered, /artifact: \{ filename, content \}/);
      const protocol = readFileSync(new URL('../docs/reference/04-protocol.md', import.meta.url), 'utf8');
      assert.match(protocol, /Gate and handover evidence in BB uses UTF-8 opaque `\.txt` attachments/);
      assert.match(protocol, /Attachment acceptance is not schema validation/);
      assert.match(protocol, /\[reference helper\]\(\.\.\/\.\.\/scripts\/bb-evidence-verdict-names\.mjs\)/);
      assert.match(protocol, /names, counts and multiplicities/);
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

for (const role of ['orchestrator', 'approver', 'worker']) {
  test(`BB ${role}: the initial evidence recipe captures finalization and separates current proof from history`, async () => {
    const { BB_ROLE_SKILLS, renderBbInstructionSkill } = await import('promptobus/instructions');
    const rendered = renderBbInstructionSkill(role);
    const shipped = readFileSync(new URL(`../integrations/bb/skills/${BB_ROLE_SKILLS[role]}/SKILL.md`, import.meta.url), 'utf8');
    assert.match(rendered, /before the first relevant mechanical check/);
    assert.match(rendered, /commands\/record-command\.js/);
    assert.match(rendered, /commands\/command-runner\.js/);
    assert.match(rendered, /commands\/evidence-prepare\.js/);
    assert.match(rendered, /inner receipt[^.]*alone[^.]*finalization/i);
    assert.match(rendered, /constructor[^.]*does not run[^.]*suites/i);
    assert.match(rendered, /required prior findings and failures/);
    assert.match(rendered, /zero current gates/);
    assert.match(rendered, /unchanged suite/);
    assert.ok(shipped.endsWith(rendered.trimEnd() + '\n'));
  });
  test(`BB ${role}: complete command grants and terminal release belong to the rendered and shipped contract`, async () => {
    const { BB_ROLE_SKILLS, renderBbInstructionSkill } = await import('promptobus/instructions');
    const rendered = renderBbInstructionSkill(role);
    const shipped = readFileSync(new URL(`../integrations/bb/skills/${BB_ROLE_SKILLS[role]}/SKILL.md`, import.meta.url), 'utf8');
    assert.match(rendered, /same canonical task[^.]*authenticated actor[^.]*immutable authorization token[^.]*exact command scope[^.]*all required preconditions[^.]*owner confirmation/i,
      `${role}: complete grant text contract includes every owner input`);
    assert.match(rendered, /released[^.]*terminal|terminal[^.]*release/i, `${role}: terminal grant text contract`);
    assert.match(rendered, /(?:confirmation|resume)[^.]*must not revive/i, `${role}: terminal grant cannot revive`);
    assert.match(rendered, /remaining work needs a fresh complete grant/i, `${role}: terminal grant requires a fresh grant`);
    assert.match(rendered, /runner-only release[^.]*does not authorize[^.]*closure lint/i, `${role}: runner text contract limits closure scope`);
    assert.doesNotMatch(shipped, /(?:^|[.!?]\s+|\n)\s*(?:Require|Wait for) a separate (?:owner )?confirmation|do not execute until[^.]*separate canonical task[^.]*owner confirms/i,
      `${role}: whole shipped skill must not add a separate confirmation barrier`);
    if (role === 'orchestrator') {
      assert.match(rendered, /Persist[^.]*authenticated actor[^.]*immutable authorization token[^.]*exact command scope[^.]*all preconditions[^.]*before[^.]*task create[^.]*participant dispatch/i,
        `${role}: prebound text contract persists the complete grant before reservation or dispatch`);
      assert.match(rendered, /Keep the actor slot until the exact all-calls release is acknowledged, or an official task-owned stop\/pause is verified/i,
        `${role}: retain text contract holds the actor slot until acknowledgment or verified Stop`);
      assert.match(rendered, /all-calls release identifies actor, token and completed scope and confirms pending and running calls are zero/i,
        `${role}: exactRelease text contract requires exact identity, scope and drained calls`);
      assert.match(rendered, /Validate it against current control before acknowledging it and reallocating the actor slot/i,
        `${role}: exactRelease text contract validates current control before acknowledgment or reallocation`);
      assert.match(rendered, /Sent Hold[^.]*sent or queued are not acknowledgments[^.]*read or applied/i,
        `${role}: retain text contract distinguishes delivery from acknowledgment`);
      assert.match(rendered, /official task-owned participant stop\/pause route[^.]*verify fresh actual status, paused delivery and zero pending\/running calls before reassigning/i,
        `${role}: stop text contract requires a fresh official Stop verification`);
      assert.match(rendered, /Preserve worktrees, raw receipts and unrelated participants/i,
        `${role}: stop text contract preserves owned evidence and unrelated work`);
      assert.match(rendered, /changed precondition during a running batch takes effect only after acknowledged application/i,
        `${role}: update text contract waits for acknowledged precondition application`);
    } else {
      assert.match(rendered, /Immediately before every mechanical call[^.]*current control and STOP[^.]*authenticated actor and authorization token[^.]*current granted scope/i,
        `${role}: guard text contract checks current control, STOP, actor, token and scope before every call`);
      assert.match(rendered, /earlier Proceed[^.]*insufficient when current ownership has changed/i,
        `${role}: guard text contract rejects stale Proceed`);
      assert.match(rendered, /Refuse a call outside that exact scope or under STOP, an ended grant or mismatched ownership/i,
        `${role}: guard text contract refuses invalid current authority`);
      assert.match(rendered, /fresh normal-account routing before each substantial suite invocation/i,
        `${role}: routing text contract requires a fresh receipt for each suite`);
      assert.match(rendered, /Cached quota is not a fresh routing receipt/i,
        `${role}: routing text contract excludes cached quota`);
      assert.match(rendered, /Follow the initial grant's preconditions until a changed precondition has acknowledged application/i,
        `${role}: update text contract keeps initial guards until acknowledgment`);
      assert.match(rendered, /later message cannot retroactively change a running call's guard/i,
        `${role}: update text contract does not change a running call retroactively`);
    }
    assert.ok(shipped.endsWith(rendered.trimEnd() + '\n'));
  });
}
