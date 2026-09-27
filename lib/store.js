import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { artifactClaimsInResult, recordRefusal } from './handoff.js';
import { warn } from './util.js';
import {
  addrDir, addressOf, bindingNames, brokenNote, claimRoute, dropBinding, FOREIGN_MARK,
  FOREIGN_ROUTE, MAILBOX_COPY,
  boundSessionOf, foreignSessionOf, foreignTaskLine,
  GateError, holdsSession, isAddress, MECHANISM_VERSION_FIELD, MESSAGE_TYPES, migrate, splitLegacyRel,
  newTaskIdentity, onTaskLock,
  openEngine, ORCHESTRATOR, ownerOf, participantFileStem, preflight, PromptobusError,
  listArtifacts, readBinding, requireTaskId,
  roleOf, ROOT_DIR, sameSession, sessionFile, sessionIdOf, sessionOf, stampOfId, TASK_TITLE_SEP, taskDir,
  tasksDir, validate,
  withTaskLock as lockTask, workersDir, writeBinding,
  addressList, admitsAddress, APPROVER, EDITS_TREE, registryOf, roleEntry, SHIPPED_REGISTRY, WORKER, WRITES_MAIN_TREE,
} from '../dist/index.js';
import { writeFileAtomic, writeJsonAtomic } from '../dist/fs/atomic.js';
import { artifactsDir, blobsDir, brokenArtifactsDir, filesDir, messagesDir } from '../dist/v1/layout.js';
import { RECORD_ID_RE } from '../dist/v1/model.js';
import { writeTask } from '../dist/v1/store.js';

// Keep these adapter-local path helpers for lib/ callers without widening the package entry.
export { artifactsDir, blobsDir, brokenArtifactsDir, filesDir, messagesDir };

// Adapter of the bus over Promptobus. The core — tasks, participants,
// mailboxes, artifacts, recoverable fan-out, history, task-directory files and the MCP factory
// — lives in the package TypeScript core and knows nothing about the workspace.
//
// What remains here is what the core must not know: finding the workspace root, the store
// path inside it, session identity, human diagnostics, routing policy
// and the mechanism address grammar.
//
// **There is no compatibility layer any more.** The package has one surface — v1 — and
// bus consumers call it with v1 models: `TaskV1` (title, status, participants, `adapter`
// with mechanism fields), `ParticipantV1` (id, role, harness, mode, session reference,
// capabilities and mechanism `metadata`), `MessageV1` (sender and recipients — participant
// ids). This module makes no promise that "names and signatures stay the same": it is the
// mechanism door, not a second layer over the core. Helpers that v1 does not and cannot
// give — address to participant record, the foreign-mailbox gate vocabulary, the task title
// from tracks, "session → task" bindings — live here explicitly and without compatibility
// promises.
//
// **Import is by path to `dist`, not by package name.** From a checkout the command works
// only after a build — `npm run build`. A tarball user is unaffected: `dist`
// ships in the package.
//
// Every other bus module still imports `./store.js`: the boundary sits here,
// and they have no reason to know about `dist`.
export {
  // addresses and grammar
  ORCHESTRATOR, isAddress, addrDir, roleOf, addressOf, workerAddress, reviewerAddress, approverAddress,
  participantFileStem, SLUG_MAX, slugify, newTaskIdentity, stampOfId, TASK_TITLE_SEP,
  // foreign-mailbox gate vocabulary
  GateError, FOREIGN_MARK, FOREIGN_ROUTE, MAILBOX_CLAIMED_MARK, foreignTaskLine, claimRoute,
  brokenNote,
  // session identity on the participant record and its check
  sessionOf, sessionIdOf, sameSession, foreignSessionOf, holdsSession, startedOf,
  // message types, protocol v1 refusal codes, and the open fan-out lease
  MESSAGE_TYPES, ERROR_CODES, PromptobusError,
  // task-directory paths and files the store does not hold
  taskDir, tasksDir, workersDir, sessionsDir, sessionFile, wakeFile, healthFile,
  stallsFile, wardenLogFile, wardenMarkFile,
  // liveness and the warden
  pidAlive, WARDEN_BEAT_SEC, liveWarden, claimWarden, beatWarden, clearWarden,
  readWake, writeWake, readHealth, writeHealth, logWarden, tailWardenLog,
  readWardenExit, readWardenGeneration, writeWardenExit, clearWardenExit,
  // end-of-turn marks and the session transcript the guard saw
  lastTurnAt, markTurn, markTranscript, readTranscript,
  // busy journal-lock refusal
  lockBusyError,
} from '../dist/index.js';

// Root of the bus store inside the workspace. This is `.promptobus`: mail,
// participants and artifacts live in protocol v1.
// The `PROMPTOBUS_HOME` environment variable takes its name from here.
export const PROMPTOBUS_REL = ROOT_DIR;

// Harness for records that do not name one at all: the former CLI journal. Same value as
// the driver-registry `fallback` — importing it from here is impossible (the registry pulls
// the driver, and that pulls this module), so the copy lives here, and a suite check holds
// them together: `REGISTRY.fallback === FALLBACK_HARNESS`.
export const FALLBACK_HARNESS = 'claude';

export function promptobusHome(root, host) {
  if (host == null) {
    throw new Error("promptobusHome: host is required — a missing legacy layout is declared by host.legacyLayout(), not by omitting the argument");
  }
  ensureStore(root, host);
  return path.join(root, PROMPTOBUS_REL);
}

/**
 * Workspace root from a declared store directory.
 *
 * Two tails are recognised — the new one (`.promptobus`) and the former one, if the host
 * declared it through `legacyLayout()`. `legacyLayout() === null` is the legal standalone
 * path: there is no legacy layout, nothing to migrate, the tail is unrecognised, and the
 * home is taken as-is. Recognised — migration runs the same way as the command, and a stale
 * `PROMPTOBUS_HOME` of an unsynced config resolves to the NEW root instead of recreating
 * the old directory next to the one that already moved. Unrecognised — the directory is
 * taken as-is: home may be an arbitrary directory (the suite sets it that way), and
 * inventing a root for it is forbidden.
 */
function rootOfHome(home, host) {
  if (host == null) {
    throw new Error("rootOfHome: host is required — a missing legacy layout is declared by host.legacyLayout(), not by omitting the argument");
  }
  const abs = path.resolve(home);
  if (path.basename(abs) === PROMPTOBUS_REL) return path.dirname(abs);
  const layout = host?.legacyLayout?.() ?? null;
  if (!layout?.rel) return null;
  const parts = splitLegacyRel(layout.rel);
  if (!parts) return null;
  const [outer, inner] = parts;
  const parent = path.dirname(abs);
  if (path.basename(abs) === inner && path.basename(parent) === outer) return path.dirname(parent);
  return null;
}

// Migration of the former directory → `.promptobus` on the first migration-aware access.
// A host whose `legacyLayout()` is not null runs the package-root `preflight()` and, when
// its plan says so, `migrate()` inside its own `promptobusHome()`; a refusal surfaces there.
// Commands ask their host for that already chosen home. The adapter-internal
// `promptobusHome(root, host)` is the assembly `resolveIdentity` uses when a process declares
// `PROMPTOBUS_HOME`. That identity entry remains mandatory: participant configs and the
// workspace canonical list both set the variable, so a bus-tool call from a session may
// never call the host member itself.
//
// A preflight refusal (active tasks, both roots at once, a damaged root) is a legal
// outcome and arrives as a `GateError`: the top-level catch prints it without a stack, and
// the MCP server returns it as the tool reply text. A successful-move report goes to
// stderr: MCP-server stdout is the protocol in full, and a stray line in it breaks the
// client.
//
// What was done is remembered PER ROOT, not as one process-wide flag: a process may have
// several roots — that is how the suite walks, and how a command that was given a root
// argument walks too.
const migrated = new Set();

function ensureStore(root, host) {
  if (host == null) {
    throw new Error("ensureStore: host is required — a missing legacy layout is declared by host.legacyLayout(), not by omitting the argument");
  }
  if (migrated.has(root)) return;
  const layout = host.legacyLayout();
  const plan = preflight(root, layout);
  if (!plan.needed && !plan.refusal) {
    migrated.add(root);
    return;
  }
  if (plan.refusal) throw new GateError(plan.refusal);
  // The adapter feeds session identity and the harness name into the move: the first is
  // for a busy migration-lock diagnosis, the second is for former-CLI records that have
  // no `harness` field at all, while v1 requires it on every participant record.
  const report = migrate(root, { session: sessionIdentity(), harness: FALLBACK_HARNESS, layout });
  migrated.add(root);
  // Nothing was done: there was nothing to move, or a neighbour did it all — the move
  // runs from two processes at once, and the loser leaves empty-handed. Stay silent: a
  // numeric report on an empty result would say "0 tasks, 0 messages, former directory
  // removed" where the neighbour moved seventy-one tasks — that is, it would lie with
  // exactly the line promised to the user as the report.
  if (!report.moved) return;
  if (report.resumed) {
    warn(`bus: former directory ${report.from} is gone — interrupted move cleanup finished`);
    return;
  }
  const msgs = report.tasks.reduce((n, t) => n + t.messages, 0);
  const arts = report.tasks.reduce((n, t) => n + t.artifacts, 0);
  const broken = report.tasks.reduce((n, t) => n + t.broken.length, 0);
  warn(`the bus moved to ${report.to}: ${report.tasks.length} tasks, ${msgs} messages, `
    + `${arts} artifacts, ${report.bindings} session bindings`
    + `${broken ? `, ${broken} broken records set aside` : ''}`
    + `${report.brokenTasks.length ? `, ${report.brokenTasks.length} damaged tasks (in migration-broken)` : ''}`
    + `. Former directory ${report.from} removed: the old CLI does not read the new store.`);
}

// Who this session is — the drivers' answer, injected rather than imported: the core
// cannot reach them, and 02-host.md § Session identity carries the measurement that says so.
let readIdentity = null;
let saidUnbound = false;

export function bindSessionIdentity(fn) {
  readIdentity = typeof fn === 'function' ? fn : null;
}

