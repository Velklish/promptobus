import './home.mjs';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { hostOf } from '../lib/host.js';
import { planSpawn } from '../lib/spawn.js';
import { planReview } from '../lib/review.js';
import { planLead } from '../lib/lead.js';
import { bus, participantRecord, upsertParticipant } from '../lib/store.js';
import { serviceFor } from '../lib/server.js';
import { createMcpServer } from '../dist/index.js';

export async function capturePrompts() {
  const root = realpathSync(makeSandbox('promptobus-promptobus-prompts-'));
  writeHostConfig(root, { tools: ['claude', 'cursor', 'codex', 'opencode'] });
  const repo = path.join(root, 'sample');
  mkdirSync(repo);
  function git(...args) {
    const result = spawnSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }
  git('init', '-b', 'main');
  writeFileSync(path.join(repo, 'AGENTS.md'), 'Keep changes within this repository.\n');
  writeFileSync(path.join(repo, 'sample.cs'), 'public const int Answer = 41;\n');
  git('add', '.');
  git('commit', '-qm', 'Fixture');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  writeFileSync(path.join(repo, 'sample.cs'), 'public const int Answer = 42;\n');
  const brief = path.join(root, 'brief.md');
  writeFileSync(brief, '# Capture the role instructions\nKeep the supplied role profile and report exact evidence.\n');
  const host = hostOf(root);
  const task = 'prompt-source-t20261008-000001';
  bus(host.promptobusHome(), { cli: host.version }).createTask({
    id: task, title: 'Prompt source fixture',
    owner: participantRecord('orchestrator', { harness: 'codex', owner: 'fixture-owner' }),
  });
  const normalize = (text) => text.replaceAll(root, '<workspace>').replaceAll('\\', '/')
    .replace(/\b[0-9a-f]{40}\b/g, '<sha>')
    .replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\b/g, '<timestamp>');
  const prompts = {};
  for (const harness of ['claude', 'cursor', 'codex', 'opencode']) {
    const worker = await planSpawn(host, { repo: 'sample', brief, task, worker: 'source', harness, dryRun: true });
    const reviewer = planReview(host, { target: repo, task, title: 'Prompt source fixture', harness, dryRun: true });
    prompts[harness] = { worker: normalize(worker.prompt), reviewer: normalize(reviewer.prompt) };
    if (harness === 'codex') {
      const lead = await planLead(host, { brief, task: 'prompt-owner-t20261008-000002', permissionMode: 'full-access', dryRun: true });
      prompts[harness].orchestrator = normalize(lead.prompt);
    } else {
      try { await planLead(host, { harness, brief, permissionMode: 'full-access', dryRun: true }); }
      catch (error) { prompts[harness].orchestratorRefusal = error.message; }
    }
  }
  return prompts;
}

export async function capturePreflightReplies(address) {
  const root = makeSandbox('promptobus-promptobus-preflight-');
  writeHostConfig(root, { tools: ['codex'] });
  const host = hostOf(root);
  const home = host.promptobusHome();
  const task = 'preflight-t20261008-000001';
  const native = address === 'orchestrator' ? 'fixture-root-thread' : 'fixture-reviewer-thread';
  bus(home, { cli: host.version }).createTask({
    id: task, title: 'Fresh root',
    owner: participantRecord('orchestrator', { harness: 'codex', mode: 'managed', owner: 'fixture-root-thread' }),
  });
  if (address !== 'orchestrator') {
    upsertParticipant(home, task, participantRecord(address, { harness: 'codex', mode: 'managed', owner: native }));
  }
  const server = createMcpServer({
    service: serviceFor(host), protocolVersions: ['2025-06-18'],
    resolveIdentity: () => ({ home, role: address, declaredTask: task, session: native }),
    serverInfo: () => ({ name: 'promptobus', version: host.version }),
    onJoin: () => {}, decorateParticipant: () => [], stalls: () => null,
    errorText: (event) => `error: ${event.kind}`,
  });
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    ...['promptobus_task', 'promptobus_mailbox'].map((name, index) => ({
      jsonrpc: '2.0', id: index + 2, method: 'tools/call', params: { name, arguments: {} },
    })),
  ];
  const output = [];
  await server.serve({
    input: Readable.from([requests.map((request) => JSON.stringify(request)).join('\n') + '\n']),
    output: { write: (line) => output.push(JSON.parse(line)) },
  });
  return {
    tools: output[0].result.tools.map((tool) => tool.name),
    task: output[1].result.content[0].text, mailbox: output[2].result.content[0].text,
  };
}
