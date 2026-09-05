// Codex driver — the third production bus driver. Run: npm test
//
// Subject — what Codex does differently from Claude Code and Cursor: an app-server
// process per participant, a thread without a turn does not exist, turn/steer into a
// turn in progress, review/start, the limit gate, denyTools as the sandbox, an empty
// LaunchPlan.files. The loop runs on the real mechanism. Only the `codex` binary is
// substituted ([harness-codex.mjs](harness-codex.mjs)).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { buildWorkspace, cli, store } from './scenario.mjs';
import {
  APPROVAL_VAR, CODEX_HOME_VAR, FIRST_DELAY_VAR, HANG_FIRST_VAR, LIMIT_VAR,
  diagnoseTrace, installHarness, pidAlive, planParticipant, readTrace,
} from './harness-codex.mjs';
import { waitFor } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SB = makeSandbox('promptobus-codex-');
const { home: HARNESS, stateHome, restore } = await installHarness({ binDir: path.join(SB, 'bin') });

const {
  codexDriver, PHRASES, PROVEN_CODEX_VERSION, DEFAULT_MODEL, REVIEWER_DENY,
} = await import(path.join(here, '..', 'lib', 'driver-codex.js'));
const {
  readSession, writeSession, dropSession, decideApproval, readyMs, preambleMs, turnWaitMs,
  codexMcpServers, codexMcpName, sessionsDir, CODEX_MCP_PREFIX,
} = await import(path.join(here, '..', 'lib', 'codex-session.js'));
const { liftDriver, REGISTRY } = await import(path.join(here, '..', 'lib', 'drivers.js'));
const { liftHarness, toolName } = await import(path.join(here, '..', 'lib', 'spawn.js'));

const TASK = 'codexbus-t20260903-000000';
const WORKER = 'worker:cdx';
const REVIEWER = 'reviewer:cdx';
const ORCH_SESSION = `orch-codex-${process.pid}`;

function thrown(fn) {
  try {
    fn();
    return { threw: false, msg: '' };
  } catch (e) {
    return { threw: true, msg: e.message };
  }
}

check(': the Codex driver sits in the registry map and is taken by name',
  liftDriver('codex').id === 'codex' && Object.keys(REGISTRY.drivers).sort().join(',') === 'claude,codex,cursor',
  Object.keys(REGISTRY.drivers).join(','));

check(': without a name the previous driver is taken — Claude Code argv does not move',
  liftDriver().id === 'claude');

check(': Codex capabilities are declared, all nine',
  ['spawn', 'attach', 'activation', 'inspect', 'stop', 'denyTools', 'systemPrompt', 'sessionList', 'enter']
    .every((k) => codexDriver.capabilities[k] !== undefined)
  && codexDriver.capabilities.attach === false && codexDriver.capabilities.activation === 'push',
  JSON.stringify(codexDriver.capabilities));

check(': default readyMs = preamble + turn, not the old 60 s',
  readyMs({}) === preambleMs({}) + turnWaitMs({}) && readyMs({}) > 180_000,
  String(readyMs({})));

const patchRec = { cwd: '/tmp/wt', addDirs: [], role: 'worker' };
check(': a patch outside cwd — deny',
  (() => {
    const d = decideApproval('applyPatchApproval', { changes: { '/etc/passwd': { type: 'add' } } }, patchRec);
    return d.allow === false && /outside cwd/.test(d.why);
  })());
check(': a patch with an unreadable target — deny',
  (() => {
    const d = decideApproval('applyPatchApproval', {}, patchRec);
    return d.allow === false && /unreadable/.test(d.why);
  })());
check(': a relative patch inside cwd — allow',
  decideApproval('applyPatchApproval', { changes: { 'note.md': { type: 'add' } } }, patchRec).allow === true);
check(': fileChange outside cwd — deny',
  (() => {
    const d = decideApproval('item/fileChange/requestApproval', { item: { path: '/etc/x' } }, patchRec);
    return d.allow === false && /outside cwd/.test(d.why);
  })());