/**
 * `null` is an answer here, never a silence. Unbound, the core says so once instead of
 * falling back to one harness's variable — the fallback IS the defect (ADR-010).
 */
export function sessionIdentity(env = process.env, scope = null) {
  if (!readIdentity) {
    if (!saidUnbound) {
      saidUnbound = true;
      warn('session identity: no driver registry is bound to this process, so no harness can name itself — '
        + 'task ownership stays unestablished for this call');
    }
    return null;
  }
  const answer = readIdentity(env, scope);
  // Only the CONTESTED null is worth a person's attention. An environment that names no
  // harness is a legal state — a plain shell, a stand — and its reason stays on the
  // resolver's `why` for a caller that shows it.
  if (contestedIdentity(answer)) warnOnce(`session identity: ${answer.why}`);
  return answer?.id ?? null;
}

// Too much rather than too little. Named by the resolver's own state, not counted here:
// counting was what read two variables as none.
export function contestedIdentity(answer) {
  return answer?.reason === 'contested' || answer?.reason === 'contested-records';
}

/**
 * The resolver's whole answer, for a caller whose refusal must SAY why there is no identity.
 * `sessionIdentity` drops everything but the id, and "none" and "contested" then look alike.
 */
export function sessionIdentityReport(env = process.env, scope = null) {
  const answer = readIdentity ? readIdentity(env, scope) : null;
  return answer ?? { id: null, reason: 'none', why: 'no driver registry is bound to this process', candidates: [] };
}

const saidWhy = new Set();

function warnOnce(text) {
  if (saidWhy.has(text)) return;
  saidWhy.add(text);
  warn(text);
}

// --- engine v1 -------------------------------------------------------------------

// The consumer supplies the route rule; core reads roles from participant records.
const GOVERNANCE = Object.freeze(Object.fromEntries(
  SHIPPED_REGISTRY.entries.filter((entry) => entry.layer === 'governance').map((entry) => [entry.name, entry.name]),
));
const SIBLING_TYPES = Object.freeze(['question', 'answer', 'status', 'artifact']);

function rootTeamlead(home, task, participant) {
  if (task.parent !== undefined || participant.role !== GOVERNANCE.teamlead) return false;
  const childId = participant.metadata?.childTask;
  if (typeof childId !== 'string') return false;
  try {
    const child = readTask(home, childId);
    const bound = sessionIdOf(participant);
    const owner = ownerOf(participantOf(child, ORCHESTRATOR));
    return child.parent === task.id && !!bound && !!owner && bound === owner;
  } catch {
    return false;
  }
}

function linkedPeer(home, task, peer) {
  const otherId = peer.metadata?.peerTask;
  if (task.parent !== undefined || peer.role !== GOVERNANCE.peer || typeof otherId !== 'string') return false;
  try {
    const other = readTask(home, otherId);
    const mine = ownerOf(participantOf(task, ORCHESTRATOR));
    const theirs = ownerOf(participantOf(other, ORCHESTRATOR));
    const back = participantOf(other, `${GOVERNANCE.peer}:${task.adapter.slug}`);
    return other.parent === undefined && other.id !== task.id
      && typeof task.adapter.slug === 'string' && typeof other.adapter.slug === 'string'
      && addressOf(peer) === `${GOVERNANCE.peer}:${other.adapter.slug}`
      && back?.metadata?.peerTask === task.id
      && mine && theirs && sessionIdOf(peer) === theirs && sessionIdOf(back) === mine;
  } catch {
    return false;
  }
}

function routingPolicy(home, sender, recipient, task, type, registry) {
  const vertical = `route through the root orchestrator of task ${task.parent ?? task.id}`;
  if (sender.role === GOVERNANCE.reporter) {
    return { deny: true, reason: `the reporter reads and sends nothing — ${vertical}` };
  }
  if (sender.role === GOVERNANCE.user || recipient.role === GOVERNANCE.user) {
    if (sender.role === GOVERNANCE.user
      && recipient.role === ORCHESTRATOR && type === 'question') {
      return { allow: true };
    }
    if (sender.role === ORCHESTRATOR && recipient.role === GOVERNANCE.user
      && (type === 'answer' || type === 'status')) return { allow: true };
    return { deny: true, reason: `user asks the orchestrator by question and receives answer or status — ${vertical}` };
  }
  if (sender.role === GOVERNANCE.peer || recipient.role === GOVERNANCE.peer) {
    const peer = sender.role === GOVERNANCE.peer ? sender : recipient;
    if ((sender.role === ORCHESTRATOR || recipient.role === ORCHESTRATOR)
      && SIBLING_TYPES.includes(type) && linkedPeer(home, task, peer)) return { allow: true };
    return { deny: true, reason: `peers exchange only question, answer, status or artifact after a reciprocal link — ${vertical}` };
  }
  if (sender.role === GOVERNANCE.teamlead && recipient.role === GOVERNANCE.teamlead) {
    if (sender.id !== recipient.id && SIBLING_TYPES.includes(type)
      && rootTeamlead(home, task, sender) && rootTeamlead(home, task, recipient)) return { allow: true };
    return { deny: true, reason: `${type} between teamleads needs sibling bindings and ${vertical}` };
  }
  if (sender.role === ORCHESTRATOR || recipient.role === ORCHESTRATOR) return { allow: true };
  if (acceptanceRoute(sender, recipient, registry)) return { allow: true };
  return {
    deny: true,
    reason: `${sender.role}s and ${recipient.role}s do not write to each other — `
      + `context and artifacts go through the orchestrator: pass this to them, they will forward it; ${vertical}`,
  };
}

// Engine on a home and reader version: the first access restores unfinished fan-outs of
// every task and reports the result, and there is no need to do that on every store call.
// Each process entry point selects the version for the home it resolves; adapter helpers use
// that selection. A direct low-level helper call has the core's honest `null` reader until
// an entry point selects one and warns once instead of silently losing mixed-version
// diagnosis; that engine is a different cache entry. Tests may open the same home as two
// releases, so a reader never inherits the diagnosis vocabulary of the writer that ran
// before it.
const engines = new Map();
const selectedVersions = new Map();
const warnedUnversionedReaders = new Set();
const routeRegistries = new Map();

function engine(home, version = selectedVersions.get(home) ?? null) {
  if (version === null && !warnedUnversionedReaders.has(home)) {
    warnedUnversionedReaders.add(home);
    warn(`bus: unversioned reader opened ${home} — mixed-version diagnosis may be incomplete`);
  }
  const byVersion = engines.get(home);
  const hit = byVersion?.get(version);
  if (hit) return hit;
  const opened = openEngine({
    home, policy: (sender, recipient, task, type) => routingPolicy(
      home, sender, recipient, task, type, routeRegistries.get(home) ?? SHIPPED_REGISTRY,
    ),
    cli: version, recover: false,
  });
  reportRecovery(opened.recover());
  if (byVersion) byVersion.set(version, opened);
  else engines.set(home, new Map([[version, opened]]));
  return opened;
}

function writerVersion(home, record) {
  const version = selectedVersions.get(home) ?? null;
  if (!version) {
    warn(`bus: ${record} in ${home} without mechanismVersion — no writer version was selected`);
  }
  return version;
}

function reportRecovery(result) {
  // Recovery activation events stay with the warden: it wakes from unread refs.
  for (const link of result.links) {
    warn(`bus recovery: task ${link.child} parent link to ${link.parent} completed `
      + `(child created: ${link.childCreated}, teamlead registered: ${link.teamleadRegistered})`);
  }
  for (const failure of result.linkFailures) {
    warn(`bus recovery: task ${failure.child} parent link to ${failure.parent} remains unfinished: ${failure.note}`);
  }
  for (const repair of result.repairs) {
    warn(`bus recovery: task ${repair.task}, message ${repair.message} fan-out completed `
      + `(new recipients: ${repair.recipients.join(', ') || 'none'})`);
  }
  for (const broken of result.broken) {
    const place = broken.attic ? `set aside at ${broken.attic}` : 'left in place';
    warn(`bus recovery: record ${broken.name} ${place} (${broken.code}): ${broken.note}`);
  }
  for (const failure of result.failed) {
    if (failure.code === 'intent-lost') {
      warn(`bus recovery: task ${failure.task}, message ${failure.message} is lost and will not be retried `
        + `(${failure.code}): ${failure.note}`);
      continue;
    }
    warn(`bus recovery: task ${failure.task}, message ${failure.message} remains unfinished `
      + `(${failure.code}): ${failure.note}`);
  }
}

/**
 * v1 engine of this home — the only mechanism door into the store. The store directory is
 * given in full: the mechanism receives it from an environment variable, and `.promptobus`
 * may be missing from the end entirely.
 */
export function bus(home, { cli } = {}) {
  const version = cli === undefined ? selectedVersions.get(home) : cli;
  if (typeof version !== 'string' || !version.trim()) {
    throw new TypeError(`bus: reader mechanism version is required on the first open of ${home}`);
  }
  // The mechanism version is named at open — CLI dispatch and the independently resolved
  // warden, guard, and MCP homes go through this door, so they read a mixed-version store
  // the same way.
  const opened = engine(home, version);
  selectedVersions.set(home, version);
  return opened;
}

/**
 * A v1 refusal — to a human. Codes `task-not-found`, `task-broken`, `lock-busy` and the
 * rest are addressed to whoever typed the command, so they leave as a `GateError`: a bare
 * `Error` is printed with a stack by the CLI top-level catch, and a legal refusal reads as
 * a break in the mechanism itself. The caller may also branch on the code — `ERROR_CODES`
 * are exported from here too.
 */
function gate(fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PromptobusError) throw new GateError(e.message);
    throw e;
  }
}

// --- participants: address ↔ v1 record ------------------------------------------------

/**
 * v1 participant record from an address and mechanism fields.
 *
 * Own v1 fields are `id`, `role`, `harness`, `mode`, `sessionRef`, `capabilities`; everything
 * else the mechanism writes about the participant (track title, repository, session name,
 * start time, dismissed-from-watch mark) rides in `metadata` in full, and the address lives
 * there too: it is how the participant is named to a human, and how health, contact points
 * and stop marks are keyed.
 */
