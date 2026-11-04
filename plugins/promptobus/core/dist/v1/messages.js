// Messages: names, order and what a read marks.
// [reference/04-protocol.md#messages-names-order-and-what-a-read-marks](../../docs/reference/04-protocol.md#messages-names-order-and-what-a-read-marks)
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { pidAlive } from '../fs/proc.js';
import { dirFailure, linkFailure } from './artifacts.js';
import { fail, PromptobusError } from './errors.js';
import { brokenInboxDir, brokenMessagesDir, historyDir, historyRef, historyRoot, inboxDir, inboxRef, intentFile, intentsDir, messageFile, messagesDir, ownerOfIntent, } from './layout.js';
import { compactStamp, MESSAGE_PROTOCOL_VERSION } from './model.js';
import { reserveMessageId, withMessageCommit } from './message-order.js';
import { validate } from './validate.js';
const NO_FAULT = () => { };
/** Message excerpt for a notification: the driver assembles the text, the frame belongs to the channel. */
export function previewOf(m) {
    return {
        id: m.id,
        type: m.type,
        from: m.sender,
        ts: m.ts,
        body: m.body,
        artifact: m.artifact ?? null,
    };
}
let seq = 0;
/** Independent draft/artifact name. Message commit replaces it with a durable logical ID. */
export function newRecordId(now) {
    seq = (seq + 1) % 10000;
    const stamp = compactStamp(now);
    return `${stamp}-${String(seq).padStart(4, '0')}-${randomBytes(3).toString('hex')}`;
}
// Idempotent hard link. Link `EEXIST` means the ref is already placed.
// Mkdir errno is classified by `dirFailure`, not by `linkFailure`.
function linkOnce(from, to, fault = NO_FAULT) {
    const dir = path.dirname(to);
    try {
        fault('mkdir', { target: dir, to });
        mkdirSync(dir, { recursive: true });
    }
    catch (e) {
        const directory = dirFailure(e, dir);
        if (directory !== e)
            throw directory;
        throw linkFailure(e, dir);
    }
    try {
        linkSync(from, to);
        return true;
    }
    catch (e) {
        if (e.code === 'EEXIST')
            return false;
        throw linkFailure(e, to);
    }
}
/** Whether the recipient has a ref — in the inbox or already in history. */
function delivered(home, task, participant, message) {
    return existsSync(inboxRef(home, task, participant, message))
        || existsSync(historyRef(home, task, participant, message));
}
/** Threshold after which an unclosed intent is treated as abandoned.
 * [reference/04-protocol.md#intent_stale_ms--threshold-after-which-an-unclosed-intent-is-treated-as-abandoned-regardless](../../docs/reference/04-protocol.md#intent_stale_ms--threshold-after-which-an-unclosed-intent-is-treated-as-abandoned-regardless) */
export const INTENT_STALE_MS = 30_000;
/** Writing a message into a mailbox.
 * [reference/04-protocol.md#leaseintent--lease-who-is-writing-this-fan-out-right-now](../../docs/reference/04-protocol.md#leaseintent--lease-who-is-writing-this-fan-out-right-now) */
function leaseIntent(intent) {
    try {
        writeFileSync(ownerOfIntent(intent), `${JSON.stringify({ pid: process.pid, host: os.hostname() })}\n`, { flag: 'w' });
    }
    catch {
        // No lease — recovery will pick the intent up by age, not by owner liveness.
    }
}
/** Lease record; `null` — there is no lease, it is unreadable, or it is incomplete. */
function readLease(file) {
    try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        const { pid, host } = raw;
        if (!Number.isInteger(pid) || typeof host !== 'string')
            return null;
        return { pid: pid, host };
    }
    catch {
        return null;
    }
}
/** Whether an unclosed intent is abandoned — that is, whether recovery may touch it.
 * [reference/04-protocol.md#abandonedintent--whether-an-unclosed-intent-is-abandoned--that-is-whether-recovery-may](../../docs/reference/04-protocol.md#abandonedintent--whether-an-unclosed-intent-is-abandoned--that-is-whether-recovery-may) */
