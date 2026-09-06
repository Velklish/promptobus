// Cursor availability adapter: what it answers about the account, and what it
// refuses to say. Run: npm test
//
// **No real `cursor-agent` is started here.** The subject is the parse and the
// classification, and the states that matter — nobody logged in, a binary that
// never answers, a listing that came back wrong — are states a live account is not
// asked to be in for a test run. The substitution sits on the BINARY boundary
// (`stubCommand`, the same seam the driver suite uses), not on the adapter: a
// substituted adapter would stop checking the thing this file exists for.
//
// The stub prints what was measured on `cursor-agent` 2026.09.02-c22c1a3 on
// 2026-09-05, ANSI colour included — `status` answers `✓ Logged in as <account>`
// and `models` answers a header, `<id> - <Display Name>` rows and a trailing
// `Tip:` line. `STUB_ACCOUNT` is the account address the real binary prints on
// that line: it is handed over on purpose so that the checks can prove it reaches
// neither the verdict nor the cache file.
// Home diversion before any import that is not a Node built-in: a module that
// resolved a home path at load would see the real one. [home.mjs](home.mjs) says
// what it applies; the sentinel in tmpdir-sweep.test.mjs keeps the order.
import './home.mjs';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import {
  authState, autoPoolModels, backendUrlOf, connectHeaders, cursorAvailability, derivedTier,
  nudgeNote, parseModels, periodWindows, sanitizeMessage,
} from '../lib/model-routing/adapter-cursor.js';
import { CURSOR, CURSOR_TOOL, cursorDriver } from '../lib/driver-cursor.js';
import { adapterOf } from '../lib/drivers.js';
import { preflight } from '../lib/model-routing/preflight.js';
import { stubCommand } from './sandbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const SNAPSHOT_SCHEMA = path.join(ROOT, 'schemas', 'model-routing', 'snapshot.schema.json');

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validSnapshot = ajv.compile(JSON.parse(readFileSync(SNAPSHOT_SCHEMA, 'utf8')));

/** The account line the real `status` prints. Handed to the stub, expected nowhere else. */
const STUB_ACCOUNT = 'probe-account@example.invalid';

/** The version the host reports from its own resolve; the adapter must carry it, not re-ask. */
const STUB_VERSION = '2026.09.02-c22c1a3';

/**
 * The inventory the stub prints, as ONE list.
 *
 * It used to be five lines inside the stub body with the ids repeated in the
 * checks beside it, and two of the five had drifted — so the pool checks were
 * covering an inventory no stand-in ever printed. The stub interpolates this at
 * build time and `STUB_IDS` is read off the same array, so there is nothing left
 * to drift against.
 */
const STUB_MODELS = [
  ['auto', 'Auto (default)'],
  ['gpt-5.3-codex-low', 'Codex 5.3 Low'],
  ['claude-opus-5-thinking-max', 'Claude Opus 5 Max Thinking'],
  ['cursor-grok-4.6-xhigh-fast', 'Grok 4.6 Extra High Fast'],
  ['claude-fable-5-thinking-high', 'Claude Fable 5 1M Thinking (NO ZDR)'],
];

/** The ids of that list, which is what the adapter reports and what the pool checks read. */
const STUB_IDS = STUB_MODELS.map(([id]) => id);

// The stub binary. One file, steered by `STUB_CURSOR_MODE`, because the modes
// differ only in which of the two subcommands misbehaves.
const STUB_BODY = `
import process from 'node:process';

const args = process.argv.slice(2);
const mode = process.env.STUB_CURSOR_MODE ?? 'ok';
const account = process.env.STUB_CURSOR_ACCOUNT ?? '';
// Both subcommands colour their output even when stdout is not a terminal.
const cyan = (s) => \`\\u001b[36m\${s}\\u001b[39m\`;
const dim = (s) => \`\\u001b[2m\${s}\\u001b[22m\`;

// Never answers. The adapter's own deadline is what ends this, and the check
// around it is that a slow binary is a timeout and not an unavailable account.
const hang = () => { setTimeout(() => {}, 60_000); };

const loggedInLine = () => process.stdout.write(\`\\u001b[32m✓\\u001b[39m Logged in as \${account}\\n\`);

if (args[0] === 'status') {
  if (mode === 'slow-status') hang();
  // Answers a second late and leaves the rest of the budget to \`models\`, which
  // then never answers: the two readings of \`timeoutMs\` end a whole second apart.
  else if (mode === 'late-status') setTimeout(loggedInLine, 1500);
  else if (mode === 'logged-out') process.stdout.write('Not logged in. Run cursor-agent login to sign in.\\n');
  // Exit 1 on a line that says neither thing, and exit 1 on a line that plainly
  // says the account is in: what the adapter must read, and what it must ignore.
  else if (mode === 'status-garbled') { process.stdout.write('Something went sideways.\\n'); process.exitCode = 1; }
  else if (mode === 'status-nonzero') { loggedInLine(); process.exitCode = 1; }
  else loggedInLine();
} else if (args[0] === 'models') {
  if (mode === 'slow-models' || mode === 'late-status') hang();
  else if (mode === 'models-refuse') process.exitCode = 1;
  else if (mode === 'models-garbled') process.stdout.write(\`\${dim('Available models')}\\n\`);
  else {
    process.stdout.write([
      dim('Available models'),
      '',
      ...${JSON.stringify(STUB_MODELS)}.map(([id, name]) => \`\${cyan(id)} \${dim('- ' + name)}\`),
      '',
      dim("Tip: use --model <id> (or /model <id> in interactive mode) to switch. Parameterized models "
        + "also accept quoted overrides, e.g. --model 'claude-opus-4-8[context=1m,effort=high,fast=false]'."),
      '',
    ].join('\\n'));
  }
} else {
  process.exitCode = 2;
}
`;

