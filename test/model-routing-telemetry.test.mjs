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
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { capture } from './console.mjs';
import { adapterMap, answeringStub, availableStub, counter } from './routing-stubs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const SCHEMAS = path.join(ROOT, 'schemas', 'model-routing');
const FIXTURES = path.join(here, 'fixtures', 'model-routing');

const store = await import(path.join(ROOT, 'lib', 'store.js'));
const { done } = await import(path.join(ROOT, 'lib', 'done.js'));
const { models, routingContext, routingMetadata } = await import(path.join(ROOT, 'lib', 'models.js'));
const { hostOf } = await import(path.join(ROOT, 'lib', 'host.js'));
const telemetry = await import(path.join(ROOT, 'lib', 'model-routing', 'telemetry.js'));
const { ROUTED_ROLES } = await import(path.join(ROOT, 'lib', 'model-routing', 'catalog.js'));
const { PROVEN_CODEX_VERSION } = await import(path.join(ROOT, 'lib', 'driver-codex.js'));
const publicTelemetry = await import(path.join(ROOT, 'dist', 'telemetry.js'));

// PB-212: telemetrySummary has one implementation, re-exported, not two that could agree by
// coincidence — a defect in the shared algorithm cannot hide behind output parity any more.
check(': telemetry.telemetrySummary is the same function as the public one, not a twin',
  telemetry.telemetrySummary === publicTelemetry.telemetrySummary, 'the re-export is missing');

// The owner gate is a positive proof, and the suite strips harness identity from the
// environment: a file that cannot name its caller would only ever see the refusal.
process.env.CLAUDE_CODE_SESSION_ID = 'sess-telemetry-stand';

