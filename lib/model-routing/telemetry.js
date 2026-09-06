// Participant telemetry: one JSON Lines record per routed participant, appended
// when `promptobus done` closes the task.
//
// **What it is for.** The catalog's ratings come from published benchmarks, and
// two frontier models a point apart on one leaderboard share a band; nothing in
// the tool learns from what actually happens on this machine. This file is the
// collecting half — a record that ties together what the bus already knows about
// one participant when its run is over: the tuple it was routed to, the strategy
// that chose it, how long it lived, how many review rounds it took, and how much
// of the account's own limit windows moved while it worked. The READING half —
// a finer scale, absolute bands, `models calibrate` — is PB-37 and is not here:
// nothing in this file scores, compares or proposes anything.
//
// **This file is the second disk boundary of routing, and it obeys the first
// one's rules** ([cache.js](cache.js)). It writes into the same account-scoped
// directory, mode `0600`, and it PROJECTS field by field onto a closed shape
// (`schemas/model-routing/telemetry.schema.json`) rather than spreading anything
// it was handed. That matters more here than in the cache: the source is not an
// adapter's verdict but a participant record and a task journal, and those hold
// a repository path, a worktree, a session ref, a branch name and every message
// body of the run. None of them is a field below, and a record carrying one
// stops validating.
//
// The only identifier is `task`: an opaque local key, not the id. It exists so
// PB-37 can tell records of one run from records of another, and the slug a
// person typed does not travel. It is a truncated SHA-256 with no salt — stable
// across installs of one account, which is what makes the grouping work, and
// therefore NOT a claim that the id cannot be guessed back: a task id is short
// and low-entropy, and anyone holding both the file and the workspace could
// match one against the other. The claim is the narrow one — the id is not IN
// the file — and the file is the account's, mode 0600, exactly as the cache is.
//
// **Written at `done`, and not at `dismiss`.** A dismissal is not the end of a
// participant: `dismiss` says out loud that a new assignment to the same address
// puts it back under watch, so a record per dismissal would put several rows on
// one participant's run with nothing to merge them by — and the file is
// append-only, read by PB-37 as one row per participant run. `done` is the one
// moment a run is over for good, and `dismissedBeforeDone` carries the dismissal
// into that single row.
//
// **No lock, unlike the cache.** The cache write is a read-merge-write and loses
// a neighbour's entries without one; this is an append of whole lines, which is
// what JSON Lines is for. Two `done` calls at once interleave records and lose
// nothing.

