// The routing COMMANDS — `models`, and the `--strategy` gate on `spawn` and
// `review`. Run: npm test
//
// The neighbouring [model-routing.test.mjs](model-routing.test.mjs) pins the
// contract and reproduces the goldens end to end; this file is what the command
// does around them, and the two do not overlap. What is asserted here is
// behaviour with consequences: what is on disk after a refusal, what a dry run
// leaves behind, what the participant record carries, and in which ORDER the
// gates fire.
//
// Three properties are the subject, and each of them would be silent if it broke:
//
// 1. **A run with no candidate leaves the store exactly as it was.** ADR-005
//    puts routing in the gate order `lib/spawn.js` already states — "two gates,
//    both before any write to disk" — and the check is a byte comparison of the
//    whole store directory before and after, not a spot check of one file: a
//    write that moved to a neighbouring file would pass a spot check.
// 2. **A dry run writes nothing, and `--refresh` still writes nothing.** The
//    probe counter says the second half of that is real — a `--refresh --dry-run`
//    that quietly skipped the probe would also write nothing, and would pass a
//    check that only looked at the disk.
// 3. **Constraints are validated before the resolver is asked.** `resolve`
//    cannot tell "a harness this workspace never declared" from "nothing
//    survived": both are `chosen: null`. The order is checked by the probe
//    counter — the refusal has to arrive before the preflight, which is before
//    the resolver.
//
// Nothing here starts a harness binary. `claude` is a stub script on PATH for
// the lift (the same helper the spawn and review files use), and every
// availability adapter is a stand-in ([routing-stubs.mjs](routing-stubs.mjs))
// handed in through the seam the two commands declare for it.
// Home diversion before any import that is not a Node built-in: a module that
// resolved a home path at load would see the real one. [home.mjs](home.mjs) says
// what it applies; the sentinel in tmpdir-sweep.test.mjs keeps the order.
import './home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { captureSplit, quiet } from './console.mjs';
import { adapterMap, answeringStub, counter, unauthenticatedStub } from './routing-stubs.mjs';
import { stubCommand, writeHostConfig } from './sandbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const {
  models, routingContext, routingLine, routingMetadata,
} = await import(path.join(here, '..', 'lib', 'models.js'));
const SCHEMAS = path.join(here, '..', 'schemas', 'model-routing');
const { planSpawn, spawn: spawnRaw } = await import(path.join(here, '..', 'lib', 'spawn.js'));
const { planReview, review } = await import(path.join(here, '..', 'lib', 'review.js'));
const { status } = await import(path.join(here, '..', 'lib', 'status.js'));
const { hostOf } = await import(path.join(here, '..', 'lib', 'host.js'));
const store = await import(path.join(here, '..', 'lib', 'store.js'));
const { markExhausted, readSnapshot } = await import(path.join(here, '..', 'lib', 'model-routing', 'cache.js'));

// realpath: the planner canonicalises the workspace root (macOS: /var →
// /private/var), and paths compared against a plan must be canonical too.
const SB = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'promptobus-routing-cmd-')));
const WS = path.join(SB, 'ws');
mkdirSync(WS, { recursive: true });
writeFileSync(path.join(WS, 'AGENTS.md'), 'workspace\n');
writeHostConfig(WS, { tools: ['claude', 'cursor', 'codex'] });

const g = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

// A bare origin on disk instead of the network, exactly as the spawn file does
// it: `freshenRepo` runs a real fetch and `createWorktree` opens a real branch,
// and no check here depends on a git mock.
const ORIGIN = path.join(SB, 'origin', 'orders-api.git');
const SEED = path.join(SB, 'seed');
mkdirSync(ORIGIN, { recursive: true });
mkdirSync(SEED, { recursive: true });
spawnSync('git', ['init', '--bare', '-b', 'main', ORIGIN], { encoding: 'utf8' });
g(SEED, 'init', '-b', 'main');
writeFileSync(path.join(SEED, 'a.txt'), 'v1\n');
g(SEED, 'add', '.');
g(SEED, 'commit', '-m', 'init', '-q');
g(SEED, 'remote', 'add', 'origin', ORIGIN);
g(SEED, 'push', '-q', 'origin', 'main');
const REPO = path.join(WS, 'orders-api');
spawnSync('git', ['clone', '-q', ORIGIN, REPO], { encoding: 'utf8' });

const BRIEF = path.join(SB, 'brief.md');
writeFileSync(BRIEF, '# Route this worker\n\nA brief.\n');

// The stub `claude`: `--version` for the binary gate, `agents --json` for the
// liveness check, anything else is the background lift. No session is started.
const BIN = path.join(SB, 'bin');
mkdirSync(BIN, { recursive: true });
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;
const claudeSays = (sessions) => stubCommand(BIN, 'claude', `const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('2.1.237 (Claude Code)\\n'); process.exit(0); }
if (args[0] === 'agents') { process.stdout.write(${JSON.stringify(JSON.stringify(sessions))}); process.exit(0); }
process.stdout.write('backgrounded · sess-0001\\n');
process.exit(0);`);

const HOST = hostOf(WS);
const HOME = store.promptobusHome(WS, HOST);
const CACHE = HOST.routingPaths().cacheFile;

/** A stream that keeps what a command wrote. */
function sink() {
  const chunks = [];
  return { write: (c) => chunks.push(c), get text() { return chunks.join(''); } };
}

/** One availability entry, stamped now so the cache TTLs count it live. */
const entry = (state, reason, extra = {}) => ({
  state,
  reason,
  message: 'stand-in entry written by the suite',
  checkedAt: new Date().toISOString(),
  source: 'cache',
  resetAt: null,
  ...extra,
});

/** Seed the availability cache the host names. Written whole: these checks own the file. */
function seedCache(harnesses) {
  mkdirSync(path.dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, `${JSON.stringify({ schemaVersion: 2, takenAt: new Date().toISOString(), harnesses }, null, 2)}\n`,
    { mode: 0o600 });
}

/** Every harness authenticated, with a limit window — the ordinary case a pick is made in. */
const HEALTHY = () => ({
  claude: entry('available', null, {
    models: [{ model: 'claude-opus-5', rated: true }, { model: 'claude-sonnet-5', rated: true }],
    windows: [{ id: '5h', kind: 'session', usedPercent: 20, lengthSec: 18000, resetAt: null, scope: null }],
  }),
  cursor: entry('unavailable', 'not_authenticated'),
  codex: entry('unavailable', 'not_authenticated'),
});

/**
 * The adapters a probing run is answered by: `claude` logged in with the two
 * models the catalog rates for it, the other two logged out.
 *
 * The inventory matters and cannot be left to a generic stand-in: a tuple whose
 * model the account does not expose is excluded, so an adapter answering with
 * invented model names would make every catalog row fall to
 * `model-not-in-inventory` and turn every probing check into a no-candidate one.
 */
const probeSet = (probes) => adapterMap({
  claude: answeringStub({
    state: 'available',
    reason: null,
    message: 'stand-in probe',
    checkedAt: new Date().toISOString(),
    source: 'probe',
    resetAt: null,
    models: [{ model: 'claude-opus-5' }, { model: 'claude-sonnet-5' }],
    windows: [{ id: '5h', kind: 'session', usedPercent: 20, lengthSec: 18000, resetAt: null, scope: null }],
  }, probes),
  cursor: unauthenticatedStub(probes),
  codex: unauthenticatedStub(probes),
});

/**
 * The whole store, as bytes. A refusal that wrote one file into a directory this
 * comparison did not name would pass a spot check; this one names every file.
 */
function treeOf(dir) {
  const rows = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(d, e.name);
      const at = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        rows.push(`d ${at}`);
        walk(abs, at);
      } else {
        rows.push(`f ${at} ${statSync(abs).size} ${readFileSync(abs, 'utf8')}`);
      }
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return rows;
}

const cacheBytes = () => (existsSync(CACHE) ? readFileSync(CACHE, 'utf8') : null);

/** A task to attach a worker to. Its id is fixed: a generated one moves with the clock. */
function freshTask(id) {
  store.createTask(HOME, { id, title: 'routing checks', slug: 'routing', stamp: 't20260905-090000' });
  return id;
}

