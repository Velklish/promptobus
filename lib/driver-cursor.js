import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fail, info } from './util.js';
import { run } from './exec.js';
import { KNOCK_TEXT_MAX, PROMPTOBUS_SERVER } from './contract.js';
import { foreignSession, logWarden, writeWake } from './store.js';
import { previewBlock } from './notification.js';
import {
  CURSOR_TMUX_SERVER, dropSession, findSession, injectText, liftSession,
  mcpRuntimeNeedles, patchSession, readParticipantMcp, readSession, SESSION_ENV_VAR, sessionFile,
  silentIsStall, stopSession, toolKidsOf, turnIdleMs, turnState, writeSession,
} from './cursor-persist.js';

// Driver harness'а Cursor — второй production driver шины. Здесь собрано ВСЁ, что механизм
// знает про Cursor: форма его конфигов, флаги
// бинаря, словарь его опций, слова его команд и то, как у него устроена сессия. Реестр
// сессий и разговор с tmux — этажом ниже, в [cursor-persist.js](cursor-persist.js).
//
// **Что у Cursor устроено принципиально иначе, чем у Claude Code.** Сессия — живой
// интерактивный TUI в панели tmux, поднятый подкомандой `agent persist`: она
// переживает родителя, принимает вход человека (`agent persist attach`) и принимает текст
// механизма нажатием клавиш. Реестра сессий у бинаря по-прежнему нет — его отдаёт tmux, — а
// «идёт ли ход» знает не harness, а стенограмма чата: `{"type":"turn_ended"}` пишется на
// каждый переход сессии в простой.
//
// Все числа и формы ниже сняты живыми прогонами спайков (headless и persist)
// на `agent` 2026.09.02-c22c1a3 и tmux 3.6b, а не выведены из документации:
// документации ни на `-p --output-format stream-json`, ни на `persist` у Cursor нет вовсе.
//
// Граница та же, что у [driver-claude.js](driver-claude.js): остальной механизм этот файл
// не импортирует вовсе — он берёт driver из карты registry ([drivers.js](drivers.js)), и
// это сторожит гейт границы adapter'а ([promptobus-adapter.test.mjs](../../test/promptobus-adapter.test.mjs)).

/** Имя harness'а в записи участника и ключ в карте registry. */
export const CURSOR = 'cursor';

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

const CURSOR_SKILLS_REL = path.join('.cursor', 'skills');
const CURSOR_INSTALL = "curl https://cursor.com/install -fsS | bash (Windows: irm 'https://cursor.com/install?win32=true' | iex)";
const CURSOR_BINS = ['agent', 'cursor-agent', 'cursor'];
const CURSOR_INSTALL_DIRS = ['~/.local/bin', '/opt/homebrew/bin', '/usr/local/bin'];
const SKILL_FILE = 'SKILL.md';
const TMUX_MIN_VERSION = '3.0';

function skillDirs(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => {
    const dirAbs = path.join(dir, e.name);
    return { name: e.name, dirAbs, isSkill: existsSync(path.join(dirAbs, SKILL_FILE)) };
  });
}

function cursorMcpDuplicates(canonServerNames) {
  const file = path.join(homedir(), '.cursor', 'mcp.json');
  if (!existsSync(file)) return [];
  let mine;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    mine = j?.mcpServers && typeof j.mcpServers === 'object' ? j.mcpServers : {};
  } catch {
    return [];
  }
  return canonServerNames.filter((n) => Object.hasOwn(mine, n)).sort();
}

function expandHomeDir(dir, home) {
  return dir.startsWith('~/') ? path.join(home, dir.slice(2)) : dir;
}

function binInDir(dir, bin) {
  const p = path.join(dir, bin);
  try {
    if (!existsSync(p)) return null;
    if (process.platform === 'win32') return p;
    if (statSync(p).mode & 0o111) return p;
  } catch { /* пропал между проверками */ }
  return null;
}

function findCursorBin({ env = process.env, home = homedir() } = {}) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const pathDirs = String(env.PATH || env.Path || '').split(sep).filter(Boolean);
  const extra = CURSOR_INSTALL_DIRS.map((d) => expandHomeDir(d, home));
  for (const bin of CURSOR_BINS) {
    for (const dir of [...pathDirs, ...extra]) {
      const hit = binInDir(dir.replace(/^"|"$/g, ''), bin);
      if (hit) return { path: hit };
    }
  }
  return null;
}

