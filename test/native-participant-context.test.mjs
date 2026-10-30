import './home.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { makeSandbox, resetCliCaches, stubCommand, writeHostConfig } from './sandbox.mjs';
import { hostOf } from '../lib/host.js';
import { planSpawn, planTeamlead, writeLaunchFiles } from '../lib/spawn.js';
import { planReview, review } from '../lib/review.js';
import { planLead } from '../lib/lead.js';
import { planReport } from '../lib/report.js';
import { planApprover } from '../lib/approver.js';
import { runPromptobus } from '../lib/cli.js';
import { claudeDriver } from '../lib/driver-claude.js';
import { cursorDriver } from '../lib/driver-cursor.js';
import { codexDriver, installPrivateHomeLayer } from '../lib/driver-codex.js';
import { opencodeDriver } from '../lib/driver-opencode.js';
import { assertNativeContextDriver, contextCliOptions, nativeContextMetadata, nativeContextPrompt, prepareNativeContext, selectedNativeFiles } from '../lib/native-participant-context.js';
import { createTask, participantRecord, readTask, sendMessage, sessionIdentity, upsertParticipant } from '../lib/store.js';
import { REGISTRY } from '../lib/drivers.js';
import { openParticipant } from '../dist/index.js';
import { reviewerFiles } from '../lib/reviewer-files.js';
import { capture } from './console.mjs';