/**
 * A routed spawn call. The adapter seam is part of the DEFAULT, not something a
 * check remembers to add: a check that forgot it would reach the real Claude
 * adapter and stay green only while a seeded cache entry sits inside its sixty
 * seconds — green on the clock rather than on the code. A check that wants to
 * count probes passes its own counter, and `...extra` wins.
 */
const routedOpts = (extra = {}) => ({
  repo: 'orders-api',
  brief: BRIEF,
  strategy: 'balanced',
  tool: { ok: true, bin: path.join(BIN, process.platform === 'win32' ? 'claude.cmd' : 'claude') },
  adapterFor: probeSet(counter()),
  ...extra,
});

// --- the strategy default, ADR-005 ------------------------------------------

/** The writable layer under the standalone host: `<promptobusHome>/model-routing.json`. */
const WORKSPACE_OVERLAY = () => path.join(HOST.promptobusHome(), 'model-routing.json');
const USER_OVERLAY = () => HOST.routingPaths().overlays.find((l) => l.id === 'user').path;

function writeOverlay(file, doc) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

function dropOverlays() {
  for (const file of [WORKSPACE_OVERLAY(), USER_OVERLAY()]) rmSync(file, { force: true });
}

test('`models strategy` with no default says so, and --set records one in the writable layer', async () => {
  dropOverlays();
  try {
    const empty = await captureSplit(() => models(WS, { subcommand: 'strategy' }));
    assert.equal(empty.value, 0);
    assert.match(empty.out, /strategy default: none/);

    const set = await captureSplit(() => models(WS, { subcommand: 'strategy', set: 'balance' }));
    assert.equal(set.value, 0);
    assert.match(set.out, /strategy default set to balance in overlay "workspace"/);

    const file = WORKSPACE_OVERLAY();
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { schemaVersion: 2, defaults: { strategy: 'balance' } });
    // The host contract asks for 0600 on what the tool writes under a person's
    // home, and a half-written overlay is a routing stack that refuses to load.
    assert.equal(statSync(file).mode & 0o777, 0o600, 'the written overlay must be 0600');

    const said = await captureSplit(() => models(WS, { subcommand: 'strategy' }));
    assert.match(said.out, /strategy default: balance · set by overlay "workspace"/);
  } finally {
    dropOverlays();
  }
});

test('--set keeps every other key of the file, and --clear takes only that one away', async () => {
  dropOverlays();
  const file = WORKSPACE_OVERLAY();
  // A person's file that happens to hold one machine-written value — not a file
  // the tool owns. Everything they wrote has to survive both operations.
  // Version 2 because it carries a floor: ADR-005 refuses a v1 file holding any
  // value on the rating scale. `--set` must not touch that either.
  writeOverlay(file, {
    schemaVersion: 2,
    note: 'mine',
    deny: { tuples: ['cursor-composer-2.5'] },
    qualityFloor: { reviewer: 4 },
  });
  try {
    await quiet(() => models(WS, { subcommand: 'strategy', set: 'economy' }));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      schemaVersion: 2,
      note: 'mine',
      deny: { tuples: ['cursor-composer-2.5'] },
      qualityFloor: { reviewer: 4 },
      defaults: { strategy: 'economy' },
    });

    const cleared = await captureSplit(() => models(WS, { subcommand: 'strategy', clear: true }));
    assert.match(cleared.out, /strategy default cleared from overlay "workspace"/);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      schemaVersion: 2,
      note: 'mine',
      deny: { tuples: ['cursor-composer-2.5'] },
      qualityFloor: { reviewer: 4 },
    }, 'an empty defaults block is removed rather than left as {}');
  } finally {
    dropOverlays();
  }
});

test('`models` routes with the recorded default, and --strategy still wins over it', async () => {
  // `models` answers "what would the resolver pick right now", so it reads the
  // same default the lift does. Without that, `--set balance` and `models` would
  // disagree about what is in force — and the near-limit line, which falls
  // silent when it would propose the running strategy, could never fall silent.
  dropOverlays();
  seedCache(HEALTHY());
  try {
    const run = async (opts = {}) => {
      const out = sink();
      await quiet(() => models(WS, { ...opts, output: out }));
      return out.text;
    };

    assert.match(await run(), /strategy: balanced · role: worker/,
      'no default: balanced, the answer with no thumb on any scale');

    await quiet(() => models(WS, { subcommand: 'strategy', set: 'economy' }));
    assert.match(await run(), /strategy: economy · role: worker/);
    assert.match(await run({ strategy: 'quality' }), /strategy: quality · role: worker/, 'the flag wins here too');

    assert.equal(JSON.parse(await run({ json: true })).strategySource, 'overlay:workspace',
      'the document says where the strategy came from when it was not typed');
    assert.equal(JSON.parse(await run({ strategy: 'quality', json: true })).strategySource, undefined,
      'a flag records no source — there is nowhere else the value could have come from');
  } finally {
    dropOverlays();
  }
});

test('--clear with nothing to clear writes no file, and a shadowing layer is named', async () => {
  dropOverlays();
  try {
    // Creating a file to record the absence of a key would leave an overlay on
    // disk that says nothing, in a directory that had none.
    const nothing = await captureSplit(() => models(WS, { subcommand: 'strategy', clear: true }));
    assert.equal(nothing.value, 0);
    assert.match(nothing.out, /nothing to clear/);
    assert.equal(existsSync(WORKSPACE_OVERLAY()), false, '--clear must not create the file it would clear');

    // The standalone host marks its HIGHEST layer writable, so nothing can
    // shadow it — 02-host says a host SHOULD do that, and the warning exists for
    // a consumer host that does not. Built here, because a warning no host in
    // the suite can raise is a warning nobody has read back.
    const paths = HOST.routingPaths();
    const upended = {
      ...HOST,
      routingPaths: () => ({ ...paths, overlays: [paths.overlays[1], paths.overlays[0]] }),
    };
    writeOverlay(USER_OVERLAY(), { schemaVersion: 1, defaults: { strategy: 'quality' } });
    const shadowed = await captureSplit(() => models(upended, { subcommand: 'strategy', set: 'economy' }));
    assert.match(shadowed.out, /strategy default set to economy/);
    assert.match(shadowed.err + shadowed.out, /what was just written is shadowed/);
    assert.match(shadowed.err + shadowed.out, /overlay "user" sits above "workspace"/);
  } finally {
    dropOverlays();
  }
});

test('`models strategy --set` refuses a value that is not a strategy, and refuses both flags at once', async () => {
  dropOverlays();
  await assert.rejects(() => quiet(() => models(WS, { subcommand: 'strategy', set: 'auto' })),
    (e) => e.code === 'strategy-unknown' && /"auto" is not one of them/.test(e.message));
  await assert.rejects(() => quiet(() => models(WS, { subcommand: 'strategy', set: 'balance', clear: true })),
    (e) => /opposite things/.test(e.message));
  assert.equal(existsSync(WORKSPACE_OVERLAY()), false, 'a refused write leaves no file behind');
});

test('models rejects strategy and calibration flags without their subcommand', async () => {
  dropOverlays();
  seedCache(HEALTHY());
  try {
    const cases = [
      [{ set: 'economy' }, /models strategy --set/],
      [{ clear: true }, /models strategy --clear/],
      [{ write: true }, /models calibrate --write/],
      [{ yes: true }, /models calibrate --write/],
    ];
    for (const [options, expected] of cases) {
      await assert.rejects(() => quiet(() => models(WS, options)),
        (error) => expected.test(error.message), JSON.stringify(options));
    }
  } finally {
    dropOverlays();
  }
});

test('a host with no writable layer is refused at the write, naming why', async () => {
  // The standalone host marks one; a consumer host need not declare an overlay
  // at all, and then there is nowhere to keep a default. The refusal says that
  // rather than writing somewhere of its own choosing.
  const bare = { ...HOST, routingPaths: () => ({ ...HOST.routingPaths(), overlays: [] }) };
  await assert.rejects(() => quiet(() => models(bare, { subcommand: 'strategy', set: 'balance' })),
    (e) => e.code === 'overlay-invalid' && /nowhere to keep a strategy default/.test(e.message));
});

