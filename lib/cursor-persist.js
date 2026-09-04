import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { run } from './exec.js';
import { shellQuote } from './util.js';
import { PROMPTOBUS_SERVER } from './contract.js';

// Машинерия persist-сессий Cursor — внутренность driver'а Cursor
// ([driver-cursor.js](driver-cursor.js)), этажом ниже него, как [liftoff.js](liftoff.js) у
// Claude. Снаружи этот файл не импортирует никто: гейт границы adapter'а
// ([promptobus-adapter.test.mjs](../../test/promptobus-adapter.test.mjs)) держит и его.
//
// **Что такое `agent persist`.** Обёртка над tmux (спайк , REPORT §2): подкоманда
// поднимает обычный интерактивный TUI в панели tmux-сервера `cursor-agent`
// (`TMUX_TMPDIR=/tmp tmux -u -L cursor-agent -f /dev/null`), помечает сессию своими опциями
// (`@cursor_managed`, `@cursor_workspace_hash`, `@cursor_session_version`,
// `@cursor_chat_id`) и переживает родителя. Своего сокета и своего сервера сессий у неё нет
// — всё, что механизму нужно от «сервера сессий», отдаёт tmux: список, ввод, вывод, гашение.
//
// **Отсюда три вещи, которых у headless-пути не было.** Живой процесс между ходами, вход
// человека (`agent persist attach`) и программный ввод в живую сессию: текст доезжает
// нажатием клавиш в TUI, а не новым процессом. Ходов механизм больше не держит вовсе —
// держит их сам бинарь, а механизм ведёт запись сессии и разговаривает с ней через tmux.
//
// **Дом реестра — `~/.promptobus/cursor`, а не `~/.cursor`.** Второе — дом человека, и писать
// туда сверх того, что кладёт сам Cursor, механизм не вправе. Переменная `PROMPTOBUS_CURSOR_HOME`
// уводит его целиком: ею набор ставит реестр в песочницу, иначе прогон писал бы в дом
// разработчика. Дом самого Cursor уводится своей — `PROMPTOBUS_CURSOR_USER_HOME`, и уводит
// её тоже только набор: настоящие стенограммы лежат в `~/.cursor/projects`.
//
// Все числа и формы ниже сняты живыми прогонами спайка  (2026-09-03, `agent`
// 2026.09.02-c22c1a3, tmux 3.6b), а не выведены из документации: документации на `persist` у
// Cursor нет вовсе, а сама подкоманда своих флагов не имеет.

/** Имя переменной, которой сессия помечена для добора её процессов и для сдачи contact point'а. */
export const SESSION_ENV_VAR = 'PROMPTOBUS_CURSOR_SESSION';

/**
 * Сервер tmux, на котором живут persist-сессии. Имя не наше — его выбирает сам `persist`, и
 * менять его переменной `CURSOR_AGENT_TMUX_SERVER_NAME` механизм не станет: участники живут
 * на общем сервере ровно затем, чтобы человеку хватило `agent persist list` и
 * `agent persist attach <имя>` без единой переменной в окружении (решение владельца).
 */
export const CURSOR_TMUX_SERVER = 'cursor-agent';

/**
 * Сервер одноразовых панелей-поставщиков pty. Свой, потому что панель — машинерия подъёма, а
 * не сессия участника: в `agent persist list` ей делать нечего, а гасится она через секунду
 * после старта.
 */
export const LAUNCH_TMUX_SERVER = 'promptobus-launch';

/**
 * `persist` поднимает свой сервер с `TMUX_TMPDIR=/tmp` (REPORT §2), и разговаривать с ним
 * надо оттуда же: сокет ищется по этой переменной, и её умолчание у разных систем разное.
 */
export const TMUX_TMPDIR = '/tmp';

/** Опции, которыми `persist` помечает свою сессию. По ним она и опознаётся среди прочих. */
export const CURSOR_SESSION_OPTS = ['@cursor_managed', '@cursor_workspace_hash', '@cursor_session_version', '@cursor_chat_id'];

/**
 * Опции, которыми СВОИ сессии помечает механизм. По ним `inspect` отличает участников от
 * persist-сессий человека, и по ним же уборка не трогает чужих: сервер общий, и «погасить
 * всё, что нашлось» сняло бы работу человека.
 */
export const TASK_OPT = '@promptobus_task';
export const ADDRESS_OPT = '@promptobus_address';

/**
 * Пауза между вставкой текста и `Enter`. Замер спайка (REPORT §4.3): без паузы Enter
 * ТЕРЯЕТСЯ — текст остаётся в поле ввода и приклеивается к следующему сообщению (живой
 * случай: `LAT-8` и `LAT-9` ушли в стенограмму одним сообщением). С 0,3–0,4 с прошли все
 * прогоны; берём верх замера.
 */
export const ENTER_PAUSE_MS = 400;

/** Сколько ждём, пока поле ввода опустеет: сломанный случай — потолок, обычный — такт-другой. */
export const INPUT_WAIT_MS = 5_000;
export const INPUT_STEP_MS = 100;
export const ENTER_SETTLE_MS = 400;

/**
 * Потолок ТИШИНЫ в стенограмме, а не общего времени хода.
 *
 * Порог именно на тишине, потому что у настоящего worker'а ход идёт МИНУТАМИ: он читает
 * файлы, правит их и зовёт инструменты, и общий потолок резал бы живую работу. Число то же,
 * что было у watchdog'а по потоку: 180 с — вшестеро больше самого долгого
 * нормального хода целиком. Изменилось только, ЧТО молчит: не поток `stream-json`, которого
 * под persist нет вовсе, а файл стенограммы.
 *
 * И изменилось, что watchdog ДЕЛАЕТ. Процесса хода у механизма больше нет, убивать нечего:
 * порог теперь даёт вердикт `inspect`'у — «ход молчит дольше порога», — а решение остаётся
 * человеку и надзирателю.
 */
