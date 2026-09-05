// The text half of a decision: what `promptobus models` prints when it is not
// asked for `--json`.
//
// It renders a decision document and nothing else — no catalog, no snapshot, no
// policy — so the two outputs of the command cannot drift: whatever the JSON
// says, this is that same document with column widths. The order is the
// document's own, scored candidates first by descending total and excluded ones
// after, because `candidates` in `decision.schema.json` declares that order as
// part of the contract and the renderer prints the array as it stands.
//
// Byte-for-byte pinned by `test/fixtures/model-routing/models.txt`. The columns
// below are what that fixture fixes; the rules around them exist so a longer
// name widens the grid for every row instead of pushing one row out of it.
import { GateError } from '../../dist/index.js';

/** The state column fits the longest word of a closed vocabulary — `unavailable`. */
const STATE_WIDTH = 11;

/** The score column is right-aligned, wide enough for a three-digit total and the gutter after it. */
const SCORE_WIDTH = 8;

/** Floor of the harness/model/effort column. Content wider than this widens the column for every row. */
const DESC_MIN = 30;

/** Marker column: the pick, a scored candidate, an excluded one. */
const MARKERS = { chosen: '*', scored: ' ', excluded: '-' };

const widest = (values) => values.reduce((a, v) => Math.max(a, v.length), 0);

/** `harness / model effort` — the human name of a tuple, and the second column of every row. */
const describe = (c) => `${c.harness} / ${c.model}${c.effort ? ` ${c.effort}` : ''}`;

/** A signed number: an adjustment reads as what it did, so a bonus keeps its plus. */
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);

function candidateRow(c, { idWidth, descWidth }) {
  const marker = c.chosen ? MARKERS.chosen : (c.score ? MARKERS.scored : MARKERS.excluded);
  const state = c.availability.state.padEnd(STATE_WIDTH);
  const score = (c.score ? c.score.total.toFixed(2) : '--').padStart(SCORE_WIDTH);
  const tail = c.score
    ? (c.score.adjustments.length
      ? `  (${c.score.adjustments.map((a) => `${signed(a.points)} ${a.code}`).join(', ')})`
      : '')
    : `  ${c.excluded.code}: ${c.excluded.detail}`;
  return `  ${marker} ${c.tupleId.padEnd(idWidth)}${describe(c).padEnd(descWidth)}${state}${score}${tail}`;
}

/** The fields this renderer reads. `chosen` is not among them: `null` there is the empty-candidate case. */
const READS = ['strategy', 'role', 'candidates', 'runtime', 'warnings', 'overlays', 'snapshot'];

/**
 * What is missing from a document that claims to be a decision, or `null` when
 * nothing is.
 *
 * The whole shape is checked rather than the outermost type, because `render`
 * is exported and the document it is handed need not come from `resolve` in the
 * same process — a consumer will pass one it read from `models --json`. A
 * missing field would otherwise surface as `Cannot read properties of undefined`
 * halfway down a page of output, and the reader would have no idea which field.
 */
function missingField(decision) {
  for (const field of READS) {
    if (decision[field] === undefined || decision[field] === null) return field;
  }
  for (const field of ['candidates', 'runtime', 'warnings', 'overlays']) {
    if (!Array.isArray(decision[field])) return `${field} (expected an array)`;
  }
  for (const field of ['takenAt', 'ageSec', 'source']) {
    if (decision.snapshot[field] === undefined || decision.snapshot[field] === null) return `snapshot.${field}`;
  }
  return null;
}

/**
 * A decision as the terminal shows it.
 *
 * Blocks that carry nothing are left out rather than printed empty: a `warnings:`
 * heading with nothing under it reads as a warning that failed to print.
 */
export function render(decision) {
  if (!decision || typeof decision !== 'object') throw new GateError('render: expected a decision document');
  const missing = missingField(decision);
  if (missing) throw new GateError(`render: the decision has no ${missing}`);
  const candidates = decision.candidates;
  const idWidth = widest(candidates.map((c) => c.tupleId)) + 1;
  const descWidth = Math.max(DESC_MIN, widest(candidates.map(describe)) + 1);

  const lines = [
    `strategy: ${decision.strategy} · role: ${decision.role}`,
    `snapshot: ${decision.snapshot.takenAt} · ${decision.snapshot.ageSec} s old · source ${decision.snapshot.source}`,
    `overlays: ${decision.overlays.length
      ? decision.overlays.map((o) => `${o.id} (${o.applied ? 'applied' : 'absent'})`).join(' · ')
      : 'none'}`,
    decision.chosen
      ? `chosen: ${decision.chosen.tupleId} · ${describe(decision.chosen)} · `
        + `score ${candidates.find((c) => c.chosen).score.total.toFixed(2)}`
      : 'chosen: none · nothing survived filtering',
    '',
  ];

  if (candidates.length) {
    lines.push('candidates:');
    for (const c of candidates) lines.push(candidateRow(c, { idWidth, descWidth }));
  } else {
    lines.push('candidates: none');
  }

  if (decision.runtime.length) {
    lines.push('', 'runtime models — not rated, never chosen automatically:');
    for (const r of decision.runtime) {
      lines.push(`    ${r.harness} / ${r.model}${r.flags?.length ? `  [${r.flags.join(', ')}]` : ''}`);
    }
  }

  if (decision.warnings.length) {
    lines.push('', 'warnings:');
    for (const w of decision.warnings) lines.push(`  ! ${w.code}: ${w.message}`);
  }

  return `${lines.join('\n')}\n`;
}
