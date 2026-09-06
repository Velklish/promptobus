// Availability cache: the last availability snapshot, kept between commands so
// that a routed `spawn` does not start three harness binaries every time.
//
// **This file is the disk boundary of routing, and it is the one new file that can
// leak.** Two rules hold it, and both are gates rather than intentions:
//
//   • mode `0600` and a temp-file-plus-rename write — a parallel reader never sees
//     a truncated file, and a process that dies mid-write leaves the previous one;
//   • a verdict is PROJECTED onto the closed snapshot shape before it reaches
//     disk. `snapshotEntry` copies the declared fields and nothing else, so a
//     token, an email or an open account id an adapter put beside them does not
//     travel. The shape is not this file's invention — it is
//     `schemas/model-routing/snapshot.schema.json`, whose every object is closed
//     precisely so that a document carrying such a field stops validating.
//
// The file is named by the host (`routingPaths().cacheFile`) and is account-scoped:
// auth, model inventory and the remaining limit belong to the account the harness
// binary is logged into, and the same account is reached from every checkout on
// the machine. `promptobusHome()` — the per-workspace task store — is not used
// here at all.
//
// It carries no account key. v1 assumes ONE locally authenticated account per
// harness (ADR-003), so there is nothing to tell apart; the snapshot schema keeps
// a `fingerprint` slot for the day that changes, and the rule that comes with it
// is that the key must be opaque and one-way.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../util.js';

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
    return body();
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

/** A list of model ids, deduplicated, or `null` when it is not one. The schema wants unique items and at least one. */
function modelList(raw) {
  if (!Array.isArray(raw)) return null;
  const ids = [...new Set(raw.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim()))];
  return ids.length ? ids : null;
}

/**
 * What a window binds, projected onto the closed scope shapes, or `undefined`
 * when the value is present and is none of them.
 *
 * `undefined` rather than `null`, and the difference is the whole point: `null`
 * is a CLAIM — this window binds the whole account — and an unreadable scope is
 * not evidence for it. So a garbled scope takes its window with it (see
 * `windowOf`) instead of being quietly widened into an account-wide limit, which
 * would make the resolver apply somebody's per-model weekly cap to every tuple
 * of that harness.
 *
 * A model scope may arrive without `models`: the adapter holds the driver's
 * dictionary and could not resolve the harness's display name to ids. That
 * window stays — it is printed for a person and binds nothing — and the resolver
 * matches by exact id, so it never guesses a family (ADR-004). An `auto` pool
 * without its list is the other way round: the harness publishes that list, so
 * its absence is an adapter fault and the window goes. An `api` pool carries no
 * list at all, being the complement, and one attached to it is dropped with the
 * window rather than kept as a second, quieter claim.
 */
function scopeOf(raw) {
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
const TIER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

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

/**
 * One harness entry, projected onto the closed snapshot shape.
 *
 * Field by field on purpose, never a spread: a spread is exactly how a `token`, a
 * `rawOutput` or an `account` field an adapter attached would reach the file. The
 * only free text that survives is `message`, and the contract says what it may
 * hold — a human diagnosis, never harness output verbatim.
 *
 * The projection is by VALUE as well as by field, and it drops rather than
 * repairs: an element of `models` or `windows` that is not one is left out, and
 * the rest of the verdict stands. Nothing here invents a number — the file
 * promises to validate against the snapshot schema, and a repaired value would
 * validate while saying something the harness never said.
 *
 * A `checkedAt` that cannot be read becomes `NEVER_CHECKED`, never "now". Now is
 * the one value that would make an unreadable stamp look freshly measured and
 * hold it live for a whole TTL; the epoch makes the same entry read as expired,
 * which sends the next run back to the adapter.
 */
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
 * and still writes nothing.
 */
export function writeEntries(host, entries, { at = Date.now(), dryRun = false } = {}) {
  if (dryRun) return null;
  const file = cacheFileOf(host);
  // The read is inside the lock, not before it. Merging what was on disk a moment
  // ago is exactly the read-modify-write that loses a neighbour's entries.
  return withCacheLock(file, () => {
    const stored = readSnapshot(host);
    const harnesses = { ...(stored?.harnesses ?? {}) };
    for (const [harness, entry] of Object.entries(entries)) harnesses[harness] = snapshotEntry(entry);
    // The schema wants at least one harness: an empty document is not a snapshot of
    // anything, and writing one would only give the next reader a file to parse.
    if (!Object.keys(harnesses).length) return null;
    const doc = { schemaVersion: SNAPSHOT_VERSION, takenAt: isoStamp(at), harnesses };
    writeFileAtomic(file, `${JSON.stringify(doc, null, 2)}\n`, { mode: CACHE_MODE });
    return doc;
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

/**
 * Late-start hook: a driver whose session failed to start on a limit reports it
 * here, and the harness is exhausted from that moment.
 *
 * The evidence chooses the code, and `reason` is how a caller states evidence this
 * function cannot see. Left out, it is derived as it always was: a reset the harness
 * named makes it `subscription_exhausted`, and the entry expires by itself at that
 * time; no reset makes it `manual_exhaustion`, the sticky kind, which only
 * `--clear-exhausted` lifts.
 *
 * **The derivation is not the whole vocabulary, which is why the argument exists.**
 * A harness can say the limit RESETS and name the time in a person's words and a
 * person's timezone ("resets at 3pm"): that is a subscription limit with a reset
 * nothing may parse, and it is `subscription_exhausted` with `resetAt: null` — a
 * combination the derivation cannot express. Without the argument the one caller
 * with that evidence wrote its entry through `writeEntries` instead, and one fact
 * had two doors into the cache.
 *
 * A `resetAt` that IS readable still expires the entry by itself, whichever reason
 * carries it; with none, both reasons are the sticky kind, and the reason then says
 * who the limit belongs to rather than when it comes back.
 *
 * `source` is `probe`: the harness itself said so — it was asked to start and
 * answered — even though nothing here started a preflight.
 *
 * The mark is per HARNESS, not per tuple: the availability snapshot has no tuple
 * dimension, and a limit is an account fact rather than a model one. A tuple the
 * run must avoid for another reason is the resolver's business.
 */
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
