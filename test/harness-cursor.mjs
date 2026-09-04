// Подставной harness Cursor: два бинаря — `agent` и `tmux`. Не `*.test.mjs` —
// раннер (run.mjs) берёт из каталога только их, и этот файл в прогон не попадает.
//
// Чем он отличается от подставного `claude` ([harness.mjs](harness.mjs)). Тот моделирует
// ДЕМОН: `--bg` заводит долгоживущую сессию, `agents --json` печатает её реестр, `stop`
// гасит. У Cursor вместо реестра — tmux: `agent persist` поднимает интерактивный TUI в
// панели, список сессий отдаёт `tmux list-sessions`, ввод — `paste-buffer` и `send-keys`,
// гашение — `agent persist stop`. Стенд повторяет именно это, потому что на этом и стоит
// driver.
//
// **Подставных бинаря два, и второй обязателен.** Требовать настоящего tmux от набора
// нельзя: он есть не на всякой машине, а прогон обязан судить driver, а не окружение. Зато
// стенд обязан моделировать те свойства tmux и `persist`, на которых driver и держится, — и
// каждое из них снято живым замером спайка  (REPORT):
//
//   - **пауза перед Enter** (§4.3): `send-keys Enter` раньше `STUB_ENTER_MIN_MS` после
//     вставки ТЕРЯЕТСЯ, текст остаётся в поле ввода и уезжает вместе со следующим;
//   - **`persist` внутри чужого `TMUX`** (§4.2) молча не персистит: ход играется, сессии не
//     появляется вовсе;
//   - **дети инструментов переживают `persist stop`** (§4.8), а сирота `worker-server`
//     живёт и после ШТАТНОГО конца хода;
//   - **неизвестное имя события в `.cursor/hooks.json`** (§4.4) молча убивает весь файл: не
//     стреляет ни один хук, включая правильно названные;
//   - **конец хода** — `{"type":"turn_ended","status":"success"}` в стенограмме плюс хук
//     `stop`; `sessionEnd` под persist не стреляет вовсе;
//   - **сообщение во время хода** (§4.3) встаёт в очередь и исполняется отдельным ходом
//     сразу после текущего.
//
// Подмена стоит на границе БИНАРЕЙ, а не driver'а: driver — предмет проверки, и подменённый
// перестал бы проверять `prepare`, `inspect`, инъекцию, `stop` и разбор стенограммы.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { KNOWN_HOOK_EVENTS, PROVEN_CURSOR_VERSION } from '../lib/driver-cursor.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Дом стенда в окружении: его читают оба подставных бинаря и тест. */
export const CURSOR_HOME_VAR = 'PROMPTOBUS_E2E_CURSOR';

/** Зависание хода — тем же флагом, каким его включает проба watchdog'а по тишине. */
export const HANG_VAR = 'PROMPTOBUS_E2E_CURSOR_HANG';

/**
 * То же зависание, но панель держит живого ребёнка. Тишина стенограммы тогда не стоп:
 * долгий гейт пишет в TUI только по концу вызова, а процессы при этом живы.
 */
export const HANG_CHILD_VAR = 'PROMPTOBUS_E2E_CURSOR_HANG_CHILD';

/**
 * Порог потери Enter. Живой замер: без паузы Enter теряется, с 0,3–0,4 с проходит всегда
 * (REPORT §4.3). Стенд берёт середину: driver со своей паузой 400 мс проходит, driver без
 * паузы — нет, и склейка двух сообщений в одно видна в стенограмме ровно так же, как её
 * увидел спайк.
 */
export const STUB_ENTER_MIN_MS = 250;

/** Версия, которой отвечает подставной tmux: та, на которой снят весь протокол спайка. */
export const TMUX_VERSION = 'tmux 3.6b';

/** Версия, которой отвечает подставной бинарь: своя копия числа сделала бы стенд бинарём,
 * которого механизм не поднимает вовсе (`optionRefusal` отказывает всему старше проверенной). */
export const HARNESS_VERSION = `${PROVEN_CURSOR_VERSION}-e2estub`;

// --- раскладка стенда ----------------------------------------------------------------

function serverDir(home, server) {
  return path.join(home, 'tmux', String(server).replace(/[^A-Za-z0-9._-]+/g, '-'));
}

function sessionPath(home, server, name) {
  return path.join(serverDir(home, server), 'sessions', `${String(name).replace(/[^A-Za-z0-9._-]+/g, '-')}.json`);
}

function readSess(home, server, name) {
  try {
    return JSON.parse(readFileSync(sessionPath(home, server, name), 'utf8'));
  } catch {
    return null;
  }
}

