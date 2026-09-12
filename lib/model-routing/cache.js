// The availability cache: the first disk boundary of routing.
// [guides/model-routing.md#the-availability-cache-the-first-disk-boundary-of-routing](../../docs/guides/model-routing.md#the-availability-cache-the-first-disk-boundary-of-routing)

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../../dist/fs/atomic.js';

/**
 * Snapshot document version. One shape, pinned by the schema and its golden fixture.
 *
 * Version 2 is ADR-004's: a window carries `kind`, `lengthSec` and an explicit
 * `scope`, a harness carries its `tier`, and a model row can be `hidden`.
 *
 * **A document of any other version is discarded, never migrated** (ADR-004,
 * decision D). This is a cache: its shortest fact lives sixty seconds and its
 * longest an hour, so a reader for the old shape would buy one hour of not asking
 * and then be kept forever. Discarding costs one entry that matters — a
 * reset-less exhaustion, which no TTL clears — and the next lift that hits the
 * limit writes it again through the same hook that wrote it the first time.
 */
export const SNAPSHOT_VERSION = 2;

/** Permissions of the cache file. Availability is not a secret; what a leaky adapter might attach to it is. */
export const CACHE_MODE = 0o600;

// TTLs, in the vocabulary the reference uses. They are not one number because the
// facts in one entry do not age at the same speed: a login holds for an hour, a
// remaining-limit window for a minute, and a transient failure should be retried
// long before either.
/** Auth and model inventory. */
export const AUTH_TTL_MS = 60 * 60 * 1000;
/** Limit windows. An entry that carries any ages at this speed — it is only as fresh as its shortest fact. */
export const WINDOW_TTL_MS = 60 * 1000;
/** A probe that timed out or failed. Long enough not to hammer a broken harness, short enough to recover. */
export const TRANSIENT_TTL_MS = 5 * 60 * 1000;

/**
 * The stamp of something that was never looked at. It is the epoch rather than a
 * fourth `source` value, because the schema's `source` is a closed list of three
 * and this is not a provenance: it is an AGE, and the age of "never" is the
 * largest one there is. Every TTL measured from it has long passed, so a value
 * that arrives without a readable stamp reads as expired instead of as fresh.
 */
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

/**
 * The last moment a timestamp may name. The schema wants a four-digit year, and a
 * reset handed over in the wrong unit — milliseconds where seconds were meant —
 * lands tens of thousands of years out: the entry would stop validating and,
 * worse, an exhaustion held by that reset would never expire by itself.
 */
const LATEST_STAMP_MS = Date.UTC(9999, 11, 31);

/**
 * Epoch milliseconds as the snapshot writes a moment, or `null` when the value
 * cannot be one.
 *
 * The three adapters all have to turn a harness's own idea of a moment into this
 * one form, and they disagree only about the UNIT they start from — Codex names
 * unix seconds, Cursor epoch milliseconds inside a string, Claude an ISO-8601
 * with an offset. So the unit stays with each adapter, where the evidence for it
 * is, and the range check and the formatting live here once. `isoStamp` above is
 * the neighbouring rule for a value already known to be a stamp; this one is for
 * a number that has to be judged first, and it never falls back to "now" — a
 * moment that cannot be read is unknown, which the snapshot writes as `null`.
 */
export function stampAtMs(ms) {
  if (!Number.isFinite(ms) || ms < 0 || ms > LATEST_STAMP_MS) return null;
  return new Date(ms).toISOString();
}

/** The cache file this host names. Never assembled from a home path here: the host owns the layout. */
export function cacheFileOf(host) {
  return host.routingPaths().cacheFile;
}

/**
 * The lock a writer holds while it reads, merges and renames.
 *
 * **What it prevents is a lost entry, not a corrupt file.** The write itself is
 * already a temp-file-plus-rename, so a reader never sees half a document. What the
 * rename cannot do is make the read-merge-write one step: a `spawn` and a
 * `models --refresh` in another terminal both read the same document, both merge
 * their own harness into it, and the second rename wins — the loser's entries are
 * gone, and the next run re-probes that harness. A cost rather than a wrong answer,
 * which is why this is a lock file next to the cache and not a protocol.
 *
 * It is not `withTaskLock` ([src/v1](../../src/v1/store.ts)): that one guards a task
 * inside the store, and this file is account-scoped and lives wherever the host
 * names, outside any store.
 */
export const LOCK_SUFFIX = '.lock';

/** How long a writer waits for somebody else's lock before writing anyway. */
export const LOCK_WAIT_MS = 2_000;

/**
 * When a lock stops being somebody's and becomes litter. A holder keeps it for one
 * read and one rename — microseconds — so a lock older than this is a process that
 * died between the two, and waiting the full `LOCK_WAIT_MS` for it on every command
 * afterwards would be a permanent tax for a crash that happened once.
 */
export const LOCK_STALE_MS = 15_000;

