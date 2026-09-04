// Подставной harness E2E: `claude`, у которого сессии — настоящие процессы. Не
// `*.test.mjs` — раннер (run.mjs) берёт из каталога только их, и этот файл в прогон не
// попадает.
//
// Чем он отличается от подставного бинаря соседних файлов ([sandbox.mjs](sandbox.mjs)).
// Тот печатает заготовленный ответ и выходит: сессии там нет вовсе, и круг «notification →
// mailbox → ответ» на нём не собирается. Здесь `--bg` поднимает ОТДЕЛЬНЫЙ процесс
// scripted-участника ([participant.mjs](participant.mjs)), `agents --json` печатает свой
// реестр этих процессов, а `stop <id>` их гасит. Всё остальное в круге настоящее: driver
// `claude` из `lib/`, надзиратель, MCP-сервер шины, store задачи.
//
// **Подмена стоит на границе бинаря, а не driver'а.** Driver — предмет проверки: если
// подменить его, E2E перестанет проверять `activate`, `inspect` и `stop`, ради которых он и
// заведён. Поэтому подменяется ровно то, что и в жизни лежит за границей механизма, —
// внешняя команда `claude`.
//
// Реестр — КАТАЛОГ файлов, по файлу на сессию, а не один JSON. Писателей у него трое:
// `--bg` заводит запись, сам участник правит свою занятость на каждом ходе, `stop` её
// сносит. Общий файл потребовал бы лока между тремя процессами; отдельные файлы разводят
// писателей по разным именам, и лока не нужно вовсе.
import {
  existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));

/** Дом harness'а в окружении: его читают и подставной бинарь, и участник. */
export const HARNESS_HOME_VAR = 'PROMPTOBUS_E2E_HARNESS';
/** Шаблон пути сокета сессии — с `@` вместо имени. Почему шаблон, а не каталог, — ниже. */
export const SOCK_BASE_VAR = 'PROMPTOBUS_E2E_SOCK';

// Версия, которой отвечает подставной бинарь, — не литерал, а та же константа, на которой
// стоит весь разбор: форма провода и формат `agents --json` сняты с неё. Своя копия числа
// разъехалась бы с `contract.js` молча, и стенд притворялся бы сборкой, которой уже нет.
// Имя у стенда своё: снаружи это «версия harness'а», и зовут её ниже под ним же.
import { PROVEN_CLAUDE_VERSION } from '../lib/driver-claude.js';

export const HARNESS_VERSION = PROVEN_CLAUDE_VERSION;

// Ключ файла по адресу участника: двоеточие в имени файла законно не везде, а адрес —
// единственное, чем тест и участник опознают друг друга. Одна функция на обоих, поэтому
// участник импортирует её отсюда, а не повторяет правило у себя.
export function addrKey(address) {
  return String(address).replace(/[^A-Za-z0-9._-]+/g, '-');
}

export function sessionsDir(home) {
  return path.join(home, 'sessions');
}

export function sessionFile(home, id) {
  return path.join(sessionsDir(home), `${id}.json`);
}

/** Скрипт хода участника: его пишет тест, читает участник. */
export function scriptFile(home, address) {
  return path.join(home, 'scripts', `${addrKey(address)}.json`);
}

/** След того, что участник делал и что ему ответила шина. По нему сверяет тест. */
export function traceFile(home, address) {
  return path.join(home, 'trace', `${addrKey(address)}.jsonl`);
}

/** Каталог конфигурации, который подставной harness выдаёт за `~/.claude`. */
export function claudeConfigDir(home) {
  return path.join(home, 'claude-config');
}

export function logFile(home, id) {
  return path.join(home, 'logs', `${id}.log`);
}

export function readSession(home, id) {
  try {
    return JSON.parse(readFileSync(sessionFile(home, id), 'utf8'));
  } catch {
    return null;
  }
}

