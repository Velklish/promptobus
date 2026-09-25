// Multi-process contention of protocol v1: send, read, and recovery by real
// processes, and a real process death mid-fan-out.
//
// Real ones, not promises in one process: the subject of the check is the
// atomic file-system primitives (`wx` on the intent, `link` on the links,
// `rename` on a read), and inside one process they never meet themselves.
// The legacy store suite is built the same way
// ([races.test.mjs](races.test.mjs)), and the barrier here is the same:
// without it the children line up by start time, and the window that is
// being fixed never arrives at all.
// Home diversion before any import that is not a Node built-in: a module that
// resolved a home path at load would see the real one. [home.mjs](home.mjs) says
// what it applies; the sentinel in tmpdir-sweep.test.mjs keeps the order.
import './home.mjs';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { Readable } from 'node:stream';

import { ERROR_CODES, openEngine, PromptobusError } from '../dist/index.js';
import { withDirLock, withDirLockAsync } from '../dist/fs/lock.js';

const DIST = new URL('../dist/index.js', import.meta.url).href;
const STATUS = new URL('../lib/status.js', import.meta.url).href;
const HISTORY = new URL('../lib/history.js', import.meta.url).href;
const PRUNE = new URL('../lib/prune.js', import.meta.url).href;
const SWEEP = new URL('../lib/sweep.js', import.meta.url).href;
const SB = mkdtempSync(path.join(os.tmpdir(), 'promptobus-v1-races-'));
process.on('exit', () => rmSync(SB, { recursive: true, force: true }));

const J = JSON.stringify;
const CAPS = { spawn: true, attach: true, activation: 'push', inspect: true, stop: true };
const person = (id, role) => ({
  id, role, harness: 'fake', mode: 'managed', sessionRef: `sess-${id}`, capabilities: CAPS, metadata: {},
});
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

function open(root, options = {}) {
  return openEngine({ root, policy: allowAll, ...options });
}

function taskWith(engine, id) {
  engine.createTask({ id, title: 'гонка', owner: person('owner', 'orchestrator') });
  for (const who of ['w-api', 'w-docs']) engine.addParticipant(id, person(who, 'worker'));
  return id;
}

// Child report "reached the barrier". The first line of its stdout is not
// returned into the checks.
const READY = '__ready__';