/**
 * A machine with a Cursor binary on it. The host answers exactly what the adapter
 * asks for — `resolveToolBin` and nothing else — so a module reaching for anything
 * more would be visible here rather than hidden behind a full stand-in host.
 */
function machine({
  mode = 'ok', version = STUB_VERSION, bin = true, executable = true,
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'promptobus-adapter-cursor-'));
  const binDir = path.join(dir, 'bin');
  if (bin) {
    stubCommand(binDir, CURSOR_TOOL, STUB_BODY);
    // A file that is there and will not run. Not a missing binary and not a slow
    // one — the third way a launch fails, and the one with no reason code of its own.
    if (!executable) chmodSync(path.join(binDir, CURSOR_TOOL), 0o644);
    process.env.STUB_CURSOR_MODE = mode;
    process.env.STUB_CURSOR_ACCOUNT = STUB_ACCOUNT;
  }
  return {
    kind: 'promptobus-host',
    dir,
    routingPaths() {
      return { cacheFile: path.join(dir, 'model-routing', 'cache.json'), overlays: [] };
    },
    resolveToolBin(name) {
      if (!bin || name !== CURSOR_TOOL) return { ok: false, reason: 'not found' };
      return { ok: true, bin: path.join(binDir, name), ...(version ? { version } : {}) };
    },
  };
}

/**
 * A machine whose `cursor-agent` is a plain shell script rather than the usual node
 * stub. Exactly one check needs it, and it needs it because of how the node stub is
 * launched: `stubCommand` writes `exec node …`, so the stub REPLACES the shell and
 * leaves no wrapper behind — the case that does NOT put a grandchild on the inherited
 * pipe. A script whose `sleep` is forked does, which is the shape the live probe hit.
 * POSIX only, like every stub here.
 */
function shellMachine(body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'promptobus-adapter-cursor-'));
  const bin = path.join(dir, CURSOR_TOOL);
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return {
    routingPaths: () => ({ cacheFile: path.join(dir, 'model-routing', 'cache.json'), overlays: [] }),
    resolveToolBin: () => ({ ok: true, bin, version: STUB_VERSION }),
  };
}

/** The stub is steered by the environment; every check sets it, and none may inherit a neighbour's. */
afterEach(() => {
  delete process.env.STUB_CURSOR_MODE;
  delete process.env.STUB_CURSOR_ACCOUNT;
});

/**
 * Call the adapter the way the preflight does: the binary is resolved ONCE, before
 * the probe, and travels in the request ([preflight.js](../lib/model-routing/preflight.js)).
 * The host is still handed over, so a module reaching for it stays visible here.
 */
const NO_ACCOUNT = {
  readToken: async () => null,
  readBackendUrl: async () => 'https://backend.invalid',
  postJson: async () => { throw new Error('the suite never calls the Cursor dashboard'); },
};

/**
 * The adapter under test, with the account half stubbed.
 *
 * The binary substitution stays where it was — on the BINARY boundary, which is
 * what this file exists to check. What is handed in here is the OTHER half: the
 * keychain read and the dashboard POSTs, which have no binary to stub. The
 * default answers nothing and refuses to be called, so a check that forgets to
 * ask for the account half gets `quota_unknown` and an explanation, never a
 * keychain dialog on the machine running `npm test` and never a request to
 * api2.cursor.sh. The driver's live wiring is pinned separately, as source.
 */
const stubAdapter = (deps = {}) => cursorAvailability(CURSOR_TOOL, { ...NO_ACCOUNT, ...deps });

const ask = (host, timeoutMs = 10_000, deps = {}) => {
  const adapter = stubAdapter(deps);
  return adapter.probe({ host, toolBin: host.resolveToolBin(adapter.tool), timeoutMs, refresh: false });
};

// --- the driver declares it --------------------------------------------------

test('the Cursor driver declares the adapter, and the registry hands back that one', async () => {
  // Without this the adapter could be perfect and never run: `adapterOf` answers
  // `unknown` / `probe_failed` for a driver that declares none, and that answer
  // is indistinguishable from a probe that failed.
  assert.equal(typeof cursorDriver.availability?.probe, 'function');
  assert.equal(adapterOf(CURSOR), cursorDriver.availability);
});

// --- the inventory -----------------------------------------------------------

test('a logged-in account whose limit could not be read is quota_unknown with its inventory', async () => {
  // The binary half succeeded and the account half was not answered — here
  // because no token could be read, which is the shape a refused keychain has.
  // `available` would claim the limit was confirmed, and `quota_unknown` is the
  // code written for auth-is-fine-limit-is-not. Since ADR-004 this is a BRANCH
  // rather than the only outcome: the check below it is the one where the
  // dashboard answered.
  const verdict = await ask(machine());
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.reason, 'quota_unknown');
  assert.equal(verdict.source, 'probe');
  assert.equal(verdict.resetAt, null);
  assert.equal(verdict.version, STUB_VERSION);
  // No windows at all, not an empty list: a limit that could not be read reports
  // none, and an empty array would age the entry at the 60 s window TTL for a
  // fact it never measured.
  assert.equal(verdict.windows, undefined);
  // `rated` belongs to the catalog, and an adapter does not know the catalog.
  for (const m of verdict.models) assert.equal('rated' in m, false, m.model);
});

test('the model id is taken whole, effort suffix included', async () => {
  // In Cursor the effort level is a flat suffix of the id, not a flag. A stripped
  // suffix would name a model the binary does not have, and the tuple would be
  // excluded as `model-not-in-inventory` for a reason nobody could find.
  const verdict = await ask(machine());
  assert.deepEqual(verdict.models.map((m) => m.model), [
    'auto',
    'gpt-5.3-codex-low',
    'claude-opus-5-thinking-max',
    'cursor-grok-4.6-xhigh-fast',
    'claude-fable-5-thinking-high',
  ]);
});

