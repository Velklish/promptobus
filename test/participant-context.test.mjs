import './home.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeContextDeclaration, selectParticipantContext } from '../lib/participant-context.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'participant-context-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skill = path.join(root, 'installed', 'check'), shared = path.join(root, 'installed', '_shared');
  mkdirSync(skill, { recursive: true }); mkdirSync(shared);
  const rule = path.join(root, 'AGENTS.md'), resource = path.join(shared, 'contract.md');
  writeFileSync(rule, Buffer.from([0])); writeFileSync(path.join(skill, 'SKILL.md'), Buffer.from([0]));
  writeFileSync(resource, 'Exact contract');
  const selection = { rules: [{ path: rule, reason: 'Mandatory rule' }], skills: [{ name: 'check', root: skill, reason: 'Selected check' }],
    resources: [{ path: resource, reason: 'Selected contract' }] };
  const host = { selectParticipantContext: () => selection, resolveRepoModule: () => null, reviewSkillDir: () => skill };
  const task = { id: 'task-explicit-context', purpose: 'technical', context: { skills: [{ name: 'check', reason: 'Validate contract',
    requires: [{ kind: 'resource', path: resource }] }], resources: [{ path: resource, reason: 'Check reference', requires: [{ kind: 'rule', path: rule }] }] } };
  return { root, skill, rule, resource, selection, host, task, input: { root, role: 'worker', task } };
}

test('task declarations are strict, detached and deeply frozen', () => {
  const input = { skills: [{ name: 'check', reason: 'Inspect behavior', requires: [{ kind: 'skill', name: 'dependency' }] }], resources: [] };
  const declaration = normalizeContextDeclaration(input);
  input.skills[0].requires[0].name = 'changed';
  assert.equal(declaration.skills[0].requires[0].name, 'dependency');
  assert.throws(() => { declaration.skills.push({ name: 'other', reason: 'Changed' }); }, TypeError);
  assert.throws(() => { declaration.skills[0].requires[0].name = 'changed'; }, TypeError);
  for (const value of [null, [], {}, { skills: [], resources: [], extra: true }, { skills: [{ name: '../escape', reason: 'No' }], resources: [] },
    { skills: [], resources: [{ path: 'relative.md', reason: 'No' }] }, { skills: [{ name: 'check', reason: 'No', requires: [{ kind: 'skill', name: 'x', path: '/x' }] }], resources: [] },
    { skills: [{ name: 'check', reason: 'A' }, { name: 'check', reason: 'B' }], resources: [] }]) assert.throws(() => normalizeContextDeclaration(value));
});

test('an explicit declaration refuses unsupported Hosts while legacy purpose-only requests stay compatible', t => {
  const s = fixture(t); delete s.host.selectParticipantContext;
  assert.throws(() => selectParticipantContext(s.host, s.input), /declaration requires Host selector support/);
  assert.equal(selectParticipantContext(s.host, { ...s.input, task: { id: s.task.id, purpose: 'technical' } }), null);
});

test('shared admission delivers the complete immutable task and metadata without reading payload bodies', t => {
  const s = fixture(t);
  s.host.selectParticipantContext = input => { assert.deepEqual(input.task, s.task); return s.selection; };
  const result = selectParticipantContext(s.host, s.input);
  assert.deepEqual(result.task, s.task);
  assert.equal(result.skills[0].sourceRoot, s.skill); assert.equal(result.resources[0].sourcePath, s.resource);
  assert.deepEqual(result.skills[0].requires, [{ kind: 'resource', path: s.resource }]);
  assert.deepEqual(result.resources[0].requires, [{ kind: 'rule', path: s.rule }]);
  for (const node of [...result.rules, ...result.skills, ...result.resources]) assert.equal(Object.hasOwn(node, 'text'), false);
  assert.throws(() => { result.resources[0].sourcePath = '/other'; }, TypeError);
});

