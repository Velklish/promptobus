// Content-addressed v1 artifacts.
//
// The payload is addressed by SHA-256 and deduplicated inside the task; the
// file name lives separately, in metadata. The same payload under two names
// yields two metadata records and one blob. The blob is immutable and is
// deleted only with the task — `prune`.
//
// The digest is computed as a STREAM, on the write pass: reading the file
// twice would hash something other than what landed on disk — the source may
// change between the two reads.
import { createHash } from 'node:crypto';
import {
  createReadStream, createWriteStream, existsSync, linkSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { writeJsonAtomic } from '../fs/atomic.js';
import { fail, PromptobusError } from './errors.js';
import {
  artifactFile, artifactsDir, blobFile, blobOf, blobRef, blobsDir, brokenArtifactsDir,
} from './layout.js';
import { FILENAME_RE, SCHEMA_VERSION } from './model.js';
import type { ArtifactV1 } from './model.js';
import { requireValid, validate } from './validate.js';

/**
 * Artifact source: a file on disk or a stream. Nothing else — "a string as
 * payload" would invite putting on the bus what already sits in the message body.
 */
export type ArtifactSource =
  | { path: string; filename?: string }
  | { stream: NodeJS.ReadableStream; filename: string };

let tmpSeq = 0;

/**
 * Artifact file name — from the source. Called BEFORE the blob is written: a
 * bad name, caught by the schema only after, would leave payload in the task
 * with no metadata, an orphan blob on a flat path (review remark).
 */
export function nameOf(source: ArtifactSource): string {
  let name: string;
  if ('stream' in source) {
    if (typeof source.filename !== 'string' || !source.filename) {
      fail('artifact-source', 'the stream has no file name — there is no one to name it');
    }
    name = source.filename;
  } else {
    if (typeof source.path !== 'string' || !source.path) fail('artifact-source', 'artifact path is not named');
    name = source.filename || path.basename(source.path);
  }
  // The same grammar as the schema: a path separator in the name would mean
  // metadata addresses something outside the task. The schema checks it too —
  // but only on a record already on disk.
  if (!FILENAME_RE.test(name) || name === '.' || name === '..' || name.length > 255) {
    fail('artifact-source', `invalid artifact file name: «${name}»`, { filename: name });
  }
  return name;
}

function inputOf(source: ArtifactSource): NodeJS.ReadableStream {
  if ('stream' in source) return source.stream;
  if (!existsSync(source.path)) fail('artifact-source', `artifact is missing: ${source.path}`, { path: source.path });
  return createReadStream(source.path);
}

/**
 * Put the payload into a task blob. Returns the digest and the size.
 *
 * Written through a temporary neighbour, and put in place with `link`: a
 * taken name yields `EEXIST`, and that is not a refusal, it is dedup — the
 * payload under this digest is already there. A blob must not be overwritten
 * at all: it is immutable, and a second write on top would change the payload
 * for every metadata record at once.
 */
export async function stashBlob(home: string, task: string, source: ArtifactSource): Promise<{ sha256: string; size: number }> {
  const dir = blobsDir(home, task);
  mkdirSync(dir, { recursive: true });
  tmpSeq += 1;
  const tmp = path.join(dir, `.tmp-blob-${process.pid}-${tmpSeq}`);
  const hash = createHash('sha256');
  let size = 0;
  try {
    await pipeline(inputOf(source), async function* count(chunks: AsyncIterable<Buffer | string>) {
      for await (const chunk of chunks) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        hash.update(buf);
        size += buf.length;
        yield buf;
      }
    }, createWriteStream(tmp));
    const sha256 = hash.digest('hex');
    try {
      linkSync(tmp, blobFile(home, task, sha256));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // The same digest is already there — that is dedup inside the task.
      if (code !== 'EEXIST') throw linkFailure(e, blobFile(home, task, sha256));
    }
    return { sha256, size };
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * The same, synchronously, from a file. Made for an adapter whose send path
 * is synchronous whole (`sendSync` below): the bus MCP server answers
 * `tools/call` in one synchronous pass, and a promise in the middle of it
 * would rewrite the tool dispatcher for one artifact.
 *
 * The streaming-branch invariant is held, not loosened: the file is read
 * ONCE, and the digest is computed over the very bytes that will land in the
 * blob. The cost is the file size in memory; bus artifacts are a diff and a
 * contract, not a disk image.
 *
 * **The "one pass" property is structural, and no gate covers it.** It holds
 * because there is no window between read and write in the code at all:
 * one `readFileSync`, the digest is computed over that same buffer, and that
 * same buffer is written. There is nowhere to swap the payload "between two
 * reads", and a two-pass-edit probe paints nothing — so there is no check
 * for this property, not a green one. What is actually checked: the record
 * digest matches the blob payload, and a read refuses `artifact-integrity`
 * on a mismatch.
 */
export function stashBlobSync(home: string, task: string, file: string): { sha256: string; size: number } {
  if (typeof file !== 'string' || !file) fail('artifact-source', 'artifact path is not named');
  let content: Buffer;
  try {
    content = readFileSync(file);
  } catch {
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
    } catch (e) {
      // The same digest is already there — that is dedup inside the task.
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw linkFailure(e, blobFile(home, task, sha256));
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  return { sha256, size: content.length };
}

// Refusals with which the FS says "a hard link cannot be put here": a foreign
// volume, no hard links at all, no rights on the directory, the inode's link
// limit.
//
// `ENOENT` must not enter this list: `materialize` ([messages.ts](messages.ts))
// reads it as "a neighbour who materialized the message earlier took the
// intent" and for that compares the raw exception `code`. If `ENOENT` landed
// here, this would return a `PromptobusError` with code `link-refused`, the
// compare would not recognise it, and race tolerance would die in silence.
const LINK_REFUSALS = ['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EACCES', 'EMLINK'];

/**
 * Hard-link refusal — a typed code, not a bare errno.
 *
 * A filesystem without hard links and a link across a volume boundary are
 * lawful environment conditions, not a mechanism crash. The code answers them
 * so the adapter can tell a person in words; no half-written record is left —
 * fan-out breaks on the step, the intent stays open, and recovery will take
 * it to the end when the condition is lifted.
 */
export function linkFailure(e: unknown, target: string): Error {
  const code = (e as NodeJS.ErrnoException).code ?? '';
  if (LINK_REFUSALS.includes(code)) {
    return new PromptobusError('link-refused',
      `hard link was not created (${code}): ${target}`, { target, errno: code });
  }
  return e as Error;
}

/** Write artifact metadata. Validation before the write: the bad never enters the store. */
export function writeArtifact(home: string, task: string, meta: ArtifactV1): ArtifactV1 {
  requireValid('artifact', meta, { task, artifact: meta.id });
  writeJsonAtomic(artifactFile(home, task, meta.id), meta);
  return meta;
}

export function newArtifact(id: string, sha256: string, filename: string, size: number): ArtifactV1 {
  return { schemaVersion: SCHEMA_VERSION, id, sha256, filename, size, blob: blobRef(sha256) };
}

/**
 * Read metadata. Invalid metadata goes to `broken/artifacts` — one corrupt
 * record must not cost the task the rest.
 */
export function readArtifact(home: string, task: string, id: string): ArtifactV1 {
  const file = artifactFile(home, task, id);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    fail('artifact-not-found', `artifact ${id} is not in task ${task}`, { task, artifact: id });
  }
  let meta: unknown;
  try {
    meta = JSON.parse(raw);
  } catch (e) {
    isolateArtifact(home, task, `${id}.json`);
    fail('artifact-not-found', `artifact ${id} metadata did not parse (${(e as Error).message}) — set aside in broken`,
      { task, artifact: id });
  }
  const verdict = validate('artifact', meta);
  if (!verdict.ok) {
    // A record from the future does not go to `broken`: it is not corrupt, there is just nothing to read it with.
    if (verdict.code !== 'schema-version-unsupported') isolateArtifact(home, task, `${id}.json`);
    fail(verdict.code ?? 'schema-invalid',
      `artifact ${id} metadata does not match the schema: ${verdict.at} ${verdict.note}`,
      { task, artifact: id, at: verdict.at });
  }
  return meta as ArtifactV1;
}

function isolateArtifact(home: string, task: string, name: string): void {
  const attic = brokenArtifactsDir(home, task);
  try {
    mkdirSync(attic, { recursive: true });
    renameSync(path.join(artifactsDir(home, task), name), path.join(attic, name));
  } catch {
    // Setting it aside failed — that must not stop the reader: it already
    // refuses with a code, and the file stays in place under the same name.
  }
}

/**
 * Read the artifact payload, checking the digest. A mismatch is a typed
 * refusal, not a quiet read: a corrupt blob handed over as payload is the
 * case artifacts are hash-addressed for.
 */
export function readBlob(home: string, task: string, meta: ArtifactV1): Buffer {
  const file = blobOf(home, task, meta);
  let content: Buffer;
  try {
    content = readFileSync(file);
  } catch {
    fail('artifact-not-found', `blob ${meta.sha256} is not in task ${task}`,
      { task, artifact: meta.id, sha256: meta.sha256 });
  }
  const actual = createHash('sha256').update(content).digest('hex');
  if (actual !== meta.sha256) {
    fail('artifact-integrity',
      `artifact ${meta.id} blob does not match the digest: declared ${meta.sha256}, computed ${actual}`,
      { task, artifact: meta.id, declared: meta.sha256, actual });
  }
  if (content.length !== meta.size) {
    fail('artifact-integrity',
      `artifact ${meta.id} size does not match: declared ${meta.size}, on disk ${content.length}`,
      { task, artifact: meta.id, declared: meta.size, actual: content.length });
  }
  return content;
}

/** List the task's metadata records, skipping unreadable ones. */
export function listArtifacts(home: string, task: string): { artifacts: ArtifactV1[]; broken: string[] } {
  const artifacts: ArtifactV1[] = [];
  const broken: string[] = [];
  let names: string[];
  try {
    names = readdirSync(artifactsDir(home, task));
  } catch {
    return { artifacts, broken };
  }
  for (const name of names.filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort()) {
    try {
      artifacts.push(readArtifact(home, task, name.slice(0, -'.json'.length)));
    } catch (e) {
      broken.push(`${name}: ${(e as Error).message}`);
    }
  }
  return { artifacts, broken };
}

/**
 * Blobs no metadata record points at. They appear lawfully: a crash between
 * writing the blob and writing the metadata leaves payload with no name.
 * They must not be deleted one by one — a blob is deduplicated, and it is
 * "nobody's" only until the next send of the same payload; `prune` takes
 * them with the task.
 */
export function orphanBlobs(home: string, task: string): string[] {
  let names: string[];
  try {
    names = readdirSync(blobsDir(home, task));
  } catch {
    return [];
  }
  const used = new Set(listArtifacts(home, task).artifacts.map((a) => a.sha256));
  return names.filter((n) => !n.startsWith('.') && !used.has(n)).sort();
}

/** How many blobs and bytes sit with the task — for the `prune` report. */
export function blobStats(home: string, task: string): { count: number; bytes: number } {
  let names: string[];
  try {
    names = readdirSync(blobsDir(home, task)).filter((n) => !n.startsWith('.'));
  } catch {
    return { count: 0, bytes: 0 };
  }
  let bytes = 0;
  for (const name of names) {
    try {
      bytes += statSync(path.join(blobsDir(home, task), name)).size;
    } catch {
      // A neighbour took it between the listing and `stat` — not our problem: we count what remains.
    }
  }
  return { count: names.length, bytes };
}
