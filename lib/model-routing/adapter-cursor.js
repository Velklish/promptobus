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
// **Cursor has no quota source at all.** There is no limit API, no usage
// subcommand and no window the binary will name, so a successful probe is not
// `available`: it is `unknown` / `quota_unknown`, which is the reason code
// written for exactly this — auth is fine, the remaining limit is not knowable.
// The resolver penalises `unknown` rather than blocking it, so the harness stays
// a candidate. No `windows` are reported, because inventing one would put a
// number on disk that no harness said.
//
// Both commands print ANSI colour even when stdout is not a terminal (measured
// 2026-09-05 on `cursor-agent` 2026.09.02-c22c1a3), so everything is stripped
// before it is looked at.
//
// **Nothing read here reaches `message`.** `status` prints the account address
// on success; the adapter counts and classifies, and writes its own diagnosis.
// The verdict `message` is the only free-text field that reaches the cache file.
import { spawn } from 'node:child_process';
import { planRun } from '../exec.js';
import { isoStamp } from './cache.js';

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
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, timedOut: true });
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
async function probe({ toolBin: found, timeoutMs }) {
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

  // Authenticated and the inventory in hand — and still `unknown`. Cursor exposes
  // no remaining-limit source, and `quota_unknown` is the code written for that;
  // `available` would claim a limit was confirmed.
  return verdict('unknown', 'quota_unknown',
    `authenticated; ${models.length} models listed; Cursor exposes no remaining-limit source`,
    { ...carry, models });
}

/**
 * The adapter the driver declares. The tool name comes from the driver rather than
 * being repeated here: it is the same string the driver puts in `options.tool`,
 * and a second copy of it is a drift waiting to happen. It is declared rather than
 * used: the preflight resolves it and hands the binary back in the request.
 */
export function cursorAvailability(tool) {
  return { tool, probe: (request) => probe(request) };
}
