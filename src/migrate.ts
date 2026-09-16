// Migration: reading an older store.
// [reference/01-overview.md#migration-reading-an-older-store](../docs/reference/01-overview.md#migration-reading-an-older-store)
import {
  copyFileSync, cpSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { writeJsonAtomic } from './fs/atomic.js';
import { withDirLock } from './fs/lock.js';
import type { LockHolder } from './fs/lock.js';
import {
  addrDir, GateError, isAddress, ORCHESTRATOR, roleOf, TASK_ID_RE, UNDECLARED_HARNESS,
  UNDECLARED_ROLE,
} from './protocol.js';
import * as legacy from './legacy-store.js';
import {
  artifactsDir, blobFile, blobRef, blobsDir, brokenInboxDir, filesDir, historyDir, inboxDir, messagesDir,
  ROOT_DIR, taskDir,
} from './v1/layout.js';
import { compactStamp, MESSAGE_PROTOCOL_VERSION, SCHEMA_VERSION } from './v1/model.js';
import type {
  ArtifactV1, CapabilitiesSnapshot, MessageV1, ParticipantV1, TaskV1,
} from './v1/model.js';
import { validate } from './v1/validate.js';
import type { HostLegacyLayout, PromptobusHost } from './host.js';

/** Transient successful-assembly mark. It survives `rename` and is removed after cleanup. */
const MARK = 'migrating.json';

/** How long to wait for a neighbour that is already moving. Two launches in one workspace are the
 * ordinary case; a measured move (71 tasks, 36 MB) took 1.45 s, and only a LIVE neighbour sits it out. */
const MIGRATION_WAIT_MS = 30_000;

/** Steps at which the suite can abort the migration. Not supplied in production at all. */
export type MigrationStep =
  | 'scan' | 'temp' | 'task' | 'messages' | 'artifacts' | 'sidecar' | 'sessions'
  | 'mark' | 'switch' | 'cleanup';

export type MigrationFault = (step: MigrationStep, info: Record<string, unknown>) => void;

const NO_FAULT: MigrationFault = () => {};

/** What the migration did with one task. */
export interface TaskReport {
  id: string;
  participants: number;
  messages: number;
  unread: number;
  read: number;
  artifacts: number;
  broken: string[];
}

/** Migration outcome: counts and the list of what was set aside. */
export interface MigrationReport {
  root: string;
  from: string;
  to: string;
  tasks: TaskReport[];
  brokenTasks: string[];
  bindings: number;
  /** Whether THIS call did anything. Without it an empty report is indistinguishable from a
   * successful move, and the numeric report would say "0 tasks" where a neighbour moved seventy-one. */
  moved: boolean;
  /** The work was already done by a previous run — the switch is finished without a rebuild. */
  resumed: boolean;
}

/** Preflight decision: whether migration is needed and what it refuses with. */
export interface MigrationPlan {
  needed: boolean;
  /** Only the transient mark remains; no former data will move. */
  sweep: boolean;
  /** Human refusal text or `null`. A refusal is a lawful outcome, not a breakage. */
  refusal: string | null;
  legacyHome: string;
  target: string;
  /** Active tasks, if the refusal came from them. */
  active: string[];
}

function homeOf(root: string): string {
  return path.join(root, ROOT_DIR);
}

function tempOf(root: string): string {
  return path.join(root, `${ROOT_DIR}.migrating`);
}

function lockOf(root: string): string {
  return path.join(root, `${ROOT_DIR}.migrating.lock`);
}

/** A held move lock: the neighbour is alive and still transferring. */
class MigrationBusy extends Error {
  readonly refusal: GateError;

  constructor(refusal: GateError) {
    super(refusal.message);
    this.refusal = refusal;
  }
}

function busyRefusal(root: string, held: LockHolder | null, waitedMs: number): MigrationBusy {
  const who = held?.pid
    ? `Held by live process ${held.pid}${held.session ? ` (session ${held.session})` : ''}`
      + `${held.since ? `, taken ${held.since}` : ''}`
    : 'Who holds it, the lock did not name: the owner file was not written';
  return new MigrationBusy(new GateError(
    `the bus move into ${root} is running in another process: waited ${waitedMs} ms, lock ${lockOf(root)}. `
    + `${who} — wait for it and repeat the command.`));
}

function isDir(at: string): boolean {
  try {
    return statSync(at).isDirectory();
  } catch {
    return false;
  }
}

function markOf(home: string): { from?: string } | null {
  try {
    return JSON.parse(readFileSync(path.join(home, MARK), 'utf8')) as { from?: string };
  } catch {
    return null;
  }
}

/** Parse `legacyLayout().rel`: exactly two segments joined by `/`. An absolute path, empty segments,
 * `.`, `..` and `\\` are a shape error, not "no legacy" — `path.join` would walk above the root. */
export function splitLegacyRel(rel: string): [string, string] {
  const s = String(rel ?? '');
  if (path.isAbsolute(s) || s.startsWith('/') || s.startsWith('\\') || s.includes('\\')) {
    throw new GateError(
      `legacy layout.rel must be a relative path of two segments joined by '/', `
      + `not ${JSON.stringify(rel)}`,
    );
  }
  const parts = s.split('/');
  if (parts.length !== 2 || parts.some((p) => !p || p === '.' || p === '..')) {
    throw new GateError(
      `legacy layout.rel must be exactly two path segments `
      + `(the directory and the store inside it, joined by '/', no '..'), not ${JSON.stringify(rel)}`,
    );
  }
  return [parts[0], parts[1]];
}

function layoutOf(options: MigrationOptions): HostLegacyLayout | null {
  if (Object.prototype.hasOwnProperty.call(options, 'layout')) return options.layout ?? null;
  if (options.host) return options.host.legacyLayout();
  return null;
}

function requireLayout(
  layout: HostLegacyLayout | null | undefined,
  fn: string,
): HostLegacyLayout | null {
  if (layout === undefined) {
    throw new GateError(
      `${fn}: layout is required — pass host.legacyLayout() or an explicit null `
      + 'if this workspace has no former store',
    );
  }
  return layout;
}

/** Whether migration is needed and may run — not a single change on disk. The second argument has no
 * default: a forgotten call site must not look like "nothing to migrate from". */
export function preflight(root: string, layout: HostLegacyLayout | null): MigrationPlan {
  const named = requireLayout(layout, 'preflight');
  const target = homeOf(root);
  const empty: MigrationPlan = {
    needed: false, sweep: false, refusal: null, legacyHome: '', target, active: [],
  };
  if (!named) return empty;
  const [outer, inner] = splitLegacyRel(named.rel);
  const legacyHome = path.join(root, outer, inner);
  const plan: MigrationPlan = {
    needed: false, sweep: false, refusal: null, legacyHome, target, active: [],
  };
  if (!existsSync(legacyHome)) {
    if (markOf(target)?.from === legacyHome) {
      plan.needed = true;
      plan.sweep = true;
    }
    return plan;
  }
  if (!isDir(legacyHome)) {
    plan.refusal = `${legacyHome} is not a directory: the former bus store is damaged, and there is nothing to move from it. `
      + `Remove it by hand if it is not needed, and repeat the command.`;
    return plan;
  }
  const legacyTasks = path.join(legacyHome, 'tasks');
  if (existsSync(legacyTasks) && !isDir(legacyTasks)) {
    plan.refusal = `${legacyTasks} is not a directory: the former bus store is damaged. `
      + 'Sort it out by hand: migration does not touch a damaged root and moves nothing from it.';
    return plan;
  }
  // Check before both-roots/mark handling: resumed cleanup deletes the former root whole, including skipped entries.
  const invalidTask = invalidLegacyTaskDir(legacyTasks);
  if (invalidTask) {
    plan.refusal = `${path.join(legacyTasks, invalidTask)} is an entry under the former tasks/ whose name is not a v1 task id (${invalidTask}). `
      + 'Task ids must be 1 to 128 characters: an ASCII letter or digit first, then ASCII letters, digits, ., _, or -. '
      + 'Rename or remove it by hand, then repeat the command; migration has changed nothing.';
    return plan;
  }
  if (existsSync(target)) {
    // Both roots at once. The current transient mark tells unfinished cleanup from a foreign home:
    // an old completed-move record is not proof — previous releases left it behind after cleanup.
    if (markOf(target)?.from === legacyHome) {
      plan.needed = true;
      return plan;
    }
    plan.refusal = `both bus stores sit side by side: the new ${target} and the former ${legacyHome}. `
      + 'The mechanism will not merge them — it does not know which correspondence is newer. '
      + `Sort it out by hand: keep the directory you need, remove the other, and repeat the command.`;
    return plan;
  }
  plan.needed = true;
  const active = activeLegacyTasks(legacyHome);
  if (active.length) {
    plan.active = active;
    plan.refusal = `moving to the new store requires that no active tasks remain, and there are ${active.length}: `
      + `${active.join(', ')}.\nClose each with the former CLI version and repeat the command:\n`
      + active.map((id) => `  ${named.done.replace('<id>', id)}`).join('\n');
  }
  return plan;
}

function invalidLegacyTaskDir(legacyTasks: string): string | null {
  try {
    return readdirSync(legacyTasks, { withFileTypes: true })
      .filter((entry) => {
        if (!entry.isDirectory() || TASK_ID_RE.test(entry.name)) return false;
        try {
          return readdirSync(path.join(legacyTasks, entry.name)).length > 0;
        } catch {
          return true;
        }
      })
      .map((entry) => entry.name)
      .sort()[0] ?? null;
  } catch {
    return null;
  }
}

function activeLegacyTasks(legacyHome: string): string[] {
  const dir = path.join(legacyHome, 'tasks');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const active: string[] = [];
  for (const name of names.sort()) {
    if (!TASK_ID_RE.test(name)) continue;
    try {
      const meta = JSON.parse(readFileSync(path.join(dir, name, 'task.json'), 'utf8')) as { status?: string };
      // A broken task is not counted as active: there is nothing to activate it with, and a refusal
      // on it would not let the former CLI close it — that CLI would stumble on it too.
      if (meta?.status !== 'done') active.push(name);
    } catch {
      // An unreadable journal is not an active task. It goes to migration-broken.
    }
  }
  return active;
}

/** Whether migration is needed at all, including a mark-only sweep. Use `preflight().sweep` to distinguish it from a data move. */
export function migrationNeeded(root: string, layout: HostLegacyLayout | null): boolean {
  return preflight(root, layout).needed;
}

/** Move the store. A preflight refusal is a `GateError` with human text — a lawful outcome, not a
 * mechanism breakage. Without a layout the report is empty and the disk is not touched. */
export function migrate(root: string, {
  fault = NO_FAULT, waitMs = MIGRATION_WAIT_MS, session = null, harness = null, ...rest
}: MigrationOptions = {}): MigrationReport {
  const layout = layoutOf(rest);
  const plan = preflight(root, layout);
  if (plan.refusal) throw new GateError(plan.refusal);
  const empty = (): MigrationReport => ({
    root, from: plan.legacyHome, to: plan.target, tasks: [], brokenTasks: [], bindings: 0,
    moved: false, resumed: false,
  });
  if (plan.sweep) {
    rmSync(path.join(plan.target, MARK), { force: true });
    return empty();
  }
  if (!plan.needed) return empty();

  // **The move runs under a lock, and the lock is not a safety net here**: without it two processes
  // lose data in silence, with no rollback. The loser does NOT refuse — it re-asks preflight.
  try {
    return withDirLock(lockOf(root), () => migrateLocked(root, layout, empty(), fault, harness), {
      waitMs,
      session,
      onMissing: () => new GateError(`workspace ${root} is missing — there is nothing to move from it`),
      onBusy: (held, waitedMs) => busyRefusal(root, held, waitedMs),
    });
  } catch (e) {
    if (!(e instanceof MigrationBusy)) throw e;
    // The lock sat out to the end — but the neighbour may have finished in exactly this window. Ask
    // again: a moved root is an outcome for us, not a reason to refuse.
    const after = preflight(root, layout);
    if (after.refusal) throw new GateError(after.refusal);
    if (after.sweep) {
      rmSync(path.join(after.target, MARK), { force: true });
      return empty();
    }
    if (!after.needed) return empty();
    throw e.refusal;
  }
}

/** The transfer itself — already under the lock: there is no neighbour here by construction. */
function migrateLocked(
  root: string,
  layout: HostLegacyLayout | null,
  report: MigrationReport,
  fault: MigrationFault,
  harness: string | null,
): MigrationReport {
  // While we waited for the lock the neighbour may have done everything. Preflight is re-asked HERE
  // because the outside read happened before the wait and has had time to go stale.
  const plan = preflight(root, layout);
  if (plan.refusal) throw new GateError(plan.refusal);
  if (plan.sweep) {
    rmSync(path.join(plan.target, MARK), { force: true });
    return report;
  }
  if (!plan.needed) return report;
  const { legacyHome, target } = plan;

  // A previous run switched and did not finish removing legacy — finish the cleanup.
  if (existsSync(target)) {
    report.moved = true;
    report.resumed = true;
    fault('cleanup', { target });
    rmSync(legacyHome, { recursive: true, force: true });
    rmSync(path.join(target, MARK), { force: true });
    return report;
  }

  const temp = tempOf(root);
  // A leftover of a foreign assembly under the lock is already garbage: we hold the lock, so its
  // former owner either released it or was dropped by pid. This `rm` cannot catch a live neighbour.
  rmSync(temp, { recursive: true, force: true });

  try {
    fault('scan', { legacyHome });
    mkdirSync(path.join(temp, 'tasks'), { recursive: true });
    fault('temp', { temp });
    for (const id of legacyTaskIds(legacyHome)) {
      const one = migrateTask(legacyHome, temp, id, fault, harness);
      if (one) report.tasks.push(one);
      else report.brokenTasks.push(id);
    }
    report.bindings = copyBindings(legacyHome, temp);
    fault('sessions', { bindings: report.bindings });
    writeJsonAtomic(path.join(temp, MARK), {
      from: legacyHome,
      at: new Date().toISOString(),
      tasks: report.tasks.length,
      brokenTasks: report.brokenTasks.length,
    });
    fault('mark', { temp });
    // The switch point. Until here the legacy directory has not been touched once.
    renameSync(temp, target);
    fault('switch', { target });
  } catch (e) {
    // A refusal before the switch leaves neither half of a new store nor a trace in the old one.
    rmSync(temp, { recursive: true, force: true });
    throw e;
  }
  fault('cleanup', { legacyHome });
  rmSync(legacyHome, { recursive: true, force: true });
  rmSync(path.join(target, MARK), { force: true });
  report.moved = true;
  return report;
}

function legacyTaskIds(legacyHome: string): string[] {
  try {
    return readdirSync(path.join(legacyHome, 'tasks'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && TASK_ID_RE.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// --- one task ---------------------------------------------------------------

/** Deterministic tail of a record id: the same legacy record yields the same name on any repeat. A
 * random tail would be a direct loss — a repeated migration would lay the same messages twice. */
function tail(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 6);
}

const LEGACY_MSG_RE = /^(\d{8}T\d{9})-(\d{4})-/;

/** v1 message name from a legacy one; stamp and counter are taken as they are, since history order
 * rests on them. **The tail is seeded by the DIRECTORY**: legacy names are unique per mailbox, not per task. */
function recordIdOf(legacyId: string, at: string, box: string): string {
  const seed = `${box}/${legacyId}`;
  const m = LEGACY_MSG_RE.exec(`${legacyId}-`);
  if (m) return `${m[1]}-${m[2]}-${tail(seed)}`;
  // A name not in the former-store shape (edited by hand, a foreign file) —
  // the stamp is taken from the write time, and the order stays chronological.
  const stamp = compactStamp(new Date(Number.isFinite(Date.parse(at)) ? at : Date.now()));
  return `${stamp}-0000-${tail(seed)}`;
}

function isoOf(value: unknown, fallback: string): string {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? new Date(at).toISOString() : fallback;
}

function migrateTask(legacyHome: string, temp: string, id: string, fault: MigrationFault, harness: string | null): TaskReport | null {
  const report: TaskReport = { id, participants: 0, messages: 0, unread: 0, read: 0, artifacts: 0, broken: [] };
  let meta: legacy.TaskMeta;
  try {
    meta = JSON.parse(readFileSync(path.join(legacyHome, 'tasks', id, 'task.json'), 'utf8')) as legacy.TaskMeta;
  } catch (e) {
    stashBrokenTask(legacyHome, temp, id, `journal did not parse: ${(e as Error).message}`);
    return null;
  }
  const task = toV1Task(id, meta, harness);
  if (!task) {
    stashBrokenTask(legacyHome, temp, id, 'journal does not translate into the v1 model');
    return null;
  }
  report.participants = task.participants.length;
  mkdirSync(taskDir(temp, id), { recursive: true });

  // Artifacts go FIRST: a message points at a metadata record by id, and
  // without a "file name → record id" map the link cannot be rewritten.
  const named = migrateArtifacts(legacyHome, temp, id, meta, report);
  fault('artifacts', { task: id, artifacts: report.artifacts });

  migrateMessages(legacyHome, temp, id, named, report);
  fault('messages', { task: id, messages: report.messages });

  writeJsonAtomic(path.join(taskDir(temp, id), 'task.json'), task);
  fault('task', { task: id });

  copySidecar(legacyHome, temp, id);
  fault('sidecar', { task: id });
  return report;
}

/** A damaged task: the directory is kept whole and does NOT enter `tasks/`. */
function stashBrokenTask(legacyHome: string, temp: string, id: string, why: string): void {
  const at = path.join(temp, 'migration-broken', id);
  mkdirSync(path.dirname(at), { recursive: true });
  cpSync(path.join(legacyHome, 'tasks', id), at, { recursive: true });
  writeFileSync(path.join(temp, 'migration-broken', `${id}.txt`), `${why}\n`);
}

/** What is fed to the transfer. Everything except the fault-injection seam is adapter data. */
export interface MigrationOptions {
  /** Fault-injection seam. Not supplied in production at all. */
  fault?: MigrationFault;
  /** How long to wait for the move lock. */
  waitMs?: number;
  /** Identity of the session that started the move — only for diagnosing a busy lock. The environment
   * is read by the adapter, so the value arrives as an argument. */
  session?: string | null;
  /** Harness of former-CLI records, which have none, though v1 requires one. Harness names cannot
   * live in the package — their home is with the drivers — so the adapter supplies it. */
  harness?: string | null;
  /** Where to migrate from. An explicit `null` means nothing to move from even if the host says
   * otherwise; not passed, `host.legacyLayout()` is taken, and without a host — also nothing. */
  layout?: HostLegacyLayout | null;
  host?: Pick<PromptobusHost, 'legacyLayout'>;
}

function capsOf(value: unknown): CapabilitiesSnapshot | null {
  return validate('participant', {
    id: 'x', role: 'x', harness: 'x', mode: 'attached', sessionRef: null, capabilities: value, metadata: {},
  }).ok ? (value as CapabilitiesSnapshot | null) : null;
}

/** Former-store participant record into the v1 model. The legacy record goes into `metadata` WHOLE —
 * everything the adapter ever wrote comes back byte for byte — and the v1 fields are a view of it. */
function participantToV1(p: legacy.Participant, harness: string | null): ParticipantV1 {
  const declared = typeof p.harness === 'string' ? p.harness.trim() : '';
  const ref = typeof p.sessionRef === 'string' && p.sessionRef ? p.sessionRef
    : (typeof p.name === 'string' && p.name ? p.name : null);
  const raw = typeof p.mode === 'string' ? p.mode.trim() : '';
  const usable = isAddress(p?.address);
  return {
    // A bad address does NOT drop the record: one damaged row may not cost the rest. The id must be
    // stable — the same address yields the same name on every pass.
    id: usable ? addrDir(p.address) : `broken-${tail(String(p?.address))}`,
    role: usable ? roleOf(p.address) : UNDECLARED_ROLE,
    harness: declared || harness || UNDECLARED_HARNESS,
    // Mode is required by the schema and a legacy record may lack it. Same rule as `modeOf`: a
    // session reference means `managed`, none means `attached`; an unfamiliar value stays in `metadata`.
    mode: raw === 'managed' || raw === 'attached' ? raw : (ref ? 'managed' : 'attached'),
    sessionRef: ref,
    capabilities: capsOf(p.capabilities ?? null),
    metadata: { ...p },
  };
}

function toV1Task(id: string, meta: legacy.TaskMeta, harness: string | null): TaskV1 | null {
  const participants: ParticipantV1[] = [];
  const seen = new Set<string>();
  for (const p of meta.participants ?? []) {
    // The same translation the compatibility layer does — two editions of one rule would drift. A
    // record with a bad address is neither dropped nor lost: it gets a stable tail from the address.
    const one = participantToV1(p, harness);
    if (seen.has(one.id)) continue;
    seen.add(one.id);
    participants.push(one);
  }
  // The task owner must be a participant: in v1 it is the same kind of record. The former
  // `createTask` always laid `orchestrator` down, but a journal edited by hand could lose it.
  if (!seen.has(ORCHESTRATOR)) {
    participants.unshift(participantToV1({ address: ORCHESTRATOR }, harness));
  }
  const adapter: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!['id', 'title', 'status', 'created', 'participants'].includes(k)) adapter[k] = v;
  }
  const created = isoOf(meta.created, new Date().toISOString());
  const task: TaskV1 = {
    schemaVersion: SCHEMA_VERSION,
    id,
    title: (typeof meta.title === 'string' && meta.title) ? meta.title.slice(0, 512) : id,
    status: meta.status === 'done' ? 'done' : 'active',
    owner: ORCHESTRATOR,
    created,
    updated: isoOf(meta.closed, created),
    participants,
    adapter,
  };
  return validate('task', task).ok ? task : null;
}

// --- artifacts ------------------------------------------------------------------

/** Each file in `artifacts/` becomes a SHA-256 blob plus a metadata record, with the name kept as a
 * hard link in `files/`. An orphan moves with the rest: only `prune` may delete it, with the task. */
function migrateArtifacts(legacyHome: string, temp: string, id: string, meta: legacy.TaskMeta, report: TaskReport): Map<string, string> {
  const named = new Map<string, string>();
  const from = path.join(legacyHome, 'tasks', id, 'artifacts');
  let names: string[];
  try {
    names = readdirSync(from).sort();
  } catch {
    return named;
  }
  const stamp = compactStamp(new Date(isoOf(meta.created, new Date().toISOString())));
  let seq = 0;
  for (const name of names) {
    const src = path.join(from, name);
    let content: Buffer;
    try {
      if (!statSync(src).isFile()) continue;
      content = readFileSync(src);
    } catch (e) {
      report.broken.push(`artifact ${name}: could not be read (${(e as Error).message})`);
      continue;
    }
    seq += 1;
    const sha256 = createHash('sha256').update(content).digest('hex');
    const record: ArtifactV1 = {
      schemaVersion: SCHEMA_VERSION,
      id: `${stamp}-${String(seq).padStart(4, '0')}-${tail(name)}`,
      sha256,
      filename: name,
      size: content.length,
      blob: blobRef(sha256),
    };
    if (!validate('artifact', record).ok) {
      const attic = path.join(taskDir(temp, id), 'broken', 'artifacts');
      mkdirSync(attic, { recursive: true });
      copyFileSync(src, path.join(attic, name));
      report.broken.push(`artifact ${name}: metadata does not match the v1 schema — set aside in broken/artifacts`);
      continue;
    }
    mkdirSync(blobsDir(temp, id), { recursive: true });
    const blob = blobFile(temp, id, sha256);
    // A blob is immutable and is deduplicated inside the task: two same-named
    // files with the same content yield two metadata records and one blob.
    if (!existsSync(blob)) writeFileSync(blob, content);
    mkdirSync(artifactsDir(temp, id), { recursive: true });
    writeJsonAtomic(path.join(artifactsDir(temp, id), `${record.id}.json`), record);
    const files = filesDir(temp, id);
    mkdirSync(files, { recursive: true });
    try {
      linkSync(blob, path.join(files, name));
    } catch {
      // The name is taken — what a same-named file with different content looks like. The former
      // store already told them apart with a number at send time, so both names differ here.
    }
    named.set(name, record.id);
    report.artifacts += 1;
  }
  return named;
}

// --- messages ------------------------------------------------------------------

function migrateMessages(legacyHome: string, temp: string, id: string, named: Map<string, string>, report: TaskReport): void {
  const taskAt = path.join(legacyHome, 'tasks', id);
  for (const [box, target] of [['inbox', 'inbox'], ['read', 'history']] as const) {
    for (const dir of boxes(path.join(taskAt, box))) {
      for (const name of records(path.join(taskAt, box, dir))) {
        const moved = migrateMessage(path.join(taskAt, box, dir, name), temp, id, dir, target, named, report);
        if (moved) {
          report.messages += 1;
          if (target === 'inbox') report.unread += 1;
          else report.read += 1;
        }
      }
    }
  }
  // Already set aside by the former store. v1 has three `broken/` directories, not one — a
  // participant whose id is `artifacts` would otherwise walk off with someone else.
  for (const dir of boxes(path.join(taskAt, 'broken'))) {
    const attic = brokenInboxDir(temp, id, dir);
    mkdirSync(attic, { recursive: true });
    for (const name of readdirSync(path.join(taskAt, 'broken', dir))) {
      copyFileSync(path.join(taskAt, 'broken', dir, name), path.join(attic, name));
      report.broken.push(`message ${dir}/${name}: set aside by the former store — moved to broken/inbox`);
    }
  }
}

function boxes(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

function records(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
  } catch {
    return [];
  }
}

function migrateMessage(src: string, temp: string, id: string, box: string, target: 'inbox' | 'history',
  named: Map<string, string>, report: TaskReport): boolean {
  let raw: string;
  try {
    raw = readFileSync(src, 'utf8');
  } catch (e) {
    report.broken.push(`message ${box}/${path.basename(src)}: could not be read (${(e as Error).message})`);
    return false;
  }
  let legacyMsg: legacy.Message | null = null;
  let why = '';
  try {
    legacyMsg = JSON.parse(raw) as legacy.Message;
  } catch (e) {
    why = `did not parse (${(e as Error).message})`;
  }
  const message = legacyMsg && !why ? toV1Message(id, legacyMsg, named, box) : null;
  if (!message) {
    // A broken or untranslatable record goes to `broken/inbox/<participant>` under its own name. A
    // truncated file left by a process death mid-write looks exactly like this.
    const attic = brokenInboxDir(temp, id, box);
    mkdirSync(attic, { recursive: true });
    writeFileSync(path.join(attic, path.basename(src)), raw);
    report.broken.push(`message ${box}/${path.basename(src)}: ${why || 'does not translate into protocol v1'} `
      + '— set aside in broken/inbox');
    return false;
  }
  // Canonical and the recipient link are one inode, as on send: the link is laid AFTER the canonical,
  // and a repeat pass over a finished one does nothing.
  mkdirSync(messagesDir(temp, id), { recursive: true });
  const canonical = path.join(messagesDir(temp, id), `${message.id}.json`);
  if (!existsSync(canonical)) writeFileSync(canonical, `${JSON.stringify(message, null, 2)}\n`);
  const at = target === 'inbox' ? inboxDir(temp, id, box) : historyDir(temp, id, box);
  mkdirSync(at, { recursive: true });
  try {
    linkSync(canonical, path.join(at, `${message.id}.json`));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  return true;
}

function toV1Message(task: string, m: legacy.Message, named: Map<string, string>, box: string): MessageV1 | null {
  if (!isAddress(m?.from) || !isAddress(m?.to)) return null;
  const ts = isoOf(m.ts, '');
  if (!ts) return null;
  const artifact = typeof m.artifact === 'string' ? named.get(m.artifact) : undefined;
  const message: MessageV1 = {
    protocolVersion: MESSAGE_PROTOCOL_VERSION,
    id: recordIdOf(String(m.id ?? ''), ts, box),
    task,
    sender: addrDir(m.from),
    recipients: [addrDir(m.to)],
    type: String(m.type),
    body: String(m.body ?? ''),
    ...(artifact ? { artifact } : {}),
    ts,
  };
  return validate('message', message).ok ? message : null;
}

// --- adapter files -------------------------------------------------------------

/** What is copied as-is: files that neither store holds. `wake/` is absent on purpose — a moved
 * contact point would be the address of a dead socket, and the warden would knock until it refused. */
const SIDECAR = ['health.json', 'supervisor.json', 'supervisor.log', 'stalls.json', 'waits', 'workers'];

function copySidecar(legacyHome: string, temp: string, id: string): void {
  const from = path.join(legacyHome, 'tasks', id);
  for (const name of SIDECAR) {
    const src = path.join(from, name);
    if (!existsSync(src)) continue;
    cpSync(src, path.join(taskDir(temp, id), name), { recursive: true });
  }
}

/** Session→task bindings — as-is: the store does not touch their format at all. */
function copyBindings(legacyHome: string, temp: string): number {
  const from = path.join(legacyHome, 'sessions');
  let names: string[];
  try {
    names = readdirSync(from).filter((n) => n.endsWith('.json'));
  } catch {
    return 0;
  }
  if (!names.length) return 0;
  mkdirSync(path.join(temp, 'sessions'), { recursive: true });
  for (const name of names) copyFileSync(path.join(from, name), path.join(temp, 'sessions', name));
  return names.length;
}