import {
  appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { addressOf, dismissedOf, routingOf, startedOf, taskDir } from '../../dist/index.js';
import {
  WINDOW_KINDS, entryLive, isTimestamp, isoStamp, readSnapshot, scopeOf,
} from './cache.js';

/**
 * Record version. Additive-only from here on: PB-37 reads rows written by every
 * build after this one, and a reader that had to migrate history would be a
 * reason to throw history away — which is the one thing a file collected from
 * the first day must not do.
 */
export const TELEMETRY_VERSION = 1;

/** Permissions of the telemetry file. The cache's, for the cache's reason: it is the account's. */
export const TELEMETRY_MODE = 0o600;

/** File name, beside the cache the host names. The host owns the directory; this owns the leaf. */
export const TELEMETRY_FILE = 'telemetry.jsonl';

/**
 * The telemetry file this host names.
 *
 * Assembled from `routingPaths().cacheFile`, not from a home path: the host owns
 * the layout, and a consumer that moves the cache moves this with it — the two
 * are the same account's, and a split would leave the telemetry of one account
 * beside the availability of another.
 */
export function telemetryFileOf(host) {
  return path.join(path.dirname(host.routingPaths().cacheFile), TELEMETRY_FILE);
}

/**
 * The opaque local key of a task.
 *
 * SHA-256, truncated to sixteen hex characters — the shape the snapshot's
 * `fingerprint` fixes. Its whole job is to group the records of one run, and it
 * is deliberately unsalted so that grouping holds across installs of one
 * account. That is the trade: a key stable enough to group is a key a holder of
 * the workspace could match back to a task id it already has, so this is an
 * opaque local key rather than a secret. What it buys is that the slug a person
 * typed is not in the file.
 */
export function taskHash(id) {
  return createHash('sha256').update(String(id)).digest('hex').slice(0, 16);
}

/**
 * One window of the record, or `null` when the spawn-side value is not one.
 *
 * The input is `metadata.routing.windows` — the windows that applied to the
 * chosen tuple at spawn, written by the routed lift. The projection drops rather
 * than repairs, exactly as the cache's does: a number invented here would read as
 * a measurement, and the delta below it is the whole point of the row.
 */
function windowOf(raw, endOf) {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
  const at = typeof raw?.usedPercent === 'number' ? raw.usedPercent : NaN;
  if (!id || !WINDOW_KINDS.includes(raw.kind)) return null;
  if (!Number.isFinite(at) || at < 0 || at > 100) return null;
  const scope = scopeOf(raw.scope);
  if (scope === undefined) return null;
  return {
    id, kind: raw.kind, scope, usedPercentAtSpawn: at, usedPercentAtEnd: endOf(id),
  };
}

/**
 * The end-of-run reading of a harness's windows, by window id.
 *
 * Read from the cache as it stands now, and only when the entry may still be
 * used — the same `entryLive` the resolver decides on, so "fresh enough" has one
 * definition in this package rather than a second one here. A stale entry gives
 * `null` for every window: a delta measured against an hour-old percentage is
 * not a delta, and PB-37 is told so rather than handed a number to divide.
 */
function endReader(host, harness, at) {
  const entry = readSnapshot(host)?.harnesses?.[harness];
  if (!entry || !entryLive(entry, at)) return () => null;
  const byId = new Map();
  for (const w of Array.isArray(entry.windows) ? entry.windows : []) {
    if (typeof w?.id === 'string' && typeof w.usedPercent === 'number') byId.set(w.id, w.usedPercent);
  }
  return (id) => (byId.has(id) ? byId.get(id) : null);
}

/**
 * Message counts per participant, from the task's canonical messages.
 *
 * The canonical directory and not `history/`, and that is not a detail: history
 * holds what a mailbox FETCHED, so a `result` nobody read would be missing from
 * the tally of the participant that sent it. The canonical record is written
 * once per message and is what both the inbox and the history point at.
 *
 * **Only the envelope is read.** `sender`, `recipients` and `type` are counted;
 * `body` is opened by `JSON.parse` and never leaves this function, which is the
 * property the privacy check in the suite exists to hold.
 */
function tallies(home, id) {
  const out = new Map();
  const of = (who) => {
    if (!out.has(who)) out.set(who, { turns: 0, reviewRounds: 0, questions: 0, resultCount: 0 });
    return out.get(who);
  };
  let names;
  try {
    names = readdirSync(path.join(taskDir(home, id), 'messages'));
  } catch {
    // No messages directory is a task nobody wrote on — zero counts, not a refusal.
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let msg;
    try {
      msg = JSON.parse(readFileSync(path.join(taskDir(home, id), 'messages', name), 'utf8'));
    } catch {
      // An unreadable record costs its own count and nothing else: the run it
      // belongs to is over, and there is nobody left to fix it for.
      continue;
    }
    const type = typeof msg?.type === 'string' ? msg.type : null;
    if (typeof msg?.sender === 'string') {
      const sent = of(msg.sender);
      sent.turns += 1;
      if (type === 'question') sent.questions += 1;
      if (type === 'result') sent.resultCount += 1;
    }
    if (type === 'review') {
      for (const to of Array.isArray(msg.recipients) ? msg.recipients : []) {
        if (typeof to === 'string') of(to).reviewRounds += 1;
      }
    }
  }
  return out;
}

/**
 * Whether this participant ever lifted a session — the one predicate that decides
 * both who gets a row and who counts as a neighbour on a harness.
 *
 * Role `worker` or `reviewer` with a model on the record. It is `liveTuples`'
 * own filter — "a record with no model never lifted a session" — and it is what
 * keeps the task owner and the already-dismissed record `sendMessage` writes for
 * a foreign session out of a file about runs.
 */
function lifted(p) {
  if (p?.role !== 'worker' && p?.role !== 'reviewer') return false;
  return typeof p.metadata?.model === 'string' && Boolean(p.metadata.model.trim());
}

/**
 * The moment a participant's own run ended: its dismissal, or the close of the
 * task.
 *
 * The dismissal is read through `dismissedOf` and not out of `metadata` by hand:
 * the accessors are the one door core has into an adapter field, and a field
 * named in four files is renamed in three.
 */
function endOf(p, closedAt) {
  const dismissed = dismissedOf(p);
  return isTimestamp(dismissed) ? isoStamp(dismissed) : closedAt;
}

/**
 * How many other participants of this task were live on the same harness when
 * this one spawned.
 *
 * It is the reason the window delta is attributed to the RUN and not to one
 * participant: several participants of one account overlap in time, and a weekly
 * window that moved four points while three of them worked does not say which of
 * the three spent them. The number is the evidence a reader needs to know that;
 * dividing it is PB-37's decision, not this file's.
 */
function concurrentAt(participants, self, spawnedAt) {
  if (!spawnedAt) return null;
  const at = Date.parse(spawnedAt);
  let n = 0;
  for (const p of participants) {
    if (p === self) continue;
    // The same filter the rows use, and for the same reason: a record with no
    // model never lifted a session, so it was never on that harness and never
    // spent anything. Counting one would inflate the very number a reader
    // divides a window delta by.
    if (!lifted(p)) continue;
    if (p.harness !== self.harness) continue;
    const started = Date.parse(startedOf(p) ?? '');
    if (!Number.isFinite(started) || started > at) continue;
    const dismissed = Date.parse(dismissedOf(p) ?? '');
    if (Number.isFinite(dismissed) && dismissed <= at) continue;
    n += 1;
  }
  return n;
}

/**
 * The records this task's participants leave behind, in journal order.
 *
 * A participant is counted when it lifted a session: role `worker` or `reviewer`
 * and a model on the record. That filter is `liveTuples`' own — "a record with no
 * model never lifted a session" — and it is what keeps the orchestrator and the
 * dismissed foreign sender (a record `sendMessage` writes for an address that
 * only ever wrote once) out of a file about runs.
 *
 * A participant WITHOUT `metadata.routing` gets a record all the same, with
 * `strategy: null`: an explicit `--model` is a choice too, and a file that held
 * only routed picks could never say whether routing beat the hand.
 *
 * Every field is copied by name. There is no spread anywhere below, and that is
 * the gate: `metadata` holds `repoAbs`, `worktree`, `branch`, `sessionRef` and
 * the participant's name, and a spread is exactly how they would arrive.
 */
export function telemetryRecords(host, home, meta, { at = Date.now() } = {}) {
  const participants = (meta?.participants ?? []).filter((p) => addressOf(p));
  const recordedAt = isoStamp(at);
  const task = taskHash(meta.id);
  const counts = tallies(home, meta.id);
  const ends = new Map();
  const rows = [];
  for (const p of participants) {
    if (!lifted(p)) continue;
    const model = p.metadata.model.trim();
    const routing = routingOf(p) ?? {};
    const spawnedAt = isTimestamp(startedOf(p)) ? isoStamp(startedOf(p)) : null;
    const ended = endOf(p, recordedAt);
    const seconds = spawnedAt ? Math.round((Date.parse(ended) - Date.parse(spawnedAt)) / 1000) : null;
    const tally = counts.get(p.id) ?? { turns: 0, reviewRounds: 0, questions: 0, resultCount: 0 };
    if (!ends.has(p.harness)) ends.set(p.harness, endReader(host, p.harness, at));
    const readEnd = ends.get(p.harness);
    rows.push({
      schemaVersion: TELEMETRY_VERSION,
      recordedAt,
      task,
      role: p.role,
      harness: p.harness,
      model,
      effort: typeof p.metadata?.effort === 'string' && p.metadata.effort ? p.metadata.effort : null,
      tuple: typeof routing.tupleId === 'string' && routing.tupleId ? routing.tupleId : null,
      strategy: typeof routing.strategy === 'string' && routing.strategy ? routing.strategy : null,
      // PB-32's field, read defensively: a build that does not write it yet
      // leaves `null`, and a record of it is still a record of the strategy.
      strategySource: typeof routing.strategySource === 'string' && routing.strategySource
        ? routing.strategySource
        : null,
      spawnedAt,
      endedAt: ended,
      durationSec: seconds === null ? null : Math.max(0, seconds),
      turns: tally.turns,
      reviewRounds: tally.reviewRounds,
      questions: tally.questions,
      resultCount: tally.resultCount,
      windows: (Array.isArray(routing.windows) ? routing.windows : [])
        .map((w) => windowOf(w, readEnd))
        .filter(Boolean),
      concurrentParticipants: concurrentAt(participants, p, spawnedAt),
      dismissedBeforeDone: Boolean(dismissedOf(p)),
    });
  }
  return rows;
}

/**
 * Append this task's records and say how many landed.
 *
 * One `appendFileSync` for the whole task rather than one per participant: a
 * single write is what makes the file's own atomicity worth having, and a `done`
 * interrupted between two participants would otherwise leave half a run.
 *
 * `mode` on the create is cut by umask, so the permissions are set again right
 * after — the same correction [util.js](../util.js) `writeFileAtomic` makes, for
 * the same reason. Only on a file this call created: the mode of one a person
 * already has is theirs.
 */
export function appendTelemetry(host, home, meta, { at = Date.now() } = {}) {
  const file = telemetryFileOf(host);
  const rows = telemetryRecords(host, home, meta, { at });
  if (!rows.length) return { file, written: 0 };
  mkdirSync(path.dirname(file), { recursive: true });
  const fresh = !existsSync(file);
  appendFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: TELEMETRY_MODE });
  if (fresh) chmodSync(file, TELEMETRY_MODE);
  return { file, written: rows.length };
}

