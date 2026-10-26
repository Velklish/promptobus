import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BB_ROLE_SKILLS, createBbInstructionDelivery, renderBbInstructionSkill } from 'promptobus/instructions';

test('reviewer role names ordinary source reads separately from selected Host resources', () => {
  const body = renderBbInstructionSkill('reviewer');
  for (const name of ['pb_review_read_file', 'pb_review_read_files', 'pb_review_list_files', 'pb_review_search_text']) assert.ok(body.includes(name), name);
  assert.match(body, /TASK.md, AGENTS.md and source files within the supplied owned review workspace/);
  assert.match(body, /promptobus_host_context only for selected Host rules, skills and exact declared resources/);
  assert.match(body, /content completely through bounded ranges/);
  assert.match(body, /Shell execution and edits remain forbidden/);
  assert.ok(readFileSync(new URL('../skills/promptobus-reviewer/SKILL.md', import.meta.url), 'utf8').endsWith(body.trimEnd() + '\n'));
});

test('installed instruction delivery is a complete SDK configuration with explicit authenticated tool selection', () => {
  const stand = mkdtempSync(path.join(tmpdir(), 'promptobus-bb-instruction-types-'));
  const installed = name => fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url)).replaceAll('\\', '/');
  const file = path.join(stand, 'check.mts');
  try {
    writeFileSync(file, `import { createBbInstructionDelivery } from ${JSON.stringify(installed('promptobus/lib/instructions.js'))};
import type { PluginAgentConfiguration } from ${JSON.stringify(installed('@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts'))};
const delivery = createBbInstructionDelivery('approver', { taskId:'task', address:'approver:bb', environmentId:'env', workspace:'/owned', assignment:'accept', tools:{promptobus_send:'send'}, workerAddress:'worker:bb', allowDirectWorkerMessages:true });
const denied: PluginAgentConfiguration = delivery.configuration;
const authenticatedToolSelection: string[] = ['send'];
const selected: PluginAgentConfiguration = { ...delivery.configuration, tools: authenticatedToolSelection };
`);
    const result = spawnSync(process.execPath, [installed('typescript/lib/tsc.js'), '--noEmit', '--strict', '--skipLibCheck',
      '--target', 'es2023', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--types', 'node',
      '--typeRoots', installed('@types'), file], { cwd:stand, encoding:'utf8', timeout:60000 });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  } finally { rmSync(stand, { recursive:true, force:true }); }
});

for (const role of ['worker', 'reviewer', 'approver']) {
  test(`installed BB ${role}: w-pb3502 receives the UTF-8 opaque evidence profile in its selected skill`, () => {
    const context = { taskId: 'bb-evidence', address: 'w-pb3502', environmentId: 'env_evidence', workspace: '/owned',
      assignment: 'Record the real authenticated actor.', tools: { promptobus_send: 'authenticated_send' } };
    const delivery = createBbInstructionDelivery(role, context);
    assert.deepEqual(JSON.parse(delivery.initialPrompt.split('\n\n')[1]), context);
    assert.deepEqual(delivery.configuration.skills, [BB_ROLE_SKILLS[role]]);
    const body = renderBbInstructionSkill(role);
    const skill = readFileSync(new URL(`../skills/${BB_ROLE_SKILLS[role]}/SKILL.md`, import.meta.url), 'utf8');
    assert.ok(skill.endsWith(body.trimEnd() + '\n'));
    assert.match(body, /UTF-8 opaque|opaque UTF-8/);
    assert.match(body, /authenticated[^.\n]*participant id/i);
    assert.match(body, /not schema validation/i);
    assert.match(body, /exact test names, order and repeated occurrences/);
    assert.match(body, /only the terminal numeric duration/);
    assert.match(body, /gate status separate from test names/);
    assert.match(body, /unsupported formats.*explicitly incomplete/);
    assert.match(body, /checkout-only reference helper `scripts\/bb-evidence-verdict-names\.mjs`/);
    assert.match(body, /\.txt/);
    assert.doesNotMatch(skill, /artifactPath/);
    assert.doesNotMatch(skill, /schemas\/v1\/(?:gate|handover)-record\.schema\.json/);
    assert.doesNotMatch(skill, /bus checks (?:the record|the SHAPE)[^.\n]*schema|record is checked against its schema/i);
  });
}

for (const role of ['orchestrator', 'approver', 'worker']) {
  test(`installed BB ${role}: selected skill delivers the complete command-grant contract`, () => {
    const context = { taskId:'command-grant', address:'w-command', environmentId:'env_command', workspace:'/owned',
      assignment:'Actor w-command; token command-01; exact scope preparation; owner confirmation in this task.',
      tools:{promptobus_send:'authenticated_send'} };
    const delivery = createBbInstructionDelivery(role, context);
    assert.deepEqual(JSON.parse(delivery.initialPrompt.split('\n\n')[1]), context);
    assert.deepEqual(delivery.configuration.skills, [BB_ROLE_SKILLS[role]]);
    const body = renderBbInstructionSkill(role);
    const skill = readFileSync(new URL(`../skills/${BB_ROLE_SKILLS[role]}/SKILL.md`, import.meta.url), 'utf8');
    assert.match(body, /same canonical task[^.]*owner confirmation|owner confirmation[^.]*same canonical task/i);
    assert.match(body, /released[^.]*terminal|terminal[^.]*release/i);
    assert.match(body, /(?:confirmation|resume)[^.]*must not revive/i);
    assert.doesNotMatch(skill, /(?:^|[.!?]\s+|\n)\s*(?:Require|Wait for) a separate (?:owner )?confirmation|do not execute until[^.]*separate canonical task[^.]*owner confirms/i);
    assert.ok(skill.endsWith(body.trimEnd() + '\n'));
  });
}