function abandonedIntent(intent) {
    let age;
    try {
        age = Date.now() - statSync(intent).mtimeMs;
    }
    catch {
        // The intent was taken between the directory listing and the check — nothing to recover.
        return false;
    }
    if (age >= INTENT_STALE_MS)
        return true;
    const lease = readLease(ownerOfIntent(intent));
    if (!lease || lease.host !== os.hostname())
        return false;
    return lease.pid === process.pid || !pidAlive(lease.pid);
}
/** Step 2: create the intent. Atomic `open(O_EXCL)` — the commit point of the whole fan-out. */
function openIntent(home, task, message) {
    mkdirSync(intentsDir(home, task), { recursive: true });
    const intent = intentFile(home, task, message.id);
    writeFileSync(intent, `${JSON.stringify(message, null, 2)}\n`, { flag: 'wx' });
    // The lease AFTER the intent, not before: an orphaned lease describes nobody's fan-out, and the
    // "intent there, lease not yet" window is closed by age.
    leaseIntent(intent);
}
/** Step 3: link the canon to the intent, idempotent. There is no "already there" check before the
 * link — `EEXIST` says it; `ENOENT` on the source means another took the fan-out to the end. */
function materialize(home, task, message, fault = NO_FAULT) {
    const canonical = messageFile(home, task, message);
    try {
        return linkOnce(intentFile(home, task, message), canonical, fault);
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
        if (existsSync(canonical))
            return false;
        return fail('link-refused', `intent is gone and there is no canon: ${canonical}`, { task, message, target: canonical, errno: 'ENOENT' });
    }
}
/** Steps 3–5 in one pass: the canon, refs for recipients, drop the intent. Called by both send and
 * recovery — exactly one code, or recovery would repair something other than what broke. */
export function completeFanout(home, task, message, fault = NO_FAULT) {
    materialize(home, task, message.id, fault);
    fault('canonical', { task, message: message.id });
    const fresh = [];
    for (const [index, recipient] of message.recipients.entries()) {
        // Fresh — those who must be woken: a recipient is counted for the process whose ref landed, or
        // two recoverers would both name it fresh and send two activation events for one message.
        if (!delivered(home, task, recipient, message.id)
            && linkOnce(messageFile(home, task, message.id), inboxRef(home, task, recipient, message.id), fault)) {
            fresh.push(recipient);
        }
        fault('ref', { task, message: message.id, recipient, index });
    }
    // Step 5, only after refs for ALL: an intent dropped earlier would take the only trace of the
    // undelivered with it. The lease leaves with it — a closed fan-out needs no owner.
    const intent = intentFile(home, task, message.id);
    withMessageCommit(home, () => {
        rmSync(intent, { force: true });
        rmSync(ownerOfIntent(intent), { force: true });
    });
    fault('close', { task, message: message.id });
    return fresh;
}
/** How much unread sits with the participant. */
export function countInbox(home, task, participant) {
    return inboxNames(inboxDir(home, task, participant)).length;
}
export function inboxIdentity(home, task, participant) {
    try {
        return { ids: inboxNames(inboxDir(home, task, participant), true).map(name => name.slice(0, -5)), complete: true };
    }
    catch {
        return { ids: [], complete: false };
    }
}
function inboxNames(dir, strict = false) {
    try {
        return readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
    }
    catch (e) {
        if (strict && e.code !== 'ENOENT')
            throw e;
        return [];
    }
}
/** Assemble the activation event for a participant: what sits with them and how to wake them. */
export function eventFor(home, task, participant, messages) {
    return {
        kind: 'unread',
        task,
        address: participant.id,
        ref: participant.sessionRef,
        unread: countInbox(home, task, participant.id),
        messages: messages.map(previewOf),
    };
}
/** Assemble a canonical message. Validation is on the caller's side, before the first write. */
export function newMessage(task, sender, recipients, type, body, artifact, now, originTask) {
    return {
        protocolVersion: MESSAGE_PROTOCOL_VERSION,
        id: newRecordId(now),
        task,
        ...(originTask ? { originTask } : {}),
        sender,
        recipients: [...recipients],
        type,
        body,
        ...(artifact ? { artifact } : {}),
        ts: now.toISOString(),
    };
}
/** Reserve store order under the message-commit lock, then publish the intent. */
export function commitIntent(home, task, message, now, fault = NO_FAULT) {
    return withMessageCommit(home, () => {
        const current = { ...message, id: reserveMessageId(home, now) };
        fault('order-reserved', { task, message: current.id });
        openIntent(home, task, current);
        return current;
    });
}
/** Where the record went: the directory, or the reason setting it aside failed. */
function isolate(from, atticDir, name) {
    try {
        mkdirSync(atticDir, { recursive: true });
        renameSync(from, path.join(atticDir, name));
        return { attic: atticDir, failure: null };
    }
    catch (e) {
        return { attic: null, failure: e.message };
    }
}
function readRecord(file, name, attic) {
    const raw = readFileSync(file, 'utf8');
    let parsed = null;
    let code = '';
    let note = '';
    try {
        parsed = JSON.parse(raw);
    }
    catch (e) {
        code = 'schema-invalid';
        note = 'did not parse (' + e.message + ')';
    }
    if (!code) {
        const verdict = validate('message', parsed);
        if (!verdict.ok) {
            code = verdict.code;
            note = 'does not match the schema: ' + verdict.at + ' ' + verdict.note;
        }
    }
    if (code) {
        // A future schema stays in place: it is unsupported, not corrupt.
        const where = code === 'schema-version-unsupported' || attic === null
            ? { attic: null, failure: null }
            : isolate(file, attic, name);
        return { broken: { name, code, note, ...where } };
    }
    return { message: parsed };
}
/** Take incoming and move the refs to history. No processing ack and no exactly-once: the mailbox
 * keeps a message until read, and that is all. Order is by file name, which is send order. */