test('`spawn --dry-run` with no --strategy takes the overlay default and records its source', async () => {
  dropOverlays();
  seedCache(HEALTHY());
  const task = freshTask('default-t20260905-090010');
  try {
    await quiet(() => models(WS, { subcommand: 'strategy', set: 'economy' }));
    const said = await captureSplit(() => spawnRaw(WS, {
      repo: 'orders-api',
      brief: BRIEF,
      task,
      worker: 'defaulted',
      dryRun: true,
      tool: { ok: true, bin: path.join(BIN, process.platform === 'win32' ? 'claude.cmd' : 'claude') },
      adapterFor: probeSet(counter()),
    }));
    assert.match(said.out, /routing decision:/, 'the default routes the lift, with no flag on the command line');
    assert.match(said.out, /strategy: economy · role: worker/);
  } finally {
    dropOverlays();
  }
});

test('a broken overlay warns before an unrouted lift takes the legacy path', async () => {
  // Keep the recorded default in the user layer so the workspace layer can be
  // the broken one. Both failures used to return null with no diagnostic.
  const cases = [
    ['malformed JSON', '{"schemaVersion": 2,'],
    ['schemaVersion 1 with scaled ratings', JSON.stringify({
      schemaVersion: 1, ratings: { 'claude-opus-5': { quality: 8 } },
    })],
  ];
  for (const [index, [label, contents]] of cases.entries()) {
    dropOverlays();
    const task = freshTask(`broken-default-t20260905-09001${index + 3}`);
    const workspace = WORKSPACE_OVERLAY();
    writeOverlay(USER_OVERLAY(), { schemaVersion: 1, defaults: { strategy: 'balance' } });
    mkdirSync(path.dirname(workspace), { recursive: true });
    writeFileSync(workspace, contents);
    try {
      const said = await captureSplit(() => spawnRaw(WS, {
        repo: 'orders-api',
        brief: BRIEF,
        task,
        worker: `broken-default-${index}`,
        dryRun: true,
        tool: { ok: true, bin: path.join(BIN, process.platform === 'win32' ? 'claude.cmd' : 'claude') },
        adapterFor: probeSet(counter()),
      }));
      assert.match(said.err, /routing layer "workspace"/);
      assert.ok(said.err.includes(workspace), `${label}: warning names the overlay path`);
      assert.match(said.err, /promptobus models validate/);
      assert.match(said.err, /reading the strategy default/);
      assert.equal(/routing decision:/.test(said.out), false, `${label}: broken default is not treated as a route`);
      await assert.rejects(() => quiet(() => models(WS, {})), (e) => {
        assert.equal(e.code, 'overlay-invalid', `${label}: models refuses the broken stack`);
        assert.match(e.message, /routing layer "workspace"/);
        assert.ok(e.message.includes(workspace), `${label}: models names the overlay path`);
        return true;
      });
    } finally {
      dropOverlays();
    }
  }
});

test('a flag on the command line always wins over the default', async () => {
  // ADR-005's precedence, and the rule ADR-005 fixed for --harness, --model and
  // --effort: a named value is never replaced. This is the check the mutation
  // probe of PB-32 breaks.
  dropOverlays();
  seedCache(HEALTHY());
  const task = freshTask('precedence-t20260905-090011');
  try {
    await quiet(() => models(WS, { subcommand: 'strategy', set: 'economy' }));
    const said = await captureSplit(() => spawnRaw(WS, routedOpts({
      task, worker: 'flagged', dryRun: true, strategy: 'quality',
    })));
    assert.match(said.out, /strategy: quality · role: worker/,
      'the flag the person typed is what routed, not the recorded default');
    assert.equal(/strategy: economy/.test(said.out), false);
  } finally {
    dropOverlays();
  }
});

test('with no default anywhere, a spawn without --strategy takes the legacy path', async () => {
  dropOverlays();
  seedCache(HEALTHY());
  const task = freshTask('legacy-t20260905-090012');
  const probes = counter();
  const said = await captureSplit(() => spawnRaw(WS, {
    repo: 'orders-api',
    brief: BRIEF,
    task,
    worker: 'legacy',
    dryRun: true,
    tool: { ok: true, bin: path.join(BIN, process.platform === 'win32' ? 'claude.cmd' : 'claude') },
    adapterFor: probeSet(probes),
  }));
  assert.equal(/routing decision:/.test(said.out), false, 'nothing is routed');
  assert.equal(probes.probes, 0, 'and no harness is asked — the legacy path is unchanged, not merely quiet');
});

test('`models` names the one question the tool cannot answer, and no command writes it', async () => {
  dropOverlays();
  seedCache(HEALTHY());
  const missing = await captureSplit(() => models(WS, {}));
  assert.match(missing.out, /no plan name recorded for/);
  assert.match(missing.out, /No command writes it/);
  assert.match(missing.out, /"account": \{ "<harness>": \{ "plan": "<name>" \} \}/);

  writeOverlay(USER_OVERLAY(), { schemaVersion: 1, account: { cursor: { plan: 'example-ultra' } } });
  try {
    const answered = await captureSplit(() => models(WS, {}));
    assert.match(answered.out, /account\.cursor\.plan: "example-ultra" · from overlay "user"/);
    assert.match(answered.out, /scored by nothing/);
  } finally {
    dropOverlays();
  }
});

// --- `models validate`, `--clear-exhausted` ----------------------------------

test('`models validate` prints the bans in force and who can lift each one', async () => {
  // The whole point of ADR-005's union is met where a person meets it: a deny
  // rule is lifted in the layer that wrote it and nowhere else, and no allow
  // list anywhere reaches one. A person reading `denied-by-policy` on a
  // candidate row otherwise has to work out which of three files to open.
  dropOverlays();
  writeOverlay(USER_OVERLAY(), { schemaVersion: 1, deny: { tuples: ['cursor-composer-2.5'] } });
  writeOverlay(WORKSPACE_OVERLAY(), {
    schemaVersion: 1,
    deny: { harnesses: ['codex'], byRole: { reviewer: { harnesses: ['cursor'] } } },
  });
  try {
    const said = await captureSplit(() => models(WS, { subcommand: 'validate' }));
    assert.match(said.out, /deny rules in force — each is lifted only in the layer that wrote it/);
    assert.match(said.out, /deny\.tuples of "user": cursor-composer-2\.5/);
    assert.match(said.out, /deny\.harnesses of "workspace": codex/);
    assert.match(said.out, /deny\.byRole\.reviewer\.harnesses of "workspace": cursor/);
  } finally {
    dropOverlays();
  }

  // No rule, no block: a heading with nothing under it reads as output that
  // failed to print.
  const bare = await captureSplit(() => models(WS, { subcommand: 'validate' }));
  assert.equal(/deny rules in force/.test(bare.out), false);
});

test('`models validate` checks the shipped catalog and the layers the host names', async () => {
  const said = await captureSplit(() => models(WS, { subcommand: 'validate' }));
  assert.equal(said.value, 0);
  assert.match(said.out, /layers: catalog /);
  assert.match(said.out, /user \(absent\)/);
  assert.match(said.out, /the catalog and 2 overlay layer\(s\) hold/);
  // Which layer the tool writes is a fact about the stack, and this is the
  // command a person runs to ask about the stack (ADR-005, PB-25).
  assert.match(said.out, /workspace .*\[writable\]/);
  assert.equal(/user .*\[writable\]/.test(said.out), false, 'only one layer may be marked');
});

test('`models validate` prints the layer of a warning that carries one', async () => {
  // The question the field was added for is "is this mine?", and a person asks
  // it here rather than in a library call — so the line has to answer it.
  dropOverlays();
  writeOverlay(USER_OVERLAY(), {
    schemaVersion: 2, reviewerQualityFloor: 2, qualityFloor: { reviewer: 5 },
  });
  try {
    const said = await captureSplit(() => models(WS, { subcommand: 'validate' }));
    assert.equal(said.value, 0, 'an advisory warning does not fail the command');
    assert.match(said.err, /quality-floor-alias · user: /);
    // Raised by the shipped catalog and by nothing of this person's: the same
    // line has to say so instead of leaving them to guess.
    assert.match(said.err, /ladder-indistinguishable · catalog: /);
    // A warning with no layer keeps the plain shape. Positive form on purpose:
    // an absence passes just as well when the warning itself stopped being raised.
    assert.match(said.err, /(?:^|\n)[^\n]*promotion-expired: /);
  } finally {
    dropOverlays();
  }
});

