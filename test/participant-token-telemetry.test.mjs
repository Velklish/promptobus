import './home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { capture } from './console.mjs';
import * as store from '../lib/store.js';
import { hostOf } from '../lib/host.js';
import { done } from '../lib/done.js';
import { runPromptobus } from '../lib/cli.js';
import * as telemetry from '../lib/model-routing/telemetry.js';
import { telemetryStats } from '../dist/telemetry.js';
import { createHarnessRegistry } from '../lib/harness-registry.js';

const stamp = (second) => `2026-10-01T12:00:${String(second).padStart(2, '0')}.000Z`;
function fixture() {
  const root = makeSandbox('promptobus-telemetry-');
  writeHostConfig(root);
  const base = hostOf(root);
  const home = path.join(root, '.promptobus');
  const host = { ...base,
    routingPaths: () => ({ ...base.routingPaths(), cacheFile: path.join(root, 'routing', 'cache.json') }),
    harnessStateHome: (harness) => path.join(root, 'harnesses', harness),
  };
  const id = 'fixture-token-run';
  process.env.CLAUDE_CODE_SESSION_ID = 'fixture-root';
  store.createTask(home, { id, title: 'disposable token accounting', owner: null });
  const task = store.readTask(home, id);
  writeFileSync(store.taskFile(home, id), JSON.stringify({ ...task, created: stamp(0) }));
  return { root, home, host, id };
}
function log(f, name, rows) {
  const file = path.join(f.root, `${name}.jsonl`);
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return file;
}
function participant(f, address, harness, sessionId, rows = null, extra = {}) {
  const p = store.participantRecord(address, { harness, model: `${harness}-fixture-model`,
    sessionRef: `fixture-ref-${sessionId}`, sessionId, started: stamp(0),
    ...(address === 'orchestrator' ? { owner: 'fixture-root' } : {}), ...extra });
  store.upsertParticipant(f.home, f.id, p);
  if (rows) {
    const file = log(f, sessionId, rows);
    if (harness === 'codex' && p.sessionRef) {
      createHarnessRegistry({ harness }).writeSession({ ref: p.sessionRef, threadId: sessionId,
        home: f.home, task: f.id, address, rolloutPath: file },
      { PROMPTOBUS_CODEX_HOME: f.host.harnessStateHome('codex') });
    } else store.markTranscript(f.home, f.id, address, file, sessionId);
  }
  return p;
}
const assistant = (id, second, usage, extra = {}) => ({ type: 'assistant', sessionId: 'fixture-claude',
  timestamp: stamp(second), message: { id, role: 'assistant', usage }, ...extra });
const usage = (input, read, write, output) => ({ input_tokens: input, cache_read_input_tokens: read,
  cache_creation_input_tokens: write, output_tokens: output });
const meta = (id) => ({ timestamp: stamp(0), type: 'session_meta', payload: { id } });
const cumulative = (second, input, read, write, output) => ({ timestamp: stamp(second), type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input,
    cached_input_tokens: read, cache_write_input_tokens: write, output_tokens: output } } } });
const tokens = (input, cacheRead, cacheWrite, output, reason = null) => ({ input, cacheRead, cacheWrite, output, reason });
const records = (f) => telemetry.readTelemetry(f.host).records;
const project = (f) => telemetry.telemetryRecords(f.host, f.home, store.readTask(f.home, f.id), { at: Date.parse(stamp(40)) });

