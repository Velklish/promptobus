import './home.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { hostOf } from '../lib/host.js';
import { models, routeLift, routingLine } from '../lib/models.js';
import { calibrate } from '../lib/model-routing/calibrate.js';
import { telemetryRecords } from '../lib/model-routing/telemetry.js';
import { adapterMap, answeringStub } from './routing-stubs.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = makeSandbox('promptobus-routing-steps-');
const catalogFile = path.join(sandbox, 'catalog.json');
const now = Date.now();
const timestamp = new Date(now).toISOString();
const tuples = [
  { id: 'quick', harness: 'claude', model: 'quick', effort: null, roles: ['reviewer'],
    ratings: { quality: 7, speed: 10, quotaCost: 1 }, billing: 'subscription', priority: 1 },
  { id: 'deep', harness: 'claude', model: 'deep', effort: null, roles: ['reviewer'],
    ratings: { quality: 9, speed: 1, quotaCost: 10 }, billing: 'subscription', priority: 2 },
];
writeFileSync(catalogFile, JSON.stringify({ schemaVersion: 2, updated: '2026-09-26', tuples }));

const adapterFor = adapterMap({ claude: answeringStub({
  state: 'available', reason: null, message: 'available', checkedAt: timestamp,
  source: 'probe', resetAt: null, models: [{ model: 'quick' }, { model: 'deep' }], windows: [],
}) });

let workspaces = 0;
function workspace(floor) {
  const dir = path.join(sandbox, `floor-${floor ?? 'kind'}-${workspaces += 1}`);
  writeHostConfig(dir, {
    tools: ['claude'],
    pipeline: {
      owner: { name: 'worker', kind: 'edits-tree' },
      gates: [{ name: 'security', kind: 'reads-diff', ...(floor === null ? {} : { qualityFloor: floor }) }],
    },
  });
  return hostOf(dir);
}

function output() {
  const chunks = [];
  return { write: (chunk) => chunks.push(chunk), get text() { return chunks.join(''); } };
}

async function decision(host, role = 'security') {
  const out = output();
  await models(host, {
    role, strategy: 'economy', refresh: true, json: true, output: out,
    adapterFor, catalogFile, now,
  });
  return JSON.parse(out.text);
}

test('models resolves the step through its kind and honors an explicit floor', async () => {
  const kind = workspace(null);
  const lowered = workspace(7);
  assert.deepEqual(kind.pipeline(), [{ name: 'worker', kind: 'edits-tree' },
    { name: 'security', kind: 'reads-diff' }]);
  assert.equal(lowered.pipeline()[1].qualityFloor, 7);
  const atNine = await decision(kind);
  const atSeven = await decision(lowered);
  assert.equal(atNine.role, 'reviewer');
  assert.equal(atNine.step, 'security');
  assert.equal(atNine.qualityFloor, 9);
  assert.equal(atNine.chosen.tupleId, 'deep');
  assert.equal(atSeven.qualityFloor, 7);
  assert.equal(atSeven.chosen.tupleId, 'quick');
  const kindOverlay = kind.routingPaths().overlays.find((layer) => layer.writable);
  mkdirSync(path.dirname(kindOverlay.path), { recursive: true });
  writeFileSync(kindOverlay.path, JSON.stringify({ schemaVersion: 2, qualityFloor: { reviewer: 7 } }));
  assert.equal((await decision(kind)).chosen.tupleId, 'quick',
    'a step without a declared floor still takes the merged catalog-role floor');
  const out = output();
  await models(lowered, { role: 'security', strategy: 'economy', refresh: true,
    output: out, adapterFor, catalogFile, now });
  assert.match(out.text, /role: reviewer · step: security · quality floor: 7/);
});

test('a routed lift carries step and catalog role into metadata and its status line', async () => {
  const host = workspace(7);
  const lift = await routeLift(host, { role: 'security', strategy: 'economy', refresh: true,
    adapterFor, catalogFile, now });
  assert.equal(lift.decision.step, 'security');
  assert.equal(lift.decision.role, 'reviewer');
  assert.equal(lift.metadata.step, 'security');
  assert.equal(lift.metadata.role, 'reviewer');
  assert.match(routingLine(lift.metadata), /step security · catalog role reviewer · floor 7/);
});

