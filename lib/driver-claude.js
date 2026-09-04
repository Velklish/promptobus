import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { run } from './exec.js';
import { PROMPTOBUS_SERVER, KNOCK_TEXT_MAX } from './contract.js';
import { foreignSession, logWarden, writeWake } from './store.js';
import { previewBlock } from './notification.js';
import {
  bgSessions, findSession, liftoffParticipant, resetBgSessionsCache, sayLiftoff, sessionLiveness,
} from './liftoff.js';

// Driver harness'а Claude Code — первый production driver шины
// (ADR-032, §3 и §10; расширение контракта — ADR-034). Здесь собрано ВСЁ, что знает про
// Claude: реестр его bg-сессий, разбор их стопа, messaging-сокет с токеном, перевод
// harness-neutral контекста в argv бинаря, его файл настроек и конфиг MCP, допустимые
// значения его опций, версии, слова его команд и текст, который уезжает в чужую сессию.
//
// Граница проходит по этому файлу: машина состояний надзирателя (круги, пороги, health,
// эскалация, разбор «кого активировать») живёт в package и про Claude не знает ничего —
// она зовёт объявленные здесь операции через registry. Отсюда правило: имя `claude`,
// формат `claude agents --json`, флаги бинаря и слова про `claude attach` законны здесь и
// запрещены в `src/**` — это сторожит отдельный гейт
// ([promptobus-package.test.mjs](../../test/promptobus-package.test.mjs)).
//
// **Второе правило зеркально первому**: остальной механизм не импортирует этот
// файл вовсе — он ходит к driver'у через карту registry ([drivers.js](drivers.js)), и это
// сторожит гейт границы adapter'а ([promptobus-adapter.test.mjs](../../test/promptobus-adapter.test.mjs)).
// Второй driver кладётся в registry, не трогая ни одного файла за пределами `drivers.js` и
// своего `driver-<harness>.js`.
//
// Реестр самих сессий этажом ниже, в [liftoff.js](liftoff.js): он общий с подъёмом
// участника и был выделен раньше этой задачи.

/** Имя harness'а в записи участника и ключ в карте registry. */
export const CLAUDE = 'claude';

