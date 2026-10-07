import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { capture, expectFail } from './console.mjs';
import { hostOf } from '../lib/host.js';
import { planLead, lead } from '../lib/lead.js';
import { bus, claimWarden, clearWarden, participantRecord, taskExists, taskFile, upsertParticipant } from '../lib/store.js';
import { wardenLine } from '../lib/status.js';
import { runPromptobus, helpText } from '../lib/cli.js';
import { dropSession, readSession, writeSession, threadStartConfig, recoveryPrompt } from '../lib/codex-session.js';
import { codexDriver, participantCodexHome } from '../lib/driver-codex.js';
import { reviewerFiles } from '../lib/reviewer-files.js';

const root = makeSandbox('promptobus-lead-');
writeHostConfig(root, { tools: ['codex'] });
const host = hostOf(root);
const brief = path.join(root, 'assignment.md');
writeFileSync(brief, '# Codex owns this task\nCoordinate the workers and accept their results.\n');
const opts = { brief, task: 'lead-t20261001-000001', model: 'gpt-6-astra', permissionMode: 'full-access', dryRun: true };
for (const permissionMode of [undefined, 'workspace-write', 'read-only', 'bypassPermissions']) {
  let refusal = '';
  const noRouting = Object.create(host);
  noRouting.collectRules = () => { throw new Error('unsupported permission reached rules collection'); };
  try { await planLead(noRouting, { ...opts, permissionMode, brief: path.join(root, 'missing-brief.md') }); }
  catch (error) { refusal = error.message; }
  check(`root lead refuses ${permissionMode ?? 'implicit permissions'} before reading the brief or creating a task`,
    /requires explicit --permission-mode full-access/.test(refusal)
    && !taskExists(host.promptobusHome(), opts.task), refusal);
}
const plan = await planLead(host, opts);
check('Codex root lead plans the orchestrator mailbox without a child task',
  plan.address === 'orchestrator' && plan.task === opts.task && !plan.rootTask
  && plan.launch.mcpConfig.mcpServers.promptobus.env.PROMPTOBUS_ROLE === 'orchestrator'
  && plan.launch.mcpConfig.mcpServers.promptobus.env.PROMPTOBUS_TASK === opts.task);
check('root lead has a private Codex home and writes no shared project layer',
  plan.launch.files.length === 0 && plan.launch.trustProject === false
  && plan.launch.codexHome && plan.launch.rootSessionRecord === null);
check('root lead keeps the requested model and explicit full-access sandbox',
  plan.model === 'gpt-6-astra' && plan.launch.settings.sandbox === 'danger-full-access');
const fallback = await planLead(host, { ...opts, model: undefined });
check('an unrouted root lead defaults to the model proven by native subscription turns',
  fallback.model === 'gpt-6-astra');
const full = await planLead(host, { ...opts, permissionMode: 'full-access' });
check('root lead full access is explicit and hooks stay off in its thread',
  full.launch.settings.sandbox === 'danger-full-access'
  && threadStartConfig({ role: 'orchestrator' })['features.hooks'] === false);
check('root lead assignment gives the actual harness and mailbox protocol',
  /Codex root orchestrator/.test(plan.prompt) && /promptobus_mailbox/.test(plan.prompt)
  && /Coordinate the workers/.test(plan.prompt) && !/separate Claude Code/.test(plan.prompt));
const output = await capture(() => lead(host, opts));
check('root lead dry run creates no task or launch file',
  /dry-run: nothing written/.test(output) && !taskExists(host.promptobusHome(), opts.task)
  && !existsSync(plan.launch.codexHome));
let refused = '';
try { await planLead(host, { ...opts, harness: 'claude' }); } catch (error) { refused = error.message; }
check('managed root lead refuses unsupported harnesses before creating a task',
  /only Codex/.test(refused) && !taskExists(host.promptobusHome(), opts.task));