test('done reads recorded Claude usage, latest Codex totals, teamlead and root exactly once', async () => {
  const f = fixture();
  participant(f, 'worker:claude', 'claude', 'fixture-claude', [
    assistant('a', 2, usage(10, 100, 20, 3)),
    assistant('a', 2, usage(10, 100, 20, 7)),
    assistant('a', 2, usage(10, 100, 20, 3)),
    { type: 'user', timestamp: stamp(3), message: { usage: usage(999, 999, 999, 999) } },
    assistant('b', 4, usage(5, 30, 0, 2)),
    assistant('foreign', 5, usage(900, 900, 900, 900), { sessionId: 'another-fixture-session' }),
  ]);
  // Attached transcript fixtures carry no controller-owned native launch.
  participant(f, 'reviewer:codex', 'codex', 'fixture-codex', [meta('fixture-codex'),
    cumulative(2, 100, 60, 10, 3), cumulative(4, 250, 160, 20, 8), cumulative(5, 250, 160, 20, 8)],
  { mode: 'attached', sessionRef: null });
  participant(f, 'teamlead:fixture', 'claude', 'fixture-lead', [
    assistant('lead', 3, usage(7, 4, 3, 2), { sessionId: 'fixture-lead' }),
  ]);
  participant(f, 'orchestrator', 'codex', 'fixture-root', [meta('fixture-root'), cumulative(3, 90, 50, 0, 6)],
    { mode: 'attached', sessionRef: null });
  for (const address of ['reviewer:codex', 'orchestrator']) {
    const p = store.participantOf(store.readTask(f.home, f.id), address);
    const transcript = telemetry.sessionLogOf(f.host, f.home, f.id, p);
    assert.equal(p.mode, 'attached');
    assert.equal(p.sessionRef, null);
    assert.equal(p.metadata.nativeStop, undefined);
    assert.equal(transcript.sessionId, p.metadata.sessionId);
    assert.equal(JSON.parse(readFileSync(transcript.path, 'utf8').split('\n')[0]).payload.id, transcript.sessionId);
  }
  await capture(() => done(f.host, { task: f.id, 'keep-sessions': true,
    snapshot: () => ({}), adapterFor: () => { throw new Error('fixture must not call any adapter'); } }));
  const rows = records(f);
  assert.deepEqual(rows.find((r) => r.role === 'worker')?.tokens, tokens(15, 130, 20, 9));
  assert.deepEqual(rows.find((r) => r.role === 'reviewer')?.tokens, tokens(70, 160, 20, 8));
  assert.deepEqual(rows.find((r) => r.role === 'teamlead')?.tokens, tokens(7, 4, 3, 2));
  assert.deepEqual(rows.find((r) => r.role === 'orchestrator')?.tokens, tokens(40, 50, 0, 6));
  const before = readFileSync(telemetry.telemetryFileOf(f.host), 'utf8');
  await capture(() => done(f.host, { task: f.id, 'keep-sessions': true, snapshot: () => ({}) }));
  assert.equal(readFileSync(telemetry.telemetryFileOf(f.host), 'utf8'), before);
  const ajv = new Ajv2020({ strict: false });
  for (const name of ['snapshot', 'telemetry']) ajv.addSchema(JSON.parse(readFileSync(
    new URL(`../schemas/model-routing/${name}.schema.json`, import.meta.url), 'utf8')));
  const validate = ajv.getSchema('urn:promptobus:model-routing:telemetry');
  for (const row of rows) assert.equal(validate(row), true, ajv.errorsText(validate.errors));
  for (const key of ['sessionId', 'path', 'accountId', 'body']) {
    assert.equal(validate({ ...rows[0], [key]: 'private-fixture-value' }), false);
    assert.equal(validate({ ...rows[0], tokens: { ...rows[0].tokens, [key]: 'private-fixture-value' } }), false);
  }
  const old = { ...rows.find((row) => row.role === 'worker') };
  delete old.tokens; delete old.participant; delete old.generation;
  assert.equal(validate(old), true, ajv.errorsText(validate.errors));
  assert.equal(/fixture-ref-|fixture-root|\.jsonl|sessionId|rolloutPath/.test(before), false);
  assert.equal(telemetryStats(f.host)?.records, 4);
});

test('root with a recorded owner remains visible when its model and log are unavailable', () => {
  const f = fixture();
  store.upsertParticipant(f.home, f.id, store.participantRecord('orchestrator', { owner: 'fixture-owner' }));
  const rows = project(f);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'orchestrator');
  assert.equal(rows[0].model, null);
  assert.deepEqual(rows[0].tokens, tokens(null, null, null, null, 'session_log_unavailable'));
});

