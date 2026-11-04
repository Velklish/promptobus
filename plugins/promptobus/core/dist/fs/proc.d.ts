/** Whether the process is alive. Signal 0 sends nothing and only checks reachability; `EPERM` means
 * the process exists but is not ours — also alive. */
export declare function pidAlive(pid: unknown): boolean;
/** Synchronous pause: the lock is taken from synchronous code, and there is no event loop to yield to there. */
export declare function sleepSync(ms: number): void;
