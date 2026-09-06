// Cursor availability adapter: what the locally logged-in Cursor account can do
// right now. The driver ([driver-cursor.js](../driver-cursor.js)) declares it as
// `availability`, the preflight ([preflight.js](preflight.js)) runs it, and the
// verdict it answers is one harness entry of the availability snapshot.
//
// Two binary calls and nothing else: `status` for auth, `models` for the
// inventory. Neither starts a session, neither writes, and neither touches the
// availability cache — the cache is read and written around this module.
// Everything about a RUNNING Cursor participant — the tmux pane, `persist`, the
// transcript — lives one floor below in [cursor-persist.js](../cursor-persist.js)
// and is none of this file's business: an adapter answers about the ACCOUNT,
// before any session exists.
//
// **The quota source is not the binary — it is the dashboard's own call.** The
// binary names no limit, and ADR-003 recorded that as "Cursor exposes none".
// [ADR-004](../../docs/adr/adr-004-subscription-balance.md) supersedes the
// assumption on a spike of 2026-09-06: `POST <backendUrl>/aiserver.v1.DashboardService/GetCurrentPeriodUsage`
// answers the account's billing cycle with the CLI's own token, and costs no turn.
// So a successful probe is `available` now — auth, model AND limit confirmed — and
// every path where the limit could not be read is still `unknown` /
// `quota_unknown`, which the resolver penalises rather than blocks.
//
// **One cycle, two pools, and that is the shape the harness has.** The answer
// carries ONE window — `billingCycleStart` to `billingCycleEnd` — and two
// percentages inside it: `autoPercentUsed` for Cursor's own models, which the
// answer lists in `autoBucketModels`, and `apiPercentUsed` for named third-party
// models. ADR-004 writes that as two windows of the same length with a pool
// scope each: the `auto` pool names the ids it covers, and the `api` pool names
// none because it is the complement and a list of everything else is not a fact
// any harness stated.
//
// **`autoBucketModels` is not the only place Cursor says which pool a model is
// billed to, and it is not the current one.** Measured on the owner's account on
// 2026-09-06: one turn on `cursor-grok-4.6-medium` moved `autoPercentUsed` and
// not `apiPercentUsed`, while the bucket list named `grok-4.5` and no `grok-4.6`
// before or after. `POST <backendUrl>/aiserver.v1.DashboardService/GetAggregatedUsageEvents`
// states the same thing per model — `tier: 2` is the Auto bucket, `tier: 1` the
// api pool — for every model with an event this cycle, so the `auto` scope is the
// UNION of the two, and a model with neither a row nor a bucket entry stays in
// `api`. That third call is optional in the way the policy call is: without it
// the bucket list is the whole answer, which is what this adapter did before —
// though a live hang on it drains the shared budget and costs the policy call's
// note as well.
//
// **The token is read and never written.** `cursor-access-token` in the keychain
// FIRST — that is the credential the spike measured this call answering — and
// `CURSOR_API_KEY` in the environment only as a fallback, because nothing
// measured says DashboardService accepts an API key at all. Which of the two was
// used travels with the token, and it decides what a refusal means.
// `cursor-refresh-token` is never asked for. `~/.cursor/cli-config.json` is read for ONE field, the backend URL — the
// same file carries the account's address and ids, and nothing here parses them.
// The token reaches one `Authorization` header and no verdict, message or cache
// file.
//
// **The keychain read and the POSTs arrive as parameters**, the way the Codex
// adapter takes its launch context: `cursorAvailability` defaults them to the live
// implementations, and the suite hands in its own, so no test touches the network
// or the person's keychain.
//
// Both commands print ANSI colour even when stdout is not a terminal (measured
// 2026-09-05 on `cursor-agent` 2026.09.02-c22c1a3), so everything is stripped
// before it is looked at.
//
// **Nothing read here reaches `message`.** `status` prints the account address
// on success; the adapter counts and classifies, and writes its own diagnosis.
// The verdict `message` is the only free-text field that reaches the cache file.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { planRun } from '../exec.js';
import { isoStamp, stampAtMs } from './cache.js';

/**
 * Subcommands, as they were measured. `status` exits 0 in both the logged-in and
 * the logged-out case on the machine this was taken from, so the exit code is not
 * the auth answer — the text is.
 */
const STATUS_ARGS = ['status'];
const MODELS_ARGS = ['models'];

