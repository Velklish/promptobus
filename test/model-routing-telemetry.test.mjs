// The participant telemetry record: what `promptobus done` appends, and — the
// point of the whole file — what it never carries. Run: npm test
//
// **Privacy is the acceptance criterion here, not a side check.** The record is
// assembled from a participant journal and a task journal, and those hold a
// repository path, a worktree directory, a branch, a session ref and every
// message body of the run. So one message body below carries a token-shaped
// string, an address and a path, and the file is grepped for all of them: a
// writer that spread `metadata` or kept a body would go red on this file and
// nowhere else. The mutation probe named in the task is exactly that check —
// write the participant's session ref into the record and it turns red.
//
// The rest is the arithmetic: who gets a record and who does not, the counts
// read off the canonical messages, the window delta against a fresh cache and
// against a stale one, and the one line `models` prints — which must NOT reach
// the decision stream, or the golden `models.txt` would move under a change that
// has nothing to do with the resolver.
//
// Home diversion before any import that is not a Node built-in: the telemetry
// file lives beside the availability cache under the account's home, and a file
// run by hand would otherwise write into the real one.
import './home.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { capture } from './console.mjs';
import { adapterMap, availableStub } from './routing-stubs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const SCHEMAS = path.join(ROOT, 'schemas', 'model-routing');
const FIXTURES = path.join(here, 'fixtures', 'model-routing');

const store = await import(path.join(ROOT, 'lib', 'store.js'));
const { done } = await import(path.join(ROOT, 'lib', 'done.js'));
const { models, routingContext, routingMetadata } = await import(path.join(ROOT, 'lib', 'models.js'));
const { hostOf } = await import(path.join(ROOT, 'lib', 'host.js'));
const telemetry = await import(path.join(ROOT, 'lib', 'model-routing', 'telemetry.js'));

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
for (const name of readdirSync(SCHEMAS).filter((n) => n.endsWith('.schema.json'))) {
  ajv.addSchema(readJson(path.join(SCHEMAS, name)));
}
const validate = ajv.getSchema('urn:promptobus:model-routing:telemetry');

// The strings that must not travel. They are planted in the places a record is
// assembled from — a message body, a participant record, the task id — and the
// whole file is grepped for them at the end.
const TOKEN = 'sk-test-promptobus-9f3a2c-not-a-real-secret';
const SESSION = 'sess-worker-01HQZZ';
const EMAIL = 'someone@example.invalid';
const REPO = '/private/nowhere/secret-client-repo';

const SB = makeSandbox('promptobus-telemetry-');
writeHostConfig(SB);
const HOME = path.join(SB, '.promptobus');
const host = hostOf(SB);
const CACHE = host.routingPaths().cacheFile;
const FILE = telemetry.telemetryFileOf(host);

/** A v2 availability snapshot at the cache path, stamped `agoMs` ago. */
function seedCache({ agoMs = 0, usedPercent = 55 } = {}) {
  const at = new Date(Date.now() - agoMs).toISOString();
  mkdirSync(path.dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, `${JSON.stringify({
    schemaVersion: 2,
    takenAt: at,
    harnesses: {
      claude: {
        state: 'available',
        reason: null,
        message: 'authenticated',
        checkedAt: at,
        source: 'probe',
        resetAt: null,
        windows: [
          { id: 'session', kind: 'session', lengthSec: 18000, usedPercent, resetAt: null, scope: null },
        ],
      },
    },
  }, null, 2)}\n`, { mode: 0o600 });
}

// The windows the routed lift records on the participant: the account-wide one
// and the model-scoped one that covers the tuple. The second is deliberately a
// window the cache entry does NOT carry — that is the `null` end reading.
const SPAWN_WINDOWS = [
  { id: 'session', kind: 'session', usedPercent: 40, scope: null },
  { id: 'weekly-opus', kind: 'weekly', usedPercent: 12, scope: { model: 'Opus', models: ['claude-opus'] } },
];