check(': the channel is declared rpc — knockRegistry does not substitute the messaging socket',
  codexDriver.options.knockChannel === 'rpc', codexDriver.options.knockChannel);

check(': the Codex vocabulary is its own — binary, model, reviewer sandbox',
  codexDriver.options.tool === 'codex' && codexDriver.options.defaultModel === DEFAULT_MODEL
  && JSON.stringify(codexDriver.options.denyTools) === JSON.stringify(REVIEWER_DENY)
  && codexDriver.options.skillsDir === false
  && JSON.stringify(codexDriver.options.permissionModes) === JSON.stringify(['read-only', 'workspace-write']),
  JSON.stringify(codexDriver.options));

check(': bus tool names are mcp__<override key>__name',
  PHRASES.tool('promptobus', 'promptobus_send') === `mcp__${codexMcpName('promptobus')}__promptobus_send`
  && PHRASES.tool('promptobus', 'promptobus_send') !== 'mcp__promptobus__promptobus_send',
  PHRASES.tool('promptobus', 'promptobus_send'));

check(': harness rules forbid questions and require the mailbox on every turn',
  /Do not ask questions/.test(PHRASES.promptRules) && /Fetch the mailbox at the start of every turn/.test(PHRASES.promptRules));

check(': a binary older than the proven version — refuse before lift',
  /0\.140/.test(String(codexDriver.optionRefusal({}, { version: '0.140.0' })))
  && codexDriver.optionRefusal({}, { version: PROVEN_CODEX_VERSION }) === null
  && codexDriver.optionRefusal({}, { version: null }) === null,
  String(codexDriver.optionRefusal({}, { version: '0.140.0' })).slice(0, 90));

check(': shadowedUserServers is empty — the personal set is not isolated, config/read is forbidden',
  JSON.stringify(codexDriver.shadowedUserServers(['promptobus'])) === '[]');

// The `config.mcp_servers` override form is checked by field comparison, not by running
// the binary. The stand below does not parse the config, and a real `codex` refuses to
// load it WHOLE on an extra field and does not lift the participant at all; a live
// workspace has 13 of 14 url-servers. Hence two steps: here the translation fields are
// checked, and at `worker:mcp` — what actually went into `thread/start`.
const translated = codexMcpServers({
  'es-mcp-prod': { type: 'http', url: 'http://es.invalid/mcp' },
  'ati-kaiten-mcp': { type: 'http', url: 'http://kaiten.invalid/mcp', headers: { api_key: 'TOKEN' } },
  promptobus: { type: 'stdio', command: 'node', args: ['bin.js'], env: { PROMPTOBUS_ROLE: WORKER } },
  'sse-legacy': { type: 'sse', url: 'http://sse.invalid/mcp' },
  'bez-komandy': { type: 'stdio', args: [], env: {} },
});
const fieldsOf = (name) => Object.keys(translated.servers[codexMcpName(name)] ?? {}).sort().join(',');

check(': a url-server goes out in url form — no args, no env, no command',
  fieldsOf('es-mcp-prod') === 'url'
  && fieldsOf('ati-kaiten-mcp') === 'http_headers,url'
  && translated.servers[codexMcpName('ati-kaiten-mcp')].http_headers.api_key === 'TOKEN',
  JSON.stringify(translated.servers));

check(': a stdio-server goes out in stdio form — no url is attached to it',
  fieldsOf('promptobus') === 'args,command,env'
  && translated.servers[codexMcpName('promptobus')].env.PROMPTOBUS_ROLE === WORKER,
  JSON.stringify(translated.servers[codexMcpName('promptobus')]));

check(': a transport Codex does not have, and a half-record, are not given out at all',
  !(codexMcpName('sse-legacy') in translated.servers) && !(codexMcpName('bez-komandy') in translated.servers)
  && translated.skipped.slice().sort().join(',') === 'bez-komandy,sse-legacy',
  JSON.stringify(translated.skipped));

