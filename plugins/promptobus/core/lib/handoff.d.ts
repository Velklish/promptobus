import type { RoleRegistry } from '../dist/index.js';
/** Characters a result body may take, header included. Derivation: the reference. */
export declare const RESULT_BODY_MAX = 2400;
/** Characters of command output one gate record may carry — the tail, not the log. */
export declare const GATE_TAIL_MAX = 2000;
/** Where the record's shape is published, as a participant is told to find it. */
export declare const GATE_RECORD_SCHEMA = "schemas/v1/gate-record.schema.json";
/** Stem of the file a worker attaches its gate record as; the reviewer resolves it by this. */
export declare const GATE_RECORD_STEM = "gates";
/** Where the pre-handover checks publish their shape, as a participant is told to find it. */
export declare const HANDOVER_RECORD_SCHEMA = "schemas/v1/handover-record.schema.json";
/** Stem of the file a worker attaches its handover record as; the reviewer resolves it by this. */
export declare const HANDOVER_RECORD_STEM = "handover";
/** The five checks the record is defined by, in the order the preambles name them. */
export declare const HANDOVER_CHECKS: readonly string[];
/** The attachment contract, quoted WORD FOR WORD by the worker, approver and reviewer
 * preambles: one constant is why the sides cannot drift apart on it. */
export declare const ATTACHMENT_CONTRACT: string;
/** "gates N, green M", quoted word for word. One constant, so the preambles cannot drift. */
export declare const GATE_LINE_COUNTS: string;
/** Where a verification outcome shows, quoted the same way. */
export declare const GATE_LINE_VERIFICATION: string;
export declare function isGateRecordName(filename: unknown): boolean;
export declare function isHandoverRecordName(filename: unknown): boolean;
/** The schema a landed filename claims by its stem, or `null` — it claims neither. */
export declare function recordSchemaOf(filename: unknown): "schemas/v1/gate-record.schema.json" | "schemas/v1/handover-record.schema.json" | null;
/** Why this file is not the record its name claims, or `null` — it is one, or claims none.
 * [reference/04-protocol.md#the-gate-record](../docs/reference/04-protocol.md#the-gate-record) */
export declare function recordRefusal(filename: string, file: string, registry: RoleRegistry): string | null;
/** Landed filenames named in the Gate or Decide header lines. */
export declare function artifactClaimsInResult(body: unknown, landedFilenames: readonly string[]): string[];
