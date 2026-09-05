// Engine protocol v1: the task and participants, fan-out with recovery, mailbox
// and history, content-addressed artifacts, isolation of the damaged.
//
// There is no CLI, no workspace, no harness here at all — and that is the
// subject of the check on a par with the rest: core must work without them.
// Everything the engine knows about the outside world arrives as two open
// arguments — the root and the routing policy.
// Home diversion before any import that is not a Node built-in: a module that
// resolved a home path at load would see the real one. [home.mjs](home.mjs) says
// what it applies; the sentinel in tmpdir-sweep.test.mjs keeps the order.
import './home.mjs';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  ERROR_CODES, MECHANISM_VERSION_FIELD, openEngine, PromptobusError, validate,
} from '../dist/index.js';
// The only deep import in the suite, and it is needed by exactly one check
// below: `commitIntent` accepts a ready record, that is it lets the id be
// named in advance, while through `openEngine` the engine assembles it
// itself with a random tail. The package does not export this module —
// it has three entry points, and the check does not extend them.
import { commitIntent } from '../dist/v1/messages.js';

const SB = mkdtempSync(path.join(os.tmpdir(), 'promptobus-v1-'));
process.on('exit', () => rmSync(SB, { recursive: true, force: true }));

const CAPS = { spawn: true, attach: true, activation: 'push', inspect: true, stop: true };

// The role is declared as a FIELD, not derived from the id: `w-api` is a
// worker here only because that is what the record says. That is what v1
// separates compared to the `worker:<slug>` address.
const person = (id, role, extra = {}) => ({
  id,
  role,
  harness: 'fake',
  mode: 'managed',
  sessionRef: `sess-${id}`,
  capabilities: CAPS,
  metadata: {},
  ...extra,
});

// Stand-in policy: the sample "worker → worker is forbidden" policy lives at
// the adapter; here it stands as a specimen — core does not know its own roles.
const noWorkerToWorker = (sender, recipient) => (
  sender.role === 'worker' && recipient.role === 'worker'
    ? { deny: true, reason: 'workers must not write to each other' }
    : { allow: true }
);

const allowAll = () => ({ allow: true });

// Unclosed fan-outs of the task. Intent records are counted, not the
// directory contents: next to each sits the owner lease `<id>.owner`.
const openIntents = (dir) => readdirSync(dir).filter((n) => n.endsWith('.json'));

let sandboxes = 0;
function sandbox() {
  sandboxes += 1;
  const root = path.join(SB, `root-${sandboxes}`);
  mkdirSync(root, { recursive: true });
  return root;
}

// The clock steps one second per call: message ids sort by send order, and
// run stamps do not depend on how fast the machine is.
function clock(from = '2026-09-02T10:00:00.000Z') {
  let ms = Date.parse(from);
  return () => {
    ms += 1000;
    return new Date(ms);
  };
}

/** A task with an owner and two workers. The owner is a participant too, with a harness and a mode. */
function taskWith(engine, id = 'demo-t20260902-100000') {
  engine.createTask({ id, title: 'демо', owner: person('owner', 'orchestrator', { mode: 'attached' }) });
  engine.addParticipant(id, person('w-api', 'worker'));
  engine.addParticipant(id, person('w-docs', 'worker'));
  return id;
}

function open(root, options = {}) {
  return openEngine({ root, policy: allowAll, now: clock(), ...options });
}

// An engine refusal: the code, not a parse of the text. Human text is the
// adapter's business, and checking it here would pin the suite to something
// that is not in the contract.
function refusal(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

async function refusalAsync(fn) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return null;
}

// ── Opening the engine ───────────────────────────────────────────────────────────────────

test('a routing policy is required at open, not at the first send', () => {
  const e = refusal(() => openEngine({ root: sandbox() }));
  assert.ok(e instanceof PromptobusError);
  assert.equal(e.code, 'policy-required');
  // A refusal before the first send is the whole point: an engine whose rule
  // appears later lets everything through until then.
  assert.equal(refusal(() => openEngine({ root: sandbox(), policy: 'no' })).code, 'policy-required');
});

test('the store sits in <root>/.promptobus, and the package does not search for the root', () => {
  const root = sandbox();
  assert.equal(open(root).home, path.join(root, '.promptobus'));
});

// ── The task and participants ────────────────────────────────────────────────────────────────

test('the task owner is a participant too: harness, mode, sessionRef, and capabilities', () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  const meta = engine.readTask(id);
  const owner = meta.participants.find((p) => p.id === meta.owner);
  assert.equal(meta.owner, 'owner');
  assert.equal(owner.harness, 'fake');
  assert.equal(owner.mode, 'attached');
  assert.equal(owner.sessionRef, 'sess-owner');
  assert.deepEqual(owner.capabilities, CAPS);
});

test('a participant without a harness is not created: v1 has no fallback at all', () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  const { harness, ...noHarness } = person('w-null', 'worker');
  const e = refusal(() => engine.addParticipant(id, noHarness));
  assert.equal(e.code, 'schema-invalid');
  assert.deepEqual(engine.readTask(id).participants.map((p) => p.id), ['owner', 'w-api', 'w-docs']);
});

test('updating a participant is a field patch, not a whole-record replace', async (t) => {
  // The legacy `upsertParticipant` invariant ("the second call must put the
  // same record back") is not repeated in v1: there, a caller appending one
  // field silently lost the fields of the first call.
  const engine = open(sandbox());
  const id = taskWith(engine);
  engine.patchParticipant(id, 'w-api', { metadata: { repo: 'ns/repo' } });
  engine.patchParticipant(id, 'w-api', { sessionRef: 'sess-restarted' });
  const p = engine.readTask(id).participants.find((x) => x.id === 'w-api');
  await t.test('patch: the field of the first call survived the second', () => {
    assert.deepEqual(p.metadata, { repo: 'ns/repo' });
    assert.equal(p.sessionRef, 'sess-restarted');
    assert.equal(p.harness, 'fake');
  });
  await t.test('patch: a schema-breaking one refuses BEFORE the journal write', () => {
    const before = readFileSync(path.join(engine.home, 'tasks', id, 'task.json'), 'utf8');
    assert.equal(refusal(() => engine.patchParticipant(id, 'w-api', { mode: 'detached' })).code, 'schema-invalid');
    assert.equal(readFileSync(path.join(engine.home, 'tasks', id, 'task.json'), 'utf8'), before);
  });
});

test('the owner changes only by an explicit claim and returns the previous one', () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  assert.equal(engine.claimOwner(id, 'w-api'), 'owner');
  assert.equal(engine.readTask(id).owner, 'w-api');
  // A claim on a participant who is not in the task is a refusal, not a
  // quiet change of owner.
  assert.equal(refusal(() => engine.claimOwner(id, 'w-none')).code, 'participant-not-found');
});

test('exactly one creates a task with the same id', () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  const e = refusal(() => engine.createTask({ id, title: 'вторая', owner: person('owner', 'orchestrator') }));
  assert.equal(e.code, 'task-exists');
  assert.equal(engine.readTask(id).title, 'демо');
});