/** Sleep without yielding to callers: the write is synchronous and there is nothing to await it. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `body` while holding the cache lock, and always release it.
 *
 * A lock that cannot be taken is not a refusal. The cache is a cache: a run that
 * refused to write because a neighbour held a lock, or because the directory is
 * read-only, would lose the very entries the lock exists to keep. So the wait is
 * bounded and the write happens either way — at worst the behaviour is what it was
 * before the lock existed, for the one run that timed out.
 */
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

/**
 * The marks a model row may carry — a CLOSED list, and the snapshot schema's
 * `flags` enum is the same one.
 *
 * Closed because an overlay may deny by a flag (ADR-004), and a flag name checked
 * against nothing would let a typo ban silently nothing: `no-zdrr` would validate,
 * match no model, and read to its author as a rule that holds. The price is that a
 * new mark a harness starts printing needs a release rather than a data change,
 * and that is the price of the deny rule being checkable at all.
 *
 * A flag outside the list is dropped like any other garbled element — the row and
 * the verdict stand, because an adapter that reported one mark this build does not
 * know still knows what the account can run.
 */
export const MODEL_FLAGS = ['no-zdr'];

/** The snapshot property-name grammar, shared with the hand-written validator. */
export const HARNESS_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * One model of the inventory, or `null` when the element is not one.
 *
 * A dropped element is not a dropped verdict: an adapter that garbles one row of
 * `codex --list` still knows whether the account is logged in, and losing the
 * whole harness over a blank model name would throw away the answer to keep the
 * footnote. `flags` are deduplicated because the schema demands unique items — a
 * repeat would fail validation for a document that is otherwise fine.
 *
 * `hidden` is written only when it is true (ADR-004): the harness lists the row
 * and declines to offer it. It is carried rather than dropped so that `models`
 * shows the whole inventory a person would see from the harness itself, and the
 * resolver reads the rows without it — which is why a tuple naming a hidden model
 * comes out as `model-not-in-inventory` and needs no code of its own. A `false`
 * is left out rather than written: the absent case and the explicit-false case
 * are one fact, and one spelling of a fact is the rule this file already keeps.
 */
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

/**
 * A list of model ids, deduplicated, or `null` when it is not one. The schema wants
 * unique items and at least one.
 *
 * Exported for the telemetry record ([telemetry.js](telemetry.js)), which writes
 * the same scope shapes into a second file: one function per schema, or the two
 * copies drift and the quieter one stops deduplicating.
 */
export function modelList(raw) {
  if (!Array.isArray(raw)) return null;
  const ids = [...new Set(raw.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim()))];
  return ids.length ? ids : null;
}

// What a window binds, projected onto the closed scope shapes, or undefined.
// [guides/model-routing.md#scopeof--what-a-window-binds-projected-onto-the-closed-scope-shapes-or-undefined](../../docs/guides/model-routing.md#scopeof--what-a-window-binds-projected-onto-the-closed-scope-shapes-or-undefined)
export function scopeOf(raw) {
  if (raw === null) return null;
  // ABSENT is not `null`. `null` is a claim — this window binds the whole account
  // — and an adapter that never named a scope did not make it; writing one would
  // apply somebody's per-model cap to every tuple of the harness. So absence
  // drops the window, exactly as a missing `kind` does, and the schema requires
  // the field for the same reason.
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

/**
 * One limit window, or `null` when the element is not one.
 *
 * `usedPercent` outside 0…100 — or `NaN`, which is what `Number(undefined)` gives
 * — is dropped rather than clamped: the resolver turns it into `remaining`, and a
 * number invented here would read as a measurement. A window whose `resetAt`
 * cannot be read keeps its percentage and loses only the reset, which is the
 * schema's own `null` for "unknown".
 *
 * `kind` and `lengthSec` are required by ADR-004 and their absence drops the
 * window. A window with no length has no PACE — `elapsedShare` cannot be
 * computed from it — and one that silently never paces is worse than one that
 * fails here, where the adapter that wrote it is still the obvious suspect. An
 * adapter that cannot state a length reports no window, which is the rule
 * ADR-003 already gives for a harness that exposes none.
 */
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

/**
 * A tier name has the shape of a CODE, not of prose: no spaces and no `@`.
 *
 * That is a gate rather than tidiness. `message` is documented as the one
 * free-text field that reaches disk, and a tier is the second string an adapter
 * writes there — an adapter that handed over an account address or a sentence of
 * harness output would put it in the file this module exists to keep clean. A
 * plan name is `plus`, `default_..._20x` or `included:<cents>`; none of those
 * needs a space, and nothing that does is a plan name.
 */
export const TIER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/**
 * The tier, or `null` when the value is not one.
 *
 * `null` is the schema's own word here — "this harness names no plan" — and it is
 * what an unreadable tier becomes, because a tier is displayed and scored by
 * nothing: losing it costs a line of output, and keeping a garbled one would put
 * an unchecked string on disk under a field a person reads as measured.
 */
function tierOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!TIER_NAME_RE.test(name) || !TIER_SOURCES.includes(raw.source)) return null;
  return { name, source: raw.source };
}

