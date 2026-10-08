import './home.mjs';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { capturePrompts } from './prompt-sources.mjs';
import { hostOf } from '../lib/host.js';
import { planTeamlead } from '../lib/spawn.js';
import { planApprover } from '../lib/approver.js';
import { planReport } from '../lib/report.js';
import { bus, participantRecord, sendMessage, upsertParticipant } from '../lib/store.js';

export async function captureRolePrompts() {
  const prompts = await capturePrompts();
  const root = realpathSync(makeSandbox('promptobus-promptobus-role-prompts-'));
  writeHostConfig(root, { tools: ['claude', 'cursor', 'codex', 'opencode'] });
  const repo = path.join(root, 'sample');
  mkdirSync(repo);
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git('init', '-b', 'main');
  writeFileSync(path.join(root, 'AGENTS.md'), 'Workspace fixture rules.\n');
  writeFileSync(path.join(repo, 'AGENTS.md'), 'Keep changes within this repository.\n');
  writeFileSync(path.join(repo, 'sample.cs'), 'public const int Answer = 42;\n');
  git('add', '.');
  git('commit', '-qm', 'Fixture');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const brief = path.join(root, 'brief.md');
  writeFileSync(brief, '# Capture additional roles\nKeep the supplied task and evidence bindings.\n');
  const host = hostOf(root);
  const home = host.promptobusHome();
  const task = 'role-source-t20261008-000001';
  const started = '2026-10-08T00:00:00.000Z';
  bus(home, { cli: host.version }).createTask({
    id: task, title: 'Role source fixture',
    owner: participantRecord('orchestrator', { harness: 'claude', owner: 'fixture-owner' }),
  });
  for (const address of ['worker:sample', 'reviewer:sample']) {
    upsertParticipant(home, task, participantRecord(address, {
      harness: 'claude', repo: 'sample', repoAbs: repo, worktree: repo, branch: 'main',
      started, reviewAssignedAt: started, reviewSubject: repo,
    }));
    sendMessage(home, task, { from: address, to: 'orchestrator', type: 'result', body: 'Fixture result' });
  }
  const normalize = text => text.replaceAll(root, '<workspace>').replaceAll('\\', '/')
    .replace(/\b[0-9a-f]{40}\b/g, '<sha>')
    .replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\b/g, '<timestamp>')
    .replace(/-t\d{8}-\d{6}/g, '-t<time>');
  const previous = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'fixture-owner';
  try {
    for (const harness of ['claude', 'cursor', 'codex', 'opencode']) {
      for (const [role, prepare] of [
        ['approver', () => planApprover(host, { target: repo, task, harness, brief, dryRun: true })],
        ['teamlead', () => planTeamlead(host, { task, harness, brief, slug: 'group', dryRun: true })],
        ['reporter', () => planReport(host, { task, harness, dryRun: true })],
      ]) {
        try {
          const plan = await prepare();
          prompts[harness][role] = normalize(plan.prompt);
          if (plan.refusal) prompts[harness][`${role}Refusal`] = normalize(plan.refusal);
        } catch (error) { prompts[harness][`${role}Refusal`] = normalize(error.message); }
      }
    }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = previous;
  }
  return prompts;
}
