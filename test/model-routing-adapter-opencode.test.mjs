// OpenCode availability: local-estimate windows and the off-allowance flag.
// No opencode process is started. The capture stub is the binary boundary.
import './home.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import {
  OPENCODE_WINDOW_LENGTH_SEC, OPENCODE_WINDOW_SHARES, opencodeAvailability,
} from '../lib/model-routing/adapter-opencode.js';
import { snapshotEntry } from '../lib/model-routing/cache.js';
import { mergeRouting } from '../lib/model-routing/catalog.js';
import { preflight } from '../lib/model-routing/preflight.js';
import { render } from '../lib/model-routing/render.js';
import { resolve } from '../lib/model-routing/resolver.js';
import { checkOverlayShape } from '../lib/model-routing/validate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const MONTHLY = 1_000_000;
const NOW = Date.parse('2026-10-29T00:00:12.000Z');
const STAMP = '2026-10-29T00:00:00.000Z';

const tool = { ok: true, bin: 'opencode' };

function statsDoc(rows) {
  return JSON.stringify({
    models: rows.map(([id, tokens, variant]) => {
      const slash = id.indexOf('/');
      return {
        model: { providerID: id.slice(0, slash), id: id.slice(slash + 1), variant: variant ?? 'default' },
        tokens: {
          input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 },
        },
      };
    }),
  });
}

function captureOf({ models, session, weekly, account }) {
  return async (_bin, argv) => {
    const key = argv.join(' ');
    if (key === '--version') return { status: 0, stdout: 'opencode v2.0.20\n' };
    if (key === 'models') return { status: 0, stdout: `${models.join('\n')}\n` };
    if (key === 'stats --days 0 --models --json') return { status: 0, stdout: statsDoc(session) };
    if (key === 'stats --days 7 --models --json') return { status: 0, stdout: statsDoc(weekly) };
    return { status: 1, stdout: '' };
  };
}

async function probe(opts) {
  return opencodeAvailability({
    capture: captureOf(opts),
    accountOf: async () => opts.account ?? {},
  }).probe({ toolBin: tool, timeoutMs: 5000, host: {} });
}

const MODELS = [
  'opencode-go/minimax-m3',
  'opencode-go/beam-free',
  'opencode-go/muse-spark-1.3-contributor',
  'opencode-go/m3-preview',
];

function windowById(verdict, id) {
  return verdict.windows.find((w) => w.id === id);
}

test('session used percent is tokens over 20 percent of the monthly allowance', async () => {
  const verdict = await probe({
    models: MODELS,
    session: [['opencode-go/minimax-m3', 100_000]],
    weekly: [['opencode-go/minimax-m3', 100_000]],
    account: { allowance: { monthlyTokens: MONTHLY }, denySuffixes: ['-preview'] },
  });
  const session = windowById(verdict, '5h:opencode-go/minimax-m3');
  assert.equal(session.usedPercent, 50);
  assert.equal(session.kind, 'session');
  assert.equal(session.lengthSec, OPENCODE_WINDOW_LENGTH_SEC.session);
  assert.equal(session.lengthSec, 18000);
  assert.equal(session.estimate, 'local-estimate');
  assert.equal(OPENCODE_WINDOW_SHARES.session, 0.2);
  assert.deepEqual(session.scope, { model: 'opencode-go/minimax-m3', models: ['opencode-go/minimax-m3'] });
  assert.equal(verdict.state, 'available');
  assert.match(verdict.message, /auth is checked by the lift/);
  assert.match(verdict.message, /against the declared monthly token allowance/);
});

test('weekly used percent is tokens over 50 percent of the monthly allowance', async () => {
  const verdict = await probe({
    models: ['opencode-go/minimax-m3'],
    session: [['opencode-go/minimax-m3', 0]],
    weekly: [['opencode-go/minimax-m3', 100_000]],
    account: { allowance: { monthlyTokens: MONTHLY } },
  });
  const weekly = windowById(verdict, '7d:opencode-go/minimax-m3');
  assert.equal(weekly.usedPercent, 20);
  assert.equal(weekly.kind, 'weekly');
  assert.equal(weekly.lengthSec, 604800);
  assert.equal(OPENCODE_WINDOW_SHARES.weekly, 0.5);
});

