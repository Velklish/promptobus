import './home.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { leaseRule } from '../lib/lease.js';
import { BB_ROLE_SKILLS, renderBbInstructionSkill } from 'promptobus/instructions';

const native = leaseRule({
  host: { busCommand: argv => `promptobus ${argv.join(' ')}` },
  taskId: 'resource-policy', address: 'worker:policy',
});

test('native execution policy permits independent full suites and gates after resource ownership', () => {
  assert.match(native, /source reads, setup, builds, no-model checks, focused tests, full suites and gates may run concurrently/i);
  assert.match(native, /approved actor\/card limit/);
  assert.match(native, /worktree, output, temporary-directory and writable-cache ownership/);
  assert.match(native, /not required for ordinary full suites or gates/);
  assert.doesNotMatch(native, /full test suite and its gate command/);
});

test('native execution policy limits exclusive leases to declared conflicts and measurements', () => {
  assert.match(native, /explicitly named conflicting path or service, same-clone publication, or a declared controlled performance\/load measurement/);
  assert.match(native, /generic machine lease remains opt-in/);
  assert.match(native, /promptobus lease --as worker:policy --task resource-policy -- <command…>/);
  assert.match(native, /Do not nest one leased command inside another/);
});

for (const role of ['worker', 'approver', 'orchestrator']) {
  const rendered = renderBbInstructionSkill(role);
  const shipped = readFileSync(new URL(`../integrations/bb/skills/${BB_ROLE_SKILLS[role]}/SKILL.md`, import.meta.url), 'utf8');
  test(`BB ${role}: independent checks use owned resources and the actual concurrency policy`, () => {
    for (const body of [rendered, shipped]) {
      assert.match(body, /source reads, setup, builds, no-model checks, focused tests, full suites and gates may run concurrently/i);
      assert.match(body, /approved actor\/card limit/);
      assert.match(body, /worktree, output, temporary-directory and writable-cache ownership/);
      assert.match(body, /explicitly named conflicting path or service, same-clone publication, or a declared controlled performance\/load measurement/);
      assert.match(body, /generic machine lease remains opt-in/);
      assert.match(body, /maxActiveIncludingOwner[^.]*owner-declared actor metadata/);
      assert.match(body, /actual BB concurrency policy[^.]*separate/i);
      assert.match(body, /do not establish a universal BB scheduler or interception of arbitrary native commands/);
    }
    assert.ok(shipped.endsWith(rendered.trimEnd() + '\n'));
  });
  test(`BB ${role}: permission waits free generic compute while writers retain named resources until terminal receipts`, () => {
    for (const body of [rendered, shipped]) {
      assert.match(body, /Permission waiting consumes no generic compute capacity/);
      assert.match(body, /after a permission or resource wait[^.]*immediately before execution[^.]*current phase, token, scope, resources and STOP/i);
      assert.match(body, /confirmed or UNKNOWN writer[^.]*named resource[^.]*actual terminal receipt/i);
      assert.match(body, /Administrative parking, control revocation or an ended grant alone does not drain a writer/);
    }
  });
}

for (const role of ['worker', 'approver']) {
  test(`BB ${role}: owned command phases use the checked launcher and refuse a missing immutable grant`, () => {
    const rendered = renderBbInstructionSkill(role);
    const shipped = readFileSync(new URL(`../integrations/bb/skills/${BB_ROLE_SKILLS[role]}/SKILL.md`, import.meta.url), 'utf8');
    for (const body of [rendered, shipped]) {
      assert.match(body, /For each owned build, test or mutating command phase, use the checked launcher/);
      assert.ok(body.includes('node <generation>/commands/command-runner.js --admission /owned/input.json --output /owned/stem --by ACTOR -- EXEC ARGS'));
      assert.match(body, /admission input contains `\{ binding, commandId \}`/);
      assert.match(body, /exact current `grant\.execution\.commands` entry using supplied bindings and task-owned paths/);
      assert.match(body, /ordinary provider execution and its normal approval flow/);
      assert.match(body, /`--by` records receipt attribution and does not authenticate the caller/);
      assert.match(body, /immutable command grant is missing, report the blocked operation to the owner/);
      assert.match(body, /do not use the legacy recorder or a native-command fallback for these admitted calls/);
    }
  });
}

test('BB reviewer keeps bounded reads without the executable command launcher', () => {
  const rendered = renderBbInstructionSkill('reviewer');
  const shipped = readFileSync(new URL(`../integrations/bb/skills/${BB_ROLE_SKILLS.reviewer}/SKILL.md`, import.meta.url), 'utf8');
  for (const body of [rendered, shipped]) {
    assert.match(body, /Shell execution and edits are forbidden/);
    assert.doesNotMatch(body, /command-runner\.js|--admission/);
  }
});