/**
 * How many records the file holds and how large it is, `null` when there is no
 * file yet, and an `unreadable` verdict when there is one and it cannot be read.
 *
 * The three are kept apart because the line below is the only thing that ever
 * reports on this file: a permission error or a directory in its place read as
 * "no records yet" would tell a person their runs are not being collected when
 * the truth is that their records are there and something is wrong.
 */
export function telemetryStats(host) {
  const file = telemetryFileOf(host);
  if (!existsSync(file)) return null;
  try {
    const records = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
    return { file, records, bytes: statSync(file).size, unreadable: false };
  } catch (e) {
    return { file, records: null, bytes: null, unreadable: true, note: e.message };
  }
}

/**
 * Every record the file holds, in the order they were appended.
 *
 * The reader half of the append above, and the only one: `models calibrate`
 * takes rows from here and hands them to the pure
 * [calibrate.js](calibrate.js). A line that does not parse is SKIPPED rather
 * than raising — the file is append-only across builds and a machine that lost
 * power mid-append leaves a truncated last line, and refusing to read a person's
 * whole history over one byte would throw away the evidence the command exists
 * to show. `telemetryStats` still counts every line, so a reader can see the two
 * numbers differ.
 *
 * No file is not an error either: nobody has closed a task with a routed
 * participant yet, which is a state the command reports rather than refuses.
 */
export function readTelemetry(host) {
  const file = telemetryFileOf(host);
  if (!existsSync(file)) return { file, records: [], skipped: 0 };
  const records = [];
  let skipped = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) records.push(row);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { file, records, skipped };
}

/**
 * The one line `models` prints about the file. A COUNT and a size, and nothing
 * read out of the records: reading them back is PB-37, and a line that summarised
 * them here would be the first half of an analysis nobody has decided the shape
 * of yet.
 */
export function telemetryLine(host) {
  const stats = telemetryStats(host);
  if (!stats) return `telemetry: no records yet (${telemetryFileOf(host)})`;
  if (stats.unreadable) {
    return `telemetry: the file is there and could not be read (${stats.note}) — ${stats.file}`;
  }
  return `telemetry: ${stats.records} record(s), ${stats.bytes} B (${stats.file})`;
}
