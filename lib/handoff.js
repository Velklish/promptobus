// The hand-off: the shape of a result body and the evidence beside it.
// Where the numbers come from: docs/reference/04-protocol.md § Artifacts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { schemaErrors, sayErrors } from './schema.js';

const SCHEMA_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Characters a result body may take, header included. Derivation: the reference. */
export const RESULT_BODY_MAX = 2400;

/** Characters of command output one gate record may carry — the tail, not the log. */
export const GATE_TAIL_MAX = 2000;

/** Where the record's shape is published, as a participant is told to find it. */
export const GATE_RECORD_SCHEMA = 'schemas/v1/gate-record.schema.json';

/** Stem of the file a worker attaches its gate record as; the reviewer resolves it by this. */
export const GATE_RECORD_STEM = 'gates';

/** Where the pre-handover checks publish their shape, as a participant is told to find it. */
export const HANDOVER_RECORD_SCHEMA = 'schemas/v1/handover-record.schema.json';

/** Stem of the file a worker attaches its handover record as; the reviewer resolves it by this. */
export const HANDOVER_RECORD_STEM = 'handover';

/** The five checks the record is defined by, in the order the preambles name them. */
export const HANDOVER_CHECKS = Object.freeze([
  'verdictNames', 'mutationProbe', 'treeState', 'environmentalRed', 'gatesNotRun',
]);

const GATE_RECORD_RE = new RegExp(`^${GATE_RECORD_STEM}-[^/\\\\]+\\.json$`);
const HANDOVER_RECORD_RE = new RegExp(`^${HANDOVER_RECORD_STEM}-[^/\\\\]+\\.json$`);

const GATE_HEADER = {
  bold: /^\s*[-*]*\s*\*\*Gate\*\*\s*[—\-:]\s*(.*)$/,
  plain: /^\s*Gate\s*:\s*(.*)$/i,
};
const DECIDE_HEADER = {
  bold: /^\s*[-*]*\s*\*\*Decide\*\*\s*[—\-:]\s*(.*)$/,
  plain: /^\s*Decide\s*:\s*(.*)$/i,
};

export function isGateRecordName(filename) {
  return typeof filename === 'string' && GATE_RECORD_RE.test(filename);
}

export function isHandoverRecordName(filename) {
  return typeof filename === 'string' && HANDOVER_RECORD_RE.test(filename);
}

/** The schema a landed filename claims by its stem, or `null` — it claims neither. */
export function recordSchemaOf(filename) {
  if (isGateRecordName(filename)) return GATE_RECORD_SCHEMA;
  if (isHandoverRecordName(filename)) return HANDOVER_RECORD_SCHEMA;
  return null;
}

/** Why this file is not the record its name claims, or `null` — it is one, or claims none.
 * [reference/04-protocol.md#the-gate-record](../docs/reference/04-protocol.md#the-gate-record) */
export function recordRefusal(filename, file) {
  const schemaPath = recordSchemaOf(filename);
  if (!schemaPath) return null;
  let raw;
  // Unreadable is not this check's refusal: the send already says «artifact is missing».
  try { raw = readFileSync(file, 'utf8'); } catch { return null; }
  let document;
  try {
    document = JSON.parse(raw);
  } catch (e) {
    return `«${filename}» is named as a record of ${schemaPath} and did not parse as JSON: ${e.message}`;
  }
  const errors = schemaErrors(JSON.parse(readFileSync(path.join(SCHEMA_ROOT, schemaPath), 'utf8')), document);
  return errors.length
    ? `«${filename}» does not match ${schemaPath}, so it is not the evidence its name claims: ${sayErrors(errors)}`
    : null;
}

function headerLine(body, patterns) {
  for (const line of String(body ?? '').split('\n')) {
    const bold = line.match(patterns.bold);
    if (bold) return bold[1].trim();
    const plain = line.match(patterns.plain);
    if (plain) return plain[1].trim();
  }
  return null;
}

const BEFORE_BOUNDARY = /[\w.-]/;
const AFTER_BOUNDARY = /[\w-]/;
const EXTENSION_HEAD = /[A-Za-z0-9]/;

function isDelimitedMatch(line, name, index) {
  const before = index > 0 ? line[index - 1] : '';
  if (before && BEFORE_BOUNDARY.test(before)) return false;
  const pos = index + name.length;
  const after = pos < line.length ? line[pos] : '';
  if (!after) return true;
  if (AFTER_BOUNDARY.test(after)) return false;
  if (after === '.') {
    const next = pos + 1 < line.length ? line[pos + 1] : '';
    return !next || !EXTENSION_HEAD.test(next);
  }
  return true;
}

function landedNamesInLine(line, landedFilenames) {
  const known = new Set(landedFilenames);
  const hits = [];
  for (const name of known) {
    let idx = 0;
    while ((idx = line.indexOf(name, idx)) !== -1) {
      if (isDelimitedMatch(line, name, idx)) hits.push({ name, idx });
      idx += 1;
    }
  }
  hits.sort((a, b) => a.idx - b.idx);
  const seen = new Set();
  const ordered = [];
  for (const { name } of hits) {
    if (seen.has(name)) continue;
    seen.add(name);
    ordered.push(name);
  }
  return ordered;
}

/** Landed filenames named in the Gate or Decide header lines. */
export function artifactClaimsInResult(body, landedFilenames) {
  const claims = [];
  const gate = headerLine(body, GATE_HEADER);
  if (gate) claims.push(...landedNamesInLine(gate, landedFilenames));
  const decide = headerLine(body, DECIDE_HEADER);
  if (decide) claims.push(...landedNamesInLine(decide, landedFilenames));
  return [...new Set(claims)];
}
