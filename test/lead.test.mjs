import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { capture } from './console.mjs';
import { hostOf } from '../lib/host.js';
import { planLead, lead } from '../lib/lead.js';
import { bus, claimWarden, clearWarden, participantRecord, taskExists, taskFile, upsertParticipant } from '../lib/store.js';
import { wardenLine } from '../lib/status.js';
import { runPromptobus, helpText } from '../lib/cli.js';
import { dropSession, readSession, writeSession, threadStartConfig } from '../lib/codex-session.js';
import { codexDriver, participantCodexHome } from '../lib/driver-codex.js';

const root = makeSandbox('promptobus-lead-');
writeHostConfig(root, { tools: ['codex'] });
const host = hostOf(root);
const brief = path.join(root, 'assignment.md');
writeFileSync(brief, '# Codex owns this task\nCoordinate the workers and accept their results.\n');
const opts = { brief, task: 'lead-t20261001-000001', model: 'gpt-6-astra', dryRun: true };
const plan = await planLead(host, opts);
check('Codex root lead plans the orchestrator mailbox without a child task',
  plan.address === 'orchestrator' && plan.task === opts.task && !plan.rootTask
  && plan.launch.mcpConfig.mcpServers.promptobus.env.PROMPTOBUS_ROLE === 'orchestrator'
  && plan.launch.mcpConfig.mcpServers.promptobus.env.PROMPTOBUS_TASK === opts.task);
check('root lead has a private Codex home and writes no shared project layer',
  plan.launch.files.length === 0 && plan.launch.trustProject === false
  && plan.launch.codexHome && plan.launch.rootSessionRecord === null);
check('root lead keeps the requested model and the ordinary write sandbox',
  plan.model === 'gpt-6-astra' && plan.launch.settings.sandbox === 'workspace-write');
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
  cliCode = await runPromptobus(['lead', '--brief', brief, '--task', opts.task,
    '--model', 'gpt-6-astra', '--dry-run'], { host, cwd: root, env: {} });
});
check('lead CLI dispatch reaches the dry plan without creating a task',
  cliCode === 0 && /root task: lead-t20261001-000001/.test(cliOutput)
  && /dry-run: nothing written/.test(cliOutput) && !taskExists(host.promptobusHome(), opts.task));
check('CLI help exposes the managed root and both reporter harnesses',
  /lead --brief/.test(helpText(host))
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
  && roots.includes(root) && roots.includes(reviewer.cwd)
  && roots.includes(path.join(host.promptobusHome(), 'tasks', opts.task, 'files'))
  && !roots.includes(reviewer.codexHome) && reviewer.settings.sandbox === 'read-only');
