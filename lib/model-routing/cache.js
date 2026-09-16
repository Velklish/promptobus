// The availability cache: the first disk boundary of routing.
// [guides/model-routing.md#the-availability-cache-the-first-disk-boundary-of-routing](../../docs/guides/model-routing.md#the-availability-cache-the-first-disk-boundary-of-routing)

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../../dist/fs/atomic.js';

/** Snapshot document version, pinned by the schema and its golden fixture. A document of any
 * other version is DISCARDED, never migrated (ADR-004 D): this is a cache, not a store. */
export const SNAPSHOT_VERSION = 2;

/** Permissions of the cache file. Availability is not a secret; what a leaky adapter might attach to it is. */
export const CACHE_MODE = 0o600;

// TTLs, in the vocabulary the reference uses. Not one number, because the facts in one entry
// age at different speeds: a login holds an hour, a remaining-limit window a minute.
/** Auth and model inventory. */
export const AUTH_TTL_MS = 60 * 60 * 1000;
/** Limit windows. An entry that carries any ages at this speed — it is only as fresh as its shortest fact. */
export const WINDOW_TTL_MS = 60 * 1000;
/** A probe that timed out or failed. Long enough not to hammer a broken harness, short enough to recover. */
export const TRANSIENT_TTL_MS = 5 * 60 * 1000;

/** The stamp of something never looked at: the epoch rather than a fourth `source`, because
 * this is an AGE, not a provenance — every TTL measured from it has long passed. */
export const NEVER_CHECKED = '1970-01-01T00:00:00.000Z';

/** Whether a value is a timestamp at all. The form is normalised by `isoStamp`; this only asks if it can be. */
export function isTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** ISO-8601 with milliseconds — the one timestamp form the snapshot schema accepts. */
export function isoStamp(value = null) {
  const ms = value === null || value === undefined
    ? Date.now()
    : (typeof value === 'number' ? value : Date.parse(value));
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
}

/** The last moment a timestamp may name. A reset handed over in the wrong unit lands tens of
 * thousands of years out, and an exhaustion held by that reset would never expire. */
const LATEST_STAMP_MS = Date.UTC(9999, 11, 31);

/** Epoch milliseconds as the snapshot writes a moment, or `null`. The unit stays with each
 * adapter; the range check lives here once, and it never falls back to "now". */
export function stampAtMs(ms) {
  if (!Number.isFinite(ms) || ms < 0 || ms > LATEST_STAMP_MS) return null;
  return new Date(ms).toISOString();
}

/** The cache file this host names. Never assembled from a home path here: the host owns the layout. */
export function cacheFileOf(host) {
  return host.routingPaths().cacheFile;
}

/** The lock a writer holds while it reads, merges and renames. What it prevents is a LOST
 * entry, not a corrupt file — the write is already temp-plus-rename. */
export const LOCK_SUFFIX = '.lock';

/** How long a writer waits for somebody else's lock before writing anyway. */
export const LOCK_WAIT_MS = 2_000;

/** When a lock stops being somebody's and becomes litter: a holder keeps it for microseconds,
 * and waiting the full window on every later command would tax one crash forever. */
export const LOCK_STALE_MS = 15_000;

/** Sleep without yielding to callers: the write is synchronous and there is nothing to await it. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `body` under the cache lock, always releasing it. A lock that cannot be taken is not
 * a refusal: refusing to write would lose the very entries the lock exists to keep. */
function withCacheLock(file, body) {
  const lock = `${file}${LOCK_SUFFIX}`;
  let held = false;
  // `body` is told whether the lock was taken: a write that fell through it may lose a
  // neighbour's entry, and a silent loss is what PB-186 caught. See 05-drivers, the cache lock.
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        closeSync(openSync(lock, 'wx'));
        held = true;
        break;
      } catch (e) {
        if (e?.code !== 'EEXIST') break;
        let age = Infinity;
        try { age = Date.now() - statSync(lock).mtimeMs; } catch { age = Infinity; }
        if (age > LOCK_STALE_MS) {
          rmSync(lock, { force: true });
          continue;
        }
        if (Date.now() >= deadline) break;
        sleepSync(20);
      }
    }
  } catch {
    held = false;
  }
  try {
    return body(held);
  } finally {
    if (held) {
      try { rmSync(lock, { force: true }); } catch { /* somebody broke it as stale */ }
    }
  }
}