// Lift stamps are relative to the run's own clock: `durationSec` is measured
// against the moment `done` closes the task, and a fixed date would be in the
// future on any machine reading this after it.
const NOW = Date.now();
const ago = (minutes) => new Date(NOW - minutes * 60 * 1000).toISOString();
const T0 = ago(180);
const T1 = ago(90);
const T2 = ago(45);
const TASK = 'telemetriya-t20260906-090000';
store.createTask(HOME, { id: TASK, title: 'запись телеметрии', owner: null });

// Routed worker. Its record carries everything a record must not repeat: the
// clone path, the worktree, the branch and the session ref.
store.upsertParticipant(HOME, TASK, store.participantRecord('worker:api', {
  harness: 'claude',
  mode: 'managed',
  sessionRef: SESSION,
  name: SESSION,
  model: 'claude-opus',
  effort: 'high',
  started: T1,
  repoAbs: REPO,
  worktree: path.join(REPO, '.claude', 'worktrees', 'promptobus-api'),
  branch: 'worktree-promptobus-api',
  routing: {
    strategy: 'balance',
    role: 'worker',
    tupleId: 'claude.opus.high',
    harness: 'claude',
    model: 'claude-opus',
    effort: 'high',
    score: 71.25,
    strategySource: 'overlay:workspace',
    snapshot: { takenAt: T1, ageSec: 12, source: 'cache' },
    warnings: [],
    windows: SPAWN_WINDOWS,
  },
}));
// Routed reviewer on another harness, dismissed mid-run: its record must end at
// the dismissal, not at the close.
store.upsertParticipant(HOME, TASK, store.participantRecord('reviewer:api', {
  harness: 'codex',
  mode: 'managed',
  sessionRef: 'sess-reviewer',
  model: 'gpt-x',
  started: T1,
  routing: {
    strategy: 'quality', role: 'reviewer', tupleId: 'codex.gpt-x', windows: [],
  },
}));
store.dismissParticipant(HOME, TASK, 'reviewer:api', T2);
// Explicit `--model`, no routing at all. It gets a record too, so a hand-picked
// tuple is measured beside a routed one.
store.upsertParticipant(HOME, TASK, store.participantRecord('worker:hand', {
  harness: 'claude', mode: 'managed', sessionRef: 'sess-hand', model: 'claude-sonnet', started: T0,
}));
// An address that only ever wrote to the task: `sendMessage` writes such a record
// itself, already dismissed. It never lifted a session and must not be a row.
store.upsertParticipant(HOME, TASK, store.participantRecord('worker:mimo', { dismissed: T1 }));

// The mail. The bodies are the leak surface: one of them carries the token, the
// address and the clone path all at once.
const say = (from, to, type, body) => store.sendMessage(HOME, TASK, {
  from, to, type, body,
});
say('worker:api', 'orchestrator', 'status', 'взял задание, читаю код');
say('worker:api', 'orchestrator', 'question', `упёрся: в конфиге лежит ${TOKEN}, писать его в ${REPO}? пиши на ${EMAIL}`);
say('worker:api', 'orchestrator', 'result', 'готово, дифф на ветке');
say('orchestrator', 'worker:api', 'review', 'первый круг замечаний');
say('orchestrator', 'worker:api', 'review', 'второй круг замечаний');
say('worker:hand', 'orchestrator', 'result', 'ручной выбор модели, готово');

seedCache();
const noSessions = () => ({});
const out = await capture(async () => done(SB, { task: TASK, snapshot: noSessions }));

const lines = readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim());
const rows = lines.map((l) => JSON.parse(l));
const by = (role, model) => rows.find((r) => r.role === role && r.model === model);
const worker = by('worker', 'claude-opus');
const reviewer = by('reviewer', 'gpt-x');
const hand = by('worker', 'claude-sonnet');

check(': one record per participant that lifted a session — three of them',
  rows.length === 3, `${rows.length}: ${rows.map((r) => `${r.role}/${r.model}`).join(', ')}`);
