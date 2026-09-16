// Cursor adapter: what the probe reads.
// [guides/model-routing.md#cursor-adapter-what-the-probe-reads](../../docs/guides/model-routing.md#cursor-adapter-what-the-probe-reads)
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { stampAtMs } from './cache.js';
import {
  readKeychainSecret, requestJson, spawnAndCapture, verdict,
} from './adapter-common.js';

/** Subcommands, as they were measured. `status` exits 0 in both the logged-in and the logged-out
 * case, so the exit code is not the auth answer — the text is. */
const STATUS_ARGS = ['status'];
const MODELS_ARGS = ['models'];

/** ANSI colour. `models` wraps every id and display name in escapes and `status` colours its tick;
 * a parse that did not strip these would see no line it recognises. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1B\[[0-9;]*[A-Za-z]/g;

/** The logged-in line, and the trap under it: "not logged in" CONTAINS "logged in", so a single
 * positive pattern reads a logged-out binary as authenticated. The negative wins. */
const LOGGED_IN = /logged in as\s+\S/i;
const NOT_LOGGED_IN = /\bnot\s+logged\s+in\b/i;

/** One inventory row: `<id> - <Display Name>`. The id is taken WHOLE, effort suffix included, and
 * the row is recognised by the SHAPE of its id next to a literal ` - `, not by field count. */
const MODEL_ROW = /^([A-Za-z0-9][A-Za-z0-9._+-]*)\s+-\s+(.+)$/;

/** The mark Cursor prints on a model outside zero-data-retention. It travels as a flag and is NOT
 * judged here: a consumer that must not use such a model denies it in an overlay. */
const NO_ZDR = /\(NO ZDR\)/;
const NO_ZDR_FLAG = 'no-zdr';

const stripAnsi = (text) => String(text ?? '').replace(ANSI, '');

/** The bearer, by the two routes the binary knows. **The keychain token is first** — the measured
 * one; `CURSOR_API_KEY` is a fallback. `cursor-refresh-token` is never asked for. */
const TOKEN_ENV = 'CURSOR_API_KEY';
const TOKEN_SERVICE = 'cursor-access-token';

/** Where the backend URL is cached, and the fallback when it is not there. The file also holds
 * `authInfo`, and ONE field of it is parsed: this cache promises to hold no address. */
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

/** The `tier` an aggregation row carries for a model billed to the Auto pool. 1 is the api pool,
 * and no other value is measured — a row with one is left alone. */
const AUTO_TIER = 2;

/** The cycle boundaries arrive as epoch milliseconds IN A STRING, which is how Connect carries a
 * 64-bit integer. The UNIT is this adapter's fact; the range check is shared. */
function epochMs(value) {
  const ms = typeof value === 'number' ? value : (/^\d{1,15}$/.test(String(value ?? '')) ? Number(value) : NaN);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** A percentage the snapshot will take, or `null`. Capped at 100 rather than dropped above it:
 * `bonusSpend` can carry the total past the included amount, and "spent" is what that means. */
function percentOf(value) {
  // `typeof` first, because `Number(null)` and `Number('')` are 0: a field the answer left out
  // would become a pool reported as untouched, the one wrong number nobody would question.
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(100, value);
}

// The inventory ids the auto pool covers.
// [guides/model-routing.md#autopoolmodels--the-inventory-ids-the-auto-pool-covers](../../docs/guides/model-routing.md#autopoolmodels--the-inventory-ids-the-auto-pool-covers)
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

// The ids Cursor BILLED to the auto pool this cycle, off `GetAggregatedUsageEvents`.
// [guides/model-routing.md#autotiermodels--the-ids-cursor-billed-to-the-auto-pool-this-cycle-off-getaggregatedusageevents](../../docs/guides/model-routing.md#autotiermodels--the-ids-cursor-billed-to-the-auto-pool-this-cycle-off-getaggregatedusageevents)
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

/** The billing cycle as ADR-004 windows: one length, two pools. `lengthSec` is the cycle the answer
 * states, not thirty days; unreadable boundaries yield no window, since a pace needs a length. */
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

/** The tier, derived, or `null`. **No Cursor method returns the plan name**, so ADR-004 makes the
 * cycle's included amount the proxy — the PLAN's cents, never the account's spend. */
export function derivedTier(usage) {
  // `typeof` first: `Number(null)` and `Number('')` are 0, and a plan that named no included
  // amount would come out as `included:0` — a tier a person would read as measured.
  const limit = usage?.planUsage?.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) return null;
  return { name: `included:${limit}`, source: 'derived' };
}

