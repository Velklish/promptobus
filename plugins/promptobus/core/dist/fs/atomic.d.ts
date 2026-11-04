/** Write a file whole: a temporary neighbour in the same directory, then `rename` over it.
 * `writeFileSync` truncates to zero — a parallel reader finds it empty, and a death leaves it so. */
export declare function writeFileAtomic(file: string, content: string, { mode, preserveMode }?: {
    mode?: number | null;
    preserveMode?: boolean;
}): void;
/** The same move — for every overwriteable JSON file on the bus. */
export declare function writeJsonAtomic<T>(file: string, value: T, { mode }?: {
    mode?: number | null;
}): T;