/**
 * ANSI colour. `models` wraps every id in `\x1b[36m…\x1b[39m` and every display
 * name in `\x1b[2m…\x1b[22m`; `status` colours its tick. A parse that did not
 * strip these would see no line it recognises at all.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1B\[[0-9;]*[A-Za-z]/g;

/**
 * The logged-in line, and the trap under it. `status` answers
 * `✓ Logged in as <account>` when the account is in — but "not logged in"
 * CONTAINS "logged in", so a single positive pattern would read a logged-out
 * binary as authenticated. The negative is matched separately and wins.
 */
const LOGGED_IN = /logged in as\s+\S/i;
const NOT_LOGGED_IN = /\bnot\s+logged\s+in\b/i;

/**
 * One inventory row: `<id> - <Display Name>`.
 *
 * The id is taken WHOLE, effort suffix included. In Cursor the effort level is not
 * a separate flag but a flat suffix on the id (`claude-opus-5-thinking-max`,
 * `cursor-grok-4.6-xhigh-fast` — the driver says the same next to `EFFORT_LEVELS`),
 * so a stripped suffix would name a model the binary does not have.
 *
 * A row is recognised by the SHAPE of its id next to a literal ` - `, not by
 * "a line with two fields in it": the listing carries a header
 * (`Available models`) and a trailing `Tip: use --model …` line, and a looser
 * pattern reads the header as a model called `Available`. Neither prose line
 * carries ` - ` today — the anchor is what keeps that true of a line the binary
 * adds tomorrow.
 */
const MODEL_ROW = /^([A-Za-z0-9][A-Za-z0-9._+-]*)\s+-\s+(.+)$/;

/**
 * The mark Cursor prints on a model that is outside zero-data-retention. It
 * travels as a flag and is NOT judged here: the package carries what the harness
 * said, and a consumer that must not use such a model denies it in an overlay.
 */
const NO_ZDR = /\(NO ZDR\)/;
const NO_ZDR_FLAG = 'no-zdr';

const stripAnsi = (text) => String(text ?? '').replace(ANSI, '');

/**
 * The bearer, by the two routes the binary itself knows, in the order the
 * evidence puts them.
 *
 * **The keychain token is first**, because it is the one the spike of 2026-09-06
 * measured `GetCurrentPeriodUsage` answering. `CURSOR_API_KEY` is the other way
 * the binary authenticates and is taken only when the keychain has nothing — a
 * fallback rather than a claim: no measurement says DashboardService accepts an
 * API key, and a refusal of an unmeasured credential must not be reported as a
 * statement about the account.
 *
 * `cursor-refresh-token` sits in the same keychain under a neighbouring service
 * name and is **never asked for**: it is the credential that mints new ones, this
 * adapter has no use for it, and the safest way not to leak a secret is not to
 * hold it.
 */
const TOKEN_ENV = 'CURSOR_API_KEY';
const SECURITY_BIN = '/usr/bin/security';
const TOKEN_SERVICE = 'cursor-access-token';
const TOKEN_ARGV = ['find-generic-password', '-s', TOKEN_SERVICE, '-w'];

/**
 * Where the backend URL is cached, and the fallback when it is not there.
 *
 * The file also holds `authInfo` — the account's address, display name and two
 * ids — and ONE field of it is parsed. The rest is not read, not carried and not
 * logged: this package's cache promises to hold no address and no open account id,
 * and the cheapest way to keep that promise is not to take them out of the file.
 */
const CLI_CONFIG_FILE = ['.cursor', 'cli-config.json'];
const DEFAULT_BACKEND = 'https://api2.cursor.sh';

/** The Connect methods, and the headers that protocol wants. */
const USAGE_METHOD = 'aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const POLICY_METHOD = 'aiserver.v1.DashboardService/GetUsageLimitStatusAndActiveGrants';
const EVENTS_METHOD = 'aiserver.v1.DashboardService/GetAggregatedUsageEvents';
const CONNECT_VERSION = '1';

/** The window ids of the two pools. One cycle, two percentages, two windows (ADR-004). */
const AUTO_WINDOW = 'monthly-auto';
const API_WINDOW = 'monthly-api';

/**
 * The `tier` an aggregation row carries for a model Cursor billed to the Auto
 * pool. Measured 2026-09-06: the four `cursor-grok-4.6-*` rows of that cycle all
 * carry 2, and the turn that produced one of them moved `autoPercentUsed`. 1 is
 * the api pool, and no other value is measured — a row with one is left alone.
 */
const AUTO_TIER = 2;

/**
 * The cycle boundaries arrive as epoch milliseconds IN A STRING (`"1891123200000"`),
 * which is how Connect carries a 64-bit integer. A value that is neither a number
 * nor a string of digits is not a moment, and nothing here repairs one.
 *
 * The UNIT is this adapter's fact; the range check and the formatting are shared
 * (`stampAtMs` in [cache.js](cache.js)), because all three adapters need the
 * second half and disagree only about the first.
 */
