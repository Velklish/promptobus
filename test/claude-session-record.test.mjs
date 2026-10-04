// The Claude Code session record a lift bound before launch: the pointer its bus entry carries,
// the handshake that binds the session's own id once, and the persist that checks it. Run: npm test
import { check } from './check.mjs';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { captureSplit, expectFail } from './console.mjs';
import { makeSandbox, stubCommand, writeHostConfig } from './sandbox.mjs';
import * as store from '../lib/store.js';
import { hostOf } from '../lib/host.js';
import { status } from '../lib/status.js';
import { writeLaunchFiles } from '../lib/spawn.js';
import { serve } from '../lib/server.js';
import { bindBeforeLaunch, liftoffParticipant } from '../lib/liftoff.js';
import {
  bindHandshake, claudeDriver, registerWake, SESSION_RECORD_VAR,
} from '../lib/driver-claude.js';

const SB = makeSandbox('promptobus-test-session-record-');
const WS = path.join(SB, 'ws');
writeHostConfig(WS);
writeFileSync(path.join(WS, 'AGENTS.md'), 'sandbox\n');
const host = hostOf(WS);
const HOME = host.promptobusHome();
const TASK = 'record-t20261004-130000';
const OTHER = 'other-t20261004-130001';
const ADDR = 'worker:api';
store.createTask(HOME, { id: TASK, title: 'session record', owner: 'orch-session' });
store.createTask(HOME, { id: OTHER, title: 'another task', owner: 'orch-session' });

// --- the lift's plan ----------------------------------------------------------

const bus = { type: 'stdio', command: 'node', args: ['promptobus', 'mcp'], env: { PROMPTOBUS_ROLE: ADDR, PROMPTOBUS_TASK: TASK, PROMPTOBUS_HOME: HOME } };
const planFor = (role, mcp) => claudeDriver.prepare({
  ref: 'Worker: api', role, mcp, prompt: 'work', model: 'opus',
  mcpConfigPath: store.participantMcpPath(HOME, TASK, ADDR),
  settingsPath: store.participantSettingsPath(HOME, TASK, ADDR),
  guardCommand: 'promptobus guard',
});
const POINTER = store.participantSessionPath(HOME, TASK, ADDR);
const worker = planFor('worker', { home: HOME, task: TASK, address: ADDR, servers: { promptobus: bus } });
const recordFile = worker.files.find((f) => f.path === POINTER);
check('a lift that binds before launch writes a session record beside its mcp-config, bound to nobody',
  path.dirname(POINTER) === path.dirname(store.participantMcpPath(HOME, TASK, ADDR))
  && recordFile?.secret === true
  && JSON.stringify(JSON.parse(recordFile.text)) === JSON.stringify({ home: HOME, task: TASK, address: ADDR, sessionId: null }),
  JSON.stringify(worker.files.map((f) => f.path)));
check('its bus entry and its prelaunch binding both name that record',
  worker.mcpConfig.mcpServers.promptobus.env[SESSION_RECORD_VAR] === POINTER
  && worker.prelaunchBinding.sessionRecord === POINTER && !!worker.prelaunchBinding.sessionId,
  JSON.stringify({ env: worker.mcpConfig.mcpServers.promptobus.env, binding: worker.prelaunchBinding }));
const teamlead = planFor('teamlead', { home: HOME, task: TASK, address: 'orchestrator', servers: { promptobus: bus } });
check('a teamlead lift gets no pointer: its ownership moves with the rebind after launch',
  !teamlead.files.some((f) => f.path.endsWith('.session.json'))
  && teamlead.mcpConfig.mcpServers.promptobus.env[SESSION_RECORD_VAR] === undefined
  && teamlead.prelaunchBinding.sessionRecord === undefined, JSON.stringify(teamlead.prelaunchBinding));
writeLaunchFiles(worker.files);
check('the session record is written with mode 0600, as the mcp-config is',
  (statSync(POINTER).mode & 0o777) === 0o600, (statSync(POINTER).mode & 0o777).toString(8));

// --- the handshake ------------------------------------------------------------

