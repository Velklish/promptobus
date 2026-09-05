import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { warn, writeFileAtomic } from './util.js';
import {
  addrDir, addressOf, bindingNames, brokenNote, dropBinding, FOREIGN_MARK,
  FOREIGN_ROUTE,
  foreignSessionOf,
  GateError, isAddress, MECHANISM_VERSION_FIELD, MESSAGE_TYPES, migrate, splitLegacyRel,
  newTaskIdentity, onTaskLock,
  openEngine, ORCHESTRATOR, ownerOf, participantFileStem, preflight, PromptobusError,
  readBinding, requireTaskId,
  roleOf, ROOT_DIR, sameSession, sessionFile, sessionOf, stampOfId, TASK_TITLE_SEP, taskDir,
  tasksDir, validate,
  withTaskLock as lockTask, workersDir, writeBinding,
} from '../dist/index.js';

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
  ORCHESTRATOR, isAddress, addrDir, roleOf, addressOf, workerAddress, reviewerAddress,
  participantFileStem, SLUG_MAX, slugify, newTaskIdentity, stampOfId, TASK_TITLE_SEP,
  // foreign-mailbox gate vocabulary
  GateError, FOREIGN_MARK, FOREIGN_ROUTE, MAILBOX_CLAIMED_MARK, foreignTaskLine, claimRoute,
  brokenNote,
  // session identity on the participant record and its check
  sessionOf, sessionIdOf, sameSession, foreignSessionOf,
  // message types, protocol v1 refusal codes, and the open fan-out lease
  MESSAGE_TYPES, ERROR_CODES, PromptobusError, INTENT_STALE_MS,
  // task-directory paths and files the store does not hold
  taskDir, tasksDir, workersDir, sessionsDir, sessionFile, wakeFile, healthFile,
  wardenLogFile, wardenMarkFile,
  // liveness and the warden
  pidAlive, WARDEN_BEAT_SEC, liveWarden, claimWarden, beatWarden, clearWarden,
  readWake, writeWake, readHealth, writeHealth, logWarden, tailWardenLog,
  // end-of-turn marks
  lastTurnAt, markTurn,
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

// Migration of the former directory → `.promptobus` on FIRST access. There are two doors
// into the store, and both lead here: `promptobusHome(root, host)` for commands that find
// the root from cwd, and `resolveIdentity` for processes whose home is declared by
// `PROMPTOBUS_HOME`. The second is as mandatory as the first: `PROMPTOBUS_HOME` is set by
// both the participant config and the workspace canonical list, so the most common first
// touch of the store is a bus-tool call from any session, and it never goes through
// `promptobusHome` at all.
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
    warn(`bus: former directory ${report.from} is gone — the move was finished by a previous run`);
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

// Session identity is the only variable that can be trusted: each session has its own, it
// reaches the MCP-server child process, and it survives `--resume` (verified live).
// Neighbours lie: `CLAUDE_PID` and `CLAUDE_EFFORT` leak from the ancestor,
// `CLAUDE_CODE_HOST_SESSION_ID` is shared by the whole family. Without it the owner
// mechanism stays silent.
export function sessionIdentity(env = process.env) {
  return env.CLAUDE_CODE_SESSION_ID?.trim() || null;
}

// --- engine v1 -------------------------------------------------------------------

// Routing policy — the rule "who may write to whom". Required when the engine opens, and
// the consumer supplies it: the core does not know roles and takes them from participant
// records.
//
// Bus rule: correspondence is only with the task orchestrator. Workers and reviewers do
// not talk to each other — context and artifacts go through the orchestrator; the `send`
// tool description has said this since the bus appeared, and only protocol v1 made it
// enforceable.
export function atiRouting(sender, recipient) {
  if (sender.role === ORCHESTRATOR || recipient.role === ORCHESTRATOR) return { allow: true };
  return {
    deny: true,
    reason: `${sender.role}s and ${recipient.role}s do not write to each other — `
      + "context and artifacts go through the orchestrator: pass this to them, they will forward it",
  };
}

// Engine on a home: opening restores unfinished fan-outs of every task, and there is no
// need to do that on every store call. The key is the home itself: a CLI process works
// with one, and the suite opens one temporary directory per file.
const engines = new Map();

/**
 * v1 engine of this home — the only mechanism door into the store. The store directory is
 * given in full: the mechanism receives it from an environment variable, and `.promptobus`
 * may be missing from the end entirely.
 */
