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

/** The window-kind column fits the longest of the three ADR-004 names — `monthly`. */
const KIND_WIDTH = 8;

/** The score column is right-aligned, wide enough for a three-digit total and the gutter after it. */
const SCORE_WIDTH = 8;

/** Floor of the harness/model/effort column. Content wider than this widens the column for every row. */
const DESC_MIN = 30;

/** Marker column: the pick, a scored candidate, an excluded one. */
const MARKERS = { chosen: '*', scored: ' ', excluded: '-' };

const widest = (values) => values.reduce((a, v) => Math.max(a, v.length), 0);

/** `harness / model effort` — the human name of a tuple, and the second column of every row. */
const describe = (c) => `${c.harness} / ${c.model}${c.effort ? ` ${c.effort}` : ''}`;

/**
 * Whether nothing in this snapshot was ever checked.
 *
 * A decision is aged from the oldest entry's own `checkedAt`, and an entry the
 * cache never held carries `NEVER_CHECKED` — the epoch ([cache.js](cache.js)).
 * The whole line is then ageless, and printed as a number it reads as
 * "1788614269 s old": the truth in the least useful form a person can be handed.
 * The document keeps its literal `takenAt` and `ageSec` and stays exactly as
 * true; only the human line says it in words.
 *
 * Compared by value rather than against the imported constant, for the reason
 * this file checks the whole shape of what it is given: the document need not
 * have come from `resolve` in the same process, and every spelling of the epoch
 * parses to zero.
 */
const neverChecked = (takenAt) => Date.parse(takenAt) === 0;

/** A signed number: an adjustment reads as what it did, so a bonus keeps its plus. */
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);

/**
 * What a window binds, in one phrase.
 *
 * The scope is printed as the harness named it — a display name for a model
 * scope, the pool's own word for a pool — and the ids behind it are not: they are
 * in `--json` for a machine, and a person reading a limit wants to know which
 * limit it is, not the eleven rows it covers.
 */
function scopeText(scope) {
  if (!scope) return 'account';
  if (scope.pool) return `pool ${scope.pool}`;
  return `model ${scope.model}`;
}

/**
 * One window of one harness.
 *
 * `kind` and `lengthSec` are printed side by side and neither is folded into the
 * other: ADR-004 makes the kind a NAME and the length the number, so a `monthly`
 * window prints its own seconds rather than the "30 days" nobody measured. A
 * window with no reset time says so — `resets never` would be a claim, and an
 * empty tail would read as a line that failed to print.
 */
function windowRow(w, idWidth) {
  const reset = w.resetAt ? `resets ${w.resetAt}` : 'reset time unknown';
  return `      ${w.id.padEnd(idWidth)}${String(w.kind).padEnd(KIND_WIDTH)}`
    + `${w.usedPercent.toFixed(1)}% used · ${w.lengthSec} s · ${scopeText(w.scope)} · ${reset}`;
}

/** The tier as a person reads it: the plan and where the value came from, or that the harness names none. */
function tierText(tier) {
  return tier ? `tier ${tier.name} (${tier.source})` : 'tier unknown';
}

/**
 * The availability block: what the account can run, harness by harness (ADR-004).
 *
 * It is rendered from the decision document like everything else here, because
 * the block travels IN that document — the command projects the snapshot onto it
 * before printing either form. A renderer that read the snapshot itself would be
 * the second source this file exists to avoid, and `--json` would stop carrying
 * what the text shows.
 *
 * Absent is normal and prints nothing: the field is optional, and a decision
 * assembled without a snapshot in reach is still a decision.
 */
function availabilityLines(harnesses) {
  if (!Array.isArray(harnesses) || !harnesses.length) return [];
  const nameWidth = widest(harnesses.map((h) => h.harness)) + 2;
  const lines = ['', 'availability:'];
  for (const h of harnesses) {
    const extras = [tierText(h.tier)];
    if (h.credits) extras.push(h.credits.unlimited ? 'credits unlimited' : `credits ${h.credits.available ? 'available' : 'none'}`);
    if (h.resetCredits) extras.push(`reset credits ${h.resetCredits.available}`);
    lines.push(`  ${h.harness.padEnd(nameWidth)}${h.state.padEnd(STATE_WIDTH)}${extras.join(' · ')}`);
    const windows = Array.isArray(h.windows) ? h.windows : [];
    const idWidth = widest(windows.map((w) => w.id)) + 2;
    for (const w of windows) lines.push(windowRow(w, idWidth));
  }
  return lines;
}

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
/** Unrated rows the text form prints per harness before it counts the rest (PB-20.1). */
export const RUNTIME_ROWS_PER_HARNESS = 8;

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
    neverChecked(decision.snapshot.takenAt)
      ? `snapshot: never checked · source ${decision.snapshot.source}`
      : `snapshot: ${decision.snapshot.takenAt} · ${decision.snapshot.ageSec} s old · source ${decision.snapshot.source}`,
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

  lines.push(...availabilityLines(decision.harnesses));

  if (decision.runtime.length) {
    lines.push('', 'runtime models — not rated, never chosen automatically:');
    // The text form shows a FEW unrated rows per harness and counts the rest: an
    // account that lists two hundred models the catalog does not rate would
    // otherwise push the decision and the warnings to the two ends of a page
    // (PB-20.1). `--json` keeps every row, so the two outputs cannot drift.
    const byHarness = new Map();
    for (const r of decision.runtime) {
      if (!byHarness.has(r.harness)) byHarness.set(r.harness, []);
      byHarness.get(r.harness).push(r);
    }
    for (const [harness, rows] of byHarness) {
      for (const r of rows.slice(0, RUNTIME_ROWS_PER_HARNESS)) {
        lines.push(`    ${r.harness} / ${r.model}${r.flags?.length ? `  [${r.flags.join(', ')}]` : ''}`);
      }
      const rest = rows.length - RUNTIME_ROWS_PER_HARNESS;
      if (rest > 0) lines.push(`    ${harness}: … and ${rest} more — every row is in --json`);
    }
  }

  if (decision.warnings.length) {
    lines.push('', 'warnings:');
    for (const w of decision.warnings) lines.push(`  ! ${w.code}: ${w.message}`);
  }

  return `${lines.join('\n')}\n`;
}