export const TURN_IDLE_MS = 180_000;

/**
 * Окно, в котором инъекция считается начатым ходом, хотя стенограмма о нём ещё молчит.
 * Замер спайка: от инъекции до ответа в стенограмме 3,09 и 8,03 с (`composer-2.5`), то есть
 * первая строка появляется не мгновенно. Без окна `inspect` в этом промежутке говорил бы
 * «сессия свободна», и надзиратель слал бы второе пробуждение на то же непрочитанное.
 */
export const INJECT_GRACE_MS = 20_000;

/**
 * Сколько ждём появления persist-сессии в списке tmux. Замер: 1,17–1,39 с (три старта),
 * потолок — с запасом на занятую машину. Форма ожидания — `{tries, delayMs}`, та же, что у
 * соседнего driver'а: `awaitOptions` приходит вызывающим одним контрактом, и вторая форма
 * здесь молча игнорировала бы чужую (замечание ревью).
 */
export const LIFT_TRIES = 240;
export const LIFT_STEP_MS = 250;

/** Сколько ждём исчезновения сессии после `persist stop`. Замер самого гашения: 0,14–0,15 с. */
export const STOP_TIMEOUT_MS = 10_000;
export const STOP_STEP_MS = 100;

/**
 * Шов набора: живой порог тишины мерится минутами, и ждать их в наборе нечем. Переменная
 * читается только здесь; в жизни она не задана, и порог остаётся живым.
 */
export function turnIdleMs(env = process.env) {
  const named = Number(env.PROMPTOBUS_CURSOR_IDLE_MS);
  return Number.isFinite(named) && named > 0 ? named : TURN_IDLE_MS;
}

// --- реестр сессий -----------------------------------------------------------------

export function cursorStateHome(env = process.env) {
  const named = String(env.PROMPTOBUS_CURSOR_HOME ?? '').trim();
  return named || path.join(homedir(), '.promptobus', 'cursor');
}

/** Дом самого Cursor: в нём он ведёт стенограммы сессий. Уводится только набором. */
export function cursorUserHome(env = process.env) {
  const named = String(env.PROMPTOBUS_CURSOR_USER_HOME ?? '').trim();
  return named || path.join(homedir(), '.cursor');
}

export function sessionsDir(env = process.env) {
  return path.join(cursorStateHome(env), 'sessions');
}

/**
 * Ключ файла по opaque session reference. Читаемая часть — ради того, чтобы каталог реестра
 * можно было читать глазами; хвост — sha1 полного ref'а, потому что читаемая часть его не
 * различает: имя сессии несёт кириллицу и скобки, и после отсечки нелатиницы два разных
 * имени сошлись бы в один файл, то есть в одну сессию.
 */
export function sessionKey(ref) {
  const flat = String(ref ?? '');
  const head = flat.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).toLowerCase();
  const hash = createHash('sha1').update(flat).digest('hex').slice(0, 12);
  return head ? `${head}-${hash}` : hash;
}

export function sessionFile(ref, env = process.env) {
  return path.join(sessionsDir(env), `${sessionKey(ref)}.json`);
}

/** Скрипт подъёма: им панель-поставщик зовёт `persist`. Живёт до подтверждения сессии. */
function launchScriptFile(ref, env = process.env) {
  return path.join(sessionsDir(env), `${sessionKey(ref)}.launch.sh`);
}

/** Лок инъекции: writer у сессии один. Две инъекции разом склеили бы два сообщения в одно. */
function lockFile(ref, env = process.env) {
  return path.join(sessionsDir(env), `${sessionKey(ref)}.inject.lock`);
}

/**
 * Сколько лок считается живым без своего процесса. Инъекция занимает секунду, а сломанная —
 * секунд пять (потолки ожидания ниже); минута — с запасом на медленную машину и вдесятеро
 * меньше порога молчания участника.
 */
export const LOCK_STALE_MS = 60_000;

/**
 * Взять лок инъекции или сказать, кто его держит.
 *
 * **Бесхозный лок перехватывается** (замечание ревью). Снимает лок `finally` своего процесса,
 * а процессов у доставки двое — надзиратель и команда механизма; умри писатель между взятием
 * и снятием, лок пережил бы его, и КАЖДАЯ следующая доставка в эту сессию отказывала бы
 * «уже пишет кто-то ещё» до самого гашения участника. Поэтому в локе лежат pid и время:
 * мёртвый pid или запись старше порога — бесхозный лок, и он берётся заново.
 */
function takeLock(file) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, { flag: 'wx' });
      return { ok: true };
    } catch {
      // Лок занят — смотрим, жив ли его хозяин.
    }
    let held = null;
    try {
      held = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      held = null;
    }
    const age = Date.now() - Date.parse(held?.at ?? '');
    const alive = pidAlive(Number(held?.pid));
    if (alive && !(Number.isFinite(age) && age > LOCK_STALE_MS)) {
      return {
        ok: false,
        error: `в эту сессию уже пишет процесс ${held?.pid ?? '(pid не назван)'} — две инъекции разом склеились бы `
          + `в одно сообщение. Лок снимается сам; завис — снимай руками: ${file}`,
      };
    }
    rmSync(file, { force: true });
  }
  return {
    ok: false,
    error: `лок инъекции не взять: его перехватил кто-то ещё между двумя попытками — ${file}`,
  };
}

