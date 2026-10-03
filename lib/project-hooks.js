// The tracker's own records a lift accepts in a project hooks file, beside the guard (ADR-025).
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const TRACKER_CONFIG = 'backslop.json';

const EVENT_KEYS = {
  codex: { 'session-start': 'SessionStart', stop: 'Stop' },
  cursor: { 'session-start': 'sessionStart', stop: 'stop' },
};
// Codex nests records in `{ hooks: [ … ] }` groups; Cursor lists them flat beside `version`.
const SHAPES = {
  codex: { top: ['hooks'], grouped: true, entry: ['command', 'type'] },
  cursor: { top: ['hooks', 'version'], grouped: false, entry: ['command'] },
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasKeys = (value, keys) => isObject(value) && Object.keys(value).sort().join() === keys.join();

function trackerCli(root) {
  try {
    const cli = JSON.parse(readFileSync(path.join(root, TRACKER_CONFIG), 'utf8'))?.cli;
    return typeof cli === 'string' && cli.trim() ? cli.trim() : null;
  } catch {
    return null;
  }
}

/** The commands accepted in `root`'s hooks file of `harness`, by event key; none without a tracker `cli`. */
export function acceptedHookCommands(root, harness) {
  const cli = trackerCli(root);
  if (!cli) return new Map();
  return new Map(Object.entries(EVENT_KEYS[harness])
    .map(([event, key]) => [key, `${cli} hook ${event} --harness ${harness}`]));
}

/** Accepted records as `{ key, command }`, and every other record as its text. */
export function judgeHookRecords(text, root, harness) {
  const accepted = [];
  const refused = [];
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { accepted, refused: [`not JSON (${error.message})`] };
  }
  if (!isObject(doc)) return { accepted, refused: [JSON.stringify(doc)] };
  const shape = SHAPES[harness];
  const commands = acceptedHookCommands(root, harness);
  for (const [name, value] of Object.entries(doc)) {
    if (!shape.top.includes(name)) refused.push(`${name}: ${JSON.stringify(value)}`);
  }
  if (doc.hooks === undefined) return { accepted, refused };
  if (!isObject(doc.hooks)) return { accepted, refused: [...refused, `hooks: ${JSON.stringify(doc.hooks)}`] };
  for (const [key, list] of Object.entries(doc.hooks)) {
    if (!Array.isArray(list)) {
      refused.push(`${key}: ${JSON.stringify(list)}`);
      continue;
    }
    const entries = [];
    for (const item of list) {
      if (!shape.grouped) entries.push(item);
      else if (hasKeys(item, ['hooks']) && Array.isArray(item.hooks)) entries.push(...item.hooks);
      else refused.push(`${key}: ${JSON.stringify(item)}`);
    }
    for (const entry of entries) {
      const ok = hasKeys(entry, shape.entry) && (!shape.grouped || entry.type === 'command')
        && entry.command === commands.get(key);
      if (ok) accepted.push({ key, command: entry.command });
      else refused.push(`${key}: ${JSON.stringify(entry)}`);
    }
  }
  return { accepted, refused };
}