test('`models --clear-exhausted` drops a reset-less exhaustion and says so, and leaves a dated one alone', async () => {
  seedCache(HEALTHY());
  markExhausted(HOST, 'claude', { resetAt: null });
  assert.equal(readSnapshot(HOST).harnesses.claude.state, 'exhausted');

  const cleared = await captureSplit(() => models(WS, { clearExhausted: 'claude' }));
  assert.match(cleared.out, /the exhaustion mark is cleared/);
  assert.equal(readSnapshot(HOST).harnesses.claude, undefined, 'the entry is dropped, not rewritten');

  // An exhaustion that names its reset expires by itself, and this flag is not
  // the door to it: the entry has to still be there afterwards.
  markExhausted(HOST, 'claude', { resetAt: new Date(Date.now() + 3600_000).toISOString() });
  const kept = await captureSplit(() => models(WS, { clearExhausted: 'claude' }));
  assert.match(kept.out, /nothing to clear/);
  assert.equal(readSnapshot(HOST).harnesses.claude.state, 'exhausted');
});

test('`models --clear-exhausted` refuses a harness the workspace does not declare', async () => {
  await assert.rejects(() => models(WS, { clearExhausted: 'no-such-harness' }),
    (e) => e.code === 'harness-unknown' && /declares no such harness/.test(e.message));
});

// --- the constraint gate stands before the preflight, hence before resolve ----

test('an undeclared --harness is harness-unknown, and the refusal arrives before any probe', async () => {
  seedCache(HEALTHY());
  const probes = counter();
  await assert.rejects(() => routingContext(WS, {
    strategy: 'balanced',
    role: 'worker',
    harness: 'no-such-harness',
    // `--refresh` would probe every harness; the counter staying at zero is what
    // says the refusal came first — and the preflight is before the resolver, so
    // it came before that too.
    refresh: true,
    adapterFor: probeSet(probes),
  }), (e) => e.code === 'harness-unknown');
  assert.equal(probes.probes, 0, 'the constraint gate must refuse before the preflight runs');
});

test('a --model no tuple names is constraint-unknown, and the refusal lists what is rated', async () => {
  seedCache(HEALTHY());
  const probes = counter();
  await assert.rejects(() => routingContext(WS, {
    strategy: 'balanced',
    role: 'worker',
    model: 'gpt-nothing',
    refresh: true,
    adapterFor: probeSet(probes),
  }), (e) => e.code === 'constraint-unknown' && /rated models: /.test(e.message));
  assert.equal(probes.probes, 0, 'the constraint gate must refuse before the preflight runs');
});

// --- an explicit --model the catalog does not rate lifts unrouted --------------

