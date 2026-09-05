// Multi-process contention where the engine does not cover it: participants
// under the journal lock, uniqueness of record names on disk, artifact
// metadata, and the warden place. With real processes, not promises in one:
// the subject is the atomic filesystem primitives (`mkdir` of the lock, `wx`
// of the journal, `link` of the record name), and inside one process they
// never meet themselves.
//
// Moved with the code: the sections on two-process read-modify-write
// and on atomicity ("the first one wins").
// Run with the package's own command: `npm test`.
//
// **Three checks were removed and are not lost.** They ran the same contention
// through the compatibility layer that [v1-races.test.mjs](v1-races.test.mjs)
// checks directly on the engine, and after the layer was removed they would
// have become verbatim copies: "two processes write concurrently into one
// inbox" is covered there by "two processes send into one mailbox — nothing
// is lost and the sender order is intact", "exactly one of eight creates a
// task" — "eight processes create one task — success for exactly one", "two
// readers of one mailbox" — "two readers of one mailbox — no refusal and no
// duplicated message".
//
// **The multi-process race for an artifact NAME in the task files folder was
// removed, and it has no replacement.** The name is taken by the hard link
// itself: `linkSync` refuses `EEXIST` on a taken name, and the next one is
// chosen in a loop at the mechanism door (`placeFile` in the consumer
// adapter). The property is held by that FS refusal, not by a check before
// the write, and it is covered sequentially — by the consumer adapter suite,
// "artifact: a namesake does not overwrite the former — the link itself takes
// the name". There is no multi-process stand at the door: it would have cost
// its own harness for a branch where the FS itself is the arbiter.
// Home diversion before any import that is not a Node built-in: a module that
// resolved a home path at load would see the real one. [home.mjs](home.mjs) says
// what it applies; the sentinel in tmpdir-sweep.test.mjs keeps the order.
import './home.mjs';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

const store = await import('../dist/index.js');

// A routing policy is required when the engine opens, and its rule is the
// adapter's business: there is no adapter here, and the suite plays it. The
// example policy ("a worker must not write to a worker") lives in the CLI and
// is checked there.
const DIST = new URL('../dist/index.js', import.meta.url).href;

// There is no adapter here, and the suite plays it: turning an address into a
// participant record is its business. The same turn goes into the child
// process: it opens its own engine and lays its own records, and the names
// and fields must match the parent's.
const RECIPE = `const at = (home) => m.openEngine({ home, policy: () => ({ allow: true }) });
const rec = (address, fields = {}) => ({
  id: m.addrDir(address), role: m.roleOf(address), harness: 'proba',
  mode: fields.sessionRef ? 'managed' : 'attached', sessionRef: fields.sessionRef ?? null,
  capabilities: null, metadata: { address, ...fields },
});
`;
// eslint-disable-next-line no-new-func
const { at, rec } = await import(`data:text/javascript,${encodeURIComponent(
  `const m = await import(${JSON.stringify(DIST)});\n${RECIPE}export { at, rec };`,
)}`);

const SB = mkdtempSync(path.join(os.tmpdir(), 'promptobus-races-'));
process.on('exit', () => rmSync(SB, { recursive: true, force: true }));

const J = JSON.stringify;

// Child report "reached the barrier". The first line of its stdout is not
// returned into the checks.
const READY = '__ready__';