test('a NO ZDR mark travels as a flag on that row and on no other', async () => {
  // The package judges nothing about it: a consumer that must not use such a
  // model denies it in an overlay, and it can only do that if the mark arrived.
  const verdict = await ask(machine());
  const flagged = verdict.models.filter((m) => m.flags?.includes('no-zdr'));
  assert.deepEqual(flagged.map((m) => m.model), ['claude-fable-5-thinking-high']);
  for (const m of verdict.models) {
    if (m.model !== 'claude-fable-5-thinking-high') assert.equal(m.flags, undefined, m.model);
  }
});

test('the listing header and its trailing tip are not models', () => {
  // Both lines sit in every real listing, and neither is a model. A looser row
  // pattern — any line with two fields in it — reads the header as a model
  // called `Available`, and the tip as one called `Tip:`.
  const models = parseModels([
    '\u001b[2mAvailable models\u001b[22m',
    '',
    '\u001b[36mauto\u001b[39m \u001b[2m- Auto\u001b[22m',
    "Tip: use --model <id> (or /model <id> in interactive mode) to switch. Parameterized models also "
      + "accept quoted overrides, e.g. --model 'claude-opus-4-8[context=1m,effort=high,fast=false]'.",
  ].join('\n'));
  assert.deepEqual(models, [{ model: 'auto' }]);
});

// --- auth --------------------------------------------------------------------

test('a logged-out binary is unavailable / not_authenticated', async () => {
  const verdict = await ask(machine({ mode: 'logged-out' }));
  assert.equal(verdict.state, 'unavailable');
  assert.equal(verdict.reason, 'not_authenticated');
});

test('"not logged in" is not read as "logged in", and neither is read as unreadable', () => {
  // The trap under the positive pattern: the logged-out line CONTAINS the
  // logged-in one. A single positive match reads a signed-out binary as
  // authenticated, and the run then blames the model list for the failure.
  assert.equal(authState('\u001b[32m\u2713\u001b[39m Logged in as someone@example.invalid'), 'in');
  assert.equal(authState('Not logged in. Run cursor-agent login to sign in.'), 'out');
  assert.equal(authState('You are not logged in as any account.'), 'out');
  // A third answer, not a second: output that says neither thing is a parse
  // fault, and calling it a logged-out account would blame the person's login.
  assert.equal(authState('Something went sideways.'), 'unreadable');
});

test('the exit code of status is not the auth answer', async () => {
  // `cursor-agent status` exits 0 signed in and signed out alike, so the code
  // carries no auth information — the text does. A line that says the account is
  // in stays in whatever the code; a line that says neither is `probe_failed`,
  // never `not_authenticated`, because sending the person to `cursor-agent login`
  // for a parse fault costs them the real diagnosis.
  const garbled = await ask(machine({ mode: 'status-garbled' }));
  assert.equal(garbled.state, 'unknown');
  assert.equal(garbled.reason, 'probe_failed');

  const nonzero = await ask(machine({ mode: 'status-nonzero' }));
  assert.equal(nonzero.reason, 'quota_unknown');
  assert.equal(nonzero.models.length, 5);
});

test('no binary at all is unavailable / binary_missing', async () => {
  const verdict = await ask(machine({ bin: false }));
  assert.equal(verdict.state, 'unavailable');
  assert.equal(verdict.reason, 'binary_missing');
});

// --- the slow binary ---------------------------------------------------------

test('a binary that is there and will not run is probe_failed, not a missing one and not a timeout', async () => {
  // Three ways a call comes back with no output, and they are three facts about
  // the machine: the binary is gone, it is there and will not start, or it ran
  // and never answered. Only the last is a timeout — telling someone whose binary
  // has no execute bit that it "did not answer within the budget" sends them to
  // look at the wrong thing entirely.
  const verdict = await ask(machine({ executable: false }));
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.reason, 'probe_failed');
});

test('a binary that does not answer is probe_timeout, never unavailable', async () => {
  // The rule this check exists for: slowness is not death. Calling a slow Cursor
  // `unavailable` would drop every Cursor tuple out of the run on a machine where
  // the account is perfectly fine — the same mistake the neighbouring finding
  // PB-7 names about a live session.
  const verdict = await ask(machine({ mode: 'slow-status' }), 300);
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.reason, 'probe_timeout');
});

test('the budget covers both calls, not each of them', async () => {
  // `timeoutMs` is the WHOLE preflight budget: a `status` that answered does not
  // hand `models` a fresh one. A per-call ceiling would let this adapter alone
  // spend twice the budget the person was promised.
  // `status` answers late but inside the budget, and `models` never answers, so
  // the two readings of `timeoutMs` end far apart: sharing the budget, the run
  // stops when the 2000 ms are gone; a budget per call gives `models` a fresh
  // 2000 ms on top of the 1500 ms `status` already spent. The threshold sits
  // between the two with about 750 ms either side, so what reddens it is the
  // second budget and not a machine under a parallel suite.
  const host = machine({ mode: 'late-status' });
  const started = Date.now();
  const verdict = await ask(host, 2000);
  const elapsed = Date.now() - started;
  assert.equal(verdict.reason, 'probe_timeout');
  assert.ok(elapsed < 2750, `the second call was given a budget of its own (${elapsed} ms)`);
});

