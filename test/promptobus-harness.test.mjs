// Unit on the stub harness itself. Run: npm test
//
// Subject — the stand, not the mechanism: until it is proven that the stub `claude`
// prints its registry in the real form, lifts a live participant process and stops it,
// E2E verdicts mean nothing — a red there would be indistinguishable from a crooked
// stand. So the checks here follow exactly the three harness promises from the brief:
// `agents --json` prints the lifted one, the participant accepts a knock and replies,
// `stop` kills it.
//
// The mechanism is still real here: the registry is read by `findSession` /
// `sessionLiveness` from [liftoff.js](../lib/liftoff.js), state is the `inspect`
// operation of the [claude](../lib/driver-claude.js) driver, the knock is its
// `knockSocket`, the contact point arrives in the store through `onJoin` of a live
// MCP server. Only the binary is substituted.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, makeSockPath } from './sandbox.mjs';
import {
  authorErrors, claudeConfigDir, diagnoseTrace, installHarness, listSessions, pidAlive, planParticipant,
  readLog, readTrace, sessionByName, stopAll, traceFile, waitFor,
} from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'promptobus.js');
const store = await import(path.join(here, '..', 'lib', 'store.js'));
const { claudeDriver, knockSocket } = await import(path.join(here, '..', 'lib', 'driver-claude.js'));
const { bgSessions, findSession, resetBgSessionsCache, sessionLiveness } = await import(path.join(here, '..', 'lib', 'liftoff.js'));

const SB = makeSandbox('promptobus-harness-');
const HOME = path.join(SB, 'promptobus');
const TASK = 'harness-t20260901-000000';
const ADDR = 'worker:probe';
const NAME = 'Worker: проба harness';
const ORCH_SESSION = 'orch-session-harness';

store.createTask(HOME, { id: TASK, title: 'проба подставного harness', owner: ORCH_SESSION });
store.upsertParticipant(HOME, TASK, store.participantRecord(ADDR, { name: NAME, sessionRef: NAME, harness: 'claude', mode: 'managed',
  started: new Date().toISOString() }));

// The participant config is assembled in the same form spawn writes: a `promptobus`
// entry with its own `env` is the only place the participant learns the address, the
// task and the bus home (spawn.js).
const CFG = path.join(SB, 'mcp.json');
writeFileSync(CFG, JSON.stringify({
  mcpServers: {
    promptobus: {
      type: 'stdio',
      command: process.execPath,
      args: [BIN, 'mcp'],
      env: { PROMPTOBUS_ROLE: ADDR, PROMPTOBUS_TASK: TASK, PROMPTOBUS_HOME: HOME },
    },
  },
}, null, 2));

const sock = makeSockPath('a2h-');
// The harness home is created by the stand itself and outside the sandbox: otherwise
// cleanup on exit is a no-op — the sandbox hook removes the directory before the stand
// has time to kill its processes.
const { home: HARNESS, restore } = await installHarness({ binDir: path.join(SB, 'bin'), sock });
const { run } = await import(path.join(here, '..', 'lib', 'exec.js'));
const claude = (...args) => run('claude', args, { cwd: SB, encoding: 'utf8' });

planParticipant(HARNESS, ADDR, {
  turns: [
    {
      do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'первый ход участника' } }],
      detail: 'status sent; awaiting next cycle',
    },
    {
      do: [
        { tool: 'promptobus_mailbox' },
        { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: 'ответ после стука' } },
      ],
      detail: 'result sent; awaiting next cycle',
    },
  ],
});

// --- lift ---------------------------------------------------------------------

// The number is a literal on purpose: `HARNESS_VERSION` is `PROVEN_CLAUDE_VERSION` under
// the stand name, and checking the constant against itself would check nothing. The
// literal makes a version bump red — that is, it reminds us to re-check the wire form
// and `agents --json`.
const version = claude('--version');
check('the stub claude names the version the format was taken from',
  version.stdout.trim().startsWith('2.1.263'), version.stdout);
const emptyList = claude('agents', '--json');
check('an empty registry prints as an empty array, not a refusal',
  emptyList.stdout.trim() === '[]', emptyList.stdout);