// A child process with code on stdin: exit code, stdout, and stderr in one
// resolve. `open` inside is assembled by the same line as here: the engine
// at the child is real, and it needs a routing-policy rule too.
//
// The return code is taken from EVERY child, not only where it is asked:
// the body of a fallen child prints nothing, and its silence is
// indistinguishable from a lost message — a count check named the
// consequence as the cause. Resolve on `close`, not on `exit`: `exit`
// arrives before the pipes are read through, and the stderr tail would
// leave with the diagnosis.
//
// `ready` is the barrier hook: called exactly once, with the child stdin
// on the ready report, or with `null` if the child died without reporting.
// The second is required: a fallen child would otherwise lock the barrier
// forever.
function child(body, { ready = null } = {}) {
  const code = `const m = await import(${J(DIST)});\n`
    + 'const open = (root, extra = {}) => m.openEngine({ root, policy: () => ({ allow: true }), ...extra });\n'
    + body;
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

// All children exited zero — checked BEFORE any count of messages, links,
// and intents. The detail names the fallen one and carries its stderr: the
// diagnosis sits there, not in the undercount number.
function exitedZero(kids, who = (i) => `#${i}`) {
  const dead = kids.map((k, i) => ({ ...k, who: who(i) })).filter((k) => k.code !== 0);
  assert.equal(dead.length, 0, dead
    .map((k) => `child ${k.who} exited with code ${k.code}: ${k.err || 'stderr empty'}`).join('\n'));
}

// Barrier: children report ready and sleep on a stdin read, and the parent
// releases everyone at once when all have gathered.
//
// By readiness, not by a shared time mark. A mark gave a head start for
// node launch and the `dist` import, and was calibrated for a quiet
// machine: under load (load average 40) some children entered the barrier
// already AFTER the mark, and the race degenerated into an almost
// sequential start. Waiting on stdin is a block, not a spin: the former
// `while (Date.now() < at) {}` burned each child's CPU until the mark.
// Taking stdin off the read after the release is required: left in the
// stream, it would hold the child event loop alive after the race too.
function racers(n, body) {
  const doors = [];
  let seen = 0;
  let gathered = null;
  const all = new Promise((r) => { gathered = r; });
  const arrive = (stdin) => {
    if (stdin) {
      // The error listener — at once when the door is laid, not at
      // release: a child that reported ready and died at once would leave
      // a pipe without a listener, and EPIPE would bring the suite down.
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
    // A child could die between the report and the release: EPIPE here is
    // not a stand refusal, and the error listener on the door has stood
    // since it was laid.
    for (const door of doors) door.end('go\n');
    return Promise.all(kids);
  });
}

// ── Concurrent send ─────────────────────────────────────────────────────────────

test('two processes send into one mailbox — nothing is lost and sender order is intact', async (t) => {
  const root = sandbox();
  const id = taskWith(open(root), 'otpravka-t20260902-110000');
  const PER = 20;
  const kids = await racers(2,
    `const e = open(${J(root)});\n`
    + `for (let k = 0; k < ${PER}; k += 1) {\n`
    + `  await e.send(${J(id)}, { from: 'w-' + (i ? 'docs' : 'api'), to: ['owner'], type: 'status', body: i + '#' + k });\n`
    + '}\n');
  const { messages } = open(root).read(id, 'owner');
  const sender = (i) => ['w-api', 'w-docs'][i];
  await t.test('concurrent send: both processes wrote, nothing is lost', () => {
    exitedZero(kids, sender);
    assert.equal(messages.length, PER * 2);
  });
  await t.test('concurrent send: each sender order is preserved', () => {
    exitedZero(kids, sender);
    for (const line of [0, 1]) {
      const own = messages.filter((m) => m.body.startsWith(`${line}#`)).map((m) => Number(m.body.split('#')[1]));
      assert.equal(own.length, PER);
      assert.deepEqual(own, own.map((_, k) => k));
    }
  });
  await t.test('concurrent send: no unclosed intents or temp files left', () => {
    exitedZero(kids, sender);
    const taskRoot = path.join(open(root).home, 'tasks', id);
    assert.deepEqual(readdirSync(path.join(taskRoot, 'intents')), []);
    assert.deepEqual(readdirSync(path.join(taskRoot, 'messages')).filter((n) => n.startsWith('.')), []);
  });
});

test('eight processes create one task — success for exactly one', async () => {
  const root = sandbox();
  const id = 'sozdanie-t20260902-110100';
  const owner = J(person('owner', 'orchestrator'));
  const kids = await racers(8,
    `try { open(${J(root)}).createTask({ id: ${J(id)}, title: 'линия ' + i, owner: ${owner} });\n`
    + "  console.log('ok ' + i);\n"
    + "} catch (e) { console.log('busy ' + (e.code || e.message)); }");
  exitedZero(kids);
  const created = kids.map((k) => k.out);
  const winners = created.filter((r) => r.startsWith('ok'));
  assert.equal(winners.length, 1, created.join(', '));
  assert.ok(created.filter((r) => r.startsWith('busy')).every((r) => r.endsWith('task-exists')), created.join(', '));
  assert.equal(open(root).readTask(id).title, `линия ${winners[0].split(' ')[1]}`);
});

// ── Concurrent read ───────────────────────────────────────────────────────────────

test('two readers of one mailbox — neither a refusal nor a doubled message', async (t) => {
  const root = sandbox();
  const engine = open(root);
  const id = taskWith(engine, 'chtenie-t20260902-110200');
  const LETTERS = 120;
  for (let k = 0; k < LETTERS; k += 1) {
    await engine.send(id, { from: 'owner', to: ['w-api'], type: 'status', body: `п${k}` });
  }
  const kids = await racers(2,
    `try { const r = open(${J(root)}, { recover: false }).read(${J(id)}, 'w-api');\n`
    + "  console.log(r.messages.map((x) => x.body).join(' '));\n"
    + "} catch (e) { console.log('ОТКАЗ ' + (e.code || e.message)); }");
  const readers = kids.map((k) => k.out);
  // A refusing reader is not taken into the count: its output is not
  // messages, it is a diagnosis, and in the sum it would lie upward on
  // exactly the mutation this check stands for.
  const delivered = readers.filter((r) => !r.startsWith('ОТКАЗ')).flatMap((r) => r.split(' ')).filter(Boolean);
  await t.test('two readers: no refusal, not one message is lost', () => {
    exitedZero(kids);
    assert.ok(!readers.some((r) => r.startsWith('ОТКАЗ')), readers.filter((r) => r.startsWith('ОТКАЗ')).join(', '));
    assert.equal(delivered.length, LETTERS);
  });
  await t.test('two readers: not one message went to both', () => {
    exitedZero(kids);
    assert.equal(new Set(delivered).size, LETTERS);
  });
  await t.test('two readers: the mailbox is empty, and everything read sits in history', () => {
    exitedZero(kids);
    assert.equal(open(root).unread(id, 'w-api'), 0);
    assert.equal(open(root).history({ task: id, participant: 'w-api', all: true }).entries.length, LETTERS);
  });
});

// ── A real process death mid-fan-out ──────────────────────────────────────

test('a process dies mid-fan-out — recovery takes delivery to the end', async (t) => {
  // Exactly the state a throw from the seam in one process gives — but
  // obtained by a real process death: without this, a "crash" would stay
  // a model of a crash.
  const root = sandbox();
  const id = taskWith(open(root), 'padenie-t20260902-110300');
  const died = await child(
    `const e = open(${J(root)}, { recover: false, faults: (step) => { if (step === 'ref') process.exit(7); } });\n`
    + `await e.send(${J(id)}, { from: 'owner', to: ['w-api', 'w-docs'], type: 'task', body: 'обоим' });\n`);
  await t.test('crash: the process died at the ref point', () => {
    assert.equal(died.code, 7, died.err || 'stderr empty');
  });
  await t.test('crash: an unclosed intent and one link of two stayed on disk', () => {
    const noHeal = openEngine({ root, policy: allowAll, recover: false });
    assert.equal(openIntents(path.join(noHeal.home, 'tasks', id, 'intents')).length, 1);
    assert.equal(noHeal.unread(id, 'w-api') + noHeal.unread(id, 'w-docs'), 1);
  });
  await t.test('crash: opening the engine appends what is missing', () => {
    const healed = open(root);
    assert.equal(healed.unread(id, 'w-api'), 1);
    assert.equal(healed.unread(id, 'w-docs'), 1);
    assert.deepEqual(readdirSync(path.join(healed.home, 'tasks', id, 'intents')), []);
  });
});

test('concurrent recovery from four processes does not double delivery', async (t) => {
  const root = sandbox();
  const id = taskWith(open(root), 'vosstanovlenie-t20260902-110400');
  // Five undelivered fan-outs: each dies after the first link. The exit
  // code is checked on each: a child that did not start, rather than die,
  // would give a shortage of intents with the diagnosis "recovery did not
  // work" instead of "the process did not run".
  for (let k = 0; k < 5; k += 1) {
    const killed = await child(
      `const e = open(${J(root)}, { recover: false, faults: (step) => { if (step === 'ref') process.exit(7); } });\n`
      + `await e.send(${J(id)}, { from: 'owner', to: ['w-api', 'w-docs'], type: 'task', body: 'п${k}' });\n`);
    assert.equal(killed.code, 7, `sender п${k}: ${killed.err || 'stderr empty'}`);
  }
  const before = openEngine({ root, policy: allowAll, recover: false });
  assert.equal(openIntents(path.join(before.home, 'tasks', id, 'intents')).length, 5);

  const kids = await racers(4,
    `const r = open(${J(root)}, { recover: false }).recover(${J(id)});\n`
    + "console.log(r.repairs.flatMap((x) => x.recipients.map((p) => x.message + ':' + p)).join(','));");
  const healers = kids.map((k) => k.out);
  await t.test('concurrent recovery: not one process refused', () => {
    exitedZero(kids);
    assert.ok(healers.every((r) => !r.startsWith('ОТКАЗ')), healers.join(' | '));
  });
  await t.test('concurrent recovery: each recipient has exactly five links', () => {
    exitedZero(kids);
    const healed = open(root);
    assert.equal(healed.unread(id, 'w-api'), 5);
    assert.equal(healed.unread(id, 'w-docs'), 5);
    assert.deepEqual(readdirSync(path.join(healed.home, 'tasks', id, 'intents')), []);
  });
  await t.test('concurrent recovery: each recipient was named fresh by exactly one process', () => {
    exitedZero(kids);
    // Five senders died after the first link: recovery was left one link
    // per message, and only the process whose link landed is entitled to
    // name its recipient as fresh. Two who passed `delivered()` before
    // the other's `link` would otherwise name it both — and the warden
    // would send two notifications on one message.
    const pairs = healers.flatMap((r) => r.trim().split(',').filter(Boolean));
    assert.equal(pairs.length, 5, pairs.join(' '));
    assert.equal(new Set(pairs).size, 5, pairs.join(' '));
  });
  await t.test('concurrent recovery: a read returns each message once', () => {
    const healed = open(root);
    const bodies = healed.read(id, 'w-docs').messages.map((m) => m.body).sort();
    assert.deepEqual(bodies, ['п0', 'п1', 'п2', 'п3', 'п4']);
  });
});

test('recovery next to a read does not return what was already read', async () => {
  const root = sandbox();
  const id = taskWith(open(root), 'gonka-chteniya-t20260902-110500');
  for (let k = 0; k < 8; k += 1) {
    const killed = await child(
      `const e = open(${J(root)}, { recover: false, faults: (step) => { if (step === 'ref') process.exit(7); } });\n`
      + `await e.send(${J(id)}, { from: 'owner', to: ['w-api', 'w-docs'], type: 'task', body: 'п${k}' });\n`);
    assert.equal(killed.code, 7, `sender п${k}: ${killed.err || 'stderr empty'}`);
  }
  // Three recoverers and one reader at once: the reader takes links into
  // history, and the recoverers at the same time append the missing.
  // Checking TWO places — inbox and history — is what works here: without
  // it what was read would return to the reader a second time.
  const kids = await racers(4,
    `const e = open(${J(root)}, { recover: false });\n`
    + `if (i === 0) { const r = e.read(${J(id)}, 'w-api'); console.log('read ' + r.messages.map((m) => m.body).join(' ')); }\n`
    + `else { e.recover(${J(id)}); console.log('heal'); }\n`);
  exitedZero(kids);
  const out = kids.map((k) => k.out);
  const readLine = out.find((r) => r.startsWith('read')) ?? '';
  const gotFirst = readLine.slice('read '.length).split(' ').filter(Boolean);
  const engine = open(root);
  const gotSecond = engine.read(id, 'w-api').messages.map((m) => m.body);
  const all = [...gotFirst, ...gotSecond];
  assert.equal(new Set(all).size, all.length, `message delivered twice: ${all.join(' ')}`);
  assert.deepEqual([...all].sort(), ['п0', 'п1', 'п2', 'п3', 'п4', 'п5', 'п6', 'п7']);
});

test('opening the engine at a neighbour does not break an in-flight send', async (t) => {
  // A home with several writing processes is an ordinary run: the
  // orchestrator and the workers. The engine opens lazily, and open runs
  // recovery across all tasks of the home; without a lease it would pick
  // up not an abandoned fan-out of the dead, but an in-flight fan-out of
  // the live — take the intent down from under the owner, and they would
  // get `ENOENT` on `link`, that is a refusal on a message already
  // delivered. Here four send, four open the engine over and over: a
  // sender refusal is visible by the return code, not only by a shortage
  // in the count.
  const root = sandbox();
  const id = taskWith(open(root), 'lizing-t20260902-110700');
  const PER = 25;
  const kids = await racers(8,
    'if (i % 2 === 0) {\n'
    + `  const e = open(${J(root)});\n`
    + `  for (let k = 0; k < ${PER}; k += 1) {\n`
    + `    await e.send(${J(id)}, { from: 'w-api', to: ['owner'], type: 'status', body: i + '#' + k });\n`
    + '  }\n'
    + '} else {\n'
    + `  for (let k = 0; k < ${PER}; k += 1) open(${J(root)});\n`
    + '}\n');
  await t.test('not one sender refused', () => {
    exitedZero(kids);
  });
  await t.test('everything that was sent was delivered', () => {
    exitedZero(kids);
    assert.equal(open(root).unread(id, 'owner'), 4 * PER);
  });
  await t.test('no unclosed intents or orphaned leases left', () => {
    exitedZero(kids);
    assert.deepEqual(readdirSync(path.join(open(root).home, 'tasks', id, 'intents')), []);
  });
});

// ── Hard-link refusal ──────────────────────────────────────────────────────────────

test('an intent lost before materialize is permanent, not a retryable link refusal', async () => {
  const root = sandbox();
  const engine = open(root, { recover: false });
  const id = taskWith(engine, 'poterya-t20260902-110550');
  const interrupted = open(root, {
    recover: false,
    faults: (step) => { if (step === 'intent') throw new Error('injected crash after intent'); },
  });
  await assert.rejects(
    interrupted.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'will be lost' }),
    /injected crash after intent/,
  );
  const intents = path.join(engine.home, 'tasks', id, 'intents');
  const [intentName] = openIntents(intents);
  assert.ok(intentName, 'the interrupted send left no intent to race');
  const message = intentName.slice(0, -'.json'.length);
  const intent = path.join(intents, intentName);
  const canonical = path.join(engine.home, 'tasks', id, 'messages', intentName);
  let raced = 0;
  const report = open(root, {
    recover: false,
    faults: (step) => {
      if (step !== 'intent-materialize') return;
      raced += 1;
      rmSync(intent, { force: true });
      rmSync(canonical, { force: true });
    },
  }).recover(id);
  assert.deepEqual(report.failed.map((f) => ({ task: f.task, message: f.message, code: f.code })), [
    { task: id, message, code: 'intent-lost' },
  ]);
  assert.equal(raced, 1, 'recovery did not expose the loaded-intent/materialize race');
  assert.match(report.failed[0].note, /intent is gone and there is no canon/);
  assert.equal(existsSync(intent), false);
  assert.deepEqual(open(root, { recover: false }).recover(id).failed, [],
    'a permanently lost message was reported again as retryable');
});