let invalid = '';
try { await planLead(host, { ...opts, task: '../outside', brief: path.join(root, 'absent.md') }); }
catch (error) { invalid = error.message; }
check('invalid root task ids refuse before reading the brief or preparing a session',
  invalid === 'invalid task id: «../outside»');

let cliCode = null;
const cliOutput = await capture(async () => {
  cliCode = await runPromptobus(['lead', '--permission-mode', 'full-access', '--brief', brief, '--task', opts.task,
    '--model', 'gpt-6-astra', '--dry-run'], { host, cwd: root, env: {} });
});
check('lead CLI dispatch reaches the dry plan without creating a task',
  cliCode === 0 && /root task: lead-t20261001-000001/.test(cliOutput)
  && /dry-run: nothing written/.test(cliOutput) && !taskExists(host.promptobusHome(), opts.task));
check('CLI help exposes the managed root and both reporter harnesses',
  /lead --brief/.test(helpText(host))
  && !/workspace-write\|full-access/.test(helpText(host))
  && /report --task[^\n]*\[--harness claude\|codex\]/.test(helpText(host))
  && /read-only Claude Code or Codex reporter/.test(helpText(host)));

const existing = bus(host.promptobusHome(), { cli: host.version }).createTask({
  id: opts.task, title: 'Already owned root',
  owner: participantRecord('orchestrator', {
    harness: 'codex', mode: 'managed', owner: 'fixture-owner', sessionId: 'fixture-owner',
    sessionRef: 'existing-owner',
  }),
});
const before = readFileSync(taskFile(host.promptobusHome(), opts.task), 'utf8');
const refusingHost = Object.create(host);
refusingHost.collectRules = () => { throw new Error('existing task reached session preparation'); };
let takeover = '';
try { await planLead(refusingHost, opts); } catch (error) { takeover = error.message; }
check('lead cannot take over an existing task and leaves its owner byte-identical',
  /already exists.*cannot replace/.test(takeover)
  && before === readFileSync(taskFile(host.promptobusHome(), opts.task), 'utf8'));
claimWarden(host.promptobusHome(), existing.id, { cli: host.version });
const actualWarden = wardenLine(host.promptobusHome(), existing.id, host);
check('warden status names the actual Codex owner delivery driver',
  actualWarden.alive && /injection proven on codex /.test(actualWarden.line)
  && !/injection proven on claude /.test(actualWarden.line));
clearWarden(host.promptobusHome(), existing.id);

const privateHome = participantCodexHome({ task: opts.task, address: 'orchestrator' });
mkdirSync(privateHome, { recursive: true });
const retained = { ref: 'existing-owner', threadId: 'fixture-owner', role: 'orchestrator',
  task: opts.task, address: 'orchestrator', home: host.promptobusHome(), cwd: root,
  codexHome: privateHome, sandbox: 'danger-full-access', model: 'gpt-6-astra',
  holderPid: null, appPid: null, state: 'dead', turns: 3 };
writeSession(retained);
const resumeOpts = { task: opts.task, resume: true, dryRun: true };
const resumed = await planLead(host, resumeOpts);
check('resume uses the same managed owner thread and its retained private home',
  resumed.launch.resumeThreadId === retained.threadId && resumed.name === retained.ref
  && resumed.launch.codexHome === privateHome && resumed.title === existing.title
  && resumed.launch.settings.sandbox === 'danger-full-access');
const resumeBefore = readFileSync(taskFile(host.promptobusHome(), opts.task), 'utf8');
let resumeCliCode = null;
await capture(async () => {
  resumeCliCode = await runPromptobus(['lead', '--resume', '--task', opts.task, '--dry-run'],
    { host, cwd: root, env: {} });
});
check('resume CLI dry run preserves the owner and retained history record',
  resumeCliCode === 0 && resumeBefore === readFileSync(taskFile(host.promptobusHome(), opts.task), 'utf8')
  && readSession(retained.ref).threadId === retained.threadId);