const bg = claude('--bg', '--name', NAME, '--mcp-config', CFG, '--model', 'opus', 'participant prompt');
check('claude --bg reported in the form the mechanism parses the session id from',
  bg.status === 0 && /backgrounded · [0-9a-f]{6,} · /.test(bg.stdout), `${bg.status}: ${bg.stdout}${bg.stderr}`);

resetBgSessionsCache();
const listed = bgSessions();
const record = sessionByName(HARNESS, NAME);
const REQUIRED = ['pid', 'cwd', 'kind', 'startedAt', 'sessionId', 'name', 'id', 'status', 'state'];
check('agents --json prints the lifted one — a bare array and the 2.1.263 form fields',
  Array.isArray(listed) && listed.length === 1 && REQUIRED.every((f) => listed[0][f] !== undefined),
  JSON.stringify(listed));
check('the record is found by the same findSession the mechanism uses, and is judged alive',
  findSession(listed, NAME)?.id === record?.id && sessionLiveness(findSession(listed, NAME), listed) === 'alive',
  JSON.stringify(record));

const wake = await waitFor(() => {
  const w = store.readWake(HOME, TASK, ADDR);
  return w?.socket ? w : null;
}, { timeoutMs: 20000 });
check('the participant handed over a contact point through onJoin of a live MCP server, not by hand into the store',
  !!wake?.socket && !!wake?.token && wake.session === record?.sessionId,
  `${JSON.stringify(wake)} · log: ${readLog(HARNESS, record?.id)}`);

const first = await waitFor(() => {
  const msgs = store.glanceInbox(HOME, TASK, store.ORCHESTRATOR);
  return msgs.length ? msgs : null;
}, { timeoutMs: 20000 });
check('the first participant turn reached the orchestrator by a real send',
  first?.[0]?.sender === store.addrDir(ADDR) && first?.[0]?.body === 'первый ход участника',
  `${JSON.stringify(first)} · trace: ${JSON.stringify(readTrace(HARNESS, ADDR))} · log: ${readLog(HARNESS, record?.id)}`);

// --- end of turn --------------------------------------------------------------

const idle = await waitFor(() => {
  const s = sessionByName(HARNESS, NAME);
  return s?.status === 'idle' ? s : null;
}, { timeoutMs: 20000 });
check('end of turn is marked in the registry the way the harness marks it: idle + done',
  idle?.status === 'idle' && idle?.state === 'done', JSON.stringify(idle));
const stateFile = path.join(claudeConfigDir(HARNESS), 'jobs', String(record?.id), 'state.json');
check('the stall reason sits in jobs/<id>/state.json — where the driver reads it',
  JSON.parse(readFileSync(stateFile, 'utf8')).detail === 'status sent; awaiting next cycle', stateFile);

resetBgSessionsCache();
const view = claudeDriver.inspect(NAME);
check('the driver sees the participant alive, free, and with its own stall reason',
  view?.state === 'alive' && view.busy === false && view.stall?.kind === 'unknown'
  && view.stall?.reason === 'status sent; awaiting next cycle', JSON.stringify(view));

// --- knock --------------------------------------------------------------------

store.sendMessage(HOME, TASK, {
  from: store.ORCHESTRATOR, to: ADDR, type: 'answer', body: 'ответ оркестратора участнику',
});
const knocked = await knockSocket({ socket: wake.socket, token: wake.token }, 'служебный стук пробы');
check('a knock by the real driver knockSocket was accepted by the participant',
  knocked.ok === true, JSON.stringify(knocked));

const answered = await waitFor(() => {
  const hit = store.glanceInbox(HOME, TASK, store.ORCHESTRATOR).find((m) => m.type === 'result');
  return hit ?? null;
}, { timeoutMs: 20000 });
check('on the knock the participant played the next turn and replied',
  answered?.body === 'ответ после стука',
  `${JSON.stringify(answered)} · log: ${readLog(HARNESS, record?.id)}`);