export function participantRecord(address, fields = {}, registry = SHIPPED_REGISTRY) {
  if (!admitsAddress(registry, address)) {
    throw new GateError(`invalid participant address "${address}" — `
      + `expected ${addressList(registry)}`);
  }
  const declared = typeof fields.harness === 'string' ? fields.harness.trim() : '';
  const ref = typeof fields.sessionRef === 'string' && fields.sessionRef ? fields.sessionRef
    : (typeof fields.name === 'string' && fields.name ? fields.name : null);
  const raw = typeof fields.mode === 'string' ? fields.mode.trim() : '';
  return {
    id: addrDir(address),
    role: roleOf(address),
    harness: declared || FALLBACK_HARNESS,
    // Mode is required by the schema. Same rule as `modeOf` on the driver contract: spawn
    // started the session for the participant, so `managed`; no session — `attached`, as
    // for the owner.
    mode: raw === 'managed' || raw === 'attached' ? raw : (ref ? 'managed' : 'attached'),
    sessionRef: ref,
    capabilities: capsOf(fields.capabilities ?? null),
    // A caller with store context adds the mechanism version that wrote the record. It is
    // the evidence of a mixed-version store: a reader from a former release trips over fields
    // it does not know, and without the version it answers "journal is not to schema" instead
    // of "start a new session". A context-free record has no synthetic writer version.
    metadata: { ...fields, address },
  };
}

// A capabilities snapshot is stored only whole: half a snapshot means nothing, and the
// schema would reject such a record anyway.
function capsOf(value) {
  return validate('participant', {
    id: 'x', role: 'x', harness: 'x', mode: 'attached', sessionRef: null, capabilities: value, metadata: {},
  }).ok ? value : null;
}

// Participant files in `workers/` — by address: lift writes them, and `promptobus done`
// sweep cleans them. Name joining lives in the package (`participantFileStem`), the
// directory lives in the sidecar; here there are only the two doors the mechanism calls
// them through.
export function participantMcpPath(home, taskId, address) {
  return path.join(workersDir(home, taskId), `${participantFileStem(address)}.mcp.json`);
}

export function participantSettingsPath(home, taskId, address) {
  return path.join(workersDir(home, taskId), `${participantFileStem(address)}.settings.json`);
}

/**
 * Participant DIRECTORIES in `workers/` — those the driver created next to the files.
 * The driver chooses the directory name, so the mechanism recognises them by the shared
 * address stem, not by name: the Cursor and Codex drivers each seat a reviewer in one of
 * these, Claude Code has none at all. What is inside differs by driver — a Cursor
 * reviewer's holds its project configs, including an MCP config with tokens substituted
 * in, while a Codex reviewer's holds a copy of the workspace skills canon and nothing
 * secret — so the same `promptobus done` sweep that cleans mcp-configs removes them
 * whole, without asking a driver what it put there.
 */
export function participantDirs(home, taskId, address) {
  const dir = workersDir(home, taskId);
  const stem = `${participantFileStem(address)}.`;
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(stem))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

/** Participant of the task by address; `null` — no such record in the journal. */
export function participantOf(meta, address) {
  return (meta?.participants ?? []).find((p) => addressOf(p) === address) ?? null;
}

/** Addresses of the task participants, in record order. Invalid records are skipped. */
export function addressesOf(meta) {
  return (meta?.participants ?? []).map((p) => addressOf(p)).filter(Boolean);
}

// --- task journal ---------------------------------------------------------------

export function taskExists(home, id) {
  return typeof id === 'string' && engine(home).taskExists(id);
}

export function taskFile(home, id) {
  return engine(home).taskFile(requireTaskId(id));
}

export function inboxDir(home, id, addr) {
  return engine(home).inboxPath(requireTaskId(id), addrDir(addr));
}

/** What this address has read: in v1 the directory is called `history/` — fan-out
 * recovery uses the filename in it to tell delivered from missing. */
export function historyDir(home, id, addr) {
  return engine(home).historyPath(requireTaskId(id), addrDir(addr));
}

/** Where unreadable mail from this address mailbox is set aside. */
export function brokenDir(home, id, addr) {
  return engine(home).brokenPath(requireTaskId(id), addrDir(addr));
}

// Journal cache for one request: a single bus-tool call reads the journal four to six
// times from places that do not know about each other. It lives exactly as long as the
// wrapped synchronous stretch: outside it a neighbour edits the journal legally. A journal
// write and the task lock clear it. Reader invariant: do not mutate a `readTask` result
// that came from the cache.
let taskCache = null;

export function withTaskCache(fn) {
  const outer = taskCache;
  taskCache = outer ?? new Map();
  try {
    return fn();
  } finally {
    taskCache = outer;
  }
}

// The cache is dropped for the duration of the lock: under it the journal changes both
// by this write and by a foreign write the lock waited for. The lock itself lives in the
// package and knows nothing about caches.
onTaskLock((fn) => {
  const outer = taskCache;
  taskCache = null;
  try {
    return fn();
  } finally {
    taskCache = outer;
    outer?.clear();
  }
});

export function readTask(home, id) {
  const key = `${home}\u0000${requireTaskId(id)}`;
  const hit = taskCache?.get(key);
  if (hit) return hit;
  const meta = gate(() => engine(home).readTask(id));
  taskCache?.set(key, meta);
  return meta;
}

/** Read-modify-write of the journal under the task lock, with session identity for diagnosis. */
export function withTaskLock(home, id, fn, opts = {}) {
  return lockTask(home, id, fn, { session: sessionIdentity(), ...opts });
}

/** Patch the journal: title and mechanism fields in `adapter`. `adapter` fields are merged. */
export function patchTask(home, id, patch) {
  const meta = gate(() => engine(home).patchTask(id, patch));
  taskCache?.clear();
  return meta;
}

/**
 * Create a task IN JOURNAL FORM: `{ id, title, adapter }` — the same form `readTask`
 * returns. One form on purpose: the command plan carries the journal it will write, and
 * reads it by the same fields the next command will read — slug, stamp and the explicit-
 * title mark live in `adapter`; the own fields of the task there are title and status.
 *
 * The mailbox-owner session is not a task field: it rides in the `orchestrator` participant
 * record `metadata`, and is written only when the environment supplied identity.
 */
export function createTask(home, {
  id = newTaskIdentity().id, title, adapter: fields = {}, owner = sessionIdentity(),
  parent, teamlead,
} = {}) {
  requireTaskId(id);
  if (parent !== undefined) requireTaskId(parent);
  if (taskExists(home, id)) throw new Error(`task ${id} already exists`);
  const version = writerVersion(home, `creating task ${id} orchestrator participant`);
  // The stamp is always written: without it `readableTail` falls back to the full id — a
  // human reads `(t20260827-175756)` instead of `(0827-1757)`.
  const taskStamp = fields.stamp ?? stampOfId(id);
  const adapter = { ...fields, ...(taskStamp ? { stamp: taskStamp } : {}) };
  const leadAddress = parent === undefined ? null : (teamlead ?? `teamlead:${slugify(fields.slug ?? id)}`);
  if (parent !== undefined && (!owner || !leadAddress?.startsWith('teamlead:') || !isAddress(leadAddress))) {
    throw new GateError(`child task ${id} needs a session owner and a teamlead:<slug> address in parent ${parent}`);
  }
  let meta;
  try {
    // Create is first-wins — the `wx` flag inside v1: between the check and the write a
    // second first spawn of the same run can slip in, and the late one would silently
    // overwrite the participants of the one that got there first via `rename`.
    //
    // The task owner is the `orchestrator` participant. The session that owns that mailbox
    // sits in the `owner` field of `metadata`: that is ownership of the address, not of the
    // task. Write it only when the environment supplied identity — otherwise the owner
    // mechanism is off.
    meta = engine(home).createTask({
      id,
      title: title ?? id,
      owner: participantRecord(ORCHESTRATOR, {
        ...(owner ? { owner } : {}),
        ...(version ? { [MECHANISM_VERSION_FIELD]: version } : {}),
      }),
      adapter,
      ...(parent === undefined ? {} : {
        parent,
        teamlead: participantRecord(leadAddress, {
          sessionId: owner,
          ...(version ? { [MECHANISM_VERSION_FIELD]: version } : {}),
        }),
      }),
    });
  } catch (e) {
    if (e instanceof PromptobusError && e.code === 'task-exists') throw new Error(`task ${id} already exists`);
    if (e instanceof PromptobusError) throw new GateError(e.message);
    throw e;
  }
  // Owner mailbox and task-files directories — the way the former store created them: an
  // empty mailbox and an empty files folder are visible to a human right after `spawn`.
  mkdirSync(inboxDir(home, id, ORCHESTRATOR), { recursive: true });
  mkdirSync(filesDir(home, id), { recursive: true });
  return meta;
}

// Listing survives both a stray directory and a broken journal: one damaged task would
// otherwise kill every bus command — `listTasks` feeds `resolveTaskId`.
export function listTasks(home) {
  const { tasks, broken } = engine(home).listTasks();
  // The text is assembled here, not received as a ready-made string: id and reason arrive
  // as a pair, and a human also needs the file path — that is what they fix from.
  for (const { id, note } of broken) {
    warn(`task ${id} skipped: ${taskFile(home, id)} is unreadable (${note})`);
  }
  return [...tasks].sort((a, b) => String(a.created).localeCompare(String(b.created)));
}

export function activeTasks(home) {
  return listTasks(home).filter((t) => t.status === 'active');
}

export function closeTask(home, id) {
  const meta = gate(() => engine(home).closeTask(id, { adapter: { closed: new Date().toISOString() } }));
  taskCache?.clear();
  return meta;
}

