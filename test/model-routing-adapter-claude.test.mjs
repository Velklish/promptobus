// Claude Code availability adapter: what it answers for each state of the
// account, and what it refuses to say. Run: npm test
//
// Nothing here starts a real `claude`. The binary is a stub script the host is
// told to resolve to ([sandbox.mjs](sandbox.mjs) `stubCommand`), which is what
// lets the states a live account is never asked to be in — logged out, a build
// with no `auth` subcommand, a probe that outlives its budget — be checked at all.
// The suite's hygiene check watches the same rule from the other side.
//
// Three checks exist to be broken rather than to pass, and the mutation probes name
// them: change `MODEL_ALIASES` in the driver and the inventory check reddens;
// widen the argv the adapter sends and the "no bare word" check reddens, which is
// the one that keeps a probe from starting a paid turn; and make the probe
// synchronous again and the event-loop check reddens, which is the one that keeps
// one adapter from eating the whole preflight budget on its own.
// Home diversion before any import that is not a Node built-in: a module that
// resolved a home path at load would see the real one. [home.mjs](home.mjs) says
// what it applies; the sentinel in tmpdir-sweep.test.mjs keeps the order.
import './home.mjs';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import {
  CLAUDE, DEFAULT_MODEL, MODEL_ALIASES, MODEL_IDS, MODEL_SCOPE_IDS, claudeDriver, markLimitAtStart,
} from '../lib/driver-claude.js';
import { liftoffParticipant } from '../lib/liftoff.js';
import {
  claudeAvailability, credentialFile, credentialRecord, oauthHeaders, scopeModels, spentWindow,
  stampOf, usageWindows,
} from '../lib/model-routing/adapter-claude.js';
import { entryLive, readSnapshot, stickyExhaustion } from '../lib/model-routing/cache.js';
import { preflight } from '../lib/model-routing/preflight.js';
import { stubCommand } from './sandbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_SCHEMA = path.join(here, '..', 'schemas', 'model-routing', 'snapshot.schema.json');

// `strict: false` for the reason the neighbouring routing files state: the
// schema's own vocabulary is suspicious to ajv in strict mode, and the subject
// here is the verdict.
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validSnapshot = ajv.compile(JSON.parse(readFileSync(SNAPSHOT_SCHEMA, 'utf8')));

// A secret shaped exactly like what this adapter could pick up out of the auth
// answer. `claude auth status --json` really does print an email, an organisation
// id and its name next to `loggedIn` (measured 2026-09-05 on 2.1.251), and the
// cache promises to hold none of them — so the stub hands them over and the checks
// grep for them.
const FAKE_EMAIL = 'someone@example.invalid';
const FAKE_ORG = 'promptobus-fake-org-4c1b7e';

/** The auth answer in the shape the real binary prints, with the fields that must not travel. */
const AUTH_JSON = (loggedIn) => JSON.stringify({
  loggedIn,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: FAKE_EMAIL,
  orgId: FAKE_ORG,
  orgName: `${FAKE_EMAIL}'s Organization`,
  subscriptionType: 'max',
});

/**
 * A sandbox with a stub `claude` and a host that resolves to it.
 *
 * The host answers exactly what an adapter is allowed to ask — `resolveToolBin`
 * and `routingPaths` — and nothing else: a stand-in that answered more would hide
 * an adapter reaching for the store home. `version` rides on the tool answer the
 * way the workspace host really returns it, and the three drivers already read it
 * that way.
 */
function sandbox(body, { version = '2.1.251', ok = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'promptobus-adapter-claude-'));
  const argvFile = path.join(dir, 'argv.json');
  stubCommand(dir, CLAUDE, `import { writeFileSync } from 'node:fs';\n`
    + `writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n${body}`);
  return {
    dir,
    argv: () => JSON.parse(readFileSync(argvFile, 'utf8')),
    host: {
      kind: 'promptobus-host',
      resolveToolBin: (name) => (ok
        ? { ok: true, bin: path.join(dir, name), version }
        : { ok: false, reason: 'not found' }),
      routingPaths: () => ({ cacheFile: path.join(dir, 'model-routing', 'cache.json'), overlays: [] }),
    },
  };
}

/**
 * A sandbox whose `claude` is a plain shell script rather than the usual node
 * stub. Exactly one check needs it, and it needs it because of how the stub is
 * launched: `stubCommand` writes `exec node …`, so the stub REPLACES the shell and
 * leaves no wrapper behind, which is the case that does NOT reproduce a grandchild
 * outliving the kill (measured: 308 ms either way). A script that forks and waits
 * does — the same shape the live probe hit. POSIX only, like every stub here.
 */
function shellSandbox(body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'promptobus-adapter-claude-'));
  const bin = path.join(dir, CLAUDE);
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return {
    host: {
      resolveToolBin: () => ({ ok: true, bin, version: '2.1.251' }),
      routingPaths: () => ({ cacheFile: path.join(dir, 'model-routing', 'cache.json'), overlays: [] }),
    },
  };
}

/**
 * The two calls that leave this process, as the suite answers them.
 *
 * **Nothing here may reach the real ones**, and the default is what enforces it:
 * a keychain that answers nothing and an endpoint that is never asked. A check
 * that wants the account half says so by handing in its own — so a check that
 * forgets to gets `quota_unknown` and an explanation, never a keychain dialog on
 * the machine running `npm test` and never a request to api.anthropic.com.
 */
const NO_ACCOUNT = {
  readCredential: async () => null,
  getJson: async () => { throw new Error('the suite never calls the usage endpoint'); },
};

/**
 * The inventory the driver hands its adapter, derived here from the driver's own
 * exported constants exactly as the driver derives it. What the checks assert is
 * still written out literally: an expectation computed from the constant under
 * test passes whatever that constant becomes, which is what the first mutation
 * probe of this file caught.
 */
const DRIVER_MODELS = [...new Set([...MODEL_IDS, ...MODEL_ALIASES, DEFAULT_MODEL])];

/**
 * The adapter under test, with the account half stubbed.
 *
 * It is built here rather than taken from `claudeDriver.availability` for one
 * reason: the driver wires the LIVE keychain read and the LIVE endpoint, and a
 * suite that ran those would ask the developer's own keychain for a token. The
 * driver's wiring is pinned separately, as source, by the check at the foot of
 * this file — the same way the lift hook's wiring is pinned.
 */
const adapter = (deps = {}) => claudeAvailability(DRIVER_MODELS, MODEL_SCOPE_IDS, { ...NO_ACCOUNT, ...deps });

/**
 * Call an adapter the way the preflight does: the binary is resolved ONCE, before
 * the probe, and travels in the request ([preflight.js](../lib/model-routing/preflight.js)).
 * A host with no `resolveToolBin` resolves to nothing, which is the `null` the
 * preflight hands over for a host that cannot answer.
 */