// The filter is "lifted a session" — role worker/reviewer with a model on the
// record — and the two it excludes here share a harness with one it keeps, so a
// check by harness alone would pass on a writer that dropped the wrong one. The
// assertion is a BIJECTION: every lifted participant has exactly one row, and
// every row names a lifted participant's own role, harness and model.
const meta = store.readTask(HOME, TASK);
const liftedOf = (p) => (p.role === 'worker' || p.role === 'reviewer')
  && typeof p.metadata?.model === 'string' && Boolean(p.metadata.model);
const lifted = meta.participants.filter(liftedOf);
const unlifted = meta.participants.filter((p) => !liftedOf(p));
const same = (r, p) => r.role === p.role && r.harness === p.harness && r.model === p.metadata.model;
check(': five participants, three lifted a session — and the rows are exactly those three',
  meta.participants.length === 5 && lifted.length === 3 && rows.length === 3
  && lifted.every((p) => rows.filter((r) => same(r, p)).length === 1)
  && rows.every((r) => lifted.some((p) => same(r, p))),
  `${meta.participants.length} participants, ${lifted.length} lifted, ${rows.length} rows`);
check(': the two without a row are the task owner and an address that only ever wrote once',
  unlifted.map((p) => p.metadata?.address).sort().join(', ') === 'orchestrator, worker:mimo'
  && unlifted.every((p) => !p.metadata?.model),
  unlifted.map((p) => `${p.metadata?.address}/${p.harness}`).join(', '));