const defaultTelemetryAdapter = adapterMap({
  claude: answeringStub({
    state: 'available', reason: null, message: 'refreshed',
    checkedAt: new Date().toISOString(), source: 'probe', resetAt: null,
    windows: [{ id: 'session', kind: 'session', lengthSec: 18000, usedPercent: 55, resetAt: null, scope: null }],
  }),
});
const refusingTelemetryAdapter = adapterMap({
  claude: answeringStub({
    state: 'unknown', reason: 'probe_failed', message: 'stand-in refusal',
    checkedAt: new Date().toISOString(), source: 'probe', resetAt: null,
  }),
});
const close = (root, opts = {}) => done(root, { adapterFor: defaultTelemetryAdapter, ...opts });

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const CODEX_USAGE_FIELDS = [
  'input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
  'output_tokens', 'reasoning_output_tokens', 'total_tokens',
];
const codexRolloutFixture = readJson(path.join(
  here, 'fixtures', 'codex-app-server', PROVEN_CODEX_VERSION,
  'TokenUsage-0.156.1-2026-09-25.json',
));
const codexUsage = [
  codexRolloutFixture.event?.payload?.info?.last_token_usage,
  codexRolloutFixture.event?.payload?.info?.total_token_usage,
];
check(': the Codex rollout fixture keeps usage evidence outside throughput',
  codexRolloutFixture.event?.type === 'event_msg'
  && codexRolloutFixture.event?.payload?.type === 'token_count'
  && codexUsage.every((usage) => usage
    && CODEX_USAGE_FIELDS.every((field) => typeof usage[field] === 'number'))
  && codexRolloutFixture.event?.payload?.info?.model_context_window !== undefined
  && codexRolloutFixture.event?.payload?.rate_limits !== undefined
  && telemetry.throughputObservationOf(codexRolloutFixture.event) === null,
  JSON.stringify(codexRolloutFixture.event));
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
function seedCache({ cacheFile = CACHE, agoMs = 0, usedPercent = 55, state = 'available', resetAt = null } = {}) {
  const at = new Date(Date.now() - agoMs).toISOString();
  mkdirSync(path.dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, `${JSON.stringify({
    schemaVersion: 2,
    takenAt: at,
    harnesses: {
      claude: {
        state,
        reason: state === 'exhausted' ? 'subscription_exhausted' : null,
        message: 'authenticated',
        checkedAt: at,
        source: 'probe',
        resetAt,
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
// against each participant's own result (or its dismissal/close), and a fixed
// date would be in the future on any machine reading this after it.
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
const workerThroughputFile = telemetry.throughputSidecarFile(HOME, TASK, 'worker:api');
mkdirSync(path.dirname(workerThroughputFile), { recursive: true });
writeFileSync(workerThroughputFile, `${JSON.stringify({
  outputTokens: 300, generationDurationSec: 6,
})}\n`, { mode: telemetry.THROUGHPUT_SIDECAR_MODE });
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
store.upsertParticipant(HOME, TASK, store.participantRecord('approver:api', {
  harness: 'claude',
  mode: 'managed',
  sessionRef: 'sess-approver',
  model: 'claude-fable-5-1',
  started: T2,
  routing: { strategy: 'quality', role: 'approver', tupleId: 'claude-fable-51-high', windows: [] },
}));
// Explicit `--model`, no routing at all. It gets a record too, so a hand-picked
// tuple is measured beside a routed one.
store.upsertParticipant(HOME, TASK, store.participantRecord('worker:hand', {
  harness: 'claude', mode: 'managed', sessionRef: 'sess-hand', model: 'claude-sonnet', started: T0,
}));
// An address that only ever wrote to the task: `sendMessage` writes such a record
// itself, already dismissed. It never lifted a session and must not be a row.
store.upsertParticipant(HOME, TASK, store.participantRecord('worker:mimo', { dismissed: T1 }));

// A model-bearing but deliberately unrouted participant must stay out of telemetry.
store.upsertParticipant(HOME, TASK, {
  id: 'architect-future',
  role: 'architect',
  harness: 'claude',
  mode: 'managed',
  sessionRef: 'sess-architect',
  capabilities: null,
  metadata: { address: 'architect:future', model: 'future-model', started: T1 },
});

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
const out = await capture(async () => close(SB, { task: TASK, snapshot: noSessions }));

const lines = readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim());
const rows = lines.map((l) => JSON.parse(l));
const by = (role, model) => rows.find((r) => r.role === role && r.model === model);
const worker = by('worker', 'claude-opus');
const reviewer = by('reviewer', 'gpt-x');
const approver = by('approver', 'claude-fable-5-1');
const hand = by('worker', 'claude-sonnet');

check(': one record per participant that lifted a session — four of them',
  rows.length === 4, `${rows.length}: ${rows.map((r) => `${r.role}/${r.model}`).join(', ')}`);
// The filter is "lifted a session" — a participant role with a model on the
// record — and the two it excludes here share a harness with one it keeps, so a
// check by harness alone would pass on a writer that dropped the wrong one. The
// assertion is a BIJECTION: every lifted participant has exactly one row, and
// every row names a lifted participant's own role, harness and model.
const meta = store.readTask(HOME, TASK);
const liftedOf = (p) => ROUTED_ROLES.includes(p.role)
  && typeof p.metadata?.model === 'string' && Boolean(p.metadata.model);
const lifted = meta.participants.filter(liftedOf);
const unlifted = meta.participants.filter((p) => !liftedOf(p));
const same = (r, p) => r.role === p.role && r.harness === p.harness && r.model === p.metadata.model;
check(': seven participants, four lifted a session — and the rows are exactly those four',
  meta.participants.length === 7 && lifted.length === 4 && rows.length === 4
  && lifted.every((p) => rows.filter((r) => same(r, p)).length === 1)
  && rows.every((r) => lifted.some((p) => same(r, p))),
  `${meta.participants.length} participants, ${lifted.length} lifted, ${rows.length} rows`);
check(': the three without a row include a model-bearing unrouted address',
  unlifted.map((p) => p.metadata?.address).sort().join(', ') === 'architect:future, orchestrator, worker:mimo'
  && unlifted.some((p) => p.metadata?.address === 'architect:future'
    && p.metadata?.model === 'future-model')
  && unlifted.filter((p) => p.metadata?.address !== 'architect:future')
    .every((p) => !p.metadata?.model),
  unlifted.map((p) => `${p.metadata?.address}/${p.harness}`).join(', '));
check(': done says how many records it appended and where',
  new RegExp(`telemetry: 4 record\\(s\\) appended to ${FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(out),
  out.trim());

for (const [i, row] of rows.entries()) {
  check(`: record ${i} validates against telemetry.schema.json`,
    validate(row) === true, ajv.errorsText(validate.errors));
}

check(': the approver record carries the addressed role and its routing tuple',
  approver.role === 'approver' && approver.tuple === 'claude-fable-51-high',
  JSON.stringify(approver));

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
check(': the duration runs from the lift to the worker\'s last result',
  worker.spawnedAt === T1 && worker.lastResultAt !== null
  && worker.endedAt === worker.lastResultAt && worker.durationSec >= 90 * 60,
  JSON.stringify({
    from: worker.spawnedAt, result: worker.lastResultAt, to: worker.endedAt, sec: worker.durationSec,
  }));
check(': throughput evidence is projected without using completion duration',
  worker.throughput?.outputTokens === 300
  && worker.throughput?.generationDurationSec === 6
  && worker.throughput?.tokensPerSecond === null,
  JSON.stringify(worker.throughput));
const partialThroughput = {
  outputTokens: 184, generationDurationSec: null, tokensPerSecond: null,
};
check(': a partial throughput observation is schema-valid but not a calibration rate',
  validate({ ...worker, throughput: partialThroughput }) === true
  && telemetry.throughputRate(partialThroughput) === null,
  JSON.stringify({ errors: validate.errors, rate: telemetry.throughputRate(partialThroughput) }));
check(': a pair and a direct rate both normalize to tokens per second',
  telemetry.throughputRate({ outputTokens: 300, generationDurationSec: 6 }) === 50
  && telemetry.throughputRate({ tokensPerSecond: 50 }) === 50,
  JSON.stringify({ pair: telemetry.throughputRate({ outputTokens: 300, generationDurationSec: 6 }),
    direct: telemetry.throughputRate({ tokensPerSecond: 50 }) }));
check(': throughput absence is null and zero is not accepted as a rate',
  telemetry.throughputObservationOf({}) === null
  && validate({ ...worker, throughput: { outputTokens: null, generationDurationSec: null, tokensPerSecond: 0 } }) === false,
  JSON.stringify({ empty: telemetry.throughputObservationOf({}), errors: validate.errors }));

const directRateSidecar = telemetry.throughputSidecarFile(HOME, TASK, 'worker:direct-rate');
writeFileSync(directRateSidecar, [
  { outputTokens: 100, tokensPerSecond: 10 },
  { outputTokens: 300, tokensPerSecond: 20 },
].map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: telemetry.THROUGHPUT_SIDECAR_MODE });
const directRateTotals = telemetry.readThroughputSidecar(HOME, TASK, 'worker:direct-rate');
check(': direct sidecar rates use a token-weighted mean instead of the last turn',
  directRateTotals?.outputTokens === 400
  && directRateTotals?.generationDurationSec === null
  && directRateTotals?.tokensPerSecond === 17.5,
  JSON.stringify(directRateTotals));

const mixedSidecar = telemetry.throughputSidecarFile(HOME, TASK, 'worker:mixed');
writeFileSync(mixedSidecar, [
  { outputTokens: 5000 },
  { generationDurationSec: 2 },
].map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: telemetry.THROUGHPUT_SIDECAR_MODE });
const mixedTotals = telemetry.readThroughputSidecar(HOME, TASK, 'worker:mixed');
check(': mixed sidecar turns do not manufacture a pair across observations',
  mixedTotals?.outputTokens === 5000
  && mixedTotals?.generationDurationSec === null
  && mixedTotals?.tokensPerSecond === null,
  JSON.stringify(mixedTotals));