/** Файл, из которого текст уезжает в буфер tmux: многострочное через argv не проносится. */
function bufferFile(ref, env = process.env) {
  return path.join(sessionsDir(env), `${sessionKey(ref)}.buf`);
}

function writeJson(file, value, { secret = false } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, secret ? { mode: 0o600 } : undefined);
  renameSync(tmp, file);
  return value;
}

export function readSession(ref, env = process.env) {
  try {
    return JSON.parse(readFileSync(sessionFile(ref, env), 'utf8'));
  } catch {
    return null;
  }
}

export function writeSession(record, env = process.env) {
  // Права `0600`: в записи лежат путь рабочего дерева, id чата и имя сессии — не токен, но
  // и не то, что должно читаться всей машиной.
  return writeJson(sessionFile(record.ref, env), record, { secret: true });
}

/**
 * Правка записи под чтение-запись. Писателей у неё двое — хук конца хода и команды
 * механизма, — и оба меняют РАЗНЫЕ поля: хук ведёт счётчик ходов, команды заводят и сносят
 * сессию. Полной замены поэтому не делаем нигде: слияние поверх свежего чтения дешевле лока
 * и теряет ровно то, что и так перетёрлось бы.
 */
export function patchSession(ref, patch, env = process.env) {
  const was = readSession(ref, env);
  if (!was) return null;
  return writeSession({ ...was, ...patch }, env);
}

/** Снять сессию из реестра целиком — запись, скрипт подъёма, лок и буфер. */
export function dropSession(ref, env = process.env) {
  for (const file of [sessionFile(ref, env), launchScriptFile(ref, env), lockFile(ref, env), bufferFile(ref, env)]) {
    rmSync(file, { force: true });
  }
}

/** Жив ли процесс. Сигналом 0 — тем же признаком, каким живость судит весь механизм. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function settle(ms) {
  await new Promise((r) => { setTimeout(r, ms); });
}

// --- разговор с tmux ----------------------------------------------------------------

/**
 * Вызов tmux на названном сервере. `-f /dev/null` — тем же флагом, что и `persist`: личный
 * `~/.tmux.conf` человека не должен доезжать до сессии участника, иначе его биндинги и его
 * `default-shell` меняли бы то, что механизм вставляет и читает.
 */
export function tmux(args, { server = CURSOR_TMUX_SERVER, env = process.env, input = null } = {}) {
  return run('tmux', ['-u', '-L', server, '-f', '/dev/null', ...args], {
    encoding: 'utf8',
    env: { ...env, TMUX_TMPDIR },
    ...(input === null ? {} : { input }),
  });
}

/**
 * Поля, которыми tmux отдаёт состояние сессии машинно, и разделитель между ними: разбирать
 * человеческий текст `persist list` незачем, те же поля tmux отдаёт полями. Путей в перечне
 * нет — в них разделитель встретиться может, а в имени сессии, хэше, id чата и наших метках
 * не может.
 */
const LIST_SEP = '|';
const LIST_FIELDS = [
  '#{session_name}', '#{session_attached}', '#{session_created}', '#{pane_pid}',
  '#{@cursor_managed}', '#{@cursor_workspace_hash}', '#{@cursor_chat_id}', `#{${TASK_OPT}}`, `#{${ADDRESS_OPT}}`,
];

/**
 * Сессии сервера машинно. Пустой список у несуществующего сервера — не отказ: tmux-сервер
 * живёт, пока на нём есть сессии, и «no server running» значит ровно «сессий нет».
 */
export function listSessions({ server = CURSOR_TMUX_SERVER, env = process.env } = {}) {
  const r = tmux(['list-sessions', '-F', LIST_FIELDS.join(LIST_SEP)], { server, env });
  if (r.error || r.status !== 0) return [];
  return String(r.stdout ?? '').split('\n').filter(Boolean).map((line) => {
    const [name, attached, created, panePid, managed, hash, chatId, task, address] = line.split(LIST_SEP);
    return {
      name,
      attached: Number(attached) || 0,
      created: Number(created) || 0,
      panePid: Number(panePid) || null,
      managed: managed === '1',
      hash: hash || null,
      chatId: chatId || null,
      task: task || null,
      address: address || null,
    };
  });
}

/** Одна сессия по имени либо `null`. */
export function findSession(name, { server = CURSOR_TMUX_SERVER, env = process.env } = {}) {
  if (!name) return null;
  return listSessions({ server, env }).find((s) => s.name === name) ?? null;
}

/**
 * Хэш рабочего каталога, которым `persist` метит свою сессию (REPORT §2, §4.10): первые
 * десять знаков sha256 от пути. По нему механизм и узнаёт СВОЮ сессию среди чужих — имя её
 * придумывает сам бинарь и заранее не печатает.
 *
 * **Путь берётся РАЗРЕШЁННЫЙ** (живой замер 2026-09-03): Cursor хэширует то, во что путь
 * разворачивается, а на macOS `$TMPDIR` — симлинк, и `/var/folders/…` против
 * `/private/var/folders/…` дают разные хэши. Не разреши путь — и подъём из такого каталога
 * ждёт свою сессию до потолка, а потом объявляет неподнявшейся ЖИВУЮ сессию и оставляет её
 * на машине.
 */
