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

import { CLAUDE, DEFAULT_MODEL, claudeDriver, markLimitAtStart } from '../lib/driver-claude.js';
import { liftoffParticipant } from '../lib/liftoff.js';
import { claudeAvailability } from '../lib/model-routing/adapter-claude.js';
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

/** The adapter as the driver declares it — the object the preflight would reach through the registry. */
const adapter = () => claudeDriver.availability;

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
const probe = (host, timeoutMs = 15_000) => ask(adapter(), host, timeoutMs);

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
  // that. The two ids are the full names the catalog rates — a catalog row and an
  // inventory that disagreed would exclude every Claude tuple as
  // `model-not-in-inventory` and blame the catalog for it (PB-13.1) — and the three
  // aliases are what `claude --help` prints under `--model` on 2.1.251, measured
  // 2026-09-05. So the ids, the alias set and the default model that feed the
  // inventory are pinned through one check.
  const box = sandbox(`process.stdout.write(${JSON.stringify(AUTH_JSON(true))});`);
  const verdict = await probe(box.host);
  assert.deepEqual(verdict.models.map((m) => m.model),
    ['claude-opus-5', 'claude-sonnet-5', 'fable', 'opus', 'sonnet']);
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
  const verdict = await ask(claudeAvailability(['only-this-one']), box.host, 15_000);
  assert.deepEqual(verdict.models, [{ model: 'only-this-one' }]);
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
