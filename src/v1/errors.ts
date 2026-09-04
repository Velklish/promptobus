// Отказы protocol v1: типизированный код плюс контекст.
//
// Человеческий текст — дело adapter'а, и это не стилистика: package обязан собираться и
// проверяться без CLI, а пользовательский вывод остаётся в CLI целиком. Поэтому наружу
// уходит `code` из перечня ниже и `context` с фактами отказа; `message` внутри исключения
// оставлен для отладки — читать его потребителю незачем, разбирать отказ он обязан по коду.

/**
 * Перечень кодов отказа. Константой, а не строками по месту: потребитель ветвится по коду,
 * и незаявленный код читается им как неизвестный отказ.
 */
export const ERROR_CODES = [
  // routing policy
  'policy-required',
  'policy-denied',
  // задача
  'task-not-found',
  'task-exists',
  'task-closed',
  'task-active',
  'task-broken',
  // участники
  'participant-not-found',
  'participant-exists',
  // отправка
  'recipients-empty',
  'recipients-duplicate',
  'message-type-unknown',
  // валидация
  'schema-invalid',
  'schema-version-unsupported',
  // артефакты
  'artifact-source',
  'artifact-not-found',
  'artifact-integrity',
  // диск
  'lock-busy',
  'link-refused',
] as const;

/** Код отказа v1. */
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Факты отказа: что за задача, участник, файл. Читается потребителем, а не человеком. */
export type ErrorContext = Record<string, unknown>;

/**
 * Отказ protocol v1. Класс, а не голый `Error`: потребитель отличает отказ шины от поломки
 * `instanceof`, а ветвится по `code`.
 */
export class PromptobusError extends Error {
  readonly code: ErrorCode;

  readonly context: ErrorContext;

  constructor(code: ErrorCode, message: string, context: ErrorContext = {}) {
    super(message);
    this.name = 'PromptobusError';
    this.code = code;
    this.context = context;
  }
}

/** Короткая форма броска: у отказов v1 нет ни одного места, где нужен голый `Error`. */
export function fail(code: ErrorCode, message: string, context: ErrorContext = {}): never {
  throw new PromptobusError(code, message, context);
}