function writeSess(home, server, sess) {
  const file = sessionPath(home, server, sess.name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(sess, null, 2)}\n`);
  return sess;
}

function listSess(home, server) {
  const dir = path.join(serverDir(home, server), 'sessions');
  let files = [];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files.map((f) => {
    try {
      return JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function dropSess(home, server, name) {
  rmSync(sessionPath(home, server, name), { force: true });
}

/** Очередь сообщений сессии: её пишет `send-keys Enter`, читает подставной `agent`. */
function queueFile(home, name) {
  return path.join(home, 'queue', `${String(name).replace(/[^A-Za-z0-9._-]+/g, '-')}.jsonl`);
}

/**
 * Стенограмма чата в доме Cursor. Каталог проекта у живого бинаря — путь слагом, а длинные
 * пути он обрезает и дописывает к ним хэш; механизм слаг не вычисляет вовсе, а ищет
 * стенограмму по id чата, поэтому стенду довольно любого стабильного имени.
 */
export function transcriptFile(userHome, workspace, chatId) {
  const slug = `${String(workspace).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+/, '').slice(-60)}`;
  return path.join(userHome, 'projects', slug, 'agent-transcripts', chatId, `${chatId}.jsonl`);
}

/** Скрипт ходов участника: его пишет тест, читает подставной бинарь. Ключ — адрес. */
export function scriptFile(home, address) {
  return path.join(home, 'scripts', `${addrKey(address)}.json`);
}

/** След того, что участник делал и что ему ответила шина. По нему сверяет тест. */
export function traceFile(home, address) {
  return path.join(home, 'trace', `${addrKey(address)}.jsonl`);
}

/** Счётчик сыгранных ходов: ход у стенда — итерация цикла, и помнить номер удобнее файлом. */
export function turnsFile(home, address) {
  return path.join(home, 'turns', `${addrKey(address)}.json`);
}

export function addrKey(address) {
  return String(address).replace(/[^A-Za-z0-9._-]+/g, '-');
}

export function readTrace(home, address) {
  try {
    return readFileSync(traceFile(home, address), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  } catch {
    return [];
  }
}

export function planParticipant(home, address, script) {
  mkdirSync(path.dirname(scriptFile(home, address)), { recursive: true });
  writeFileSync(scriptFile(home, address), `${JSON.stringify(script, null, 2)}\n`);
  return script;
}

/** Диагноз по следу участника для красного вердикта. */
export function diagnoseTrace(home, address, tail = 8) {
  return `след ${address}: ${JSON.stringify(readTrace(home, address).slice(-tail))}`;
}

/** Жив ли процесс — тем же признаком, каким живость судит весь механизм. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// --- установка --------------------------------------------------------------------

/**
 * Разложить стенд и поставить его `agent` и `tmux` первыми в PATH. Оба дома механизма
 * уводятся туда же: реестр сессий (`PROMPTOBUS_CURSOR_HOME`) и дом Cursor со стенограммами
 * (`PROMPTOBUS_CURSOR_USER_HOME`) — без этого прогон писал бы в `~/legacy/cursor` и в
 * `~/.cursor` разработчика.
 *
 * Дом стенда заводится ВНЕ песочницы файла — по той же причине, что у подставного `claude`:
 * хук песочницы сносит её каталог раньше, чем стенд успевает убрать за собой.
 */
export async function installHarness({ binDir, env = process.env } = {}) {
  const { stubCommand, withStubPath } = await import('./sandbox.mjs');
  const home = mkdtempSync(path.join(os.tmpdir(), 'promptobus-cursor-'));
  armCleanup(home);
  for (const dir of ['scripts', 'trace', 'turns', 'approvals', 'state', 'queue', 'tmux', 'cursor']) {
    mkdirSync(path.join(home, dir), { recursive: true });
  }
  stubCommand(binDir, 'agent', `import { agentMain } from ${JSON.stringify(path.join(here, 'harness-cursor.mjs'))};\n`
    + 'await agentMain(process.argv.slice(2));\n');
  stubCommand(binDir, 'tmux', `import { tmuxMain } from ${JSON.stringify(path.join(here, 'harness-cursor.mjs'))};\n`
    + 'await tmuxMain(process.argv.slice(2));\n');
  const restore = withStubPath(binDir);
  const was = { state: env.PROMPTOBUS_CURSOR_HOME, user: env.PROMPTOBUS_CURSOR_USER_HOME };
  env[CURSOR_HOME_VAR] = home;
  env.PROMPTOBUS_CURSOR_HOME = path.join(home, 'state');
  env.PROMPTOBUS_CURSOR_USER_HOME = path.join(home, 'cursor');
  return {
    home,
    stateHome: path.join(home, 'state'),
    userHome: path.join(home, 'cursor'),
    restore: () => {
      restore();
      delete env[CURSOR_HOME_VAR];
      for (const [name, value] of [['PROMPTOBUS_CURSOR_HOME', was.state], ['PROMPTOBUS_CURSOR_USER_HOME', was.user]]) {
        if (value === undefined) delete env[name];
        else env[name] = value;
      }
    },
  };
}

// Уборка на выходе процесса — та же беда и то же лекарство, что у песочниц: упавшая
// проверка уносит процесс через `process.exit`, и парный вызов в хвосте файла не
// выполняется ровно на том прогоне, где мусор и остаётся.
const armed = new Set();
let hooked = false;
const exit0 = process.exit;

function armCleanup(home) {
  armed.add(home);
  if (hooked) return;
  hooked = true;
  const clean = () => {
    for (const dir of armed) {
      // Живые «панели» стенда — процессы: не сняв их, прогон оставил бы за собой сессию.
      for (const server of ['cursor-agent', 'promptobus-launch']) {
        for (const s of listSess(dir, server)) killTree(s.panePid);
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
  process.on('exit', clean);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { clean(); exit0.call(process, 130); });
  }
}

function killTree(pid) {
  if (!pidAlive(pid)) return;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // Группы нет либо процесс уже мёртв — обе ветки законны.
    }
  }
}

// --- подставной tmux ------------------------------------------------------------------

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/**
 * Подставной `tmux`. Разбирает ровно те подкоманды, которыми механизм разговаривает с
 * persist-сессией; всё прочее — отказ ненулевым кодом, потому что молчаливый успех на
 * незнакомой команде спрятал бы расхождение с настоящим бинарём.
 */
export async function tmuxMain(argv, env = process.env) {
  const home = env[CURSOR_HOME_VAR];
  if (!home) {
    process.stderr.write(`подставной tmux: ${CURSOR_HOME_VAR} не задан — дома стенда нет\n`);
    process.exitCode = 1;
    return;
  }
  // Версию печатает ТОЛЬКО `-V`, и это не придирка стенда: живой tmux на `--version`
  // отвечает usage'ом и кодом 1 (замер 2026-09-03, 3.6b). Спроси механизм не тем флагом — и
  // версия «не определена», то есть гейт `minVersion` не срабатывает никогда; стенд обязан
  // краснеть на этом, а не подыгрывать.
  if (argv[0] === '-V') {
    process.stdout.write(`${TMUX_VERSION}\n`);
    return;
  }
  // Глобальные флаги: `-L <сервер>` разбираем, `-u` и `-f <файл>` глотаем — на поведение
  // стенда они не влияют, а в argv механизма стоят всегда.
  const rest = [];
  let server = 'default';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '-L') { server = argv[i + 1]; i += 1; continue; }
    if (argv[i] === '-f') { i += 1; continue; }
    if (argv[i] === '-u') continue;
    rest.push(...argv.slice(i));
    break;
  }
  const cmd = rest[0];
  const args = rest.slice(1);
  if (cmd === 'new-session') return tmuxNewSession(home, server, args, env);
  if (cmd === 'list-sessions') return tmuxList(home, server, args);
  if (cmd === 'set-option') return tmuxSetOption(home, server, args);
  if (cmd === 'kill-session') return tmuxKillSession(home, server, args);
  if (cmd === 'capture-pane') return tmuxCapture(home, server, args);
  if (cmd === 'load-buffer') return tmuxLoadBuffer(home, args);
  if (cmd === 'paste-buffer') return tmuxPasteBuffer(home, server, args);
  if (cmd === 'send-keys') return tmuxSendKeys(home, server, args);
  process.stderr.write(`подставной tmux: подкоманда «${cmd ?? ''}» не поддержана\n`);
  process.exitCode = 1;
  return undefined;
}

function tmuxNewSession(home, server, args, env) {
  const name = argValue(args, '-s') ?? `unnamed-${process.pid}`;
  const cwd = argValue(args, '-c') ?? process.cwd();
  // Команда панели — всё, что осталось после флагов: механизм зовёт `... -c <cwd> sh <скрипт>`.
  const flags = new Set(['-s', '-c', '-x', '-y']);
  const command = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-d') continue;
    if (flags.has(args[i])) { i += 1; continue; }
    command.push(...args.slice(i));
    break;
  }
  if (!command.length) {
    process.stderr.write('подставной tmux: new-session без команды панели\n');
    process.exitCode = 1;
    return;
  }
  // `TMUX` в окружении панели — ровно то, ради чего механизм зовёт `env -u TMUX`: живой
  // `persist` внутри чужой tmux-сессии МОЛЧА не персистит (REPORT §4.2). Сними `-u TMUX` из
  // скрипта подъёма — и сессия не появится, как не появлялась живьём.
  const child = spawn(command[0], command.slice(1), {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: { ...env, TMUX: `${serverDir(home, server)}/socket,${process.pid},0`, TMUX_PANE: '%0' },
  });
  child.unref();
  writeSess(home, server, {
    name,
    server,
    created: Math.floor(Date.now() / 1000),
    attached: 0,
    panePid: child.pid ?? null,
    cwd,
    options: {},
    pending: '',
    pastedAt: 0,
    busy: false,
  });
}

// Разворот формата `#{...}`: те же поля, что отдаёт живой tmux механизму.
function renderFormat(fmt, sess) {
  return String(fmt).replace(/#\{([^}]+)\}/g, (_, key) => {
    if (key.startsWith('@')) return String(sess.options?.[key] ?? '');
    if (key === 'session_name') return sess.name;
    if (key === 'session_attached') return String(sess.attached ?? 0);
    if (key === 'session_created') return String(sess.created ?? 0);
    if (key === 'pane_pid') return String(sess.panePid ?? '');
    if (key === 'session_path') return String(sess.cwd ?? '');
    return '';
  });
}