test('the FS refused a hard link — a typed code, not a half-written record', async (t) => {
  // The FS requirement is inherited whole: hard links inside one volume.
  // Their absence is a lawful environment condition, and it must be
  // distinct from a mechanism breakage. It is pictured as a directory
  // without write permission: `link` returns `EACCES` where a foreign
  // volume would return `EXDEV`.
  //
  // Under root directory permissions do not apply at all — `link` goes
  // through, and there is nothing to picture the refusal with. The stand
  // has no way to get a refusal that root does not bypass: a second volume
  // is not kept under the test, and `chattr`/`chflags` are not portable.
  // So under `uid 0` the check skips itself out loud, rather than go green
  // on nothing. `getuid` is not everywhere — Windows does not have it, and
  // there the check runs as it did.
  if (process.getuid?.() === 0) {
    t.skip('under root directory permissions do not apply, a link refusal cannot be pictured; the check runs under an unprivileged user');
    return;
  }
  const root = sandbox();
  const engine = open(root);
  const id = taskWith(engine, 'ssylka-t20260902-110600');
  const box = path.join(engine.home, 'tasks', id, 'inbox', 'w-api');
  mkdirSync(box, { recursive: true });
  chmodSync(box, 0o500);
  let refused = null;
  try {
    await engine.send(id, { from: 'owner', to: ['w-api', 'w-docs'], type: 'task', body: 'не пройдёт' });
  } catch (e) {
    refused = e;
  }
  await t.test('link refusal: a typed code and errno in the context', () => {
    assert.ok(refused instanceof PromptobusError, String(refused));
    assert.equal(refused.code, 'link-refused');
    assert.ok(ERROR_CODES.includes(refused.code));
    assert.match(String(refused.context.errno), /^E[A-Z]+$/);
  });
  const intents = path.join(engine.home, 'tasks', id, 'intents');
  const [intentName] = openIntents(intents);
  assert.ok(intentName, 'the refused fan-out left no intent to recover');
  const message = intentName.slice(0, -'.json'.length);
  const neighbour = taskWith(engine, 'zdorovaya-t20260902-110601');
  const interrupted = open(root, {
    recover: false,
    faults: (step) => { if (step === 'intent') throw new Error('injected crash after the neighbouring intent'); },
  });
  await assert.rejects(
    interrupted.send(neighbour, { from: 'owner', to: ['w-api'], type: 'task', body: 'will recover' }),
    /injected crash after the neighbouring intent/,
  );
  await t.test('link refusal: recovery reports the affected operation and leaves it for retry', () => {
    const report = openEngine({ root, policy: allowAll, recover: false }).recover();
    assert.deepEqual(report.failed.map((f) => ({ task: f.task, message: f.message, code: f.code })), [
      { task: id, message, code: 'link-refused' },
    ]);
    assert.match(report.failed[0].note, /hard link was not created/);
    assert.deepEqual(report.repairs.map((r) => r.task), [neighbour],
      'the refused operation stopped recovery before the neighbouring task');
    assert.deepEqual(openIntents(intents), [intentName]);
  });
  await t.test('link refusal: open-time recovery returns while the refusal is held', () => {
    const reopened = openEngine({ root, policy: allowAll, recover: true });
    assert.equal(reopened.readTask(id).id, id);
    assert.deepEqual(openIntents(intents), [intentName]);
  });
  await t.test('link refusal: recovery does not catch a programmer failure', () => {
    const programmer = new Error('programmer failure injected after materialize');
    assert.throws(
      () => openEngine({
        root,
        policy: allowAll,
        recover: true,
        faults: (step) => { if (step === 'canonical') throw programmer; },
      }),
      (e) => e === programmer,
    );
  });
  await t.test('link refusal: status, history, and prune open independently and report recovery', async () => {
    // These are fresh processes. Mark the former owner dead so each one sees
    // an abandoned intent immediately instead of waiting out the stale lease.
    writeFileSync(path.join(intents, `${message}.owner`),
      `${JSON.stringify({ pid: 2_147_483_647, host: os.hostname() })}\n`);
    const commands = [
      ['status', `const { status } = await import(${J(STATUS)});\nstatus(${J(root)}, { task: ${J(id)}, sessions: {} });\n`],
      ['history', `const { history } = await import(${J(HISTORY)});\nhistory(${J(root)}, { task: ${J(id)} });\n`],
      ['prune', `const { prune } = await import(${J(PRUNE)});\nprune(${J(root)}, { olderThan: 0 });\n`],
    ];
    const runs = await Promise.all(commands.map(([, body]) => child(body)));
    exitedZero(runs, (i) => commands[i][0]);
    const warning = `bus recovery: task ${id}, message ${message} remains unfinished (link-refused)`;
    for (const [i, run] of runs.entries()) {
      assert.ok(run.err.includes(warning), `${commands[i][0]} stderr: ${run.err || 'empty'}`);
    }
    assert.ok(runs[0].out.includes(id), `status stdout: ${runs[0].out || 'empty'}`);
    assert.ok(runs[1].out.includes('history is empty'), `history stdout: ${runs[1].out || 'empty'}`);
    assert.ok(runs[2].out.includes('active tasks: 2'), `prune stdout: ${runs[2].out || 'empty'}`);
  });
  await t.test('link refusal: the fan-out is not half — the intent is open and is taken through later', () => {
    const stuck = openEngine({ root, policy: allowAll, recover: false });
    assert.equal(openIntents(intents).length, 1);
    assert.equal(stuck.unread(id, 'w-docs'), 0, 'the second recipient did not get a link');
    chmodSync(box, 0o700);
    const healed = open(root);
    assert.equal(healed.unread(id, 'w-api'), 1);
    assert.equal(healed.unread(id, 'w-docs'), 1);
    assert.deepEqual(readdirSync(path.join(healed.home, 'tasks', id, 'intents')), []);
  });
  // Permissions are restored in any case: otherwise sandbox cleanup would
  // hit a closed directory.
  if (existsSync(box)) chmodSync(box, 0o700);
});