// ── Fan-out prevalidation ─────────────────────────────────────────────────────────────

test('prevalidation: an empty list, duplicates, an unknown addressee, and a foreign type', async (t) => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  const cases = [
    ['recipients-empty', { from: 'owner', to: [], type: 'task', body: 'a' }],
    ['recipients-duplicate', { from: 'owner', to: ['w-api', 'w-api'], type: 'task', body: 'a' }],
    ['participant-not-found', { from: 'owner', to: ['w-none'], type: 'task', body: 'a' }],
    ['participant-not-found', { from: 'w-none', to: ['w-api'], type: 'task', body: 'a' }],
    ['message-type-unknown', { from: 'owner', to: ['w-api'], type: 'notify', body: 'a' }],
    ['schema-invalid', { from: 'owner', to: ['w-api'], type: 'task', body: '' }],
  ];
  for (const [code, input] of cases) {
    await t.test(`prevalidation: ${code} on ${JSON.stringify(input.to)} ${input.type}`, async () => {
      const e = await refusalAsync(() => engine.send(id, input));
      assert.equal(e.code, code);
    });
  }
  await t.test('prevalidation: not one refusal touched the store', () => {
    assert.equal(engine.unread(id, 'w-api'), 0);
    assert.ok(!existsSync(path.join(engine.home, 'tasks', id, 'messages')));
    assert.ok(!existsSync(path.join(engine.home, 'tasks', id, 'intents')));
  });
});

test('a closed task is not written to, and reading it is lawful', async () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  await engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'до закрытия' });
  engine.closeTask(id);
  assert.equal((await refusalAsync(() => engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'после' }))).code,
    'task-closed');
  assert.equal(engine.read(id, 'w-api').messages.length, 1);
});

// ── Routing policy ────────────────────────────────────────────────────────────────────

test('a routing denial fires BEFORE artifacts and messages', async (t) => {
  const root = sandbox();
  const engine = openEngine({ root, policy: noWorkerToWorker, now: clock() });
  const id = taskWith(engine);
  const file = path.join(SB, 'denial.patch');
  writeFileSync(file, 'дифф, который не должен доехать\n');
  const e = await refusalAsync(() => engine.send(id, {
    from: 'w-api', to: ['w-docs'], type: 'artifact', body: 'дифф', artifact: { path: file },
  }));
  await t.test('routing denial: the code and the policy reason', () => {
    assert.equal(e.code, 'policy-denied');
    assert.equal(e.context.sender, 'w-api');
    assert.equal(e.context.recipient, 'w-docs');
    assert.match(e.context.reason, /worker/);
  });
  await t.test('routing denial: no blob appeared in the task', () => {
    // The "policy → blob" order is the subject: an artifact put before the
    // check would stay in the task forever — blobs leave only with `prune`.
    assert.equal(engine.orphanBlobs(id).length, 0);
    assert.ok(!existsSync(path.join(engine.home, 'tasks', id, 'blobs')));
  });
  await t.test('routing denial: neither a message nor an intent', () => {
    assert.ok(!existsSync(path.join(engine.home, 'tasks', id, 'messages')));
    assert.ok(!existsSync(path.join(engine.home, 'tasks', id, 'intents')));
    assert.equal(engine.unread(id, 'w-docs'), 0);
  });
  await t.test('routing denial: the allowed direction goes through', async () => {
    const sent = await engine.send(id, { from: 'w-api', to: ['owner'], type: 'result', body: 'готово' });
    assert.equal(sent.message.sender, 'w-api');
    assert.equal(engine.unread(id, 'owner'), 1);
  });
});

test('a policy that returned not a decision is read as a refusal', async () => {
  const engine = openEngine({ root: sandbox(), policy: () => undefined, now: clock() });
  const id = taskWith(engine);
  const e = await refusalAsync(() => engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'a' }));
  assert.equal(e.code, 'policy-denied');
  assert.equal(engine.unread(id, 'w-api'), 0);
});

// ── Fan-out: delivery and events ───────────────────────────────────────────────────────

test('fan-out: one canonical message and a link for each recipient', async (t) => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  const { message, events } = await engine.send(id, {
    from: 'owner', to: ['w-api', 'w-docs'], type: 'task', body: 'сделай',
  });
  const taskRoot = path.join(engine.home, 'tasks', id);
  await t.test('fan-out: the canon is one', () => {
    assert.deepEqual(readdirSync(path.join(taskRoot, 'messages')), [`${message.id}.json`]);
  });
  await t.test('fan-out: the intent is taken down after the links of all', () => {
    assert.deepEqual(readdirSync(path.join(taskRoot, 'intents')), []);
  });
  await t.test('fan-out: a link at each recipient, nothing at the sender', () => {
    assert.equal(engine.unread(id, 'w-api'), 1);
    assert.equal(engine.unread(id, 'w-docs'), 1);
    assert.equal(engine.unread(id, 'owner'), 0);
  });
  await t.test('fan-out: the links and the canon are one inode', () => {
    // Canon immutability is declared by the contract, and the inode is
    // shared: the contents are not copied, and a "link" here is a hard
    // link, not a record next to it.
    const ino = statSync(path.join(taskRoot, 'messages', `${message.id}.json`)).ino;
    for (const who of ['w-api', 'w-docs']) {
      assert.equal(statSync(path.join(taskRoot, 'inbox', who, `${message.id}.json`)).ino, ino);
    }
  });
  await t.test('fan-out: "whom to wake" events per recipient, with a ref and an excerpt', () => {
    // The form is the one `activate(target, notification)` of a driver will
    // take: `ref` goes into target, the rest — into notification.
    assert.deepEqual(events.map((e) => e.address), ['w-api', 'w-docs']);
    assert.deepEqual(events.map((e) => e.ref), ['sess-w-api', 'sess-w-docs']);
    for (const e of events) {
      assert.equal(e.kind, 'unread');
      assert.equal(e.task, id);
      assert.equal(e.unread, 1);
      assert.deepEqual(e.messages, [{
        id: message.id, type: 'task', from: 'owner', ts: message.ts, body: 'сделай', artifact: null,
      }]);
    }
  });
});

test('an activation refusal of one recipient does not touch the fan-out and does not block the others', async () => {
  // Activation is the supervisor's and the driver's business: the engine
  // returns the "whom to wake" list. What is checked here is the event
  // contract — that a refusal of one does not roll back delivery and does
  // not take the others with it.
  const engine = open(sandbox());
  const id = taskWith(engine);
  const { events } = await engine.send(id, { from: 'owner', to: ['w-api', 'w-docs'], type: 'task', body: 'обоим' });
  const woken = [];
  for (const e of events) {
    try {
      if (e.address === 'w-api') throw new Error('socket did not accept the notification');
      woken.push(e.address);
    } catch {
      // Exactly what the supervisor does: a refusal is an outcome, not an
      // exception outward.
    }
  }
  assert.deepEqual(woken, ['w-docs']);
  assert.equal(engine.unread(id, 'w-api'), 1, 'an activation refusal did not roll back delivery');
  assert.equal(engine.read(id, 'w-api').messages.length, 1);
});

