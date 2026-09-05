// Package at its own boundary, where the engine does not cover it: the bus
// dictionary (addresses, task identity), the task-journal lock, and the three
// mailbox reads that arrived with the compatibility-layer removal — `peekInbox`,
// `glanceInbox`, and `lastSentAt`. Run with the package's own command:
// `npm test`.
//
// **What is no longer here, and why.** This file used to check the
// compatibility layer — a legacy surface over engine v1 — and half of its
// checks called the same v1 operation through the facade. The layer is gone,
// and each such check moved to where its subject lives: store operations in
// [v1-engine.test.mjs](v1-engine.test.mjs), the mechanism door (the journal in
// addresses, the journal cache, the task files folder, refusal to a bad
// recipient) — in the consumer adapter suite.
// A named breakdown of what was removed is in the task result.
//
// Diagnostics and session identity arrive as ARGUMENTS: the package does not
// read the environment and does not write to process streams, and it no longer
// has a seam for substitution at all.
// Home diversion before any import that is not a Node built-in: a module that
// resolved a home path at load would see the real one. [home.mjs](home.mjs) says
// what it applies; the sentinel in tmpdir-sweep.test.mjs keeps the order.
import './home.mjs';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

const store = await import('../dist/index.js');

const SB = mkdtempSync(path.join(os.tmpdir(), 'promptobus-store-'));
process.on('exit', () => rmSync(SB, { recursive: true, force: true }));

// A routing policy is required when the engine opens, and its rule is the
// adapter's business: there is no adapter here, and the suite plays it. The
// example policy ("a worker must not write to a worker") lives in the CLI and
// is checked there.
const engineAt = (home) => store.openEngine({ home, policy: () => ({ allow: true }) });

// A participant record as the adapter lays it: id is the mailbox-directory
// name, address is the `metadata` field by which a participant is named to a
// person and the warden files are keyed.
function participant(address, fields = {}) {
  return {
    id: store.addrDir(address),
    role: store.roleOf(address),
    harness: 'proba',
    mode: 'attached',
    sessionRef: null,
    capabilities: null,
    metadata: { address, ...fields },
  };
}

// What the call threw: class and text. The class is by constructor, as the
// upper CLI catch reads it (it recognises `GateError` by the class name, not
// `instanceof`).
function thrown(fn) {
  try {
    fn();
    return { threw: false, name: '', msg: '' };
  } catch (e) {
    return { threw: true, name: e?.constructor?.name, msg: e.message };
  }
}

// --- bus dictionary: addresses and task identity ------------------------------

test('address: orchestrator and worker:<slug> are valid', () => {
  assert.ok(store.isAddress('orchestrator') && store.isAddress('worker:cargos-api'));
});

test('address: a stranger is rejected', () => {
  assert.ok(!store.isAddress('worker:') && !store.isAddress('boss') && !store.isAddress('worker:Bad Slug'));
});

test('address → directory: the colon does not go into the file name', () => {
  assert.equal(store.addrDir('worker:cargos-api'), 'worker-cargos-api');
  assert.equal(store.addrDir('orchestrator'), 'orchestrator');
});

// The role is counted ONCE, when the participant is written: store v1 holds it
// as a field and does not derive it from the id.
test('address → role: counted from the address and laid as a record field', () => {
  assert.equal(store.roleOf('worker:cargos-api'), 'worker');
  assert.equal(store.roleOf('reviewer:cargos-api'), 'reviewer');
  assert.equal(store.roleOf('orchestrator'), 'orchestrator');
});

// Participant file name in `workers/`: spawn lays files by it, and cleanup
// sweeps them by it.
test('address → participant file name: reviewer differs from a worker', () => {
  assert.equal(store.participantFileStem('worker:cargos-api'), 'cargos-api');
  assert.equal(store.participantFileStem('reviewer:cargos-api'), 'reviewer-cargos-api');
});

// An address with no slug yields no file name at all, and that used to be
// silent: the glue returned `undefined`, and the config path was assembled
// from it as `undefined.mcp.json` — a file nobody looked for and nobody
// cleaned up. The refusal must name the address: the route here is
// unreachable, and by the words "no slug" alone the caller cannot be found.
test('address with no slug: the participant file name is not assembled, the refusal names the address', () => {
  const stem = thrown(() => store.participantFileStem('orchestrator'));
  assert.ok(stem.threw && /orchestrator/.test(stem.msg), `${stem.threw} · ${stem.msg}`);
});

