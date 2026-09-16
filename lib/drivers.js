import path from 'node:path';
import { createRegistry, driverFor, hasFeature, harnessOf, snapshotSessions } from '../dist/index.js';
import { bindSessionIdentity, canonicalPath } from './store.js';
import { readRecordAt } from './driver-common.js';
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
 * A driver that declares no adapter is answered for by the stand-in below, and
 * the answer is `unknown` / `probe_failed`: the mechanism has no right to call a
 * harness unavailable just because nobody has written its probe yet, and
 * `unknown` is penalised by the resolver rather than blocking. A real adapter
 * lands as the `availability` field of `driver-<harness>.js`, and nothing here
 * changes when it does.
 */
export function adapterOf(harness) {
  const driver = driverByHarness(harness);
  return driver.availability ?? standInAdapter(driver);
}

/**
 * The adapter a driver gets when it declares none: `unknown` / `probe_failed`,
 * never a throw. Exported so the suite can pin the stand-in itself rather than
 * whichever shipped drivers happen to lack an adapter today.
 */
export function standInAdapter(driver) {
  return {
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

/** Harnesses eligible to route a lift for the role — approver omits harnesses without `approverLift`. */
export function eligibleHarnessesForRole(host, role) {
  const declared = host.declaredTools();
  if (role !== 'approver') return declared;
  return declared.filter((h) => hasFeature(driverByHarness(h), 'approverLift'));
}

/** @deprecated use eligibleHarnessesForRole — name kept for callers that mean the eligible set */
export const declaredHarnessesForRole = eligibleHarnessesForRole;

/** Refusal when a declared harness cannot lift the role — explicit `--harness` and routing diagnostics. */
export function roleHarnessRefusal(driver, role) {
  if (role !== 'approver') return null;
  if (hasFeature(driver, 'approverLift')) return null;
  if (driver.id === 'cursor') {
    return 'harness "cursor" cannot lift an approver: Cursor reads project configuration — MCP, permissions.deny and hooks — only from the selected workspace\'s `.cursor/`, and `CURSOR_CONFIG_DIR` does not carry hooks. The approver session must run at the repository clone root for merge, gates and archive. Launch files that carry the bus and mechanical MCP-write denies land in task-owned storage beside the participant record; `--workspace` and the process select the clone, so that layer never reaches the session. Lift the approver with Claude Code instead.';
  }
  if (driver.id === 'codex') {
    return 'harness "codex" cannot lift an approver: Codex reads project hooks and `.codex/skills` from the thread cwd, and the approver session cwd is the shared clone root — `writeLaunchFiles` would overwrite or delete untracked `.codex/` content there without restoration on failure, stop or done. Lift the approver with Claude Code instead.';
  }
  return `harness "${driver.id}" cannot lift an approver — this harness does not declare approver lift.`;
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

/**
 * Every declared harness identity the environment carries, with the driver that declared
 * the variable. More than one answer is not a tie to break — 02-host.md § Session identity.
 */
export function identityCandidates(env = process.env) {
  return Object.entries(REGISTRY.drivers ?? {}).flatMap(([harness, driver]) => {
    const variable = driver?.options?.identityVar ?? null;
    const id = variable ? String(env?.[variable] ?? '').trim() : '';
    return id ? [{ harness, variable, id }] : [];
  });
}

/**
 * Session records named by an MCP child, after the record proves the same bus identity.
 * A readable record is not enough: another task or address is another participant.
 */
export function mcpIdentityCandidates(env = process.env, scope = null) {
  if (!scope?.home || !scope?.task || !scope?.address) return [];
  const scopeHome = canonicalPath(scope.home);
  return Object.entries(REGISTRY.drivers ?? {}).flatMap(([harness, driver]) => {
    const proof = driver?.options?.mcpIdentity ?? null;
    const variable = proof?.recordVar ?? null;
    const file = variable ? String(env?.[variable] ?? '').trim() : '';
    if (!file || !path.isAbsolute(file)) return [];
    const record = readRecordAt(file);
    const id = proof?.idField ? String(record?.[proof.idField] ?? '').trim() : '';
    const recordHome = typeof record?.home === 'string' ? record.home : '';
    if (!id
      || !recordHome
      || canonicalPath(recordHome) !== scopeHome
      || String(record?.task ?? '') !== scope.task
      || String(record?.address ?? '') !== scope.address) return [];
    return [{ harness, variable, id, record: file }];
  });
}

/**
 * What to repair when there is too much rather than too little. The contested reasons say
 * it themselves: the variables are named, and the move is to remove, never to add.
 */
function namesToDrop(candidates) {
  return `clear this environment down to one of ${candidates.map((c) => c.variable).join(', ')} `
    + '— what is missing here is nothing, what is extra is a variable, and only removing it answers';
}

/**
 * Who the session running this process is. `null` is an answer and not a silence, and
 * `reason` names which one — 02-host § Session identity.
 */
export function resolveSessionIdentity(env = process.env, scope = null) {
  const candidates = identityCandidates(env);
  if (candidates.length === 1) {
    return { id: candidates[0].id, ...candidates[0], candidates, reason: 'resolved', why: null };
  }
  if (!candidates.length) {
    const records = mcpIdentityCandidates(env, scope);
    if (records.length === 1) {
      return { id: records[0].id, ...records[0], candidates: records, reason: 'resolved', why: null };
    }
    if (records.length > 1) {
      return {
        id: null, harness: null, variable: null, candidates: records, reason: 'contested-records',
        why: `${records.length} MCP session records prove this address at once (${
          records.map((c) => `${c.harness} via ${c.variable}`).join(', ')
        }) — picking one would hand out an unproven session id; ${namesToDrop(records)}`,
      };
    }
    return {
      id: null,
      harness: null,
      variable: null,
      candidates,
      reason: 'none',
      why: `no declared harness names itself in this environment (looked at ${
        Object.values(REGISTRY.drivers ?? {}).map((d) => d?.options?.identityVar).filter(Boolean).join(', ') || 'nothing'
      })`,
    };
  }
  return {
    id: null,
    harness: null,
    variable: null,
    candidates,
    reason: 'contested',
    why: `${candidates.length} harnesses name themselves at once (${
      candidates.map((c) => `${c.harness} via ${c.variable}`).join(', ')
    }) — an ancestor's identity leaked into this session, and picking one would hand out someone `
      + `else's id; ${namesToDrop(candidates)}`,
  };
}

// Bound at import, like the participant-home removal a driver binds into the session
// registry: the core cannot import this file (the cycle is real), and whoever loads the
// registry is exactly who can answer — 02-host.md § Session identity.
bindSessionIdentity(resolveSessionIdentity);