test('the FS refused a recipient inbox mkdir — recovery keeps the intent open', async (t) => {
  // The refusal must happen while creating the recipient directory, not while
  // linking into one that already exists: recursive mkdir is the boundary
  // that used to sit outside link-refused classification.
  if (process.getuid?.() === 0) {
    t.skip('under root directory permissions do not apply, a mkdir refusal cannot be pictured; the check runs under an unprivileged user');
    return;
  }
  const root = sandbox();
  const engine = open(root);
  const id = taskWith(engine, 'mkdir-refused-t20260910-095700');
  const inbox = path.join(engine.home, 'tasks', id, 'inbox');
  const recipient = path.join(inbox, 'w-api');
  mkdirSync(inbox, { recursive: true });
  rmSync(recipient, { recursive: true, force: true });
  assert.equal(existsSync(recipient), false, 'the recipient directory must be absent before fan-out');
  chmodSync(inbox, 0o500);
  try {
    let refused = null;
    try {
      await engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'mkdir refused' });
    } catch (e) {
      refused = e;
    }
    assert.equal(refused?.code, 'link-refused', String(refused));

    const intents = path.join(engine.home, 'tasks', id, 'intents');
    const [intentName] = openIntents(intents);
    assert.ok(intentName, 'the refused fan-out left no intent to recover');
    const message = intentName.slice(0, -'.json'.length);
    const owner = path.join(intents, `${message}.owner`);
    writeFileSync(owner, `${JSON.stringify({ pid: 2_147_483_647, host: os.hostname() })}\n`);

    const reopened = openEngine({ root, policy: allowAll, recover: true });
    const report = reopened.recover(id);
    assert.deepEqual(report.failed.map((f) => ({ task: f.task, message: f.message, code: f.code })), [
      { task: id, message, code: 'link-refused' },
    ]);
    assert.ok(report.failed[0].note.endsWith(path.join('inbox', 'w-api')), report.failed[0].note);
    assert.deepEqual(openIntents(intents), [intentName], 'the refused fan-out intent was not retained');

    const commands = [
      ['status', `const { status } = await import(${J(STATUS)});\nstatus(${J(root)}, { task: ${J(id)}, sessions: {} });\n`],
      ['history', `const { history } = await import(${J(HISTORY)});\nhistory(${J(root)}, { task: ${J(id)} });\n`],
      ['prune', `const { prune } = await import(${J(PRUNE)});\nprune(${J(root)}, { olderThan: 0 });\n`],
    ];
    const runs = await Promise.all(commands.map(([, body]) => child(body)));
    exitedZero(runs, (i) => commands[i][0]);
  } finally {
    if (existsSync(inbox)) chmodSync(inbox, 0o700);
  }
});