export function writeSession(home, record) {
  mkdirSync(sessionsDir(home), { recursive: true });
  writeFileSync(sessionFile(home, record.id), JSON.stringify(record, null, 2) + '\n');
  return record;
}

/** Реестр целиком — то же, что печатает `agents --json`. */
export function listSessions(home) {
  let names;
  try {
    names = readdirSync(sessionsDir(home)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map((n) => readSession(home, n.slice(0, -'.json'.length))).filter(Boolean)
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

/** Записи участника по имени сессии — тем же полем, каким его ищет `findSession`. */
export function sessionByName(home, name) {
  return listSessions(home).find((s) => s.name === name) ?? null;
}

/** След участника: по строке на действие. Пусто — участник не сделал ничего. */
export function readTrace(home, address) {
  try {
    return readFileSync(traceFile(home, address), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  } catch {
    return [];
  }
}

// Ошибки СЦЕНАРИЯ участника, а не механизма: незнакомое действие скрипта, упавшее действие,
// упавший ход. Участник на них не останавливается — живая сессия на незнакомый инструмент не
// падает, и стенд её в этом повторяет, — поэтому E2E краснеет шагами позже, а причина лежит в
// начале следа. Живой случай: старые `{ tool: 'send' }` в сценарии после
// переименования инструментов — участник писал `unknown-action` и шёл дальше, красным
// был восьмой шаг, диагноз добывался чтением следа целиком.
const AUTHOR_ERROR_KINDS = new Set(['unknown-action', 'action-failed', 'turn-failed']);
export function authorErrors(trace) {
  return trace.filter((e) => AUTHOR_ERROR_KINDS.has(e?.kind));
}

/** Диагноз по следу участника для красного вердикта: ошибки сценария первыми, потом хвост следа. */
export function diagnoseTrace(home, address, tail = 6) {
  const trace = readTrace(home, address);
  const errs = authorErrors(trace);
  const head = errs.length ? `ошибки сценария ${address} (причина обычно здесь): ${JSON.stringify(errs)} · ` : '';
  return `${head}след ${address}: ${JSON.stringify(trace.slice(-tail))}`;
}

/** Хвост лога участника — его печатает тест на красном вердикте, иначе диагноза нет. */
export function readLog(home, id, lines = 40) {
  try {
    return readFileSync(logFile(home, id), 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/** Жив ли процесс сессии. Судим сигналом 0 — тем же, чем судит о живости весь механизм. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// --- установка ------------------------------------------------------------------

/**
 * Разложить harness и поставить его `claude` первым в PATH. `sock` — строитель пути сокета
 * из [sandbox.mjs](sandbox.mjs) (`makeSockPath`): полный путь unix-сокета ограничен
 * примерно 104 байтами, а песочница файла набора живёт в каталоге прогона и одна съедает
 * под семьдесят пять символов. Подставному бинарю уезжает ШАБЛОН (`@` вместо имени), а не
 * каталог: на Windows сокет — именованный канал, каталога у него нет вовсе, и шаблон
 * остаётся единственной формой, годной обеим платформам.
 *
 * **Дом harness'а заводит он сам и ВНЕ песочницы файла** (замечание ревью). Лежи он внутри,
 * уборка на выходе была бы холостой: хук песочницы ([sandbox.mjs](sandbox.mjs)) регистрируется
 * раньше — её заводят до установки стенда, — и на `process.exit` каталог сносится первым,
 * а `clean()` читает пустой реестр и не гасит никого. Свой `mkdtemp` в `os.tmpdir()` кладёт
 * дом СОСЕДОМ песочницы: под раннером это каталог прогона (его убирает раннер), в одиночном
 * запуске — системный tmp, и оттуда его убирает тот же хук, что гасит сессии.
 *
 * Возвращает дом и функцию возврата PATH: PATH один на процесс теста, и оставленный
 * подменённым утекает в соседние ветки того же файла.
 */
export async function installHarness({ binDir, sock, env = process.env }) {
  const { stubCommand, withStubPath } = await import('./sandbox.mjs');
  const home = mkdtempSync(path.join(os.tmpdir(), 'promptobus-harness-'));
  armCleanup(home);
  for (const dir of ['sessions', 'scripts', 'trace', 'logs']) {
    mkdirSync(path.join(home, dir), { recursive: true });
  }
  mkdirSync(claudeConfigDir(home), { recursive: true });
  // Тело бинаря — вызов `claudeMain` этого же модуля. Своей копией сценария оно быть не
  // может: реестр, форма записи и раскладка каталогов нужны и тесту, и бинарю, а разъехаться
  // им негде только пока дом у них один.
  stubCommand(binDir, 'claude', `import { claudeMain } from ${JSON.stringify(path.join(here, 'harness.mjs'))};\n`
    + 'await claudeMain(process.argv.slice(2));\n');
  const restore = withStubPath(binDir);
  env[HARNESS_HOME_VAR] = home;
  env[SOCK_BASE_VAR] = sock('@');
  // Дом конфигурации harness'а: отсюда driver читает `jobs/<id>/state.json`, то есть
  // причину стопа. Без подмены он смотрел бы в настоящий `~/.claude` человека.
  env.CLAUDE_CONFIG_DIR = claudeConfigDir(home);
  return {
    home,
    restore: () => {
      restore();
      delete env[HARNESS_HOME_VAR];
      delete env[SOCK_BASE_VAR];
      delete env.CLAUDE_CONFIG_DIR;
    },
  };
}

/**
 * Скрипт хода scripted-участника. Форма — список ходов: ход `0` играется на подъёме
 * сессии (это первый ход по промпту), каждый следующий — на очередном стуке надзирателя.
 * Ходов больше, чем стуков, — лишние не играются; стуков больше, чем ходов, — участник
 * молчит, и это законный сценарий (доклад о молчаливом стопе на нём и проверяется).
 */
export function planParticipant(home, address, script) {
  mkdirSync(path.dirname(scriptFile(home, address)), { recursive: true });
  writeFileSync(scriptFile(home, address), JSON.stringify(script, null, 2) + '\n');
  return script;
}

// --- сам бинарь -----------------------------------------------------------------

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

// Короткий id записи выводится ИЗ uuid сессии, а не заводится отдельным. Замер
// 2026-09-03 на `claude` 2.1.251: у фоновой записи `id: "e8c5be23"` при
// `sessionId: "e8c5be23-dfef-4d20-bd96-e2a40a366b97"` — то есть ровно первые восемь hex того
// же uuid.
//
// Гейт владения адресом на этой связи НЕ стоит: основное правило — равенство полных id, и в
// E2E работает именно оно, потому что стенд кладёт в запись `sessionId`. Пара держится здесь
// ради ЗАПАСНОГО правила (`sameSession`), по которому читаются записи без полного id —
// прежнего релиза и подъёмов с неразобранным списком сессий. Разведи два написания здесь — и
// стенд проверял бы запасное правило на модели, которой нет.
function shortId(sessionId) {
  return sessionId.slice(0, 8);
}

/**
 * Идентичность шины, которую подставной демон выдаёт КАЖДОЙ своей фоновой сессии. Она
 * заведомо чужая — и это её работа, а не подкрутка стенда: демон на машине поднят посторонним
 * процессом, и сессии достаётся ЕГО окружение. Демон, отдающий окружение того вызова, который
 * его сессию занял, не моделирует ничего — ровно эту неверную предпосылку и снял .
 */
export const DAEMON_IDENTITY = {
  PROMPTOBUS_ROLE: 'worker:demon',
  PROMPTOBUS_TASK: 'demon-t20260101-000000',
  PROMPTOBUS_HOME: '/nonexistent/demon/.promptobus',
};

/**
 * Окружение фоновой сессии — то, что выдаёт ей ДЕМОН, а не то, с которым её позвали
 *. Замер 2026-09-03 (`ps eww`, `claude` 2.1.251): фоновые сессии берутся из
 * заранее заведённых `claude bg-spare` под `claude bg-pty-host … /tmp/cc-daemon-501/…`, и
 * окружение им достаётся от процесса, поднявшего демон, — у всех сессий run'а стояла одна
 * тройка `PROMPTOBUS_*`, включая сессию в другом рабочем месте.
 *
 * Стенд моделирует это в двух половинах, и обе нужны. Первая: окружение первого `--bg` за
 * прогон ложится файлом в дом harness'а и достаётся каждой следующей сессии — своими у неё
 * остаются лишь те переменные, которые харнес кладёт ей сам (идентичность сессии и её contact
 * point). Вторая: поверх ложится `DAEMON_IDENTITY` — тройка ЧУЖОГО процесса, поднявшего
 * демон. Без второй половины стенд был бы зелёным при любом порядке источников в стороже:
 * окружение сессии совпадало бы с тем, что и так знает подъём. Дом свой у каждого файла
 * набора, поэтому демон здесь тоже свой на файл.
 */
function daemonEnv(home, env) {
  const file = path.join(home, 'daemon-env.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    const first = { ...env, ...DAEMON_IDENTITY };
    mkdirSync(home, { recursive: true });
    // Права `0600`: в окружении разработчика ходят токены, и снимок его целиком — файл того
    // же класса, что mcp-конфиг участника (`writeSecret` в spawn.js). Дом harness'а живёт
    // один прогон, но читаемым для всей машины он быть не обязан ни секунды.
    writeFileSync(file, JSON.stringify(first, null, 2) + '\n', { mode: 0o600 });
    return first;
  }
}

// Гашение сессии. Бьём по ГРУППЕ процессов, а не по одному pid: участник поднимает своим
// дочерним процессом настоящий `promptobus mcp`, и снятый в одиночку родитель оставил бы его
// сиротой — а вердикт E2E говорит «после done процессов участников нет». Группа своя у
// каждой сессии, потому что участник поднят `detached`. Группы нет (Windows) — бьём по pid,
// и участник снимает своего ребёнка сам, по SIGTERM.
function killSession(record) {
  const pid = Number(record?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGTERM');
      return true;
    } catch {
      // Группы нет либо процесс уже мёртв — пробуем следующую форму.
    }
  }
  return false;
}

async function settle(ms) {
  await new Promise((r) => { setTimeout(r, ms); });
}

// Ждём смерти процесса, прежде чем снести запись: снос под живым участником дал бы ему
// переписать свой файл на конце хода, и `agents --json` показал бы погашенную сессию живой.
async function awaitDeath(pid, { tries = 40, delayMs = 25 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    if (!pidAlive(pid)) return true;
    await settle(delayMs);
  }
  return false;
}

/**
 * Насколько запись сессии переживает свою команду гашения.
 *
 * **Число замерено у живого harness'а**, а не выбрано: 2026-09-03, `claude` 2.1.251, три
 * прогона — `claude stop <id>` возвращается за 677, 801 и 898 мс, а запись исчезает из
 * `claude agents --json` через 1070, 1145 и 1218 мс от начала вызова, то есть спустя
 * 270–390 мс ПОСЛЕ возврата команды. Стенд, сносивший запись синхронно, был зелен на
 * гонке, которой у него не было вовсе: живой прогон E2E краснел на шагах 13–14, а
 * подставной шёл 51/51 стабильно.
 */
export const REAP_DELAY_MS = 300;

/**
 * Снос записи сессии ДЕМОНОМ, а не командой: отдельный отвязанный процесс дожидается
 * смерти участника, выдерживает задержку и убирает файл. Команда `stop` к этому моменту
 * давно вернулась — ровно так и ведёт себя живой harness.
 *
 * Отвязанным он обязан быть по той же причине, по которой отвязан надзиратель: процесс
 * подставного `claude` живёт доли секунды, и ребёнок, привязанный к нему, умер бы вместе с
 * ним, не дождавшись ничего.
 */
function reapSession(home, record) {
  const file = sessionFile(home, record.id);
  const code = 'const {rmSync}=require("node:fs");'
    + `const pid=${Number(record.pid)},file=${JSON.stringify(file)},delay=${REAP_DELAY_MS};`
    + 'const alive=()=>{try{process.kill(pid,0);return true}catch(e){return e.code==="EPERM"}};'
    + 'const wait=(ms)=>new Promise(r=>setTimeout(r,ms));'
    + '(async()=>{for(let i=0;i<400&&alive();i+=1)await wait(25);'
    + 'await wait(delay);rmSync(file,{force:true});})();';
  const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' });
  child.unref();
}

/**
 * Подставной `claude`. Разбирает ровно те подкоманды, которые зовёт механизм: `--version`
 * (резолв бинаря), `agents --json` (реестр сессий), `stop <id>` (гашение) и `--bg …`
 * (подъём участника). Всё прочее — отказ с ненулевым кодом: молчаливый успех на незнакомой
 * команде спрятал бы расхождение с настоящим бинарём.
 */
export async function claudeMain(argv, env = process.env) {
  const home = env[HARNESS_HOME_VAR];
  if (!home) {
    process.stderr.write(`подставной claude: ${HARNESS_HOME_VAR} не задан — дома harness'а нет\n`);
    process.exitCode = 1;
    return;
  }
  if (argv[0] === '--version') {
    process.stdout.write(`${HARNESS_VERSION} (Claude Code)\n`);
    return;
  }
  if (argv[0] === 'agents') {
    process.stdout.write(`${JSON.stringify(listSessions(home))}\n`);
    return;
  }
  if (argv[0] === 'stop') {
    const record = readSession(home, argv[1]);
    if (!record) {
      process.stderr.write(`job not found: ${argv[1]}\n`);
      process.exitCode = 1;
      return;
    }
    // Команда возвращается СРАЗУ, а запись сносит демон — асинхронно, после смерти
    // процесса (`reapSession`). Так ведёт себя живой `claude stop`, и стенд
    // обязан повторять его именно в этом: синхронный снос делал зелёной уборку, которая на
    // живом harness'е законно оставляла каталог worktree.
    killSession(record);
    reapSession(home, record);
    process.stdout.write(`stopped ${record.id}\n`);
    return;
  }
  if (!argv.includes('--bg')) {
    process.stderr.write(`подставной claude: подкоманда «${argv[0] ?? ''}» не поддержана\n`);
    process.exitCode = 1;
    return;
  }

  const name = argValue(argv, '--name');
  if (!name) {
    process.stderr.write('подставной claude: --bg без --name — сессию нечем назвать\n');
    process.exitCode = 1;
    return;
  }
  const sessionId = randomUUID();
  const id = shortId(sessionId);
  const socket = String(env[SOCK_BASE_VAR] ?? '').replace('@', id);
  const token = randomUUID();
  mkdirSync(path.join(home, 'logs'), { recursive: true });
  const fd = openSync(logFile(home, id), 'a');
  // Окружение сессии — ДЕМОНА, а не этого вызова (`daemonEnv` выше). Своим у
  // сессии остаётся ровно то, что настоящий Claude Code кладёт ей сам: идентичность сессии
  // и её contact point. Свой источник участник берёт из `--mcp-config`
  // ([13]), а его Stop-хук — из аргументов команды,
  // которую ему вписал в файл настроек подъём: окружению сессии тут верить нечему.
  const child = spawn(process.execPath, [path.join(here, 'participant.mjs'), ...argv], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', fd, fd],
    env: {
      ...daemonEnv(home, env),
      CLAUDE_CODE_SESSION_ID: sessionId,
      CLAUDE_CODE_MESSAGING_SOCKET: socket,
      CLAUDE_CODE_MESSAGING_TOKEN: token,
      PROMPTOBUS_E2E_SESSION: id,
    },
  });
  child.unref();
  // Форма записи снята с `claude agents --json` 2.1.251 (замер в
  // [12], «Граница покрытия тестами»): голый массив, поля
  // `pid, cwd, kind, startedAt, sessionId, name, id, status, state`. `id` и `state` есть
  // только у фоновых — интерактивных записей harness не заводит вовсе.
  writeSession(home, {
    pid: child.pid,
    cwd: process.cwd(),
    kind: 'background',
    startedAt: new Date().toISOString(),
    sessionId,
    name,
    id,
    status: 'busy',
    state: 'working',
  });
  // Формат вывода — наблюдённый у 2.1.221 («backgrounded · <id> · <имя>»): его разбирает
  // `parseSessionId`, и подъём обязан проверяться на той форме, которую механизм и читает.
  process.stdout.write(`backgrounded · ${id} · ${name}\n`);
}

// Уборка на выходе процесса — та же беда и то же лекарство, что у песочниц
// ([sandbox.mjs](sandbox.mjs)): парный `stopAll` в хвосте файла не выполняется ровно на том
// прогоне, где мусор и остаётся, — упавшая проверка уносит процесс через `process.exit` из
// `fail()`, а Ctrl+C не доходит и до этого. Цена промаха здесь выше, чем у каталога: за
// записью реестра стоит живой процесс участника, и он переживёт весь прогон. Живой след:
// оборванный на первой красной проверке юнит harness'а оставил участника работать до конца
// сессии разработчика.
//
// Хук синхронный и смерти не ждёт: у обработчика `exit` тактов событийного цикла нет вовсе,
// а сигнал процессу уходит сразу — большего от страховки и не нужно.
const armed = new Set();
let hooked = false;
// Настоящий выход снимается при загрузке модуля: файлы набора подменяют `process.exit`
// бросателем, и хук на сигнале звал бы подменённый.
const exit0 = process.exit;

function armCleanup(home) {
  armed.add(home);
  if (hooked) return;
  hooked = true;
  const clean = () => {
    for (const dir of armed) {
      for (const record of listSessions(dir)) killSession(record);
      // Дом сносится целиком: реестр, скрипты, следы и логи живут только на время файла, а
      // каталог заведён вне песочницы — своей уборки у него больше нет ниоткуда.
      rmSync(dir, { recursive: true, force: true });
    }
  };
  process.on('exit', clean);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { clean(); exit0.call(process, 130); });
  }
}

/** Погасить всё, что осталось: страховка теста в `finally`, а не часть сценария. */
export async function stopAll(home) {
  const left = [];
  for (const record of listSessions(home)) {
    killSession(record);
    if (!await awaitDeath(record.pid, { tries: 20 })) left.push(record.id);
    rmSync(sessionFile(home, record.id), { force: true });
  }
  return left;
}

/** Есть ли дом harness'а — им отличается разложенный стенд от несуществующего. */
export function harnessReady(home) {
  return existsSync(sessionsDir(home));
}

/**
 * Ждать условия до потолка. Возвращает ЗНАЧЕНИЕ последней пробы, а не бросает по таймауту:
 * вердикт о недождавшемся шаге обязан быть красным вердиктом, а не обрывом файла — иначе
 * проверки ниже не выполнятся вовсе, и число вердиктов у прогонов разойдётся.
 *
 * Потолок задаётся вызывающим: у подставного harness'а он секунды, у живого — минуты.
 */
export async function waitFor(probe, { timeoutMs, stepMs = 100 } = {}) {
  const edge = Date.now() + timeoutMs;
  let last = await probe();
  while (!last && Date.now() < edge) {
    await settle(stepMs);
    last = await probe();
  }
  return last;
}