const sandbox = realpathSync(makeSandbox('promptobus-native-context-'));
process.env.CLAUDE_CODE_SESSION_ID = 'native-context-owner';
const root = path.join(sandbox, 'workspace');
const repo = path.join(root, 'demo');
const installed = path.join(root, 'installed', 'skills');
const put = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); return file; };
const git = (...args) => {
  const result = spawnSync('git', ['-C', repo, '-c', 'user.name=test', '-c', 'user.email=test@test', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};
mkdirSync(repo, { recursive: true });
writeHostConfig(root, { tools: ['claude', 'cursor', 'codex', 'opencode'] });
const workspaceRule = put(path.join(root, 'AGENTS.md'), 'Required workspace rule.\n');
const repoRule = put(path.join(repo, 'AGENTS.md'), 'Required repository rule.\n');
put(path.join(repo, 'file.txt'), 'before\n');
git('init', '-b', 'main'); git('add', '.'); git('commit', '-qm', 'fixture');
git('update-ref', 'refs/remotes/origin/main', 'HEAD');
git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
put(path.join(repo, 'file.txt'), 'after\n');
const brief = put(path.join(root, 'brief.md'), '# Selected native work\nChange the assigned file.\n');
const alpha = put(path.join(installed, 'alpha', 'SKILL.md'), '# Alpha\nRead [standard](../_shared/standard.md).\n');
put(path.join(installed, 'alpha', 'scripts', 'run.sh'), '#!/bin/sh\nexit 0\n');
chmodSync(path.join(installed, 'alpha', 'scripts', 'run.sh'), 0o755);
put(path.join(installed, 'beta', 'SKILL.md'), '# Beta\n');
put(path.join(installed, 'review', 'SKILL.md'), '# Required module review\n');
const resource = put(path.join(installed, '_shared', 'standard.md'), 'Required exact standard.\n');
put(path.join(installed, '_shared', 'sibling.md'), 'Unselected shared sibling.\n');
const profile = put(path.join(installed, 'my-voice', 'SKILL.md'), 'Excluded personal profile A.\n');
for (const layout of ['.cursor', '.codex', '.opencode']) put(path.join(root, layout, 'skills', 'my-voice', 'SKILL.md'), 'Legacy full-container source.\n');
const declaration = { skills: [{ name: 'alpha', reason: 'Task procedure', requires: [{ kind: 'skill', name: 'beta' }, { kind: 'resource', path: resource }] },
  { name: 'beta', reason: 'Declared dependency' }], resources: [{ path: resource, reason: 'Exact procedure standard' }] };
const calls = [];
const host = Object.create(hostOf(root));
host.collectRules = () => { throw new Error('selected context reached legacy collectRules'); };
host.resolveRepoModule = () => ({ name: 'fixture', meta: { review: { skill: 'review' } } });
host.reviewSkillDir = name => path.join(installed, name);
host.selectParticipantContext = ({ repoDir, role, task }) => {
  calls.push({ repoDir, role, task });
  return { rules: [{ path: workspaceRule, reason: 'Mandatory workspace authority' }, { path: repoRule, reason: 'Mandatory repository authority' }],
    skills: (task.context?.skills ?? []).map(skill => ({ ...skill, root: path.join(installed, skill.name) })),
    resources: task.context?.resources ?? [] };
};
const options = { contextPurpose: 'technical', contextDeclaration: declaration };
const prepare = (extra = {}) => prepareNativeContext(host, { root: repo, role: 'worker', taskId: 'native-t20261020-000001', options, ...extra });
const selection = prepare();

for (const kind of ['leaf', 'ancestor']) {
  test(`native resource open race refuses ${kind} substitution before reading bytes`, () => {
    const directory = path.join(sandbox, `resource-race-${kind}`), source = path.join(directory, 'selected'), foreign = path.join(directory, 'foreign');
    const file = put(path.join(source, 'reference.md'), 'Selected body.\n');
    const outside = put(path.join(foreign, 'reference.md'), 'FOREIGN BODY MUST NOT ENTER BOOTSTRAP');
    const prepared = prepare({ options: { contextPurpose: 'technical', contextDeclaration: { skills: [], resources: [{ path: file, reason: 'Exact race fixture' }] } } });
    const originalOpen = fs.openSync, originalRead = fs.readSync;
    let swapped = false, openedFd = null, bytesRead = 0;
    fs.openSync = function(candidate, ...args) {
      if (String(candidate) === file && !swapped) {
        swapped = true;
        if (kind === 'leaf') { fs.renameSync(file, `${file}.selected`); symlinkSync(outside, file); }
        else { fs.renameSync(source, `${source}.selected`); symlinkSync(foreign, source); }
        openedFd = originalOpen.call(this, candidate, ...args);
        return openedFd;
      }
      return originalOpen.call(this, candidate, ...args);
    };
    fs.readSync = function(fd, ...args) { const count = originalRead.call(this, fd, ...args); if (fd === openedFd) bytesRead += count; return count; };
    syncBuiltinESMExports();
    try { assert.throws(() => nativeContextPrompt(prepared), /changed|ELOOP|symbolic link/); }
    finally { fs.openSync = originalOpen; fs.readSync = originalRead; syncBuiltinESMExports(); }
    assert.equal(swapped, true);
    assert.equal(bytesRead, 0);
  });
}

function selectedCopyPlan(name, kind) {
  const directory = path.join(sandbox, name), skill = path.join(installed, name);
  put(path.join(skill, 'SKILL.md'), '# Selected copy fixture\n');
  const binary = put(path.join(skill, 'scripts', 'run.bin'), Buffer.from([0, 255, 1, 2, 10]));
  const shared = put(path.join(installed, '_shared', name, 'reference.md'), 'Exact selected dependency.\n');
  const file = kind === 'shared' ? shared : binary;
  const foreign = path.join(directory, 'foreign'), outside = put(path.join(foreign, path.basename(file)), 'Foreign unadmitted source bytes.\n');
  const prepared = prepare({ options: { contextPurpose: 'technical', contextDeclaration: {
    skills: [{ name, reason: 'Selected copy fixture', requires: [{ kind: 'resource', path: shared }] }],
    resources: [{ path: shared, reason: 'Exact selected dependency' }] } } });
  const cwd = path.join(directory, 'worktree'); mkdirSync(cwd, { recursive: true });
  const plan = cursorDriver.prepare({ ref: name, role: 'worker', cwd, root, selectedContext: prepared,
    settingsPath: path.join(directory, 'session', 'settings.json'), mcpConfigPath: path.join(directory, 'session', 'mcp.json'),
    mcp: { servers: {} }, prompt: nativeContextPrompt(prepared), model: cursorDriver.options.defaultModel, env: process.env });
  const destination = plan.files.find(entry => entry.copyFileFrom === file)?.path;
  assert.ok(destination);
  return { file, foreign, outside, destination, plan, config: path.join(cwd, '.cursor', 'mcp.json') };
}

for (const source of ['shared', 'skill']) {
  test(`selected native copy source refuses a changed ${source} leaf before launch-file writes`, () => {
    const fixture = selectedCopyPlan(`copy-afterplan-${source}`, source);
    fs.renameSync(fixture.file, `${fixture.file}.selected`); symlinkSync(fixture.outside, fixture.file);
    assert.throws(() => writeLaunchFiles(fixture.plan.files), /changed|ELOOP|symbolic link/);
    assert.equal(existsSync(fixture.destination), false);
    assert.equal(existsSync(fixture.config), false);
  });

  for (const kind of ['leaf', 'ancestor']) {
    test(`selected native copy source refuses ${source} ${kind} substitution at actual copy open before bytes`, () => {
      const fixture = selectedCopyPlan(`copy-open-${source}-${kind}`, source);
      const originalOpen = fs.openSync, originalRead = fs.readSync;
      let sourceOpens = 0, swapped = false, copiedFd = null, bytesRead = 0;
      fs.openSync = function(candidate, ...args) {
        if (String(candidate) === fixture.file && ++sourceOpens === 2) {
          swapped = true;
          if (kind === 'leaf') { fs.renameSync(fixture.file, `${fixture.file}.selected`); symlinkSync(fixture.outside, fixture.file); }
          else { const parent = path.dirname(fixture.file); fs.renameSync(parent, `${parent}.selected`); symlinkSync(fixture.foreign, parent); }
          copiedFd = originalOpen.call(this, candidate, ...args);
          return copiedFd;
        }
        return originalOpen.call(this, candidate, ...args);
      };
      fs.readSync = function(fd, ...args) { const count = originalRead.call(this, fd, ...args); if (fd === copiedFd) bytesRead += count; return count; };
      syncBuiltinESMExports();
      try { assert.throws(() => writeLaunchFiles(fixture.plan.files), /changed|ELOOP|symbolic link/); }
      finally { fs.openSync = originalOpen; fs.readSync = originalRead; syncBuiltinESMExports(); }
      assert.equal(swapped, true);
      assert.equal(bytesRead, 0);
      assert.equal(existsSync(fixture.destination), false);
    });
  }
}

test('selected native copy source preserves a binary skill larger than 256 KiB and its executable mode with partial writes', () => {
  const fixture = selectedCopyPlan('copy-binary-roundtrip', 'skill');
  const bytes = Buffer.alloc(512 * 1024 + 17); for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256;
  writeFileSync(fixture.file, bytes); chmodSync(fixture.file, 0o751);
  const originalWrite = fs.writeSync;
  let partialWrites = 0;
  fs.writeSync = function(fd, buffer, offset, length, position) {
    if (Buffer.isBuffer(buffer) && length > 4093) { partialWrites++; return originalWrite.call(this, fd, buffer, offset, 4093, position); }
    return originalWrite.call(this, fd, buffer, offset, length, position);
  };
  syncBuiltinESMExports();
  try { writeLaunchFiles(fixture.plan.files); }
  finally { fs.writeSync = originalWrite; syncBuiltinESMExports(); }
  assert.deepEqual(readFileSync(fixture.destination), bytes);
  assert.equal(fs.statSync(fixture.destination).mode & 0o777, 0o751);
  assert.ok(partialWrites > 0);
});

for (const driver of [claudeDriver, cursorDriver]) {
  test(`${driver.id} large selected bootstrap uses an owned file through a real fake-binary OS launch`, async () => {
    const directory = path.join(sandbox, `large-os-${driver.id}`);
    const resources = Array.from({ length: 4 }, (_, index) => {
      const file = put(path.join(directory, 'external-reference', `${index}.md`), `${index}`.repeat(256 * 1024));
      return { path: file, reason: 'Exact maximum-size reference' };
    });
    put(path.join(directory, 'external-reference', 'sibling.md'), 'Unselected sibling body.\n');
    const task = createTask(host.promptobusHome(), { id: `native-large-${driver.id}-t20261020-000001`, title: 'Large bootstrap transport' });
    const plan = await planSpawn(host, { repo, brief, task: task.id, worker: `large-${driver.id}`, harness: driver.id, dryRun: true,
      contextPurpose: 'technical', contextDeclaration: { skills: [], resources } });
    writeLaunchFiles(plan.launch.files);
    const fake = put(path.join(directory, 'fake-provider.cjs'), `const fs=require('node:fs'),crypto=require('node:crypto');
const args=process.argv.slice(2),file=args.at(-1).split('\\n').at(-1);const body=fs.readFileSync(file);
if(crypto.createHash('sha256').update(body).digest('hex')!==process.env.EXPECTED_BOOTSTRAP_HASH)throw Error('Owned bootstrap bytes differ');
process.stdout.write(JSON.stringify({file,bytes:body.length,largestArgumentBytes:Math.max(...args.map(value=>Buffer.byteLength(value)))}));`);
    const ran = spawnSync(process.execPath, [fake, ...plan.launch.argv], { cwd: repo, env: { ...process.env,
      EXPECTED_BOOTSTRAP_HASH: createHash('sha256').update(plan.prompt).digest('hex') }, encoding: 'utf8', maxBuffer: 65536 });
    assert.equal(ran.status, 0, `fake OS launch failed: ${ran.error?.code ?? ran.stderr}`);
    const observed = JSON.parse(ran.stdout);
    const owned = driver.id === 'claude' ? path.join(`${plan.settingsPath}-context`, 'bootstrap') : `${plan.settingsPath}-context`;
    assert.equal(observed.file, path.join(owned, 'assignment.md'));
    assert.ok(observed.bytes > 1024 * 1024);
    assert.ok(observed.largestArgumentBytes < 32 * 1024);
    assert.equal(plan.launch.prompt, plan.prompt);
    assert.ok(plan.launch.argv.includes(owned));
    assert.equal(plan.launch.argv.includes(path.dirname(resources[0].path)), false);
    assert.equal(plan.launch.argv.includes(path.dirname(plan.settingsPath)), false);
    const delivered = readFileSync(observed.file, 'utf8');
    assert.equal(delivered.includes('Unselected sibling body.'), false);
    assert.equal(delivered.includes(readFileSync(profile, 'utf8')), false);
  });

  test(`${driver.id} selected bootstrap directory preserves foreign and symlink authority and permits owned repeats`, () => {
    const context = name => {
      const cwd = path.join(sandbox, name, 'worktree'); mkdirSync(cwd, { recursive: true });
      return { ref: name, role: 'worker', cwd, root, selectedContext: selection,
        settingsPath: path.join(sandbox, name, 'settings.json'), mcpConfigPath: path.join(sandbox, name, 'mcp.json'),
        mcp: { servers: {} }, prompt: 'x'.repeat(32 * 1024 + 1), model: driver.options.defaultModel, env: process.env };
    };
    const ownedDir = options => driver.id === 'claude' ? path.join(`${options.settingsPath}-context`, 'bootstrap') : `${options.settingsPath}-context`;
    for (const kind of ['foreign-file', 'dangling-link']) {
      const options = context(`${driver.id}-${kind}`), destination = ownedDir(options);
      if (kind === 'foreign-file') put(path.join(destination, 'assignment.md'), 'Foreign bootstrap authority.\n');
      else { mkdirSync(path.dirname(destination), { recursive: true }); symlinkSync(path.join(sandbox, 'absent-bootstrap'), destination); }
      assert.throws(() => driver.prepare(options), /unowned|symbolic link/);
      if (kind === 'foreign-file') assert.equal(readFileSync(path.join(destination, 'assignment.md'), 'utf8'), 'Foreign bootstrap authority.\n');
      assert.equal(existsSync(driver.id === 'cursor' ? path.join(options.cwd, '.cursor', 'mcp.json') : options.mcpConfigPath), false);
    }
    const options = context(`${driver.id}-owned-bootstrap`);
    writeLaunchFiles(driver.prepare(options).files);
    assert.doesNotThrow(() => writeLaunchFiles(driver.prepare(options).files));
    const file = path.join(ownedDir(options), 'assignment.md'), target = put(path.join(sandbox, `${driver.id}-protected-bootstrap.md`), 'Protected target.\n');
    unlinkSync(file); symlinkSync(target, file);
    assert.throws(() => driver.prepare(options), /symbolic link/);
    assert.equal(readFileSync(target, 'utf8'), 'Protected target.\n');
  });

  test(`${driver.id} selected bootstrap collision after prepare refuses before provider files`, () => {
    const settingsPath = path.join(sandbox, `${driver.id}-late-bootstrap`, 'settings.json');
    const cwd = path.join(path.dirname(settingsPath), 'worktree'); mkdirSync(cwd, { recursive: true });
    const plan = driver.prepare({ ref: 'late-bootstrap', role: 'worker', cwd, root, selectedContext: selection,
      settingsPath, mcpConfigPath: path.join(path.dirname(settingsPath), 'mcp.json'), mcp: { servers: {} },
      prompt: 'x'.repeat(32 * 1024 + 1), model: driver.options.defaultModel, env: process.env });
    const directory = driver.id === 'claude' ? path.join(`${settingsPath}-context`, 'bootstrap') : `${settingsPath}-context`;
    const file = put(path.join(directory, 'assignment.md'), 'Foreign content after planning.\n');
    assert.throws(() => writeLaunchFiles(plan.files), /unowned/);
    assert.equal(readFileSync(file, 'utf8'), 'Foreign content after planning.\n');
    assert.equal(existsSync(driver.id === 'cursor' ? path.join(cwd, '.cursor', 'mcp.json') : path.join(path.dirname(settingsPath), 'mcp.json')), false);
  });

  test(`${driver.id} selected bootstrap keeps the 32 KiB boundary inline and moves the next byte into a file`, () => {
    const common = { ref: 'prompt-boundary', role: 'worker', cwd: repo, root, selectedContext: selection,
      settingsPath: path.join(sandbox, `${driver.id}-threshold`, 'settings.json'), mcpConfigPath: path.join(sandbox, `${driver.id}-threshold`, 'mcp.json'),
      mcp: { servers: {} }, model: driver.options.defaultModel, env: process.env };
    const inline = 'x'.repeat(32 * 1024), extended = `${inline}x`;
    assert.equal(driver.prepare({ ...common, prompt: inline }).argv.at(-1), inline);
    const plan = driver.prepare({ ...common, prompt: extended });
    assert.notEqual(plan.argv.at(-1), extended);
    assert.equal(plan.prompt, extended);
    assert.ok(plan.files.some(file => file.text === extended));
  });
}

for (const symbolic of [false, true]) {
  test(`selected Claude manifest ownership preserves foreign ${symbolic ? 'symlink target' : 'file'} before provider writes`, () => {
    const directory = path.join(sandbox, `manifest-${symbolic}`), settingsPath = path.join(directory, 'settings.json');
    const manifest = path.join(`${settingsPath}-context`, '.claude-plugin', 'plugin.json');
    const protectedFile = symbolic ? put(path.join(directory, 'protected.json'), 'Foreign manifest authority.\n') : put(manifest, 'Foreign manifest authority.\n');
    if (symbolic) { mkdirSync(path.dirname(manifest), { recursive: true }); symlinkSync(protectedFile, manifest); }
    let refusal;
    try {
      const plan = claudeDriver.prepare({ ref: 'manifest-guard', role: 'worker', cwd: repo, selectedContext: selection,
        settingsPath, mcpConfigPath: path.join(directory, 'mcp.json'), mcp: { servers: {} }, prompt: 'Assignment' });
      writeLaunchFiles(plan.files);
    } catch (error) { refusal = error; }
    assert.equal(readFileSync(protectedFile, 'utf8'), 'Foreign manifest authority.\n', 'foreign manifest bytes must remain unchanged');
    assert.match(refusal?.message ?? '', /unowned|symbolic link/);
    assert.equal(existsSync(path.join(directory, 'mcp.json')), false);
    assert.equal(existsSync(settingsPath), false);
    assert.equal(existsSync(path.join(`${settingsPath}-context`, 'skills')), false);
  });
}

test('selected Claude manifest ownership permits owned repeats and rejects a later manifest symlink', () => {
  const settingsPath = path.join(sandbox, 'owned-manifest', 'settings.json');
  const context = { ref: 'owned-manifest', role: 'worker', cwd: repo, selectedContext: selection, settingsPath,
    mcpConfigPath: path.join(path.dirname(settingsPath), 'mcp.json'), mcp: { servers: {} }, prompt: 'Assignment' };
  writeLaunchFiles(claudeDriver.prepare(context).files);
  assert.doesNotThrow(() => writeLaunchFiles(claudeDriver.prepare(context).files));
  const manifest = path.join(`${settingsPath}-context`, '.claude-plugin', 'plugin.json');
  const target = put(path.join(sandbox, 'owned-manifest', 'protected.json'), 'Do not overwrite this target.\n');
  unlinkSync(manifest); symlinkSync(target, manifest);
  assert.throws(() => { const plan = claudeDriver.prepare(context); writeLaunchFiles(plan.files); }, /symbolic link/);
  assert.equal(readFileSync(target, 'utf8'), 'Do not overwrite this target.\n');
});

test('selected Claude manifest ownership is rechecked before the first launch-file write', () => {
  const settingsPath = path.join(sandbox, 'manifest-after-plan', 'settings.json');
  const plan = claudeDriver.prepare({ ref: 'manifest-after-plan', role: 'worker', cwd: repo, selectedContext: selection,
    settingsPath, mcpConfigPath: path.join(path.dirname(settingsPath), 'mcp.json'), mcp: { servers: {} }, prompt: 'Assignment' });
  const manifest = put(path.join(`${settingsPath}-context`, '.claude-plugin', 'plugin.json'), 'Foreign file arrived after planning.\n');
  assert.throws(() => writeLaunchFiles(plan.files), /unowned/);
  assert.equal(readFileSync(manifest, 'utf8'), 'Foreign file arrived after planning.\n');
  assert.equal(existsSync(path.join(`${settingsPath}-context`, 'skills')), false);
  assert.equal(existsSync(path.join(path.dirname(settingsPath), 'mcp.json')), false);
});

for (const driver of [claudeDriver, cursorDriver, codexDriver, opencodeDriver]) {
  test(`${driver.id} resource-only native bootstrap transports exact external body without sibling or parent grant`, async () => {
    const file = put(path.join(sandbox, 'external-reference', `${driver.id}.md`), `Exact standalone resource body for ${driver.id}.\n`);
    const siblingBody = 'Unselected adjacent resource body.\n';
    put(path.join(path.dirname(file), 'unselected.md'), siblingBody);
    const plan = await planSpawn(host, { repo, brief, newTask: true, worker: `resource-${driver.id}`, harness: driver.id, dryRun: true,
      contextPurpose: 'technical', contextDeclaration: { skills: [], resources: [{ path: file, reason: 'Exact external task reference' }] } });
    const transport = [plan.launch.prompt ?? '', ...plan.launch.argv].join('\n');
    assert.ok(transport.includes(readFileSync(file, 'utf8')), 'the real driver prompt transport must contain the exact selected resource body');
    assert.ok(transport.includes(file));
    assert.equal(transport.includes(siblingBody), false);
    assert.equal(transport.includes(readFileSync(profile, 'utf8')), false);
    assert.equal((plan.launch.settings.addDirs ?? []).includes(path.dirname(file)), false);
    assert.equal(plan.ruleDirs.includes(path.dirname(file)), false);
    assert.equal(plan.selectedContext.resources.length, 1);
  });
}

test('native bootstrap declares canonical task identity and all three exact purposes', () => {
  for (const purpose of ['technical', 'user-facing', 'author-voice']) {
    const prepared = prepare({ options: { contextPurpose: purpose, contextDeclaration: { skills: [], resources: [] } } });
    const prompt = nativeContextPrompt(prepared);
    assert.ok(prompt.includes(`Task: ${prepared.task.id}\nPurpose: ${purpose}`));
  }
});

test('native exact resource bodies refuse NUL, invalid UTF-8, per-file overflow and aggregate overflow before planning', () => {
  const declarations = paths => ({ contextPurpose: 'technical', contextDeclaration: { skills: [], resources: paths.map(file => ({ path: file, reason: 'Bounded exact reference' })) } });
  const nul = put(path.join(sandbox, 'invalid-resources', 'nul.txt'), Buffer.from([65, 0, 66]));
  const utf8 = put(path.join(sandbox, 'invalid-resources', 'invalid-utf8.txt'), Buffer.from([0xc3, 0x28]));
  const large = put(path.join(sandbox, 'invalid-resources', 'large.txt'), 'x'.repeat(256 * 1024 + 1));
  for (const [file, reason] of [[nul, /NUL/], [utf8, /UTF-8/], [large, /256 KiB/]]) {
    assert.throws(() => prepare({ options: declarations([file]) }), reason);
  }
  const maximum = Array.from({ length: 4 }, (_, index) => put(path.join(sandbox, 'invalid-resources', `bounded-${index}.txt`), 'x'.repeat(256 * 1024)));
  assert.doesNotThrow(() => prepare({ options: declarations(maximum) }));
  const overflow = put(path.join(sandbox, 'invalid-resources', 'overflow.txt'), 'x');
  assert.throws(() => prepare({ options: declarations([...maximum, overflow]) }), /1 MiB/);
});

test('CLI reads one strict declaration file and validates purpose before provider work', () => {
  put(path.join(root, 'context.json'), JSON.stringify(declaration));
  assert.deepEqual(contextCliOptions({ 'context-purpose': 'technical', 'context-file': 'context.json' }, root), options);
  assert.throws(() => contextCliOptions({ 'context-purpose': 'implicit' }), /requires technical/);
  put(path.join(root, 'bad.json'), '{');
  assert.throws(() => contextCliOptions({ 'context-file': 'bad.json' }, root), /Invalid --context-file/);
  put(path.join(root, 'bad.json'), JSON.stringify({ ...declaration, surprise: true }));
  assert.throws(() => contextCliOptions({ 'context-file': 'bad.json' }, root), /Invalid task context declaration/);
});

test('native CLI propagates purpose and full declaration through the production dry-run path', async () => {
  const file = put(path.join(root, 'cli-context.json'), JSON.stringify(declaration));
  let exit;
  await capture(async () => { exit = await runPromptobus(['spawn', '--repo', repo, '--brief', brief, '--new-task', '--worker', 'cli-context',
    '--context-purpose', 'technical', '--context-file', file, '--dry-run'], { host, cwd: root, env: process.env }); });
  assert.equal(exit, 0);
  assert.ok(calls.some(call => call.role === 'worker' && call.task.purpose === 'technical' && call.task.context?.skills.length === 2));
});

test('native selection requires explicit purpose, refuses unsupported Host and preserves legacy absence', () => {
  assert.throws(() => prepare({ options: {} }), /explicit --context-purpose/);
  const legacy = Object.create(host); legacy.selectParticipantContext = undefined;
  assert.equal(prepareNativeContext(legacy, { root: repo, role: 'worker', taskId: 'legacy', options: {} }), null);
  assert.throws(() => prepareNativeContext(legacy, { root: repo, role: 'worker', taskId: 'legacy', options }), /Host selector support/);
  assert.throws(() => assertNativeContextDriver(selection, { id: 'unsupported', options: {} }), /does not support selected/);
});

test('immutable metadata retains purpose/declaration and prevents changed re-review or legacy conversion', () => {
  const participant = { metadata: nativeContextMetadata(selection) };
  assert.deepEqual(prepare({ participant, options: {} }), selection);
  assert.throws(() => prepare({ participant, options: { ...options, contextPurpose: 'author-voice' } }), /prepare a new participant and session/);
  assert.throws(() => prepare({ participant, options: { ...options, contextDeclaration: { skills: [], resources: [] } } }), /prepare a new participant and session/);
  assert.throws(() => prepare({ participant: { metadata: {} } }), /legacy participant needs a new preparation/);
});

for (const driver of [claudeDriver, cursorDriver, codexDriver, opencodeDriver]) {
  test(`${driver.id} real prepare materializes only admitted native files before fake provider launch`, () => {
    const cwd = path.join(sandbox, driver.id, 'worktree'); mkdirSync(cwd, { recursive: true });
    const settingsPath = path.join(sandbox, driver.id, 'session', 'settings.json');
    const plan = driver.prepare({ ref: `selected-${driver.id}`, task: selection.task.id, address: 'worker:selected', role: 'worker',
      cwd, root, skillsRoot: root, selectedContext: selection, settingsPath,
      mcpConfigPath: path.join(path.dirname(settingsPath), 'mcp.json'), mcp: { home: path.join(root, '.promptobus'), task: selection.task.id, address: 'worker:selected', servers: {} },
      prompt: 'Selected task', model: driver.options.defaultModel, permissionMode: driver.options.defaultPermissionMode, env: process.env });
    assert.equal(plan.files.some(file => file.copyFrom), false, 'no whole-container copy survives');
    const files = plan.files.filter(file => file.copyFileFrom);
    assert.ok(files.length >= 4);
    const target = files.find(file => file.copyFileFrom === alpha).path;
    const destination = path.dirname(path.dirname(target));
    let providerCalls = 0;
    writeLaunchFiles(plan.files);
    const fakeProvider = () => {
      providerCalls++;
      assert.equal(readFileSync(path.join(destination, 'alpha', '..', '_shared', 'standard.md'), 'utf8'), 'Required exact standard.\n');
      assert.equal(existsSync(path.join(destination, 'my-voice')), false);
      assert.equal(existsSync(path.join(destination, '_shared', 'sibling.md')), false);
      assert.ok((readFileSync(path.join(destination, 'alpha', 'SKILL.md'), 'utf8')).includes('../_shared/standard.md'));
    };
    fakeProvider();
    assert.equal(providerCalls, 1);
    assert.deepEqual(readdirSync(destination).sort(), ['.promptobus-context.json', '_shared', 'alpha', 'beta']);
    assert.equal(plan.privateHomeSkills ?? null, null);
    if (driver.id === 'claude') {
      const plugin = plan.argv[plan.argv.indexOf('--plugin-dir') + 1];
      assert.equal(path.join(plugin, 'skills'), destination);
      assert.equal(existsSync(path.join(plugin, '.claude-plugin', 'plugin.json')), true);
    }
    assert.doesNotThrow(() => driver.prepare({ ref: `repeat-${driver.id}`, role: 'worker', cwd, root, selectedContext: selection, task: selection.task.id,
      address: 'worker:selected', settingsPath, mcpConfigPath: path.join(path.dirname(settingsPath), 'mcp.json'),
      mcp: { home: path.join(root, '.promptobus'), task: selection.task.id, address: 'worker:selected', servers: {} }, env: process.env }));
  });
}

test('Codex private root home receives selected content and reviewer exact roots exclude personal/index/siblings', () => {
  const cwd = path.join(sandbox, 'codex-root'); mkdirSync(cwd, { recursive: true });
  const common = { ref: 'private-selected', role: 'orchestrator', task: selection.task.id, address: 'orchestrator', cwd, root,
    selectedContext: selection, permissionMode: 'full-access', mcp: { servers: {} }, env: process.env };
  const privatePlan = codexDriver.prepare(common);
  assert.equal(privatePlan.privateHomeSkills, null);
  installPrivateHomeLayer(privatePlan, privatePlan.codexHome);
  assert.equal(existsSync(path.join(privatePlan.codexHome, 'skills', 'my-voice')), false);
  assert.equal(existsSync(path.join(privatePlan.codexHome, 'skills', 'alpha', 'SKILL.md')), true);
  const personal = put(path.join(process.env.HOME, '.agents', 'skills', 'personal', 'SKILL.md'), 'Personal unrelated skill.\n');
  put(path.join(root, '.agents', 'skills-index.md'), 'Unselected full index.\n');
  const reviewPlan = codexDriver.prepare({ ...common, role: 'reviewer', address: 'reviewer:selected',
    settingsPath: path.join(sandbox, 'codex-review', 'settings.json'), readFiles: selection.rules.map(rule => rule.path), readSkillDirs: selection.skills.map(skill => skill.root) });
  const env = reviewPlan.mcpConfig.mcpServers.reviewer_files.env;
  const roots = JSON.parse(env.PROMPTOBUS_REVIEW_READ_ROOTS), exact = JSON.parse(env.PROMPTOBUS_REVIEW_CANONICAL_FILES);
  assert.ok(roots.includes(resource));
  assert.equal(roots.includes(path.dirname(personal)), false);
  assert.equal(roots.includes(path.join(root, '.agents', 'skills-index.md')), false);
  assert.equal(roots.includes(installed), false);
  writeLaunchFiles(reviewPlan.files);
  const read = reviewerFiles(roots, exact);
  assert.doesNotThrow(() => read('read_file', { path: resource }));
  assert.throws(() => read('read_file', { path: path.join(installed, '_shared', 'sibling.md') }));
});

function withAliasedTemp(name, run) {
  const canonical = path.join(sandbox, name), alias = `${canonical}-alias`;
  mkdirSync(canonical);
  symlinkSync(canonical, alias, 'dir');
  const variables = ['TMPDIR', 'TEMP', 'TMP'];
  const saved = variables.map(key => process.env[key]);
  try {
    for (const key of variables) process.env[key] = alias;
    return run({ canonical, alias });
  } finally {
    variables.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
  }
}

test('managed selected contexts canonicalize explicit external store and clone roots before owned descendants', async () => {
  const storeBase = path.join(sandbox, 'trusted-store-base'), storeAlias = `${storeBase}-alias`;
  mkdirSync(storeBase); symlinkSync(storeBase, storeAlias, 'dir');
  const rootAlias = `${root}-trusted-alias`; symlinkSync(root, rootAlias, 'dir');
  const home = path.join(storeBase, 'store'), aliasedHome = path.join(storeAlias, 'store');
  const task = createTask(home, { id: 'trusted-roots-t20261020-000001', title: 'Trusted roots' });
  upsertParticipant(home, task.id, participantRecord('orchestrator', { owner: sessionIdentity() }));
  const canonicalHost = Object.create(host), aliasedHost = Object.create(host);
  canonicalHost.promptobusHome = () => home;
  aliasedHost.promptobusHome = () => aliasedHome;
  aliasedHost.workspaceRoot = () => rootAlias;
  aliasedHost.repoAbsPath = () => path.join(rootAlias, 'demo');
  const selectedFiles = plan => plan.launch.files.filter(file => file.selectedContext || file.copyFileFrom);
  for (const driver of [claudeDriver, cursorDriver, codexDriver, opencodeDriver]) {
    const input = { repo, brief, task: task.id, worker: `trusted-${driver.id}`, harness: driver.id, dryRun: true, ...options };
    const canonicalPlan = await planSpawn(canonicalHost, input);
    const aliasedPlan = await planSpawn(aliasedHost, input);
    assert.equal(aliasedPlan.home, home);
    assert.equal(aliasedPlan.repoAbs, repo);
    assert.equal(aliasedPlan.settingsPath, canonicalPlan.settingsPath);
    assert.equal(aliasedPlan.mcpConfigPath, canonicalPlan.mcpConfigPath);
    assert.deepEqual(selectedFiles(aliasedPlan), selectedFiles(canonicalPlan));
    assert.equal(existsSync(aliasedPlan.settingsPath), false);
    assert.equal(existsSync(aliasedPlan.worktreePath), false);
  }
  const reviewer = planReview(aliasedHost, { target: repo, task: task.id, dryRun: true, ...options });
  const reporter = await planReport(aliasedHost, { task: task.id, dryRun: true, ...options });
  const teamlead = await planTeamlead(aliasedHost, { task: task.id, brief, slug: 'trusted-child', dryRun: true, ...options });
  const lead = await planLead(aliasedHost, { brief, task: 'trusted-lead-t20261020-000001', permissionMode: 'full-access', dryRun: true, ...options });
  for (const plan of [reviewer, reporter, teamlead, lead]) {
    assert.equal(plan.home, home);
    assert.equal(plan.launch.files.some(file => file.path.startsWith(storeAlias + path.sep)), false);
  }
  for (const plan of [reporter, teamlead, lead]) assert.equal(plan.root, root);
});

test('trusted store normalization keeps missing homes and descendants absent during planning', async () => {
  const storeBase = path.join(sandbox, 'missing-store-base'), storeAlias = `${storeBase}-alias`;
  mkdirSync(storeBase); symlinkSync(storeBase, storeAlias, 'dir');
  const home = path.join(storeBase, 'missing', 'store');
  const aliasedHost = Object.create(host);
  aliasedHost.promptobusHome = () => path.join(storeAlias, 'missing', 'store');
  const plan = await planSpawn(aliasedHost, { repo, brief, newTask: true, worker: 'missing-store', dryRun: true, ...options });
  assert.equal(plan.home, home);
  assert.equal(existsSync(path.dirname(home)), false);
  assert.equal(existsSync(plan.settingsPath), false);
  assert.equal(existsSync(plan.worktreePath), false);
});

test('managed trusted-root plans retain symlink refusal below the selected base before preparation or writes', async () => {
  for (const driver of [claudeDriver, cursorDriver, codexDriver, opencodeDriver]) {
    for (const kind of ['ancestor', 'parent', 'leaf', 'dangling']) {
      const name = `${driver.id}-${kind}`;
      const storeBase = path.join(sandbox, `guarded-store-${name}`), storeAlias = `${storeBase}-alias`;
      mkdirSync(storeBase); symlinkSync(storeBase, storeAlias, 'dir');
      const home = path.join(storeBase, 'store'), scoped = Object.create(host);
      scoped.promptobusHome = () => path.join(storeAlias, 'store');
      const task = createTask(home, { id: `owned-${name}-t20261020-000001`, title: 'Owned descendants' });
      const plan = await planSpawn(scoped, { repo, brief, task: task.id, worker: `links-${name}`, harness: driver.id,
        ...(driver.id === 'codex' ? { permissionMode: 'read-only' } : {}), dryRun: true, ...options });
      const container = plan.launch.files.find(file => file.clearDirectory).path;
      const target = kind === 'ancestor' ? path.dirname(path.dirname(container)) : kind === 'parent' ? path.dirname(container) : container;
      const foreign = path.join(sandbox, `foreign-${name}`), marker = put(path.join(foreign, 'marker.txt'), 'Foreign bytes stay untouched.\n');
      mkdirSync(path.dirname(target), { recursive: true });
      symlinkSync(kind === 'dangling' ? path.join(foreign, 'absent') : foreign, target, 'dir');
      const input = { ref: plan.name, role: 'worker', task: task.id, address: plan.address, home: plan.home,
        cwd: plan.worktreePath, root, selectedContext: plan.selectedContext, model: plan.model, permissionMode: plan.permissionMode,
        mcpConfigPath: plan.mcpConfigPath, settingsPath: plan.settingsPath,
        mcp: { home: plan.home, task: task.id, address: plan.address, servers: {} }, prompt: 'Guarded selected context' };
      assert.throws(() => driver.prepare(input), /symbolic link/, `${name}: preparation must reject the substituted descendant`);
      assert.throws(() => writeLaunchFiles(plan.launch.files), /symbolic link/, `${name}: writing must recheck the substituted descendant`);
      assert.deepEqual(readdirSync(foreign), ['marker.txt']);
      assert.equal(readFileSync(marker, 'utf8'), 'Foreign bytes stay untouched.\n');
      assert.equal(existsSync(plan.settingsPath), false);
      assert.equal(existsSync(plan.mcpConfigPath), false);
      fs.rmSync(plan.worktreePath, { recursive: true, force: true });
    }
  }
});

test('a selected container that gains foreign content after trusted-root planning refuses before provider files', async () => {
  const storeBase = path.join(sandbox, 'late-store'), storeAlias = `${storeBase}-alias`;
  mkdirSync(storeBase); symlinkSync(storeBase, storeAlias, 'dir');
  const scoped = Object.create(host); scoped.promptobusHome = () => path.join(storeAlias, 'store');
  const plan = await planSpawn(scoped, { repo, brief, newTask: true, worker: 'late-context', dryRun: true, ...options });
  const container = plan.launch.files.find(file => file.clearDirectory).path;
  const foreign = put(path.join(container, 'foreign.txt'), 'Foreign content arrived after planning.\n');
  assert.throws(() => writeLaunchFiles(plan.launch.files), /pre-existing unowned/);
  assert.equal(readFileSync(foreign, 'utf8'), 'Foreign content arrived after planning.\n');
  assert.equal(existsSync(plan.settingsPath), false);
  assert.equal(existsSync(plan.mcpConfigPath), false);
});

test('changing the trusted alias after planning cannot redirect provider or selected-context writes', async () => {
  const storeBase = path.join(sandbox, 'retained-store'), storeAlias = `${storeBase}-alias`;
  mkdirSync(storeBase); symlinkSync(storeBase, storeAlias, 'dir');
  const scoped = Object.create(host); scoped.promptobusHome = () => path.join(storeAlias, 'store');
  const plan = await planSpawn(scoped, { repo, brief, newTask: true, worker: 'retained-context', dryRun: true, ...options });
  const foreign = path.join(sandbox, 'retained-foreign'), marker = put(path.join(foreign, 'marker.txt'), 'Foreign root stays untouched.\n');
  unlinkSync(storeAlias); symlinkSync(foreign, storeAlias, 'dir');
  writeLaunchFiles(plan.launch.files);
  assert.equal(existsSync(plan.settingsPath), true);
  assert.equal(existsSync(plan.mcpConfigPath), true);
  assert.ok(plan.settingsPath.startsWith(storeBase + path.sep));
  assert.deepEqual(readdirSync(foreign), ['marker.txt']);
  assert.equal(readFileSync(marker, 'utf8'), 'Foreign root stays untouched.\n');
});

test('direct preparation without a trusted root keeps aliased context destinations strict', () => {
  const canonical = path.join(sandbox, 'untrusted-direct'), alias = `${canonical}-alias`;
  mkdirSync(canonical); symlinkSync(canonical, alias, 'dir');
  assert.throws(() => claudeDriver.prepare({ ref: 'untrusted-direct', role: 'worker', cwd: repo, selectedContext: selection,
    settingsPath: path.join(alias, 'settings.json'), mcpConfigPath: path.join(alias, 'mcp.json'), mcp: { servers: {} }, prompt: 'Assignment' }), /symbolic link/);
  assert.equal(existsSync(path.join(canonical, 'settings.json-context')), false);
});

const privateSelectedPlan = role => codexDriver.prepare({
  ref: `temp-alias-${role}`, role, task: selection.task.id, address: role, cwd: root, root,
  selectedContext: selection, permissionMode: role === 'reporter' ? 'read-only' : 'full-access',
  mcp: { servers: {} }, env: process.env,
});

test('Codex private selected skills use a canonical temp base without changing home identity', () => {
  withAliasedTemp('private-selected-temp', ({ canonical, alias }) => {
    for (const role of ['reporter', 'orchestrator']) {
      const plan = privateSelectedPlan(role);
      const homeLeaf = path.basename(plan.codexHome);
      assert.equal(plan.codexHome, path.join(alias, 'promptobus-codex-homes', homeLeaf));
      assert.equal(plan.canonicalSkillsDir, path.join(canonical, 'promptobus-codex-homes', homeLeaf, 'skills'));
      assert.equal(plan.files.length, 0);
      installPrivateHomeLayer(plan, plan.codexHome);
      assert.equal(readFileSync(path.join(plan.codexHome, 'skills', 'alpha', 'SKILL.md'), 'utf8'), readFileSync(alpha, 'utf8'));
      assert.equal(existsSync(path.join(plan.codexHome, 'skills', 'my-voice')), false);
    }
  });
});

test('Codex private selected skills refuse symlinks below the system temp base', () => {
  withAliasedTemp('private-selected-links', ({ canonical }) => {
    const foreign = path.join(canonical, 'foreign');
    const marker = put(path.join(foreign, 'marker.txt'), 'Foreign bytes stay untouched.\n');
    for (const role of ['reporter', 'orchestrator']) {
      const plan = privateSelectedPlan(role);
      mkdirSync(plan.codexHome, { recursive: true });
      for (const target of [path.dirname(plan.codexHome), plan.codexHome]) {
        const retained = `${target}-retained`;
        renameSync(target, retained);
        symlinkSync(foreign, target, 'dir');
        try {
          assert.throws(() => privateSelectedPlan(role), /destination traverses a symbolic link/);
          assert.deepEqual(readdirSync(foreign), ['marker.txt']);
          assert.equal(readFileSync(marker, 'utf8'), 'Foreign bytes stay untouched.\n');
        } finally { unlinkSync(target); renameSync(retained, target); }
      }
    }
  });
});

test('exact standalone resources stay at their original path without granting their parent', () => {
  const file = put(path.join(repo, 'reference.md'), 'Exact repo reference.\n');
  const prepared = prepare({ options: { contextPurpose: 'technical', contextDeclaration: { skills: [], resources: [{ path: file, reason: 'Task reference' }] } } });
  const plan = selectedNativeFiles(prepared, path.join(sandbox, 'resource-only'));
  assert.equal(plan.some(entry => entry.copyFileFrom), false);
  assert.deepEqual(prepared.resources.map(entry => entry.path), [file]);
});

test('collisions, unsupported topology and escaping child symlinks refuse before context writes', () => {
  const destination = path.join(sandbox, 'refused-context');
  const foreign = put(path.join(destination, 'unselected', 'SKILL.md'), 'Do not delete.\n');
  assert.throws(() => selectedNativeFiles(selection, destination), /pre-existing unowned skills container/);
  assert.equal(readFileSync(foreign, 'utf8'), 'Do not delete.\n');
  const sourceB = put(path.join(sandbox, 'other', 'standard.md'), 'Different shared source.\n');
  assert.throws(() => selectedNativeFiles({ ...selection, resources: [...selection.resources, { path: sourceB,
    sourcePath: path.join(installed, '_shared', 'standard.md'), reason: 'Collision', requires: [] }] }, path.join(sandbox, 'collision')), /destination collision/);
  const outside = put(path.join(sandbox, 'outside.md'), 'Outside.\n');
  assert.throws(() => prepare({ options: { contextPurpose: 'technical', contextDeclaration: {
    skills: [{ name: 'alpha', reason: 'Requires unsupported relocation', requires: [{ kind: 'resource', path: outside }] }], resources: [{ path: outside, reason: 'Outside dependency' }] } } }), /unsupported relative topology/);
  const escaped = path.join(installed, 'escaped'); mkdirSync(escaped, { recursive: true });
  put(path.join(escaped, 'SKILL.md'), '# Escape test\n'); symlinkSync(outside, path.join(escaped, 'reference.md'));
  assert.throws(() => prepare({ options: { contextPurpose: 'technical', contextDeclaration: { skills: [{ name: 'escaped', reason: 'Escape fixture' }], resources: [] } } }), /symbolic link/);
  assert.equal(existsSync(path.join(sandbox, 'collision')), false);
});

test('worker/reviewer/root plans pass real task identity and required review skill while excluding profile', async () => {
  const worker = await planSpawn(host, { repo, brief, worker: 'selected', dryRun: true, ...options });
  assert.equal(worker.selectedContext.task.id, worker.taskId);
  assert.ok(worker.rules.includes(path.join(worker.worktreePath, 'AGENTS.md')));
  assert.equal(worker.prompt.includes(profile), false);
  const reviewer = planReview(host, { target: repo, title: 'Selected review', dryRun: true, ...options });
  assert.equal(reviewer.selectedContext.task.id, reviewer.taskId);
  assert.ok(reviewer.selectedContext.skills.some(skill => skill.name === 'review'));
  assert.equal(reviewer.skill.shared, null);
  assert.equal(reviewer.launch.files.some(file => file.copyFrom), false);
  const lead = await planLead(host, { brief, task: 'native-lead-t20261020-000001', permissionMode: 'full-access', dryRun: true, ...options });
  assert.equal(lead.selectedContext.task.id, lead.task);
  assert.equal(lead.launch.privateHomeSkills, null);
  const owner = createTask(host.promptobusHome(), { id: 'native-root-t20261020-000001', title: 'Native role context' });
  upsertParticipant(host.promptobusHome(), owner.id, participantRecord('orchestrator', { owner: sessionIdentity() }));
  const reporter = await planReport(host, { task: owner.id, dryRun: true, ...options });
  assert.equal(reporter.selectedContext.task.id, owner.id);
  const teamlead = await planTeamlead(host, { task: owner.id, brief, slug: 'context-child', dryRun: true, ...options });
  assert.equal(teamlead.selectedContext.task.id, teamlead.childTask);
  assert.notEqual(teamlead.childTask, owner.id);
  assert.ok(calls.some(call => call.task.id === teamlead.childTask));
  const approverHost = Object.create(host);
  approverHost.pipeline = () => [{ name: 'worker', kind: 'edits-tree' }, { name: 'approver', kind: 'writes-main-tree' }];
  const acceptance = createTask(host.promptobusHome(), { id: 'native-acceptance-t20261020-000001', title: 'Selected acceptance' });
  openParticipant(host.promptobusHome(), acceptance.id, participantRecord('worker:acceptance', { harness: 'claude', name: 'Acceptance owner',
    repoAbs: repo, worktree: repo, branch: 'main' }), REGISTRY, { assignment: true });
  sendMessage(host.promptobusHome(), acceptance.id, { from: 'worker:acceptance', to: 'orchestrator', type: 'result', body: 'Owner result' });
  const approver = planApprover(approverHost, { target: repo, task: acceptance.id, dryRun: true, ...options });
  assert.equal(approver.selectedContext.task.id, acceptance.id);
  assert.equal(approver.selectedContext.skills.some(skill => skill.name === 'review'), false, 'reviewer-only extras do not leak to approver');
});

test('live native re-review keeps declaration and refuses changed context before sending another assignment', async () => {
  const task = createTask(host.promptobusHome(), { id: 'native-rereview-t20261020-000001', title: 'Same context review' });
  const first = planReview(host, { target: repo, task: task.id, dryRun: true, ...options });
  upsertParticipant(host.promptobusHome(), task.id, participantRecord(first.address, { harness: 'claude', name: first.name,
    repoAbs: repo, ...nativeContextMetadata(first.selectedContext) }));
  const bin = path.join(sandbox, 'fake-bin');
  stubCommand(bin, 'claude', `process.stdout.write(JSON.stringify([{ name: ${JSON.stringify(first.name)}, status: 'running' }]));`);
  const savedPath = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${savedPath}`; resetCliCaches();
  try {
    const repeated = planReview(host, { target: repo, task: first.taskId, dryRun: true });
    assert.equal(repeated.reuse, true);
    assert.deepEqual(repeated.selectedContext.task, first.selectedContext.task);
    await capture(() => review(host, { target: repo, task: first.taskId, dryRun: true }));
    await assert.rejects(() => review(host, { target: repo, task: first.taskId, contextPurpose: 'author-voice', dryRun: true }), /prepare a new participant and session/);
    assert.deepEqual(readTask(host.promptobusHome(), task.id).participants.find(participant => participant.metadata.name === first.name).metadata.participantContext.task, first.selectedContext.task);
  } finally { process.env.PATH = savedPath; resetCliCaches(); }
});

test('profile-only edits leave technical owned bytes unchanged and required rule edits change bootstrap source', async () => {
  const before = selectedNativeFiles(selection, path.join(sandbox, 'byte-proof')).filter(file => file.copyFileFrom).map(file => readFileSync(file.copyFileFrom, 'utf8')).join('\n');
  put(profile, 'Excluded personal profile B, different length.\n');
  const after = selectedNativeFiles(prepare(), path.join(sandbox, 'byte-proof')).filter(file => file.copyFileFrom).map(file => readFileSync(file.copyFileFrom, 'utf8')).join('\n');
  assert.equal(after, before);
  const original = readFileSync(workspaceRule, 'utf8');
  put(workspaceRule, 'Changed mandatory rule.\n');
  assert.notEqual(readFileSync(prepare().rules[0].path, 'utf8'), original);
});