test('the probe does not block the event loop, so the preflight budget can still fire', async () => {
  // The contract says a probe must not hold the event loop, and the preflight holds
  // ONE budget for every adapter as a timer racing their promises: a `spawnSync`
  // here would stop that timer while this adapter worked, and the ceiling of the run
  // would become the sum of the blocking adapters instead of one budget. What is
  // asserted is not this probe's duration but that OTHER work ran while it was in
  // flight.
  //
  // Mutation probe: put `run()` from lib/exec.js back in place of `runOut`'s spawn
  // and this goes red while every other check in the file stays green.
  // Counted rather than timed: the file runs in the pool, and a threshold in
  // milliseconds would measure the machine's neighbours. A blocked loop fires a
  // 20 ms interval once, however long the block — node coalesces the periods it
  // missed into a single callback — while a probe that yields lets it tick on every
  // turn. Five is a fifth of what an unloaded run counts here.
  const host = machine();
  const started = Date.now();
  let ticks = 0;
  const beat = setInterval(() => { ticks += 1; }, 20);
  const verdict = await ask(host);
  clearInterval(beat);
  const took = Date.now() - started;
  assert.equal(verdict.reason, 'quota_unknown', verdict.message);
  assert.ok(took > 150, `the two stub calls answered in ${took} ms — too fast to prove anything`);
  assert.ok(ticks >= 5, `a 20 ms interval ticked ${ticks} times while a ${took} ms probe ran`);
});

test('the deadline holds when a grandchild keeps the output pipe open, and the pipe is let go', async () => {
  // `close` fires when the last stdio pipe closes, not when the child dies, so a
  // process the harness left behind holding the inherited pipe would keep the probe
  // pending long past the kill. Measured 2026-09-05 against this wrapper: the
  // verdict was already answered at the deadline — the timeout handler resolves
  // rather than waiting for `close` — and the RUN was held 5.2 s past it by the
  // pipe nobody was reading any more (two runs in three; whether `/bin/sh` has
  // forked its `sleep` by the deadline is a race, so the hold is intermittent and
  // the check below is green when it did not happen at all).
  //
  // Mutation probe: take `finish` out of the timeout handler so it waits for
  // `close` again — the wall clock goes red at ~5 s. Take `destroy`/`unref` out and
  // the pipe count goes red instead. They are two lines for two symptoms, and
  // deleting either as redundant reads as safe and is not.
  // A destroyed stream does not leave the list on the next tick: measured, the
  // handle goes within ~50 ms, so the settle is a short timer rather than
  // `setImmediate`. A pipe a grandchild still holds is there for five seconds and
  // no settle hides it.
  const settled = () => new Promise((r) => { setTimeout(r, 150); });
  await settled();
  // `PipeWrap` is what libuv calls a child's stdio pipe in this list; a stream
  // destroyed and unref'd leaves none behind, an unread one that a grandchild still
  // holds stays until that process dies.
  const pipes = () => process.getActiveResourcesInfo().filter((r) => r === 'PipeWrap').length;
  const before = pipes();
  const started = Date.now();
  const verdict = await ask(shellMachine('sleep 5'), 700);
  const took = Date.now() - started;
  await settled();
  assert.equal(verdict.reason, 'probe_timeout', verdict.message);
  assert.ok(took < 2000, `the probe answered ${took} ms after a 700 ms deadline`);
  assert.equal(pipes(), before, 'the probe left an unread pipe holding the event loop open');
});

test('the binary comes from the request: this adapter resolves none of its own', async () => {
  // A host may start a process inside `resolveToolBin` — this package's own Cursor
  // driver says it does, with a 15 s ceiling — and the call is synchronous, so an
  // adapter making it would hold the event loop and stop the timer that bounds the
  // whole preflight. No adapter could fix that from its own side, so the preflight
  // resolves every binary once, before the race, and hands the answer over.
  //
  // Mutation probe: put `host.resolveToolBin(tool)` back at the top of `probe` and
  // this reddens on the throw while every other check in the file stays green.
  const host = machine();
  const resolved = host.resolveToolBin(CURSOR_TOOL);
  const hostile = {
    ...host,
    resolveToolBin: () => { throw new Error('the preflight resolved this already'); },
  };
  const verdict = await stubAdapter()
    .probe({ host: hostile, toolBin: resolved, timeoutMs: 10_000, refresh: false });
  assert.equal(verdict.reason, 'quota_unknown', verdict.message);
  assert.equal(verdict.version, STUB_VERSION);
});

// --- the listing that came back wrong ----------------------------------------

test('a refused or unreadable listing is probe_failed, not an account with no models', async () => {
  // Reporting an empty inventory would exclude every Cursor tuple as
  // `model-not-in-inventory` and send the person to the catalog for a parse fault.
  for (const mode of ['models-refuse', 'models-garbled']) {
    const verdict = await ask(machine({ mode }));
    assert.equal(verdict.state, 'unknown', mode);
    assert.equal(verdict.reason, 'probe_failed', mode);
    assert.equal(verdict.models, undefined, mode);
  }
});

// --- what reaches disk -------------------------------------------------------

test('the account the binary printed reaches neither the verdict nor the cache file', async () => {
  // `status` prints the account address on the one line the adapter reads. This is
  // the check that the adapter counts and classifies instead of quoting: the
  // verdict `message` is the only free text that reaches the cache.
  const host = machine();
  const verdict = await ask(host);
  assert.equal(JSON.stringify(verdict).includes(STUB_ACCOUNT), false, 'the verdict carries the account');

  await preflight({ host, harnesses: [CURSOR], adapterFor: () => stubAdapter() });
  const written = readFileSync(host.routingPaths().cacheFile, 'utf8');
  assert.equal(written.includes(STUB_ACCOUNT), false, 'the cache file carries the account');
});

