import type { FaultHook } from './messages.js';
import type { ArtifactV1 } from './model.js';
/** Artifact source: a file on disk or a stream. Nothing else — "a string as payload" would invite
 * putting on the bus what already sits in the message body. */
export type ArtifactSource = {
    path: string;
    filename?: string;
} | {
    stream: NodeJS.ReadableStream;
    filename: string;
};
/** Artifact file name, from the source. Called BEFORE the blob is written: a bad name caught only by
 * the schema afterwards would leave payload in the task with no metadata. */
export declare function nameOf(source: ArtifactSource): string;
/** Put the payload into a task blob, returning digest and size. Put in place with `link`: `EEXIST` is
 * dedup, not a refusal. A blob is immutable — a second write would change it for every record. */
export declare function stashBlob(home: string, task: string, source: ArtifactSource): Promise<{
    sha256: string;
    size: number;
}>;
/** Putting a file into the task store as an artifact.
 * [reference/04-protocol.md#stashblobsync--the-same-synchronously-from-a-file](../../docs/reference/04-protocol.md#stashblobsync--the-same-synchronously-from-a-file) */
export declare function stashBlobSync(home: string, task: string, file: string): {
    sha256: string;
    size: number;
};
/** Hard-link refusal as a typed code, not a bare errno: a filesystem without hard links is a lawful
 * environment condition. No half-written record is left — the intent stays open for recovery. */
export declare function linkFailure(e: unknown, target: string): Error;
/** Mkdir refusal as its own typed code. A volume that may return is `dir-blocked`. A stray file,
 * a broken link (`ENOENT`), or a symlink loop (`ELOOP`) is `dir-occupied`. Any other errno stays raw. */
export declare function dirFailure(e: unknown, target: string): Error;
/** Write artifact metadata. Validation before the write: the bad never enters the store. */
export declare function writeArtifact(home: string, task: string, meta: ArtifactV1): ArtifactV1;
export declare function newArtifact(id: string, sha256: string, filename: string, size: number): ArtifactV1;
/** Read metadata. Missing — `artifact-not-found`; another errno — `artifact-broken`. Invalid metadata
 * goes to `broken/artifacts`: one corrupt record must not cost the task the rest. */
export declare function readArtifact(home: string, task: string, id: string, fault?: FaultHook): ArtifactV1;
/** Read the artifact payload, checking the digest: a mismatch is a typed refusal, which is what
 * artifacts are hash-addressed for. Missing is `artifact-not-found`, another errno `artifact-broken`. */
export declare function readBlob(home: string, task: string, meta: ArtifactV1, fault?: FaultHook): Buffer;
/** List the task's metadata records, skipping unreadable ones. */
export declare function listArtifacts(home: string, task: string): {
    artifacts: ArtifactV1[];
    broken: string[];
};
/** Blobs NOTHING names — no metadata record, no hard link beyond the blob file itself.
 *  Lawful, and never removed one by one; `prune` takes them: reference/04-protocol.md § Store layout. */
export declare function orphanBlobs(home: string, task: string): string[];
/** Whether anything still names this payload — one answer, for the sweep and for `prune`.
 * [reference/04-protocol.md#store-layout](../../docs/reference/04-protocol.md#store-layout) */
export declare function blobNamed(home: string, task: string, sha256: string, records?: readonly ArtifactV1[]): boolean;
/** How many blobs and bytes sit with the task — for the `prune` report. */
export declare function blobStats(home: string, task: string): {
    count: number;
    bytes: number;
};
