// Rendering a decision for a person.
// [guides/model-routing.md#rendering-a-decision-for-a-person](../../docs/guides/model-routing.md#rendering-a-decision-for-a-person)
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

/** Whether nothing in this snapshot was ever checked: `NEVER_CHECKED` is the epoch, and as
 * a number it prints "1788614269 s old". Only the human line changes, the document does not. */
const neverChecked = (takenAt) => Date.parse(takenAt) === 0;

/** A signed number: an adjustment reads as what it did, so a bonus keeps its plus. */
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);

/** What a window binds, in one phrase: the scope as the harness named it, and not the ids
 * behind it — those are in `--json`, and a person wants to know which limit it is. */
function scopeText(scope) {
  if (!scope) return 'account';
  if (scope.pool) return `pool ${scope.pool}`;
  return `model ${scope.model}`;
}

/** One window of one harness. ADR-004 makes `kind` a NAME and `lengthSec` the number, so
 * neither folds into the other; a window with no reset says so rather than claiming never. */
function windowRow(w, idWidth) {
  const reset = w.resetAt ? `resets ${w.resetAt}` : 'reset time unknown';
  return `      ${w.id.padEnd(idWidth)}${String(w.kind).padEnd(KIND_WIDTH)}`
    + `${w.usedPercent.toFixed(1)}% used · ${w.lengthSec} s · ${scopeText(w.scope)} · ${reset}`;
}

/** The tier as a person reads it: the plan and where the value came from, or that the harness names none. */
function tierText(tier) {
  return tier ? `tier ${tier.name} (${tier.source})` : 'tier unknown';
}

/** The availability block (ADR-004), rendered from the decision document like everything
 * here: a renderer reading the snapshot itself would be a second source. Absent prints nothing. */
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

/** A pace number as the terminal shows it. Two decimals, because one prints −0.02 as "-0.0";
 * always a sign, because these are differences and not levels. */
const points = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;

// The pace table, and which lines it must always print.
// [guides/model-routing.md#pacelines--the-pace-table-and-which-lines-it-must-always-print](../../docs/guides/model-routing.md#pacelines--the-pace-table-and-which-lines-it-must-always-print)
function paceLines(decision) {
  if (decision.strategy !== 'balance') return [];
  const scored = decision.candidates.filter((c) => c.pace);
  if (!scored.length) return [];
  const band = decision.balance?.band;
  const spendUnit = decision.balance?.spendUnit;
  const lines = ['', `pace — percentage points of each binding window${
    Number.isFinite(band) ? ` · band ${band.toFixed(1)} · spend unit ${spendUnit.toFixed(1)}` : ''}:`];
  const groups = new Map();
  const unpaced = new Map();
  const harnessesWithWindow = new Set();
  for (const row of scored) {
    if (!row.pace.window) {
      if (!unpaced.has(row.harness)) unpaced.set(row.harness, []);
      unpaced.get(row.harness).push(row);
      continue;
    }
    harnessesWithWindow.add(row.harness);
    const pool = row.pace.window?.scope?.pool ?? null;
    const key = `${row.harness}\u0000${pool ?? ''}`;
    if (!groups.has(key)) groups.set(key, { harness: row.harness, rows: [] });
    groups.get(key).rows.push(row);
  }
  // Keep one note only for a harness whose scored tuples have no window at all: otherwise a
  // no-pace tuple would contradict another pool of the same harness that has one.
  for (const [harness, rows] of unpaced) {
    if (!harnessesWithWindow.has(harness)) groups.set(`${harness}\u0000`, { harness, rows });
  }
  const nameWidth = widest([...groups.values()].map(({ harness }) => harness)) + 2;
  for (const { harness, rows } of groups.values()) {
    const rep = rows.find((c) => c.pace.representative) ?? rows.find((c) => c.pace.eligible) ?? rows[0];
    const marker = rep.chosen ? MARKERS.chosen : ' ';
    const head = `  ${marker} ${harness.padEnd(nameWidth)}`;
    const { pace } = rep;
    const pool = pace.window?.scope?.pool;
    const poolText = pool ? `pool ${pool} · ` : '';
    if (!pace.eligible) {
      const why = pace.note === 'window-spent'
        ? `${pace.window.id} is spent — ${(pace.usedShare * 100).toFixed(1)}% used`
        : 'no window that can be paced';
      lines.push(`${head}${poolText}${pace.note}: ${why}`);
      continue;
    }
    lines.push(`${head}${poolText}${rep.tupleId} · ${pace.window.id} ${pace.window.kind} · `
      + `${(pace.usedShare * 100).toFixed(1)}% used · ${(pace.elapsedShare * 100).toFixed(1)}% elapsed · `
      + `underspend ${points(pace.underspend)} · penalty ${points(0 - pace.spendPenalty)} · `
      + `effective ${points(pace.effective)}`
      // The number is still printed at the cap: the row says what the account has room for.
      // A row silently missing it would read as an unpaceable window, a different fact.
      + (pace.atCap ? ' · at its live-participant cap' : ''));
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

// Printed once under the heading rather than repeated in every `near-limit` line: the
// signal is per harness, and this answers the two questions a reader has about all of them.
const NEAR_LIMIT_NOTE = '  near-limit is measured from pace, not from a missing limit source — that one is '
  + '`unknown-remaining` — and it is not raised at all under the strategy it would propose, so one snapshot '
  + 'names it under one strategy and not under another.';

/** The fields this renderer reads. `chosen` is not among them: `null` there is the empty-candidate case. */
/** Unrated rows the text form prints per harness before it counts the rest (PB-20.1). */
export const RUNTIME_ROWS_PER_HARNESS = 8;

const READS = ['strategy', 'role', 'candidates', 'runtime', 'warnings', 'overlays', 'snapshot'];

/** What is missing from a document that claims to be a decision, or `null`. The whole shape
 * is checked: `render` is exported, and a consumer may pass one read from `models --json`. */
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

/** A decision as the terminal shows it. Blocks that carry nothing are left out: a `warnings:`
 * heading with nothing under it reads as a warning that failed to print. */
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

  lines.push(...paceLines(decision));
  lines.push(...availabilityLines(decision.harnesses));

  if (decision.runtime.length) {
    lines.push('', 'runtime models — not rated, never chosen automatically:');
    // A FEW unrated rows per harness and a count of the rest: two hundred of them would push
    // the decision and the warnings to opposite ends of a page. `--json` keeps every row.
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
    if (decision.warnings.some((w) => w.code === 'near-limit')) lines.push(NEAR_LIMIT_NOTE);
  }

  return `${lines.join('\n')}\n`;
}
