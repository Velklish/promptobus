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
import { planReview, review, step } from '../lib/review.js';
import { admitsAddress, registryOf } from '../dist/index.js';

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

test('a renamed owner still uses the worker address created by spawn', () => {
  const renamedHost = { ...host, pipeline: () => [
    { name: 'builder', kind: 'edits-tree' },
    { name: 'approver', kind: 'writes-main-tree' },
  ] };
  assert.ok(admitsAddress(registryOf(renamedHost), 'worker:piece'));
  assert.ok(admitsAddress(registryOf(renamedHost), 'builder:piece'));
  const planned = planApprover(renamedHost, { target: subject, task, stepName: 'approver', dryRun: true });
  assert.equal(planned.address, 'approver:piece');
  const noOwnerTask = 'step-renamed-owner-t20260927-000002';
  store.createTask(home, { id: noOwnerTask, title: 'renamed owner without result', status: 'active', participants: [] });
  store.upsertParticipant(home, noOwnerTask, store.participantRecord('worker:piece', {
    harness: 'claude', worktree: subject, started: assignedAt,
  }, registryOf(renamedHost)));
  assert.throws(() => planApprover(renamedHost, { target: subject, task: noOwnerTask, stepName: 'approver', dryRun: true }),
    /type=result message from worker:piece/);
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