/** The marks a model row may carry — a CLOSED list, and the schema's `flags` enum. Closed so
 * a typo in an overlay deny cannot ban nothing silently; an unknown flag is dropped. */
export const MODEL_FLAGS = ['no-zdr'];

/** The snapshot property-name grammar, shared with the hand-written validator. */
export const HARNESS_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** One model of the inventory, or `null`. A dropped element is not a dropped verdict; `hidden`
 * is written only when true (ADR-004), and the resolver reads the rows without it. */
function modelOf(raw) {
  const model = typeof raw?.model === 'string' ? raw.model.trim() : '';
  if (!model) return null;
  const out = { model, rated: raw.rated === true };
  if (raw.hidden === true) out.hidden = true;
  const flags = Array.isArray(raw.flags)
    ? [...new Set(raw.flags.filter((f) => MODEL_FLAGS.includes(f)))]
    : [];
  if (flags.length) out.flags = flags;
  return out;
}

/** The window kinds ADR-004 names. A NAME, never a length: `lengthSec` is the number, and neither is derived from the other. */
export const WINDOW_KINDS = ['session', 'weekly', 'monthly'];

/** A list of model ids, deduplicated, or `null`. Exported for the telemetry record: one
 * function per schema, or the two copies drift and the quieter one stops deduplicating. */
export function modelList(raw) {
  if (!Array.isArray(raw)) return null;
  const ids = [...new Set(raw.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim()))];
  return ids.length ? ids : null;
}

// What a window binds, projected onto the closed scope shapes, or undefined.
// [guides/model-routing.md#scopeof--what-a-window-binds-projected-onto-the-closed-scope-shapes-or-undefined](../../docs/guides/model-routing.md#scopeof--what-a-window-binds-projected-onto-the-closed-scope-shapes-or-undefined)
export function scopeOf(raw) {
  if (raw === null) return null;
  // ABSENT is not `null`. `null` claims the window binds the whole account; an adapter that
  // never named a scope did not claim it, so absence drops the window.
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (typeof raw.model === 'string' && raw.model.trim()) {
    const out = { model: raw.model.trim() };
    const models = modelList(raw.models);
    if (models) out.models = models;
    else if (raw.models !== undefined) return undefined;
    return out;
  }
  if (raw.pool === 'auto') {
    const models = modelList(raw.models);
    return models ? { pool: 'auto', models } : undefined;
  }
  if (raw.pool === 'api') return raw.models === undefined ? { pool: 'api' } : undefined;
  return undefined;
}

/** One limit window, or `null`. `usedPercent` outside 0…100 is DROPPED, not clamped — an
 * invented number would read as a measurement; `kind` and `lengthSec` are required (ADR-004). */
function windowOf(raw) {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
  const usedPercent = typeof raw?.usedPercent === 'number' ? raw.usedPercent : NaN;
  if (!id || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return null;
  if (!WINDOW_KINDS.includes(raw.kind)) return null;
  if (!Number.isInteger(raw.lengthSec) || raw.lengthSec < 1) return null;
  const scope = scopeOf(raw.scope);
  if (scope === undefined) return null;
  const out = { id, kind: raw.kind, lengthSec: raw.lengthSec, usedPercent, scope };
  if (raw.resetAt !== undefined) out.resetAt = isTimestamp(raw.resetAt) ? isoStamp(raw.resetAt) : null;
  return out;
}

/** Where a tier name may have come from. A closed list, so a fifth spelling never reaches disk. */
export const TIER_SOURCES = ['credentials', 'probe', 'derived', 'user'];

/** A tier name has the shape of a CODE, not of prose. A gate, not tidiness: it is the second
 * string an adapter writes to disk, and this file exists to stay clean. */
export const TIER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** The tier, or `null` — the schema's own word for "this harness names no plan". A garbled one
 * becomes that too: losing it costs a line, keeping it puts an unchecked string on disk. */
function tierOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!TIER_NAME_RE.test(name) || !TIER_SOURCES.includes(raw.source)) return null;
  return { name, source: raw.source };
}

