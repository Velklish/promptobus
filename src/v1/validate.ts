// Own protocol v1 validators: production does not read JSON Schemas at all.
//
// The schemas live in `schemas/v1` and ship in the tarball for consumers; here
// the same grammar is written by hand — so the package has no runtime
// dependency. Drift between two descriptions of one contract is caught by a
// parity test on a shared fixture set
// ([v1-validate.test.mjs](../../test/v1-validate.test.mjs)); edit one — edit
// the other, or the red will come from there.
//
// Check order inside a model is not accidental: the schema version comes
// FIRST. A newer-version record is blocked by its own code without touching
// the store, and there is no point parsing the rest of its fields — we do not
// know the fields of that version.
import { ERROR_CODES, PromptobusError } from './errors.js';
import type { ErrorCode } from './errors.js';
import {
  BLOB_PATH_RE, FILENAME_RE, HARNESS_RE, MESSAGE_PROTOCOL_VERSION, MESSAGE_TYPES_V1,
  PARTICIPANT_ID_RE, RECORD_ID_RE, ROLE_RE, SCHEMA_VERSION, SHA256_RE, TASK_ID_RE, TIMESTAMP_RE,
} from './model.js';
import type { ModelName } from './model.js';

/** Validator verdict: where the refusal is and why. The code is required — the consumer branches on it. */
export interface Verdict {
  ok: boolean;
  code: ErrorCode | null;
  /** Path to the bad field: `participants[1].harness`. Empty when accepted. */
  at: string;
  note: string;
  /**
   * Unfamiliar fields the refusal is about. A separate field, not a parse of
   * `note`: the reader uses it to tell "a record written by a mechanism newer
   * than me" from corruption, and the refusal text is prose — a matcher on it
   * would drift with the first wording change.
   */
  extra: readonly string[];
}

const OK: Verdict = { ok: true, code: null, at: '', note: '', extra: [] };