test('variant rows of one model id are one token total', async () => {
  const verdict = await probe({
    models: ['opencode-go/minimax-m3'],
    session: [
      ['opencode-go/minimax-m3', 60_000, 'default'],
      ['opencode-go/minimax-m3', 40_000, 'high'],
    ],
    weekly: [['opencode-go/minimax-m3', 0]],
    account: { allowance: { monthlyTokens: MONTHLY } },
  });
  assert.equal(windowById(verdict, '5h:opencode-go/minimax-m3').usedPercent, 50);
});

test('a spent model stays a local window and the harness stays available', async () => {
  const verdict = await probe({
    models: ['opencode-go/minimax-m3'],
    session: [['opencode-go/minimax-m3', 500_000]],
    weekly: [['opencode-go/minimax-m3', 0]],
    account: { allowance: { monthlyTokens: MONTHLY } },
  });
  assert.equal(verdict.state, 'available');
  assert.equal(verdict.reason, null);
  assert.equal(windowById(verdict, '5h:opencode-go/minimax-m3').usedPercent, 100);
});

test('unset allowance keeps the windows and omits the used percentage', async () => {
  const verdict = await probe({
    models: ['opencode-go/minimax-m3'],
    session: [['opencode-go/minimax-m3', 100_000]],
    weekly: [['opencode-go/minimax-m3', 100_000]],
    account: {},
  });
  const session = windowById(verdict, '5h:opencode-go/minimax-m3');
  assert.equal(session.estimate, 'local-estimate');
  assert.equal(Object.hasOwn(session, 'usedPercent'), false);
  assert.match(verdict.message, /monthlyTokens is set/);
  const text = render({
    strategy: 'balanced',
    role: 'worker',
    candidates: [],
    runtime: [],
    warnings: [],
    overlays: [],
    snapshot: { takenAt: STAMP, ageSec: 0, source: 'probe', harnesses: [] },
    harnesses: [{
      harness: 'opencode',
      state: 'available',
      tier: null,
      windows: [session],
    }],
  });
  assert.match(text, /percentage unset/);
  assert.match(text, /local-estimate/);
});

test('free, contributor and overlay suffixes carry off-allowance', async () => {
  const verdict = await probe({
    models: MODELS,
    session: [['opencode-go/minimax-m3', 0]],
    weekly: [['opencode-go/minimax-m3', 0]],
    account: { denySuffixes: ['-preview'] },
  });
  const flagged = (id) => verdict.models.find((row) => row.model === id).flags;
  assert.equal(flagged('opencode-go/minimax-m3'), undefined);
  assert.deepEqual(flagged('opencode-go/beam-free'), ['off-allowance']);
  assert.deepEqual(flagged('opencode-go/muse-spark-1.3-contributor'), ['off-allowance']);
  assert.deepEqual(flagged('opencode-go/m3-preview'), ['off-allowance']);
});

test('a stats parse failure is probe_failed and omits the windows', async () => {
  const verdict = await opencodeAvailability({
    capture: async (_bin, argv) => {
      const key = argv.join(' ');
      if (key === '--version') return { status: 0, stdout: 'opencode v2.0.20\n' };
      if (key === 'models') return { status: 0, stdout: 'opencode-go/minimax-m3\n' };
      return { status: 1, stdout: 'not json' };
    },
    accountOf: async () => ({}),
  }).probe({ toolBin: tool, timeoutMs: 5000, host: {} });
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.reason, 'probe_failed');
  assert.equal(verdict.windows, undefined);
  assert.equal(verdict.models.length, 1);
  assert.match(verdict.message, /local-estimate windows were not read/);
  assert.match(verdict.message, /auth is checked by the lift/);
});