check(': done says how many records it appended and where',
  new RegExp(`telemetry: 3 record\\(s\\) appended to ${FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(out),
  out.trim());

for (const [i, row] of rows.entries()) {
  check(`: record ${i} validates against telemetry.schema.json`,
    validate(row) === true, ajv.errorsText(validate.errors));
}

check(': the routed worker carries its strategy, its source and its tuple',
  worker.strategy === 'balance' && worker.strategySource === 'overlay:workspace'
  && worker.tuple === 'claude.opus.high' && worker.effort === 'high',
  JSON.stringify({ s: worker.strategy, src: worker.strategySource, t: worker.tuple }));
check(': the counts are the bus traffic — turns, review rounds, questions, results',
  worker.turns === 3 && worker.reviewRounds === 2 && worker.questions === 1 && worker.resultCount === 1,
  JSON.stringify({
    turns: worker.turns, review: worker.reviewRounds, q: worker.questions, r: worker.resultCount,
  }));
check(': the window delta is the spawn reading against the current cache',
  worker.windows.length === 2
  && worker.windows[0].id === 'session' && worker.windows[0].usedPercentAtSpawn === 40
  && worker.windows[0].usedPercentAtEnd === 55,
  JSON.stringify(worker.windows[0]));
check(': a window the cache entry does not carry has no end reading, and is not invented',
  worker.windows[1].id === 'weekly-opus' && worker.windows[1].usedPercentAtEnd === null
  && worker.windows[1].scope.model === 'Opus',
  JSON.stringify(worker.windows[1]));
check(': the run is named, not one participant — the neighbour live on that harness at spawn is counted',
  worker.concurrentParticipants === 1, String(worker.concurrentParticipants));
check(': the duration runs from the lift to the close',
  worker.spawnedAt === T1 && worker.durationSec >= 90 * 60
  && worker.endedAt === worker.recordedAt, JSON.stringify({
    from: worker.spawnedAt, to: worker.endedAt, sec: worker.durationSec,
  }));

check(': a participant dismissed mid-run says so, and its record ends at the dismissal',
  reviewer.dismissedBeforeDone === true && reviewer.endedAt === T2 && reviewer.durationSec === 2700,
  JSON.stringify({ d: reviewer.dismissedBeforeDone, end: reviewer.endedAt, sec: reviewer.durationSec }));
check(': an explicit --model run is recorded too, with no strategy and no windows',
  hand.strategy === null && hand.strategySource === null && hand.tuple === null
  && hand.windows.length === 0 && hand.dismissedBeforeDone === false,
  JSON.stringify({ s: hand.strategy, t: hand.tuple, w: hand.windows.length }));
check(': a participant with no routing is still measured — its traffic is counted',
  hand.turns === 1 && hand.resultCount === 1, JSON.stringify({ turns: hand.turns, r: hand.resultCount }));

// --- a repeat `done` is not a second run -------------------------------------
//
// `closeTask` is idempotent and the reference asks for a second `promptobus done`
// after the sessions holding a worktree have been closed by hand. Without a gate
// each repeat would append the whole set again, and PB-37 reads one row as one
// participant run.
const afterFirst = readFileSync(FILE, 'utf8');
const againOut = await capture(async () => done(SB, { task: TASK, snapshot: noSessions }));
check(': a second done on the same task appends nothing and says nothing about telemetry',
  readFileSync(FILE, 'utf8') === afterFirst && !/telemetry:/.test(againOut), againOut.trim());

// --- the acceptance criterion ------------------------------------------------
//
// The mutation probe of the task is this check and this check alone: write the
// participant's session ref (or its clone path, or a message body) into a record
// and the line below turns red.
const text = readFileSync(FILE, 'utf8');
const leaks = [
  ['token from a message body', TOKEN],
  ['session ref of the participant', SESSION],
  ['account address from a message body', EMAIL],
  ['clone path', REPO],
  ['worktree directory', 'promptobus-api'],
  ['branch name', 'worktree-promptobus-api'],
  ['task id', TASK],
  ['message body', 'упёрся'],
  ['bus home', HOME],
];
for (const [what, needle] of leaks) {
  check(`: the record carries no ${what}`, !text.includes(needle), `found ${needle}`);
}
check(': the only identifier is the opaque one — the task digest, and it is not the id',
  rows.every((r) => /^[0-9a-f]{16}$/.test(r.task)) && new Set(rows.map((r) => r.task)).size === 1
  && rows[0].task === telemetry.taskHash(TASK) && rows[0].task !== TASK,
  rows[0].task);
check(': the file is the account\'s — mode 0600, like the cache beside it',
  (statSync(FILE).mode & 0o777) === 0o600, (statSync(FILE).mode & 0o777).toString(8));

// --- a stale cache measures nothing ------------------------------------------
//
// A second workspace, the same account. Two facts at once: a delta against a
// cache entry past its TTL is `null` rather than a number, and the file is the
// ACCOUNT's — the records of another workspace land in the same one.
const SB2 = makeSandbox('promptobus-telemetry-stale-');
writeHostConfig(SB2);
const HOME2 = path.join(SB2, '.promptobus');
const TASK2 = 'telemetriya-staryy-kesh-t20260906-100000';
store.createTask(HOME2, { id: TASK2, title: 'протухший кеш', owner: null });
store.upsertParticipant(HOME2, TASK2, store.participantRecord('worker:api', {
  harness: 'claude',
  mode: 'managed',
  sessionRef: 'sess-stale',
  model: 'claude-opus',
  started: T1,
  routing: { strategy: 'balance', tupleId: 'claude.opus.high', windows: SPAWN_WINDOWS },
}));
// Two hours old: past every TTL in the cascade, and past the window TTL by a
// hundred times.
seedCache({ agoMs: 2 * 60 * 60 * 1000 });
await capture(async () => done(SB2, { task: TASK2, snapshot: noSessions }));
const all = readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const stale = all[all.length - 1];
check(': the file is the account\'s, not one workspace\'s — a second workspace appends to the same one',
  all.length === 4, String(all.length));
check(': a stale cache gives no end reading at all — null, never a number',
  stale.windows.length === 2 && stale.windows.every((w) => w.usedPercentAtEnd === null),
  JSON.stringify(stale.windows));
check(': the spawn readings survive a stale cache — they were recorded, not measured now',
  stale.windows[0].usedPercentAtSpawn === 40 && stale.windows[1].usedPercentAtSpawn === 12,
  JSON.stringify(stale.windows.map((w) => w.usedPercentAtSpawn)));

// --- the one line `models` prints --------------------------------------------
//
// It goes past the decision stream on purpose. `--json` prints one document a
// machine parses, and the text form is pinned byte for byte by `models.txt`: a
// line inside either would break a reader that has nothing to do with telemetry.
const SB3 = makeSandbox('promptobus-telemetry-models-');
writeHostConfig(SB3, { tools: ['example', 'other'] });
const stubs = adapterMap({ example: availableStub(), other: availableStub() });
function sink() {
  const chunks = [];
  return { write: (c) => chunks.push(c), get text() { return chunks.join(''); } };
}
const textOut = sink();
const said = await capture(async () => models(hostOf(SB3), {
  strategy: 'balanced',
  role: 'worker',
  catalogFile: path.join(FIXTURES, 'catalog.json'),
  adapterFor: stubs,
  output: textOut,
}));
check(': `models` prints the record count and the file size, and nothing read out of the records',
  /telemetry: 4 record\(s\), \d+ B \(/.test(said) && !/strategy|tuple|score/.test(said.split('\n').find((l) => l.includes('telemetry:')) ?? ''),
  said.trim());
check(': the line does not enter the decision the text form prints — the golden cannot move under it',
  !textOut.text.includes('telemetry:'), textOut.text.slice(-200));

const jsonOut = sink();
const saidJson = await capture(async () => models(hostOf(SB3), {
  strategy: 'balanced',
  role: 'worker',
  json: true,
  catalogFile: path.join(FIXTURES, 'catalog.json'),
  adapterFor: stubs,
  output: jsonOut,
}));
check(': `--json` stays one document — the line is not in the stream and not on the console beside it',
  !jsonOut.text.includes('telemetry:') && !saidJson.includes('telemetry:')
  && typeof JSON.parse(jsonOut.text) === 'object', saidJson.trim());

// --- nothing to write, and nowhere to write ----------------------------------
const SB4 = makeSandbox('promptobus-telemetry-empty-');
writeHostConfig(SB4);
const HOME4 = path.join(SB4, '.promptobus');
const TASK4 = 'telemetriya-bez-uchastnikov-t20260906-110000';
store.createTask(HOME4, { id: TASK4, title: 'некого записывать', owner: null });
const before = readFileSync(FILE, 'utf8');
const emptyOut = await capture(async () => done(SB4, { task: TASK4, snapshot: noSessions }));
check(': a task nobody lifted a session in appends nothing and says nothing',
  readFileSync(FILE, 'utf8') === before && !/telemetry:/.test(emptyOut), emptyOut.trim());

// A close must not fail on the telemetry file. The routing directory is made
// unreachable — a regular file sits where it should be, which is what an
// operator's own home looks like from here when it is not the shape we assume.
const SB5 = makeSandbox('promptobus-telemetry-blocked-');
writeHostConfig(SB5);
const HOME5 = path.join(SB5, '.promptobus');
const TASK5 = 'telemetriya-net-kataloga-t20260906-120000';
store.createTask(HOME5, { id: TASK5, title: 'некуда писать', owner: null });
store.upsertParticipant(HOME5, TASK5, store.participantRecord('worker:api', {
  harness: 'claude', mode: 'managed', sessionRef: 'sess-ro', model: 'claude-opus', started: T1,
}));
const wall = path.join(SB5, 'not-a-directory');
writeFileSync(wall, 'a file where the routing directory should be\n');
const blockedHost = {
  ...hostOf(SB5),
  routingPaths: () => ({ cacheFile: path.join(wall, 'model-routing', 'cache.json'), overlays: [] }),
};
const roOut = await capture(async () => done(blockedHost, { task: TASK5, snapshot: noSessions }));
check(': a path that cannot be written warns and does not undo the close',
  /telemetry records were not written/.test(roOut) && /closed/.test(roOut)
  && store.readTask(HOME5, TASK5).status === 'done', roOut.trim());
check(': the account\'s own file is untouched by that run',
  existsSync(FILE) && readFileSync(FILE, 'utf8') === before, 'the blocked run wrote anyway');

// --- the real routed lift, end to end ----------------------------------------
//
// Everything above hand-seeds `metadata.routing`. This one does not: the
// resolver picks a tuple against the fixture catalog and a fresh snapshot,
// `routingMetadata` computes the applicable windows of that tuple exactly as a
// routed `spawn` would, and the record reads them back. It is the seam between
// PB-30 and this task, and the only check that would notice the two halves
// naming a window field differently.
const SB6 = makeSandbox('promptobus-telemetry-routed-');
writeHostConfig(SB6, { tools: ['example'] });
const HOME6 = path.join(SB6, '.promptobus');
const host6 = hostOf(SB6);

/** A fresh snapshot of the fixture harness: one account-wide window, one scoped to the deep model. */
function seedExample(usedPercent) {
  const at = new Date().toISOString();
  const soon = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
  mkdirSync(path.dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, `${JSON.stringify({
    schemaVersion: 2,
    takenAt: at,
    harnesses: {
      example: {
        state: 'available',
        reason: null,
        message: 'authenticated',
        checkedAt: at,
        source: 'probe',
        resetAt: null,
        models: [{ model: 'example-deep', rated: true }, { model: 'example-quick', rated: true }],
        windows: [
          { id: 'session', kind: 'session', lengthSec: 18000, usedPercent, resetAt: soon, scope: null },
          {
            id: 'weekly-example-deep',
            kind: 'weekly',
            lengthSec: 604800,
            usedPercent: 12,
            resetAt: soon,
            scope: { model: 'Example Deep', models: ['example-deep'] },
          },
        ],
      },
    },
  }, null, 2)}\n`, { mode: 0o600 });
}

seedExample(40);
const ctx = await routingContext(host6, {
  strategy: 'balanced',
  role: 'worker',
  model: 'example-deep',
  dryRun: true,
  catalogFile: path.join(FIXTURES, 'catalog.json'),
  adapterFor: adapterMap({ example: availableStub() }),
});
const decision = ctx.decide();
const routed = routingMetadata(decision, ctx.snapshot);
check(': the routed lift itself records the applicable windows of the tuple it chose',
  routed.windows.length === 2 && routed.windows.every((w) => typeof w.usedPercent === 'number'),
  JSON.stringify(routed.windows));

const TASK6 = 'telemetriya-marshrut-t20260906-130000';
store.createTask(HOME6, { id: TASK6, title: 'настоящий маршрутизированный подъём', owner: null });
store.upsertParticipant(HOME6, TASK6, store.participantRecord('worker:api', {
  harness: routed.harness,
  mode: 'managed',
  sessionRef: 'sess-routed',
  model: routed.model,
  ...(routed.effort ? { effort: routed.effort } : {}),
  started: T1,
  routing: routed,
}));
// The account spent a quarter of its session window while the participant worked.
seedExample(66);
await capture(async () => done(SB6, { task: TASK6, snapshot: noSessions }));
const routedRows = readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const row = routedRows[routedRows.length - 1];
check(': the record validates and carries the tuple the resolver actually chose',
  validate(row) === true && row.tuple === routed.tupleId && row.tuple === decision.chosen.tupleId
  && row.strategy === 'balanced' && row.harness === routed.harness && row.model === routed.model,
  `${ajv.errorsText(validate.errors)} · ${JSON.stringify({ t: row.tuple, s: row.strategy })}`);
check(': the windows the lift recorded are the windows the record reads back, by id and by value',
  row.windows.length === routed.windows.length
  && routed.windows.every((w) => row.windows.some((r) => r.id === w.id
    && r.kind === w.kind && r.usedPercentAtSpawn === w.usedPercent)),
  JSON.stringify(row.windows));
const session = row.windows.find((w) => w.id === 'session');
const weekly = row.windows.find((w) => w.id === 'weekly-example-deep');
check(': the delta on the account-wide window is what the run spent — 66 at the close against 40 at the lift',
  session.usedPercentAtSpawn === 40 && session.usedPercentAtEnd === 66
  && session.usedPercentAtEnd - session.usedPercentAtSpawn === 26, JSON.stringify(session));
check(': a window that did not move reads as a zero delta, not as an absence',
  weekly.usedPercentAtSpawn === 12 && weekly.usedPercentAtEnd === 12
  && weekly.scope.models.includes('example-deep'), JSON.stringify(weekly));