const resumeRefusal = async () => {
  try { await planLead(host, resumeOpts); return ''; } catch (error) { return error.message; }
};
writeSession({ ...retained, holderPid: process.pid });
check('resume refuses an active holder instead of starting another owner',
  /live Codex holder/.test(await resumeRefusal()));
writeSession({ ...retained, threadId: 'another-thread' });
check('resume refuses a thread that does not match the task owner',
  /no matching.*managed Codex root owner/.test(await resumeRefusal()));
writeSession(retained);
const engine = bus(host.promptobusHome(), { cli: host.version });
const originalOwner = engine.readTask(opts.task).participants[0];
writeSession({ ...retained, threadId: null });
upsertParticipant(host.promptobusHome(), opts.task, { ...originalOwner, metadata: { ...originalOwner.metadata, owner: null } });
check('resume refuses an ownerless managed record instead of opening a fresh thread',
  /no matching.*managed Codex root owner/.test(await resumeRefusal()));
writeSession(retained);
upsertParticipant(host.promptobusHome(), opts.task, { ...originalOwner, mode: 'attached' });
check('resume refuses an attached Desktop owner', /no matching/.test(await resumeRefusal()));
upsertParticipant(host.promptobusHome(), opts.task, { ...originalOwner, metadata: {
  ...originalOwner.metadata, launcherPid: process.pid,
} });
check('resume refuses a concurrent launcher while the holder is not ready',
  /live Codex holder/.test(await resumeRefusal()));
upsertParticipant(host.promptobusHome(), opts.task, originalOwner);
engine.closeTask(opts.task);
check('resume refuses a closed task rather than reopen its journal', /no matching/.test(await resumeRefusal()));
dropSession(retained.ref);

const reviewer = codexDriver.prepare({ ref: 'execution-free-review', role: 'reviewer',
  task: opts.task, address: 'reviewer:source', root, cwd: root,
  settingsPath: path.join(root, 'review-settings.json'), prompt: 'Read the diff.',
  model: 'gpt-6-astra', mcp: { servers: { promptobus: {
    command: process.execPath, args: [], env: { PROMPTOBUS_HOME: host.promptobusHome() },
  } } },
});
const reader = reviewer.mcpConfig.mcpServers.reviewer_files;
const roots = JSON.parse(reader.env.PROMPTOBUS_REVIEW_READ_ROOTS);
check('reviewer disables native command execution while other roles retain it',
  threadStartConfig({ role: 'reviewer' })['features.shell_tool'] === false
  && threadStartConfig({ role: 'reviewer' })['features.unified_exec'] === false
  && threadStartConfig({ role: 'worker' })['features.shell_tool'] === undefined
  && threadStartConfig({ role: 'approver' })['features.unified_exec'] === undefined
  && threadStartConfig({ role: 'reporter' })['features.shell_tool'] === undefined);
check('reviewer receives only the bounded file-reader helper and declared source roots',
  reader.command === process.execPath && /reviewer-files\.js$/.test(reader.args[0])
  && roots.includes(root) && !roots.includes(reviewer.cwd)
  && roots.includes(path.join(host.promptobusHome(), 'tasks', opts.task, 'files'))
  && !roots.includes(reviewer.codexHome) && reviewer.settings.sandbox === 'read-only');

const recovery = { initialPrompt: 'ORIGINAL SCOPE MARKER', prompt: 'Continue with current instructions' };
check('empty native history replays immutable original assignment and the continuation',
  recoveryPrompt(recovery, { thread: { turns: [] } }) === 'ORIGINAL SCOPE MARKER\n\n## Recovery continuation\nContinue with current instructions');
check('native user history containing the assignment avoids replaying it',
  recoveryPrompt(recovery, { thread: { turns: [{ items: [{ type: 'userMessage', content: [{ type: 'text', text: recovery.initialPrompt }] }] }] } }) === recovery.prompt);
check('model output quoting assignment is not proof that its user input was delivered',
  recoveryPrompt(recovery, { thread: { turns: [{ items: [{ type: 'agentMessage', text: recovery.initialPrompt }] }] } }) !== recovery.prompt);