test('a named stats row with a non-numeric token total is not a zero window', async () => {
  const body = JSON.stringify({
    models: [{
      model: { providerID: 'opencode-go', id: 'minimax-m3' },
      tokens: { input: '100000', output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }],
  });
  const verdict = await opencodeAvailability({
    capture: async (_bin, argv) => {
      const key = argv.join(' ');
      if (key === '--version') return { status: 0, stdout: 'opencode v2.0.20\n' };
      if (key === 'models') return { status: 0, stdout: 'opencode-go/minimax-m3\n' };
      if (key.startsWith('stats ')) return { status: 0, stdout: body };
      return { status: 1, stdout: '' };
    },
    accountOf: async () => ({ allowance: { monthlyTokens: MONTHLY } }),
  }).probe({ toolBin: tool, timeoutMs: 5000, host: {} });
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.reason, 'probe_failed');
  assert.equal(verdict.windows, undefined);
});

test('a model list that is not read is probe_failed and omits the windows', async () => {
  for (const modelsAnswer of [
    { status: 1, stdout: '' },
    { status: 0, stdout: '' },
    { timedOut: true, status: null, stdout: '' },
  ]) {
    const verdict = await opencodeAvailability({
      capture: async (_bin, argv) => {
        const key = argv.join(' ');
        if (key === '--version') return { status: 0, stdout: 'opencode v2.0.20\n' };
        if (key === 'models') return modelsAnswer;
        return { status: 0, stdout: statsDoc([['opencode-go/minimax-m3', 0]]) };
      },
      accountOf: async () => ({ allowance: { monthlyTokens: MONTHLY } }),
    }).probe({ toolBin: tool, timeoutMs: 5000, host: {} });
    assert.equal(verdict.state, 'unknown');
    assert.equal(verdict.reason, 'probe_failed');
    assert.equal(verdict.windows, undefined);
    assert.equal(verdict.models, undefined);
    assert.equal(verdict.version, '2.0.20');
    assert.match(verdict.message, /the model list was not read/);
  }
});

test('a model the stats document does not name is zero percent', async () => {
  const verdict = await probe({
    models: ['opencode-go/minimax-m3'],
    session: [],
    weekly: [],
    account: { allowance: { monthlyTokens: MONTHLY } },
  });
  assert.equal(verdict.state, 'available');
  assert.equal(windowById(verdict, '5h:opencode-go/minimax-m3').usedPercent, 0);
});

test('a second probe whose stats body is not JSON keeps the earlier percentage', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'promptobus-adapter-opencode-'));
  const host = {
    kind: 'promptobus-host',
    resolveToolBin: () => ({ ok: true, bin: 'opencode' }),
    routingPaths: () => ({ cacheFile: path.join(dir, 'cache.json'), overlays: [] }),
  };
  let bad = false;
  const capture = async (_bin, argv) => {
    const key = argv.join(' ');
    if (key === '--version') return { status: 0, stdout: 'opencode v2.0.20\n' };
    if (key === 'models') return { status: 0, stdout: 'opencode-go/minimax-m3\n' };
    if (bad) return { status: 0, stdout: 'not json' };
    if (key === 'stats --days 0 --models --json') {
      return { status: 0, stdout: statsDoc([['opencode-go/minimax-m3', 100_000]]) };
    }
    if (key === 'stats --days 7 --models --json') {
      return { status: 0, stdout: statsDoc([['opencode-go/minimax-m3', 0]]) };
    }
    return { status: 1, stdout: '' };
  };
  const adapterFor = () => opencodeAvailability({
    capture,
    accountOf: async () => ({ allowance: { monthlyTokens: MONTHLY } }),
  });
  const first = await preflight({
    host, harnesses: ['opencode'], adapterFor, budgetMs: 5000,
  });
  assert.equal(first.harnesses.opencode.windows.find((w) => w.id.startsWith('5h:')).usedPercent, 50);
  bad = true;
  const second = await preflight({
    host, harnesses: ['opencode'], adapterFor, refresh: true, budgetMs: 5000,
  });
  assert.equal(second.harnesses.opencode.state, 'unknown');
  assert.equal(second.harnesses.opencode.reason, 'probe_failed');
  assert.equal(second.harnesses.opencode.windows.find((w) => w.id.startsWith('5h:')).usedPercent, 50);
});

