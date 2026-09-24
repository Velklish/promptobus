// `promptobus stop <address>` — one participant's session, the task left open. Run: npm test
//
// Subject: the door PB-174 asks for, and the three things that make it a door rather than a
// narrower `done`. The task must survive it; the OTHER participants must survive it; and the
// session record must not outlive the process, because a record reading `alive` after a hand
// `kill` is the defect this command exists to end.
//
// The stand-in driver counts who was asked to stop and reports what its own registry would say
// afterwards, so "the record is retired" is read off the driver's contract rather than off a
// live harness. Which is where it belongs: `stop` does not retire the record itself — the
// driver's own `stop` does, and the command's job is to call it instead of a person's `kill`.
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, stubCommand } from './sandbox.mjs';
import { capture, expectFail } from './console.mjs';

const SB = makeSandbox('promptobus-stop-');
const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(SB, '.promptobus');

const store = await import(path.join(here, '..', 'lib', 'store.js'));
const bus = await import(path.join(here, '..', 'dist', 'index.js'));
const { stop } = await import(path.join(here, '..', 'lib', 'stop.js'));
const { createStandaloneHost } = await import(path.join(here, '..', 'dist', 'host-index.js'));

// The owner gate is a positive proof, and the suite strips harness identity from the
// environment: a file that cannot name its caller would only ever see the refusal.
process.env.CLAUDE_CODE_SESSION_ID = 'sess-stop-stand';

const HOST = createStandaloneHost({ cwd: SB, commandName: 'promptobus', home: HOME });

// Sessions the stand-in calls alive, and the records it has retired. A `stop` removes the ref
// from `live` — the same move the real drivers make with `dropSession`.
const live = new Set();
function fakeRegistry(reply = () => ({ ok: true, stopped: true, note: 'closed' })) {
  const calls = [];
  const driver = {
    id: 'claude',
    capabilities: {
      spawn: true, attach: false, activation: 'push', inspect: true, stop: true,
      denyTools: true, systemPrompt: true, sessionList: true, enter: true,
    },
    phrases: {
      sessions: 'claude agents', unreadable: 'unreadable', enter: (id) => `enter ${id}`,
      stop: (id) => `stop ${id}`, logs: (id) => `logs ${id}`,
    },
    inspect: (ref) => (live.has(ref)
      ? { state: 'alive', busy: false, stall: null, id: ref, note: 'idle' }
      : { state: 'gone', busy: false, stall: null, id: null, note: null }),
    stop: (ref) => {
      calls.push(ref);
      const r = reply(ref);
      if (r.ok && r.stopped) live.delete(ref);
      return r;
    },
  };
  return { registry: bus.createRegistry({ drivers: { claude: driver }, fallback: 'claude' }), calls };
}

const TASK = 'stop-t20260912-020000';
const OTHER = 'stop-t20260912-020001';
const reset = () => {
  live.clear();
  ['sess-a', 'sess-b'].forEach((r) => live.add(r));
};
store.createTask(HOME, { id: TASK, title: 'одного участника гасим, задача живёт', owner: null });
store.upsertParticipant(HOME, TASK, store.participantRecord('worker:a', { harness: 'claude', mode: 'managed', sessionRef: 'sess-a' }));
store.upsertParticipant(HOME, TASK, store.participantRecord('worker:b', { harness: 'claude', mode: 'managed', sessionRef: 'sess-b' }));
store.upsertParticipant(HOME, TASK, store.participantRecord('worker:own', { harness: 'claude', mode: 'attached', sessionRef: 'sess-own' }));
store.createTask(HOME, { id: OTHER, title: 'соседняя задача', owner: null });
store.upsertParticipant(HOME, OTHER, store.participantRecord('worker:elsewhere', { harness: 'claude', mode: 'managed', sessionRef: 'sess-elsewhere' }));

// --- the negative controls, before the positive one --------------------------
//
// Both halves are asserted for each: the exit code AND that nothing changed. A refusal that
// returns 1 after doing the work is not a refusal.

reset();
const foreign = fakeRegistry();
const outForeign = await expectFail(async () => stop(HOST, { task: TASK, address: 'worker:elsewhere' }, { registry: foreign.registry }));
check(': an address of ANOTHER task is refused — it is not a participant of this one',
  outForeign.failed && /has no participant "worker:elsewhere"/.test(outForeign.out),
  outForeign.out.trim());
check(': and the refusal stopped nothing — no driver call was made',
  foreign.calls.length === 0, foreign.calls.join(', '));

const unknown = fakeRegistry();
const outUnknown = await expectFail(async () => stop(HOST, { task: TASK, address: 'worker:nobody' }, { registry: unknown.registry }));
check(': an address of no task at all is refused, and the line names who IS in the task',
  outUnknown.failed && /worker:a/.test(outUnknown.out), outUnknown.out.trim());
check(': and it too stopped nothing', unknown.calls.length === 0, unknown.calls.join(', '));