test('a stray file at a recipient path does not take status, history, or prune down', async (t) => {
  const cases = [
    {
      name: 'EEXIST',
      place: (home, id) => {
        const stray = path.join(home, 'tasks', id, 'inbox', 'w-api');
        mkdirSync(path.dirname(stray), { recursive: true });
        writeFileSync(stray, 'not a directory\n');
        return stray;
      },
    },
    {
      name: 'ENOTDIR',
      place: (home, id) => {
        const stray = path.join(home, 'tasks', id, 'inbox');
        writeFileSync(stray, 'inbox is a file\n');
        return stray;
      },
    },
    {
      name: 'ENOENT',
      place: (home, id) => {
        const stray = path.join(home, 'tasks', id, 'inbox', 'w-api');
        mkdirSync(path.dirname(stray), { recursive: true });
        symlinkSync('missing', stray);
        return stray;
      },
    },
    {
      name: 'ELOOP',
      place: (home, id) => {
        const stray = path.join(home, 'tasks', id, 'inbox', 'w-api');
        mkdirSync(path.dirname(stray), { recursive: true });
        symlinkSync('w-api', stray);
        return stray;
      },
    },
  ];
  for (const { name, place } of cases) {
    await t.test(`stray file ${name}: status, history and prune exit 0 and keep the intent`, async () => {
      const root = sandbox();
      const engine = open(root);
      const id = taskWith(engine, `mkdir-stray-${name.toLowerCase()}-t20260925-160000`);
      const stray = place(engine.home, id);
      let refused = null;
      try {
        await engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: `stray ${name}` });
      } catch (e) {
        refused = e;
      }
      assert.equal(refused?.code, 'dir-occupied', String(refused));
      assert.equal(refused.context.errno, name);
      assert.equal(refused.context.target, stray);
      const intents = path.join(engine.home, 'tasks', id, 'intents');
      const [intentName] = openIntents(intents);
      assert.ok(intentName, 'the refused fan-out left no intent');
      const message = intentName.slice(0, -'.json'.length);
      writeFileSync(path.join(intents, `${message}.owner`),
        `${JSON.stringify({ pid: 2_147_483_647, host: os.hostname() })}\n`);
      const commands = [
        ['status', `const { status } = await import(${J(STATUS)});\nstatus(${J(root)}, { task: ${J(id)}, sessions: {} });\n`],
        ['history', `const { history } = await import(${J(HISTORY)});\nhistory(${J(root)}, { task: ${J(id)} });\n`],
        ['prune', `const { prune } = await import(${J(PRUNE)});\nprune(${J(root)}, { olderThan: 0 });\n`],
      ];
      const runs = await Promise.all(commands.map(([, body]) => child(body)));
      exitedZero(runs, (i) => `${name} ${commands[i][0]}`);
      const warning = `remains unfinished (dir-occupied)`;
      for (const [i, run] of runs.entries()) {
        assert.ok(run.err.includes(warning), `${commands[i][0]} stderr: ${run.err || 'empty'}`);
        assert.ok(run.err.includes(stray), `${commands[i][0]} did not name the stray path: ${run.err}`);
      }
      assert.deepEqual(openIntents(intents), [intentName], 'the stray-file intent was not retained');
      // rmSync reports success and leaves a dangling symlink in place.
      if (lstatSync(stray).isSymbolicLink()) unlinkSync(stray);
      else rmSync(stray);
      const delivered = await child(commands[0][1]);
      assert.equal(delivered.code, 0, `${name} status after clear: ${delivered.err}`);
      assert.deepEqual(openIntents(intents), [], `${name}: the intent stayed after the path was cleared`);
      assert.ok(existsSync(path.join(engine.home, 'tasks', id, 'inbox', 'w-api', `${message}.json`)),
        `${name}: status did not deliver once the path was clear`);
    });
  }
});