test('a second probe whose models call exits non-zero keeps the earlier percentage', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'promptobus-adapter-opencode-'));
  const host = {
    kind: 'promptobus-host',
    resolveToolBin: () => ({ ok: true, bin: 'opencode' }),
    routingPaths: () => ({ cacheFile: path.join(dir, 'cache.json'), overlays: [] }),
  };
  let bad = false;
  const capture = async (_bin, argv) => {
    const key = argv.join(' ');
    if (key === '--version') return { status: 0, stdout: 'opencode v2.0.20\n' };
    if (key === 'models') {
      return bad
        ? { status: 1, stdout: '' }
        : { status: 0, stdout: 'opencode-go/minimax-m3\n' };
    }
    if (key === 'stats --days 0 --models --json') {
      return { status: 0, stdout: statsDoc([['opencode-go/minimax-m3', 100_000]]) };
    }
    if (key === 'stats --days 7 --models --json') {
      return { status: 0, stdout: statsDoc([['opencode-go/minimax-m3', 0]]) };
    }
    return { status: 1, stdout: '' };
  };
  const adapterFor = () => opencodeAvailability({
    capture,
    accountOf: async () => ({ allowance: { monthlyTokens: MONTHLY } }),
  });
  const first = await preflight({
    host, harnesses: ['opencode'], adapterFor, budgetMs: 5000,
  });
  assert.equal(first.harnesses.opencode.windows.find((w) => w.id.startsWith('5h:')).usedPercent, 50);
  bad = true;
  const second = await preflight({
    host, harnesses: ['opencode'], adapterFor, refresh: true, budgetMs: 5000,
  });
  assert.equal(second.harnesses.opencode.state, 'unknown');
  assert.equal(second.harnesses.opencode.reason, 'probe_failed');
  assert.equal(second.harnesses.opencode.windows.find((w) => w.id.startsWith('5h:')).usedPercent, 50);
});

test('a local-estimate window may omit usedPercent and a measured window may not', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const schema = JSON.parse(readFileSync(path.join(root, 'schemas/model-routing/snapshot.schema.json'), 'utf8'));
  const validate = ajv.compile(schema);
  const harness = (window) => ({
    schemaVersion: 2,
    takenAt: STAMP,
    harnesses: {
      opencode: {
        state: 'available',
        reason: null,
        message: 'local estimate',
        checkedAt: STAMP,
        source: 'probe',
        windows: [window],
      },
    },
  });
  const base = {
    id: '5h:opencode-go/minimax-m3',
    kind: 'session',
    lengthSec: 18000,
    scope: { model: 'opencode-go/minimax-m3', models: ['opencode-go/minimax-m3'] },
    resetAt: null,
  };
  assert.equal(validate(harness({ ...base, estimate: 'local-estimate' })), true, ajv.errorsText(validate.errors));
  assert.equal(validate(harness({ ...base })), false);
  assert.equal(validate(harness({ ...base, usedPercent: 12 })), true, ajv.errorsText(validate.errors));
  const kept = snapshotEntry({
    state: 'available',
    reason: null,
    message: 'local estimate',
    checkedAt: STAMP,
    source: 'probe',
    windows: [{ ...base, estimate: 'local-estimate' }],
  });
  assert.equal(kept.windows.length, 1);
  assert.equal(Object.hasOwn(kept.windows[0], 'usedPercent'), false);
  const dropped = snapshotEntry({
    state: 'available',
    reason: null,
    message: 'measured',
    checkedAt: STAMP,
    source: 'probe',
    windows: [base],
  });
  assert.equal(dropped.windows.length, 0);
});

function tuple(id, model) {
  return {
    id,
    harness: 'opencode',
    model,
    effort: null,
    roles: ['worker', 'reviewer', 'approver'],
    ratings: { quality: 7, speed: 5, quotaCost: 6 },
    billing: 'subscription',
    priority: id.endsWith('free') ? 960 : 950,
    assessedAt: STAMP,
  };
}