const outsideRules = path.join(root, 'outside-rules', 'AGENTS.md');
mkdirSync(path.dirname(outsideRules), { recursive: true });
writeFileSync(outsideRules, 'Declared rule file only');
const externalSkill = path.join(root, 'external-review-skill');
mkdirSync(externalSkill);
writeFileSync(path.join(externalSkill, 'SKILL.md'), '---\nname: external-review\n---\nRead references.');
const bounded = codexDriver.prepare({ ref: 'bounded-review', role: 'reviewer', task: opts.task,
  address: 'reviewer:bounds', root, cwd: path.join(root, 'source'),
  settingsPath: path.join(root, 'bounded-settings.json'), prompt: 'Review', model: 'gpt-6-astra',
  addDirs: [path.dirname(outsideRules)], readFiles: [outsideRules], readSkillDirs: [externalSkill],
  mcp: { servers: {} },
});
const boundedRoots = JSON.parse(bounded.mcpConfig.mcpServers.reviewer_files.env.PROMPTOBUS_REVIEW_READ_ROOTS);
check('reviewer grants exact rule files and external review skills without their ancestors',
  boundedRoots.includes(outsideRules) && boundedRoots.includes(externalSkill)
  && !boundedRoots.includes(path.dirname(outsideRules)) && !boundedRoots.includes(root)
  && !boundedRoots.includes(bounded.cwd) && !boundedRoots.includes(bounded.codexHome));
const indexFile = path.join(root, '.agents', 'skills-index.md');
mkdirSync(path.dirname(indexFile), { recursive: true });
mkdirSync(path.join(root, 'source'), { recursive: true });
writeFileSync(indexFile, 'Review skills index marker');
const privateFile = path.join(root, '.agents', 'private.txt');
writeFileSync(privateFile, 'PRIVATE');
const indexPlan = codexDriver.prepare({ ref: 'indexed-review', role: 'reviewer', root,
  cwd: path.join(root, 'source'), settingsPath: path.join(root, 'indexed-settings.json'),
  prompt: 'Review', model: 'gpt-6-astra', mcp: { servers: {} },
});
const indexRoots = JSON.parse(indexPlan.mcpConfig.mcpServers.reviewer_files.env.PROMPTOBUS_REVIEW_READ_ROOTS);
const indexReader = reviewerFiles(indexRoots);
let privateDenied = false, parentDenied = false, indexMarker = '';
try { indexMarker = indexReader('read_file', { path: indexFile }).lines[0].text; } catch (error) { indexMarker = error.message; }
try { indexReader('read_file', { path: privateFile }); } catch (error) { privateDenied = /outside the declared review roots/.test(error.message); }
try { indexReader('list_files', { path: path.dirname(indexFile) }); } catch (error) { parentDenied = /outside the declared review roots/.test(error.message); }
check('Codex reviewer can read the exact workspace skills index without its parent or private sibling',
  indexMarker === 'Review skills index marker'
  && privateDenied && parentDenied && !indexRoots.includes(root));
const workerPlan = codexDriver.prepare({ ref: 'index-worker', role: 'worker', root,
  cwd: path.join(root, 'source'), prompt: 'Implement', model: 'gpt-6-astra', mcp: { servers: {} },
});
check('a Codex worker does not receive the reviewer file server', !workerPlan.mcpConfig.mcpServers.reviewer_files);

let incompatibleCode;
const incompatibleOutput = await expectFail(async () => {
  incompatibleCode = await runPromptobus(['report', '--task', opts.task, '--question', 'What changed?', '--model', 'other'], { host, cwd: root, env: {} });
});
check('report question CLI rejects launch flags before looking for a reporter',
  incompatibleOutput.failed && /report --question cannot use launch options: --model/.test(incompatibleOutput.out));
check('report help documents the follow-up channel', /report --task <root> --question <text>/.test(helpText(host)));