/** A line of harness text made safe for a diagnosis, or `null`: control characters out, whitespace
 * collapsed, 120 characters, and any `@` refused — an address is what the cache never holds. */
export function sanitizeMessage(text) {
  if (typeof text !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean || clean.includes('@')) return null;
  return clean.length > 120 ? `${clean.slice(0, 119)}…` : clean;
}

/** A model id as the harness prints one. The nudge names one, and only this shape travels. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** Cursor's own near-limit signal in this adapter's words, or `null`. The threshold and the target
 * travel; the nudge's `label` is prose written for a dialog and does not. */
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

/** The backend URL the CLI cached, or `null`. **Only `https:` is accepted**: a bearer token is about
 * to be sent there, and a refused value falls back to the measured default. */
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

/** Run a harness command and hand back its exit code and stdout, or say how it failed. Asynchronous
 * on purpose — a `spawnSync` here would block the one budget timer. stderr is `ignore`d. */
async function runOut(cmd, args, timeoutMs) {
  if (timeoutMs <= 0) return { ok: false, timedOut: true };
  const r = await spawnAndCapture(cmd, args, timeoutMs);
  if (!r.launched) return { ok: false, missing: r.error?.code === 'ENOENT' };
  if (r.timedOut) return { ok: false, timedOut: true };
  return { ok: true, status: r.status, out: r.stdout };
}


/** The bearer, or `null` when neither route has one. The answer says WHICH of the two it found,
 * because that decides what a refusal means one floor up. `cursor-refresh-token` is never asked. */
async function liveToken({ timeoutMs }) {
  if (process.platform === 'darwin') {
    const token = await readKeychainSecret(TOKEN_SERVICE, { timeoutMs });
    if (token) return { token, source: 'keychain' };
  }
  const named = typeof process.env[TOKEN_ENV] === 'string' ? process.env[TOKEN_ENV].trim() : '';
  return named ? { token: named, source: 'env' } : null;
}

/** The backend URL the CLI cached, or the measured default. Read asynchronously — a probe may not
 * hold the event loop — and a missing or non-https value falls back rather than failing. */
async function liveBackendUrl() {
  try {
    const text = await readFile(path.join(homedir(), ...CLI_CONFIG_FILE), 'utf8');
    return backendUrlOf(text) ?? DEFAULT_BACKEND;
  } catch {
    return DEFAULT_BACKEND;
  }
}

/** One Connect call, JSON in hand or a word for why not. `timeout` and `network` are different
 * verdicts; the token appears in one header only, and the response text is parsed and dropped. */
async function livePostJson(url, { token, timeoutMs }) {
  return requestJson(url, {
    method: 'POST', headers: connectHeaders(token), body: '{}', timeoutMs,
  });
}

/** The three headers Connect wants, and no fourth. Exported so the shape can be checked without a
 * request: `connect-protocol-version` is what makes these methods answer 200 at all. */
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

/** What `status` said: `in`, `out`, or `unreadable`. **The exit code is not consulted** — it is 0
 * either way — and the negative is matched first, because "not logged in" contains "logged in". */
export function authState(stdout) {
  const text = stripAnsi(stdout);
  if (NOT_LOGGED_IN.test(text)) return 'out';
  return LOGGED_IN.test(text) ? 'in' : 'unreadable';
}

/** The verdict for a call that came back with no output, by the way it failed. Three different
 * facts about the machine, and only the last is a timeout. */
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

