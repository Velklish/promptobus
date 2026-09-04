// Модели protocol v1 и грамматика их полей (ADR-032, §6).
//
// Здесь только формы и регулярные выражения — ни диска, ни политики. Грамматика объявлена
// один раз и читается обоими: и собственными валидаторами ([validate.ts](validate.ts)), и
// JSON Schemas в `schemas/v1` — их parity держит [v1-validate.test.mjs](../../test/v1-validate.test.mjs).
import { MESSAGE_TYPES } from '../protocol.js';

/** Версия схемы записей v1: `task.json` и metadata артефактов. */
export const SCHEMA_VERSION = 1;

/** Версия протокола сообщений v1. */
export const MESSAGE_PROTOCOL_VERSION = 1;

/** Модели, которые проверяются схемой. */
export const MODELS = ['task', 'participant', 'message', 'artifact'] as const;

/** Имя модели. */
export type ModelName = (typeof MODELS)[number];

// Грамматика полей. Идентификатор задачи щедрее остальных: его собирает adapter из своего
// слага и штампа. Идентификатор участника — свой и независимый: роль из него не выводится
// нигде, поэтому двоеточия в нём нет вовсе.
export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const PARTICIPANT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ROLE_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const HARNESS_RE = /^[a-z][a-z0-9-]{0,31}$/;
// Штамп времени, счётчик отправителя и случайный хвост: сортировка строк — порядок
// отправки, и вторых часов для истории не нужно.
export const RECORD_ID_RE = /^[0-9]{8}T[0-9]{9}-[0-9]{4}-[0-9a-f]{6}$/;
// Ровно то, что печатает `Date#toISOString`. Формата `date-time` мало: он допускает
// смещение, а смещение ломает сортировку строк, на которой стоит история.
export const TIMESTAMP_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
// Имя файла артефакта — только имя: разделитель пути в нём означал бы, что metadata
// адресует что-то за пределами задачи.
export const FILENAME_RE = /^[^/\\]+$/;
export const BLOB_PATH_RE = /^blobs\/[0-9a-f]{64}$/;

/** Режим участника: сессию поднял driver (`managed`) либо она подключилась сама (`attached`). */
export type ParticipantMode = 'managed' | 'attached';

/**
 * Снимок capabilities driver'а на момент подъёма участника.
 *
 * Пять полей обязательны, четыре (ADR-034) — нет, и это не послабление схемы: записи,
 * сделанные до расширения контракта, лежат в живых журналах, и потребуй схема новых полей,
 * задача прошлого релиза перестала бы читаться целиком. Снимок и есть свидетельство того,
 * чем участника поднимали: чего driver тогда не объявлял, того в нём и нет.
 */
export interface CapabilitiesSnapshot {
  spawn: boolean;
  attach: boolean;
  activation: 'push' | 'pull';
  inspect: boolean;
  stop: boolean;
  denyTools?: boolean;
  systemPrompt?: boolean;
  sessionList?: boolean;
  enter?: boolean;
}

/**
 * Участник задачи. ID независим, роль объявлена полем: `worker:<слаг>` прежней шины
 * смешивал адрес, роль и harness в одной строке, и второй harness требует их развести.
 */
export interface ParticipantV1 {
  id: string;
  role: string;
  harness: string;
  mode: ParticipantMode;
  /** Opaque session reference driver'а. Явный `null`, а не отсутствие поля. */
  sessionRef: string | null;
  capabilities: CapabilitiesSnapshot | null;
  /** Метаданные adapter'а: core в них не заглядывает. */
  metadata: Record<string, unknown>;
}

/** Журнал задачи v1. */
export interface TaskV1 {
  schemaVersion: number;
  id: string;
  title: string;
  status: 'active' | 'done';
  /** ID участника-владельца. Он всегда один, смена — явным claim. */
  owner: string;
  created: string;
  updated: string;
  participants: ParticipantV1[];
  /** Метаданные adapter'а как opaque объект. */
  adapter: Record<string, unknown>;
}

/** Каноническое сообщение. Неизменяемо: ссылки inbox и history — тот же inode. */
export interface MessageV1 {
  protocolVersion: number;
  id: string;
  task: string;
  sender: string;
  recipients: string[];
  type: string;
  body: string;
  artifact?: string;
  ts: string;
}

/** Metadata артефакта. Одно содержимое живёт под несколькими именами: записей несколько, blob один. */
export interface ArtifactV1 {
  schemaVersion: number;
  id: string;
  sha256: string;
  filename: string;
  size: number;
  /** Путь blob'а внутри каталога задачи. */
  blob: string;
}

/** Типы сообщений: дом значения — `src/protocol.ts`, второго списка в коде не бывает. */
export const MESSAGE_TYPES_V1: readonly string[] = MESSAGE_TYPES;
