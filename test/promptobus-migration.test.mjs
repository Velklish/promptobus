// Migration `legacy/a2a` → `.promptobus` (§7).
//
// Input — a golden slice of `v0.61.0` ([fixtures/promptobus/legacy-v061](fixtures/promptobus/legacy-v061)),
// captured by the generator through the current release's store. The slice deliberately does not
// cover adapter files: `wake/`, `waits/` and `stalls.json` are created as work proceeds, and none
// of them end up in git. This suite appends them itself — through the SAME store API the live
// mechanism writes them with ([MANIFEST](fixtures/promptobus/MANIFEST.md)); editing the slice
// itself is not allowed for this, it was captured byte-for-byte and an edit would change its
// meaning.
//
// The subject under test is three properties, and each gets its own section:
//
// 1. **Full transfer.** inbox and `read/` counters, ownership, history, artifact digest.
// 2. **Refusal BEFORE mutation.** Active tasks, both roots at once, a corrupted root.
// 3. **Recoverability.** A crash at any step before the atomic switch leaves the legacy
//    directory untouched, and a retry carries the transfer through to completion.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The mechanism's doorway — it both triggers the transfer on the store's first access and feeds
// it what the package has no right to know: session identity and the harness for the previous
// CLI's records (their `harness` field is absent entirely, while v1 requires it on every
// participant record). Without it the migration would write "harness not declared" — exactly
// what it must close with a value from the driver registry (the package no longer has a
// substitution seam for this: everything now arrives as an argument).
const store = await import('../lib/store.js');
const bus = await import('../dist/index.js');
const { legacy, preflight: preflightOf, ROOT_DIR } = bus;

const LAYOUT = { rel: 'legacy/a2a', done: 'promptobus done <id>' };
const LEGACY_DONE = LAYOUT.done;
const preflight = (root) => preflightOf(root, LAYOUT);
const migrate = (root, opts = {}) => bus.migrate(root, {
  harness: store.FALLBACK_HARNESS, layout: LAYOUT, ...opts,
});

const SB = mkdtempSync(path.join(os.tmpdir(), 'promptobus-migration-'));
process.on('exit', () => rmSync(SB, { recursive: true, force: true }));

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'promptobus', 'legacy-v061');
const ACTIVE = 't20260831-090000';
const CLOSED = 't20260830-140000';

let nth = 0;

/** A workspace with the `v0.61.0` slice inside. Each section takes its own — migration is destructive. */
function workspace({ close = true } = {}) {
  nth += 1;
  const root = path.join(SB, `ws-${nth}`);
  const home = path.join(root, 'legacy', 'a2a');
  mkdirSync(path.dirname(home), { recursive: true });
  cpSync(FIXTURE, home, { recursive: true });
  // An active task blocks the switch by design. We close it with the same store the previous
  // CLI would have closed it with — the same way a human would have to.
  if (close) legacy.closeTask(home, ACTIVE);
  return { root, home, target: path.join(root, ROOT_DIR) };
}