export function readInbox(home, task, participant, fault = NO_FAULT) {
    const dir = inboxDir(home, task, participant);
    const messages = [];
    const broken = [];
    const names = inboxNames(dir);
    // The history directory is created here, not on the first send: `rename` of a ref needs a ready
    // parent, and creating it empty for every participant is unnecessary.
    if (names.length)
        ensureHistoryDir(home, task, participant);
    for (const name of names) {
        const file = path.join(dir, name);
        let record;
        try {
            fault('inbox-read', { task, participant, name, mode: 'read' });
            record = readRecord(file, name, brokenInboxDir(home, task, participant));
        }
        catch (e) {
            // A neighbour took it between the listing and the read — a skip, not a refusal: the second
            // reader took the message, and that reader will deliver it.
            if (e.code === 'ENOENT')
                continue;
            const errno = e.code;
            if (typeof errno !== 'string')
                throw e;
            broken.push({ name, code: errno, note: e.message, attic: null, failure: null });
            continue;
        }
        if ('broken' in record) {
            broken.push(record.broken);
            continue;
        }
        try {
            fault('history-ref', { task, participant, name });
            renameSync(file, historyRef(home, task, participant, record.message.id));
        }
        catch (e) {
            // ENOENT here is the same neighbour. A refusal from the MIDDLE of the walk would strand refs
            // already moved: report it, leave this one in the inbox, and return what moved.
            const errno = e.code;
            if (errno === 'ENOENT')
                continue;
            if (typeof errno !== 'string')
                throw e;
            broken.push({ name, code: errno, note: e.message, attic: null, failure: null });
            continue;
        }
        messages.push(record.message);
    }
    fault('read', { task, participant, taken: messages.length });
    return { messages, broken };
}
// history/<participant> is created lazily, like inbox: the directory appears with the first read.
export function ensureHistoryDir(home, task, participant) {
    mkdirSync(historyDir(home, task, participant), { recursive: true });
}
/** Order key: the message id, and on a tie the participant. **The cursor is this key WHOLE**, not the
 * message id: the limit counts RECORDS, and an id cursor would leave records on no page at all. */
function orderKey(message, participant) {
    return `${message} ${participant}`;
}
/** Compare order keys — one comparison for both sort and cursor cut, or the page boundary would stop
 * matching itself. `localeCompare` is no good: it depends on the locale, and the key is machine-made. */
function byKey(a, b) {
    if (a < b)
        return -1;
    return a > b ? 1 : 0;
}
/** Task history: what was read, old to new, last 50 records by default. Unread is not here — it sits
 * in the mailbox, and fan-out recovery stands on telling delivered from read. */