// ── A crash at each fan-out point ──────────────────────────────────────────────────────

// A crash is pictured as a throw from the seam: a real process death mid-step
// is not reproduced by the suite, and the state on disk stays the same. That
// this is not an artifact of a throw in one process is checked by
// [v1-races.test.mjs](v1-races.test.mjs) — there the process really dies
// mid-fan-out.
function crashAt(root, step, { at = 0 } = {}) {
  let seen = 0;
  return openEngine({
    root,
    policy: allowAll,
    now: clock(),
    recover: false,
    faults: (which) => {
      if (which !== step) return;
      seen += 1;
      if (seen > at) throw new Error(`crash at step ${step}`);
    },
  });
}

const STEPS = ['validate', 'blob', 'artifact', 'intent', 'canonical', 'ref', 'close'];

test('a crash at each fan-out point and idempotent recovery', async (t) => {
  for (const step of STEPS) {
    await t.test(`crash at step ${step}: recovery takes delivery to the end`, async () => {
      const root = sandbox();
      const source = path.join(SB, `crash-${step}.patch`);
      writeFileSync(source, `содержимое для ${step}\n`);
      const broken = crashAt(root, step, { at: 0 });
      const id = taskWith(broken);
      const e = await refusalAsync(() => broken.send(id, {
        from: 'owner', to: ['w-api', 'w-docs'], type: 'artifact', body: 'дифф', artifact: { path: source },
      }));
      assert.match(e.message, new RegExp(`crash at step ${step}`));

      // Opening the engine recovers the fan-out itself — this is the first
      // of two recovery routes (the second is a `recover()` call by the
      // warden round).
      const healed = openEngine({ root, policy: allowAll, now: clock() });
      const committed = ['intent', 'canonical', 'ref', 'close'].includes(step);
      if (committed) {
        assert.equal(healed.unread(id, 'w-api'), 1, `${step}: w-api`);
        assert.equal(healed.unread(id, 'w-docs'), 1, `${step}: w-docs`);
        assert.deepEqual(readdirSync(path.join(healed.home, 'tasks', id, 'intents')), [],
          `${step}: the intent stayed unclosed`);
      } else {
        // Before the commit point the message does not exist at all: the
        // send did not return, and the sender does not know about it.
        assert.equal(healed.unread(id, 'w-api'), 0, `${step}: w-api`);
        assert.equal(healed.unread(id, 'w-docs'), 0, `${step}: w-docs`);
      }

      // A second pass does nothing: recovery is idempotent by construction
      // — both the canon and each link are put by `link`, and `EEXIST`
      // means "already there".
      const again = healed.recover(id);
      assert.deepEqual(again.repairs, [], `${step}: a second recovery fixed something`);
      assert.deepEqual(again.events, [], `${step}: a second recovery wakes someone`);
      assert.equal(healed.unread(id, 'w-api'), committed ? 1 : 0, `${step}: a second pass changed the mailbox`);
    });
  }
});

test('a crash after the first link: the second is appended, the first is not duplicated', async () => {
  const root = sandbox();
  // A crash AFTER the first link: `w-api` has it, `w-docs` does not yet.
  const broken = crashAt(root, 'ref', { at: 0 });
  const id = taskWith(broken);
  await refusalAsync(() => broken.send(id, { from: 'owner', to: ['w-api', 'w-docs'], type: 'task', body: 'обоим' }));
  assert.equal(broken.unread(id, 'w-api'), 1);
  assert.equal(broken.unread(id, 'w-docs'), 0);

  const healed = openEngine({ root, policy: allowAll, now: clock(), recover: false });
  const { repairs, events } = healed.recover(id);
  assert.equal(repairs.length, 1);
  assert.deepEqual(repairs[0].recipients, ['w-docs'], 'only the missing link is appended');
  assert.deepEqual(events.map((e) => e.address), ['w-docs'], 'only the one who was appended to is woken');
  assert.equal(healed.unread(id, 'w-api'), 1, 'the first link was not doubled');
  assert.equal(healed.unread(id, 'w-docs'), 1);
});

test('a crash after a read: recovery does not return what was already read', async (t) => {
  const root = sandbox();
  // A crash after the link to the ONLY recipient: everyone has a link, and
  // the intent was not taken down yet — exactly the state in which recovery
  // could deliver a second time.
  const broken = crashAt(root, 'ref', { at: 0 });
  const id = taskWith(broken);
  await refusalAsync(() => broken.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'один раз' }));
  assert.equal(openIntents(path.join(broken.home, 'tasks', id, 'intents')).length, 1, 'the intent is open');

  // The recipient takes the message BEFORE recovery: the link leaves inbox
  // for history.
  const taken = broken.read(id, 'w-api');
  assert.deepEqual(taken.messages.map((m) => m.body), ['один раз']);

  const healed = openEngine({ root, policy: allowAll, now: clock(), recover: false });
  const { repairs, events } = healed.recover(id);
  await t.test('recovery checked history, not only inbox', () => {
    assert.deepEqual(repairs[0].recipients, [], 'the link was appended again');
    assert.deepEqual(events, [], 'woke the one who had already read');
    assert.equal(healed.unread(id, 'w-api'), 0);
  });
  await t.test('a second read is empty — the message was not delivered twice', () => {
    assert.deepEqual(healed.read(id, 'w-api').messages, []);
  });
});

// ── Lease of an unclosed fan-out ─────────────────────────────────────────────

/**
 * An unclosed intent on disk: the send is thrown from the seam right after
 * the commit point. What remains are the intent and the owner record with
 * the pid of THIS process — exactly what a real sender who died at that
 * moment would have left.
 */
async function inFlight(root, body = 'в полёте') {
  const broken = crashAt(root, 'intent');
  const id = taskWith(broken);
  await refusalAsync(() => broken.send(id, { from: 'owner', to: ['w-api'], type: 'task', body }));
  const dir = path.join(broken.home, 'tasks', id, 'intents');
  const [name] = readdirSync(dir).filter((n) => n.endsWith('.json'));
  return { id, dir, intent: path.join(dir, name), owner: path.join(dir, `${name.slice(0, -'.json'.length)}.owner`) };
}

const lease = (file, pid, host = os.hostname()) => writeFileSync(file, `${JSON.stringify({ pid, host })}\n`);

// Age the intent past the threshold. An hour is well above any threshold, so
// the check does not depend on the number itself — it is about the "age
// decides" branch, not about the size of `INTENT_STALE_MS`.
const backdate = (file) => {
  const long = new Date(Date.now() - 3600_000);
  utimesSync(file, long, long);
};

// A foreign LIVE pid: a real process. Our own will not do at all — recovery
// reads our pid on the intent as "a previous process with the same number"
// and picks it up.
const liveStranger = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });

// A foreign DEAD pid: the number of a process that has just exited. A
// number at random will not do — it may turn out to be live, and the check
// would silently check the wrong thing.
async function deadStranger() {
  const ch = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => ch.on('exit', r));
  return ch.pid;
}

test('lease: recovery does not touch the intent of a live owner', async (t) => {
  // A home with several writing processes is normal, and the engine opens
  // lazily, and open runs recovery. Without a lease a latecomer would pick
  // up a neighbour's live fan-out: materialise the canon and take the
  // intent down while the owner stood on the path to `link`.
  const root = sandbox();
  const { id, intent } = await inFlight(root);
  const stranger = liveStranger();
  // Killed in `after`, not on the last line: a red assert throws past it,
  // and a live child holds the parent event loop — the suite would hang a
  // minute after the fall.
  t.after(() => stranger.kill());
  lease(path.join(path.dirname(intent), `${path.basename(intent, '.json')}.owner`), stranger.pid);
  const healed = openEngine({ root, policy: allowAll, now: clock(), recover: false });
  const { repairs, events } = healed.recover(id);
  await t.test('a live intent was not picked up and not taken down', () => {
    assert.deepEqual(repairs, [], 'recovery stepped into a foreign in-flight fan-out');
    assert.deepEqual(events, []);
    assert.ok(existsSync(intent), 'the intent was taken down from under a live owner');
    assert.equal(healed.unread(id, 'w-api'), 0, 'the link was appended past the owner');
  });
});

test('lease: recovery picks up the intent of a dead owner', async () => {
  const root = sandbox();
  const { id, intent, owner } = await inFlight(root, 'дописать');
  lease(owner, await deadStranger());
  const healed = openEngine({ root, policy: allowAll, now: clock(), recover: false });
  const { repairs } = healed.recover(id);
  assert.deepEqual(repairs.map((r) => r.recipients), [['w-api']]);
  assert.equal(healed.unread(id, 'w-api'), 1);
  assert.ok(!existsSync(intent), 'the intent stayed unclosed');
  assert.ok(!existsSync(owner), 'the owner record survived the fan-out close');
});

test('lease: an intent without an owner record waits for the threshold, and past it is picked up', async (t) => {
  const root = sandbox();
  const { id, intent, owner } = await inFlight(root);
  // This is what an intent written by a version that did not know the lease
  // looks like: there is nothing to ask the owner liveness of, and age
  // alone decides.
  rmSync(owner);
  await t.test('younger than the threshold — not touched', () => {
    const young = openEngine({ root, policy: allowAll, now: clock(), recover: false });
    assert.deepEqual(young.recover(id).repairs, []);
    assert.ok(existsSync(intent));
  });
  await t.test('older than the threshold — picked up', () => {
    backdate(intent);
    const stale = openEngine({ root, policy: allowAll, now: clock(), recover: false });
    assert.equal(stale.recover(id).repairs.length, 1);
    assert.equal(stale.unread(id, 'w-api'), 1);
  });
});

test('lease: an owner record from a foreign machine — wait for the threshold, liveness is not asked', async () => {
  const root = sandbox();
  const { id, intent, owner } = await inFlight(root);
  // The pid is OURS: on our machine it would mean "pick it up", and a check
  // that does not look at host would not notice that at all.
  lease(owner, process.pid, `${os.hostname()}-drugaya`);
  const healed = openEngine({ root, policy: allowAll, now: clock(), recover: false });
  assert.deepEqual(healed.recover(id).repairs, []);
  assert.ok(existsSync(intent));
});

test('lease: past the threshold even the intent of a live owner is picked up', async (t) => {
  // Age is the upper bound of the lease: a pid reused by the OS under a
  // foreign live process would otherwise lock the intent forever. It also
  // leaves reachable the race that `materialize` tolerates — without it
  // that tolerance would be dead code.
  const root = sandbox();
  const { id, intent, owner } = await inFlight(root);
  const stranger = liveStranger();
  t.after(() => stranger.kill());
  lease(owner, stranger.pid);
  backdate(intent);
  const healed = openEngine({ root, policy: allowAll, now: clock(), recover: false });
  assert.equal(healed.recover(id).repairs.length, 1);
  assert.equal(healed.unread(id, 'w-api'), 1);
});

test('lease: an intent abandoned by this same process is picked up', async (t) => {
  // The life of an intent inside a process is ONE synchronous block:
  // `commitIntent` and `completeFanout` are synchronous whole, and all send
  // awaits sit before the commit point. So our pid on the intent means "a
  // previous process with the same number", not "it is being written right
  // now". The whole crash suite above rests on that invariant — it throws
  // the send from the seam and recovers in THE SAME process; an await
  // between creating the intent and taking it down would redden both them
  // and this check.
  const root = sandbox();
  const { id, intent, owner } = await inFlight(root, 'свой же');
  await t.test('our pid is written as the owner', () => {
    assert.deepEqual(JSON.parse(readFileSync(owner, 'utf8')), { pid: process.pid, host: os.hostname() });
  });
  await t.test('recovery by the same process takes delivery to the end', () => {
    const healed = openEngine({ root, policy: allowAll, now: clock(), recover: false });
    assert.equal(healed.recover(id).repairs.length, 1);
    assert.equal(healed.unread(id, 'w-api'), 1);
    assert.ok(!existsSync(intent));
  });
});

test('lease: a fresh intent does not inherit an orphaned owner record', async () => {
  // Record names can repeat — the code itself counts that reachable:
  // `commitIntent` rebuilds the id on `EEXIST` up to sixteen times. If an
  // orphaned lease of a previous fan-out is left under the same name, a
  // fresh intent must overwrite it with itself: otherwise it carries
  // foreign pid and host and is declared abandoned at once — the window is
  // open again.
  const root = sandbox();
  const engine = open(root);
  const id = taskWith(engine);
  const dir = path.join(engine.home, 'tasks', id, 'intents');
  mkdirSync(dir, { recursive: true });
  const record = {
    protocolVersion: 1,
    id: '20260902T100700000-0021-abcdef',
    task: id,
    sender: 'owner',
    recipients: ['w-api'],
    type: 'task',
    body: 'свежий',
    ts: '2026-09-02T10:07:00.000Z',
  };
  const orphan = path.join(dir, `${record.id}.owner`);
  lease(orphan, await deadStranger(), `${os.hostname()}-drugaya`);
  commitIntent(engine.home, id, record, new Date(record.ts));
  assert.deepEqual(JSON.parse(readFileSync(orphan, 'utf8')), { pid: process.pid, host: os.hostname() });
});

test('lease: an orphaned owner record is removed silently', async () => {
  // This is what the directory looks like after former-version code: it
  // takes the intent down and does not know about the lease.
  const root = sandbox();
  const engine = open(root);
  const id = taskWith(engine);
  await engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'закрытый fan-out' });
  const orphan = path.join(engine.home, 'tasks', id, 'intents', '20260902T100500000-0009-abcdef.owner');
  mkdirSync(path.dirname(orphan), { recursive: true });
  lease(orphan, process.pid);
  assert.deepEqual(engine.recover(id).repairs, []);
  assert.ok(!existsSync(orphan), 'the orphaned owner record stayed as junk');
});