/** Tree fingerprint: relative paths and content. Used to verify "legacy untouched". */
function treeDigest(dir) {
  const hash = createHash('sha256');
  const walk = (at, rel) => {
    for (const e of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = path.join(at, e.name);
      const key = path.join(rel, e.name);
      if (e.isDirectory()) {
        hash.update(`d ${key}\n`);
        walk(next, key);
      } else {
        hash.update(`f ${key} `);
        hash.update(readFileSync(next));
        hash.update('\n');
      }
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}

function names(dir) {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function thrown(fn) {
  try {
    fn();
    return { threw: false, name: '', msg: '' };
  } catch (e) {
    return { threw: true, name: e?.constructor?.name, msg: e.message };
  }
}

// --- refusals before mutation ---------------------------------------------------------

test('preflight: active tasks — refusal without a single change and with the old version\'s command', async (t) => {
  const { root, home, target } = workspace({ close: false });
  const before = treeDigest(home);
  const plan = preflight(root);

  await t.test('the refusal is named, and it lists the active tasks', () => {
    assert.equal(plan.needed, true);
    assert.ok(plan.refusal, 'no refusal');
    assert.deepEqual(plan.active, [ACTIVE]);
    assert.match(plan.refusal, new RegExp(ACTIVE));
  });

  await t.test('the refusal contains the exact close command from the previous CLI', () => {
    assert.ok(plan.refusal.includes(LEGACY_DONE.replace('<id>', ACTIVE)),
      plan.refusal);
  });

  await t.test('the migration itself refuses with the same text and gate class', () => {
    const said = thrown(() => migrate(root));
    assert.equal(said.name, 'GateError');
    assert.match(said.msg, new RegExp(ACTIVE));
  });

  await t.test('legacy store untouched, no new directory appeared', () => {
    assert.equal(treeDigest(home), before);
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(path.join(root, `${ROOT_DIR}.migrating`)), false);
  });
});

test('preflight: both roots at once — refusal without a merge', async (t) => {
  const { root, home, target } = workspace();
  mkdirSync(path.join(target, 'tasks'), { recursive: true });
  const before = treeDigest(home);
  const plan = preflight(root);

  await t.test('the refusal names both directories and does not attempt to merge them', () => {
    assert.ok(plan.refusal, 'no refusal');
    assert.ok(plan.refusal.includes(target) && plan.refusal.includes(home), plan.refusal);
    assert.match(plan.refusal, /The mechanism will not merge them/);
  });

  await t.test('legacy store untouched', () => {
    assert.equal(treeDigest(home), before);
  });
});

test('preflight: a corrupted root — refusal without mutation', async (t) => {
  const root = path.join(SB, 'ws-broken-root');
  mkdirSync(path.join(root, 'legacy'), { recursive: true });
  writeFileSync(path.join(root, 'legacy', 'a2a'), 'this is a file, not a directory\n');

  await t.test('root-as-a-file: refusal, not an attempted read', () => {
    const plan = preflight(root);
    assert.ok(plan.refusal, 'no refusal');
    assert.equal(plan.needed, false);
    assert.match(plan.refusal, /is not a directory/);
  });

  await t.test('tasks/ as a file instead of a directory — the same refusal', () => {
    const other = path.join(SB, 'ws-broken-tasks');
    mkdirSync(path.join(other, 'legacy', 'a2a'), { recursive: true });
    writeFileSync(path.join(other, 'legacy', 'a2a', 'tasks'), 'substitute\n');
    const plan = preflight(other);
    assert.ok(plan.refusal, 'no refusal');
    assert.match(plan.refusal, /is not a directory/);
    assert.equal(existsSync(path.join(other, ROOT_DIR)), false);
  });
});

// --- full transfer ------------------------------------------------------------

test('golden: the v0.61.0 slice transfers in full', async (t) => {
  const { root, home, target } = workspace();
  // Adapter files that are absent from the slice entirely, we append with the same store
  // API: contact points, the end-of-turn mark, and the reported-stop mark.
  legacy.writeWake(home, ACTIVE, 'worker:demo', { socket: '/tmp/promptobus-demo/worker-demo.sock', pid: 424243 });
  legacy.markTurn(home, ACTIVE, 'worker:demo', '2026-08-31T10:05:00.000Z');
  legacy.writeStalls(home, ACTIVE, { 'worker:demo': { reason: 'permission', at: '2026-08-31T10:06:00.000Z', tries: 1 } });
  const artifactSha = createHash('sha256')
    .update(readFileSync(path.join(home, 'tasks', ACTIVE, 'artifacts', 'demo-diff.patch'))).digest('hex');

  const report = migrate(root);

  await t.test('both tasks transferred, none broken', () => {
    assert.deepEqual(report.tasks.map((x) => x.id).sort(), [CLOSED, ACTIVE]);
    assert.deepEqual(report.brokenTasks, []);
  });

  await t.test('legacy directory removed only after the switch', () => {
    assert.equal(existsSync(home), false);
    assert.equal(existsSync(path.join(target, 'tasks', ACTIVE, 'task.json')), true);
  });

  await t.test('participants: legacy IDs preserved, role sits in a field, harness is set', () => {
    const meta = readJson(path.join(target, 'tasks', ACTIVE, 'task.json'));
    assert.deepEqual(meta.participants.map((p) => p.id).sort(), ['orchestrator', 'reviewer-demo', 'worker-demo']);
    assert.deepEqual(meta.participants.map((p) => p.role).sort(), ['orchestrator', 'reviewer', 'worker']);
    assert.ok(meta.participants.every((p) => p.harness === 'claude'), 'not all have harness');
    // The address is not parsed back out of the id — it sits in the record's metadata.
    assert.deepEqual(meta.participants.map((p) => p.metadata.address).sort(),
      ['orchestrator', 'reviewer:demo', 'worker:demo']);
  });

  await t.test('task ownership: owner is a participant, the owning session stays a field on the record', () => {
    const meta = readJson(path.join(target, 'tasks', ACTIVE, 'task.json'));
    assert.equal(meta.owner, 'orchestrator');
    assert.equal(meta.participants.find((p) => p.id === 'orchestrator').metadata.owner,
      '00000000-0000-4000-8000-000000000001');
  });

  await t.test('adapter fields from the journal survived', () => {
    const meta = readJson(path.join(target, 'tasks', ACTIVE, 'task.json'));
    assert.equal(meta.title, 'демо: активная задача');
    assert.equal(meta.adapter.slug, 'demo');
    assert.equal(meta.adapter.stamp, ACTIVE);
    assert.equal(meta.status, 'done', 'a closed task must remain closed');
  });

  await t.test('inbox counters: unread stayed unread', () => {
    const one = report.tasks.find((x) => x.id === ACTIVE);
    assert.equal(one.unread, 3, `unread: ${one.unread}`);
    assert.equal(names(path.join(target, 'tasks', ACTIVE, 'inbox', 'orchestrator')).length, 1);
    assert.equal(names(path.join(target, 'tasks', ACTIVE, 'inbox', 'worker-demo')).length, 2);
  });

  await t.test('history counters: read stayed read', () => {
    const one = report.tasks.find((x) => x.id === ACTIVE);
    assert.equal(one.read, 4, `read: ${one.read}`);
    assert.equal(names(path.join(target, 'tasks', ACTIVE, 'history', 'orchestrator')).length, 3);
    assert.equal(names(path.join(target, 'tasks', ACTIVE, 'history', 'reviewer-demo')).length, 1);
  });

  await t.test('one canonical file per message, and the link is the same inode', () => {
    const canon = names(path.join(target, 'tasks', ACTIVE, 'messages'));
    assert.equal(canon.length, 7, `canonical: ${canon.length}`);
    const ref = names(path.join(target, 'tasks', ACTIVE, 'inbox', 'orchestrator'))[0];
    const a = statSync(path.join(target, 'tasks', ACTIVE, 'messages', ref));
    const b = statSync(path.join(target, 'tasks', ACTIVE, 'inbox', 'orchestrator', ref));
    assert.equal(a.ino, b.ino, 'inbox link is not the same inode');
  });

  await t.test('message order preserved: name sort order is send order', () => {
    const canon = names(path.join(target, 'tasks', ACTIVE, 'messages'));
    const stamps = canon.map((n) => readJson(path.join(target, 'tasks', ACTIVE, 'messages', n)).ts);
    assert.deepEqual(stamps, [...stamps].sort(), stamps.join(' '));
  });

  await t.test('the broken record moved to broken, the rest of the messages arrived', () => {
    const one = report.tasks.find((x) => x.id === ACTIVE);
    assert.equal(one.broken.length, 1, one.broken.join('; '));
    assert.deepEqual(names(path.join(target, 'tasks', ACTIVE, 'broken', 'inbox', 'worker-demo')),
      ['20260831T095500000-0009-orchestrator.json']);
  });

  await t.test('artifact: blob by SHA-256, metadata, a human-readable filename', () => {
    const one = report.tasks.find((x) => x.id === ACTIVE);
    assert.equal(one.artifacts, 1);
    assert.deepEqual(names(path.join(target, 'tasks', ACTIVE, 'blobs')), [artifactSha]);
    const meta = readJson(path.join(target, 'tasks', ACTIVE, 'artifacts',
      names(path.join(target, 'tasks', ACTIVE, 'artifacts'))[0]));
    assert.equal(meta.sha256, artifactSha);
    assert.equal(meta.filename, 'demo-diff.patch');
    assert.deepEqual(names(path.join(target, 'tasks', ACTIVE, 'files')), ['demo-diff.patch']);
  });

  await t.test('the artifact reference in the message is rewritten to the record id', () => {
    const dir = path.join(target, 'tasks', ACTIVE, 'history', 'orchestrator');
    const withArt = names(dir).map((n) => readJson(path.join(dir, n))).find((m) => m.artifact);
    const meta = readJson(path.join(target, 'tasks', ACTIVE, 'artifacts',
      names(path.join(target, 'tasks', ACTIVE, 'artifacts'))[0]));
    assert.equal(withArt.artifact, meta.id);
  });

  await t.test('adapter files transferred as-is', () => {
    const at = path.join(target, 'tasks', ACTIVE);
    assert.equal(existsSync(path.join(at, 'health.json')), true);
    assert.equal(existsSync(path.join(at, 'supervisor.json')), true);
    assert.equal(existsSync(path.join(at, 'supervisor.log')), true);
    assert.equal(readJson(path.join(at, 'stalls.json'))['worker:demo'].reason, 'permission');
    assert.equal(readJson(path.join(at, 'waits', 'worker-demo.turn.json')).at, '2026-08-31T10:05:00.000Z');
  });

  await t.test('contact points are not transferred: live sessions re-issue them', () => {
    assert.equal(existsSync(path.join(target, 'tasks', ACTIVE, 'wake')), false);
  });

  await t.test('session bindings transferred', () => {
    assert.equal(report.bindings, 1);
    assert.deepEqual(names(path.join(target, 'sessions')),
      ['00000000-0000-4000-8000-000000000001.json']);
  });

  await t.test('closed task: both sides of the correspondence are in place', () => {
    const one = report.tasks.find((x) => x.id === CLOSED);
    assert.equal(one.read, 2);
    assert.equal(one.unread, 0);
    assert.equal(names(path.join(target, 'tasks', CLOSED, 'history', 'orchestrator')).length, 1);
    assert.equal(names(path.join(target, 'tasks', CLOSED, 'history', 'worker-stale')).length, 1);
  });
});

test('golden: the transferred data is readable by the mechanism', async (t) => {
  const { root, home, target } = workspace();
  migrate(root);

  await t.test('the unread counter is the same as it was in legacy', () => {
    assert.equal(store.countInbox(target, ACTIVE, 'worker:demo'), 2);
    assert.equal(store.countInbox(target, ACTIVE, 'orchestrator'), 1);
  });

  await t.test('participants are read by address, not by v1 participant id', () => {
    const meta = store.readTask(target, ACTIVE);
    assert.deepEqual(store.addressesOf(meta).sort(),
      ['orchestrator', 'reviewer:demo', 'worker:demo']);
    assert.equal(store.participantOf(meta, 'worker:demo').metadata.repo, 'demo-group/demo-api');
  });

  await t.test('mailbox ownership preserved', () => {
    assert.equal(store.taskOwner(target, ACTIVE), '00000000-0000-4000-8000-000000000001');
  });

  await t.test('the mailbox returns the transferred data, and sender/recipient are participant ids', () => {
    const { messages } = store.readInbox(target, ACTIVE, 'worker:demo');
    assert.equal(messages.length, 2);
    assert.ok(messages.every((m) => m.sender === 'orchestrator' && m.recipients.join(',') === 'worker-demo'),
      JSON.stringify(messages.map((m) => [m.sender, m.recipients])));
  });

  await t.test('history returns exactly what was read, and its order is the same', () => {
    // v1 history is built ONLY from `history/`: undelivered messages don't land in it, and
    // fan-out recovery rests on that exact difference.
    const page = store.history(target, { task: ACTIVE, participant: 'orchestrator', all: true });
    assert.equal(page.entries.length, 3, `entries: ${page.entries.length}`);
    const stamps = page.entries.map((e) => e.message.ts);
    assert.deepEqual(stamps, [...stamps].sort(), stamps.join(' '));
    assert.deepEqual(page.broken, []);
  });

  await t.test('the artifact is found by name in the task folder', () => {
    assert.equal(existsSync(path.join(store.filesDir(target, ACTIVE), 'demo-diff.patch')), true);
  });

  await t.test('legacy directory removed', () => {
    assert.equal(existsSync(home), false);
  });
});

test('same-named legacy records in different mailboxes do not clobber each other', async (t) => {
  // The previous store's names are unique within ONE mailbox, not within a task: two senders
  // under one address from two processes could collide on the same name, and `link` resolved
  // them within its own directory. Seeding the id from the filename alone would give them a
  // single id for the whole task — and the second body would vanish silently, while the
  // migration is irreversible.
  const { root, home, target } = workspace();
  const NAME = '20260831T091500000-0042-orchestrator.json';
  const twin = (to, body) => ({
    id: NAME.slice(0, -'.json'.length), task: ACTIVE, from: 'orchestrator', to,
    type: 'task', ts: '2026-08-31T09:15:00.000Z', body,
  });
  for (const [box, to, body] of [['worker-demo', 'worker:demo', 'близнец worker\'у'],
    ['reviewer-demo', 'reviewer:demo', 'близнец reviewer\'у']]) {
    const dir = path.join(home, 'tasks', ACTIVE, 'inbox', box);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, NAME), `${JSON.stringify(twin(to, body), null, 2)}\n`);
  }

  const report = migrate(root);

  await t.test('both twins arrived: two distinct canonical files, both with a body', () => {
    const dir = path.join(target, 'tasks', ACTIVE, 'messages');
    const bodies = names(dir).map((n) => readJson(path.join(dir, n)))
      .filter((m) => m.body.startsWith('близнец')).map((m) => m.body).sort();
    assert.deepEqual(bodies, ['близнец reviewer\'у', 'близнец worker\'у'], bodies.join(' | '));
  });

  await t.test('their ids differ, and each lives in its own mailbox', () => {
    const at = (box) => names(path.join(target, 'tasks', ACTIVE, 'inbox', box));
    const mine = at('worker-demo').filter((n) => n.startsWith('20260831T091500000-0042'));
    const theirs = at('reviewer-demo').filter((n) => n.startsWith('20260831T091500000-0042'));
    assert.equal(mine.length, 1, at('worker-demo').join(','));
    assert.equal(theirs.length, 1, at('reviewer-demo').join(','));
    assert.notEqual(mine[0], theirs[0], `ids collided: ${mine[0]}`);
  });

  await t.test('the task counter counted both of them', () => {
    const one = report.tasks.find((x) => x.id === ACTIVE);
    assert.equal(one.unread, 5, `unread: ${one.unread}`);
  });
});

