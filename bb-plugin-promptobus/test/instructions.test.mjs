import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BB_ROLE_SKILLS, createBbInstructionDelivery, renderBbInstructionSkill } from 'promptobus/instructions';

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
    for (const text of [body, skill]) {
      assert.match(text, /UTF-8 opaque|opaque UTF-8/);
      assert.match(text, /authenticated[^.\n]*participant id/i);
      assert.match(text, /not schema validation/i);
      assert.match(text, /exact test names, order and repeated occurrences/);
      assert.match(text, /only the terminal numeric duration/);
      assert.match(text, /gate status separate from test names/);
      assert.match(text, /unsupported formats.*explicitly incomplete/);
      assert.match(text, /checkout-only reference helper `scripts\/bb-evidence-verdict-names\.mjs`/);
      assert.match(text, /\.txt/);
      assert.doesNotMatch(text, /artifactPath/);
      assert.doesNotMatch(text, /schemas\/v1\/(?:gate|handover)-record\.schema\.json/);
      assert.doesNotMatch(text, /bus checks (?:the record|the SHAPE)[^.\n]*schema|record is checked against its schema/i);
    }
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
    for (const text of [body, skill]) {
      assert.match(text, /same canonical task[^.]*owner confirmation|owner confirmation[^.]*same canonical task/i);
      assert.match(text, /released[^.]*terminal|terminal[^.]*release/i);
      assert.match(text, /(?:confirmation|resume)[^.]*must not revive/i);
      assert.doesNotMatch(text, /(?:^|[.!?]\s+|\n)\s*(?:Require|Wait for) a separate (?:owner )?confirmation|do not execute until[^.]*separate canonical task[^.]*owner confirms/i);
    }
    assert.ok(skill.endsWith(body.trimEnd() + '\n'));
  });
}