function bad(at: string, note: string, code: ErrorCode = 'schema-invalid', extra: readonly string[] = []): Verdict {
  return { ok: false, code, at, note, extra };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// An extra field is a refusal, not a loosening: `additionalProperties: false`
// stands in all four schemas, and a validator that let an unfamiliar field
// through would drift from the schema in silence.
function extras(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((k) => !allowed.includes(k));
}

function text(value: unknown, at: string, re: RegExp): Verdict | null {
  if (typeof value !== 'string') return bad(at, 'expected a string');
  if (!re.test(value)) return bad(at, `does not match grammar ${re.source}`);
  return null;
}

// Record version. Newer — its own code and a refusal before any write; older
// or malformed — ordinary invalidity: there is no migration into v1.
function version(value: unknown, at: string, expected: number): Verdict | null {
  if (value === expected) return null;
  if (typeof value === 'number' && Number.isInteger(value) && value > expected) {
    return bad(at, `version ${value} is newer than supported ${expected}`, 'schema-version-unsupported');
  }
  return bad(at, `expected ${expected}`);
}

// Five required and four optional: a contract extension must not make a
// record written before it unreadable — those sit in live task journals.
const CAPABILITY_KEYS = [
  'spawn', 'attach', 'activation', 'inspect', 'stop',
  'denyTools', 'systemPrompt', 'sessionList', 'enter',
] as const;
const CAPABILITY_OPTIONAL = ['denyTools', 'systemPrompt', 'sessionList', 'enter'] as const;
const PARTICIPANT_KEYS = ['id', 'role', 'harness', 'mode', 'sessionRef', 'capabilities', 'metadata'] as const;
const TASK_KEYS = ['schemaVersion', 'id', 'title', 'status', 'owner', 'created', 'updated', 'participants', 'adapter'] as const;
const MESSAGE_KEYS = ['protocolVersion', 'id', 'task', 'sender', 'recipients', 'type', 'body', 'artifact', 'ts'] as const;
const ARTIFACT_KEYS = ['schemaVersion', 'id', 'sha256', 'filename', 'size', 'blob'] as const;

function capabilities(value: unknown, at: string): Verdict | null {
  if (value === null) return null;
  if (!isObject(value)) return bad(at, 'expected an object or null');
  const extra = extras(value, CAPABILITY_KEYS);
  if (extra.length) return bad(at, `extra fields: ${extra.join(', ')}`, 'schema-invalid', extra);
  for (const key of ['spawn', 'attach', 'inspect', 'stop']) {
    if (typeof value[key] !== 'boolean') return bad(`${at}.${key}`, 'expected boolean');
  }
  if (value.activation !== 'push' && value.activation !== 'pull') {
    return bad(`${at}.activation`, 'expected push or pull');
  }
  // Optional — only when present: no field at all (a previous-release record)
  // is lawful; a non-boolean in it is the same corruption as in a required one.
  for (const key of CAPABILITY_OPTIONAL) {
    if (Object.hasOwn(value, key) && typeof value[key] !== 'boolean') {
      return bad(`${at}.${key}`, 'expected boolean');
    }
  }
  return null;
}

function participant(value: unknown, at: string): Verdict | null {
  if (!isObject(value)) return bad(at, 'expected an object');
  const extra = extras(value, PARTICIPANT_KEYS);
  if (extra.length) return bad(at, `extra fields: ${extra.join(', ')}`, 'schema-invalid', extra);
  for (const key of PARTICIPANT_KEYS) {
    if (!Object.hasOwn(value, key)) return bad(`${at}.${key}`, 'field is required');
  }
  const id = text(value.id, `${at}.id`, PARTICIPANT_ID_RE);
  if (id) return id;
  const role = text(value.role, `${at}.role`, ROLE_RE);
  if (role) return role;
  // Harness is required and non-empty: v1 has no fallback at all. A record
  // without a harness is the one the registry fallback was invented for, and
  // in v1 nobody creates one.
  const harness = text(value.harness, `${at}.harness`, HARNESS_RE);
  if (harness) return harness;
  if (value.mode !== 'managed' && value.mode !== 'attached') {
    return bad(`${at}.mode`, 'expected managed or attached');
  }
  if (value.sessionRef !== null && (typeof value.sessionRef !== 'string' || !value.sessionRef)) {
    return bad(`${at}.sessionRef`, 'expected a non-empty string or null');
  }
  const caps = capabilities(value.capabilities, `${at}.capabilities`);
  if (caps) return caps;
  if (!isObject(value.metadata)) return bad(`${at}.metadata`, 'expected an object');
  return null;
}

function task(value: unknown): Verdict {
  if (!isObject(value)) return bad('', 'expected an object');
  const ver = version(value.schemaVersion, 'schemaVersion', SCHEMA_VERSION);
  if (ver) return ver;
  const extra = extras(value, TASK_KEYS);
  if (extra.length) return bad('', `extra fields: ${extra.join(', ')}`, 'schema-invalid', extra);
  for (const key of TASK_KEYS) {
    if (!Object.hasOwn(value, key)) return bad(key, 'field is required');
  }
  const id = text(value.id, 'id', TASK_ID_RE);
  if (id) return id;
  if (typeof value.title !== 'string' || !value.title || value.title.length > 512) {
    return bad('title', 'expected a non-empty string no longer than 512');
  }
  if (value.status !== 'active' && value.status !== 'done') return bad('status', 'expected active or done');
  const owner = text(value.owner, 'owner', PARTICIPANT_ID_RE);
  if (owner) return owner;
  for (const key of ['created', 'updated'] as const) {
    const ts = text(value[key], key, TIMESTAMP_RE);
    if (ts) return ts;
  }
  if (!Array.isArray(value.participants) || !value.participants.length) {
    return bad('participants', 'expected a non-empty array');
  }
  for (let i = 0; i < value.participants.length; i += 1) {
    const p = participant(value.participants[i], `participants[${i}]`);
    if (p) return p;
  }
  if (!isObject(value.adapter)) return bad('adapter', 'expected an object');
  return OK;
}

function message(value: unknown): Verdict {
  if (!isObject(value)) return bad('', 'expected an object');
  const ver = version(value.protocolVersion, 'protocolVersion', MESSAGE_PROTOCOL_VERSION);
  if (ver) return ver;
  const extra = extras(value, MESSAGE_KEYS);
  if (extra.length) return bad('', `extra fields: ${extra.join(', ')}`, 'schema-invalid', extra);
  for (const key of MESSAGE_KEYS) {
    if (key !== 'artifact' && !Object.hasOwn(value, key)) return bad(key, 'field is required');
  }
  const id = text(value.id, 'id', RECORD_ID_RE);
  if (id) return id;
  const taskId = text(value.task, 'task', TASK_ID_RE);
  if (taskId) return taskId;
  const sender = text(value.sender, 'sender', PARTICIPANT_ID_RE);
  if (sender) return sender;
  if (!Array.isArray(value.recipients) || !value.recipients.length) {
    return bad('recipients', 'expected a non-empty array');
  }
  for (let i = 0; i < value.recipients.length; i += 1) {
    const r = text(value.recipients[i], `recipients[${i}]`, PARTICIPANT_ID_RE);
    if (r) return r;
  }
  if (new Set(value.recipients as string[]).size !== value.recipients.length) {
    return bad('recipients', 'duplicate recipients');
  }
  if (typeof value.type !== 'string' || !MESSAGE_TYPES_V1.includes(value.type)) {
    return bad('type', `not a v1 protocol type: ${MESSAGE_TYPES_V1.join(', ')}`);
  }
  if (typeof value.body !== 'string' || !value.body) return bad('body', 'expected a non-empty string');
  if (Object.hasOwn(value, 'artifact')) {
    const art = text(value.artifact, 'artifact', RECORD_ID_RE);
    if (art) return art;
  }
  const ts = text(value.ts, 'ts', TIMESTAMP_RE);
  if (ts) return ts;
  return OK;
}

function artifact(value: unknown): Verdict {
  if (!isObject(value)) return bad('', 'expected an object');
  const ver = version(value.schemaVersion, 'schemaVersion', SCHEMA_VERSION);
  if (ver) return ver;
  const extra = extras(value, ARTIFACT_KEYS);
  if (extra.length) return bad('', `extra fields: ${extra.join(', ')}`, 'schema-invalid', extra);
  for (const key of ARTIFACT_KEYS) {
    if (!Object.hasOwn(value, key)) return bad(key, 'field is required');
  }
  const id = text(value.id, 'id', RECORD_ID_RE);
  if (id) return id;
  const sha = text(value.sha256, 'sha256', SHA256_RE);
  if (sha) return sha;
  const name = text(value.filename, 'filename', FILENAME_RE);
  if (name) return name;
  // `.` and `..` pass the name grammar (no separator in them) but address a directory.
  if (value.filename === '.' || value.filename === '..') return bad('filename', 'a directory name, not a file');
  if ((value.filename as string).length > 255) return bad('filename', 'longer than 255');
  if (!Number.isInteger(value.size) || (value.size as number) < 0) {
    return bad('size', 'expected a non-negative integer');
  }
  const blob = text(value.blob, 'blob', BLOB_PATH_RE);
  if (blob) return blob;
  return OK;
}

const VALIDATORS: Record<ModelName, (value: unknown) => Verdict> = {
  task,
  // A participant is checked both on its own and inside a task journal, so the
  // path to the field arrives as a prefix. A standalone record has no prefix —
  // a leading dot in the path is extra.
  participant: (value) => {
    const verdict = participant(value, '');
    return verdict ? { ...verdict, at: verdict.at.replace(/^\./, '') } : OK;
  },
  message,
  artifact,
};

/** Check a record against a model. A verdict, not a throw: the reader isolates the bad, it does not crash. */
export function validate(model: ModelName, value: unknown): Verdict {
  const check = VALIDATORS[model];
  if (!check) return bad('', `unknown model «${model}»`);
  return check(value);
}

/** The same as a throw — for writes: the bad never enters the store. */
export function requireValid(model: ModelName, value: unknown, context: Record<string, unknown> = {}): void {
  const verdict = validate(model, value);
  if (verdict.ok) return;
  throw new PromptobusError(verdict.code ?? 'schema-invalid',
    `${model}${verdict.at ? `.${verdict.at}` : ''}: ${verdict.note}`,
    { ...context, model, at: verdict.at });
}

export { ERROR_CODES };