// Task identity and the message id live in one journal. A message is stamped
// through `toISOString`, that is UTC; the task used to take local getters. A
// stand-in clock splits the two zones independently of the test machine TZ: on
// a UTC machine a real Date would have hidden the former implementation.
const UTC_CLOCK = {
  getUTCFullYear: () => 2026, getUTCMonth: () => 7, getUTCDate: () => 31,
  getUTCHours: () => 11, getUTCMinutes: () => 6, getUTCSeconds: () => 52,
  getFullYear: () => 1999, getMonth: () => 0, getDate: () => 1,
  getHours: () => 23, getMinutes: () => 59, getSeconds: () => 58,
};

test('task id is stamped by UTC, not by local getters', () => {
  const utcIdentity = store.newTaskIdentity('utc-proba', UTC_CLOCK);
  assert.equal(utcIdentity.id, 'utc-proba-t20260831-110652');
  assert.equal(utcIdentity.stamp, 't20260831-110652');
});

test('tail format and reading of old ids did not change', () => {
  assert.equal(store.stampOfId('utc-proba-t20260831-110652'), 't20260831-110652');
  assert.equal(store.stampOfId('staryy-t20250102-030405'), 't20250102-030405');
});

test('task id: a path out is rejected', () => {
  assert.ok(thrown(() => store.taskDir(path.join(SB, 'ws'), '../../etc')).threw);
});

// --- adapter field accessors -------------------------------------
//
// A participant record has five fields of its own — role, harness, mode,
// session reference, and a capabilities snapshot; everything else is written
// by the adapter, and the core looks there by exactly these seven names.
// There is no scatter of `metadata.<field>` across the core: the door is one,
// and the check guards that it yields the field its name speaks of.
test('accessors read adapter fields and stay silent on empty', () => {
  const full = participant('worker:a', {
    started: '2026-09-03T10:00:00.000Z', repoAbs: '/tmp/repo', dismissed: '2026-09-03T11:00:00.000Z',
    session: 'bg-1', name: 'Worker: кусок (0903-1000)', owner: 'sess-1',
  });
  assert.equal(store.addressOf(full), 'worker:a');
  assert.equal(store.startedOf(full), '2026-09-03T10:00:00.000Z');
  assert.equal(store.repoAbsOf(full), '/tmp/repo');
  assert.equal(store.dismissedOf(full), '2026-09-03T11:00:00.000Z');
  assert.equal(store.sessionOf(full), 'bg-1');
  assert.equal(store.nameOf(full), 'Worker: кусок (0903-1000)');
  assert.equal(store.ownerOf(full), 'sess-1');
  const bare = participant('worker:b');
  for (const read of [store.startedOf, store.repoAbsOf, store.dismissedOf, store.sessionOf,
    store.nameOf, store.ownerOf]) {
    assert.equal(read(bare), null);
  }
  assert.equal(store.addressOf(null), null);
});

// --- task journal lock ------------------------------------

