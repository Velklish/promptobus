// Claude Code availability adapter: what the account can do with the `claude`
// binary on this machine, right now. The verdict shape and the rules it answers
// under are the contract ([model-routing.ts](../../src/model-routing.ts)); this
// file is only the harness half of it.
//
// The whole probe is TWO reads and no turn. Binary and version come from the host
// (`resolveToolBin`) — ADR-003 says an adapter reports `binary_missing` from its
// verdict rather than searching `PATH` itself — and auth comes from `claude auth
// status --json`, the one non-interactive check the binary offers today.
// Measured 2026-09-05 on `claude` 2.1.251: three runs, 0.86 / 1.17 / 1.36 s wall,
// exit 0, a JSON object whose `loggedIn` boolean is what is read below.
//
// **The auth check is spawned asynchronously, and that is not a style choice.**
// The preflight runs the adapters together and holds ONE budget beside them, as a
// timer racing their promises. A `spawnSync` here would block the event loop for
// its whole run, so that timer could not fire while this adapter worked and each
// blocking adapter would get the full budget again after its neighbours — the
// ceiling of the run would become their sum, which is the opposite of what
// `timeoutMs` promises. So: `spawn`, a deadline taken as the first line of the
// probe, and a kill of our own when it passes. The suite watches this with a
// check that a timer scheduled beside the probe still fires while it runs.
//
// **Nothing here runs `claude` with a bare word.** An unrecognised word after the
// binary name is not an unknown subcommand — it is taken as a PROMPT, and a probe
// that guessed at one would start a paid turn on the person's plan. So the argv is
// a subcommand `claude --help` lists with flags `claude auth status --help` lists,
// and a probe that wants a new fact reads those helps first.
//
// **The inventory is not a listing.** The binary publishes no model list at all:
// no `models` subcommand and no `--list-models` (measured 2026-09-05 by the
// catalog track on the same build). The only names it publishes are the `--model`
// aliases in its help text, so the inventory reported here is the driver's own
// alias set, handed in by the driver — which owns it next to the default model it
// lifts participants on. That is why the models arrive as an argument instead of
// being imported: the driver is private to the registry, and a module of the
// mechanism reaching into it is exactly the crossing the boundary gate refuses
// ([promptobus-adapter.test.mjs](../../test/promptobus-adapter.test.mjs)).
//
// **Where the tier and the windows come from, measured 2026-09-06 on 2.1.251.**
// ADR-003 recorded an assumption — this harness exposes no remaining limit — and
// [ADR-004](../../docs/adr/adr-004-subscription-balance.md) supersedes it: the
// source Claude Code's own `/usage` command reads is reachable with the
// credentials the CLI already holds, and costs no turn.
//
//   • **the tier is offline.** The credential record — a keychain generic
//     password on macOS, `~/.claude/.credentials.json` elsewhere — carries
//     `rateLimitTier` beside the token, so `{ name, source: 'credentials' }` needs
//     no request at all. `/api/oauth/profile` is asked for it ONLY when the record
//     names none, and then the source is `probe`;
//   • **the windows are one GET.** `/api/oauth/usage` answers `limits[]`, whose
//     rows are `session`, `weekly_all` and `weekly_scoped` — the last one a
//     per-model weekly row that names its model by DISPLAY name. The lengths are
//     the kinds' own (five hours, seven days) and `percent` is the used share.
//
// So `available` is reachable now, and the word keeps its meaning: auth, model AND
// limit confirmed. A logged-in account whose limit could not be read is still
// `unknown` / `quota_unknown`, which the resolver penalises by ten points instead
// of dropping the harness.
//
// **The token is read, used once as a header, and never written or refreshed.**
// `refreshToken` is not even parsed out of the record — `credentialRecord` below
// picks three fields and no more — and a token past its `expiresAt` answers
// `quota_unknown` with the tier still
// reported — never a refresh, because refreshing rotates the person's credentials
// under Claude Code's feet. Nothing token-shaped reaches a verdict, a message or
// the cache.
//
// **The keychain read and the HTTP call arrive as parameters**, the way the Codex
// adapter takes its launch context: `claudeAvailability` defaults them to the live
// implementations, and the suite hands in its own — so no test touches the network
// or the person's keychain, and the seam is the same one the binaries already use.
//
// What of the auth answer reaches the verdict is ONE boolean. The same JSON also
// carries an email address, an organisation id and its name, and none of them may
// travel: `message` is the only free-text field that reaches disk, and the cache
// promises to hold no email and no open account id.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { planRun } from '../exec.js';
import { stampAtMs } from './cache.js';