function tmuxList(home, server, args) {
  const sessions = listSess(home, server).filter((s) => pidAlive(s.panePid));
  if (!sessions.length) {
    process.stderr.write(`no server running on ${serverDir(home, server)}/socket\n`);
    process.exitCode = 1;
    return;
  }
  const fmt = argValue(args, '-F') ?? '#{session_name}';
  process.stdout.write(`${sessions.map((s) => renderFormat(fmt, s)).join('\n')}\n`);
}

function tmuxSetOption(home, server, args) {
  const name = argValue(args, '-t');
  const tail = args.slice(args.indexOf('-t') + 2);
  const sess = readSess(home, server, name);
  if (!sess) {
    process.stderr.write(`подставной tmux: сессии ${name} нет\n`);
    process.exitCode = 1;
    return;
  }
  sess.options = { ...sess.options, [tail[0]]: tail.slice(1).join(' ') };
  writeSess(home, server, sess);
}

function tmuxKillSession(home, server, args) {
  const name = argValue(args, '-t');
  const sess = readSess(home, server, name);
  if (!sess) {
    process.stderr.write(`подставной tmux: сессии ${name} нет\n`);
    process.exitCode = 1;
    return;
  }
  killTree(sess.panePid);
  dropSess(home, server, name);
}

/**
 * Что видно в панели. Две строки, и обе — подписи, на которых стоит протокол ввода driver'а:
 * поле ввода (приглашение либо текст в нём) и признак идущего хода.
 */