function decide(flags, constraints = {}) {
  const catalog = {
    schemaVersion: 2,
    updated: STAMP,
    tuples: [tuple('opencode-minimax-m3', 'opencode-go/minimax-m3'), tuple('opencode-beam-free', 'opencode-go/beam-free')],
  };
  const policy = mergeRouting({ canonical: catalog, now: NOW });
  const snapshot = {
    schemaVersion: 2,
    takenAt: STAMP,
    harnesses: {
      opencode: {
        state: 'available',
        reason: null,
        message: 'local estimate',
        checkedAt: STAMP,
        source: 'probe',
        models: [
          { model: 'opencode-go/minimax-m3' },
          { model: 'opencode-go/beam-free', flags },
        ],
        windows: [{
          id: '5h:opencode-go/minimax-m3',
          kind: 'session',
          lengthSec: 18000,
          usedPercent: 50,
          estimate: 'local-estimate',
          scope: { model: 'opencode-go/minimax-m3', models: ['opencode-go/minimax-m3'] },
          resetAt: null,
          source: 'probe',
        }],
      },
    },
  };
  return resolve({
    role: 'worker', strategy: 'balanced', constraints, policy, snapshot, now: NOW,
  });
}

test('a free model is never chosen, including when it is named', () => {
  const open = decide(['off-allowance']);
  assert.equal(open.chosen.tupleId, 'opencode-minimax-m3');
  const banned = open.candidates.find((row) => row.tupleId === 'opencode-beam-free');
  assert.equal(banned.excluded.code, 'denied-by-policy');
  assert.match(banned.excluded.detail, /off-allowance/);
  assert.match(banned.excluded.detail, /explicit --model is refused too/);
  const named = decide(['off-allowance'], { model: 'opencode-go/beam-free' });
  assert.equal(named.chosen, null);
  assert.equal(named.candidates.find((row) => row.tupleId === 'opencode-beam-free').excluded.code, 'denied-by-policy');
});

function harnessEntry(over) {
  return {
    state: 'available',
    reason: null,
    message: 'fixture',
    checkedAt: STAMP,
    source: 'probe',
    ...over,
  };
}

test('balance does not pick opencode-minimax-m3 over a paced harness', () => {
  const catalog = {
    schemaVersion: 2,
    updated: STAMP,
    tuples: [
      tuple('opencode-minimax-m3', 'opencode-go/minimax-m3'),
      {
        ...tuple('claude-paced', 'claude-paced'),
        harness: 'claude',
        model: 'claude-paced',
        ratings: { quality: 6, speed: 5, quotaCost: 6 },
        priority: 10,
      },
    ],
  };
  const policy = mergeRouting({ canonical: catalog, now: NOW });
  const snapshot = {
    schemaVersion: 2,
    takenAt: STAMP,
    harnesses: {
      opencode: harnessEntry({
        models: [{ model: 'opencode-go/minimax-m3' }],
        windows: [{
          id: '5h:opencode-go/minimax-m3',
          kind: 'session',
          lengthSec: 18000,
          usedPercent: 5,
          estimate: 'local-estimate',
          resetAt: null,
          scope: { model: 'opencode-go/minimax-m3', models: ['opencode-go/minimax-m3'] },
          source: 'probe',
        }],
      }),
      claude: harnessEntry({
        models: [{ model: 'claude-paced' }],
        windows: [{
          id: '5h',
          kind: 'session',
          lengthSec: 18000,
          usedPercent: 40,
          resetAt: '2026-10-29T05:00:00.000Z',
          scope: null,
          source: 'probe',
        }],
      }),
    },
  };
  const strategyCommands = {
    economy: 'promptobus models strategy --set economy',
    balance: 'promptobus models strategy --set balance',
  };
  const decision = resolve({
    role: 'worker', strategy: 'balance', policy, snapshot, now: NOW, strategyCommands,
  });
  const open = decision.candidates.find((row) => row.tupleId === 'opencode-minimax-m3');
  assert.equal(open.pace.note, 'no-pace');
  assert.equal(open.pace.eligible, false);
  assert.equal(decision.chosen.tupleId, 'claude-paced');
  const spent = resolve({
    role: 'worker',
    strategy: 'balance',
    policy,
    strategyCommands,
    now: NOW,
    snapshot: {
      ...snapshot,
      harnesses: {
        ...snapshot.harnesses,
        opencode: harnessEntry({
          models: [{ model: 'opencode-go/minimax-m3' }],
          windows: [{
            ...snapshot.harnesses.opencode.windows[0],
            usedPercent: 96,
          }],
        }),
      },
    },
  });
  assert.equal(spent.candidates.find((row) => row.tupleId === 'opencode-minimax-m3').excluded.code,
    'window-nearly-spent');
  assert.equal(spent.chosen.tupleId, 'claude-paced');
});