export function workspaceHash(cwd) {
  let flat = String(cwd);
  try {
    flat = realpathSync(flat);
  } catch {
    // Каталога ещё нет либо он недоступен — хэшируем как есть: своя сессия тогда просто не
    // найдётся, и подъём скажет об этом отказом.
  }
  return createHash('sha256').update(flat).digest('hex').slice(0, 10);
}

/** Что видно в панели сейчас. Читается ради поля ввода и подписи идущего хода. */
export function capturePane(name, { server = CURSOR_TMUX_SERVER, env = process.env } = {}) {
  const r = tmux(['capture-pane', '-p', '-t', name], { server, env });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout ?? '');
}

/**
 * Подписи TUI, на которые опирается протокол ввода. Обе сняты живыми прогонами спайка
 * (REPORT §4.3, §4.6) и обе — НЕ документированный интерфейс: у TUI Cursor версии нет вовсе,
 * и любая его правка способна сломать чтение. Поэтому они собраны здесь, в одном месте, а не
 * рассыпаны по коду: сломается — чинится строкой.
 */
const INPUT_PROMPT = '→ ';
const INPUT_PLACEHOLDER = 'Add a follow-up';
const BUSY_LINE = 'ctrl+c to stop';

/**
 * Текст, стоящий в поле ввода панели. Пустое поле — приглашение без текста.
 *
 * **Подпись идущего хода живёт на ТОЙ ЖЕ строке, что и поле ввода** (живой замер 2026-09-03,
 * `cursor-grok-4.6-xhigh-fast`): пока идёт ход, строка выглядит как
 * `→ Add a follow-up …пробелы… ctrl+c to stop`. Не сними её — и поле ввода читается занятым
 * на каждом идущем ходе: доставка отказывает «в поле остался текст», хотя поле пустое. Так и
 * вышло на первом живом прогоне под persist — три отказа из трёх при исправной доставке.
 */
export function inputText(pane) {
  const lines = String(pane ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith(INPUT_PROMPT)) continue;
    let text = line.slice(INPUT_PROMPT.length).trim();
    if (text.endsWith(BUSY_LINE)) text = text.slice(0, -BUSY_LINE.length).trim();
    return text === INPUT_PLACEHOLDER ? '' : text;
  }
  return '';
}

// --- подъём -------------------------------------------------------------------------

// Имена, которые `-u` снимает, в assignments не входят: `env` применяет аргументы
// слева направо, и `TMUX=…` после `-u` вернул бы чужую сессию на место.
const LAUNCH_UNSET = ['TMUX', 'TMUX_PANE'];

/**
 * Скрипт панели-поставщика pty.
 *
 * Окружение материализуется ЗДЕСЬ, а не наследуется панелью, и это не перестраховка:
 * панель наследует окружение tmux-СЕРВЕРА, а сервер мог подняться на прошлом подъёме с
 * другим окружением — метка сессии уехала бы в чужую запись. `env -u` по `LAUNCH_UNSET` —
 * ловушка спайка (REPORT §4.2): внутри чужого `TMUX` подкоманда `persist` МОЛЧА поднимает
 * обычный непостоянный `agent` — ни tmux-сессии, ни строки в `persist list`, ни слова об
 * этом в выводе.
 */
export function launchScript({ bin, argv, env }) {
  const drop = new Set(LAUNCH_UNSET);
  const assignments = Object.entries(env ?? {})
    .filter(([k, v]) => v !== undefined && v !== null && !drop.has(k))
    .map(([k, v]) => `${k}=${shellQuote(String(v))}`);
  const unsetFlags = LAUNCH_UNSET.map((n) => `-u ${n}`).join(' ');
  return `#!/bin/sh\nexec env ${unsetFlags} ${assignments.join(' ')} \\\n  ${shellQuote(bin)} `
    + `${argv.map(shellQuote).join(' ')}\n`;
}

/**
 * Поднять persist-сессию: одноразовая панель на своём сервере, ожидание сессии в списке
 * `cursor-agent`, метка задачи и адреса, гашение панели.
 *
 * Имя сессии придумывает сам бинарь (`cursor-<слаг>-<хэш>-<n>-<rand6>`), и заранее его не
 * напечатать — поэтому оно узнаётся ПОСЛЕ старта, ровно так же, как id чата. Своя сессия
 * опознаётся тремя признаками сразу: хэш рабочего каталога, непустой `@cursor_chat_id` и
 * время создания не раньше нашего старта — на общем сервере рядом живут persist-сессии
 * человека, и взять чужую значило бы писать в его переписку.
 */