test('a symlink loop at the canonical messages directory does not take status, history, or prune down', async () => {
  const root = sandbox();
  const engine = open(root);
  const id = taskWith(engine, 'mkdir-canon-eloop-t20260925-160000');
  const stray = path.join(engine.home, 'tasks', id, 'messages');
  symlinkSync('messages', stray);
  let refused = null;
  try {
    await engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'canonical loop' });
  } catch (e) {
    refused = e;
  }
  assert.equal(refused?.code, 'dir-occupied', String(refused));
  assert.equal(refused.context.errno, 'ELOOP');
  assert.equal(refused.context.target, stray);
  assert.match(refused.message, /do not resend/);
  const intents = path.join(engine.home, 'tasks', id, 'intents');
  const [intentName] = openIntents(intents);
  assert.ok(intentName, 'the refused fan-out left no intent');
  const message = intentName.slice(0, -'.json'.length);
  writeFileSync(path.join(intents, `${message}.owner`),
    `${JSON.stringify({ pid: 2_147_483_647, host: os.hostname() })}\n`);
  const commands = [
    ['status', `const { status } = await import(${J(STATUS)});\nstatus(${J(root)}, { task: ${J(id)}, sessions: {} });\n`],
    ['history', `const { history } = await import(${J(HISTORY)});\nhistory(${J(root)}, { task: ${J(id)} });\n`],
    ['prune', `const { prune } = await import(${J(PRUNE)});\nprune(${J(root)}, { olderThan: 0 });\n`],
  ];
  const runs = await Promise.all(commands.map(([, body]) => child(body)));
  exitedZero(runs, (i) => commands[i][0]);
  for (const [i, run] of runs.entries()) {
    assert.ok(run.err.includes('remains unfinished (dir-occupied)'), `${commands[i][0]} stderr: ${run.err || 'empty'}`);
    assert.ok(run.err.includes(stray), `${commands[i][0]} did not name the loop: ${run.err}`);
  }
  assert.deepEqual(openIntents(intents), [intentName], 'the loop intent was not retained');
  unlinkSync(stray);
  const delivered = await child(commands[0][1]);
  assert.equal(delivered.code, 0, `status after clear: ${delivered.err}`);
  assert.deepEqual(openIntents(intents), [], 'the intent stayed after the loop was removed');
  assert.ok(existsSync(path.join(engine.home, 'tasks', id, 'inbox', 'w-api', `${message}.json`)),
    'status did not deliver once the canonical directory was clear');
});

test('a dangling symlink at the canonical messages directory is retried, not reported lost', async () => {
  const root = sandbox();
  const engine = open(root);
  const id = taskWith(engine, 'mkdir-canon-enoent-t20260925-160000');
  const stray = path.join(engine.home, 'tasks', id, 'messages');
  symlinkSync('missing', stray);
  let refused = null;
  try {
    await engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'canonical dangling' });
  } catch (e) {
    refused = e;
  }
  assert.equal(refused?.code, 'dir-occupied', String(refused));
  assert.equal(refused.context.errno, 'ENOENT');
  assert.equal(refused.context.target, stray);
  assert.match(refused.message, /do not resend/);
  assert.doesNotMatch(refused.message, /intent is gone/);
  const intents = path.join(engine.home, 'tasks', id, 'intents');
  const [intentName] = openIntents(intents);
  assert.ok(intentName, 'the refused fan-out left no intent');
  const message = intentName.slice(0, -'.json'.length);
  const intent = path.join(intents, intentName);
  assert.ok(existsSync(intent), 'the intent file was removed while the symlink was still there');
  writeFileSync(path.join(intents, `${message}.owner`),
    `${JSON.stringify({ pid: 2_147_483_647, host: os.hostname() })}\n`);
  const held = open(root, { recover: false }).recover(id);
  assert.equal(held.repairs.length, 0, 'recovery delivered through the dangling symlink');
  assert.equal(held.failed.length, 1, 'recovery dropped the dangling-symlink refusal');
  assert.equal(held.failed[0].code, 'dir-occupied');
  assert.notEqual(held.failed[0].code, 'intent-lost');
  assert.ok(existsSync(intent), 'recovery removed the intent it could not deliver');
  const commands = [
    ['status', `const { status } = await import(${J(STATUS)});\nstatus(${J(root)}, { task: ${J(id)}, sessions: {} });\n`],
    ['history', `const { history } = await import(${J(HISTORY)});\nhistory(${J(root)}, { task: ${J(id)} });\n`],
    ['prune', `const { prune } = await import(${J(PRUNE)});\nprune(${J(root)}, { olderThan: 0 });\n`],
  ];
  const runs = await Promise.all(commands.map(([, body]) => child(body)));
  exitedZero(runs, (i) => commands[i][0]);
  for (const [i, run] of runs.entries()) {
    assert.ok(run.err.includes('remains unfinished (dir-occupied)'), `${commands[i][0]} stderr: ${run.err || 'empty'}`);
    assert.ok(!run.err.includes('will not be retried'), `${commands[i][0]} reported a live intent as lost: ${run.err}`);
    assert.ok(run.err.includes(stray), `${commands[i][0]} did not name the dangling link: ${run.err}`);
  }
  assert.deepEqual(openIntents(intents), [intentName], 'the dangling-symlink intent was not retained');
  unlinkSync(stray);
  const delivered = open(root, { recover: false }).recover(id);
  assert.equal(delivered.repairs.length, 1, 'the next recover did not deliver once the symlink was gone');
  assert.equal(delivered.failed.length, 0, 'the cleared path was still a refusal');
  assert.deepEqual(openIntents(intents), [], 'the intent stayed after the symlink was removed');
  assert.ok(existsSync(path.join(engine.home, 'tasks', id, 'inbox', 'w-api', `${message}.json`)),
    'recover did not deliver once the canonical directory was clear');
});

