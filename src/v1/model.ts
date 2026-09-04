// Protocol v1 models and the grammar of their fields.
//
// Forms and regular expressions only — no disk, no policy. The grammar is
// declared once and read by both: the own validators ([validate.ts](validate.ts))
// and the JSON Schemas in `schemas/v1` — their parity is held by
// [v1-validate.test.mjs](../../test/v1-validate.test.mjs).
import { MESSAGE_TYPES } from '../protocol.js';

/** v1 record schema version: `task.json` and artifact metadata. */
export const SCHEMA_VERSION = 1;

/** v1 message protocol version. */
export const MESSAGE_PROTOCOL_VERSION = 1;

/** Models checked by the schema. */
export const MODELS = ['task', 'participant', 'message', 'artifact'] as const;

/** Model name. */
export type ModelName = (typeof MODELS)[number];

// Field grammar. A task identifier is more generous than the others: the
// adapter assembles it from its own slug and stamp. A participant identifier
// is its own and independent: role is never derived from it, so there is no
// colon in it at all.
export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const PARTICIPANT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ROLE_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const HARNESS_RE = /^[a-z][a-z0-9-]{0,31}$/;
// Timestamp, sender counter, and a random tail: string sort is send order, and
// history does not need a second clock.
export const RECORD_ID_RE = /^[0-9]{8}T[0-9]{9}-[0-9]{4}-[0-9a-f]{6}$/;
// Exactly what `Date#toISOString` prints. The `date-time` format is not enough:
// it allows an offset, and an offset breaks the string sort history rests on.
export const TIMESTAMP_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
// Artifact file name — a name only: a path separator in it would mean metadata
// addresses something outside the task.
export const FILENAME_RE = /^[^/\\]+$/;
export const BLOB_PATH_RE = /^blobs\/[0-9a-f]{64}$/;

/** Participant mode: the driver lifted the session (`managed`) or it attached itself (`attached`). */
export type ParticipantMode = 'managed' | 'attached';

/**
 * Snapshot of the driver's capabilities at the moment the participant was lifted.
 *
 * Five fields are required, four are not, and that is not a loosening of the
 * schema: records written before the contract grew sit in live journals, and
 * if the schema required the new fields, a previous-release task would stop
 * being readable as a whole. The snapshot is the evidence of what the
 * participant was lifted with: what the driver did not declare then is not in it.
 */
export interface CapabilitiesSnapshot {
  spawn: boolean;
  attach: boolean;
  activation: 'push' | 'pull';
  inspect: boolean;
  stop: boolean;
  denyTools?: boolean;
  systemPrompt?: boolean;
  sessionList?: boolean;
  enter?: boolean;
}

/**
 * Task participant. The ID is independent, the role is a field: the former
 * bus's `worker:<slug>` mixed address, role, and harness in one string, and a
 * second harness requires them to be split.
 */
export interface ParticipantV1 {
  id: string;
  role: string;
  harness: string;
  mode: ParticipantMode;
  /** Opaque driver session reference. An explicit `null`, not an absent field. */
  sessionRef: string | null;
  capabilities: CapabilitiesSnapshot | null;
  /** Adapter metadata: core does not look into it. */
  metadata: Record<string, unknown>;
}

/** v1 task journal. */
export interface TaskV1 {
  schemaVersion: number;
  id: string;
  title: string;
  status: 'active' | 'done';
  /** Owner participant ID. There is always one; a change is an explicit claim. */
  owner: string;
  created: string;
  updated: string;
  participants: ParticipantV1[];
  /** Adapter metadata as an opaque object. */
  adapter: Record<string, unknown>;
}

/** Canonical message. Immutable: inbox and history refs are the same inode. */
export interface MessageV1 {
  protocolVersion: number;
  id: string;
  task: string;
  sender: string;
  recipients: string[];
  type: string;
  body: string;
  artifact?: string;
  ts: string;
}

/** Artifact metadata. One payload lives under several names: several records, one blob. */
export interface ArtifactV1 {
  schemaVersion: number;
  id: string;
  sha256: string;
  filename: string;
  size: number;
  /** Blob path inside the task directory. */
  blob: string;
}

/** Message types: the value home is `src/protocol.ts`; there is never a second list in the code. */
export const MESSAGE_TYPES_V1: readonly string[] = MESSAGE_TYPES;
