import { PromptobusError } from '../dist/index.js';
import { info, warn, fail } from './util.js';
import { run } from './exec.js';

// Lift a bus participant and the registry of their sessions. The registry lives here
// together with the lift — otherwise spawn.js and review.js would import each other.
// The lift is one for a worker and a reviewer: line-by-line copies already drifted on
// the "session appeared" check. Role differences — words and routes — arrive as
// parameters.
const ROLE = {
  worker: { nom: 'worker', acc: 'the worker' },
  reviewer: { nom: 'reviewer', acc: 'the reviewer' },
};

// `persist(session, state, sessionId)` — write the participant into the journal. Called
// on ANY check outcome, including a dead spawn: a repeat lift at the same address is a
// normal restart, and without a write it would hit "directory taken, and the participant
// is not in the journal". The check outcome goes as the second argument:
// `applyParticipant` replaces the record whole, and without the outcome a "no session"
// refusal would clear the reviewer's `pending` mark. Third — the FULL session identifier
// (review note): the address-ownership gate checks equality against it, while the short
// id is parsed from free-text output and is only good as a prefix. `launchFailNote` and
// `deadNote` are refusal routes, different per role; `awaitOptions` is a test seam.
// `sayLimit(output)` — the late-start hook. A lift can fail because the account's
// limit was spent between the availability preflight and this launch, and the only
// evidence of that is the harness's own words in `output`. The hook is called on
// the two branches that HAVE those words — a non-zero exit and a session that never
// came up — and on no other: a lift that worked said nothing about a limit.
//
// It RETURNS the line to append to the refusal, or `''` when it marked nothing. The
// mark it writes lands in a file nothing reads yet and no flag clears yet, so a
// refusal that did not name it would leave a person with a state they never saw;
// the words are the driver's, because the file and the command are its own.
//
// It has to be called from HERE rather than by a caller catching a refusal, because
// `fail` ends the process: past that line there is no caller left to classify
// anything. The classification itself is not here — this file knows the lift, and
// what counts as a limit refusal is the driver's own pattern.
//
// **A refusal the hook classified leaves as a typed error, not through `fail`.**
// `limit-hit-at-start` is a published routing code ([03-cli](../docs/reference/03-cli.md)),
// and a code nothing raises is a vocabulary a consumer cannot branch on (PB-21.1).
// So the two branches that HAVE the harness's words throw a `PromptobusError` with
// that code — and they throw it on exactly the condition the hook reports: a
// non-empty line, which the hook returns only after the cache mark was WRITTEN.
//
// That is what the code means, both halves at once: the limit was hit AND the
// harness is now marked exhausted. A limit refusal whose mark could not be written
// — an unreadable routing path, a directory that refuses — returns `''` from the
// hook and leaves through `fail` with no code, which is the honest reading: there
// is no mark for a consumer to act on, and the person gets the same diagnosis
// either way. The CLI catch prints a `PromptobusError` as one line and exits 1,
// exactly as `fail` does; what the code adds is on the way past a consumer.
export async function liftoffParticipant({
  tool, argv, cwd, env, name, role, launchFailNote = '', deadNote = '', persist, awaitOptions,
  sayLimit = null,
}) {
  const who = ROLE[role];
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
  // there will be no session (a silent daemon failure). We check with the same
  // findSession as `promptobus status`; registration lags by fractions of a second — a
  // short retry.
  const seen = await awaitSession(name, awaitOptions);
  const session = spawnedSessionId(seen, output);
  // The session identifier is written on a second run: there is nowhere to know it
  // before launch. The full one is taken ONLY from the harness record (`sessionId` next
  // to `id`) and is not guessed from output: `parseSessionId` legally returns a token
  // like `agent-12345`, which is not a full identifier at all. If we did not parse it —
  // there is no field, and the gate falls back to the prefix.
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

// What is said about the lift after success — the same for both. An unconfirmed check
// and an unparsed id are not a refusal: the participant is up, they can be found by
// name.
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
  // The third pattern is a spare and deliberately narrow: the value must carry a digit,
  // otherwise "session started successfully" would declare `started` as the identifier.
  // No match — `null`.
  const named = text.match(/\b(?:agent|session|id)\b\W{0,4}([A-Za-z0-9][\w-]{5,})/i);
  return named && /\d/.test(named[1]) ? named[1] : null;
}

// Where the session id comes from after spawn. Order matters: the record from
// `claude agents --json` is the harness's direct answer, and `parseSessionId` guesses
// the id in free text and will guess differently on another claude build. A separate
// function — so the order is tested.
//
// The name is not `sessionIdOf` (review note): that is the participant-record accessor
// in [protocol.ts](../src/protocol.ts), and there it means the FULL identifier — two
// different subjects under one name in one repository. And not "short": the first
// branch returns the short `id` of the harness record, and the first `parseSessionId`
// pattern legally returns a full uuid from the text. The subject here is "the session
// id as the lift learned it", and the name says exactly that.
export function spawnedSessionId(seen, output) {
  return seen?.session?.id ?? parseSessionId(output);
}