const ask = (adapterObj, host, timeoutMs) => adapterObj.probe({
  host,
  toolBin: typeof host?.resolveToolBin === 'function' ? host.resolveToolBin(adapterObj.tool) : null,
  timeoutMs,
  refresh: false,
});
const probe = (host, timeoutMs = 15_000, deps = {}) => ask(adapter(deps), host, timeoutMs);

// --- the states --------------------------------------------------------------

test('no binary is unavailable / binary_missing, and nothing is claimed about the account', async () => {
  const box = sandbox('', { ok: false });
  const verdict = await probe(box.host);
  assert.equal(verdict.state, 'unavailable');
  assert.equal(verdict.reason, 'binary_missing');
  assert.equal(verdict.source, 'probe');
  // No inventory and no version: a binary that is not there listed nothing and
  // has no version to read.
  assert.equal(verdict.models, undefined);
  assert.equal(verdict.version, undefined);
});

test('a host that cannot resolve a binary gets a verdict, not a throw', async () => {
  // The contract's own rule: an adapter answers, it never throws — a thrown error
  // becomes probe_failed with its text discarded, and the message is the only
  // diagnostic channel a person has. This is also the shape PB-14's registry check
  // calls the three drivers with.
  const verdict = await probe(null, 1);
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.reason, 'probe_failed');
  assert.match(verdict.message, /host/);
});

test('logged out is unavailable / not_authenticated, and the version is still read', async () => {
  const box = sandbox(`process.stdout.write(${JSON.stringify(AUTH_JSON(false))});`);
  const verdict = await probe(box.host);
  assert.equal(verdict.state, 'unavailable');
  assert.equal(verdict.reason, 'not_authenticated');
  assert.equal(verdict.version, '2.1.251');
  // The account exposes nothing we know of when nobody is logged into it.
  assert.equal(verdict.models, undefined);
});

test('logged in is unknown / quota_unknown: auth confirmed, the remaining limit not', async () => {
  // `available` is unreachable for this harness on purpose. The word means auth,
  // model AND limit confirmed, and Claude Code publishes no stable limit source at
  // all — ADR-003 says such an adapter answers `unknown` rather than modelling a
  // value, and the resolver penalises that by ten points instead of blocking.
  const box = sandbox(`process.stdout.write(${JSON.stringify(AUTH_JSON(true))});`);
  const verdict = await probe(box.host);
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.reason, 'quota_unknown');
  assert.equal(verdict.version, '2.1.251');
  assert.equal(verdict.resetAt, null);
  // No windows, ever: there is no source to normalise one from, and an invented
  // percentage would read as a measurement.
  assert.equal(verdict.windows, undefined);
});

test('an answer this adapter cannot read is quota_unknown, never a guessed logout', async () => {
  // The shape of an older build: no `auth` subcommand at all. A refusal to parse
  // must not become `not_authenticated` — that would take every tuple of the
  // harness out of routing on the strength of a guess.
  const box = sandbox("process.stderr.write(\"error: unknown command 'auth'\");\nprocess.exit(1);");
  const verdict = await probe(box.host);
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.reason, 'quota_unknown');
  assert.match(verdict.message, /auth could not be verified/);
  assert.match(verdict.message, /exit 1/);
});

test('a probe that outlives its budget is probe_timeout, and the budget is what the caller gave', async () => {
  // The whole preflight budget is the adapter's ceiling, and a harness that has
  // not answered by then must not hold the command. 200 ms is the ceiling here;
  // the stub sleeps well past it.
  const box = sandbox('await new Promise((r) => setTimeout(r, 5000));');
  const started = Date.now();
  const verdict = await probe(box.host, 200);
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.reason, 'probe_timeout');
  assert.ok(Date.now() - started < 4000, `waited ${Date.now() - started} ms`);
});

// --- what is asked, and what is answered -------------------------------------

test('the deadline holds even when a grandchild keeps the output pipe open', async () => {
  // `close` fires when the last stdio pipe closes, not when the child dies, so a
  // process the harness left behind holding the inherited pipe would keep the
  // probe pending long past the kill. Found live on 2026-09-05: a 300 ms deadline
  // against a shell wrapper whose `sleep 5` held the pipe answered `probe_timeout`
  // 5.2 s late — the right verdict, at the wrong time, which is the overshoot the
  // deadline exists to prevent.
  //
  // Mutation probe: take the answer, the `destroy` and the `unref` out of the
  // timeout handler so it waits for `close` again — this goes red on the wall
  // clock (5.0 s measured) while the verdict itself stays correct.
  const box = shellSandbox('sleep 5');
  const started = Date.now();
  const verdict = await probe(box.host, 300);
  const took = Date.now() - started;
  assert.equal(verdict.reason, 'probe_timeout', verdict.message);
  assert.ok(took < 1500, `the probe answered ${took} ms after a 300 ms deadline`);
});

test('the probe does not block the event loop, so the preflight budget can still fire', async () => {
  // The preflight holds ONE budget for every adapter, as a timer racing their
  // promises. A `spawnSync` probe would block the loop for its whole run, that
  // timer could not fire while this adapter worked, and each blocking adapter
  // would get the full budget again after its neighbours — the run's ceiling
  // would become their sum. So what is asserted is not the probe's own duration
  // but that OTHER work still ran while it was in flight.
  //
  // Mutation probe: put `run()` from lib/exec.js back in place of the spawn and
  // this goes red while every other check in the file stays green.
  // Counted rather than timed (PB-15.7): the file runs in the pool, and a threshold
  // in milliseconds would measure the machine's neighbours — measured red once at
  // 760 ms under load with the adapter behaving. A blocked loop fires a 20 ms
  // interval once, however long the block (node coalesces the missed periods into
  // one callback); a probe that yields lets it tick on every turn. Five is a fifth
  // of what an unloaded run counts here.
  const box = sandbox(`await new Promise((r) => setTimeout(r, 400));\n`
    + `process.stdout.write(${JSON.stringify(AUTH_JSON(true))});`);
  const started = Date.now();
  let ticks = 0;
  const beat = setInterval(() => { ticks += 1; }, 20);
  const verdict = await probe(box.host, 15_000);
  clearInterval(beat);
  assert.equal(verdict.reason, 'quota_unknown', verdict.message);
  const probeTook = Date.now() - started;
  assert.ok(probeTook > 250, `the stub answered in ${probeTook} ms — too fast to prove anything`);
  assert.ok(ticks >= 5, `a 20 ms interval ticked ${ticks} times while a ${probeTook} ms probe ran`);
});

test('the binary comes from the request: this adapter resolves none of its own', async () => {
  // `resolveToolBin` is synchronous and a host is free to start a process inside
  // it, so an adapter that called it would hold the event loop and stop the timer
  // that bounds the whole preflight — no adapter can fix that from its own side.
  // The preflight resolves once, before the race, and hands the answer over.
  //
  // Mutation probe: put `host.resolveToolBin(TOOL)` back at the top of `probe` and
  // this reddens on the throw while every other check in the file stays green.
  const box = sandbox(`process.stdout.write(${JSON.stringify(AUTH_JSON(true))});`);
  const resolved = box.host.resolveToolBin(CLAUDE);
  const hostile = {
    resolveToolBin: () => { throw new Error('the preflight resolved this already'); },
    routingPaths: box.host.routingPaths,
  };
  const verdict = await adapter().probe({ host: hostile, toolBin: resolved, timeoutMs: 15_000, refresh: false });
  assert.equal(verdict.reason, 'quota_unknown', verdict.message);
  assert.equal(verdict.version, '2.1.251');
});

