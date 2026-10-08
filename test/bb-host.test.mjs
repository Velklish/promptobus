import './home.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBbHostIntegration, renderBbHostContext } from '../lib/bb-host.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'promptobus-review-files-host-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repositories', 'backend'), worktree = path.join(root, 'worktrees', 'backend');
  const module = path.join(root, 'modules', 'backend'), base = path.join(root, 'base'), skills = path.join(root, 'skills');
  for (const p of [repo, worktree, module, base, path.join(skills, 'canonical-skill')]) mkdirSync(p, { recursive: true });
  for (const [p, token] of [[repo, 'repo'], [worktree, 'repo'], [module, 'module'], [base, 'base']]) writeFileSync(path.join(p, 'AGENTS.md'), `TOKEN=${token}\n`);
  writeFileSync(path.join(skills, 'canonical-skill', 'SKILL.md'), '---\nname: canonical-skill\n---\nRead the catalog before changes.');
  writeFileSync(path.join(skills, 'canonical-skill', 'reference.txt'), 'canonical resource');
  writeFileSync(path.join(root, 'private.txt'), 'not a context resource');
  const calls = [];
  const classification = { tools: [{ server: 'catalog', tool: 'write' }], complete: true };
  const host = { collectRules: p => [path.join(p, 'AGENTS.md'), path.join(module, 'AGENTS.md'), path.join(base, 'AGENTS.md')],
    skillsDir: () => skills, resolveRepoModule: () => ({ name: 'backend', meta: null }), reviewSkillDir: () => skills,
    participantServers: () => ({ servers: { catalog: { command: 'fixture', env: { SECRET: 'private-token' } } }, external: [] }),
    participantDenyTools: () => classification };
  const integration = createBbHostIntegration({ resolveHost: () => host,
    listTools: async () => [{ name: 'read', description: 'Read catalog', inputSchema: { type: 'object' }, access: 'read' },
      { name: 'write', description: 'Change catalog', inputSchema: { type: 'object' }, access: 'write' }],
    invokeTool: async input => { calls.push(input); return { called: input.tool }; } });
  return { root, repo, worktree, skills, host, classification, integration, calls };
}

test('Host rules retain repo/module/base precedence and use the actual BB worktree', async t => {
  const s = fixture(t);
  for (const root of [s.repo, s.worktree]) {
    const context = await s.integration.collect({ root, role: 'worker' });
    assert.equal(context.rules[0].path, path.join(root, 'AGENTS.md'));
    assert.deepEqual(context.rules.map(r => r.text.trim()), ['TOKEN=repo', 'TOKEN=module', 'TOKEN=base']);
    assert.match(renderBbHostContext(context), /highest priority first/);
    assert.equal(context.skills[0].name, 'canonical-skill');
    assert.match(renderBbHostContext(context), /Read the catalog before changes/);
    assert.equal(JSON.stringify(context).includes('private-token'), false);
  }
});

test('worker invokes canonical writes with host-supplied configuration and authenticated identity', async t => {
  const s = fixture(t);
  const actor = { task: 'task', participant: 'worker-one' };
  assert.deepEqual(await s.integration.invoke({ root: s.worktree, role: 'worker', server: 'catalog', tool: 'write', args: { value: 1 }, actor }),
    { called: 'write' });
  assert.equal(s.calls[0].configuration.env.SECRET, 'private-token');
  assert.deepEqual(s.calls[0].actor, actor); assert.equal(s.calls[0].role, 'worker');
});

test('reviewer receives reads and mechanically rejects canonical writes and unknown tools before dispatch', async t => {
  const s = fixture(t); const input = { root: s.worktree, role: 'reviewer', server: 'catalog', actor: { participant: 'reviewer-one', task: 'task' } };
  const context = await s.integration.collect(input);
  assert.deepEqual(context.tools.map(t => t.tool), ['read']);
  assert.deepEqual(await s.integration.invoke({ ...input, tool: 'read', args: {} }), { called: 'read' });
  for (const tool of ['write', 'unlisted']) await assert.rejects(s.integration.invoke({ ...input, tool, args: {} }), /not admitted/);
  assert.equal(s.calls.length, 1); assert.equal(s.calls[0].role, 'reviewer');
});

test('missing or incomplete write classification refuses reviewer context before external invocation', async t => {
  const s = fixture(t); s.classification.complete = false;
  await assert.rejects(s.integration.collect({ root: s.worktree, role: 'reviewer' }), /classification.*incomplete/);
  s.classification.complete = true; s.classification.tools = [];
  await assert.rejects(s.integration.collect({ root: s.worktree, role: 'reviewer' }), /write.*classification/);
  assert.equal(s.calls.length, 0);
});

test('reporter uses reviewer classification with legacy and strict kind Host contracts', async t => {
  const s = fixture(t);
  s.host.participantDenyTools = role => { assert.equal(role, 'reviewer'); return s.classification; };
  const input = { root: s.worktree, role: 'reporter', server: 'catalog', actor: { task: 'task', participant: 'reporter' } };
  for (const byKind of [false, true]) {
    if (byKind) s.host.participantDenyToolsByKind = kind => { assert.equal(kind, 'reads-diff'); return s.classification; };
    const context = await s.integration.collect(input);
    assert.deepEqual(context.tools.map(t => t.tool), ['read']);
    assert.deepEqual(await s.integration.invoke({ ...input, tool: 'read', args: {} }), { called: 'read' });
    await assert.rejects(s.integration.invoke({ ...input, tool: 'write', args: {} }), /not admitted/);
  }
  assert.deepEqual(s.calls.map(call => call.role), ['reporter', 'reporter']);
});

test('declared canonical servers require an explicit integration rather than claiming undelivered parity', async t => {
  const s = fixture(t);
  const integration = createBbHostIntegration({ resolveHost: () => s.host });
  await assert.rejects(integration.collect({ root: s.worktree, role: 'worker' }), /canonical tool adapter/);
});

test('Host resource reads include canonical skill references and refuse unrelated workspace files', async t => {
  const s = fixture(t);
  const resource = await s.integration.read({ root: s.worktree, role: 'reviewer', path: path.join(s.skills, 'canonical-skill', 'reference.txt') });
  assert.match(JSON.stringify(resource), /canonical resource/);
  await assert.rejects(s.integration.read({ root: s.worktree, role: 'reviewer', path: path.join(s.root, 'private.txt') }), /outside the declared/);
});