export function history(home, tasks, { participant, limit = 50, before, all = false, strict = false }) {
    const refs = [];
    for (const task of tasks) {
        const root = historyRoot(home, task);
        let boxes;
        try {
            boxes = readdirSync(root);
        }
        catch (e) {
            if (strict && e.code !== 'ENOENT')
                throw e;
            continue;
        }
        for (const box of boxes) {
            if (participant && box !== participant)
                continue;
            for (const name of inboxNames(path.join(root, box), strict)) {
                const id = name.slice(0, -'.json'.length);
                refs.push({ key: orderKey(id, box), task, participant: box, file: path.join(root, box, name) });
            }
        }
    }
    refs.sort((a, b) => byKey(a.key, b.key));
    // Exclusive cursor: the page returns records strictly OLDER than it, so there are no repeats on
    // the boundary. The comparison is the one the records were sorted with.
    const older = before ? refs.filter((r) => byKey(r.key, before) < 0) : refs;
    const page = all ? older : older.slice(Math.max(0, older.length - Math.max(0, limit)));
    const entries = [];
    const broken = [];
    for (const ref of page) {
        let record;
        try {
            record = readRecord(ref.file, path.basename(ref.file), null);
        }
        catch (e) {
            broken.push({ name: path.basename(ref.file), code: 'schema-invalid', note: e.message, attic: null, failure: null });
            continue;
        }
        if ('broken' in record) {
            broken.push(record.broken);
            continue;
        }
        entries.push({ task: ref.task, participant: ref.participant, message: record.message });
    }
    const first = page[0];
    const hasOlder = Boolean(first) && older.length > page.length;
    return { entries, cursor: hasOlder ? first.key : null, broken };
}
/** Recover fan-out of one task: walk unclosed intents and write what is missing. Idempotent by
 * construction; a classified refusal for one message does not stop recovery of its neighbours. */
export function recoverTask(home, task, meta, fault = NO_FAULT) {
    const repairs = [];
    const events = [];
    const broken = [];
    const failed = [];
    let entries;
    try {
        entries = readdirSync(intentsDir(home, task)).sort();
    }
    catch {
        return { repairs, events, broken, failed };
    }
    const names = entries.filter((n) => n.endsWith('.json') && !n.startsWith('.'));
    for (const name of names) {
        const file = path.join(intentsDir(home, task), name);
        // The lease gate stands BEFORE the record is parsed: a live neighbour's torn record is lawful
        // too — `wx` creates the file atomically and the contents land after.
        if (!abandonedIntent(file))
            continue;
        let raw;
        try {
            fault('intent-read', { task, name });
            raw = readFileSync(file, 'utf8');
        }
        catch (e) {
            if (e.code === 'ENOENT')
                continue;
            const errno = e.code;
            if (typeof errno !== 'string')
                throw e;
            broken.push({ name, code: errno, note: e.message, attic: null, failure: null });
            continue;
        }
        let parsed = null;
        let code = '';
        let note = '';
        try {
            parsed = JSON.parse(raw);
        }
        catch (e) {
            code = 'schema-invalid';
            note = `intent did not parse (${e.message})`;
        }
        if (!code) {
            const verdict = validate('message', parsed);
            if (!verdict.ok) {
                code = verdict.code;
                note = `intent does not match the schema: ${verdict.at} ${verdict.note}`;
            }
        }
        if (code) {
            // A torn intent record is the only corruption a crash inside the commit point produces: the
            // send did not return then, and there was no message for the sender.
            const where = code === 'schema-version-unsupported'
                ? { attic: null, failure: null }
                : withMessageCommit(home, () => {
                    const isolated = isolate(file, brokenMessagesDir(home, task), name);
                    // Quarantine and lease removal cannot disappear between strict snapshot listings.
                    if (isolated.attic)
                        rmSync(ownerOfIntent(file), { force: true });
                    return isolated;
                });
            broken.push({ name, code, note, ...where });
            continue;
        }
        const message = parsed;
        const hadCanonical = existsSync(messageFile(home, task, message.id));
        let fresh;
        try {
            fault('intent-materialize', { task, message: message.id });
            fresh = completeFanout(home, task, message, fault);
        }
        catch (e) {
            // Classified refusals leave the intent. Link ENOENT is intent-lost; a directory
            // refusal is not — the intent is still the only copy. Anything else escapes.
            if (!(e instanceof PromptobusError))
                throw e;
            if (e.code !== 'link-refused' && e.code !== 'dir-blocked' && e.code !== 'dir-occupied')
                throw e;
            const failureCode = e.code === 'link-refused' && e.context.errno === 'ENOENT' ? 'intent-lost' : e.code;
            failed.push({ task, message: message.id, code: failureCode, note: e.message });
            continue;
        }
        repairs.push({ task, message: message.id, recipients: fresh, canonical: !hadCanonical });
        for (const id of fresh) {
            const who = meta.participants.find((p) => p.id === id);
            // A recipient no longer in the journal still gets the ref — it would have sat there without
            // the crash too. There is nobody to wake, so no event for them.
            if (who)
                events.push(eventFor(home, task, who, [message]));
        }
    }
    sweepLeases(intentsDir(home, task), entries);
    return { repairs, events, broken, failed };
}
/** Remove leases that have nothing to describe. The decision comes from ONE listing and is never
 * atomic — but the error is one-sided: a swept live lease only makes recovery more careful. */
