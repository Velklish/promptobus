import { rebuildMessageOrder, strictCommittedMessages, validOrderId, withMessageCommit } from './message-order.js';
// The engine: the door every protocol write goes through.
// [reference/04-protocol.md#the-engine-the-door-every-protocol-write-goes-through](../../docs/reference/04-protocol.md#the-engine-the-door-every-protocol-write-goes-through)
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { isAddress } from '../protocol.js';
import { blobStats, listArtifacts, nameOf, newArtifact, orphanBlobs, readArtifact, readBlob, stashBlob, stashBlobSync, writeArtifact, } from './artifacts.js';
import { fail } from './errors.js';
import { artifactFile, blobFile, brokenInboxDir, historyDir, homeOf, inboxDir, ROOT_DIR, taskDir, taskFile, tasksDir, } from './layout.js';
import { commitIntent, completeFanout, countInbox, eventFor, glanceInbox, history as historyOf, inboxIdentity, inspectInbox, lastSentAt as lastSentAtOf, newMessage, newRecordId, peekInbox, readInbox, recoverTask, } from './messages.js';
import { MESSAGE_TYPES_V1, TASK_ID_RE } from './model.js';
import { addParticipant, assignParticipant, claimOwner, closeTask, createTask, listTasks, patchParticipant, putParticipant, recoverTaskLinks, readTask, requireActive, requireParticipant, taskExists, withBlobLock, withBlobLockAsync, withTaskLock, writeTask, } from './store.js';
import { requireValid } from './validate.js';
const NO_FAULT = () => { };
/**
 * Open the engine. Without a routing policy — a refusal HERE, not on the
 * first send: a bus whose rule will appear later lets everything through
 * until then.
 */