test('a lift context for a --model no tuple names routes nothing, says so, and probes nothing', async () => {
  seedCache(HEALTHY());
  const probes = counter();
  const said = await captureSplit(() => routingContext(WS, {
    strategy: 'balanced',
    role: 'worker',
    model: 'claude-next-9',
    refresh: true,
    adapterFor: probeSet(probes),
    liftUnrated: true,
  }));
  assert.equal(said.value, null, 'an unrated model leaves nothing for the resolver to choose from');
  assert.match(said.err, /--model claude-next-9: no tuple of the merged catalog rates it/);
  assert.match(said.err, /strategy "balanced" routes nothing/);
  assert.match(said.err, /the lift runs on claude \(the default harness/);
  assert.equal(probes.probes, 0, 'an unrouted lift pays no preflight');
});

test('a routed spawn with an unrated --model lifts that id as typed, without a decision', async () => {
  dropOverlays();
  seedCache(HEALTHY());
  const task = freshTask('unrated-t20260928-090001');
  const before = treeOf(HOME);
  const probes = counter();
  const said = await captureSplit(() => spawnRaw(WS, routedOpts({
    task, worker: 'unrated', dryRun: true, model: 'claude-next-9', refresh: true, adapterFor: probeSet(probes),
  })));
  assert.equal(/routing decision:/.test(said.out), false, 'nothing is routed');
  assert.match(said.out, /model: claude-next-9/, 'the typed id reaches the lift unchanged');
  assert.match(said.err, /--model claude-next-9: no tuple of the merged catalog rates it/);
  assert.equal(probes.probes, 0);
  assert.deepEqual(treeOf(HOME), before, 'a dry run still writes nothing');
});

test('an unrated --model is still held to the allow and deny lists in force', async () => {
  dropOverlays();
  seedCache(HEALTHY());
  const task = freshTask('unrated-t20260928-090002');
  const before = treeOf(HOME);
  const cases = [
    [{ allow: { models: ['claude-opus-5'] } }, {}, /not named by allow\.models of overlay "user"/],
    [{ deny: { harnesses: ['claude'] } }, {}, /denied by deny\.harnesses of overlay "user"/],
    [{ allow: { tuples: ['claude-opus-high'] } }, {}, /not named by allow\.tuples/],
    [{ deny: { byRole: { worker: { harnesses: ['codex'] } } } }, { harness: 'codex' }, /rates it on codex, .*denied by deny\.byRole\.worker\.harnesses/],
  ];
  try {
    for (const [overlay, extra, pattern] of cases) {
      writeOverlay(USER_OVERLAY(), { schemaVersion: 2, ...overlay });
      await assert.rejects(() => quiet(() => spawnRaw(WS, routedOpts({
        task, worker: 'unrated-denied', model: 'claude-next-9', ...extra,
      }))), (e) => e.code === 'candidates-empty' && pattern.test(e.message), JSON.stringify(overlay));
    }
  } finally {
    dropOverlays();
  }
  assert.deepEqual(treeOf(HOME), before, 'a refused unrated lift leaves the store as it was');
});

/** A lift context for an unrated `--model` under the overlay given, its output split. */
async function unratedContext(overlay, extra = {}, probes = counter()) {
  dropOverlays();
  if (overlay) writeOverlay(USER_OVERLAY(), { schemaVersion: 2, ...overlay });
  try {
    return await captureSplit(() => routingContext(WS, {
      strategy: 'balanced', role: 'worker', dryRun: true, adapterFor: probeSet(probes), liftUnrated: true, ...extra,
    }));
  } finally {
    dropOverlays();
  }
}

test('an alias is held to the lists under the id it resolves to as well as its own spelling', async () => {
  seedCache(HEALTHY());
  await assert.rejects(() => unratedContext({ deny: { models: ['claude-opus-5-5'] } }, { model: 'opus' }),
    (e) => e.code === 'candidates-empty' && /denied by deny\.models/.test(e.message));
  const admitted = await unratedContext({ allow: { models: ['claude-sonnet-5'] } }, { model: 'sonnet' });
  assert.equal(admitted.value, null, 'an allow list naming the id the alias resolves to admits the alias');
});

test('a named --harness is where the lift runs, and a model rated elsewhere is unrated there', async () => {
  seedCache(HEALTHY());
  const said = await unratedContext(null, { harness: 'codex', model: 'claude-opus-5' });
  assert.equal(said.value, null);
  assert.match(said.err, /rates it on codex, so strategy "balanced" routes nothing — the lift runs on codex with the id/);
  assert.doesNotMatch(said.err, /the default harness/);
});

test('an allow.efforts list refuses a lift that names no --effort, and says which flag admits it', async () => {
  seedCache(HEALTHY());
  await assert.rejects(() => unratedContext({ allow: { efforts: ['high'] } }, { model: 'claude-next-9' }),
    (e) => e.code === 'candidates-empty' && /not named by allow\.efforts/.test(e.message)
      && /An --effort the list names admits it/.test(e.message));
  const named = await unratedContext({ allow: { efforts: ['high'] } }, { model: 'claude-next-9', effort: 'high' });
  assert.equal(named.value, null);
});

test('a flag rule reads the snapshot row of an unrated model, and says when there is none', async () => {
  seedCache({
    ...HEALTHY(),
    cursor: entry('available', null, { models: [{ model: 'cursor-next', flags: ['no-zdr'] }, { model: 'cursor-clean' }] }),
  });
  const deny = { deny: { flags: ['no-zdr'] } };
  await assert.rejects(() => unratedContext(deny, { harness: 'cursor', model: 'cursor-next' }),
    (e) => e.code === 'candidates-empty' && /denied by deny\.flags/.test(e.message));
  const clean = await unratedContext(deny, { harness: 'cursor', model: 'cursor-clean' });
  assert.equal(clean.value, null);
  assert.doesNotMatch(clean.err, /could not be checked/);
  const unlisted = await unratedContext(deny, { harness: 'cursor', model: 'cursor-unlisted' });
  assert.equal(unlisted.value, null);
  assert.match(unlisted.err, /lists no such model on cursor, so its marks are unknown and deny\.flags could not be checked/);
  await assert.rejects(() => unratedContext({ allow: { flags: ['no-zdr'] } }, { harness: 'cursor', model: 'cursor-clean' }),
    (e) => e.code === 'candidates-empty' && /not named by allow\.flags/.test(e.message));
});

test('a flag rule finds the row under the id an alias resolves to', async () => {
  seedCache({
    ...HEALTHY(),
    claude: entry('available', null, { models: [{ model: 'claude-opus-5-5', flags: ['no-zdr'] }] }),
  });
  await assert.rejects(() => unratedContext({ deny: { flags: ['no-zdr'] } }, { model: 'opus' }),
    (e) => e.code === 'candidates-empty' && /denied by deny\.flags/.test(e.message));
});

test('a flag rule asks only the harness the lift runs on, and a dry run asks nothing', async () => {
  seedCache(HEALTHY());
  const deny = { deny: { flags: ['no-zdr'] } };
  const dry = counter();
  await unratedContext(deny, { model: 'claude-next-9', refresh: false }, dry);
  assert.equal(dry.probes, 0, 'a dry run reads the cache and probes nothing');
  const live = counter();
  await unratedContext(deny, { model: 'claude-next-9', refresh: true, dryRun: false }, live);
  assert.equal(live.probes, 1, 'only the lift\'s own harness is probed');
  const none = counter();
  await unratedContext(null, { model: 'claude-next-9', refresh: true, dryRun: false }, none);
  assert.equal(none.probes, 0, 'with no flag rule in force nothing is probed');
});

test('an unrated --model with an undeclared --harness is still harness-unknown', async () => {
  await assert.rejects(() => routingContext(WS, {
    strategy: 'balanced', role: 'worker', harness: 'no-such-harness', model: 'claude-next-9', liftUnrated: true,
  }), (e) => e.code === 'harness-unknown');
});

test('an unknown --strategy is strategy-unknown and says auto is not a value here', async () => {
  await assert.rejects(() => routingContext(WS, { strategy: 'auto', role: 'worker' }),
    (e) => e.code === 'strategy-unknown' && /"auto" is not one of them/.test(e.message));
});

test('an unknown --role is role-unknown', async () => {
  await assert.rejects(() => routingContext(WS, { strategy: 'balanced', role: 'orchestrator' }),
    (e) => e.code === 'role-unknown');
});

// --- no candidate: the store is exactly as it was -----------------------------

test('a strategy with no candidate refuses and leaves the store byte for byte as it was', async () => {
  // Every declared harness is logged out, so every tuple of the merged catalog
  // falls to `harness-unavailable` and nothing reaches scoring.
  seedCache({
    claude: entry('unavailable', 'not_authenticated'),
    cursor: entry('unavailable', 'not_authenticated'),
    codex: entry('unavailable', 'not_authenticated'),
  });
  // `--new-task`, deliberately: with an existing `--task` the plan has no task to
  // create, and a write that moved in FRONT of the routing gate would have
  // nothing to write — the check would pass on the very regression it is for.
  const before = treeOf(HOME);
  const worktrees = path.join(REPO, '.claude', 'worktrees');
  const worktreesBefore = existsSync(worktrees) ? readdirSync(worktrees) : [];

  await assert.rejects(() => quiet(() => spawnRaw(WS, routedOpts({ newTask: true, worker: 'nobody' }))), (e) => {
    assert.equal(e.code, 'candidates-empty');
    // The refusal carries the rendered decision — the same lines `models` prints
    // — so the person sees WHY every candidate fell, not only that one did.
    assert.match(e.message, /strategy: balanced · role: worker/);
    assert.match(e.message, /harness-unavailable/);
    assert.match(e.message, /no task, no worktree and no participant record/);
    return true;
  });

  assert.deepEqual(treeOf(HOME), before, 'the store must be untouched after a refused routed spawn');
  assert.deepEqual(existsSync(worktrees) ? readdirSync(worktrees) : [], worktreesBefore,
    'no worktree directory may be left behind');
});

test('an explicit --harness whose account is spent is constraint-unavailable, not candidates-empty', async () => {
  // The named combination is rated and its harness is down: an explicit value is
  // never replaced by a neighbour, so the two refusals must not read the same.
  seedCache({
    claude: entry('exhausted', 'manual_exhaustion'),
    cursor: entry('available', null, { windows: [{ id: '5h', kind: 'session', usedPercent: 10, lengthSec: 18000, resetAt: null, scope: null }] }),
    codex: entry('unavailable', 'not_authenticated'),
  });
  const before = treeOf(HOME);
  await assert.rejects(() => quiet(() => spawnRaw(WS, routedOpts({ newTask: true, worker: 'spent', harness: 'claude' }))),
    (e) => e.code === 'constraint-unavailable' && /never replaced by a neighbour/.test(e.message));
  assert.deepEqual(treeOf(HOME), before);
});

// --- dry runs write nothing ---------------------------------------------------

test('a tuple another harness denied by overlay does not turn constraint-unavailable back into candidates-empty', async () => {
  // Which candidates the explicit values selected is read off the values. Read
  // off the exclusion codes instead, and a tuple an overlay denied first — its
  // reason is `denied-by-policy`, never `constraint-mismatch` — joined the set
  // and broke the "every one of them is down" test.
  seedCache({
    claude: entry('exhausted', 'manual_exhaustion'),
    cursor: entry('available', null, { windows: [{ id: '5h', kind: 'session', usedPercent: 10, lengthSec: 18000, resetAt: null, scope: null }] }),
    codex: entry('unavailable', 'not_authenticated'),
  });
  const overlay = path.join(HOST.promptobusHome(), 'model-routing.json');
  mkdirSync(path.dirname(overlay), { recursive: true });
  writeFileSync(overlay, `${JSON.stringify({ schemaVersion: 1, deny: { tuples: ['cursor-composer-2.5'] } }, null, 2)}\n`);
  try {
    await assert.rejects(
      () => quiet(() => spawnRaw(WS, routedOpts({ newTask: true, worker: 'denied', harness: 'claude' }))),
      (e) => e.code === 'constraint-unavailable',
    );
  } finally {
    rmSync(overlay, { force: true });
  }
});

test('a routed --dry-run prints the decision and writes neither cache nor task state', async () => {
  seedCache(HEALTHY());
  const task = freshTask('dry-t20260905-090003');
  const before = treeOf(HOME);
  const cache = cacheBytes();
  const probes = counter();

  const said = await captureSplit(() => spawnRaw(WS, routedOpts({
    task,
    worker: 'dry',
    dryRun: true,
    adapterFor: probeSet(probes),
  })));

  assert.match(said.out, /routing decision:/);
  assert.match(said.out, /strategy: balanced · role: worker/);
  assert.match(said.out, /dry-run: nothing written to disk/);
  assert.equal(probes.probes, 0, 'a dry run without --refresh asks no harness anything');
  assert.deepEqual(treeOf(HOME), before, 'a dry run must write no task state');
  assert.equal(cacheBytes(), cache, 'a dry run must not touch the availability cache');
});

test('--refresh --dry-run probes and still writes nothing', async () => {
  seedCache(HEALTHY());
  const task = freshTask('refresh-t20260905-090004');
  const before = treeOf(HOME);
  const cache = cacheBytes();
  const probes = counter();

  await captureSplit(() => spawnRaw(WS, routedOpts({
    task,
    worker: 'refreshed',
    dryRun: true,
    refresh: true,
    adapterFor: probeSet(probes),
  })));

  // Both halves, and each is what the other cannot say: a run that skipped the
  // probe would also write nothing, and a run that wrote would also have probed.
  assert.equal(probes.probes, 3, 'every declared harness is asked under --refresh');
  assert.deepEqual(treeOf(HOME), before, '--refresh --dry-run must write no task state');
  assert.equal(cacheBytes(), cache, '--refresh --dry-run must not write a cache entry');
});

// --- the snapshot the decision is aged from -----------------------------------

test('a routed lift served entirely from the cache leaves the cache file byte for byte as it was', async () => {
  // The preflight merges what it probed into the stored document and re-stamps
  // it. Called with nothing probed it rewrote the same entries under a fresh
  // stamp, and the next cache-only run then reported the age of THAT run instead
  // of the age of the facts — the failure the whole ageing rule exists against.
  // This is a real lift, not a dry run: `dryRun` already blocks every write, so
  // a dry run cannot see this at all.
  seedCache(HEALTHY());
  const task = freshTask('nowrite-t20260905-090007');
  const before = readFileSync(CACHE, 'utf8');
  const stamp = statSync(CACHE).mtimeMs;
  const plan = await planSpawn(WS, routedOpts({ task, worker: 'nowrite' }));
  claudeSays([{ id: 'sess-nowrite', name: plan.name, state: 'working', pid: 4242 }]);
  await captureSplit(() => spawnRaw(WS, routedOpts({ task, worker: 'nowrite' })));

  assert.equal(readFileSync(CACHE, 'utf8'), before, 'a run that probed nothing must not rewrite the cache');
  assert.equal(statSync(CACHE).mtimeMs, stamp, 'the cache file was not touched at all');
});

test('the decision is aged from the oldest entry, not from the freshest one', async () => {
  // A mixed snapshot is the case the document stamp cannot describe: one harness
  // answered a moment ago and two are hours old, and a snapshot is only as fresh
  // as the stalest thing inside it.
  const old = new Date(Date.now() - 3600_000).toISOString();
  seedCache({
    claude: { ...entry('available', null, {
      models: [{ model: 'claude-opus-5', rated: true }, { model: 'claude-sonnet-5', rated: true }],
    }), checkedAt: old },
    cursor: entry('unavailable', 'not_authenticated'),
    codex: entry('unavailable', 'not_authenticated'),
  });
  const out = sink();
  await models(WS, { strategy: 'balanced', role: 'worker', json: true, output: out });
  const decision = JSON.parse(out.text);
  assert.equal(decision.snapshot.takenAt, old, 'the stamp is the oldest entry own checkedAt');
  assert.ok(decision.snapshot.ageSec >= 3600, `expected an hour of age, got ${decision.snapshot.ageSec}`);
});

test('a cold cache says "never checked" in words, and the document still carries the epoch', async () => {
  // The decision is aged from the oldest entry, and a cache that never held a
  // harness gives that entry the epoch — so the whole line is ageless. As a
  // number it reads "1788614269 s old", which is true and useless. The text
  // says it in words; the document is not touched, because a machine reader
  // wants the literal stamp and the literal age.
  rmSync(CACHE, { force: true });
  try {
    const text = sink();
    await models(WS, { strategy: 'balanced', role: 'worker', adapterFor: probeSet(counter()), output: text });
    assert.match(text.text, /^snapshot: never checked · source cache$/m);
    assert.equal(/ s old/.test(text.text), false, 'a never-checked snapshot has no age to print');

    const json = sink();
    await models(WS, { strategy: 'balanced', role: 'worker', json: true, adapterFor: probeSet(counter()), output: json });
    const decision = JSON.parse(json.text);
    assert.equal(decision.snapshot.takenAt, '1970-01-01T00:00:00.000Z');
    assert.ok(decision.snapshot.ageSec > 0, 'the document keeps the literal age it computed');
  } finally {
    seedCache(HEALTHY());
  }
});

// --- the legacy path: no flag, no routing -------------------------------------

test('a routed owner uses its declared step beside the edits-tree catalog role', async () => {
  dropOverlays();
  seedCache(HEALTHY());
  const task = freshTask('declared-owner-t20260905-090004');
  const namedHost = { ...HOST, pipeline: () => [
    { name: 'builder', kind: 'edits-tree' },
    { name: 'approver', kind: 'writes-main-tree' },
  ] };
  const plan = await planSpawn(namedHost, routedOpts({ task, worker: 'named-owner' }));
  assert.equal(plan.address, 'builder:named-owner');
  assert.equal(plan.routing.step, 'builder');
  assert.equal(plan.routing.role, 'worker');
});

test('without --strategy the plan carries no decision and the record gets no routing field', async () => {
  seedCache(HEALTHY());
  const task = freshTask('legacy-t20260905-090005');
  claudeSays([{ id: 'sess-legacy', name: 'x', state: 'working', pid: 4242 }]);

  const plan = await planSpawn(WS, { repo: 'orders-api', brief: BRIEF, task, worker: 'legacy' });
  assert.equal(plan.routing, null);
  assert.equal(plan.decision, null);
  assert.equal(plan.routingSkipped, null);
  // The values are the driver's own, exactly as they were before routing existed.
  assert.equal(plan.model, plan.driver.options.defaultModel);
  assert.equal(plan.effort, null);
});

// --- a routed lift: the decision reaches the record and comes back out of status

test('a routed spawn keeps its decision on the participant, and status prints it', async () => {
  seedCache(HEALTHY());
  const task = freshTask('routed-t20260905-090006');
  const plan = await planSpawn(WS, routedOpts({ task, worker: 'routed' }));
  claudeSays([{ id: 'sess-routed', name: plan.name, state: 'working', pid: 4242 }]);
  await captureSplit(() => spawnRaw(WS, routedOpts({ task, worker: 'routed' })));

  const record = store.readTask(HOME, task).participants.find((p) => p.metadata.address === 'worker:routed');
  const routing = record.metadata.routing;
  assert.ok(routing, 'a routed lift must leave its decision on the participant');
  assert.equal(routing.strategy, 'balanced');
  assert.equal(routing.role, 'worker');
  assert.equal(routing.harness, record.harness, 'the record harness and the routed one are one fact');
  assert.equal(routing.model, record.metadata.model);
  assert.equal(typeof routing.score, 'number');
  assert.equal(typeof routing.snapshot.ageSec, 'number');
  assert.ok(Array.isArray(routing.warnings));
  assert.equal(routing.constraints.applied, false, 'nothing was constrained, so nothing was applied');

  // The round trip: what `status` prints comes out of the record through the
  // accessor, and it names the four things the ADR asks for.
  const said = await captureSplit(() => status(WS, { task, sessions: {} }));
  assert.match(said.out, new RegExp(`routing: balanced · ${routing.tupleId}`));
  assert.match(said.out, /snapshot \d+ s old/);
  assert.ok(said.out.includes(routingLine(routing)), 'the status line is the shared renderer, not a second copy');
});

test('status prints review rounds, questions and results before done', async () => {
  const task = freshTask('status-rounds-t20260910-010000');
  store.upsertParticipant(HOME, task, store.participantRecord('worker:status-rounds'));
  store.sendMessage(HOME, task, {
    from: 'orchestrator', to: 'worker:status-rounds', type: 'review', body: 'first review',
  });
  store.sendMessage(HOME, task, {
    from: 'orchestrator', to: 'worker:status-rounds', type: 'review', body: 'second review',
  });

  const said = await captureSplit(() => status(WS, { task, sessions: {} }));
  assert.match(said.out, /worker:status-rounds.*rounds 2/);
  assert.match(said.out, /questions 0 · results 0/);
});

test('status omits the traffic fragment when a participant has no messages', async () => {
  const task = freshTask('status-empty-t20260910-010001');
  store.upsertParticipant(HOME, task, store.participantRecord('worker:status-empty'));

  const said = await captureSplit(() => status(WS, { task, sessions: {} }));
  const line = said.out.split('\n').find((entry) => entry.includes('worker:status-empty'));
  assert.ok(line, 'the participant line is present');
  assert.doesNotMatch(line, /rounds \d+|questions \d+|results \d+/);
});

// --- the reviewer side --------------------------------------------------------

test('a routed review dry run prints the decision, writes nothing, and measures against the worker', async () => {
  seedCache(HEALTHY());
  // A reviewer needs something to look at, and the pick needs somebody to be
  // measured against: the worker lifted above is the live participant, and the
  // reviewer's diversity bonus and per-harness penalty are about it.
  writeFileSync(path.join(REPO, 'a.txt'), 'v2\n');
  const before = treeOf(HOME);
  const cache = cacheBytes();
  const probes = counter();

  const said = await captureSplit(() => review(WS, {
    target: REPO,
    task: 'routed-t20260905-090006',
    strategy: 'balanced',
    dryRun: true,
    adapterFor: probeSet(probes),
    tool: { ok: true, bin: path.join(BIN, process.platform === 'win32' ? 'claude.cmd' : 'claude') },
  }));

  assert.match(said.out, /routing: balanced · /);
  assert.match(said.out, /routing decision:/);
  assert.match(said.out, /strategy: balanced · role: reviewer/);
  assert.match(said.out, /dry-run: nothing written to disk/);
  assert.equal(probes.probes, 0, 'a dry run without --refresh asks no harness anything');
  assert.deepEqual(treeOf(HOME), before, 'a review dry run must write no task state');
  assert.equal(cacheBytes(), cache, 'a review dry run must not touch the availability cache');
});

test('a routed review with an unrated --model lifts that id without a decision', async () => {
  seedCache(HEALTHY());
  const before = treeOf(HOME);
  const said = await captureSplit(() => review(WS, {
    target: REPO,
    task: 'routed-t20260905-090006',
    strategy: 'balanced',
    model: 'claude-next-9',
    dryRun: true,
    adapterFor: probeSet(counter()),
    tool: { ok: true, bin: path.join(BIN, process.platform === 'win32' ? 'claude.cmd' : 'claude') },
  }));
  assert.equal(/routing decision:/.test(said.out), false);
  assert.match(said.out, /model: claude-next-9/);
  assert.match(said.err, /--model claude-next-9: no tuple of the merged catalog rates it/);
  assert.deepEqual(treeOf(HOME), before);
});

test('a routed review with no path refuses for the path, not after probing three harnesses', async () => {
  // The path gate of `planReview` is the first thing that stands, and routing
  // must not step in front of it: a forgotten argument is not worth a preflight.
  const probes = counter();
  await assert.rejects(() => quiet(() => review(WS, {
    strategy: 'balanced', refresh: true, adapterFor: probeSet(probes),
  })), /repository path is required|path/i);
  assert.equal(probes.probes, 0);
});

test('a routed review lift keeps its decision on the reviewer record', async () => {
  seedCache(HEALTHY());
  writeFileSync(path.join(REPO, 'a.txt'), 'v3\n');
  const opts = {
    target: REPO,
    task: 'routed-t20260905-090006',
    strategy: 'balanced',
    adapterFor: probeSet(counter()),
    tool: { ok: true, bin: path.join(BIN, process.platform === 'win32' ? 'claude.cmd' : 'claude') },
  };
  const plan = planReview(WS, opts);
  claudeSays([{ id: 'sess-reviewer', name: plan.name, state: 'working', pid: 4343 }]);
  await captureSplit(() => review(WS, opts));

  const record = store.readTask(HOME, opts.task).participants
    .find((p) => p.metadata.address === plan.address);
  assert.ok(record, `the reviewer ${plan.address} is not in the journal`);
  assert.equal(record.metadata.routing.role, 'reviewer');
  assert.equal(record.metadata.routing.harness, record.harness);
  assert.equal(record.metadata.routing.model, record.metadata.model);
});

test('a re-review with --strategy --refresh pays no preflight, and still says the flag was ignored', async () => {
  // The reviewer lifted just above is in the journal, so its harness is fixed and
  // there is nothing to route. `--refresh` would probe every declared harness if
  // a context were built at all: the counter staying at zero is what says none
  // was — the lookup that decides it stands in front of the preflight.
  seedCache(HEALTHY());
  writeFileSync(path.join(REPO, 'a.txt'), 'v4\n');
  const probes = counter();
  const said = await captureSplit(() => review(WS, {
    target: REPO,
    task: 'routed-t20260905-090006',
    strategy: 'balanced',
    refresh: true,
    dryRun: true,
    adapterFor: probeSet(probes),
    tool: { ok: true, bin: path.join(BIN, process.platform === 'win32' ? 'claude.cmd' : 'claude') },
  }));
  assert.equal(probes.probes, 0, 'a re-review must not pay a preflight to be told the flag is ignored');
  assert.match(said.err, /--strategy routes a lift/);
  assert.match(said.err, /started by harness /);
});

test('a repeat spawn at a routed address does not re-route, and says why', async () => {
  // ADR-005: once a participant is lifted its harness and model are fixed. The
  // flag has nothing to choose, and silence about that would read as a routed
  // restart.
  seedCache(HEALTHY());
  const task = 'routed-t20260905-090006';
  const plan = await planSpawn(WS, routedOpts({ task, worker: 'routed', sessions: [] }));
  assert.equal(plan.routing, null, 'a repeat lift routes nothing');
  assert.match(plan.routingSkipped, /--strategy routes a lift/);
  assert.match(plan.routingSkipped, /lifted by harness /);
});

// --- a nearly spent window leaves automatic selection -----------------------

const HOURS = 3600_000;
const CODEX_RESET = new Date(Date.now() + 4 * HOURS).toISOString();

/**
 * The morning the owner measured: Codex's session window at `codexUsed` %,
 * Claude well inside its week, Cursor logged out. The models are the ones the
 * catalog rates for a reviewer on each harness, so the reviewer rows reach the
 * window step rather than falling at the inventory one. `codexResetAt: null`
 * leaves the session window with no reset stamp at all.
 */
const nearlySpent = (codexUsed, {
  codexCheckedAt = new Date().toISOString(), codexResetAt = CODEX_RESET, claudeUsed = 30,
  weeklyUsed = 40, weeklyResetAt = new Date(Date.now() + 72 * HOURS).toISOString(),
} = {}) => ({
  claude: entry('available', null, {
    models: [{ model: 'claude-opus-5', rated: true }],
    windows: [{
      id: 'weekly', kind: 'weekly', usedPercent: claudeUsed, lengthSec: 604800,
      resetAt: new Date(Date.now() + 96 * HOURS).toISOString(), scope: null,
    }],
  }),
  cursor: entry('unavailable', 'not_authenticated'),
  codex: entry('available', null, {
    checkedAt: codexCheckedAt,
    models: [{ model: 'gpt-6-astra', rated: true }],
    windows: [
      {
        id: 'primary', kind: 'session', usedPercent: codexUsed, lengthSec: 18000,
        ...(codexResetAt === null ? {} : { resetAt: codexResetAt }), scope: null,
      },
      {
        id: 'secondary', kind: 'weekly', usedPercent: weeklyUsed, lengthSec: 604800,
        resetAt: weeklyResetAt, scope: null,
      },
    ],
  }),
});

/** `models --strategy quality --role reviewer --json` on that cache, as the document it prints. */
async function reviewerDecision(codexUsed, { now = Date.now(), ...fixture } = {}) {
  seedCache(nearlySpent(codexUsed, fixture));
  const out = sink();
  await models(WS, {
    strategy: 'quality', role: 'reviewer', json: true, adapterFor: probeSet(counter()), output: out, now,
  });
  return JSON.parse(out.text);
}

/** The same cache through the routed-lift path, which is where `--harness` and `--model` arrive. */
async function constrainedDecision(codexUsed, constraint = {}) {
  seedCache(nearlySpent(codexUsed));
  const ctx = await routingContext(WS, {
    strategy: 'quality', role: 'reviewer', dryRun: true, adapterFor: probeSet(counter()), ...constraint,
  });
  return { decision: ctx.decide(), snapshot: ctx.snapshot };
}

const codexRows = (decision) => decision.candidates.filter((c) => c.harness === 'codex');

test('at 96 % used every codex tuple that would have been scored leaves selection, and a claude tuple is picked', async () => {
  const room = await reviewerDecision(89);
  const scoredAt89 = codexRows(room).filter((c) => c.score).map((c) => c.tupleId);
  assert.ok(scoredAt89.length > 0, 'at 89 % some codex reviewer tuple must reach scoring, or this check proves nothing');

  const decision = await reviewerDecision(96);
  assert.equal(decision.chosen?.harness, 'claude', JSON.stringify(decision.chosen));
  assert.deepEqual(codexRows(decision).filter((c) => c.score).map((c) => c.tupleId), [],
    'no codex tuple may be scored past the threshold');
  for (const id of scoredAt89) {
    const row = decision.candidates.find((c) => c.tupleId === id);
    assert.equal(row.excluded?.code, 'window-nearly-spent', `${id}: ${JSON.stringify(row.excluded)}`);
    assert.match(row.excluded.detail, /codex session window "primary" is 96 % used/);
    assert.ok(row.excluded.detail.includes(`resets at ${CODEX_RESET}`), row.excluded.detail);
  }
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const name of readdirSync(SCHEMAS).filter((n) => n.endsWith('.schema.json'))) {
    ajv.addSchema(JSON.parse(readFileSync(path.join(SCHEMAS, name), 'utf8')));
  }
  const valid = ajv.getSchema('urn:promptobus:model-routing:decision');
  assert.equal(valid(decision), true, ajv.errorsText(valid.errors));
});