export async function liftSession({
  ref, bin, argv, cwd, env = process.env, launchEnv = null, task = null, address = null,
  tries = LIFT_TRIES, delayMs = LIFT_STEP_MS,
}) {
  const script = launchScriptFile(ref, env);
  mkdirSync(path.dirname(script), { recursive: true });
  // Окружение СЕССИИ и окружение наших вызовов tmux — разные вещи: первое материализуется в
  // скрипте (иначе панель унаследовала бы окружение tmux-сервера, а он мог подняться на
  // прошлом подъёме), второе нужно только чтобы найти сокет сервера.
  writeFileSync(script, launchScript({ bin, argv, env: launchEnv ?? env }), { mode: 0o700 });
  const hash = workspaceHash(cwd);
  const known = new Set(listSessions({ env }).map((s) => s.name));
  const startedAt = Math.floor(Date.now() / 1000);
  const pane = `promptobus-${sessionKey(ref)}`;
  // Ширина панели задаётся явно: `capture-pane` читает то, что нарисовано, и узкая панель
  // рвала бы строки поля ввода. Ширину живой сессии потом всё равно ужимает вошедший
  // человек (REPORT §4.5) — но подъём от его терминала зависеть не должен.
  const started = tmux(['new-session', '-d', '-s', pane, '-x', '200', '-y', '50', '-c', cwd, 'sh', script],
    { server: LAUNCH_TMUX_SERVER, env });
  if (started.error || started.status !== 0) {
    rmSync(script, { force: true });
    const why = started.error?.message ?? (String(started.stderr ?? '').trim() || `код ${started.status}`);
    return { ok: false, error: `панель-поставщик pty не поднялась: ${why}` };
  }
  let seen = null;
  for (let i = 0; i < tries; i += 1) {
    seen = listSessions({ env }).find((s) => s.hash === hash && s.chatId && !known.has(s.name)
      && s.created >= startedAt - 2) ?? null;
    if (seen) break;
    if (i < tries - 1) await settle(delayMs);
  }
  if (seen) {
    // Метка своей сессии: по ней `inspect` отличает участника от persist-сессии человека, а
    // уборка — своё от чужого. Ставится ДО гашения панели: погасшая панель сессию не трогает,
    // а непомеченная сессия на общем сервере неотличима от чужой.
    if (task) tmux(['set-option', '-t', seen.name, TASK_OPT, task], { env });
    if (address) tmux(['set-option', '-t', seen.name, ADDRESS_OPT, address], { env });
  }
  // Панель гасится в обеих ветках: persist-сессия её переживает (REPORT §2), а неудавшийся
  // подъём не имеет права оставить за собой процесс.
  tmux(['kill-session', '-t', pane], { server: LAUNCH_TMUX_SERVER, env });
  rmSync(script, { force: true });
  if (!seen) {
    return {
      ok: false,
      error: 'persist-сессия не появилась в списке tmux. Так выглядит и отказ бинаря до старта '
        + '(неверный id модели, просроченный вход), и запуск изнутри чужого TMUX — тогда persist молча '
        + 'поднимает обычный непостоянный agent',
    };
  }
  return { ok: true, session: seen };
}

// --- ввод ---------------------------------------------------------------------------

/**
 * Доставить текст в живую сессию.
 *
 * Протокол — тот, что снят спайком (REPORT §4.3), и каждый его шаг платит за живой промах:
 *
 *   1. **поле ввода чистится**, иначе остаток прошлой неудачи уедет вместе с новым текстом;
 *   2. **текст едет буфером tmux**, а не `send-keys -l`: многострочное сообщение через
 *      bracketed paste ложится в стенограмму ОДНИМ сообщением, а построчный ввод разослал
 *      бы его несколькими;
 *   3. **между вставкой и `Enter` стоит пауза** — без неё Enter теряется, текст остаётся в
 *      поле и приклеивается к следующему сообщению;
 *   4. **вставка и отправка сверяются по `capture-pane`**: пусто в поле — значит ушло.
 *
 * Доставка идёт и в ИДУЩИЙ ход. Текст встаёт в очередь TUI и исполняется отдельным ходом
 * сразу после текущего (REPORT §4.3): идущий ход его не видит, инъекция ход не прерывает,
 * второго параллельного хода не возникает. Отказывать «ход идёт» здесь больше не за что —
 * сообщение не теряется, оно ждёт.
 */
export async function injectText(record, text, { env = process.env, pauseMs = ENTER_PAUSE_MS } = {}) {
  const name = record?.sessionName;
  const server = record?.tmuxServer || CURSOR_TMUX_SERVER;
  if (!name) return { ok: false, error: 'у записи сессии нет имени persist-сессии — доставлять нечего' };
  const lock = lockFile(record.ref, env);
  mkdirSync(path.dirname(lock), { recursive: true });
  const taken = takeLock(lock);
  if (!taken.ok) return taken;
  try {
    const cleared = await clearInput(name, { server, env });
    if (!cleared.ok) return cleared;
    const buf = bufferFile(record.ref, env);
    writeFileSync(buf, text);
    const bufName = `promptobus-${sessionKey(record.ref)}`;
    const loaded = tmux(['load-buffer', '-b', bufName, buf], { server, env });
    if (loaded.error || loaded.status !== 0) {
      return { ok: false, error: `текст не уехал в буфер tmux: ${String(loaded.stderr ?? '').trim() || `код ${loaded.status}`}` };
    }
    // `-p` — bracketed paste (одним сообщением), `-d` — буфер снимается сразу: имя буфера
    // одно на сессию, и остаток прошлой вставки уехал бы следующей.
    const pasted = tmux(['paste-buffer', '-p', '-d', '-b', bufName, '-t', name], { server, env });
    rmSync(buf, { force: true });
    if (pasted.error || pasted.status !== 0) {
      return { ok: false, error: `текст не вставился в поле ввода: ${String(pasted.stderr ?? '').trim() || `код ${pasted.status}`}` };
    }
    // Пауза перед Enter — тот самый шаг, без которого Enter теряется. Мишень мутационной
    // пробы: сними её, и стенд склеит два сообщения в одно, как склеил живой прогон.
    await settle(pauseMs);
    const sent = tmux(['send-keys', '-t', name, 'Enter'], { server, env });
    if (sent.error || sent.status !== 0) {
      return { ok: false, error: `Enter не дошёл до сессии: ${String(sent.stderr ?? '').trim() || `код ${sent.status}`}` };
    }
    // Поле пустеет сразу за Enter — ждём такт-другой, а не полный потолок: эту операцию круг
    // надзирателя ждёт СИНХРОННО, и лишние секунды здесь стоят задержки доставки всем
    // остальным участникам. Цена доставки целиком — около секунды: 0,4 с паузы перед Enter
    // плюс пять вызовов tmux по три-четыре десятка миллисекунд.
    const gone = await waitInput(name, { server, env }, (value) => value === '', { timeoutMs: ENTER_SETTLE_MS });
    if (!gone) {
      return {
        ok: false,
        error: 'текст остался в поле ввода после Enter — сообщение не отправлено; следующая доставка чистит поле '
          + 'и шлёт заново',
      };
    }
    return { ok: true };
  } finally {
    // Сюда попадают только с взятым локом: отказ `takeLock` возвращается выше по коду.
    rmSync(lock, { force: true });
  }
}