/** The binary. The same name is what the host is asked to resolve. */
const TOOL = 'claude';

/**
 * The auth check, whole. `--json` is that subcommand's documented default and is
 * named anyway: a default that flips in a later build would turn the parse below
 * into a silent `quota_unknown`, and one flag is cheaper than that.
 */
const AUTH_ARGV = ['auth', 'status', '--json'];

/**
 * The credential record on macOS: one keychain generic password, whose service
 * name Claude Code writes and whose account is the OS user.
 *
 * `/usr/bin/security` by absolute path rather than by name. Every other binary in
 * this package is resolved by the host, deliberately; this one is a platform tool
 * on a fixed path, and a `security` picked up from `PATH` would be whatever a
 * person's shell profile put in front of it — which is a poor thing to hand a
 * request for a token. `-w` prints the value and nothing else.
 */
const SECURITY_BIN = '/usr/bin/security';
const CREDENTIAL_SERVICE = 'Claude Code-credentials';
const CREDENTIAL_ARGV = ['find-generic-password', '-s', CREDENTIAL_SERVICE, '-w'];

/**
 * The credential record everywhere else. Read if present and no more: the Linux
 * path was NOT measured by the spike of 2026-09-06, so the reference says so
 * rather than this file pretending otherwise.
 *
 * `CLAUDE_CONFIG_DIR` moves the whole directory, and the driver's own `claudeHome`
 * honours it — a probe that looked under `~/.claude` on a machine where the
 * harness does not would report `quota_unknown` for an account that is fine. The
 * variable is read here rather than the driver imported: the dependency runs one
 * way, driver → adapter, and one environment variable is not a dictionary.
 */
const CREDENTIAL_DIR_ENV = 'CLAUDE_CONFIG_DIR';
const CREDENTIAL_HOME = '.claude';
const CREDENTIAL_NAME = '.credentials.json';

/** Where the record lives on a platform whose credentials are a file. */
export function credentialFile(env = process.env, home = homedir()) {
  const named = typeof env?.[CREDENTIAL_DIR_ENV] === 'string' ? env[CREDENTIAL_DIR_ENV].trim() : '';
  return path.join(named || path.join(home, CREDENTIAL_HOME), CREDENTIAL_NAME);
}

/** The two endpoints, and the beta header both of them want. */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const OAUTH_BETA = 'oauth-2025-04-20';

/**
 * Window lengths by kind. They are the kinds' own — a session window is five
 * hours and a weekly one is seven days — and the payload states neither, which is
 * why they are written here once instead of being derived from two `resets_at`
 * moments. ADR-004 requires `lengthSec` on every window: an adapter that cannot
 * state a length reports no window at all.
 */
const SESSION_LENGTH_SEC = 18_000;
const WEEKLY_LENGTH_SEC = 604_800;

/**
 * The three `limits[]` rows this adapter places, and what each becomes. A row of
 * any other kind is left out rather than guessed at: the endpoint is not a
 * published contract, and a kind nobody measured is not a window whose length is
 * known.
 */
const WINDOW_KINDS = {
  session: { id: 'session', kind: 'session', lengthSec: SESSION_LENGTH_SEC },
  weekly_all: { id: 'weekly', kind: 'weekly', lengthSec: WEEKLY_LENGTH_SEC },
  weekly_scoped: { id: 'weekly', kind: 'weekly', lengthSec: WEEKLY_LENGTH_SEC },
};

