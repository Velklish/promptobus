// Собственные валидаторы protocol v1: production не читает JSON Schemas вовсе.
//
// Схемы лежат в `schemas/v1` и едут в tarball для потребителей, а здесь та же грамматика
// написана вручную — ровно затем, чтобы у package не было runtime-зависимости. Расхождение
// двух описаний одного контракта ловится parity-тестом на общем наборе fixtures
// ([v1-validate.test.mjs](../../test/v1-validate.test.mjs)); правишь одно — правь второе,
// иначе красный придёт оттуда.
//
// Порядок проверок внутри модели не случаен: версия схемы идёт ПЕРВОЙ. Запись более новой
// версии блокируется своим кодом и без изменения store, а разбирать её по остальным полям
// незачем — полей этой версии мы не знаем.
import { ERROR_CODES, PromptobusError } from './errors.js';
import type { ErrorCode } from './errors.js';
import {
  BLOB_PATH_RE, FILENAME_RE, HARNESS_RE, MESSAGE_PROTOCOL_VERSION, MESSAGE_TYPES_V1,
  PARTICIPANT_ID_RE, RECORD_ID_RE, ROLE_RE, SCHEMA_VERSION, SHA256_RE, TASK_ID_RE, TIMESTAMP_RE,
} from './model.js';
import type { ModelName } from './model.js';