export function openEngine({ root, home: at, policy, now = () => new Date(), faults = NO_FAULT, recover = true, cli = null, }) {
    if (typeof policy !== 'function') {
        fail('policy-required', 'routing policy is required: an engine without a who-may-write-to-whom rule does not open');
    }
    if ((root === undefined) === (at === undefined)) {
        fail('schema-invalid', 'the engine opens on exactly one of: the workspace root, or the store home itself');
    }
    const home = at ?? homeOf(root);
    const normalizedHome = path.resolve(home);
    const pending = [path.join(normalizedHome, 'migrating.json')];
    const homeName = path.basename(normalizedHome);
    if (homeName === ROOT_DIR)
        pending.push(`${normalizedHome}.migrating`, `${normalizedHome}.migrating.lock`);
    const unfinished = homeName === `${ROOT_DIR}.migrating` || homeName === `${ROOT_DIR}.migrating.lock`
        ? normalizedHome : pending.find(existsSync);
    if (unfinished) {
        fail('schema-invalid', `unfinished store conversion at ${unfinished}; finish the upgrade with promptobus v0.28.0 before opening ${home}`, { home, file: unfinished });
    }
    let names;
    try {
        names = readdirSync(tasksDir(home));
    }
    catch {
        names = [];
    }
    for (const id of names.filter(name => TASK_ID_RE.test(name))) {
        let raw;
        try {
            raw = JSON.parse(readFileSync(taskFile(home, id), 'utf8'));
        }
        catch {
            continue;
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            continue;
        const meta = raw;
        if (Object.hasOwn(meta, 'schemaVersion') || meta.id !== id
            || (meta.status !== 'active' && meta.status !== 'done'))
            continue;
        const participants = meta.participants;
        if (Array.isArray(participants) && participants.length > 0 && participants.every(p => p && typeof p === 'object' && isAddress(p.address) && !Object.hasOwn(p, 'id'))) {
            fail('schema-version-unsupported', `former store format at ${taskFile(home, id)} is unsupported; upgrade with promptobus v0.28.0 before opening ${home}`, { home, task: id, file: taskFile(home, id) });
        }
    }
    function decide(sender, recipient, meta, type) {
        const decision = policy(sender, recipient, meta, type);
        if (decision && decision.allow === true)
            return;
        // Not a decision at all is also a refusal: a policy that returned garbage
        // must not be read as permission. A silent pass here would cost exactly
        // what the policy is required for.
        const reason = decision && typeof decision.reason === 'string'
            ? decision.reason
            : 'policy returned no decision';
        fail('policy-denied', `${sender.id} → ${recipient.id}: ${reason}`, { task: meta.id, sender: sender.id, recipient: recipient.id, reason });
    }
    /** Step 1: everything checked BEFORE the first side effect. One for both send branches. */
    function prepare(task, input) {
        const meta = requireActive(readTask(home, task, cli));
        const sender = requireParticipant(meta, input.from);
        if (!Array.isArray(input.to) || !input.to.length) {
            fail('recipients-empty', 'recipient list is empty', { task });
        }
        if (new Set(input.to).size !== input.to.length) {
            fail('recipients-duplicate', `duplicate recipients: ${input.to.join(', ')}`, { task, to: input.to });
        }
        const recipients = input.to.map((id) => requireParticipant(meta, id));
        if (typeof input.type !== 'string' || !MESSAGE_TYPES_V1.includes(input.type)) {
            fail('message-type-unknown', `type «${String(input.type)}» is not a v1 protocol type: ${MESSAGE_TYPES_V1.join(', ')}`, { task, type: input.type });
        }
        if (typeof input.body !== 'string' || !input.body) {
            fail('schema-invalid', 'body is empty — a message with no text is not sent', { task });
        }
        if (input.originTask !== undefined
            && (typeof input.originTask !== 'string' || !TASK_ID_RE.test(input.originTask))) {
            fail('schema-invalid', 'originTask must be a task id', { task });
        }
        // At the WRITE and not in `validate`: reading is retroactive, and records of this shape
        // sit in live journals ([04-protocol](../../docs/reference/04-protocol.md) § Validation).
        if (input.type === 'artifact' && !input.artifact && !input.linkArtifact) {
            fail('schema-invalid', 'type «artifact» with no artifact — a message of this type carries a file: '
                + 'attach one with artifact, or name one already in the task with linkArtifact', { task, type: input.type });
        }
        // Presence, not a read: `readArtifact` sets a corrupt record aside, and prevalidation must
        // leave the task untouched. A broken record is classified by whoever reads it next.
        if (input.linkArtifact && !existsSync(artifactFile(home, task, input.linkArtifact))) {
            fail('artifact-not-found', `artifact ${input.linkArtifact} is not in task ${task}`, { task, artifact: input.linkArtifact, file: artifactFile(home, task, input.linkArtifact) });
        }
        for (const recipient of recipients)
            decide(sender, recipient, meta, input.type);
        faults('validate', { task, message: null });
        return { meta, sender, recipients };
    }
    /** Steps 2–5: the commit point, fan-out, and "who to wake" events. Also one for both send branches. */
    function finish(task, sender, recipients, input, artifact) {
        const draft = newMessage(task, sender.id, input.to, input.type, input.body, artifact?.id ?? input.linkArtifact ?? null, now(), input.originTask);
        requireValid('message', draft, { task });
        const message = withTaskLock(home, task, () => withMessageCommit(home, () => {
            requireActive(readTask(home, task, cli));
            const committed = commitIntent(home, task, draft, now(), faults);
            if (input.type === 'task' || input.type === 'review') {
                const meta = readTask(home, task, cli);
                writeTask(home, { ...meta, participants: meta.participants.map(participant => input.to.includes(participant.id)
                        ? { ...participant, metadata: { ...participant.metadata, assignmentAfterId: committed.id } } : participant) }, now);
            }
            return committed;
        }));
        faults('intent', { task, message: message.id });
        completeFanout(home, task, message, faults);
        // Activation is NOT here: the engine returns a "who to wake" list, and
        // the supervisor wakes them through the participant's driver — independently
        // per recipient, after the fan-out is on disk.
        return { message, artifact, events: recipients.map((r) => eventFor(home, task, r, [message])) };
    }
    const engine = {
        home,
        createTask: (input) => createTask(home, input, now, faults, cli),
        readTask: (task) => readTask(home, task, cli, faults),
        listTasks: () => listTasks(home, cli, faults),
        taskExists: (task) => taskExists(home, task),
        rebuildMessageOrder: () => rebuildMessageOrder(home),
        assignParticipant: (task, participant) => assignParticipant(home, task, participant, now, cli),
        inboxIdentity: (task, participant) => inboxIdentity(home, task, participant),
        facts: (task) => {
            const recovery = engine.recover(task);
            if (recovery.broken.length || recovery.failed.length || recovery.linkFailures.length)
                fail('schema-invalid', 'Canonical committed evidence requires explicit repair before facts', { task });
            return withTaskLock(home, task, () => withMessageCommit(home, () => {
                const meta = readTask(home, task, cli, faults);
                for (const participant of meta.participants) {
                    const boundary = participant.metadata.assignmentAfterId;
                    if (boundary !== undefined && boundary !== null && !validOrderId(boundary))
                        fail('schema-invalid', 'Canonical assignment boundary requires explicit repair', { task });
                }
                try {
                    return { task: meta, messages: strictCommittedMessages(home, task) };
                }
                catch (error) {
                    if (/unresolved task intent/.test(error.message))
                        throw error;
                    return fail('schema-invalid', 'Canonical committed evidence requires explicit repair before facts', { task });
                }
            }));
        },
        closeTask: (task, patch = {}) => closeTask(home, task, now, patch.adapter, cli),
        patchTask: (task, patch) => withTaskLock(home, task, () => {
            const meta = readTask(home, task, cli);
            return writeTask(home, {
                ...meta,
                ...(patch.title === undefined ? {} : { title: patch.title }),
                ...(patch.adapter === undefined ? {} : { adapter: { ...meta.adapter, ...patch.adapter } }),
            }, now);
        }),
        addParticipant: (task, participant) => addParticipant(home, task, participant, now, cli),
        putParticipant: (task, participant) => putParticipant(home, task, participant, now, cli),
        taskFile: (task) => taskFile(home, task),
        inboxPath: (task, participant) => inboxDir(home, task, participant),
        historyPath: (task, participant) => historyDir(home, task, participant),
        brokenPath: (task, participant) => brokenInboxDir(home, task, participant),
        patchParticipant: (task, id, patch) => patchParticipant(home, task, id, patch, now, cli),
        claimOwner: (task, id) => claimOwner(home, task, id, now, cli),
        async send(task, input) {
            const { sender, recipients } = prepare(task, input);
            // --- artifact: after policy, before the message -----------------------------------
            // The order is required: a policy refusal must not leave a blob in the
            // task. The digest is computed as a stream, on the write pass — the
            // source may be a stream, and it has no second read at all.
            let artifact = null;
            if (input.artifact) {
                // The name is computed BEFORE the blob is written: a bad one, caught
                // by the schema only after, would leave payload in the task with no
                // metadata — an orphan blob until `prune`.
                const filename = nameOf(input.artifact);
                const source = input.artifact;
                // Payload and record under one short lock: between them the payload is named by
                // nothing, and a sweep running in that window takes it from under this send.
                artifact = await withBlobLockAsync(home, task, async () => {
                    const { sha256, size } = await stashBlob(home, task, source);
                    faults('blob', { task, sha256 });
                    return writeArtifact(home, task, newArtifact(newRecordId(now()), sha256, filename, size));
                });
                faults('artifact', { task, artifact: artifact.id });
            }
            return finish(task, sender, recipients, input, artifact);
        },
        sendSync(task, input) {
            const { sender, recipients } = prepare(task, input);
            let artifact = null;
            if (input.artifact) {
                const source = input.artifact;
                // The source name is checked BEFORE the blob is written — the same as
                // the streaming branch: a bad one, caught only after, would leave
                // payload in the task with no metadata, an orphan blob on a flat path.
                nameOf({ path: source.path });
                // Payload, name and record under one short lock, for the reason the streaming
                // branch gives: the `files/` link and the record both land inside it.
                artifact = withBlobLock(home, task, () => {
                    const { sha256, size } = stashBlobSync(home, task, source.path);
                    faults('blob', { task, sha256 });
                    // The name a person will see the record under is given by the adapter
                    // and AFTER the blob: name dedup without a digest is impossible. It
                    // is checked by the same `nameOf`.
                    const filename = nameOf({ path: source.path, filename: source.name?.(sha256, size) });
                    return writeArtifact(home, task, newArtifact(newRecordId(now()), sha256, filename, size));
                });
                faults('artifact', { task, artifact: artifact.id });
            }
            return finish(task, sender, recipients, input, artifact);
        },
        read(task, participant) {
            // Reading a closed task is lawful: `requireActive` has nothing to do
            // here — the correspondence stays a journal after close.
            requireParticipant(readTask(home, task, cli), participant);
            return readInbox(home, task, participant, faults);
        },
        peek: (task, participant) => peekInbox(home, task, participant, faults),
        glance: (task, participant) => glanceInbox(home, task, participant).messages,
        inspectInbox: (task, participant) => inspectInbox(home, task, participant, faults),
        unread: (task, participant) => countInbox(home, task, participant),
        lastSentAt: (task, participant) => lastSentAtOf(home, task, participant),
        linkBlob(task, sha256, target) {
            mkdirSync(path.dirname(target), { recursive: true });
            try {
                linkSync(blobFile(home, task, sha256), target);
                return true;
            }
            catch (e) {
                if (e.code === 'EEXIST')
                    return false;
                throw e;
            }
        },
        history(query = {}) {
            const tasks = query.task ? [query.task] : listTasks(home, cli).tasks.map((t) => t.id);
            return historyOf(home, tasks, query);
        },
        recover(task) {
            const taskLinks = recoverTaskLinks(home, now, task, cli);
            const metas = task ? [readTask(home, task, cli)] : listTasks(home, cli).tasks;
            const out = { repairs: [], ...taskLinks, events: [], broken: [], failed: [] };
            for (const meta of metas) {
                const one = recoverTask(home, meta.id, meta, faults);
                out.repairs.push(...one.repairs);
                out.events.push(...one.events);
                out.broken.push(...one.broken);
                out.failed.push(...one.failed);
            }
            return out;
        },
        readArtifact: (task, id) => readArtifact(home, task, id, faults),
        readArtifactContent: (task, id) => readBlob(home, task, readArtifact(home, task, id, faults), faults),
        listArtifacts: (task) => listArtifacts(home, task),
        orphanBlobs: (task) => orphanBlobs(home, task),
        /**
         * Wipe the task whole, blobs included. A blob is deduplicated inside the
         * task, and it is "nobody's" only until the next send of the same
         * payload — so blobs are never removed one by one, they leave with the task.
         */
        prune(task) {
            const meta = readTask(home, task, cli);
            if (meta.status === 'active') {
                fail('task-active', `task ${task} is active — prune wipes its correspondence and blobs whole`, { task, status: meta.status });
            }
            const { count, bytes } = blobStats(home, task);
            rmSync(taskDir(home, task), { recursive: true, force: true });
            return { task, blobs: count, bytes };
        },
    };
    if (recover)
        engine.recover();
    return engine;
}
