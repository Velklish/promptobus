// The v1 record shapes.
// [reference/04-protocol.md#the-v1-record-shapes](../../docs/reference/04-protocol.md#the-v1-record-shapes)
import { MESSAGE_TYPES, TASK_ID_RE } from '../protocol.js';
/** v1 record schema version: `task.json` and artifact metadata. */
export const SCHEMA_VERSION = 1;
/** v1 message protocol version. */
export const MESSAGE_PROTOCOL_VERSION = 1;
/** Models checked by the schema. */
export const MODELS = ['task', 'participant', 'message', 'artifact'];
// Field grammar exported to v1 consumers. A participant identifier is its own and independent: role
// is never derived from it, so there is no colon in it at all.
export { TASK_ID_RE };
export const PARTICIPANT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ROLE_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const HARNESS_RE = /^[a-z][a-z0-9-]{0,31}$/;
// Logical stamp/counter and random tail for committed messages; retained IDs stay opaque.
// Artifact names share the grammar but do not define causal message order.
export const RECORD_ID_RE = /^[0-9]{8}T[0-9]{9}-[0-9]{4}-[0-9a-f]{6}$/;
/** Compact UTC stamp used in sortable record ids. */
export function compactStamp(at) {
    return at.toISOString().replace(/[-:.]/g, '').replace('Z', '');
}
// Exactly what `Date#toISOString` prints. The `date-time` format is not enough:
// it allows an offset, and an offset breaks the string sort history rests on.
export const TIMESTAMP_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
// Artifact file name — a name only: a path separator in it would mean metadata
// addresses something outside the task.
export const FILENAME_RE = /^[^/\\]+$/;
export const BLOB_PATH_RE = /^blobs\/[0-9a-f]{64}$/;
/** Message types: the value home is `src/protocol.ts`; there is never a second list in the code. */
export const MESSAGE_TYPES_V1 = MESSAGE_TYPES;