/**
 * A moment as the snapshot writes them, or `null` when the value is not one.
 *
 * `resets_at` arrives as ISO-8601 with an offset (`…+00:00`) and sometimes with
 * microseconds; the snapshot's own form is UTC with milliseconds. The UNIT is
 * this adapter's fact and the range check and the formatting are shared
 * (`stampAtMs` in [cache.js](cache.js)), because all three adapters need the
 * second half and disagree only about the first. A number is refused rather than
 * guessed at: this endpoint names moments in strings, and reading one as
 * milliseconds or as seconds would be a choice nobody measured.
 */
export function stampOf(value) {
  return typeof value === 'string' ? stampAtMs(Date.parse(value)) : null;
}

/**
 * The model ids a scope's display name resolves to, or `null` when it resolves to
 * none.
 *
 * A `weekly_scoped` row names its model the way a person reads it — "Fable" — and
 * ADR-004 asks the adapter to resolve that into ids, because the resolver matches
 * by exact id and infers no family. **The table is the driver's** and arrives as
 * an argument, beside the inventory and for the same reason: it is one more
 * reading of the dictionary the driver owns, and a copy of it here would go on
 * naming an id nobody points at after a repin — silently, because a scope
 * resolving to a stale id binds no row and prints no complaint.
 *
 * A name the table does not carry resolves to `null`: the window then stays in
 * the snapshot, is printed for a person, and binds nothing, which is ADR-004's
 * own rule and why the table may be short without being wrong.
 *
 * The answer is a fresh array on every call: it travels into a verdict, and a
 * shared one would let a caller edit the driver's table.
 */
export function scopeModels(displayName, table) {
  const key = String(displayName ?? '').trim().toLowerCase();
  const ids = table?.[key];
  return Array.isArray(ids) && ids.length ? [...ids] : null;
}

/** A display name as a window id fragment: lower case, one dash between words. */
const slug = (name) => String(name).trim().toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Three fields of the credential record, and no fourth.
 *
 * The shape is the enforcement: `refreshToken` is never read, so it cannot be
 * carried by accident into a message, a log line or a cache file. `accessToken`
 * is the one value with a use — a single `Authorization` header — and a record
 * without one is not a record this adapter can do anything with.
 */
export function credentialRecord(text) {
  let doc = null;
  try {
    doc = JSON.parse(String(text ?? ''));
  } catch {
    return null;
  }
  const oauth = doc?.claudeAiOauth;
  if (!oauth || typeof oauth !== 'object') return null;
  const accessToken = typeof oauth.accessToken === 'string' && oauth.accessToken.trim()
    ? oauth.accessToken.trim()
    : null;
  if (!accessToken) return null;
  // `typeof` first: `Number(null)`, `Number('')` and `Number(false)` are all 0,
  // and a record whose expiry is absent would then read as a token that expired in
  // 1970 — the harness would go `quota_unknown` for a perfectly good credential.
  const expiresAt = typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt)
    ? oauth.expiresAt
    : null;
  const tier = typeof oauth.rateLimitTier === 'string' && oauth.rateLimitTier.trim()
    ? oauth.rateLimitTier.trim()
    : null;
  return { accessToken, expiresAt, tier };
}

/**
 * The usage answer as ADR-004 windows.
 *
 * `limits[]` is the general shape and the only one read: the top-level `five_hour`
 * and `seven_day` objects duplicate two of its rows, and the neighbouring keys with
 * odd names are experiments. A row whose `percent` is not a number is not a window
 * and is left out — the snapshot projection would drop it anyway, and dropping it
 * here is what keeps the count in the message honest.
 *
 * `usedPercent` is capped at 100 rather than dropped above it. The schema's range
 * ends there, and "spent" is what a value past the end means; losing the window
 * would lose the fact along with the number.
 *
 * A `weekly_scoped` row takes its id from the model's display name, because two
 * scoped rows would otherwise collide on `weekly` and the second would be dropped
 * as a duplicate.
 *
 * **`is_active` is read by nothing here, and that is not an oversight.** It marks
 * the row that binds RIGHT NOW, which is a question the snapshot does not ask an
 * adapter: every window is carried, ADR-003 takes `remaining` as the largest
 * `usedPercent` over the applicable ones and ADR-004 names the binding window per
 * candidate tuple. A flag saying which row binds the account as a whole would be a
 * second, coarser answer to a question two consumers already answer per tuple.
 */
