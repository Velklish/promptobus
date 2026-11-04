interface WorktreeInspection {
    branch?: string | null;
    dirty?: boolean | null;
    unmerged: number | null;
    base?: string | null;
    adds?: boolean | null;
    squashed?: boolean | null;
    namedBy?: string | false | null;
}
export declare const WORKTREE_BRANCH_PREFIX = "worktree-";
/** Directory of service worktrees inside the clone, relative. Its home is here because the
 * `.git/info/exclude` line below cites it: two copies would leave the clone dirty forever. */
export declare const WORKTREE_DIR_REL: string;
export declare const WORKTREE_BRANCH_TEMPLATE: string;
export declare function defaultRefs(repoAbs: string, def: string | null | undefined): string[];
export declare function worktreeBranch(worktreePath: string | null | undefined): string | null;
export declare const BRANCH_CHANGED_MARK: string;
export declare function branchLine(journalBranch: string | null | undefined, actualBranch: string | null | undefined): string | null;
export declare function inspectWorktree(repoAbs: string, worktreePath: string | null | undefined, def: string | null | undefined): {
    branch: null;
    dirty: null;
    unmerged: null;
    base: null;
    adds: null;
    squashed?: undefined;
    namedBy?: undefined;
} | {
    branch: string | null;
    dirty: boolean | null;
    unmerged: number | null;
    base: string | null;
    adds: boolean | null;
    squashed: boolean | null;
    namedBy: string | false | null;
};
export declare function worktreeDisposition(info: WorktreeInspection | null | undefined): {
    action: string;
    reason: string;
};
export declare function removeWorktree(repoAbs: string, worktreePath: string, branch: string | null | undefined): {
    removed: boolean;
    error: string;
    branchKept: null;
    branchDeleted?: undefined;
    branchStuck?: undefined;
} | {
    error?: undefined;
    removed: boolean;
    branchDeleted: boolean;
    branchKept: string | null;
    branchStuck: string | null;
};
export declare function createWorktree(repoAbs: string, worktreePath: string, branch: string, base: string | null | undefined): {
    created: boolean;
    error: string;
    reused: boolean;
    baseSha: null;
} | {
    error?: undefined;
    created: boolean;
    reused: boolean;
    baseSha: string | null;
};
export declare function worktreeHasLock(dir: string | null | undefined): boolean;
export declare function npmCiCommand(): string;
/** Installs dependencies in a just-created worktree. A refusal is not a spawn refusal; npm
 * output goes to a log beside the directory, whose path the warning names. */
export declare function installWorktreeDeps(worktreePath: string, { env }?: {
    env?: NodeJS.ProcessEnv;
}): {
    ran: boolean;
    ok?: undefined;
    ms?: undefined;
    why?: undefined;
    command?: undefined;
    logPath?: undefined;
    ignored?: undefined;
} | {
    ran: boolean;
    ok: boolean;
    ms: number;
    logPath: string;
    ignored: boolean | null;
    why?: undefined;
    command?: undefined;
} | {
    ran: boolean;
    ok: boolean;
    ms: number;
    why: string | null;
    command: string;
    logPath: string;
    ignored: boolean | null;
};
export declare function excludeWorktrees(repoAbs: string): {
    status: string;
    error: string;
} | {
    status: string;
    error: null;
};
/** What git calls uncommitted or untracked here; `null` is "git did not answer", not clean.
 * Exported because a generator leaving unignored files must be said out loud at spawn. */
export declare function worktreeDirt(worktreePath: string): string[] | null;
export declare function pruneWorktrees(repoAbs: string): boolean;
export {};