function versionLess(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

const CLAUDE_INSTALL = 'npm install -g @anthropic-ai/claude-code (или https://docs.claude.com/en/docs/claude-code/setup)';

function claudeUserMcp(canonServerNames) {
  const file = path.join(homedir(), '.claude.json');
  let names = [];
  if (existsSync(file)) {
    try {
      names = Object.keys(JSON.parse(readFileSync(file, 'utf8'))?.mcpServers ?? {}).sort();
    } catch {
      names = [];
    }
  }
  const canon = new Set(canonServerNames);
  const extras = [];
  const shadowed = [];
  for (const name of names) (canon.has(name) ? shadowed : extras).push(name);
  return { extras, shadowed };
}

// --- словарь harness'а: допустимые значения опций и версии ------------------------
//
// Дом этих значений здесь, а не в `contract.js`: уровни effort, режимы прав и
// имена запрещаемых инструментов — словарь ОДНОГО harness'а, и у второго driver'а он свой.
// В `contract.js` осталось только harness-neutral. Цитаты контракта в документации на них
// по-прежнему стоят: `lint` берёт значение из нового дома, ключи цитат не менялись
// ([reference/10](../../../docs/reference/10-validation.md)).

// Допустимые значения --effort — как у флага `claude --effort`
// (https://code.claude.com/docs/en/model-config#adjust-effort-level).
// `ultracode` тоже принимается флагом: xhigh-эффорт с динамической оркестрацией воркфлоу.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];

// Допустимые значения --permission-mode — как у флага `claude --permission-mode` (перечень
// `claude --help` 2.1.251). Worker'у по умолчанию идёт `auto`: `acceptEdits` снимает
// вопросы только с правок файлов, а рядовую Bash-команду спрашивает каждую — фоновый worker
// встал бы на первой же; `auto` же спрашивает человека на командах вне привычного класса
// (Docker-стенд, каталоги вне worktree, `rm -rf`), и track'у с таким стендом планку прав
// задаёт оркестратор флагом на один spawn.
export const PERMISSION_MODES = ['auto', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'manual', 'plan'];
export const DEFAULT_PERMISSION_MODE = 'auto';

// Модель участника без флага `--model`. Дом здесь, а не у команд подъёма: имя
// модели — словарь harness'а, и второй driver его не разделяет. Значение прежнее: дефолт
// сессии пользователя может быть дороже, поэтому механизм называет модель сам.
export const DEFAULT_MODEL = 'opus';

// Версия claude, начиная с которой `ultracode` доезжает до сессии. Источник: CHANGELOG
// Claude Code — отбрасывание `--effort ultracode` без слова починено в 2.1.210; на 2.1.169
// бинарь пишет предупреждение в stderr и поднимает сессию на дефолтном эффорте
// (замер 2026-08-28).
export const ULTRACODE_MIN_VERSION = '2.1.210';

// Инструменты, снятые у reviewer'а: он читает и пишет отчёт на шину, но не правит и не
// ходит наружу. Тем же списком поднимается headless-запуск (headless.js), а его зовёт
// только canary smoke: роль там другая, гарантия та же. Ужесточая запреты reviewer'у, ты
// меняешь условия канарейки — смотри smoke.js, прежде чем добавлять сюда имя.
export const REVIEWER_DENY = ['Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch'];

// Версия claude, на которой проверена доставка надзирателя инъекцией в messaging-сокет
// (ADR-028). Это НЕ минимальная версия и не гейт: поверхность инъекции
// недокументирована и едет с версией бинаря молча, а отказ инъекции не валит доставку
// остальным — участник просто узнает о сообщении, только когда сам позовёт `mailbox`
// (ADR-031). Число нужно другому: `promptobus status` и `doctor` называют, на чём канал
// мерили, чтобы разбор «почему участник не просыпается» начинался со сверки версий.
// Источник: спайк 2026-08-29, бинарь 2.1.251.
export const PROVEN_CLAUDE_VERSION = '2.1.251';

// Переменные предка, которые до участника доезжать не должны: `CLAUDE_PID` в дочернем
// процессе указывает на постороннюю сессию, `CLAUDE_EFFORT` протекает устаревшим
// значением.
//
// Снятие `CLAUDE_EFFORT` не меняет эффорт сессии — проверено живьём 2026-08-28 на
// `claude` 2.1.237 по полю `effort` в транскрипте (три прогона headless в чистом
// каталоге): `CLAUDE_EFFORT=max` без флага → xhigh; переменной нет, без флага → xhigh;
// `CLAUDE_EFFORT=max, --effort low` → low; на 2.1.237 дефолт без флага — xhigh. Набор не
// наш контракт: перепроверять при смене версии Claude Code.
export const SESSION_ENV_DROP = ['CLAUDE_PID', 'CLAUDE_EFFORT'];

/**
 * Слова harness'а, которые adapter вставляет в свои строки (ADR-034). Общий текст остаётся
 * у него, а команда — здесь: иначе `claude attach` знал бы каждый, кто печатает строку про
 * сессию, и второй harness пришлось бы разводить по всем этим местам.
 */
export const PHRASES = {
  sessions: 'claude agents',
  unreadable: 'claude agents --json не разобран',
  enter: (id) => `claude attach ${id}`,
  // Без идентификатора — голое имя команды: маршрут по исчезнувшей записи называет её
  // как ПРИЧИНУ («снять сессию мог человек: claude stop убирает запись целиком»), а не как
  // строку для копирования, и id там взять неоткуда.
  stop: (id) => (id ? `claude stop ${id}` : 'claude stop'),
  logs: (id) => `claude logs ${id}`,
  // Имя инструмента MCP так, как его зовёт сессия Claude Code. Клиент неймспейсит его сам
  // (`mcp__<сервер>__<имя>`), но короткого имени модели достаточно, и промпт участника
  // называет его именно так с самого первого релиза шины — форма проверена живой
  // перепиской. Второй harness пишет иначе, и потому это слово driver'а.
  tool: (_server, name) => name,
  // Своих правил в промпт участника Claude Code не дописывает: его повадки в фоновой
  // сессии описаны самим промптом и правилами рабочего места.
  promptRules: '',
};

// Сколько ждём сокет: вечное ожидание мёртвого сокета остановило бы доставку остальным.
export const KNOCK_TIMEOUT_MS = 3000;

// Имя отправителя в поле `from` инъекции: по нему получатель разбирает, кто вписал ход.
export const KNOCK_FROM = 'promptobus-warden';

// --- разбор состояния сессии --------------------------------------------------

// Каталог конфигурации claude — тот же, по которому живут `jobs/` и `daemon/`.
function claudeHome(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
}

// Причина уезжает в однострочный вывод. Формат `state.json` не контракт — в `detail`
// попадал целый абзац брифа, поэтому сводим к одной строке и режем по длине здесь.
const DETAIL_MAX = 160;

function oneLine(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat;
}

// Строка `detail` фоновой сессии по её короткому id (тому же, что принимают `claude
// attach` и `claude logs`). Ничего не бросает: чего угодно из этого нет — null.
export function sessionDetail(id, home = claudeHome()) {
  if (!id) return null;
  try {
    const raw = JSON.parse(readFileSync(path.join(home, 'jobs', String(id), 'state.json'), 'utf8'));
    return (typeof raw?.detail === 'string' ? oneLine(raw.detail) : '') || null;
  } catch {
    return null;
  }
}

// Исчерпанный лимит узнаётся по строке самого harness'а: свои причины сессия пишет
// своими словами, и ловить их шаблоном значит объявлять лимитом всё подряд.
const LIMIT_DETAIL = /\bhit your\b[^\n]*\blimit\b|\blimit\b[^\n]*\bresets\b/i;

// Стоп сессии: `null` — стопа нет, иначе `{ kind, reason }`. `kind` — `permission` (ждёт
// человека у диалога), `limit` (снимется сам) или `unknown` (маршрут не выводится).
// Причину список сессий несёт наполовину: `waitingFor` есть только у стоящей на диалоге, у
// лимита — ничего. Вторая половина — у демона фоновых сессий:
// `<конфиг claude>/jobs/<id>/state.json`, поле `detail`. Формат не контракт: не разобрано —
// причины нет, и выдумывать её нельзя.
//
// **Вход в разбор — КОНЕЦ ХОДА, а не состояние `blocked`**. До этой задачи вход
// стоял на `state === 'blocked'`, и на `claude` 2.1.251 в него не попадала ни одна
// закончившая ход сессия: замер живого прогона 2026-09-02 (шесть снимков `claude agents
// --json` с шагом 20 с) дал у обеих сессий `status: idle`, `state: done`, `waitingFor: null`,
// а по всем девяти записям машины у фоновых сессий встретились ровно две пары — `busy/working`
// и `idle/done`. То есть молчаливый участник был невидим целиком, и доклад не уходил
// никогда — поймал это живой прогон E2E, где вердикт о докладе краснел при исправном стенде.
//
// Поэтому `unknown` заводится на `status: idle` при ЛЮБОМ состоянии, а `busy`/`working`
// БЕЗ метки диалога стопом не считается вовсе: ход идёт. Метка диалога состояния не
// спрашивает и стоит выше гейта намеренно — сессия, упёршаяся в permission-запрос посреди
// хода, ждёт человека независимо от того, чем она занята. `blocked` остаётся входом наравне
// с `idle` — записи прежних сборок приходят с ним, и снимать его значило бы менять
// поведение там, где оно работало. Единственный фильтр `unknown` — гейт молчания
// `stallStands` в машине состояний: он и отделяет штатный конец хода от настоящего стопа.
export function sessionStall(session, detail = undefined) {
  if (!session) return null;
  // Метка диалога проверяется первой, и файл ради неё не читается: надзиратель опрашивает
  // состояние на каждом ударе сердца по каждому вставшему. Состояния она не спрашивает:
  // `waitingFor` выдаётся только стоящей у диалога, и другого смысла у поля нет.
  if (session.waitingFor) return { kind: 'permission', reason: oneLine(session.waitingFor) };
  const blocked = session.state === 'blocked';
  const idle = String(session.status ?? '').toLowerCase() === 'idle';
  if (!blocked && !idle) return null;
  const said = detail === undefined ? sessionDetail(session.id) : oneLine(detail ?? '') || null;
  if (said && LIMIT_DETAIL.test(said)) return { kind: 'limit', reason: said };
  // Причины нет — называем признак, по которому вошли в разбор, а не выдумываем состояние.
  return { kind: 'unknown', reason: said ?? (blocked ? 'blocked' : 'idle') };
}

// Что делать с этим стопом. Одна строка на всех потребителей: `promptobus status`, доклад
// надзирателя, ответ `mailbox`. Маршруты Claude-специфичны целиком — `claude attach`,
// `claude logs`, `claude stop`, — и потому живут у driver'а, а не в машине состояний.
// Сами команды берутся из `PHRASES` (замечание ревью): второй дом у той же строки означал
// бы, что маршрут и adapter советуют человеку разное, разойдясь на первой же правке.
export function stallRoute({ kind, address, repoAbs, task }, id, name) {
  // Reviewer'а и worker'а поднимают заново разными командами: `promptobus spawn` заводит адрес
  // `worker:`, а worktree у reviewer'а нет вовсе.
  const relift = () => (address?.startsWith('reviewer:')
    ? `поднимай reviewer'а заново: promptobus review "${repoAbs ?? '<путь клона>'}"${task ? ` --task ${task}` : ''}`
    : `поднимай worker'а заново тем же spawn'ом — он сядет в свой worktree и свою ветку`);
  if (kind === 'stale') {
    return `будить некого — процесса за записью нет. Убедись: ${PHRASES.logs(id)} (ответ «job not found» подтверждает), `
      + `и ${relift()}`;
  }
  // Записи нет вовсе: проверять нечем. Слова мягче, чем у `stale`, — исчезнуть сессия
  // могла и штатно (`claude stop` убирает запись целиком после сданной работы).
  if (kind === 'gone') {
    return `сессии в списке нет — будить некого. Снять её мог человек: ${PHRASES.stop(null)} убирает `
      + `запись целиком. Работа сдана — это штатный конец, делать нечего; не сдана — ${relift()}`;
  }
  // Contact point перехвачен: сессия жива и работает, глуха она только к notification'ам.
  // Человеку тут делать нечего — запись чинится сама, — но знать он обязан: до этого
  // момента адресат сообщений не видел.
  if (kind === 'wake-taken') {
    return 'сессия жива, глух только канал: contact point вернётся к ней на её же следующем '
      + `конце хода. До тех пор доставь сообщение сам — ${PHRASES.enter(id)}; если чужая сессия `
      + 'переписывает канал снова и снова, у неё старый релиз механизма — обнови рабочее место';
  }
  if (kind === 'permission') return `ответить может только человек: ${PHRASES.enter(id)} (или снять сессию: ${PHRASES.stop(id)})`;
  if (kind === 'limit') {
    return 'человек не нужен: лимит сбросится сам, а разбудить сессию можно сообщением в неё '
      + `(в Claude Code — SendMessage сессии «${name}»)`;
  }
  return `маршрут по этой причине не выводится — смотри ${PHRASES.logs(id)}: `
    + `дальше либо ответить сессии (${PHRASES.enter(id)}), либо разбудить её сообщением`;
}

// --- текст notification'а ------------------------------------------------------

// Рамка межсессионного сообщения — одна на оба notification. Оба её свойства проверены
// живым замером и потому уцелели при укорочении: опора на протокол шины, а не
// на авторитет человека (просьба «от пользователя» откладывалась получателем «до
// подтверждения»), и явный отказ от эскалации прав — текст, который об этом молчит,
// читается подозрительно. Разворачивать её обратно в абзац незачем: тело оборачивает сам
// Claude Code рамкой «Another Claude session sent a message» с предостережениями (около
// 650 знаков, не наша). Совсем снять её тоже нельзя — у driver'а без такой обёртки эта
// фраза остаётся единственной.
const NOT_A_HUMAN = 'Это notification, а не поручение человека, и прав оно не даёт.';

// Хвост приказа по mailbox'у: строка дела и рамка. Прежде здесь стояли два абзаца на
// каждый стук — около 430 знаков: порядок работы, который и так лежит в промпте участника
// и в скилле оркестрации, и своя копия предостережений Claude Code. Замер 2026-09-01
// (задача promptobus): 30 notification оркестратору на 17 чтений mailbox'а, то есть хвост
// уезжал тридцать раз.
const KNOCK_TAIL = 'Забери mailbox: прочитанными сообщения делает только mailbox, порядок работы — '
  + `в правилах шины. ${NOT_A_HUMAN}`;

// Тело инъекции. Самодостаточно: читается вне контекста, поэтому называет задачу, адрес
// и что делать. Блок выжимок и его бюджет — арифметика, общая на все harness'ы, и живёт
// она листом [notification.js](notification.js) (замечание ревью): у driver'а остаются
// рамка и слова его канала. Бюджет применяет тот, кто рендерит: у другого канала своя
// цена знака.
export function orderBody(task, addr, unread, msgs = []) {
  return `Служебный notification Promptobus. В mailbox'е адреса ${addr} задачи ${task} лежит непрочитанных: ${unread}.\n\n`
    + previewBlock(msgs, KNOCK_TEXT_MAX)
    + KNOCK_TAIL;
}

// Структурный notification машины состояний — в текст этого канала. Приказ по mailbox'у.
export function renderNotification(n) {
  return orderBody(n.task, n.address, n.unread, n.messages ?? []);
}

// --- messaging-сокет ------------------------------------------------------------

// Стук в messaging-сокет участника: одно соединение, две строки построчного JSON.
// Auth-строка шлётся всегда, хотя на macOS не проверяется (`authRequired` включается
// только на Windows): код без неё непереносим.
function dial(socketPath, lines, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    let sock;
    try {
      sock = connect(socketPath);
    } catch (e) {
      finish({ ok: false, error: e.code ?? e.message });
      return;
    }
    sock.setTimeout(timeoutMs);
    sock.on('error', (e) => {
      finish({ ok: false, error: e.code ?? e.message });
      sock.destroy();
    });
    sock.on('timeout', () => {
      finish({ ok: false, error: 'сокет не ответил' });
      sock.destroy();
    });
    sock.on('connect', () => {
      // `end` только ПОЛУзакрывает соединение: слушатель держит его до своих тридцати
      // секунд, а ответа протокол инъекции не предусматривает — отсюда `destroy` сразу.
      sock.end(`${lines.join('\n')}\n`, () => {
        finish({ ok: true });
        sock.destroy();
      });
    });
  });
}

