// Stateless-фрагменты util.js внутри границы шины (BL-518, ADR-038). Сюда не входят
// пути ATI (`AGENTS_BIN`, `findRoot`, раскладка `.agents/`) — их отдаёт host.

import {
  chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { run } from './exec.js';

const paintOn = (stream, code, s) => (stream.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const out = (code, s) => paintOn(process.stdout, code, s);
const err = (code, s) => paintOn(process.stderr, code, s);

export function ok(msg) { console.log(`${out(32, '✔')} ${msg}`); }
export function info(msg) { console.log(`  ${msg}`); }
export function warn(msg) { console.warn(`${err(33, '⚠')} ${msg}`); }
export function fail(msg) { console.error(`${err(31, '✖')} ${msg}`); process.exit(1); }
// Тот же уровень, что у fail, но без выхода: диагностика перечисляет ВСЁ найденное.
export function bad(msg) { console.error(`${err(31, '✖')} ${msg}`); }

// Потолок ожидания сети для git, один на fresh.js, refs.js и promptobus/worktree.js: разъехавшись,
// они дали бы разное время ожидания на одном отвалившемся VPN (в worktree.js вызовы
// локальные — там он страхует от залипшего index.lock).
export const GIT_NET_TIMEOUT_MS = 30_000;

// Клонирование меряется отдельно: 30 секунд отмерены вопросу (`ls-remote`, `fetch` одного
// ref), а клон везёт целые репозитории — на медленном VPN минуты тут норма. Потолок обязан
// быть: без него `spawnSync` ждёт вечно, и `sync` без VPN стоит молча и навсегда.
export const GIT_CLONE_TIMEOUT_MS = 5 * 60 * 1000;

// Потолок вывода git. Дефолтный мегабайт перебирает перечень незакоммиченного у грязного
// клона: процесс убивается, и ответ читается как «дерево чистое» или «состояние
// неизвестно», а на последнем стоит решение уборки каталога worker'а. 32 МБ — сотни тысяч
// строк status; константа одна на всех, иначе они дали бы разный ответ на одном клоне.
export const GIT_MAX_OUTPUT = 32 * 1024 * 1024;

// Дефолта у `spawnSync` нет вовсе: без явного значения зависший хук, npm или npx стоит
// вечно вместе со звавшей его командой. Установке пакетов отведён свой, вдесятеро больший.
export const PROC_TIMEOUT_MS = 60_000;
export const PROC_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

// Единая обёртка дочернего процесса: даёт таймаут и потолок вывода. Многословный npm
// упирался в дефолтный мегабайт `maxBuffer` и убивал установку хуков невнятным отказом.
export function runProc(cmd, args = [], options = {}) {
  return run(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: PROC_TIMEOUT_MS,
    maxBuffer: GIT_MAX_OUTPUT,
    ...options,
  });
}

// Убитый по таймауту процесс не оставляет ни stderr, ни статуса: spawnSync кладёт
// ETIMEDOUT в error и сигнал в signal. Без этой развилки человек получает «exited null».
export function procTimedOut(r) {
  return r?.error?.code === 'ETIMEDOUT' || (!!r?.signal && r?.status === null);
}

// Последняя непустая строка: git и npm пишут диагноз хвостом, а перед ним — прогресс.
export function lastLine(text) {
  return String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';
}

// Хвост вывода последними `n` строками: `npm` и `claude` кладут диагноз в предпоследнюю,
// а последней печатают совет, и `lastLine` отдал бы совет вместо причины. Разделитель
// строк — и `\r\n`: иначе хвост Windows-процесса приезжает с `\r` посреди склеенной строки.
export function lastLines(text, n = 2) {
  return String(text ?? '').trim().split(/\r?\n/).slice(-n).join(' ');
}

// Причина отказа одной фразой. Источники от точного к грубому: что сказал процесс, что
// сказал Node (ENOENT, ETIMEDOUT — stderr там пуст), код выхода. `full`: весь stderr — так
// печатает отказ клонирования, где важен весь ответ git.
export function procError(r, { label = 'процесс', full = false } = {}) {
  const err = (r?.stderr ?? '').toString().trim();
  const text = full ? err : lastLine(err);
  return text || r?.error?.message || `${label} exited ${r?.status}`;
}

// Аргумент для копирования в терминал: в готовые команды spawn'а и уборки уезжают имена
// сессий с пробелами и пути, а склеенная через пробел строка распадается на десяток
// аргументов. Квотирование POSIX: безопасное слово как есть, остальное — в одинарные
// кавычки, сама кавычка приезжает экранированной (`'\''`); пустая строка тоже получает их.
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function shellQuote(arg) {
  const s = String(arg);
  return SHELL_SAFE.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

// Запись через tmp+rename: `writeFileSync` в цель усекает её до нуля на глазах у
// параллельного читателя, а умерший внутри записи процесс оставляет обрубок навсегда. tmp —
// рядом с целью: `rename` атомарен только в пределах одной ФС, а `.agents/` и `/tmp` сплошь
// и рядом на разных; имя держит цель, pid и счётчик, иначе два писателя встретились бы на
// общем tmp. `preserveMode` берёт права у прежней цели — `rename` подменяет её вместе с
// режимом, и права 0600 у чужого `info/exclude` молча съехали бы на дефолтные; `mode` —
// права новому файлу, когда переносить не с чего, и перенос сильнее его.
let atomicSeq = 0;

export function writeFileAtomic(file, content, { mode = null, preserveMode = false } = {}) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  atomicSeq += 1;
  const tmp = path.join(dir, `.tmp-${path.basename(file)}-${process.pid}-${atomicSeq}`);
  const kept = preserveMode && existsSync(file) ? (statSync(file).mode & 0o777) : null;
  const m = kept ?? mode;
  try {
    writeFileSync(tmp, content, m === null ? undefined : { mode: m });
    // `mode` у `writeFileSync` режет umask: при штатном 022 просьба 0o660 приезжает 0o640,
    // и перенос прав у файла группы терял бы группу. `chmod` после создания umask не касается.
    if (m !== null) chmodSync(tmp, m);
    renameSync(tmp, file);
  } catch (e) {
    // recursive: на месте tmp бывает каталог (оборванный проход, чужая ФС), одним `force`
    // он не снимается, и следующая запись упиралась бы в него вечно.
    rmSync(tmp, { force: true, recursive: true });
    throw e;
  }
}

export function toPosix(p) { return p.split(path.sep).join('/'); }

const ENV_NAME = '[A-Za-z_][A-Za-z0-9_]*';

// Свежая регулярка на каждый вызов: у глобальной живёт lastIndex, и общий экземпляр между
// `replace` и `matchAll` — заряженная ловушка на следующего потребителя.
export function envPlaceholderRe() {
  return new RegExp(`\\$\\{(${ENV_NAME})\\}`, 'g');
}

// Подстановка ${VAR} в объекте MCP-конфига с JSON-экранированием значения: Claude Code не
// гарантирует интерполяцию при чтении .mcp.json. Незаполненную переменную оставляем как
// ${VAR} — пусть сервер даст явный отказ, а не молча уйдёт с пустым заголовком.
export function substituteEnvVars(obj) {
  return JSON.parse(
    JSON.stringify(obj).replace(envPlaceholderRe(), (m, name) =>
      (process.env[name] ? JSON.stringify(process.env[name]).slice(1, -1) : m)),
  );
}