// A child process with code on the input: exit code, stdout, and stderr in
// one resolve.
//
// The return code is taken from EVERY child, not only where it is asked. The
// body of a fallen child prints nothing, and its silence is indistinguishable
// from an overwritten record: a count check named the consequence as the
// cause — "the message was overwritten" instead of "the process did not run".
//
// Resolve on `close`, not on `exit`: `exit` arrives before the pipes are
// drained, and the stderr tail of a fallen child would leave with the
// diagnosis it is read for.
//
// `ready` is the barrier hook: it is called exactly once, with the child
// stdin on the readiness report, or with `null` if the child died without
// reporting. The second is required: a fallen child would otherwise lock the
// barrier forever, and the check needs its return code live.
function child(body, { ready = null } = {}) {
  const code = `const m = await import(${J(DIST)});\n${RECIPE}${body}`;
  return new Promise((resolve) => {
    const ch = spawn(process.execPath, ['--input-type=module', '-e', code],
      { stdio: [ready ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let pending = ready;
    const arrive = (stdin) => {
      if (!pending) return;
      const hook = pending;
      pending = null;
      hook(stdin);
    };
    ch.stdout.on('data', (d) => { out += d; if (out.startsWith(`${READY}\n`)) arrive(ch.stdin); });
    ch.stderr.on('data', (d) => { err += d; });
    ch.on('close', (c) => {
      arrive(null);
      resolve({ code: c, out: (ready ? out.slice(out.indexOf('\n') + 1) : out).trim(), err: err.trim() });
    });
  });
}

// Every child exited zero — checked BEFORE any count of messages and
// artifacts. The detail names the fallen one and carries its stderr: the
// diagnosis lives there, not in the number of missing items.
function exitedZero(kids, who = (i) => `#${i}`) {
  const dead = kids.map((k, i) => ({ ...k, who: who(i) })).filter((k) => k.code !== 0);
  assert.equal(dead.length, 0, dead
    .map((k) => `child ${k.who} exited with code ${k.code}: ${k.err || 'stderr empty'}`).join('\n'));
}

// Barrier for races: children report readiness and sleep on a stdin read, and
// the parent releases them all at once when everyone has gathered. Without
// the barrier they queue by process-start time, and the window between the
// check and the write — the one being fixed — never arrives at all.
//
// By readiness, not by a shared time mark. The mark gave a head start on
// launching node and importing `dist`, and it was calibrated for a quiet
// machine: under load (load average 41–43) half of the eight children entered
// the barrier AFTER the mark, +27…−159 ms, and the race degenerated into an
// almost sequential start. The report knows nothing of load: there are no
// latecomers by construction, and a measurement of eight children over 5
// rounds gave a barrier-exit spread of 0…3 ms against 7…28 ms for the mark on
// the same machine.
//
// Waiting on stdin is a block, not a spin: it burns no CPU time at all.
// Taking stdin off the read after the release is required: left in the
// stream, it would keep the child event loop alive after the race body had
// finished.
function racers(n, body) {
  const doors = [];
  let seen = 0;
  let gathered = null;
  const all = new Promise((r) => { gathered = r; });
  const arrive = (stdin) => {
    if (stdin) {
      // The error listener is attached as soon as the door is laid, not at
      // release: a child that reported readiness and died at once would leave
      // the pipe with no listener, and EPIPE would bring the suite down.
      stdin.on('error', () => {});
      doors.push(stdin);
    }
    seen += 1;
    if (seen === n) gathered();
  };
  const kids = Array.from({ length: n }, (_, i) => child(
    `const i = ${i};\nconsole.log(${J(READY)});\n`
    + "await new Promise((r) => process.stdin.once('data', r));\nprocess.stdin.pause();\n"
    + body,
    { ready: arrive },
  ));
  return all.then(() => {
    // A child could die between the report and the release: EPIPE here is not
    // a stand refusal, and the error listener on the door stands from the
    // moment it is laid.
    for (const door of doors) door.end('go\n');
    return Promise.all(kids);
  });
}

// --- two-process read-modify-write ---------------------------------

test('two processes write participants — no record is lost', async () => {
  // Without the lock the second writer lays the list it read before the
  // foreign write, and the participant is lost in silence — the worker is up,
  // and it is not in the journal. Addresses are all different: a lost record
  // is not restored by the next round.
  const home = path.join(SB, 'race-participants');
  const RACE_N = 120;
  const raceTask = at(home).createTask({
    id: 't20260827-100003', title: 'гонка участников', owner: rec(store.ORCHESTRATOR),
  });
  const joiner = (prefix) => child(`const e = at(${J(home)});\n`
    + `for (let i = 0; i < ${RACE_N}; i += 1) e.putParticipant(${J(raceTask.id)}, `
    + `rec('worker:${prefix}' + i, { repo: 'ns/repo' }));`);
  const joiners = await Promise.all([joiner('a'), joiner('b')]);
  const joined = at(home).readTask(raceTask.id).participants;
  exitedZero(joiners, (i) => ['a', 'b'][i]);
  assert.equal(joined.length, RACE_N * 2 + 1, `participants ${joined.length} of ${RACE_N * 2 + 1}`);
  assert.ok(!existsSync(path.join(store.taskDir(home, raceTask.id), '.lock')), 'lock released');
  assert.ok(readdirSync(store.taskDir(home, raceTask.id)).every((n) => !n.startsWith('.tmp-')),
    'no temporary files left');
});

// --- atomicity and "the first one wins" -------------------------------

const atomicHome = path.join(SB, 'race-atomic');

test('message names are unique on disk, not in process memory', async (t) => {
  // `seq` is its own in each process, and two senders under one address in
  // one millisecond assembled one name, and `rename` overwrote in silence.
  // The address is the same for every child — that is the whole subject.
  const NAME_TASK = 'imena-t20260829-030100';
  const engine = at(atomicHome);
  engine.createTask({ id: NAME_TASK, title: 'уникальность имён', owner: rec(store.ORCHESTRATOR) });
  engine.putParticipant(NAME_TASK, rec('worker:a'));
  const WRITERS = 6;
  const PER_WRITER = 30;
  const kids = await racers(WRITERS,
    `const e = at(${J(atomicHome)});\n`
    + `for (let k = 0; k < ${PER_WRITER}; k += 1) e.sendSync(${J(NAME_TASK)}, `
    + "{ from: 'worker-a', to: ['orchestrator'], type: 'status', body: i + '#' + k });");
  const { messages: sameFrom } = engine.peek(NAME_TASK, 'orchestrator');
  await t.test('senders under one address — no message is overwritten', () => {
    exitedZero(kids);
    assert.equal(sameFrom.length, WRITERS * PER_WRITER, `${sameFrom.length} of ${WRITERS * PER_WRITER}`);
  });
  await t.test('no temporary files left after the name race', () => {
    exitedZero(kids);
    assert.equal(readdirSync(engine.inboxPath(NAME_TASK, 'orchestrator'))
      .filter((n) => n.startsWith('.tmp-')).length, 0);
  });
});

test('parallel senders of the same content do not lose records', async (t) => {
  // The record name was taken by a check before the copy, and two senders
  // that saw one free name laid the file over each other. In store v1 the
  // content is addressed by SHA-256 and deduplicated, and the visible part is
  // the metadata record: thirty sends of one file yield thirty records and
  // one blob, and no record is lost. The race for the HUMAN name in the task
  // files folder is the adapter's business, and it is checked there.
  const ART_TASK = 'artefakty-t20260829-030200';
  const engine = at(atomicHome);
  engine.createTask({ id: ART_TASK, title: 'гонка артефактов', owner: rec(store.ORCHESTRATOR) });
  engine.putParticipant(ART_TASK, rec('worker:a'));
  const artRace = path.join(SB, 'race-artifact.json');
  writeFileSync(artRace, '{"event":"CargoCreated"}\n');
  const kids = await racers(6,
    `const e = at(${J(atomicHome)});\n`
    + `for (let k = 0; k < 5; k += 1) e.sendSync(${J(ART_TASK)}, `
    + "{ from: 'worker-a', to: ['orchestrator'], type: 'artifact', body: 'a' + i + k, "
    + `artifact: { path: ${J(artRace)} } });`);
  await t.test('parallel senders — as many metadata records as sends', () => {
    exitedZero(kids);
    const { artifacts, broken } = engine.listArtifacts(ART_TASK);
    assert.equal(broken.length, 0, broken.join(', '));
    assert.equal(artifacts.length, 30, `${artifacts.length} of 30`);
  });
  await t.test('record ids do not repeat, and the content is deduplicated into one blob', () => {
    exitedZero(kids);
    const seen = engine.peek(ART_TASK, 'orchestrator').messages.map((msg) => msg.artifact);
    assert.equal(new Set(seen).size, 30);
    assert.equal(new Set(engine.listArtifacts(ART_TASK).artifacts.map((a) => a.sha256)).size, 1);
  });
});

test('the warden mark is not written over itself', async () => {
  // It arrives in place through rename, like the journal: a hard link to the
  // former file holds the former content. Written over itself, it would
  // change by the link too — and between the truncate and the write a reader
  // sees an empty file and answers "there is no warden", which is the
  // opposite of the truth.
  const MARK_TASK = 'otmetka-t20260829-030300';
  at(atomicHome).createTask({ id: MARK_TASK, title: 'атомарность отметки', owner: rec(store.ORCHESTRATOR) });
  store.claimWarden(atomicHome, MARK_TASK, { cli: 'probe' });
  const heldMark = path.join(SB, 'race-mark.json');
  linkSync(store.wardenMarkFile(atomicHome, MARK_TASK), heldMark);
  const heldBeat = JSON.parse(readFileSync(heldMark, 'utf8')).beat;
  // The heartbeat carries time: without a pause both writes would land in one
  // millisecond, and there would be nothing to compare.
  await new Promise((r) => { setTimeout(r, 5); });
  const beaten = store.beatWarden(atomicHome, MARK_TASK);
  assert.equal(JSON.parse(readFileSync(heldMark, 'utf8')).beat, heldBeat);
  assert.equal(JSON.parse(readFileSync(store.wardenMarkFile(atomicHome, MARK_TASK), 'utf8')).beat, beaten.beat);
  assert.notEqual(beaten.beat, heldBeat);
});

test('exactly one of eight takes the warden place', async () => {
  // The liveness check and the mark write are one decision under the lock.
  // Without the lock eight parallel bus commands see "there is no warden" and
  // lift eight processes: one task would be watched by eight delivery loops,
  // and every message would go to the recipient eight times.
  const CLAIM_TASK = 'nadziratel-t20260829-030400';
  at(atomicHome).createTask({ id: CLAIM_TASK, title: 'первый выигрывает место надзирателя', owner: rec(store.ORCHESTRATOR) });
  // The mark is set on the PARENT pid, not one of its own per child. The
  // place is held by the owner being alive: `liveWarden` asks `pidAlive`, and
  // an exited winner frees it for real. While the children marked themselves,
  // the winner had to be held alive by a sleep, and under the runner pool
  // that sleep did not cover the spread — the first exited before the last
  // reached `claimWarden`, and that one took a FREE place lawfully. That is
  // how the file failed in the shared run and passed alone: `mark, busy,
  // busy, busy, busy, mark, busy, busy`, test 4.3 s with a 900 ms hold. The
  // parent pid is alive for the whole test, so holding the place by sleep is
  // no longer needed at all — and what is checked is exactly what the title
  // names: the decision under the lock, not the lifetime of a foreign
  // process.
  const kids = await racers(8,
    `const r = m.claimWarden(${J(atomicHome)}, ${J(CLAIM_TASK)}, { pid: ${process.pid} });\n`
    + "console.log(r.busy ? 'busy' : 'mark');");
  exitedZero(kids);
  const claims = kids.map((k) => k.out);
  assert.equal(claims.filter((r) => r === 'mark').length, 1, claims.join(', '));
});

test('clearing the mark goes under the task lock', async (t) => {
  // Clearing the mark is read-check-delete, and it is under the lock too:
  // between reading "is it mine" and the delete a foreign `claimWarden` fits,
  // and a fresh foreign mark would be cleared. The lock sign is the wait
  // itself: a stranger drops the holder after 400 ms, and the clear sits that
  // long too. The holder is live (our pid), so the lock is not counted as an
  // orphan.
  const LOCK_TASK = 'snyatie-t20260829-030500';
  at(atomicHome).createTask({ id: LOCK_TASK, title: 'снятие под локом', owner: rec(store.ORCHESTRATOR) });
  store.claimWarden(atomicHome, LOCK_TASK);
  const clearLock = path.join(store.taskDir(atomicHome, LOCK_TASK), '.lock');
  mkdirSync(clearLock, { recursive: true });
  writeFileSync(path.join(clearLock, 'owner'), `${JSON.stringify({ pid: process.pid, session: null, since: null })}\n`);
  const releaser = spawn(process.execPath, ['--input-type=module', '-e',
    'await new Promise((r) => setTimeout(r, 400));\n'
    + `(await import('node:fs')).rmSync(${J(clearLock)}, { recursive: true, force: true });`],
  { stdio: ['ignore', 'ignore', 'inherit'] });
  const clearStart = Date.now();
  const cleared = store.clearWarden(atomicHome, LOCK_TASK);
  const clearMs = Date.now() - clearStart;
  await new Promise((r) => releaser.on('exit', r));
  await t.test('clearing the mark waits for the task lock — read-check-delete does not bypass it', () => {
    assert.equal(cleared, true);
    assert.ok(clearMs >= 350, `${clearMs}ms`);
    assert.ok(!existsSync(store.wardenMarkFile(atomicHome, LOCK_TASK)));
  });
  // The task is already gone from disk — there is nothing to clear, and
  // nothing to take the lock on: this is called from the `finally` of the
  // warden loop, and a refusal from there would take a lawful exit with it.
  rmSync(store.taskDir(atomicHome, LOCK_TASK), { recursive: true, force: true });
  await t.test('a task wiped from disk — clear stays silent, it does not fail on the lock', () => {
    let threw = false;
    try { store.clearWarden(atomicHome, LOCK_TASK); } catch { threw = true; }
    assert.ok(!threw);
  });
});