function authLine(token) {
  return JSON.stringify({ type: 'auth', token: token ?? '' });
}

export function knockSocket(endpoint, body, { timeoutMs = KNOCK_TIMEOUT_MS } = {}) {
  return dial(endpoint.socket, [
    authLine(endpoint.token),
    JSON.stringify({
      msgV: 1,
      msg_id: randomUUID(),
      type: 'user',
      message: { role: 'user', content: body },
      priority: 'next',
      from: KNOCK_FROM,
    }),
  ], timeoutMs);
}

// Смок канала для `doctor`: соединение и одна auth-строка, без сообщения — файл сокета
// на месте, слушатель принимает. Соединение без второй строки слушателю безобидно.
export function probeWake(socketPath, token, { timeoutMs = KNOCK_TIMEOUT_MS } = {}) {
  return dial(socketPath, [authLine(token)], timeoutMs);
}

/**
 * Канал пробуждения ЭТОЙ сессии — вход диагностики. Где лежит адрес сокета и как
 * называется переменная, знает только harness, поэтому `doctor` спрашивает исход, а не
 * переменные: `endpoint: null` — сессия сокета не сдаёт вовсе, и причина названа словами
 * harness'а. Настоящего сообщения смок не шлёт: оно стоило бы записи в ленту человека,
 * который спросил про layout.
 */
