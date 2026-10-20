import './home.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
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
  return { root, repo, worktree, module, base, skills, host, classification, integration, calls };
}

function selectedFixture(t) {
  const s = fixture(t), profile = path.join(s.base, 'communication.md');
  writeFileSync(profile, 'PERSONAL_STYLE_SENTINEL');
  const unrelated = path.join(s.skills, 'unrelated');
  mkdirSync(unrelated); writeFileSync(path.join(unrelated, 'SKILL.md'), Buffer.from([0]));
  const collectRules = s.host.collectRules;
  s.host.collectRules = root => [...collectRules(root), profile];
  s.host.selectParticipantContext = ({ repoDir, role, task }) => ({
    rules: [...collectRules(repoDir), ...(task.purpose === 'technical' ? [] : [profile])]
      .map(file => ({ path: file, reason: task.purpose === 'technical' ? `${role} technical instructions` : `${task.purpose} instructions` })),
    skills: [{ name: 'canonical-skill', root: path.join(s.skills, 'canonical-skill'), reason: 'Task resources' }],
  });
  return { ...s, profile, input: { root: s.worktree, role: 'worker', task: { id: 'task-context', purpose: 'technical' } } };
}

test('selected technical contexts skip personal style and invalid unrelated skills before reading', async t => {
  const s = selectedFixture(t);
  for (const role of ['worker', 'reviewer']) {
    const context = await s.integration.prepare({ ...s.input, role });
    assert.deepEqual(context.rules.map(rule => rule.text.trim()), ['TOKEN=repo', 'TOKEN=module', 'TOKEN=base']);
    assert.equal(renderBbHostContext(context).includes('PERSONAL_STYLE_SENTINEL'), false);
    assert.deepEqual(context.skills.map(skill => skill.name), ['canonical-skill']);
    assert.deepEqual(context.selection.task, s.input.task);
    assert.equal(context.selection.rules[0].reason, `${role} technical instructions`);
    assert.deepEqual(context.selection.skills, [{ name: 'canonical-skill', root: path.join(s.skills, 'canonical-skill'), reason: 'Task resources' }]);
  }
});

test('consumer explicitly includes personal style for user-facing and author-voice tasks', async t => {
  const s = selectedFixture(t);
  for (const purpose of ['user-facing', 'author-voice']) {
    const context = await s.integration.prepare({ ...s.input, task: { id: s.input.task.id, purpose } });
    assert.match(renderBbHostContext(context), /PERSONAL_STYLE_SENTINEL/);
    assert.equal(context.selection.rules.at(-1).path, s.profile);
    assert.equal(context.selection.rules.at(-1).reason, `${purpose} instructions`);
  }
});

test('selected context requires explicit task identity and purpose', async t => {
  const s = selectedFixture(t);
  for (const task of [undefined, { id: 'task-context' }, { purpose: 'technical' }, { id: 'task-context', purpose: 'other' }]) {
    await assert.rejects(s.integration.prepare({ ...s.input, task }), /explicit task.*purpose/i);
  }
});

test('selected reviewer context retains the module review skill and its resource root', async t => {
  const s = selectedFixture(t), directory = path.join(s.module, 'review-instructions');
  mkdirSync(directory); writeFileSync(path.join(directory, 'SKILL.md'), 'MANDATORY_REVIEW_INSTRUCTIONS');
  writeFileSync(path.join(directory, 'reference.txt'), 'Required review reference');
  s.host.resolveRepoModule = () => ({ name: 'backend', meta: { review: { skill: 'module-review' } } });
  s.host.reviewSkillDir = name => { assert.equal(name, 'module-review'); return directory; };
  const input = { ...s.input, role: 'reviewer' }, context = await s.integration.prepare(input);
  assert.match(renderBbHostContext(context), /MANDATORY_REVIEW_INSTRUCTIONS/);
  assert.deepEqual(context.selection.skills.at(-1), { name: 'module-review', root: directory, reason: 'Required module review skill' });
  const resource = await s.integration.read({ ...input, preparedContext: context, path: path.join(directory, 'reference.txt') });
  assert.match(JSON.stringify(resource), /Required review reference/);
});

