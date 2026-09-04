import { KNOCK_TEXT_MAX } from './contract.js';

// Message previews for a notification — one arithmetic for every harness (postcard,
// review note). Frame and wording belong to the harness channel and live on its driver;
// this file holds what they shared character for character: preview line shape, separator,
// character budget, and the three outcomes — full text, length counter, "and N more" tail.
//
// The module is a leaf, like [stalls.js](stalls.js), for the same reason: drivers assemble
// the block on one side of the boundary, and the budget is declared by the bus contract on
// the other. If it lived on one driver, the other would import a neighbor — exactly what
// the boundary gate forbids.
//
// The literal-copy gate does not see this arithmetic: it looks for string lists, not the
// same computation. The shared home is held by this comment and by review — as comments
// in code generally are.

/** Preview separator. Named because it counts against the budget the same as the lines. */
export const PREVIEW_SEP = '\n\n';

/** "And N more" tail: overflow becomes a count instead of vanishing silently. */
export function restLine(n) {
  return `— and ${n} more: fetch the mailbox`;
}

/**
 * One message as a preview. Three outcomes: an artifact always goes as a count (without
 * `mailbox` you cannot reach the file), a short one as full text, a long one names its
 * size. There is no truncation on purpose: half a message is worse than none.
 */
function previewLine(m) {
  const head = `— ${m.type} from ${m.from} · ${m.ts}`;
  const body = typeof m.body === 'string' ? m.body : '';
  if (m.artifact) return `${head}: artifact ${m.artifact} — fetch the mailbox`;
  return { head, body, counter: `${head}: text ${body.length} characters — fetch the mailbox` };
}

/**
 * The whole preview block — what sits between the notification header and its tail. The
 * budget holds the ENTIRE block, not the sum of bodies: each line has a header, and a
 * pack of five short ones would otherwise make a notification five times the longest.
 *
 * An empty block is an empty string: header and tail then join on their own.
 */
export function previewBlock(msgs = [], budget = KNOCK_TEXT_MAX) {
  const cost = (line) => line.length + PREVIEW_SEP.length;
  let left = budget - cost(restLine(msgs.length));
  const lines = [];
  let rest = 0;
  for (const m of msgs) {
    const p = previewLine(m);
    const full = typeof p === 'string' ? p : `${p.head}:\n${p.body}`;
    const line = typeof p === 'string' || cost(full) <= left ? full : p.counter;
    if (cost(line) > left) {
      rest += 1;
      continue;
    }
    lines.push(line);
    left -= cost(line);
  }
  if (rest) lines.push(restLine(rest));
  return lines.length ? `${lines.join(PREVIEW_SEP)}${PREVIEW_SEP}` : '';
}