test('a neighbour took the intent between the check and the link — the send does not refuse', async (t) => {
  // The race whole, in one process and deterministically: the seam hits
  // exactly the window — the commit point is passed, `completeFanout` has
  // not started yet — and the neighbour is played by our own recovery,
  // which our pid on the intent lets pick it up. It materialises the canon
  // and takes the intent down, and the owner arrives at `link` on a vanished
  // source.
  const root = sandbox();
  let stolen = false;
  let id = null;
  const engine = openEngine({
    root,
    policy: allowAll,
    now: clock(),
    recover: false,
    faults: (step) => {
      if (step !== 'intent' || stolen) return;
      stolen = true;
      engine.recover(id);
    },
  });
  id = taskWith(engine);
  const sent = await engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'один раз' });
  await t.test('the send returned success, not a refusal on what was already delivered', () => {
    assert.ok(stolen, 'the race was not reproduced — there was no neighbour');
    assert.equal(sent.message.body, 'один раз');
  });
  await t.test('delivered exactly once', () => {
    assert.equal(engine.unread(id, 'w-api'), 1);
    assert.deepEqual(engine.read(id, 'w-api').messages.map((m) => m.id), [sent.message.id]);
  });
  await t.test('the intent and the owner record are taken down', () => {
    assert.deepEqual(readdirSync(path.join(engine.home, 'tasks', id, 'intents')), []);
  });
});

test('the intent is gone and there is no canon — the refusal stays a refusal', async () => {
  // The second outcome of the same window: neither an intent nor a canon —
  // this is not "materialised by another", it is a real loss, and it must
  // not be tolerated.
  const root = sandbox();
  let taken = false;
  const engine = openEngine({
    root,
    policy: allowAll,
    now: clock(),
    recover: false,
    faults: (step, info) => {
      if (step !== 'intent' || taken) return;
      taken = true;
      rmSync(path.join(root, '.promptobus', 'tasks', info.task, 'intents', `${info.message}.json`));
    },
  });
  const id = taskWith(engine);
  const e = await refusalAsync(() => engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'потеря' }));
  assert.ok(e instanceof PromptobusError, String(e));
  assert.equal(e.code, 'link-refused');
  assert.equal(e.context.errno, 'ENOENT');
  assert.equal(engine.unread(id, 'w-api'), 0);
});

test('a torn intent is isolated, and the task keeps working', async () => {
  const root = sandbox();
  const engine = open(root);
  const id = taskWith(engine);
  const { message } = await engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'целое' });
  // A crash inside the commit point is the only form of intent spoilage:
  // `wx` creates the file atomically, and the contents are written after.
  const torn = path.join(engine.home, 'tasks', id, 'intents', '20260902T100500000-0009-abcdef.json');
  mkdirSync(path.dirname(torn), { recursive: true });
  writeFileSync(torn, '{"protocolVersion":1,"id":"2026');
  // It is isolated only when the owner is recognised as abandoned: for a
  // live neighbour half a record is lawful in exactly the same way — the
  // file is created, the contents are still being written. There is no
  // owner record on this half, so age makes it abandoned.
  backdate(torn);
  const healed = openEngine({ root, policy: allowAll, now: clock() });
  assert.equal(healed.recover(id).broken.length, 0, 'isolation happened at open, not later');
  assert.ok(existsSync(path.join(healed.home, 'tasks', id, 'broken', 'messages', path.basename(torn))));
  assert.ok(!existsSync(torn));
  assert.deepEqual(healed.read(id, 'w-api').messages.map((m) => m.id), [message.id]);
});

test('a torn intent of a live neighbour stays in place until the owner is abandoned', () => {
  // Half a record is a lawful state of a live neighbour: `wx` created the
  // file atomically, the contents are written after, and its half is
  // visible. The lease gate sits BEFORE the record parse for that reason;
  // move it under the parse — a fresh half would leave for `broken`, and
  // the owner would arrive at `link` on a vanished source. The neighbouring
  // check above about the same only catches an AGED record, and both gate
  // positions give the same green on it.
  const root = sandbox();
  const engine = open(root);
  const id = taskWith(engine);
  const torn = path.join(engine.home, 'tasks', id, 'intents', '20260902T100600000-0011-abcdef.json');
  mkdirSync(path.dirname(torn), { recursive: true });
  writeFileSync(torn, '{"protocolVersion":1,"id":"2026');
  const healed = openEngine({ root, policy: allowAll, now: clock(), recover: false });
  assert.deepEqual(healed.recover(id).broken, [], 'half a record of a live neighbour was declared spoilage');
  assert.ok(existsSync(torn), 'half a record of a live neighbour was taken into broken');
  assert.ok(!existsSync(path.join(healed.home, 'tasks', id, 'broken', 'messages')),
    'the isolation directory was created on a clean slate');
});

// ── Mailbox and history ─────────────────────────────────────────────────────────────────

test('a read moves the link to history and does not return what was already read', async () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  await engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'раз' });
  await engine.send(id, { from: 'owner', to: ['w-api'], type: 'status', body: 'два' });
  assert.deepEqual(engine.read(id, 'w-api').messages.map((m) => m.body), ['раз', 'два']);
  assert.deepEqual(engine.read(id, 'w-api').messages, []);
  assert.equal(engine.unread(id, 'w-api'), 0);
  assert.equal(readdirSync(path.join(engine.home, 'tasks', id, 'history', 'w-api')).length, 2);
});

test('a link in inbox and a record in history read the same contents', async () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  const { message } = await engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'то же самое' });
  const root = path.join(engine.home, 'tasks', id);
  const inInbox = readFileSync(path.join(root, 'inbox', 'w-api', `${message.id}.json`), 'utf8');
  engine.read(id, 'w-api');
  const inHistory = readFileSync(path.join(root, 'history', 'w-api', `${message.id}.json`), 'utf8');
  const canonical = readFileSync(path.join(root, 'messages', `${message.id}.json`), 'utf8');
  assert.equal(inInbox, canonical);
  assert.equal(inHistory, canonical);
});

test('a broken message in the mailbox leaves for broken, and the rest arrive', async () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  await engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'целое' });
  const box = path.join(engine.home, 'tasks', id, 'inbox', 'w-api');
  writeFileSync(path.join(box, '20260902T100900000-0009-ffffff.json'), '{битое');
  const { messages, broken } = engine.read(id, 'w-api');
  assert.deepEqual(messages.map((m) => m.body), ['целое']);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].code, 'schema-invalid');
  assert.ok(existsSync(path.join(engine.home, 'tasks', id, 'broken', 'inbox', 'w-api',
    '20260902T100900000-0009-ffffff.json')));
});