/**
 * Очистить поле ввода перед вставкой. `C-u` — обычная правка строки; сессия его не понявшая
 * оставит текст, и тогда доставка честно отказывает: приклеить новое сообщение к чужому
 * остатку хуже, чем не доставить и сказать об этом.
 */
async function clearInput(name, { server, env }) {
  if (!inputText(capturePane(name, { server, env }))) return { ok: true };
  tmux(['send-keys', '-t', name, 'C-u'], { server, env });
  const empty = await waitInput(name, { server, env }, (value) => value === '');
  if (empty) return { ok: true };
  return {
    ok: false,
    error: `в поле ввода сессии остался текст, и очистить его не вышло — новое сообщение приклеилось бы к нему`,
  };
}

async function waitInput(name, { server, env }, ok, { timeoutMs = INPUT_WAIT_MS, stepMs = INPUT_STEP_MS } = {}) {
  const edge = Date.now() + timeoutMs;
  for (;;) {
    if (ok(inputText(capturePane(name, { server, env })))) return true;
    if (Date.now() >= edge) return false;
    await settle(stepMs);
  }
}

// --- стенограмма ---------------------------------------------------------------------

/**
 * Стенограмма чата — единственный машинный источник о ходе под persist: потока `stream-json`
 * здесь нет вовсе. Лежит она в доме человека,
 * `~/.cursor/projects/<путь слагом>/agent-transcripts/<chatId>/<chatId>.jsonl`, и слаг
 * механизм НЕ вычисляет: длинные пути Cursor обрезает и дописывает к ним хэш
 * (`Users-kim-p-AtiWorkspace-trials-0831-home-cursor-AtiWo-aede696` в доме владельца), то
 * есть по правилу его не собрать. Путь ищется по id чата один раз и ложится в запись.
 */