function epochMs(value) {
  const ms = typeof value === 'number' ? value : (/^\d{1,15}$/.test(String(value ?? '')) ? Number(value) : NaN);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * A percentage the snapshot will take, or `null` when the value is not one.
 *
 * Capped at 100 rather than dropped above it: this account's `bonusSpend` can
 * carry the total past the included amount, the schema's range ends at 100, and
 * "spent" is what a value past the end means. Losing the window would lose the
 * fact along with the number.
 */
function percentOf(value) {
  // `typeof` first, because `Number(null)` is 0 and `Number('')` is 0: a field the
  // answer left out would become a pool reported as untouched, which is the one
  // wrong number a person would never question.
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(100, value);
}

/**
 * The inventory ids the `auto` pool covers.
 *
 * `autoBucketModels` names FAMILIES — `composer-2.5`, `cursor-grok-4.6` — while
 * the inventory names ids with the effort level and the speed tier baked into
 * them (`cursor-grok-4.6-xhigh-fast`). ADR-004 requires a scope that covers
 * models to name them **by id**, because the resolver matches exactly and infers
 * no family; so the family inference happens here, in the module that holds both
 * lists, and what travels is ids.
 *
 * Two ways an id joins the pool through the bucket list, and this is the "say
 * which" PB-27 asks for: the id **is** a bucket name, or it starts with a bucket
 * name followed by a hyphen. The hyphen is the whole of the second rule — without
 * it `vega` would claim `vegabond-3` — and a bucket name that matches no id
 * contributes nothing rather than being carried as a guess.
 *
 * **And a third way, because the bucket list lags Cursor's own billing.**
 * `tiered` is the set `autoTierModels` read off the aggregation, and an id in it
 * joins the pool whatever the bucket list says. It is a UNION and never a
 * subtraction: a model the bucket list names stays in the pool even with no event
 * this cycle, because that list is the harness's own statement about the pool and
 * an absent row is an absent measurement rather than a denial.
 *
 * An empty answer means no `auto` window at all: the schema requires the list on
 * that pool, the harness publishes it, and its absence is this adapter's fault
 * rather than a limit to report.
 */
export function autoPoolModels(inventory, bucket, tiered) {
  const names = Array.isArray(bucket)
    ? [...new Set(bucket.filter((b) => typeof b === 'string' && b.trim()).map((b) => b.trim()))]
    : [];
  const billed = tiered instanceof Set ? tiered : new Set(Array.isArray(tiered) ? tiered : []);
  if (!names.length && !billed.size) return [];
  const exact = new Set(names);
  const ids = [];
  for (const id of inventory ?? []) {
    if (typeof id !== 'string' || !id) continue;
    if (exact.has(id) || billed.has(id) || names.some((name) => id.startsWith(`${name}-`))) ids.push(id);
  }
  return [...new Set(ids)];
}

/**
 * The ids Cursor BILLED to the auto pool this cycle, off
 * `GetAggregatedUsageEvents`.
 *
 * The bucket list is a list Cursor maintains and it lags Cursor's own billing:
 * measured on the owner's account on 2026-09-06, one turn on
 * `cursor-grok-4.6-medium` moved `autoPercentUsed` (86.1025 → 86.105) and left
 * `apiPercentUsed` untouched, while `autoBucketModels` named no `grok-4.6` before
 * or after. The aggregation is where the same answer is stated per model:
 * `tier: 2` is the Auto bucket and `tier: 1` is the api pool, and a row is a fact
 * the harness published about a turn that was really billed.
 *
 * A row names a WHOLE id (`cursor-grok-4.6-medium`), which is the id the
 * inventory prints, so this route matches exactly and infers no family — the rule
 * ADR-004 fixed for the resolver. **A model with no row is not in the pool**: no
 * events this cycle and no bucket entry leaves it in `api`, which is the
 * conservative reading, the api pool being the fuller one.
 */
export function autoTierModels(events) {
  const rows = Array.isArray(events?.aggregations) ? events.aggregations : [];
  const ids = new Set();
  for (const row of rows) {
    // `typeof` first, for the reason `derivedTier` gives: `Number(null)` is 0, and
    // a row carrying no tier must not be read as a pool nobody named.
    if (typeof row?.tier !== 'number' || row.tier !== AUTO_TIER) continue;
    const id = typeof row.modelIntent === 'string' ? row.modelIntent.trim() : '';
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * The billing cycle as ADR-004 windows: one length, two pools.
 *
 * `lengthSec` is the cycle the answer states rather than thirty days — ADR-004 is
 * explicit that `kind` is a name and `lengthSec` is the number, and that a
 * billing cycle is `monthly` and is not a month. A cycle whose boundaries do not
 * read, or that does not run forwards, yields no window at all: a pace cannot be
 * computed without a length, and an invented one would be a measurement nobody
 * made.
 */
export function periodWindows(usage, inventory, events) {
  const start = epochMs(usage?.billingCycleStart);
  const end = epochMs(usage?.billingCycleEnd);
  if (start === null || end === null || end <= start) return [];
  const lengthSec = Math.round((end - start) / 1000);
  const resetAt = stampAtMs(end);
  if (lengthSec < 1 || !resetAt) return [];
  const plan = usage?.planUsage ?? {};
  const out = [];

  const models = autoPoolModels(inventory, usage?.autoBucketModels, autoTierModels(events));
  const autoPercent = percentOf(plan.autoPercentUsed);
  if (models.length && autoPercent !== null) {
    out.push({
      id: AUTO_WINDOW,
      kind: 'monthly',
      lengthSec,
      usedPercent: autoPercent,
      resetAt,
      scope: { pool: 'auto', models },
    });
  }
  const apiPercent = percentOf(plan.apiPercentUsed);
  if (apiPercent !== null) {
    // The `api` pool carries no list: it is the complement, and ADR-004 refuses
    // one there rather than letting a second, quieter claim ride along.
    out.push({
      id: API_WINDOW, kind: 'monthly', lengthSec, usedPercent: apiPercent, resetAt, scope: { pool: 'api' },
    });
  }
  return out;
}

/**
 * The tier, derived, or `null` when the answer does not carry the amount.
 *
 * **No Cursor method returns the plan name** — the spike checked, and
 * `cursor.com/api/auth/stripe` refuses the CLI's token — so ADR-004 makes the
 * included amount of the cycle the tier proxy and marks it `derived`. The number
 * is the PLAN's included cents and never the account's spend, which is what keeps
 * a tier a property of the plan rather than a fact about the person. The plan's
 * real name is the one question the tool cannot answer; it lives in the user
 * overlay and is display only.
 */
export function derivedTier(usage) {
  // `typeof` first: `Number(null)` and `Number('')` are 0, and a plan that named
  // no included amount would come out as `included:0` — a tier a person would read
  // as measured and nobody stated.
  const limit = usage?.planUsage?.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) return null;
  return { name: `included:${limit}`, source: 'derived' };
}

/**
 * A line of harness text, made safe to put in a diagnosis — or `null`.
 *
 * `message` is the one free-text field that reaches disk, and this is the only
 * place harness prose is allowed into it, so the prose is bounded rather than
 * trusted: control characters out, whitespace collapsed, 120 characters, and a
 * string containing `@` refused outright, because the shape of an address is the
 * one thing the cache promises never to hold.
 */
export function sanitizeMessage(text) {
  if (typeof text !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean || clean.includes('@')) return null;
  return clean.length > 120 ? `${clean.slice(0, 119)}…` : clean;
}

/** A model id as the harness prints one. The nudge names one, and only this shape travels. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/**
 * Cursor's own near-limit signal, in this adapter's words — or `null` when the
 * answer carries none.
 *
 * `thirdPartyUsageNudge` is the harness saying the API pool is near its end. The
 * threshold is a number and the target is a model id, and those two are carried;
 * the nudge's `label` is prose written for a dialog and is not, because a verdict
 * message is written here rather than quoted from a harness.
 */
export function nudgeNote(policy) {
  const nudge = policy?.thirdPartyUsageNudge;
  // `typeof` first, for the reason `derivedTier` gives: `Number(null)` is 0, and a
  // nudge with no threshold would warn that the pool is "past 0 %".
  const threshold = nudge?.threshold;
  if (!nudge || typeof threshold !== 'number' || !Number.isFinite(threshold)) return null;
  const target = typeof nudge.targetModel === 'string' && MODEL_ID.test(nudge.targetModel.trim())
    ? nudge.targetModel.trim()
    : null;
  const where = target ? ` and points at ${target}` : '';
  return `Cursor warns that the api pool is past ${threshold} %${where}`;
}

/**
 * The backend URL the CLI cached, or `null`.
 *
 * **Only `https:` is accepted.** The value comes out of a file on disk and this
 * adapter is about to send a bearer token to it; a `http:` or a `file:` there
 * would be a token going somewhere in the clear, or nowhere useful. A refused
 * value falls back to the measured default rather than failing the probe.
 */
export function backendUrlOf(text) {
  let doc = null;
  try {
    doc = JSON.parse(String(text ?? ''));
  } catch {
    return null;
  }
  const raw = doc?.serverConfigCache?.backendUrl;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url = null;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  return url.protocol === 'https:' ? url.origin : null;
}

/**
 * Run a harness command and hand back its exit code and stdout, or say which way
 * it failed. Never throws: an adapter answers with a verdict, and a thrown error
 * would reach the preflight as `probe_failed` with its text discarded.
 *
 * Asynchronous rather than the package's synchronous `run`: the preflight starts
 * every adapter at once and races them against one budget timer, and a
 * `spawnSync` here would block that timer along with the other two harnesses.
 * `planRun` is still the launch plan — the Windows batch-file rules belong to
 * [exec.js](../exec.js) and are not restated here.
 *
 * stderr is `ignore`d rather than captured. It is the likeliest place for an
 * account line to appear, nothing below reads it, and an ignored pipe cannot fill
 * up and stall the child.
 */
function runOut(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    if (timeoutMs <= 0) { resolve({ ok: false, timedOut: true }); return; }
    const plan = planRun(cmd, args);
    if (!plan.ok) { resolve({ ok: false, missing: plan.code === 'ENOENT' }); return; }
    let child;
    try {
      child = spawn(plan.file, plan.args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false,
        ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (e) {
      resolve({ ok: false, missing: e?.code === 'ENOENT' });
      return;
    }
    let out = '';
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    // The child is killed rather than left running: the budget is the whole
    // preflight's, and a `cursor-agent` still going after it would outlive the
    // command that started it.
    //
    // The kill alone does not end the wait, and three lines are needed rather than
    // one. `close` fires when the last stdio pipe closes, not when the child dies,
    // so a grandchild holding the inherited pipe keeps this promise pending long
    // after the signal — measured 2026-09-05 against a `#!/bin/sh` wrapper whose
    // `sleep 5` held the pipe: the verdict was already right at the deadline, and
    // the RUN was held 5.2 s past it. So `finish` ANSWERS at the deadline, and
    // `destroy` and `unref` let go of the pipe and the child handle, so a process
    // the harness left behind cannot hold the event loop open after the run is
    // over. The same two symptoms and the same three lines as the Claude adapter
    // ([adapter-claude.js](adapter-claude.js)); deleting either as redundant reads
    // as safe and is not.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, timedOut: true });
      child.stdout.destroy();
      child.unref();
    }, timeoutMs);
    // Decoded before it is concatenated: a multibyte character split across a
    // chunk boundary would otherwise become replacement characters, and the tick
    // `status` prints in front of its line is one.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', (e) => finish({ ok: false, missing: e?.code === 'ENOENT' }));
    child.on('close', (status) => finish({ ok: true, status, out }));
  });
}


