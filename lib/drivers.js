import path from 'node:path';
import { createRegistry, driverFor, hasFeature, harnessOf, snapshotSessions } from '../dist/index.js';
import { bindSessionIdentity, canonicalPath } from './store.js';
import { readRecordAt } from './driver-common.js';
import { CLAUDE, claudeDriver } from './driver-claude.js';
import { CURSOR, cursorDriver } from './driver-cursor.js';
import { CODEX, codexDriver } from './driver-codex.js';
import { verdict } from './model-routing/adapter-common.js';

// Driver registry of this CLI — the `harness → driver` map it passes into the state machine
// explicitly, and the only door from the mechanism to drivers. Three of them today.

/** `fallback` is the harness for a record that names none at all — a pre-task participant
 * or the task owner. A non-empty unknown name is not saved by it: it refuses. */
export const REGISTRY = createRegistry({
  drivers: { [CLAUDE]: claudeDriver, [CURSOR]: cursorDriver, [CODEX]: codexDriver },
  fallback: CLAUDE,
});

/** Availability adapter of a harness — the one door from the routing preflight to drivers.
 * No adapter means `unknown` / `probe_failed`, which the resolver penalises, never blocks. */
export function adapterOf(harness) {
  const driver = driverByHarness(harness);
  return driver.availability ?? standInAdapter(driver);
}

/** The adapter a driver gets when it declares none: `unknown` / `probe_failed`, never a
 * throw. Exported so the suite pins this stand-in rather than whichever driver lacks one. */
export function standInAdapter(driver) {
  return {
    probe: () => verdict('unknown', 'probe_failed', `no availability adapter for ${driver.id}`),
  };
}

/** Snapshot of participant sessions — input to the state machine. Taken once per heartbeat:
 * a driver reply is an external harness poll, and the loop runs once a second. */
export function snapshotOf(participants) {
  return snapshotSessions(participants, REGISTRY);
}

/** Driver of a participant record, by the harness that record declared. A former-CLI record
 * carries no field and gets `fallback`; a non-empty unknown name refuses. */
export function driverOf(participant) {
  return driverFor(REGISTRY, harnessOf(participant, REGISTRY));
}

/** Lift driver: the harness a command uses to spawn. No name — the map `fallback`; a name —
 * the one a person gave with `--harness`. An unknown one refuses before any write to disk. */
export function liftDriver(harness = null) {
  const named = String(harness ?? '').trim();
  return driverFor(REGISTRY, named || REGISTRY.fallback);
}

/** Driver of a record; on a FOREIGN harness — the lift driver. A door for where refusing
 * costs more than imprecision: it gives WORDS, and everything that acts uses `driverOf`. */
export function driverOrLift(participant) {
  try {
    return driverOf(participant);
  } catch {
    return liftDriver();
  }
}

/** Driver by the harness name from a stall report. No field means `fallback`: the report is
 * built from a participant record, and a former-CLI record has no harness. */
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

/** Forget cached session lists on every driver, after a lift or a stop: the next reader
 * would otherwise see a closed session as live. A driver holding no registry has nothing. */
export function forgetSessions() {
  for (const driver of Object.values(REGISTRY.drivers)) driver.forgetSessions?.();
}

/** Registry with substituted delivery — a suite seam. Another registry rather than a
 * module variable: the suite runs loops in parallel, and a shared one would mix them. */
export function knockRegistry(knock) {
  if (!knock) return REGISTRY;
  const drivers = Object.fromEntries(Object.entries(REGISTRY.drivers).map(([harness, driver]) => [
    harness,
    // Substituted ONLY where delivery is truly a socket: elsewhere `endpoint` points at a
    // turn-registry record. The flag asked is the declared one, not one inferred.
    driver.options.knockChannel === 'socket'
      ? { ...driver, activate: (target, notification) => knock(target.endpoint, driver.renderNotification(notification)) }
      : driver,
  ]));
  return { ...REGISTRY, drivers };
}

/** Stall route — from the driver of the participant whose state was just read; the shared
 * line text stays with [stalls.js](stalls.js), so all three surfaces advise the same thing. */
export function stallRouteOf(stalled, task) {
  const driver = driverByHarness(stalled.harness);
  return driver.stallRoute({ ...stalled, task }, stalled.id ?? stalled.ref, stalled.ref);
}

/** Every declared harness identity the environment carries, with the driver that declared
 * the variable. More than one answer is not a tie to break — 02-host.md § Session identity. */
export function identityCandidates(env = process.env) {
  return Object.entries(REGISTRY.drivers ?? {}).flatMap(([harness, driver]) => {
    const variable = driver?.options?.identityVar ?? null;
    const id = variable ? String(env?.[variable] ?? '').trim() : '';
    return id ? [{ harness, variable, id }] : [];
  });
}

/** Session records named by an MCP child, after the record proves the same bus identity: a
 * readable record is not enough — another task or address is another participant. */
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

/** What to repair when there is too much rather than too little: the contested reasons name
 * the variables themselves, and the move is to remove, never to add. */
function namesToDrop(candidates) {
  return `clear this environment down to one of ${candidates.map((c) => c.variable).join(', ')} `
    + '— what is missing here is nothing, what is extra is a variable, and only removing it answers';
}

/** Who the session running this process is. `null` is an answer and not a silence, and
 * `reason` names which one — 02-host.md § Session identity. */
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

// Bound at import: the core cannot import this file (the cycle is real), and whoever loads
// the registry is exactly who can answer — 02-host.md § Session identity.
bindSessionIdentity(resolveSessionIdentity);