function sweepLeases(dir, entries) {
    const open = new Set(entries.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length)));
    for (const name of entries) {
        if (!name.endsWith('.owner') || open.has(name.slice(0, -'.owner'.length)))
            continue;
        rmSync(path.join(dir, name), { force: true });
    }
}
export { messagesDir };
/** Look into the mailbox without touching anything: refs stay and do not go to history. Broken ones
 * are still set aside, or one unreadable record would return to the reader on every visit. */
export function peekInbox(home, task, participant, fault = NO_FAULT) {
    return inspectRefs(home, task, participant, fault, 'peek');
}
/** Validate unread records without consuming or isolating their refs. */
export function inspectInbox(home, task, participant, fault = NO_FAULT) {
    return inspectRefs(home, task, participant, fault, 'inspect');
}
function inspectRefs(home, task, participant, fault, mode) {
    const dir = inboxDir(home, task, participant);
    const messages = [];
    const broken = [];
    for (const name of inboxNames(dir, mode === 'inspect')) {
        const file = path.join(dir, name);
        let record;
        try {
            fault('inbox-read', { task, participant, name, mode });
            record = readRecord(file, name, mode === 'peek' ? brokenInboxDir(home, task, participant) : null);
        }
        catch (e) {
            // The owner took it between the listing and the read: they will deliver the message.
            if (e.code === 'ENOENT')
                continue;
            // Any other refusal is present-and-broken, never absent
            // ([01-overview](../../docs/reference/01-overview.md) § Store home).
            const errno = e.code;
            if (typeof errno !== 'string')
                throw e;
            broken.push({ name, code: errno, note: e.message, attic: null, failure: null });
            continue;
        }
        if ('broken' in record) {
            broken.push(record.broken);
            continue;
        }
        messages.push(record.message);
    }
    return { messages, broken };
}
/** Glance without consuming: no refs moved. A refusal or a record that does not parse is named
 * in `broken` and left in place — setting it aside would vanish into ignored supervisor diagnostics. */
export function glanceInbox(home, task, participant, fault = NO_FAULT) {
    const dir = inboxDir(home, task, participant);
    const messages = [];
    const broken = [];
    for (const name of inboxNames(dir)) {
        let raw;
        try {
            fault('inbox-read', { task, participant, name, mode: 'glance' });
            raw = readFileSync(path.join(dir, name), 'utf8');
        }
        catch (e) {
            // The owner took it between the listing and the read: they will deliver the message.
            if (e.code === 'ENOENT')
                continue;
            const errno = e.code;
            if (typeof errno !== 'string')
                throw e;
            broken.push({ name, code: errno, note: e.message, attic: null, failure: null });
            continue;
        }
        try {
            messages.push(JSON.parse(raw));
        }
        catch (e) {
            // Named, not set aside: the consuming read is what isolates it.
            broken.push({
                name, code: 'schema-invalid', note: `did not parse (${e.message})`,
                attic: null, failure: null,
            });
        }
    }
    return { messages, broken };
}
/** When the participant last SENT on the bus. The record name carries no sender, so the parse is
 * **incremental**: each record is read once per process, since the canon is immutable. */
const sentSeen = new Map();
export function lastSentAt(home, task, participant) {
    const dir = messagesDir(home, task);
    let hit = sentSeen.get(dir);
    if (!hit) {
        hit = { seen: new Set(), last: new Map() };
        sentSeen.set(dir, hit);
    }
    // Directories are created lazily: no directory — `inboxNames` returns an empty list.
    for (const name of inboxNames(dir)) {
        if (hit.seen.has(name))
            continue;
        hit.seen.add(name);
        try {
            const m = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
            const at = Date.parse(m.ts);
            if (!Number.isFinite(at))
                continue;
            if (!hit.last.has(m.sender) || hit.last.get(m.sender) < at)
                hit.last.set(m.sender, at);
        }
        catch {
            // A broken message does not name its sender — the walk continues.
        }
    }
    return hit.last.get(participant) ?? null;
}