// --- a sweep meets a sender between its payload and its record ----------------------
//
// The window the publication lock exists for: a neighbour's `stashBlob` finds the payload
// already there (`EEXIST` is dedup), and until its own record lands the payload is named by
// nothing a sweep can see. Three real processes, for the reason the whole file gives —
// inside one the lock recognises itself and the window never arrives.
//
// **What is asserted is mutual exclusion, and it is asserted by an event, not by a clock.**
// The sweeper marks the instant the lock is in its hands. Under the fix that mark cannot
// appear while the sender sits in its stretch; without the fix it appears at once, because
// nothing stands between the sweeper's own mark and its `mkdir`. The settle below covers
// that gap alone — an unblocked take of this lock measured 0.173 ms at the median and
// 1.142 ms at the worst of forty, so 400 ms is some three hundred times it — and a negative
// claim is the one kind that needs a ceiling at all. The stand also proves it ENTERED the
// window: a run that never saw the sender inside fails rather than passing on vacuous checks.
const MARK_SETTLE_MS = 400;

// Waiting for a file another process writes. An event with a ceiling: `null` when it never
// came, and the caller decides whether that is a failure or the answer it wanted.
async function until(mark, ceilingMs = 20_000) {
  for (const started = Date.now(); Date.now() - started < ceilingMs;) {
    if (existsSync(mark)) return Date.now();
    await new Promise((r) => { setTimeout(r, 5); });
  }
  return null;
}

test('a sweep of a neighbour piece does not take a payload a live sender is publishing', async (t) => {
  const root = sandbox();
  const engine = open(root);
  const id = taskWith(engine, 'race-blob-t20260916-170000');
  const payload = path.join(SB, 'shared-payload.diff');
  writeFileSync(payload, 'the very same bytes\n');

  // The neighbour's piece: a landed record and a files/ entry, both going in the sweep.
  const landed = await engine.send(id, {
    from: 'w-docs', to: ['owner'], type: 'artifact', body: 'соседский', artifact: { path: payload },
  });
  const taskAt = path.join(engine.home, 'tasks', id);
  const files = path.join(taskAt, 'files');
  mkdirSync(files, { recursive: true });
  assert.ok(engine.linkBlob(id, landed.artifact.sha256, path.join(files, landed.artifact.filename)));

  const marks = path.join(SB, 'race-marks');
  mkdirSync(marks, { recursive: true });
  const mark = (name) => path.join(marks, name);
  const plan = {
    broken: [],
    going: [{
      ...landed.artifact,
      file: path.join(taskAt, 'artifacts', `${landed.artifact.id}.json`),
      blob: path.join(taskAt, 'blobs', landed.artifact.sha256),
      link: path.join(files, landed.artifact.filename),
    }],
  };
  const kept = [path.join(taskAt, 'messages')];

  // The sender stalls INSIDE the publication stretch: the hook fires between the payload
  // and the record, marks the window, and leaves on the parent's word, not on a duration.
  const sender = child(
    `const { writeFileSync, existsSync } = await import('node:fs');\n`
    + `const e = open(${J(root)}, { faults: (kind) => {\n`
    + '  if (kind !== "blob") return;\n'
    + `  writeFileSync(${J(mark('at-window'))}, "");\n`
    + `  for (let i = 0; i < 6000 && !existsSync(${J(mark('go'))}); i += 1) {\n`
    + '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);\n'
    + '  }\n'
    // The sender says it LEFT, and that is what the parent reads to know it judged the
    // sweeper against a live window: `go` is the parent's own write and proves nothing.
    + `  writeFileSync(${J(mark('left-window'))}, "");\n`
    + '} });\n'
    + `await e.send(${J(id)}, { from: 'w-api', to: ['owner'], type: 'artifact', body: 'мой', artifact: { path: ${J(payload)} } });\n`,
  );

  const sawWindow = await until(mark('at-window'));

  // The sweeper marks the instant the lock is its own: `withBlobLock` nests inside a
  // process, so the `sweepArtifacts` beneath it runs in this very critical section.
  const sweeper = child(
    `const { writeFileSync } = await import('node:fs');\n`
    + `const { withBlobLock } = await import(${J(DIST)});\n`
    + `const { sweepArtifacts } = await import(${J(SWEEP)});\n`
    + `writeFileSync(${J(mark('attempt'))}, "");\n`
    + `const swept = withBlobLock(${J(engine.home)}, ${J(id)}, () => {\n`
    + `  writeFileSync(${J(mark('entered'))}, "");\n`
    + `  return sweepArtifacts(${J(engine.home)}, ${J(id)}, ${J(plan)}, ${J(kept)});\n`
    + '});\n'
    + `writeFileSync(${J(mark('swept'))}, JSON.stringify(swept));\n`,
  );

  const sawAttempt = await until(mark('attempt'));
  // The one gap a clock has to cover: between the sweeper's own mark and its `mkdir`.
  await new Promise((r) => { setTimeout(r, MARK_SETTLE_MS); });
  const enteredWhileHeld = existsSync(mark('entered'));
  const senderStillHeld = !existsSync(mark('left-window'));
  writeFileSync(mark('go'), '');

  const [senderRun, sweeperRun] = await Promise.all([sender, sweeper]);

  await t.test('the stand entered the window and both processes ran', () => {
    assert.ok(sawWindow, 'the sender never reported itself inside the publication stretch');
    assert.ok(sawAttempt, 'the sweeper never reported an attempt');
    assert.ok(senderStillHeld, 'the sender had already been released before the sweeper was judged');
    exitedZero([senderRun, sweeperRun], (i) => (i ? 'sweeper' : 'sender'));
  });
  await t.test('the sweeper did not get the lock while the sender was inside its stretch', () => {
    assert.equal(enteredWhileHeld, false,
      `the sweeper held the publication lock ${MARK_SETTLE_MS} ms into a live sender's stretch`);
  });
  await t.test('and the payload stayed, because the sender named it before the sweep judged', () => {
    const swept = JSON.parse(readFileSync(mark('swept'), 'utf8'));
    assert.equal(swept.records, 1);
    assert.equal(swept.files, 1);
    assert.equal(swept.blobs, 0, `the sweep removed a payload under a live sender: ${J(swept)}`);
    assert.deepEqual(swept.busy, [landed.artifact.filename]);
  });
  await t.test('the sender artifact reads back — payload and digest both', () => {
    const after = openEngine({ root, policy: allowAll, recover: false });
    const mine = after.listArtifacts(id).artifacts.filter((a) => a.id !== landed.artifact.id);
    assert.equal(mine.length, 1, J(mine));
    assert.equal(after.readArtifactContent(id, mine[0].id).toString(), 'the very same bytes\n');
  });
});