// The full session identifier — the one it calls itself (`CLAUDE_CODE_SESSION_ID`) — and
// it arrives only from the harness record. In the participant record it is stored as
// `sessionId`, and core `sessionIdOf` reads it from there — the same subject from the
// other side. There is no guessing here on purpose: the "short id is a prefix of the
// full one" link was removed by one measurement and is not a contract, and the
// address-ownership gate is fail-closed on it. No record — `null`, and the gate falls
// back to the prefix.
export function sessionIdFull(seen) {
  const full = seen?.session?.sessionId;
  return typeof full === 'string' && full.trim() ? full.trim() : null;
}

// Wait for the session to appear in the list. Outcomes: `alive` — found, `dead` — not
// found in all attempts, `unknown` — `claude agents --json` output was not parsed (this
// is not death).
export async function awaitSession(name, { tries = 6, delayMs = 500, sessions = bgSessions } = {}) {
  let ghost = null;
  for (let i = 0; i < tries; i += 1) {
    // The list changes after `--bg`: without a reset the cache of the first empty probe
    // would declare a just-lifted session missing on every remaining attempt.
    if (sessions === bgSessions) resetBgSessionsCache();
    const list = sessions();
    if (list === null) return { state: 'unknown', session: null, ghost: null };
    const hit = findSession(list, name);
    // A matching name is not enough: restarting a dead worker uses the same address, and
    // the past session's record does not vanish from the list — counting it as success
    // is not allowed.
    if (hit && sessionLiveness(hit, list) === 'alive') return { state: 'alive', session: hit, ghost: null };
    if (hit) ghost = hit;
    if (i < tries - 1) await new Promise((r) => { setTimeout(r, delayMs); });
  }
  return { state: 'dead', session: null, ghost };
}

// Live background sessions by the names we set at spawn. The `claude agents --json`
// format is not a contract: if we did not parse it — we say so, we do not invent state.
//
// A successful parse is remembered until reset: `promptobus status` and the warden
// heartbeat read the list per participant, and without memory each would cost a
// separate launch. A parse refusal is not cached — one failure does not declare every
// later call `unknown`. That costs today's readers nothing, and both halves were
// measured (2026-09-02): the snapshot dies on the FIRST `null`, so an unparsed reply
// costs one launch at any participant count, and the warden resets the cache itself
// before the heartbeat snapshot — it has no inter-beat memory at all. The cost would
// appear for a reader that takes state more often than the heartbeat and without a
// reset: 60 snapshots in a row — 1 launch on a parsed reply versus 60 on an unparsed
// one. There is no such reader, and one must not be added (see [warden.js](warden.js)).
// The suite after spawn/stop calls `resetBgSessionsCache` (sandbox.mjs); `awaitSession`
// and the warden reset themselves, otherwise they would see the list from before the
// change.
let bgSessionsCache = undefined;

export function resetBgSessionsCache() {
  bgSessionsCache = undefined;
}

export function bgSessions({ fresh = false } = {}) {
  if (!fresh && bgSessionsCache !== undefined) return bgSessionsCache;
  const r = run('claude', ['agents', '--json'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout);
    const list = Array.isArray(parsed) ? parsed : parsed.agents ?? parsed.sessions ?? [];
    if (!Array.isArray(list)) return null;
    bgSessionsCache = list;
    return list;
  } catch {
    return null;
  }
}

// The check is by the record's `name` field, and in full: a substring over the whole
// record would find a session whose `cwd` contains another name. We do not filter by
// `kind`: a self-calibration signal has none — a filter on a vanished field would
// declare everyone dead at once.
export function findSession(sessions, name) {
  const hits = (sessions ?? []).filter((s) => s?.name === name);
  if (!hits.length) return null;
  // More than one record is normal: a ghost and a new session. We pick the live one.
  return hits.find((s) => sessionLiveness(s, sessions) === 'alive') ?? hits[0];
}

// Liveness of a background session from its record. Presence of a record is not
// liveness: the record outlives its daemon. `pid` distinguishes them: a live one has
// it, a surviving one has none at all (after `claude stop` the record vanishes
// entirely). The signal is self-calibrating: missing `pid` means "listed" only where
// this claude prints a pid at all.
export function sessionLiveness(session, sessions = null) {
  if (!session) return 'dead';
  const hasPid = (s) => typeof s?.pid === 'number' && s.pid > 0;
  if (hasPid(session)) return 'alive';
  return (sessions ?? []).some(hasPid) ? 'stale' : 'alive';
}