test('a signal this adapter did not send is probe_failed, not probe_timeout', async () => {
  // Only our own kill is the budget. A harness that dies on every probe would
  // otherwise hide behind a code that reads as "the machine was busy", and the
  // cache would keep retrying it as a transient.
  const box = sandbox('process.kill(process.pid, \'SIGTERM\');\nawait new Promise(() => {});');
  const verdict = await probe(box.host, 15_000);
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.reason, 'probe_failed');
  assert.match(verdict.message, /SIGTERM/);
  assert.match(verdict.message, /did not send it/);
});

test('the probe sends one declared subcommand and never a bare word', async () => {
  // This is the check that keeps a probe from costing money. An unrecognised word
  // after `claude` is not an unknown subcommand — the binary takes it as a PROMPT
  // and starts a turn on the person's plan. So the argv is pinned whole, and a
  // future probe that wants a new fact has to change this line deliberately.
  const box = sandbox(`process.stdout.write(${JSON.stringify(AUTH_JSON(true))});`);
  await probe(box.host);
  assert.deepEqual(box.argv(), ['auth', 'status', '--json']);
});

test('the inventory is the pinned ids and the alias set the binary publishes, plus the driver default', async () => {
  // Every name is pinned LITERALLY, not computed from `MODEL_IDS` or
  // `MODEL_ALIASES`: an expectation derived from the constant under test passes
  // whatever that constant becomes, and the first mutation probe caught exactly
  // that. The three ids are the full names the catalog rates — a catalog row and an
  // inventory that disagreed would exclude every Claude tuple as
  // `model-not-in-inventory` and blame the catalog for it (PB-13.1) — and the three
  // aliases are what `claude --help` prints under `--model` on 2.1.263, measured
  // 2026-09-06. So the ids, the alias set and the default model that feed the
  // inventory are pinned through one check.
  //
  // `claude-fable-5` joined the ids in PB-29 and `claude-fable-5-1` in PB-34, both
  // read offline out of the binary's own baked catalog rather than guessed. On
  // 2.1.263 that table holds the two of them as separate first-party rows of
  // `family:"fable"` and points the alias at the newer one
  // (`fable:{default:"claude-fable-5-1",per_provider:{gateway:"claude-fable-5"}}`,
  // `latest_per_family.fable:"claude-fable-5-1"`, `alias_migration` still `{}`), so
  // the predecessor is a name the binary still takes. An id the catalog rates has
  // to be in the inventory or every Fable row would be excluded as
  // `model-not-in-inventory`.
  const box = sandbox(`process.stdout.write(${JSON.stringify(AUTH_JSON(true))});`);
  const verdict = await probe(box.host);
  assert.deepEqual(verdict.models.map((m) => m.model),
    ['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5',
      'fable', 'opus', 'sonnet']);
  // And the default is in there whatever the alias set says: it is the model every
  // spawn without a `--model` flag asks for.
  assert.ok(verdict.models.some((m) => m.model === DEFAULT_MODEL), DEFAULT_MODEL);
  // `rated` belongs to the catalog, and this adapter knows the harness. The
  // preflight fills it from the predicate its caller supplies.
  assert.ok(verdict.models.every((m) => m.rated === undefined), JSON.stringify(verdict.models));
});

test('the account fields of the auth answer reach neither the verdict nor the cache', async () => {
  // The auth answer carries an email, an organisation id and its name. The message
  // is the one free-text field that reaches disk, and the cache promises to hold
  // none of the three — so the whole written snapshot is grepped, not just the
  // message.
  const box = sandbox(`process.stdout.write(${JSON.stringify(AUTH_JSON(true))});`);
  const verdict = await probe(box.host);
  for (const secret of [FAKE_EMAIL, FAKE_ORG]) {
    assert.ok(!JSON.stringify(verdict).includes(secret), `${secret} in the verdict`);
  }

  const snapshot = await preflight({
    host: box.host,
    harnesses: [CLAUDE],
    adapterFor: () => adapter(),
  });
  assert.equal(snapshot.harnesses[CLAUDE].reason, 'quota_unknown');
  assert.ok(validSnapshot(snapshot), ajv.errorsText(validSnapshot.errors));
  const written = readFileSync(box.host.routingPaths().cacheFile, 'utf8');
  for (const secret of [FAKE_EMAIL, FAKE_ORG]) {
    assert.ok(!written.includes(secret), `${secret} on disk`);
  }
});

test('the inventory the driver hands over is what the adapter reports, not a list of its own', async () => {
  // The adapter takes the models as an argument precisely so that the alias set
  // and the default model stay in one file — the driver's. A copy inside the
  // adapter would drift, and this is what would notice.
  const box = sandbox(`process.stdout.write(${JSON.stringify(AUTH_JSON(true))});`);
  const verdict = await ask(claudeAvailability(['only-this-one'], MODEL_SCOPE_IDS, NO_ACCOUNT), box.host, 15_000);
  assert.deepEqual(verdict.models, [{ model: 'only-this-one' }]);
});

// --- the account: the tier, the windows, and what never travels ---------------

/**
 * The measured shapes, redacted. Every one of them is a copy of what the spike of
 * 2026-09-06 saw on the owner's machine with the token, the account id and the
 * scoped model's id replaced by `<redacted>` — which is also what `npm run audit`
 * scans the tree for. The adapter reads the scope's DISPLAY name and never its
 * id, and the fixture's redacted id is what says so.
 */
const FIXTURES = path.join(here, 'fixtures', 'model-routing');
const fixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
const USAGE = fixture('claude-usage.json');
const CREDENTIALS = fixture('claude-credentials.json');
const PROFILE = fixture('claude-profile.json');

/** The credential record as text, the way both platforms hand it over. */
const credentialText = (patch = {}) => JSON.stringify({
  ...CREDENTIALS,
  claudeAiOauth: { ...CREDENTIALS.claudeAiOauth, ...patch },
});

/**
 * A token no live endpoint would take, shaped like one so a grep can find it. The
 * checks below hunt for it in the verdict and on disk: the whole point of reading
 * a keychain is that nothing read there comes back out.
 */
const FAKE_TOKEN = 'sk-ant-oat01-promptobus-fake-9d41c0';

/**
 * The account half wired to answers instead of to the network: a credential
 * record, and one reply per URL. Every URL asked is recorded, which is how the
 * checks that a request was NOT made are written.
 */
