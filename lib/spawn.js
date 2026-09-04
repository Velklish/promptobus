import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ok, info, warn, fail, shellQuote, GIT_MAX_OUTPUT, GIT_NET_TIMEOUT_MS, toPosix,
} from './util.js';
import { hostOf, HostResolveError } from './host.js';
import { guardHookCommand } from '../dist/hooks.js';
import {
  activeTasks, addressOf, bindIfOwner, boundTaskId, claimRoute, createTask,
  foreignTaskLine, GateError, newTaskIdentity, ORCHESTRATOR, ownership, participantMcpPath,
  participantOf, participantRecord, participantSettingsPath, readTask, retitleTask,
  sessionIdentity, SLUG_MAX, slugify, TASK_TITLE_SEP, taskExists, titleFromLines,
  upsertParticipant, workerAddress,
} from './store.js';
import { PROMPTOBUS_SERVER } from './contract.js';
import {
  WORKTREE_BRANCH_PREFIX, WORKTREE_DIR_REL, createWorktree, defaultRefs, excludeWorktrees,
  installWorktreeDeps, npmCiCommand, worktreeHasLock,
} from './worktree.js';
import { openParticipant } from '../dist/index.js';
import { driverOf, liftDriver, REGISTRY } from './drivers.js';
import { ensureWarden } from './warden.js';
// Живость участника — предикатом состояния (status.js): гейт «адрес уже работает» и
// строка `promptobus status` обязаны считать живым одно и то же.
import { participantSession } from './status.js';

// Spawn worker'а: фоновая сессия harness'а в директории целевого репозитория, с Promptobus
// через собственный конфиг MCP. Конфиг шины лежит в сторе задачи и уезжает
// участнику вместе с остальным планом подъёма. Общая сборка участника (промпт, имена,
// набор MCP, настройки) живёт здесь и зовётся ещё и ревью.
//
// **Ни argv, ни имени harness'а здесь нет**. Этот файл называет ПРЕДМЕТ
// — каталоги видимости, команду сторожа цикла, снятые инструменты, — а в argv, конфиг и
// файл настроек его переводит driver из registry ([drivers.js](drivers.js)), одной
// операцией `prepare`. Реестр сессий и подъём — там же, за контрактом.

function readBrief(file) {
  if (!file) throw new GateError('нужен --brief <файл с текстом задания>');
  const abs = path.resolve(file);
  if (!existsSync(abs)) throw new GateError(`файла с заданием нет: ${abs}`);
  const text = readFileSync(abs, 'utf8').trim();
  if (!text) throw new GateError(`файл с заданием пуст: ${abs}`);
  return text;
}

// Из настроек workspace участнику копируется один ключ — `skillOverrides`: он гасит
// личные файловые копии одноимённых скиллов (сами скиллы едут каталогом плагина).
// Экспортируется ради гейта: соответствие с `OWNED_SETTINGS_KEYS` в plugin.js держит тест.
export const SKILL_KEYS = ['skillOverrides'];

export function skillSettings(rootOrHost) {
  const host = hostOf(rootOrHost);
  const file = path.join(host.workspaceRoot(), '.claude', 'settings.json');
  if (!existsSync(file)) return {};
  try {
    const ws = JSON.parse(readFileSync(file, 'utf8'));
    return Object.fromEntries(SKILL_KEYS.filter((k) => ws[k] !== undefined).map((k) => [k, ws[k]]));
  } catch {
    warn(`${file}: настройки workspace не разобраны — личные копии одноимённых скиллов`
      + ` у участника не погашены. Почини файл или прогони ${host.syncHint()}`);
    return {};
  }
}

// Скиллы workspace участнику — флагом сессии, а не установкой плагина: `--plugin-dir`
// грузит плагин на одну сессию, namespace тот же, записи в `installed_plugins.json` не
// появляется.
export function participantPluginDir(rootOrHost) {
  const host = hostOf(rootOrHost);
  const dir = host.pluginDir();
  // Смотрим на манифест, а не на каталог: плагином каталог делает
  // `.claude-plugin/plugin.json`.
  if (existsSync(path.join(host.workspaceRoot(), host.pluginManifestRel()))) return dir;
  warn(`${dir}: каталога плагина нет или он без манифеста .claude-plugin/plugin.json`
    + ` — участник останется без скиллов workspace. Прогони ${host.syncHint()}`);
  return null;
}

// Имя записи шины в конфиге участника — из своего дома: его читает и хук шины.
export { PROMPTOBUS_SERVER } from './contract.js';

// Canonical MCP-список workspace — участнику шины: `.mcp.json` workspace сессии с cwd в
// своём репозитории не адресован, а базовые правила требуют от неё `search_facts` первой
// строкой задачи. Собираем тем же путём, каким `sync` собирает `.mcp.json`;
// внешне-авторизуемые серверы (`managedBy.auth: "external"`) отделяет сам
// `collectServers` — их динамический токен держит внешний скилл на user-scope, и
// возвращаются они рядом с доехавшими. Запись шины идёт ПОСЛЕ списка и перекрывает
// одноимённую: `PROMPTOBUS_ROLE`, `PROMPTOBUS_TASK` и `PROMPTOBUS_HOME` у участника свои. Мягкий режим
// обязателен: по умолчанию `collectServers` зовёт `fail()` (process.exit, try/catch его
// не ловит), а поломка списка не повод убивать подъём.
// Harness-neutral MCP descriptor участника и объяснение к нему — считаются вместе, иначе
// строка вывода обещает не тот набор. Что за серверы, решает рабочее место через host:
// canonical-набор плюс запись самой шины. В какой файл они лягут — дело driver'а:
// descriptor уезжает к нему, и он же переводит его в свой конфиг.
export function participantMcp(rootOrHost, { address, taskId, home }, driver) {
  const host = hostOf(rootOrHost);
  const { servers, external } = host.participantServers();
  const mcpServers = {
    ...host.substituteVars(servers),
    [PROMPTOBUS_SERVER]: {
      type: 'stdio',
      command: host.nodePath(),
      args: host.busArgv(['mcp']),
      env: { PROMPTOBUS_ROLE: address, PROMPTOBUS_TASK: taskId, PROMPTOBUS_HOME: home },
    },
  };
  return {
    descriptor: { address, task: taskId, home, servers: mcpServers },
    external,
    // Перекрытые личные записи считает driver: личный конфиг harness'а — его словарь.
    shadowed: driver.shadowedUserServers(Object.keys(mcpServers)),
  };
}

// Права 0600 на mcp-config участника: в нём подставленные токены — вывод spawn их
// поэтому и не печатает. `mode` у `writeFileSync` работает только на СОЗДАНИИ файла,
// отсюда `chmod` следом: перезапись при повторном spawn оставила бы прежние права.
export function writeSecret(file, text) {
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

// Каталог из плана: driver называет источник, кладёт вызывающий — как текст файла.
// Бит +x источника переносится: скрипты скилла иначе приедут неисполняемыми. Симлинк
// не разыменовываем: цель бывает вне канона, и копия уехала бы неполной. Пропуск —
// с предупреждением, как у Writer.copyDir: молча оставленный симлинк оставляет скилл
// неполным. Цель сносится перед копией: повторный подъём иначе оставил бы выпавший скилл.
function copyLaunchTree(src, dest, { wipe = true } = {}) {
  if (wipe && existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === '.DS_Store') continue;
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) copyLaunchTree(from, to, { wipe: false });
    else if (e.isFile()) {
      copyFileSync(from, to);
      const mode = statSync(from).mode & 0o777;
      if (mode & 0o111) chmodSync(to, mode);
    } else {
      warn(`${toPosix(from)} — ${e.isSymbolicLink() ? 'символическая ссылка' : 'не файл и не каталог'}, `
        + `в каталог участника не поехал (источник: ${toPosix(src)}); `
        + 'то, что на него ссылается, приедет неполным — положи в источник сам файл');
    }
  }
}

