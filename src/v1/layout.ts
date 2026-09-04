// Раскладка store v1 на диске (ADR-032, §6).
//
// Корень даёт вызывающий: package рабочего места не ищет и окружения не читает — это дело
// adapter'а. Здесь только склейка путей, ни одного обращения к диску.
import path from 'node:path';
import { fail } from './errors.js';
import { PARTICIPANT_ID_RE, RECORD_ID_RE, TASK_ID_RE } from './model.js';

/** Каталог store внутри рабочего места. */
export const ROOT_DIR = '.promptobus';

/** Store v1 внутри корня, который назвал вызывающий. */
export function homeOf(root: string): string {
  if (typeof root !== 'string' || !root) fail('schema-invalid', 'корень store не назван');
  return path.join(root, ROOT_DIR);
}

// Грамматика проверяется у КАЖДОГО имени, попадающего в путь: id приходит и от adapter'а,
// и из чужой записи на диске, а `..` в нём вывел бы запись за пределы задачи.
function safeTask(id: unknown): string {
  if (typeof id !== 'string' || !TASK_ID_RE.test(id)) {
    fail('task-not-found', `недопустимый id задачи: «${String(id)}»`, { task: id });
  }
  return id;
}

function safeParticipant(id: unknown): string {
  if (typeof id !== 'string' || !PARTICIPANT_ID_RE.test(id)) {
    fail('participant-not-found', `недопустимый id участника: «${String(id)}»`, { participant: id });
  }
  return id;
}

function safeRecord(id: unknown): string {
  if (typeof id !== 'string' || !RECORD_ID_RE.test(id)) {
    fail('schema-invalid', `недопустимый id записи: «${String(id)}»`, { record: id });
  }
  return id;
}

export function tasksDir(home: string): string {
  return path.join(home, 'tasks');
}

export function taskDir(home: string, task: string): string {
  return path.join(tasksDir(home), safeTask(task));
}

export function taskFile(home: string, task: string): string {
  return path.join(taskDir(home, task), 'task.json');
}

export function lockDir(home: string, task: string): string {
  return path.join(taskDir(home, task), '.lock');
}

/** Канонические сообщения. Неизменяемы: ссылки inbox, history и intent — тот же inode. */
export function messagesDir(home: string, task: string): string {
  return path.join(taskDir(home, task), 'messages');
}

export function messageFile(home: string, task: string, message: string): string {
  return path.join(messagesDir(home, task), `${safeRecord(message)}.json`);
}

/** Незакрытые fan-out'ы. Файл здесь — жёсткая ссылка на каноническое сообщение. */
export function intentsDir(home: string, task: string): string {
  return path.join(taskDir(home, task), 'intents');
}

export function intentFile(home: string, task: string, message: string): string {
  return path.join(intentsDir(home, task), `${safeRecord(message)}.json`);
}

/**
 * Лизинг незакрытого fan-out'а: `<id>.owner` рядом с intent'ом. Путь собирается ИЗ пути
 * intent'а, а не из id второй раз: восстановление обходит каталог по именам файлов и
 * лизинг спрашивает до разбора записи — у него на руках путь, а не id.
 */
export function ownerOfIntent(intent: string): string {
  return `${intent.slice(0, -'.json'.length)}.owner`;
}

export function inboxDir(home: string, task: string, participant: string): string {
  return path.join(taskDir(home, task), 'inbox', safeParticipant(participant));
}

export function inboxRef(home: string, task: string, participant: string, message: string): string {
  return path.join(inboxDir(home, task, participant), `${safeRecord(message)}.json`);
}

/** Прочитанное. Имя файла то же — по нему recovery и отличает доставленное от недостающего. */
export function historyDir(home: string, task: string, participant: string): string {
  return path.join(taskDir(home, task), 'history', safeParticipant(participant));
}

export function historyRef(home: string, task: string, participant: string, message: string): string {
  return path.join(historyDir(home, task, participant), `${safeRecord(message)}.json`);
}

/**
 * Изолированное. Два подкаталога, а не один: `inbox/<участник>` и `artifacts` — иначе
 * участник с id `artifacts` увёл бы чужие записи к себе.
 */
export function brokenInboxDir(home: string, task: string, participant: string): string {
  return path.join(taskDir(home, task), 'broken', 'inbox', safeParticipant(participant));
}

export function brokenArtifactsDir(home: string, task: string): string {
  return path.join(taskDir(home, task), 'broken', 'artifacts');
}

/** Оборванный intent: падение внутри точки коммита — единственная форма его порчи. */
export function brokenMessagesDir(home: string, task: string): string {
  return path.join(taskDir(home, task), 'broken', 'messages');
}

/** Содержимое артефактов, адресуемое SHA-256. Дедуплицируется внутри задачи. */
export function blobsDir(home: string, task: string): string {
  return path.join(taskDir(home, task), 'blobs');
}

export function blobFile(home: string, task: string, sha256: string): string {
  return path.join(blobsDir(home, task), sha256);
}

/** Metadata артефактов: имя файла живёт здесь, содержимое — в blob'е. */
export function artifactsDir(home: string, task: string): string {
  return path.join(taskDir(home, task), 'artifacts');
}

export function artifactFile(home: string, task: string, artifact: string): string {
  return path.join(artifactsDir(home, task), `${safeRecord(artifact)}.json`);
}

/** Путь blob'а, как он записан в metadata: относительный, внутри каталога задачи. */
export function blobRef(sha256: string): string {
  return `blobs/${sha256}`;
}

/** Тот же путь абсолютным. Чтение metadata идёт только через него: `..` в поле отсекает схема. */
export function blobOf(home: string, task: string, artifact: { sha256: string }): string {
  return blobFile(home, task, artifact.sha256);
}