test('declared skill/resource/rule closure refuses missing nodes with the exact parent and dependency', t => {
  const s = fixture(t);
  for (const [change, parent, dependency] of [
    [() => { s.selection.resources = []; }, 'check', s.resource],
    [() => { s.selection.rules = []; }, s.resource, s.rule],
    [() => { s.task.context.skills[0].requires = [{ kind: 'skill', name: 'missing' }]; }, 'check', 'missing'],
  ]) {
    s.selection.resources = [{ path: s.resource, reason: 'Selected contract' }]; s.selection.rules = [{ path: s.rule, reason: 'Mandatory' }];
    change();
    assert.throws(() => selectParticipantContext(s.host, s.input), error => error.message.includes(`${parent} -> ${dependency}`));
  }
});

test('required module review skills remain admitted with an explicitly empty extra skill set', t => {
  const s = fixture(t); s.task.context = { skills: [], resources: [] }; s.selection.skills = []; s.selection.resources = [];
  s.host.resolveRepoModule = () => ({ meta: { review: { skill: 'module-review' } } });
  const result = selectParticipantContext(s.host, { ...s.input, role: 'reviewer' });
  assert.equal(result.skills[0].name, 'module-review'); assert.equal(result.skills[0].reason, 'Required module review skill');
});

test('complete declared cycles need no traversal order and unavailable dependencies name their parent', t => {
  const s = fixture(t); s.task.context.resources[0].requires = [{ kind: 'skill', name: 'check' }];
  assert.equal(selectParticipantContext(s.host, s.input).resources.length, 1);
  const missing = path.join(s.root, 'missing.md'); s.task.context.skills[0].requires = [{ kind: 'resource', path: missing }];
  assert.throws(() => selectParticipantContext(s.host, s.input), error => error.message.includes(`skill check -> ${missing}`) && /unavailable/.test(error.message));
});

test('prepared admission rejects changed declarations and expanded exact resources before payload reads', t => {
  const s = fixture(t), preparedSelection = selectParticipantContext(s.host, s.input);
  s.task.context.skills[0].reason = 'Changed reason';
  assert.throws(() => selectParticipantContext(s.host, { ...s.input, preparedSelection }), /task selection changed/);
  s.task.context.skills[0].reason = 'Validate contract';
  const neighbor = path.join(path.dirname(s.resource), 'private.md'); writeFileSync(neighbor, Buffer.from([0]));
  s.selection.resources.push({ path: neighbor, reason: 'Expanded' });
  assert.throws(() => selectParticipantContext(s.host, { ...s.input, preparedSelection }), /expanded to resource.*prepare context again/);
});

test('logical skill/resource provenance survives store symlinks and is part of the prepared ceiling', t => {
  const s = fixture(t), logical = path.join(s.root, 'logical'); mkdirSync(logical);
  const skillAlias = path.join(logical, 'check'), resourceAlias = path.join(logical, 'contract.md');
  symlinkSync(s.skill, skillAlias); symlinkSync(s.resource, resourceAlias);
  s.selection.skills[0].root = skillAlias; s.selection.resources[0].path = resourceAlias;
  const preparedSelection = selectParticipantContext(s.host, s.input);
  assert.equal(preparedSelection.skills[0].root, s.skill); assert.equal(preparedSelection.skills[0].sourceRoot, skillAlias);
  assert.equal(preparedSelection.resources[0].path, s.resource); assert.equal(preparedSelection.resources[0].sourcePath, resourceAlias);
  s.selection.skills[0].root = s.skill;
  assert.throws(() => selectParticipantContext(s.host, { ...s.input, preparedSelection }), /expanded to skill/);
  s.selection.skills[0].root = skillAlias; s.selection.resources[0].path = s.resource;
  assert.throws(() => selectParticipantContext(s.host, { ...s.input, preparedSelection }), /expanded to resource/);
});

test('ambiguous skill names and directory resources refuse admission', t => {
  const s = fixture(t), other = path.join(s.root, 'other'); mkdirSync(other);
  s.selection.skills.push({ name: 'check', root: other, reason: 'Ambiguous' });
  assert.throws(() => selectParticipantContext(s.host, s.input), /Ambiguous selected Host skill/);
  s.selection.skills.pop(); s.selection.resources = [{ path: path.dirname(s.resource), reason: 'Directory' }];
  assert.throws(() => selectParticipantContext(s.host, s.input), /not a file/);
});
