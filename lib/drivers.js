import { createRegistry, driverFor, harnessOf, snapshotSessions } from '../dist/index.js';
import { CLAUDE, claudeDriver } from './driver-claude.js';
import { CURSOR, cursorDriver } from './driver-cursor.js';
import { CODEX, codexDriver } from './driver-codex.js';

// Driver registry of this CLI: the `harness → driver` map it passes into the
// warden state machine EXPLICITLY. The map lives in its own module, not inside
// a driver: a driver knows its harness and need not know its neighbors.
//
// **This file is the only door from the mechanism to drivers**. The other
// bus modules (`spawn`, `review`, `done`, `server`, `warden`, `status`, `doctor`, `guard`)
// import neither `driver-claude.js` nor `liftoff.js`: they take the object from here and
// call the operations the contract declares. A second production driver goes into the map
// below, without touching any file outside this one and its own `driver-<harness>.js`.
//
// The map holds three drivers — Claude Code, Cursor, and Codex. Stand-in
// drivers live only in the package suite and do not enter the map.

/**
 * `fallback` is the harness for a record that does not name one AT ALL. Two kinds of
 * record look like that: participants the CLI created before this task, and the task
 * owner — `createTask` writes that record and does not know about drivers. A non-empty
 * unknown name is not saved by fallback: a declared foreign harness refuses.
 */
export const REGISTRY = createRegistry({
  drivers: { [CLAUDE]: claudeDriver, [CURSOR]: cursorDriver, [CODEX]: codexDriver },
  fallback: CLAUDE,
});

/**
 * Availability adapter of a harness — the one door from the routing preflight to
 * the drivers, the same way the map above is the one door to the drivers themselves.
 *
 * A driver that declares no adapter is answered for here, and the answer is
 * `unknown` / `probe_failed`: the mechanism has no right to call a harness
 * unavailable just because nobody has written its probe yet, and `unknown` is
 * penalised by the resolver rather than blocking. All three drivers are in that
 * state today — this function is what changes when the real adapters land, and
 * `driver-<harness>.js` is where they land.
 */
export function adapterOf(harness) {
  const driver = driverByHarness(harness);
  return driver.availability ?? {
    probe: () => ({
      state: 'unknown',
      reason: 'probe_failed',
      message: `no availability adapter for ${driver.id}`,
      checkedAt: new Date().toISOString(),
      source: 'probe',
      resetAt: null,
    }),
  };
}

/**
 * Snapshot of participant sessions — input to the state machine. Taken once per heartbeat:
 * a driver reply is an external harness poll, and the loop runs once a second.
 */
export function snapshotOf(participants) {
  return snapshotSessions(participants, REGISTRY);
}

/**
 * Driver of a participant record — by the harness that record declared. Records from the
 * former CLI carry no field at all and get `fallback`; a non-empty unknown name refuses.
 */
export function driverOf(participant) {
  return driverFor(REGISTRY, harnessOf(participant, REGISTRY));
}

/**
 * Lift driver: the harness a command uses to spawn a session. With no name — the map
 * `fallback`, that is the former harness and the former argv; with a name — the one the
 * human named with `--harness`.
 *
 * One door exists exactly for this: the flag steers this function, not each lift command,
 * and callers still do not know the driver name constants. An unknown name refuses here,
 * before any write to disk — `driverFor` throws `GateError` with the known list.
 */
export function liftDriver(harness = null) {
  const named = String(harness ?? '').trim();
  return driverFor(REGISTRY, named || REGISTRY.fallback);
}

/**
 * Driver of a participant record; on a FOREIGN harness — the lift driver (review note).
 * A separate door is needed where refuse costs more than imprecision: `promptobus done`
 * cleanup runs AFTER the task closes, and a `GateError` thrown from there would take
 * participant secret cleanup and journal sweeping with it — exactly why that same file
 * has the rule "a post-close walk does not throw". A record with a foreign harness
 * arrives there on the normal path: the snapshot gives it `unknown`, and unknown is not
 * death, so the walk lawfully leaves that record's directory with words.
 *
 * Imprecision here is harmless: the lift driver gives WORDS to a human, not an action
 * on a foreign session. Everything that acts — stop, lift, knock — goes through
 * `driverOf` and refuses as it always refused.
 */
export function driverOrLift(participant) {
  try {
    return driverOf(participant);
  } catch {
    return liftDriver();
  }
}

/**
 * Driver by the harness name from a stall report. No field — take `fallback`: the report
 * is built from a participant record, and a former-CLI record has no harness.
 */
export function driverByHarness(harness) {
  return driverFor(REGISTRY, harness || REGISTRY.fallback);
}

/**
 * Forget cached session lists on every driver. Called after lift and stop: the list
 * changes after those, and the next reader would see a closed session as live. A driver
 * that holds no registry (`sessionList: false`) does not declare the operation — it has
 * nothing to forget.
 */
export function forgetSessions() {
  for (const driver of Object.values(REGISTRY.drivers)) driver.forgetSessions?.();
}

/**
 * Registry with substituted delivery — suite seam: a stand-in channel for one loop.
 * Exactly `activate` is substituted on EVERY driver; the text stays with that driver:
 * the loop under test is the live one, and only the wire changes. The registry is passed
 * into the state machine explicitly, so the seam is another registry, not a module-local
 * variable: the suite runs loops in parallel, and a shared variable would mix them.
 */
export function knockRegistry(knock) {
  if (!knock) return REGISTRY;
  const drivers = Object.fromEntries(Object.entries(REGISTRY.drivers).map(([harness, driver]) => [
    harness,
    // Delivery is substituted ONLY where it is truly a socket (review note). On a driver
    // that wakes with a new turn, `endpoint` is not a socket at all — it is a pointer to
    // that driver's turn-registry record — and a stand-in channel would knock it as a
    // socket, testing a loop this harness does not have. The flag asked is the declared
    // one, not one inferred from an operation existing: the second driver renders text
    // and wakes itself.
    driver.options.knockChannel === 'socket'
      ? { ...driver, activate: (target, notification) => knock(target.endpoint, driver.renderNotification(notification)) }
      : driver,
  ]));
  return { ...REGISTRY, drivers };
}

/**
 * Stall route — from the driver of the participant whose state was just read. The shared
 * line text stays with the adapter ([stalls.js](stalls.js)); the harness-specific command
 * comes from here: `status`, the `mailbox` reply, and the warden report must advise the
 * same thing.
 */
export function stallRouteOf(stalled, task) {
  const driver = driverByHarness(stalled.harness);
  return driver.stallRoute({ ...stalled, task }, stalled.id ?? stalled.ref, stalled.ref);
}
