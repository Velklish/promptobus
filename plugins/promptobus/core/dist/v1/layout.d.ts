/** Store directory inside the workspace. */
export declare const ROOT_DIR = ".promptobus";
/** Store v1 inside the root the caller named. */
export declare function homeOf(root: string): string;
export declare function tasksDir(home: string): string;
export declare function taskDir(home: string, task: string): string;
export declare function taskFile(home: string, task: string): string;
export declare function lockDir(home: string, task: string): string;
/** Artifact publication lock: payload, metadata and sweep reachability checks.
 * Separate from the task and store message-commit locks; streaming stays outside commit. */
export declare function blobLockDir(home: string, task: string): string;
/** Canonical messages. Immutable: inbox, history, and intent refs are the same inode. */
export declare function messagesDir(home: string, task: string): string;
export declare function messageFile(home: string, task: string, message: string): string;
/** Unclosed fan-outs. The file here is a hard link to the canonical message. */
export declare function intentsDir(home: string, task: string): string;
export declare function intentFile(home: string, task: string, message: string): string;
/** Lease of an unclosed fan-out: `<id>.owner` beside the intent. Assembled FROM the intent path, not
 * from the id again — recovery walks by file names and asks for the lease before parsing. */
export declare function ownerOfIntent(intent: string): string;
export declare function inboxDir(home: string, task: string, participant: string): string;
export declare function inboxRef(home: string, task: string, participant: string, message: string): string;
/** Root of all per-participant history boxes. */
export declare function historyRoot(home: string, task: string): string;
/** Read mail. The file name is the same — recovery uses it to tell delivered from missing. */
export declare function historyDir(home: string, task: string, participant: string): string;
export declare function historyRef(home: string, task: string, participant: string, message: string): string;
/** Isolated. Two subdirectories, not one: `inbox/<participant>` and `artifacts` — otherwise a
 * participant whose id is `artifacts` would take foreign records as its own. */
export declare function brokenInboxDir(home: string, task: string, participant: string): string;
export declare function brokenArtifactsDir(home: string, task: string): string;
/** A torn intent: a crash inside the commit point is the only form of its corruption. */
export declare function brokenMessagesDir(home: string, task: string): string;
/** Artifact payloads, addressed by SHA-256. Deduplicated inside the task. */
export declare function blobsDir(home: string, task: string): string;
export declare function blobFile(home: string, task: string, sha256: string): string;
/** Artifact metadata: the file name lives here, the payload in the blob. */
export declare function artifactsDir(home: string, task: string): string;
/** Human-facing task files: artifacts and mechanism-produced briefs or diffs. */
export declare function filesDir(home: string, task: string): string;
export declare function artifactFile(home: string, task: string, artifact: string): string;
/** Blob path as written in metadata: relative, inside the task directory. */
export declare function blobRef(sha256: string): string;
/** The same path, absolute. Metadata is read only through it: `..` in the field is cut by the schema. */
export declare function blobOf(home: string, task: string, artifact: {
    sha256: string;
}): string;