test('at 89 % used the codex tuples are scored and near-limit says so, with nothing excluded for it', async () => {
  const decision = await reviewerDecision(89);
  assert.equal(decision.candidates.some((c) => c.excluded?.code === 'window-nearly-spent'), false);
  const near = decision.warnings.filter((w) => w.code === 'near-limit' && w.harness === 'codex');
  assert.equal(near.length, 1, decision.warnings.map((w) => w.code).join(' | '));
  assert.equal(near[0].usedPercent, 89);
});

test('--harness codex spends the nearly spent window with a warning, and --model of a claude tuple is unaffected', async () => {
  const { decision: named } = await constrainedDecision(96, { harness: 'codex' });
  assert.equal(named.chosen?.harness, 'codex', JSON.stringify(named.chosen));
  const waived = named.warnings.find((w) => w.code === 'window-nearly-spent-named');
  assert.ok(waived, named.warnings.map((w) => w.code).join(' | '));
  assert.match(waived.message, /only because --harness codex named it/);

  const room = (await constrainedDecision(89, { model: 'claude-opus-5' })).decision;
  const spent = (await constrainedDecision(96, { model: 'claude-opus-5' })).decision;
  assert.equal(spent.chosen?.tupleId, room.chosen?.tupleId);
  assert.equal(spent.chosen?.model, 'claude-opus-5');
  assert.equal(spent.warnings.some((w) => w.code === 'window-nearly-spent-named'), false);
  for (const row of codexRows(spent)) assert.equal(row.excluded?.code, 'constraint-mismatch', row.tupleId);
});