test('the verdict survives the preflight contract gate and reaches the snapshot intact', async () => {
  // `verdictOf` replaces anything outside the closed lists with `probe_failed`
  // and discards the rest, so a misspelt `quota-unknown` — the mistake PB-14 says
  // an adapter author actually makes — would leave the person with a harness that
  // says nothing at all. This is the check that reddens on that typo, and the
  // snapshot it produces is handed to the schema the cache file promises to
  // validate against.
  const host = machine();
  const snapshot = await preflight({ host, harnesses: [CURSOR], adapterFor: () => stubAdapter() });
  const entry = snapshot.harnesses[CURSOR];
  assert.equal(entry.state, 'unknown');
  assert.equal(entry.reason, 'quota_unknown');
  assert.equal(entry.version, STUB_VERSION);
  assert.equal(entry.models.length, 5);
  // `rated` is the preflight's to fill, and its default with no catalog in hand
  // is `false`; the flag beside it is the adapter's and travelled untouched.
  assert.deepEqual(entry.models.find((m) => m.model === 'claude-fable-5-thinking-high'),
    { model: 'claude-fable-5-thinking-high', rated: false, flags: ['no-zdr'] });
  assert.equal(validSnapshot(snapshot) ? true : ajv.errorsText(validSnapshot.errors), true);
});

// --- the account: the billing cycle, the two pools, the tier -----------------

/**
 * The measured shapes, redacted. Copies of what the spike of 2026-09-06 saw, with
 * the account's address and its three ids replaced by `<redacted>` in the config
 * fixture — which is also what `npm run audit` scans the tree for. The adapter
 * reads ONE field out of that file and the redaction is what says so.
 */
const FIXTURES = path.join(here, 'fixtures', 'model-routing');
const fixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
const PERIOD_USAGE = fixture('cursor-period-usage.json');
const LIMIT_STATUS = fixture('cursor-usage-limit-status.json');
const CLI_CONFIG = readFileSync(path.join(FIXTURES, 'cursor-cli-config.json'), 'utf8');

/** A bearer no live endpoint would take, shaped like one so a grep can find it. */
const FAKE_TOKEN = 'cursor-fake-jwt.promptobus.3f9a1c';
const BACKEND = 'https://api2.cursor.sh';
const USAGE_CALL = `${BACKEND}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`;
const POLICY_CALL = `${BACKEND}/aiserver.v1.DashboardService/GetUsageLimitStatusAndActiveGrants`;
const ok = (doc) => ({ status: 200, doc });

/**
 * The account half wired to answers instead of to the network. Every URL asked is
 * recorded, which is how the checks that a call was NOT made are written.
 */
function account({ token = FAKE_TOKEN, source = 'keychain', replies = {} } = {}) {
  const asked = [];
  return {
    asked,
    deps: {
      readToken: async () => (token ? { token, source } : null),
      readBackendUrl: async () => BACKEND,
      postJson: async (url, opts) => {
        asked.push({ url, token: opts.token });
        const reply = replies[url];
        return reply ? (typeof reply === 'function' ? reply() : reply) : { status: 404, doc: null };
      },
    },
  };
}

test('the auto pool names inventory ids, by exact name or by family prefix', () => {
  // `autoBucketModels` names FAMILIES and the inventory names ids with the effort
  // level and the speed tier baked in. ADR-004 wants a scope that covers models to
  // name them by id, because the resolver matches exactly and infers no family —
  // so the inference happens in the adapter, which holds both lists.
  const bucket = ['composer-2.5', 'cursor-grok-4.6', 'vega', 'default'];
  const inventory = [
    'composer-2.5', 'composer-2.5-fast', 'cursor-grok-4.6-xhigh-fast', 'cursor-grok-4.6-low',
    'claude-opus-5-thinking-high', 'gpt-5.6-sol-high', 'vegabond-3', 'auto',
  ];
  assert.deepEqual(autoPoolModels(inventory, bucket), [
    'composer-2.5', 'composer-2.5-fast', 'cursor-grok-4.6-xhigh-fast', 'cursor-grok-4.6-low',
  ]);
  // The hyphen is the whole of the prefix rule: without it `vega` would claim
  // `vegabond-3`, and the api pool would silently lose a model to the auto one.
  assert.equal(autoPoolModels(['vegabond-3'], ['vega']).length, 0);
  // A bucket name that matches no id contributes nothing rather than being carried
  // as a guess — `default` is Cursor's internal name for the auto row and is not
  // an id the binary lists.
  assert.equal(autoPoolModels(inventory, bucket).includes('default'), false);
  // No bucket at all is no auto pool at all: the harness publishes that list, and
  // its absence is this adapter's fault rather than a limit to report.
  assert.deepEqual(autoPoolModels(inventory, undefined), []);
  assert.deepEqual(autoPoolModels(inventory, []), []);
});

test('one billing cycle becomes two windows of the same length, one per pool', () => {
  // ADR-004: `kind` is a name and `lengthSec` is the number, and a billing cycle
  // is `monthly` and is not thirty days — the length is the one the answer states.
  const windows = periodWindows(PERIOD_USAGE, STUB_IDS);
  assert.deepEqual(windows.map((w) => w.id), ['monthly-auto', 'monthly-api']);
  assert.deepEqual(windows.map((w) => w.kind), ['monthly', 'monthly']);
  assert.deepEqual(windows.map((w) => w.lengthSec), [2_592_000, 2_592_000]);
  assert.deepEqual(windows.map((w) => w.usedPercent), [86.1025, 98.4]);
  assert.deepEqual(windows.map((w) => w.resetAt), ['2030-01-04T00:00:00.000Z', '2030-01-04T00:00:00.000Z']);
  // The auto pool names the ids it covers; the api pool names none, being the
  // complement — ADR-004 refuses a list there rather than letting a second,
  // quieter claim ride along.
  assert.deepEqual(windows[0].scope, { pool: 'auto', models: ['cursor-grok-4.6-xhigh-fast'] });
  assert.deepEqual(windows[1].scope, { pool: 'api' });
  assert.equal('models' in windows[1].scope, false);
});

