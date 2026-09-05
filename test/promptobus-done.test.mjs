// `promptobus done` stops managed sessions itself. Before this task a person closed
// them by hand, and the cost of delay was double: live sessions piled up on the
// machine, and worktree cleanup after a live session does not run at all — the
// directory would leave from under its `cwd`.
//
// The driver here is a STAND-IN and is passed through the `registry` seam: the
// subject under test is who the walk stops and who it doesn't, not the behavior of
// `claude stop`. The suite does not touch the live binary.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { capture } from './console.mjs';

const SB = makeSandbox('promptobus-promptobus-done-');
const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(SB, '.promptobus');

const store = await import(path.join(here, '..', 'lib', 'store.js'));
const { stopManaged } = await import(path.join(here, '..', 'lib', 'done.js'));
const bus = await import(path.join(here, '..', 'dist', 'index.js'));

// There is no substitution of the binary here at all, and that is the point under
// test (review finding): the walk builds its session snapshot with the SAME
// registry it stops with, so participant liveness is declared by the stand-in
// driver, not by whatever is running on the machine. A half seam would prop
// liveness up with a substituted `claude`, and the stand-in driver's `inspect`
// would stay a dead fixture.
const LIVE = ['sess-worker', 'sess-reviewer', 'sess-attached'];

// The stand-in driver: counts who was asked to stop. `reply` sets the outcome by
// ref; `sessions` is the harness's word for its own registry, which cleanup
// inserts into its own routes
//: it shows that the driver assembled the line, not cleanup itself.
function fakeRegistry(reply = () => ({ ok: true, stopped: true, note: 'closed' }), sessions = 'claude agents') {
  const calls = [];
  const driver = {
    id: 'claude',
    capabilities: {
      spawn: true, attach: false, activation: 'push', inspect: true, stop: true,
      denyTools: true, systemPrompt: true, sessionList: true, enter: true,
    },
    phrases: { sessions, unreadable: 'the registry could not be parsed', enter: (id) => `enter ${id}`, stop: (id) => `stop ${id}`, logs: (id) => `logs ${id}` },
    inspect: (ref) => (LIVE.includes(ref)
      ? { state: 'alive', busy: false, stall: null, id: ref, note: 'idle' }
      : { state: 'gone', busy: false, stall: null, id: null, note: null }),
    stop: (ref) => {
      calls.push(ref);
      return reply(ref);
    },
  };
  return { registry: bus.createRegistry({ drivers: { claude: driver }, fallback: 'claude' }), calls };
}

const TASK = 'done-t20260901-230000';
store.createTask(HOME, { id: TASK, title: 'уборка гасит сессии', owner: null });
// The worker of a former CLI: it has no `mode` field at all, and it is managed — spawn started its session.
store.upsertParticipant(HOME, TASK, store.participantRecord('worker:api', { name: 'sess-worker' }));
// The reviewer of the current one: the fields were set at lift-off.
store.upsertParticipant(HOME, TASK, store.participantRecord('reviewer:api', { harness: 'claude', mode: 'managed', sessionRef: 'sess-reviewer' }));
// One who attached itself: the driver did not start it and has no right to dispose of it.
store.upsertParticipant(HOME, TASK, store.participantRecord('worker:svoy', { harness: 'claude', mode: 'attached', sessionRef: 'sess-attached' }));

const { registry, calls } = fakeRegistry();
const out = await capture(async () => stopManaged(HOME, TASK, { registry }));

check(': managed participants with a live session are stopped, both kinds of record',
  calls.length === 2 && calls.includes('sess-worker') && calls.includes('sess-reviewer'),
  calls.join(', '));
check(': a record of the former CLI without a mode field counts as managed — spawn started its session',
  calls.includes('sess-worker'), calls.join(', '));
check(': attached is not stopped — the driver did not start this session',
  !calls.includes('sess-attached'), calls.join(', '));
check(': the task owner is not stopped — there is no session behind it at all',
  !calls.some((c) => c === null || c === 'orchestrator'), calls.join(', '));
check(': closed ones are named out loud — the line shows what no longer remains on the machine',
  /worker:api/.test(out) && /reviewer:api/.test(out), out.trim());

