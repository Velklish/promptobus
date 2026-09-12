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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import { capture, expectFail } from './console.mjs';

const SB = makeSandbox('promptobus-stop-');
const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(SB, '.promptobus');

const store = await import(path.join(here, '..', 'lib', 'store.js'));
const bus = await import(path.join(here, '..', 'dist', 'index.js'));
const { stop } = await import(path.join(here, '..', 'lib', 'stop.js'));
const { createStandaloneHost } = await import(path.join(here, '..', 'dist', 'host-index.js'));

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