function account({ credential = credentialText({ accessToken: FAKE_TOKEN }), replies = {} } = {}) {
  const asked = [];
  return {
    asked,
    deps: {
      readCredential: async () => credential,
      getJson: async (url, { token }) => {
        asked.push({ url, token });
        const reply = replies[url];
        if (!reply) return { status: 404, doc: null };
        return typeof reply === 'function' ? reply() : reply;
      },
    },
  };
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const ok = (doc) => ({ status: 200, doc });

test('a reset moment is normalised to the snapshot form, and an unreadable one is null', () => {
  // The endpoint answers ISO-8601 with an offset and sometimes with microseconds;
  // the snapshot's own form is UTC with milliseconds, and the schema's pattern
  // refuses anything else.
  assert.equal(stampOf('2030-01-04T13:00:00+00:00'), '2030-01-04T13:00:00.000Z');
  assert.equal(stampOf('2030-01-01T00:00:00.319386+00:00'), '2030-01-01T00:00:00.319Z');
  assert.equal(stampOf('not a date'), null);
  assert.equal(stampOf(null), null);
  assert.equal(stampOf(1788668319), null, 'a number is not this endpoint’s shape and is not guessed at');
});

test('the credential record is three fields, and the refresh token is not one of them', () => {
  // The shape is the enforcement. `refreshToken` is never read, so it cannot be
  // carried by accident into a message, a log line or the cache — and this is the
  // check that reddens if someone spreads the record instead of picking from it.
  const record = credentialRecord(credentialText({ accessToken: FAKE_TOKEN }));
  assert.deepEqual(Object.keys(record).sort(), ['accessToken', 'expiresAt', 'tier']);
  assert.equal(record.accessToken, FAKE_TOKEN);
  assert.equal(record.tier, 'default_claude_max_20x');
  assert.equal(JSON.stringify(record).includes('refreshToken'), false);

  // And the ways there is no record at all: not JSON, no oauth block, no token.
  assert.equal(credentialRecord('not json'), null);
  assert.equal(credentialRecord('{}'), null);
  assert.equal(credentialRecord(JSON.stringify({ claudeAiOauth: { refreshToken: 'x' } })), null);
  assert.equal(credentialRecord(null), null);
});

test('a scope display name resolves to pinned ids, and an unknown one resolves to none', () => {
  // ADR-004: the adapter holds the harness's model dictionary and resolves a
  // display name into the ids the catalog rates; the resolver matches by exact id
  // and infers no family, so what it is handed has to be ids.
  // "Fable" is a FAMILY window and names both ids the binary serves under it: a
  // tuple on the predecessor spends the same weekly window as one on the successor,
  // and a table naming only the current alias target would leave it bound by none.
  assert.deepEqual(scopeModels('Fable', MODEL_SCOPE_IDS), ['claude-fable-5-1', 'claude-fable-5']);
  assert.deepEqual(scopeModels('opus', MODEL_SCOPE_IDS), ['claude-opus-5']);
  assert.deepEqual(scopeModels('Sonnet', MODEL_SCOPE_IDS), ['claude-sonnet-5']);
  assert.equal(scopeModels('Some Model Nobody Pinned', MODEL_SCOPE_IDS), null);
  assert.equal(scopeModels('', MODEL_SCOPE_IDS), null);
  // A fresh array every time: it travels into a verdict, and a shared one would
  // let a caller edit the table.
  assert.notEqual(scopeModels('Fable', MODEL_SCOPE_IDS), scopeModels('Fable', MODEL_SCOPE_IDS));
});

test('the usage answer becomes three windows: a session, a weekly, and a model-scoped weekly', () => {
  // The lengths are the kinds' own — the payload states neither — and ADR-004
  // requires `lengthSec` on every window, because a pace cannot be computed
  // without one.
  const windows = usageWindows(USAGE, MODEL_SCOPE_IDS);
  assert.deepEqual(windows.map((w) => w.id), ['session', 'weekly', 'weekly-fable']);
  assert.deepEqual(windows.map((w) => w.kind), ['session', 'weekly', 'weekly']);
  assert.deepEqual(windows.map((w) => w.lengthSec), [18_000, 604_800, 604_800]);
  assert.deepEqual(windows.map((w) => w.usedPercent), [8, 44, 38]);
  assert.equal(windows[0].resetAt, '2030-01-01T00:00:00.000Z');
  assert.equal(windows[1].resetAt, '2030-01-04T13:00:00.000Z');
  // The two account-wide rows carry no scope; the scoped one names its model the
  // way the harness does and the ids the driver's table resolves it to.
  assert.equal(windows[0].scope, null);
  assert.equal(windows[1].scope, null);
  assert.deepEqual(windows[2].scope,
    { model: 'Fable', models: ['claude-fable-5-1', 'claude-fable-5'] });
  // And the model's own id in the payload is never read: the fixture holds
  // `<redacted>` there and the window is complete anyway.
  assert.equal(JSON.stringify(windows).includes('<redacted>'), false);
});

test('a scope this adapter cannot resolve keeps its window and binds nothing', () => {
  // ADR-004's own rule: `models` is absent when the display name does not resolve,
  // the window stays in the snapshot and is printed for a person, and it binds no
  // tuple. Dropping it would lose a limit the harness stated.
  const doc = {
    limits: [{
      kind: 'weekly_scoped',
      percent: 12,
      resets_at: '2030-01-04T13:00:00+00:00',
      scope: { model: { id: '<redacted>', display_name: 'Astra 6' } },
    }],
  };
  const [window] = usageWindows(doc, MODEL_SCOPE_IDS);
  assert.equal(window.id, 'weekly-astra-6');
  assert.deepEqual(window.scope, { model: 'Astra 6' });
  assert.equal('models' in window.scope, false);
});

test('rows this adapter cannot place are left out rather than guessed at', () => {
  // A kind nobody measured has no known length, and ADR-004 says an adapter that
  // cannot state a length reports no window. A percentage that is not a number is
  // not a window either — the projection would drop it, and dropping it here is
  // what keeps the count in the message honest.
  const windows = usageWindows({
    limits: [
      { kind: 'monthly_all', percent: 10, resets_at: '2030-01-04T13:00:00+00:00', scope: null },
      { kind: 'session', percent: 'lots', resets_at: '2030-01-01T00:00:00+00:00', scope: null },
      { kind: 'weekly_scoped', percent: 4, resets_at: '2030-01-04T13:00:00+00:00', scope: null },
      { kind: 'weekly_all', percent: 140, resets_at: '2030-01-04T13:00:00+00:00', scope: null },
    ],
  }, MODEL_SCOPE_IDS);
  // Only the last survives, and its percentage is capped rather than dropped: the
  // schema's range ends at 100 and "spent" is what a value past the end means.
  assert.deepEqual(windows.map((w) => w.id), ['weekly']);
  assert.equal(windows[0].usedPercent, 100);
});

test('two rows that would share an id do not: the second is not silently lost', () => {
  const windows = usageWindows({
    limits: [
      { kind: 'weekly_scoped', percent: 10, resets_at: '2030-01-04T13:00:00+00:00', scope: { model: { display_name: 'Fable' } } },
      { kind: 'weekly_scoped', percent: 20, resets_at: '2030-01-04T13:00:00+00:00', scope: { model: { display_name: 'Opus' } } },
    ],
  }, MODEL_SCOPE_IDS);
  assert.deepEqual(windows.map((w) => w.id), ['weekly-fable', 'weekly-opus']);
});

test('only an account-wide window spends the harness; a spent model scope does not', () => {
  // `exhausted` takes every tuple of the harness out of routing, and a
  // `weekly_scoped` row at 100 % says one model family is spent while the rest of
  // the account runs. The spent scope travels as its own `usedPercent`, which is
  // where the resolver reads it per tuple (ADR-004, binding window).
  const scoped = {
    limits: [{
      kind: 'weekly_scoped', percent: 100, resets_at: '2030-01-04T13:00:00+00:00',
      scope: { model: { display_name: 'Fable' } },
    }],
  };
  assert.equal(spentWindow(scoped), null);

  const session = { limits: [{ kind: 'session', percent: 100, resets_at: '2030-01-01T00:00:00+00:00', scope: null }] };
  assert.deepEqual(spentWindow(session), { id: 'session', resetAt: '2030-01-01T00:00:00.000Z' });

  // `locked_reason` is the same fact stated another way: a row the account may not
  // spend at all.
  const locked = {
    limits: [{ kind: 'weekly_all', percent: 3, locked_reason: 'plan_paused', resets_at: '2030-01-04T13:00:00+00:00', scope: null }],
  };
  assert.deepEqual(spentWindow(locked), { id: 'weekly', resetAt: '2030-01-04T13:00:00.000Z' });
  assert.equal(spentWindow(USAGE), null);
});

test('a spent row the harness marks inactive does not exhaust the account, and a locked one does', () => {
  // This is the one place `is_active` is read. Everywhere else the flag adds
  // nothing — every window is carried and the pace is per tuple — but here it is
  // the difference between a limit that is being enforced and one that is not, and
  // reading a spent inactive row as `exhausted` would take every Claude tuple out
  // of routing on a limit nothing is applying.
  //
  // Mutation probe: drop the `is_active !== false` clause and this reddens.
  const inactive = {
    limits: [{ kind: 'weekly_all', percent: 100, is_active: false, resets_at: '2030-01-04T13:00:00+00:00', scope: null }],
  };
  assert.equal(spentWindow(inactive), null);

  // The same row marked active, and the same row with no flag at all: both spend.
  const active = { limits: [{ ...inactive.limits[0], is_active: true }] };
  assert.deepEqual(spentWindow(active), { id: 'weekly', resetAt: '2030-01-04T13:00:00.000Z' });
  const unflagged = { limits: [{ kind: 'weekly_all', percent: 100, resets_at: '2030-01-04T13:00:00+00:00', scope: null }] };
  assert.deepEqual(spentWindow(unflagged), { id: 'weekly', resetAt: '2030-01-04T13:00:00.000Z' });

  // `locked_reason` is a state rather than a moment, so the flag does not qualify
  // it: an inactive locked row is still locked.
  const locked = {
    limits: [{ kind: 'session', percent: 3, locked_reason: 'plan_paused', is_active: false, resets_at: null, scope: null }],
  };
  assert.deepEqual(spentWindow(locked), { id: 'session', resetAt: null });
});

test('logged in with a readable record and a usage answer is available: auth, model and limit confirmed', async () => {
  // The sentence this replaces is ADR-003's, and [03-cli](../docs/reference/03-cli.md)
  // said it too: `available` was a state this harness could not reach. ADR-004
  // supersedes the assumption under it, and the word keeps its meaning — auth,
  // model AND limit confirmed.
  const box = sandbox(`process.stdout.write(${JSON.stringify(AUTH_JSON(true))});`);
  const wired = account({ replies: { [USAGE_URL]: ok(USAGE) } });
  const verdict = await probe(box.host, 15_000, wired.deps);
  assert.equal(verdict.state, 'available');
  assert.equal(verdict.reason, null);
  assert.deepEqual(verdict.tier, { name: 'default_claude_max_20x', source: 'credentials' });
  assert.deepEqual(verdict.windows.map((w) => w.id), ['session', 'weekly', 'weekly-fable']);
  assert.equal(verdict.version, '2.1.251');
  // One request, and it is the usage endpoint: the tier came off the record with
  // no request at all, so the profile is not asked.
  assert.deepEqual(wired.asked.map((a) => a.url), [USAGE_URL]);
});

test('the token reaches one header and nothing else — not the verdict, not the cache', async () => {
  // The whole reason a keychain read is acceptable at all: what comes out of it
  // goes into an Authorization header and stops there. The written snapshot is
  // grepped, not just the message, because `message` is only the field a token
  // would arrive in most obviously.
  const box = sandbox(`process.stdout.write(${JSON.stringify(AUTH_JSON(true))});`);
  const wired = account({ replies: { [USAGE_URL]: ok(USAGE) } });
  const verdict = await probe(box.host, 15_000, wired.deps);
  assert.equal(wired.asked[0].token, FAKE_TOKEN, 'the header did get the token');
  assert.ok(!JSON.stringify(verdict).includes(FAKE_TOKEN), 'the token is in the verdict');

  const snapshot = await preflight({
    host: box.host, harnesses: [CLAUDE], adapterFor: () => adapter(wired.deps),
  });
  assert.equal(snapshot.harnesses[CLAUDE].state, 'available');
  const written = readFileSync(box.host.routingPaths().cacheFile, 'utf8');
  assert.ok(!written.includes(FAKE_TOKEN), 'the token is on disk');
  assert.ok(!written.includes('refreshToken'), 'the refresh token is on disk');
});

test('the headers are the three the endpoints answer to, and the token is in one of them', () => {
  // The beta header is what makes these endpoints answer 200 (measured 2026-09-06
  // on 2.1.251). A probe that lost it would report `quota_unknown` for a perfectly
  // good account, which reads as a harness change rather than as a missing line.
  assert.deepEqual(oauthHeaders(FAKE_TOKEN), {
    authorization: `Bearer ${FAKE_TOKEN}`,
    'anthropic-beta': 'oauth-2025-04-20',
    accept: 'application/json',
  });
});

test('a token past its expiry is quota_unknown with the tier still reported, and never a refresh', async () => {
  // Refreshing rotates the credentials Claude Code itself holds, so a preflight
  // that did it would sign a person out of the session they are working in. The
  // tier survives because it is known offline: an expired token does not unknow it.
  const box = sandbox(`process.stdout.write(${JSON.stringify(AUTH_JSON(true))});`);
  const wired = account({
    credential: credentialText({ accessToken: FAKE_TOKEN, expiresAt: Date.now() - 1000 }),
    replies: { [USAGE_URL]: ok(USAGE) },
  });
  const verdict = await probe(box.host, 15_000, wired.deps);
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.reason, 'quota_unknown');
  assert.deepEqual(verdict.tier, { name: 'default_claude_max_20x', source: 'credentials' });
  assert.equal(verdict.windows, undefined);
  assert.match(verdict.message, /never refreshes/);
  assert.deepEqual(wired.asked, [], 'no endpoint was asked at all');
});

