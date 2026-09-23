// Claude Code adapter: what the probe reads.
// [guides/model-routing.md#claude-code-adapter-what-the-probe-reads](../../docs/guides/model-routing.md#claude-code-adapter-what-the-probe-reads)
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { stampAtMs } from './cache.js';
import {
  readKeychainSecret, requestJson, spawnAndCapture, verdict,
} from './adapter-common.js';

/** The binary. The same name is what the host is asked to resolve. */
const TOOL = 'claude';

/** The auth check, whole. `--json` is that subcommand's documented default and is named anyway:
 * a default that flips in a later build would turn the parse below into a silent quota_unknown. */
const AUTH_ARGV = ['auth', 'status', '--json'];

/** The credential record on macOS: one keychain generic password, read by `readKeychainSecret`. */
const CREDENTIAL_SERVICE = 'Claude Code-credentials';

/** The credential record everywhere else; the Linux path was not measured. `CLAUDE_CONFIG_DIR`
 * moves the whole directory, so it is read here — looking under `~/.claude` regardless lies. */
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

/** Window lengths by kind: the kinds' own, and the payload states neither. ADR-004 requires
 * `lengthSec` on every window — an adapter that cannot state a length reports no window. */
const SESSION_LENGTH_SEC = 18_000;
const WEEKLY_LENGTH_SEC = 604_800;

/** The three `limits[]` rows this adapter places. A row of any other kind is left out rather
 * than guessed at: the endpoint is not a published contract. */
const WINDOW_KINDS = {
  session: { id: 'session', kind: 'session', lengthSec: SESSION_LENGTH_SEC },
  weekly_all: { id: 'weekly', kind: 'weekly', lengthSec: WEEKLY_LENGTH_SEC },
  weekly_scoped: { id: 'weekly', kind: 'weekly', lengthSec: WEEKLY_LENGTH_SEC },
};

/** A moment as the snapshot writes them, or `null`. The UNIT is this adapter's fact; the range
 * check and formatting are shared. A number is refused — this endpoint names moments in strings. */
export function stampOf(value) {
  return typeof value === 'string' ? stampAtMs(Date.parse(value)) : null;
}

/** The model ids a scope's display name resolves to, or null when it resolves to none.
 * [guides/model-routing.md#scopemodels--resolving-a-scope-display-name-to-model-ids](../../docs/guides/model-routing.md#scopemodels--resolving-a-scope-display-name-to-model-ids) */
export function scopeModels(displayName, table) {
  const key = String(displayName ?? '').trim().toLowerCase();
  const ids = table?.[key];
  return Array.isArray(ids) && ids.length ? [...ids] : null;
}

/** A display name as a window id fragment: lower case, one dash between words. */
const slug = (name) => String(name).trim().toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Three fields of the credential record, and no fourth. The shape is the enforcement:
 * `refreshToken` is never read, so it cannot be carried into a message, a log or a cache. */
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
  // `typeof` first: `Number(null)`, `Number('')` and `Number(false)` are all 0, and an absent
  // expiry would read as a token that expired in 1970.
  const expiresAt = typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt)
    ? oauth.expiresAt
    : null;
  const tier = typeof oauth.rateLimitTier === 'string' && oauth.rateLimitTier.trim()
    ? oauth.rateLimitTier.trim()
    : null;
  return { accessToken, expiresAt, tier };
}

// The usage answer as ADR-004 windows.
// [guides/model-routing.md#usagewindows--the-usage-answer-as-adr-004-windows](../../docs/guides/model-routing.md#usagewindows--the-usage-answer-as-adr-004-windows)
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
      // A scoped row that does not name its model is not placeable: it would sit as a second
      // `weekly` window covering nothing, and the resolver could not tell which tuples it binds.
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

// The account-wide row that is spent, or none.
// [guides/model-routing.md#spentwindow--the-account-wide-row-that-is-spent-or-none](../../docs/guides/model-routing.md#spentwindow--the-account-wide-row-that-is-spent-or-none)
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

/** A launch failure or signal name, when it has the shape of a code — the same rule the preflight
 * applies to an adapter's own codes. Nothing else from a failed launch is quoted. */
const ERRNO = /^[A-Z][A-Z0-9_]{1,20}$/;
const codeOf = (value) => (ERRNO.test(String(value ?? '')) ? String(value) : null);

/** Whether the account is logged in, or `null`. Three outcomes, not two: "the binary said no" and
 * "the binary said something unreadable" are different facts, and only the first is a logout. */
function loggedIn(stdout) {
  try {
    const doc = JSON.parse(String(stdout ?? ''));
    return typeof doc?.loggedIn === 'boolean' ? doc.loggedIn : null;
  } catch {
    return null;
  }
}

/** Run a command and hand back what it did, never rejecting: every outcome is data for a verdict.
 * `stderr` is not piped at all, and `timedOut` is set by OUR timer and by nothing else. */
async function runCapture(bin, argv, ms) {
  const r = await spawnAndCapture(bin, argv, ms);
  if (!r.launched) return { error: r.error, timedOut: false };
  return {
    timedOut: r.timedOut, stdout: r.stdout, status: r.status, signal: r.signal,
  };
}

/** The credential record as text, or `null`. Two platforms, two mechanisms, one answer — and
 * nothing is said about WHY a read failed: to the caller every reason means no token. */
async function liveCredential({ timeoutMs }) {
  if (process.platform === 'darwin') {
    return readKeychainSecret(CREDENTIAL_SERVICE, { timeoutMs });
  }
  try {
    return await readFile(credentialFile(), 'utf8');
  } catch {
    return null;
  }
}