check(': a participant dismissed mid-run says so, and its record ends at the dismissal',
  reviewer.dismissedBeforeDone === true && reviewer.lastResultAt === null
  && reviewer.endedAt === T2 && reviewer.durationSec === 2700,
  JSON.stringify({ d: reviewer.dismissedBeforeDone, end: reviewer.endedAt, sec: reviewer.durationSec }));
check(': an explicit --model run is recorded too, with no strategy and no windows',
  hand.strategy === null && hand.strategySource === null && hand.tuple === null
  && hand.windows.length === 0 && hand.dismissedBeforeDone === false && hand.throughput === null,
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
const againOut = await capture(async () => close(SB, { task: TASK, snapshot: noSessions }));
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
await capture(async () => close(SB2, {
  task: TASK2, snapshot: noSessions, adapterFor: refusingTelemetryAdapter,
}));
const all = readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const stale = all[all.length - 1];
check(': the file is the account\'s, not one workspace\'s — a second workspace appends to the same one',
  all.length === 5, String(all.length));
check(': a stale cache gives no end reading at all — null, never a number',
  stale.windows.length === 2 && stale.windows.every((w) => w.usedPercentAtEnd === null),
  JSON.stringify(stale.windows));
check(': the spawn readings survive a stale cache — they were recorded, not measured now',
  stale.windows[0].usedPercentAtSpawn === 40 && stale.windows[1].usedPercentAtSpawn === 12,
  JSON.stringify(stale.windows.map((w) => w.usedPercentAtSpawn)));

// The direct writer does not refresh: its omitted snapshot must read the cache
// as it stands and therefore retain the PB-77 stale-cache null. Keep its cache
// and telemetry file separate from the account-wide fixture above.
const SB_DIRECT = makeSandbox('promptobus-telemetry-direct-');
writeHostConfig(SB_DIRECT);
const directBase = hostOf(SB_DIRECT);
const directCache = path.join(SB_DIRECT, 'routing', 'cache.json');
const directHost = Object.create(directBase);
directHost.routingPaths = () => ({ ...directBase.routingPaths(), cacheFile: directCache });
const directHome = directHost.promptobusHome();
const directTask = 'telemetriya-pryamaya-zapis-t20260906-100000';
store.createTask(directHome, { id: directTask, title: 'прямая запись', owner: null });
store.upsertParticipant(directHome, directTask, store.participantRecord('worker:api', {
  harness: 'claude', mode: 'managed', sessionRef: 'sess-direct', model: 'claude-opus', started: T1,
  routing: { strategy: 'balance', tupleId: 'claude.opus.high', windows: SPAWN_WINDOWS },
}));
seedCache({ cacheFile: directCache, agoMs: 2 * 60 * 60 * 1000 });
const directWrite = telemetry.appendTelemetry(directHost, directHome, store.readTask(directHome, directTask));
const directRows = readFileSync(directWrite.file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
check(': direct appendTelemetry without a snapshot gives no end reading from a stale cache',
  directRows.length === 1 && directRows[0].windows.every((w) => w.usedPercentAtEnd === null),
  JSON.stringify(directRows[0]?.windows));

// Routing keeps an exhausted entry until its own reset — or forever when the
// reset is unknown. Telemetry has a different question: whether the percentage
// is fresh enough to subtract from the spawn reading. Both exhausted forms are
// deliberately past the window TTL, so neither may supply an end reading.
const futureReset = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
for (const [label, resetAt, taskId] of [
  ['an exhausted entry with a future reset', futureReset, 'telemetriya-izraskhodovannyy-t20260906-100001'],
  ['a sticky exhausted entry with no reset', null, 'telemetriya-lipko-izraskhodovannyy-t20260906-100002'],
]) {
  store.createTask(HOME2, { id: taskId, title: label, owner: null });
  store.upsertParticipant(HOME2, taskId, store.participantRecord('worker:api', {
    harness: 'claude',
    mode: 'managed',
    sessionRef: `sess-${taskId}`,
    model: 'claude-opus',
    started: T1,
    routing: { strategy: 'balance', tupleId: 'claude.opus.high', windows: SPAWN_WINDOWS },
  }));
  seedCache({ agoMs: 2 * 60 * 60 * 1000, state: 'exhausted', resetAt });
  const exhaustedOut = await capture(async () => close(SB2, {
    task: taskId, snapshot: noSessions, adapterFor: refusingTelemetryAdapter,
  }));
  const exhausted = readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => JSON.parse(l)).at(-1);
  check(`: ${label} past the TTL gives no end reading`,
    exhausted.windows.length === 2 && exhausted.windows.every((w) => w.usedPercentAtEnd === null),
    JSON.stringify(exhausted.windows));
  if (!resetAt) {
    check(': a held exhausted entry names its own reason once',
      /telemetry: claude window not re-read \(subscription_exhausted\) — end reading absent/.test(exhaustedOut),
      exhaustedOut.trim());
  }
}

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
  /telemetry: 7 record\(s\), \d+ B \(/.test(said) && !/strategy|tuple|score/.test(said.split('\n').find((l) => l.includes('telemetry:')) ?? ''),
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

// Routing state does not decide whether an end reading exists: an exhausted
// answer can still carry a fresh window percentage, and an available answer
// can carry none.
const FRESH_EXHAUSTED_TASK = 'telemetriya-svezhiy-izraskhodovannyy-t20260906-100003';
store.createTask(HOME2, { id: FRESH_EXHAUSTED_TASK, title: 'свежее исчерпание', owner: null });
store.upsertParticipant(HOME2, FRESH_EXHAUSTED_TASK, store.participantRecord('worker:api', {
  harness: 'claude', mode: 'managed', sessionRef: 'sess-fresh-exhausted', model: 'claude-opus', started: T1,
  routing: { strategy: 'balance', tupleId: 'claude.opus.high', windows: SPAWN_WINDOWS },
}));
seedCache({ agoMs: 2 * 60 * 60 * 1000 });
const freshExhaustedOut = await capture(async () => close(SB2, {
  task: FRESH_EXHAUSTED_TASK,
  snapshot: noSessions,
  adapterFor: adapterMap({
    claude: answeringStub({
      state: 'exhausted', reason: 'subscription_exhausted', message: 'limit spent',
      checkedAt: new Date().toISOString(), source: 'probe', resetAt: futureReset,
      windows: [{ id: 'session', kind: 'session', lengthSec: 18000, usedPercent: 61, resetAt: null, scope: null }],
    }),
  }),
}));
const freshExhausted = readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).at(-1);
check(': a fresh exhausted answer supplies its end reading',
  freshExhausted.windows[0].usedPercentAtEnd === 61, JSON.stringify(freshExhausted.windows[0]));
check(': a fresh exhausted answer reports its missing scoped window',
  /telemetry: claude window weekly-opus not re-read \(no_window_reading\) — end reading absent/.test(freshExhaustedOut),
  freshExhaustedOut.trim());

const EMPTY_WINDOWS_TASK = 'telemetriya-svezhiy-pustoy-t20260906-100004';
store.createTask(HOME2, { id: EMPTY_WINDOWS_TASK, title: 'пустые окна', owner: null });
store.upsertParticipant(HOME2, EMPTY_WINDOWS_TASK, store.participantRecord('worker:api', {
  harness: 'claude', mode: 'managed', sessionRef: 'sess-empty-windows', model: 'claude-opus', started: T1,
  routing: { strategy: 'balance', tupleId: 'claude.opus.high', windows: SPAWN_WINDOWS },
}));
seedCache({ agoMs: 2 * 60 * 60 * 1000 });
const emptyWindowsOut = await capture(async () => close(SB2, {
  task: EMPTY_WINDOWS_TASK,
  snapshot: noSessions,
  adapterFor: adapterMap({
    claude: answeringStub({
      state: 'available', reason: null, message: 'no limits reported',
      checkedAt: new Date().toISOString(), source: 'probe', resetAt: null, windows: [],
    }),
  }),
}));
const emptyWindows = readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).at(-1);
check(': an available answer with no windows leaves the end reading absent',
  emptyWindows.windows.every((w) => w.usedPercentAtEnd === null), JSON.stringify(emptyWindows.windows));