export async function checkWake(env = process.env) {
  const socket = env.CLAUDE_CODE_MESSAGING_SOCKET?.trim();
  if (!socket) return { endpoint: null, ok: false, error: 'CLAUDE_CODE_MESSAGING_SOCKET пуст' };
  const r = await probeWake(socket, env.CLAUDE_CODE_MESSAGING_TOKEN);
  return { endpoint: socket, ok: !!r.ok, error: r.ok ? null : String(r.error ?? '') };
}

// Сдать свой contact point в store задачи. Зовут дочерние процессы шины самого
// участника — им Claude Code кладёт в окружение адрес сокета и токен сессии. Сдавать
// нечего (не Claude Code, прежний бинарь) — участник придёт за сообщением сам.
//
// **За чужой адрес запись не идёт**. Адрес закреплён за сессией в журнале, и
// сдать его вправе только она: чужая перепишет канал первого участника своим сокетом, и
// notification'ы пойдут не туда — за десять минут run'а 2026-09-03 так ушли одиннадцать.
// Гейт стоит здесь, а не у двух вызывающих: сдают contact point и сервер шины участника, и
// его Stop-хук, а разошедшиеся копии правила означали бы дыру в одной из них.
//
// **Сессия приходит АРГУМЕНТОМ, а не только из окружения** (замечание ревью). Процессу
// Stop-хука `CLAUDE_CODE_SESSION_ID` ничем не обещана — свою сессию он резолвит из нагрузки
// события ([15](../../../docs/reference/15-warden.md)), — и читай мы здесь одно окружение,
// на машине без переменной запись легла бы БЕЗ поля `session`. Клеймо владельца стиралось бы
// каждым концом хода, и второй рубеж переставал бы различать вовсе. Умолчание осталось
// окружением: сервер шины участника — дочерний процесс сессии, и у него переменная есть.
export function registerWake(home, task, addr, env = process.env, session = null) {
  try {
    const who = session ?? env.CLAUDE_CODE_SESSION_ID?.trim() ?? null;
    const held = foreignSession(home, task, addr, who);
    if (held) {
      sayForeignWrite(home, task, addr, held, who, `сдача contact point'а`);
      return null;
    }
    return writeWake(home, task, addr, {
      socket: env.CLAUDE_CODE_MESSAGING_SOCKET?.trim() || null,
      token: env.CLAUDE_CODE_MESSAGING_TOKEN?.trim() || null,
      session: who || null,
    });
  } catch {
    // Страховка не вправе уронить вызов инструмента шины.
    return null;
  }
}