test('no credential record is quota_unknown, and nothing is claimed about the login', async () => {
  // The binary already answered the auth question. A keychain that refused, an
  // item that is not there and a file that is not there are one fact to the
  // caller — no token — and the diagnosis is about the limit.
  const box = sandbox(`process.stdout.write(${JSON.stringify(AUTH_JSON(true))});`);
  const verdict = await probe(box.host, 15_000, { readCredential: async () => null });
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.reason, 'quota_unknown');
  assert.match(verdict.message, /credential record could not be read/);
  assert.equal(verdict.tier, undefined);
  // The inventory is still reported: it is the driver's fact, not the account's.
  assert.deepEqual(verdict.models.map((m) => m.model),
    ['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5',
      'fable', 'opus', 'sonnet']);
});

test('a usage endpoint that refuses the token is not_authenticated, not a quota mystery', async () => {
  // The binary says logged in and the endpoint refuses the credentials it holds.
  // 401 and 403 are the two statuses that are a statement about the ACCOUNT rather
  // than about the request, and they are the ones PB-26 names.
  const box = sandbox(`process.stdout.write(${JSON.stringify(AUTH_JSON(true))});`);
  for (const status of [401, 403]) {
    const wired = account({ replies: { [USAGE_URL]: { status, doc: null } } });
    const verdict = await probe(box.host, 15_000, wired.deps);
    assert.equal(verdict.state, 'unavailable', `status ${status}`);
    assert.equal(verdict.reason, 'not_authenticated', `status ${status}`);
    assert.match(verdict.message, /claude auth login/);
  }
});