test('selected rules deliver full declared dependency closure with exact-file resources', async t => {
  const s = selectedFixture(t), a = path.join(s.worktree, 'AGENTS.md'), b = path.join(s.worktree, 'run.md'), c = path.join(s.worktree, 'checks.md');
  writeFileSync(b, 'Required execution instructions'); writeFileSync(c, 'Required check instructions');
  const selected = [{ path: a, reason: 'Repository instructions', requires: [b] },
    { path: b, reason: 'Required by repository instructions', requires: [c] }, { path: c, reason: 'Required by execution instructions' }];
  s.host.selectParticipantContext = () => ({ rules: selected, skills: [] });
  const context = await s.integration.prepare(s.input);
  assert.deepEqual(context.rules.map(rule => rule.path), [a, b, c]);
  assert.deepEqual(context.selection.rules, selected.map(rule => ({ ...rule, requires: rule.requires ?? [] })));
  assert.match(JSON.stringify(await s.integration.read({ ...s.input, preparedContext: context, path: c })), /Required check instructions/);
  const neighbor = path.join(s.worktree, 'optional.md'); writeFileSync(neighbor, 'Optional neighboring instructions');
  await assert.rejects(s.integration.read({ ...s.input, preparedContext: context, path: neighbor }), /outside the declared/);
  selected.splice(1, 1);
  await assert.rejects(s.integration.prepare(s.input), error => error.message.includes(`${a} -> ${b}`) && /selected/.test(error.message));
  selected.splice(1, 0, { path: b, reason: 'Required by repository instructions', requires: [c] });
  rmSync(b);
  await assert.rejects(s.integration.prepare(s.input), error => error.message.includes(`${a} -> ${b}`) && /unavailable/.test(error.message));
  writeFileSync(b, Buffer.from([0]));
  await assert.rejects(s.integration.prepare(s.input), error => error.message.includes(`${a} -> ${b}`) && /unavailable.*binary/.test(error.message));
});

test('prepared selected context refuses expansion and vanished selectors before payload reads', async t => {
  const s = selectedFixture(t), context = await s.integration.prepare(s.input);
  const select = s.host.selectParticipantContext;
  writeFileSync(s.profile, Buffer.from([0]));
  s.host.selectParticipantContext = input => {
    const selected = select(input); selected.rules.push({ path: s.profile, reason: 'Changed callback' }); return selected;
  };
  const input = { ...s.input, preparedContext: context };
  for (const operation of [() => s.integration.collect(input), () => s.integration.read({ ...input, path: s.profile }),
    () => s.integration.invoke({ ...input, server: 'catalog', tool: 'read', args: {}, actor: { task: s.input.task.id, participant: 'worker-one' } })]) {
    await assert.rejects(operation(), /expanded.*prepare context again/);
  }
  assert.equal(s.calls.length, 0);
  s.host.selectParticipantContext = input => {
    const selected = select(input); selected.skills.push({ name: 'unrelated', root: path.join(s.skills, 'unrelated'), reason: 'Changed callback' }); return selected;
  };
  await assert.rejects(s.integration.collect(input), /expanded to skill.*prepare context again/);
  delete s.host.selectParticipantContext;
  await assert.rejects(s.integration.collect(input), /selector disappeared.*prepare context again/);
});

test('prepared selected context permits narrowing and explicit preparation permits a new selection', async t => {
  const s = selectedFixture(t), preparedContext = await s.integration.prepare(s.input), select = s.host.selectParticipantContext;
  s.host.selectParticipantContext = input => ({ rules: select(input).rules.slice(0, 1), skills: [] });
  const context = await s.integration.collect({ ...s.input, preparedContext });
  assert.equal(context.rules.length, 1); assert.equal(context.skills.length, 0);
  await assert.rejects(s.integration.read({ ...s.input, preparedContext, path: path.join(s.base, 'AGENTS.md') }), /outside the declared/);
  s.host.selectParticipantContext = input => {
    const selected = select(input); selected.rules.push({ path: s.profile, reason: 'New task context' }); return selected;
  };
  assert.match(renderBbHostContext(await s.integration.prepare({ ...s.input, preparedContext })), /PERSONAL_STYLE_SENTINEL/);
});

test('prepared selected context rejects a symlink replacement of a canonical rule', async t => {
  const s = selectedFixture(t), preparedContext = await s.integration.prepare(s.input), file = path.join(s.worktree, 'AGENTS.md');
  rmSync(file); symlinkSync(s.profile, file);
  await assert.rejects(s.integration.read({ ...s.input, preparedContext, path: file }), /expanded.*prepare context again/);
});

test('prepared tools never gain identities or read-to-write access and current reviewer denials still apply', async t => {
  const s = selectedFixture(t), input = { ...s.input, role: 'reviewer' }, preparedContext = await s.integration.prepare(input);
  s.host.participantDenyTools = () => ({ complete: true, tools: [{ server: 'catalog', tool: 'read' }, { server: 'catalog', tool: 'write' }] });
  const context = await s.integration.collect({ ...input, preparedContext });
  assert.deepEqual(context.tools, []);
  await assert.rejects(s.integration.invoke({ ...input, preparedContext, server: 'catalog', tool: 'read', args: {},
    actor: { task: s.input.task.id, participant: 'reviewer-one' } }), /not admitted/);
  let catalog = [{ name: 'read', description: 'Read catalog', inputSchema: {}, access: 'read' }];
  const integration = createBbHostIntegration({ resolveHost: () => s.host, listTools: async () => catalog, invokeTool: async () => assert.fail('No expanded tool may run') });
  const worker = await integration.prepare(s.input);
  catalog = [{ ...catalog[0], access: 'write' }, { name: 'new', description: 'New read', inputSchema: {}, access: 'read' }];
  assert.deepEqual((await integration.collect({ ...s.input, preparedContext: worker })).tools, []);
});