function tmuxCapture(home, server, args) {
  const name = argValue(args, '-t');
  const sess = readSess(home, server, name);
  if (!sess) {
    process.stderr.write(`подставной tmux: сессии ${name} нет\n`);
    process.exitCode = 1;
    return;
  }
  // Подпись идущего хода стоит на ТОЙ ЖЕ строке, что и поле ввода, — так её рисует живой TUI
  // (замер 2026-09-03: `→ Add a follow-up …пробелы… ctrl+c to stop`). Не повтори стенд этого
  // — и driver, читающий поле ввода занятым на каждом идущем ходе, прошёл бы набор зелёным:
  // ровно так первый живой прогон под persist и дал три отказа доставки из трёх.
  const input = sess.pending ? sess.pending.split('\n')[0] : 'Add a follow-up';
  const lines = [
    '  Cursor Agent (стенд)',
    `  → ${input}${sess.busy ? `${' '.repeat(20)}ctrl+c to stop` : ''}`,
    '  Cursor Model · 1.0%',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function bufferPath(home, name) {
  return path.join(home, 'tmux', 'buffers', String(name).replace(/[^A-Za-z0-9._-]+/g, '-'));
}

function tmuxLoadBuffer(home, args) {
  const buf = argValue(args, '-b') ?? 'default';
  const file = args[args.length - 1];
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    process.stderr.write(`подставной tmux: буфер не прочитан (${e.message})\n`);
    process.exitCode = 1;
    return;
  }
  mkdirSync(path.dirname(bufferPath(home, buf)), { recursive: true });
  writeFileSync(bufferPath(home, buf), text);
}

/**
 * Вставка буфера в поле ввода. `-p` (bracketed paste) кладёт многострочный текст ОДНИМ
 * сообщением — построчный ввод разослал бы его несколькими; `-d` снимает буфер.
 */
function tmuxPasteBuffer(home, server, args) {
  const buf = argValue(args, '-b') ?? 'default';
  const name = argValue(args, '-t');
  const sess = readSess(home, server, name);
  if (!sess) {
    process.stderr.write(`подставной tmux: сессии ${name} нет\n`);
    process.exitCode = 1;
    return;
  }
  let text = '';
  try {
    text = readFileSync(bufferPath(home, buf), 'utf8');
  } catch {
    process.stderr.write(`подставной tmux: буфера ${buf} нет\n`);
    process.exitCode = 1;
    return;
  }
  if (args.includes('-d')) rmSync(bufferPath(home, buf), { force: true });
  sess.pending = `${sess.pending}${text}`;
  sess.pastedAt = Date.now();
  writeSess(home, server, sess);
}

/**
 * Клавиши в панель. Две формы, обе живые: `Enter` отправляет поле ввода, `C-u` его чистит.
 *
 * **Enter теряется, если он пришёл сразу за вставкой** — это и есть тот живой промах, ради
 * которого у driver'а стоит пауза (REPORT §4.3): текст остаётся в поле и уезжает вместе со
 * следующим сообщением одной склейкой.
 */
function tmuxSendKeys(home, server, args) {
  const name = argValue(args, '-t');
  const sess = readSess(home, server, name);
  if (!sess) {
    process.stderr.write(`подставной tmux: сессии ${name} нет\n`);
    process.exitCode = 1;
    return;
  }
  const keys = args.slice(args.indexOf('-t') + 2);
  if (keys.includes('C-u')) {
    sess.pending = '';
    writeSess(home, server, sess);
    return;
  }
  if (!keys.includes('Enter')) {
    // `send-keys -l <текст>` стенд принимает, но в поле ввода кладёт как есть: driver им не
    // пользуется, а молчаливый отказ спрятал бы его появление.
    const i = keys.indexOf('-l');
    if (i >= 0) {
      sess.pending = `${sess.pending}${keys.slice(i + 1).join(' ')}`;
      sess.pastedAt = Date.now();
      writeSess(home, server, sess);
    }
    return;
  }
  if (Date.now() - Number(sess.pastedAt || 0) < STUB_ENTER_MIN_MS) {
    // Enter потерян. Поле ввода остаётся с текстом — ровно как в живом случае `LAT-8`/`LAT-9`.
    return;
  }
  if (!sess.pending) return;
  const file = queueFile(home, sess.name);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ text: sess.pending, at: Date.now() })}\n`);
  sess.pending = '';
  writeSess(home, server, sess);
}

// --- подставной agent ------------------------------------------------------------------

function note(home, address, entry) {
  if (!address) return;
  try {
    mkdirSync(path.dirname(traceFile(home, address)), { recursive: true });
    appendFileSync(traceFile(home, address), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // След — диагностика теста, и отказ записи не повод ронять стенд.
  }
}

/**
 * Осиротевший `worker-server` — тот самый, что живой `agent` оставляет и после ШТАТНОГО
 * конца хода (REPORT §4.8). Отвязан намеренно: дерево процессов панели его не накрывает, и
 * добрать его можно только по метке в окружении — ровно то, что и проверяет проба.
 *
 * Живёт минуту и умирает сам: упавший прогон не имеет права оставить за собой процесс.
 */
function spawnWorkerServer(home) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000); // worker-server'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, AGENT_CLI_SOCKET_PATH: path.join(home, 'worker.soc') },
  });
  child.unref();
  return child.pid ?? null;
}

/**
 * Ребёнок инструмента: процесс, который ход запустил и который переживает `persist stop`
 * (REPORT §4.8). Не отвязан — он потомок панели, и добирается деревом от её pid'а, а не
 * меткой: окружение потомку собирает инструмент, а не бинарь.
 */
function spawnToolChild() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000); // tool child'], {
    stdio: 'ignore',
  });
  child.unref();
  return child.pid ?? null;
}

/**
 * Подставной `agent`. Разбирает ровно то, что зовёт механизм: `--version`, `mcp enable
 * <имя>` и подкоманду `persist` во всех четырёх формах. Всё прочее — отказ ненулевым кодом.
 */
export async function agentMain(argv, env = process.env) {
  const home = env[CURSOR_HOME_VAR];
  if (!home) {
    process.stderr.write(`подставной agent: ${CURSOR_HOME_VAR} не задан — дома стенда нет\n`);
    process.exitCode = 1;
    return;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(`${HARNESS_VERSION}\n`);
    return;
  }
  if (argv[0] === 'mcp' && argv[1] === 'enable') {
    const file = path.join(home, 'approvals', `${createHash('md5').update(process.cwd()).digest('hex')}.json`);
    const was = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    writeFileSync(file, `${JSON.stringify([...new Set([...was, argv[2]])], null, 2)}\n`);
    process.stdout.write(`enabled ${argv[2]}\n`);
    return;
  }
  if (argv[0] !== 'persist') {
    process.stderr.write(`подставной agent: подкоманда «${argv[0] ?? ''}» не поддержана\n`);
    process.exitCode = 1;
    return;
  }
  if (argv[1] === 'list') return persistList(home);
  if (argv[1] === 'stop') return persistStop(home, argv[2]);
  if (argv[1] === 'attach') {
    // Вход человека стенд не рисует: лента — это TUI, а проверяется здесь маршрут, а не
    // картинка. Успешный код и строка — то, что видит вошедший.
    process.stdout.write(`attached ${argv[2]}\n`);
    return undefined;
  }
  // Внутренняя форма: сама persist-сессия. Её поднимает отвязанным потомком клиент `persist`
  // ниже — так же, как живой: панель сессии живёт на СВОЁМ сервере и переживает клиента,
  // который её создал.
  if (argv[1] === '__session') return sessionMain(JSON.parse(Buffer.from(argv[2], 'base64').toString('utf8')), env);
  return persistUp(home, argv.slice(1), env);
}

const STUB_SERVER = 'cursor-agent';

function persistList(home) {
  const sessions = listSess(home, STUB_SERVER).filter((s) => pidAlive(s.panePid));
  if (!sessions.length) {
    process.stdout.write('No Cursor-managed persistent sessions.\n');
    return;
  }
  const body = sessions.map((s) => `Task: ${s.options?.['@promptobus_address'] ?? 'session'}\n`
    + `  Status: Detached (running in background)\n`
    + `  Session: ${s.name}\n`
    + `  Chat ID: ${s.options?.['@cursor_chat_id'] ?? '-'}\n`
    + `  Workspace: ${s.cwd}\n`
    + `  Attach: agent persist attach ${s.name}`).join('\n\n');
  process.stdout.write(`${sessions.length} persistent session${sessions.length > 1 ? 's' : ''}:\n\n${body}\n`);
}

/**
 * Гашение сессии. Панель умирает, запись сессии исчезает — а дети инструментов остаются
 * жить: живой `persist stop` их не трогает (REPORT §4.8), и добор их — работа механизма.
 */
function persistStop(home, name) {
  const sess = readSess(home, STUB_SERVER, name);
  if (!sess) {
    process.stderr.write(`Cursor-managed persistent session not found: ${name}\n`);
    process.exitCode = 1;
    return;
  }
  // Бьём ОДИН процесс панели, а не группу: группа накрыла бы и детей инструментов, то есть
  // стенд убирал бы за механизмом то, что механизм обязан убрать сам.
  try {
    process.kill(sess.panePid, 'SIGKILL');
  } catch {
    // Панель уже мертва — законный исход.
  }
  dropSess(home, STUB_SERVER, name);
  process.stdout.write(`Stopped persistent session: ${name}\n`);
}

/**
 * Хэш рабочего каталога — тот же, которым живой `persist` метит свою сессию (REPORT §2), и
 * считается он по РАЗРЕШЁННОМУ пути: живой Cursor хэширует то, во что путь разворачивается
 * (живой замер 2026-09-03, macOS `$TMPDIR` — симлинк). Не повтори стенд этого — и снятие
 * `realpathSync` у механизма оставило бы набор зелёным, хотя подъём из каталога за симлинком
 * перестал бы находить свою сессию.
 */
function workspaceHash(cwd) {
  let flat = String(cwd);
  try {
    flat = realpathSync(flat);
  } catch {
    // Каталога нет — хэшируем как есть: сессия тогда просто не найдётся.
  }
  return createHash('sha256').update(flat).digest('hex').slice(0, 10);
}

/** Имя сессии — той же формы, что у живого: `cursor-<слаг>-<хэш>-<n>-<rand6>`. */
function sessionName(cwd) {
  const slug = path.basename(cwd).replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
  return `cursor-${slug}-${workspaceHash(cwd)}-1-${randomUUID().slice(0, 6)}`;
}

/**
 * Клиент `agent persist`: он поднимает СЕССИЮ отвязанным процессом и уходит. Живой ведёт
 * себя так же — панель сессии живёт на сервере `cursor-agent` и переживает и клиента, и
 * панель-поставщик pty, из которой её позвали (REPORT §2).
 */
async function persistUp(home, argv, env) {
  if (argv.includes('--approve-mcps')) {
    process.stderr.write('подставной agent: --approve-mcps одобряет чужие серверы workspace — driver его не даёт\n');
    process.exitCode = 1;
    return;
  }
  const workspace = argValue(argv, '--workspace');
  if (!workspace) {
    process.stderr.write('подставной agent: persist без --workspace — стор чатов ключевался бы каталогом запуска\n');
    process.exitCode = 1;
    return;
  }
  const model = argValue(argv, '--model') ?? 'composer-2.5';
  const prompt = argv[argv.length - 1];
  const cfg = readBusConfig(workspace);
  const address = cfg?.env?.PROMPTOBUS_ROLE ?? null;
  const chatId = randomUUID();
  const name = sessionName(workspace);
  const plan = {
    home, workspace, chatId, model, name, address, prompt,
    userHome: env.PROMPTOBUS_CURSOR_USER_HOME ?? path.join(home, 'cursor'),
  };
  // **Ловушка `TMUX`** (REPORT §4.2): внутри чужой tmux-сессии `persist` МОЛЧА поднимает
  // обычный непостоянный `agent` — ни сессии, ни строки в списке, ни слова об этом. Стенд
  // повторяет это буквально: ход играется здесь же, а сессии не появляется вовсе.
  if (env.TMUX) {
    note(home, address, { kind: 'not-persistent', chatId, name });
    const transcript = transcriptFile(plan.userHome, workspace, chatId);
    mkdirSync(path.dirname(transcript), { recursive: true });
    await playTurn({ ...plan, transcript, text: prompt, persistent: false, env });
    return;
  }
  const child = spawn(process.execPath, [process.argv[1], 'persist', '__session',
    Buffer.from(JSON.stringify(plan)).toString('base64')], {
    cwd: workspace,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  writeSess(home, STUB_SERVER, {
    name,
    server: STUB_SERVER,
    created: Math.floor(Date.now() / 1000),
    attached: 0,
    panePid: child.pid ?? null,
    cwd: workspace,
    options: {
      '@cursor_managed': '1',
      '@cursor_workspace_hash': workspaceHash(workspace),
      '@cursor_session_version': '1',
      '@cursor_chat_id': chatId,
    },
    pending: '',
    pastedAt: 0,
    busy: true,
  });
  note(home, address, { kind: 'session-up', chatId, model, name, argv });
  process.stdout.write(`Started persistent session ${name}\n`);
}

/** Сама persist-сессия: первый ход по промпту подъёма, дальше — очередь сообщений. */
async function sessionMain(plan, env = process.env) {
  const {
    home, workspace, chatId, model, name, address, prompt, userHome,
  } = plan;
  const cfg = readBusConfig(workspace);
  const transcript = transcriptFile(userHome, workspace, chatId);
  mkdirSync(path.dirname(transcript), { recursive: true });
  const ctx = {
    home, address, cfg, chatId, workspace, transcript, model, name, env,
  };
  await playTurn({ ...ctx, text: prompt, persistent: true });
  await serveQueue(ctx);
}

/** Круг живой сессии: ждём сообщения в очереди и играем каждое отдельным ходом. */
async function serveQueue(ctx) {
  const file = queueFile(ctx.home, ctx.name);
  let played = 0;
  for (;;) {
    if (!readSess(ctx.home, STUB_SERVER, ctx.name)) return;
    let lines = [];
    try {
      lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch {
      lines = [];
    }
    if (lines.length > played) {
      const next = lines[played];
      played += 1;
      let text = '';
      try {
        text = JSON.parse(next).text;
      } catch {
        text = next;
      }
      await playTurn({ ...ctx, text, persistent: true });
      continue;
    }
    await new Promise((r) => { setTimeout(r, 100); });
  }
}

function setBusy(home, name, busy) {
  const sess = readSess(home, STUB_SERVER, name);
  if (!sess) return;
  sess.busy = busy;
  writeSess(home, STUB_SERVER, sess);
}

/** Ход: сообщение пользователя в стенограмму, действия по скрипту, `turn_ended` и хук. */
async function playTurn({
  home, address, cfg, chatId, workspace, transcript, model, text, name, persistent, env,
}) {
  if (persistent) setBusy(home, name, true);
  appendFileSync(transcript, `${JSON.stringify({
    role: 'user',
    message: { content: [{ type: 'text', text: `<user_query>\n${String(text).slice(0, 400)}\n</user_query>` }] },
  })}\n`);
  const turn = nextTurn(home, address);
  note(home, address, { kind: 'turn-start', turn, text: String(text).slice(0, 120) });
  // Рантайм панели (`worker-server`) жив и на чистом зависании — как `promptobus mcp`
  // у живой persist-сессии. Стоп тогда всё равно должен ставиться: фильтр его срезает.
  // Живой ребёнок инструмента (долгий гейт) — отдельный флаг.
  spawnWorkerServer(home);
  if (env[HANG_CHILD_VAR] || !env[HANG_VAR]) spawnToolChild();
  const outcome = await runScript({ home, address, cfg, turn, chatId, workspace, transcript, env });
  if (outcome === 'hang') {
    // Зависание: ход не кончается, стенограмма не растёт. Ровно та подпись, по которой
    // watchdog судит тишину, — и процесс при этом жив, как жив он и в живом зависании.
    note(home, address, { kind: 'hang' });
    await new Promise((r) => { setTimeout(r, 600_000); });
    return;
  }
  appendFileSync(transcript, `${JSON.stringify({
    role: 'assistant', message: { content: [{ type: 'text', text: `ход ${turn} сыгран (${outcome})` }] },
  })}\n`);
  appendFileSync(transcript, `${JSON.stringify({ type: 'turn_ended', status: outcome === 'error' ? 'error' : 'success' })}\n`);
  if (persistent) setBusy(home, name, false);
  note(home, address, { kind: 'turn-end', turn, outcome });
  fireStopHook(workspace, { chatId, model, outcome, transcript });
}

// Запись шины из проектного `.cursor/mcp.json` рабочего каталога — так участник и узнаёт
// себя: адрес, задачу и дом шины кладёт туда подъём.
function readBusConfig(workspace) {
  try {
    const cfg = JSON.parse(readFileSync(path.join(workspace, '.cursor', 'mcp.json'), 'utf8'));
    return cfg?.mcpServers?.promptobus ?? null;
  } catch {
    return null;
  }
}

function nextTurn(home, address) {
  const file = turnsFile(home, address ?? 'anon');
  let n = 0;
  try {
    n = Number(JSON.parse(readFileSync(file, 'utf8')).n) || 0;
  } catch {
    n = 0;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ n: n + 1 })}\n`);
  return n;
}