// Отказ гейта обязан быть ВИДЕН (замечание ревью). Молчаливый `null` выглядит исправной
// работой: участник просто «не сдал сокет», надзиратель штатно откатывается на self-wake, и
// разъехавшиеся написания id сессии на следующей сборке harness'а остановили бы шину без
// единой строки. Пишем в журнал надзирателя — тот же файл, по которому человек разбирает
// «почему участник молчал»; `promptobus status` показывает ту же беду строкой будильника.
//
// **Дверей у гейта две, и говорят обе** (второй раунд ревью). Здесь — рукопожатие сервера
// шины; у сторожа цикла гейт стоит раньше `registerWake`, и молчи он там, самый частый вход
// в эту беду — чужой Stop-хук — остался бы невидимым вовсе. Поэтому функция общая и
// экспортируется; что именно не сделано, приходит словами вызывающего.
//
// Один раз на причину и на процесс: сервер шины участника живёт всю сессию и сдаёт contact
// point на каждом рукопожатии, а процесс хука короткий и напишет строку не чаще раза за ход.
const foreignWrites = new Set();

export function sayForeignWrite(home, task, addr, held, session, what) {
  const key = [home, task, addr, held, session, what].join('\u0000');
  if (foreignWrites.has(key)) return;
  foreignWrites.add(key);
  logWarden(home, task, `${what} за адрес ${addr} не идёт: адрес закреплён за сессией ${held}, `
    + `а пишет ${session} — записи владельца не тронуты`);
}

// --- перевод harness-neutral контекста в свой конфиг и argv ----------------------
//
// Наружу отсюда не торчит ничего: сборка конфига и argv — половины ОДНОЙ
// операции `prepare`, и вызывающий не собирает команду по частям. Он называет предмет
// («каталоги, которые участник вправе читать», «команда сторожа цикла»), а как это
// выглядит у бинаря, решает этот файл.

// MCP-конфиг участника: harness-neutral перечень серверов в форму, которую читает бинарь.
// Что за серверы — решает подъём (canonical-набор workspace плюс запись самой шины), а как
// они лежат в файле — этот driver.
function mcpConfig({ servers }) {
  return { mcpServers: { ...servers } };
}

// Пре-аппрув доставленных серверов: `--allowedTools mcp__<имя>` на каждое имя из
// конфига. Reviewer поднимается без `--permission-mode` и встал бы на permission-запросе
// первого не-шинного сервера. Шина первой, остальные по алфавиту — порядок стабилен.
function mcpAllowedTools(mcpCfg) {
  const names = Object.keys(mcpCfg.mcpServers ?? {});
  return [PROMPTOBUS_SERVER, ...names.filter((n) => n !== PROMPTOBUS_SERVER).sort()].map((n) => `mcp__${n}`);
}

