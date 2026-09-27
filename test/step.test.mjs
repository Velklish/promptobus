import './home.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { capture, captureSplit } from './console.mjs';
import { hostOf } from '../lib/host.js';
import * as store from '../lib/store.js';
import { planApprover } from '../lib/approver.js';
import { planReview, review, step, worktreeOwner } from '../lib/review.js';
import { addressList, admitsAddress, registryOf } from '../dist/index.js';

const box = realpathSync(makeSandbox('promptobus-test-registry-'));
const ws = path.join(box, 'ws');
const clone = path.join(ws, 'repos', 'demo', 'project');
const subject = path.join(clone, '.claude', 'worktrees', 'piece');
const pipeline = {
  owner: { name: 'worker', kind: 'edits-tree' },
  gates: [
    { name: 'reviewer', kind: 'reads-diff' },
    { name: 'security', kind: 'reads-diff' },
    { name: 'approver', kind: 'writes-main-tree' },
  ],
};
mkdirSync(clone, { recursive: true });
writeHostConfig(ws, { pipeline });
const git = (at, ...args) => {
  const run = spawnSync('git', ['-C', at, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
};
git(clone, 'init', '-b', 'main');
writeFileSync(path.join(clone, 'change.txt'), 'before\n');
git(clone, 'add', '.');
git(clone, 'commit', '-qm', 'initial');
const base = git(clone, 'rev-parse', 'HEAD');
git(clone, 'worktree', 'add', '-qb', 'piece', subject, 'main');
writeFileSync(path.join(subject, 'change.txt'), 'after\n');
git(subject, 'add', '.');
git(subject, 'commit', '-qm', 'change');
const host = hostOf(ws);
const cli = fileURLToPath(new URL('../bin/promptobus.js', import.meta.url));
const home = host.promptobusHome();
const task = 'step-t20260927-000000';
store.createTask(home, { id: task, title: 'gate steps', status: 'active', participants: [] });
const assignedAt = '2026-09-26T00:00:00.000Z';
const registry = registryOf(host);
const participant = (address, fields) => store.upsertParticipant(home, task,
  store.participantRecord(address, { harness: 'claude', started: assignedAt, ...fields }, registry));
const result = (address) => store.sendMessage(home, task, {
  from: address, to: store.ORCHESTRATOR, type: 'result', body: 'reported',
});
participant('worker:piece', { repoAbs: clone, worktree: subject, baseSha: base });

test('the first gate lifts without a predecessor, and a later gate names the missing result', () => {
  const first = planReview(host, { target: subject, task, stepName: 'reviewer', dryRun: true });
  assert.equal(first.address, 'reviewer:piece');
  assert.throws(() => planReview(host, { target: subject, task, stepName: 'security', dryRun: true }),
    /step security requires a type=result message from reviewer:piece/);
  assert.throws(() => planApprover(host, { target: subject, task, stepName: 'approver', dryRun: true }),
    /step approver requires a type=result message from security:piece/);
});

test('a later gate requires the current result at the same subject', () => {
  participant('reviewer:piece', { repoAbs: subject, reviewAssignedAt: assignedAt });
  result('reviewer:piece');
  const security = planReview(host, { target: subject, task, stepName: 'security', dryRun: true });
  assert.equal(security.address, 'security:piece');
  assert.ok(security.diffPath.includes('security-piece.diff'));
  const future = new Date(Date.now() + 60_000).toISOString();
  store.stampReviewAssignment(home, task, 'reviewer:piece', future);
  assert.throws(() => planReview(host, { target: subject, task, stepName: 'security', dryRun: true }),
    /no result is recorded at or after its current assignment/);
  store.stampReviewAssignment(home, task, 'reviewer:piece', assignedAt);
  participant('security:piece', { repoAbs: clone, reviewAssignedAt: assignedAt });
  result('security:piece');
  assert.throws(() => planApprover(host, { target: subject, task, stepName: 'approver', dryRun: true }),
    /recorded subject is .*project, not .*piece/);
  participant('security:piece', { repoAbs: subject, reviewAssignedAt: assignedAt });
});

test('a main-tree gate needs both predecessor and owner results', () => {
  result('security:piece');
  assert.throws(() => planApprover(host, { target: subject, task, stepName: 'approver', dryRun: true }),
    /step approver requires a type=result message from worker:piece/);
  result('worker:piece');
  const planned = planApprover(host, { target: subject, task, stepName: 'approver', dryRun: true });
  assert.equal(planned.address, 'approver:piece');
  assert.equal(planned.repoDir, subject);
  assert.ok(planned.worktreePath.startsWith(path.join(clone, '.claude', 'worktrees')));
  assert.ok(planned.addDirs.includes(subject));
});

test('a named reads-diff gate keeps the reviewer sandbox and accepts kind or legacy role classification', () => {
  const denyTask = 'step-denies-t20260927-000005';
  store.createTask(home, { id: denyTask, title: 'kind denies', status: 'active', participants: [] });
  store.upsertParticipant(home, denyTask, store.participantRecord('worker:piece', {
    harness: 'claude', worktree: subject, baseSha: base, started: assignedAt,
  }, registry));
  const shippedHost = { ...host, pipeline: () => [pipeline.owner, pipeline.gates[0]] };
  const namedHost = { ...host, pipeline: () => [pipeline.owner, pipeline.gates[1]] };
  for (const harness of ['claude', 'cursor', 'codex']) {
    const shipped = planReview(shippedHost, { target: subject, task: denyTask, stepName: 'reviewer', harness, dryRun: true });
    const named = planReview(namedHost, { target: subject, task: denyTask, stepName: 'security', harness, dryRun: true });
    assert.equal(named.repoDir, shipped.repoDir, harness);
    assert.deepEqual(named.settings.permissions?.deny, shipped.settings.permissions?.deny, harness);
    assert.equal(named.settings.sandbox, shipped.settings.sandbox, harness);
    assert.equal(named.settings.approvalPolicy, shipped.settings.approvalPolicy, harness);
  }
  const calls = [];
  const servers = () => ({ servers: { catalog: { type: 'http', url: 'http://catalog.invalid/mcp' } }, external: [] });
  const kindHost = {
    ...namedHost,
    participantServers: servers,
    participantDenyToolsByKind: (kind) => {
      calls.push(kind);
      return { tools: [{ server: 'catalog', tool: 'create_entry' }], complete: true };
    },
  };
  const kindPlan = planReview(kindHost, { target: subject, task: denyTask, stepName: 'security', harness: 'codex', dryRun: true });
  assert.deepEqual(kindPlan.mcpConfig.mcpServers.catalog.disabled_tools, ['create_entry']);
  assert.equal(kindPlan.refusal, null);
  assert.deepEqual(calls, ['reads-diff']);

  const legacyHost = {
    ...namedHost,
    participantServers: servers,
    participantDenyTools: (role) => {
      if (role !== 'reviewer' && role !== 'approver') throw new Error(`unknown deny role ${role}`);
      calls.push(role);
      return { tools: [{ server: 'catalog', tool: role === 'reviewer' ? 'create_entry' : 'merge_entry' }], complete: true };
    },
  };
  const legacyReview = planReview(legacyHost, { target: subject, task: denyTask, stepName: 'security', harness: 'codex', dryRun: true });
  assert.deepEqual(legacyReview.mcpConfig.mcpServers.catalog.disabled_tools, ['create_entry']);
  assert.equal(legacyReview.refusal, null);
  const writerHost = { ...legacyHost, pipeline: () => [pipeline.owner, pipeline.gates[2]] };
  const writerTask = 'step-legacy-writer-t20260927-000006';
  store.createTask(home, { id: writerTask, title: 'strict legacy classifier', status: 'active', participants: [] });
  store.upsertParticipant(home, writerTask, store.participantRecord('worker:piece', {
    harness: 'claude', worktree: subject, started: assignedAt,
  }, registryOf(writerHost)));
  store.sendMessage(home, writerTask, { from: 'worker:piece', to: store.ORCHESTRATOR, type: 'result', body: 'reported' });
  const legacyWriter = planApprover(writerHost, { target: subject, task: writerTask, stepName: 'approver', harness: 'codex', dryRun: true });
  assert.equal(legacyWriter.refusal, null);
  assert.deepEqual(legacyWriter.mcpConfig.mcpServers.catalog.disabled_tools, ['merge_entry']);
  assert.deepEqual(calls, ['reads-diff', 'reviewer', 'approver']);
});

test('a cleared predecessor assignment refuses the next gate until a new result', async () => {
  store.stampReviewAssignment(home, task, 'security:piece', null);
  const missing = /step approver requires a type=result message from security:piece.*current assignment timestamp is absent/;
  assert.throws(() => planApprover(host, { target: subject, task, stepName: 'approver', dryRun: true }), missing);
  await assert.rejects(() => step(host, { stepName: 'approver', target: subject, task, dryRun: true }), missing);
  store.stampReviewAssignment(home, task, 'security:piece', assignedAt);
  assert.equal(planApprover(host, { target: subject, task, stepName: 'approver', dryRun: true }).address, 'approver:piece');
});

test('step and the review aliases print the selected declared step', async () => {
  const selected = await capture(() => step(host, { stepName: 'security', target: subject, task, dryRun: true }));
  assert.match(selected, /step security \(reads-diff\)/);
  const reviewed = await capture(() => review(host, { target: subject, task, dryRun: true }));
  assert.match(reviewed, /step reviewer \(reads-diff\)/);
  const accepted = await capture(() => review(host, { target: subject, task, approver: true, dryRun: true }));
  assert.match(accepted, /step approver \(writes-main-tree\)/);
  await assert.rejects(() => step(host, { stepName: 'worker', target: subject, task, dryRun: true }),
    /not a gate in the declared pipeline/);
});

test('the checkout CLI accepts step and prints the selected step', () => {
  const run = spawnSync(process.execPath, [cli, 'step', 'security', subject, '--task', task, '--dry-run'], {
    cwd: ws, encoding: 'utf8', env: { ...process.env, PROMPTOBUS_HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /step security \(reads-diff\)/);
  assert.match(run.stdout, /security:piece/);
});

test('an approver-only declaration has no review alias and waits for the owner result', async () => {
  const onlyHost = { ...host, pipeline: () => [pipeline.owner, pipeline.gates[2]] };
  await assert.rejects(() => review(onlyHost, { target: subject, task, dryRun: true }),
    /review has no reads-diff gate in the declared pipeline/);
  const out = await capture(() => review(onlyHost, { target: subject, task, approver: true, dryRun: true }));
  assert.match(out, /step approver \(writes-main-tree\)/);
  const noOwnerTask = 'step-no-owner-t20260927-000001';
  store.createTask(home, { id: noOwnerTask, title: 'missing owner result', status: 'active', participants: [] });
  store.upsertParticipant(home, noOwnerTask, store.participantRecord('worker:piece', {
    harness: 'claude', worktree: subject, started: assignedAt,
  }, registryOf(onlyHost)));
  assert.throws(() => planApprover(onlyHost, { target: subject, task: noOwnerTask, stepName: 'approver', dryRun: true }),
    /type=result message from worker:piece/);
});

test('a renamed owner is the recorded worktree owner and its result opens the main-tree gate', () => {
  const renamedHost = { ...host, pipeline: () => [
    { name: 'builder', kind: 'edits-tree' },
    { name: 'approver', kind: 'writes-main-tree' },
  ] };
  const renamedRegistry = registryOf(renamedHost);
  assert.ok(!admitsAddress(renamedRegistry, 'worker:piece'));
  assert.ok(admitsAddress(renamedRegistry, 'builder:piece'));
  assert.equal(renamedRegistry.activeSteps.join(','), 'builder,approver');
  assert.equal(addressList(renamedRegistry), 'orchestrator, builder:<slug> or approver:<slug>');
  const noOwnerTask = 'step-renamed-owner-t20260927-000002';
  store.createTask(home, { id: noOwnerTask, title: 'renamed owner without result', status: 'active', participants: [] });
  store.upsertParticipant(home, noOwnerTask, store.participantRecord('builder:piece', {
    harness: 'claude', worktree: subject, started: assignedAt,
  }, renamedRegistry));
  assert.throws(() => planApprover(renamedHost, { target: subject, task: noOwnerTask, stepName: 'approver', dryRun: true }),
    /type=result message from builder:piece/);
  store.sendMessage(home, noOwnerTask, {
    from: 'builder:piece', to: store.ORCHESTRATOR, type: 'result', body: 'reported',
  });
  const planned = planApprover(renamedHost, { target: subject, task: noOwnerTask, stepName: 'approver', dryRun: true });
  assert.equal(planned.address, 'approver:piece');
  assert.equal(planned.workerAddress, 'builder:piece');
});

test('the one direct route joins the declared owner and writes-main-tree step only', () => {
  const routedHost = { ...host, pipeline: () => [
    { name: 'builder', kind: 'edits-tree' },
    { name: 'security', kind: 'reads-diff' },
    { name: 'merge', kind: 'writes-main-tree' },
  ] };
  const routedTask = 'step-rights-t20260927-000004';
  const routedRegistry = registryOf(routedHost);
  assert.throws(() => planReview(routedHost, { target: subject, task, stepName: 'merge', dryRun: true }),
    /step merge is writes-main-tree, not reads-diff/);
  assert.throws(() => planApprover(routedHost, { target: subject, task, stepName: 'security', dryRun: true }),
    /step security is reads-diff, not writes-main-tree/);
  store.createTask(home, { id: routedTask, title: 'kind routes', status: 'active', participants: [] });
  const addresses = [
    ['builder:piece', '00000000-0000-4000-8000-000000000021'],
    ['security:piece', '00000000-0000-4000-8000-000000000022'],
    ['merge:piece', '00000000-0000-4000-8000-000000000023'],
  ];
  for (const [address, sessionId] of addresses) {
    store.upsertParticipant(home, routedTask, store.participantRecord(address, {
      harness: 'claude', sessionId, started: assignedAt,
      ...(address.startsWith('builder:') ? { worktree: subject } : {}),
      ...(address.startsWith('security:') ? { repoAbs: subject, reviewAssignedAt: assignedAt } : {}),
      ...(address.startsWith('merge:') ? { reviewSubject: subject } : {}),
    }, routedRegistry));
  }
  const send = (from, to, type = 'question', artifactPath = undefined) => store.sendMessage(home, routedTask, {
    from, to, type, body: 'route', artifactPath,
    session: store.participantOf(store.readTask(home, routedTask), from).metadata.sessionId,
  }, { registry: routedRegistry, status: 'promptobus status' });
  assert.ok(send('builder:piece', 'merge:piece').message.id);
  assert.ok(send('merge:piece', 'builder:piece').message.id);
  assert.throws(() => send('security:piece', 'builder:piece'), /through the orchestrator/);
  assert.throws(() => send('builder:piece', 'security:piece'), /through the orchestrator/);
  const attachment = path.join(box, 'security-attachment.txt');
  writeFileSync(attachment, 'not sent');
  assert.throws(() => send('security:piece', 'builder:piece', 'artifact', attachment), /through the orchestrator/);
  store.sendMessage(home, routedTask, { from: 'builder:piece', to: store.ORCHESTRATOR, type: 'result', body: 'reported' });
  store.sendMessage(home, routedTask, { from: 'security:piece', to: store.ORCHESTRATOR, type: 'result', body: 'reported' });
  const keyedHost = {
    ...routedHost,
    participantServers: () => ({ servers: { catalog: { type: 'http', url: 'http://catalog.invalid/mcp' } }, external: [] }),
    participantDenyToolsByKind: (kind) => ({
      tools: kind === 'writes-main-tree' ? [{ server: 'catalog', tool: 'create_entry' }] : [], complete: true,
    }),
  };
  const merge = planApprover(keyedHost, { target: subject, task: routedTask, stepName: 'merge', dryRun: true });
  assert.ok(merge.worktreePath.startsWith(path.join(clone, '.claude', 'worktrees')));
  assert.ok(merge.prompt.includes(`session cwd is the approver worktree ${merge.worktreePath}`));
  assert.ok(merge.addDirs.includes(subject));
  assert.ok(merge.settings.permissions.deny.includes('mcp__catalog__create_entry'));
});

test('only the declared edits-tree owner is selected from matching worktrees', () => {
  const nonOwner = { role: 'security', metadata: { worktree: subject } };
  const worker = { role: 'worker', metadata: { worktree: subject } };
  const builder = { role: 'builder', metadata: { worktree: subject } };
  const builderStep = { name: 'builder', kind: 'edits-tree' };
  assert.equal(worktreeOwner(pipeline.owner, { participants: [nonOwner, worker] }, subject), worker);
  assert.equal(worktreeOwner(builderStep, { participants: [nonOwner, builder] }, subject), builder);
  assert.equal(worktreeOwner(builderStep, { participants: [nonOwner] }, subject), null);
});

test('a renamed first review gate keeps solo review pickup on repeat', async () => {
  const soloHost = { ...host, pipeline: () => [pipeline.owner, pipeline.gates[1]] };
  const soloTask = 'step-solo-t20260927-000003';
  store.createTask(home, { id: soloTask, title: 'solo security review', status: 'active', participants: [] });
  store.upsertParticipant(home, soloTask, store.participantRecord('security:project', {
    harness: 'claude', repoAbs: clone, started: assignedAt, reviewAssignedAt: assignedAt,
  }, registryOf(soloHost)));
  const picked = planReview(soloHost, { target: clone, stepName: 'security', dryRun: true });
  assert.equal(picked.taskId, soloTask);
  assert.equal(picked.address, 'security:project');
  const repeated = await captureSplit(() => review(soloHost, { target: clone, strategy: 'balanced', dryRun: true }));
  assert.equal(repeated.value.taskId, soloTask);
  assert.equal(repeated.value.address, 'security:project');
  assert.match(repeated.value.routingSkipped, /--strategy routes a lift/);
});