test('a usage endpoint that answers something else keeps the harness unknown, never unavailable', async () => {
  // A 500 or a body that is not JSON says nothing about the account. Calling it
  // `not_authenticated` would take every Claude tuple out of routing on the
  // strength of a bad afternoon at the other end.
  const box = sandbox(`process.stdout.write(${JSON.stringify(AUTH_JSON(true))});`);
  const wired = account({ replies: { [USAGE_URL]: { status: 500, doc: null } } });
  const verdict = await probe(box.host, 15_000, wired.deps);
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.reason, 'quota_unknown');
  assert.deepEqual(verdict.tier, { name: 'default_claude_max_20x', source: 'credentials' });
});

test('a usage endpoint that does not answer in time is probe_timeout; one that cannot be reached is probe_failed', async () => {
  // Two different things to do about them, so two codes: the cache retries a
  // timeout in five minutes, and a machine with no route to the endpoint is not
  // the budget being short.
  const box = sandbox(`process.stdout.write(${JSON.stringify(AUTH_JSON(true))});`);
  const slow = account({ replies: { [USAGE_URL]: { error: 'timeout' } } });
  assert.equal((await probe(box.host, 15_000, slow.deps)).reason, 'probe_timeout');
  const gone = account({ replies: { [USAGE_URL]: { error: 'network' } } });
  assert.equal((await probe(box.host, 15_000, gone.deps)).reason, 'probe_failed');
});

test('an account-wide window at 100 % is exhausted, and it carries the reset it named', async () => {
  const box = sandbox(`process.stdout.write(${JSON.stringify(AUTH_JSON(true))});`);
  // `is_active: true` beside the 100 %: the fixture's session row is the inactive
  // one, and an inactive spent row is deliberately not an exhaustion — the check
  // above this file's account section is the one that holds that apart.
  const spent = {
    ...USAGE,
    limits: USAGE.limits.map((row) => (row.kind === 'session' ? { ...row, percent: 100, is_active: true } : row)),
  };
  const wired = account({ replies: { [USAGE_URL]: ok(spent) } });
  const verdict = await probe(box.host, 15_000, wired.deps);
  assert.equal(verdict.state, 'exhausted');
  assert.equal(verdict.reason, 'subscription_exhausted');
  assert.equal(verdict.resetAt, '2030-01-01T00:00:00.000Z');
  // The windows are still reported: an exhausted harness is the one a person most
  // wants the numbers for.
  assert.deepEqual(verdict.windows.map((w) => w.usedPercent), [100, 44, 38]);
});

test('the profile is asked for the tier only when the record names none, and then the source says probe', async () => {
  // ADR-004 closes `source` to four names, and which one it is says where the
  // value came from: `credentials` is the record read offline, `probe` is the
  // harness having been asked.
  const box = sandbox(`process.stdout.write(${JSON.stringify(AUTH_JSON(true))});`);
  const wired = account({
    credential: credentialText({ accessToken: FAKE_TOKEN, rateLimitTier: undefined }),
    replies: { [USAGE_URL]: ok(USAGE), [PROFILE_URL]: ok(PROFILE) },
  });
  const verdict = await probe(box.host, 15_000, wired.deps);
  assert.deepEqual(verdict.tier, { name: 'default_claude_max_20x', source: 'probe' });
  assert.deepEqual(wired.asked.map((a) => a.url), [USAGE_URL, PROFILE_URL]);
});

test('a profile that refuses costs the tier and nothing else', async () => {
  const box = sandbox(`process.stdout.write(${JSON.stringify(AUTH_JSON(true))});`);
  const wired = account({
    credential: credentialText({ accessToken: FAKE_TOKEN, rateLimitTier: undefined }),
    replies: { [USAGE_URL]: ok(USAGE), [PROFILE_URL]: { status: 500, doc: null } },
  });
  const verdict = await probe(box.host, 15_000, wired.deps);
  assert.equal(verdict.tier, undefined);
  assert.equal(verdict.state, 'available');
  assert.equal(verdict.windows.length, 3);
});

test('the scope table is the driver\'s, and every name in it is one the driver publishes', () => {
  // The table used to be a copy inside the adapter, which is a copy of a
  // dictionary that gets repinned: a scope resolving to a stale id binds no row
  // and prints no complaint, so nothing would have gone red. It travels as an
  // argument now, and this is the check that keeps the two halves in step.
  //
  // Mutation probe: add a key to `MODEL_SCOPE_IDS` that is not an alias, or point
  // one at an id nobody publishes, and this reddens.
  for (const name of Object.keys(MODEL_SCOPE_IDS)) {
    assert.ok(MODEL_ALIASES.includes(name), `${name} is not one of MODEL_ALIASES`);
  }
  // Every id the table names is one the driver publishes. `claude-fable-5` was an
  // exception here while PB-29 was in flight — the check asserted that the
  // exception was still needed, so the day the catalog landed the id the check
  // reddened and the exception went (PB-26.2).
  for (const ids of Object.values(MODEL_SCOPE_IDS)) {
    for (const id of ids) {
      assert.ok(MODEL_IDS.includes(id), `${id} is not an id the driver publishes`);
    }
  }
});