/** Codex's credit flags, or `null`. Booleans only — the amount is deliberately not carried:
 * this file promises to hold no identity, and nothing in the package reads a balance. */
function creditsOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.available !== 'boolean' || typeof raw.unlimited !== 'boolean') return null;
  return { available: raw.available, unlimited: raw.unlimited };
}

/** The count of window resets the account may spend. Surfaced, never spent: spending one is a person's decision. */
function resetCreditsOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.available) || raw.available < 0) return null;
  return { available: raw.available };
}

// One harness entry, projected onto the closed snapshot shape.
// [guides/model-routing.md#snapshotentry--one-harness-entry-projected-onto-the-closed-snapshot-shape](../../docs/guides/model-routing.md#snapshotentry--one-harness-entry-projected-onto-the-closed-snapshot-shape)
export function snapshotEntry(entry) {
  const out = {
    state: entry.state,
    reason: entry.reason ?? null,
    message: String(entry.message ?? ''),
    checkedAt: isTimestamp(entry.checkedAt) ? isoStamp(entry.checkedAt) : NEVER_CHECKED,
    source: entry.source,
    resetAt: isTimestamp(entry.resetAt) ? isoStamp(entry.resetAt) : null,
  };
  if (typeof entry.version === 'string') out.version = entry.version;
  if (entry.tier !== undefined) out.tier = tierOf(entry.tier);
  if (typeof entry.spendControlReached === 'boolean') out.spendControlReached = entry.spendControlReached;
  const credits = creditsOf(entry.credits);
  if (credits) out.credits = credits;
  const resetCredits = resetCreditsOf(entry.resetCredits);
  if (resetCredits) out.resetCredits = resetCredits;
  if (Array.isArray(entry.models)) out.models = entry.models.map(modelOf).filter(Boolean);
  if (Array.isArray(entry.windows)) out.windows = entry.windows.map(windowOf).filter(Boolean);
  return out;
}

/** The stored snapshot, or `null`. An unreadable file and a document of another `schemaVersion`
 * are both none; the version is checked HERE because this is the one door into the file. */
export function readSnapshot(host) {
  const file = cacheFileOf(host);
  if (!existsSync(file)) return null;
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    if (!doc || typeof doc.harnesses !== 'object' || !doc.harnesses) return null;
    return doc.schemaVersion === SNAPSHOT_VERSION ? doc : null;
  } catch {
    return null;
  }
}

/** The `schemaVersion` at the cache path that this build does NOT read, or `null`. It exists
 * so one word of a diagnosis can tell a first run from an upgrade that discarded everything. */
export function staleVersionAt(host) {
  const file = cacheFileOf(host);
  if (!existsSync(file)) return null;
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    const version = doc?.schemaVersion;
    return Number.isInteger(version) && version !== SNAPSHOT_VERSION ? version : null;
  } catch {
    return null;
  }
}

/** Whether an exhaustion is the sticky kind: confirmably spent with no known reset. Neither
 * time nor a later probe clears it — `--clear-exhausted` is the only door. */
export function stickyExhaustion(entry) {
  return entry?.state === 'exhausted' && !entry.resetAt;
}

/** When an entry stops being usable. The cascade reads top to bottom and the first match wins;
 * the tier needs no line of its own, since it ages with auth and inventory. */
export function entryExpiry(entry) {
  if (entry.state === 'exhausted') return entry.resetAt ? Date.parse(entry.resetAt) : Infinity;
  const checked = Date.parse(entry.checkedAt);
  if (!Number.isFinite(checked)) return -Infinity;
  if (entry.reason === 'probe_timeout' || entry.reason === 'probe_failed') return checked + TRANSIENT_TTL_MS;
  if (Array.isArray(entry.windows) && entry.windows.length) return checked + WINDOW_TTL_MS;
  return checked + AUTH_TTL_MS;
}

/** Whether the entry may still be used at that moment. */
export function entryLive(entry, at = Date.now()) {
  return at < entryExpiry(entry);
}

