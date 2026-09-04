// On-disk layout of store v1.
//
// The caller supplies the root: the package does not search the workspace and
// does not read the environment — that is the adapter's business. Path joining
// only, no disk access.
import path from 'node:path';
import { fail } from './errors.js';
import { PARTICIPANT_ID_RE, RECORD_ID_RE, TASK_ID_RE } from './model.js';

/** Store directory inside the workspace. */
export const ROOT_DIR = '.promptobus';

/** Store v1 inside the root the caller named. */
export function homeOf(root: string): string {
  if (typeof root !== 'string' || !root) fail('schema-invalid', 'store root is not named');
  return path.join(root, ROOT_DIR);
}

// Grammar is checked on EVERY name that enters a path: an id arrives both from
// the adapter and from a foreign record on disk, and `..` in it would walk the
// record out of the task.
function safeTask(id: unknown): string {
  if (typeof id !== 'string' || !TASK_ID_RE.test(id)) {
    fail('task-not-found', `invalid task id: «${String(id)}»`, { task: id });
  }
  return id;
}

function safeParticipant(id: unknown): string {
  if (typeof id !== 'string' || !PARTICIPANT_ID_RE.test(id)) {
    fail('participant-not-found', `invalid participant id: «${String(id)}»`, { participant: id });
  }
  return id;
}

function safeRecord(id: unknown): string {
  if (typeof id !== 'string' || !RECORD_ID_RE.test(id)) {
    fail('schema-invalid', `invalid record id: «${String(id)}»`, { record: id });
  }
  return id;
}

export function tasksDir(home: string): string {
  return path.join(home, 'tasks');
}

export function taskDir(home: string, task: string): string {
  return path.join(tasksDir(home), safeTask(task));
}

export function taskFile(home: string, task: string): string {
  return path.join(taskDir(home, task), 'task.json');
}

export function lockDir(home: string, task: string): string {
  return path.join(taskDir(home, task), '.lock');
}

/** Canonical messages. Immutable: inbox, history, and intent refs are the same inode. */
export function messagesDir(home: string, task: string): string {
  return path.join(taskDir(home, task), 'messages');
}

export function messageFile(home: string, task: string, message: string): string {
  return path.join(messagesDir(home, task), `${safeRecord(message)}.json`);
}

/** Unclosed fan-outs. The file here is a hard link to the canonical message. */
export function intentsDir(home: string, task: string): string {
  return path.join(taskDir(home, task), 'intents');
}

export function intentFile(home: string, task: string, message: string): string {
  return path.join(intentsDir(home, task), `${safeRecord(message)}.json`);
}

/**
 * Lease of an unclosed fan-out: `<id>.owner` next to the intent. The path is
 * assembled FROM the intent path, not from the id a second time: recovery walks
 * the directory by file names and asks for the lease before parsing the
 * record — it has a path in hand, not an id.
 */
export function ownerOfIntent(intent: string): string {
  return `${intent.slice(0, -'.json'.length)}.owner`;
}

export function inboxDir(home: string, task: string, participant: string): string {
  return path.join(taskDir(home, task), 'inbox', safeParticipant(participant));
}

export function inboxRef(home: string, task: string, participant: string, message: string): string {
  return path.join(inboxDir(home, task, participant), `${safeRecord(message)}.json`);
}

/** Read mail. The file name is the same — recovery uses it to tell delivered from missing. */
export function historyDir(home: string, task: string, participant: string): string {
  return path.join(taskDir(home, task), 'history', safeParticipant(participant));
}

export function historyRef(home: string, task: string, participant: string, message: string): string {
  return path.join(historyDir(home, task, participant), `${safeRecord(message)}.json`);
}

/**
 * Isolated. Two subdirectories, not one: `inbox/<participant>` and `artifacts`
 * — otherwise a participant whose id is `artifacts` would take foreign records
 * as its own.
 */
export function brokenInboxDir(home: string, task: string, participant: string): string {
  return path.join(taskDir(home, task), 'broken', 'inbox', safeParticipant(participant));
}

export function brokenArtifactsDir(home: string, task: string): string {
  return path.join(taskDir(home, task), 'broken', 'artifacts');
}

/** A torn intent: a crash inside the commit point is the only form of its corruption. */
export function brokenMessagesDir(home: string, task: string): string {
  return path.join(taskDir(home, task), 'broken', 'messages');
}

/** Artifact payloads, addressed by SHA-256. Deduplicated inside the task. */
export function blobsDir(home: string, task: string): string {
  return path.join(taskDir(home, task), 'blobs');
}

export function blobFile(home: string, task: string, sha256: string): string {
  return path.join(blobsDir(home, task), sha256);
}

/** Artifact metadata: the file name lives here, the payload in the blob. */
export function artifactsDir(home: string, task: string): string {
  return path.join(taskDir(home, task), 'artifacts');
}

export function artifactFile(home: string, task: string, artifact: string): string {
  return path.join(artifactsDir(home, task), `${safeRecord(artifact)}.json`);
}

/** Blob path as written in metadata: relative, inside the task directory. */
export function blobRef(sha256: string): string {
  return `blobs/${sha256}`;
}

/** The same path, absolute. Metadata is read only through it: `..` in the field is cut by the schema. */
export function blobOf(home: string, task: string, artifact: { sha256: string }): string {
  return blobFile(home, task, artifact.sha256);
}