function resolveTmux(_name, { env = process.env } = {}) {
  const r = run('tmux', ['-V'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || (r.status !== 0 && !String(r.stdout ?? r.stderr ?? '').trim())) {
    return {
      ok: false,
      reason: 'tmux: не найден в PATH. Поставь: brew install tmux (macOS) / пакет дистрибутива (Linux).',
    };
  }
  const raw = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const version = /\d+(?:\.\d+)*/.exec(String(raw))?.[0] ?? null;
  if (version && versionLess(version, TMUX_MIN_VERSION)) {
    return {
      ok: false,
      reason: `tmux: найдена версия ${version}, нужна ${TMUX_MIN_VERSION} или новее — сессия участника Cursor стоит на панели tmux.`,
    };
  }
  return { ok: true, version };
}

// --- словарь harness'а ----------------------------------------------------------

// Уровни effort. У Cursor это НЕ отдельный флаг: скобочная форма `--model 'x[effort=high]'`
// отвергается даже на примере из собственного `--help` бинаря, а уровень задаётся плоским
// СУФФИКСОМ id модели — `cursor-grok-4.6-xhigh`, `claude-opus-5-thinking-max` (REPORT
// §4.14). Отсюда правило driver'а: `--effort <уровень>` дописывает `-<уровень>` к `--model`.
//
// Перечень — по замеру 2026-09-03 (`agent -p --model <неверный id>` печатает все доступные
// id; их же печатает `agent models`): в id встречаются ровно эти суффиксы. Своего уровня
// нет у каждой модели: у `cursor-grok-4.5` доступны только `low`, `medium`, `high`, а
// `extra-high` встречается у одной семьи (`gpt-5.5`). Проверить пару «модель + уровень» до
// подъёма нечем — годность знает только бинарь, и на неверном id он отказывает за 2 с с
// пустым stdout, не заводя чата. Уровень, названный уже В id модели, вторым флагом не
// дублируется: `--model cursor-grok-4.6-xhigh-fast` идёт БЕЗ `--effort`.
export const EFFORT_LEVELS = ['none', 'low', 'medium', 'high', 'extra-high', 'xhigh', 'max'];

// Режимы прав. У Cursor их два источника, и оба нужны: файл `.cursor/cli.json` каталога
// (запреты, держатся и под `--force`, и под `persist` — REPORT §4.5 и §4.7 второго спайка) и
// флаг режима исполнения. Флагом задаётся то, что в файл не кладётся: `plan` — только чтение
// и планы, `ask` — вопросы и объяснения. `force` — неденайные инструменты не ждут одобрения:
// в сессии участника отвечать на запрос прав некому.
//
// `--auto-review` в перечень не входит намеренно: флаг у бинаря есть, но что он делает с
// deny-конфигом, спайк не проверил, а необъявленный режим лучше объявленного непроверенного.
export const PERMISSION_MODES = ['force', 'plan', 'ask'];
export const DEFAULT_PERMISSION_MODE = 'force';

// Модель по умолчанию. Дом — driver: имя модели принадлежит harness'у целиком, и `opus`
// Claude Code бинарь Cursor отвергает так же, как любой другой неизвестный id.
// `composer-2.5` — собственная модель Cursor, на ней снята большая часть замеров спайков.
export const DEFAULT_MODEL = 'composer-2.5';

// Инструменты, снятые у reviewer'а. Форма — правила `.cursor/cli.json`, а не имена
// инструментов Claude Code: у Cursor запрещаются ДЕЙСТВИЯ шаблоном. Ровно эта пара
// проверена живьём и держится под `persist` (REPORT §4.7 спайка: ход «выполни
// echo» получил `Permission denied` в живой persist-сессии). Третьего правила здесь нет
// намеренно: неизвестный ключ прежние версии zod-схемы отбрасывали молча, а молчаливо
// разрешённая запись — ровно то, от чего эта пара и защищает.
export const REVIEWER_DENY = ['Write(**)', 'Shell(**)'];

// Версия `agent`, на которой снят весь разбор: раскладка `persist`, опции его tmux-сессии,
// поведение хуков под ним, форма `turn_ended` в стенограмме, поведение `--workspace` и
// deny-конфига. Это НЕ минимум бинаря — число называет,
// на чём мерили, потому что бинарь обновляет себя сам и управления этим нет (REPORT §4.1).
export const PROVEN_CURSOR_VERSION = '2026.09.02';

// Переменные предка, которые до участника доезжать не должны. Первая — своя: метка сессии
// Cursor, и утеки она чужой ход в реестр этой сессии (contact point и добор процессов читают
// её). Остальные — внутренние переменные самого бинаря: они указывают на сокет и журнал
// ЧУЖОЙ сессии (REPORT §4.11), и унаследованные ведут потомка не туда.
export const SESSION_ENV_DROP = [SESSION_ENV_VAR, 'AGENT_CLI_SOCKET_PATH', 'AGENT_CLI_LOG_PATH', 'CURSOR_AGENT_SOCKET'];

/**
 * Правила Cursor, которые дописываются к промпту участника. Их два, и оба сняты замером.
 *
 * Первое — запрет вопросов. `AskQuestion` в сессии механизма получает не согласие, а
 * ПРОПУСК (`askQuestionToolCall.result.rejected`), после чего модель кончает ход прозой, не
 * сделав работу (REPORT §4.15). Механического рычага против этого у CLI нет — только
 * просьба в промпте.
 *
 * Второе — цена хода. Сообщение, пришедшее во время хода, встаёт в очередь сессии и
 * исполняется отдельным ходом сразу после текущего (REPORT §4.3 спайка ): в идущий
 * ход оно не попадает, и участник, кончивший ход на полуслове, ждёт следующего.
 */
const CURSOR_PROMPT_TAIL = `

## Правила этого инструмента (Cursor)

- **Вопросов не задавай.** В этом режиме инструмент AskQuestion получает не ответ, а пропуск: ход кончится, работа останется несделанной, и никто об этом не узнает. Развилка, без которой не продолжить, — это promptobus-promptobus_send с type=question оркестратору, и только он.
- **Ход у тебя один за раз.** Пришедшее во время хода сообщение исполнится следующим ходом, а не внутри текущего. Поэтому забирай mailbox в начале каждого хода и перед отправкой result.`;

/**
 * Слова harness'а для человеческих строк adapter'а.
 *
 * Все четыре команды у Cursor теперь есть, и все — подкоманды `persist`: сессия
 * живёт до гашения, человек в неё входит, механизм её гасит. `logs` — единственное, что
 * командой не выражается: стенограмма лежит в доме человека под id ЧАТА, а маршруты
 * adapter'а собираются по имени persist-сессии, и связать одно с другим человеку проще
 * входом в сессию, чем поиском файла.
 */
export const PHRASES = {
  sessions: 'agent persist list',
  unreadable: 'список persist-сессий tmux не разобран',
  enter: (id) => `agent persist attach ${id}`,
  stop: (id) => `agent persist stop ${id}`,
  logs: (id) => `лента сессии — на её экране: agent persist attach ${id}`
    + ` (стенограмма чата лежит в ~/.cursor/projects/<каталог участника слагом>/agent-transcripts/)`,
  // Имена инструментов MCP Cursor неймспейсит ДЕФИСОМ: `promptobus-promptobus_send`, а не
  // `mcp__promptobus__promptobus_send`. Форма снята живым прогоном (REPORT §4.17), и
  // промпт участника обязан называть их так — иначе участник ищет инструмент, которого под
  // этим именем у него нет.
  tool: (server, name) => `${server}-${name}`,
  promptRules: CURSOR_PROMPT_TAIL,
  // Имя persist-сессии выбирает не механизм, а сам бинарь, и печатает его только после
  // старта. `--dry-run` обязан сказать это вслух: иначе человек ждёт в его выводе имя,
  // которого там не будет никогда, — а команду он видит ту самую, что исполнится.
  naming: 'имя persist-сессии придумывает сам agent — cursor-<слаг каталога>-<хэш пути>-<номер>-<rand6>; '
    + 'механизм узнаёт его после старта, вместе с id чата, и печатает подъёмом',
};

// --- перевод harness-neutral контекста в конфиги и argv --------------------------
//
// Наружу отсюда не торчит ничего: сборка argv и конфигов — половины ОДНОЙ операции
// `prepare`, и вызывающий команду по частям не собирает.

/** Каталог per-session конфигов Cursor внутри рабочего места участника. */
const CURSOR_DIR = '.cursor';

// Самоигнорирующий `.gitignore` внутри `.cursor/`: действует только в этом дереве и
// уезжает с каталогом. Общий `info/exclude` клона не трогаем — неякорёная `.cursor/`
// спрятала бы личные файлы человека на любом уровне дерева.

/**
 * Канон скиллов Cursor в корне рабочего места — тот, что раскладывает `sync`.
 * Источник только он, не `~/.cursor`: личные копии человека участнику не адресованы.
 * Каталога нет (рабочее место без Cursor-рендера) — `null`, участник идёт без скиллов.
 */
export function workspaceSkillsDir(root) {
  if (!root) return null;
  const src = path.join(root, CURSOR_SKILLS_REL);
  try {
    if (statSync(src).isDirectory()) return src;
  } catch {
    // Нет каталога или это не каталог — тот же исход, что «рендера не было».
  }
  return null;
}

function skillsCount(dir) {
  return skillDirs(dir).filter((s) => s.isSkill).length;
}

export function skillsNoteOf({ src, dest, count }) {
  if (!src) {
    return 'не подключены — в корне рабочего места нет .cursor/skills (Cursor-рендер sync не раскладывал)';
  }
  return `${count} из ${src} → ${dest}`;
}

/**
 * Песочница reviewer'а: рабочее место, которое не грязнит ревьюируемый клон.
 *
 * Reviewer Claude Code садится прямо в проверяемый каталог — его read-only держит файл
 * настроек на один подъём. У Cursor файла на один подъём нет вовсе: и права, и MCP, и хуки
 * читаются из `.cursor/` РАБОЧЕГО каталога, то есть сели бы reviewer в клон — механизм
 * писал бы три файла в чужое рабочее дерево. Поэтому cwd reviewer'а — свой каталог рядом с
 * остальными файлами участника в сторе задачи, а проверяемый клон подключается `--add-dir`
 * (тот же приём, что у headless-ревью).
 *
 * Каталог ДЕТЕРМИНИРОВАННЫЙ, а не `mkdtemp`: `prepare` ничего не пишет и не запускает, а
 * `--dry-run` обязан напечатать ровно тот путь, который исполнит реальный подъём.
 */
export function reviewSandbox(settingsPath) {
  return `${String(settingsPath).replace(/\.settings\.json$/, '')}.cursor-sandbox`;
}

// MCP-конфиг участника: harness-neutral перечень серверов в форму, которую читает бинарь.
// Форма совпадает с Claude Code байт в байт (`mcpServers`), а вот МЕСТО другое: проектный
// конфиг Cursor лежит в `.cursor/mcp.json` рабочего каталога, и читается он только в
// git-репозитории (REPORT §4.2). У worker'а условие выполняется само (worktree — git), у
// reviewer'а его выполняет `git init` песочницы при подъёме.
function mcpConfig({ servers }) {
  return { mcpServers: { ...servers } };
}

// Права участника: проектный `.cursor/cli.json`. Пишется ВСЕГДА, в том числе worker'у с
// пустыми списками: Cursor ищет этот файл вверх по дереву, а worktree участника лежит
// внутри workspace — без своего файла права участника задавал бы конфиг чужого каталога.
// `allow` обязателен схемой: без него `agent` падает с `Invalid project config`.
function cliConfig(denyTools) {
  return { permissions: { allow: [], deny: [...(denyTools ?? [])] } };
}

/**
 * Известные имена событий хуков Cursor — перечень, а не одно имя, и лежит он здесь ради
 * гейта.
 *
 * Цена ошибки в имени несоразмерна опечатке: неизвестное событие в `.cursor/hooks.json`
 * МОЛЧА убивает весь файл — не стреляет ни один хук, включая правильно названные (REPORT
 * §4.4 спайка: девять имён, из них два выдуманных, дали ноль хуков; после
 * сокращения до пяти известных те же ходы дали хуки). Driver, дописавший событие с
 * опечаткой, потерял бы сторож цикла и канал пробуждения разом и бесшумно.
 *
 * Перечень — те пять имён, что подтверждены живыми прогонами обоих спайков. Гейт на него
 * стоит в наборе: driver пишет только известные имена, и вход в файл хуков один.
 */
export const KNOWN_HOOK_EVENTS = ['sessionStart', 'beforeSubmitPrompt', 'stop', 'sessionEnd', 'afterFileEdit'];

/**
 * Событие хука, на котором стоит сторож цикла. Под `persist` это `stop`, а не `sessionEnd`:
 * зеркало headless-пути. `sessionEnd` в живой сессии НЕ стреляет вовсе — ни на конце хода,
 * ни на `persist stop`, ни на `tmux kill-session`, — а `stop` стреляет на конце каждого хода
 * и несёт `session_id` (это и есть `chatId`), `status`, `loop_count`, токены хода и
 * `transcript_path` (REPORT §4.4 спайка ). Хуки читаются только из ПРОЕКТНОГО
 * `.cursor/hooks.json`; каталог `CURSOR_CONFIG_DIR` для них не работает, поэтому файл ложится
 * в рабочий каталог участника.
 */
const GUARD_HOOK_EVENT = 'stop';

// Версия формата файла хуков — та, что стоит в живых конфигах спайков.
const HOOKS_VERSION = 1;

function hooksFile(guardCommand) {
  return { version: HOOKS_VERSION, hooks: { [GUARD_HOOK_EVENT]: [{ command: guardCommand }] } };
}

/**
 * argv бинаря из контекста подъёма.
 *
 * Первым идёт `persist`: сессия участника — живой TUI в панели tmux, а не headless-ход.
 * Своих флагов у подкоманды нет вовсе — всё после неё уезжает интерактивному
 * `agent` как есть (REPORT §4.1 спайка ), поэтому набор флагов тот же, что был у
 * headless-пути, минус `-p --output-format stream-json`.
 *
 * `--workspace <cwd>` стоит ВСЕГДА и не заменяется рабочей директорией процесса: он
 * перекрывает cwd целиком — и каталог агента, и хэш, под которым ляжет чат (REPORT §4.7).
 * Без него стор чатов ключевался бы каталогом запуска, то есть сессия участника уехала бы
 * в чужой чат; тем же хэшем механизм узнаёт СВОЮ сессию в списке tmux.
 *
 * `--approve-mcps` здесь НЕТ и быть не может: он одобряет ВСЕ серверы, объявленные выше по
 * дереву, и пишет одобрение в запись чужого проекта — worktree участника лежит внутри
 * workspace, и флаг одобрил бы там весь canonical-список от имени человека (REPORT §4.4,
 * §11). Свой сервер driver одобряет точечно, `agent mcp enable` из каталога участника.
 *
 * Промпт стоит последним и единственным позиционным аргументом: этого же порядка ждёт
 * печать команды в `--dry-run`.
 */
function spawnArgv({
  cwd, model, effort = null, permissionMode = null, addDirs = [], prompt,
}) {
  const mode = permissionMode === 'plan' || permissionMode === 'ask' ? permissionMode : null;
  return [
    'persist',
    '--workspace', cwd,
    '--trust',
    // `--force` — чтобы неденайные инструменты не ждали одобрения: отвечать на запрос прав
    // в сессии участника некому. Гарантию read-only он не трогает — deny сильнее (REPORT §4.5).
    '--force',
    ...(mode ? ['--mode', mode] : []),
    '--model', effort ? `${model}-${effort}` : model,
    ...addDirs.flatMap((dir) => ['--add-dir', dir]),
    prompt,
  ];
}

/**
 * План подъёма из harness-neutral контекста. Ничего не пишет и не запускает.
 *
 * `--plugin-dir` в argv не идёт: у Cursor свой формат плагина, а каталог механизма — плагин
 * Claude Code (`options.skillsDir` поэтому false и смысл не меняет). Канон скиллов Cursor
 * едет файлами `.cursor/skills` корня рабочего места: driver просит положить копию в
 * worktree участника. Живой замер — шаг «участник читает скилл» в
 * [live-cursor.mjs](../../scripts/live-cursor.mjs): прогон кладёт заглушку в канон,
 * участник возвращает её маркер. `mcp.json` рабочего места не копируется — набор MCP
 * собирает spawn. `.cursor/rules` sync не рендерит; `.cursor/agents` — субагенты IDE в
 * корне, не процедура участника. Каталога в корне нет — строка вывода говорит это,
 * участник идёт без скиллов.
 */
function prepare({
  mcp, prompt, model, effort = null, permissionMode = null, addDirs = [], settingsPath,
  cwd, guardCommand, denyTools = null, root = null,
}) {
  // Reviewer поднимается в своей песочнице, worker — в своём worktree. Различает их ровно
  // снятие инструментов: read-only участник — это reviewer, и другого у механизма нет.
  const readOnly = !!denyTools?.length;
  const workdir = readOnly ? reviewSandbox(settingsPath) : cwd;
  const cfg = mcpConfig(mcp);
  const settings = cliConfig(denyTools);
  const hooks = hooksFile(guardCommand);
  // Проверяемый клон подключается reviewer'у чтением: его cwd теперь песочница.
  const dirs = readOnly ? [...new Set([cwd, ...addDirs])] : [...addDirs];
  const files = [
    { path: path.join(workdir, CURSOR_DIR, 'mcp.json'), text: `${JSON.stringify(cfg, null, 2)}\n`, secret: true },
    { path: path.join(workdir, CURSOR_DIR, 'cli.json'), text: `${JSON.stringify(settings, null, 2)}\n`, secret: false },
    { path: path.join(workdir, CURSOR_DIR, 'hooks.json'), text: `${JSON.stringify(hooks, null, 2)}\n`, secret: false },
    { path: path.join(workdir, CURSOR_DIR, '.gitignore'), text: '*\n', secret: false },
  ];
  const src = workspaceSkillsDir(root);
  const dest = path.join(workdir, CURSOR_SKILLS_REL);
  const count = src ? skillsCount(src) : 0;
  if (src) files.push({ path: dest, copyFrom: src, text: '', secret: false });
  return {
    argv: spawnArgv({
      cwd: workdir, model, effort, permissionMode, addDirs: dirs, prompt,
    }),
    mcpConfig: cfg,
    settings,
    // Рабочий каталог сессии: у worker'а — его worktree, у reviewer'а — своя песочница.
    // Вызывающему он нужен затем же, зачем и driver'у: `--dry-run` печатает то место, куда
    // лягут файлы, а печатать чужой каталог значило бы обещать не то.
    cwd: workdir,
    // Порядок файлов — порядок записи. Конфиг MCP несёт подставленные токены
    // canonical-серверов и потому помечен секретом.
    files,
    skillsNote: skillsNoteOf({ src, dest, count }),
  };
}

// Окружение поднимаемой сессии: поверх наследуемого снимаются переменные предка, которые
// ведут потомка в чужую сессию. Что кладёт сам механизм (рычаг хука памяти), приходит
// аргументом — это не свойство harness'а.
function sessionEnv(base = process.env, extra = {}) {
  const env = { ...base, ...extra };
  for (const name of SESSION_ENV_DROP) delete env[name];
  return env;
}

/**
 * Отказ по версии бинаря и по составу рабочего места — до первой записи на диск.
 *
 * По запрошенному effort отказывать нечем: уровень у Cursor — суффикс id модели, а годность
 * пары «модель + уровень» знает только бинарь. Неверный id он отвергает за 2 с с пустым
 * stdout и перечнем доступных, чата при этом не заводя (REPORT §4.14).
 *
 * А вот два других отказа есть.
 *
 * **Версия.** Отказ свой, не общий минимум: общий порог headless-пути на старом
 * бинаре работает. Подъём участника стоит на другом: на подкоманде `persist`, на опциях,
 * которыми она метит tmux-сессию, на стрельбе хука `stop` под ней и на форме `turn_ended` в
 * стенограмме — всё это снято на `PROVEN_CURSOR_VERSION` и ни на чём другом. Версия не
 * прочитана — не отказываем: утверждать «старее нужной» о том, чего не прочли, механизм не
 * вправе (то же правило, что у `toolVersionCheck`).
 *
 * **tmux.** `agent persist` — обёртка над tmux, и без него сессия участника не поднимается
 * вовсе: подъём упёрся бы в «панель-поставщик pty не поднялась» уже после того,
 * как на диске появились worktree, ветка и запись участника. Поэтому спрашиваем его здесь,
 * рядом с версией бинаря, — и теми же словами, что `doctor`.
 */
function optionRefusal(options, tool, { util = resolveTmux } = {}) {
  if (tool?.version && versionLess(tool.version, PROVEN_CURSOR_VERSION)) {
    return `найден agent ${tool.version}, а подъём участника Cursor проверен на ${PROVEN_CURSOR_VERSION} и новее: `
      + 'на нём сняты раскладка agent persist, опции его tmux-сессии, стрельба хука stop под ней и форма turn_ended. '
      + 'На бинаре старше механизм поднимал бы сессию, которой не разбирал ни разу, и молчал бы о конце хода. '
      + `Обнови: ${CURSOR_INSTALL} (бинарь обновляет себя и сам — довольно одного запуска).`;
  }
  const tmux = util(TMUX_UTIL, { fresh: true });
  if (!tmux.ok) return `${tmux.reason} Без него участник Cursor не поднимается вовсе: сессия — панель tmux.`;
  return null;
}

/** Имя утилиты, на которой стоит подъём. Резолв — рядом, в этом файле. */
const TMUX_UTIL = 'tmux';

// Имена доставленных серверов, перекрытые ЛИЧНЫМИ записями пользователя. У Cursor личный
// конфиг — `~/.cursor/mcp.json`, и гасить одноимённые в нём нечем: проектный и домашний
// сливаются, ближний побеждает по имени, но соседние остаются (REPORT §4.3).
function shadowedUserServers(names) {
  return cursorMcpDuplicates(names);
}

// --- contact point и канал --------------------------------------------------------

/**
 * Contact point участника Cursor.
 *
 * У Claude Code это messaging-сокет живой сессии: стук в него вписывает ход в идущую
 * сессию. У Cursor сокета нет, а вписать сообщение в ИДУЩИЙ ход нечем и под persist: текст
 * встаёт в очередь сессии и исполняется отдельным ходом сразу после текущего (REPORT §4.3).
 * Поэтому contact point здесь значит другое: «сессия жива и приняла ход», а сдаёт его конец
 * хода.
 *
 * **Сдаёт его ХУК** (раньше сдавал бегун). Причина, по которой сдача переезжала в бегуна,
 * под persist исчезла: тогда отпечаток, пойманный
 * надзирателем в окне «хук стрельнул, ход ещё идёт», приводил к `activate`, а тот честно
 * отказывал «ход идёт» — и сигнал тратился. Теперь `activate` в этом окне ДОСТАВЛЯЕТ:
 * инъекция в занятую сессию не теряется, она ждёт своей очереди. А бегуна, который мог бы
 * сдать отпечаток, у механизма больше нет вовсе — ход держит сам бинарь.
 *
 * В `socket` едет счётчик кончившихся ходов. Надзиратель активирует немедленно, когда
 * contact point ПЕРЕПИСАН (`moved` в [supervisor.ts](../src/supervisor.ts)),
 * а `writeWake` не переписывает файл с прежним содержимым — без счётчика запись менялась бы
 * только полем `pid` процесса хука, то есть механизм пробуждения держался бы на том, что pid
 * у соседних процессов разный. Счётчик ведёт этот же вызов: других писателей у него нет.
 */
export function registerWake(home, task, addr, env = process.env, session = null) {
  try {
    // Сессию называет вызывающий: без неё это не конец хода. Сервер шины участника зовёт ту
    // же операцию в НАЧАЛЕ хода и своей сессии не знает — сдавать ему нечего.
    if (!session) return null;
    const file = String(env?.[SESSION_ENV_VAR] ?? '').trim();
    if (!file) return null;
    const record = readRecordAt(file);
    if (!record?.ref) return null;
    // Гейт владения адресом: адрес закреплён за сессией, и чужая за него не пишет ничего.
    const held = foreignSession(home, task, addr, session);
    if (held) {
      sayForeignWrite(home, task, addr, held, session, `сдача contact point'а`);
      return null;
    }
    const turns = (Number(record.turns) || 0) + 1;
    patchSession(record.ref, { turns, last: { endedAt: new Date().toISOString(), session } }, env);
    return writeWake(home, task, addr, { socket: `${file}#${turns}`, token: null, session });
  } catch {
    // Страховка не вправе уронить вызов инструмента шины или сторож цикла.
    return null;
  }
}

// Запись реестра по ПУТИ, а не по ref'у: contact point и смок канала приходят из процесса
// участника, и путь записи им кладёт driver переменной окружения — ref'а они не знают.
function readRecordAt(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Отказ гейта владения адресом обязан быть ВИДЕН: молчаливый `null` выглядит исправной
// работой. Пишем в журнал надзирателя — тот же файл, по которому человек разбирает
// «почему участник молчал». Один раз на причину и на процесс.
const foreignWrites = new Set();

export function sayForeignWrite(home, task, addr, held, session, what) {
  const key = [home, task, addr, held, session, what].join('\u0000');
  if (foreignWrites.has(key)) return;
  foreignWrites.add(key);
  logWarden(home, task, `${what} за адрес ${addr} не идёт: адрес закреплён за сессией ${held}, `
    + `а пишет ${session} — записи владельца не тронуты`);
}

/**
 * Смок канала для `doctor`. У Cursor «канал» — это живая persist-сессия, в которую можно
 * вставить текст, и сдаёт её сессия участника, а не сессия человека: `doctor` человек зовёт
 * из своего терминала, и метки сессии Cursor в его окружении нет. Настоящей инъекции смок не
 * делает — она стоила бы хода и записи в чат человека, который спросил про layout.
 */
export function checkWake(env = process.env) {
  const file = String(env?.[SESSION_ENV_VAR] ?? '').trim();
  if (!file) return { endpoint: null, ok: false, error: `${SESSION_ENV_VAR} пуст — эта сессия не участник Cursor` };
  const record = readRecordAt(file);
  if (!record) return { endpoint: file, ok: false, error: 'записи сессии по этому пути нет' };
  if (!record.sessionName) return { endpoint: file, ok: false, error: 'persist-сессия ещё не названа — подъём не подтверждён' };
  const live = findSession(record.sessionName, { server: record.tmuxServer || CURSOR_TMUX_SERVER, env });
  return {
    endpoint: file,
    ok: !!live,
    error: live ? null : `persist-сессии ${record.sessionName} на tmux-сервере нет`,
  };
}

// --- канал пробуждения ------------------------------------------------------------
//
// **Как участник Cursor узнаёт о сообщении**. Механизм
// вставляет текст в его живую сессию — тем же способом, каким пишет человек: буфер tmux,
// bracketed paste, Enter ([cursor-persist.js](cursor-persist.js)). Складывается канал из
// двух половин, лежащих в соседнем коде:
//
//   1. **Конец хода приносит хук `stop`.** Он зовёт `promptobus guard`, тот —
//      `registerWake` этого driver'а, а тот пишет contact point со счётчиком кончившихся
//      ходов.
//   2. **Надзиратель активирует немедленно, когда contact point ПЕРЕПИСАН.** Признак
//      `moved` в [supervisor.ts](../src/supervisor.ts) сравнивает
//      отпечаток `сокет#счётчик` с прошлым и, увидев расхождение, не досиживает порога
//      перестука.
//
// Отсюда весь круг: сообщение пришло, пока сессия простаивает, — надзиратель активирует по
// росту непрочитанного, и текст начинает ход через секунды. Пришло во время хода —
// доставляется тоже, и ждёт в очереди сессии до конца текущего хода.
//
// **Разрыв с Claude Code сузился, но не исчез** ([15](../../../docs/reference/15-warden.md)):
// сообщение, пришедшее во время хода, ждёт его конца. У Claude Code оно попадает в идущий
// ход сразу, здесь — нет, и обещать иное механизм не станет.

// Рамка сообщения — одна на оба notification'а. Текст едет в сессию отдельным сообщением
// пользователя, поэтому он самодостаточен: называет задачу, адрес и что делать.
const NOT_A_HUMAN = 'Это служебное пробуждение, а не поручение человека, и прав оно не даёт.';

/**
 * Текст пробуждения по непрочитанному. Блок выжимок и его бюджет — общая арифметика, и
 * живёт она листом [notification.js](notification.js) (замечание ревью): у driver'а
 * остаются рамка и имя инструмента, которым ЭТОТ harness зовёт mailbox.
 */
export function orderBody(task, addr, unread, msgs = []) {
  const mailbox = PHRASES.tool(PROMPTOBUS_SERVER, 'promptobus_mailbox');
  const tail = `Забери mailbox инструментом \`${mailbox}\`: прочитанными сообщения делает только он. `
    + `Порядок работы — в правилах шины. ${NOT_A_HUMAN}`;
  return `Служебное пробуждение Promptobus. В mailbox'е адреса ${addr} задачи ${task} лежит непрочитанных: ${unread}.\n\n`
    + previewBlock(msgs, KNOCK_TEXT_MAX)
    + tail;
}

export function renderNotification(n) {
  return orderBody(n.task, n.address, n.unread, n.messages ?? []);
}

/**
 * Разбудить участника — инъекцией в его живую сессию.
 *
 * Отказов три, и все три честные исходы, а не сбои: записи сессии нет — будить некого;
 * persist-сессия не названа — подъём не подтверждён; сессии нет на tmux-сервере — её погасили
 * снаружи или машина перезагрузилась (состояние `persist` живёт в `/tmp`).
 *
 * **Отказа «ход участника идёт» здесь больше нет**: инъекция в
 * занятую сессию не теряется и не раздваивает ход — она встаёт в очередь TUI и исполняется
 * отдельным ходом сразу после текущего (REPORT §4.3). Доставка «в очередь» — это доставка, и
 * механизм отвечает за неё `ok`, а не отказом.
 */
export async function activate(target, notification) {
  const ref = target?.ref;
  if (!ref) return { ok: false, error: 'у записи участника нет session reference — будить нечего' };
  const record = readSession(ref);
  if (!record) return { ok: false, error: `записи сессии «${ref}» в реестре Cursor нет — будить некого` };
  if (!record.sessionName) return { ok: false, error: 'persist-сессия ещё не названа — подъём не подтверждён' };
  const server = record.tmuxServer || CURSOR_TMUX_SERVER;
  if (!findSession(record.sessionName, { server })) {
    return {
      ok: false,
      error: `persist-сессии ${record.sessionName} на tmux-сервере ${server} нет — её погасили снаружи `
        + 'либо машина перезагружалась (состояние persist живёт в /tmp). Поднимай участника заново',
    };
  }
  const sent = await injectText(record, renderNotification(notification));
  if (!sent.ok) return { ok: false, error: sent.error };
  // Отметка инъекции — вход в окно, где ход уже начат, а стенограмма о нём ещё молчит
  // (`turnState`). Закрывается окно само, первой же строкой стенограммы.
  patchSession(ref, { injectedAt: new Date().toISOString() });
  return { ok: true };
}

// --- разбор состояния сессии ------------------------------------------------------

/**
 * Состояние одной сессии для снимка.
 *
 * **Состояние `stale` у Cursor появилось**. Под headless его не
 * бывало ни при каком исходе: сессия — чат, а чат переживает что угодно. Под persist сессия —
 * живой процесс в панели tmux, и «запись механизма есть, а сессии на сервере нет» — законное
 * состояние: её погасили снаружи, или машина перезагружалась (состояние `persist` живёт в
 * `/tmp`). Записи нет вовсе — это `gone`, как было.
 */
function inspect(ref) {
  const record = readSession(ref);
  if (!record) {
    return {
      state: 'gone',
      busy: false,
      stall: { kind: 'gone', reason: 'записи сессии в реестре Cursor нет' },
      id: null,
      note: null,
    };
  }
  const id = record.sessionName ?? null;
  const server = record.tmuxServer || CURSOR_TMUX_SERVER;
  const live = id ? findSession(id, { server }) : null;
  if (!live) {
    // До появления сессии в списке tmux её имени ещё нет, и сказать «числится, а процесса
    // нет» о поднимающейся сессии было бы ложью. Слово об этом — своё, потому что и
    // состояние своё.
    if (!id) {
      return {
        state: 'alive',
        busy: true,
        stall: null,
        id: null,
        note: 'поднимается — persist-сессия ещё не названа',
      };
    }
    return {
      state: 'stale',
      busy: false,
      stall: {
        kind: 'stale',
        reason: `persist-сессии ${id} на tmux-сервере ${server} нет — её погасили снаружи либо машина перезагружалась`,
      },
      id,
      note: record.chatId ? `чат ${record.chatId}` : null,
    };
  }
  const turn = turnState(record);
  // Дерево панели дорогое (`ps -Awwo` на каждый inspect) и нужно только сторожу тишины:
  // простой и говорящий ход детей не спрашивают. panePid уже есть у live — второй
  // findSession не зовём.
  const kids = turn.busy && turn.silent
    ? toolKidsOf(live.panePid, { needles: mcpRuntimeNeedles(readParticipantMcp(record)) })
    : [];
  const seen = live.attached ? `, клиентов в сессии: ${live.attached}` : '';
  if (turn.busy) {
    const silentSec = turn.silentMs == null ? 0 : Math.round(turn.silentMs / 1000);
    const living = turn.silent && kids.length
      ? `ход молчит ${silentSec} с, процессы живы: ${kids.join(', ')}`
      : null;
    return {
      state: 'alive',
      busy: true,
      stall: silentIsStall(turn, kids)
        ? {
          kind: 'watchdog',
          reason: `стенограмма хода молчит дольше ${Math.round(turnIdleMs() / 1000)} с`,
        }
        : null,
      id,
      note: living || `ход идёт — присланное исполнится следующим ходом${seen}`,
    };
  }
  if (turn.status && turn.status !== 'success') {
    return {
      state: 'alive',
      busy: false,
      stall: { kind: 'failed', reason: `последний ход кончился со статусом ${turn.status}` },
      id,
      note: `ход кончился (${turn.status})${seen}`,
    };
  }
  if (!turn.transcript) {
    return {
      state: 'alive',
      busy: false,
      stall: { kind: 'unknown', reason: 'стенограммы чата ещё нет — ход не начинался' },
      id,
      note: `сессия поднята, ходов не было${seen}`,
    };
  }
  return {
    state: 'alive',
    busy: false,
    stall: { kind: 'unknown', reason: 'ход кончился' },
    id,
    note: `ход кончился, ходов всего ${turn.ended}${seen}`,
  };
}

/**
 * Что человеку делать с этим стопом — командами Cursor. Общий текст строки («встал»,
 * «ЧИСЛИТСЯ», «ИСЧЕЗ») остаётся у adapter'а ([stalls.js](stalls.js)), сюда driver добавляет
 * маршрут.
 *
 * Вход человека у Cursor теперь настоящий: `agent persist attach <имя сессии>` показывает
 * всю ленту, включая инъекции механизма, и держит двух клиентов одновременно. Плата названа
 * там, где её платят: tmux ужимает окно до самого узкого клиента (REPORT §4.5).
 */
export function stallRoute({ kind, address, repoAbs, task }, id) {
  const where = repoAbs ? `cd ${repoAbs} && ` : '';
  const relift = () => (address?.startsWith('reviewer:')
    ? `поднимай reviewer'а заново: promptobus review "${repoAbs ?? '<путь клона>'}"${task ? ` --task ${task}` : ''}`
    : `поднимай worker'а заново тем же spawn'ом — он сядет в свой worktree и свою ветку`);
  if (kind === 'gone') {
    return 'записи сессии в реестре нет — будить некого. Снял её механизм (promptobus done гасит '
      + `участников закрытой задачи). Работа сдана — это штатный конец; не сдана — ${relift()}`;
  }
  if (kind === 'stale') {
    return `persist-сессии нет на tmux-сервере: её погасили снаружи (agent persist stop, tmux kill-session) `
      + `либо машина перезагружалась — состояние persist живёт в /tmp и перезагрузку не переживает. `
      + `Список живых: ${PHRASES.sessions}. Работа не сдана — ${relift()}`;
  }
  if (kind === 'watchdog') {
    return `ход молчит дольше порога: стенограмма не растёт. Сессия при этом жива — загляни в неё и реши сам: `
      + `${PHRASES.enter(id)} (выход из просмотра — ctrl+b d, ход снимается ctrl+c). `
      + `Сообщение ей доставится и так — оно встанет в очередь и исполнится следующим ходом`;
  }
  if (kind === 'question') {
    return 'ход потрачен на вопрос: в сессии участника вопрос получает пропуск, а не ответ. Ответить некому и не нужно — '
      + `пришли участнику указание сообщением, оно исполнится следующим ходом`;
  }
  if (kind === 'failed') {
    return `ход кончился нештатно — смотри ленту сессии: ${PHRASES.enter(id)}. `
      + `Неверный id модели и просроченный вход Cursor выглядят так же`;
  }
  if (kind === 'wake-taken') {
    return 'сессия жива, глух только канал: contact point вернётся к ней на её же следующем конце хода. '
      + `До тех пор доставь сообщение сам — ${where}${PHRASES.enter(id)}`;
  }
  return `ход кончился, сессия ждёт сообщения — разбудит её надзиратель. Заглянуть самому: ${PHRASES.enter(id)}`;
}

// --- подъём ------------------------------------------------------------------------

/**
 * Подъём участника: запись в реестре и живая persist-сессия.
 *
 * Бинарь зовётся ПУТЁМ КОНКРЕТНОЙ ВЕРСИИ, а не симлинком: `agent` обновляет себя сам при
 * запуске, и управления этим нет ни флагом, ни переменной (REPORT §4.1) — симлинк
 * `~/.local/bin/agent` мог переехать между проверкой версии и запуском. Резолв симлинка
 * фиксирует версию на всю сессию; фактическую версию механизм узнаёт постфактум, полем
 * `cursor_version` хука `stop`.
 *
 * Имя persist-сессии придумывает сам бинарь и заранее не печатает — оно узнаётся ПОСЛЕ
 * старта, как id чата (`--dry-run` печатает то, что механизм исполняет, а не то, что
 * получится). Механизм узнаёт свою сессию по хэшу рабочего каталога, непустому id чата и
 * времени создания: сервер `cursor-agent` общий, и рядом живут persist-сессии человека.
 */
async function spawn(plan, {
  tool, ref, role, cwd, env, home: runtimeHome, task: runtimeTask, address: runtimeAddress,
  launchFailNote = '', deadNote = '', persist, awaitOptions,
}) {
  const who = role === 'reviewer' ? `reviewer'а` : `worker'а`;
  let bin = tool.bin;
  try {
    bin = realpathSync(tool.bin);
  } catch {
    // Симлинка нет либо он битый — зовём то, что дал резолв: отказ придёт от запуска.
  }
  // Рабочий каталог берётся из плана, а не из cwd вызывающего: у reviewer'а это песочница,
  // и она же названа в `--workspace`. План и есть то, что исполняется.
  const workdir = plan.cwd ?? cwd;
  // Per-session MCP читается только в git-каталоге (REPORT §4.2). У worker'а условие
  // выполнено (worktree — git), песочнице reviewer'а его выполняем здесь: пустой
  // репозиторий без коммитов, только ради того, чтобы конфиг шины прочитался.
  if (workdir !== cwd) initGit(workdir);
  // Свой сервер шины одобряется ТОЧЕЧНО. `--approve-mcps` одобрил бы все серверы, видимые
  // выше по дереву, и записал бы это в запись чужого проекта (REPORT §4.4, §11).
  approveOwnServer(bin, workdir, env);
  writeSession({
    ref,
    cwd: workdir,
    bin,
    role: role ?? null,
    startedAt: new Date().toISOString(),
    // Имя сессии, чат и pid панели узнаются после старта — их кладёт подтверждение подъёма.
    sessionName: null,
    chatId: null,
    panePid: null,
    tmuxServer: CURSOR_TMUX_SERVER,
    turns: 0,
    last: null,
    // Адрес, задача и дом шины — хуку сессии: отпечаток «ход кончился» сдаёт он, и
    // адресовать запись ему больше нечем.
    home: runtimeHome,
    task: runtimeTask,
    address: runtimeAddress,
    // argv подъёма ложится в запись: по нему человек видит, чем сессия поднята, а уборка —
    // что именно гасить.
    argv: plan.argv,
  }, env);
  const lifted = await liftSession({
    ref,
    bin,
    argv: plan.argv,
    cwd: workdir,
    env,
    // Метка сессии уезжает в окружение самой сессии: по ней добираются её процессы, и по ней
    // же её хук находит свою запись в реестре. Ставится ПОСЛЕ чистки — `SESSION_ENV_VAR`
    // входит в перечень снимаемых, и метка предка иначе пережила бы чистку.
    launchEnv: { ...sessionEnv(env), [SESSION_ENV_VAR]: sessionFile(ref, env) },
    task: runtimeTask,
    address: runtimeAddress,
    // Форма ожидания у `awaitOptions` одна на контракт — `{tries, delayMs}` (замечание
    // ревью): шов набора приходит от вызывающего, а не от driver'а, и своя вторая форма
    // молча игнорировала бы чужую.
    ...(awaitOptions ?? {}),
  });
  if (!lifted.ok) {
    dropSession(ref, env);
    fail(`${bin}: persist-сессия не поднялась (${lifted.error}) — ${who} поднимать нечем.${launchFailNote}${deadNote}`);
  }
  const { name, chatId, panePid } = lifted.session;
  patchSession(ref, { sessionName: name, chatId, panePid }, env);
  // Человеку в записи участника едет ИМЯ persist-сессии: им зовутся `attach` и `stop`. Полный
  // id — чат: его же приносит хук конца хода полем `session_id`, и по нему сверяется владение
  // адресом.
  persist(name, 'alive', chatId);
  return { output: `persist-сессия ${name} · чат ${chatId}`, session: name, seen: lifted };
}

/**
 * Путь бинаря на СЕЙЧАС. Подъём фиксирует версию резолвом симлинка, но между ходами бинарь
 * успевает обновить себя сам, и старый versioned-каталог с диска исчезает. Поэтому гашение
 * берёт свежий резолв тем же путём, каким его берёт подъём.
 */
function liveBin(recorded) {
  // Поиск БЕЗ пробы версии: `resolveToolBin` спрашивает `--version` с потолком в 15 с, а
  // годность версии подтверждена подъёмом — переспрашивать её на гашении незачем.
  const found = findCursorBin();
  if (!found?.path) return recorded;
  try {
    return realpathSync(found.path);
  } catch {
    return found.path;
  }
}

// Что сказано о подъёме после успеха. Отказом это не является: участник поднят, найти его
// можно по имени persist-сессии и по id чата.
function saidLiftoff({ output }) {
  if (output) info(output);
}

// Пустой git-репозиторий песочницы: без него проектный `.cursor/mcp.json` не читается
// вовсе (REPORT §4.2), и reviewer остался бы без шины — то есть без единственного способа
// прислать отчёт. Коммитов не делаем: условие — наличие репозитория, а не истории.
function initGit(dir) {
  if (existsSync(path.join(dir, '.git'))) return;
  run('git', ['init', '-q', dir], { encoding: 'utf8' });
}

// Точечное одобрение своего сервера. Запись ложится в `~/.cursor/projects/<слаг>/`
// каталога, из которого зовут, — потому и зовём из каталога участника. Отказ команды
// подъём не валит: без одобрения сервер не поднимется, и об этом скажет отсутствие вызовов
// шины из сессии, а не молчание здесь.
function approveOwnServer(bin, dir, env) {
  run(bin, ['mcp', 'enable', PROMPTOBUS_SERVER], { cwd: dir, env, encoding: 'utf8' });
}

// --- гашение -----------------------------------------------------------------------

/**
 * Погасить сессию: команда harness'а, добор процессов, снятие записи.
 *
 * **Возвращается операция после того, как сессии у harness'а НЕТ**: следом за
 * гашением идёт уборка каталогов, и вернись `stop` раньше исчезновения сессии, обход увидел
 * бы ход идущим и законно оставил бы worktree.
 *
 * Добор идёт ДВУХ пород процессов, и обе — замер спайка (REPORT §4.8): дети инструментов
 * идущего хода, которых `persist stop` не трогает вовсе, и сирота `worker-server`, живущая
 * минутами и после ШТАТНОГО конца хода. Второе значит, что добор нужен и на простаивающей
 * сессии, а не только на убитой посреди хода.
 */
async function stop(ref, waitOptions = undefined) {
  const record = readSession(ref);
  if (!record) return { ok: true, stopped: false, note: `сессии «${ref}» в реестре Cursor нет` };
  const id = record.sessionName ?? record.chatId ?? ref;
  const done = await stopSession(record, { bin: liveBin(record.bin), ...(waitOptions ?? {}) });
  const reaped = [
    done.kids.length ? `добрано детей инструментов: ${done.kids.length}` : null,
    done.orphans.length ? `добрано сирот: ${done.orphans.length}` : null,
  ].filter(Boolean).join(', ');
  const tail = reaped ? `, ${reaped}` : '';
  if (record.sessionName && !done.stopped && findSession(record.sessionName, { server: record.tmuxServer || CURSOR_TMUX_SERVER })) {
    // Гашение пошло, а подтвердить его нечем. Записи не снимаем: по этому исходу пойдёт
    // уборка каталогов, и объявлять сессию погашенной нельзя.
    return {
      ok: true,
      stopped: false,
      attempted: true,
      note: `persist-сессия ${id} не исчезла с tmux-сервера после agent persist stop${tail}`,
    };
  }
  dropSession(ref);
  return {
    ok: true,
    stopped: true,
    note: done.stopped ? `persist-сессия ${id} погашена, запись снята${tail}`
      : `сессия ${id} закрыта — persist-сессии уже не было, запись снята${tail}`,
  };
}

/**
 * Driver Cursor.
 *
 * `attach: false` — пользовательского подключения к чужой сессии у механизма нет вовсе,
 * как и у Claude. Не путать с `enter`: то — вход ЧЕЛОВЕКА в сессию из
 * терминала, и он у Cursor теперь настоящий (`agent persist attach`).
 *
 * `activation: 'push'` — механизм и правда доставляет текст в живую сессию участника:
 * инъекция в TUI, а не новый процесс. Доставка проходит и в идущий ход — текст
 * ждёт своей очереди и исполняется следующим ходом.
 */
export const cursorDriver = {
  id: CURSOR,
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
    tool: CURSOR,
    effortLevels: EFFORT_LEVELS,
    permissionModes: PERMISSION_MODES,
    defaultPermissionMode: DEFAULT_PERMISSION_MODE,
    defaultModel: DEFAULT_MODEL,
    denyTools: REVIEWER_DENY,
    provenVersion: PROVEN_CURSOR_VERSION,
    // Канал — инъекция в живую сессию, а не сокет и не новый процесс: `endpoint` этого
    // driver'а сокетом не является вовсе, и подставной канал набора подменять здесь нечего.
    knockChannel: 'inject',
    envDrop: SESSION_ENV_DROP,
    // Утилиты, без которых driver не поднимет сессию. Имя объявляет driver; резолв и
    // проверку версии он же делает при отказе по опциям — host про утилиты harness'а не знает.
    utils: [TMUX_UTIL],
    // Плагин скиллов Claude Code Cursor не читает. Канон едет файлами `.cursor/skills`:
    // копию в каталог участника кладёт prepare, не этот флаг. Смысл поля не меняется.
    skillsDir: false,
  },
  phrases: PHRASES,
  prepare,
  spawn,
  saidLiftoff,
  inspect,
  stop,
  activate,
  renderNotification,
  stallRoute,
  registerWake,
  sayForeignWrite,
  checkWake,
  sessionEnv,
  optionRefusal,
  shadowedUserServers,
};
