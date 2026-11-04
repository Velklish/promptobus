import { TASK_ID_RE } from '../protocol.js';
/** v1 record schema version: `task.json` and artifact metadata. */
export declare const SCHEMA_VERSION = 1;
/** v1 message protocol version. */
export declare const MESSAGE_PROTOCOL_VERSION = 1;
/** Models checked by the schema. */
export declare const MODELS: readonly ['task', 'participant', 'message', 'artifact'];
/** Model name. */
export type ModelName = (typeof MODELS)[number];
export { TASK_ID_RE };
export declare const PARTICIPANT_ID_RE: RegExp;
export declare const ROLE_RE: RegExp;
export declare const HARNESS_RE: RegExp;
export declare const RECORD_ID_RE: RegExp;
/** Compact UTC stamp used in sortable record ids. */
export declare function compactStamp(at: Date): string;
export declare const TIMESTAMP_RE: RegExp;
export declare const SHA256_RE: RegExp;
export declare const FILENAME_RE: RegExp;
export declare const BLOB_PATH_RE: RegExp;
/** Participant mode: the driver lifted the session (`managed`) or it attached itself (`attached`). */
export type ParticipantMode = 'managed' | 'attached';
/** Snapshot of the driver's capabilities at the moment the participant was lifted. Six fields are
 * optional so a previous-release task stays readable; it is evidence of what the lift declared. */
export interface CapabilitiesSnapshot {
    spawn: boolean;
    attach: boolean;
    activation: 'push' | 'pull';
    inspect: boolean;
    stop: boolean;
    denyTools?: boolean;
    mcpDenyTools?: boolean;
    systemPrompt?: boolean;
    sessionList?: boolean;
    enter?: boolean;
    approverLift?: boolean;
}
/** Task participant. The ID is independent and the role is a field: the former bus mixed address,
 * role and harness in one string, and a second harness requires them split. */
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
    /** The root task id. Absent on a root task. */
    parent?: string;
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
    originTask?: string;
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
export declare const MESSAGE_TYPES_V1: readonly string[];
