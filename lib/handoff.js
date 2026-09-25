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

/** The attachment contract, quoted WORD FOR WORD by the worker, approver and reviewer
 * preambles: one constant is why the sides cannot drift apart on it. */
export const ATTACHMENT_CONTRACT = 'Every file an address attaches to this task with `artifactPath` '
  + 'before `review` runs is listed in the review subject of that address — name, type and time — '
  + 'and not only the records a schema shapes.';

/** "gates N, green M", quoted word for word. One constant, so the preambles cannot drift. */
export const GATE_LINE_COUNTS = 'The line "gates N, green M" counts by command, and only the entries whose `tree` and `dirty` match the tree the line is about — a worker\'s clean HEAD, an approver\'s merged tree. '
  + 'Entries on other trees are history and are not counted. '
  + 'N is the number of distinct `command` values among those gate entries — an entry with no `kind`, or `kind` `gate`. '
  + 'Different spellings of one command are different commands; keep one spelling. '
  + 'M is how many of those have a latest entry that exits 0. '
  + 'An entry whose `counts` carry `gates` and `green` is the aggregate itself, not a gate, and is not counted in N. '
  + 'When the record has no per-command gate entries, the runner entry\'s own `gates` and `green` are the line. '
  + 'When per-command entries exist, they are counted by command and must agree with the runner entry when the record has one. '
  + 'An entry with `kind` `verification` is a card\'s own run and is left out of both.';

/** Where a verification outcome shows, quoted the same way. */
export const GATE_LINE_VERIFICATION = 'After the aggregate, the Gate line names each verification run with its exit code, '
  + 'or says "verification K, green L".';

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

const say = (names) => names.map((n) => `«${n}»`).join(', ');

/** Why the declared target is not among the names the probe reddened, or `null` — two fields of
 * one document, which no schema keyword compares. [reference/04-protocol.md#the-handover-record](../docs/reference/04-protocol.md#the-handover-record) */
function probeIntentRefusal(document) {
  const probe = document?.checks?.mutationProbe;
  if (!Array.isArray(probe?.expected)) return null;
  const reddened = new Set(probe.reddened);
  const absent = probe.expected.filter((name) => !reddened.has(name));
  if (!absent.length) return null;
  // Both lists in full, not the missing part alone: with one target of two hit, the hit one
  // read as a stray while the record said it was declared.
  const head = `the mutation probe declared ${say(probe.expected)} and \`reddened\` names `
    + `${say(probe.reddened)}, so ${say(absent)} never turned red`;
  // The diagnosis differs by branch, and this message is read by whoever comes to fix the
  // probe: «reddened other things» sends them looking the wrong way when some target did hit.
  return absent.length === probe.expected.length
    ? `${head} — a probe that reddened other things measured something other than the change under it`
    : `${head} — the mutation reached part of what it was declared against and not the rest, `
      + 'so either those verdicts do not cover the line it broke or they were the wrong targets to declare';
}

/** Why the stated remainder is not the counts' subtraction, or `null` — two sides,
 * which no schema keyword compares. [reference/04-protocol.md#the-handover-record](../docs/reference/04-protocol.md#the-handover-record) */
function probeCountsRefusal(document) {
  const probe = document?.checks?.mutationProbe;
  const verdicts = probe?.verdicts;
  if (!verdicts) return null;
  const { baseTotal, passed, unaccounted } = verdicts;
  // Length, not a set: two checks may share a name, and a repeated listing is two verdicts.
  const remainder = baseTotal - passed - probe.reddened.length;
  if (remainder === unaccounted) return null;
  const head = `\`baseTotal\` ${baseTotal} − \`passed\` ${passed} − \`reddened.length\` ${probe.reddened.length} is ${remainder}, `
    + `and \`unaccounted\` states ${unaccounted}`;
  // The sign is the diagnosis. One sentence for both sends a positive remainder's author
  // to rewrite the numbers until they agree, which is the consistent wrong capture.
  if (remainder > 0) {
    return `${head} — ${remainder} verdict${remainder === 1 ? '' : 's'} the mutated run never reached, or names missing from \`reddened\` — run again or declare \`notRun\``;
  }
  return `${head} — more verdicts than the base run has — numbers from another invocation`;
}

/** Why the probe sha is not the tree being handed over, or `null` — they agree, or `treeLag` says why. */
function probeTreeRefusal(document) {
  const probe = document?.checks?.mutationProbe;
  if (typeof probe?.tree !== 'string' || typeof document?.tree !== 'string') return null;
  if (probe.tree === document.tree || typeof probe.treeLag === 'string') return null;
  return `the handover \`tree\` is \`${document.tree}\` and the probe ran on \`${probe.tree}\`, `
    + 'with no `treeLag` to say why — re-run the probe on `tree`, or state in '
    + `\`checks.mutationProbe.treeLag\` why the commits since \`${probe.tree}\` reach neither `
    + 'the mutated line nor its verdicts';
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
  if (errors.length) {
    return `«${filename}» does not match ${schemaPath}, so it is not the evidence its name claims: ${sayErrors(errors)}`;
  }
  // After the shape and only then: the fields must exist before they can be compared.
  const intent = probeIntentRefusal(document);
  if (intent) return `«${filename}» contradicts itself: ${intent}`;
  const counts = probeCountsRefusal(document);
  if (counts) return `«${filename}» contradicts itself: ${counts}`;
  const trees = probeTreeRefusal(document);
  return trees ? `«${filename}» contradicts itself: ${trees}` : null;
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
