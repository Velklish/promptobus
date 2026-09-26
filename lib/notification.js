import { KNOCK_TEXT_MAX } from './contract.js';

// Shared preview arithmetic for driver-specific notification frames.
// Drivers retain their exact headers and tails while this leaf owns previews and budget.

/** Preview separator. Named because it counts against the budget the same as the lines. */
export const PREVIEW_SEP = '\n\n';

/** Where a bus line is read once the postcard has no room for it: it is not in the mailbox. */
const BUS_ROUTE = 'not in the mailbox — the bus status command shows it';

/** "And N more" tail: overflow becomes a count instead of vanishing silently. Mail is fetched from
 * the mailbox; a bus line is not there, so it is counted apart. */
export function restLine(n, bus = 0) {
  const parts = [];
  if (n) parts.push(`${n} more: fetch the mailbox`);
  if (bus) parts.push(`${bus} bus line${bus > 1 ? 's' : ''} more, ${BUS_ROUTE}`);
  return `— and ${parts.join('; ')}`;
}

/** One message as a preview: its stub — sender, type and size, never the text. A bus line
 * (`bus: true`) rides whole when it fits, and otherwise names its size and where to read it. */
function previewLine(m) {
  const head = `— ${m.type} from ${m.from} · ${m.ts}`;
  const body = typeof m.body === 'string' ? m.body : '';
  if (m.bus === true) return { full: `${head}:\n${body}`, counter: `${head}: ${body.length} characters, ${BUS_ROUTE}` };
  if (m.artifact) return `${head}: artifact ${m.artifact} — fetch the mailbox`;
  return `${head}: text ${body.length} characters — fetch the mailbox`;
}

/** The whole preview block. The budget holds the ENTIRE block of stub lines: a burst of mail
 * would otherwise grow the postcard line by line. */
export function previewBlock(msgs = [], budget = KNOCK_TEXT_MAX) {
  const cost = (line) => line.length + PREVIEW_SEP.length;
  const busTotal = msgs.filter((m) => m.bus === true).length;
  let left = budget - cost(restLine(msgs.length - busTotal, busTotal));
  const lines = [];
  let rest = 0;
  let restBus = 0;
  for (const m of msgs) {
    const p = previewLine(m);
    const line = typeof p === 'string' ? p : (cost(p.full) <= left ? p.full : p.counter);
    if (cost(line) > left) {
      if (m.bus === true) restBus += 1;
      else rest += 1;
      continue;
    }
    lines.push(line);
    left -= cost(line);
  }
  if (rest || restBus) lines.push(restLine(rest, restBus));
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