// Ход по скрипту: те же действия, что играет scripted-участник подставного `claude`
// ([participant.mjs](participant.mjs)).
async function runScript({ home, address, cfg, turn, workspace, env }) {
  if (env[HANG_VAR] || env[HANG_CHILD_VAR]) return 'hang';
  let script = { turns: [] };
  try {
    script = JSON.parse(readFileSync(scriptFile(home, address), 'utf8'));
  } catch {
    // Скрипта нет — ход молчаливый: законный сценарий, а не поломка стенда.
  }
  const plan = script.turns?.[turn] ?? null;
  if (!plan) return 'idle';
  if (plan.hang) return 'hang';
  // Ход, потраченный на вопрос: в сессии участника вопрос получает пропуск, а не ответ
  // (REPORT §4.15). Ход при этом кончается успешно — различает исходы только содержание.
  if (plan.askQuestion) return 'question';
  if (!cfg) {
    note(home, address, { kind: 'no-bus', workspace });
    return 'error';
  }
  const bus = await openBus(cfg);
  for (const action of plan.do ?? []) {
    await act({ home, address, bus, action, workspace });
  }
  await bus.close();
  return 'done';
}

// Настоящий `promptobus mcp` дочерним процессом и построчный JSON-RPC — тот же транспорт,
// каким с ним разговаривает живой Cursor.
async function openBus(cfg) {
  const child = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let seq = 0;
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const resolve = pending.get(msg.id);
        if (resolve) {
          pending.delete(msg.id);
          resolve(msg);
        }
      } catch {
        // Посторонняя строка в канале протокола — беда сервера, а не стенда.
      }
    }
  });
  const rpc = (method, params) => {
    const rid = (seq += 1);
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`нет ответа на ${method}`)), 30000);
      pending.set(rid, (m) => { clearTimeout(timer); resolve(m); });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: rid, method, params })}\n`);
    return answer;
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cursor-stub', version: '1' } });
  return { rpc, close: () => new Promise((r) => { child.on('close', r); child.stdin.end(); }) };
}

async function act({
  home, address, bus, action, workspace,
}) {
  if (action.wait) {
    await new Promise((r) => { setTimeout(r, action.wait); });
    note(home, address, { kind: 'wait', ms: action.wait });
    return;
  }
  if (action.write) {
    const file = path.join(workspace, action.write.path);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, action.write.text);
    note(home, address, { kind: 'write', path: action.write.path });
    return;
  }
  if (action.commit) {
    const r = spawnSync('git', ['-C', workspace, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid',
      'add', '-A'], { encoding: 'utf8' });
    const c = spawnSync('git', ['-C', workspace, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid',
      'commit', '-m', action.commit.message], { encoding: 'utf8' });
    note(home, address, { kind: 'commit', status: `${r.status}/${c.status}` });
    return;
  }
  if (action.tool) {
    let answer = null;
    try {
      answer = await bus.rpc('tools/call', { name: action.tool, arguments: action.args ?? {} });
    } catch (e) {
      note(home, address, { kind: 'action-failed', tool: action.tool, error: e.message });
      return;
    }
    const text = answer?.result?.content?.map((c) => c.text).join('\n') ?? '';
    note(home, address, { kind: 'tool', tool: action.tool, isError: !!answer?.result?.isError, text: text.slice(0, 400) });
    return;
  }
  note(home, address, { kind: 'unknown-action', action });
}

/**
 * Хук `stop` из ПРОЕКТНОГО `.cursor/hooks.json`: под persist стреляет он, а `sessionEnd` не
 * стреляет вовсе (REPORT §4.4). Нагрузка та же — `session_id` (он же `chatId`), `status`,
 * `loop_count`, `cursor_version`, `transcript_path`.
 *
 * **Неизвестное имя события убивает весь файл.** Живой бинарь в этом случае не стреляет ни
 * одним хуком, включая правильно названные, и молчит об этом (REPORT §4.4). Стенд повторяет
 * это буквально: driver, дописавший событие с опечаткой, теряет сторож цикла и канал
 * пробуждения разом — и прогон краснеет там же.
 */
function fireStopHook(workspace, { chatId, model, outcome, transcript }) {
  let hooks = null;
  try {
    hooks = JSON.parse(readFileSync(path.join(workspace, '.cursor', 'hooks.json'), 'utf8'));
  } catch {
    return;
  }
  const names = Object.keys(hooks?.hooks ?? {});
  if (!names.length || names.some((n) => !KNOWN_HOOK_EVENTS.includes(n))) return;
  const command = hooks?.hooks?.stop?.[0]?.command ?? null;
  if (!command) return;
  const payload = {
    conversation_id: chatId,
    generation_id: chatId,
    model,
    status: outcome === 'error' ? 'error' : 'completed',
    loop_count: 0,
    input_tokens: 57240,
    output_tokens: 184,
    session_id: chatId,
    hook_event_name: 'stop',
    cursor_version: HARNESS_VERSION,
    workspace_roots: [workspace],
    transcript_path: transcript,
  };
  // `shell: true` — в файле хуков лежит СТРОКА команды, и разбирает её шелл: так её
  // исполняет настоящий бинарь, и кавычки вокруг путей ставятся ради него.
  spawnSync(command, {
    cwd: workspace, env: process.env, shell: true, input: JSON.stringify(payload), encoding: 'utf8',
  });
}
