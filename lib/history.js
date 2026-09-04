import { fail, info, ok } from './util.js';
import { hostOf } from './host.js';
import {
  addrDir, addressOf, history as historyPage, isAddress, listTasks, nameOfArtifact, promptobusHome, readTask,
  taskExists,
} from './store.js';

// Journal of read mail: a page of entries from oldest to newest. It reads
// history only — unread mail sits in the mailbox, and this command does not look there
// at all. That is its main property: `history` marks nothing as read.
//
// The unit is an ENTRY, not a message: one message sitting with two people yields two
// entries, and the limit counts entries. A page boundary may therefore legally split a
// group of entries for one message — the history cursor is opaque and carries the full
// order key.

// The default limit lives in the store itself (`history({ limit = 50 })`), not here:
// prose cites one number, and a second declaration would drift from it silently.
const BODY_MAX = 120;

// Body preview — first non-empty line, trimmed at a word boundary. A `result` body can
// be thousands of characters, and a journal line must stay one line.
function say(body) {
  const line = String(body ?? '').split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  if (line.length <= BODY_MAX) return line;
  const cut = line.slice(0, BODY_MAX);
  const space = cut.lastIndexOf(' ');
  return (space > BODY_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd();
}

// Reverse map of a v1 participant id back to a bus address. The forward map
// (`worker:api` → `worker-api`) is unique; the reverse is not: a slug itself may contain
// a hyphen. So the map is built from the task journal, not by parsing the string; if the
// journal has no entry, we print the id as-is, because a history entry older than the
// participant is a legal case.
function addressMap(home, task) {
  const map = new Map();
  let meta = null;
  try {
    meta = readTask(home, task);
  } catch {
    // A broken task must not take the history of the others with it.
    return map;
  }
  for (const p of meta?.participants ?? []) {
    try {
      map.set(addrDir(addressOf(p)), addressOf(p));
    } catch {
      // A bad address in a former CLI journal: skip the entry, not the whole task.
    }
  }
  return map;
}

export function history(rootOrHost, { task, participant, limit, all } = {}) {
  const host = hostOf(rootOrHost);
  const cmd = host.commandName;
  if (all && limit !== undefined) {
    fail(`${cmd} history: --all and --limit together are not accepted — --all drops the limit entirely`);
  }
  let take;
  if (limit !== undefined) {
    take = Number(limit);
    if (!Number.isInteger(take) || take <= 0) {
      fail(`${cmd} history: --limit "${limit}" — expected a positive integer`);
    }
  }
  const home = promptobusHome(host.workspaceRoot(), host);
  if (task && !taskExists(home, task)) {
    const known = listTasks(home).map((t) => t.id);
    fail(`${cmd} history: task "${task}" is not in the journal`
      + `${known.length ? `. Known: ${known.join(', ')}` : ''}`);
  }
  let box;
  if (participant !== undefined) {
    if (!isAddress(participant)) {
      fail(`${cmd} history: --participant "${participant}" — expected orchestrator, `
        + 'worker:<slug> or reviewer:<slug>');
    }
    box = addrDir(participant);
  }
  const page = historyPage(home, {
    ...(task ? { task } : {}),
    ...(box ? { participant: box } : {}),
    ...(take !== undefined ? { limit: take } : {}),
    ...(all ? { all: true } : {}),
  });
  if (page.broken.length) {
    info(`skipped unreadable entries: ${page.broken.length}`);
  }
  if (!page.entries.length) {
    ok('history is empty — no read mail matches these filters');
    return;
  }
  const names = new Map();
  ok(`${page.entries.length} entries${page.cursor ? ' (older ones exist — drop the limit with --all)' : ''}`);
  for (const e of page.entries) {
    if (!names.has(e.task)) names.set(e.task, addressMap(home, e.task));
    const addr = names.get(e.task);
    const from = addr.get(e.message.sender) ?? e.message.sender;
    const to = addr.get(e.participant) ?? e.participant;
    const said = say(e.message.body);
    // An artifact is named by FILE NAME, as on every other surface: the message carries
    // a metadata-record id, and a person will not find the file in the task folder by
    // that. The name is read by the same helper the tool replies use; if it cannot be
    // read, there is no tail at all.
    const named = e.message.artifact ? nameOfArtifact(home, e.task, e.message.artifact) : undefined;
    info(`${e.message.ts} · ${e.task} · ${e.message.type} ${from} → ${to}`
      + `${named ? ` · artifact ${named}` : ''}`
      + `${said ? ` — ${said}` : ''}`);
  }
}