// --- concurrent run ---------------------------------------------------------

// With two real processes, not promises inside one: the subject is the lock directory and
// `rename`, and within a single process they never collide with themselves. The barrier is
// mandatory — without it the children line up by their launch time, and the window never
// opens at all.
//
// They wait by SLEEPING, not by spinning: the window we're trying to catch is measured in
// just over a second (the move itself takes 1.45s for 36MB), spin-precision isn't needed
// here, and half a second of burned CPU per process is paid out of the suite's own budget.
function racers(n, body) {
  const at = Date.now() + 700;
  // `a` — the adapter CLI (the one that fits the package's seam), `m` — the package itself.
  const code = (i) => `const path = await import('node:path');\n`
    + `const a = await import(${JSON.stringify(path.join(process.cwd(), 'lib', 'store.js'))});\n`
    + `const m = await import(${JSON.stringify(path.join(process.cwd(), 'dist', 'index.js'))});\n`
    + `const layout = ${JSON.stringify(LAYOUT)};\n`
    + `const i = ${i};\n`
    + `await new Promise((r) => setTimeout(r, Math.max(0, ${at} - Date.now())));\n${body}`;
  return Promise.all(Array.from({ length: n }, (_, i) => new Promise((resolve) => {
    const ch = spawn(process.execPath, ['--input-type=module', '-e', code(i)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { err += d; });
    ch.on('exit', (codeOut) => resolve({ code: codeOut, out: out.trim(), err: err.trim() }));
  })));
}

test('the move report is printed by whoever moved — and only them', async (t) => {
  // The adapter prints it, not the package: it's also the one that stays quiet when there
  // was nothing to transfer. Without this branch the loser would report "0 tasks, 0 messages,
  // former directory" on a workspace where its neighbor had transferred everything — the very
  // line promised to the user as a numeric report would be lying.
  const { root, home } = workspace();
  const before = names(path.join(home, 'tasks')).length;
  const runs = await racers(2, `a.promptobusHome(${JSON.stringify(root)}, { legacyLayout: () => layout });`);

  await t.test('both processes exited successfully', () => {
    assert.deepEqual(runs.map((r) => r.code), [0, 0], JSON.stringify(runs));
  });

  await t.test('the "the bus moved" line appears exactly once — for whoever moved', () => {
    const said = runs.filter((r) => r.err.includes('the bus moved'));
    assert.equal(said.length, 1, runs.map((r) => `«${r.err}»`).join(' | '));
    assert.match(said[0].err, new RegExp(`${before} tasks`), said[0].err);
  });

  await t.test('the other one stays silent entirely — there is no such thing as an empty report', () => {
    const quiet = runs.filter((r) => !r.err.includes('the bus moved'));
    assert.equal(quiet.length, 1);
    assert.equal(quiet[0].err, '', `«${quiet[0].err}»`);
  });
});

test('two processes move at the same time — one transfers, both end up with the full store', async (t) => {
  const { root, home, target } = workspace();
  // We take the bodies BEFORE the move: they're what must be checked, not the counters. A
  // counter counts links, and both links are in place even when they point at one inode —
  // it doesn't see a loss.
  const bodies = [];
  for (const box of ['inbox', 'read']) {
    for (const dir of names(path.join(home, 'tasks', ACTIVE, box))) {
      for (const n of names(path.join(home, 'tasks', ACTIVE, box, dir))) {
        try {
          bodies.push(readJson(path.join(home, 'tasks', ACTIVE, box, dir, n)).body);
        } catch {
          // A broken record has no body — it will move to broken, and there's nothing to
          // check it against.
        }
      }
    }
  }

  const runs = await racers(2, `const r = m.migrate(${JSON.stringify(root)}, { harness: a.FALLBACK_HARNESS, layout });\n`
    + `process.stdout.write(JSON.stringify({ tasks: r.tasks.length, moved: r.moved, resumed: r.resumed }));`);

  await t.test('both processes exited successfully — the loser does not refuse', () => {
    assert.deepEqual(runs.map((r) => r.code), [0, 0], JSON.stringify(runs));
  });

  await t.test('exactly one transferred, the other saw a root that had already moved', () => {
    const moved = runs.filter((r) => JSON.parse(r.out).tasks > 0);
    assert.equal(moved.length, 1, runs.map((r) => r.out).join(' | '));
  });

  await t.test('the loser says "did nothing", not an empty transfer', () => {
    // Without this field, an empty report is indistinguishable from a successful transfer, and
    // the numeric report would say "0 tasks, 0 messages, former directory" on a workspace where
    // its neighbor had transferred everything.
    const said = runs.map((r) => JSON.parse(r.out));
    assert.deepEqual(said.map((r) => r.moved).sort(), [false, true], JSON.stringify(said));
    assert.equal(said.find((r) => !r.moved).tasks, 0);
  });

  await t.test('the new root holds the FULL store — checking bodies, not counters', () => {
    const after = [];
    const dir = path.join(target, 'tasks', ACTIVE, 'messages');
    for (const n of names(dir)) after.push(readJson(path.join(dir, n)).body);
    assert.deepEqual(after.sort(), bodies.sort(), `${after.length} bodies out of ${bodies.length}`);
  });

  await t.test('the previous root is removed, no temp directory or lock remains', () => {
    assert.equal(existsSync(home), false, 'previous root still in place');
    assert.equal(existsSync(path.join(root, `${ROOT_DIR}.migrating`)), false, 'a temp directory remains');
    assert.equal(existsSync(path.join(root, `${ROOT_DIR}.migrating.lock`)), false, 'a lock remains');
  });
});

// --- recoverability -----------------------------------------------------------

const BEFORE_SWITCH = ['scan', 'temp', 'artifacts', 'messages', 'task', 'sidecar', 'sessions', 'mark'];

test('fault injection: a crash before the atomic switch does not touch legacy', async (t) => {
  for (const step of BEFORE_SWITCH) {
    await t.test(`crash at "${step}": legacy intact, no new directory, a retry finishes the job`, () => {
      const { root, home, target } = workspace();
      const before = treeDigest(home);
      // The target is checked FROM INSIDE the fault, not after it: from the outside, its
      // absence could just as well be produced by cleanup in a catch block, and that's not
      // what's under test — while the build is in progress, nothing exists at the target's
      // location yet. A real process death does no cleanup at all.
      const seen = [];
      const said = thrown(() => migrate(root, {
        fault: (at) => {
          seen.push([at, existsSync(target)]);
          if (at === step) throw new Error(`synthetic fault at ${at}`);
        },
      }));
      assert.equal(said.threw, true, 'no crash happened');
      assert.match(said.msg, /synthetic fault/);
      assert.deepEqual(seen.filter(([, there]) => there), [],
        `target existed during the build: ${JSON.stringify(seen)}`);
      assert.equal(treeDigest(home), before, 'legacy store changed');
      assert.equal(existsSync(target), false, 'target appeared before the switch');
      assert.equal(existsSync(path.join(root, `${ROOT_DIR}.migrating`)), false, 'a temp directory remains');

      // A retry after interruption is idempotent: the transfer runs to completion.
      const report = migrate(root);
      assert.equal(report.tasks.length, 2);
      assert.equal(existsSync(home), false);
      assert.equal(existsSync(path.join(target, 'tasks', ACTIVE, 'task.json')), true);
    });
  }
});

test('fault injection: a crash AFTER the switch is finished by a retry, not by a refusal', async (t) => {
  const { root, home, target } = workspace();
  const said = thrown(() => migrate(root, {
    fault: (at) => {
      if (at === 'switch') throw new Error('synthetic fault after rename');
    },
  }));

  await t.test('both directories are in place — the window between the switch and cleanup', () => {
    assert.equal(said.threw, true);
    assert.equal(existsSync(home), true);
    assert.equal(existsSync(target), true);
  });

  await t.test('a retry does not refuse with "both roots", it finishes the cleanup', () => {
    const plan = preflight(root);
    assert.equal(plan.refusal, null, plan.refusal ?? '');
    const report = migrate(root);
    assert.equal(report.resumed, true);
    assert.equal(existsSync(home), false);
    assert.equal(existsSync(path.join(target, 'tasks', ACTIVE, 'task.json')), true);
  });
});

test('a retry on an already-transferred workspace does nothing', async (t) => {
  const { root, target } = workspace();
  migrate(root);
  const after = treeDigest(target);

  await t.test('preflight no longer asks for a migration', () => {
    const plan = preflight(root);
    assert.equal(plan.needed, false);
    assert.equal(plan.refusal, null);
  });

  await t.test('a repeat migration does nothing and says so', () => {
    const report = migrate(root);
    assert.deepEqual(report.tasks, []);
    assert.equal(report.moved, false, 'an empty report was passed off as a transfer');
    assert.equal(treeDigest(target), after);
  });
});

test('a corrupted task moves to migration-broken and is not activated', async (t) => {
  const { root, home, target } = workspace();
  writeFileSync(path.join(home, 'tasks', CLOSED, 'task.json'), '{"id": "cut');
  const report = migrate(root);

  await t.test('the broken task is named separately and did not end up in tasks/', () => {
    assert.deepEqual(report.brokenTasks, [CLOSED]);
    assert.deepEqual(report.tasks.map((x) => x.id), [ACTIVE]);
    assert.equal(existsSync(path.join(target, 'tasks', CLOSED)), false);
  });

  await t.test('its directory is preserved in full, with the reason alongside', () => {
    assert.equal(existsSync(path.join(target, 'migration-broken', CLOSED, 'task.json')), true);
    assert.match(readFileSync(path.join(target, 'migration-broken', `${CLOSED}.txt`), 'utf8'),
      /journal did not parse/);
  });

  await t.test('meanwhile the healthy task reads fine', () => {
    assert.equal(store.readTask(target, ACTIVE).id, ACTIVE);
  });
});