check(': override keys carry the prefix — canonical names do not go into the config',
  CODEX_MCP_PREFIX === 'promptobus-'
  && !('promptobus' in translated.servers) && !('es-mcp-prod' in translated.servers)
  && codexMcpName('promptobus') in translated.servers
  && codexMcpName('es-mcp-prod') in translated.servers
  && codexMcpName('promptobus') === `${CODEX_MCP_PREFIX}promptobus`
  && codexMcpName(`${CODEX_MCP_PREFIX}promptobus`) === `${CODEX_MCP_PREFIX}promptobus`,
  JSON.stringify(Object.keys(translated.servers)));

check(': toolName and phrases.tool call the override key, not the canonical name',
  toolName(codexDriver, 'promptobus', 'promptobus_send') === `mcp__${CODEX_MCP_PREFIX}promptobus__promptobus_send`
  && toolName(codexDriver, 'promptobus', 'promptobus_mailbox') === PHRASES.tool('promptobus', 'promptobus_mailbox')
  && toolName(codexDriver, 'memory-hooks', 'search_facts') === `mcp__${CODEX_MCP_PREFIX}memory-hooks__search_facts`,
  toolName(codexDriver, 'promptobus', 'promptobus_send'));

const ctx = {
  mcp: { servers: { promptobus: { command: 'node', args: ['x'], env: {} } } },
  prompt: 'PROMPT',
  model: DEFAULT_MODEL,
  cwd: '/tmp/wt',
  addDirs: ['/tmp/rules'],
};
const workerPlan = codexDriver.prepare(ctx);
check(': argv is app-server --stdio, prompt last; no files on disk',
  workerPlan.argv[0] === 'app-server' && workerPlan.argv[1] === '--stdio'
  && workerPlan.argv.at(-1) === 'PROMPT' && workerPlan.files.length === 0
  && workerPlan.settings.sandbox === 'workspace-write'
  && workerPlan.settings.approvalPolicy === 'on-request',
  JSON.stringify({ argv: workerPlan.argv.slice(0, 2), files: workerPlan.files.length, settings: workerPlan.settings }));

const reviewerPlan = codexDriver.prepare({ ...ctx, denyTools: REVIEWER_DENY, role: 'reviewer' });
check(': reviewer — sandbox read-only, same cwd, no files',
  reviewerPlan.settings.sandbox === 'read-only' && reviewerPlan.cwd === ctx.cwd
  && reviewerPlan.files.length === 0,
  JSON.stringify(reviewerPlan.settings));

check(': the wake text calls the mailbox by the Codex name',
  (() => {
    const text = codexDriver.renderNotification({
      kind: 'unread', task: 'T', address: 'worker:a', unread: 1,
      messages: [{ type: 'answer', from: 'orchestrator', ts: 'now', body: 'BODY' }],
    });
    return text.includes(`mcp__${codexMcpName('promptobus')}__promptobus_mailbox`) && text.includes('BODY');
  })());

const { ws, repoAbs, repo } = buildWorkspace(SB);
writeHostConfig(ws, { tools: ['claude', 'codex'] });
const home = path.join(ws, '.promptobus');
const brief = path.join(SB, 'worker-brief.md');
writeFileSync(brief, '# Codex driver probe\n\nSend the orchestrator a status and end the turn.\n');

const MARK = 'CODEX-STATUS-1';
const WOKE = 'CODEX-WOKE-1';
const STEERED = 'CODEX-STEER-1';
const REVIEW_MARK = 'CODEX-REVIEW-1';
const NOTE_FILE = 'codex/note.md';
const FORBIDDEN = 'codex/forbidden.md';

planParticipant(HARNESS, WORKER, {
  turns: [
    {
      do: [
        { write: { path: NOTE_FILE, text: `# ${MARK}\n` } },
        { commit: { message: ': правка worker’а Codex' } },
        { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: `${MARK}: worker Codex на связи` } },
      ],
    },
    { do: [{ wait: 900 }, { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: `${STEERED}: второй ход` } }] },
    { do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: `${WOKE}: разбужен` } }] },
  ],
});
planParticipant(HARNESS, REVIEWER, {
  turns: [
    {
      do: [
        { write: { path: FORBIDDEN, text: 'must not appear\n' } },
        { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: `${REVIEW_MARK}: замечаний нет` } },
      ],
    },
  ],
});

