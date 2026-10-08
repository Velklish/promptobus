import './home.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { capturePrompts, capturePreflightReplies } from './prompt-sources.mjs';
import { codexDriver } from '../lib/driver-codex.js';

const baseline = JSON.parse(readFileSync(new URL('./fixtures/participant-prompts/native.json', import.meta.url), 'utf8'));
const actual = await capturePrompts();
for (const harness of ['claude', 'cursor', 'opencode']) {
  for (const role of ['worker', 'reviewer', 'orchestratorRefusal']) {
    test(`${harness} ${role} preserves the captured native instructions`, () => {
      assert.equal(actual[harness][role], baseline[harness][role]);
    });
  }
}
const shared = (prompt) => prompt.split('\n\n## Rules for this tool (Codex)')[0];
for (const role of ['worker', 'reviewer', 'orchestrator']) {
  test(`Codex ${role} preserves shared ownership, review and evidence instructions`, () => {
    const current = shared(actual.codex[role]).replace(
      'The orchestrator is a separate Promptobus participant at address orchestrator',
      'The orchestrator is a separate Claude Code session');
    assert.equal(current, shared(baseline.codex[role]));
  });
  test(`Codex ${role} reuses persistent MCP and checks actual identity and route`, () => {
    const prompt = actual.codex[role];
    assert.match(prompt, /already attached persistent MCP servers/);
    assert.match(prompt, /Do not start temporary MCP processes/);
    assert.match(prompt, /actual native thread id, task id and mailbox address/);
    assert.match(prompt, /foreign or missing identity/);
    assert.match(prompt, /end the turn.*native protocol events/s);
    assert.doesNotMatch(prompt, /Each bus tool call costs a turn/);
  });
}
test('Codex worker uses the task owner rather than claiming its harness is Claude', () => {
  assert.match(actual.codex.worker, /The orchestrator is a separate Promptobus participant at address orchestrator/);
  assert.doesNotMatch(actual.codex.worker, /separate Claude Code session/);
});
test('listener permission guidance reaches executable Codex roles before their first attempt', () => {
  for (const role of ['worker', 'orchestrator']) {
    const prompt = actual.codex[role];
    assert.match(prompt, /Before the first known listener-dependent command/);
    assert.match(prompt, /effective sandbox, network access and approval policy/);
    assert.match(prompt, /supported command-level network permission.*first call/s);
    assert.match(prompt, /already authorized/);
    assert.match(prompt, /report the blocked operation/);
    assert.match(prompt, /Do not change session permissions/);
  }
});
test('Codex reviewer retains bounded reads and receives no command permission guidance', () => {
  const prompt = actual.codex.reviewer;
  assert.match(prompt, /batch independent file ranges with read_files/);
  assert.match(prompt, /Do not run builds, tests or analyzers/);
  assert.doesNotMatch(prompt, /command-level network permission|listener-dependent command/);
});
test('a fresh managed root bootstraps with no participant contact before its first spawn', async () => {
  const replies = await capturePreflightReplies('orchestrator');
  assert.match(replies.task, /you may write: nobody/);
  assert.match(replies.task, /orchestrator.*owner fixture-root-thread/);
  assert.match(actual.codex.orchestrator, /A fresh root may have no participant contacts before the first spawn/);
  assert.match(actual.codex.orchestrator, /Missing owner contact blocks only a question/);
  assert.doesNotMatch(actual.codex.orchestrator, /absent route is a blocked preflight/);
});
test('reviewer identity preflight uses bound MCP proof without requiring hidden native context', async () => {
  const replies = await capturePreflightReplies('reviewer:source');
  assert.match(replies.task, /reviewer:source.*owner fixture-reviewer-thread/);
  assert.match(replies.mailbox, /address=reviewer:source/);
  assert.doesNotMatch(replies.mailbox, /fixture-reviewer-thread/);
  for (const name of ['promptobus_send', 'promptobus_mailbox', 'promptobus_task']) assert.ok(replies.tools.includes(name));
  assert.doesNotMatch(replies.tools.join(' '), /identity|session|shell|exec/);
  assert.match(actual.codex.reviewer, /bound MCP identity/);
  assert.match(actual.codex.reviewer, /Native context is optional/);
  assert.match(actual.codex.reviewer, /independent native id comparison was unavailable/);
  assert.match(actual.codex.reviewer, /Do not use shell or an unavailable tool to obtain reviewer identity/);
});
test('a Codex worker source edit changes only its worker prompt', async () => {
  const source = readFileSync(new URL('../lib/prompts/codex.js', import.meta.url), 'utf8');
  const changedSource = source.replace('const workerRules = commonRules + identityRules + participantRoutes + executableRules;',
    "const workerRules = commonRules + identityRules + participantRoutes + executableRules + '\\nWORKER SOURCE PROBE';");
  assert.notEqual(changedSource, source, 'worker source marker must be present');
  const importable = changedSource.replace('../../dist/registry.js', new URL('../dist/registry.js', import.meta.url).href);
  const { codexPrompts } = await import(`data:text/javascript;base64,${Buffer.from(importable).toString('base64')}`);
  const original = codexDriver.phrases.promptRulesFor;
  let changed;
  try {
    codexDriver.phrases.promptRulesFor = codexPrompts.promptRulesFor;
    changed = await capturePrompts();
  } finally { codexDriver.phrases.promptRulesFor = original; }
  assert.equal(changed.codex.worker, `${actual.codex.worker}\nWORKER SOURCE PROBE`);
  assert.equal(changed.codex.reviewer, actual.codex.reviewer);
  assert.equal(changed.codex.orchestrator, actual.codex.orchestrator);
  for (const harness of ['claude', 'cursor', 'opencode']) assert.deepEqual(changed[harness], actual[harness]);
});