/**
 * The bearer, or `null` when neither route has one.
 *
 * One `security` read of the ACCESS token FIRST — `/usr/bin/security` by absolute
 * path, because a `security` picked up from `PATH` would be whatever a person's
 * shell profile put in front of it, which is a poor thing to hand a request for a
 * token. `CURSOR_API_KEY` is taken only when the keychain has nothing: it is the
 * other way the binary authenticates, and no measurement says DashboardService
 * accepts an API key at all.
 *
 * The answer says WHICH of the two it found, because that decides what a refusal
 * means one floor up: a 401 on the measured credential is a statement about the
 * account, and a 401 on the unmeasured one is only this adapter failing to learn
 * the limit. `cursor-refresh-token` is never asked for, on either route.
 */
async function liveToken({ timeoutMs }) {
  if (process.platform === 'darwin') {
    const answer = await runOut(SECURITY_BIN, TOKEN_ARGV, timeoutMs);
    const out = answer.ok && answer.status === 0 ? String(answer.out ?? '').trim() : '';
    if (out) return { token: out, source: 'keychain' };
  }
  const named = typeof process.env[TOKEN_ENV] === 'string' ? process.env[TOKEN_ENV].trim() : '';
  return named ? { token: named, source: 'env' } : null;
}

/**
 * The backend URL the CLI cached, or the measured default.
 *
 * Read asynchronously: a probe may not hold the event loop, and the rule is about
 * the loop rather than about the size of the read. A file that is not there, or
 * one whose URL is not `https:`, falls back rather than failing the probe — the
 * default is what the CLI itself uses.
 */