const personalSkill = path.join(homedir(), '.agents', 'skills', 'visible-personal-reader');
mkdirSync(personalSkill, { recursive: true });
writeFileSync(path.join(personalSkill, 'SKILL.md'), '---\nname: visible-personal-reader\n---\nRead nearby references.');
const personalPlan = codexDriver.prepare({ ref: 'personal-review', role: 'reviewer', root,
  cwd: path.join(root, 'source'), settingsPath: path.join(root, 'personal-settings.json'),
  prompt: 'Review', model: 'gpt-6-astra', mcp: { servers: {} },
});
const personalRoots = JSON.parse(personalPlan.mcpConfig.mcpServers.reviewer_files.env.PROMPTOBUS_REVIEW_READ_ROOTS);
check('visible unrelated personal skills remain readable without granting their home ancestor',
  personalRoots.includes(realpathSync(personalSkill)) && !personalRoots.includes(homedir())
  && !personalRoots.includes(path.join(homedir(), '.agents', 'skills')));

check('a natively injected original assignment resumes by continuation without duplication',
  recoveryPrompt({ ...recovery, initialAssignmentInjected: true }, { thread: { turns: [] } }) === recovery.prompt);

const doc = readFileSync(path.resolve('README.md'), 'utf8');
const line = doc.match(/^promptobus lead --brief[^\n]+/m)?.[0];
const args = line?.match(/"[^"]*"|[^\s]+/g)?.slice(1).map(value => value.replace(/^"|"$/g, '')) ?? [];
const index = args.indexOf('--brief');
if (index >= 0) args[index + 1] = brief;
const ran = await expectFail(() => runPromptobus([...args, '--dry-run'], { host, cwd: root, env: {} }));
check('README.md: the first managed lead recipe reaches a real CLI dry run',
  !ran.failed && ran.value === 0 && args[0] === 'lead', ran.out);
const from = doc.indexOf(line);
const end = doc.indexOf('promptobus spawn', from);
const question = doc.slice(from, end).match(/promptobus ask "[^"]*"[^\n`]*--task <id>/)?.[0];
check('README.md: the quickstart human question selects the task printed by lead', !!question);

function checkIndex(name, run) {
  let failure;
  try { run(); } catch (error) { failure = error; }
  check(name, !failure, failure?.stack);
}

function indexFixture() {
  const root = realpathSync(makeSandbox('promptobus-codex-'));
  const source = path.join(root, 'source');
  const privateDir = path.join(root, 'private');
  mkdirSync(source); mkdirSync(privateDir);
  const credential = path.join(privateDir, 'auth.json');
  writeFileSync(credential, 'PRIVATE_CREDENTIAL_FIXTURE');
  const index = path.join(root, '.agents', 'skills-index.md');
  mkdirSync(path.dirname(index));
  writeFileSync(index, 'PUBLIC_SKILLS_INDEX');
  const prepare = () => codexDriver.prepare({ root, cwd: source, role: 'reviewer', ref: 'index-boundary',
    settingsPath: path.join(root, 'review.settings.json'), prompt: 'Review', model: 'gpt-6-astra', mcp: { servers: {} },
    env: { ...process.env, PROMPTOBUS_CODEX_HOME: path.join(root, 'registry') },
  }).mcpConfig.mcpServers.reviewer_files;
  const reader = (env) => reviewerFiles(JSON.parse(env.PROMPTOBUS_REVIEW_READ_ROOTS),
    JSON.parse(env.PROMPTOBUS_REVIEW_CANONICAL_FILES));
  return { root, source, privateDir, credential, index, prepare, reader };
}