/** Ask the Cursor account what it can do. `timeoutMs` is what is LEFT of the preflight budget and
 * both calls share it. A slow binary is a timeout and NOT `unavailable`. */
async function probe({ toolBin: found, timeoutMs }, deps) {
  // The binary arrives already resolved. This adapter must not call `resolveToolBin`: it is
  // synchronous, and a host may run `--version` inside it, stopping the preflight's timer.
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
  // The version the host read while resolving; nothing is asked for it. Absent means the field is
  // left out, which is what the contract says about a version the probe did not read.
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
    // Logged in with an unreadable inventory is not an account with no models: the listing is ~210
    // rows on any account. An empty inventory would blame the catalog for a parse.
    return verdict('unknown', 'probe_failed', listed.status === 0
      ? 'logged in, but the model listing came back in a shape this adapter does not read'
      : 'logged in, but the model listing refused', carry);
  }

  // Authenticated and the inventory in hand. What the BINARY can say ends here; the limit comes
  // from the dashboard's own call, the account half of this probe (ADR-004).
  const inventory = { models };
  return limitVerdict({
    deadline, timeoutMs, deps, carry: { ...carry, ...inventory }, inventory: models.map((m) => m.model),
  });
}

/** The second half of the probe: the billing cycle, the two pools, the tier. `inventory` is the ids
 * the binary just printed — the `auto` pool's scope is drawn from it. */
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
    // **Not `not_authenticated`.** `status` already answered the auth question and the inventory
    // listed: what failed is reading the bearer for a SECOND channel.
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
    // A 401 on the KEYCHAIN token is a statement about the account — the measured credential. A 401
    // on `CURSOR_API_KEY` is not: nothing says DashboardService accepts one at all.
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

  // Which pool a model is billed to, and why the bucket list is not the only source:
  // [guides/model-routing.md#events--which-pool-a-model-is-billed-to-and-why-the-bucket-list-is-not-the-only-source](../../docs/guides/model-routing.md#events--which-pool-a-model-is-billed-to-and-why-the-bucket-list-is-not-the-only-source)
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

  // The policy call is optional and asked last on purpose: it carries a WARNING and the windows are
  // the fact. A refusal, a timeout or an empty budget costs the note and nothing else.
  let note = null;
  if (left() > 0) {
    const policy = await deps.postJson(`${backend}/${POLICY_METHOD}`, { token, timeoutMs: left() });
    if (policy?.status === 200 && policy.doc) note = nudgeNote(policy.doc);
  }

  // The HARNESS is exhausted only when BOTH pools were read and both are spent: one spent pool
  // leaves the other running, and a list of one window is no evidence about the one missing.
  const spentPool = (id) => windows.find((w) => w.id === id)?.usedPercent >= 100;
  const bothRead = windows.length === 2;
  const spent = bothRead && spentPool(AUTO_WINDOW) && spentPool(API_WINDOW);

  const count = `${windows.length} limit window${windows.length === 1 ? '' : 's'}`;
  if (spent) {
    // The harness's own line is carried HERE and not on the healthy branch: beside `available` it
    // reads as a contradiction.
    const said = sanitizeMessage(usage.doc.displayMessage);
    const tail = [count, ...(note ? [note] : []), ...(said ? [`the harness says: ${said}`] : [])].join('; ');
    return verdict('exhausted', 'subscription_exhausted',
      `both usage pools are spent; ${tail}`,
      { ...tiered, windows, resetAt: windows[0].resetAt ?? null });
  }
  const tail = [count, ...(note ? [note] : [])].join('; ');
  return verdict('available', null, `authenticated; ${listed}; ${tail}`, { ...tiered, windows });
}

/** The adapter the driver declares; the tool name comes from the driver, so there is no second copy
 * to drift. `deps` is the seam for everything that leaves this process but the harness binary. */
export function cursorAvailability(tool, deps = {}) {
  const wired = { ...LIVE, ...deps };
  return { tool, probe: (request) => probe(request, wired) };
}
