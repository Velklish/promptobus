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
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { authState, cursorAvailability, parseModels } from '../lib/model-routing/adapter-cursor.js';
import { CURSOR, cursorDriver } from '../lib/driver-cursor.js';
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
  mode = 'ok', version = STUB_VERSION, bin = true, executable = true, resolveBlocksMs = 0,
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'promptobus-adapter-cursor-'));
  const binDir = path.join(dir, 'bin');
  if (bin) {
    stubCommand(binDir, CURSOR, STUB_BODY);
    // A file that is there and will not run. Not a missing binary and not a slow
    // one — the third way a launch fails, and the one with no reason code of its own.
    if (!executable) chmodSync(path.join(binDir, CURSOR), 0o644);
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
      // A host that starts a process while resolving — this package's own driver
      // says `resolveToolBin` asks `--version` with a ceiling of its own — and does
      // it synchronously, which is what a `spawnSync` costs. Spun rather than
      // awaited on purpose: the point is that the adapter cannot yield through it.
      if (resolveBlocksMs) {
        const until = Date.now() + resolveBlocksMs;
        while (Date.now() < until) { /* the event loop is held, exactly as spawnSync holds it */ }
      }
      if (!bin || name !== CURSOR) return { ok: false, reason: 'not found' };
      return { ok: true, bin: path.join(binDir, name), ...(version ? { version } : {}) };
    },
  };
}

/** The stub is steered by the environment; every check sets it, and none may inherit a neighbour's. */
afterEach(() => {
  delete process.env.STUB_CURSOR_MODE;
  delete process.env.STUB_CURSOR_ACCOUNT;
});

const ask = (host, timeoutMs = 10_000) => cursorAvailability(CURSOR)
  .probe({ host, timeoutMs, refresh: false });

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

test('the budget covers the binary resolve too', async () => {
  // A host may start a process inside `resolveToolBin` — this package's own Cursor
  // driver says it does, with a 15 s ceiling — so resolving is part of the probe.
  // A deadline taken after it would let one adapter spend that ceiling AND the
  // whole budget; taken before it, the resolve comes out of the same 1500 ms.
  // (That a synchronous resolve also holds the event loop is a host-contract
  // problem no adapter can fix from its own side — filed as PB-16.2.)
  const host = machine({ mode: 'slow-models', resolveBlocksMs: 1000 });
  const started = Date.now();
  const verdict = await ask(host, 1500);
  const elapsed = Date.now() - started;
  assert.equal(verdict.reason, 'probe_timeout');
  assert.ok(elapsed < 2100, `the resolve was spent outside the budget (${elapsed} ms)`);
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