checkIndex('normal index is readable without its directory or neighbouring credentials', () => {
  const f = indexFixture(), env = f.prepare().env, read = f.reader(env);
  assert.deepEqual(JSON.parse(env.PROMPTOBUS_REVIEW_CANONICAL_FILES), [f.index]);
  assert.equal(read('read_file', { path: f.index }).lines[0].text, 'PUBLIC_SKILLS_INDEX');
  assert.throws(() => read('list_files', { path: path.dirname(f.index) }), /outside the declared review roots/);
  assert.throws(() => read('read_files', { files: [{ path: f.credential }] }), /outside the declared review roots/);
});
checkIndex('an index symlink cannot grant credentials outside the reviewed tree', () => {
  const f = indexFixture();
  unlinkSync(f.index); symlinkSync(f.credential, f.index);
  const env = f.prepare().env, read = f.reader(env);
  assert.deepEqual(JSON.parse(env.PROMPTOBUS_REVIEW_CANONICAL_FILES), []);
  for (const file of [f.index, f.credential]) assert.throws(() => read('read_file', { path: file }), /outside the declared review roots/);
});
checkIndex('a redirected index parent cannot grant its external target', () => {
  const f = indexFixture();
  writeFileSync(path.join(f.privateDir, 'skills-index.md'), 'PRIVATE_PARENT_FIXTURE');
  rmSync(path.dirname(f.index), { recursive: true }); symlinkSync(f.privateDir, path.dirname(f.index));
  const read = f.reader(f.prepare().env);
  for (const file of [f.index, path.join(f.privateDir, 'skills-index.md'), f.credential]) {
    assert.throws(() => read('read_file', { path: file }), /outside the declared review roots/);
  }
});
checkIndex('index replacement between preparation and server startup refuses instead of authorizing its target', () => {
  const f = indexFixture(), server = f.prepare();
  unlinkSync(f.index); symlinkSync(f.credential, f.index);
  assert.throws(() => f.reader(server.env), /Canonical review file changed/);
  const child = spawnSync(server.command, server.args, {
    env: { ...process.env, ...server.env }, input: '', encoding: 'utf8', timeout: 5000,
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /Canonical review file changed/);
  assert.ok(!child.stdout.includes('PRIVATE_CREDENTIAL_FIXTURE'));
});
checkIndex('parent replacement before startup is rejected and replacement after startup cannot escape', () => {
  const f = indexFixture(), server = f.prepare(), read = f.reader(server.env);
  writeFileSync(path.join(f.privateDir, 'skills-index.md'), 'PRIVATE_PARENT_FIXTURE');
  rmSync(path.dirname(f.index), { recursive: true }); symlinkSync(f.privateDir, path.dirname(f.index));
  assert.throws(() => f.reader(server.env), /Canonical review file changed/);
  assert.throws(() => read('read_file', { path: f.index }), /outside the declared review roots/);
});
checkIndex('index replaced with a directory before server startup is refused without descendant bytes', () => {
  const f = indexFixture(), server = f.prepare();
  unlinkSync(f.index); mkdirSync(f.index);
  writeFileSync(path.join(f.index, 'private.txt'), 'PRIVATE_DIRECTORY_FIXTURE');
  assert.throws(() => f.reader(server.env), /Canonical review file changed/);
  const child = spawnSync(server.command, server.args, {
    env: { ...process.env, ...server.env }, input: '', encoding: 'utf8', timeout: 5000,
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /Canonical review file changed/);
  assert.ok(!child.stdout.includes('PRIVATE_DIRECTORY_FIXTURE'));
});
checkIndex('index replaced with a directory after startup retains an exact-file grant', () => {
  const f = indexFixture(), read = f.reader(f.prepare().env);
  unlinkSync(f.index); mkdirSync(f.index);
  const descendant = path.join(f.index, 'private.txt');
  writeFileSync(descendant, 'PRIVATE_DIRECTORY_FIXTURE');
  assert.throws(() => read('read_file', { path: descendant }), /outside the declared review roots/);
  assert.throws(() => read('read_files', { files: [{ path: descendant }] }), /outside the declared review roots/);
  assert.throws(() => read('search_text', { path: f.index, query: 'PRIVATE' }), /outside the declared review roots/);
});