test('a cycle that does not read yields no window at all, and a percentage past 100 is capped', () => {
  // A pace cannot be computed without a length, and an invented one would be a
  // measurement nobody made. The cap is the other way round: `bonusSpend` can
  // carry a total past the included amount, the schema's range ends at 100, and
  // "spent" is what a value past the end means.
  const noCycle = { ...PERIOD_USAGE, billingCycleEnd: 'soon' };
  assert.deepEqual(periodWindows(noCycle, STUB_IDS), []);
  const backwards = { ...PERIOD_USAGE, billingCycleEnd: PERIOD_USAGE.billingCycleStart };
  assert.deepEqual(periodWindows(backwards, STUB_IDS), []);

  const over = { ...PERIOD_USAGE, planUsage: { ...PERIOD_USAGE.planUsage, apiPercentUsed: 140 } };
  assert.equal(periodWindows(over, STUB_IDS).find((w) => w.id === 'monthly-api').usedPercent, 100);
  const missing = { ...PERIOD_USAGE, planUsage: { ...PERIOD_USAGE.planUsage, autoPercentUsed: null } };
  assert.deepEqual(periodWindows(missing, STUB_IDS).map((w) => w.id), ['monthly-api']);
});

test('the tier is the plan included amount, marked derived, and never the account spend', () => {
  // No Cursor method returns the plan name — the spike checked, and cursor.com
  // refuses the CLI token — so ADR-004 makes the included amount the proxy and
  // marks it `derived`. The number is the PLAN's, which is why a tier stays a
  // property of the plan rather than a fact about the person.
  assert.deepEqual(derivedTier(PERIOD_USAGE), { name: 'included:7000', source: 'derived' });
  assert.equal(String(derivedTier(PERIOD_USAGE).name).includes(String(PERIOD_USAGE.planUsage.totalSpend)), false);
  assert.equal(derivedTier({ planUsage: {} }), null);
  assert.equal(derivedTier(null), null);
  // And the name has the shape the snapshot demands of a tier — no spaces, no `@`.
  assert.match(derivedTier(PERIOD_USAGE).name, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/);
});

test('the near-limit nudge is rewritten, never quoted', () => {
  // `message` is the one free-text field that reaches disk. The threshold is a
  // number and the target is a model id, and those two are carried; the nudge's
  // own `label` is prose written for a dialog and does not travel.
  const note = nudgeNote(LIMIT_STATUS);
  assert.match(note, /api pool is past 90 %/);
  assert.match(note, /grok-4\.6/);
  assert.equal(note.includes(LIMIT_STATUS.thirdPartyUsageNudge.label), false);
  assert.equal(nudgeNote({}), null);
  assert.equal(nudgeNote({ thirdPartyUsageNudge: { targetModel: 'x' } }), null);
  // A target that is not shaped like a model id is left out rather than carried.
  assert.equal(nudgeNote({ thirdPartyUsageNudge: { threshold: 90, targetModel: 'a b@c' } }),
    'Cursor warns that the api pool is past 90 %');
});

test('harness prose is bounded before it reaches a message, and an address is refused outright', () => {
  assert.equal(sanitizeMessage("You've hit your usage limit"), "You've hit your usage limit");
  assert.equal(sanitizeMessage('  spaced   out\tand\nwrapped '), 'spaced out and wrapped');
  assert.equal(sanitizeMessage('write to someone@example.invalid'), null, 'an address is refused');
  assert.equal(sanitizeMessage('x'.repeat(400)).length, 120);
  assert.equal(sanitizeMessage(''), null);
  assert.equal(sanitizeMessage(null), null);
});

test('only https is accepted as the backend, and anything else falls back to the measured default', () => {
  // The value comes out of a file on disk and a bearer token is about to be sent
  // to it. A `http:` there would be a token in the clear.
  assert.equal(backendUrlOf(CLI_CONFIG), 'https://api2.cursor.sh');
  assert.equal(backendUrlOf(JSON.stringify({ serverConfigCache: { backendUrl: 'http://api2.cursor.sh' } })), null);
  assert.equal(backendUrlOf(JSON.stringify({ serverConfigCache: { backendUrl: 'file:///etc/passwd' } })), null);
  assert.equal(backendUrlOf('not json'), null);
  assert.equal(backendUrlOf('{}'), null);
});

test('the config file is read for one field: the account it also holds does not travel', () => {
  // `~/.cursor/cli-config.json` carries `authInfo` — an address, a display name
  // and two ids. One field of the file is parsed, and the answer is a URL.
  assert.equal(backendUrlOf(CLI_CONFIG), 'https://api2.cursor.sh');
  assert.ok(CLI_CONFIG.includes('authInfo'), 'the fixture really does carry the block');
});

test('a logged-in account whose dashboard answers is available, with two pool windows and a tier', async () => {
  // The sentence this replaces is the reference's: "a successful probe is
  // `unknown`, not `available`". ADR-004 supersedes the assumption under it, and
  // the word still means auth, model AND limit confirmed.
  const wired = account({ replies: { [USAGE_CALL]: ok(PERIOD_USAGE), [POLICY_CALL]: ok(LIMIT_STATUS) } });
  const verdict = await ask(machine(), 10_000, wired.deps);
  assert.equal(verdict.state, 'available', verdict.message);
  assert.equal(verdict.reason, null);
  assert.deepEqual(verdict.tier, { name: 'included:7000', source: 'derived' });
  assert.deepEqual(verdict.windows.map((w) => w.id), ['monthly-auto', 'monthly-api']);
  assert.equal(verdict.version, STUB_VERSION);
  // The nudge is in the message, rewritten. The harness's own `displayMessage` is
  // NOT: it is written for a person who is out of usage, and the check below on the
  // exhausted branch is where it belongs.
  assert.match(verdict.message, /api pool is past 90 %/);
  assert.equal(/the harness says/.test(verdict.message), false, verdict.message);
  assert.deepEqual(wired.asked.map((a) => a.url), [USAGE_CALL, POLICY_CALL]);
});