/** The three headers both endpoints want, and no fourth. Exported so the shape can be checked
 * without a request: it is the only place a token is written. */
export function oauthHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    'anthropic-beta': OAUTH_BETA,
    accept: 'application/json',
  };
}

/** One GET, JSON in hand or a word for why not. `timeout` and `network` are different verdicts;
 * the token appears in one header only, and the response text is parsed and dropped. */
async function liveGetJson(url, { token, timeoutMs }) {
  return requestJson(url, { headers: oauthHeaders(token), timeoutMs });
}

/** The live side of the two calls that leave this process. Replaced whole by the suite. */
const LIVE = { readCredential: liveCredential, getJson: liveGetJson };

/** The probe itself; never throws. The binary arrives already resolved — `resolveToolBin` is
 * synchronous, and an adapter calling it would stop the timer that bounds the preflight. */
async function probe({ toolBin: tool, timeoutMs }, inventoryOf, deps) {
  const deadline = Date.now() + timeoutMs;
  if (!tool) {
    return verdict('unknown', 'probe_failed', 'the host resolved no tool binary, so the harness was never asked');
  }
  if (!tool.ok || !tool.bin) {
    return verdict('unavailable', 'binary_missing',
      `no ${TOOL} binary on this machine — install it, or stop declaring this harness in the workspace`);
  }
  // The version belongs in the verdict on every branch, logged in or not: it is what a person
  // reads first when the adapter starts answering something new after an update.
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
    // A signal we did not send is a crash or a person's `kill`, not the budget: `probe_timeout`
    // would hide a harness that dies on every probe behind "the machine was busy".
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
  const models = inventoryOf(tool.version);
  const inventory = { models: models.map((model) => ({ model })) };
  const listed = `${models.length} model ${models.length === 1 ? 'alias' : 'aliases'} the harness accepts`;

  return limitVerdict({ deadline, timeoutMs, deps, carry: { ...version, ...inventory }, listed });
}

/** The second half of the probe: the tier, the windows, and the states they reach. Its own
 * function because the first half answers about the BINARY and this one about the ACCOUNT. */
async function limitVerdict({ deadline, timeoutMs, deps, carry, listed }) {
  const left = () => deadline - Date.now();
  const spent = (what) => verdict('unknown', 'quota_unknown',
    `authenticated; ${listed}; ${what}, so the remaining limit stays unknown`, carry);

  if (left() <= 0) return spent('the preflight budget ran out before the usage endpoint was asked');

  const record = credentialRecord(await deps.readCredential({ timeoutMs: left() }));
  if (!record) {
    // Logged in by the binary's own answer, and no credential record this adapter can read.
    // Nothing is claimed about the login — only about the limit.
    return spent('the credential record could not be read');
  }
  // The tier is the record's, and it survives every branch below: it is known
  // offline, and an expired token or a refused endpoint does not unknow it.
  const tier = record.tier ? { tier: { name: record.tier, source: 'credentials' } } : {};
  const held = { ...carry, ...tier };
  const stale = (what) => verdict('unknown', 'quota_unknown',
    `authenticated; ${listed}; ${what}, so the remaining limit stays unknown`, held);

  if (Number.isFinite(record.expiresAt) && record.expiresAt <= Date.now()) {
    // **Never a refresh.** The refresh endpoint rotates the credentials Claude Code is holding,
    // and a preflight that did it would sign a person out of the session they are working in.
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
    // The binary says logged in and the endpoint refuses its token: an account this run cannot
    // use, and the one HTTP status that is a statement about the account, not the request.
    return verdict('unavailable', 'not_authenticated',
      'the stored credentials were refused by the usage endpoint — sign in again with `claude auth login`', held);
  }
  if (usage.status !== 200 || !usage.doc) {
    return stale(`the usage endpoint answered ${usage.status ?? 'nothing'} this adapter cannot read`);
  }

  // The profile is asked for ONE field and only when the record named no tier: a request that
  // answers a question already answered offline is a request nobody needed.
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
    // **An exhaustion with no reset is STICKY** — only `--clear-exhausted` lifts it. So the two
    // cases say different things, and the second names the way out rather than a moment.
    const said = reached.resetAt
      ? `the ${reached.id} limit is spent; a turn is refused until it resets`
      : `the ${reached.id} limit is spent and the harness named no reset — neither time nor a later `
        + `probe lifts this mark; clear it with \`${deps.clearHint}\``;
    return verdict('exhausted', 'subscription_exhausted', said, { ...done, resetAt: reached.resetAt });
  }
  if (!windows.length) {
    // The endpoint answered and named no window this adapter places: the limit is as unknown as
    // before the call, and `available` would claim one was confirmed.
    return verdict('unknown', 'quota_unknown',
      `authenticated; ${listed}; the usage endpoint named no limit window`, carried);
  }
  return verdict('available', null,
    `authenticated; ${listed}; ${windows.length} limit window${windows.length === 1 ? '' : 's'}`, done);
}

/** The adapter a driver declares as `availability`.
 * [guides/model-routing.md#claudeavailability--the-adapter-a-driver-declares-as-availability](../../docs/guides/model-routing.md#claudeavailability--the-adapter-a-driver-declares-as-availability) */
export function claudeAvailability(inventoryOf, scopeIds, deps = {}) {
  const wired = { ...LIVE, ...deps, scopeIds };
  return {
    tool: TOOL,
    probe: (request) => probe(request, inventoryOf, {
      ...wired,
      clearHint: request.host?.busCommand?.(['models', '--clear-exhausted', TOOL]) ?? wired.clearHint,
    }),
  };
}