const trace = readTrace(HARNESS, ADDR);
const knock = trace.find((e) => e.kind === 'knock');
check('the wire reached the participant whole: auth on the first line, the token matches, the body is from the warden',
  knock?.lines === 2 && knock.auth === true && knock.tokenOk === true
  && knock.msgV === 1 && knock.from === 'promptobus-warden' && knock.body === 'служебный стук пробы',
  JSON.stringify(knock));
const box = trace.find((e) => e.kind === 'mailbox');
check('the participant fetched the mailbox with the real tool and saw the orchestrator reply there',
  typeof box?.text === 'string' && box.text.includes('ответ оркестратора участнику'), JSON.stringify(box));
check('the protocol channel wrote no unreadable lines',
  !trace.some((e) => e.kind === 'stray'), JSON.stringify(trace.filter((e) => e.kind === 'stray')));

// --- teardown -----------------------------------------------------------------

const stopped = await claudeDriver.stop(NAME);
check('the driver stopped the session through claude stop and said so',
  stopped.ok === true && stopped.stopped === true, JSON.stringify(stopped));
// Judge by the pid taken BEFORE stop: the stub `claude stop` drops the record, and a
// verdict from registry lines would be green by construction — a broken teardown would
// stay invisible (review note). A short wait is needed: `stop` itself waits for the
// process to die, but the system does not free it in the same millisecond.
const dead = await waitFor(() => !pidAlive(record.pid), { timeoutMs: 5000 });
check('after stop the participant process is gone, and the record left the registry',
  dead === true && listSessions(HARNESS).length === 0,
  `pid ${record?.pid} alive: ${pidAlive(record?.pid)} · ${JSON.stringify(listSessions(HARNESS))}`);
const idempotent = await claudeDriver.stop(NAME);
check('a second stop is an outcome with its own words, not a refusal',
  idempotent.ok === true && idempotent.stopped === false, JSON.stringify(idempotent));

// --- diagnosis from the trace -------------------------------------------------

// Scenario errors do not stop the participant, and E2E goes red on later steps: the
// diagnosis must name them first, not leave them at the start of a tail-trimmed trace.
const PROBE = 'worker:probe';
const probeTrace = [
  { kind: 'up' }, { kind: 'turn', no: 0 }, { kind: 'unknown-action', action: { tool: 'send' } },
  { kind: 'mailbox' }, { kind: 'turn', no: 1 }, { kind: 'action-failed', action: { tool: 'promptobus_send' }, error: 'boom' },
  { kind: 'send' }, { kind: 'turn', no: 2 }, { kind: 'mailbox' }, { kind: 'stopped', code: 0 },
];
mkdirSync(path.dirname(traceFile(HARNESS, PROBE)), { recursive: true });
writeFileSync(traceFile(HARNESS, PROBE), probeTrace.map((e) => JSON.stringify(e)).join('\n') + '\n');
const errs = authorErrors(readTrace(HARNESS, PROBE));
check(': scenario errors are taken from the whole trace and in order',
  errs.length === 2 && errs[0].kind === 'unknown-action' && errs[1].kind === 'action-failed', JSON.stringify(errs));
const diag = diagnoseTrace(HARNESS, PROBE);
check(': the diagnosis names scenario errors first, before the trace tail',
  diag.startsWith(`scenario errors for ${PROBE}`) && diag.indexOf('unknown-action') < diag.indexOf('trace for '), diag.slice(0, 160));
check(': the trace tail stayed in the diagnosis — the last six records',
  diag.endsWith(JSON.stringify(probeTrace.slice(-6))), diag.slice(-120));
writeFileSync(traceFile(HARNESS, PROBE), probeTrace.filter((e) => !['unknown-action', 'action-failed'].includes(e.kind))
  .map((e) => JSON.stringify(e)).join('\n') + '\n');
check(': without scenario errors the diagnosis starts with the trace — no prefix',
  diagnoseTrace(HARNESS, PROBE).startsWith(`trace for ${PROBE}`), diagnoseTrace(HARNESS, PROBE).slice(0, 80));

await stopAll(HARNESS);
restore();