const CHOSEN = worker.prelaunchBinding.sessionId;
const OWN = 'a1b2c3d4-0000-4000-8000-000000000001';
const LATER = 'a1b2c3d4-0000-4000-8000-000000000002';
const SOCK = path.join(SB, 'own.sock');
store.upsertParticipant(HOME, TASK, store.participantRecord(ADDR, {
  harness: 'claude', name: 'Worker: api', sessionRef: 'Worker: api', ...worker.prelaunchBinding,
}));
const recordNow = () => JSON.parse(readFileSync(POINTER, 'utf8'));
const boundId = () => store.participantOf(store.readTask(HOME, TASK), ADDR)?.metadata?.sessionId;
const envOf = (session, pointer = POINTER) => ({
  CLAUDE_CODE_SESSION_ID: session, CLAUDE_CODE_MESSAGING_SOCKET: SOCK, [SESSION_RECORD_VAR]: pointer,
});

const strayTask = path.join(SB, 'stray-task.session.json');
writeFileSync(strayTask, JSON.stringify({ home: HOME, task: OTHER, address: ADDR, sessionId: null }));
const strayAddr = path.join(SB, 'stray-addr.session.json');
writeFileSync(strayAddr, JSON.stringify({ home: HOME, task: TASK, address: 'worker:web', sessionId: null }));
const unnamed = path.join(SB, 'unnamed.session.json');
writeFileSync(unnamed, JSON.stringify({ home: HOME, task: TASK, address: ADDR, sessionId: null }));
check('a pointer naming another task binds nothing, and the gate still refuses the handover',
  bindHandshake(HOME, TASK, ADDR, envOf(OWN, strayTask)) === null && boundId() === CHOSEN
  && registerWake(HOME, TASK, ADDR, envOf(OWN, strayTask)) === false && store.readWake(HOME, TASK, ADDR) === null,
  JSON.stringify({ bound: boundId() }));
check('a pointer naming another address binds nothing',
  bindHandshake(HOME, TASK, ADDR, envOf(OWN, strayAddr)) === null && boundId() === CHOSEN,
  JSON.stringify({ bound: boundId() }));
check('a pointer the participant record does not name binds nothing',
  bindHandshake(HOME, TASK, ADDR, envOf(OWN, unnamed)) === null && boundId() === CHOSEN
  && JSON.parse(readFileSync(unnamed, 'utf8')).sessionId === null, JSON.stringify({ bound: boundId() }));
check('the proven pointer binds the session\'s own id into the session record and the participant record',
  bindHandshake(HOME, TASK, ADDR, envOf(OWN)) === 'bound' && recordNow().sessionId === OWN && boundId() === OWN,
  JSON.stringify({ record: recordNow(), bound: boundId() }));
const handed = registerWake(HOME, TASK, ADDR, envOf(OWN));
check('and the unchanged gate then hands the contact point over at that same handshake',
  handed?.session === OWN && store.readWake(HOME, TASK, ADDR)?.socket === SOCK, JSON.stringify(handed));
check('the same session handshaking again stays bound and is not refused',
  bindHandshake(HOME, TASK, ADDR, envOf(OWN)) === 'bound' && recordNow().refused === undefined,
  JSON.stringify(recordNow()));
check('a later handshake with another id is refused, kept in the session record, and binds nothing',
  bindHandshake(HOME, TASK, ADDR, envOf(LATER)) === 'refused' && boundId() === OWN
  && recordNow().refused?.length === 1 && recordNow().refused[0].session === LATER
  && registerWake(HOME, TASK, ADDR, envOf(LATER)) === false && store.readWake(HOME, TASK, ADDR)?.session === OWN,
  JSON.stringify(recordNow()));
const printed = captureSplit(() => status(host, { task: TASK, sessions: [] }));
check('status prints the refused handshake on the participant\'s line',
  printed.out.includes(`HANDSHAKE REFUSED: session ${LATER}`) && printed.out.includes(`bound to ${OWN}`), printed.out);
check('registerWake keeps null for nothing to hand over, apart from a refusal',
  registerWake(HOME, TASK, ADDR, { CLAUDE_CODE_SESSION_ID: OWN }) === null);

// --- the bus entry's join, end to end -----------------------------------------