// A refusal of one participant does not interrupt the walk: cleanup runs AFTER the
// task is closed, and a throw from here would take the rest down with it — the same trouble as in .
const failing = fakeRegistry((ref) => (ref === 'sess-worker'
  ? { ok: false, stopped: false, note: 'claude stop w1 exited with code 1' }
  : { ok: true, stopped: true, note: 'closed' }));
const outTwo = await capture(async () => stopManaged(HOME, TASK, { registry: failing.registry }));
check(': a refusal of one does not interrupt the walk — the second was stopped anyway',
  failing.calls.length === 2 && failing.calls.includes('sess-reviewer'), failing.calls.join(', '));
check(': a refusal is named out loud and with a route — otherwise the worktree stays silent',
  /could not close/.test(outTwo) && /claude agents/.test(outTwo), outTwo.trim());
// : the word about the session registry in the route comes from the driver, not from
// cleanup. Checked by substituting the word itself: if they diverged, the line would
// advise a person to use a command of a harness that isn't in this task.
const named = fakeRegistry((ref) => (ref === 'sess-worker'
  ? { ok: false, stopped: false, note: 'stand-in stop refused' }
  : { ok: true, stopped: true, note: 'closed' }), 'stand-in harness\'s registry');
const outNamed = await capture(async () => stopManaged(HOME, TASK, { registry: named.registry }));
check(': the route of a refusal names the session registry in the driver\'s words, not cleanup\'s own',
  /stand-in harness's registry/.test(outNamed) && !/claude agents/.test(outNamed), outNamed.trim());

// : the third outcome of stopping — the command was given, and there is nothing to
// confirm it with. Printing it with the words "no need to stop" would deny the first
// half of the line with the second: it did have to be stopped. What distinguishes it
// from "there was no session even before the command" is the outcome's `attempted`
// flag, and without it the machine would see two different states as one.
const unsure = fakeRegistry(() => ({
  ok: true, stopped: false, attempted: true, note: 'the stand-in stop did not confirm that the record disappeared',
}));
const unsureOut = await capture(async () => stopManaged(HOME, TASK, { registry: unsure.registry }));
check(': stopping without confirmation is its own outcome, not "no need to stop"',
  /stop of the session of participant worker:api was not confirmed/.test(unsureOut)
  && !/no need to stop/.test(unsureOut), unsureOut.trim());
check(': the line names the cost — worktree will stay in place',
  /worktree will stay in place/.test(unsureOut), unsureOut.trim());
const unsureCount = await stopManaged(HOME, TASK, { registry: fakeRegistry(() => ({
  ok: true, stopped: false, attempted: true, note: 'the stand-in stop did not confirm that the record disappeared',
})).registry });
check(': unconfirmed counts neither as stopped, nor as "nothing to stop", nor as a failure',
  unsureCount.unconfirmed === 2 && unsureCount.stopped === 0 && unsureCount.idle === 0
  && unsureCount.failed === 0, JSON.stringify(unsureCount));

// nothing to stop: these participants' sessions are not in the list. The liveness
// predicate is the same as for the whole cleanup, so a dead session never reaches the
// driver at all.
const DEAD = 'done-dead-t20260901-230100';
store.createTask(HOME, { id: DEAD, title: 'мёртвые сессии', owner: null });
store.upsertParticipant(HOME, DEAD, store.participantRecord('worker:mertvyy', { harness: 'claude', mode: 'managed', sessionRef: 'sess-net-takoy' }));
const dead = fakeRegistry();
const deadOut = await capture(async () => stopManaged(HOME, DEAD, { registry: dead.registry }));
check(': a dead session never reaches the driver — nothing to stop',
  dead.calls.length === 0 && !/closed/.test(deadOut), `${dead.calls.join(', ')} · ${deadOut.trim()}`);

// Contract: attached refuses by mode, not by capability — the driver does have the
// capability. The refusal is caught by `await`: the stop outcome is a promise, and a
// synchronous `try` would pass right by it with an empty string, making the check a
// no-op.
const refusal = await (async () => {
  try {
    await bus.stopParticipant({ address: 'worker:svoy', harness: 'claude', mode: 'attached', sessionRef: 'sess-attached' },
      fakeRegistry().registry);
    return '';
  } catch (e) {
    return e.message;
  }
})();
check(': a refusal on attached names the mode, not the absence of capability',
  /mode «attached»/.test(refusal) && /did not launch/.test(refusal), refusal);

// A bad participant record does not crash the walk — the same trick as the whole cleanup.
const BAD = 'done-bad-t20260901-230200';
store.createTask(HOME, { id: BAD, title: 'негодная запись', owner: null });
// The record is valid by the store schema and invalid by address: address is an
// adapter field, and the schema does not look at it at all. It is placed past the door:
// `participantRecord` does not accept such an address.
const badMeta = store.readTask(HOME, BAD);
badMeta.participants.push({
  id: 'worker-plohoy',
  role: 'worker',
  harness: 'claude',
  mode: 'attached',
  sessionRef: null,
  capabilities: null,
  metadata: { address: 'worker:Плохой Адрес', name: 'sess-worker' },
});
writeFileSync(store.taskFile(HOME, BAD), JSON.stringify(badMeta, null, 2) + '\n');
store.upsertParticipant(HOME, BAD, store.participantRecord('worker:posle', { harness: 'claude', mode: 'managed', sessionRef: 'sess-reviewer' }));
const bad = fakeRegistry();
await capture(async () => stopManaged(HOME, BAD, { registry: bad.registry }));
check(': a bad record does not crash the walk — the neighbor was stopped',
  bad.calls.includes('sess-reviewer'), bad.calls.join(', '));

// There is no task at all — we stay silent: cleanup runs after closing, and a refusal
// from here would take the whole thing down.
check(': there is no task — the walk stays silent instead of crashing',
  JSON.stringify(await stopManaged(HOME, 'net-takoy-zadachi', { registry: fakeRegistry().registry }))
  === JSON.stringify({ stopped: 0, idle: 0, failed: 0, unconfirmed: 0 }));

// Success without stopping is its own outcome, not "closed" (review finding): the
// session vanished between the snapshot and the call, and printing this as completed
// work would assert something unproven.
const idle = fakeRegistry(() => ({ ok: true, stopped: false, note: 'session «sess-worker» is not in the list' }));
const idleOut = await capture(async () => stopManaged(HOME, TASK, { registry: idle.registry }));
check(': no need to stop — its own outcome, and it\'s not "closed"',
  /no need to stop/.test(idleOut) && !/session of participant worker:api closed/.test(idleOut), idleOut.trim());
let counted;
await capture(async () => { counted = await stopManaged(HOME, TASK, { registry: idle.registry }); });
check(': and it is counted separately from the stopped ones',
  JSON.stringify(counted) === JSON.stringify({ stopped: 0, idle: 2, failed: 0, unconfirmed: 0 }),
  JSON.stringify(counted));

// The list of addresses is printed BEFORE the first stop: the command is irreversible,
// and a person must see what is about to be closed, not learn about it after the fact.
const ahead = fakeRegistry();
const aheadOut = await capture(async () => stopManaged(HOME, TASK, { registry: ahead.registry }));
check(': the list of those being stopped is named before stopping',
  /stopping participant sessions \(2\)/.test(aheadOut)
  && aheadOut.indexOf('stopping participant sessions') < aheadOut.indexOf('closed'), aheadOut.trim());

// An unfamiliar mode is not managed: "if it's not attached, then it's managed" would
// stop a session the driver did not start. A case typo here is exactly such a case.
//
// **With  before the walk, such a record never arrives at all**: mode is a v1 protocol
// field, and the schema knows exactly two values for it. The mechanism's door
// normalizes junk, and a record past the door is rejected by the store — before the
// task journal. Protection of the predicate itself (`modeOf`, `stopParticipant`) stayed
// where the predicate lives: `driver.test.mjs`, the check "an unfamiliar mode does not
// count as managed — neither a case typo nor junk"; here what's checked is that junk
// never reaches it.
const STRANGE = 'done-strange-t20260901-230300';
store.createTask(HOME, { id: STRANGE, title: 'незнакомый режим', owner: null });
const junkMode = (mode) => {
  try {
    store.upsertParticipant(HOME, STRANGE, {
      ...store.participantRecord('worker:musor', { harness: 'claude', sessionRef: 'sess-reviewer' }),
      mode,
    });
    return '';
  } catch (e) {
    return e.message;
  }
};
check(': store does not accept an unfamiliar mode — neither a case typo nor junk',
  /expected managed or attached/.test(junkMode('Attached')) && /expected managed or attached/.test(junkMode('что-то своё')),
  `${junkMode('Attached')} · ${junkMode('что-то своё')}`);
store.upsertParticipant(HOME, STRANGE, store.participantRecord('worker:opechatka', { harness: 'claude', mode: 'attached', sessionRef: 'sess-worker' }));
const strange = fakeRegistry();
await capture(async () => stopManaged(HOME, STRANGE, { registry: strange.registry }));
check(': attached is not picked up by the stop walk — the driver did not start it',
  strange.calls.length === 0, strange.calls.join(', '));
const strangeRefusal = await (async () => {
  try {
    await bus.stopParticipant({ address: 'worker:musor', harness: 'claude', mode: 'что-то своё', sessionRef: 'sess-reviewer' },
      fakeRegistry().registry);
    return '';
  } catch (e) {
    return e.message;
  }
})();
check(': an explicit call on an unfamiliar mode refuses and names it verbatim',
  /«что-то своё»/.test(strangeRefusal) && /the contract does not know this mode/.test(strangeRefusal), strangeRefusal);

// --- switch for an irreversible action ----------------------------------------
//
// `--keep-sessions` is checked on the real command: the branch lives in `done`, not in
// the walk, and the flag's declaration keeps its own gate (`cli-flags.test.mjs`). Here —
// that the flag reaches the library by its kebab key and changes the command's course.
const { done } = await import(path.join(here, '..', 'lib', 'done.js'));
writeFileSync(path.join(SB, 'AGENTS.md'), 'песочница\n');
writeHostConfig(SB);
const KEEP = 'done-keep-t20260901-230400';
store.createTask(HOME, { id: KEEP, title: 'выключатель гашения', owner: null });
// Session snapshot — via seam: the subject of the file is cleanup, not polling the
// harness, and a live `claude` is not needed by any branch of it.
const noSessions = () => ({});
const keptOut = await capture(async () => done(SB, { task: KEEP, 'keep-sessions': true, snapshot: noSessions }));
check(': --keep-sessions arrives by its own key and names itself in the output',
  /--keep-sessions: participant sessions left alive/.test(keptOut), keptOut.trim());
check(': with the flag, the stop walk does not start at all',
  !/stopping participant sessions/.test(keptOut), keptOut.trim());
// --- : `done` removes journals of LONG-closed tasks ------------------------
//
// Owner's measurement 2026-09-02: the workspace journal — 71 tasks, 36 MB, 1243
// messages, 196 artifacts. A manual `prune` has existed since , but it's called by
// hand, and the journal grew faster than it was swept. Owner's decision: `done` after
// its own work calls the same cleanup at the default threshold — closing a task is
// exactly the moment when a person tidies up and sees the list. The home here is its
// own: cleanup counters must not count the tasks of the checks above.
const { PRUNE_DEFAULT_DAYS } = await import(path.join(here, '..', 'lib', 'prune.js'));
const SWEEP = path.join(SB, 'sweep-ws');
const sweepHome = path.join(SWEEP, '.promptobus');
mkdirSync(sweepHome, { recursive: true });
writeFileSync(path.join(SWEEP, 'AGENTS.md'), 'песочница\n');
writeHostConfig(SWEEP);
// The date is set directly in the journal: `closeTask` writes "now", and the subject
// under test is age.
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
const closedAgo = (id, title, ago) => {
  store.createTask(sweepHome, { id, title, owner: null });
  store.closeTask(sweepHome, id);
  store.patchTask(sweepHome, id, { adapter: { closed: daysAgo(ago) } });
  return id;
};
const SWEEP_OLD = closedAgo('sweep-staraya-t20260801-010000', 'давно закрытый заход', PRUNE_DEFAULT_DAYS + 1);
const SWEEP_YOUNG = closedAgo('sweep-svezhaya-t20260901-020000', 'вчерашний заход', 1);
// Closed long ago, but its worktree still sits on disk: the journal is the only place
// where it's recorded where this work lives. The participant has no session at all —
// the worktree walk will leave the directory with the words "unknown" and will not make
// an external poll.
const SWEEP_HELD = closedAgo('sweep-zanyataya-t20260801-030000', 'заход с оставленным каталогом', PRUNE_DEFAULT_DAYS + 1);
const heldTree = path.join(SB, 'sweep-repo', '.claude', 'worktrees', 'promptobus-ostavshiysya');
mkdirSync(heldTree, { recursive: true });
store.upsertParticipant(sweepHome, SWEEP_HELD, store.participantRecord('worker:ostavshiysya', { repoAbs: path.join(SB, 'sweep-repo'), worktree: heldTree }));
const SWEEP_ACTIVE = 'sweep-zhivaya-t20260902-040000';
store.createTask(sweepHome, { id: SWEEP_ACTIVE, title: 'живой заход', owner: null });
// The task that the call itself closes: it's seconds old, and it does not fall under
// cleanup.
const SWEEP_NOW = 'sweep-seychas-t20260902-050000';
store.createTask(sweepHome, { id: SWEEP_NOW, title: 'закрываемая сейчас', owner: null });

const swept = await capture(async () => done(SWEEP, { task: SWEEP_NOW, snapshot: noSessions }));
check(': done removed the journal of a long-closed task and named it in the list',
  !existsSync(store.taskDir(sweepHome, SWEEP_OLD)) && swept.includes(SWEEP_OLD)
  && /journals removed: tasks 1/.test(swept), swept.trim());
check(': the young task, the one occupied by a directory, and the active task survived cleanup',
  [SWEEP_YOUNG, SWEEP_HELD, SWEEP_ACTIVE].every((id) => existsSync(store.taskDir(sweepHome, id))),
  [SWEEP_YOUNG, SWEEP_HELD, SWEEP_ACTIVE].filter((id) => !existsSync(store.taskDir(sweepHome, id))).join(' · '));
// We look for the id in the LIST line (`<id> "<title>" — closed …`), not anywhere in
// the output: `done` names the task being closed in its very first line, and a bare id
// occurrence would always be true.
check(': a task just closed remains — cleanup runs by threshold, not by the fact of closing',
  existsSync(store.taskDir(sweepHome, SWEEP_NOW)) && !new RegExp(`${SWEEP_NOW} "`).test(swept),
  swept.trim());
// Order is mandatory: the worktree walk reads journals of ALL closed tasks, and if
// cleanup removed a journal earlier, the directory would be left an orphan without a
// name.
// `includes` is mandatory: `indexOf` of an absent string gives −1, and the order check
// would pass vacuously exactly where the worktree walk said nothing (review finding).
check(': journal cleanup runs after the worktree walk, not before it',
  swept.includes('left in place') && swept.indexOf('left in place') < swept.indexOf('journals removed'),
  swept.trim());

// A home with no candidates: `done` stays completely silent about cleanup. A line about
// nothing done on every close would be noise — the list and count stay with the manual
// `promptobus prune`.
const QUIET = path.join(SB, 'quiet-ws');
mkdirSync(path.join(QUIET, '.promptobus'), { recursive: true });
writeFileSync(path.join(QUIET, 'AGENTS.md'), 'песочница\n');
writeHostConfig(QUIET);
const QUIET_TASK = 'quiet-t20260902-060000';
store.createTask(path.join(QUIET, '.promptobus'), { id: QUIET_TASK, title: 'нечего убирать', owner: null });
const quietOut = await capture(async () => done(QUIET, { task: QUIET_TASK, snapshot: noSessions }));
check(': nothing to remove — done says nothing about cleanup',
  !/journals removed|nothing to remove/.test(quietOut) && /closed/.test(quietOut), quietOut.trim());
