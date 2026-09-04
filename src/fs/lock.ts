// Лок-каталог: read-modify-write журнала задачи под ним, и у legacy store, и у protocol v1.
//
// Лок — каталог, а не файл: `mkdir` атомарен на всякой ФС и не требует уборки дескриптора,
// второй процесс получает `EEXIST` вместо тихой перезаписи. Чужой лок снимается только по
// мёртвому pid и никогда по догадке о возрасте.
//
// Слова отказов сюда не переехали и не переедут: у legacy store они свои (`GateError` с
// маршрутом человеку), у v1 — свои (типизированный код). Модуль берёт их callback'ами.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pidAlive, sleepSync } from './proc.js';

export const LOCK_WAIT_MS = 5000;
export const LOCK_RETRY_MS = 20;

/** Кто держит лок: без файла владельца совет «удали каталог, если процесса нет» невыполним. */
export interface LockHolder {
  pid: number | null;
  session: string | null;
  since: string | null;
}

/**
 * Кто держит лок. Лок прежнего CLI держит pid строкой — читается и он: пережить каталог
 * может ровно процесс, умерший внутри записи.
 */
export function lockHolder(lock: string): LockHolder | null {
  let raw;
  try { raw = readFileSync(path.join(lock, 'owner'), 'utf8').trim(); } catch { return null; }
  if (!raw) return null;
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { /* не JSON — лок прежнего CLI */ }
  // Проверка на объект не формальность: голый pid прежнего формата — валидный JSON, и
  // `JSON.parse('999999')` отдаёт число, у которого нет поля `pid`.
  if (parsed && typeof parsed === 'object') return parsed as LockHolder;
  return { pid: Number(raw) || null, session: null, since: null };
}

/**
 * Осиротевший лок — по живости pid: процесс, умерший внутри записи, оставляет каталог
 * навсегда. Каталог уводим `rename`, а не удаляем на месте: между чужим `rm` и своим
 * `mkdir` вклинился бы сосед, и его свежий лок снёс бы второй уборщик. Держателя без pid не
 * трогаем: между `mkdir` и записью файла лок — живой захват, а не сирота.
 */
export function dropDeadLock(lock: string): boolean {
  const held = lockHolder(lock);
  if (!held?.pid || pidAlive(held.pid)) return false;
  const tomb = `${lock}.dead.${process.pid}`;
  try { renameSync(lock, tomb); } catch { return false; }
  rmSync(tomb, { recursive: true, force: true });
  return true;
}

/** Чем отвечает лок на два своих законных отказа. Слова — дело вызывающего. */
export interface DirLockOptions {
  waitMs?: number;
  retryMs?: number;
  /** Идентичность сессии в файл владельца: pid отвечает «жив ли», сессия — «чей он». */
  session?: string | null;
  /** Каталога, в котором берётся лок, нет вовсе — это не занятый лок, а отсутствие предмета. */
  onMissing: () => Error;
  /** Лок занят живым держателем дольше отведённого. */
  onBusy: (held: LockHolder | null, waitedMs: number) => Error;
}

/**
 * Локи, взятые ЭТИМ процессом прямо сейчас. Нужны ради вложенности: read-modify-write
 * adapter'а берёт лок задачи, а операция store внутри него берёт его же — и без учёта
 * своих локов процесс досиживал бы `waitMs` на самом себе и отказывал бы «журнал занят»,
 * назвав держателем собственный pid.
 *
 * Вложение законно и безопасно: лок разводит ПРОЦЕССЫ, а внутри процесса участок под ним
 * синхронный, и вложенный вызов — та же критическая секция. Снимает лок только тот вызов,
 * который его взял: внутренний уходит, не тронув каталога.
 */
const held = new Set<string>();

/**
 * Взять лок-каталог, выполнить и снять. Мёртвый держатель снимается по ходу ожидания;
 * живой досиживает `waitMs` и отказывает словами вызывающего.
 */
export function withDirLock<T>(lock: string, fn: () => T, {
  waitMs = LOCK_WAIT_MS, retryMs = LOCK_RETRY_MS, session = null, onMissing, onBusy,
}: DirLockOptions): T {
  // Свой же лок — работаем внутри него. Отсутствие каталога задачи при этом остаётся
  // отказом внешнего вызова: до сюда он не доходит.
  if (held.has(lock)) return fn();
  const started = Date.now();
  const deadline = started + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(path.join(lock, 'owner'), `${JSON.stringify({
        pid: process.pid, session, since: new Date().toISOString(),
      })}\n`);
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw onMissing();
      if (code !== 'EEXIST') throw e;
      if (dropDeadLock(lock)) continue;
      if (Date.now() >= deadline) throw onBusy(lockHolder(lock), Date.now() - started);
      sleepSync(retryMs);
    }
  }
  held.add(lock);
  try {
    return fn();
  } finally {
    held.delete(lock);
    rmSync(lock, { recursive: true, force: true });
  }
}