test('task journal lock', async (t) => {
  const home = path.join(SB, 'lock', '.promptobus');
  const engine = engineAt(home);
  const heldTask = engine.createTask({
    id: 't20260827-100004', title: 'занятый лок', owner: participant('orchestrator'),
  });
  const heldLock = path.join(store.taskDir(home, heldTask.id), '.lock');
  const holdLock = (holder) => {
    mkdirSync(heldLock, { recursive: true });
    writeFileSync(path.join(heldLock, 'owner'), typeof holder === 'string' ? holder : `${JSON.stringify(holder)}\n`);
  };
  // The wait is set by the `waitMs` seam: formerly this single check in the
  // suite sat out the whole `LOCK_WAIT_MS`, five seconds per run for one line.
  const takeLock = (opts = {}) => store.withTaskLock(home, heldTask.id, () => 'taken', { waitMs: 120, ...opts });

  // Entry through the lock is not reached by a command: `taskExists` stands
  // above on every route, and `task.json` lives INSIDE the task directory — a
  // state "the journal is there, the directory is not" does not happen without
  // a race. So the subject here is library-level and exactly what the upper
  // CLI catch reads: the class name (it recognises it by name, not
  // `instanceof`).
  await t.test('ENOENT under the lock answers with the words and the class of a refusal to a person', () => {
    const ghost = thrown(() => store.withTaskLock(home, 'net-takoy', () => 'will not reach'));
    assert.equal(ghost.name, 'GateError');
    assert.match(ghost.msg, /task net-takoy is not in/);
  });

  holdLock({ pid: process.pid, session: 'sess-derzhatel', since: '2026-08-28T10:00:00.000Z' });
  const busy = thrown(() => takeLock());
  await t.test('a busy lock is a refusal, not a write over a foreign read-modify-write', () => {
    assert.ok(busy.threw && busy.msg.includes(heldLock), busy.msg);
  });
  await t.test('the refusal names the holder — pid, session, and how long it waited', () => {
    assert.ok(busy.msg.includes(`process ${process.pid}`), busy.msg);
    assert.ok(busy.msg.includes('session sess-derzhatel'), busy.msg);
    assert.match(busy.msg, /waited \d+ ms/);
  });
  // A busy journal is a lawful refusal to a person ("wait for it and retry the
  // command"), and its class is shared with the rest of the dictionary: with a
  // stack it would be read as a CLI break.
  await t.test('a busy task journal is a refusal to a person, not a CLI break', () => {
    assert.equal(thrown(() => takeLock()).name, 'GateError');
  });

  // The lock itself writes the holder, and that is a separate subject: the
  // checks above plant the `owner` file by hand, so a session disappearing
  // from the record would have gone unseen — the refusal would simply stop
  // naming it (mutation probe 2026-08-28).
  rmSync(heldLock, { recursive: true, force: true });
  const ownerFile = () => JSON.parse(readFileSync(path.join(heldLock, 'owner'), 'utf8'));
  const insideOwner = store.withTaskLock(home, heldTask.id, ownerFile, { session: 'sess-moya' });
  await t.test('the lock names itself from inside — this process pid, session, and grab time', () => {
    assert.equal(insideOwner?.pid, process.pid);
    assert.equal(insideOwner.session, 'sess-moya');
    assert.ok(!Number.isNaN(Date.parse(insideOwner.since)), JSON.stringify(insideOwner));
  });

  // Session identity arrives as an ARGUMENT, and it has no other source: the
  // Claude Code session variable STANDS in the environment at the same time —
  // otherwise the check would only say that it is missing, and the subject
  // here is different. This check is the target of the mutation probe
  // "`process.env.CLAUDE_CODE_SESSION_ID` in the package source".
  const wasEnv = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sess-iz-okruzheniya';
  let noSession;
  try {
    noSession = store.withTaskLock(home, heldTask.id, ownerFile);
  } finally {
    if (wasEnv === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = wasEnv;
  }
  await t.test('the caller names the session to the lock — the package does not read the environment', () => {
    assert.equal(noSession.session, null);
    assert.equal(noSession.pid, process.pid);
  });

  // A lock with no owner mark is lawful leftover from the former version: the
  // route remains, but a number is not invented by guess. Such a lock is not
  // declared dead either: between `mkdir` and writing the file there is a
  // window, and in it an unnamed lock is a live grab, not an orphan.
  mkdirSync(heldLock, { recursive: true });
  await t.test('no holder in the lock — the refusal says so, it does not invent a number', () => {
    const anon = thrown(() => takeLock());
    assert.ok(anon.threw && /the lock did not name/.test(anon.msg), anon.msg);
  });
  // An orphaned lock is read by pid liveness, not by the directory being
  // there. A process that died mid-write would otherwise lock the task journal
  // forever: every next write would sit out the timeout and refuse. Lock age
  // means nothing here: the holder above has a year-old `since`, and the lock
  // stayed.
  rmSync(heldLock, { recursive: true, force: true });
  holdLock({ pid: 2147483646, session: 'sess-umershaya', since: '2026-08-28T10:00:00.000Z' });
  await t.test('a dead-process lock is dropped by itself — the write goes through, and the directory does not stay', () => {
    assert.equal(takeLock(), 'taken');
    assert.ok(!existsSync(heldLock));
  });
  // A former-CLI lock holds the bare pid as a string. It is read by the same
  // read: `JSON.parse('999999')` yields a number, not a record, and without
  // the object check such a lock would silently count as unnamed.
  holdLock('999999\n');
  await t.test('a former-format lock (bare pid) is read by the same read — a dead one is dropped', () => {
    assert.equal(takeLock(), 'taken');
    assert.ok(!existsSync(heldLock));
  });
  rmSync(heldLock, { recursive: true, force: true });

  // Re-entry of the same process. The door read-modify-write takes the task
  // lock, and a store operation inside it takes THE SAME ONE: without
  // accounting for its own locks the process would sit out `waitMs` on itself
  // and refuse with "journal is busy", naming its own pid as the holder (found
  // by a live run — `promptobus dismiss` failed exactly that way). Nesting is
  // lawful: the lock separates PROCESSES, and inside a process the stretch is
  // synchronous, so the nested call is the same section.
  await t.test('a nested lock of the same process enters the same section, it does not wait for itself', () => {
    // There is no need to check wall time: without accounting for its own
    // locks the nested call is not "slow", it is a refusal — it sits out its
    // `waitMs` and throws. The outcome is checked, not the duration: under
    // load from neighbouring runs the threshold would jitter, the refusal
    // would not.
    const seen = store.withTaskLock(home, heldTask.id, () => {
      const outerOwner = ownerFile();
      const innerOwner = store.withTaskLock(home, heldTask.id, () => ownerFile(), { waitMs: 120 });
      return { outerOwner, innerOwner, insideExists: existsSync(heldLock) };
    }, { session: 'sess-vlozhennaya' });
    assert.deepEqual(seen.innerOwner, seen.outerOwner, 'the inner call sees the same holder');
    assert.equal(seen.innerOwner.session, 'sess-vlozhennaya', 'the holder is still the outer call');
    assert.equal(seen.insideExists, true);
  });
  // Only the call that took the lock drops it: drop the inner one — the outer
  // would finish with no lock at all, and a neighbour would enter its critical
  // section.
  await t.test('the taker drops the lock — after the inner call it is still held', () => {
    const held = store.withTaskLock(home, heldTask.id, () => {
      store.withTaskLock(home, heldTask.id, () => 'inside');
      return existsSync(heldLock);
    });
    assert.equal(held, true, 'the inner call dropped a lock it did not take');
    assert.equal(existsSync(heldLock), false, 'the outer call did not drop the lock');
  });

  await t.test('the lock is dropped — no temporary files and no lock directory left in the task', () => {
    assert.ok(!existsSync(heldLock));
    assert.ok(readdirSync(store.taskDir(home, heldTask.id)).every((n) => !n.startsWith('.tmp-')));
  });
});

// --- three mailbox reads that `read` does not cover ----------------------
//
// `read` takes the mailbox and carries the refs into history. It does not
// serve these three operations: a foreign session is given a copy, the warden
// glances in silence, and a stall diagnosis asks "when this address last went
// out on the bus". All three used to live in the compatibility layer and
// nearly left with it.
test('peek, glance and lastSentAt — reads that do not take the mailbox', async (t) => {
  const home = path.join(SB, 'peek', '.promptobus');
  const engine = engineAt(home);
  const task = engine.createTask({ id: 'peek-t20260903-000000', title: 'чтения', owner: participant('orchestrator') });
  engine.addParticipant(task.id, participant('worker:a'));
  for (const n of [1, 2, 3]) {
    engine.sendSync(task.id, { from: 'worker-a', to: ['orchestrator'], type: 'status', body: `цел ${n}` });
  }

  await t.test('peek: messages are yielded, and the mailbox stays full', () => {
    const { messages, broken } = engine.peek(task.id, 'orchestrator');
    assert.equal(messages.map((m) => m.body).join(','), 'цел 1,цел 2,цел 3');
    assert.equal(broken.length, 0);
    assert.equal(engine.unread(task.id, 'orchestrator'), 3);
  });

  // This is what a file looks like after a process died mid-write in the
  // former CLI (no link/rename).
  const box = engine.inboxPath(task.id, 'orchestrator');
  const dirtyName = '20260903T000000000-9999-abcdef.json';
  writeFileSync(path.join(box, dirtyName), '{"id": "20260903T0000');
  await t.test('peek: the broken one is named structurally and set aside, the intact one arrived', () => {
    const { messages, broken } = engine.peek(task.id, 'orchestrator');
    assert.equal(messages.length, 3);
    assert.equal(broken.length, 1);
    assert.equal(broken[0].name, dirtyName);
    // Cause and place are split into fields, not glued into a string: the
    // adapter assembles the text for a person, and a glue would force it to
    // cut the string back with a regex.
    assert.match(broken[0].note, /did not parse/);
    assert.ok(broken[0].attic && !existsSync(path.join(box, dirtyName)));
  });

  await t.test('glance: glances in silence — touches no refs and sets no broken aside', () => {
    writeFileSync(path.join(box, dirtyName), 'not json at all');
    const seen = engine.glance(task.id, 'orchestrator');
    assert.equal(seen.map((m) => m.body).join(','), 'цел 1,цел 2,цел 3');
    assert.ok(existsSync(path.join(box, dirtyName)), 'the broken file stayed in place');
    assert.equal(engine.unread(task.id, 'orchestrator'), 4);
    rmSync(path.join(box, dirtyName), { force: true });
  });

  await t.test('lastSentAt: time of the address last SEND, not of its unread', () => {
    const sent = engine.lastSentAt(task.id, 'worker-a');
    assert.ok(Number.isFinite(sent), String(sent));
    assert.equal(engine.lastSentAt(task.id, 'orchestrator'), null, 'the orchestrator has not sent yet');
    // The walk is incremental and survives an addition: the next send moves
    // the time.
    const before = sent;
    engine.sendSync(task.id, { from: 'orchestrator', to: ['worker-a'], type: 'task', body: 'ответ' });
    assert.ok(engine.lastSentAt(task.id, 'orchestrator') >= before);
  });

  await t.test('read after peek: the mailbox is taken whole, a second read is empty', () => {
    const { messages } = engine.read(task.id, 'orchestrator');
    assert.equal(messages.map((m) => m.body).join(','), 'цел 1,цел 2,цел 3');
    assert.equal(engine.read(task.id, 'orchestrator').messages.length, 0);
    assert.equal(engine.unread(task.id, 'orchestrator'), 0);
  });
});

// --- hard link to a blob under the adapter name ---------------------
//
// The task files folder is the adapter's business, and the package does not
// yield the blob path outward. The door between them is one — `linkBlob`, and
// it also takes the name: `false` instead of a quiet overwrite.
test('linkBlob places the link and does not overwrite a taken name', () => {
  const home = path.join(SB, 'link', '.promptobus');
  const engine = engineAt(home);
  const task = engine.createTask({ id: 'link-t20260903-000000', title: 'ссылки', owner: participant('orchestrator') });
  engine.addParticipant(task.id, participant('worker:a'));
  const src = path.join(SB, 'contract.json');
  writeFileSync(src, '{"event":"CargoCreated"}\n');
  let placed = null;
  const dir = path.join(SB, 'files');
  const sent = engine.sendSync(task.id, {
    from: 'worker-a',
    to: ['orchestrator'],
    type: 'artifact',
    body: 'контракт',
    artifact: {
      path: src,
      name: (sha) => {
        placed = sha;
        return 'contract.json';
      },
    },
  });
  assert.equal(sent.artifact.filename, 'contract.json');
  assert.ok(engine.linkBlob(task.id, placed, path.join(dir, 'contract.json')));
  assert.match(readFileSync(path.join(dir, 'contract.json'), 'utf8'), /CargoCreated/);
  // A second time under the same name — `false`, not an overwrite: the caller
  // picks the next name.
  assert.equal(engine.linkBlob(task.id, placed, path.join(dir, 'contract.json')), false);
  assert.ok(engine.linkBlob(task.id, placed, path.join(dir, 'contract-2.json')));
});