const orch = fakeRegistry();
const outOrch = await expectFail(async () => stop(HOST, { task: TASK, address: 'orchestrator' }, { registry: orch.registry }));
check(': the orchestrator is refused — it has no session this mechanism started',
  outOrch.failed && orch.calls.length === 0, outOrch.out.trim());

const attached = fakeRegistry();
const outAttached = await expectFail(async () => stop(HOST, { task: TASK, address: 'worker:own' }, { registry: attached.registry }));
check(': an attached participant is refused — the mechanism did not start that session',
  outAttached.failed && attached.calls.length === 0 && /not ours to close/.test(outAttached.out),
  outAttached.out.trim());

// --- the door itself ---------------------------------------------------------

reset();
const one = fakeRegistry();
const outOne = await capture(async () => stop(HOST, { task: TASK, address: 'worker:a' }, { registry: one.registry }));
check(': the named participant is stopped, and only it',
  one.calls.length === 1 && one.calls[0] === 'sess-a', one.calls.join(', '));
check(': the OTHER participant is untouched — this is what makes it a door and not a narrower done',
  live.has('sess-b'), [...live].join(', '));
check(': the record of the stopped one is retired with the process, not left reading alive',
  !live.has('sess-a'), [...live].join(', '));
// Not a count: a count passes while the record holds the wrong people. The neighbour is named.
const after = store.readTask(HOME, TASK);
check(': the task stays active — the record is readable and the other participant is still in it',
  !!store.participantOf(after, 'worker:b') && !!store.participantOf(after, 'worker:a')
  && after.status !== 'done',
  JSON.stringify({ status: after.status, addresses: (after.participants ?? []).map((x) => x.address) }));
check(': the line says the task stays open, so a person does not read this as a done',
  /stays active/.test(outOne), outOne.trim());
check(': and it says the watch is a separate thing — dismiss is named, not implied',
  /dismiss/.test(outOne), outOne.trim());

// The watch is genuinely untouched: `stop` must not do `dismiss`'s work behind its back.
check(': the participant is still watched after its session was stopped',
  !store.participantOf(store.readTask(HOME, TASK), 'worker:a')?.dismissedAt,
  JSON.stringify(store.participantOf(store.readTask(HOME, TASK), 'worker:a')));

// --- what the command does when there is nothing to stop ---------------------

const twice = fakeRegistry();
const outTwice = await capture(async () => stop(HOST, { task: TASK, address: 'worker:a' }, { registry: twice.registry }));
check(': a second stop is not an error — the session is already gone and the task is still open',
  twice.calls.length === 0 && /nothing to stop/.test(outTwice), outTwice.trim());

// --- a driver that refuses ---------------------------------------------------

reset();
const refusing = fakeRegistry(() => ({ ok: false, stopped: false, note: 'claude stop exited with code 1' }));
const outRefused = await expectFail(async () => stop(HOST, { task: TASK, address: 'worker:a' }, { registry: refusing.registry }));
check(': a driver refusal is a refusal, and names the harness registry to look in',
  outRefused.failed && /claude agents/.test(outRefused.out), outRefused.out.trim());
check(': and the session is left alone rather than reported closed', live.has('sess-a'), [...live].join(', '));

reset();
const unconfirmed = fakeRegistry(() => ({ ok: true, stopped: false, attempted: true, note: 'the record did not leave the registry' }));
let unconfirmedCode = null;
const outUnconfirmed = await capture(async () => { unconfirmedCode = await stop(HOST, { task: TASK, address: 'worker:a' }, { registry: unconfirmed.registry }); });
check(': an unconfirmed stop is not reported as success — the record may still read alive',
  unconfirmedCode === 1 && /not confirmed/.test(outUnconfirmed), outUnconfirmed.trim());

// --- PB-231: the approver of an accepted piece closes its session ------------
//
// Every task above records no owner, so the gate lets a session that names itself through
// and the approver branch is never reached. This one has an owner, and the caller is not it:
// what admits the call is the approver record holding the calling session, and nothing else.

reset();
const GATED = 'stop-t20260917-100500';
store.createTask(HOME, { id: GATED, title: 'приёмщик гасит участника своего куска', owner: 'sess-stop-hozyain' });
store.upsertParticipant(HOME, GATED, store.participantRecord('worker:c', { harness: 'claude', mode: 'managed', sessionRef: 'sess-c' }));
store.upsertParticipant(HOME, GATED, store.participantRecord('approver:c', {
  harness: 'claude', mode: 'managed', sessionRef: 'sess-approver-ref', sessionId: 'sess-stop-stand',
}));

live.add('sess-c');
const strangerEnv = process.env.CLAUDE_CODE_SESSION_ID;
process.env.CLAUDE_CODE_SESSION_ID = 'sess-stop-gost';
const byStranger = fakeRegistry();
const outStranger = await expectFail(async () => stop(HOST, { task: GATED, address: 'worker:c' }, { registry: byStranger.registry }));
process.env.CLAUDE_CODE_SESSION_ID = strangerEnv;
check(': a stranger is refused on an owned task, and the session is left running',
  outStranger.failed && byStranger.calls.length === 0 && live.has('sess-c'), outStranger.out.trim());