test('windows the cache let expire read as expired, not as no limit source, and still cost the penalty', async () => {
  const t0 = Date.now();
  seedCache(nearlySpent(40, { codexCheckedAt: new Date(t0 - 150_000).toISOString() }));
  const out = sink();
  await models(WS, {
    strategy: 'quality', role: 'reviewer', json: true, adapterFor: probeSet(counter()), output: out, now: t0,
  });
  const decision = JSON.parse(out.text);
  const unknown = decision.warnings.filter((w) => w.code === 'unknown-remaining');
  assert.deepEqual(unknown.map((w) => w.message.split(' ')[0]), ['codex'], JSON.stringify(unknown));
  assert.match(unknown[0].message, /^codex window entries expired 90 s ago; refresh with --refresh — /);
  assert.equal(/exposes no limit source/.test(unknown[0].message), false);
  for (const row of codexRows(decision).filter((c) => c.score)) {
    assert.deepEqual(row.score.adjustments.find((a) => a.code === 'unknown-availability'),
      { code: 'unknown-availability', points: -10 }, row.tupleId);
  }
  assert.ok(codexRows(decision).some((c) => c.score), 'a codex tuple must be scored for the penalty to be read');
});

test('the lift line names the nearly spent window once, by harness and percentage', async () => {
  const { decision, snapshot } = await constrainedDecision(96, { harness: 'codex' });
  const line = routingLine(routingMetadata(decision, snapshot));
  assert.equal(line.split('near-limit codex 96 %').length - 1, 1, line);
  assert.equal(/near-limit(,|$)/.test(line), false, `a bare near-limit code is left on the line: ${line}`);
});