check(': an available answer with no windows names the missing reading',
  /telemetry: claude window session not re-read \(no_window_reading\) — end reading absent/.test(emptyWindowsOut)
  && /telemetry: claude window weekly-opus not re-read \(no_window_reading\) — end reading absent/.test(emptyWindowsOut),
  emptyWindowsOut.trim());

// --- done refreshes only the window-bearing harnesses it records --------------
//
// A close owns the one probe that can make its end reading fresh. The cache is
// deliberately stale before each close, so a passing record proves the adapter
// answer, not a value left over from the previous check.
const REFRESH_TASK = 'telemetriya-avto-obnovlenie-t20260906-100003';
store.createTask(HOME2, { id: REFRESH_TASK, title: 'автоматическое обновление', owner: null });
store.upsertParticipant(HOME2, REFRESH_TASK, store.participantRecord('worker:api', {
  harness: 'claude', mode: 'managed', sessionRef: 'sess-refresh', model: 'claude-opus', started: T1,
  routing: { strategy: 'balance', tupleId: 'claude.opus.high', windows: SPAWN_WINDOWS },
}));
seedCache({ agoMs: 2 * 60 * 60 * 1000 });
const refreshCount = counter();
const otherCount = counter();
const refreshOut = await capture(async () => close(SB2, {
  task: REFRESH_TASK,
  snapshot: noSessions,
  adapterFor: adapterMap({
    claude: answeringStub({
      state: 'available', reason: null, message: 'refreshed',
      checkedAt: new Date().toISOString(), source: 'probe', resetAt: null,
      windows: [{ id: 'session', kind: 'session', lengthSec: 18000, usedPercent: 66, resetAt: null, scope: null }],
    }, refreshCount),
    cursor: availableStub(otherCount),
  }),
}));
const refreshed = readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).at(-1);
check(': done refreshes the recorded harness before reading its end window',
  refreshed.windows[0].usedPercentAtEnd === 66 && refreshCount.probes === 1,
  JSON.stringify({ end: refreshed.windows[0].usedPercentAtEnd, probes: refreshCount.probes }));
check(': done does not probe a harness with no telemetry record',
  otherCount.probes === 0, String(otherCount.probes));
check(': a successful telemetry refresh reports its missing scoped window',
  /telemetry: claude window weekly-opus not re-read \(no_window_reading\) — end reading absent/.test(refreshOut),
  refreshOut.trim());

const SPLIT_TASK = 'telemetriya-raznye-okna-t20260906-100005';
store.createTask(HOME2, { id: SPLIT_TASK, title: 'разные окна', owner: null });
store.upsertParticipant(HOME2, SPLIT_TASK, store.participantRecord('worker:api', {
  harness: 'claude', mode: 'managed', sessionRef: 'sess-split-session', model: 'claude-opus', started: T1,
  routing: { strategy: 'balance', tupleId: 'claude.opus.high', windows: [SPAWN_WINDOWS[0]] },
}));
store.upsertParticipant(HOME2, SPLIT_TASK, store.participantRecord('worker:other', {
  harness: 'claude', mode: 'managed', sessionRef: 'sess-split-weekly', model: 'claude-opus', started: T1,
  routing: { strategy: 'balance', tupleId: 'claude.opus.high', windows: [SPAWN_WINDOWS[1]] },
}));
seedCache({ agoMs: 2 * 60 * 60 * 1000 });
const splitOut = await capture(async () => close(SB2, {
  task: SPLIT_TASK,
  snapshot: noSessions,
  adapterFor: adapterMap({
    claude: answeringStub({
      state: 'available', reason: null, message: 'session limit only',
      checkedAt: new Date().toISOString(), source: 'probe', resetAt: null,
      windows: [{ id: 'session', kind: 'session', lengthSec: 18000, usedPercent: 70, resetAt: null, scope: null }],
    }),
  }),
}));
const splitRows = readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).slice(-2);
const splitSession = splitRows.find((row) => row.windows[0]?.id === 'session');
const splitWeekly = splitRows.find((row) => row.windows[0]?.id === 'weekly-opus');
const splitWarnings = splitOut.split('\n').filter((line) => line.includes('not re-read'));
check(': two participants with different window sets keep the session end reading and lose only weekly',
  splitRows.length === 2 && splitSession?.windows[0].usedPercentAtEnd === 70
  && splitWeekly?.windows[0].usedPercentAtEnd === null,
  JSON.stringify(splitRows));