export function usageWindows(usage, scopeTable) {
  const rows = Array.isArray(usage?.limits) ? usage.limits : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const shape = WINDOW_KINDS[row?.kind];
    if (!shape) continue;
    const percent = Number(row?.percent);
    if (!Number.isFinite(percent) || percent < 0) continue;
    const window = {
      id: shape.id,
      kind: shape.kind,
      lengthSec: shape.lengthSec,
      usedPercent: Math.min(100, percent),
      resetAt: stampOf(row?.resets_at),
      scope: null,
    };
    if (row.kind === 'weekly_scoped') {
      const display = typeof row?.scope?.model?.display_name === 'string'
        ? row.scope.model.display_name.trim()
        : '';
      // A scoped row that does not name its model is not placeable: it would sit
      // in the snapshot as a second `weekly` window covering nothing, and the
      // resolver would have no way to tell which tuples it binds.
      if (!display || !slug(display)) continue;
      window.id = `weekly-${slug(display)}`;
      window.scope = { model: display };
      const models = scopeModels(display, scopeTable);
      if (models) window.scope.models = models;
    }
    if (seen.has(window.id)) continue;
    seen.add(window.id);
    out.push(window);
  }
  return out;
}

/**
 * The account-wide row that is spent, or `null` when none is.
 *
 * **Account-wide only**, and that is a reading of ADR-004 rather than of PB-26's
 * one sentence about "a window at 100 %". `exhausted` is a statement about the
 * HARNESS — it takes every tuple on it out of routing — and a `weekly_scoped` row
 * at 100 % says one model family is spent while the rest of the account runs. A
 * spent scope travels as the window's own `usedPercent`, which is where the
 * resolver reads it per tuple; a spent session or weekly-all window is the
 * account, and that is this verdict.
 *
 * **`is_active: false` on a percentage is not an exhaustion**, and this is the one
 * place the flag is read. The paragraph above says the flag adds nothing to a
 * WINDOW, and it does not — every window is carried and the pace is computed per
 * tuple. It says something here: a row the harness marks inactive is one that is
 * not binding the account right now, and reading a spent inactive row as
 * `exhausted` would take every Claude tuple out of routing on a limit that is not
 * being enforced. So a percentage exhausts only a row the harness has not marked
 * inactive.
 *
 * `locked_reason` is a separate fact and is NOT qualified by the flag: it is the
 * endpoint saying the account may not spend that row at all, which is a state
 * rather than a moment, and an inactive locked row is still locked.
 */
export function spentWindow(usage) {
  const rows = Array.isArray(usage?.limits) ? usage.limits : [];
  for (const row of rows) {
    if (row?.kind !== 'session' && row?.kind !== 'weekly_all') continue;
    const locked = typeof row?.locked_reason === 'string' && row.locked_reason.trim();
    const full = Number(row?.percent) >= 100 && row?.is_active !== false;
    if (!locked && !full) continue;
    return { id: WINDOW_KINDS[row.kind].id, resetAt: stampOf(row?.resets_at) };
  }
  return null;
}

/**
 * A launch failure or signal name, when it has the shape of a code.
 *
 * The same rule the preflight applies to an adapter's own codes: a value is
 * echoed into a diagnosis only through the shape a code has. `ENOENT`, `ETIMEDOUT`
 * and `SIGSEGV` are worth telling apart by eye, and nothing else from a failed
 * launch is quoted.
 */
const ERRNO = /^[A-Z][A-Z0-9_]{1,20}$/;
const codeOf = (value) => (ERRNO.test(String(value ?? '')) ? String(value) : null);

/** One verdict of this adapter. `source` is `probe` on every branch: this run asked the harness. */
function verdict(state, reason, message, extra = {}) {
  return {
    state,
    reason,
    message,
    checkedAt: new Date().toISOString(),
    source: 'probe',
    resetAt: null,
    ...extra,
  };
}