test('a named role override on a declared step still enforces step and catalog-role policy', async () => {
  const host = workspace(7);
  const namedCatalog = path.join(sandbox, 'named-role-catalog.json');
  writeFileSync(namedCatalog, JSON.stringify({ schemaVersion: 2, updated: '2026-09-26',
    tuples: tuples.map((tuple) => ({ ...tuple, roles: ['worker'] })),
  }));
  const options = { role: 'security', strategy: 'economy', model: 'quick', refresh: true,
    dryRun: true, adapterFor, catalogFile: namedCatalog, now };
  const lift = await routeLift(host, options);
  assert.equal(lift.decision.chosen.tupleId, 'quick');
  assert.equal(lift.decision.role, 'reviewer');
  assert.equal(lift.decision.step, 'security');
  assert.match(lift.decision.warnings.find((w) => w.code === 'role-not-rated-named').message,
    /reviewer \(step security\).*rated for worker only/);
  const writable = host.routingPaths().overlays.find((layer) => layer.writable);
  mkdirSync(path.dirname(writable.path), { recursive: true });
  for (const name of ['security', 'reviewer']) {
    for (const rule of ['allow', 'deny']) {
      writeFileSync(writable.path, JSON.stringify({ schemaVersion: 2,
        [rule]: { byRole: { [name]: { models: [rule === 'deny' ? 'quick' : 'deep'] } } },
      }));
      await assert.rejects(() => routeLift(host, options), (error) => {
        assert.match(error.message, /denied-by-policy/);
        assert.match(error.message, new RegExp(`${rule}.byRole.${name}.models`));
        return true;
      });
    }
  }
});

test('a declared step selector applies beside its catalog-role selector; validate names an unknown key', async () => {
  const host = workspace(7);
  const writable = host.routingPaths().overlays.find((layer) => layer.writable);
  mkdirSync(path.dirname(writable.path), { recursive: true });
  writeFileSync(writable.path, JSON.stringify({ schemaVersion: 2,
    deny: { byRole: { security: { models: ['quick'] } } },
  }));
  const security = await decision(host);
  const reviewer = await decision(host, 'reviewer');
  assert.equal(security.chosen.tupleId, 'deep');
  assert.equal(reviewer.candidates.find((c) => c.tupleId === 'quick').excluded, null);
  assert.match(security.candidates.find((c) => c.tupleId === 'quick').excluded.detail,
    /deny.byRole.security.models/);

  writeFileSync(writable.path, JSON.stringify({ schemaVersion: 2,
    deny: { byRole: { unknown: { harnesses: ['claude'] } } },
  }));
  const { validate } = await import('../lib/model-routing/validate.js');
  const verdict = validate({ host });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((error) => error.at === 'deny.byRole.unknown'
    && /unknown role or declared step/.test(error.message)));
});

test('validation ignores an inherited constructor selector when constructor is a declared step', async () => {
  const dir = path.join(sandbox, `constructor-${workspaces += 1}`);
  writeHostConfig(dir, {
    tools: ['claude'],
    pipeline: {
      owner: { name: 'worker', kind: 'edits-tree' },
      gates: [{ name: 'constructor', kind: 'reads-diff' }],
    },
  });
  const host = hostOf(dir);
  const writable = host.routingPaths().overlays.find((layer) => layer.writable);
  mkdirSync(path.dirname(writable.path), { recursive: true });
  writeFileSync(writable.path, JSON.stringify({ schemaVersion: 2,
    deny: { byRole: { reviewer: { harnesses: ['claude'] } } },
  }));
  const { validate } = await import('../lib/model-routing/validate.js');
  const verdict = validate({ host });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.errors));
  assert.equal(verdict.errors.some((error) => error.at === 'deny.byRole.constructor'), false);
});

test('telemetry and calibration retain the step beside its catalog role', async () => {
  const host = workspace(7);
  const lift = await routeLift(host, { role: 'security', strategy: 'economy', refresh: true,
    adapterFor, catalogFile, now });
  const meta = { id: 'security-t20260926-180000', participants: [{
    id: 'security-x', role: 'security', harness: 'claude', mode: 'managed', sessionRef: 'session-x',
    capabilities: null,
    metadata: { address: 'security:x', model: lift.model, started: timestamp, routing: lift.metadata },
  }] };
  const rows = telemetryRecords(host, sandbox, meta, { at: now + 1000 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].step, 'security');
  assert.equal(rows[0].role, 'reviewer');
  const report = calibrate(rows, { tuples });
  assert.deepEqual(report.keys[0].steps, [
    { step: 'security', role: 'reviewer', runs: 1, acceptedPieces: 0 },
  ]);

  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const name of ['catalog', 'overlay', 'snapshot', 'decision', 'telemetry']) {
    ajv.addSchema(JSON.parse(readFileSync(path.join(root, 'schemas', 'model-routing', `${name}.schema.json`), 'utf8')));
  }
  assert.equal(ajv.getSchema('urn:promptobus:model-routing:decision')(lift.decision), true);
  assert.equal(ajv.getSchema('urn:promptobus:model-routing:telemetry')(rows[0]), true);
});