check(': partial coverage warns once for the missing scoped window',
  splitWarnings.length === 1 && /claude window weekly-opus not re-read \(no_window_reading\)/.test(splitWarnings[0]),
  splitWarnings.join('\n'));

const REFUSAL_TASK = 'telemetriya-otkaz-obnovleniya-t20260906-100004';
store.createTask(HOME2, { id: REFUSAL_TASK, title: 'отказ обновления', owner: null });
store.upsertParticipant(HOME2, REFUSAL_TASK, store.participantRecord('worker:api', {
  harness: 'claude', mode: 'managed', sessionRef: 'sess-refusal', model: 'claude-opus', started: T1,
  routing: { strategy: 'balance', tupleId: 'claude.opus.high', windows: SPAWN_WINDOWS },
}));
seedCache({ agoMs: 2 * 60 * 60 * 1000 });
const refusalOut = await capture(async () => close(SB2, {
  task: REFUSAL_TASK,
  snapshot: noSessions,
  adapterFor: adapterMap({
    claude: answeringStub({
      state: 'unknown', reason: 'probe_failed', message: 'stand-in refusal',
      checkedAt: new Date().toISOString(), source: 'probe', resetAt: null,
    }),
  }),
}));
const refused = readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).at(-1);
check(': a refused refresh leaves the end reading absent',
  refused.windows[0].usedPercentAtEnd === null, JSON.stringify(refused.windows[0]));
check(': a refused refresh warns with the reason and still closes the task',
  /telemetry: claude window not re-read \(probe_failed\) — end reading absent/.test(refusalOut)
  && /closed/.test(refusalOut) && store.readTask(HOME2, REFUSAL_TASK).status === 'done', refusalOut.trim());

// --- nothing to write, and nowhere to write ----------------------------------
const SB4 = makeSandbox('promptobus-telemetry-empty-');
writeHostConfig(SB4);
const HOME4 = path.join(SB4, '.promptobus');
const TASK4 = 'telemetriya-bez-uchastnikov-t20260906-110000';
store.createTask(HOME4, { id: TASK4, title: 'некого записывать', owner: null });
const before = readFileSync(FILE, 'utf8');
const emptyOut = await capture(async () => close(SB4, { task: TASK4, snapshot: noSessions }));
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
const roOut = await capture(async () => close(blockedHost, { task: TASK5, snapshot: noSessions }));
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
await capture(async () => close(SB6, {
  task: TASK6,
  snapshot: noSessions,
  adapterFor: adapterMap({
    example: answeringStub({
      state: 'available', reason: null, message: 'refreshed',
      checkedAt: new Date().toISOString(), source: 'probe', resetAt: null,
      windows: [
        { id: 'session', kind: 'session', lengthSec: 18000, usedPercent: 66, resetAt: null, scope: null },
        {
          id: 'weekly-example-deep', kind: 'weekly', lengthSec: 604800, usedPercent: 12,
          resetAt: new Date(Date.now() + 3_600_000).toISOString(),
          scope: { model: 'Example Deep', models: ['example-deep'] },
        },
      ],
    }),
  }),
}));
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

// A malformed participant address must not stop `done` from writing the other
// participants' rows. This is kept after the account-wide assertions above:
// the sandbox host intentionally shares the account telemetry file.
const badAddressSandbox = makeSandbox('promptobus-telemetry-invalid-');
writeHostConfig(badAddressSandbox);
const badAddressHome = path.join(badAddressSandbox, '.promptobus');
const badAddressHost = hostOf(badAddressSandbox);
const badAddressTask = 'telemetriya-invalid-t20260906-100000';
const badAddressMeta = store.createTask(badAddressHome, { id: badAddressTask, title: 'негодный адрес', owner: null });
badAddressMeta.participants.push(store.participantRecord('worker:good', {
  harness: 'claude', model: 'claude-opus', started: T1,
}));
badAddressMeta.participants.push({
  id: 'worker-bad', role: 'worker', harness: 'claude', mode: 'attached', sessionRef: null,
  capabilities: null, metadata: { address: 'not-an-address', model: 'claude-opus', started: T1 },
});
writeFileSync(store.taskFile(badAddressHome, badAddressTask), JSON.stringify(badAddressMeta, null, 2) + '\n');
store.sendMessage(badAddressHome, badAddressTask, {
  from: 'orchestrator',
  to: 'worker:good',
  type: 'task',
  body: 'canonical timing fixture',
});
telemetry.appendThroughputObservation(badAddressHome, badAddressTask, 'worker:good', { output_tokens: 42 });
await capture(async () => close(badAddressSandbox, { task: badAddressTask, snapshot: noSessions }));
const badAddressFile = telemetry.telemetryFileOf(badAddressHost);
const badAddressRows = readFileSync(badAddressFile, 'utf8').split('\n').filter((line) => line.trim())
  .map((line) => JSON.parse(line))
  .filter((row) => row.task === telemetry.taskHash(badAddressTask));