/**
 * Whether the account is logged in, or `null` when the answer cannot be read.
 *
 * Three outcomes rather than two, because "the binary said no" and "the binary
 * said something this adapter does not understand" are different facts and only
 * the first of them is `not_authenticated`. An older build with no `auth`
 * subcommand, a JSON shape that moved, an empty stdout — all of them land on
 * `null`, and the verdict for `null` says auth could not be verified instead of
 * claiming a logout nobody observed.
 */
function loggedIn(stdout) {
  try {
    const doc = JSON.parse(String(stdout ?? ''));
    return typeof doc?.loggedIn === 'boolean' ? doc.loggedIn : null;
  } catch {
    return null;
  }
}

/**
 * Run the auth check and hand back what it did, without ever rejecting: every
 * outcome — a launch that failed, a kill, an exit code — is data for the verdict.
 *
 * `stderr` is not piped at all. Nothing here reads it, an unread pipe is one more
 * thing that can fill and stall the child, and a stream that is never opened is
 * one fewer route for harness output to travel by.
 *
 * `timedOut` is set by OUR timer and by nothing else, so the caller can tell the
 * kill it asked for from a signal the machine sent: the first is the budget, the
 * second is a crash, and they are different verdicts.
 *
 * Two callers: the auth check, and the keychain read on macOS. The second is the
 * reason the argv is a parameter — one launch path, one kill path, one set of
 * event-loop rules, rather than a second copy of all three beside the first.
 */
function runCapture(bin, argv, ms) {
  const plan = planRun(bin, argv);
  if (!plan.ok) return Promise.resolve({ error: { code: plan.code }, timedOut: false });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(plan.file, plan.args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (error) {
      resolve({ error, timedOut: false });
      return;
    }

    let stdout = '';
    let timedOut = false;
    let timer = null;
    let settled = false;
    const done = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut, ...out });
    };

    timer = setTimeout(() => {
      timedOut = true;
      // `SIGKILL`, not `SIGTERM`: the budget is already spent by the time this
      // fires, and a child that ignores a polite signal would spend the rest of
      // the run's ceiling on top of it.
      child.kill('SIGKILL');
      // The kill alone does not end the wait. `close` fires when the last stdio
      // pipe closes, not when the child dies, so a grandchild holding the
      // inherited pipe keeps the probe pending long after the signal — measured
      // live on 2026-09-05: a 300 ms deadline against a wrapper whose `sleep 5`
      // held the pipe gave the right verdict 5.2 s late, which is exactly the
      // overshoot the deadline exists to prevent.
      //
      // Two lines follow, and they are not one line twice. `done` ANSWERS at the
      // deadline, which is the timing this check is about; `destroy` and `unref`
      // let go of the pipe and the child handle, so a process the harness left
      // behind cannot hold the event loop open after the run is over. Either
      // would incidentally unstick the other's symptom, which is why deleting one
      // as redundant reads as safe and is not.
      done({ status: null, signal: 'SIGKILL' });
      child.stdout.destroy();
      child.unref();
    }, ms);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    // A stream error is not an adapter failure to report twice: `close` follows
    // and carries the outcome. Unhandled, it would be thrown at the process.
    child.stdout.on('error', () => {});
    child.on('error', (error) => done({ error }));
    child.on('close', (status, signal) => done({ stdout, status, signal }));
  });
}

/**
 * The credential record as text, or `null` when there is none to read.
 *
 * Two platforms, two mechanisms, one answer. On macOS the record is a keychain
 * item and `security` is how a process outside Claude Code asks for it — which
 * may put the system's own permission dialog in front of the person the first
 * time, and that is a fact for the reference rather than something to work
 * around. Everywhere else it is a file, read asynchronously: a probe may not hold
 * the event loop, and the rule is about the loop rather than about the size of
 * the read.
 *
 * Nothing is said about WHY the read failed. A missing item, a refused keychain
 * and an unreadable file all mean the same thing to the caller — no token — and
 * the diagnosis it writes is about the limit, not about the person's keychain.
 */
