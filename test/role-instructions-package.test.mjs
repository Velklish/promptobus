import './home.mjs';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeSandbox } from './sandbox.mjs';
import { run as runProcess } from '../lib/exec.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const stand = makeSandbox('promptobus-package-role-instructions-');
const consumer = path.join(stand, 'consumer');
mkdirSync(consumer);
writeFileSync(path.join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
const run = (command, args, cwd) => {
  const result = runProcess(command, args, { cwd, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, npm_config_cache: path.join(stand, 'npm-cache') } });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', stand], root))[0];
run('npm', ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', path.join(stand, packed.filename)], consumer);

test('packed instruction entry and its typed dependencies survive a clean installation', () => {
  const files = new Set(packed.files.map(file => file.path));
  for (const file of ['lib/instructions.js', 'lib/instructions.d.ts', 'lib/prompts/roles.js', 'lib/prompts/roles.d.ts', 'lib/prompts/bb.js', 'lib/prompts/bb.d.ts', 'lib/prompts/README.md']) {
    assert.ok(files.has(file), `not packed: ${file}`);
  }
  const output = run('node', ['--input-type=module', '-e', 'import * as i from "promptobus/instructions"; console.log(JSON.stringify({skills:Object.keys(i.BB_ROLE_SKILLS),worker:i.renderBbInstructionSkill("worker").length,reviewer:i.renderBbInstructionSkill("reviewer").length}));'], consumer);
  const actual = JSON.parse(output);
  assert.equal(actual.skills.length, 6);
  assert.ok(actual.worker > 4096 && actual.reviewer > 4096);
  const readme = readFileSync(path.join(consumer, 'node_modules/promptobus/lib/prompts/README.md'), 'utf8');
  for (const match of readme.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    readFileSync(path.resolve(consumer, 'node_modules/promptobus/lib/prompts', target));
  }
});

test('an installed TypeScript consumer checks role context and rejects an unknown role', () => {
  const file = path.join(consumer, 'check.ts');
  const source = `import { renderBbInstructionSkill, createBbInstructionDelivery, renderReviewerInstructions, type ReviewerInstructionInput } from 'promptobus/instructions';
const input: ReviewerInstructionInput = {
  taskId: 'task', nsPath: 'repo', repoDir: '/owned', address: 'reviewer:check', stepName: 'reviewer', rules: [],
  reviewSubject: 'snapshot HEAD/base and gate records', instructionsSection: '', procedureText: '',
  bindings: { tools: {promptobus_send:'send', promptobus_mailbox:'mail', promptobus_task:'task'}, memory:'', contacts:'',
    mcpBoundary:'read-only', communication:'native BB', externalReads:'declared reads only', wait:'end turn', close:'BB Stop', operationalRules:'',
    reviewerCommands:{isolation:'bounded reads', procedureSkip:'tests', record:'not run', gate:'not run'} }
};
input.bindings.evidenceInstructions = 'BB evidence uses opaque text attachments.';
renderReviewerInstructions(input);
renderBbInstructionSkill('reviewer');
createBbInstructionDelivery('worker', {taskId:'task', address:'worker:check', environmentId:'env', workspace:'/owned', assignment:'scope', tools:{promptobus_send:'send'}});
`;
  writeFileSync(file, source);
  const args = [path.join(root, 'node_modules/typescript/lib/tsc.js'), '--noEmit', '--strict', '--skipLibCheck',
    '--target', 'es2023', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--types', 'node',
    '--typeRoots', path.join(root, 'node_modules/@types'), file];
  run('node', args, consumer);
  writeFileSync(file, source + "renderBbInstructionSkill('unknown');\n");
  const invalid = runProcess('node', args, { cwd: consumer, encoding: 'utf8', timeout: 60000 });
  assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
  assert.match(invalid.stdout, /not assignable to parameter of type 'BbInstructionRole'/);
});

test('packed BB evidence instructions: independent w-pb3502 identity survives without native schema promises', () => {
  const source = `import { renderBbInstructionSkill, createBbInstructionDelivery } from 'promptobus/instructions';
const roles = ['worker', 'reviewer', 'approver'];
const context = {taskId:'bb-evidence', address:'w-pb3502', environmentId:'env_evidence', workspace:'/owned', assignment:'Truthful evidence.', tools:{promptobus_send:'authenticated_send'}};
console.log(JSON.stringify(roles.map(role => ({role, body:renderBbInstructionSkill(role), delivery:createBbInstructionDelivery(role, context)}))));`;
  const output = JSON.parse(run('node', ['--input-type=module', '-e', source], consumer));
  assert.equal(output.length, 3);
  for (const { role, body, delivery } of output) {
    assert.equal(JSON.parse(delivery.initialPrompt.split('\n\n')[1]).address, 'w-pb3502');
    assert.match(body, /UTF-8 opaque|opaque UTF-8/, role);
    assert.match(body, /authenticated[^.\n]*participant id/i, role);
    assert.match(body, /not schema validation/i, role);
    assert.match(body, /exact test names, order and repeated occurrences/, role);
    assert.match(body, /only the terminal numeric duration/, role);
    assert.match(body, /gate status separate from test names/, role);
    assert.match(body, /unsupported formats.*explicitly incomplete/, role);
    assert.match(body, /checkout-only reference helper `scripts\/bb-evidence-verdict-names\.mjs`/, role);
    assert.match(body, /\.txt/, role);
    assert.doesNotMatch(body, /artifactPath/, role);
    assert.doesNotMatch(body, /schemas\/v1\/(?:gate|handover)-record\.schema\.json/, role);
    assert.doesNotMatch(body, /bus checks (?:the record|the SHAPE)[^.\n]*schema|record is checked against its schema/i, role);
  }
});

test('packed BB command-grant contract survives installation without a separate confirmation barrier', () => {
  const source = `import { renderBbInstructionSkill } from 'promptobus/instructions';
console.log(JSON.stringify(['orchestrator','approver','worker'].map(role => ({role,body:renderBbInstructionSkill(role)}))));`;
  const output = JSON.parse(run('node', ['--input-type=module', '-e', source], consumer));
  assert.equal(output.length, 3);
  for (const { role, body } of output) {
    assert.match(body, /same canonical task[^.]*owner confirmation|owner confirmation[^.]*same canonical task/i, role);
    assert.match(body, /released[^.]*terminal|terminal[^.]*release/i, role);
    assert.match(body, /(?:confirmation|resume)[^.]*must not revive/i, role);
    assert.doesNotMatch(body, /(?:^|[.!?]\s+|\n)\s*(?:Require|Wait for) a separate (?:owner )?confirmation|do not execute until[^.]*separate canonical task[^.]*owner confirms/i, role);
    if (role !== 'orchestrator') assert.match(body, /immediately before every mechanical call/i, role);
  }
});
