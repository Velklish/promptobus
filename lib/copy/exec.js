// Копия exec.js внутри границы шины (BL-518, ADR-038): package не импортирует cli/lib, а шина не ходит за run наружу ради запуска процессов.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Единая точка запуска внешних процессов. `shell: true` на Windows даёт не «то же, но через
// оболочку», а другую семантику: Node строит `cmd.exe /d /s /c "<файл> <аргументы через
// пробел>"` с windowsVerbatimArguments и кавычек не добавляет — аргумент с пробелом
// разваливается на два, перевод строки обрывает команду, `& | ^ < >` исполняются. Здесь argv
// остаётся массивом везде: POSIX — spawnSync без shell; Windows и .exe — тот же spawnSync по
// резолвнутому пути; Windows и .cmd/.bat — cmd.exe с командной строкой, собранной здесь,
// потому что напрямую батник Node не запускает (после CVE-2024-27980 отказ EINVAL). Побочный
// эффект — резолв возвращает к жизни ENOENT: под `shell: true` cmd.exe стартовал всегда и
// вместо «не найден в PATH» отдавал код 1 или 9009 с мусором в stderr.

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const BATCH_EXT = new Set(['.cmd', '.bat']);

// Через cmd.exe не проносятся: `%` раскрывается в переменную до всякого квотирования (`^%` не
// спасает, `%%` только внутри батника), перевод строки завершает команду. Отсюда отказ —
// молча исполнить обрезанное значит исполнить инъекцию.
const UNCARRIABLE_BY_CMD = /[\r\n%]/;

// PATHEXT пишется прописными, а приклеивается строчным: ФС Windows регистр не различает, зато
// путь предсказуем — и в сообщении об ошибке, и в сравнении с .cmd/.bat. Наружу не
// экспортируется: в copy нет `tools.js`, ради которого оригинал отдаёт функцию.
function pathExtensions(env) {
  return (env.PATHEXT || DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// Ищем только по PATH: CreateProcess начинает с текущей директории, и подложенный в репозиторий
// `claude.exe` перебил бы системный. Разделитель `;` литералом — path.delimiter даёт `:` на POSIX,
// а функция вызывается с platform: 'win32' и из тестов.
export function resolveCommand(cmd, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return cmd;
  const exts = pathExtensions(env);
  const hasKnownExt = (p) => exts.some((e) => p.toLowerCase().endsWith(e));
  const candidates = (base) => (hasKnownExt(base) ? [base] : []).concat(exts.map((e) => base + e));

  if (/[\\/]/.test(cmd) || /^[A-Za-z]:/.test(cmd)) return candidates(cmd).find(existsSync) ?? null;

  for (const dir of (env.PATH || env.Path || '').split(';')) {
    if (!dir) continue;
    const hit = candidates(path.join(dir.replace(/^"|"$/g, ''), cmd)).find(existsSync);
    if (hit) return hit;
  }
  return null;
}

// Аргумент батника проходит ДВЕ разборки — cmd.exe, затем CRT программы, которую батник зовёт
// через `%*`. Отсюда: квотируем всегда; кавычку удваиваем как `""` (её понимают обе стороны,
// а `\"` для cmd.exe кавычкой не является); слеши перед кавычкой удваиваем по правилам CRT,
// иначе `C:\dir\` съедает закрывающую кавычку. Непроносимое отсекает planRun.
export function quoteCmdArg(arg) {
  const s = String(arg);
  let out = '"';
  let slashes = 0;
  for (const ch of s) {
    if (ch === '\\') { slashes += 1; continue; }
    if (ch === '"') { out += '\\'.repeat(slashes * 2) + '""'; slashes = 0; continue; }
    out += '\\'.repeat(slashes) + ch;
    slashes = 0;
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

// `/v:off` — выключить отложенное раскрытие: с DelayedExpansion в реестре `!VAR!` раскрылся бы
// и внутри кавычек. `/d` — без AutoRun из реестра, `/s` — снять внешнюю пару кавычек, `/c` — выполнить и выйти.
export function buildCmdLine(file, args) {
  return `/v:off /d /s /c "${[file, ...args].map(quoteCmdArg).join(' ')}"`;
}

// ComSpec бывает и не cmd.exe (PowerShell), а экранирование выше — про cmd.exe; пробел в пути дисквалифицирует тоже (verbatim).
function comSpec(env) {
  const v = env.ComSpec ?? env.COMSPEC ?? '';
  return /\\cmd\.exe$/i.test(v) && !/\s/.test(v) ? v : 'cmd.exe';
}

// План отдельно от запуска: Windows-ветки так проверяются юнитом на любой платформе.
export function planRun(cmd, args = [], { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return { ok: true, file: cmd, args, verbatim: false };

  const file = resolveCommand(cmd, { platform, env });
  if (!file) return { ok: false, code: 'ENOENT', message: `${cmd}: не найден в PATH` };
  if (!BATCH_EXT.has(path.extname(file).toLowerCase())) {
    return { ok: true, file, args, verbatim: false };
  }

  const bad = args.find((a) => UNCARRIABLE_BY_CMD.test(String(a)));
  if (bad !== undefined) {
    return {
      ok: false,
      code: 'ERR_UNCARRIABLE_ARG',
      message: `${cmd}: ${path.basename(file)} — командный файл Windows, а аргумент содержит перевод строки или «%»;`
        + ' через cmd.exe такой аргумент не проносится. Поставь нативный бинарь (.exe) вместо npm-обёртки.',
    };
  }
  return { ok: true, file: comSpec(env), args: [buildCmdLine(file, args)], verbatim: true };
}

// Отказ в форме spawnSync с тем же `error.code`, что отдал бы Node: вызывающие разбирают его одинаково.
function failure({ code, message }) {
  const error = new Error(message);
  error.code = code;
  return { error, status: null, signal: null, stdout: '', stderr: '', pid: 0, output: [null, '', ''] };
}

export function run(cmd, args = [], options = {}) {
  const plan = planRun(cmd, args);
  if (!plan.ok) return failure(plan);
  return spawnSync(plan.file, plan.args, {
    ...options,
    shell: false,
    ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
  });
}