export function findTranscript(chatId, env = process.env) {
  if (!chatId) return null;
  const root = path.join(cursorUserHome(env), 'projects');
  let dirs = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const file = path.join(root, dir, 'agent-transcripts', chatId, `${chatId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

/** Путь стенограммы записи: из записи, а найдя впервые — в запись. */
export function transcriptOf(record, env = process.env) {
  const known = record?.transcript;
  if (known && existsSync(known)) return known;
  const found = findTranscript(record?.chatId, env);
  if (found && record?.ref) patchSession(record.ref, { transcript: found }, env);
  return found;
}

/**
 * Что стенограмма говорит о ходе. «Идёт ли ход» читается ПОРЯДКОМ строк: сообщение
 * пользователя открывает ход, `{"type":"turn_ended"}` закрывает.
 *
 * **`turn_ended` — не запись события, а маркер конца ФАЙЛА** (живой замер 2026-09-03,
 * поправка к REPORT §4.6). Файл переписывается: после второго хода прежний `turn_ended`
 * из середины исчезает, и новый стоит один в конце — на пяти строках стенограммы двух ходов
 * он ровно один. Поэтому считать им ходы нельзя; счётчик кончившихся ходов ведёт хук
 * ([driver-cursor.js](driver-cursor.js), `registerWake`), а отсюда берётся только «идёт или
 * нет». `ended` остаётся числом ради разбора: несколько маркеров в одном файле — форма,
 * которую разбор обязан пережить, а не признак нескольких ходов.
 */
export function readTranscript(file) {
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let busy = false;
  let ended = 0;
  let status = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === 'turn_ended') {
      busy = false;
      ended += 1;
      status = event.status ?? null;
      continue;
    }
    if (event?.role === 'user') busy = true;
  }
  let touchedAt = null;
  try {
    touchedAt = statSync(file).mtimeMs;
  } catch {
    touchedAt = null;
  }
  return { busy, ended, status, touchedAt };
}

/**
 * Идёт ли ход сессии прямо сейчас, и молчит ли он дольше порога.
 *
 * Инъекция считается ходом ещё до того, как стенограмма о нём скажет: от инъекции до первой
 * строки проходит секунды (REPORT §4.3), и в этом окне `inspect` иначе говорил бы «сессия
 * свободна», а надзиратель слал бы второе пробуждение на то же непрочитанное. Окно
 * закрывается само, как только стенограмма скажет «ход идёт», — считать по ней ходы нельзя
 * (см. `readTranscript`).
 */
export function turnState(record, env = process.env) {
  const file = transcriptOf(record, env);
  const seen = file ? readTranscript(file) : null;
  const injectedAt = Date.parse(record?.injectedAt ?? '');
  const fresh = Number.isFinite(injectedAt) && Date.now() - injectedAt < INJECT_GRACE_MS
    && !seen?.busy;
  const busy = !!seen?.busy || fresh;
  const idleMs = seen?.touchedAt ? Date.now() - seen.touchedAt : null;
  return {
    busy,
    ended: seen?.ended ?? 0,
    status: seen?.status ?? null,
    transcript: file,
    silentMs: idleMs,
    // Тишина судится только у идущего хода: у простаивающей сессии стенограмма молчит
    // законно, и порог там означал бы «встал» на каждой сессии, ждущей сообщения.
    silent: !!(busy && !fresh && idleMs !== null && idleMs > turnIdleMs(env)),
  };
}

/**
 * Процесс агента Cursor. Для сторожа — рантайм (не инструмент). Для уборки — сирота
 * `worker-server` (см. reapOrphans): одного имени мало, нужен ещё маркер сессии.
 */
const WORKER_SERVER_CMD = /worker-server/;

/**
 * Игла шины рядом с `worker-server`: не из `.cursor/mcp.json`. Отказ чтения файла иначе
 * оставляет needles пустыми, и `promptobus mcp` становится «инструментом» — стопа нет.
 * `ensureWarden` поднимает надзирателя `detached` + `unref` (`warden.js`, launchWarden):
 * ppid остаётся за родителем, и надзиратель, заведённый MCP-сервером участника, навсегда
 * ребёнок этого процесса.
 */
export const BUS_MCP_NEEDLE = `${PROMPTOBUS_SERVER} mcp`;

const INTERPRETERS = /^(?:node|nodejs|python\d*|python|ruby|perl|php|sh|bash|zsh|env|npx|npm|pnpm|yarn|deno|bun)$/i;

/** Иглы командной строки stdio-серверов из проектного MCP участника. */
export function mcpRuntimeNeedles(mcp) {
  const needles = [];
  for (const cfg of Object.values(mcp?.mcpServers ?? {})) {
    if (!cfg || (cfg.type && cfg.type !== 'stdio')) continue;
    const parts = [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])]
      .filter((p) => p != null && String(p).trim() !== '')
      .map(String);
    const distinctive = parts.filter((p) => !INTERPRETERS.test(path.basename(p.split(/\s+/)[0])));
    // Голый интерпретатор (`{command:'node'}`) — не игла: иначе рантаймом станет каждый
    // node-процесс панели. Пустой distinctive сервер пропускаем, на parts не откатываемся.
    if (!distinctive.length) continue;
    needles.push(distinctive.join(' '));
  }
  return needles;
}

export function readParticipantMcp(record) {
  const cwd = record?.cwd;
  if (!cwd) return null;
  try {
    return JSON.parse(readFileSync(path.join(cwd, '.cursor', 'mcp.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function isRuntimeCmd(cmd, needles = []) {
  const s = String(cmd ?? '');
  if (WORKER_SERVER_CMD.test(s)) return true;
  if (s.includes(BUS_MCP_NEEDLE)) return true;
  return needles.some((n) => n && s.includes(n));
}

/**
 * Таблица процессов одним `ps`. `ww` обязателен: BSD `ps` без него режет ширину, а признак
 * шины — игла контракта (`promptobus mcp`). Замер на живой сессии этой машины (2026-09-03,
 * процессы MCP рабочего места): строка `promptobus mcp` — 159 знаков и с `-Ao`, и с `-Awwo`.
 * Без `ww` хвост команды обрежется, сервер шины сочтится инструментом, стопа не будет.
 * Тот же файл для окружения уже берёт `ps eww`.
 */
function psTable(ps, columns) {
  const listed = ps('ps', ['-Awwo', columns], { encoding: 'utf8' });
  if (listed.error || listed.status !== 0) return null;
  const kids = new Map();
  const cmd = new Map();
  for (const line of String(listed.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    const child = Number(m[1]);
    const parent = Number(m[2]);
    cmd.set(child, m[3] ?? '');
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(child);
  }
  return { kids, cmd };
}

function walkKids(root, kids, { keep = () => true, descend = () => true } = {}) {
  const base = Number(root);
  if (!Number.isInteger(base) || base <= 0) return [];
  const walk = [base];
  const seen = new Set([base]);
  const out = [];
  while (walk.length) {
    const next = walk.pop();
    for (const child of kids.get(next) ?? []) {
      if (seen.has(child) || child === process.pid) continue;
      seen.add(child);
      if (keep(child)) out.push(child);
      if (descend(child)) walk.push(child);
    }
  }
  return out;
}

/**
 * Инструментальные потомки процесса панели — признак жизни хода шире тишины стенограммы.
 * TUI пишет стенограмму по концу вызова, и долгий гейт (`npm test` на минуты) молчит
 * законно, пока живы sh/node/npm/git хода. Тишина без таких потомков — стоп.
 *
 * В поддерево рантайма не спускаемся: сам процесс и его дети — не инструменты. Инструменты
 * в жизни — дети агента / панели, не `worker-server`. Надзиратель, которого поднял MCP
 * участника (штатно, когда живого нет: потолок `WARDEN_TOTAL_SEC`, выход по
 * `ROUND_FAIL_LIMIT`, следующий вызов шины), навсегда ребёнок `promptobus mcp`. Строка
 * `agents.js promptobus warden --task …` не матчит ни `WORKER_SERVER_CMD`, ни иглу шины:
 * спуск оставил бы kids непустым навсегда, и ослеп бы тот самый надзиратель. `sh -c persist`
 * и `node … --cursor-persist-restore` рантаймом не являются — после сужения регекса
 * спускаться ради них нечего.
 */
export function toolKidsOf(pid, { ps = run, needles = [] } = {}) {
  const table = psTable(ps, 'pid=,ppid=,command=');
  if (!table) return [];
  const runtime = (id) => isRuntimeCmd(table.cmd.get(id), needles);
  return walkKids(pid, table.kids, {
    keep: (id) => !runtime(id),
    descend: (id) => !runtime(id),
  });
}

/** Тишина стенограммы сама по себе не стоп: стоп — тишина И нет инструментальных потомков. */
export function silentIsStall(turn, kids) {
  return !!(turn?.silent && !(kids?.length));
}

// --- уборка --------------------------------------------------------------------------

/**
 * Метка сессии в окружении её процессов. Считается из ref'а, а не берётся из записи: по ней
 * добираются и дети инструментов, и сирота `worker-server`, а к моменту уборки записи о
 * ходе уже нет.
 */
export function sessionMarker(record, env = process.env) {
  return record?.ref ? `${SESSION_ENV_VAR}=${sessionFile(record.ref, env)}` : null;
}

/**
 * Осиротевший `worker-server` (REPORT §4.11, §4.8). Опознаётся ДВУМЯ признаками сразу: имя
 * подкоманды в командной строке и метка сессии в окружении процесса. Одного имени мало —
 * `worker-server` поднимает каждая сессия Cursor на машине, в том числе сессия человека в
 * IDE, и бить по имени значило бы снимать чужую работу.
 *
 * Живёт она и после ШТАТНОГО конца хода: замер спайка — 11 минут после нормально
 * завершившегося хода, то есть порог «пройдёт само за минуты» не подтверждён.
 */
export function reapOrphans(marker, { ps = run } = {}) {
  if (!marker) return [];
  const listed = ps('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' });
  if (listed.error || listed.status !== 0) return [];
  const killed = [];
  for (const line of String(listed.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!m || !WORKER_SERVER_CMD.test(m[2])) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    // Окружение процесса печатает `ps eww`; на машине без него добора не будет вовсе — и
    // это лучше, чем убийство по одному имени.
    const dump = ps('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    if (dump.error || dump.status !== 0 || !String(dump.stdout ?? '').includes(marker)) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch {
      // Процесс умер сам между перечислением и сигналом — законный исход, а не отказ.
    }
  }
  return killed;
}

/**
 * Дети ИНСТРУМЕНТОВ идущего хода. `agent persist stop` гасит панель за 0,14 с, а процессы,
 * которые ход успел запустить (шелл инструмента и его потомки), остаются жить (REPORT §4.8)
 * — гашение сессии посреди хода оставляло бы их на машине каждый раз.
 *
 * Ищутся они деревом от процесса панели, а не по метке: у потомка инструмента в окружении
 * может не быть ничего нашего вовсе — окружение ему собирает инструмент, а не бинарь. Дерево
 * снимается ОДНИМ `ps`, потому что зовётся это из уборки задачи, а не из круга надзирателя.
 */
export function treeOf(pid, { ps = run } = {}) {
  const table = psTable(ps, 'pid=,ppid=');
  if (!table) return [];
  return walkKids(pid, table.kids);
}

/** Снять названные процессы. Умерший сам между перечислением и сигналом — законный исход. */
export function killPids(pids) {
  const killed = [];
  for (const pid of pids ?? []) {
    if (!pidAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch {
      // Умер сам — считать это отказом не за что.
    }
  }
  return killed;
}

/**
 * Погасить persist-сессию: команда harness'а, ожидание её исчезновения, добор процессов.
 *
 * **Возвращается операция после того, как сессии у harness'а НЕТ**: следом за
 * гашением идёт уборка каталогов, и вернись `stop` раньше, обход увидел бы сессию живой и
 * законно оставил бы worktree.
 */
export async function stopSession(record, {
  env = process.env, bin = null, timeoutMs = STOP_TIMEOUT_MS, stepMs = STOP_STEP_MS,
} = {}) {
  const server = record?.tmuxServer || CURSOR_TMUX_SERVER;
  const name = record?.sessionName ?? null;
  const marker = sessionMarker(record, env);
  const live = name ? findSession(name, { server, env }) : null;
  // Дети инструментов переписываются ДО гашения, а снимаются после: гашение убивает панель,
  // и осиротевшие дети тут же переезжают под PPID 1 — дерево от pid панели после этого пусто.
  const panePid = live?.panePid ?? (Number(record?.panePid) || null);
  const kids = treeOf(panePid);
  if (!live) {
    // Сессии нет, а процессы её пережить могли: сирота `worker-server` живёт минутами и
    // после штатного конца хода.
    return { stopped: false, orphans: reapOrphans(marker), kids: killPids(kids) };
  }
  const agent = bin || record?.bin;
  let said = null;
  if (agent) {
    const r = run(agent, ['persist', 'stop', name], { encoding: 'utf8', env, cwd: record?.cwd });
    said = r.error ? r.error.message : String(r.stdout ?? r.stderr ?? '').trim();
  }
  const edge = Date.now() + timeoutMs;
  while (findSession(name, { server, env }) && Date.now() < edge) await settle(stepMs);
  let stopped = !findSession(name, { server, env });
  if (!stopped) {
    // Команда harness'а не сработала — гасим панель напрямую. Это не обход гейта «одна
    // сессия — один режим»: гейт держит сам бинарь на СВОЁМ сторе, а здесь снимается tmux,
    // и привязку чата бинарь подберёт на следующем подъёме сам (она чистится по возрасту).
    tmux(['kill-session', '-t', name], { server, env });
    const hard = Date.now() + timeoutMs;
    while (findSession(name, { server, env }) && Date.now() < hard) await settle(stepMs);
    stopped = !findSession(name, { server, env });
  }
  return {
    stopped, said, orphans: reapOrphans(marker), kids: killPids(kids),
  };
}
