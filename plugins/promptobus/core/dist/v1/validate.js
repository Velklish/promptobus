// Validation of a v1 record.
// [reference/04-protocol.md#validation-of-a-v1-record](../../docs/reference/04-protocol.md#validation-of-a-v1-record)
import { ERROR_CODES, PromptobusError } from './errors.js';
import { BLOB_PATH_RE, FILENAME_RE, HARNESS_RE, MESSAGE_PROTOCOL_VERSION, MESSAGE_TYPES_V1, PARTICIPANT_ID_RE, RECORD_ID_RE, ROLE_RE, SCHEMA_VERSION, SHA256_RE, TASK_ID_RE, TIMESTAMP_RE, } from './model.js';
const OK = { ok: true, code: null, at: '', note: '', extra: [] };
function bad(at, note, code = 'schema-invalid', extra = []) {
    return { ok: false, code, at, note, extra };
}
function isObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
// An extra field is a refusal, not a loosening: `additionalProperties: false` stands in all four
// schemas, and a validator that let one through would drift from the schema in silence.
function extras(value, allowed) {
    return Object.keys(value).filter((k) => !allowed.includes(k));
}
function text(value, at, re) {
    if (typeof value !== 'string')
        return bad(at, 'expected a string');
    if (!re.test(value))
        return bad(at, `does not match grammar ${re.source}`);
    return null;
}
// Record version. Newer — its own code and a refusal before any write; older
// or malformed — ordinary invalidity: there is no migration into v1.
function version(value, at, expected) {
    if (value === expected)
        return null;
    if (typeof value === 'number' && Number.isInteger(value) && value > expected) {
        return bad(at, `version ${value} is newer than supported ${expected}`, 'schema-version-unsupported');
    }
    return bad(at, `expected ${expected}`);
}
// Five required and six optional: a contract extension must not make a
// record written before it unreadable — those sit in live task journals.
const CAPABILITY_KEYS = [
    'spawn', 'attach', 'activation', 'inspect', 'stop',
    'denyTools', 'mcpDenyTools', 'systemPrompt', 'sessionList', 'enter', 'approverLift',
];
const CAPABILITY_OPTIONAL = ['denyTools', 'mcpDenyTools', 'systemPrompt', 'sessionList', 'enter', 'approverLift'];
const PARTICIPANT_KEYS = ['id', 'role', 'harness', 'mode', 'sessionRef', 'capabilities', 'metadata'];
const TASK_KEYS = ['schemaVersion', 'id', 'title', 'status', 'parent', 'owner', 'created', 'updated', 'participants', 'adapter'];
const MESSAGE_KEYS = ['protocolVersion', 'id', 'task', 'originTask', 'sender', 'recipients', 'type', 'body', 'artifact', 'ts'];
const ARTIFACT_KEYS = ['schemaVersion', 'id', 'sha256', 'filename', 'size', 'blob'];
function capabilities(value, at) {
    if (value === null)
        return null;
    if (!isObject(value))
        return bad(at, 'expected an object or null');
    const extra = extras(value, CAPABILITY_KEYS);
    if (extra.length)
        return bad(at, `extra fields: ${extra.join(', ')}`, 'schema-invalid', extra);
    for (const key of ['spawn', 'attach', 'inspect', 'stop']) {
        if (typeof value[key] !== 'boolean')
            return bad(`${at}.${key}`, 'expected boolean');
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
function participant(value, at) {
    if (!isObject(value))
        return bad(at, 'expected an object');
    const extra = extras(value, PARTICIPANT_KEYS);
    if (extra.length)
        return bad(at, `extra fields: ${extra.join(', ')}`, 'schema-invalid', extra);
    for (const key of PARTICIPANT_KEYS) {
        if (!Object.hasOwn(value, key))
            return bad(`${at}.${key}`, 'field is required');
    }
    const id = text(value.id, `${at}.id`, PARTICIPANT_ID_RE);
    if (id)
        return id;
    const role = text(value.role, `${at}.role`, ROLE_RE);
    if (role)
        return role;
    // Harness is required and non-empty: v1 has no fallback at all. A record without one is what the
    // registry fallback was invented for, and in v1 nobody creates one.
    const harness = text(value.harness, `${at}.harness`, HARNESS_RE);
    if (harness)
        return harness;
    if (value.mode !== 'managed' && value.mode !== 'attached') {
        return bad(`${at}.mode`, 'expected managed or attached');
    }
    if (value.sessionRef !== null && (typeof value.sessionRef !== 'string' || !value.sessionRef)) {
        return bad(`${at}.sessionRef`, 'expected a non-empty string or null');
    }
    const caps = capabilities(value.capabilities, `${at}.capabilities`);
    if (caps)
        return caps;
    if (!isObject(value.metadata))
        return bad(`${at}.metadata`, 'expected an object');
    return null;
}
function task(value) {
    if (!isObject(value))
        return bad('', 'expected an object');
    const ver = version(value.schemaVersion, 'schemaVersion', SCHEMA_VERSION);
    if (ver)
        return ver;
    const extra = extras(value, TASK_KEYS);
    if (extra.length)
        return bad('', `extra fields: ${extra.join(', ')}`, 'schema-invalid', extra);
    for (const key of TASK_KEYS) {
        if (key === 'parent')
            continue;
        if (!Object.hasOwn(value, key))
            return bad(key, 'field is required');
    }
    const id = text(value.id, 'id', TASK_ID_RE);
    if (id)
        return id;
    if (typeof value.title !== 'string' || !value.title || value.title.length > 512) {
        return bad('title', 'expected a non-empty string no longer than 512');
    }
    if (value.status !== 'active' && value.status !== 'done')
        return bad('status', 'expected active or done');
    if (Object.hasOwn(value, 'parent')) {
        const parent = text(value.parent, 'parent', TASK_ID_RE);
        if (parent)
            return parent;
        if (value.parent === value.id)
            return bad('parent', 'a task cannot be its own parent');
    }
    const owner = text(value.owner, 'owner', PARTICIPANT_ID_RE);
    if (owner)
        return owner;
    for (const key of ['created', 'updated']) {
        const ts = text(value[key], key, TIMESTAMP_RE);
        if (ts)
            return ts;
    }
    if (!Array.isArray(value.participants) || !value.participants.length) {
        return bad('participants', 'expected a non-empty array');
    }
    for (let i = 0; i < value.participants.length; i += 1) {
        const p = participant(value.participants[i], `participants[${i}]`);
        if (p)
            return p;
    }
    if (Object.hasOwn(value, 'parent')) {
        const teamlead = value.participants.findIndex((p) => p.role === 'teamlead'
            || (typeof p.metadata.address === 'string' && p.metadata.address.startsWith('teamlead:')));
        if (teamlead !== -1)
            return bad(`participants[${teamlead}]`, 'a child task cannot carry a teamlead participant');
    }
    if (!isObject(value.adapter))
        return bad('adapter', 'expected an object');
    return OK;
}
function message(value) {
    if (!isObject(value))
        return bad('', 'expected an object');
    const ver = version(value.protocolVersion, 'protocolVersion', MESSAGE_PROTOCOL_VERSION);
    if (ver)
        return ver;
    const extra = extras(value, MESSAGE_KEYS);
    if (extra.length)
        return bad('', `extra fields: ${extra.join(', ')}`, 'schema-invalid', extra);
    for (const key of MESSAGE_KEYS) {
        if (key !== 'artifact' && key !== 'originTask' && !Object.hasOwn(value, key))
            return bad(key, 'field is required');
    }
    const id = text(value.id, 'id', RECORD_ID_RE);
    if (id)
        return id;
    const taskId = text(value.task, 'task', TASK_ID_RE);
    if (taskId)
        return taskId;
    if (Object.hasOwn(value, 'originTask')) {
        const origin = text(value.originTask, 'originTask', TASK_ID_RE);
        if (origin)
            return origin;
    }
    const sender = text(value.sender, 'sender', PARTICIPANT_ID_RE);
    if (sender)
        return sender;
    if (!Array.isArray(value.recipients) || !value.recipients.length) {
        return bad('recipients', 'expected a non-empty array');
    }
    for (let i = 0; i < value.recipients.length; i += 1) {
        const r = text(value.recipients[i], `recipients[${i}]`, PARTICIPANT_ID_RE);
        if (r)
            return r;
    }
    if (new Set(value.recipients).size !== value.recipients.length) {
        return bad('recipients', 'duplicate recipients');
    }
    if (typeof value.type !== 'string' || !MESSAGE_TYPES_V1.includes(value.type)) {
        return bad('type', `not a v1 protocol type: ${MESSAGE_TYPES_V1.join(', ')}`);
    }
    if (typeof value.body !== 'string' || !value.body)
        return bad('body', 'expected a non-empty string');
    // `type: "artifact"` with no `artifact` field is REFUSED AT THE WRITE, not here: reading is
    // retroactive, and records of that shape sit in live journals ([04-protocol](../../docs/reference/04-protocol.md) § Validation).
    if (Object.hasOwn(value, 'artifact')) {
        const art = text(value.artifact, 'artifact', RECORD_ID_RE);
        if (art)
            return art;
    }
    const ts = text(value.ts, 'ts', TIMESTAMP_RE);
    if (ts)
        return ts;
    return OK;
}
function artifact(value) {
    if (!isObject(value))
        return bad('', 'expected an object');
    const ver = version(value.schemaVersion, 'schemaVersion', SCHEMA_VERSION);
    if (ver)
        return ver;
    const extra = extras(value, ARTIFACT_KEYS);
    if (extra.length)
        return bad('', `extra fields: ${extra.join(', ')}`, 'schema-invalid', extra);
    for (const key of ARTIFACT_KEYS) {
        if (!Object.hasOwn(value, key))
            return bad(key, 'field is required');
    }
    const id = text(value.id, 'id', RECORD_ID_RE);
    if (id)
        return id;
    const sha = text(value.sha256, 'sha256', SHA256_RE);
    if (sha)
        return sha;
    const name = text(value.filename, 'filename', FILENAME_RE);
    if (name)
        return name;
    // `.` and `..` pass the name grammar (no separator in them) but address a directory.
    if (value.filename === '.' || value.filename === '..')
        return bad('filename', 'a directory name, not a file');
    if (value.filename.length > 255)
        return bad('filename', 'longer than 255');
    if (!Number.isInteger(value.size) || value.size < 0) {
        return bad('size', 'expected a non-negative integer');
    }
    const blob = text(value.blob, 'blob', BLOB_PATH_RE);
    if (blob)
        return blob;
    return OK;
}
const VALIDATORS = {
    task,
    // A participant is checked both on its own and inside a task journal, so the path arrives as a
    // prefix. A standalone record has none — a leading dot in the path is extra.
    participant: (value) => {
        const verdict = participant(value, '');
        return verdict ? { ...verdict, at: verdict.at.replace(/^\./, '') } : OK;
    },
    message,
    artifact,
};
/** Check a record against a model. A verdict, not a throw: the reader isolates the bad, it does not crash. */
export function validate(model, value) {
    const check = VALIDATORS[model];
    if (!check)
        return bad('', `unknown model «${model}»`);
    return check(value);
}
/** The same as a throw — for writes: the bad never enters the store. */
export function requireValid(model, value, context = {}) {
    const verdict = validate(model, value);
    if (verdict.ok)
        return;
    throw new PromptobusError(verdict.code ?? 'schema-invalid', `${model}${verdict.at ? `.${verdict.at}` : ''}: ${verdict.note}`, { ...context, model, at: verdict.at });
}
export { ERROR_CODES };