// argv бинаря из контекста подъёма. `--mcp-config` и `--allowedTools` у claude
// вариадические: они съедают позиционные аргументы до следующей опции, и промпт после них
// ушёл бы в их список — сессия поднялась бы пустой. Поэтому промпт стоит только после
// невариадической опции и всегда последним.
function spawnArgv({
  ref, mcpConfigPath, mcpConfig: cfg, addDirs = [], pluginDir = null, settingsPath,
  model, effort = null, permissionMode = null, prompt,
}) {
  return [
    '--bg',
    '--name', ref,
    '--mcp-config', mcpConfigPath,
    '--allowedTools', ...mcpAllowedTools(cfg),
    ...(addDirs.length ? ['--add-dir', ...addDirs] : []),
    ...(pluginDir ? ['--plugin-dir', pluginDir] : []),
    '--settings', settingsPath,
    '--model', model,
    // --effort — только если задан явно: без флага сессия поднимается на дефолте бинаря.
    ...(effort ? ['--effort', effort] : []),
    ...(permissionMode ? ['--permission-mode', permissionMode] : []),
    prompt,
  ];
}

// Событие хука, на котором стоит сторож цикла. Имя события — контракт Claude Code, и дом
// у него один на две двери: layout рабочего места ([guardhook.js](../guardhook.js)) и файл
// настроек участника. Здесь оборачивается ГОТОВАЯ команда: собирает её adapter (там знают
// путь бинаря рабочего места), а в какую форму она ложится — знает harness.
const GUARD_HOOK_EVENT = 'Stop';

/**
 * Файл настроек участника: `enableAllProjectMcpServers` — иначе bg-сессия в репозитории с
 * `.mcp.json` встаёт на интерактивном диалоге выбора серверов, а отвечать в ней некому;
 * `viewMode: focus` — заглянувший человек получает сводку вместо простыни вызовов
 * инструментов. `permissions.deny` стоит ПЕРВЫМ ключом и только там, где инструменты сняты:
 * порядок ключей в файле не поведение, но и переставлять его без повода незачем.
 */
function settingsFile({ denyTools, guardCommand, extraSettings }) {
  return {
    ...(denyTools?.length ? { permissions: { deny: denyTools } } : {}),
    enableAllProjectMcpServers: true,
    viewMode: 'focus',
    hooks: { [GUARD_HOOK_EVENT]: [{ hooks: [{ type: 'command', command: guardCommand }] }] },
    ...extraSettings,
  };
}

/**
 * План подъёма из harness-neutral контекста (ADR-034). Ничего не пишет и не запускает:
 * `--dry-run` печатает ровно этот объект, а реальный подъём исполняет его же — расхождению
 * между печатью и делом взяться неоткуда.
 */
function prepare({
  ref, mcp, prompt, model, effort = null, permissionMode = null,
  addDirs = [], pluginDir = null, mcpConfigPath, settingsPath,
  guardCommand, denyTools = null, extraSettings = {},
}) {
  const cfg = mcpConfig(mcp);
  const settings = settingsFile({ denyTools, guardCommand, extraSettings });
  return {
    argv: spawnArgv({
      ref, mcpConfigPath, mcpConfig: cfg, addDirs, pluginDir, settingsPath,
      model, effort, permissionMode, prompt,
    }),
    mcpConfig: cfg,
    settings,
    // Порядок файлов — порядок записи. Конфиг несёт подставленные токены canonical-серверов
    // и потому помечен секретом: класть его правами `0600` — дело вызывающего, знать про
    // `chmod` harness'у незачем.
    files: [
      { path: mcpConfigPath, text: `${JSON.stringify(cfg, null, 2)}\n`, secret: true },
      { path: settingsPath, text: `${JSON.stringify(settings, null, 2)}\n`, secret: false },
    ],
  };
}

// Окружение поднимаемой сессии: поверх наследуемого снимаются переменные предка, которые
// протекают чужими значениями. Что кладёт сам механизм (рычаг хука памяти), приходит
// аргументом — это не свойство harness'а.
function sessionEnv(base = process.env, extra = {}) {
  const env = { ...base, ...extra };
  for (const name of SESSION_ENV_DROP) delete env[name];
  return env;
}

// Отказ точечный, а не подъём общей `minVersion`: платит только просивший `ultracode`.
// Версия не прочитана — не отказываем: утверждать «старее нужной» о том, чего не прочли,
// механизм не вправе (то же правило, что у `toolVersionCheck`).
function optionRefusal({ effort = null } = {}, tool) {
  if (effort !== 'ultracode') return null;
  if (!tool?.version || !versionLess(tool.version, ULTRACODE_MIN_VERSION)) return null;
  return `--effort ultracode: найден claude ${tool.version}, а это ключевое слово доезжает до сессии `
    + `с ${ULTRACODE_MIN_VERSION}. Бинарь ниже отбрасывает его предупреждением в stderr и поднимает сессию `
    + 'на ДЕФОЛТНОМ эффорте (замер 2026-08-28 на 2.1.169) — тихая деградация вместо запрошенного: '
    + 'журнал задачи и promptobus status при этом называют эффорт тем, который просили. '
    + `Обнови бинарь (${CLAUDE_INSTALL}) либо поднимай участника с --effort xhigh.`;
}

// Имена canonical-серверов, перекрытые личными записями пользователя. Личный конфиг —
// свойство harness'а: у второго driver'а он лежит в другом месте и в другом формате.
function shadowedUserServers(names) {
  return claudeUserMcp(names).shadowed;
}

// --- операции driver'а ----------------------------------------------------------

