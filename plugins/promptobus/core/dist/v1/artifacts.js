// Artifacts: how a file becomes a message attachment.
// [reference/04-protocol.md#artifacts-how-a-file-becomes-a-message-attachment](../../docs/reference/04-protocol.md#artifacts-how-a-file-becomes-a-message-attachment)
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, lstatSync, renameSync, rmSync, statSync, writeFileSync, } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { writeJsonAtomic } from '../fs/atomic.js';
import { fail, PromptobusError } from './errors.js';
import { artifactFile, artifactsDir, blobFile, blobOf, blobRef, blobsDir, brokenArtifactsDir, } from './layout.js';
import { FILENAME_RE, SCHEMA_VERSION } from './model.js';
import { requireValid, validate } from './validate.js';
let tmpSeq = 0;
const NO_FAULT = () => { };
/** Artifact file name, from the source. Called BEFORE the blob is written: a bad name caught only by
 * the schema afterwards would leave payload in the task with no metadata. */
export function nameOf(source) {
    let name;
    if ('stream' in source) {
        if (typeof source.filename !== 'string' || !source.filename) {
            fail('artifact-source', 'the stream has no file name — there is no one to name it');
        }
        name = source.filename;
    }
    else {
        if (typeof source.path !== 'string' || !source.path)
            fail('artifact-source', 'artifact path is not named');
        name = source.filename || path.basename(source.path);
    }
    // The same grammar as the schema: a path separator in the name would mean metadata addressing
    // something outside the task. The schema checks it too — but only on a record already on disk.
    if (!FILENAME_RE.test(name) || name === '.' || name === '..' || name.length > 255) {
        fail('artifact-source', `invalid artifact file name: «${name}»`, { filename: name });
    }
    return name;
}
function inputOf(source) {
    if ('stream' in source)
        return source.stream;
    if (!existsSync(source.path))
        fail('artifact-source', `artifact is missing: ${source.path}`, { path: source.path });
    return createReadStream(source.path);
}
/** Put the payload into a task blob, returning digest and size. Put in place with `link`: `EEXIST` is
 * dedup, not a refusal. A blob is immutable — a second write would change it for every record. */
export async function stashBlob(home, task, source) {
    const dir = blobsDir(home, task);
    mkdirSync(dir, { recursive: true });
    tmpSeq += 1;
    const tmp = path.join(dir, `.tmp-blob-${process.pid}-${tmpSeq}`);
    const hash = createHash('sha256');
    let size = 0;
    let output;
    try {
        await pipeline(inputOf(source), async function* count(chunks) {
            for await (const chunk of chunks) {
                const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
                hash.update(buf);
                size += buf.length;
                yield buf;
            }
        }, output = createWriteStream(tmp));
        const sha256 = hash.digest('hex');
        try {
            linkSync(tmp, blobFile(home, task, sha256));
        }
        catch (e) {
            const code = e.code;
            // The same digest is already there — that is dedup inside the task.
            if (code !== 'EEXIST')
                throw linkFailure(e, blobFile(home, task, sha256));
        }
        return { sha256, size };
    }
    finally {
        // A source failure can reject pipeline before the writer opens and closes.
        // Wait for close so a late open cannot recreate the temporary file after removal.
        if (output && !output.closed) {
            const writer = output;
            const closed = new Promise((resolve) => writer.once('close', resolve));
            writer.destroy();
            await closed;
        }
        rmSync(tmp, { force: true });
    }
}
/** Putting a file into the task store as an artifact.
 * [reference/04-protocol.md#stashblobsync--the-same-synchronously-from-a-file](../../docs/reference/04-protocol.md#stashblobsync--the-same-synchronously-from-a-file) */
export function stashBlobSync(home, task, file) {
    if (typeof file !== 'string' || !file)
        fail('artifact-source', 'artifact path is not named');
    let content;
    try {
        content = readFileSync(file);
    }
    catch {
        fail('artifact-source', `artifact is missing: ${file}`, { path: file });
    }
    const sha256 = createHash('sha256').update(content).digest('hex');
    const dir = blobsDir(home, task);
    mkdirSync(dir, { recursive: true });
    tmpSeq += 1;
    const tmp = path.join(dir, `.tmp-blob-${process.pid}-${tmpSeq}`);
    try {
        writeFileSync(tmp, content);
        try {
            linkSync(tmp, blobFile(home, task, sha256));
        }
        catch (e) {
            // The same digest is already there — that is dedup inside the task.
            if (e.code !== 'EEXIST')
                throw linkFailure(e, blobFile(home, task, sha256));
        }
    }
    finally {
        rmSync(tmp, { force: true });
    }
    return { sha256, size: content.length };
}
// Refusals with which the FS says a hard link cannot be put here. `ENOENT` must NOT join this list:
// `materialize` reads it as "a neighbour took the intent" and compares the raw errno code.
const LINK_REFUSALS = ['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EACCES', 'EMLINK'];
/** Hard-link refusal as a typed code, not a bare errno: a filesystem without hard links is a lawful
 * environment condition. No half-written record is left — the intent stays open for recovery. */