function warnTrackedCursor(files) {
  const dirs = new Set();
  const needle = `${path.sep}.cursor${path.sep}`;
  for (const file of files) {
    const at = file.path.indexOf(needle);
    if (at < 0) continue;
    dirs.add(file.path.slice(0, at));
  }
  for (const dir of dirs) {
    const listed = spawnSync('git', ['-C', dir, 'ls-files', '--', '.cursor'], {
      encoding: 'utf8', timeout: GIT_NET_TIMEOUT_MS, maxBuffer: GIT_MAX_OUTPUT,
    });
    if (listed.status !== 0) continue;
    const names = String(listed.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!names.length) continue;
    warn(`${dir}: в git уже лежат ${names.join(', ')} — подъём их перетрёт, дерево станет грязным`);
  }
}

/**
 * Файлы, которые driver просит положить рядом с сессией до подъёма. Порядок —
 * его, права — общие: секрет ложится `0600`. Что именно лежит в файле и как он называется,
 * знает driver; что «здесь токены» — знает контракт, и потому режим ставит вызывающий.
 * `copyFrom` — каталог целиком: канон скиллов Cursor едет файлами, не текстом одного файла.
 */
export function writeLaunchFiles(files) {
  warnTrackedCursor(files);
  for (const file of files) {
    mkdirSync(path.dirname(file.path), { recursive: true });
    if (file.copyFrom) copyLaunchTree(file.copyFrom, file.path);
    else if (file.secret) writeSecret(file.path, file.text);
    else writeFileSync(file.path, file.text);
  }
}

// Перечень доставленных серверов для `--dry-run`: имя и type, без конфига с токенами.
export function mcpServerLines(mcpConfig) {
  return Object.entries(mcpConfig.mcpServers ?? {}).map(([name, cfg]) => `${name} · ${cfg?.type ?? 'stdio'}`);
}

// Набор MCP участника — строкой вывода: называется только НЕОБЫЧНОЕ, полный перечень
// остаётся в `--dry-run`. Перекрытие — `warn` (считается по личному ~/.claude.json
// человека, это единственная машинозависимая строка вывода spawn), отсечённое — `info`.
export function mcpNote(mcp, who) {
  const count = Object.keys(mcp.descriptor.servers ?? {}).length;
  const parts = [];
  if (mcp.shadowed.length) {
    parts.push(`перекрыли личные записи user-scope — ${mcp.shadowed.join(', ')}`);
  }
  if (mcp.external.length) {
    parts.push(`не поехали — ${mcp.external.join(', ')}`
      + ' (внешне-авторизуемые: токен динамический, его держит внешний скилл на user-scope)');
  }
  return {
    level: mcp.shadowed.length ? 'warn' : 'info',
    text: `MCP ${who} (${count}): ${parts.join('; ') || 'необычного нет'}`,
  };
}

// В `--dry-run` подсказки про `--dry-run` нет: полный перечень там уже напечатан выше.
export function sayMcp(plan, { hint = true } = {}) {
  const n = plan.mcpNote;
  (n.level === 'warn' ? warn : info)(hint ? `${n.text}. Полный перечень имён — --dry-run` : n.text);
}

// Окружение фоновых сессий шины.
// Одна функция на worker'а и reviewer'а: две фоновые сессии одного run'а — одно окружение.
// Что снимается от предка, решает driver: переменные, протекающие чужими значениями, —
// свойство harness'а, и у второго они свои. Рычаг памяти — `host.extraEnv()`.
//
// **Идентичности шины здесь нет**. До неё тройку `PROMPTOBUS_*` клали в окружение
// поднимаемой сессии ради Stop-хука, и предпосылка «окружение сессии кладёт
// `claude --bg` из argv spawn'а» на `claude` 2.1.251 не выполняется: замер 2026-09-03 —
// фоновая сессия это заранее заведённый spare демона, и окружение ей достаётся от процесса,
// поднявшего демон. Тройка первого spawn'а run'а стояла у ВСЕХ его сессий, включая чужие
// рабочие места, и хук второго участника переписывал contact point первого. Теперь
// идентичность едет аргументами команды хука в файле настроек участника
// ([hooks](../src/hooks.ts)), а окружение сессии её не несёт вовсе — класть туда
// значение, которое достанется соседям, значит ровно раздавать чужую идентичность.
export function sessionEnv(driver, base = process.env, host) {
  return driver.sessionEnv(base, host.extraEnv());
}

/**
 * Имя инструмента MCP так, как его зовёт сессия ЭТОГО harness'а. Промпт участника называет
 * инструменты шины и памяти, и написание у harness'ов разное: Claude Code берёт короткое
 * имя, Cursor неймспейсит дефисом (`promptobus-promptobus_send`). Участник, которому
 * назвали чужое написание, ищет инструмент, которого у него нет.
 */
export function toolName(driver, server, name) {
  return driver.phrases.tool(server, name);
}

// Правило одно на оба промпта: worker и reviewer получают одно правило на один инструмент.
// Функция, а не константа: имена инструментов памяти пишет harness (`toolName`).
export function memoryRule(driver, host) {
  return host.memorySection((server, name) => toolName(driver, server, name)) ?? '';
}

// Отказ по версии бинаря под запрошенные опции — операция driver'а: и граница версии, и
// слова отказа принадлежат harness'у. Гейт общий у worker'а и reviewer'а:
// разойдись отказы, reviewer тихо вставал бы на дефолтном эффорте.
export function optionRefusal(driver, effort, tool) {
  return driver.optionRefusal({ effort }, tool);
}
// Реэкспорт: spawn считает её для предсказания в `--dry-run`, решает — `retitleTask` под локом.
export { titleFromLines } from './store.js';

// Исход перештамповки, проигранной под локом: план пообещал переименование, а
// `retitleTask` вернул `null`. Отдельной чистой функцией: печатает её участок `spawn()`,
// куда тестом не попасть — смена владельца случается между планом и записью.
export function restampOutcome(current, wanted) {
  return current === wanted
    ? { level: 'ok', text: 'заголовок уже такой — назвал его соседний spawn, переименовывать нечего' }
    : {
      level: 'warn',
      text: 'заголовок не перештампован — mailbox задачи сменил владельца, пока шёл spawn. '
        + claimRoute('spawn'),
    };
}

/**
 * Driver ПОДЪЁМА по флагу `--harness`. Два гейта, и оба до всякой записи на диск.
 *
 * Первый — registry: неизвестное имя отказывает с перечнем известных, и делает это
 * `liftDriver` ([drivers.js](drivers.js)) — единственная дверь механизма к driver'ам.
 *
 * Второй — декларация рабочего места: harness, которого нет в манифесте инструментов, не
 * получил ни адаптеров (`sync` их не раскладывал), ни строки в `doctor`. Поднять им
 * участника значило бы завести сессию инструмента, которым это рабочее место не работает.
 * Без флага гейта нет вовсе: прежний harness подъёма берётся из карты и декларации не
 * спрашивает — иначе рабочее место с одним `cursor` в декларации перестало бы поднимать
 * оркестрацию, которая на нём и работала.
 */
export function liftHarness(rootOrHost, harness = null) {
  const lifter = liftDriver(harness);
  if (!harness) return lifter;
  const host = hostOf(rootOrHost);
  const tools = host.declaredTools();
  if (!tools.includes(lifter.id)) {
    throw new GateError(`--harness ${lifter.id}: инструмент не объявлен в ${host.toolsManifestRel()} рабочего места `
      + `(объявлены: ${tools.join(', ') || 'ни одного'}) — адаптеры под него не разложены, и участник `
      + `остался бы без правил и скиллов рабочего места. Объяви его: ${host.formatCommand(['tools', 'add', lifter.id])}, `
      + `затем ${host.syncHint()}`);
  }
  return lifter;
}