/**
 * Codex's credit flags, or `null` when they are not there.
 *
 * Booleans only, and the amount is deliberately not carried: the count of what an
 * account holds is a fact about that account, this file promises to hold no
 * identity, and nothing in the package reads a balance. What a person needs to
 * know is whether there is anything beside the windows at all.
 */
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

/**
 * The stored snapshot, or `null` when there is none.
 *
 * An unreadable file is the same as none, and so is a document of another
 * `schemaVersion`: ADR-004 discards rather than migrates, so a v1 file read by
 * this build is exactly a cache that holds nothing. Every harness then reports
 * `unknown` / `stale_cache`, which is the code for "the cache cannot answer for
 * this harness and no probe ran" — the same answer a first run on a new machine
 * gets, and the same one it recovers from.
 *
 * The version is checked HERE rather than at each caller because this is the one
 * door into the file: `heldOf`, `writeEntries` and `clearExhausted` all read
 * through it, so a document of the wrong shape cannot reach a merge and be
 * written back half-converted.
 */
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

/**
 * The `schemaVersion` of a document sitting at the cache path that this build does
 * NOT read, or `null` when there is no such thing.
 *
 * It exists so that one word of a diagnosis can be true. `readSnapshot` answers
 * `null` for a missing file and for a discarded version alike — which is right,
 * because both are a cache that holds nothing — but the person meets the two in
 * different places: one is a first run, the other is an upgrade that just threw
 * away every entry they had. `stale_cache` is the code for both, and this is how
 * the message beside it says which.
 *
 * Only called when `readSnapshot` came back empty, so the ordinary run reads the
 * file once.
 */
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

/**
 * Whether an exhaustion is the sticky kind: confirmably spent with no known reset.
 *
 * Time does not clear it and neither does a later probe — `--clear-exhausted` is
 * the only door, which is what the reference means by "nothing else clears one".
 */
export function stickyExhaustion(entry) {
  return entry?.state === 'exhausted' && !entry.resetAt;
}

/**
 * When an entry stops being usable, in epoch milliseconds. `Infinity` — never by
 * itself; `-Infinity` — already, because its stamp cannot be read.
 *
 * The cascade reads top to bottom and the first line that matches wins: an
 * exhaustion is held by its own reset rather than by a TTL, a failed probe is
 * retried soonest, and an entry carrying limit windows ages at the speed of the
 * fastest fact inside it.
 *
 * The tier needs no line of its own. A plan changes about as often as a login
 * does, so it belongs to the hour the last line gives auth and inventory — and an
 * entry that also carries windows is already held to a minute by the line above,
 * which is stricter and therefore never wrong for the tier.
 */
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

/**
 * Entries reused without asking the harness, taken from a snapshot already read.
 *
 * `refresh` drops every live entry — that is what the flag is for — with one
 * exception it must not touch: a sticky exhaustion. A probe cannot clear one, so
 * re-probing that harness would either change nothing or quietly contradict the
 * held fact; the person clears it with `--clear-exhausted` or not at all.
 *
 * A reused entry says `source: 'cache'` whatever wrote it: `source` is how THIS
 * snapshot got the value, not who first learned it.
 */
export function heldOf(doc, { refresh = false, at = Date.now() } = {}) {
  const held = {};
  for (const [harness, entry] of Object.entries(doc?.harnesses ?? {})) {
    if (refresh && !stickyExhaustion(entry)) continue;
    if (!entryLive(entry, at)) continue;
    held[harness] = { ...entry, source: 'cache' };
  }
  return held;
}

/**
 * Merge entries into the stored snapshot and write it.
 *
 * Merge, not replace: the late-start hook writes ONE harness without re-probing
 * its neighbours, and a preflight over a narrowed harness list must not drop what
 * it did not ask about.
 *
 * `dryRun` makes the whole call a no-op and returns `null`. That is the flag's
 * whole meaning here and it holds in both modes — `--refresh --dry-run` probes
 * and still writes nothing. Otherwise the result is `{ doc, dropped }`, where
 * `doc` is the written document or `null` when every incoming key was dropped.
 */
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

/**
 * Drop a sticky exhaustion — the `--clear-exhausted <harness>` library half.
 *
 * Only the sticky kind: an exhaustion that names its reset expires by itself, and
 * clearing it early would claim the limit is back before it is. Returns whether
 * anything was held to clear, so the command can say so.
 *
 * The entry is removed rather than rewritten as `unknown`: nothing is known about
 * that harness afterwards, and the next preflight probes it. When it was the last
 * entry the file goes with it — an empty snapshot is not a document.
 */
export function clearExhausted(host, harness, { dryRun = false } = {}) {
  if (dryRun) return stickyExhaustion(readSnapshot(host)?.harnesses?.[harness]);
  const file = cacheFileOf(host);
  // Under the same lock as `writeEntries`, and for the same reason: this is a
  // read-modify-write of the same document, and a preflight landing between its
  // read and its rename would come back from the dead in the written file.
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
