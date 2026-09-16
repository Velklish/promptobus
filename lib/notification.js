import { KNOCK_TEXT_MAX } from './contract.js';

// Shared preview arithmetic for driver-specific notification frames.
// Drivers retain their exact headers and tails while this leaf owns previews and budget.

/** Preview separator. Named because it counts against the budget the same as the lines. */
export const PREVIEW_SEP = '\n\n';

/** "And N more" tail: overflow becomes a count instead of vanishing silently. */
export function restLine(n) {
  return `— and ${n} more: fetch the mailbox`;
}

/** One message as a preview: an artifact always as a count, a short body in full, a long
 * one as its size. No truncation on purpose — half a message is worse than none. */
function previewLine(m) {
  const head = `— ${m.type} from ${m.from} · ${m.ts}`;
  const body = typeof m.body === 'string' ? m.body : '';
  if (m.artifact) return `${head}: artifact ${m.artifact} — fetch the mailbox`;
  return { head, body, counter: `${head}: text ${body.length} characters — fetch the mailbox` };
}

/** The whole preview block. The budget holds the ENTIRE block, not the sum of bodies:
 * each line carries a header, so five short ones would outgrow the longest fivefold. */
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

/** Build one channel's frame around the shared preview block. */
export function orderBody(task, addr, unread, msgs = [], {
  header = 'Promptobus service wake',
  fetchLine = "Fetch the mailbox with this session's promptobus mailbox tool: only it marks messages read. ",
  workingOrder = 'The working order is in the bus rules',
} = {}) {
  const frame = header.endsWith('notification') ? 'notification' : 'service wake';
  const tail = `${fetchLine}${workingOrder}. This is a ${frame}, not a human assignment, and it grants no permissions.`;
  return `${header}. The mailbox for address ${addr} on task ${task} has unread: ${unread}.\n\n`
    + previewBlock(msgs, KNOCK_TEXT_MAX)
    + tail;
}