async function liveCredential({ timeoutMs }) {
  if (process.platform === 'darwin') {
    const answer = await runCapture(SECURITY_BIN, CREDENTIAL_ARGV, timeoutMs);
    return answer.status === 0 && answer.stdout ? answer.stdout : null;
  }
  try {
    return await readFile(credentialFile(), 'utf8');
  } catch {
    return null;
  }
}

/**
 * The three headers both endpoints want, and no fourth.
 *
 * Exported so the shape can be checked without a request: it is the only place a
 * token is written, and the beta header is what the endpoints answer 200 to
 * (measured 2026-09-06 on 2.1.251) — a probe that lost it would report
 * `quota_unknown` for a perfectly good account, which reads as a harness change
 * rather than as a missing line.
 */
export function oauthHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    'anthropic-beta': OAUTH_BETA,
    accept: 'application/json',
  };
}

/**
 * One GET, JSON in hand or a word for why not.
 *
 * `{ status, doc }` is an answer that arrived — `doc` is `null` when the body was
 * not JSON, which is a refusal shape rather than a failure of the call.
 * `{ error }` is `timeout` or `network`, and they are different verdicts: the
 * first is the budget and the cache retries it in five minutes, the second is a
 * machine with no route to the endpoint.
 *
 * The token appears in exactly one place — this header — and the response text is
 * parsed and dropped. Neither reaches a verdict.
 */