const goodAddressRow = badAddressRows.find((row) => row.model === 'claude-opus' && row.throughput?.outputTokens === 42);
check(': one invalid participant address does not prevent the valid row from being written',
  badAddressRows.length === 2 && goodAddressRow?.throughput?.outputTokens === 42,
  JSON.stringify(badAddressRows));

// --- each participant's own result ends its duration ------------------------
//
// Two participants of one task finish at different moments, while `done` has
// one close stamp for both. The canonical messages are rewritten only in this
// fixture so the regression does not depend on wall-clock time or message
// creation order; their envelopes remain schema-shaped and carry valid ts
// values.
const SB56 = makeSandbox('promptobus-telemetry-end-stamp-');
writeHostConfig(SB56);
const HOME56 = path.join(SB56, '.promptobus');
const HOST56 = hostOf(SB56);
const TASK56 = 'telemetriya-sobstvennyy-konets-t20260906-140000';
const WORKER56_START = ago(120);
const REVIEWER56_START = ago(105);
const WORKER56_RESULT = ago(45);
const REVIEWER56_RESULT = ago(15);
store.createTask(HOME56, { id: TASK56, title: 'собственный конец участника', owner: null });
for (const [address, model, started] of [
  ['worker:stamp', 'claude-opus', WORKER56_START],
  ['reviewer:stamp', 'claude-opus', REVIEWER56_START],
]) {
  store.upsertParticipant(HOME56, TASK56, store.participantRecord(address, {
    harness: 'claude', mode: 'managed', sessionRef: `sess-${address.split(':')[1]}`,
    model, started,
  }));
}
const setResultStamp = (address, stamp) => {
  const sent = store.sendMessage(HOME56, TASK56, {
    from: address, to: 'orchestrator', type: 'result', body: `${address} finished`,
  });
  const file = path.join(store.taskDir(HOME56, TASK56), 'messages', `${sent.message.id}.json`);
  const message = readJson(file);
  message.ts = stamp;
  writeFileSync(file, `${JSON.stringify(message, null, 2)}\n`);
};
setResultStamp('worker:stamp', WORKER56_RESULT);
setResultStamp('reviewer:stamp', REVIEWER56_RESULT);
const endStampRows = telemetry.telemetryRecords(HOST56, HOME56, store.readTask(HOME56, TASK56), { at: NOW });
const worker56 = endStampRows.find((row) => row.role === 'worker');
const reviewer56 = endStampRows.find((row) => row.role === 'reviewer');
check(': worker and reviewer durations end at their own result stamps, not the shared close',
  worker56?.lastResultAt === WORKER56_RESULT && reviewer56?.lastResultAt === REVIEWER56_RESULT
  && worker56?.endedAt === WORKER56_RESULT && reviewer56?.endedAt === REVIEWER56_RESULT
  && worker56?.recordedAt === reviewer56?.recordedAt
  && worker56?.durationSec === 75 * 60 && reviewer56?.durationSec === 90 * 60,
  JSON.stringify({ worker: worker56, reviewer: reviewer56 }));
const SB205 = makeSandbox('promptobus-telemetry-summary-');
writeHostConfig(SB205);
const HOME205 = path.join(SB205, '.promptobus');
const HOST205 = hostOf(SB205);
const TASK205 = 'telemetriya-summary-t20260906-150000';
const CLOSE205 = Date.now();
const stamp205 = (offset) => new Date(CLOSE205 + offset).toISOString();
store.createTask(HOME205, { id: TASK205, title: 'сводка телеметрии', owner: null });
store.upsertParticipant(HOME205, TASK205, store.participantRecord('worker:timed', {
  harness: 'claude',
  mode: 'managed',
  sessionRef: 'sess-timed',
  model: 'claude-opus',
  started: stamp205(-100000),
  routing: {
    strategy: 'balance',
    tupleId: 'claude.opus.high',
    windows: [{ id: 'session', kind: 'session', usedPercent: 10, scope: null }],
  },
}));
store.upsertParticipant(HOME205, TASK205, store.participantRecord('reviewer:timed', {
  harness: 'cursor',
  mode: 'managed',
  sessionRef: 'sess-reviewer-timed',
  model: 'cursor-model',
  started: stamp205(-200000),
}));
const inbound205 = store.sendMessage(HOME205, TASK205, {
  from: 'orchestrator',
  to: 'worker:timed',
  type: 'task',
  body: 'timed delivery fixture',
});
const inboundFile205 = path.join(
  store.taskDir(HOME205, TASK205), 'messages', String(inbound205.message.id) + '.json',
);
const inboundEnvelope205 = readJson(inboundFile205);
inboundEnvelope205.ts = stamp205(-40000);
writeFileSync(inboundFile205, JSON.stringify(inboundEnvelope205, null, 2) + '\n');
store.sendMessage(HOME205, TASK205, {
  from: 'worker:timed',
  to: 'orchestrator',
  type: 'status',
  body: 'timed status',
});
writeFileSync(store.wardenLogFile(HOME205, TASK205), [
  stamp205(-30000) + ' notification worker:timed: unread 1, knock 1',
  stamp205(0) + ' delivered worker:timed: mailbox was taken (had 1, knocks 1)',
].join('\n') + '\n');
store.writeHealth(HOME205, TASK205, {
  'worker:timed': {
    unread: 0, since: null, knockedAt: null, deliveredAt: stamp205(0), knocks: 0,
  },
  'reviewer:timed': {
    unread: 0, since: null, knockedAt: stamp205(-60000), deliveredAt: stamp205(0), knocks: 1,
  },
});
seedCache({ cacheFile: HOST205.routingPaths().cacheFile, usedPercent: 20 });
const written205 = telemetry.appendTelemetry(
  HOST205, HOME205, store.readTask(HOME205, TASK205), { at: CLOSE205 },
);
const rows205 = readFileSync(written205.file, 'utf8').split('\n').filter((line) => line.trim())
  .map((line) => JSON.parse(line));