const env = {
  ...process.env,
  PROMPTOBUS_HOME: home,
  CLAUDE_CODE_SESSION_ID: ORCH_SESSION,
  PROMPTOBUS_WARDEN: 'off',
  [CODEX_HOME_VAR]: HARNESS,
  PROMPTOBUS_CODEX_HOME: stateHome,
};
store.createTask(home, { id: TASK, title: 'проба driver’а Codex', owner: ORCH_SESSION });

const bare = path.join(SB, 'bare-ws');
writeHostConfig(bare, { tools: ['claude'] });
const undeclared = thrown(() => liftHarness(bare, 'codex'));
check(': a harness outside promptobus.json is refused before lift',
  undeclared.threw && /tools add codex/.test(undeclared.msg), undeclared.msg);
check(': a declared harness passes the same gate',
  liftHarness(ws, 'codex').id === 'codex');

const dry = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'cdx', '--harness', 'codex', '--dry-run'], { cwd: ws, env });
check(': --dry-run prints app-server --stdio and writes nothing to disk',
  dry.status === 0 && /app-server --stdio/.test(dry.out) && /dry-run: nothing written to disk, worker not started/.test(dry.out),
  dry.out.slice(-500));
check(': --dry-run names the thread id and that the prompt goes out as turn/start',
  /harness session name: the thread id is chosen by app-server/.test(dry.out)
  && /the prompt then goes out as a turn\/start request/.test(dry.out),
  dry.out.slice(-400));

const spawned = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'cdx', '--harness', 'codex'], { cwd: ws, env });
check('step 1: promptobus spawn --harness codex lifted the participant',
  spawned.status === 0 && /worker worker:cdx lifted/.test(spawned.out), spawned.out.slice(-800));

const wp = store.participantOf(store.readTask(home, TASK), WORKER);
check('step 1: the record carries harness codex and a capabilities snapshot',
  wp?.harness === 'codex' && wp?.mode === 'managed' && wp?.capabilities?.activation === 'push'
  && wp?.capabilities?.sessionList === true, JSON.stringify(wp?.capabilities));

const ref = wp?.sessionRef ?? '';
const record = readSession(ref, env);
check('step 1: the thread landed in the mechanism registry — thread id and holder are alive',
  !!record?.threadId && record.state === 'alive' && typeof record.holderPid === 'number',
  JSON.stringify({ threadId: record?.threadId, state: record?.state, holder: record?.holderPid }));

check('step 1: the session handle is the thread id',
  wp?.metadata?.session === record?.threadId, `${wp?.metadata?.session} · ${record?.threadId}`);

const sent = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
  .find((m) => String(m.body ?? '').includes(MARK)) ?? null, { timeoutMs: 25000 });
check('step 2: the bus loop from Codex closed — status reached the orchestrator',
  !!sent, `${JSON.stringify(sent)} · ${diagnoseTrace(HARNESS, WORKER)}`);

const idle = await waitFor(() => {
  const view = codexDriver.inspect(ref);
  return view && view.state === 'alive' && view.busy === false ? view : null;
}, { timeoutMs: 15000 });
check('step 3: the turn ended — the session is alive and not busy',
  idle?.state === 'alive' && idle?.busy === false && idle?.id === record?.threadId,
  JSON.stringify(idle));

{
  const idleStatus = cli([ 'status', '--task', TASK], { cwd: ws, env });
  const idleLine = idleStatus.out.split('\n').find((l) => l.includes(WORKER)) ?? idleStatus.out;
  check(': idle after a Codex turn — inspect.unknown, status is not a stall of unknown nature',
    idle?.stall?.kind === 'unknown' && /the turn ended/.test(String(idle?.stall?.reason))
    && idleStatus.status === 0 && /waiting for a message/.test(idleLine) && !/STALLED/.test(idleLine),
    `${JSON.stringify(idle)} · ${idleLine}`);
}