test('the token reaches one header and nothing else — not the verdict, not the cache', async () => {
  const host = machine();
  const wired = account({ replies: { [USAGE_CALL]: ok(PERIOD_USAGE) } });
  const verdict = await ask(host, 10_000, wired.deps);
  assert.equal(wired.asked[0].token, FAKE_TOKEN, 'the header did get the token');
  assert.equal(JSON.stringify(verdict).includes(FAKE_TOKEN), false, 'the token is in the verdict');

  const snapshot = await preflight({
    host, harnesses: [CURSOR], adapterFor: () => stubAdapter(wired.deps),
  });
  assert.equal(snapshot.harnesses[CURSOR].state, 'available');
  assert.equal(validSnapshot(snapshot) ? true : ajv.errorsText(validSnapshot.errors), true);
  const written = readFileSync(host.routingPaths().cacheFile, 'utf8');
  assert.equal(written.includes(FAKE_TOKEN), false, 'the token is on disk');
});

test('the refresh token is named in prose and never in code', () => {
  // The safest way not to leak a secret is not to hold it. `cursor-refresh-token`
  // sits in the same keychain under a neighbouring service name, and the check is
  // on the SOURCE because there is no branch to exercise: no expression in this
  // file names it. The comments are stripped first on purpose — the header says
  // out loud that the refresh token is never asked for, and a check that forbade
  // the words would forbid the documentation along with the call.
  const source = readFileSync(path.join(ROOT, 'lib', 'model-routing', 'adapter-cursor.js'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  assert.equal(code.includes('refresh-token'), false, 'the adapter names the refresh token in code');
  assert.equal(code.includes('refreshToken'), false, 'the adapter names the refresh token in code');
  assert.ok(source.includes('cursor-refresh-token'), 'the prose still says it is never asked for');
});

test('the Connect headers are the three the dashboard answers to', () => {
  // `connect-protocol-version` is what makes these methods answer 200 at all
  // (measured 2026-09-06). A probe that lost it would report `quota_unknown` for a
  // perfectly good account, which reads as a harness change rather than a missing
  // line.
  assert.deepEqual(connectHeaders(FAKE_TOKEN), {
    authorization: `Bearer ${FAKE_TOKEN}`,
    'content-type': 'application/json',
    'connect-protocol-version': '1',
  });
});

test('no token is quota_unknown, not a logged-out account', async () => {
  // `status` has already answered the auth question and the binary just listed the
  // inventory. Calling an unreadable keychain a logged-out account would take
  // every Cursor tuple out of routing on a dialog somebody dismissed. PB-27's text
  // says `not_authenticated` here; this follows ADR-004's own reading of the word,
  // and the reference says so.
  const verdict = await ask(machine(), 10_000, { readToken: async () => null });
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.reason, 'quota_unknown');
  assert.match(verdict.message, /no access token could be read/);
  assert.equal(verdict.models.length, 5, 'the inventory is still reported');
});

test('a dashboard that refuses the token is not_authenticated: that one IS about the account', async () => {
  for (const status of [401, 403]) {
    const wired = account({ replies: { [USAGE_CALL]: { status, doc: null } } });
    const verdict = await ask(machine(), 10_000, wired.deps);
    assert.equal(verdict.state, 'unavailable', `status ${status}`);
    assert.equal(verdict.reason, 'not_authenticated', `status ${status}`);
    assert.match(verdict.message, /cursor-agent login/);
  }
});

test('a dashboard that answers otherwise, times out, or cannot be reached keeps its own code', async () => {
  const other = account({ replies: { [USAGE_CALL]: { status: 500, doc: null } } });
  assert.equal((await ask(machine(), 10_000, other.deps)).reason, 'quota_unknown');
  const slow = account({ replies: { [USAGE_CALL]: { error: 'timeout' } } });
  assert.equal((await ask(machine(), 10_000, slow.deps)).reason, 'probe_timeout');
  const gone = account({ replies: { [USAGE_CALL]: { error: 'network' } } });
  assert.equal((await ask(machine(), 10_000, gone.deps)).reason, 'probe_failed');
});

test('the policy call is optional: a refusal costs the nudge and nothing else', async () => {
  // PB-27 says to skip it on timeout, and the windows still count — it carries a
  // warning and the windows are the fact.
  const wired = account({ replies: { [USAGE_CALL]: ok(PERIOD_USAGE), [POLICY_CALL]: { error: 'timeout' } } });
  const verdict = await ask(machine(), 10_000, wired.deps);
  assert.equal(verdict.state, 'available');
  assert.equal(verdict.windows.length, 2);
  assert.equal(/api pool is past/.test(verdict.message), false);
});

test('one spent pool does not exhaust the harness; both do', async () => {
  // A pool at or past 100 % is spent for the tuples it covers, and the resolver
  // reads that per tuple as the binding window (ADR-004). `exhausted` takes every
  // Cursor tuple out of routing, and one spent pool leaves the other one running —
  // which is the whole point of publishing two windows rather than one number.
  const onePool = {
    ...PERIOD_USAGE,
    planUsage: { ...PERIOD_USAGE.planUsage, apiPercentUsed: 100 },
  };
  const half = account({ replies: { [USAGE_CALL]: ok(onePool) } });
  const running = await ask(machine(), 10_000, half.deps);
  assert.equal(running.state, 'available', running.message);
  assert.equal(running.windows.find((w) => w.id === 'monthly-api').usedPercent, 100);

  const bothPools = {
    ...PERIOD_USAGE,
    planUsage: { ...PERIOD_USAGE.planUsage, autoPercentUsed: 100, apiPercentUsed: 100 },
  };
  const spent = account({ replies: { [USAGE_CALL]: ok(bothPools) } });
  const out = await ask(machine(), 10_000, spent.deps);
  assert.equal(out.state, 'exhausted', out.message);
  assert.equal(out.reason, 'subscription_exhausted');
  assert.equal(out.resetAt, '2030-01-04T00:00:00.000Z');
});

test('a cycle the adapter cannot place is quota_unknown with the tier still reported', async () => {
  const wired = account({ replies: { [USAGE_CALL]: ok({ ...PERIOD_USAGE, billingCycleEnd: 'soon' }) } });
  const verdict = await ask(machine(), 10_000, wired.deps);
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.reason, 'quota_unknown');
  assert.deepEqual(verdict.tier, { name: 'included:7000', source: 'derived' });
  assert.equal(verdict.windows, undefined);
});