export function linkFailure(e, target) {
    const code = e.code ?? '';
    if (LINK_REFUSALS.includes(code)) {
        return new PromptobusError('link-refused', `hard link was not created (${code}): ${target}`, { target, errno: code });
    }
    return e;
}
// Directory-half refusals. They stay off LINK_REFUSALS: a link EEXIST is idempotent success.
const DIR_BLOCKED = ['EROFS', 'ENOSPC'];
const DIR_OCCUPIED = ['EEXIST', 'ENOTDIR'];
// Both are occupied on the canonical directory and on a recipient one.
// A link ENOENT is the intent file gone; it is not a mkdir errno.
const DIR_BROKEN_LINK = ['ENOENT', 'ELOOP'];
// A file or a symlink at the path, or a file or symlink among its ancestors.
// A fault injection has no such node, so the attempted directory is named.
function occupiedPath(target) {
    let cur = target;
    for (;;) {
        try {
            const node = lstatSync(cur);
            if (node.isFile())
                return cur;
            // A directory symlink is an ordinary path. A dangling link or a loop is the stray.
            if (node.isSymbolicLink()) {
                try {
                    if (statSync(cur).isFile())
                        return cur;
                }
                catch {
                    return cur;
                }
            }
        }
        catch {
            // Missing or unreadable: the stray node may be an ancestor.
        }
        const parent = path.dirname(cur);
        if (parent === cur)
            return target;
        cur = parent;
    }
}
/** Mkdir refusal as its own typed code. A volume that may return is `dir-blocked`. A stray file,
 * a broken link (`ENOENT`), or a symlink loop (`ELOOP`) is `dir-occupied`. Any other errno stays raw. */
export function dirFailure(e, target) {
    const errno = e.code ?? '';
    if (DIR_BLOCKED.includes(errno)) {
        const when = errno === 'ENOSPC' ? 'the volume has space' : 'the volume is writable again';
        return new PromptobusError('dir-blocked', `directory was not created (${errno}) at ${target}. The message is committed; it is delivered once ${when} — do not resend`, { target, errno });
    }
    if (DIR_OCCUPIED.includes(errno) || DIR_BROKEN_LINK.includes(errno)) {
        const where = occupiedPath(target);
        const lead = DIR_BROKEN_LINK.includes(errno)
            ? `a stray or broken link at ${where} (${errno}): remove or move it`
            : `a file occupies ${where} (${errno}): remove or move that file`;
        return new PromptobusError('dir-occupied', `${lead}. The message is committed; it is delivered once the path is clear — do not resend`, { target: where, errno });
    }
    return e;
}
/** Write artifact metadata. Validation before the write: the bad never enters the store. */
export function writeArtifact(home, task, meta) {
    requireValid('artifact', meta, { task, artifact: meta.id });
    writeJsonAtomic(artifactFile(home, task, meta.id), meta);
    return meta;
}
export function newArtifact(id, sha256, filename, size) {
    return { schemaVersion: SCHEMA_VERSION, id, sha256, filename, size, blob: blobRef(sha256) };
}
/** Read metadata. Missing — `artifact-not-found`; another errno — `artifact-broken`. Invalid metadata
 * goes to `broken/artifacts`: one corrupt record must not cost the task the rest. */
export function readArtifact(home, task, id, fault = NO_FAULT) {
    const file = artifactFile(home, task, id);
    let raw;
    try {
        fault('artifact-read', { task, artifact: id, file });
        raw = readFileSync(file, 'utf8');
    }
    catch (e) {
        const errno = e.code;
        if (errno === 'ENOENT') {
            fail('artifact-not-found', `artifact ${id} is not in task ${task}`, { task, artifact: id, file, errno });
        }
        if (typeof errno !== 'string')
            throw e;
        fail('artifact-broken', `artifact ${id} metadata could not be read (${errno}): ${e.message}`, { task, artifact: id, file, errno });
    }
    let meta;
    try {
        meta = JSON.parse(raw);
    }
    catch (e) {
        isolateArtifact(home, task, `${id}.json`);
        fail('schema-invalid', `artifact ${id} metadata did not parse (${e.message}) — set aside in broken`, { task, artifact: id });
    }
    const verdict = validate('artifact', meta);
    if (!verdict.ok) {
        // A record from the future does not go to `broken`: it is not corrupt, there is just nothing to read it with.
        if (verdict.code !== 'schema-version-unsupported')
            isolateArtifact(home, task, `${id}.json`);
        fail(verdict.code ?? 'schema-invalid', `artifact ${id} metadata does not match the schema: ${verdict.at} ${verdict.note}`, { task, artifact: id, at: verdict.at });
    }
    return meta;
}
function isolateArtifact(home, task, name) {
    const attic = brokenArtifactsDir(home, task);
    try {
        mkdirSync(attic, { recursive: true });
        renameSync(path.join(artifactsDir(home, task), name), path.join(attic, name));
    }
    catch {
        // Setting it aside failed — that must not stop the reader: it already
        // refuses with a code, and the file stays in place under the same name.
    }
}
/** Read the artifact payload, checking the digest: a mismatch is a typed refusal, which is what
 * artifacts are hash-addressed for. Missing is `artifact-not-found`, another errno `artifact-broken`. */