test('Codex teamlead resolves only a reciprocal owned child registry and keeps the root participant key', () => {
  const f = fixture();
  const sessionId = 'fixture-linked-codex';
  const childTask = 'fixture-linked-child';
  const lead = store.participantRecord('teamlead:linked', { harness: 'codex', model: 'codex-fixture-model',
    sessionRef: 'fixture-linked-ref', sessionId, childTask, started: stamp(0) });
  const owner = store.participantRecord('orchestrator', { harness: 'codex', model: 'codex-fixture-model',
    sessionRef: lead.sessionRef, sessionId, owner: sessionId });
  store.bus(f.home, { cli: f.host.version }).createTask({
    id: childTask, title: 'linked child', owner, parent: f.id, teamlead: lead,
  });
  const file = log(f, sessionId, [meta(sessionId), cumulative(3, 90, 50, 4, 6)]);
  const registry = createHarnessRegistry({ harness: 'codex' });
  const env = { PROMPTOBUS_CODEX_HOME: f.host.harnessStateHome('codex') };
  const binding = { ref: lead.sessionRef, threadId: sessionId, home: f.home,
    task: childTask, address: 'orchestrator', rolloutPath: file };
  registry.writeSession(binding, env);
  const rootRow = () => project(f).find((row) => row.role === 'teamlead');
  assert.deepEqual(rootRow().tokens, tokens(36, 50, 4, 6));
  assert.equal(rootRow().participant, telemetry.taskHash(lead.id));
  for (const patch of [{ task: 'foreign-task' }, { address: 'worker:foreign' },
    { home: path.join(f.root, 'foreign') }, { threadId: 'foreign-thread' }]) {
    registry.writeSession({ ...binding, ...patch }, env);
    assert.deepEqual(rootRow().tokens, tokens(null, null, null, null, 'session_log_unavailable'));
  }
  registry.writeSession(binding, env);
  for (const patch of [{ sessionRef: 'foreign-ref' }, { sessionId: 'foreign-thread' }, { owner: 'foreign-owner' }]) {
    store.upsertParticipant(f.home, childTask, { ...owner, metadata: { ...owner.metadata, ...patch },
      ...(patch.sessionRef ? { sessionRef: patch.sessionRef } : {}) });
    assert.deepEqual(rootRow().tokens, tokens(null, null, null, null, 'session_log_unavailable'));
  }
  store.upsertParticipant(f.home, childTask, owner);
  const child = store.readTask(f.home, childTask);
  writeFileSync(store.taskFile(f.home, childTask), JSON.stringify({ ...child, parent: 'foreign-root' }));
  assert.deepEqual(rootRow().tokens, tokens(null, null, null, null, 'session_log_unavailable'));
});

test('telemetry glossary describes optional participant generations and numeric usage without private identities', () => {
  const row = readFileSync(new URL('../docs/GLOSSARY.md', import.meta.url), 'utf8')
    .split('\n').find((line) => line.startsWith('| telemetry record |'));
  assert.doesNotMatch(row, /only identifier/);
  for (const term of ['participant', 'generation', 'numeric', 'task', 'no prompt, path, session id']) {
    assert.ok(row.includes(term), term);
  }
});

test('Cursor preserves sidecar output counts and unsupported harnesses do not invent usage', () => {
  const f = fixture();
  participant(f, 'worker:cursor', 'cursor', 'fixture-cursor');
  participant(f, 'reviewer:opencode', 'opencode', 'fixture-opencode');
  telemetry.appendThroughputObservation(f.home, f.id, 'worker:cursor', { output_tokens: 8 });
  telemetry.appendThroughputObservation(f.home, f.id, 'worker:cursor', { output_tokens: 5 });
  const rows = telemetry.telemetryRecords(f.host, f.home, store.readTask(f.home, f.id), {
    throughput: telemetry.readThroughputSidecars(f.home, store.readTask(f.home, f.id)),
  });
  assert.deepEqual(rows[0].tokens, tokens(null, null, null, 13, 'input_cache_usage_not_reported'));
  assert.equal(rows[0].throughput.outputTokens, 13);
  assert.deepEqual(rows[1].tokens, tokens(null, null, null, null, 'harness_usage_unsupported'));
});

test('Codex missing cache-write evidence stays null and a reset refuses fabricated deltas', () => {
  const f = fixture();
  const partial = cumulative(3, 100, 60, 0, 3);
  delete partial.payload.info.total_token_usage.cache_write_input_tokens;
  participant(f, 'worker:partial', 'codex', 'fixture-partial', [meta('fixture-partial'), partial]);
  participant(f, 'reviewer:reset', 'codex', 'fixture-reset', [meta('fixture-reset'),
    cumulative(2, 100, 60, 0, 3), cumulative(3, 50, 30, 0, 1)]);
  assert.deepEqual(project(f).map((r) => r.tokens), [tokens(null, 60, null, 3, 'usage_fields_unavailable'),
    tokens(null, null, null, null, 'cumulative_usage_reset')]);
});

test('a resumed Codex session includes usage before its last lift in the same generation', () => {
  const f = fixture();
  participant(f, 'reviewer:resumed', 'codex', 'fixture-resumed', [meta('fixture-resumed'),
    cumulative(2, 100, 60, 0, 3), cumulative(22, 250, 160, 0, 8)], { started: stamp(20) });
  assert.deepEqual(project(f)[0].tokens, tokens(90, 160, 0, 8));
});