test('the keychain token comes first and the environment key is the fallback', () => {
  // The keychain token is the one the spike measured this call answering.
  // `CURSOR_API_KEY` is the other way the binary authenticates and nothing says
  // DashboardService takes it, so it is a fallback rather than a claim — and the
  // order is what keeps an exported variable from shadowing the measured
  // credential.
  //
  // The source travels with the token because it decides what a refusal means; the
  // live reader is pinned here as source, since exercising it would mean asking
  // the developer's own keychain.
  const source = readFileSync(path.join(ROOT, 'lib', 'model-routing', 'adapter-cursor.js'), 'utf8');
  // Both searched from the start of the file, not from a window around one of
  // them: an offset would make the check depend on how far apart the two lines
  // happen to sit, which is not what it is about.
  const keychainAt = source.indexOf('runOut(SECURITY_BIN, TOKEN_ARGV');
  const envAt = source.indexOf('process.env[TOKEN_ENV]');
  assert.ok(keychainAt > 0, 'the keychain read is not there at all');
  assert.ok(envAt > keychainAt, 'the environment key is read before the keychain');
  assert.match(source, /source: 'keychain'/);
  assert.match(source, /source: 'env'/);
});

test('a refused environment key is quota_unknown; a refused keychain token is not_authenticated', async () => {
  // A 401 on the credential the spike measured means the login is no longer good.
  // A 401 on an API key says nothing of the kind — that path is not measured at
  // all — and marking the harness `unavailable` on it would drop every Cursor
  // tuple out of routing because of a variable a person exported for the binary.
  for (const status of [401, 403]) {
    const keychain = account({ replies: { [USAGE_CALL]: { status, doc: null } } });
    const refused = await ask(machine(), 10_000, keychain.deps);
    assert.equal(refused.state, 'unavailable', `keychain ${status}`);
    assert.equal(refused.reason, 'not_authenticated', `keychain ${status}`);

    const env = account({ source: 'env', replies: { [USAGE_CALL]: { status, doc: null } } });
    const soft = await ask(machine(), 10_000, env.deps);
    assert.equal(soft.state, 'unknown', `env ${status}`);
    assert.equal(soft.reason, 'quota_unknown', `env ${status}`);
    assert.match(soft.message, /CURSOR_API_KEY/);
    assert.match(soft.message, /not measured/);
  }
});

test('one window read is never both pools spent', async () => {
  // The `auto` pool has no window when the harness published no id list, and a
  // list of one window is not evidence about the pool missing from it. Reading it
  // as "every window is spent" would exhaust the harness on the api pool alone and
  // then say "both usage pools are spent", which is a sentence about a fact
  // nobody had.
  const apiOnly = {
    ...PERIOD_USAGE,
    autoBucketModels: [],
    planUsage: { ...PERIOD_USAGE.planUsage, apiPercentUsed: 100 },
  };
  const wired = account({ replies: { [USAGE_CALL]: ok(apiOnly) } });
  const verdict = await ask(machine(), 10_000, wired.deps);
  assert.deepEqual(verdict.windows.map((w) => w.id), ['monthly-api']);
  assert.equal(verdict.state, 'available', verdict.message);
  assert.equal(/both usage pools/.test(verdict.message), false);
});

test("the harness's own usage line reaches a diagnosis only when the harness is out", async () => {
  // `displayMessage` is written for a person who has hit their limit. Beside
  // `available` it reads as a contradiction — "available … the harness says:
  // you've hit your usage limit" — so it travels on the exhausted branch and not
  // on the healthy one.
  const healthy = account({ replies: { [USAGE_CALL]: ok(PERIOD_USAGE) } });
  const running = await ask(machine(), 10_000, healthy.deps);
  assert.equal(running.state, 'available');
  assert.equal(/the harness says/.test(running.message), false, running.message);

  const bothPools = {
    ...PERIOD_USAGE,
    planUsage: { ...PERIOD_USAGE.planUsage, autoPercentUsed: 100, apiPercentUsed: 100 },
  };
  const spent = account({ replies: { [USAGE_CALL]: ok(bothPools) } });
  const out = await ask(machine(), 10_000, spent.deps);
  assert.equal(out.state, 'exhausted');
  assert.match(out.message, /the harness says: You've hit your usage limit/);
});

test('a plan that names no included amount has no tier, and a nudge with no threshold is no nudge', () => {
  // `Number(null)` is 0 both times: the first would publish `included:0` as a
  // measured tier, the second would warn that the pool is "past 0 %".
  for (const limit of [null, undefined, '', '7000', false]) {
    assert.equal(derivedTier({ planUsage: { limit } }), null, String(limit));
  }
  for (const threshold of [null, undefined, '', '90', false]) {
    assert.equal(nudgeNote({ thirdPartyUsageNudge: { threshold, targetModel: 'grok-4.6' } }), null, String(threshold));
  }
});

test('the driver wires the live token read and the live dashboard call', () => {
  // The suite builds this adapter with the account half stubbed, so the wiring a
  // person actually runs is pinned here, as source: the driver declares the
  // adapter with no `deps`, which is what leaves the live implementations in place.
  const driver = readFileSync(path.join(ROOT, 'lib', 'driver-cursor.js'), 'utf8');
  assert.match(driver, /availability: cursorAvailability\(CURSOR_TOOL\),/);
});