export function readBlob(home, task, meta, fault = NO_FAULT) {
    const file = blobOf(home, task, meta);
    let content;
    try {
        fault('artifact-read', { task, artifact: meta.id, file });
        content = readFileSync(file);
    }
    catch (e) {
        const errno = e.code;
        if (errno === 'ENOENT') {
            fail('artifact-not-found', `blob ${meta.sha256} is not in task ${task}`, { task, artifact: meta.id, sha256: meta.sha256, file, errno });
        }
        if (typeof errno !== 'string')
            throw e;
        fail('artifact-broken', `blob ${meta.sha256} could not be read (${errno}): ${e.message}`, { task, artifact: meta.id, sha256: meta.sha256, file, errno });
    }
    const actual = createHash('sha256').update(content).digest('hex');
    if (actual !== meta.sha256) {
        fail('artifact-integrity', `artifact ${meta.id} blob does not match the digest: declared ${meta.sha256}, computed ${actual}`, { task, artifact: meta.id, declared: meta.sha256, actual });
    }
    if (content.length !== meta.size) {
        fail('artifact-integrity', `artifact ${meta.id} size does not match: declared ${meta.size}, on disk ${content.length}`, { task, artifact: meta.id, declared: meta.size, actual: content.length });
    }
    return content;
}
/** List the task's metadata records, skipping unreadable ones. */
export function listArtifacts(home, task) {
    const artifacts = [];
    const broken = [];
    let names;
    try {
        names = readdirSync(artifactsDir(home, task));
    }
    catch {
        return { artifacts, broken };
    }
    for (const name of names.filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort()) {
        try {
            artifacts.push(readArtifact(home, task, name.slice(0, -'.json'.length)));
        }
        catch (e) {
            broken.push(`${name}: ${e.message}`);
        }
    }
    return { artifacts, broken };
}
/** Blobs NOTHING names — no metadata record, no hard link beyond the blob file itself.
 *  Lawful, and never removed one by one; `prune` takes them: reference/04-protocol.md § Store layout. */
export function orphanBlobs(home, task) {
    let names;
    try {
        names = readdirSync(blobsDir(home, task));
    }
    catch {
        return [];
    }
    // One snapshot for the whole listing: every blob is judged against the same records, and
    // reading them per blob made a task of 400 artifacts take 3.8 s instead of 16 ms.
    const records = listArtifacts(home, task).artifacts;
    return names.filter((n) => !n.startsWith('.') && !blobNamed(home, task, n, records)).sort();
}
/** Whether anything still names this payload — one answer, for the sweep and for `prune`.
 * [reference/04-protocol.md#store-layout](../../docs/reference/04-protocol.md#store-layout) */
export function blobNamed(home, task, sha256, records = listArtifacts(home, task).artifacts) {
    // The snapshot is the caller's: whoever holds the publication lock reads it once under
    // the lock, and a listing reads it once for every blob it judges.
    if (records.some((a) => a.sha256 === sha256))
        return true;
    try {
        return statSync(blobFile(home, task, sha256)).nlink > 1;
    }
    catch {
        return false;
    }
}
/** How many blobs and bytes sit with the task — for the `prune` report. */
export function blobStats(home, task) {
    let names;
    try {
        names = readdirSync(blobsDir(home, task)).filter((n) => !n.startsWith('.'));
    }
    catch {
        return { count: 0, bytes: 0 };
    }
    let bytes = 0;
    for (const name of names) {
        try {
            bytes += statSync(path.join(blobsDir(home, task), name)).size;
        }
        catch {
            // A neighbour took it between the listing and `stat` — not our problem: we count what remains.
        }
    }
    return { count: names.length, bytes };
}