async function liveBackendUrl() {
  try {
    const text = await readFile(path.join(homedir(), ...CLI_CONFIG_FILE), 'utf8');
    return backendUrlOf(text) ?? DEFAULT_BACKEND;
  } catch {
    return DEFAULT_BACKEND;
  }
}

/**
 * One Connect call, JSON in hand or a word for why not.
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
async function livePostJson(url, { token, timeoutMs }) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: connectHeaders(token),
      body: '{}',
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

/**
 * The three headers Connect wants, and no fourth.
 *
 * Exported so the shape can be checked without a request: it is the only place a
 * token is written, and `connect-protocol-version` is what makes these methods
 * answer 200 at all (measured 2026-09-06) — a probe that lost it would report
 * `quota_unknown` for a perfectly good account.
 */
export function connectHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'connect-protocol-version': CONNECT_VERSION,
  };
}

/** The live side of the two calls that leave this process. Replaced whole by the suite. */
const LIVE = { readToken: liveToken, readBackendUrl: liveBackendUrl, postJson: livePostJson };

/** The inventory `models` listed, with the marks it printed. */
export function parseModels(stdout) {
  const models = [];
  for (const line of stripAnsi(stdout).split('\n')) {
    const row = MODEL_ROW.exec(line.trim());
    if (!row) continue;
    const model = { model: row[1] };
    if (NO_ZDR.test(row[2])) model.flags = [NO_ZDR_FLAG];
    models.push(model);
  }
  return models;
}

