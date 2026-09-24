import path from 'node:path';
import { PromptobusError } from '../dist/index.js';
import { info, warn, fail } from './util.js';
import { run } from './exec.js';
import { harnessBin } from './harness-home.js';

// Lift a bus participant and the registry of their sessions; both live here or spawn.js and
// review.js would import each other. One lift per role — line-by-line copies had drifted.
const ROLE = {
  worker: { nom: 'worker', acc: 'the worker' },
  reviewer: { nom: 'reviewer', acc: 'the reviewer' },
  approver: { nom: 'approver', acc: 'the approver' },
};

// `limit-hit-at-start`: when a lift fails on a limit spent since the preflight.
// [guides/model-routing.md#limit-hit-at-start-when-a-lift-fails-on-a-limit-spent-since-the-preflight](../docs/guides/model-routing.md#limit-hit-at-start-when-a-lift-fails-on-a-limit-spent-since-the-preflight)
export async function liftoffParticipant({
  tool, argv, cwd, env, name, role, launchFailNote = '', deadNote = '', persist, awaitOptions,
  sayLimit = null,
}) {
  const who = ROLE[role];
  // The shared minute bounds this `--bg` registration call, not the session's
  // lifetime; session appearance is retried separately by awaitSession below.
  const r = run(tool.bin, argv, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The same words on three refusal branches: the route is one and is held by the record
  // written before launch.
  if (r.error?.code === 'ENOENT') fail(`${tool.bin}: the binary vanished between the check and launch — nothing to start ${who.acc} with.${launchFailNote}`);
  if (r.error) fail(`claude --bg: ${r.error.message}.${launchFailNote}`);
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
  if (r.status !== 0) {
    const limitNote = sayLimit?.(output) ?? '';
    const said = `claude --bg exited with code ${r.status}${output ? `: ${output}` : ''}.${launchFailNote}${limitNote}`;
    if (limitNote) throw new PromptobusError('limit-hit-at-start', said);
    fail(said);
  }

  // Did the session come up? `claude --bg` returns 0 and prints "backgrounded" even when
  // there will be none. Checked with the same `findSession` as `status`; a short retry.
  const seen = await awaitSession(name, awaitOptions);
  const session = spawnedSessionId(seen, output);
  // Written on a second pass — the id is unknowable before launch — and taken ONLY from
  // the harness record: `parseSessionId` legally returns a token, not an identifier.
  persist(session, seen.state, sessionIdFull(seen));
  if (seen.state === 'dead') {
    const limitNote = sayLimit?.(output) ?? '';
    if (output) info(output);
    const said = `claude --bg reported success, but there is no live session "${name}" in claude agents — ${who.nom} was NOT started.`
      + (seen.ghost ? ` A record of a past session sits under this name (${seen.ghost.id ?? 'no id'}), having outlived its daemon — that is not it.` : '')
      + deadNote + limitNote;
    if (limitNote) throw new PromptobusError('limit-hit-at-start', said);
    fail(said);
  }
  return { output, session, seen };
}

// What is said after a successful lift, the same for every role: an unconfirmed check and
// an unparsed id are not a refusal — the participant is up and can be found by name.
export function sayLiftoff({ name, seen, session, output }) {
  if (seen.state === 'unknown') {
    warn(`lift of session "${name}" is not confirmed: claude agents --json was not parsed.`
      + ' Check yourself — a missing participant is as silent as a working one.');
  }
  if (!session) warn(`session identifier was not parsed from the output — look it up by name "${name}": claude agents`);
  if (output) info(output);
}

// Background-session identifier from `claude --bg` output. Output format is not a
// contract: if we did not parse it — that is not a refusal.
export function parseSessionId(output) {
  const text = String(output ?? '');
  const uuid = text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  if (uuid) return uuid[0];
  // Observed v2.1.221 format: "backgrounded · d7b7340b · <name>".
  const bg = text.match(/backgrounded\W+([0-9a-f]{6,})/i);
  if (bg) return bg[1];
  // The third pattern is a spare and deliberately narrow: the value must carry a digit, or
  // "session started successfully" would declare `started` the identifier.
  const named = text.match(/\b(?:agent|session|id)\b\W{0,4}([A-Za-z0-9][\w-]{5,})/i);
  return named && /\d/.test(named[1]) ? named[1] : null;
}

// Where the session id comes from after a spawn; the order matters and is tested. Why this
// name: [03-cli.md § The session id after a lift](../docs/reference/03-cli.md#the-session-id-after-a-lift).
export function spawnedSessionId(seen, output) {
  return seen?.session?.id ?? parseSessionId(output);
}

// The full session identifier — the one the session calls itself — and only from the
// harness record: [03-cli.md § The session id after a lift](../docs/reference/03-cli.md#the-session-id-after-a-lift).
export function sessionIdFull(seen) {
  const full = seen?.session?.sessionId;
  return typeof full === 'string' && full.trim() ? full.trim() : null;
}

// Wait for the session to appear. Outcomes: `alive` — found, `dead` — not found in all
// attempts, `unknown` — `claude agents --json` output was not parsed, which is not death.
export async function awaitSession(name, { tries = 6, delayMs = 500, sessions = bgSessions } = {}) {
  let ghost = null;
  for (let i = 0; i < tries; i += 1) {
    // The list changes after `--bg`: without a reset the cache of the first empty probe
    // would declare a just-lifted session missing on every remaining attempt.
    if (sessions === bgSessions) resetBgSessionsCache();
    const list = sessions();
    if (list === null) return { state: 'unknown', session: null, ghost: null };
    const hit = findSession(list, name);
    // A matching name is not enough: a restarted worker reuses the address, and the past
    // session's record does not vanish from the list.
    if (hit && sessionLiveness(hit, list) === 'alive') return { state: 'alive', session: hit, ghost: null };
    if (hit) ghost = hit;
    if (i < tries - 1) await new Promise((r) => { setTimeout(r, delayMs); });
  }
  return { state: 'dead', session: null, ghost };
}

// Live background sessions by the names we set at spawn.
// [reference/03-cli.md#bgsessionscache--live-background-sessions-by-the-names-we-set-at-spawn](../docs/reference/03-cli.md#bgsessionscache--live-background-sessions-by-the-names-we-set-at-spawn)
let bgSessionsCache = undefined;

export function resetBgSessionsCache() {
  bgSessionsCache = undefined;
}

export function bgSessions({ fresh = false } = {}) {
  return readBgSessions({ fresh }).list;
}

// The same read, saying WHY there is no list: `missing` — the harness binary was not found or does
// not start, in words that name it; `null` beside a `null` list — it ran and did not parse.
export function readBgSessions({ fresh = false } = {}) {
  if (!fresh && bgSessionsCache !== undefined) return { list: bgSessionsCache, missing: null };
  const { r, missing } = runClaude(['agents', '--json']);
  if (missing) return { list: null, missing };
  if (r.error || r.status !== 0) return { list: null, missing: null };
  try {
    const parsed = JSON.parse(r.stdout);
    const list = Array.isArray(parsed) ? parsed : parsed.agents ?? parsed.sessions ?? [];
    if (!Array.isArray(list)) return { list: null, missing: null };
    bgSessionsCache = list;
    return { list, missing: null };
  } catch {
    return { list: null, missing: null };
  }
}

// `claude <args>` through the binary the host names — the lift's door, not this process's PATH:
// [05-drivers.md § The harness binary after a lift](../docs/reference/05-drivers.md#the-harness-binary-after-a-lift-the-lifts-door-not-path).
export function runClaude(args) {
  const tool = harnessBin('claude');
  if (!tool.bin) return { r: null, missing: `the harness binary was not found: ${tool.reason}` };
  const r = run(tool.bin, args, { encoding: 'utf8' });
  const code = r.error?.code;
  if (code === 'EACCES' || code === 'ENOEXEC') {
    return { r: null, missing: `the harness binary does not start: ${tool.bin} (${code})` };
  }
  if (code !== 'ENOENT') return { r, missing: null };
  const where = path.isAbsolute(tool.bin) || tool.bin.includes(path.sep) ? tool.bin
    : `${tool.bin} on this process's PATH (a background session's PATH is its daemon's, not a terminal's)`;
  return { r: null, missing: `the harness binary was not found: looked for ${where}` };
}

// By the record's `name` field and in full: a substring over the whole record would match a
// session whose `cwd` holds another name. No `kind` filter — a vanished field kills all.
export function findSession(sessions, name) {
  const hits = (sessions ?? []).filter((s) => s?.name === name);
  if (!hits.length) return null;
  // More than one record is normal: a ghost and a new session. We pick the live one.
  return hits.find((s) => sessionLiveness(s, sessions) === 'alive') ?? hits[0];
}

// A record is not liveness — it outlives its daemon, and `pid` separates them. The signal
// is self-calibrating: a missing `pid` means "listed" only where this claude prints one.
export function sessionLiveness(session, sessions = null) {
  if (!session) return 'dead';
  const hasPid = (s) => typeof s?.pid === 'number' && s.pid > 0;
  if (hasPid(session)) return 'alive';
  return (sessions ?? []).some(hasPid) ? 'stale' : 'alive';
}