// Состояние одной сессии для снимка. Список берётся из памяти реестра: снимок собирается
// по всем участникам разом, и без неё каждый стоил бы запуска `claude agents --json`.
// Список не разобран — `null`: это неизвестность, а не смерть, и снимок гасится целиком.
//
// Вторым аргументом список можно передать явно — так набор строит снимок по подставному
// ответу harness'а, не трогая живого `claude`. Машина состояний зовёт с одним аргументом:
// про список она не знает вовсе.
function inspect(ref, sessions = undefined) {
  const list = sessions === undefined ? bgSessions() : sessions;
  if (list === null) return null;
  const hit = findSession(list, ref);
  // Записи нет вовсе: `claude stop` убирает её целиком, а сорвавшийся подъём не создаёт.
  // Слова об этом — свои: машина состояний про `claude agents` не знает и знать не должна.
  if (!hit) {
    return {
      state: 'gone',
      busy: false,
      stall: { kind: 'gone', reason: 'записи сессии в claude agents нет' },
      id: null,
      note: null,
    };
  }
  const live = sessionLiveness(hit, list);
  return {
    state: live === 'stale' ? 'stale' : 'alive',
    // Занятость — поле `status` записи: `busy` у думающей, `idle` у отдавшей ход.
    busy: String(hit.status ?? '').toLowerCase() === 'busy',
    // У пережившей свой демон записи тоже стоит `blocked`, но разбирать её стоп незачем:
    // будить там некого, и это отдельный исход со своими словами.
    stall: live === 'stale' ? { kind: 'stale', reason: 'запись пережила свой демон' } : sessionStall(hit),
    id: hit.id ?? null,
    note: hit.status ?? hit.state ?? 'running',
  };
}

// Подъём фоновой сессии по её плану. Запуск и сверка «сессия поднялась» — общий с ролью
// reviewer'а хелпер [liftoff.js](liftoff.js): построчные копии уже разъезжались на этой
// сверке. Argv берётся из плана, а не собирается заново: план и есть то, что исполняется.
async function spawn(plan, { tool, ref, role, cwd, env, launchFailNote, deadNote, persist, awaitOptions }) {
  return liftoffParticipant({
    tool, argv: plan.argv, cwd, env, name: ref, role, launchFailNote, deadNote, persist, awaitOptions,
  });
}

// Потолок ожидания смерти сессии и шаг опроса.
//
// **Числа замерены живым стопом**, а не выбраны: 2026-09-03, `claude` 2.1.251, три прогона
// подряд — `claude stop <id>` возвращается за 677, 801 и 898 мс, а запись исчезает из
// `claude agents --json` через 1070, 1145 и 1218 мс от начала вызова. То есть команда
// возвращается на 270–390 мс РАНЬШЕ, чем сессии не станет в реестре. Потолок в 10 с —
// восьмикратный запас к худшему из замеров: он не цена нормального стопа, а предел, за
// которым ждать перестаём и говорим об этом вслух.
//
// Шаг опроса меньше самого опроса: каждая проба — запуск `claude agents --json`, замеренный
// там же в 0,34–0,41 с, и шаг короче него процессов не прибавляет, а лишнего ожидания
// добавил бы. При потолке это порядка двадцати проб, и только на зависшем стопе.
const STOP_GONE_TIMEOUT_MS = 10_000;
const STOP_GONE_STEP_MS = 100;

// Ждём, пока записи сессии не станет в реестре. Исход тристейтом: `gone` — записи нет,
// `timeout` — потолок вышел, запись на месте, `unreadable` — реестр не разобран.
//
// Три, а не два (замечание ревью): на неразобранном реестре сказать «сессия закрыта» значит
// утверждать непроверенное — это ровно то, от чего механизм уходит правилом «неизвестность
// не смерть». Вызывающий переводит и `timeout`, и `unreadable` в один исход «гашение не
// подтверждено», но причины у них разные, и человеку они говорят разное.
//
// Список берётся свежим на каждой пробе: разобранный ответ помнится до сброса, и без
// `fresh` цикл читал бы один и тот же снимок до самого потолка.
async function awaitSessionGone(ref, { timeoutMs = STOP_GONE_TIMEOUT_MS, stepMs = STOP_GONE_STEP_MS } = {}) {
  const edge = Date.now() + timeoutMs;
  for (;;) {
    const list = bgSessions({ fresh: true });
    // Повторять на неразобранном ответе незачем: отказ разбора не кэшируется, и следующая
    // проба спросила бы тот же внешний процесс с тем же исходом до самого потолка.
    if (list === null) return 'unreadable';
    if (!findSession(list, ref)) return 'gone';
    if (Date.now() >= edge) return 'timeout';
    await new Promise((r) => { setTimeout(r, stepMs); });
  }
}