/** Вердикт валидатора: где отказ и почему. Код обязателен — по нему потребитель ветвится. */
export interface Verdict {
  ok: boolean;
  code: ErrorCode | null;
  /** Путь до негодного поля: `participants[1].harness`. Пусто у принятого. */
  at: string;
  note: string;
  /**
   * Незнакомые поля, из-за которых отказано. Отдельным полем, а не разбором `note`: по нему
   * читатель отличает «запись сделана механизмом новее меня» от порчи, а текст отказа —
   * проза, и матчер по ней разъехался бы с первой же правкой формулировки.
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

// Лишнее поле — отказ, а не послабление: `additionalProperties: false` стоит во всех
// четырёх схемах, и валидатор, пропускающий незнакомое поле, разошёлся бы со схемой молча.
function extras(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((k) => !allowed.includes(k));
}

function text(value: unknown, at: string, re: RegExp): Verdict | null {
  if (typeof value !== 'string') return bad(at, 'ожидается строка');
  if (!re.test(value)) return bad(at, `не по грамматике ${re.source}`);
  return null;
}

// Версия записи. Более новая — свой код и отказ до всякой записи; более старая или
// негодная — обычная невалидность: миграции внутрь v1 нет.
function version(value: unknown, at: string, expected: number): Verdict | null {
  if (value === expected) return null;
  if (typeof value === 'number' && Number.isInteger(value) && value > expected) {
    return bad(at, `версия ${value} новее поддерживаемой ${expected}`, 'schema-version-unsupported');
  }
  return bad(at, `ожидается ${expected}`);
}

// Пять обязательных и четыре необязательных: расширение контракта не имеет права
// сделать нечитаемой запись, сделанную до него, — такие лежат в живых журналах задач.
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
  if (!isObject(value)) return bad(at, 'ожидается объект или null');
  const extra = extras(value, CAPABILITY_KEYS);
  if (extra.length) return bad(at, `лишние поля: ${extra.join(', ')}`, 'schema-invalid', extra);
  for (const key of ['spawn', 'attach', 'inspect', 'stop']) {
    if (typeof value[key] !== 'boolean') return bad(`${at}.${key}`, 'ожидается boolean');
  }
  if (value.activation !== 'push' && value.activation !== 'pull') {
    return bad(`${at}.activation`, 'ожидается push или pull');
  }
  // Необязательные — только по наличию: поля нет вовсе (запись прежнего релиза) — законно,
  // а лежит в нём не boolean — та же порча, что и в обязательном.
  for (const key of CAPABILITY_OPTIONAL) {
    if (Object.hasOwn(value, key) && typeof value[key] !== 'boolean') {
      return bad(`${at}.${key}`, 'ожидается boolean');
    }
  }
  return null;
}

function participant(value: unknown, at: string): Verdict | null {
  if (!isObject(value)) return bad(at, 'ожидается объект');
  const extra = extras(value, PARTICIPANT_KEYS);
  if (extra.length) return bad(at, `лишние поля: ${extra.join(', ')}`, 'schema-invalid', extra);
  for (const key of PARTICIPANT_KEYS) {
    if (!Object.hasOwn(value, key)) return bad(`${at}.${key}`, 'поле обязательно');
  }
  const id = text(value.id, `${at}.id`, PARTICIPANT_ID_RE);
  if (id) return id;
  const role = text(value.role, `${at}.role`, ROLE_RE);
  if (role) return role;
  // Harness обязателен и непуст: fallback'а в v1 нет вовсе. Запись без harness'а — та
  // самая, ради которой fallback заводился в registry, и в v1 она не создаётся никем.
  const harness = text(value.harness, `${at}.harness`, HARNESS_RE);
  if (harness) return harness;
  if (value.mode !== 'managed' && value.mode !== 'attached') {
    return bad(`${at}.mode`, 'ожидается managed или attached');
  }
  if (value.sessionRef !== null && (typeof value.sessionRef !== 'string' || !value.sessionRef)) {
    return bad(`${at}.sessionRef`, 'ожидается непустая строка или null');
  }
  const caps = capabilities(value.capabilities, `${at}.capabilities`);
  if (caps) return caps;
  if (!isObject(value.metadata)) return bad(`${at}.metadata`, 'ожидается объект');
  return null;
}

function task(value: unknown): Verdict {
  if (!isObject(value)) return bad('', 'ожидается объект');
  const ver = version(value.schemaVersion, 'schemaVersion', SCHEMA_VERSION);
  if (ver) return ver;
  const extra = extras(value, TASK_KEYS);
  if (extra.length) return bad('', `лишние поля: ${extra.join(', ')}`, 'schema-invalid', extra);
  for (const key of TASK_KEYS) {
    if (!Object.hasOwn(value, key)) return bad(key, 'поле обязательно');
  }
  const id = text(value.id, 'id', TASK_ID_RE);
  if (id) return id;
  if (typeof value.title !== 'string' || !value.title || value.title.length > 512) {
    return bad('title', 'ожидается непустая строка не длиннее 512');
  }
  if (value.status !== 'active' && value.status !== 'done') return bad('status', 'ожидается active или done');
  const owner = text(value.owner, 'owner', PARTICIPANT_ID_RE);
  if (owner) return owner;
  for (const key of ['created', 'updated'] as const) {
    const ts = text(value[key], key, TIMESTAMP_RE);
    if (ts) return ts;
  }
  if (!Array.isArray(value.participants) || !value.participants.length) {
    return bad('participants', 'ожидается непустой массив');
  }
  for (let i = 0; i < value.participants.length; i += 1) {
    const p = participant(value.participants[i], `participants[${i}]`);
    if (p) return p;
  }
  if (!isObject(value.adapter)) return bad('adapter', 'ожидается объект');
  return OK;
}

function message(value: unknown): Verdict {
  if (!isObject(value)) return bad('', 'ожидается объект');
  const ver = version(value.protocolVersion, 'protocolVersion', MESSAGE_PROTOCOL_VERSION);
  if (ver) return ver;
  const extra = extras(value, MESSAGE_KEYS);
  if (extra.length) return bad('', `лишние поля: ${extra.join(', ')}`, 'schema-invalid', extra);
  for (const key of MESSAGE_KEYS) {
    if (key !== 'artifact' && !Object.hasOwn(value, key)) return bad(key, 'поле обязательно');
  }
  const id = text(value.id, 'id', RECORD_ID_RE);
  if (id) return id;
  const taskId = text(value.task, 'task', TASK_ID_RE);
  if (taskId) return taskId;
  const sender = text(value.sender, 'sender', PARTICIPANT_ID_RE);
  if (sender) return sender;
  if (!Array.isArray(value.recipients) || !value.recipients.length) {
    return bad('recipients', 'ожидается непустой массив');
  }
  for (let i = 0; i < value.recipients.length; i += 1) {
    const r = text(value.recipients[i], `recipients[${i}]`, PARTICIPANT_ID_RE);
    if (r) return r;
  }
  if (new Set(value.recipients as string[]).size !== value.recipients.length) {
    return bad('recipients', 'дубли получателей');
  }
  if (typeof value.type !== 'string' || !MESSAGE_TYPES_V1.includes(value.type)) {
    return bad('type', `не из протокола v1: ${MESSAGE_TYPES_V1.join(', ')}`);
  }
  if (typeof value.body !== 'string' || !value.body) return bad('body', 'ожидается непустая строка');
  if (Object.hasOwn(value, 'artifact')) {
    const art = text(value.artifact, 'artifact', RECORD_ID_RE);
    if (art) return art;
  }
  const ts = text(value.ts, 'ts', TIMESTAMP_RE);
  if (ts) return ts;
  return OK;
}

function artifact(value: unknown): Verdict {
  if (!isObject(value)) return bad('', 'ожидается объект');
  const ver = version(value.schemaVersion, 'schemaVersion', SCHEMA_VERSION);
  if (ver) return ver;
  const extra = extras(value, ARTIFACT_KEYS);
  if (extra.length) return bad('', `лишние поля: ${extra.join(', ')}`, 'schema-invalid', extra);
  for (const key of ARTIFACT_KEYS) {
    if (!Object.hasOwn(value, key)) return bad(key, 'поле обязательно');
  }
  const id = text(value.id, 'id', RECORD_ID_RE);
  if (id) return id;
  const sha = text(value.sha256, 'sha256', SHA256_RE);
  if (sha) return sha;
  const name = text(value.filename, 'filename', FILENAME_RE);
  if (name) return name;
  // `.` и `..` проходят грамматику имени (разделителя в них нет), а адресуют каталог.
  if (value.filename === '.' || value.filename === '..') return bad('filename', 'имя каталога, а не файла');
  if ((value.filename as string).length > 255) return bad('filename', 'длиннее 255');
  if (!Number.isInteger(value.size) || (value.size as number) < 0) {
    return bad('size', 'ожидается целое неотрицательное');
  }
  const blob = text(value.blob, 'blob', BLOB_PATH_RE);
  if (blob) return blob;
  return OK;
}

const VALIDATORS: Record<ModelName, (value: unknown) => Verdict> = {
  task,
  // Участник проверяется и сам по себе, и внутри журнала задачи, поэтому путь до поля
  // приходит префиксом. У отдельной записи префикса нет — точка в начале пути лишняя.
  participant: (value) => {
    const verdict = participant(value, '');
    return verdict ? { ...verdict, at: verdict.at.replace(/^\./, '') } : OK;
  },
  message,
  artifact,
};

/** Проверить запись по модели. Вердикт, а не бросок: читатель изолирует негодное, а не падает. */
export function validate(model: ModelName, value: unknown): Verdict {
  const check = VALIDATORS[model];
  if (!check) return bad('', `неизвестная модель «${model}»`);
  return check(value);
}

/** То же броском — для записи: негодное в store не попадает вовсе. */
export function requireValid(model: ModelName, value: unknown, context: Record<string, unknown> = {}): void {
  const verdict = validate(model, value);
  if (verdict.ok) return;
  throw new PromptobusError(verdict.code ?? 'schema-invalid',
    `${model}${verdict.at ? `.${verdict.at}` : ''}: ${verdict.note}`,
    { ...context, model, at: verdict.at });
}

export { ERROR_CODES };