// The active task of the process. Three sources, strongest first: an explicit declaration
// (tool argument, `--task`, `PROMPTOBUS_TASK`), the session binding, and the "only active
// one" fallback — a spare path for those who have no identity; its gates watch it.
//
// All three refusals are addressed to a human — a typo in the id, an empty journal, several
// active tasks at once — so they are thrown as a `GateError`: a bare `Error` is printed
// with a stack by the CLI top-level catch, and a legal refusal reads as a break in the
// mechanism itself.
export function resolveTaskId(home, declared, session = sessionIdentity(), hints) {
  const { spawnRepo, spawnNewTask } = hints;
  if (declared) {
    if (!taskExists(home, declared)) throw new GateError(`task ${declared} is not in ${tasksDir(home)}`);
    return declared;
  }
  const bound = boundTaskId(home, session);
  if (bound) return bound;
  const active = activeTasks(home);
  if (active.length === 1) return active[0].id;
  if (active.length === 0) {
    throw new GateError(`no active task: ${tasksDir(home)} is empty or every task is closed. `
      + `A task is created when the first worker is spawned: ${spawnRepo}`);
  }
  throw new GateError(`several active tasks (${active.map((t) => t.id).join(', ')}), `
    + `and this session has no binding${session ? '' : ' — the environment did not supply its identity'} — `
    + 'name the one you want (PROMPTOBUS_TASK for the session, --task for the command). '
    + 'The task is yours and the session is new — claim the mailbox: mailbox {claim: true, task: <id>}, '
    + `then it will resolve on its own. Need a new run — start it with ${spawnNewTask}.`);
}

// The mailbox that was read from and written to is named in every bus reply: home,
// task, address. The task is also named by title: a foreign task is given away by the
// subject, not by the id. The same line names the drift "session bound to A, journal
// says B" — that is legal.
export function identityLabel(home, task, addr, session = null) {
  const { title } = readTask(home, task);
  const named = title && title !== task ? `${task} "${title}"` : task;
  const bound = session ? boundTaskId(home, session) : null;
  const drift = bound && bound !== task ? ` · session binding ${session}: task ${bound}` : '';
  return `PROMPTOBUS_HOME=${home} · task=${named} · address=${addr}${drift}`;
}

// --- participants ---------------------------------------------------------------------

/**
 * Put the participant in full, replacing the former record. Lift writes a NEW record — a
 * new session, a new capabilities snapshot — and takes with it everything that belonged
 * to the former one, including the dismissed-from-watch mark.
 */
export function upsertParticipant(home, id, participant) {
  const meta = gate(() => engine(home).putParticipant(id, participant));
  taskCache?.clear();
  return meta;
}

export function changePeerLink(home, aId, bId, { session, unlink = false, write = writeTask } = {}) {
  requireTaskId(aId);
  requireTaskId(bId);
  if (aId === bId) throw new GateError(`task ${aId} cannot link to itself`);
  const requireOwner = (metas) => {
    if (metas.some((meta) => ownership(home, meta.id, ORCHESTRATOR, session).allowed)) return;
    const meta = metas[0];
    const own = ownership(home, meta.id, ORCHESTRATOR, session);
    throw new GateError(`${unprovenOwnerLine(home, meta, own)} — link and unlink require the owner of one named task. `
      + ownerRoute(home, meta, own, `the ${unlink ? 'unlink' : 'link'} command`));
  };
  const aExists = unlink && taskExists(home, aId);
  const bExists = unlink && taskExists(home, bId);
  if (aExists !== bExists) {
    const survivingId = aExists ? aId : bId;
    const missingId = survivingId === aId ? bId : aId;
    return withTaskLock(home, survivingId, () => {
      if (taskExists(home, missingId)) throw new GateError(`task ${missingId} reappeared; retry unlink`);
      const survivor = readTask(home, survivingId);
      if (survivor.parent !== undefined) throw new GateError(`task ${survivor.id} is a child; only root tasks can be peers`);
      requireOwner([survivor]);
      const matches = survivor.participants.filter((p) => p.role === GOVERNANCE.peer
        && p.metadata?.peerTask === missingId);
      if (matches.length !== 1) {
        throw new GateError(`task ${survivingId} has no unique peer record for missing task ${missingId}`);
      }
      const address = addressOf(matches[0]);
      const back = `${GOVERNANCE.peer}:${survivor.adapter?.slug}`;
      if (!address?.startsWith(`${GOVERNANCE.peer}:`) || !isAddress(back)) {
        throw new GateError(`task ${survivingId} has an invalid peer record for missing task ${missingId}`);
      }
      const meta = { ...survivor, participants: survivor.participants.filter((p) => p !== matches[0]) };
      const verdict = validate('task', meta);
      if (!verdict.ok) throw new GateError(`task ${survivor.id} peer record is invalid: ${verdict.at} ${verdict.note}`);
      gate(() => write(home, meta, () => new Date()));
      taskCache?.clear();
      return survivingId === aId ? { a: address, b: back } : { a: back, b: address };
    });
  }
  const [first, second] = [aId, bId].sort();
  return withTaskLock(home, first, () => withTaskLock(home, second, () => {
    const a = readTask(home, aId);
    const b = readTask(home, bId);
    for (const meta of [a, b]) {
      if (meta.parent !== undefined) throw new GateError(`task ${meta.id} is a child; only root tasks can be peers`);
      if (!unlink && meta.status !== 'active') throw new GateError(`task ${meta.id} is ${meta.status}; only active roots can link`);
    }
    requireOwner([a, b]);
    const pair = [[a, b], [b, a]].map(([source, other]) => {
      const slug = other.adapter?.slug;
      if (typeof slug !== 'string' || !isAddress(`peer:${slug}`)) {
        throw new GateError(`task ${other.id} has no valid peer slug; its adapter.slug must form peer:<slug>`);
      }
      const address = `peer:${slug}`;
      const was = participantOf(source, address);
      if (was && (was.role !== GOVERNANCE.peer || was.metadata?.peerTask !== other.id)) {
        throw new GateError(`task ${source.id} already has ${address} for another participant or task`);
      }
      const owner = ownerOf(participantOf(other, ORCHESTRATOR));
      if (!unlink && !owner) throw new GateError(`task ${other.id} has no recorded owner session to bind ${address}`);
      return { source, other, address, was, owner };
    });
    const version = unlink ? null : writerVersion(home, `linking peer tasks ${aId} and ${bId}`);
    const next = pair.map(({ source, other, address, owner }) => {
      const participants = source.participants.filter((p) => addressOf(p) !== address);
      if (!unlink) participants.push(participantRecord(address, {
        peerTask: other.id, sessionId: owner,
        ...(version ? { [MECHANISM_VERSION_FIELD]: version } : {}),
      }));
      const meta = { ...source, participants };
      const verdict = validate('task', meta);
      if (!verdict.ok) throw new GateError(`task ${source.id} peer record is invalid: ${verdict.at} ${verdict.note}`);
      return meta;
    });
    for (const meta of next) gate(() => write(home, meta, () => new Date()));
    taskCache?.clear();
    return { a: pair[0].address, b: pair[1].address };
  }));
}

// Dismiss a participant from watch: the orchestrator closed the session, and the warden
// has nowhere to learn that — without the mark it would report GONE about a closed one.
// The mark lives on the participant record in the journal: if a process held it, its death
// would bring the reports back. Returns `{ found, was }`: "no such participant" and "the
// mark was already there" are two different answers.
function setDismissed(home, id, address, at) {
  return withTaskLock(home, id, () => {
    const meta = readTask(home, id);
    const p = participantOf(meta, address);
    if (!p) return { found: false, was: null };
    const was = p.metadata.dismissed ?? null;
    // The state is already what they asked for — leave the journal alone: a repeat
    // dismiss does not rewrite the dismiss time, and a return to watch does not write the
    // journal for someone who was not dismissed — the most common case on a re-review, and
    // it would cost a task lock.
    if (Boolean(was) === Boolean(at)) return { found: true, was };
    // Return is DELETION of the field, not `null` in it: every journal reader would have
    // to tell `dismissed: null` from a dismiss, and the field is checked for truthiness.
    const { dismissed, ...rest } = p.metadata;
    gate(() => engine(home).patchParticipant(id, p.id, {
      metadata: at ? { ...rest, dismissed: at } : rest,
    }));
    taskCache?.clear();
    return { found: true, was };
  });
}

export function dismissParticipant(home, id, address, at = new Date().toISOString()) {
  return setDismissed(home, id, address, at);
}

// Return to watch — where the participant is given new work. A fresh lift clears the
// mark itself (the record is written in full); a re-review of a live session uses this
// call.
export function watchParticipant(home, id, address) {
  return setDismissed(home, id, address, null);
}

/**
 * Record on the reviewer which snapshot it is holding: the moment the diff file was
 * written, the worktree HEAD it was taken from, and whether its tracked tree was clean
 * with the paths that differed when it was not. Together they answer how far behind
 * the file is and whether its contents matched HEAD for `promptobus status` and
 * `promptobus_task`, without opening the file and without asking the reviewer.
 *
 * A patch and not `upsertParticipant`, because it is called where the record must NOT be
 * replaced: a re-review only sends a message to a live session, and putting the record
 * in full there would take the session id and the capabilities snapshot with it. A fresh
 * lift writes the same fields itself, in the record it lays.
 *
 * `head` is absent on a repository with no commits; then the former one is REMOVED
 * rather than kept — a stale sha beside a fresh time reads as a snapshot from a commit
 * this diff was never taken from. The path list is always replaced too: otherwise a
 * clean re-review would keep reporting the prior dirty paths.
 */
export function stampSnapshot(home, id, address, { at, head = null, clean, modifiedTracked }) {
  return withTaskLock(home, id, () => {
    const meta = readTask(home, id);
    const p = participantOf(meta, address);
    if (!p) return { found: false };
    const { diffHead, diffClean, diffModifiedTracked, ...rest } = p.metadata;
    gate(() => engine(home).patchParticipant(id, p.id, {
      metadata: {
        ...rest,
        diffAt: at,
        ...(head ? { diffHead: head } : {}),
        diffClean: clean,
        diffModifiedTracked: modifiedTracked,
      },
    }));
    taskCache?.clear();
    return { found: true };
  });
}

/** Causal reviewer-assignment watermark — set from the sent task message; null clears until send. */
export function stampReviewAssignment(home, id, address, at) {
  return withTaskLock(home, id, () => {
    const meta = readTask(home, id);
    const p = participantOf(meta, address);
    if (!p) return { found: false };
    gate(() => engine(home).patchParticipant(id, p.id, {
      metadata: { ...p.metadata, reviewAssignedAt: at ?? null },
    }));
    taskCache?.clear();
    return { found: true };
  });
}