test('a message of a newer version is not isolated, it is named by its own code', async () => {
  // Spoilage and "nothing to read with" are different outcomes: a record
  // from the future is fixed by updating the mechanism, not by isolation,
  // and taking it into broken would mean losing it.
  const engine = open(sandbox());
  const id = taskWith(engine);
  await engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'целое' });
  const box = path.join(engine.home, 'tasks', id, 'inbox', 'w-api');
  const name = '20260902T101000000-0009-eeeeee.json';
  writeFileSync(path.join(box, name), JSON.stringify({
    protocolVersion: 2, id: name.slice(0, -5), task: id, sender: 'owner', recipients: ['w-api'],
    type: 'task', body: 'из будущего', ts: '2026-09-02T10:10:00.000Z',
  }));
  const { messages, broken } = engine.read(id, 'w-api');
  assert.deepEqual(messages.map((m) => m.body), ['целое']);
  assert.equal(broken[0].code, 'schema-version-unsupported');
  assert.ok(existsSync(path.join(box, name)), 'the record from the future stayed in place');
});

test('history: page by page, oldest to newest, last 50 by default', async (t) => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  for (let i = 0; i < 60; i += 1) {
    await engine.send(id, { from: 'owner', to: ['w-api'], type: 'status', body: `п${String(i).padStart(2, '0')}` });
  }
  engine.read(id, 'w-api');
  const page = engine.history({ task: id, participant: 'w-api' });
  await t.test('history: 50 last by default, oldest to newest', () => {
    assert.equal(page.entries.length, 50);
    assert.equal(page.entries[0].message.body, 'п10');
    assert.equal(page.entries.at(-1).message.body, 'п59');
  });
  await t.test('history: the cursor gives the older page, without repeats on the boundary', () => {
    const older = engine.history({ task: id, participant: 'w-api', before: page.cursor, limit: 50 });
    assert.equal(older.entries.length, 10);
    assert.equal(older.entries[0].message.body, 'п00');
    assert.equal(older.entries.at(-1).message.body, 'п09');
    assert.equal(older.cursor, null, 'no older pages left');
    const seen = new Set([...page.entries, ...older.entries].map((e) => e.message.id));
    assert.equal(seen.size, 60);
  });
  await t.test('history: all lifts the limit entirely', () => {
    assert.equal(engine.history({ task: id, participant: 'w-api', all: true }).entries.length, 60);
  });
  await t.test('history: unread is not in it', async () => {
    await engine.send(id, { from: 'owner', to: ['w-api'], type: 'status', body: 'непрочитанное' });
    const all = engine.history({ task: id, participant: 'w-api', all: true });
    assert.equal(all.entries.length, 60);
    assert.equal(engine.unread(id, 'w-api'), 1);
  });
});

test('history: a page boundary does not cut a group of records of one message', async (t) => {
  // One message to two recipients is TWO history records, and the limit
  // counts records, not messages. A cursor by message id cut the next page
  // by a whole group: records of the same message left of the cut did not
  // land in any page at all.
  const engine = open(sandbox());
  const id = taskWith(engine);
  for (let i = 0; i < 3; i += 1) {
    await engine.send(id, { from: 'owner', to: ['w-api', 'w-docs'], type: 'status', body: `м${i}` });
  }
  for (const who of ['w-api', 'w-docs']) engine.read(id, who);
  const whole = engine.history({ task: id, all: true });
  const page = engine.history({ task: id, limit: 3 });
  const older = engine.history({ task: id, limit: 3, before: page.cursor });
  const seen = (p) => p.entries.map((e) => `${e.message.id} ${e.participant}`);
  await t.test('group boundary: the pages give exactly 3 and 3 records', () => {
    assert.equal(whole.entries.length, 6);
    assert.equal(page.entries.length, 3);
    assert.equal(older.entries.length, 3);
  });
  await t.test('group boundary: two pages cover the history whole and without repeats', () => {
    const both = [...seen(older), ...seen(page)];
    assert.equal(new Set(both).size, 6, `lost or doubled: ${both.join(' | ')}`);
    assert.deepEqual(both, seen(whole));
  });
  await t.test('group boundary: no older pages left', () => {
    assert.equal(older.cursor, null);
  });
});

test('history without a participant collects everyone, without a task — all tasks', async () => {
  const engine = open(sandbox());
  const first = taskWith(engine, 'one-t20260902-100000');
  const second = taskWith(engine, 'two-t20260902-100001');
  await engine.send(first, { from: 'owner', to: ['w-api', 'w-docs'], type: 'task', body: 'первой' });
  await engine.send(second, { from: 'owner', to: ['w-api'], type: 'task', body: 'второй' });
  for (const [task, who] of [[first, 'w-api'], [first, 'w-docs'], [second, 'w-api']]) engine.read(task, who);
  // One message sitting with two is two history records: the addressees
  // are different.
  assert.equal(engine.history({ task: first, all: true }).entries.length, 2);
  assert.equal(engine.history({ all: true }).entries.length, 3);
  assert.deepEqual(engine.history({ participant: 'w-docs', all: true }).entries.map((e) => e.message.body), ['первой']);
});

// ── Artifacts ─────────────────────────────────────────────────────────────────────────

test('artifact: streaming SHA-256, deduplication, and different names on one digest', async (t) => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  const file = path.join(SB, 'artifact-a.patch');
  writeFileSync(file, 'одно и то же содержимое\n');
  const copy = path.join(SB, 'artifact-b.patch');
  writeFileSync(copy, 'одно и то же содержимое\n');

  const first = await engine.send(id, { from: 'owner', to: ['w-api'], type: 'artifact', body: 'раз', artifact: { path: file } });
  const second = await engine.send(id, { from: 'owner', to: ['w-api'], type: 'artifact', body: 'два', artifact: { path: copy } });

  await t.test('artifact: two names, two metadata records, one blob', () => {
    assert.equal(first.artifact.sha256, second.artifact.sha256);
    assert.notEqual(first.artifact.id, second.artifact.id);
    assert.deepEqual([first.artifact.filename, second.artifact.filename], ['artifact-a.patch', 'artifact-b.patch']);
    assert.deepEqual(readdirSync(path.join(engine.home, 'tasks', id, 'blobs')), [first.artifact.sha256]);
    assert.equal(engine.listArtifacts(id).artifacts.length, 2);
  });
  await t.test('artifact: the message carries the metadata id, the contents are read by it', () => {
    assert.equal(first.message.artifact, first.artifact.id);
    assert.equal(engine.readArtifactContent(id, first.artifact.id).toString(), 'одно и то же содержимое\n');
  });
  await t.test('artifact: the size is written from what was read, not from what was declared', () => {
    assert.equal(first.artifact.size, Buffer.byteLength('одно и то же содержимое\n'));
  });
});

test('an artifact from a stream: the digest is counted on the write pass', async () => {
  // The stream is read exactly once — it has no second read at all. A
  // non-streaming digest ("read the file and count") does not close this
  // case in any way.
  const engine = open(sandbox());
  const id = taskWith(engine);
  const body = 'кусок один|кусок два|кусок три';
  const sent = await engine.send(id, {
    from: 'owner',
    to: ['w-api'],
    type: 'artifact',
    body: 'из потока',
    artifact: { stream: Readable.from(body.split('|')), filename: 'stream.txt' },
  });
  assert.equal(sent.artifact.size, Buffer.byteLength(body.replaceAll('|', '')));
  assert.equal(engine.readArtifactContent(id, sent.artifact.id).toString(), body.replaceAll('|', ''));
});

