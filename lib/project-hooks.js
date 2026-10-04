// The project's own hook records a lift keeps beside the guard: those its promptobus.json trusts (ADR-025).
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const TRUST_CONFIG = 'promptobus.json';
const TRUST_FIELD = 'trustedHooks';

// The event keys a lift keeps project records under: the session start and the stop of each harness.
const EVENT_KEYS = { codex: ['SessionStart', 'Stop'], cursor: ['sessionStart', 'stop'] };
// Codex nests records in `{ hooks: [ … ] }` groups; Cursor lists them flat beside `version`.
const SHAPES = {
  codex: { top: ['hooks'], grouped: true, entry: ['command', 'type'] },
  cursor: { top: ['hooks', 'version'], grouped: false, entry: ['command'] },
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasKeys = (value, keys) => isObject(value) && Object.keys(value).sort().join() === keys.join();
const isCommandList = (list) => Array.isArray(list) && list.every((c) => typeof c === 'string' && c.length > 0);
const wordsOf = (command) => command.split(/\s+/).map((word) => word.replace(/^["']+|["']+$/g, '')).filter(Boolean);
const fileName = (word) => word.split(/[\\/]/).pop();

// A bus guard, fail-closed and quotes ignored: a bare `guard` after a word naming promptobus, or the
// words of the lift's own guard command after its launcher, through `guard`, compared by file name.
function isBusGuard(command, guardCommand) {
  const words = wordsOf(command);
  if (words.some((word, i) => word === 'guard' && words.slice(0, i).some((w) => /promptobus/i.test(w)))) return true;
  const own = guardCommand ? wordsOf(guardCommand) : [];
  const stem = own.slice(1, own.indexOf('guard') + 1).map(fileName);
  const names = words.map(fileName);
  return stem.length > 0 && names.some((_, i) => stem.every((name, j) => names[i + j] === name));
}

/** Commands `root`'s promptobus.json trusts for `harness`, by event key, or why that declaration is unusable.
 * `text` is that file's content, `null` for none; `undefined` reads it from disk. */
function trustedHookCommands(root, harness, text) {
  const file = path.join(root, TRUST_CONFIG);
  const none = { commands: {}, broken: null };
  const unusable = (broken) => ({ commands: {}, broken });
  if (text === null) return none;
  let doc;
  try {
    doc = JSON.parse(text ?? readFileSync(file, 'utf8'));
  } catch (error) {
    return error.code === 'ENOENT' ? none : unusable(`${file} is not readable JSON (${error.message})`);
  }
  if (!isObject(doc)) return unusable(`${file} must hold a JSON object`);
  const declared = doc[TRUST_FIELD];
  if (declared === undefined) return none;
  const forHarness = isObject(declared) ? declared[harness] : null;
  if (forHarness === undefined) return none;
  if (isObject(forHarness) && Object.values(forHarness).every(isCommandList)) return { commands: forHarness, broken: null };
  return unusable(`"${TRUST_FIELD}" in ${file} must map a harness to event keys and each key to an array of command strings`);
}

/** The trust rule as a sentence without its full stop, for a message about `root`'s hooks file of `harness`. */
export function trustRule(root, harness) {
  const keys = EVENT_KEYS[harness].map((key) => `"${TRUST_FIELD}.${harness}.${key}"`).join(' or ');
  return `A lift keeps a project record only when its command is listed under ${keys} in ${path.join(root, TRUST_CONFIG)}, `
    + 'and never a Promptobus guard';
}

/** Trusted records as `{ key, command }`, every other record as its text, and why the declaration is unusable.
 * `declaration` stands in for the declaration file's text (`null`: none); `guard` is the lift's guard command. */
export function judgeHookRecords(text, root, harness, { declaration, guard = null } = {}) {
  const accepted = [];
  const refused = [];
  const { commands, broken } = trustedHookCommands(root, harness, declaration);
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { accepted, refused: [`not JSON (${error.message})`], broken };
  }
  if (!isObject(doc)) return { accepted, refused: [JSON.stringify(doc)], broken };
  const shape = SHAPES[harness];
  for (const [name, value] of Object.entries(doc)) {
    if (!shape.top.includes(name)) refused.push(`${name}: ${JSON.stringify(value)}`);
  }
  if (doc.hooks === undefined) return { accepted, refused, broken };
  if (!isObject(doc.hooks)) return { accepted, refused: [...refused, `hooks: ${JSON.stringify(doc.hooks)}`], broken };
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
        && EVENT_KEYS[harness].includes(key) && (commands[key] ?? []).includes(entry.command)
        && !isBusGuard(entry.command, guard);
      if (ok) accepted.push({ key, command: entry.command });
      else refused.push(`${key}: ${JSON.stringify(entry)}`);
    }
  }
  return { accepted, refused, broken };
}