const RETRY = 'worker:retry';
const LATE = 'a1b2c3d4-0000-4000-8000-000000000003';
store.upsertParticipant(HOME, TASK, store.participantRecord(RETRY, {
  harness: 'claude', name: 'Worker: retry', sessionRef: 'Worker: retry', sessionId: CHOSEN,
}));
// The driver reads the harness variables from the process, as a real bus entry's own environment.
Object.assign(process.env, { CLAUDE_CODE_SESSION_ID: LATE, CLAUDE_CODE_MESSAGING_SOCKET: SOCK });
const input = new PassThrough();
const replies = [];
const served = serve({
  host, cwd: WS, input, output: { write: (line) => { replies.push(JSON.parse(line)); } },
  env: { ...process.env, PROMPTOBUS_ROLE: RETRY, PROMPTOBUS_TASK: TASK, PROMPTOBUS_HOME: HOME },
});
const ask = async (id, method, params) => {
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  for (let i = 0; i < 200 && !replies.some((r) => r.id === id); i += 1) await new Promise((r) => { setTimeout(r, 10); });
};
await ask(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
check('a handshake the binding gate refuses hands nothing over', store.readWake(HOME, TASK, RETRY) === null,
  JSON.stringify(store.readWake(HOME, TASK, RETRY)));
const retryRecord = store.participantOf(store.readTask(HOME, TASK), RETRY);
store.upsertParticipant(HOME, TASK, { ...retryRecord, metadata: { ...retryRecord.metadata, sessionId: LATE } });
await ask(2, 'tools/call', { name: 'promptobus_task', arguments: {} });
check('once the record names the session, its next tool call hands the contact point over',
  store.readWake(HOME, TASK, RETRY)?.session === LATE, JSON.stringify(store.readWake(HOME, TASK, RETRY)));
input.end();
await served;

// A handover that throws once — here the wake directory is a file — is asked again, not marked entered.
const FLAKY_TASK = 'flaky-t20261004-130002';
const FLAKY = 'worker:flaky';
store.createTask(HOME, { id: FLAKY_TASK, title: 'a handover that throws once', owner: 'orch-session' });
store.upsertParticipant(HOME, FLAKY_TASK, store.participantRecord(FLAKY, {
  harness: 'claude', name: 'Worker: flaky', sessionRef: 'Worker: flaky', sessionId: LATE,
}));
const wakeDir = path.dirname(store.wakeFile(HOME, FLAKY_TASK, FLAKY));
writeFileSync(wakeDir, 'not a directory\n');
const flakyInput = new PassThrough();
const flakyReplies = [];
const flakyServed = serve({
  host, cwd: WS, input: flakyInput, output: { write: (line) => { flakyReplies.push(JSON.parse(line)); } },
  env: { ...process.env, PROMPTOBUS_ROLE: FLAKY, PROMPTOBUS_TASK: FLAKY_TASK, PROMPTOBUS_HOME: HOME },
});
const askFlaky = async (id, method, params) => {
  flakyInput.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  for (let i = 0; i < 200 && !flakyReplies.some((r) => r.id === id); i += 1) await new Promise((r) => { setTimeout(r, 10); });
};
await askFlaky(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
rmSync(wakeDir, { force: true });
await askFlaky(2, 'tools/call', { name: 'promptobus_task', arguments: {} });
check('a handshake whose contact-point write throws is asked again on the next tool call, and hands over',
  store.readWake(HOME, FLAKY_TASK, FLAKY)?.session === LATE, JSON.stringify(store.readWake(HOME, FLAKY_TASK, FLAKY)));
flakyInput.end();
await flakyServed;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;

// --- status of a fresh lift ---------------------------------------------------

const FRESH = 'worker:fresh';
store.upsertParticipant(HOME, TASK, store.participantRecord(FRESH, {
  harness: 'claude', name: 'Worker: fresh', sessionRef: 'Worker: fresh', sessionId: CHOSEN,
  started: new Date().toISOString(),
}));
const lineOf = (addr) => captureSplit(() => status(host, { task: TASK, sessions: [] })).out.split('\n')
  .find((l) => l.includes(addr)) ?? '';
store.writeHealth(HOME, TASK, { ...store.readHealth(HOME, TASK), [FRESH]: { channel: 'socket', knocks: 4 } });
const freshLine = lineOf(FRESH);
check('status calls a fresh lift with no contact point and no recorded refusal awaiting its handover',
  freshLine.includes('alarm: awaiting the handover of the session lifted') && !freshLine.includes('self-wake'), freshLine);
store.writeHealth(HOME, TASK, {
  ...store.readHealth(HOME, TASK),
  [FRESH]: { channel: 'self-wake', selfWake: 'taken', knockError: `contact point is held by session ${LATER}` },
});
const refusedLine = lineOf(FRESH);
check('inside the spawn grace a recorded self-wake refusal still prints its reason',
  refusedLine.includes(`alarm: self-wake (reason: contact point is held by session ${LATER})`)
  && !refusedLine.includes('awaiting the handover'), refusedLine);

// --- the stale contact point at a lift that binds before launch ---------------

const OLD = 'worker:old';
store.upsertParticipant(HOME, TASK, store.participantRecord(OLD, { harness: 'cursor', name: 'Worker: old', sessionRef: 'Worker: old' }));
store.writeWake(HOME, TASK, OLD, { socket: path.join(SB, 'old.sock'), session: LATER });
const undoPointer = bindBeforeLaunch(HOME, TASK, OLD, { sessionRecord: path.join(SB, 'cursor-old.json') });
undoPointer();
check('a lift bound by a session-record pointer alone (Codex, Cursor) keeps the old point, also when it fails',
  store.readWake(HOME, TASK, OLD)?.session === LATER, JSON.stringify(store.readWake(HOME, TASK, OLD)));
const undoChosen = bindBeforeLaunch(HOME, TASK, OLD, { sessionId: CHOSEN });
check('a lift bound to a chosen session id drops the point another session holds',
  store.readWake(HOME, TASK, OLD) === null, JSON.stringify(store.readWake(HOME, TASK, OLD)));
undoChosen();

// --- the post-launch persist --------------------------------------------------

const BIN = path.join(SB, 'bin');
const DRIVER = fileURLToPath(new URL('../lib/driver-claude.js', import.meta.url));
const lift = async ({ named, handshake }) => {
  const addr = `worker:p${Math.random().toString(16).slice(2, 8)}`;
  const pointer = store.participantSessionPath(HOME, TASK, addr);
  mkdirSync(path.dirname(pointer), { recursive: true });
  writeFileSync(pointer, JSON.stringify({ home: HOME, task: TASK, address: addr, sessionId: null }));
  store.upsertParticipant(HOME, TASK, store.participantRecord(addr, { harness: 'claude', name: addr, sessionRef: addr }));
  // The stub's session shakes hands through the real door before the persist reads the record.
  stubCommand(BIN, 'claude', `import { bindHandshake } from ${JSON.stringify(DRIVER)};
bindHandshake(${JSON.stringify(HOME)}, ${JSON.stringify(TASK)}, ${JSON.stringify(addr)}, { ${SESSION_RECORD_VAR}: ${JSON.stringify(pointer)}, CLAUDE_CODE_SESSION_ID: ${JSON.stringify(handshake)} });
process.stdout.write('backgrounded · ${(named ?? handshake).slice(0, 8)} · ${addr}\\n');`);
  const persisted = [];
  const ran = await expectFail(() => liftoffParticipant({
    tool: { bin: path.join(BIN, 'claude') }, argv: ['--bg'], cwd: SB, env: process.env, name: addr, role: 'worker',
    home: HOME, task: TASK, address: addr, preboundSessionId: CHOSEN, preboundSessionRecord: pointer,
    persist: (id, state, full) => persisted.push({ id, state, full }),
    awaitOptions: { tries: 1, delayMs: 0, sessions: () => [{ name: addr, id: (named ?? handshake).slice(0, 8), pid: process.pid, ...(named ? { sessionId: named } : {}) }] },
  }));
  return { ...ran, persisted, record: store.participantOf(store.readTask(HOME, TASK), addr)?.metadata };
};
const agree = await lift({ named: OWN, handshake: OWN });
check('the persist confirms a handshake binding the harness names too',
  !agree.failed && agree.persisted.length === 1 && agree.persisted[0].full === OWN, JSON.stringify(agree));
const silent = await lift({ named: null, handshake: OWN });
check('a harness that names no id leaves the handshake binding standing, not the chosen UUID',
  !silent.failed && silent.persisted.length === 1 && silent.persisted[0].full === OWN, JSON.stringify(silent));
const clash = await lift({ named: LATER, handshake: OWN });
check('a harness id that contradicts the handshake binding fails the lift with both ids named',
  clash.failed && clash.persisted.length === 0 && clash.out.includes(LATER) && clash.out.includes(OWN),
  JSON.stringify(clash));
check('and the refused lift clears its binding: the record keeps neither the handshake id nor the session record',
  clash.failed && clash.record?.sessionId === undefined && clash.record?.sessionRecord === undefined,
  JSON.stringify(clash.record));