test('a bad artifact name refuses BEFORE the blob', async (t) => {
  // A name caught by the schema only after the blob write would leave
  // contents in the task without metadata — an orphan blob on a clean
  // slate, living until `prune` itself (review remark).
  const engine = open(sandbox());
  const id = taskWith(engine);
  const cases = [
    ['empty name on a stream', { stream: Readable.from(['данные']), filename: '' }],
    ['a path separator in the name', { stream: Readable.from(['данные']), filename: 'sub/x.txt' }],
    ['a directory name', { stream: Readable.from(['данные']), filename: '..' }],
  ];
  for (const [what, artifact] of cases) {
    await t.test(`artifact name: ${what} — code artifact-source`, async () => {
      const e = await refusalAsync(() => engine.send(id, {
        from: 'owner', to: ['w-api'], type: 'artifact', body: 'дифф', artifact,
      }));
      assert.equal(e.code, 'artifact-source');
    });
  }
  await t.test('artifact name: not one blob appeared in the task', () => {
    assert.ok(!existsSync(path.join(engine.home, 'tasks', id, 'blobs')));
    assert.equal(engine.orphanBlobs(id).length, 0);
  });
});

test('artifact: a digest mismatch on read is a typed refusal', async (t) => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  const file = path.join(SB, 'integrity.patch');
  writeFileSync(file, 'исходное содержимое\n');
  const sent = await engine.send(id, { from: 'owner', to: ['w-api'], type: 'artifact', body: 'дифф', artifact: { path: file } });
  const blob = path.join(engine.home, 'tasks', id, 'blobs', sent.artifact.sha256);
  await t.test('artifact: before spoilage it is read whole', () => {
    assert.equal(engine.readArtifactContent(id, sent.artifact.id).toString(), 'исходное содержимое\n');
  });
  await t.test('artifact: substituted contents are not given out silently', () => {
    rmSync(blob);
    writeFileSync(blob, 'подменённое содержимое\n');
    const e = refusal(() => engine.readArtifactContent(id, sent.artifact.id));
    assert.equal(e.code, 'artifact-integrity');
    assert.equal(e.context.declared, sent.artifact.sha256);
    assert.notEqual(e.context.actual, sent.artifact.sha256);
  });
  await t.test('artifact: a vanished blob is its own code, not integrity', () => {
    rmSync(blob);
    assert.equal(refusal(() => engine.readArtifactContent(id, sent.artifact.id)).code, 'artifact-not-found');
  });
});

test('artifact: broken metadata is isolated, the other task records are read', async () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  const file = path.join(SB, 'meta.patch');
  writeFileSync(file, 'дифф\n');
  const sent = await engine.send(id, { from: 'owner', to: ['w-api'], type: 'artifact', body: 'дифф', artifact: { path: file } });
  const dir = path.join(engine.home, 'tasks', id, 'artifacts');
  writeFileSync(path.join(dir, '20260902T101100000-0009-cccccc.json'), '{битое');
  const listed = engine.listArtifacts(id);
  assert.deepEqual(listed.artifacts.map((a) => a.id), [sent.artifact.id]);
  assert.equal(listed.broken.length, 1);
  assert.ok(existsSync(path.join(engine.home, 'tasks', id, 'broken', 'artifacts',
    '20260902T101100000-0009-cccccc.json')));
});

test('an orphan blob sits until prune, and prune takes the task whole', async (t) => {
  const root = sandbox();
  const file = path.join(SB, 'orphan.patch');
  writeFileSync(file, 'содержимое без имени\n');
  // A crash between the blob and the metadata leaves the contents without
  // a single reference to them.
  const broken = crashAt(root, 'blob', { at: 0 });
  const id = taskWith(broken);
  await refusalAsync(() => broken.send(id, {
    from: 'owner', to: ['w-api'], type: 'artifact', body: 'дифф', artifact: { path: file },
  }));
  const engine = openEngine({ root, policy: allowAll, now: clock() });
  await t.test('orphan blob: the contents sit, there is no metadata on them', () => {
    assert.equal(engine.orphanBlobs(id).length, 1);
    assert.deepEqual(engine.listArtifacts(id).artifacts, []);
  });
  await t.test('orphan blob: recovery does not touch it', () => {
    engine.recover(id);
    assert.equal(engine.orphanBlobs(id).length, 1);
  });
  await t.test('prune of an active task refuses', () => {
    assert.equal(refusal(() => engine.prune(id)).code, 'task-active');
    assert.ok(existsSync(path.join(engine.home, 'tasks', id)));
  });
  await t.test('prune of a closed one takes both the blobs and the correspondence', () => {
    engine.closeTask(id);
    const pruned = engine.prune(id);
    assert.equal(pruned.blobs, 1);
    assert.ok(pruned.bytes > 0);
    assert.ok(!existsSync(path.join(engine.home, 'tasks', id)));
  });
});

// ── Isolation of a damaged task ──────────────────────────────────────────────────────

test('a damaged task blocks only itself', async (t) => {
  const engine = open(sandbox());
  const healthy = taskWith(engine, 'zhivaya-t20260902-100000');
  const sick = taskWith(engine, 'bitaya-t20260902-100001');
  await engine.send(healthy, { from: 'owner', to: ['w-api'], type: 'task', body: 'работает' });
  writeFileSync(path.join(engine.home, 'tasks', sick, 'task.json'), '{обрезанный журнал');

  await t.test('the listing returns the healthy and names the spoiled', () => {
    const listed = engine.listTasks();
    assert.deepEqual(listed.tasks.map((t2) => t2.id), [healthy]);
    assert.equal(listed.broken.length, 1);
    // A spoiled task is named as a PAIR, not as a ready string: id and
    // reason arrive separately, because the text for a person is assembled
    // by the adapter — it still needs the file path.
    assert.equal(listed.broken[0].id, sick);
    assert.match(listed.broken[0].note, /did not parse/);
  });
  await t.test('reading the spoiled one refuses with its own code', () => {
    assert.equal(refusal(() => engine.readTask(sick)).code, 'task-broken');
  });
  await t.test('the healthy task keeps working', () => {
    assert.deepEqual(engine.read(healthy, 'w-api').messages.map((m) => m.body), ['работает']);
  });
  await t.test('recovery across all tasks does not stumble on the spoiled one', () => {
    assert.deepEqual(engine.recover().repairs, []);
  });
});

