import './home.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeSandbox } from './sandbox.mjs';
import { createStandaloneHost } from '../dist/host-index.js';
import { participantMcp, participantPluginDir, participantSkillsRoot, skillSettings } from '../lib/spawn.js';
import { hostDenyClassification } from '../lib/review.js';
import { cursorDriver } from '../lib/driver-cursor.js';
import { codexDriver } from '../lib/driver-codex.js';
import { opencodeDriver } from '../lib/driver-opencode.js';
import { createBbHostIntegration } from '../lib/bb-host.js';

const root = makeSandbox('promptobus-host-composition-');
const projects = ['a', 'b'].map((name) => path.join(root, name));
for (const project of projects) {
  for (const tool of ['claude', 'cursor', 'codex', 'opencode']) {
    const skill = path.join(project, `.${tool}`, 'skills', 'selected');
    mkdirSync(skill, { recursive: true });
    writeFileSync(path.join(skill, 'SKILL.md'), `---\nname: selected\ndescription: Selected content\n---\n${project}\n`);
  }
  const manifest = path.join(project, 'plugin', '.claude-plugin');
  mkdirSync(manifest, { recursive: true });
  writeFileSync(path.join(manifest, 'plugin.json'), '{"name":"workspace"}\n');
  writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ skillOverrides: { [path.basename(project)]: 'off' } }));
}
const standalone = createStandaloneHost({ cwd: root });
const host = {
  ...standalone,
  participantLayoutRoot: (project) => project,
  pluginDir: (project) => path.join(project, 'plugin'),
  pluginManifestRel: () => 'plugin/.claude-plugin/plugin.json',
  participantServers: (project) => ({ servers: { selected: { command: 'node', args: [project] } }, external: [] }),
  participantDenyTools: (_role, project) => ({ tools: [{ server: 'selected', tool: path.basename(project) }], complete: true }),
};

test('project selection remains independent across A, B, A', () => {
  for (const project of [projects[0], projects[1], projects[0]]) {
    assert.equal(participantSkillsRoot(host, project), project);
    assert.equal(participantPluginDir(host, project), path.join(project, 'plugin'));
    assert.deepEqual(skillSettings(host, project), { skillOverrides: { [path.basename(project)]: 'off' } });
    const mcp = participantMcp(host, { address: 'worker:x', taskId: 'task', home: root, repoDir: project },
      { shadowedUserServers: () => [] });
    assert.deepEqual(mcp.descriptor.servers.selected.args, [project]);
    const deny = hostDenyClassification(host, { hostDenyRole: 'reviewer' }, ['selected'], project);
    assert.equal(deny.tools[0].tool, path.basename(project));
  }
});

test('legacy hosts keep workspace selection and explicit null disables layout', () => {
  assert.equal(participantSkillsRoot(standalone, projects[0]), realpathSync(root));
  assert.equal(participantSkillsRoot({ ...standalone, participantLayoutRoot: () => null }, projects[0]), null);
  assert.deepEqual(skillSettings({ ...standalone, participantLayoutRoot: () => null }, projects[0]), {});
  const pluginOnly = { ...host, participantLayoutRoot: () => null, workspaceRoot: () => projects[0] };
  assert.equal(participantPluginDir(pluginOnly, projects[0]), path.join(projects[0], 'plugin'));
  assert.equal(participantPluginDir({ ...pluginOnly, pluginDir: () => null }, projects[0]), null);
});

for (const driver of [cursorDriver, codexDriver, opencodeDriver]) {
  test(`${driver.id} reads skills from the selected project while retaining the bus root`, () => {
    const project = projects[1];
    const ctx = { root, skillsRoot: project, cwd: projects[0], ref: root, role: 'worker',
      task: 'composition-t20261015-100000', address: 'worker:x', home: path.join(root, '.promptobus'),
      settingsPath: path.join(root, `${driver.id}-settings.json`), mcpConfigPath: path.join(root, `${driver.id}-mcp.json`),
      guardCommand: 'node guard.js', prompt: 'Read selected content', model: driver.options.defaultModel,
      mcp: { address: 'worker:x', task: 'composition-t20261015-100000', home: root, servers: {} } };
    const plan = driver.prepare(ctx);
    assert.ok(plan.files.some((file) => file.copyFrom === path.join(project, `.${driver.id}`, 'skills')),
      JSON.stringify(plan.files));
    assert.ok(!plan.files.some((file) => file.copyFrom === path.join(root, `.${driver.id}`, 'skills')));
    const without = driver.prepare({ ...ctx, skillsRoot: null });
    assert.ok(!without.files.some((file) => file.copyFrom?.endsWith(`${path.sep}skills`)));
  });
}

test('BB participants select project skills, servers and write classification together', async () => {
  const integration = createBbHostIntegration({
    resolveHost: () => ({ ...host, collectRules: () => [], resolveRepoModule: () => null,
      skillsDir: (project) => path.join(project, '.claude', 'skills') }),
    listTools: async ({ configuration }) => [{ name: path.basename(configuration.args[0]), access: 'write' }],
    invokeTool: async () => ({}),
  });
  for (const project of [projects[0], projects[1], projects[0]]) {
    const context = await integration.collect({ root: project, role: 'reviewer' });
    assert.ok(context.skills[0].text.includes(project));
    assert.deepEqual(context.tools, []);
  }
  const shared = path.join(projects[0], '.claude/skills/_shared');
  mkdirSync(shared);
  writeFileSync(path.join(shared, 'standards.md'), 'shared standards');
  const context = await integration.collect({ root: projects[0], role: 'reviewer' });
  assert.equal(context.skills.length, 1);
  const resource = await integration.read({ root: projects[0], role: 'reviewer', path: path.join(shared, 'standards.md') });
  assert.ok(JSON.stringify(resource).includes('shared standards'));
});