test('a lower local-estimate percentage raises remaining and does not raise near-limit', () => {
  const catalog = {
    schemaVersion: 2,
    updated: STAMP,
    tuples: [tuple('opencode-minimax-m3', 'opencode-go/minimax-m3')],
  };
  const policy = mergeRouting({ canonical: catalog, now: NOW });
  const strategyCommands = {
    economy: 'promptobus models strategy --set economy',
    balance: 'promptobus models strategy --set balance',
  };
  const at = (usedPercent) => resolve({
    role: 'worker',
    strategy: 'quality',
    policy,
    strategyCommands,
    now: NOW,
    snapshot: {
      schemaVersion: 2,
      takenAt: STAMP,
      harnesses: {
        opencode: harnessEntry({
          models: [{ model: 'opencode-go/minimax-m3' }],
          windows: [{
            id: '5h:opencode-go/minimax-m3',
            kind: 'session',
            lengthSec: 18000,
            usedPercent,
            estimate: 'local-estimate',
            resetAt: null,
            scope: { model: 'opencode-go/minimax-m3', models: ['opencode-go/minimax-m3'] },
            source: 'probe',
          }],
        }),
      },
    },
  });
  const remaining = (usedPercent) => at(usedPercent).candidates
    .find((row) => row.tupleId === 'opencode-minimax-m3').score.components.remaining;
  assert.ok(remaining(10) > remaining(40));
  const short = at(85);
  assert.equal(short.chosen.tupleId, 'opencode-minimax-m3');
  assert.equal(short.warnings.some((warning) => warning.code === 'near-limit'), false);
});

test('allowance and denySuffixes are accepted only on opencode', () => {
  assert.deepEqual(checkOverlayShape({
    schemaVersion: 2,
    account: { opencode: { allowance: { monthlyTokens: 50000000 }, denySuffixes: ['-preview'] } },
  }), []);
  const refused = checkOverlayShape({
    schemaVersion: 2,
    account: { claude: { allowance: { monthlyTokens: 1 } } },
  });
  assert.match(refused.map((item) => item.note).join('\n'), /only on opencode/);
});

test('the reference quotes the OpenCode window shares and the absolute allowance', () => {
  const doc = readFileSync(path.join(root, 'docs/reference/03-cli.md'), 'utf8');
  assert.match(doc, /account\.opencode\.allowance\.monthlyTokens/);
  assert.match(doc, /local-estimate/);
  assert.match(doc, /export const OPENCODE_WINDOW_SHARES = Object\.freeze\(\{ session: 0\.2, weekly: 0\.5 \}\);/);
  const pages = [
    doc,
    readFileSync(path.join(root, 'docs/guides/model-routing.md'), 'utf8'),
    readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'),
    readFileSync(path.join(root, 'README.md'), 'utf8'),
  ];
  for (const page of pages) {
    assert.match(page, /scales `remaining` under the weighted strategies/);
    assert.doesNotMatch(page, /enters routing only as/);
  }
});

test('the shipped catalog rates one OpenCode model at the default effort', () => {
  const catalog = JSON.parse(readFileSync(path.join(root, 'models/catalog.json'), 'utf8'));
  const rows = catalog.tuples.filter((row) => row.harness === 'opencode');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'opencode-minimax-m3');
  assert.equal(rows[0].model, 'opencode-go/minimax-m3');
  assert.equal(rows[0].effort, null);
  assert.deepEqual(rows[0].roles, ['worker']);
  assert.deepEqual(rows[0].evidence.hypothesis, ['quality', 'speed', 'quotaCost']);
});