test('prepared task identity and purpose cannot be changed by a context request', async t => {
  const s = selectedFixture(t), preparedContext = await s.integration.prepare(s.input);
  for (const task of [{ ...s.input.task, id: 'other-task' }, { ...s.input.task, purpose: 'author-voice' }]) {
    await assert.rejects(s.integration.collect({ ...s.input, task, preparedContext }), /task selection changed.*prepare context again/);
  }
});

test('selected rules canonicalize aliases and merge declared edges without changing first-source precedence', async t => {
  const s = selectedFixture(t), a = path.join(s.worktree, 'AGENTS.md'), alias = path.join(s.worktree, 'alias.md'), b = path.join(s.worktree, 'run.md');
  symlinkSync(a, alias); writeFileSync(b, 'Required execution instructions');
  s.host.selectParticipantContext = () => ({ rules: [{ path: alias, reason: 'First source' },
    { path: a, reason: 'Duplicate source', requires: [b, b] }, { path: b, reason: 'Required source' }], skills: [] });
  const context = await s.integration.prepare(s.input);
  assert.deepEqual(context.selection.rules, [{ path: a, reason: 'First source', requires: [b] }, { path: b, reason: 'Required source', requires: [] }]);
  assert.deepEqual(context.rules.map(rule => rule.path), [a, b]);
  s.host.selectParticipantContext = () => ({ rules: [{ path: a, reason: 'First source', requires: [b] }], skills: [] });
  await assert.rejects(s.integration.collect({ ...s.input, preparedContext: context }), error => error.message.includes(`${a} -> ${b}`) && /full closure/.test(error.message));
});

test('selected skill instructions and prepared skill roots cannot escape through replaced symlinks', async t => {
  const s = selectedFixture(t), directory = path.join(s.skills, 'canonical-skill'), instructions = path.join(directory, 'SKILL.md');
  const preparedContext = await s.integration.prepare(s.input);
  rmSync(instructions); symlinkSync(s.profile, instructions);
  await assert.rejects(s.integration.collect({ ...s.input, preparedContext }), /instructions escape their root/);
  rmSync(directory, { recursive: true });
  const other = path.join(s.root, 'other-skill'); mkdirSync(other); writeFileSync(path.join(other, 'SKILL.md'), Buffer.from([0]));
  symlinkSync(other, directory);
  await assert.rejects(s.integration.collect({ ...s.input, preparedContext }), /expanded to skill.*prepare context again/);
});

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
    assert.deepEqual(Object.keys(context), ['rules', 'skills', 'tools']);
  }
});

test('legacy contexts preserve declared shared resources without selection metadata', async t => {
  const s = fixture(t), shared = path.join(s.skills, '_shared');
  mkdirSync(shared); writeFileSync(path.join(shared, 'reference.txt'), 'Legacy shared resource');
  const context = await s.integration.prepare({ root: s.worktree, role: 'worker' });
  assert.deepEqual(Object.keys(context), ['rules', 'skills', 'tools']);
  assert.match(JSON.stringify(await s.integration.read({ root: s.worktree, role: 'worker', preparedContext: context,
    path: path.join(shared, 'reference.txt') })), /Legacy shared resource/);
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


test('BB context refuses symlink skill entries instead of silently omitting canonical instructions', async t => {
  const s = fixture(t);
  symlinkSync(path.join(s.skills, 'canonical-skill'), path.join(s.skills, 'linked-skill'));
  await assert.rejects(s.integration.collect({ root: s.worktree, role: 'worker' }), /symlink.*skill/i);
});

test('BB admission refuses a missing reviewer or renamed configured step before result lookup', async t => {
  const s = fixture(t);
  for (const steps of [
    [{ name: 'worker', kind: 'edits-tree' }, { name: 'approver', kind: 'writes-main-tree' }],
    [{ name: 'builder', kind: 'edits-tree' }, { name: 'reviewer', kind: 'reads-diff' }, { name: 'approver', kind: 'writes-main-tree' }],
    [{ name: 'worker', kind: 'edits-tree' }, { name: 'reviewer', kind: 'writes-main-tree' }, { name: 'approver', kind: 'writes-main-tree' }],
  ]) {
    s.host.pipeline = () => steps;
    await assert.rejects(s.integration.checkStep({ repoDir: s.worktree }), /BB requires the shipped.*pipeline/);
  }
});