{
  const idleRec = readSession(ref);
  writeSession({ ...idleRec, busy: true });
  const during = codexDriver.inspect(ref);
  check(': a Codex turn in progress is not painted as a stall',
    during?.busy === true && during?.stall === null
    && !/stood/i.test(String(during?.note ?? '')),
    JSON.stringify(during));
  writeSession({ ...idleRec, busy: false });
}

const statusOut = cli([ 'status', '--task', TASK], { cwd: ws, env });
check('step 3: promptobus status shows Codex session liveness',
  statusOut.status === 0 && statusOut.out.includes(WORKER), statusOut.out.slice(-400));

const second = await codexDriver.activate({ ref }, {
  kind: 'unread', task: TASK, address: WORKER, unread: 1,
  messages: [{ type: 'task', from: 'orchestrator', ts: 'now', body: 'второй ход' }],
});
check('step 4: activate while idle starts a turn', second.ok === true, JSON.stringify(second));

await new Promise((r) => { setTimeout(r, 80); });
const steered = await codexDriver.activate({ ref }, {
  kind: 'unread', task: TASK, address: WORKER, unread: 2,
  messages: [{ type: 'task', from: 'orchestrator', ts: 'now', body: 'steer' }],
});
check('step 4: activate during a turn — turn/steer, not a refusal',
  steered.ok === true, JSON.stringify(steered));

const steerTrace = await waitFor(() => {
  const tr = readTrace(HARNESS, WORKER);
  return tr.find((e) => e.kind === 'steer') ?? null;
}, { timeoutMs: 15000 });
check('step 4: the stand saw steer with the same turnId',
  !!steerTrace && typeof steerTrace.turnId === 'string', JSON.stringify(steerTrace));

const secondSent = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
  .find((m) => String(m.body ?? '').includes(STEERED)) ?? null, { timeoutMs: 20000 });
check('step 4: the second turn arrived as a result',
  !!secondSent, `${JSON.stringify(secondSent)} · ${diagnoseTrace(HARNESS, WORKER)}`);

const wt = wp?.metadata?.worktree ?? ws;
const reviewed = cli([ 'review', wt, '--task', TASK, '--harness', 'codex'], { cwd: ws, env });
check('step 5: promptobus review --harness codex lifted the reviewer',
  reviewed.status === 0 && /reviewer reviewer:cdx started/.test(reviewed.out), reviewed.out.slice(-600));

const reviewSent = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
  .find((m) => String(m.body ?? '').includes(REVIEW_MARK)) ?? null, { timeoutMs: 25000 });
check('step 5: the reviewer report reached the orchestrator',
  !!reviewSent, `${JSON.stringify(reviewSent)} · ${diagnoseTrace(HARNESS, REVIEWER)}`);

check('step 5: the read-only reviewer did not write a file — there is no machine sign of refusal, we check the disk',
  !existsSync(path.join(wt, FORBIDDEN)),
  existsSync(path.join(wt, FORBIDDEN)) ? 'file exists' : 'no file');

const reviewDenied = readTrace(HARNESS, REVIEWER).some((e) => e.kind === 'write-denied');
check('step 5: the stand refused the reviewer a write',
  reviewDenied, diagnoseTrace(HARNESS, REVIEWER));

const stopped = await codexDriver.stop(ref);
check('step 6: stop kills the holder and drops the record',
  stopped.ok && stopped.stopped && !readSession(ref, env),
  JSON.stringify(stopped));

const gone = codexDriver.inspect(ref);
check('step 6: inspect after stop — gone',
  gone.state === 'gone', JSON.stringify(gone));

const limitEnv = { ...env, [LIMIT_VAR]: '1' };
const limited = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'lim', '--harness', 'codex'], { cwd: ws, env: limitEnv });
check('step 7: account limit — refuse before thread/start',
  limited.status !== 0 && /limit/i.test(limited.out), limited.out.slice(-400));

const approvalEnv = { ...env, [APPROVAL_VAR]: '1' };
planParticipant(HARNESS, 'worker:apr', {
  turns: [{ do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'CODEX-APR' } }] }],
});
const approved = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'apr', '--harness', 'codex'], { cwd: ws, env: approvalEnv });
check('step 7: an approval request without a hang — the driver replied, the participant is up',
  approved.status === 0 && /worker worker:apr lifted/.test(approved.out), approved.out.slice(-500));