async function liveGetJson(url, { token, timeoutMs }) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: oauthHeaders(token),
      signal: control.signal,
    });
    const text = await res.text();
    let doc = null;
    try {
      doc = JSON.parse(text);
    } catch {
      doc = null;
    }
    return { status: res.status, doc };
  } catch (error) {
    return { error: error?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** The live side of the two calls that leave this process. Replaced whole by the suite. */
const LIVE = { readCredential: liveCredential, getJson: liveGetJson };

/**
 * The probe itself. Never throws: a thrown error is `probe_failed` with its text
 * discarded, so everything this adapter has to say it says in a verdict.
 *
 * The binary arrives already resolved (`toolBin`). This adapter does not call
 * `resolveToolBin` itself and must not: that call is synchronous by contract and a
 * host may start a process inside it, so an adapter making it would hold the event
 * loop and stop the timer that bounds the whole preflight. The preflight resolves
 * every binary once, before the race, and what it hands over is what is left of the
 * budget afterwards — so the deadline taken on the first line is already net of the
 * resolve.
 *
 * `refresh` is not read: this adapter holds no cache of its own, and the
 * availability cache upstream has already been consulted by the time it is called.
 */
async function probe({ toolBin: tool, timeoutMs }, models, deps) {
  const deadline = Date.now() + timeoutMs;
  if (!tool) {
    return verdict('unknown', 'probe_failed', 'the host resolved no tool binary, so the harness was never asked');
  }
  if (!tool.ok || !tool.bin) {
    return verdict('unavailable', 'binary_missing',
      `no ${TOOL} binary on this machine — install it, or stop declaring this harness in the workspace`);
  }
  // The version is the binary's own fact and belongs in the verdict on every
  // branch below, logged in or not: it is what a person reads first when the
  // adapter starts answering something new after an update.
  const version = typeof tool.version === 'string' && tool.version.trim()
    ? { version: tool.version.trim() }
    : {};

  const left = deadline - Date.now();
  if (left <= 0) {
    return verdict('unknown', 'probe_timeout',
      'the preflight budget was already spent when this adapter was reached — the auth check was not run', version);
  }

  const answer = await runCapture(tool.bin, AUTH_ARGV, left);
  if (answer.timedOut) {
    return verdict('unknown', 'probe_timeout',
      `the auth check did not finish inside the ${timeoutMs} ms left of the preflight budget`, version);
  }
  if (answer.error) {
    const kind = codeOf(answer.error.code);
    // `ETIMEDOUT` from the platform is the same fact our own timer reports, and
    // the cache retries a timeout in five minutes rather than holding it an hour.
    if (kind === 'ETIMEDOUT') {
      return verdict('unknown', 'probe_timeout',
        `the auth check did not finish inside the ${timeoutMs} ms left of the preflight budget`, version);
    }
    return verdict('unknown', 'probe_failed', `the auth check could not be run (${kind ?? 'no error code'})`, version);
  }
  if (answer.signal) {
    // A signal we did not send is a crash or a person's `kill`, not the budget:
    // calling it `probe_timeout` would hide a harness that dies on every probe
    // behind a code that reads as "the machine was busy".
    const signal = codeOf(answer.signal);
    return verdict('unknown', 'probe_failed',
      `the auth check was killed by ${signal ?? 'a signal'} — this adapter did not send it`, version);
  }

  const authenticated = loggedIn(answer.stdout);
  if (authenticated === false) {
    return verdict('unavailable', 'not_authenticated',
      'the binary is there and this account is not logged in — sign in with `claude auth login`', version);
  }
  if (authenticated === null) {
    const code = Number.isInteger(answer.status) ? `exit ${answer.status}` : 'no exit code';
    return verdict('unknown', 'quota_unknown',
      `the auth check answered nothing this adapter can read (${code}): auth could not be verified, `
      + 'and the remaining limit is unknown', version);
  }
  // `rated` is not filled here on purpose: this adapter knows the harness, not
  // the catalog, and the preflight sets it from the predicate its caller supplies.
  const inventory = { models: models.map((model) => ({ model })) };
  const listed = `${models.length} model ${models.length === 1 ? 'alias' : 'aliases'} the harness accepts`;

  return limitVerdict({ deadline, timeoutMs, deps, carry: { ...version, ...inventory }, listed });
}

/**
 * The second half of the probe: the tier, the windows, and the states they reach.
 *
 * It is a function of its own because the first half answers about the BINARY and
 * this one about the ACCOUNT's plan, and because the branch table below is the
 * part a person reads when a live run says something unexpected. Everything it
 * needs beyond the two calls is already decided: `carry` is the version and the
 * inventory that belong in the verdict whatever happens next.
 */
async function limitVerdict({ deadline, timeoutMs, deps, carry, listed }) {
  const left = () => deadline - Date.now();
  const spent = (what) => verdict('unknown', 'quota_unknown',
    `authenticated; ${listed}; ${what}, so the remaining limit stays unknown`, carry);

  if (left() <= 0) return spent('the preflight budget ran out before the usage endpoint was asked');

  const record = credentialRecord(await deps.readCredential({ timeoutMs: left() }));
  if (!record) {
    // Logged in by the binary's own answer and no credential record this adapter
    // can read: on macOS the keychain refused or the item is not there, elsewhere
    // the file is not. Nothing is claimed about the login — `auth status` already
    // answered that — only about the limit.
    return spent('the credential record could not be read');
  }
  // The tier is the record's, and it survives every branch below: it is known
  // offline, and an expired token or a refused endpoint does not unknow it.
  const tier = record.tier ? { tier: { name: record.tier, source: 'credentials' } } : {};
  const held = { ...carry, ...tier };
  const stale = (what) => verdict('unknown', 'quota_unknown',
    `authenticated; ${listed}; ${what}, so the remaining limit stays unknown`, held);

  if (Number.isFinite(record.expiresAt) && record.expiresAt <= Date.now()) {
    // **Never a refresh.** The refresh endpoint rotates the credentials Claude
    // Code itself is holding, and a preflight that did that would sign a person
    // out of the session they are working in. An expired token is a fact to
    // report, and the next `claude` run repairs it.
    return stale('the stored token is past its expiry and this adapter never refreshes it');
  }

  if (left() <= 0) return stale('the preflight budget ran out before the usage endpoint was asked');
  const usage = await deps.getJson(USAGE_URL, { token: record.accessToken, timeoutMs: left() });
  if (usage.error === 'timeout') {
    return verdict('unknown', 'probe_timeout',
      `the usage endpoint did not answer within the ${timeoutMs} ms left of the preflight budget`, held);
  }
  if (usage.error) return verdict('unknown', 'probe_failed', 'the usage endpoint could not be reached', held);
  if (usage.status === 401 || usage.status === 403) {
    // The binary says logged in and the endpoint refuses the token it holds. That
    // is an account this run cannot use, and it is the one HTTP status that is a
    // statement about the account rather than about the request.
    return verdict('unavailable', 'not_authenticated',
      'the stored credentials were refused by the usage endpoint — sign in again with `claude auth login`', held);
  }
  if (usage.status !== 200 || !usage.doc) {
    return stale(`the usage endpoint answered ${usage.status ?? 'nothing'} this adapter cannot read`);
  }

  // The profile is asked for ONE field and only when the record named no tier: it
  // is a second request, and a request that answers a question already answered
  // offline is a request nobody needed. A refusal costs the tier and nothing else.
  let carried = held;
  if (!record.tier && left() > 0) {
    const profile = await deps.getJson(PROFILE_URL, { token: record.accessToken, timeoutMs: left() });
    const named = profile?.status === 200 && typeof profile.doc?.organization?.rate_limit_tier === 'string'
      ? profile.doc.organization.rate_limit_tier.trim()
      : '';
    if (named) carried = { ...held, tier: { name: named, source: 'probe' } };
  }

  const windows = usageWindows(usage.doc, deps.scopeIds);
  const done = windows.length ? { ...carried, windows } : carried;
  const reached = spentWindow(usage.doc);
  if (reached) {
    // **An exhaustion with no reset is STICKY.** `entryExpiry` gives it `Infinity`
    // and `--refresh` does not drop it ([cache.js](cache.js) `stickyExhaustion`),
    // so nothing but `--clear-exhausted` lifts it — and the likeliest input here
    // is exactly a `locked_reason` row, which the endpoint may state with no
    // `resets_at` at all. A message promising "until it resets" would then leave a
    // person waiting for a moment nobody named. So the two cases say different
    // things, and the second names the way out, the way the driver's own
    // late-start mark does ([driver-claude.js](../driver-claude.js)).
    const said = reached.resetAt
      ? `the ${reached.id} limit is spent; a turn is refused until it resets`
      : `the ${reached.id} limit is spent and the harness named no reset — neither time nor a later `
        + 'probe lifts this mark; clear it with `promptobus models --clear-exhausted claude`';
    return verdict('exhausted', 'subscription_exhausted', said, { ...done, resetAt: reached.resetAt });
  }
  if (!windows.length) {
    // The endpoint answered and named no window this adapter places. The limit is
    // then as unknown as it was before the call, and saying so is the whole point
    // of the code: `available` would claim a limit was confirmed.
    return verdict('unknown', 'quota_unknown',
      `authenticated; ${listed}; the usage endpoint named no limit window`, carried);
  }
  return verdict('available', null,
    `authenticated; ${listed}; ${windows.length} limit window${windows.length === 1 ? '' : 's'}`, done);
}

/**
 * The adapter a driver declares as `availability`.
 *
 * `models` is the inventory to report when the account turns out to be logged in:
 * the alias set the driver accepts, together with its default model. It is a
 * parameter rather than a constant here so that the two facts stay in one file —
 * the driver's — instead of drifting between the lift and the probe.
 *
 * `scopeIds` is the second half of that dictionary: the display names the harness
 * prints on a model-scoped limit row, and the ids each resolves to. It travels the
 * same way and for the same reason — a copy inside this file would outlive a
 * repin of the driver's own tables and go on naming an id nobody points at.
 *
 * `deps` is the seam for everything that leaves this process without being the
 * harness binary: the keychain read and the two GETs. It defaults to the live
 * implementations, so the driver declares the adapter exactly as it did; the suite
 * passes its own, which is what lets every branch above be checked without a
 * network or a person's keychain.
 */
export function claudeAvailability(models, scopeIds, deps = {}) {
  const wired = { ...LIVE, ...deps, scopeIds };
  return { tool: TOOL, probe: (request) => probe(request, models, wired) };
}