// ── a mix of mechanism versions ────────────────────────────────────────────────────
//
// After `sync` a live session keeps working with the bus MCP server raised
// at its start from the PREVIOUS release, and a worker of the new release
// puts in the journal a record with a capabilities snapshot the former
// validator does not know. This does not weaken the schema: an unfamiliar
// field is still a refusal. What differs is the TEXT and the code — "start
// a new session" instead of "the journal does not match the schema", because
// it is cured by a new session, not by fixing the journal.
//
// The reader version is named by whoever opens the engine, and in this file
// the suite plays that part: the package has no module-level piggy bank —
// a foreign value arrives as an argument, like home and policy.

// A capabilities snapshot with a field the reader does not know: that is
// what a newer-mechanism record looks like — it has more fields of its own,
// and their names are unknown to the reader by construction.
const AHEAD_CAPS = { ...CAPS, resume: true };

// The journal is assembled each time from the ORIGINAL snapshot, not from
// what sits on disk after a neighbouring check: metadata fields merge, and
// the version of the previous edition would reach the "there is no version
// in the record" check.
const pristine = new Map();

// Addresses of the fixture participants: a refusal names the address to a
// person, not the mailbox-directory id.
const ADDRESS = { owner: 'orchestrator', 'w-api': 'worker:api', 'w-docs': 'worker:docs' };

/**
 * A journal where the participant record `on` was made by mechanism version
 * `version`, and its capabilities snapshot is `caps`. `marked` also marks
 * someone else with a version, without touching their snapshot: that is
 * what the journal looks like after `sync` — the new CLI rewrites the
 * owner too.
 */
function journalFrom(engine, id, { version, caps = AHEAD_CAPS, patch = {}, on = 'w-api', marked = {} }) {
  const file = path.join(engine.home, 'tasks', id, 'task.json');
  if (!pristine.has(file)) pristine.set(file, readFileSync(file, 'utf8'));
  const meta = JSON.parse(pristine.get(file));
  const versions = { ...marked, ...(version === null ? {} : { [on]: version }) };
  const participants = meta.participants.map((p) => ({
    ...p,
    ...(p.id === on ? { capabilities: caps } : {}),
    metadata: {
      ...p.metadata,
      address: ADDRESS[p.id] ?? p.id,
      ...(versions[p.id] ? { [MECHANISM_VERSION_FIELD]: versions[p.id] } : {}),
    },
  }));
  writeFileSync(file, JSON.stringify({ ...meta, participants, ...patch }, null, 2));
  return file;
}

test('a record of a mechanism newer than the reader — the refusal calls for a new session, not to fix the journal', async (t) => {
  const engine = open(sandbox(), { cli: '0.63.0' });
  const id = taskWith(engine);

  await t.test('extra fields plus a newer version — its own code and honest text', () => {
    journalFrom(engine, id, { version: '0.64.0' });
    const e = refusal(() => engine.readTask(id));
    assert.equal(e.code, 'schema-version-unsupported');
    // The text names BOTH versions, the participant, and the cure: without
    // the cure a person fixes a journal that is whole.
    assert.match(e.message, /participant worker:api was written by mechanism 0\.64\.0/);
    assert.match(e.message, /this session runs 0\.63\.0/);
    assert.match(e.message, /start a new session/);
    assert.match(e.message, /the bus MCP server starts from the installed release/);
    assert.equal(e.context.participant, 'worker:api');
  });

  await t.test('the same extra fields without a version on the record — the former refusal in the former text', () => {
    journalFrom(engine, id, { version: null });
    const e = refusal(() => engine.readTask(id));
    assert.equal(e.code, 'task-broken');
    assert.match(e.message, /does not match the schema/);
    assert.ok(!/start a new session/.test(e.message), e.message);
  });

  // The second move of the mutation probe: a naive edition "version ≠ mine
  // — a mix of versions" must redden both checks below, because both name
  // a version different from the reader only the other way, or not
  // different at all.
  await t.test('a version on the record OLDER than the reader — the former refusal, not a mix of versions', () => {
    journalFrom(engine, id, { version: '0.62.0' });
    const e = refusal(() => engine.readTask(id));
    assert.equal(e.code, 'task-broken');
    assert.ok(!/start a new session/.test(e.message), e.message);
  });

  await t.test('a version on the record EQUAL to the reader version — the former refusal', () => {
    journalFrom(engine, id, { version: '0.63.0' });
    assert.equal(refusal(() => engine.readTask(id)).code, 'task-broken');
  });

  // The first move of the probe on the "there are extra fields" condition:
  // the journal is newer, but the breakage is not in them — that is
  // spoilage, and it is cured by isolating the task, not by a new session.
  await t.test('a newer version, and the breakage is not in the extra fields — the former task-broken', () => {
    journalFrom(engine, id, { version: '0.64.0', caps: CAPS, patch: { title: '' } });
    const e = refusal(() => engine.readTask(id));
    assert.equal(e.code, 'task-broken');
    assert.match(e.message, /does not match the schema/);
    assert.ok(!/start a new session/.test(e.message), e.message);
  });

  // The named participant is the one whose record the validator stumbled
  // on, not the first one with a marker: `sync` rewrites the owner too,
  // and they are first in the journal.
  await t.test('the participant named is the one whose record the validator stumbled on, not the first with a marker', () => {
    journalFrom(engine, id, { version: '0.64.0', on: 'w-docs', marked: { owner: '0.64.0' } });
    const e = refusal(() => engine.readTask(id));
    assert.equal(e.code, 'schema-version-unsupported');
    assert.equal(e.context.participant, 'worker:docs');
    assert.match(e.message, /participant worker:docs/);
  });

  // A placement guard of the check: it lives INSIDE the invalid-verdict
  // branch, and a valid journal has no right to stumble on the version
  // by itself.
  await t.test('a newer version, no extra fields — the journal is read as usual', () => {
    journalFrom(engine, id, { version: '0.64.0', caps: CAPS });
    assert.equal(engine.readTask(id).id, id);
  });
});

test('the reader version is not named at open — the former path whole', () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  journalFrom(engine, id, { version: '99.0.0' });
  assert.equal(refusal(() => engine.readTask(id)).code, 'task-broken');
});

test('a journal of a newer version is not declared spoiled', () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  const file = path.join(engine.home, 'tasks', id, 'task.json');
  const meta = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...meta, schemaVersion: 2 }, null, 2));
  assert.equal(refusal(() => engine.readTask(id)).code, 'schema-version-unsupported');
});


// The journal arrives in place through `rename`, like a message: a hard
// link on the former file holds the former contents. Written over itself
// (`writeFileSync`) it would change by the link too — and between truncate
// and write a parallel reader sees an empty file and answers "the journal
// does not read" about a live task. The subject is the engine `writeTask`,
// and the mutation probe on it is substituting `writeJsonAtomic` with
// `writeFileSync` in `v1/store.ts`.
test('the journal is not written over itself — the new file stands through rename', () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  const file = path.join(engine.home, 'tasks', id, 'task.json');
  const held = path.join(engine.home, 'held-journal.json');
  linkSync(file, held);
  engine.patchTask(id, { title: 'переименована' });
  assert.equal(JSON.parse(readFileSync(held, 'utf8')).title, 'демо', 'the former link saw the new record');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).title, 'переименована');
});