check(': and the refusal names which approver proof failed — the session is not the one on record',
  /is on record under sess-stop-stand/.test(outStranger.out) && /sess-stop-gost/.test(outStranger.out),
  outStranger.out.trim());

const byApprover = fakeRegistry();
const outApprover = await capture(async () => stop(HOST, { task: GATED, address: 'worker:c' }, { registry: byApprover.registry }));
check(': an approver of this task stops the session of the piece it accepted, though the owner is another session',
  byApprover.calls.length === 1 && byApprover.calls[0] === 'sess-c' && !live.has('sess-c'), outApprover.trim());
check(': and the task it cleaned up after is still open',
  store.readTask(HOME, GATED).status === 'active', store.readTask(HOME, GATED).status);

// --- the harness binary is off this process's PATH ------------------------------
// The real Claude driver behind a `claude` only the host names; one process per host.
const OFFPATH = 'stop-offpath-t20260924-090000';
store.createTask(HOME, { id: OFFPATH, title: 'claude вне PATH поднятой сессии', owner: null });
store.upsertParticipant(HOME, OFFPATH, store.participantRecord('worker:offpath', {
  harness: 'claude', mode: 'managed', sessionRef: 'sess-offpath',
}));

const CLAUDE_CALLS = path.join(SB, 'claude-calls.log');
const STOPPED = path.join(SB, 'claude-stopped');
const HIDDEN = path.join(SB, 'hidden-bin');
stubCommand(HIDDEN, 'claude', `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const [cmd, arg] = process.argv.slice(2);
appendFileSync(${JSON.stringify(CLAUDE_CALLS)}, process.argv.slice(2).join(' ') + '\\n');
const live = [{ name: 'sess-offpath', id: 'off-1', pid: 4242, status: 'idle' }];
if (cmd === 'agents') process.stdout.write(JSON.stringify(existsSync(${JSON.stringify(STOPPED)}) ? [] : live));
else if (cmd === 'stop' && arg === 'off-1') writeFileSync(${JSON.stringify(STOPPED)}, '');
else process.exit(2);`);
const GARBLED = path.join(SB, 'garbled-bin');
stubCommand(GARBLED, 'claude', "process.stdout.write('not a list');");
const calls = () => (existsSync(CLAUDE_CALLS) ? readFileSync(CLAUDE_CALLS, 'utf8') : '');

const moduleUrl = (...at) => JSON.stringify(pathToFileURL(path.join(here, '..', ...at)).href);
function stopWithHost(said) {
  const script = `
    const { createStandaloneHost } = await import(${moduleUrl('dist', 'host-index.js')});
    const { stop } = await import(${moduleUrl('lib', 'stop.js')});
    const said = JSON.parse(process.env.STAND_TOOL_BIN);
    const base = createStandaloneHost({ cwd: ${JSON.stringify(SB)}, commandName: 'promptobus', home: ${JSON.stringify(HOME)} });
    const host = said ? { ...base, resolveToolBin: () => said } : base;
    process.exitCode = await stop(host, { task: ${JSON.stringify(OFFPATH)}, address: 'worker:offpath' });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...process.env, STAND_TOOL_BIN: JSON.stringify(said) },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const notFound = stopWithHost({ ok: false, reason: 'claude (Claude Code): not found in PATH or in ~/.local/bin' });
check('PB-239: a binary the host cannot find is a refusal naming it and where it looked — not "nothing to stop", not exit 0',
  notFound.code === 1 && /the harness binary was not found: claude \(Claude Code\): not found in PATH or in ~\/\.local\/bin/.test(notFound.out)
  && !/nothing to stop/.test(notFound.out), notFound.out.trim());
check(': and the line says nothing was stopped and the session may still run', /Nothing was stopped/.test(notFound.out),
  notFound.out.trim());

const bare = stopWithHost(null);
check(': a host that names the bare binary gets the PATH it was looked for on, named, and exit 1',
  bare.code === 1 && /looked for claude on this process's PATH/.test(bare.out) && !/nothing to stop/.test(bare.out),
  bare.out.trim());

const garbled = stopWithHost({ ok: true, bin: path.join(GARBLED, 'claude') });
check(': an unreadable registry is its own refusal — not a missing binary and not an empty one',
  garbled.code === 1 && /its harness registry could not be read: claude agents --json is unreadable/.test(garbled.out)
  && !/was not found/.test(garbled.out) && !/nothing to stop/.test(garbled.out), garbled.out.trim());

const lifted = stopWithHost({ ok: true, bin: path.join(HIDDEN, 'claude') });
check(': the stop finds claude where the host says — the lift\'s door — and closes the live session',
  lifted.code === 0 && /session of participant worker:offpath closed/.test(lifted.out) && existsSync(STOPPED),
  lifted.out.trim());
check(': through the host\'s binary: it listed the session and ran claude stop on its id',
  /^agents --json$/m.test(calls()) && /^stop off-1$/m.test(calls()), calls());
