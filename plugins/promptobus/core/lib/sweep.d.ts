import type { LibRegistry } from './driver-runtime.js';
import type { ArtifactV1 } from '../dist/index.js';
interface ArtifactRemoval extends ArtifactV1 {
    file: string;
    blob: string;
    link: string;
}
interface ArtifactPlan {
    broken: string[];
    going: ArtifactRemoval[];
}
/** What the piece sweep must never take — the run's telemetry and its mailboxes.
 * [reference/03-cli.md#keptpaths--what-the-piece-sweep-must-never-take](../docs/reference/03-cli.md#keptpaths--what-the-piece-sweep-must-never-take) */
export declare function keptPaths(home: string, id: string): string[];
/** The kept path a removal would land inside, or `null` — this is the check itself. */
export declare function keptBy(target: string, kept: readonly string[]): string | null;
/** A direct child of the named directory, or `null` — a record field that walked out.
 * [reference/03-cli.md#childof--a-path-built-from-a-record-field-stays-a-direct-child](../docs/reference/03-cli.md#childof--a-path-built-from-a-record-field-stays-a-direct-child) */
export declare function childOf(dir: string, name: unknown): string | null;
/** The removals of one piece, under the publication lock.
 * [reference/03-cli.md#sweepartifacts--the-removals-of-one-piece-under-the-publication-lock](../docs/reference/03-cli.md#sweepartifacts--the-removals-of-one-piece-under-the-publication-lock) */
export declare function sweepArtifacts(home: string, id: string, plan: ArtifactPlan, kept: readonly string[]): {
    records: number;
    blobs: number;
    files: number;
    unlinked: string[];
    busy: string[];
};
/** Clean up after one accepted piece; the task stays active.
 * [reference/03-cli.md#sweep--clean-up-after-one-accepted-piece](../docs/reference/03-cli.md#sweep--clean-up-after-one-accepted-piece) */
export declare function sweep(rootOrHost: unknown, { task, address }?: {
    task?: string | null;
    address?: string;
}, { registry }?: {
    registry?: LibRegistry;
}): Promise<number>;
export {};
