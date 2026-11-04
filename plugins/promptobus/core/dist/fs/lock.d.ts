export declare const LOCK_WAIT_MS = 5000;
export declare const LOCK_RETRY_MS = 20;
/** Who holds the lock: without an owner file the advice "delete the directory if the process is gone" cannot be followed. */
export interface LockHolder {
    pid: number | null;
    session: string | null;
    since: string | null;
    nonce?: string;
}
/** Who holds the lock. A former-CLI lock holds the pid as a string and is read too: the only process
 * that can outlive the directory is one that died mid-write. */
export declare function lockHolder(lock: string): LockHolder | null;
/** An orphaned lock, by pid liveness. An exclusive claim inside its generation serializes
 * reclamation; an old read alone cannot license renaming a replacement directory. */
export declare function dropDeadLock(lock: string): boolean;
/** How the lock answers its two lawful refusals. The words are the caller's business. */
export interface DirLockOptions {
    waitMs?: number;
    retryMs?: number;
    /** Session identity in the owner file: pid answers "is it alive", session answers "whose is it". */
    session?: string | null;
    /** The directory the lock is taken in does not exist at all — that is not a busy lock, it is a missing subject. */
    onMissing: () => Error;
    /** The lock is held by a live holder longer than allowed. */
    onBusy: (held: LockHolder | null, waitedMs: number) => Error;
    /** A synchronous take met an asynchronous holder of THIS process: waiting would hang. */
    onSelfAsync?: (lock: string) => Error;
}
/** Private HTTP dispatch scope: no synchronous wait may carry an earlier native proof forward. */
export declare function withSynchronousAuthority<T>(authorize: () => void, fn: () => T): T;
export declare function requireSynchronousAuthority(): void;
/** Take the lock directory, run, and drop. A missing task directory stays the caller's
 * own refusal: a nested call does not reach the directory at all. */
export declare function withDirLock<T>(lock: string, fn: () => T, options: DirLockOptions): T;
/** The same lock held across an await: `withDirLock` would drop the directory when `fn` handed
 *  back its promise, so holders of one path queue instead of nesting. Licence: § Store layout. */
export declare function withDirLockAsync<T>(lock: string, fn: () => Promise<T>, options: DirLockOptions): Promise<T>;