export function bus(home, { cli } = {}) {
  const hit = engines.get(home);
  if (hit) return hit;
  // The mechanism version is named at open — both paths, the CLI command and the bus MCP
  // server, go through this door, so they read a mixed-version store the same way.
  const engine = openEngine({ home, policy: atiRouting, cli: cli ?? '0.0.0' });
  engines.set(home, engine);
  return engine;
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
export function participantRecord(address, fields = {}) {
  if (!isAddress(address)) {
    throw new GateError(`invalid participant address "${address}" — `
      + 'expected orchestrator, worker:<slug> or reviewer:<slug>');
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
    // Version of the mechanism that wrote the record. It is the evidence of a mixed-version
    // store: a reader from a former release trips over fields it does not know, and without
    // the version it answers "journal is not to schema" instead of "start a new session".
    metadata: { ...fields, address, [MECHANISM_VERSION_FIELD]: fields[MECHANISM_VERSION_FIELD] ?? '0.0.0' },
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
 * address stem, not by name: for the Cursor driver this is the reviewer workspace with its
 * `.cursor/`; Claude Code has none at all. The same `promptobus done` sweep that cleans
 * mcp-configs cleans them: inside sits an MCP config with tokens substituted in.
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
  return typeof id === 'string' && bus(home).taskExists(id);
}

export function taskFile(home, id) {
  return bus(home).taskFile(requireTaskId(id));
}

export function inboxDir(home, id, addr) {
  return bus(home).inboxPath(requireTaskId(id), addrDir(addr));
}

/** What this address has read: in v1 the directory is called `history/` — fan-out
 * recovery uses the filename in it to tell delivered from missing. */
export function historyDir(home, id, addr) {
  return bus(home).historyPath(requireTaskId(id), addrDir(addr));
}

/** Where unreadable mail from this address mailbox is set aside. */
export function brokenDir(home, id, addr) {
  return bus(home).brokenPath(requireTaskId(id), addrDir(addr));
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
  const meta = gate(() => bus(home).readTask(id));
  taskCache?.set(key, meta);
  return meta;
}

/** Read-modify-write of the journal under the task lock, with session identity for diagnosis. */
export function withTaskLock(home, id, fn, opts = {}) {
  return lockTask(home, id, fn, { session: sessionIdentity(), ...opts });
}

/** Patch the journal: title and mechanism fields in `adapter`. `adapter` fields are merged. */
export function patchTask(home, id, patch) {
  const meta = gate(() => bus(home).patchTask(id, patch));
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
} = {}) {
  requireTaskId(id);
  if (taskExists(home, id)) throw new Error(`task ${id} already exists`);
  // The stamp is always written: without it `readableTail` falls back to the full id — a
  // human reads `(t20260827-175756)` instead of `(0827-1757)`.
  const taskStamp = fields.stamp ?? stampOfId(id);
  const adapter = { ...fields, ...(taskStamp ? { stamp: taskStamp } : {}) };
  mkdirSync(taskDir(home, id), { recursive: true });
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
    meta = bus(home).createTask({
      id,
      title: title ?? id,
      owner: participantRecord(ORCHESTRATOR, owner ? { owner } : {}),
      adapter,
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
  const { tasks, broken } = bus(home).listTasks();
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
  const meta = gate(() => bus(home).closeTask(id, { adapter: { closed: new Date().toISOString() } }));
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
export function resolveTaskId(home, declared, session = sessionIdentity()) {
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
      + "A task is created when the first worker is spawned: promptobus spawn --repo <name> --brief <file>");
  }
  throw new GateError(`several active tasks (${active.map((t) => t.id).join(', ')}), `
    + `and this session has no binding${session ? '' : ' — the environment did not supply its identity'} — `
    + 'name the one you want (PROMPTOBUS_TASK for the session, --task for the command). '
    + 'The task is yours and the session is new — claim the mailbox: mailbox {claim: true, task: <id>}, '
    + 'then it will resolve on its own. Need a new run — start it with promptobus spawn --new-task.');
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
  const meta = gate(() => bus(home).putParticipant(id, participant));
  taskCache?.clear();
  return meta;
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
    gate(() => bus(home).patchParticipant(id, p.id, {
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

// Task title from the titles of its tracks: otherwise a run of three tracks would read as
// the work of one. Computed from the WHOLE journal and called AFTER the participant is
// written — two spawns from one pre-image would give "A · B" and "A · C", and the winner
// would lose the foreign track. An empty list is not a reason to rename: a former-CLI
// task has no `title` field.
export function titleFromLines(meta) {
  const lines = [...new Set((meta?.participants ?? [])
    .filter((p) => String(addressOf(p) ?? '').startsWith('worker:') && p.metadata?.title)
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
} = {}) {
  return withTaskLock(home, id, () => {
    const meta = readTask(home, id);
    if (meta.adapter.titleExplicit && !(restamp && !ownership(home, id, ORCHESTRATOR, session).gated)) return null;
    // `fromLines` is computed HERE and only here: the `--dry-run` prediction lives in a
    // separate intent field (`preview`) that this function does not read.
    const next = fromLines ? titleFromLines(meta) : title;
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

export function ownership(home, id, addr, session) {
  if (addr !== ORCHESTRATOR) return { gated: false, owner: null, session };
  const owner = taskOwner(home, id);
  if (!owner || !session) return { gated: false, owner, session };
  return { gated: owner !== session, owner, session };
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

// Claim of the mailbox by a successor session. Returns the former owner: there is one
// `owner` field and no history. A claim is also a rebind: the owner also declares their
// current task.
export function claimOwnership(home, id, owner) {
  const previous = withTaskLock(home, id, () => {
    const meta = readTask(home, id);
    const p = participantOf(meta, ORCHESTRATOR);
    const was = ownerOf(p);
    if (p) {
      gate(() => bus(home).patchParticipant(id, p.id, { metadata: { ...p.metadata, owner } }));
    } else {
      gate(() => bus(home).putParticipant(id, participantRecord(ORCHESTRATOR, { owner })));
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

/**
 * Task files folder. Its contents are of two kinds: artifacts that went through the bus —
 * hard links to their blobs under the names they arrived with, and what the mechanism
 * puts there itself — the `promptobus review` diff, which lands in the folder as a file,
 * not as a send.
 *
 * In store v1 artifact content is addressed by SHA-256 and lives in `blobs/`, and
 * `artifacts/` holds metadata records. Neither is something a human would open, but they
 * do open the task folder: the `task` tool prints its path, and `promptobus prune` counts
 * it. The folder home is here, on the adapter: packing the directory is its job.
 */
export function filesDir(home, id) {
  return path.join(taskDir(home, id), 'files');
}

/**
 * Artifact name in the task files folder. The link itself occupies it: `linkBlob` refuses
 * on a taken name instead of a silent overwrite — the same atomicity the former store
 * held with `COPYFILE_EXCL`. A link, not a copy: content lives in the blob and is
 * deduplicated.
 */
function placeFile(home, id, source, sha256) {
  const dir = filesDir(home, id);
  const ext = path.extname(source);
  const stem = path.basename(source, ext);
  for (let i = 1; ; i += 1) {
    const name = numberedName(stem, ext, i);
    if (bus(home).linkBlob(id, sha256, path.join(dir, name))) return name;
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

/**
 * Send a message. Sender and recipient are ADDRESSES: that is how bus tools and a human
 * talk, and the participant id stays inside the store. Returns the v1 outcome: the canon
 * and the artifact metadata, if there was one.
 */
export function sendMessage(home, id, { from, to, type, body, artifactPath }) {
  if (!isAddress(from)) throw new Error(`unknown sender address "${from}"`);
  if (!isAddress(to)) throw new Error(`unknown recipient address "${to}" — orchestrator, worker:<slug> or reviewer:<slug>`);
  if (!MESSAGE_TYPES.includes(type)) {
    throw new Error(`type "${type}" is not from protocol v1: ${MESSAGE_TYPES.join(', ')}`);
  }
  if (typeof body !== 'string' || !body.trim()) throw new Error('body is empty — a message with no text is not sent');
  // The addressee must be listed as a task participant: a typo in the slug would pass
  // the grammar, and send would return success. There is no legal send to an unregistered
  // address — spawn writes the participant BEFORE start. The refusal words are our own:
  // v1 uses a participant id in them, and humans and the mechanism speak in addresses.
  const meta = readTask(home, id);
  const known = addressesOf(meta);
  if (!known.includes(to)) {
    throw new Error(`task ${id} has no participant "${to}" — nobody can fetch the message, `
      + `and a mailbox opened for them will be seen by neither promptobus status nor task. Task participants: ${known.join(', ')}`);
  }
  // A sender not yet on the task is written as a participant: without a record the routing
  // policy has nothing to ask. The case is legal and live — a session may name a foreign
  // task with the `task` argument, and its address is not yet listed on that task; the
  // address is not user input, it is declared by the session environment.
  //
  // **The record is written already dismissed from watch** — the same field
  // `promptobus dismiss` uses. Otherwise the record would gain a consequence the former
  // store never had: the warden would take the address under watch and report to the
  // orchestrator of a FOREIGN task about a stop of a session that merely wrote there once.
  // An explicit participant lift (`spawn`, `review`) writes the record without the mark
  // and stays under watch.
  //
  // **The right to send is asked BEFORE the write.** Same rule as the engine ("a policy
  // refusal has no right to leave a single byte on the task"): otherwise a closed-task or
  // route refusal would leave a new participant in a FOREIGN journal — and the record
  // would survive the refusal that was the reason not to write it.
  if (!known.includes(from)) {
    requireSendable(meta, from, to);
    upsertParticipant(home, id, participantRecord(from, { dismissed: new Date().toISOString() }));
  }
  const sent = gate(() => bus(home).sendSync(id, {
    from: addrDir(from),
    to: [addrDir(to)],
    type,
    body,
    ...(artifactPath ? { artifact: { path: artifactPath, name: (sha) => placeFile(home, id, artifactPath, sha) } } : {}),
  }));
  taskCache?.clear();
  return { message: sent.message, artifact: sent.artifact };
}

/**
 * Whether this address may send to this task — asked of the same rules as the engine, but
 * BEFORE the sender is written as a participant. A policy that ran twice costs nothing:
 * it is a pure function.
 */
function requireSendable(meta, from, to) {
  if (meta.status !== 'active') throw new GateError(`task ${meta.id} is closed`);
  const recipient = participantOf(meta, to);
  if (!recipient) return;
  const decision = atiRouting(participantRecord(from), recipient, meta);
  if (decision?.allow === true) return;
  throw new GateError(`${addrDir(from)} → ${recipient.id}: ${decision?.reason ?? 'policy returned no decision'}`);
}

/** Fetch incoming mail: what was read moves to history. */
export function readInbox(home, id, addr) {
  const { messages, broken } = gate(() => bus(home).read(id, addrDir(addr)));
  return { messages, broken: brokenLines(broken) };
}

/** Read without fetching: needed by a foreign session — `mailbox` gives them a copy. */
export function peekInbox(home, id, addr) {
  const { messages, broken } = gate(() => bus(home).peek(id, addrDir(addr)));
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
    return bus(home).glance(id, addrDir(addr));
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
  return bus(home).unread(id, addrDir(addr));
}

// When the address last SENT on the bus; `null` — has not sent anything yet.
export function lastSentAt(home, id, addr) {
  return bus(home).lastSentAt(id, addrDir(addr));
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
  return gate(() => bus(home).history(query));
}

// The mechanism names an artifact in a message by FILE NAME — tool replies, the warden
// notification and the `promptobus history` journal print it, and a human finds the file
// in the task folder by it. In v1 the message carries the metadata-record id, so the name
// is read from that. Messages without an artifact are not worth a metadata read at all.
export function nameOfArtifact(home, task, id) {
  try {
    return bus(home).readArtifact(task, id).filename;
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
  ownership,
  peekInbox,
  readInbox,
  readTask,
  resolveTaskId,
  send: sendMessage,
  unreadNote,
  withTaskCache,
};

// The same primitive — for overwriteable CLI files: the guard counter in `waits/` and
// `stalls.json`. The task store writes its own files itself, inside the package; it does
// not export this primitive.
export function writeJsonAtomic(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
  return value;
}

// --- process identity ---------------------------------------------------

// Who this process is on the bus. Worker and reviewer get identity through the env of
// their mcp-config; the orchestrator canonical server gets PROMPTOBUS_HOME at sync.
// Finding home from cwd is the fallback for a manual start and an old config. The path is
// brought to physical form even when the last directory does not exist yet: on Darwin
// /var and /private/var lead to the same place, and without a shared canonicalisation the
// command and the MCP server would print different identities.
function canonicalPath(value) {
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
  const role = of('PROMPTOBUS_ROLE', 'role') || ORCHESTRATOR;
  if (!isAddress(role)) throw new GateError(`PROMPTOBUS_ROLE="${role}" — expected orchestrator, worker:<slug> or reviewer:<slug>`);
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
  return {
    role,
    home: canonicalPath(home),
    declaredTask: of('PROMPTOBUS_TASK', 'task') || null,
    session: sessionIdentity(env),
  };
}
