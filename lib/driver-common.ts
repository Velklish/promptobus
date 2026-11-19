import { readFileSync } from 'node:fs';
import process from 'node:process';
import { dropStaleWake, GateError, holdsSession, logWarden, participantOf, readTask, upsertParticipant, withTaskLock } from './store.js';
import { requireCurrentNativeLaunch } from './native-lifecycle.js';
import { fail } from './util.js';
import type { LibLaunchPlan } from './driver-runtime.js';

const managedCleanupFailures = new WeakMap<LibLaunchPlan, AggregateError>();
type ObservedSession = { sessionId: string | null | undefined; session: string | null | undefined };
type BindingAction = 'check' | 'revoke' | 'revoke-reviewer';

export function revokeFailedPointerLaunch(plan: LibLaunchPlan, error: unknown, owned: ObservedSession,
  undo: ReturnType<typeof bindBeforeLaunch>, retireNative: () => Promise<void>) {
  return revokeFailedManagedLaunch(plan, error, retireNative, undefined, () => { undo(owned, 'revoke-reviewer'); });
}

export async function revokeFailedManagedLaunch(launch: LibLaunchPlan, error: unknown, afterRevoke?: () => void | Promise<void>,
  revokeRegistered?: () => Promise<void>, revokeReviewer?: () => void): Promise<never> {
  const handled = managedCleanupFailures.get(launch);
  if (handled && error === handled) throw error;
  const failures: { stage: string; cause: unknown }[] = [];
  try { revokeReviewer?.(); } catch (cause) { failures.push({ stage: 'reviewer binding revocation', cause }); }
  try { await (revokeRegistered ? revokeRegistered() : launch.service?.revoke()); }
  catch (cause) { failures.push({ stage: 'credential revocation', cause }); }
  if (!failures.length) {
    try { await afterRevoke?.(); } catch (cause) { failures.push({ stage: 'native launch cleanup', cause }); }
  }
  if (failures.length) {
    const first = error instanceof Error ? error.message : String(error);
    const details = failures.map(({ stage, cause }) => `${stage} failed: ${cause instanceof Error ? cause.message : String(cause)}`).join('; ');
    const causes = failures.flatMap(({ cause }) => cause instanceof AggregateError ? cause.errors : [cause]);
    const record = launch.sessionRecord ?? launch.prelaunchBinding?.sessionRecord;
    const failure = new AggregateError([error, ...causes], `${first}; ${details}. Native launch state is unknown; `
      + `inspect ${record ?? 'the retained native launch record'} before retrying`, { cause: error });
    managedCleanupFailures.set(launch, failure);
    throw failure;
  }
  throw error;
}

export function parseVersion(value: unknown) {
  const raw = String(value ?? '');
  const match = /(?:^|[^A-Za-z0-9])v?(\d+(?:\.\d+)*)(?![\d.])/.exec(raw);
  return match ? match[1].split('.').map(Number) : null;
}

export function versionLess(a: unknown, b: unknown) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

export function sessionEnv(dropList: readonly string[] | null | undefined, base = process.env, extra: NodeJS.ProcessEnv = {}) {
  const env = { ...base };
  for (const name of dropList ?? []) delete env[name];
  const own = { ...env, ...extra };
  for (const name of Object.keys(own)) if (name.startsWith('PROMPTOBUS_ROOT_')) delete own[name];
  return own;
}

export function sessionEnvFor(dropList: readonly string[] | null | undefined) {
  return (base = process.env, extra: NodeJS.ProcessEnv = {}) => sessionEnv(dropList, base, extra);
}

export function readRecordAt<T = Record<string, unknown>>(file: string): T | null {
  try {
    const record: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return record as T;
  } catch {
    return null;
  }
}

const foreignWrites = new Set<string>();

export function sayForeignWrite(home: string, task: string, addr: string, held: string, session: string | null, what: string) {
  const key = [home, task, addr, held, session, what].join('\u0000');
  if (foreignWrites.has(key)) return;
  foreignWrites.add(key);
  logWarden(home, task, `${what} for address ${addr} is refused: the address is bound to session ${held}, `
    + `and ${session} is writing — the owner's records were left untouched`);
}

