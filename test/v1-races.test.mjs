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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { ERROR_CODES, openEngine, PromptobusError } from '../dist/index.js';

const DIST = new URL('../dist/index.js', import.meta.url).href;
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
  await t.test('link refusal: the fan-out is not half — the intent is open and is taken through later', () => {
    const stuck = openEngine({ root, policy: allowAll, recover: false });
    assert.equal(openIntents(path.join(stuck.home, 'tasks', id, 'intents')).length, 1);
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