test('an unconstrained lift at 96 % names codex as having left selection, once', async () => {
  // The exclusion is not a warning, and codex has no scored row to raise near-limit on:
  // without this label the line read `no warnings` over an account with 4 % left.
  const { decision, snapshot } = await constrainedDecision(96);
  assert.equal(decision.chosen?.harness, 'claude');
  const line = routingLine(routingMetadata(decision, snapshot));
  assert.equal(line.split('window-nearly-spent codex 96 %').length - 1, 1, line);
  assert.equal(/window-nearly-spent claude/.test(line), false, line);
});

test('a reset that has passed is an expired figure and excludes nothing; a window with no reset still excludes', async () => {
  const t0 = Date.now();
  const reset = await reviewerDecision(96, { now: t0, codexResetAt: new Date(t0 - 12_000).toISOString() });
  const scored = codexRows(reset).filter((c) => c.score);
  assert.ok(scored.length > 0, JSON.stringify(codexRows(reset).map((c) => [c.tupleId, c.excluded?.code])));
  assert.equal(codexRows(reset).some((c) => c.excluded?.code === 'window-nearly-spent'), false);
  for (const row of scored) {
    assert.equal(row.score.components.remaining, Math.round(4 * reset.weights.remaining) / 100,
      `${row.tupleId}: penalised through remaining, not excluded`);
  }

  const stampless = await reviewerDecision(96, { now: t0, codexResetAt: null });
  assert.equal(codexRows(stampless).some((c) => c.score), false);
  const row = codexRows(stampless).find((c) => c.excluded?.code === 'window-nearly-spent');
  assert.ok(row, JSON.stringify(codexRows(stampless).map((c) => [c.tupleId, c.excluded?.code])));
  assert.match(row.excluded.detail, /\(reset time unknown\)/);
});

test('every account past the threshold refuses the lift, and the refusal names the waiver', async () => {
  // A soft fallback would spend what the owner said not to spend; naming a tuple is the way through.
  seedCache(nearlySpent(96, { claudeUsed: 95 }));
  const before = treeOf(HOME);
  await assert.rejects(() => quiet(() => spawnRaw(WS, routedOpts({ newTask: true, worker: 'spent-all' }))), (e) => {
    assert.equal(e.code, 'candidates-empty');
    assert.match(e.message, /window-nearly-spent: codex session window "primary" is 96 % used/);
    assert.match(e.message, /--harness codex or --model gpt-6-astra spends it anyway/);
    assert.match(e.message, /--harness claude or --model claude-opus-5 spends it anyway/);
    return true;
  });
  assert.deepEqual(treeOf(HOME), before, 'a refused lift writes nothing');
});

test('a session reset does not hide a weekly window past the threshold, and an all-expired account excludes nothing', async () => {
  // The owner's Codex shape ten seconds after a session reset: the session figure has expired,
  // the weekly one has not, and it is the weekly one that must decide.
  const t0 = Date.now();
  const weekly = await reviewerDecision(96, {
    now: t0, codexResetAt: new Date(t0 - 10_000).toISOString(), weeklyUsed: 92,
  });
  assert.equal(codexRows(weekly).some((c) => c.score), false,
    JSON.stringify(codexRows(weekly).map((c) => [c.tupleId, c.excluded?.code])));
  const row = codexRows(weekly).find((c) => c.excluded?.code === 'window-nearly-spent');
  assert.ok(row);
  assert.match(row.excluded.detail, /^codex weekly window "secondary" is 92 % used/);
  assert.equal(row.excluded.usedPercent, 92);
  const line = routingLine(routingMetadata(weekly));
  assert.equal(line.split('window-nearly-spent codex 92 %').length - 1, 1, line);

  const expired = await reviewerDecision(96, {
    now: t0,
    codexResetAt: new Date(t0 - 10_000).toISOString(),
    weeklyUsed: 92,
    weeklyResetAt: new Date(t0 - 5_000).toISOString(),
  });
  assert.equal(codexRows(expired).some((c) => c.excluded?.code === 'window-nearly-spent'), false);
  assert.ok(codexRows(expired).some((c) => c.score), 'every figure expired: the tuple is scored, not excluded');
});