const timed205 = rows205.find((row) => row.role === 'worker' && row.task === telemetry.taskHash(TASK205));
const reviewer205 = rows205.find((row) => row.role === 'reviewer' && row.task === telemetry.taskHash(TASK205));
check(': close-time projection records mailbox idle and delivery latency',
  written205.written === 2
  && timed205?.idleSec === 30 && timed205?.idleSamples === 1
  && timed205?.deliveryLatencySec === 40 && timed205?.deliverySamples === 1,
  JSON.stringify(timed205));
check(': the role row retains quota cost as the binding window delta',
  timed205?.windows?.[0]?.usedPercentAtEnd === 20, JSON.stringify(timed205?.windows?.[0]));
const summaryStats205 = telemetry.telemetryStats(HOST205);
const summary205 = summaryStats205?.summary?.find((run) => run.task === telemetry.taskHash(TASK205));
check(': the persisted summary answers cost, wall-clock, and bus traffic by role',
  summary205?.roles?.worker?.records === 1
  && summary205.roles.worker.wallClockSec === 100
  && summary205.roles.worker.quotaCostPercent === null
  && summary205.roles.worker.quotaCostState === 'ambiguous'
  && summary205.roles.worker.idleSec === 30
  && summary205.roles.worker.deliveryLatencySec === 40
  && summary205.roles.worker.busMessages === 1
  && summary205.roles.reviewer.quotaCostPercent === null
  && summary205.roles.reviewer.quotaCostState === 'unavailable',
  JSON.stringify(summary205));
check(': the role with the largest measured wall-clock is the bottleneck',
  summary205?.bottleneckRole === 'reviewer'
  && reviewer205?.durationSec === 200
  && reviewer205?.idleSec === null
  && reviewer205?.deliveryLatencySec === null,
  JSON.stringify({ summary: summary205, reviewer: reviewer205 }));
store.writeHealth(HOME205, TASK205, {
  'worker:timed': {
    unread: 1, since: stamp205(-20000), knockedAt: null, deliveredAt: stamp205(0), knocks: 1,
  },
});
const reopenedRows205 = telemetry.telemetryRecords(
  HOST205, HOME205, store.readTask(HOME205, TASK205), { at: CLOSE205 },
);
const reopenedTimed205 = reopenedRows205.find((row) => row.role === 'worker');
check(': a current unread interval is measured after an earlier delivery',
  reopenedTimed205?.idleSec === 50 && reopenedTimed205?.idleSamples === 2,
  JSON.stringify(reopenedTimed205));
const sharedQuota205 = {
  id: 'session', kind: 'session', scope: null, usedPercentAtSpawn: 10, usedPercentAtEnd: 20,
};
const missingQuota205 = {
  id: 'session', kind: 'session', scope: null, usedPercentAtSpawn: 10, usedPercentAtEnd: null,
};
const cursorWindow205 = {
  id: 'weekly', kind: 'weekly', scope: null, usedPercentAtSpawn: 30, usedPercentAtEnd: 40,
};
const quotaInput205 = [
  { task: 'quota-overlap-205', role: 'worker', harness: 'claude', windows: [sharedQuota205] },
  { task: 'quota-overlap-205', role: 'reviewer', harness: 'claude', windows: [sharedQuota205] },
  { task: 'quota-overlap-205', role: 'reviewer', harness: 'claude', windows: [] },
  { task: 'quota-overlap-205', role: 'approver', harness: 'claude', windows: [missingQuota205] },
  { task: 'quota-overlap-205', role: 'worker', harness: 'cursor', windows: [cursorWindow205] },
];
const quotaRows205 = telemetry.telemetrySummary(quotaInput205);
const quotaRun205 = quotaRows205.find((run) => run.task === 'quota-overlap-205');
const claudeQuota205 = quotaRun205?.quotaEvidence?.find((evidence) => evidence.harness === 'claude');
const cursorEvidence205 = quotaRun205?.quotaEvidence?.find((evidence) => evidence.harness === 'cursor');
check(': quota delta remains run-wide evidence with participant coverage',
  quotaRun205?.roles?.worker?.quotaCostPercent === null
  && quotaRun205.roles.worker.quotaCostState === 'ambiguous'
  && quotaRun205.roles.reviewer.quotaCostPercent === null
  && quotaRun205.roles.reviewer.quotaCostState === 'ambiguous'
  && quotaRun205.roles.approver.quotaCostPercent === null
  && quotaRun205.roles.approver.quotaCostState === 'unavailable'
  && claudeQuota205?.deltaPercent === 10 && claudeQuota205.state === 'ambiguous'
  && claudeQuota205.coverage.some((row) => row.role === 'worker'
    && row.records === 1 && row.measuredRecords === 1 && row.unavailableRecords === 0)
  && claudeQuota205.coverage.some((row) => row.role === 'reviewer'
    && row.records === 2 && row.measuredRecords === 1 && row.unavailableRecords === 1)
  && claudeQuota205.coverage.some((row) => row.role === 'approver'
    && row.records === 1 && row.measuredRecords === 0 && row.unavailableRecords === 1)
  && cursorEvidence205?.deltaPercent === 10 && cursorEvidence205.state === 'measured',
  JSON.stringify(quotaRun205));
const absentScopeWindow205 = {
  id: 'session', kind: 'session', usedPercentAtSpawn: 10, usedPercentAtEnd: 20,
};
const invalidScopeWindow205 = {
  id: 'session', kind: 'session', scope: { pool: 'unknown' },
  usedPercentAtSpawn: 10, usedPercentAtEnd: 20,
};
const absentScopeInput205 = [
  { task: 'scope-absence-205', role: 'worker', harness: 'claude', windows: [absentScopeWindow205] },
  { task: 'scope-invalid-205', role: 'worker', harness: 'claude', windows: [invalidScopeWindow205] },
];
const absentScopeRows205 = telemetry.telemetrySummary(absentScopeInput205);
check(': absent or invalid quota scope is not account-wide evidence',
  [
    absentScopeRows205.every((run) => run.quotaEvidence.length === 0),
    absentScopeRows205.every((run) => run.roles.worker.quotaCostState === 'unavailable'),
  ].every(Boolean),
  JSON.stringify(absentScopeRows205));
