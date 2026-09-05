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
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { authState, cursorAvailability, parseModels } from '../lib/model-routing/adapter-cursor.js';
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
      \`\${cyan('auto')} \${dim('- Auto')}\${dim(' (default)')}\`,
      \`\${cyan('gpt-5.3-codex-low')} \${dim('- Codex 5.3 Low')}\`,
      \`\${cyan('claude-opus-5-thinking-max')} \${dim('- Claude Opus 5 Max Thinking')}\`,
      \`\${cyan('cursor-grok-4.6-xhigh-fast')} \${dim('- Grok 4.6 Extra High Fast')}\`,
      \`\${cyan('claude-fable-5-thinking-high')} \${dim('- Claude Fable 5 1M Thinking (NO ZDR)')}\`,
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
const ask = (host, timeoutMs = 10_000) => {
  const adapter = cursorAvailability(CURSOR_TOOL);
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

test('a logged-in account is quota_unknown with its inventory, never available', async () => {
  // Cursor has no limit API, no usage subcommand and no window it will name, so a
  // successful probe cannot claim `available` — that word means the limit was
  // confirmed. `quota_unknown` is the code written for auth-is-fine-limit-is-not.
  const verdict = await ask(machine());
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.reason, 'quota_unknown');
  assert.equal(verdict.source, 'probe');
  assert.equal(verdict.resetAt, null);
  assert.equal(verdict.version, STUB_VERSION);
  // No windows at all, not an empty list: a harness with no limit source reports
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
  const verdict = await cursorAvailability(CURSOR_TOOL)
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

  await preflight({ host, harnesses: [CURSOR], adapterFor: () => adapterOf(CURSOR) });
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
  const snapshot = await preflight({ host, harnesses: [CURSOR], adapterFor: () => adapterOf(CURSOR) });
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