/** Entries reused without asking the harness. `refresh` drops every live one except a sticky
 * exhaustion; a reused entry says `source: 'cache'` whatever first wrote it. */
export function heldOf(doc, { refresh = false, at = Date.now() } = {}) {
  const held = {};
  for (const [harness, entry] of Object.entries(doc?.harnesses ?? {})) {
    if (refresh && !stickyExhaustion(entry)) continue;
    if (!entryLive(entry, at)) continue;
    held[harness] = { ...entry, source: 'cache' };
  }
  return held;
}

/** Merge entries into the stored snapshot and write it. Merge, not replace: the late-start
 * hook writes ONE harness. `dryRun` makes the whole call a no-op in both modes. */
export function writeEntries(host, entries, { at = Date.now(), dryRun = false } = {}) {
  if (dryRun) return null;
  const file = cacheFileOf(host);
  // The read is inside the lock, not before it. Merging what was on disk a moment
  // ago is exactly the read-modify-write that loses a neighbour's entries.
  return withCacheLock(file, (locked) => {
    const stored = readSnapshot(host);
    const harnesses = { ...(stored?.harnesses ?? {}) };
    const dropped = [];
    const contended = !locked;
    for (const [harness, entry] of Object.entries(entries)) {
      if (!HARNESS_RE.test(harness)) {
        dropped.push(harness);
        continue;
      }
      harnesses[harness] = snapshotEntry(entry);
    }
    // The schema wants at least one harness: an empty document is not a snapshot of
    // anything, and writing one would only give the next reader a file to parse.
    if (!Object.keys(harnesses).length) return { doc: null, dropped, contended };
    const doc = { schemaVersion: SNAPSHOT_VERSION, takenAt: isoStamp(at), harnesses };
    writeFileAtomic(file, `${JSON.stringify(doc, null, 2)}\n`, { mode: CACHE_MODE });
    return { doc, dropped, contended };
  });
}

/** Drop a sticky exhaustion — the `--clear-exhausted` library half. Only the sticky kind, and
 * the entry is removed rather than rewritten: nothing is known about that harness after. */
export function clearExhausted(host, harness, { dryRun = false } = {}) {
  if (dryRun) return stickyExhaustion(readSnapshot(host)?.harnesses?.[harness]);
  const file = cacheFileOf(host);
  // Under the same lock as `writeEntries`: this is a read-modify-write of one document, and a
  // preflight landing between its read and its rename would come back from the dead.
  return withCacheLock(file, () => {
    const stored = readSnapshot(host);
    const entry = stored?.harnesses?.[harness];
    if (!stickyExhaustion(entry)) return false;
    const harnesses = { ...stored.harnesses };
    delete harnesses[harness];
    if (!Object.keys(harnesses).length) rmSync(file, { force: true });
    else {
      writeFileAtomic(
        file,
        `${JSON.stringify({ schemaVersion: SNAPSHOT_VERSION, takenAt: isoStamp(), harnesses }, null, 2)}\n`,
        { mode: CACHE_MODE },
      );
    }
    return true;
  });
}

// Marking a harness exhausted when a lift fails on a spent limit.
// [guides/model-routing.md#markexhausted--marking-a-harness-exhausted-when-a-lift-fails-on-a-spent-limit](../../docs/guides/model-routing.md#markexhausted--marking-a-harness-exhausted-when-a-lift-fails-on-a-spent-limit)
export function markExhausted(host, harness, {
  resetAt = null, reason = null, message = null, at = Date.now(), dryRun = false,
} = {}) {
  const known = isTimestamp(resetAt);
  const derived = known ? 'subscription_exhausted' : 'manual_exhaustion';
  const entry = snapshotEntry({
    state: 'exhausted',
    reason: reason === 'subscription_exhausted' || reason === 'manual_exhaustion' ? reason : derived,
    message: message ?? (known
      ? 'limit hit at start; the harness named a reset time'
      : 'limit hit at start; no reset time given — clear it with --clear-exhausted'),
    checkedAt: isoStamp(at),
    source: 'probe',
    resetAt: known ? resetAt : null,
  });
  writeEntries(host, { [harness]: entry }, { at, dryRun });
  return entry;
}