/**
 * What `status` said about the account: `in`, `out`, or `unreadable`.
 *
 * **The exit code is not consulted.** `cursor-agent status` exits 0 whether or
 * not the account is in (measured 2026-09-05), so the code carries no auth
 * information at all — and a non-zero code beside a line this adapter CAN read
 * says nothing about the login either.
 *
 * The negative is matched first and wins, because "not logged in" contains
 * "logged in": a single positive pattern reads a signed-out binary as
 * authenticated. A line that matches neither is not a third auth state — it is
 * output this adapter does not recognise, and answering `not_authenticated` to it
 * would send the person to `cursor-agent login` for a parse fault.
 */
export function authState(stdout) {
  const text = stripAnsi(stdout);
  if (NOT_LOGGED_IN.test(text)) return 'out';
  return LOGGED_IN.test(text) ? 'in' : 'unreadable';
}

/**
 * The verdict for a call that came back with no output, by the way it failed.
 *
 * Three ways, and they are three different facts about the machine: the binary is
 * gone, the binary is there and would not run (no permission to execute, an
 * argument the platform cannot carry through a command file), or it ran and never
 * answered. Only the last of those is a timeout, and calling the middle one by
 * that name would put "did not answer within the budget" in front of a person
 * whose binary never started.
 */
function noAnswer(which, answer, timeoutMs, carry) {
  if (answer.missing) {
    return verdict('unavailable', 'binary_missing',
      'the Cursor binary the host named could not be started', carry);
  }
  if (answer.timedOut) {
    return verdict('unknown', 'probe_timeout',
      `cursor ${which} did not answer within the ${timeoutMs} ms left of the preflight budget`, carry);
  }
  return verdict('unknown', 'probe_failed', `cursor ${which} did not start`, carry);
}

const verdict = (state, reason, message, extra = {}) => ({
  state,
  reason,
  message,
  checkedAt: isoStamp(),
  source: 'probe',
  resetAt: null,
  ...extra,
});

/**
 * Ask the Cursor account what it can do.
 *
 * `timeoutMs` is what is LEFT of the preflight budget when the adapters start — the
 * binaries were resolved out of the same budget before the race — and both calls
 * share it: what remains after the first is the ceiling of the second. A binary slower than that is a timeout and
 * NOT `unavailable` — `unavailable` claims the account cannot run, and a slow
 * `cursor-agent` says nothing of the kind (the neighbouring finding PB-7 is about
 * exactly that mistake on a live session). `refresh` is ignored: this adapter
 * keeps no cache of its own, and the availability cache upstream has already been
 * consulted.
 */