// Task title from the titles of its tracks: otherwise a run of three tracks would read as
// the work of one. Computed from the WHOLE journal and called AFTER the participant is
// written — two spawns from one pre-image would give "A · B" and "A · C", and the winner
// would lose the foreign track. An empty list is not a reason to rename: a former-CLI
// task has no `title` field.
export function titleFromLines(meta, registry = SHIPPED_REGISTRY) {
  const owner = registry.entries.find((entry) => entry.kind === EDITS_TREE
    && (!registry.activeSteps || registry.activeSteps.includes(entry.name)));
  const lines = [...new Set((meta?.participants ?? [])
    .filter((p) => String(addressOf(p) ?? '').startsWith(`${owner?.name}:`) && p.metadata?.title)
    .map((p) => p.metadata.title))];
  return lines.length ? lines.join(TASK_TITLE_SEP) : null;
}

// The task title is written after the fact: grafting a new track appends to it, and
// `--task-title` pins it for good (`titleExplicit`). There is one door — restamping:
// `restamp` sets the plan on double explicitness (`--task-title` plus an explicit
// `--task`), and the right is checked here with the same `ownership` as the rest of the
// bus — under the lock, not in the plan: the mailbox may have changed owner after the
// plan was built.
export function retitleTask(home, id, {
  title = null, fromLines = false, explicit = false, restamp = false, session = null,
} = {}, registry = SHIPPED_REGISTRY) {
  return withTaskLock(home, id, () => {
    const meta = readTask(home, id);
    if (meta.adapter.titleExplicit && !(restamp && !ownership(home, id, ORCHESTRATOR, session).gated)) return null;
    // `fromLines` is computed HERE and only here: the `--dry-run` prediction lives in a
    // separate intent field (`preview`) that this function does not read.
    const next = fromLines ? titleFromLines(meta, registry) : title;
    if (!next || next === meta.title) {
      // The mark is set even when the title is already that: otherwise a title a human
      // named explicitly would stay unprotected from the next graft.
      if (explicit) patchTask(home, id, { adapter: { titleExplicit: true } });
      return null;
    }
    patchTask(home, id, { title: next, ...(explicit ? { adapter: { titleExplicit: true } } : {}) });
    return next;
  });
}

// --- mailbox ownership and claim --------------------------------------------------

// Owner of the `orchestrator` address — the session that created the task: `promptobus spawn`
// and `promptobus review` are launched by Bash from it and inherit its identity.
export function taskOwner(home, id) {
  return ownerOf(participantOf(readTask(home, id), ORCHESTRATOR));
}

/**
 * Two answers about the `orchestrator` mailbox, and they are not each other's negation:
 * `allowed` is the right, `gated` the narrower "proved foreign" — 03-cli § The owner gate.
 */
export function ownership(home, id, addr, session) {
  // Not the address this gate judges. No right is proven here, so none is granted.
  if (addr !== ORCHESTRATOR) return { gated: false, allowed: false, right: 'other-address', owner: null, session };
  const owner = taskOwner(home, id);
  if (!session) return { gated: false, allowed: false, right: 'no-identity', owner, session };
  // A task whose owner was never recorded belongs to nobody, and the exception is named:
  // a session that names itself may act on it, because no one can prove more than that.
  if (!owner) return { gated: false, allowed: true, right: 'ownerless', owner, session };
  const mine = owner === session;
  return { gated: !mine, allowed: mine, right: mine ? 'owner' : 'foreign', owner, session };
}

// Active tasks whose `orchestrator` mailbox this session PROVABLY owns. One binding stays,
// so a task lifted from a bound session is visible only through this walk — 03-cli § Guard and warden.
export function orchestratedTasks(home, session = sessionIdentity()) {
  if (!session) return [];
  return activeTasks(home).filter((meta) => ownership(home, meta.id, ORCHESTRATOR, session).right === 'owner');
}

// Why this call names no session. The mailbox tool prints the same sentence the refusal
// does — 03-cli § The owner gate — so the two cannot grow a second wording.
function identitySaid(home, meta, own) {
  if (own.right !== 'no-identity') return null;
  return sessionIdentityReport(process.env, { home, task: meta.id, address: ORCHESTRATOR });
}

// An answer this gate never gave carries `owner: null` because nobody looked, so nothing
// true is printable from it — 03-cli § The owner gate.
function requireOwnerGateAnswer(own) {
  if (own.right !== 'other-address') return;
  throw new Error('unprovenOwnerLine and ownerRoute serve the owner gate only: `ownership` was asked about an '
    + 'address other than `orchestrator`, and its `owner` is null because the gate never looked it up');
}

/**
 * Head of a refusal from the owner gate: what the call could NOT prove, by `right`
 * — 03-cli § The owner gate.
 */
export function unprovenOwnerLine(home, meta, own) {
  requireOwnerGateAnswer(own);
  if (own.right === 'foreign') return foreignTaskLine(meta, own);
  const whose = own.owner ? `is bound to session ${own.owner}` : 'records no mailbox owner';
  const said = identitySaid(home, meta, own);
  if (contestedIdentity(said)) {
    return `task ${meta.id} («${meta.title}») ${whose}, and this call cannot name its own session — ${said.why}`;
  }
  return `task ${meta.id} («${meta.title}») ${whose}`
    + ', and this call carries no session identity — the right here is proven, never assumed';
}

/**
 * Where to go after that refusal, and every branch must be walkable by whoever gets it
 * — 03-cli § The owner gate.
 */
export function ownerRoute(home, meta, own, repeat) {
  requireOwnerGateAnswer(own);
  if (own.right === 'foreign') return claimRoute(repeat);
  const said = identitySaid(home, meta, own);
  if (contestedIdentity(said)) {
    return `Clear the environment down to one identity variable and repeat ${repeat}: `
      + 'the extra one is what to remove, and there is nothing missing here to add.';
  }
  if (!own.owner) {
    return `Run ${repeat} from any session that names itself: this task records no owner, and naming `
      + 'yourself is the whole of what can be proven about it.';
  }
  return `Run ${repeat} from the session that owns the task: a harness names its session itself, `
    + 'and a shell that names none proves nothing about whose run this is.';
}

/** The owner-gate line, the shared copy sentence, and `ownerRoute`. `null` for every
 * other `right`: those words belong to the refusal, and a second wording would drift. */
export function noIdentityMailboxLine(home, id, own) {
  if (own?.right !== 'no-identity') return null;
  const meta = readTask(home, id);
  return `${unprovenOwnerLine(home, meta, own)}\n${MAILBOX_COPY}\n${ownerRoute(home, meta, own, 'the promptobus_mailbox tool')}`;
}

/** An approver of THIS task holding the calling session, proven by the participant record's own
 * session — the one home of the proof `sweep`, `dismiss` and `stop` share. */
export function approverHere(meta, session) {
  if (!session) return null;
  // Keyed on the shipped step names, not on step kinds: 04-protocol § The role registry.
  return (meta?.participants ?? []).find((p) => p.role === APPROVER
    && (sessionIdOf(p) ?? sessionOf(p))
    && !foreignSessionOf(p, session)) ?? null;
}

/** Why the approver route did not open either, said only where an approver record exists: a
 * record with no session of its own, or a session that is not the one recorded. */
export function unprovenApproverLine(meta, session) {
  // Keyed on the shipped step names, not on step kinds: 04-protocol § The role registry.
  const approvers = (meta?.participants ?? []).filter((p) => p.role === APPROVER);
  if (!session || !approvers.length || approverHere(meta, session)) return null;
  // Per RECORD, not per task: one sentence about "the approvers" of a mixed set tells a
  // session-less record somebody else's id, and agrees with neither half of it.
  const said = approvers.map((p) => {
    const held = sessionIdOf(p) ?? sessionOf(p);
    return `${addressOf(p) ?? p.id} ${held ? `is on record under ${held}` : 'carries no session of its own'}`;
  });
  return `The approver route is not this call either — this call is ${session}: ${said.join('; ')}. `
    + 'An approver is proven by the session on its own record.';
}

/**
 * Whether these are the same `orchestrator` mailbox owner id. Both sides are full
 * (`CLAUDE_CODE_SESSION_ID`): `registerWake` and the `owner` field store the same thing.
 * A `sameSession` prefix here is fail-open — a short id would match a foreign full one
 * that shares the first eight hex digits, and would mute the successor hint and the
 * status line.
 */
export function sameOwnerSession(a, b) {
  const x = typeof a === 'string' ? a.trim() : '';
  const y = typeof b === 'string' ? b.trim() : '';
  return Boolean(x && y && x === y);
}

/**
 * Is a FOREIGN session writing for this participant address? Returns the journal session
 * the address is bound to, or `null` — it is this session writing, or there is nothing
 * to check against.
 *
 * The gate is needed because a harness background session is given an environment that is
 * not the one it was started with: measurement 2026-09-03 on `claude` 2.1.251 — the
 * `PROMPTOBUS_*` triple reaches the session from the process that started the daemon, that
 * is from the FIRST spawn of the run. This task took the hook identity into the arguments
 * of its command, and the gate remains a second line: it holds both what is called by
 * hand and a participant started by a former release.
 *
 * The check rule itself lives in the core (`foreignSessionOf`), one home for every gate
 * door. What remains here is what the core must not know: reading the workspace journal,
 * and that ownership of the `orchestrator` address is not the concern of this gate — that
 * has its own (`ownership` above); no driver started that session.
 */
export function foreignSession(home, id, addr, session) {
  if (!session || addr === ORCHESTRATOR) return null;
  try {
    return foreignSessionOf(participantOf(readTask(home, id), addr), session);
  } catch {
    // No journal, or it is unreadable — the gate has nothing to judge by, and silence is
    // more honest than a refusal.
    return null;
  }
}

/** The address a caller sends as in task `id`: the record this session PROVABLY holds; a declared
 * role picks among held records anywhere and binds only on its declared task — 04-protocol § Addresses. */