test('telemetry keeps the routed role after the step declaration changes kind', async () => {
  const oldHost = workspace(7);
  const lift = await routeLift(oldHost, { role: 'security', strategy: 'economy', refresh: true,
    adapterFor, catalogFile, now });
  const meta = { id: 'security-role-change-t20260926-180000', participants: [{
    id: 'security-change', role: 'security', harness: 'claude', mode: 'managed', sessionRef: 'session-change',
    capabilities: null,
    metadata: { address: 'security:change', model: lift.model, started: timestamp, routing: lift.metadata },
  }] };
  writeHostConfig(oldHost.workspaceRoot(), {
    tools: ['claude'],
    pipeline: {
      owner: { name: 'worker', kind: 'edits-tree' },
      gates: [{ name: 'security', kind: 'writes-main-tree' }],
    },
  });
  const changedHost = hostOf(oldHost.workspaceRoot());
  assert.equal(changedHost.pipeline()[1].kind, 'writes-main-tree');
  const rows = telemetryRecords(changedHost, sandbox, meta, { at: now + 1000 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].step, 'security');
  assert.equal(rows[0].role, 'reviewer');
});

test('telemetry counts an unrouted declared participant as a concurrent neighbour', () => {
  const host = workspace(7);
  const earlier = new Date(now - 1000).toISOString();
  const meta = { id: 'security-concurrent-t20260926-180000', participants: [
    {
      id: 'security-earlier', role: 'security', harness: 'claude', mode: 'managed', sessionRef: 'session-earlier',
      capabilities: null, metadata: { address: 'security:earlier', model: 'deep', started: earlier },
    },
    {
      id: 'security-later', role: 'security', harness: 'claude', mode: 'managed', sessionRef: 'session-later',
      capabilities: null, metadata: { address: 'security:later', model: 'deep', started: timestamp,
        routing: { step: 'security', role: 'reviewer', strategy: 'economy' } },
    },
  ] };
  const rows = telemetryRecords(host, sandbox, meta, { at: now + 1000 });
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.spawnedAt === earlier).role, 'reviewer');
  assert.equal(rows.find((row) => row.spawnedAt === timestamp).concurrentParticipants, 1);
});

test('calibration separates identical step names by catalog role and reads legacy records', () => {
  const record = { harness: 'claude', model: 'deep', effort: null };
  const report = calibrate([
    { ...record, step: 'security', role: 'reviewer', resultCount: 1 },
    { ...record, step: 'security', role: 'approver', resultCount: 0 },
    { ...record, role: 'reviewer', resultCount: 1 },
  ], { tuples });
  assert.equal(report.keys[0].runs, 3);
  assert.deepEqual(report.keys[0].steps, [
    { step: 'reviewer', role: 'reviewer', runs: 1, acceptedPieces: 1 },
    { step: 'security', role: 'approver', runs: 1, acceptedPieces: 0 },
    { step: 'security', role: 'reviewer', runs: 1, acceptedPieces: 1 },
  ]);
});

test('an unrated --model on a declared step is held to that step\'s own lists', async () => {
  const host = workspace(null);
  const overlay = host.routingPaths().overlays.find((layer) => layer.writable);
  mkdirSync(path.dirname(overlay.path), { recursive: true });
  writeFileSync(overlay.path, JSON.stringify({
    schemaVersion: 2, deny: { byRole: { security: { harnesses: ['claude'] } } },
  }));
  const lift = (role) => routeLift(host, {
    role, strategy: 'economy', model: 'next-9', dryRun: true, adapterFor, catalogFile, now,
  });
  await assert.rejects(() => lift('security'),
    (e) => e.code === 'candidates-empty' && /deny\.byRole\.security\.harnesses/.test(e.message));
  assert.equal(await lift('worker'), null, 'the step block binds that step alone');
});