const apr = store.participantOf(store.readTask(home, TASK), 'worker:apr');
if (apr?.sessionRef) await codexDriver.stop(apr.sessionRef);
const rev = store.participantOf(store.readTask(home, TASK), REVIEWER);
if (rev?.sessionRef) await codexDriver.stop(rev.sessionRef);

const deadRef = 'dead-probe';
writeSession({
  ref: deadRef, state: 'dead', threadId: 't-dead', holderPid: process.pid,
  error: 'app-server exited (9)',
}, process.env);
const deadView = codexDriver.inspect(deadRef);
check(': inspect at state=dead — stall, even if holderPid is alive',
  deadView.state === 'stale' && deadView.stall?.kind === 'stale' && /died|exited/.test(deadView.stall.reason),
  JSON.stringify(deadView));
dropSession(deadRef, process.env);

// Holder and app-server processes of THIS file, and nobody else's.
//
// `pgrep -f` reads the whole machine, and the patterns here used to be
// `codex-hold.js` and `app-server --stdio` — names every run on the machine
// carries. A worker run by tracks puts a second `npm test` on the same machine as
// a matter of course, and its holders then counted against this file's verdict.
// Reproduced deliberately 2026-09-05: two runs started 3.2 s apart, and the check
// below went red in BOTH — one saw `app 19472`, the other `hold 24233,25179 ·
// app 24653`, each of them the neighbour's pids (PB-14.4).
//
// The scope is the file's own sandbox, and each process carries it in its own
// argv: the holder is started as `codex-hold.js <session file>`, and that file
// lives under this stand's state home (`promptobus-codex-…/state`); the app-server
// is the stub binary, started from this file's own `bin` directory inside the file
// sandbox. So each pattern is a path this run alone owns, not a program name — a
// neighbouring run has other directories and cannot match either of them.
//
// The snapshot-and-subtract around the spawn (`beforeHold` / `beforeApp`) stays.
// It answers a different question — processes of THIS file that were already up
// before the refusal — and holders leaked by an earlier run of this same suite are
// exactly what it filters out.
const ere = (s) => s.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
const HOLD_PATTERN = `codex-hold\\.js ${ere(sessionsDir(env))}`;
const APP_PATTERN = ere(`${path.join(SB, 'bin')}/codex.stub.mjs app-server --stdio`);

function pgrep(pattern) {
  const r = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  return String(r.stdout ?? '').trim().split('\n').filter(Boolean);
}

// Sentinel over the two patterns above. Widening one back to a bare program name
// is a one-word edit, and its cost is a red verdict in someone else's run days
// later — so the sandbox path is required to be in both, here, where the edit
// happens.
check(': both process reads are scoped to this file\'s own directories, not to a program name',
  HOLD_PATTERN.includes(ere(stateHome)) && APP_PATTERN.includes(ere(SB)),
  `hold ${HOLD_PATTERN} · app ${APP_PATTERN}`);

planParticipant(HARNESS, 'worker:hang', {
  turns: [{ do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'HANG' } }] }],
});
const beforeHold = pgrep(HOLD_PATTERN);
const beforeApp = pgrep(APP_PATTERN);
const hangEnv = { ...env, PROMPTOBUS_CODEX_READY_MS: '3000', [HANG_FIRST_VAR]: '1' };
const hung = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'hang', '--harness', 'codex'], { cwd: ws, env: hangEnv });
check(': a lift refusal on timeout — non-zero code',
  hung.status !== 0 && /did not lift/.test(hung.out), hung.out.slice(-400));
const extraHold = pgrep(HOLD_PATTERN).filter((p) => !beforeHold.includes(p));
const extraApp = pgrep(APP_PATTERN).filter((p) => !beforeApp.includes(p));
check(': after a lift refusal there are no holder processes',
  extraHold.length === 0 && extraApp.length === 0,
  `hold ${extraHold.join(',')} · app ${extraApp.join(',')}`);