export function senderFor(home, id, { session = null, why = null, hint = null, declaredTask = null } = {}) {
  const meta = readTask(home, id);
  if (!session) {
    throw new GateError(`this process cannot name its own session${why ? ` — ${why}` : ''}, so no address `
      + `it claims in task ${id} can be checked, and none is given to it`);
  }
  const held = (meta.participants ?? []).filter((p) => holdsSession(p, session)).map(addressOf).filter(Boolean);
  if (hint && held.includes(hint)) return hint;
  const said = hint && (!declaredTask || declaredTask === id) ? hint : null;
  if (!said && held.length === 1) return held[0];
  if (!said && held.length > 1) {
    throw new GateError(`session ${session} holds ${held.join(' and ')} in task ${id} — `
      + 'name the one it sends as with PROMPTOBUS_ROLE');
  }
  throw new GateError(unheldLine(meta, said ?? hint, Boolean(said), session, held));
}

// Why no address was proven: by the declared one when it names a record here, else by the owner.
function unheldLine(meta, named, inScope, session, held) {
  const holds = held.length ? `; this session holds ${held.join(', ')} there` : '';
  const p = named && named !== ORCHESTRATOR ? participantOf(meta, named) : null;
  const bound = boundSessionOf(p);
  if (inScope && named !== ORCHESTRATOR && !p) {
    return `PROMPTOBUS_ROLE names «${named}», which is not a participant of task ${meta.id} — `
      + `a declared role is a hint checked against the task, and this one matches no record${holds}`;
  }
  if (inScope && p && !bound) {
    return `«${named}» of task ${meta.id} carries no session binding — its record is legal to read and illegal to `
      + 'send as. A lift still in progress binds it on return: send again after the next turn; a lift that has '
      + `returned without binding it must be repeated${holds}`;
  }
  if (bound) {
    return `PROMPTOBUS_ROLE names «${named}», but that record of task ${meta.id} is held by session ${bound}, `
      + `and this one is ${session}${holds} — writing as it would borrow that address`;
  }
  const owner = ownerOf(participantOf(meta, ORCHESTRATOR));
  const said = inScope ? named : null;
  if (!owner) {
    return `task ${meta.id} records no owner, so nothing can prove this process is its ${ORCHESTRATOR}`
      + `${said ? '' : `, and no participant of it is bound to session ${session}`}: a task records its owner `
      + 'when a session that names itself opens it, and a task with no owner has no claim route';
  }
  const head = said ? `task ${meta.id} belongs to session ${owner}, and this one is ${session}${holds}`
    : `no participant of task ${meta.id} is bound to session ${session}, and the task belongs to session ${owner}`;
  return `${head} — writing as ${ORCHESTRATOR} would borrow that address`;
}

// Claim of the mailbox by a successor session. Returns the former owner: there is one
// `owner` field and no history. A claim is also a rebind: the owner also declares their
// current task.
export function claimOwnership(home, id, owner) {
  const previous = withTaskLock(home, id, () => {
    const meta = readTask(home, id);
    const p = participantOf(meta, ORCHESTRATOR);
    const was = ownerOf(p);
    const version = writerVersion(home, `claiming task ${id} orchestrator participant`);
    if (p) {
      gate(() => engine(home).patchParticipant(id, p.id, {
        metadata: {
          ...p.metadata,
          owner,
          ...(version ? { [MECHANISM_VERSION_FIELD]: version } : {}),
        },
      }));
    } else {
      gate(() => engine(home).putParticipant(id, participantRecord(ORCHESTRATOR, {
        owner,
        ...(version ? { [MECHANISM_VERSION_FIELD]: version } : {}),
      })));
    }
    taskCache?.clear();
    return was;
  });
  bindSession(home, id, owner);
  return previous;
}

// --- "session → task" bindings ----------------------------------------------------

// Only an ACTIVE task is bound: `liveBinding` will never return a closed one. Claiming the
// mailbox of a closed task is still legal — nobody forbade reading its mail.
export function bindSession(home, id, session = sessionIdentity()) {
  const file = sessionFile(home, session);
  if (!file || !taskExists(home, id) || readTask(home, id).status !== 'active') return null;
  const address = addressIn(home, id, session);
  return writeBinding(home, {
    session,
    task: id,
    since: new Date().toISOString(),
    ...(address ? { address, role: roleOf(address) } : {}),
  });
}

// Address this session is listed under. Today it is written only for the task owner —
// a participant gets identity through the env of their mcp-config, not through the
// binding. The field is optional: when a source appears, the binding will carry it
// without a second migration.
function addressIn(home, id, session) {
  try {
    return taskOwner(home, id) === session ? ORCHESTRATOR : null;
  } catch {
    return null;
  }
}

// Binding of this session, or `null`. Read by LIVENESS, not by file presence: a session
// that kept working after `promptobus done` must fall back to the spare path again. The
// mark and the journal share one `try`: a truncated journal would have crashed
// `resolveTaskId`.
export function liveBinding(home, session = sessionIdentity()) {
  try {
    const mark = readBinding(home, session);
    if (!taskExists(home, mark?.task)) return null;
    return readTask(home, mark.task).status === 'active' ? mark : null;
  } catch {
    return null;
  }
}

export function boundTaskId(home, session = sessionIdentity()) {
  return liveBinding(home, session)?.task ?? null;
}

// Bind the session to the task it owns. Spawn and review call this, not `bindSession`:
// a session that entered a foreign run with an explicit `--task` would send argument-less
// calls into the foreign journal.
export function bindIfOwner(home, id, session = sessionIdentity()) {
  if (!session || taskOwner(home, id) !== session) return null;
  return bindSession(home, id, session);
}

// Sweep of bindings that have lost liveness: the mechanism does not need it, the
// directory does.
export function sweepBindings(home) {
  let dropped = 0;
  for (const session of bindingNames(home)) {
    if (liveBinding(home, session)) continue;
    dropBinding(home, session);
    dropped += 1;
  }
  return dropped;
}

// --- messages ---------------------------------------------------------------------

/** The name a sent file lands under, at number `n`; leading dots are dropped.
 * [reference/04-protocol.md#artifacts](../docs/reference/04-protocol.md#artifacts) */
export function landedName(source, n = 1) {
  const bare = path.basename(source).replace(/^\.+/, '');
  if (!bare) {
    throw new GateError(`artifact «${path.basename(source)}» has no name left once leading dots are dropped, `
      + 'and a name made of dots alone cannot land visibly. Send it under a name that starts with a character');
  }
  const ext = path.extname(bare);
  return numberedName(path.basename(bare, ext), ext, n);
}

/**
 * Artifact name in the task files folder. The link itself occupies it: `linkBlob` refuses
 * on a taken name instead of a silent overwrite — the same atomicity the former store
 * held with `COPYFILE_EXCL`. A link, not a copy: content lives in the blob and is
 * deduplicated.
 */
function placeFile(home, id, source, sha256) {
  const dir = filesDir(home, id);
  for (let i = 1; ; i += 1) {
    const name = landedName(source, i);
    if (engine(home).linkBlob(id, sha256, path.join(dir, name))) return name;
  }
}

/**
 * The numbering of the task files folder — one home for it. The first file of a stem
 * carries no number, every next one takes the following: `review-store.diff`,
 * `review-store-2.diff`. Both kinds of file live by it — an artifact that arrived
 * through the bus (`placeFile`) and one the mechanism put there itself
 * (`occupyTaskFile`), and both the write and the PREDICTION of a name are spelled here.
 */
export function numberedName(stem, ext, n) {
  return n > 1 ? `${stem}-${n}${ext}` : `${stem}${ext}`;
}

let messageReadHook = null;
let bodyReadPurpose = null;

export function withMessageReadHook(hook, work) {
  const previous = messageReadHook;
  messageReadHook = hook;
  try { return work(); } finally { messageReadHook = previous; }
}

function readCanonical(file) {
  const record = JSON.parse(readFileSync(file, 'utf8'));
  if (!messageReadHook) return record;
  const hook = messageReadHook;
  return new Proxy(record, {
    get(target, property, receiver) {
      if (property === 'body') hook({ file, type: target.type, purpose: bodyReadPurpose });
      return Reflect.get(target, property, receiver);
    },
  });
}

function messageBody(record, purpose) {
  const previous = bodyReadPurpose;
  bodyReadPurpose = purpose;
  try { return record.body; } finally { bodyReadPurpose = previous; }
}

function firstStatusLine(record) {
  const body = String(messageBody(record, 'firstLine') ?? '');
  let start = 0;
  for (;;) {
    const end = body.indexOf('\n', start);
    const line = body.slice(start, end < 0 ? undefined : end).trim();
    if (line || end < 0) return line;
    start = end + 1;
  }
}

function messageHeader(record, { statusLine = false } = {}) {
  const head = {
    id: record.id, task: record.task, ts: record.ts, type: record.type, sender: record.sender,
    ...(record.originTask ? { originTask: record.originTask } : {}),
    recipients: record.recipients, ...(record.artifact ? { artifact: record.artifact } : {}),
  };
  if (statusLine && record.type === 'status') head.firstLine = firstStatusLine(record);
  return head;
}

function taskMessages(home, id) {
  const dir = messagesDir(home, id);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      out.push(readCanonical(path.join(dir, name)));
    } catch {
      continue;
    }
  }
  return out;
}

export function taskMessageHeaders(home, id, options = {}) {
  return taskMessages(home, id).map((record) => messageHeader(record, options));
}

export function historyHeaders(home, id, addr) {
  const dir = historyDir(home, id, addr);
  if (!existsSync(dir)) return [];
  const headers = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try { headers.push(messageHeader(readCanonical(path.join(dir, name)))); } catch { /* unreadable ref */ }
  }
  return headers.sort(bySendOrder);
}

export function journalMessageBody(home, id, messageId, purpose) {
  if (!RECORD_ID_RE.test(messageId)) throw new GateError(`invalid message id ${messageId}`);
  const record = readCanonical(path.join(messagesDir(home, id), `${messageId}.json`));
  if (record.type === 'status') throw new GateError('the full body of a status is not a digest field');
  return messageBody(record, purpose);
}