// --- two publications of one process do not share a lock ----------------------------
//
// The hole a nesting licence opens once an `await` is in the stretch: the second holder of
// THIS process would read "we already hold it", publish without the lock, and the first
// would remove the directory from under it. The publication lock has no lawful nesting, so
// holders of one path queue. Deterministic: the order is the assertion, not a duration.
test('asynchronous holders of one lock path queue inside the process', async () => {
  const lock = path.join(sandbox(), '.lock-two');
  mkdirSync(path.dirname(lock), { recursive: true });
  const words = {
    onMissing: () => new Error('missing'),
    onBusy: (h, ms) => new Error(`busy ${ms}`),
  };
  const order = [];
  const hold = (who) => withDirLockAsync(lock, async () => {
    order.push(`${who} in · lock ${existsSync(lock)}`);
    await new Promise((r) => { setImmediate(r); });
    order.push(`${who} out · lock ${existsSync(lock)}`);
  }, words);
  await Promise.all([hold('a'), hold('b')]);
  assert.deepEqual(order, [
    'a in · lock true', 'a out · lock true', 'b in · lock true', 'b out · lock true',
  ]);
  assert.equal(existsSync(lock), false, 'the last holder left the lock directory behind');
});

// A synchronous wait on an asynchronous holder of this process would block the very loop
// that has to release it. That is a caller mistake, and it is answered rather than spun on.
test('a synchronous take over a live asynchronous holder is refused, not waited out', async () => {
  const lock = path.join(sandbox(), '.lock-mixed');
  mkdirSync(path.dirname(lock), { recursive: true });
  const words = { onMissing: () => new Error('missing'), onBusy: () => new Error('busy') };
  let refusal = null;
  await withDirLockAsync(lock, async () => {
    await new Promise((r) => { setImmediate(r); });
    try {
      withDirLock(lock, () => 'taken', words);
    } catch (e) {
      refusal = e;
    }
  }, words);
  assert.match(String(refusal?.message), /asynchronous holder in this process/);
});

// A foreign process holds the lock, and the asynchronous take waits for it. What must NOT
// wait is this process's loop: `sleepSync` there would freeze every timer of the sender's
// own session for the whole of a foreign hold, and a published API has to behave as async.
test('an asynchronous take waits for a foreign holder without freezing its own loop', async () => {
  const lock = path.join(sandbox(), '.lock-foreign');
  mkdirSync(path.dirname(lock), { recursive: true });
  mkdirSync(lock);
  // A holder the lock reads as live and foreign: the pid is alive, so it is not dropped.
  writeFileSync(path.join(lock, 'owner'), `${JSON.stringify({ pid: process.pid, session: 'foreign', since: new Date().toISOString() })}\n`);
  const words = { onMissing: () => new Error('missing'), onBusy: () => new Error('busy') };
  const ticks = [];
  const beat = setInterval(() => ticks.push(Date.now()), 10);
  setTimeout(() => rmSync(lock, { recursive: true, force: true }), 150);
  await withDirLockAsync(lock, async () => { ticks.push('inside'); }, { ...words, waitMs: 5000 });
  clearInterval(beat);
  // One tick is the whole claim: the loop was not frozen. A higher count would be a number
  // about SCHEDULING — Node does not catch up missed periods, and one hiccup coalesces them.
  const before = ticks.indexOf('inside');
  assert.ok(before >= 1, `the loop of this process was frozen: ${before} timers ran while the take waited`);
  assert.equal(existsSync(lock), false);
});

// --- two sends with an artifact in one process ---------------------------------------
//
// The same hole seen from the engine. The slow sender's payload arrives in pieces, the fast
// one's is there at once: unlocked, the fast blob would be stashed first. Queued, the fast
// send does not begin until the slow one has written its record, so the digests are marked
// in the order the sends were STARTED and not in the order their payloads were ready.
test('two artifact sends of one process publish one after the other, not side by side', async () => {
  const root = sandbox();
  const marked = [];
  const engine = open(root, { faults: (kind, ctx) => { if (kind === 'blob') marked.push(ctx.sha256); } });
  const id = taskWith(engine, 'race-two-sends-t20260916-190000');

  // A stream that yields the loop several times before its bytes are all in: without the
  // queue the neighbour below overtakes it, and the order of `marked` says so.
  const slow = new Readable({ read() {} });
  let ticks = 0;
  const feed = () => {
    if (ticks < 5) { ticks += 1; slow.push(`slow ${ticks}\n`); setImmediate(feed); return; }
    slow.push(null);
  };
  setImmediate(feed);

  const first = engine.send(id, {
    from: 'w-api', to: ['owner'], type: 'artifact', body: 'медленный',
    artifact: { stream: slow, filename: 'slow.txt' },
  });
  const second = engine.send(id, {
    from: 'w-docs', to: ['owner'], type: 'artifact', body: 'быстрый',
    artifact: { stream: Readable.from(['fast bytes\n']), filename: 'fast.txt' },
  });
  const [slowSent, fastSent] = await Promise.all([first, second]);

  assert.deepEqual(marked, [slowSent.artifact.sha256, fastSent.artifact.sha256],
    'the second send stashed its payload while the first was still inside its stretch');
  assert.equal(engine.readArtifactContent(id, slowSent.artifact.id).toString(), 'slow 1\nslow 2\nslow 3\nslow 4\nslow 5\n');
  assert.equal(engine.readArtifactContent(id, fastSent.artifact.id).toString(), 'fast bytes\n');
});