const malformedQuotaInput205 = [
  { task: 'window-null-205', role: 'worker', harness: 'claude', windows: [null] },
  {
    task: 'window-kind-205', role: 'worker', harness: 'claude',
    windows: [{
      id: 'weekly', kind: 'quarterly', scope: null,
      usedPercentAtSpawn: 10, usedPercentAtEnd: 20,
    }],
  },
  {
    task: 'window-low-205', role: 'worker', harness: 'claude',
    windows: [{
      id: 'weekly', kind: 'weekly', scope: null,
      usedPercentAtSpawn: -10, usedPercentAtEnd: 10,
    }],
  },
  {
    task: 'window-high-205', role: 'worker', harness: 'claude',
    windows: [{
      id: 'weekly', kind: 'weekly', scope: null,
      usedPercentAtSpawn: 110, usedPercentAtEnd: 120,
    }],
  },
  {
    task: 'window-extra-205', role: 'worker', harness: 'claude',
    windows: [{
      id: 'weekly', kind: 'weekly', scope: null,
      usedPercentAtSpawn: 10, usedPercentAtEnd: 20, extra: true,
    }],
  },
  {
    task: 'window-array-205', role: 'worker', harness: 'claude',
    windows: [[
      'not-a-window',
    ]],
  },
];
const safeSummary205 = (summary, input) => {
  try {
    return summary(input);
  } catch {
    return null;
  }
};
const malformedRows205 = safeSummary205(telemetry.telemetrySummary, malformedQuotaInput205);
check(': malformed quota windows are unavailable rather than a crash or measurement',
  [
    malformedRows205?.length === 6,
    malformedRows205?.every((run) => run.quotaEvidence.length === 0
      && run.roles.worker.quotaCostState === 'unavailable'),
  ].every(Boolean),
  JSON.stringify(malformedRows205));
const canonicalScopeRows205 = telemetry.telemetrySummary([
  {
    task: 'scope-canonical-205', role: 'worker', harness: 'claude',
    windows: [{
      id: 'weekly', kind: 'weekly',
      scope: { model: 'Example Deep', models: ['example-deep', 'example-quick'] },
      usedPercentAtSpawn: 10, usedPercentAtEnd: 20,
    }],
  },
  {
    task: 'scope-canonical-205', role: 'reviewer', harness: 'claude',
    windows: [{
      id: 'weekly', kind: 'weekly',
      scope: { models: ['example-quick', 'example-deep'], model: 'Example Deep' },
      usedPercentAtSpawn: 10, usedPercentAtEnd: 20,
    }],
  },
]);
const duplicateScopeInput205 = [{
  task: 'scope-duplicate-205', role: 'worker', harness: 'claude',
  windows: [{
    id: 'weekly', kind: 'weekly',
    scope: { model: 'Example Deep', models: ['example-deep', 'example-deep'] },
    usedPercentAtSpawn: 10, usedPercentAtEnd: 20,
  }],
}];
const duplicateScopeRows205 = telemetry.telemetrySummary(duplicateScopeInput205);
const canonicalRun205 = canonicalScopeRows205.find((run) => run.task === 'scope-canonical-205');
const duplicateRun205 = duplicateScopeRows205.find((run) => run.task === 'scope-duplicate-205');
check(': quota scope keys canonicalize equivalent shapes and reject duplicate ids',
  [
    canonicalRun205?.quotaEvidence?.length === 1,
    canonicalRun205?.quotaEvidence?.[0]?.state === 'ambiguous',
    JSON.stringify(canonicalRun205?.quotaEvidence?.[0]?.scope)
      === '{"model":"Example Deep","models":["example-deep","example-quick"]}',
    canonicalRun205?.roles?.worker?.quotaCostState === 'ambiguous',
    canonicalRun205?.roles?.reviewer?.quotaCostState === 'ambiguous',
    duplicateRun205?.quotaEvidence?.length === 0,
    duplicateRun205?.roles?.worker?.quotaCostState === 'unavailable',
  ].every(Boolean),
  JSON.stringify({ canonical: canonicalRun205, duplicate: duplicateRun205 }));
const partialInput205 = [
  { task: 'partial-summary-205', role: 'worker', durationSec: 100, idleSec: 30, deliveryLatencySec: 5 },
  { task: 'partial-summary-205', role: 'worker', durationSec: null, idleSec: null, deliveryLatencySec: null },
  { task: 'partial-summary-205', role: 'reviewer', durationSec: 200, idleSec: 40, deliveryLatencySec: 7 },
];
const partialRows205 = telemetry.telemetrySummary(partialInput205);
const partialRun205 = partialRows205.find((run) => run.task === 'partial-summary-205');
check(': partial role fields stay unavailable and do not choose a bottleneck',
  [
    partialRun205?.roles?.worker?.wallClockSec === null,
    partialRun205?.roles?.worker?.idleSec === null,
    partialRun205?.roles?.worker?.deliveryLatencySec === null,
    partialRun205?.roles?.reviewer?.wallClockSec === 200,
    partialRun205?.roles?.reviewer?.idleSec === 40,
    partialRun205?.bottleneckRole === null,
  ].every(Boolean),
  JSON.stringify(partialRun205));
const beforePrune205 = JSON.stringify(summaryStats205?.summary);
rmSync(store.taskDir(HOME205, TASK205), { recursive: true, force: true });
const afterPruneStats205 = telemetry.telemetryStats(HOST205);
check(': the persisted summary survives pruning its source journal',
  beforePrune205 === JSON.stringify(afterPruneStats205?.summary),
  JSON.stringify(afterPruneStats205?.summary));
