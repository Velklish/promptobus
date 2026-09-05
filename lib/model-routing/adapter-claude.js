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
// **No windows, ever.** Claude Code exposes no stable, documented source for the
// remaining subscription limit, and ADR-003 is explicit that an adapter which
// cannot obtain one answers `unknown` and never models a value. So a logged-in
// account is `unknown` / `quota_unknown` — auth confirmed, limit not — which the
// resolver penalises by ten points instead of dropping the harness. `available`
// is the state this adapter cannot reach in v1, and that is the honest reading:
// the word means auth, model AND limit confirmed.
//
// What of the auth answer reaches the verdict is ONE boolean. The same JSON also
// carries an email address, an organisation id and its name, and none of them may
// travel: `message` is the only free-text field that reaches disk, and the cache
// promises to hold no email and no open account id.
import { spawn } from 'node:child_process';
import { planRun } from '../exec.js';

/** The binary. The same name is what the host is asked to resolve. */
const TOOL = 'claude';

/**
 * The auth check, whole. `--json` is that subcommand's documented default and is
 * named anyway: a default that flips in a later build would turn the parse below
 * into a silent `quota_unknown`, and one flag is cheaper than that.
 */
const AUTH_ARGV = ['auth', 'status', '--json'];

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
 */
function askAuth(bin, ms) {
  const plan = planRun(bin, AUTH_ARGV);
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
 * The probe itself. Never throws: a thrown error is `probe_failed` with its text
 * discarded, so everything this adapter has to say it says in a verdict.
 *
 * The deadline is the FIRST thing taken, before the host is asked anything: the
 * budget is the whole preflight's, and the auth check may only have what is left
 * of it after the binary was resolved. (`resolveToolBin` is itself synchronous and
 * can spend seconds on a cold binary — that is the host's contract, not this
 * adapter's, and it is filed separately.)
 *
 * `refresh` is not read: this adapter holds no cache of its own, and the
 * availability cache upstream has already been consulted by the time it is called.
 */
async function probe({ host, timeoutMs }, models) {
  const deadline = Date.now() + timeoutMs;
  if (typeof host?.resolveToolBin !== 'function') {
    return verdict('unknown', 'probe_failed', 'the host cannot resolve a tool binary, so the harness was never asked');
  }

  const tool = host.resolveToolBin(TOOL);
  if (!tool?.ok || !tool.bin) {
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
      `the ${timeoutMs} ms preflight budget was spent resolving the binary — the auth check was not run`, version);
  }

  const answer = await askAuth(tool.bin, left);
  if (answer.timedOut) {
    return verdict('unknown', 'probe_timeout',
      `the auth check did not finish inside the ${timeoutMs} ms preflight budget`, version);
  }
  if (answer.error) {
    const kind = codeOf(answer.error.code);
    // `ETIMEDOUT` from the platform is the same fact our own timer reports, and
    // the cache retries a timeout in five minutes rather than holding it an hour.
    if (kind === 'ETIMEDOUT') {
      return verdict('unknown', 'probe_timeout',
        `the auth check did not finish inside the ${timeoutMs} ms preflight budget`, version);
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
  return verdict('unknown', 'quota_unknown',
    `authenticated; ${models.length} model ${models.length === 1 ? 'alias' : 'aliases'} the harness accepts, `
    + 'and no stable source for the remaining limit — it stays unknown rather than modelled', {
    ...version,
    // `rated` is not filled here on purpose: this adapter knows the harness, not
    // the catalog, and the preflight sets it from the predicate its caller supplies.
    models: models.map((model) => ({ model })),
  });
}

/**
 * The adapter a driver declares as `availability`.
 *
 * `models` is the inventory to report when the account turns out to be logged in:
 * the alias set the driver accepts, together with its default model. It is a
 * parameter rather than a constant here so that the two facts stay in one file —
 * the driver's — instead of drifting between the lift and the probe.
 */
export function claudeAvailability(models) {
  return { probe: (request) => probe(request, models) };
}