// Send order by the same comparison the core sorts records with: `localeCompare` depends on the
// locale, and a message id is machine-made.
function bySendOrder(a, b) {
  if (a.id < b.id) return -1;
  return a.id > b.id ? 1 : 0;
}

/** Files one address attached to the task, in send order, and the records that could not be read.
 * [reference/04-protocol.md#artifacts](../docs/reference/04-protocol.md#artifacts) */
export function attachmentsOf(home, id, participantId) {
  const { artifacts, broken } = listArtifacts(home, id);
  const named = new Map(artifacts.map((a) => [a.id, a.filename]));
  // The live note reaches the FIRST reader only: `readArtifact` moves a corrupt record into
  // `broken/artifacts` before it throws, and from the second read the attic is the only witness.
  const noted = new Map(broken.map((n) => [String(n).split(':')[0].replace(/\.json$/, ''), String(n)]));
  const attic = brokenArtifactsDir(home, id);
  const mine = taskMessages(home, id)
    .filter((m) => m?.type === 'artifact' && m.sender === participantId)
    .sort(bySendOrder);
  // The id comes from the journal, read as raw JSON, and it is about to become a PATH: the
  // grammar is checked for the reason `safeRecord` names — `..` in it would leave the task.
  const atticFile = (artifact) => (RECORD_ID_RE.test(String(artifact))
    ? path.join(attic, `${artifact}.json`) : null);
  // Counted from the journal, and scoped to this sender by it: another address's unreadable
  // record is not a gap in THIS list, and a gap with no record anywhere is a swept piece.
  const gapNote = (m) => {
    const live = noted.get(m.artifact);
    if (live) return live;
    const aside = atticFile(m.artifact);
    return aside && existsSync(aside) ? `${m.artifact}.json: set aside in ${attic}` : null;
  };
  return {
    files: mine.filter((m) => named.has(m.artifact))
      .map((m) => ({ filename: named.get(m.artifact), at: m.ts })),
    broken: mine.filter((m) => !named.has(m.artifact)).map(gapNote).filter(Boolean),
  };
}

function outboundMessages(home, id, senderId, sinceMs = 0) {
  return taskMessageHeaders(home, id).filter((msg) => {
    if (msg?.sender !== senderId) return false;
    const at = Date.parse(msg.ts);
    if (sinceMs && Number.isFinite(at) && at <= sinceMs) return false;
    return true;
  });
}

function validateResultHandoff(home, id, from, body) {
  const artifacts = engine(home).listArtifacts(id).artifacts;
  const byName = new Map(artifacts.map((a) => [a.filename, a]));
  const claims = artifactClaimsInResult(body, artifacts.map((a) => a.filename));
  if (!claims.length) return null;
  const senderId = addrDir(from);
  const allMessages = taskMessages(home, id);
  const ownMessages = allMessages.filter((msg) => msg?.sender === senderId);
  let linkId = null;
  for (const filename of claims) {
    const meta = byName.get(filename);
    if (!allMessages.some((m) => m?.type === 'artifact' && m.artifact === meta.id)) {
      throw new GateError(`result claims artifact «${filename}» with no artifact message from any sender`);
    }
    if (!linkId) {
      const ownArtMsg = ownMessages.find((m) => m.type === 'artifact' && m.artifact === meta.id);
      if (ownArtMsg) linkId = meta.id;
    }
  }
  return linkId;
}

export { outboundMessages };

/**
 * A file the MECHANISM writes into the task files folder: the `review` diff and the
 * `spawn` brief. The name is occupied by the write itself — between a check for a free
 * name and the write a second command with the same stem would slip in, and an already
 * placed file must not be overwritten: the reviewer may still be reading the previous
 * diff, and the previous brief is the history of assignments of that address. The `wx`
 * flag refuses on an existing file — a signal to take the next number. Returns the path
 * that LANDED on disk.
 */