export function resolveEffort(effort, driver) {
  if (effort === undefined) return null;
  const levels = driver.options.effortLevels;
  if (!levels.includes(effort)) {
    throw new GateError(`--effort: неизвестное значение «${effort}» — допустимые: ${levels.join(', ')}`);
  }
  return effort;
}

// Режим прав сессии участника: значение флага сверяется с перечнем бинаря до
// подъёма — неизвестный режим иначе доехал бы до `claude` и уронил бы сессию непонятным
// отказом. Без флага — `fallback`: worker'у `auto`, reviewer'у режим бинаря (`null`).
export function resolvePermissionMode(mode, driver, fallback = undefined) {
  const modes = driver.options.permissionModes;
  if (mode === undefined) return fallback === undefined ? driver.options.defaultPermissionMode : fallback;
  if (!modes.includes(mode)) {
    throw new GateError(`--permission-mode: неизвестное значение «${mode}» — допустимые: ${modes.join(', ')}`);
  }
  return mode;
}

function titleFromBrief(brief) {
  const first = brief.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? 'задача';
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

// Слаг worker'а — из имени репозитория; занятый под другой репозиторий получает номер.
// Явное имя (`--worker`) сильнее и номера не получает — его выбрал человек. Префикс
// `reviewer-` занят: имена файлов в `workers/` выводятся из адреса одной функцией, и
// `worker:reviewer-foo` дал бы тот же `reviewer-foo.mcp.json`, что и `reviewer:foo`.
function refuseReviewerPrefix(slug, route) {
  if (!slug.startsWith('reviewer-')) return slug;
  throw new GateError(`имя worker'а «${slug}» начинается с «reviewer-», а этот префикс занят reviewer'ом: `
    + `его файлы в workers/ зовутся так же (reviewer-<имя>.mcp.json), и конфиг одного из двух `
    + `участников перетёрся бы молча. ${route}`);
}

function workerSlug(home, taskId, nsPath, explicit) {
  // Оба пути идут через `slugify`: адрес обязан уложиться в грамматику
  // `worker:[a-z0-9][a-z0-9-]*`; запись участника проверяет тот же инвариант ещё раз.
  if (explicit) {
    const named = slugify(explicit);
    if (!named) {
      throw new GateError(`--worker «${explicit}» не даёт имени worker'а: адрес — латиница, цифры и дефис `
        + '(`worker:<имя>`), кириллица транслитерируется, остальное отбрасывается. Возьми имя, от которого что-то остаётся.');
    }
    // Слаг задачи урезать можно (он не адрес), имя worker'а — нет.
    const full = slugify(explicit, Number.MAX_SAFE_INTEGER);
    if (named !== full) {
      throw new GateError(`--worker «${explicit}» длиннее ${SLUG_MAX} значимых символов: адрес стал бы `
        + `«${workerAddress(named)}», а хвост имени пропал бы молча — два разных куска работы так `
        + 'сходятся в один адрес и делят один worktree. Возьми имя короче.');
    }
    return refuseReviewerPrefix(named, 'Возьми другое --worker.');
  }
  // Урезание к авто-слагу не применяем: оно сменило бы адрес у длинных имён
  // репозиториев, а с ним ветку и каталог уже поднятых задач.
  const base = refuseReviewerPrefix(slugify(path.basename(nsPath), Number.MAX_SAFE_INTEGER) || 'repo',
    `Имя worker'а тут собрано из имени репозитория — назови кусок работы сам: --worker <имя>.`);
  if (!taskExists(home, taskId)) return base;
  const taken = new Map((readTask(home, taskId).participants ?? [])
    .map((p) => [addressOf(p), p.metadata.repo]));
  let slug = base;
  for (let i = 2; taken.has(workerAddress(slug)) && taken.get(workerAddress(slug)) !== nsPath; i += 1) {
    slug = `${base}-${i}`;
  }
  return slug;
}

// Предел машинного имени — файловый: Windows без long paths режет ПОЛНЫЙ путь по 260
// символам, а после имени каталога идёт ещё весь путь файла внутри репозитория, поэтому
// потолок заметно ниже 255. Имя bg-сессии пределу не подчиняется: у `--name` ограничений нет.
export const NAME_MAX = 100;

// Штамп задачи в ЧИТАЕМОМ имени — до минут (`t20260826-021515` → `0826-0215`): секунды
// человеку не нужны, а в машинном имени они держат однозначность каталога и ветки.
function shortStamp(stamp) {
  const m = /^t\d{4}(\d{2})(\d{2})-(\d{2})(\d{2})\d{2}$/.exec(String(stamp ?? ''));
  return m ? `${m[1]}${m[2]}-${m[3]}${m[4]}` : null;
}

// Хвост имени: штамп задачи, а у записи прежнего CLI без него — её id. Слаг и штамп — поля
// механизма, и в журнале v1 они лежат в `adapter`: собственные поля задачи там — заголовок,
// статус, владелец и участники.
function machineTail(task) {
  return task.adapter?.stamp ?? task.id;
}

function readableTail(task) {
  return shortStamp(task.adapter?.stamp) ?? machineTail(task);
}

// Машинное имя worker'а: каталог worktree и, с префиксом `worktree-`, имя ветки. Только
// `[a-z0-9-]` — `git check-ref-format` отвергает пробел. Ужимается только слаг задачи:
// остальные части имени не наши.
export function machineName(task, { slug } = {}) {
  const tail = [slug, machineTail(task)].filter(Boolean).join('-');
  const room = NAME_MAX - `promptobus-${tail}`.length - 1; // −1 на дефис после слага задачи
  const head = task.adapter?.slug ? slugify(task.adapter.slug, Math.max(0, room)) : '';
  const name = ['promptobus', head, tail].filter(Boolean).join('-');
  if (name.length > NAME_MAX) {
    throw new Error(`имя worktree длиннее ${NAME_MAX} символов (${name.length}): «${name}». `
      + 'Дальше в пути каталога не остаётся запаса под файлы репозитория внутри него (Windows без '
      + 'long paths режет полный путь по 260 символам), а ужимать нечего: слаг задачи уже снят, '
      + 'а штамп задачи — не наш. Отказ снимет имя покороче: `--worker`, если worker назван явно, '
      + `иначе имя каталога репозитория — из них двоих слаг worker'а и собран.`);
  }
  return name;
}

// Читаемое имя bg-сессии — то, что уезжает в `--name`: его читает человек со стороны, и
// в имя едет заголовок словами, а не машинный слаг. Роль стоит первым словом — обрезание
// списка по ширине терминала до неё не доходит.
const TITLE_MAX = 48;

// Заголовок для имени сессии: целые слова, без обрубка посреди слова. Невидимые знаки
// снимаются — `\s` в замене ниже накрывает только пробельные, а поиск сессии идёт сверкой
// имени: разойдись байты на один невидимый знак, совпадения не будет никогда, и диагноз
// не поставить. Меняем на пробел, а не выбрасываем: склеенные слова читаются хуже.
const INVISIBLE_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export function shortTitle(title, max = TITLE_MAX) {
  const t = String(title ?? '').replace(INVISIBLE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = cut.lastIndexOf(' ');
  return `${(stop > max / 2 ? cut.slice(0, stop) : cut).replace(/[\s,.:;—-]+$/, '')}…`;
}

// Первая линия собранного заголовка задачи. Стоит рядом со своим единственным
// потребителем: между чужим комментарием и его функцией она читается как шапка к чужому коду.
function firstLine(title) {
  return String(title ?? '').split(TASK_TITLE_SEP)[0].trim() || title;
}

// `taken` — имена участников из журнала: слаг попадает в имя ТОЛЬКО при совпадении
// заголовков (имя живой сессии не переименовать, `--name` действует лишь на подъём).
// `title` — заголовок КУСКА работы, иначе сессии одной задачи в `claude agents` не
// различить; не задан — берётся заголовок задачи.
export function sessionName(task, { slug, reviewer = false, taken = [], title } = {}) {
  const head = reviewer ? 'Review:' : 'Worker:';
  // Фолбэк берёт из заголовка задачи ПЕРВУЮ линию, а не всё целиком: заголовок задачи
  // перечисляет track'ы run'а, и в имя сессии уехало бы «Review: A · B · C…» обрезком.
  const label = shortTitle(title ?? firstLine(task.title)) || task.adapter?.slug || slug || 'задача';
  const stamp = readableTail(task);
  const name = `${head} ${label} (${stamp})`;
  if (!taken.includes(name)) return name;
  return `${head} ${label} (${stamp}, ${slug})`;
}

function buildPrompt({ taskId, nsPath, brief, rules, branch, driver, host }) {
  // Имена инструментов шины — написанием ЭТОГО harness'а: участник ищет их по
  // тому имени, которое ему назвали, и чужое написание оставляет его без шины вовсе.
  const bus = (name) => toolName(driver, PROMPTOBUS_SERVER, name);
  return `${host.workerPreamble({ taskId, nsPath, branch })}${host.liveRunNote(nsPath)}

Оркестратор — отдельная сессия Claude Code, она держит задачу целиком. Связь с ней — инструменты MCP-сервера ${PROMPTOBUS_SERVER} (он уже подключён к этой сессии): ${bus('promptobus_send')}, ${bus('promptobus_mailbox')}, ${bus('promptobus_task')}.

## Задание

${brief}

## Прочитай правила до работы

${rules.map((f) => `- ${f}`).join('\n')}

Первым делом прочитай эти файлы и перечисли их в первом ответе. Дальше работай по ним.

## Память команд

${memoryRule(driver, host)}

## Протокол связи

1. Взял задание в работу — сразу ${bus('promptobus_send')} {to:"orchestrator", type:"status", body:"что понял и как собираешься делать"}.
2. Дальше шли status на каждом заметном шаге: план готов, правки внесены, тесты прогнаны. Молчащий worker для оркестратора неотличим от зависшего. Запускаешь фоновую работу дольше пары минут (серия прогонов, длинная сборка, долгий замер) — status с её содержанием и оценкой срока («серия из трёх прогонов, ~9 минут») уходит ДО того, как ты завершишь ход: иначе сессия стоит молча, и по ней не отличить идущую работу от зависшей. Срок называй объёмом и замером, а не ощущением.
3. Ждать сообщение (ответ, замечания ревью) — просто заверши ход. Ждать нечем и не надо: mailbox'ы задачи слушает надзиратель шины, и он же будит тебя postcard'ом, когда тебе пишут. В postcard'е идёт текст коротких сообщений, но прочитанными их делает только mailbox — забери его первым делом, даже если из postcard'а всё понятно.
4. Уперся в вопрос, без ответа на который не продолжить, — ${bus('promptobus_send')} {to:"orchestrator", type:"question", body:"вопрос"} и заверши ход. Ответ (type=answer) придёт postcard'ом надзирателя, как в пункте 3. Не угадывай и не решай за пользователя.
5. Нужен контекст из другого репозитория (контракт события, схема, сигнатура) — спроси оркестратора тем же question: он возьмёт это у другого worker'а. Сам в чужой репозиторий не пиши.
6. Закончил — СНАЧАЛА забери mailbox, потом отправляй result. Пока ты работал, оркестратор мог расширить или сузить run, и result, посланный мимо непрочитанного, стоит всем круга впустую. Пришло что-то новое — доделай, забери mailbox ещё раз, и так пока входящих нет: пока ты доделываешь, оркестратор мог прислать ещё. Пусто — шли ${bus('promptobus_send')} {to:"orchestrator", type:"result", body:"итог + список изменённых файлов"} и заверши ход. Оркестратор прогонит изолированное ревью и пришлёт замечания сообщением type=review — придут они тем же postcard'ом: почини и отправь result снова. Замечаний нет — работа сдана.
7. Файл для передачи (дифф, выгрузка, схема) отправляй ${bus('promptobus_send')} с artifactPath — абсолютным путём; он уедет в папку артефактов задачи.
8. Задание — источник явных просьб, а не пожеланий: просит закоммитить в свою ветку — коммить сразу, отдельного подтверждения на шине не жди. Под запретом остаётся то, чего задание не отменяет: пуш и любые правки основного дерева репозитория. Ветки своей волей не двигай: оркестратор забирает результат по ветке этого worktree. Задание прямо просит другую ветку — заведи её, но тем же ходом скажи оркестратору status'ом, какая ветка теперь несёт результат. Молча сменённая ветка уводит его публикацию в пустоту: он опубликует ту, что завёл spawn, а она останется стоять на исходном коммите.${driver.phrases.promptRules}`;
}

// План spawn'а: всё вычислено, на диск ничего не записано. Тем же планом печатает
// --dry-run и работает реальный запуск — расхождению между ними взяться неоткуда.
export async function planSpawn(rootOrHost, opts) {
  const host = hostOf(rootOrHost);
  const root = host.workspaceRoot();
  const {
    repo, brief: briefFile, task, newTask = false, title, taskTitle: explicitTaskTitle,
  } = opts;
  if (task && newTask) {
    throw new GateError('--new-task несовместим с --task: один флаг заводит новую задачу, '
      + 'другой выбирает существующую');
  }
  const home = host.promptobusHome();
  const brief = readBrief(briefFile);

  let resolved;
  try {
    resolved = await host.resolveRepo(repo);
  } catch (e) {
    if (!(e instanceof HostResolveError)) throw e;
    throw new Error([e.message, ...e.candidates.map((c) => `    ${host.formatCandidate(c)}`)].join('\n'));
  }
  const nsPath = resolved.nsPath;
  // Гейт группы стоит до проверки клона: сперва «что назвали», потом «есть ли оно» —
  // иначе диагноз «не склонирован» о том, чего не называли.
  if (resolved.group) {
    throw new Error(`${repo} — это адрес группы (${nsPath}), а не репозиторий: worker'у нужен один. `
      + `Назови репозиторий: --repo ${nsPath}/<имя>. `
      + `Нужна вся группа на диске — её забирает clone, а не spawn: ${host.formatNpx(['clone', repo])}`);
  }
  const repoAbs = host.repoAbsPath(nsPath);
  // Клон, а не просто каталог: под `repos/` лежат и каталоги групп без своего `.git`, и
  // `git` внутри такого ответил бы про workspace. Признак тот же, что у резолвера и `fresh`.
  if (!host.isClone(repoAbs)) {
    throw new Error(`${nsPath} не склонирован — worker'у негде работать: ${host.cloneHint(nsPath)}`);
  }

  const active = activeTasks(home);
  // Порядок тот же, что у `resolveTaskId` (явный `--task`, привязка сессии, единственная
  // активная), а резолв свой: `--new-task`, отсутствие активных и неоднозначность без
  // привязки означают заведение новой.
  const bound = boundTaskId(home);
  if (newTask && bound) {
    throw new GateError(`--new-task не заводит второй run из сессии, привязанной к активной задаче ${bound}: `
      + `закончи текущий run (${host.busCommand(['done', `--task ${bound}`])}) либо запусти spawn из другой сессии`);
  }
  const existing = newTask ? null : (task ?? bound ?? (active.length === 1 ? active[0].id : null));
  if (task && !taskExists(home, task)) throw new GateError(`задачи ${task} нет`);
  if (task && readTask(home, task).status === 'done') {
    throw new GateError(`задача ${task} закрыта — поднятого в ней worker'а не видит никто: `
      + '`promptobus status` перечисляет активные, а уборка `promptobus done` метёт каталоги worktree всех закрытых задач, '
      + 'то есть следующее закрытие снимет worktree из-под живой сессии. '
      + `Новый run поднимается spawn'ом БЕЗ --task — он заведёт задачу сам; `
      + 'продолжать работу в закрытой задаче нечем: обратного хода у promptobus done нет.');
  }
  // Подсадка в ЧУЖУЮ задачу: без `--task` spawn садится в единственную активную, и
  // оригиналы сообщений его worker'а уходили бы владельцу чужого mailbox'а. Условие — то
  // же `ownership`, что у всего гейта владельца; явный `--task` гейта не знает.
  if (!task && existing) {
    const own = ownership(home, existing, ORCHESTRATOR, sessionIdentity());
    if (own.gated) {
      throw new GateError(`${foreignTaskLine(readTask(home, existing), own)}: `
        + `spawn без --task подсадил бы worker'а в чужой run, и сообщения его track'а ушли бы чужому оркестратору. `
        + `Вход осознанный — подсаживайся явным --task ${existing}. `
        + `${claimRoute('spawn')} `
        + 'Нужен отдельный run — повтори spawn с --new-task. '
        + 'Ни один маршрут не подходит — run заканчивает его владелец: чужой рукой promptobus done оборвал бы живую работу.');
    }
  }
  // Заголовка два: `piece` — заголовок КУСКА работы участника (`--title`, иначе первая
  // строка брифа), из него собраны имена сессии и reviewer'а; `taskTitle` — заголовок
  // ЗАДАЧИ (`--task-title`, на заведении сильнее всего). Без флагов совпадают; дальше
  // заголовок задачи дописывается подсадкой track'ов.
  const piece = title ?? titleFromBrief(brief);
  const taskTitle = explicitTaskTitle ?? piece;
  const identity = newTaskIdentity(slugify(opts.slug ?? taskTitle) || 'task');
  const taskId = existing ?? identity.id;
  // Форма плана — журнальная, та же, какую отдаёт `readTask`: слаг, штамп и пометка явного
  // заголовка лежат в `adapter`, собственные поля задачи — заголовок, статус и участники.
  const createNew = existing ? null : {
    id: taskId,
    title: taskTitle,
    status: 'active',
    adapter: {
      ...(identity.slug ? { slug: identity.slug } : {}),
      ...(identity.stamp ? { stamp: identity.stamp } : {}),
      ...(explicitTaskTitle ? { titleExplicit: true } : {}),
    },
    participants: [],
  };
  // Имя сессии собирается из журнала: у новой задачи — из плана создания, у существующей
  // — из её task.json.
  const taskMeta = createNew ?? readTask(home, taskId);

  const slug = workerSlug(home, taskId, nsPath, opts.worker);
  const address = workerAddress(slug);
  // Имени две строки: `name` — человеку в `claude agents`, `worktreeName` — машине; обе
  // уезжают в журнал задачи.
  const participant = participantOf(taskMeta, address);
  // Driver берётся из registry ДО всякой записи в журнал и до разбора опций: неизвестный
  // harness обязан отказать здесь, а не после того, как участник лёг в задачу, а допустимые
  // значения `--effort`, `--permission-mode` и `--model` — его словарь. У НОВОГО участника
  // harness называет человек флагом `--harness`, без флага берётся прежний; у
  // переподнимаемого — тот, которым его подняли, и берётся он из его записи.
  const driver = participant ? driverOf(participant) : liftHarness(host, opts.harness);
  // Перезапуск чужим harness'ом — отказ, а не тихая подмена: сессия участника уже заведена
  // в другом инструменте, его worktree и ветка остались за ней, а запись задачи назвала бы
  // один harness при сессии другого.
  if (participant && opts.harness && opts.harness !== driver.id) {
    throw new GateError(`${address} в задаче ${taskId} поднят harness'ом ${driver.id}, а --harness просит `
      + `${opts.harness}: повторный spawn перезапускает УЖЕ ЗАВЕДЁННОГО участника, и сменить ему инструмент `
      + `на ходу нечем — за ним остались его worktree и ветка. Второму инструменту возьми другое имя: --worker <имя>.`);
  }
  // Поля механизма лежат в `metadata` записи v1; собственные поля v1 — роль, harness,
  // режим, session reference и снимок capabilities.
  const was = participant?.metadata ?? {};
  // Явное имя, занятое worker'ом ДРУГОГО репозитория: участник из журнала отдал бы свой
  // worktree. Автоматический слаг такую коллизию разводит номером, явный — нет.
  if (opts.worker && was.repo && was.repo !== nsPath) {
    throw new Error(`${address} в задаче ${taskId} — worker репозитория ${was.repo}, `
      + `а spawn идёт в ${nsPath}. Имя worker'а в задаче одно на всех: возьми другое --worker.`);
  }
  // Spawn адресом живого участника — отказ: повторный spawn штатно перезапускает УМЕРШЕГО
  // в его worktree и ветке, а на живом увёл бы второго worker'а в чужую работу. Только на
  // `alive`: неизвестность не повод запрещать.
  if (participant) {
    // Шов для тестов: дефолт `participantSession` срабатывает ровно на undefined, а
    // `sessions: null` («вывод claude agents не разобран») доезжает как есть.
    if (participantSession(participant, opts.sessions) === 'alive') {
      throw new Error(`в задаче ${taskId} уже работает ${address}: сессия «${was.name}» жива. `
        + `Повторный spawn этим адресом перезапустил бы её в том же worktree (${was.worktree}) `
        + 'и той же ветке. '
        + (opts.worker
          ? 'Второму куску работы возьми другое --worker.'
          : 'Второй кусок работы в этом же репозитории поднимается своим именем: --worker <имя>.')
        + ` Нужен именно перезапуск — сначала закрой сессию: ${driver.phrases.stop('<id>')}.`);
    }
  }
  // Заголовок куска работы — из НОВОГО брифа, и для существующего адреса тоже:
  // повторный spawn кладёт запись участника целиком заново, и старый заголовок в ней
  // пережил бы новое задание — сессия звалась бы чужой работой. Старый заголовок в живой
  // записи не хранится: история работы адреса — в журнале сообщений задачи. Reviewer'а
  // это не переименовывает: имя уже поднятого берётся из его собственной записи
  // ([review.js](review.js)), а новый и должен зваться по новому куску.
  const workTitle = piece;
  // Заголовок существующей задачи: `--task-title` пришпиливает его насмерть, иначе
  // подсадка НОВОГО track'а дописывает свой заголовок к прежним. Решает `retitleTask` под
  // локом: здесь только намерение и предсказание для печати `--dry-run`.
  let retitle = null;
  let titleKept = null;
  if (existing) {
    if (explicitTaskTitle) {
      // Разошедшийся заголовок пришпиленной задачи перештамповывается только по двойной
      // явности: `--task-title` плюс явный `--task`, право — у владельца mailbox'а. Одной
      // явности мало: без `--task` spawn садится в единственную активную.
      if (taskMeta.adapter.titleExplicit) {
        if (taskMeta.title !== explicitTaskTitle) {
          // Сюда `own.gated` доходит только с явным `--task` — гейт выше отбил spawn без него.
          const own = ownership(home, taskId, ORCHESTRATOR, sessionIdentity());
          if (task && !own.gated) {
            retitle = { title: explicitTaskTitle, explicit: true, restamp: true, session: own.session };
          } else {
            titleKept = `задача ${taskId}: заголовок задачи уже задан явно («${taskMeta.title}»), --task-title проигнорирован. `
              + (own.gated
                ? `Перештамповать его может владелец mailbox'а: ${foreignTaskLine(taskMeta, own)}. ${claimRoute('spawn')}`
                : `Перештамповка требует двойной явности — повтори spawn с --task ${taskId}.`);
          }
        }
      } else {
        retitle = { title: explicitTaskTitle, explicit: true };
      }
    } else if (!taskMeta.adapter.titleExplicit && (!participant || (was.title && was.title !== workTitle))) {
      // Пересчёт — там, где строка ЭТОГО адреса в заголовке задачи изменилась: новый track
      // или перезапуск с другим брифом. Два случая он этим и обходит. Штатный
      // перезапуск тем же брифом: `applyParticipant` кладёт переписанную запись в КОНЕЦ
      // списка, а `titleFromLines` читает по порядку — задача из трёх track'ов
      // переименовалась бы из «A · B · C» в «B · C · A» на ровном месте. И запись прежнего
      // CLI, у которой поля `title` нет вовсе: сборка взяла бы заголовки только тех, у кого
      // оно есть, то есть подменила бы заголовок задачи заголовком одного куска — ровно та
      // беда, от которой уходила .
      //
      // `preview`, а не `title`: предсказание для печати `--dry-run`. Положи его в
      // `title`, и пересчёт под локом умрёт на `??`, а гонка вернётся молча.
      // Прежняя запись этого адреса из сборки выброшена: под локом её уже перетёрла
      // новая, и предсказание с обеими строками разошлось бы с живым прогоном.
      // Строка при этом уезжает в конец перечня — там же её увидит и пересчёт под локом.
      const lines = titleFromLines({
        participants: [
          ...(taskMeta.participants ?? []).filter((p) => addressOf(p) !== address),
          { metadata: { address, title: workTitle } },
        ],
      });
      if (lines && lines !== taskMeta.title) retitle = { fromLines: true, preview: lines, explicit: false };
    }
  }
  // Имя сессии пересчитывается и для существующего адреса: живого участника
  // spawn отбил выше, а мёртвому поднимается НОВАЯ сессия — под именем из нового брифа.
  // Своё прежнее имя из `taken` выброшено: иначе повтор с тем же брифом упирался бы в
  // самого себя и приписывал слаг worker'а к имени на ровном месте.
  const name = sessionName(taskMeta, {
    slug,
    title: workTitle,
    taken: (taskMeta.participants ?? []).filter((p) => addressOf(p) !== address)
      .map((p) => p.metadata.name).filter(Boolean),
  });
  // Машинное имя записанного участника берётся из журнала: пересчёт увёл бы перезапуск в
  // новую ветку. У старой записи поля `worktreeName` нет — имя даёт каталог worktree.
  const known = was.worktreeName ?? (was.worktree ? path.basename(was.worktree) : null);
  const wtName = known ?? machineName(taskMeta, { slug });
  const worktreePath = path.join(repoAbs, WORKTREE_DIR_REL, wtName);
  const branch = `${WORKTREE_BRANCH_PREFIX}${wtName}`;
  // Каталог занят, а участника в журнале нет: имя совпало с чужим — отказываем громко.
  if (!known && existsSync(worktreePath)) {
    throw new Error(`${worktreePath}: каталог worktree уже занят, а в журнале задачи ${taskId} этого worker'а нет — `
      + 'имя совпало с чужим, и worker сел бы в чужое рабочее дерево, на чужую ветку. '
      + `Забери или удали работу прежнего worker'а (git -C ${shellQuote(repoAbs)} worktree remove ${shellQuote(worktreePath)}), `
      + `либо возьми этому worker'у другое имя: --worker <имя>.`);
  }
  // База нового worktree — ЛОКАЛЬНАЯ default-ветка: незапушенные коммиты человека worker
  // обязан видеть. Порядок предпочтения даёт `defaultRefs` — та же лесенка, которой
  // сверяется уборка.
  const base = defaultRefs(repoAbs, host.defaultBranch(repoAbs))[0] ?? 'HEAD';
  // Модель без флага — умолчание driver'а: имя модели принадлежит harness'у
  // целиком, и `opus` Claude Code второй бинарь отвергает как любой неизвестный id.
  const model = opts.model ?? driver.options.defaultModel;
  const effort = resolveEffort(opts.effort, driver);
  const permissionMode = resolvePermissionMode(opts.permissionMode, driver);
  // Файл настроек участника кладёт driver: его форма — контракт harness'а. Сюда приходит
  // только команда сторожа цикла и ключи рабочего места, адресованные
  // участнику. Того, что стоит в настройках самого рабочего места, участнику не досталось
  // бы: его cwd — worktree клона, а не корень workspace. Команда та же, что у оркестратора,
  // — абсолютные node и бинарь рабочего места, из любого cwd она резолвится.
  const settingsPath = participantSettingsPath(home, taskId, address);
  const guardCommand = guardHookCommand(host, { address, taskId, home }, process.platform);
  // Каталог скиллов рабочим местом берёт не всякий harness: у Claude Code это флаг на один
  // подъём (`--plugin-dir`). У Cursor канон едет файлами `.cursor/skills` — их в worktree
  // кладёт сам driver из корня рабочего места. Не берёт плагин — не считаем его и не
  // предупреждаем об отсутствии: предупреждение о ненужном читается как поломка.
  const pluginDirPath = driver.options.skillsDir ? participantPluginDir(host) : null;
  const env = sessionEnv(driver, process.env, host);
  const mcpConfigPath = participantMcpPath(home, taskId, address);
  const mcp = participantMcp(host, { address, taskId, home }, driver);

  const collected = host.collectRules(repoAbs);
  const module = host.moduleNote(repoAbs);
  // AGENTS.md репозитория worker читает в своей копии: основное дерево не попадает в
  // --add-dir и остаётся недоступным на запись — ровно как обещает промпт.
  const rules = collected.map((f) => (f.startsWith(repoAbs + path.sep)
    ? path.join(worktreePath, path.relative(repoAbs, f))
    : f));
  // Чтение вне рабочей директории Claude Code спрашивает разрешением: без --add-dir
  // worker встал бы на первом же «прочитай эти файлы». Режим прав ни при чём — он про
  // то, что можно делать, а не куда видно.
  const ruleDirs = [...new Set(rules
    .filter((f) => !f.startsWith(worktreePath + path.sep))
    .map((f) => path.dirname(f)))];
  const prompt = buildPrompt({ taskId, nsPath, brief, rules, branch, driver, host });
  // План подъёма собирает driver: перевод harness-neutral контекста в argv, конфиг и файл
  // настроек — его дело, и вариадические опции бинаря, из-за которых
  // промпт стоит последним, знает он же. Модель — opus по умолчанию: дефолт сессии
  // пользователя может быть дороже. Режим прав — auto по умолчанию, а не acceptEdits:
  // acceptEdits снимает вопросы только с правок файлов, а рядовую Bash-команду спрашивает
  // каждую — фоновый worker встал бы на первой же. Флаг `--permission-mode` переопределяет
  // его на один spawn: track'у со стендом вне worktree auto иначе спрашивал бы
  // человека на каждой новой форме команды.
  const launch = driver.prepare({
    ref: name,
    address,
    task: taskId,
    home,
    role: 'worker',
    mcp: mcp.descriptor,
    prompt,
    cwd: worktreePath,
    model,
    effort,
    permissionMode,
    addDirs: ruleDirs,
    pluginDir: pluginDirPath,
    mcpConfigPath,
    settingsPath,
    guardCommand,
    extraSettings: skillSettings(host),
    root,
  });

  return {
    home, taskId, createNew, slug, address, nsPath, repoAbs, via: resolved.via,
    name, workTitle, wtName, worktreePath, branch, base, model, effort, permissionMode,
    settingsPath, guardCommand, pluginDir: pluginDirPath,
    mcpConfigPath, mcpNote: mcpNote(mcp, 'участника'), retitle, titleKept, driver,
    launch, argv: launch.argv, mcpConfig: launch.mcpConfig, settings: launch.settings,
    rules, ruleDirs, module, prompt, env, host,
    // Записанная точка ветвления не пересчитывается: у ветки, на которой worker уже
    // работал, HEAD точкой ветвления не является. У записи прежнего CLI поля нет.
    knownBaseSha: was.baseSha ?? null,
    // Сессия поднимается прямо в рабочем дереве worker'а: каталог заводит spawn.
    cwd: worktreePath,
  };
}

/**
 * Строка о скиллах рабочего места. Четыре исхода: каталог плагина подключён, плагина нет,
 * harness плагин не берёт, и harness сам сказал, откуда скиллы (копия файлов, не флаг).
 * Свою строку driver кладёт в план — иначе Cursor звучал бы «не подключены», уже получив
 * канон в `.cursor/skills` worktree.
 */
export function skillsNote(plan) {
  if (plan.launch?.skillsNote) return plan.launch.skillsNote;
  if (plan.pluginDir) return plan.pluginDir;
  if (!plan.driver.options.skillsDir) {
    return `не подключены — ${plan.driver.options.tool} не читает плагин скиллов Claude Code`;
  }
  return 'не подключены — каталога плагина нет';
}

// Положение дел по модулю собирается один раз в плане, а печатается дважды.
export function sayModule(plan) {
  (plan.module.level === 'warn' ? warn : info)(plan.module.text);
}

// Исход установки в только что заведённый worktree. Нет lock'а — `ran: false`, строки нет.
// Отказ — предупреждение с командой, не `fail`: spawn участника от этого не откатывается.
export function sayWorktreeDeps(result) {
  if (!result?.ran) return;
  const dur = `${(result.ms / 1000).toFixed(1)} с`;
  if (result.ok) {
    ok(`зависимости worktree поставлены (npm ci, ${dur})`);
  } else {
    const log = result.logPath ? ` · лог ${result.logPath}` : '';
    warn(`зависимости worktree не поставлены: npm ci ${result.why} — worker сделает сам: ${result.command}${log}`);
  }
  if (result.ignored === false) {
    warn('node_modules в worktree git не игнорирует — каталог останется грязным, done его не уберёт');
  }
}

// Строка о стороже цикла в `--dry-run`: файл настроек участника и идентичность, с которой
// его хук будет звать шину. Печатается обеими командами подъёма — `--dry-run` обязан
// показывать то, что уедет на диск, а идентичность участника уезжает именно сюда.
export function guardHookNote(plan) {
  return `настройки участника: ${plan.settingsPath} · сторож цикла: ${plan.guardCommand}`;
}

// Строка об окружении участника в `--dry-run` — рядом с самой сборкой окружения. Идентичность
// в ней больше не называется: в окружении сессии её нет, она стоит аргументами команды
// Stop-хука в файле настроек, и печатает её строка о самом файле.
export function sessionEnvNote(driver, host) {
  const extra = host.extraEnv();
  return `окружение сессии: ${Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(' ')}`
    + ' — гейт памяти не держит фоновую сессию; '
    + `снято от предка: ${driver.options.envDrop.join(', ')} — эти переменные протекают чужими значениями`;
}

// Чем `--dry-run` объясняет молчание о версии бинаря — одними словами у spawn'а и ревью.
// Имя бинаря называет driver: своего у команды нет.
export function dryRunToolNote(driver) {
  return `версия не проверялась: dry-run — ${driver.options.tool} --version не запускается,`
    + ' бинарь резолвится на реальном прогоне';
}

// О бинаре — только когда есть что сказать. `reason: false` — для реального прогона, где
// следом идёт `fail(tool.reason)`: тот же текст предупреждением и отказом подряд
// читается как две разные беды.
export function sayTool(tool, { reason = true } = {}) {
  if (tool.note) info(tool.note);
  if (tool.warn) warn(tool.warn);
  if (!tool.ok && reason) warn(tool.reason);
}

export async function spawn(rootOrHost, opts) {
  const plan = await planSpawn(rootOrHost, opts);
  // До ветки `--dry-run`: о проигнорированном --task-title узнают и вхолостую.
  if (plan.titleKept) warn(plan.titleKept);

  if (opts.dryRun) {
    info(`репозиторий: ${plan.nsPath} (источник: ${plan.via}) → ${plan.repoAbs}`);
    info(`задача: ${plan.taskId}${plan.createNew ? ` (будет создана: ${plan.createNew.title})` : ''}`
      + `${plan.retitle ? ` (будет переименована: ${plan.retitle.preview ?? plan.retitle.title})` : ''}`);
    info(`адрес worker'а: ${plan.address} · сессия: «${plan.name}» · модель: ${plan.model}${plan.effort ? ` · effort: ${plan.effort}` : ''}${plan.permissionMode !== plan.driver.options.defaultPermissionMode ? ` · режим прав: ${plan.permissionMode}` : ''}${opts.harness ? ` · harness: ${plan.driver.id}` : ''}`);
    info(`worktree: ${plan.worktreePath} (ветка ${plan.branch}, от ${plan.base})`);
    // Каталога ещё нет — смотрим lock в клоне: после `worktree add` он окажется в корне.
    // Каталог уже есть (перезапуск) — установки не будет, и намерения нет.
    if (!existsSync(plan.worktreePath) && worktreeHasLock(plan.repoAbs)) {
      info(`зависимости worktree: ${npmCiCommand()}`);
    }
    info(`mcp-config: ${plan.mcpConfigPath}`);
    info(guardHookNote(plan));
    info(sessionEnvNote(plan.driver, plan.host));
    // Чего в этом выводе НЕТ и почему: у harness'а, который придумывает имя
    // сессии сам, заранее его не напечатать, и молчание об этом читалось бы как пропуск.
    if (plan.driver.phrases.naming) info(`имя сессии у harness'а: ${plan.driver.phrases.naming}`);
    info(`MCP участника (${plan.mcpConfig.mcpServers ? Object.keys(plan.mcpConfig.mcpServers).length : 0}):`);
    for (const line of mcpServerLines(plan.mcpConfig)) console.log(`  ${line}`);
    sayMcp(plan, { hint: false });
    info(`скиллы workspace: ${skillsNote(plan)}`);
    info(`правила worker'а:`);
    for (const f of plan.rules) console.log(`  ${f}`);
    sayModule(plan);
    // Версию бинаря в `--dry-run` не спрашиваем: резолв запускает `claude --version`
    // (~200 мс процесса) за ответ, который здесь ни на что не влияет.
    info(dryRunToolNote(plan.driver));
    info('команда:');
    console.log(`  cd ${shellQuote(plan.cwd)} && ${plan.driver.options.tool} ${plan.argv.slice(0, -1).map(shellQuote).join(' ')} <промпт>`);
    info('промпт:');
    console.log(plan.prompt);
    ok('dry-run: на диск ничего не записано, worker не запущен');
    return plan;
  }

  // Бинарь резолвится ЗДЕСЬ, а не в плане: резолв запускает процесс, а план обещает, что
  // ничего не делает. Имя бинаря называет driver — своего у команды нет. `opts.tool` — шов
  // для теста.
  const tool = opts.tool ?? plan.host.resolveToolBin(plan.driver.options.tool);

  // Отказ по бинарю — ДО первой записи на диск: иначе оставались бы worktree, ветка и
  // запись участника. `sayTool` стоит ДО отказа: у ветки «версия младше» есть `note` про
  // каталог найденного бинаря — иначе человек обновит не тот бинарь.
  sayTool(tool, { reason: false });
  if (!tool.ok) fail(tool.reason);
  const ultra = optionRefusal(plan.driver, plan.effort, tool);
  if (ultra) fail(ultra);

  // Перечня правил на реальном прогоне нет: набор, с которым поднимается участник,
  // объявляется этими двумя строками.
  sayModule(plan);
  sayMcp(plan);

  // Исключение worktree идёт ПЕРВЫМ, до freshenRepo: неисключённый каталог прошлого
  // worker'а читается как незакоммиченная правка, а freshenRepo намеренно не трогает
  // грязное дерево — default-ветка не подтянулась бы.
  const excluded = excludeWorktrees(plan.repoAbs);
  if (excluded.status === 'added') {
    info(`${plan.nsPath}: служебные worktree исключены из git status (.git/info/exclude) — иначе клон навсегда грязный`);
  } else if (excluded.status === 'failed') {
    warn(`${plan.nsPath}: служебные worktree НЕ исключены из git status (${excluded.error}) — клон останется`
      + ' грязным, и fresh перестанет подтягивать его default-ветку. Допиши строку сам:'
      + ' **/.claude/worktrees/ в .git/info/exclude');
  }

  plan.host.reportFresh(plan.host.freshenRepo(plan.repoAbs), plan.nsPath);

  // Точка ветвления worktree — в журнал задачи: от неё `promptobus review` считает дифф.
  // Считает её git в момент создания ветки, а не план: план собран ДО freshenRepo, и sha
  // из него разошёлся бы с настоящим на подтянутые коммиты.
  let baseSha = plan.knownBaseSha;
  // Каталог уже существует — штатный перезапуск умершего worker'а: продолжаем в его дереве.
  // Установка зависимостей — после записи участника: иначе Ctrl+C на длинном `npm ci`
  // оставляет каталог без строки в журнале, и повтор упирается в «каталог занят».
  let freshWorktree = false;
  if (!existsSync(plan.worktreePath)) {
    const made = createWorktree(plan.repoAbs, plan.worktreePath, plan.branch, plan.base);
    if (!made.created) fail(`git worktree add: ${made.error} — worker'у негде работать`);
    if (made.reused) ok(`worktree ${plan.wtName} заведён на уцелевшей ветке ${plan.branch} — работа прошлого worker'а на месте`);
    else ok(`worktree ${plan.wtName} заведён от ${plan.base} (ветка ${plan.branch})`);
    baseSha ??= made.baseSha;
    freshWorktree = true;
  }

  if (plan.createNew) {
    createTask(plan.home, plan.createNew);
    ok(`задача ${plan.taskId}: ${plan.createNew.title}`);
  }
  // Привязка «сессия → задача»: `promptobus spawn` запускается Bash'ем из сессии
  // оркестратора и наследует её идентичность. Пишется только владельцу задачи.
  bindIfOwner(plan.home, plan.taskId);
  writeLaunchFiles(plan.launch.files);

  // Участник ложится в журнал ДО установки зависимостей и запуска `claude`: ветки
  // отказа уносят процесс через `fail()`, а Ctrl+C на длинном `npm ci` иначе оставляет
  // каталог без записи — повтор упирается в «каталог занят, а в журнале нет».
  // Свой каталог повтор узнаёт по `worktreeName`.
  // Запись кладёт registry: он же и отказывает — неизвестному harness'у и driver'у, не
  // умеющему поднимать сессию, — ДО того, как участник появится в журнале. Поля harness,
  // mode, sessionRef и снимок capabilities дописывает он.
  const { record } = openParticipant(plan.home, plan.taskId, participantRecord(plan.address, {
    // Harness записи — тот, которым её и поднимают. Без него registry приписал бы
    // участнику `fallback`, и вся дальнейшая работа с его сессией — состояние, гашение,
    // маршруты — пошла бы через driver ЧУЖОГО harness'а.
    harness: plan.driver.id,
    repo: plan.nsPath,
    repoAbs: plan.repoAbs,
    worktree: plan.worktreePath,
    branch: plan.branch,
    // Точка ветвления не выяснилась — поля нет вовсе, ревью остаётся на прежнем поведении.
    ...(baseSha ? { baseSha } : {}),
    model: plan.model,
    ...(plan.effort ? { effort: plan.effort } : {}),
    name: plan.name,
    sessionRef: plan.name,
    ...(plan.workTitle ? { title: plan.workTitle } : {}),
    worktreeName: plan.wtName,
    started: new Date().toISOString(),
    mechanismVersion: plan.host.version,
  }), REGISTRY);

  if (freshWorktree) {
    if (worktreeHasLock(plan.worktreePath)) {
      info(`ставлю зависимости по package-lock.json (${npmCiCommand()})`);
    }
    sayWorktreeDeps(installWorktreeDeps(plan.worktreePath));
  }

  // Заголовок задачи дописывается ПОСЛЕ записи участника и целиком под локом: сборка идёт
  // по журналу, в котором этот track уже есть.
  if (plan.retitle) {
    const named = retitleTask(plan.home, plan.taskId, plan.retitle);
    if (named) ok(`задача ${plan.taskId}: ${named}`);
    else if (plan.retitle.restamp) {
      const outcome = restampOutcome(readTask(plan.home, plan.taskId).title, plan.retitle.title);
      if (outcome.level === 'ok') ok(`задача ${plan.taskId}: ${outcome.text}`);
      else warn(`задача ${plan.taskId}: ${outcome.text}`);
    }
  }

  // Подъём идёт через driver, взятый из registry. На Windows многострочный argv переживает
  // только нативный бинарь; `claude.cmd` тянет cmd.exe, и хелпер вместо искажённой команды
  // даёт внятный отказ. Запуск и сверка «сессия поднялась» — общий с reviewer'ом
  // liftoff.js, и живёт он у driver'а.
  const { output, session, seen } = await plan.driver.spawn(plan.launch, {
    tool,
    // Адрес, задача и дом шины уезжают driver'у ВМЕСТЕ с планом: у harness'а,
    // чей канал пробуждения ведёт сам механизм, сдавать contact point'ы приходится его
    // же машинерии, а адресовать их больше нечем.
    home: plan.home,
    task: plan.taskId,
    address: plan.address,
    cwd: plan.cwd,
    env: plan.env,
    ref: plan.name,
    role: 'worker',
    launchFailNote: ` Задача ${plan.taskId} и запись участника ${plan.address} на месте: `
      + 'повтори spawn той же командой — worker сядет в свой каталог, заводить его заново не нужно.',
    deadNote: ` Задача ${plan.taskId} и запись участника ${plan.address} на месте: повтори spawn той же командой.`
      + ' Сообщений от этого адреса не будет — ждать их бессмысленно.',
    persist: (id, state, sessionId) => upsertParticipant(plan.home, plan.taskId,
      { ...record, metadata: { ...record.metadata, session: id, ...(sessionId ? { sessionId } : {}) } }),
    awaitOptions: opts.awaitOptions,
  });
  ok(`worker ${plan.address} поднят в ${plan.nsPath}, ветка ${plan.branch}${session ? ` (сессия ${session})` : ''}`);
  // Надзирателя поднимаем сразу за участником. Своего contact point'а spawn не сдаёт —
  // сдаёт её каждый участник сам, из своего процесса шины.
  ensureWarden(plan.home, plan.taskId, { host: plan.host });
  plan.driver.saidLiftoff({ name: plan.name, seen, session, output });
  return plan;
}