planParticipant(HARNESS, 'worker:die', {
  turns: [{ do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'DIE' } }] }],
});
const diedUp = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'die', '--harness', 'codex'], { cwd: ws, env });
check(': the participant for the app-server death probe is up',
  diedUp.status === 0, diedUp.out.slice(-300));
const diePart = store.participantOf(store.readTask(home, TASK), 'worker:die');
const dieRec = readSession(diePart?.sessionRef ?? '', env);
if (dieRec?.appPid) {
  try { process.kill(dieRec.appPid, 'SIGKILL'); } catch { /* none */ }
}
const died = await waitFor(() => {
  const r = readSession(diePart?.sessionRef ?? '', env);
  const view = r ? codexDriver.inspect(diePart.sessionRef) : null;
  return r?.state === 'dead' && !pidAlive(dieRec.holderPid) && view?.stall ? view : null;
}, { timeoutMs: 8000 });
check(': app-server death kills the holder and inspect sets a stall',
  !!died && died.stall?.kind === 'stale' && !pidAlive(dieRec?.holderPid),
  JSON.stringify({ died, holder: dieRec?.holderPid }));
if (diePart?.sessionRef) await codexDriver.stop(diePart.sessionRef);

planParticipant(HARNESS, 'worker:slow', {
  turns: [{ do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'SLOW' } }] }],
});
const slowEnv = { ...env, PROMPTOBUS_CODEX_READY_MS: '25000', [FIRST_DELAY_VAR]: '5000' };
const slow = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'slow', '--harness', 'codex'], { cwd: ws, env: slowEnv });
check(': waitReady waits for a delayed first turn and does not give up before the holder',
  slow.status === 0 && /worker worker:slow lifted/.test(slow.out), slow.out.slice(-500));
const slowPart = store.participantOf(store.readTask(home, TASK), 'worker:slow');
if (slowPart?.sessionRef) await codexDriver.stop(slowPart.sessionRef);

// Second step: what actually went into `thread/start`. The stand puts `params.config`
// into its thread record — that is what we read. Until this point the stand workspace
// canon was a single bus entry, so lift never saw a url-server; here the canon gets one
// and the participant is lifted with both transports at once.
writeHostConfig(ws, {
  tools: ['claude', 'codex'],
  mcp: {
    'probe-http': { type: 'http', url: 'http://probe.invalid/mcp', headers: { api_key: 'PROBE-TOKEN' } },
  },
});

planParticipant(HARNESS, 'worker:mcp', {
  turns: [{ do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'CODEX-MCP' } }] }],
});
const mcpUp = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'mcp', '--harness', 'codex'], { cwd: ws, env });
check(': a participant with a url-server in the set is lifted — the Codex config was accepted',
  mcpUp.status === 0 && /worker worker:mcp lifted/.test(mcpUp.out), mcpUp.out.slice(-600));

const mcpPart = store.participantOf(store.readTask(home, TASK), 'worker:mcp');
const mcpThread = (() => {
  const id = readSession(mcpPart?.sessionRef ?? '', env)?.threadId;
  try {
    return JSON.parse(readFileSync(path.join(HARNESS, 'threads', `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
})();
const started = mcpThread?.config?.mcp_servers ?? {};
const busKey = codexMcpName('promptobus');
const httpKey = codexMcpName('probe-http');
check(': in thread/start the url-server went out in url form, the bus in stdio form',
  Object.keys(started[httpKey] ?? {}).sort().join(',') === 'http_headers,url'
  && started[httpKey].http_headers.api_key === 'PROBE-TOKEN'
  && Object.keys(started[busKey] ?? {}).sort().join(',') === 'args,command,env',
  JSON.stringify(started));
check(': in thread/start there are no canonical names — the bus went out under the prefix',
  !('promptobus' in started) && !('probe-http' in started)
  && busKey in started && httpKey in started,
  JSON.stringify(Object.keys(started)));
if (mcpPart?.sessionRef) await codexDriver.stop(mcpPart.sessionRef);

restore();