test('a spent window the harness gave no reset for says so, and names the way out', async () => {
  // An exhaustion with no `resetAt` is STICKY — `entryExpiry` gives it Infinity and
  // `--refresh` does not drop it — and the likeliest input is exactly a
  // `locked_reason` row, which the endpoint may state with no `resets_at` at all.
  // A message promising "until it resets" would leave a person waiting for a
  // moment nobody named.
  const box = sandbox(`process.stdout.write(${JSON.stringify(AUTH_JSON(true))});`);
  const locked = {
    limits: [{ kind: 'weekly_all', percent: 12, locked_reason: 'plan_paused', resets_at: null, scope: null }],
  };
  const wired = account({ replies: { [USAGE_URL]: ok(locked) } });
  const verdict = await probe(box.host, 15_000, wired.deps);
  assert.equal(verdict.state, 'exhausted');
  assert.equal(verdict.reason, 'subscription_exhausted');
  assert.equal(verdict.resetAt, null);
  assert.match(verdict.message, /named no reset/);
  assert.match(verdict.message, /--clear-exhausted claude/);

  // And the cache really does treat it as sticky, which is what the message is
  // about: the entry outlives every TTL there is.
  const snapshot = await preflight({
    host: box.host, harnesses: [CLAUDE], adapterFor: () => adapter(wired.deps),
  });
  const entry = snapshot.harnesses[CLAUDE];
  assert.equal(stickyExhaustion(entry), true);
  assert.equal(entryLive(entry, Date.now() + 40 * 24 * 3600 * 1000), true);
});

test('the credentials file follows CLAUDE_CONFIG_DIR, which is what moves the harness directory', () => {
  // The driver's own `claudeHome` honours it, and a probe that looked under
  // `~/.claude` on a machine where the harness does not would report
  // `quota_unknown` for an account that is perfectly fine.
  assert.equal(credentialFile({}, '/home/someone'), path.join('/home/someone', '.claude', '.credentials.json'));
  assert.equal(credentialFile({ CLAUDE_CONFIG_DIR: '/elsewhere/claude' }, '/home/someone'),
    path.join('/elsewhere/claude', '.credentials.json'));
  assert.equal(credentialFile({ CLAUDE_CONFIG_DIR: '   ' }, '/home/someone'),
    path.join('/home/someone', '.claude', '.credentials.json'));
});

test('a record with no expiry is not an expired token', async () => {
  // `Number(null)`, `Number('')` and `Number(false)` are all 0, so a record whose
  // expiry is absent would read as a token that ran out in 1970 and the harness
  // would go `quota_unknown` for a credential that works.
  for (const expiresAt of [undefined, null, '', false]) {
    const record = credentialRecord(credentialText({ accessToken: FAKE_TOKEN, expiresAt }));
    assert.equal(record.expiresAt, null, String(expiresAt));
  }
  const box = sandbox(`process.stdout.write(${JSON.stringify(AUTH_JSON(true))});`);
  const wired = account({
    credential: credentialText({ accessToken: FAKE_TOKEN, expiresAt: null }),
    replies: { [USAGE_URL]: ok(USAGE) },
  });
  const verdict = await probe(box.host, 15_000, wired.deps);
  assert.equal(verdict.state, 'available', verdict.message);
});

test('a usage answer with no row this adapter places is quota_unknown, with the tier', async () => {
  // The endpoint answered and named nothing placeable — a `limits[]` of kinds
  // nobody measured, or none at all. The limit is then as unknown as it was before
  // the call, and `available` would claim it was confirmed.
  const box = sandbox(`process.stdout.write(${JSON.stringify(AUTH_JSON(true))});`);
  const wired = account({ replies: { [USAGE_URL]: ok({ limits: [{ kind: 'monthly_all', percent: 3 }] }) } });
  const verdict = await probe(box.host, 15_000, wired.deps);
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.reason, 'quota_unknown');
  assert.match(verdict.message, /named no limit window/);
  assert.deepEqual(verdict.tier, { name: 'default_claude_max_20x', source: 'credentials' });
  assert.equal(verdict.windows, undefined);
});

test('a budget spent inside the account half asks no endpoint at all', async () => {
  // A probe past its deadline holding a command is what the whole budget exists to
  // prevent, and the account half checks the clock twice — before the credential
  // read and again before the usage call. The second is the one a check can drive
  // without racing the auth stub, and the two guards are the same line one step
  // apart. The tier still travels: it came off the record, offline, before the
  // clock ran out.
  const box = sandbox(`process.stdout.write(${JSON.stringify(AUTH_JSON(true))});`);
  const wired = account({ replies: { [USAGE_URL]: ok(USAGE) } });
  const slow = {
    ...wired.deps,
    // The stub sleeps past whatever is LEFT of the budget rather than past a
    // number written here: the adapter hands it the remainder, so this outlives
    // the deadline whatever the real `node` spawn above it cost. A fixed sleep
    // raced against that spawn, and under a loaded pool the race went the other
    // way.
    readCredential: async ({ timeoutMs: leftMs }) => {
      await new Promise((r) => { setTimeout(r, Math.max(0, leftMs) + 50); });
      return credentialText({ accessToken: FAKE_TOKEN });
    },
  };
  const verdict = await probe(box.host, 5_000, slow);
  assert.equal(verdict.reason, 'quota_unknown', verdict.message);
  assert.match(verdict.message, /budget ran out/);
  assert.deepEqual(verdict.tier, { name: 'default_claude_max_20x', source: 'credentials' });
  assert.deepEqual(wired.asked, [], 'an endpoint was asked past the deadline');
});

test('the driver wires the live keychain read and the live endpoint, and hands over its own inventory', () => {
  // The suite builds this adapter with the account half stubbed, so the wiring the
  // person actually runs is pinned here, as source — the same way the lift hook's
  // wiring is pinned at the foot of this file. Two halves: the inventory the
  // driver derives, and the declaration that hands it over with no `deps`, which
  // is what leaves the live implementations in place.
  const driver = readFileSync(path.join(here, '..', 'lib', 'driver-claude.js'), 'utf8');
  assert.match(driver, /const PROBE_MODELS = \[\.\.\.new Set\(\[\.\.\.MODEL_IDS, \.\.\.MODEL_ALIASES, DEFAULT_MODEL\]\)\];/);
  assert.match(driver, /availability: claudeAvailability\(PROBE_MODELS, MODEL_SCOPE_IDS\),/);
});

// --- the late-start hook ------------------------------------------------------

test('a limit refusal that names no reset is manual_exhaustion, and it is sticky', async () => {
  const box = sandbox('');
  const note = markLimitAtStart(box.host, "Claude usage limit reached — you've hit your weekly limit.");
  const entry = readSnapshot(box.host).harnesses[CLAUDE];
  assert.equal(entry.state, 'exhausted');
  assert.equal(entry.reason, 'manual_exhaustion');
  assert.equal(entry.resetAt, null);
  assert.ok(note.includes(box.host.routingPaths().cacheFile), note);
  assert.match(note, /--clear-exhausted claude/);
});