test('telemetry reference and CLI help describe the recorded token report', async () => {
  const f = fixture();
  let text = '';
  assert.equal(await runPromptobus(['help'], { host: f.host, env: {}, output: { write: (s) => { text += s; } } }), 0);
  assert.match(text, /stats \[--task <id>\]/);
  const reference = readFileSync(new URL('../docs/reference/03-cli.md', import.meta.url), 'utf8');
  assert.match(reference, /`tokens`.*cacheRead.*cacheWrite/);
  assert.match(reference, /Uncached input excludes the cache subsets/);
  assert.match(reference, /older history without that identity stays unavailable/i);
  assert.equal(reference.includes('The task owner gets none: it has no session and no tuple.'), false);
  const guide = readFileSync(new URL('../docs/guides/model-routing.md', import.meta.url), 'utf8');
  assert.equal(guide.includes('excluded from live-tuple and telemetry projections'), false);
  assert.match(guide, /task and participant keys/i);
});

test('recorded transcript and registry ownership reject foreign session paths and ambient homes', () => {
  const f = fixture();
  participant(f, 'worker:claude', 'claude', 'fixture-claude');
  const foreign = log(f, 'foreign-private-path', [assistant('a', 2, usage(900, 900, 900, 900))]);
  store.markTranscript(f.home, f.id, 'worker:claude', foreign, 'different-session');
  const codex = participant(f, 'reviewer:codex', 'codex', 'fixture-codex', [meta('fixture-codex'), cumulative(3, 90, 50, 0, 2)]);
  const env = { PROMPTOBUS_CODEX_HOME: f.host.harnessStateHome('codex') };
  const registry = createHarnessRegistry({ harness: 'codex' });
  registry.patchSession(codex.sessionRef, { task: 'foreign-fixture-task' }, env);
  const was = process.env.PROMPTOBUS_CODEX_HOME;
  process.env.PROMPTOBUS_CODEX_HOME = path.join(f.root, 'ambient-private-home');
  try {
    const rows = project(f);
    assert.deepEqual(rows.map((r) => r.tokens), [tokens(null, null, null, null, 'session_log_unavailable'),
      tokens(null, null, null, null, 'session_log_unavailable')]);
    assert.equal(JSON.stringify(rows).includes('foreign-private-path'), false);
  } finally {
    if (was === undefined) delete process.env.PROMPTOBUS_CODEX_HOME;
    else process.env.PROMPTOBUS_CODEX_HOME = was;
  }
});

test('Codex generations subtract the boundary baseline and ignore repeated cumulative totals', () => {
  const f = fixture();
  const rows = [meta('fixture-codex'), cumulative(2, 100, 60, 0, 3), cumulative(12, 250, 160, 0, 8),
    cumulative(13, 250, 160, 0, 8), cumulative(22, 400, 260, 0, 12)];
  const file = log(f, 'closed-codex', rows);
  participant(f, 'reviewer:api', 'codex', 'fixture-codex', rows, { started: stamp(20), harnessHistory: [
    { harness: 'codex', model: 'old-fixture-model', from: stamp(0), until: stamp(20),
      sessionId: 'fixture-codex', tokenLog: { sessionId: 'fixture-codex', path: file } },
  ] });
  const measured = project(f);
  assert.deepEqual(measured.map((r) => r.tokens), [tokens(90, 160, 0, 8), tokens(50, 100, 0, 4)]);
  assert.deepEqual(measured.map((r) => r.generation), [0, 1]);
  assert.equal(measured[0].participant, measured[1].participant);
});

test('Claude duplicate assistant messages cannot cross a generation boundary', () => {
  const f = fixture();
  const first = assistant('a', 2, usage(10, 100, 5, 3));
  const rows = [first, { ...first, timestamp: stamp(22) }, assistant('b', 24, usage(7, 30, 0, 2))];
  const file = log(f, 'closed-claude', rows);
  participant(f, 'reviewer:api', 'claude', 'fixture-claude', rows, { started: stamp(20), harnessHistory: [
    { harness: 'claude', model: 'old-fixture-model', from: stamp(0), until: stamp(20),
      sessionId: 'fixture-claude', tokenLog: { sessionId: 'fixture-claude', path: file } },
  ] });
  assert.deepEqual(project(f).map((r) => r.tokens), [tokens(10, 100, 5, 3), tokens(7, 30, 0, 2)]);
});

test('same-generation Claude session history sums distinct sessions once after a rebind', () => {
  const f = fixture();
  const first = { sessionId: 'fixture-first', path: log(f, 'first-session', [
    assistant('a', 2, usage(10, 100, 5, 3), { sessionId: 'fixture-first' }),
  ]) };
  const second = { sessionId: 'fixture-second', path: log(f, 'second-session', [
    assistant('b', 12, usage(7, 30, 0, 2), { sessionId: 'fixture-second' }),
  ]) };
  participant(f, 'reviewer:api', 'codex', 'fixture-codex', [{ ...meta('fixture-codex'), timestamp: stamp(20) }, cumulative(24, 90, 50, 0, 4)], {
    started: stamp(20), harnessHistory: [{ harness: 'claude', model: 'old-fixture-model',
      from: stamp(10), until: stamp(20), sessionId: 'fixture-second', tokenLog: second,
      tokenLogHistory: [first, first, second, second] }],
  });
  assert.deepEqual(project(f).map((row) => row.tokens), [tokens(17, 130, 5, 5), tokens(40, 50, 0, 4)]);
});