export function occupyTaskFile(dir, stem, ext, content) {
  mkdirSync(dir, { recursive: true });
  for (let n = 1; ; n += 1) {
    const at = path.join(dir, numberedName(stem, ext, n));
    try {
      writeFileSync(at, content, { flag: 'wx' });
      return at;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

function acceptanceRoute(sender, recipient, registry) {
  const names = registry.activeSteps ?? registry.entries.filter((entry) => entry.layer === 'step').map((entry) => entry.name);
  const owner = names.find((name) => roleEntry(registry, name)?.kind === EDITS_TREE);
  const writer = names.find((name) => roleEntry(registry, name)?.kind === WRITES_MAIN_TREE);
  return !!owner && !!writer && ((sender.role === owner && recipient.role === writer)
    || (sender.role === writer && recipient.role === owner));
}

function directParticipantRoute(sender, recipient, registry) {
  return acceptanceRoute(sender, recipient, registry)
    || (sender.role === GOVERNANCE.teamlead && recipient.role === GOVERNANCE.teamlead)
    || (sender.role === GOVERNANCE.peer && recipient.role === ORCHESTRATOR);
}

function requireDirectSender(home, meta, sender, session) {
  const address = addressOf(sender);
  if (!session) {
    // Two variables are not zero variables: the repair is to remove the extra one, and a
    // refusal that asks for a missing one sends the reader looking the wrong way.
    const said = sessionIdentityReport(process.env, { home, task: meta.id, address });
    if (contestedIdentity(said)) {
      throw new GateError(`task ${meta.id} direct participant traffic cannot prove participant "${address}": `
        + `${said.why}`);
    }
    throw new GateError(`task ${meta.id} direct participant traffic cannot prove participant "${address}": `
      + 'the calling harness supplied no session identity');
  }
  const holder = boundSessionOf(sender);
  if (!holder) {
    throw new GateError(`task ${meta.id} direct participant traffic cannot prove participant "${address}": `
      + 'its task record has no session');
  }
  if (!holdsSession(sender, session)) {
    throw new GateError(`task ${meta.id} participant "${address}" is held by session ${holder}, and this one is ${session} — `
      + 'direct participant traffic cannot borrow an address');
  }
}

/**
 * Send a message. Sender and recipient are ADDRESSES: that is how bus tools and a human
 * talk, and the participant id stays inside the store. Returns the v1 outcome: the canon
 * and the artifact metadata, if there was one.
 */
export function sendMessage(home, id, {
  from, to, type, body, artifactPath, session = null,
}, hints) {
  if (!isAddress(from)) throw new Error(`unknown sender address "${from}"`);
  if (!isAddress(to)) throw new Error(`unknown recipient address "${to}" — ${addressList(hints?.registry ?? SHIPPED_REGISTRY)}`);
  if (!MESSAGE_TYPES.includes(type)) {
    throw new Error(`type "${type}" is not from protocol v1: ${MESSAGE_TYPES.join(', ')}`);
  }
  if (typeof body !== 'string' || !body.trim()) throw new Error('body is empty — a message with no text is not sent');
  // A GateError, not a bare one: it is addressed to the caller, and both callers are — the
  // `promptobus_send` tool and the `send` command (03-cli.md § Send).
  if (type === 'artifact' && !artifactPath) {
    throw new GateError('type "artifact" with no artifactPath — an artifact message always carries a file. '
      + 'Name the file in artifactPath, or send the text under another type');
  }
  // The addressee must be listed as a task participant: a typo in the slug would pass
  // the grammar, and send would return success. There is no legal send to an unregistered
  // address — spawn writes the participant BEFORE start. The refusal words are our own:
  // v1 uses a participant id in them, and humans and the mechanism speak in addresses.
  const meta = readTask(home, id);
  const known = addressesOf(meta);
  if (!known.includes(to)) {
    throw new Error(`task ${id} has no participant "${to}" — nobody can fetch the message, `
      + `and a mailbox opened for them will be seen by neither ${hints.status} nor task. Task participants: ${known.join(', ')}`);
  }
  const recipient = participantOf(meta, to);
  const sender = participantOf(meta, from);
  // Only a registered address sends: the doors resolve it from a record the session holds,
  // and a task names its participants by lift, never by a first message.
  if (!sender) {
    throw new GateError(`task ${id} has no sender participant "${from}" — a message is sent only from an `
      + 'address registered in this task');
  }
  if (from === ORCHESTRATOR && recipient.role === GOVERNANCE.peer) {
    const decision = routingPolicy(home, sender, recipient, meta, type);
    if (decision.deny) throw new GateError(decision.reason);
    if (!session || !holdsSession(sender, session)) {
      throw new GateError(`task ${id} peer send needs its recorded orchestrator owner session`);
    }
    const remoteTask = recipient.metadata.peerTask;
    const remoteFrom = `peer:${meta.adapter.slug}`;
    const sent = sendMessage(home, remoteTask, {
      from: remoteFrom, to: ORCHESTRATOR, type, body, artifactPath, session,
    }, hints);
    return { ...sent, deliveredTask: remoteTask };
  }
  const linkArtifact = type === 'result' ? validateResultHandoff(home, id, from, body) : null;
  const routeRegistry = hints?.registry ?? SHIPPED_REGISTRY;
  if (directParticipantRoute(sender, recipient, routeRegistry)) {
    requireDirectSender(home, meta, sender, session);
  }
  // Both artifact refusals stand BEFORE the blob is written: neither a name that cannot
  // land visibly nor a rejected record may leave payload in the task.
  if (artifactPath) {
    const refusal = recordRefusal(landedName(artifactPath), artifactPath, hints?.registry ?? SHIPPED_REGISTRY);
    if (refusal) {
      throw new GateError(`task ${id}: ${refusal}. Fix the record and send it again — a document `
        + 'this door refuses is read as evidence until someone reads it by hand');
    }
  }
  routeRegistries.set(home, routeRegistry);
  const sent = gate(() => engine(home).sendSync(id, {
    from: addrDir(from),
    to: [addrDir(to)],
    type,
    body,
    ...(sender.role === GOVERNANCE.peer ? { originTask: sender.metadata.peerTask } : {}),
    ...(artifactPath ? { artifact: { path: artifactPath, name: (sha) => placeFile(home, id, artifactPath, sha) } } : {}),
    ...(linkArtifact ? { linkArtifact } : {}),
  }));
  taskCache?.clear();
  return { message: sent.message, artifact: sent.artifact, sameContent: sameContentAs(home, id, sent.artifact) };
}

/** The file that already holds these bytes and how many names the payload has, or `null`.
 * [reference/04-protocol.md#artifacts](../docs/reference/04-protocol.md#artifacts) */
function sameContentAs(home, id, artifact) {
  if (!artifact) return null;
  const twins = engine(home).listArtifacts(id).artifacts
    .filter((a) => a.sha256 === artifact.sha256 && a.id !== artifact.id);
  if (!twins.length) return null;
  let names = 0;
  try {
    names = statSync(path.join(blobsDir(home, id), artifact.sha256)).nlink - 1;
  } catch {
    // No link count to report: the name of the twin is the fact, the count is the extra.
  }
  return { filename: twins[0].filename, names };
}

/** Fetch incoming mail: what was read moves to history. */
export function readInbox(home, id, addr) {
  const { messages, broken } = gate(() => engine(home).read(id, addrDir(addr)));
  return { messages, broken: brokenLines(broken) };
}

/** Read without fetching: needed by a foreign session — `mailbox` gives them a copy. */
export function peekInbox(home, id, addr) {
  const { messages, broken } = gate(() => engine(home).peek(id, addrDir(addr)));
  return { messages, broken: brokenLines(broken) };
}

/**
 * Glance into the mailbox without touching anything in it — needed by the warden.
 * Difference from `peekInbox`: that one sets unreadable mail aside in `broken/` and names
 * it out loud, while warden diagnostics go to `stdio: 'ignore'` — set-aside mail would
 * vanish without a word to anyone.
 */
export function glanceInbox(home, id, addr) {
  try {
    return engine(home).glance(id, addrDir(addr));
  } catch {
    return [];
  }
}

// Broken-mail report — two channels: diagnostics to a human, a list to the agent (on the
// MCP path stderr is read by the harness, not the session, and without the list the
// message would vanish silently). The words are the same as the former store knew them:
// tool replies and the suite quote them.
//
// The string is assembled FROM FIELDS, not sliced by regex from a ready-made one: reason
// and place arrive from v1 separately, and a join would force parsing it back — the two
// report channels would drift on the first wording change.
function brokenLines(notes) {
  return notes.map(({ name, note, attic, failure }) => {
    const where = failure ? ` and not set aside (${failure}) — skipped`
      : (attic ? ` — set aside in ${attic}, mailbox continues` : ' — left in place');
    const said = `BROKEN MESSAGE ${name}: ${note}${where}`;
    warn(said);
    return said;
  });
}

export function countInbox(home, id, addr) {
  return engine(home).unread(id, addrDir(addr));
}

// When the address last SENT on the bus; `null` — has not sent anything yet.
export function lastSentAt(home, id, addr) {
  const sender = addrDir(addr);
  let last = null;
  for (const message of taskMessageHeaders(home, id)) {
    if (message.sender !== sender) continue;
    const at = Date.parse(message.ts);
    if (Number.isFinite(at) && (last === null || at > last)) last = at;
  }
  return last;
}

// Accumulated unread mail does not speak for itself: notification is best-effort, if it
// did not arrive the message sits there while the session thinks nobody wrote. The
// counter rides as a tail on replies where the session does not fetch the mailbox
// (`send`, `task`, `promptobus review` output); zero is not named. To a foreign mailbox
// the line says something else: the originals will not be given to them.
export function unreadNote(home, id, addr, session = null) {
  const n = countInbox(home, id, addr);
  if (!n) return null;
  const own = ownership(home, id, addr, session);
  if (own.right === 'no-identity') {
    const meta = readTask(home, id);
    return `unread ${n} at the orchestrator: ${unprovenOwnerLine(home, meta, own)}. `
      + 'promptobus_mailbox from this call hands a copy; the originals stay in the mailbox. '
      + `${ownerRoute(home, meta, own, 'the promptobus_mailbox tool')}`;
  }
  if (!own.gated) return `your mailbox: unread ${n} — fetch it with the promptobus_mailbox tool`;
  return `${FOREIGN_MARK}: unread ${n} at the orchestrator of this task, but the mailbox is bound to session `
    + `${own.owner}, this one is ${own.session}. ${FOREIGN_ROUTE}`;
}

/**
 * Task history: a page of entries from old to new, last 50 by default.
 *
 * The unit is an ENTRY, not a message: one message sitting with two participants gives
 * two entries. There is no unread here at all — it lives in the mailbox, and reading
 * history does not touch it.
 */
export function history(home, query = {}) {
  return gate(() => engine(home).history(query));
}

// The mechanism names an artifact in a message by FILE NAME — tool replies, the warden
// notification and the `promptobus history` journal print it, and a human finds the file
// in the task folder by it. In v1 the message carries the metadata-record id, so the name
// is read from that. Messages without an artifact are not worth a metadata read at all.
export function nameOfArtifact(home, task, id) {
  try {
    return engine(home).readArtifact(task, id).filename;
  } catch {
    return undefined;
  }
}

// --- MCP-layer service ---------------------------------------------------------------

// Catalogue of operations the bus tools use. The adapter assembles it, not the package:
// half the catalogue rests on session identity — mailbox ownership, binding, resolve of
// the active task, and the reply header
// ([mcp/service.ts](../src/mcp/service.ts)).
export const busService = {
  artifactsDir: filesDir,
  artifactName: nameOfArtifact,
  bindSession,
  brokenNote,
  claimOwnership,
  countInbox,
  identityLabel,
  noIdentityMailboxLine,
  ownership,
  peekInbox,
  readInbox,
  readTask,
  listTasks,
  resolveTaskId,
  send: sendMessage,
  senderFor,
  unreadNote,
  withTaskCache,
};

// Atomic JSON writes stay available to lib/ callers without widening the package entry.
export { writeJsonAtomic };

// --- process identity ---------------------------------------------------

// Who this process is on the bus. Worker and reviewer get identity through the env of
// their mcp-config; the orchestrator canonical server gets PROMPTOBUS_HOME at sync.
// Finding home from cwd is the fallback for a manual start and an old config. The path is
// brought to physical form even when the last directory does not exist yet: on Darwin
// /var and /private/var lead to the same place, and without a shared canonicalisation the
// command and the MCP server would print different identities.
// This identity fallback deliberately differs from codex-session.js's containmentPath:
// it uses existsSync and returns abs when resolution fails, while that approval helper
// follows links with lstat/readlink and returns null so an unresolved target is denied.
export function canonicalPath(value) {
  const abs = path.resolve(value);
  let existing = abs;
  const tail = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return abs;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return path.join(realpathSync(existing), ...tail);
  } catch {
    return abs;
  }
}

// There is no binding here on purpose: the function is called once per process, and the
// binding changes under it (`claim` rebinds, `promptobus done` clears it) — `resolveTaskId`
// reads it on every call. What remains here is the unchanging part: role, home, the env-
// declared task, and the session.
/**
 * Whether this home needs a move — without moving it. Asked by the loop guard: its job
 * is to check the mailbox, not to move the store.
 * An unrecognised home tail means there is no move by it at all, so there is nothing
 * to wait for.
 */
export function storePending(home, host) {
  if (host == null) {
    throw new Error("storePending: host is required — a missing legacy layout is declared by host.legacyLayout(), not by omitting the argument");
  }
  const root = rootOfHome(home, host);
  if (!root) return false;
  const plan = preflight(root, host.legacyLayout());
  return plan.needed || Boolean(plan.refusal);
}

/**
 * Who this session is on the bus. `declared` is the identity DECLARED by the caller
 * (today that is the Stop-hook command arguments); it is stronger than the environment,
 * and the order here is not cosmetics. A harness background session is given an
 * environment that is not the one it was started with — the `PROMPTOBUS_*` triple reaches
 * it from the process that started the daemon — so the declared identity is trusted
 * first, and the environment remains the spare path for a manual start and an UNTRUSTED
 * source.
 */
export function resolveIdentity(env = process.env, cwd = process.cwd(), { move = true, declared: said = null, host } = {}) {
  if (host == null) {
    throw new Error("resolveIdentity: host is required — a missing legacy layout is declared by host.legacyLayout(), not by omitting the argument");
  }
  const of = (name, key) => (typeof said?.[key] === 'string' && said[key].trim() ? said[key].trim() : env[name]?.trim() || '');
  const hint = of('PROMPTOBUS_ROLE', 'role') || null;
  const role = hint || ORCHESTRATOR;
  const registry = registryOf(host);
  if (!admitsAddress(registry, role)) throw new GateError(`PROMPTOBUS_ROLE="${role}" — expected ${addressList(registry)}`);
  const declared = of('PROMPTOBUS_HOME', 'home');
  let home;
  // `move: false` — resolve WITHOUT a move: that is how the loop guard asks for the home,
  // and it must not move the store. The path is the same, otherwise after a move the
  // guard would look into a directory that is gone.
  const at = (root) => (move ? promptobusHome(root, host) : path.join(root, PROMPTOBUS_REL));
  if (declared) {
    // The move is started here too: a process with a declared home has no other store
    // touch at all. The root is derived from the home itself; if it did not derive, take
    // the home as-is.
    const root = rootOfHome(declared, host);
    home = root ? at(root) : declared;
  } else {
    const root = host.findRoot(cwd);
    if (!root) {
      throw new GateError('workspace root not found and PROMPTOBUS_HOME is not set — '
        + 'there is nothing to attach the Promptobus bus to');
    }
    home = at(root);
  }
  const canonicalHome = canonicalPath(home);
  const declaredTask = of('PROMPTOBUS_TASK', 'task') || null;
  const scope = { home: canonicalHome, task: declaredTask, address: role };
  const session = sessionIdentity(env, scope);
  return {
    role,
    // `role` is the mailbox this process reads; the sender is resolved per task from the
    // record, and `hint` is the declared role that record must agree with.
    hint,
    home: canonicalHome,
    declaredTask,
    session,
    why: session ? null : identityWhy(sessionIdentityReport(env, scope)),
  };
}

// Two claimants are not zero: a contested answer names both, and only an absent one says none.
function identityWhy(said) {
  return contestedIdentity(said) ? said.why : `the calling harness supplied no session identity: ${said.why}`;
}