async function probe({ toolBin: found, timeoutMs }, deps) {
  // The binary arrives already resolved. This adapter does not call
  // `resolveToolBin` itself and must not: a host is free to run `--version` inside
  // it — this package's own Cursor driver says it does, with a ceiling of its own —
  // and that call is synchronous, so an adapter making it would hold the event loop
  // and stop the timer that bounds the whole preflight. The preflight resolves every
  // binary once before the race and hands over what is left of the budget, so the
  // deadline below is already net of the resolve.
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const left = () => deadline - Date.now();
  if (!found) {
    return verdict('unknown', 'probe_failed',
      'the host resolved no Cursor binary, so the account was never asked');
  }
  if (!found.ok || !found.bin) {
    return verdict('unavailable', 'binary_missing',
      'no Cursor binary on this machine — the host resolved none');
  }
  // The version the host read while resolving. Nothing is asked for it: resolve
  // already runs `--version`, and the driver reads the same field at option
  // refuse. Absent — the field is simply left out, which is what the contract
  // says about a version the probe did not read.
  const version = typeof found.version === 'string' && found.version.trim()
    ? found.version.trim()
    : null;
  const carry = version ? { version } : {};

  const status = await runOut(found.bin, STATUS_ARGS, left());
  if (!status.ok) return noAnswer('status', status, timeoutMs, carry);
  const auth = authState(status.out);
  if (auth === 'out') {
    return verdict('unavailable', 'not_authenticated',
      'the Cursor binary is there; this account is not logged in — run cursor-agent login', carry);
  }
  if (auth === 'unreadable') {
    return verdict('unknown', 'probe_failed',
      'the status line came back in a shape this adapter does not read', carry);
  }

  const listed = await runOut(found.bin, MODELS_ARGS, left());
  if (!listed.ok) return noAnswer('models', listed, timeoutMs, carry);
  const models = listed.status === 0 ? parseModels(listed.out) : [];
  if (!models.length) {
    // Logged in and the inventory unreadable is not an account with no models:
    // the listing is ~210 rows on every account that has one. Reporting it as an
    // empty inventory would exclude every Cursor tuple as `model-not-in-inventory`
    // and blame the catalog for a parse.
    return verdict('unknown', 'probe_failed', listed.status === 0
      ? 'logged in, but the model listing came back in a shape this adapter does not read'
      : 'logged in, but the model listing refused', carry);
  }

  // Authenticated and the inventory in hand. What the BINARY can say ends here;
  // the limit comes from the dashboard's own call, and it is the account half of
  // this probe (ADR-004).
  const inventory = { models };
  return limitVerdict({
    deadline, timeoutMs, deps, carry: { ...carry, ...inventory }, inventory: models.map((m) => m.model),
  });
}

/**
 * The second half of the probe: the billing cycle, the two pools, the tier.
 *
 * It is a function of its own because the first half answers about the BINARY and
 * this one about the ACCOUNT's plan, and because the branch table below is what a
 * person reads when a live run says something unexpected. `inventory` is the list
 * of ids the binary just printed: the `auto` pool's scope is drawn from it, so the
 * ids that travel are ids the resolver will really see.
 */