test('a missing earlier session keeps generation totals unknown rather than reporting the latest only', () => {
  const f = fixture();
  participant(f, 'worker:claude', 'claude', 'fixture-claude', [assistant('a', 12, usage(7, 30, 0, 2))], {
    tokenLogHistory: [{ sessionId: 'missing-earlier-fixture-session', path: null }],
  });
  assert.deepEqual(project(f)[0].tokens, tokens(null, null, null, null, 'session_log_unavailable'));
});

test('missing, foreign and invalid logs preserve nulls with sanitized reasons', () => {
  const f = fixture();
  participant(f, 'worker:missing', 'claude', 'fixture-missing');
  participant(f, 'reviewer:foreign', 'codex', 'fixture-codex', [meta('foreign'), cumulative(3, 100, 60, 0, 3)]);
  participant(f, 'approver:invalid', 'claude', 'fixture-claude', [assistant('bad', 3, usage(-1, 2, 0, 4))]);
  const rows = project(f);
  assert.deepEqual(rows.map((r) => r.tokens), [tokens(null, null, null, null, 'session_log_unavailable'),
    tokens(null, null, null, null, 'session_identity_mismatch'), tokens(null, 2, 0, 4, 'usage_fields_unavailable')]);
});

test('stats --task reports each fixture generation and missing reasons, then survives journal removal', async () => {
  const f = fixture();
  participant(f, 'worker:missing', 'claude', 'fixture-missing');
  participant(f, 'teamlead:fixture', 'cursor', 'fixture-cursor');
  participant(f, 'reviewer:fixture', 'claude', 'fixture-claude', [assistant('stats-review', 2, usage(7, 3, 0, 2))]);
  participant(f, 'orchestrator', 'codex', 'fixture-root', [meta('fixture-root'), cumulative(3, 90, 50, 0, 6)]);
  store.sendMessage(f.home, f.id, { from: 'worker:missing', to: 'orchestrator', type: 'question', body: 'fixture question' });
  telemetry.appendTelemetry(f.host, f.home, store.readTask(f.home, f.id));
  const other = { ...store.readTask(f.home, f.id), id: 'different-fixture-task' };
  telemetry.appendTelemetry(f.host, f.home, other);
  let text = '';
  const quit = process.exit;
  let code;
  try {
    process.exit = (n) => { throw new Error(`fixture CLI exit ${n}`); };
    await capture(async () => {
      try { code = await runPromptobus(['stats', '--task', f.id], { host: f.host, env: {},
        output: { write: (s) => { text += s; } } }); }
      catch { code = 1; }
    });
  } finally { process.exit = quit; }
  assert.match(text, /worker:missing/);
  assert.match(text, /teamlead:fixture/);
  assert.match(text, /reviewer:fixture/);
  assert.match(text, /orchestrator/);
  assert.match(text, /session_log_unavailable/);
  assert.match(text, /input.*cache-read.*cache-write.*output/i);
  assert.match(text, /wall.*messages.*reviews.*questions.*results/i);
  assert.equal(text.includes(telemetry.taskHash(other.id)), false);
  assert.equal(/savings|\$|cost percent/i.test(text), false);
  assert.equal(code, 0);
  const lines = text.trimEnd().split('\n').map((line) => line.split('\t'));
  assert.equal(lines.length, 5);
  const worker = lines.find((line) => line[1] === 'worker:missing');
  assert.deepEqual(worker.slice(7, 11), ['?', '?', '?', '?']);
  assert.deepEqual(worker.slice(11, 15), ['1', '0', '1', '0']);
  assert.equal(worker[4], 'claude');
  assert.equal(worker[5], 'claude-fixture-model');
  assert.equal(Number.isFinite(Number(worker[6])), true);
  assert.equal(telemetryStats(f.host, { task: f.id }).participants.length, 4);
  assert.equal(telemetryStats(f.host).participants.length, 8);
  rmSync(store.taskDir(f.home, f.id), { recursive: true });
  text = '';
  assert.equal(await runPromptobus(['stats', '--task', f.id], { host: f.host, env: {},
    output: { write: (s) => { text += s; } } }), 0);
  assert.equal(text.split('\n').filter((line) => line.includes('fixture-model')).length, 4);
});
