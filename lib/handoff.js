// The hand-off: the shape of a result body and the evidence beside it.
// Where the numbers come from: docs/reference/04-protocol.md § Artifacts.

/** Characters a result body may take, header included. Derivation: the reference. */
export const RESULT_BODY_MAX = 2400;

/** Characters of command output one gate record may carry — the tail, not the log. */
export const GATE_TAIL_MAX = 2000;

/** Where the record's shape is published, as a participant is told to find it. */
export const GATE_RECORD_SCHEMA = 'schemas/v1/gate-record.schema.json';

/** Stem of the file a worker attaches its gate record as; the reviewer resolves it by this. */
export const GATE_RECORD_STEM = 'gates';