test('a limit refusal that says the limit resets is subscription_exhausted, still with no reset time', async () => {
  // Which alternation of the driver's pattern matched chooses the code: the
  // harness saying the limit RESETS makes the exhaustion the subscription's.
  // `resetAt` stays null either way — the reset is named in a person's words and
  // a person's timezone, and a timestamp parsed out of that would be invented, so
  // both kinds wait for `--clear-exhausted` rather than lifting themselves at a
  // made-up moment.
  const box = sandbox('');
  markLimitAtStart(box.host, 'Your limit resets at 3pm.');
  const entry = readSnapshot(box.host).harnesses[CLAUDE];
  assert.equal(entry.state, 'exhausted');
  assert.equal(entry.reason, 'subscription_exhausted');
  assert.equal(entry.resetAt, null);
  assert.equal(entryLive(entry, Date.now() + 40 * 24 * 3600 * 1000), true, 'sticky: no TTL lifts it');
  assert.equal(stickyExhaustion(entry), true);
});

test('the refusal line names the file the mark went into and the way out of it', async () => {
  // The mark lands in a file nothing reads yet and no flag clears yet. A refusal
  // that did not name it would leave a person with a state they never saw and no
  // way to find it.
  const box = sandbox('');
  const note = markLimitAtStart(box.host, "you've hit your limit");
  assert.ok(note.includes(box.host.routingPaths().cacheFile), note);
  assert.match(note, /marked exhausted/);
  assert.match(note, /neither time nor a later probe/);
  assert.match(note, /delete that harness entry/);
});

test('a refusal that is not a limit writes nothing at all and adds no line', async () => {
  // The pattern is the driver's own, and it is narrow on purpose: catching a
  // refusal with a loose template would call every failed lift a spent limit and
  // leave the harness exhausted until a person cleared it by hand.
  const box = sandbox('');
  assert.equal(markLimitAtStart(box.host, 'claude --bg exited with code 1: EACCES'), '');
  assert.equal(readSnapshot(box.host), null);
});

test('the harness output itself does not reach the mark', async () => {
  const box = sandbox('');
  markLimitAtStart(box.host, "you've hit your limit, contact someone@example.invalid");
  const written = readFileSync(box.host.routingPaths().cacheFile, 'utf8');
  assert.ok(!written.includes('someone@example.invalid'), written);
});

test('the hook survives a host that cannot be written to, and says so by adding no line', async () => {
  // A cache failure must not replace the refusal the person is about to read: the
  // lift is already going to end with "your participant did not start", and losing
  // that diagnosis to a write error would leave them with nothing.
  const broken = { routingPaths: () => { throw new Error('no paths'); } };
  assert.equal(markLimitAtStart(broken, "you've hit your limit"), '');
  assert.equal(markLimitAtStart(null, "you've hit your limit"), '');
});

// --- the wiring ---------------------------------------------------------------

test('the driver declares the adapter, and the registry door hands out that one', async () => {
  const { adapterOf } = await import('../lib/drivers.js');
  assert.equal(typeof claudeDriver.availability?.probe, 'function');
  const verdict = await ask(adapterOf(CLAUDE), null, 1);
  // Not the registry's stand-in for a driver with no adapter: that one says so in
  // its message, and this one is the driver's own.
  assert.ok(!verdict.message.includes('no availability adapter'), verdict.message);
});

test('a lift refused on a spent limit leaves as a typed limit-hit-at-start', async () => {
  // The code was published in `ERROR_CODES` and in the reference and nothing raised
  // it: the refusal ended through `fail()`, so a consumer had a vocabulary it could
  // not branch on (PB-21.1). What the PERSON reads is unchanged — the CLI catch
  // prints a `PromptobusError` as one line and exits 1, exactly as `fail` does — so
  // this is the check that says the code is on it.
  //
  // Mutation probe: put `fail(said)` back on the limit branch and the whole FILE
  // goes red (measured: `node --test` exits 1 with "test failed" and no summary) —
  // `fail` is `process.exit(1)`, so the run dies inside this check instead of a
  // refusal reaching it, which is the same reason the classification cannot live in
  // a caller.
  const box = sandbox('process.stderr.write("Claude usage limit reached — you\'ve hit your weekly limit.");\n'
    + 'process.exit(1);');
  const refusal = await liftoffParticipant({
    tool: box.host.resolveToolBin(CLAUDE),
    argv: ['--bg', 'prompt'],
    cwd: box.dir,
    env: process.env,
    name: 'worker-limit',
    role: 'worker',
    persist: () => {},
    awaitOptions: { tries: 1, delayMs: 0, sessions: () => [] },
    sayLimit: (output) => markLimitAtStart(box.host, output),
  }).then(() => null, (e) => e);

  assert.ok(refusal, 'the lift did not refuse at all');
  assert.equal(refusal.constructor.name, 'PromptobusError');
  assert.equal(refusal.code, 'limit-hit-at-start');
  // The diagnosis is the whole message, mark and all: the code is added to what the
  // person was already told, not put in place of it.
  assert.match(refusal.message, /exited with code 1/);
  assert.match(refusal.message, /--clear-exhausted/);
  // And the mark the refusal names is really there.
  assert.equal(readSnapshot(box.host).harnesses[CLAUDE].state, 'exhausted');
});

test('the lift passes the late-start hook down to the launcher and appends what it returns', () => {
  // The hook has to be handed to `liftoffParticipant`, not called by a caller
  // catching a refusal: `fail` ends the process, and past that line there is
  // nobody left to classify anything.
  //
  // Counting the CALLS is not enough — a first version of this check did that and
  // stayed green when the returned line was dropped from the refusal text. So both
  // halves are counted: two branches take the line, and two branches append it,
  // which is four mentions of the variable and no fewer.
  const driver = readFileSync(path.join(here, '..', 'lib', 'driver-claude.js'), 'utf8');
  assert.match(driver, /sayLimit: \(output\) => markLimitAtStart\(host, output\)/);
  const liftoff = readFileSync(path.join(here, '..', 'lib', 'liftoff.js'), 'utf8');
  assert.equal((liftoff.match(/sayLimit\?\.\(output\)/g) ?? []).length, 2, 'both refusal branches report');
  assert.equal((liftoff.match(/\$\{limitNote\}|\+ deadNote \+ limitNote/g) ?? []).length, 2,
    'both branches put the returned line in their refusal');
  // And both leave with the code when there was something to mark: a published
  // routing code nothing raises is a vocabulary a consumer cannot branch on
  // (PB-21.1). The refusal a person reads is unchanged — the CLI catch prints a
  // `PromptobusError` as one line and exits 1, exactly as `fail` does.
  assert.equal((liftoff.match(/if \(limitNote\) throw new PromptobusError\('limit-hit-at-start', said\);/g) ?? []).length, 2,
    'both branches raise the code when the hook marked something');
});
