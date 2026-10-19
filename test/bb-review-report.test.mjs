import './home.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { renderBbInstructionSkill } from 'promptobus/instructions';

test('BB reviewer bounds every send body and delivers findings before its sole terminal release', () => {
  const body = renderBbInstructionSkill('reviewer');
  assert.match(body, /Every send body[^.]*2400 characters/);
  assert.doesNotMatch(body, /findings follow it in the same body, and they are not bounded/);
  assert.match(body, /Review <grant-token> part i\/N/);
  assert.match(body, /type=status/);
  assert.match(body, /Review <grant-token> complete N\/N/);
  assert.match(body, /one terminal type=result/);
  assert.match(body, /single all-calls release/);
  assert.match(body, /pending=0 and running=0/);
  assert.match(body, /After that release make no tool calls/);
  assert.match(body, /Do not truncate or drop findings/);
  assert.match(body, /no artifact of your own/);
  assert.match(body, /failed or uncertain send[^.]*incomplete/);
  assert.ok(readFileSync(new URL('../bb-plugin-promptobus/skills/promptobus-reviewer/SKILL.md', import.meta.url), 'utf8').endsWith(body.trimEnd() + '\n'));
  const schema = readFileSync(new URL('../bb-plugin-promptobus/protocol.ts', import.meta.url), 'utf8');
  assert.match(schema, /body: z\.string\(\)\.min\(1\)\.max\(2400\)/);
});

test('BB orchestrator rejects incomplete reviewer parts before relying on a terminal result', () => {
  const body = renderBbInstructionSkill('orchestrator');
  assert.match(body, /Read every full part body/);
  assert.match(body, /authenticated reviewer[^.]*grant token/);
  assert.match(body, /Reject missing, duplicated, reordered or mixed-token parts/);
  assert.match(body, /single terminal result[^.]*single all-calls release/);
  assert.match(body, /procedural check[^.]*does not assemble or validate/);
});