async function limitVerdict({ deadline, timeoutMs, deps, carry, inventory }) {
  const left = () => deadline - Date.now();
  const listed = `${inventory.length} models listed`;
  const unknown = (what) => verdict('unknown', 'quota_unknown',
    `authenticated; ${listed}; ${what}, so the remaining limit stays unknown`, carry);

  if (left() <= 0) return unknown('the preflight budget ran out before the usage call was made');

  const held = await deps.readToken({ timeoutMs: left() });
  const token = held?.token ?? null;
  const fromEnv = held?.source === 'env';
  if (!token) {
    // **Not `not_authenticated`.** `status` has already answered the auth
    // question and the binary just listed the inventory, so the account is fine;
    // what failed is reading the bearer this adapter needs for a SECOND channel.
    // Calling that a logged-out account would take every Cursor tuple out of
    // routing on a keychain that would not open. PB-27's text says
    // `not_authenticated` here; ADR-004's own reading of the word is what this
    // follows, and the reference says so.
    return unknown('no access token could be read from the keychain or the environment');
  }
  const backend = await deps.readBackendUrl();
  if (left() <= 0) return unknown('the preflight budget ran out before the usage call was made');

  const usage = await deps.postJson(`${backend}/${USAGE_METHOD}`, { token, timeoutMs: left() });
  if (usage.error === 'timeout') {
    return verdict('unknown', 'probe_timeout',
      `the usage call did not answer within the ${timeoutMs} ms left of the preflight budget`, carry);
  }
  if (usage.error) return verdict('unknown', 'probe_failed', 'the usage call could not be reached', carry);
  if (usage.status === 401 || usage.status === 403) {
    // A refusal of the KEYCHAIN token is a statement about the account: it is the
    // credential the spike measured this call answering, so a 401 on it means the
    // login is no longer good. A refusal of `CURSOR_API_KEY` says nothing of the
    // kind — nothing measured says DashboardService accepts an API key at all, so
    // the honest reading is that this adapter could not learn the limit, and
    // marking the harness `unavailable` on it would drop every Cursor tuple out of
    // routing because of a variable a person exported for the binary.
    if (fromEnv) {
      return unknown(`the ${TOKEN_ENV} key was refused by the usage endpoint, and that path is not measured`);
    }
    return verdict('unavailable', 'not_authenticated',
      'the stored Cursor token was refused — sign in again with cursor-agent login', carry);
  }
  if (usage.status !== 200 || !usage.doc) {
    return unknown(`the usage call answered ${usage.status ?? 'nothing'} this adapter cannot read`);
  }

  const tier = derivedTier(usage.doc);
  const tiered = tier ? { ...carry, tier } : carry;

  // The pool a model is billed to is a fact the harness states, and the bucket
  // list is not the only place it states it — measured 2026-09-06, that list lags
  // Cursor's own billing by a model family. The aggregation states it per model
  // for every model with an event this cycle, so it is asked BEFORE the windows
  // are built: the ids it names join the `auto` scope. It is optional in the way
  // the policy call is — a refusal, a non-200, an unparsable body or an empty
  // budget costs the second route and leaves the bucket list as the whole answer,
  // which is the behaviour this adapter had before.
  //
  // A TIMEOUT here costs more than the route, and the shared budget is why: the
  // call is aborted at `left()`, so an endpoint that hangs drains what remains of
  // the preflight and the policy call below is never made — the tier route and the
  // near-limit note go together. The windows are unaffected: they are built from
  // the usage answer already in hand. Nothing caps this call below `left()`,
  // because a cap invented here would be a budget nobody measured.
  // The body is the same empty object every method here
  // is asked with: measured 2026-09-06, `{}` answers 200 and the `aggregations`
  // it returns cover the current billing cycle, so no date range is sent.
  let events = null;
  if (left() > 0) {
    const aggregated = await deps.postJson(`${backend}/${EVENTS_METHOD}`, { token, timeoutMs: left() });
    if (aggregated?.status === 200 && aggregated.doc) events = aggregated.doc;
  }
  const windows = periodWindows(usage.doc, inventory, events);
  if (!windows.length) {
    return verdict('unknown', 'quota_unknown',
      `authenticated; ${listed}; the usage call named no billing cycle this adapter can place`, tiered);
  }

  // The policy call is optional by PB-27, and it is asked last on purpose: it
  // carries a WARNING and the windows are the fact. A refusal, a timeout or an
  // empty budget costs the note and nothing else.
  let note = null;
  if (left() > 0) {
    const policy = await deps.postJson(`${backend}/${POLICY_METHOD}`, { token, timeoutMs: left() });
    if (policy?.status === 200 && policy.doc) note = nudgeNote(policy.doc);
  }

  // A pool at or past 100 % is spent for the tuples it covers, and the resolver
  // reads that per tuple as the binding window (ADR-004). The HARNESS is exhausted
  // only when BOTH pools were read and both are spent: `exhausted` takes every
  // Cursor tuple out of routing, one spent pool leaves the other one running, and
  // a list of one window is not evidence about the pool that is missing from it —
  // which is exactly the case where the `auto` pool had no id list and only the
  // `api` window was reported.
  const spentPool = (id) => windows.find((w) => w.id === id)?.usedPercent >= 100;
  const bothRead = windows.length === 2;
  const spent = bothRead && spentPool(AUTO_WINDOW) && spentPool(API_WINDOW);

  const count = `${windows.length} limit window${windows.length === 1 ? '' : 's'}`;
  if (spent) {
    // The harness's own line is carried HERE and not on the healthy branch: it is
    // written for a person who is out of usage, and beside `available` it reads as
    // a contradiction — "available … the harness says: you've hit your usage
    // limit".
    const said = sanitizeMessage(usage.doc.displayMessage);
    const tail = [count, ...(note ? [note] : []), ...(said ? [`the harness says: ${said}`] : [])].join('; ');
    return verdict('exhausted', 'subscription_exhausted',
      `both usage pools are spent; ${tail}`,
      { ...tiered, windows, resetAt: windows[0].resetAt ?? null });
  }
  const tail = [count, ...(note ? [note] : [])].join('; ');
  return verdict('available', null, `authenticated; ${listed}; ${tail}`, { ...tiered, windows });
}

/**
 * The adapter the driver declares. The tool name comes from the driver rather than
 * being repeated here: it is the same string the driver puts in `options.tool`,
 * and a second copy of it is a drift waiting to happen. It is declared rather than
 * used: the preflight resolves it and hands the binary back in the request.
 *
 * `deps` is the seam for everything that leaves this process without being the
 * harness binary: the token read, the backend URL and the three POSTs. It defaults
 * to the live implementations, so the driver declares the adapter exactly as it
 * did; the suite passes its own, which is what lets every branch above be checked
 * without a network or a person's keychain.
 */
export function cursorAvailability(tool, deps = {}) {
  const wired = { ...LIVE, ...deps };
  return { tool, probe: (request) => probe(request, wired) };
}