export function bindBeforeLaunch(home: string | null, task: string | null, address: string | null, binding: Record<string, unknown> = {}, expected: Parameters<typeof requireCurrentNativeLaunch>[1] = null) {
  if (!home || !task || !address || !Object.keys(binding).length) return () => {};
  const record = withTaskLock(home, task, () => {
    const found = participantOf(readTask(home, task), address);
    if (!found) return null;
    if (found.metadata.reviewLaunchId && found.metadata.revokedReviewLaunchId === found.metadata.reviewLaunchId)
      throw new GateError(`reviewer ${address}: launch binding was revoked`);
    requireCurrentNativeLaunch(found, expected);
    upsertParticipant(home, task, { ...found, metadata: { ...found.metadata, ...binding } });
    dropStaleWake(home, task, address, binding.sessionId as string | null);
    return found;
  });
  if (!record) fail(`participant ${address} of task ${task} disappeared before its session launch`);
  const pointerReviewer = !!record.metadata.reviewLaunchId && (record.harness === 'cursor' || record.harness === 'opencode')
    && typeof binding.sessionRecord === 'string' && !binding.sessionId;
  let revokedHere = false;
  const rollback = (owned: ObservedSession | undefined, action: BindingAction) => {
    const current = participantOf(readTask(home, task), address);
    if (pointerReviewer) {
      const m = current?.metadata;
      const retired = revokedHere && m?.revokedReviewLaunchId === record.metadata.reviewLaunchId
        && m?.sessionRecord == null && m?.sessionId == null && m?.session == null;
      if (!owned || !current || !m || current.harness !== record.harness || current.sessionRef !== record.sessionRef
        || m.reviewLaunchId !== record.metadata.reviewLaunchId || m.assignmentAfterId !== record.metadata.assignmentAfterId
        || (!retired && m.sessionRecord !== binding.sessionRecord) || (m.sessionId != null && m.sessionId !== owned.sessionId)
        || (m.session != null && (!owned.sessionId || m.session !== owned.session)))
        throw new GateError(`reviewer ${address}: assignment or native session changed before binding rollback`);
      requireCurrentNativeLaunch(current, record);
      if (retired) return true;
    }
    if (action === 'check' || !current) return;
    if (!pointerReviewer) {
      if (record.metadata.reviewLaunchId && current.metadata.reviewLaunchId !== record.metadata.reviewLaunchId) return;
      try { requireCurrentNativeLaunch(current, record); }
      catch { return; }
    }
    const metadata = { ...current.metadata };
    if (record.metadata.reviewLaunchId) {
      const { assignmentAfterId, session, sessionId, sessionRecord, findingCheckpoints } = current.metadata;
      const last = Array.isArray(findingCheckpoints) ? findingCheckpoints.at(-1) : null;
      if (last?.subject?.assignmentAfterId === assignmentAfterId && typeof last?.messageId === 'string' && holdsSession(current, last.session))
        metadata.retiredCheckpointBinding = { assignmentAfterId, through: last.messageId, session, sessionId, sessionRecord };
      if (pointerReviewer) {
        metadata.revokedReviewLaunchId = record.metadata.reviewLaunchId;
        delete metadata.sessionId;
      }
      if (pointerReviewer || (binding.sessionId && binding.sessionId === sessionId)) delete metadata.session;
    }
    for (const [key, value] of Object.entries(binding)) {
      if (metadata[key] === value || metadata[key] === record!.metadata?.[key]) delete metadata[key];
    }
    upsertParticipant(home!, task!, { ...current, metadata });
    revokedHere = pointerReviewer;
  };
  return (owned?: ObservedSession, action: BindingAction = 'revoke') => action === 'revoke-reviewer' && !pointerReviewer
    ? undefined : withTaskLock(home, task, () => rollback(owned, action));
}