// Погасить фоновую сессию: `claude stop <id>`. Идентификатор берётся из реестра по ref —
// в журнале задачи лежит имя, а команда принимает короткий id.
//
// **Идемпотентно, и это не послабление**: гасит его `promptobus done` по всему списку
// участников, и запись сессии к тому моменту законно могла исчезнуть — человек снял её
// сам, подъём когда-то сорвался, демон умер. «Гасить нечего» — исход со своими словами, а
// не отказ: иначе уборка спотыкалась бы о штатный порядок вещей.
//
// **Возвращается операция после исчезновения записи, а не после возврата команды**
//. Живой `claude stop` отвечает раньше, чем сессии не станет в реестре, а следом
// за гашением идёт уборка каталогов: она спрашивает состояние сессии и на ещё живой записи
// законно оставляет worktree («уберётся при следующем promptobus done»). Живой прогон
// 2026-09-03 00:14 краснел ровно этим — четыре вердикта шагов 13–14 при зелёном гашении.
async function stop(ref, waitOptions = undefined) {
  const list = bgSessions();
  if (list === null) return { ok: true, stopped: false, note: `состояние сессии «${ref}» не разобрано — гасить наугад нечего` };
  const hit = findSession(list, ref);
  const id = hit?.id ?? null;
  if (!hit) return { ok: true, stopped: false, note: `сессии «${ref}» в списке нет` };
  // Что стоит за записью без идентификатора, отсюда не видно, и утверждать про её процесс
  // нечего (замечание ревью): сказано ровно то, что известно, — гасить нечем.
  if (!id) return { ok: true, stopped: false, note: `у записи «${ref}» нет идентификатора — гасить нечем` };
  const r = run('claude', ['stop', id], { encoding: 'utf8' });
  if (r.error) return { ok: false, stopped: false, note: `claude stop ${id}: ${r.error.message}` };
  if (r.status !== 0) {
    const said = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n')[0] ?? '';
    return { ok: false, stopped: false, note: `claude stop ${id} завершился с кодом ${r.status}${said ? `: ${said}` : ''}` };
  }
  // Список после `stop` меняется — без сброса следующий читатель увидел бы закрытую живой.
  resetBgSessionsCache();
  const seen = await awaitSessionGone(ref, waitOptions);
  if (seen !== 'gone') {
    // Гашение пошло, а подтвердить его нечем: сессия, возможно, ещё умирает, либо реестр
    // после команды не разобран. Объявлять её погашенной нельзя — уборка каталогов пойдёт
    // по этому исходу. `ok`, потому что команда отработала: не сработало ПОДТВЕРЖДЕНИЕ, а
    // не гашение, и `attempted` отличает этот исход от «сессии не было ещё до команды».
    return {
      ok: true,
      stopped: false,
      attempted: true,
      note: seen === 'unreadable'
        ? `claude stop ${id} отработал, реестр после него не разобран — гашение не подтверждено`
        : `claude stop ${id} отработал, но запись сессии не исчезла из claude agents за `
          + `${Math.round(STOP_GONE_TIMEOUT_MS / 1000)} с — гасить её harness ещё не закончил`,
    };
  }
  return { ok: true, stopped: true, note: `сессия ${id} закрыта` };
}

/**
 * Driver Claude Code. `attach` не объявлен: пользовательского подключения к чужой сессии у
 * CLI нет вовсе (ADR-032, §1 — оно вне первого этапа). Остальное объявлено и реализовано.
 *
 * Четыре capability сверх прежних пяти (ADR-034) объявляют СВОЙСТВА бинаря, а не операции:
 * `denyTools` — `permissions.deny` в файле настроек (на нём стоит read-only reviewer'а),
 * `systemPrompt` — сам файл `--settings`, `sessionList` — реестр `claude agents --json`,
 * `enter` — вход человека в сессию (`claude attach`). Все четыре у Claude Code есть.
 */
export const claudeDriver = {
  id: CLAUDE,
  capabilities: {
    spawn: true,
    attach: false,
    activation: 'push',
    inspect: true,
    stop: true,
    denyTools: true,
    systemPrompt: true,
    sessionList: true,
    enter: true,
  },
  options: {
    // Имя бинаря: им резолвится путь к нему и им же печатается команда `--dry-run`.
    tool: CLAUDE,
    effortLevels: EFFORT_LEVELS,
    // Минимальная версия бинаря по уровню effort: значение доезжает до сессии не с любой
    // сборки, и справка называет число, а не «новее какой-то».
    effortMinVersion: { ultracode: ULTRACODE_MIN_VERSION },
    permissionModes: PERMISSION_MODES,
    defaultPermissionMode: DEFAULT_PERMISSION_MODE,
    defaultModel: DEFAULT_MODEL,
    denyTools: REVIEWER_DENY,
    provenVersion: PROVEN_CLAUDE_VERSION,
    // Канал — messaging-сокет живой сессии: стук вписывает в неё ход.
    knockChannel: 'socket',
    envDrop: SESSION_ENV_DROP,
    // Каталог скиллов рабочего места Claude Code берёт флагом на один подъём.
    skillsDir: true,
  },
  phrases: PHRASES,
  // Перевод harness-neutral контекста в свой план подъёма — дело driver'а (ADR-032, §3),
  // но capability на это нет: без него не бывает `spawn`, и объявлять его отдельно значило
  // бы объявлять половину одной операции.
  prepare,
  spawn,
  saidLiftoff: sayLiftoff,
  inspect,
  forgetSessions: resetBgSessionsCache,
  stop,
  activate: (target, notification) => knockSocket(target.endpoint, renderNotification(notification)),
  renderNotification,
  stallRoute,
  registerWake,
  sayForeignWrite,
  checkWake,
  sessionEnv,
  optionRefusal,
  shadowedUserServers,
};
