import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ok, info, warn, fail, GIT_MAX_OUTPUT } from './util.js';
import { normalize } from './fuzzy.js';
import { hostOf } from './host.js';
import { guardHookCommand } from '../dist/hooks.js';
import {
  activeTasks, addressOf, bindIfOwner, claimRoute, createTask, filesDir,
  foreignTaskLine, GateError, newTaskIdentity, ownership, participantMcpPath, participantOf,
  participantRecord, participantSettingsPath, readTask, reviewerAddress, sendMessage,
  sessionIdentity, slugify, taskExists, unreadNote, upsertParticipant, watchParticipant,
  ORCHESTRATOR,
} from './store.js';
import {
  dryRunToolNote, guardHookNote, liftHarness, memoryRule, mcpNote, mcpServerLines, optionRefusal,
  participantMcp, participantPluginDir, PROMPTOBUS_SERVER, resolveEffort, resolvePermissionMode,
  sayMcp, sayModule, sayTool, sessionEnv, sessionEnvNote, sessionName, skillSettings, skillsNote,
  toolName, writeLaunchFiles,
} from './spawn.js';
import { participantSession } from './status.js';
import { hasFeature, openParticipant } from '../dist/index.js';
import { driverOf, REGISTRY } from './drivers.js';
import { ensureWarden } from './warden.js';

// Reviewer — участник шины Promptobus: фоновая сессия harness'а в директории
// ревьюируемой рабочей копии. Один reviewer на задачу и репозиторий: первый вызов
// поднимает сессию, повторный шлёт ей новый дифф тем же адресом — reviewer помнит свои
// находки. Изоляция — от контекста сессии, писавшей код, а не от кода: доступ к рабочей
// копии только на чтение, и держит его снятие инструментов у driver'а.
//
// **Read-only — не пожелание, а capability**. Harness, не умеющий
// снимать инструменты, поднял бы reviewer'а с правом записи в ревьюируемое дерево — это
// не «ревью без гарантии», а сессия, которая правит проверяемый код. Поэтому `denyTools`
// спрашивается ДО подъёма и до всякой записи на диск.

/**
 * Отказ по способности снимать инструменты. `null` — driver её объявил, поднимать можно.
 * Чистой функцией: живого driver'а без `denyTools` в карте нет, и проверить ветку иначе
 * нечем — подставной объект подаётся ей напрямую.
 */
export function denyToolsRefusal(driver) {
  if (hasFeature(driver, 'denyTools')) return null;
  return `harness «${driver.id}» не умеет снимать инструменты сессии, а изоляция reviewer'а держится `
    + 'ровно на этом: поднятый им reviewer правил бы ревьюируемое дерево, а не читал его. '
    + 'Ревью этим harness\'ом не поднимается — возьми harness, у которого объявлен denyTools.';
}

// Подсказка «как ждать отчёт». Задачу называем её id — тем, что примет `--task`: иначе
// в `--task` уезжало бы имя сессии из соседней строки вывода `claude --bg`.
function waitHint(what, taskId) {
  return `${what} придёт сообщением type=result оркестратору задачи ${taskId}: `
    + 'разбудит тебя надзиратель шины, забери входящие mailbox';
}

// План ревью: всё вычислено, на диск ничего не записано. Тем же планом печатает --dry-run
// и работает реальный запуск. Обещание — про запись и подъём, а не про внешние процессы:
// план читает git и спрашивает `claude agents --json` о живости сессии reviewer'а. Гейты
// самого запроса (пути нет, цель вне repos/) бросают, отказ от прочитанного (не-git,
// упавший git) уезжает ПОЛЕМ `{ refusal }`: `fail()` тут унёс бы юнит-тест мимо сводки.
export function planReview(rootOrHost, { target, base, task, title, model, effort: effortOpt, permissionMode: permissionOpt, harness, dryRun } = {}) {
  const host = hostOf(rootOrHost);
  // Driver ПОДЪЁМА — тот, которым человек просит поднять сессию (`--harness`).
  // Словарь его опций здесь ещё не спрашивается: у уже заведённого reviewer'а harness свой,
  // и сверять `--effort` по чужому словарю значило бы пропустить в Cursor значение Claude
  // Code (замечание ревью). Оба флага разбираются ниже, когда driver участника известен.
  const lifter = liftHarness(host, harness);
  // Обе стороны сравнения — в канонической нативной форме: git rev-parse на Windows
  // печатает C:/… с прямыми слэшами, а realpathSync снимает /var ↔ /private/var на macOS.
  // Без этого проверка префикса repos/ ложно отказывает на пути внутри workspace.
  const root = realpathSync(host.workspaceRoot());
  // Путь к репозиторию обязателен: резолва по `cwd` нет — каталог shell-сессии агента не
  // сбрасывается. Гейт стоит первым: раньше расчёта диффа, createTask и `claude --bg`.
  if (!String(target ?? '').trim()) {
    // Подсказка повторяет ФЛАГИ вызова, а не разобранные значения: разбор `--effort` стоит
    // ниже, за driver'ом участника, а гейт пути — самый первый, до всякой работы.
    throw new Error(missingTarget(host, { task, title, base, model, effort: effortOpt, harness, dryRun }));
  }
  const resolved = resolveRepoDir(target);
  if (resolved.refusal) return { refusal: resolved.refusal };
  const { targetDir, repoDir } = resolved;
  const reposRoot = host.reposRoot();
  if (!host.inWorkspace(repoDir)) {
    // Цель внутри repos/, а её git-toplevel выше: это папка группы с вложенными клонами,
    // а не клон — отказ «вне repos/» тут сбивал бы с толку.
    if (host.inWorkspace(targetDir)) {
      throw new Error(host.reviewLayoutError('not-clone', { targetDir, repoDir }));
    }
    throw new Error(host.reviewLayoutError('outside', { repoDir }));
  }
  const clone = cloneRootOf(reposRoot, repoDir);
  if (!clone) throw new Error(host.reviewLayoutError('no-clone', { repoDir }));
  const pair = clone.nsPath.split('/').length < 2
    ? host.reviewLayoutError('need-pair', { abs: clone.abs })
    : null;
  if (pair) throw new Error(pair);
  const nsPath = clone.nsPath;

  const home = host.promptobusHome();
  if (task && !taskExists(home, task)) throw new GateError(`задачи ${task} нет`);
  // Закрытая задача законным входом не является ни для кого: явный `--task` пропуском
  // не служит. Без флага подхват смотрит activeTasks и закрытую сам не выберет.
  if (task && readTask(home, task).status === 'done') {
    throw new GateError(`задача ${task} закрыта — reviewer на ней некому отчитаться: `
      + '`promptobus status` перечисляет активные, а уборка `promptobus done` метёт каталоги worktree всех закрытых задач, '
      + 'то есть следующее закрытие снимет worktree из-под живой сессии. '
      + 'Новый run — review без --task и с --title: без имени команда задачу не заведёт. '
      + 'Каталог числится worktree активной задачи — без --task подхватит её, а не заведёт новую. '
      + 'Ревью в другую живую — назови её --task, только не этот id. '
      + 'Продолжать работу в закрытой задаче нечем: обратного хода у promptobus done нет.');
  }
  // Задачу без `--task` называет сам предмет ревью: каталог числится worktree участника
  // активной задачи — берётся она (оттуда же и точка ветвления), иначе заводится своя.
  const claiming = task ? [] : claimingTasks(home, repoDir);
  if (claiming.length > 1) {
    throw new Error(`каталог числится сразу в нескольких активных задачах (${claiming.map((t) => t.id).join(', ')})`
      + ' — выбирать за человека команда не станет: назови нужную, --task <id>');
  }
  const existing = task ?? claiming[0]?.id ?? null;
  // Гейт владельца — ПОВЕРХ подхвата по каталогу: ловится каталог, числящийся в задаче,
  // чей mailbox закреплён за ДРУГОЙ сессией — иначе поднятый reviewer отчитывался бы
  // чужому оркестратору. Явный `--task` гейта не знает.
  if (!task && existing) {
    const own = ownership(home, existing, ORCHESTRATOR, sessionIdentity());
    if (own.gated) {
      throw new GateError(`каталог ${repoDir} числится worktree участника чужого run'а: `
        + `${foreignTaskLine(readTask(home, existing), own)}. Поднятый отсюда reviewer отчитается `
        + 'её оркестратору, а сюда придут копии «ЧУЖОЙ MAILBOX». '
        + `Ревью по договорённости с владельцем — назови задачу явно: --task ${existing}. `
        + `${claimRoute('promptobus review')}`);
    }
  }
  // Об остальных активных предупреждаем только там, где заводим свою.
  const otherActive = existing ? [] : activeTasks(home).map((t) => t.id);
  // Имя задачи команда не выдумывает: заводишь новую — назови её; этим именем зовётся
  // сессия. Проверяется ниже, когда известно, есть ли что ревьюить.
  const identity = existing ? null : newTaskIdentity(slugify(String(title ?? '').trim()));
  const taskId = existing ?? identity.id;
  // Форма плана — журнальная, та же, какую отдаёт `readTask`: слаг и штамп лежат в `adapter`.
  const createNew = existing ? null : {
    id: taskId,
    title: String(title ?? '').trim(),
    status: 'active',
    adapter: {
      ...(identity.slug ? { slug: identity.slug } : {}),
      ...(identity.stamp ? { stamp: identity.stamp } : {}),
    },
    participants: [],
  };
  const taskMeta = createNew ?? readTask(home, taskId);

  // Чей это предмет ревью: каталог, числящийся worktree участника, ревьюится ЗА него — от
  // него идут адрес reviewer'а и база диффа; у основного клона владельца нет.
  const titleIgnored = !!(existing && String(title ?? '').trim());
  const owner = worktreeOwner(taskMeta, repoDir);
  // Поля механизма — в `metadata` записи v1: адрес, точка ветвления и заголовок куска.
  const ownerFields = owner?.metadata ?? {};
  const ownerAddress = owner ? addressOf(owner) : null;
  // Слаг reviewer'а — из предмета ревью, а не из корня клона: у нескольких worker'ов
  // одного репозитория `basename` давал бы один адрес, и ревью второго ушло бы живому
  // reviewer'у первого как переревью. Флага нет намеренно.
  const slug = (owner ? addressSlug(ownerAddress) : normalize(path.basename(clone.abs))) || 'repo';
  const address = reviewerAddress(slug);

  // База диффа: `--base` сильнее всего; за ним точка ветвления, записанная spawn'ом; и
  // только потом догадка по default-ветке — удалённая её версия не содержит незапушенной
  // работы оркестратора, и та попадала бы в дифф каждого worker'а. Записанной точке верим
  // не на слово: ветку могли перебазировать, а коммита в клоне может не быть — сперва она
  // сверяется с историей HEAD. Второй кусок работы на той же ветке требует влить
  // default-ветку, и записанная точка уходит назад, оставаясь предком HEAD, — поэтому база
  // считается на момент ревью, `merge-base` с ЛОКАЛЬНОЙ default-веткой.
  const isWorktree = repoDir !== clone.abs;
  const recorded = base ? null : ancestorOfHead(repoDir, ownerFields.baseSha);
  // Основной клон считается от default-ветки по-прежнему: merge-base с самим собой дал
  // бы HEAD и пустой дифф, а ревью незапушенной работы оркестратора — законный ход.
  const defBranch = base || !isWorktree ? null : localDefault(repoDir, host);
  const computed = defBranch ? mergeBase(repoDir, defBranch) : null;
  // Посчитанная база хуже записанной в двух случаях: default-ветку переписали (merge-base
  // уходит НАЗАД к общему предку; признак — записанная точка не предок посчитанной) и
  // ветку worker'а уже слили (merge-base равен HEAD, дифф пуст).
  const head = headOf(repoDir);
  // Совпадения с HEAD мало: у свежего worktree HEAD равен вершине default-ветки, и
  // записанная точка равна им обоим — «работа уже влита» там было бы неправдой.
  const mergedIntoDefault = !!computed && !!head && computed === head && computed !== recorded;
  const rewound = !!computed && !!recorded && computed !== recorded && !isAncestor(repoDir, recorded, computed);
  const live = (mergedIntoDefault || rewound) && recorded ? null : computed;
  let baseRef;
  let baseSource;
  if (base) {
    baseRef = base;
    baseSource = 'задана флагом --base';
  } else if (live) {
    baseRef = live;
    // Расхождение записанной и посчитанной баз называется вслух той же строкой: съезд
    // базы видно по ней, а не по размеру диффа.
    baseSource = recorded === live ? `точка ветвления worktree ${ownerAddress}`
      : recorded ? `merge-base с ${defBranch} на момент ревью; записанная точка ${recorded} осталась позади — ${defBranch} влита в ветку worker'а`
        : `merge-base с ${defBranch} на момент ревью`;
  } else if (recorded) {
    baseRef = recorded;
    baseSource = mergedIntoDefault
      ? `точка ветвления worktree ${ownerAddress}; работа уже влита в ${defBranch}`
      : rewound
        ? `точка ветвления worktree ${ownerAddress}; ${defBranch} переписана, merge-base с ней ушёл назад`
        : `точка ветвления worktree ${ownerAddress}`;
  } else {
    baseRef = detectBase(repoDir);
    baseSource = 'default-ветка репозитория';
  }
  // База называется вслух — одной строкой на вывод команды, промпт и сообщение переревью.
  const baseLine = baseRef
    ? `база диффа: ${baseRef} (${baseSource})`
    : 'база диффа: не определена — ревьюится только незакоммиченное';
  // Гейт механический: условие смотрит на ИСТОЧНИК базы, а не на набор полей в записи —
  // запись с worktree, но без baseSha иначе проваливалась мимо обоих условий.
  const warnings = [];
  // Пустой дифф на слитой ветке и на нетронутой выглядят одинаково: после слияния
  // default-ветка указывает на ту же вершину. Команда называет факт, а не догадку.
  if (isWorktree && !base && mergedIntoDefault && !recorded) {
    warnings.push(`HEAD этой ветки совпадает с ${defBranch}: работы поверх неё нет — `
      + 'worker либо ещё ничего не закоммитил, либо его ветку уже влили. '
      + 'Ревьюить прошлую работу — задай --base <sha точки ветвления>');
  }
  if (isWorktree && !base && !live && !recorded) {
    const why = !owner
      ? (task ? `в журнале задачи ${task} он ни за кем не числится`
        : 'ни в одной активной задаче этот каталог не числится')
      : ownerFields.baseSha
        ? `записанная точка ${ownerFields.baseSha} в истории HEAD не лежит — ветку перебазировали или коммита в клоне нет`
        : `у записи ${ownerAddress} точки ветвления нет, её сделал прежний CLI`;
    warnings.push(`цель — worktree, но точку ветвления взять неоткуда (${why}), `
      + `и посчитать её от локальной default-ветки не вышло: ${baseLine} — в дифф может попасть чужая работа. `
      + `Задай --task <id задачи worker'а> или --base <sha точки ветвления>`);
  }
  if (!baseRef) warnings.push('базовая ветка не определена — ревьюится только незакоммиченное (укажи --base <ref>)');
  // Четыре чтения git проверяются по отдельности: следующее зависит от предыдущего.
  const from = baseRef ? git(repoDir, ['merge-base', baseRef, 'HEAD']) : { out: 'HEAD' };
  if (from.refusal) return { refusal: from.refusal };
  const diffFrom = from.out;
  const diffOut = gitRaw(repoDir, ['diff', diffFrom]);
  if (diffOut.refusal) return { refusal: diffOut.refusal };
  const diff = diffOut.out;
  const others = git(repoDir, ['ls-files', '--others', '--exclude-standard']);
  if (others.refusal) return { refusal: others.refusal };
  const untracked = others.out.split('\n').filter(Boolean);
  const statOut = gitRaw(repoDir, ['diff', '--stat', diffFrom]);
  if (statOut.refusal) return { refusal: statOut.refusal };
  const stat = statOut.out.trim();

  const participant = participantOf(taskMeta, address);
  const was = participant?.metadata ?? {};
  // Имя участника из журнала не переписывается: сессия reviewer'а поднята под ним, и
  // переревью ищет её по этой же строке. Заголовок берётся у владельца worktree.
  const name = was.name ?? sessionName(taskMeta, {
    slug,
    reviewer: true,
    title: ownerFields.title,
    taken: (taskMeta.participants ?? []).map((p) => p.metadata.name).filter(Boolean),
  });
  // Переревью уходит участнику, только если его bg-сессия жива: после `claude stop`
  // сообщение легло бы в mailbox навсегда. Неизвестно — шлём дифф прежним адресом.
  const sessionState = participant ? participantSession(participant) : null;
  // Запись ДО запуска делает «reviewer есть в журнале» истинной и для того, кто не
  // поднимался. Смотрим на `pending`, а не на `participant.session`: у живого reviewer'а,
  // чей id не разобрался из вывода `claude --bg`, поля тоже нет.
  const unlaunched = !!was.pending && sessionState !== 'alive';
  const reuse = !!participant && sessionState !== 'dead' && !unlaunched;
  // --effort действует на подъём сессии, не на переревью: пересоздание теряет контекст находок.

  // Модуль может объявить процедуру ревью — скилл из своего состава (module.json, поле
  // review.skill). Reviewer'у достаточно абсолютного пути: материалы скилла резолвятся от
  // его каталога обычным чтением, загрузка плагина не нужна.
  const moduleHit = host.resolveRepoModule(repoDir);
  const declaredSkill = moduleHit?.meta?.review?.skill;
  let skill = null;
  if (declaredSkill) {
    const dir = host.reviewSkillDir(declaredSkill);
    if (!existsSync(path.join(dir, 'SKILL.md'))) {
      throw new Error(`модуль ${moduleHit.name} объявил ревью-скилл «${declaredSkill}», но ${dir} не разложен — ${host.syncHint()}`);
    }
    const shared = path.join(host.workspaceRoot(), host.pluginSkillsRel(), '_shared');
    skill = { name: declaredSkill, module: moduleHit.name, dir, shared: existsSync(shared) ? shared : null };
  }

  // Имя требуется, только когда задача действительно заведётся. Отсутствие СЛАГА именем
  // не считается: имя вне латиницы даёт пустой слаг, и отказ «имени нет» на команду с
  // названным `--title` ходил бы по кругу — id тогда остаётся одним штампом.
  if (createNew && !identity.slug && (diff.trim() || untracked.length)) {
    if (!createNew.title) {
      throw new Error(`ревью ${nsPath} заводит новую задачу, а имени у неё нет: `
        + 'назови её — --title "<чью работу смотрим>". '
        + `Ревьюишь работу worker'а активной задачи — назови её вместо этого: --task <id>`);
    }
    warnings.push(`имя «${createNew.title}» в слаг id не переводится (в него идут только `
      + `латиница и цифры) — id задачи остался машинным штампом ${taskId}. `
      + `Имя целиком сохранено в журнале задачи и в имени сессии reviewer'а`);
  }

  // Driver — из registry и до всякой записи в журнал, как у spawn'а worker'а: у уже
  // поднятого reviewer'а тот, которым его подняли, у нового — driver подъёма. Берётся он
  // ДО промпта и до каталога скиллов: имена инструментов шины в промпте и то, берёт ли
  // harness каталог скиллов, — его словарь.
  const driver = participant ? driverOf(participant) : lifter;
  // Переревью чужим harness'ом — отказ, а не тихая подмена (замечание ревью): сессия
  // reviewer'а уже поднята в другом инструменте, и сменить ей инструмент на ходу нечем.
  // Тот же гейт стоит у `planSpawn`.
  if (participant && harness && harness !== driver.id) {
    throw new GateError(`${address} в задаче ${taskId} поднят harness'ом ${driver.id}, а --harness просит `
      + `${harness}: повторный вызов шлёт НОВЫЙ ДИФФ уже поднятому reviewer'у, и сменить ему инструмент `
      + `на ходу нечем. Нужен reviewer другого инструмента — заведи ему свою задачу: --title <имя>.`);
  }
  // Допустимые значения флагов — словарь driver'а ЭТОГО участника: оба флага действуют на
  // подъём сессии, а не на переревью, но словарь у harness'ов разный, и сверка по чужому
  // пропустила бы в Cursor уровень Claude Code — тот уехал бы суффиксом id модели.
  const effort = resolveEffort(effortOpt, driver);
  // Reviewer без флага поднимается на режиме бинаря — его права режет снятие инструментов
  // в файле настроек; флаг — на один подъём, как `--effort`.
  const permissionMode = resolvePermissionMode(permissionOpt, driver, null);

  const diffPath = path.join(filesDir(home, taskId), diffName(home, taskId, slug));
  const rules = host.collectRules(repoDir);
  // Правила базы и дифф лежат вне рабочей директории reviewer'а, а чтение вне её Claude
  // Code спрашивает разрешением: без --add-dir reviewer встал бы на первом же указании
  // собственного промпта. Прав на запись это не даёт.
  const ruleDirs = [...new Set(rules.map((f) => path.dirname(f)))];
  const addDirs = [...new Set([...ruleDirs, path.dirname(diffPath)])];
  const prompt = buildPrompt({ taskId, nsPath, repoDir, address, diffPath, stat, untracked, baseLine, rules, skill, driver, host });
  const reReview = buildReReview({ diffPath, stat, untracked, baseLine });

  const settingsPath = participantSettingsPath(home, taskId, address);
  const guardCommand = guardHookCommand(host, { address, taskId, home }, process.platform);
  // Каталог скиллов берёт не всякий harness — тем же правилом, что у worker'а.
  const pluginDir = driver.options.skillsDir ? participantPluginDir(host) : null;
  // Canonical MCP-список — тем же путём, что worker'у: read-only держит снятие инструментов.
  const mcpConfigPath = participantMcpPath(home, taskId, address);
  const mcp = participantMcp(host, { address, taskId, home }, driver);

  // План подъёма собирает driver — как у spawn'а worker'а. Настройки те же, что у worker'а,
  // плюс снятые инструменты: скиллы workspace нужны и reviewer'у — процедура ревью приезжает
  // скиллом модуля. Команда сторожа цикла та же, что у worker'а: до сессии в чужом каталоге
  // хук рабочего места не доезжает. Permission-mode дефолтный: чтение не
  // спрашивают, и флага здесь нет вовсе.
  // Модель без флага — умолчание driver'а, как у worker'а.
  const resolvedModel = model ?? driver.options.defaultModel;
  const launch = driver.prepare({
    ref: name,
    address,
    task: taskId,
    home,
    role: 'reviewer',
    mcp: mcp.descriptor,
    prompt,
    cwd: repoDir,
    model: resolvedModel,
    effort,
    permissionMode,
    addDirs,
    pluginDir,
    mcpConfigPath,
    settingsPath,
    guardCommand,
    denyTools: driver.options.denyTools,
    extraSettings: skillSettings(host),
    root,
  });

  return {
    home, taskId, createNew, otherActive, slug, address, name, nsPath, repoDir, baseRef, baseLine, owner, warnings,
    diff, untracked, stat,
    participant, sessionState, reuse, unlaunched, titleIgnored, skill, rules, ruleDirs, addDirs, diffPath, prompt, reReview,
    module: host.moduleNote(repoDir), pluginDir,
    settingsPath, guardCommand, mcpConfigPath, mcpNote: mcpNote(mcp, `reviewer'а`),
    launch, argv: launch.argv, mcpConfig: launch.mcpConfig, settings: launch.settings,
    model: resolvedModel, effort, permissionMode, driver,
    // Окружение — полем плана: `--dry-run` печатает то же, что исполняет реальный запуск.
    // Идентичности шины в нём нет: она уезжает reviewer'у так же, как worker'у, —
    // аргументами команды Stop-хука в его файле настроек.
    env: sessionEnv(driver, process.env, host),
    host,
  };
}

// Накопившееся в своём mailbox'е оркестратор видит и здесь: notification могла не дойти.
// Заведённая этим же вызовом задача счётчика не получает: её mailbox пуст по построению.
function warnUnread(plan) {
  if (plan.createNew) return;
  const note = unreadNote(plan.home, plan.taskId, ORCHESTRATOR, sessionIdentity());
  if (note) warn(note);
}

export async function review(rootOrHost, opts) {
  const plan = planReview(rootOrHost, opts);
  // Отказ плана печатает и выходит команда: `fail()` живёт здесь, а не в плане.
  if (plan.refusal) fail(plan.refusal);
  // Бинарь резолвится лениво: у команды три ранних возврата без подъёма. `opts.tool` — шов.
  let toolCache = null;
  // Имя бинаря называет driver: своего у команды нет.
  const harnessTool = () => (toolCache ??= (opts.tool ?? plan.host.resolveToolBin(plan.driver.options.tool)));

  // Предупреждения про базу — до всякой развилки: на пустом диффе база подозрительна первой.
  for (const w of plan.warnings) warn(w);

  if (!plan.diff.trim() && plan.untracked.length === 0) {
    ok(`изменений нет — ревьюить нечего (${plan.baseLine})`);
    warnUnread(plan);
    return plan;
  }

  if (opts.dryRun) {
    info(`репозиторий: ${plan.nsPath} → ${plan.repoDir} · ${plan.baseLine}`);
    info(`задача: ${plan.taskId}${plan.createNew ? ` (будет создана: ${plan.createNew.title})` : ''}${titleNote(plan)}`);
    // Имя из журнала, а не собранное заново: у задачи прежнего CLI они не совпадут.
    const sessionShown = plan.reuse ? plan.participant.metadata.name ?? plan.name : plan.name;
    info(`адрес reviewer'а: ${plan.address}${ownerNote(plan)} · сессия: «${sessionShown}»${modelNote(plan)}${effortNote(plan)}${participantNote(plan)}`);
    info(`процедура: ${plan.skill ? `скилл ${plan.skill.name} (модуль ${plan.skill.module})` : 'встроенная (модуль ревью-скилл не объявил)'}`);
    // Своё рабочее место reviewer'а — только там, где driver его выбрал: harness
    // без настроек на один подъём читает их из рабочего каталога, и посадить его в
    // ревьюируемый клон значило бы писать конфиги в чужое дерево.
    if (plan.launch.cwd && plan.launch.cwd !== plan.repoDir) {
      info(`рабочее место reviewer'а: ${plan.launch.cwd} — ревьюируемый каталог подключён на чтение`);
    }
    info(`правила reviewer'а:`);
    for (const f of plan.rules) console.log(`  ${f}`);
    sayModule(plan);
    // Перечень серверов, а не конфиг целиком: в нём подставленные токены.
    info(`MCP reviewer'а (${plan.mcpConfig.mcpServers ? Object.keys(plan.mcpConfig.mcpServers).length : 0}):`);
    for (const line of mcpServerLines(plan.mcpConfig)) console.log(`  ${line}`);
    sayMcp(plan, { hint: false });
    // Версию бинаря в `--dry-run` не спрашиваем: не поднимается ничего, а проба — процесс.
    info(dryRunToolNote(plan.driver));
    info(`скиллы workspace: ${skillsNote(plan)}`);
    info(guardHookNote(plan));
    info(sessionEnvNote(plan.driver, plan.host));
    // Та же строка и по той же причине, что у spawn'а: имя сессии, которое
    // придумывает сам бинарь, `--dry-run` печатать нечем, и он говорит это вслух.
    if (plan.driver.phrases.naming) info(`имя сессии у harness'а: ${plan.driver.phrases.naming}`);
    info('промпт:');
    console.log(plan.reuse ? plan.reReview : plan.prompt);
    warnSecondTask(plan);
    ok('dry-run: на диск ничего не записано, reviewer не запущен');
    return plan;
  }

  // Бинарём проверяемся ДО первой записи на диск: иначе отказ по версии оставлял бы за
  // собой заведённую задачу, файл диффа и запись `pending`. Переревью бинарь не нужен.
  if (!plan.reuse) {
    // Read-only спрашивается ПЕРВЫМ и до всякой записи: harness, не умеющий снимать
    // инструменты, поднял бы сессию с правом записи в ревьюируемое дерево.
    const noDeny = denyToolsRefusal(plan.driver);
    if (noDeny) fail(noDeny);
    const t = harnessTool();
    sayTool(t, { reason: false });
    if (!t.ok) fail(t.reason);
    // Гейт по версии общий с worker'ом: разойдись отказы, reviewer тихо вставал бы на
    // дефолтном эффорте.
    const ultra = optionRefusal(plan.driver, plan.effort, t);
    if (ultra) fail(ultra);
  }

  // От чего считался дифф и за кого ревьюим — вслух и на реальном прогоне.
  if (plan.titleIgnored) info(titleNote(plan).replace(/^ · /, ''));
  info(`адрес reviewer'а: ${plan.address}${ownerNote(plan)} · ${plan.baseLine}`);
  sayModule(plan);
  // Набор MCP объявляется только там, где он действительно уезжает: на переревью живой
  // reviewer работает со СТАРЫМ конфигом, и строка описывала бы набор, которого нет.
  if (!plan.reuse) sayMcp(plan);
  if (plan.createNew) {
    createTask(plan.home, plan.createNew);
    ok(`задача ${plan.taskId}: ${plan.createNew.title}`);
    warnSecondTask(plan);
  }
  // Привязка «сессия → задача» — только на ПОДХВАТЕ и только владельцу. Заведённая здесь
  // задача ревью привязки не получает: инструменты без аргумента ушли бы читать её
  // mailbox, пока сообщения worker'ов основной задачи копятся незамеченными.
  if (!plan.createNew) bindIfOwner(plan.home, plan.taskId);
  retargetDiff(plan, writeDiff(path.dirname(plan.diffPath), plan.slug, plan.diff));

  // Reviewer жив — шлём ему новый дифф: переревью в том же контексте проверяет находки.
  if (plan.reuse) {
    if (plan.sessionState === 'unknown') {
      warn(`живость сессии reviewer'а ${plan.address} подтвердить нечем (${plan.driver.phrases.unreadable}) — дифф уходит прежним адресом; отчёта нет — проверь сессию: ${plan.driver.phrases.sessions}`);
    }
    sendMessage(plan.home, plan.taskId, { from: ORCHESTRATOR, to: plan.address, type: 'task', body: plan.reReview });
    ok(`reviewer ${plan.address} уже на шине — отправлен новый дифф ${plan.diffPath}`);
    // Новое задание возвращает участника под наблюдение: эта ветка записи не переписывает
    // (живому reviewer'у уходит только сообщение), а снятый встал бы молча.
    if (watchParticipant(plan.home, plan.taskId, plan.address).was) {
      info('участник был снят с наблюдения — новое задание вернуло его: о стопе этой сессии снова доложат');
    }
    info(waitHint('ответ', plan.taskId));
    warnUnread(plan);
    return plan;
  }

  // Сессия участника мертва: сообщение легло бы в mailbox навсегда. Поднимаем нового
  // reviewer'а полным промптом — контекст прошлых находок ушёл вместе с сессией.
  if (plan.unlaunched) {
    // Ни одно слово про мёртвую сессию здесь не верно: этот reviewer не поднимался.
    warn(`запись reviewer'а ${plan.address} осталась от сорвавшегося запуска (pending), живость подтвердить нечем — переревью слать некому`);
    warn(`поднимаю reviewer'а заново полным промптом: прошлого контекста у него нет, дифф он смотрит с чистого листа`);
  } else if (plan.participant) {
    warn(`сессия reviewer'а ${plan.address} мертва (её нет среди живых в ${plan.driver.phrases.sessions}) — переревью отправлять некому`);
    warn(`поднимаю нового reviewer'а полным промптом: прошлые находки ушли вместе с сессией, дифф он смотрит с чистого листа`);
  }

  // Права 0600 у конфига — те же, что у worker'а: подставленные токены те же.
  writeLaunchFiles(plan.launch.files);

  // Участник ложится в журнал ДО запуска `claude` — тот же порядок, что у worker'а: иначе
  // следующий вызов завёл бы ещё одну задачу-сироту, а worktree, по которому её
  // подхватили бы, у reviewer'а нет.
  // Запись кладёт registry — тем же порядком, что у worker'а: отказ неизвестному harness'у
  // приходит до того, как участник появится в журнале. `pending` снимается вторым
  // upsert'ом: `applyParticipant` заменяет запись целиком, поэтому дописывающий id сессии
  // кладёт обратно ту же запись, что вернул registry.
  const { record } = openParticipant(plan.home, plan.taskId, participantRecord(plan.address, {
    // Harness записи — тот, которым её поднимают, тем же правилом, что у worker'а.
    harness: plan.driver.id,
    repo: plan.nsPath,
    repoAbs: plan.repoDir,
    model: plan.model,
    ...(plan.effort ? { effort: plan.effort } : {}),
    name: plan.name,
    sessionRef: plan.name,
    started: new Date().toISOString(),
    pending: true,
    mechanismVersion: plan.host.version,
  }), REGISTRY);

  const tool = harnessTool();

  // Запуск и сверка «сессия поднялась» — общий с worker'ом хелпер внутри driver'а.
  const { output, session, seen } = await plan.driver.spawn(plan.launch, {
    tool,
    // Адрес, задача и дом шины уезжают driver'у ВМЕСТЕ с планом: у harness'а,
    // чей канал пробуждения ведёт сам механизм, сдавать contact point'ы приходится его
    // же машинерии, а адресовать их больше нечем.
    home: plan.home,
    task: plan.taskId,
    address: plan.address,
    cwd: plan.repoDir,
    env: plan.env,
    ref: plan.name,
    role: 'reviewer',
    launchFailNote: launchFailureNote(plan),
    // Маршрут переподъёма у reviewer'а свой: его поднимает `promptobus review`, worktree у него нет.
    deadNote: deadSessionNote(plan),
    // Пометка `pending` снимается только удавшимся подъёмом: иначе повтор принял бы запись
    // за живого reviewer'а и ушёл слать переревью в пустой mailbox.
    persist: (id, state, sessionId) => {
      // Пометку снимаем ЯВНО: она уехала в запись первым upsert'ом, а `applyParticipant`
      // заменяет участника целиком — оставшись, она выдала бы поднятого reviewer'а за
      // неподнявшегося, и повтор ушёл бы слать переревью в пустой mailbox.
      const { pending, ...rest } = record.metadata;
      return upsertParticipant(plan.home, plan.taskId, {
        ...record,
        metadata: {
          ...rest,
          session: id,
          ...(sessionId ? { sessionId } : {}),
          ...(state === 'dead' ? { pending: true } : {}),
        },
      });
    },
    awaitOptions: opts.awaitOptions,
  });
  ok(`reviewer ${plan.address} поднят в ${plan.nsPath}${session ? ` (сессия ${session})` : ''}`);
  // Надзирателя поднимаем сразу за участником: без него reviewer'у о сообщении не узнать —
  // он забирает mailbox только собственным ходом.
  ensureWarden(plan.home, plan.taskId, { host: plan.host });
  plan.driver.saidLiftoff({ name: plan.name, seen, session, output });
  info(waitHint('отчёт', plan.taskId));
  // Печатаем команду переревью целиком, чтобы id задачи не выуживать из вывода.
  info(`новый дифф этому же reviewer'у: ${plan.host.busCommand(['review', `"${plan.repoDir}"`, `--task ${plan.taskId}`])}`);
  warnUnread(plan);
  return plan;
}

// Что уцелело после неудачи — одна строка на оба отказа. У задачи, заведённой этим
// вызовом, нет worktree-участника: повтор без `--task` её не подхватит, поэтому отказ
// называет сироту и точную уборку.
function keptNote(plan) {
  return ` Задача ${plan.taskId} и запись участника ${plan.address} на месте; diff сохранён в ${plan.diffPath}.`;
}

// Запуск удался, а сессии нет: поднять reviewer'а заново той же командой — она подхватит
// задачу по `--task`. Уборка называется альтернативой, для случая «от ревью отказались».
function deadSessionNote(plan) {
  return `${keptNote(plan)} Поднимай reviewer'а заново: ${plan.host.busCommand(['review', `"${plan.repoDir}"`, `--task ${plan.taskId}`])}.`
    + ' Сообщений от этого адреса не будет — ждать их бессмысленно.'
    + (plan.createNew ? ` От ревью отказался — закрой задачу: ${plan.host.busCommand(['done', `--task ${plan.taskId}`])}` : '');
}

function launchFailureNote(plan) {
  const kept = keptNote(plan);
  return plan.createNew
    ? `${kept} Это активная задача-сирота: reviewer не поднят, и следующий вызов без --task её не подхватит. `
      + `Закрой её: ${plan.host.busCommand(['done', `--task ${plan.taskId}`])}`
    : `${kept} Reviewer не поднят; задача остаётся активной.`;
}

// Своя задача ревью рядом с чужой активной означает несколько активных, и резолв
// «единственной активной» отказывает — узнать об этом лучше здесь, а не следующим вызовом.
function warnSecondTask({ createNew, otherActive, taskId, host }) {
  if (!createNew || !otherActive.length) return;
  const many = otherActive.length > 1;
  warn(`${many ? 'активны ещё задачи' : 'активна ещё задача'} ${otherActive.join(', ')} — активных станет несколько: `
    + 'командам понадобится --task, инструментам шины — аргумент task');
  info(`закончишь ревью — закрой его задачу: ${host.busCommand(['done', `--task ${taskId}`])}`);
}

// Модель и effort в dry-run: при переревью argv не исполняется, и печатать флаг
// применённым — ложь. «Сессия уже жива» не утверждается при неподтверждённой живости.
function notApplied({ reuse, sessionState }) {
  if (!reuse) return '';
  return sessionState === 'unknown'
    ? ' (не применяется — дифф уйдёт прежнему адресу)'
    : ' (не применяется — сессия уже жива)';
}

// Имя, заданное вместе с --task: задача уже есть, и заголовок берётся из её журнала.
function titleNote({ titleIgnored, taskId }) {
  return titleIgnored ? ` · --title не применяется — имя берётся из журнала задачи ${taskId}` : '';
}

function modelNote(plan) {
  return ` · модель: ${plan.model}${notApplied(plan)}`;
}

function effortNote(plan) {
  return plan.effort ? ` · effort: ${plan.effort}${notApplied(plan)}` : '';
}

// Чей worktree ревьюим — приписка к адресу: иначе «почему reviewer зовётся не как
// репозиторий» выясняется чтением кода.
function ownerNote({ owner }) {
  return owner ? ` (по worker'у ${addressOf(owner)})` : '';
}

// Участник задачи, чей worktree — этот каталог. Сравниваем канонические пути: цель
// прогнана через realpathSync, а журнал хранит путь spawn'а (на macOS /var против
// /private/var). Участнику без `worktree` каталог не принадлежит.
function worktreeOwner(taskMeta, repoDir) {
  return (taskMeta.participants ?? [])
    .find((p) => p.metadata.worktree && canonical(p.metadata.worktree) === repoDir) ?? null;
}

// Активные задачи, в чьём журнале цель числится каталогом worktree участника.
// Принадлежность спрашиваем у журнала, а не у имени каталога или ветки: имена собираются
// по шаблону и совпадают случайно. По `repo` не сверяем — поле есть и у записи reviewer'а,
// и цель числилась бы в каждой задаче, где репозиторий когда-либо ревьюился.
function claimingTasks(home, repoDir) {
  return activeTasks(home).filter((t) => worktreeOwner(t, repoDir));
}

// Каталога может уже не быть (задача закрыта, worktree убран) — путь из журнала абсолютный.
function canonical(p) {
  try { return realpathSync(p); } catch { return path.resolve(p); }
}

// Локальная default-ветка репозитория: merge-base с ней даёт точку, где работа worker'а
// начинается на самом деле. Имя называет host.defaultBranch — тот же детект, которым spawn
// выбирает базу нового worktree. Существовать обязана именно ЛОКАЛЬНАЯ
// ветка: незапушенная работа оркестратора в удалённую не входит.
function localDefault(repoDir, host) {
  const exists = (br) => spawnSync('git', ['-C', repoDir, 'rev-parse', '--verify', '-q', `refs/heads/${br}`],
    { encoding: 'utf8' }).status === 0;
  const named = host.defaultBranch(repoDir);
  // Имя есть, а локальной ветки под ним нет — базы отсюда не взять, и лесенка не
  // помощник: worker ветвился от `origin/<имя>`, а не от случайной локальной ветки.
  if (named) return exists(named) ? named : null;
  // Ссылок origin в клоне нет вовсе: spawn тогда берёт за базу `HEAD`. Локальная лесенка
  // — та же очерёдность, что у fresh.js: разойдись порядок, разошлись бы и ответы.
  return ['master', 'main'].find(exists) ?? null;
}

// Вопросы к git о базе диффа зовут `spawnSync` напрямую, а не через `git()`/`gitRaw()`:
// у тех отказ уносит весь план, а здесь отказ — законный ответ.
function mergeBase(repoDir, ref) {
  const r = spawnSync('git', ['-C', repoDir, 'merge-base', ref, 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

function isAncestor(repoDir, sha, ref) {
  const r = spawnSync('git', ['-C', repoDir, 'merge-base', '--is-ancestor', sha, ref], { encoding: 'utf8' });
  return r.status === 0;
}

function headOf(repoDir) {
  const r = spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

// Лежит ли записанная точка ветвления в истории HEAD. Возвращаем sha или `null` — «этой
// точке верить нельзя»; различать причины незачем, откат из них один.
function ancestorOfHead(repoDir, sha) {
  if (!sha) return null;
  return isAncestor(repoDir, sha, 'HEAD') ? sha : null;
}

// Слаг из адреса участника — обратная к workerAddress/reviewerAddress (store.js).
function addressSlug(address) {
  const addr = String(address ?? '');
  return addr.slice(addr.indexOf(':') + 1);
}

// Что --dry-run скажет про уже заведённого reviewer'а — по тому же трёхзначному
// состоянию сессии, которым реальный запуск выбирает между переревью и новым spawn'ом.
function participantNote({ participant, sessionState, unlaunched }) {
  if (!participant) return '';
  // Запись до запуска — не «уже на шине»: реальный прогон в этом состоянии поднимет
  // нового reviewer'а, и печать обязана говорить то же.
  if (unlaunched) return ' · запись сделана до запуска, reviewer не поднимался — поднимется новый';
  if (sessionState === 'dead') return ' · был на шине, но его сессия мертва — поднимется новый reviewer';
  if (sessionState === 'unknown') return ' · уже на шине, живость сессии не подтверждена — уйдёт новый дифф';
  return ' · уже на шине — уйдёт новый дифф';
}

// Отказ `promptobus review` без пути. Репозиторий текущего каталога попадает сюда только текстом
// подсказки: команда его не исполняет, а называет.
function missingTarget(host, { task, title, base, model, effort, harness, dryRun }) {
  const head = `путь к репозиторию обязателен: ${host.busCommand(['review', '<путь>'])} [--task <id> | --title <имя>].`
    + '\n    Резолва по текущему каталогу у этой команды нет: в workspace рядом десятки клонов,'
    + ' и текущий каталог почти никогда не тот, о котором идёт разговор.';
  const ask = `\n    ${host.reviewLayoutError('ask-path')}`;
  const here = cwdRepo(host);
  // Называем репозиторий, а не каталог: `cwdRepo` отдаёт git-toplevel, и из
  // `repos/<group>/<repo>/src` человек прочитал бы про каталог, в котором не стоит.
  if (!here) return `${head}\n    Текущий каталог не в git-репозитории.${ask}`;
  // Готовая команда — только там, где её примет следующий гейт: подсказка, которую
  // planReview тут же отвергнет, стоит человеку двух повторов вместо одного.
  if (!here.nsPath) {
    return `${head}\n    Репозиторий текущего каталога — ${here.dir}, но он ${host.reviewLayoutError('cwd-outside')}.${ask}`;
  }
  const cwdPair = here.nsPath.split('/').length < 2
    ? host.reviewLayoutError('cwd-need-pair', { dir: here.dir })
    : null;
  if (cwdPair) {
    return `${head}\n    Репозиторий текущего каталога — ${here.dir}, но он ${cwdPair}.${ask}`;
  }
  const arg = (v) => (/[\s"]/.test(v) ? JSON.stringify(v) : v);
  const flags = [
    ...(task ? ['--task', arg(task)] : []),
    ...(String(title ?? '').trim() ? ['--title', arg(String(title).trim())] : []),
    ...(base ? ['--base', arg(base)] : []),
    ...(model ? ['--model', arg(model)] : []),
    ...(effort ? ['--effort', effort] : []),
    // Инструмент подъёма едет в подсказку наравне с остальными флагами: повтор
    // без него поднял бы reviewer'а не тем harness'ом, о котором шла речь.
    ...(harness ? ['--harness', arg(harness)] : []),
    ...(dryRun ? ['--dry-run'] : []),
  ];
  return `${head}\n    Репозиторий текущего каталога — ${here.nsPath} (${here.dir}).`
    + '\n    Он и есть предмет ревью — повтори с ним:'
    + `\n      ${host.busCommand(['review', `"${here.dir}"`])}${flags.length ? ` ${flags.join(' ')}` : ''}`
    + '\n    Предмет другой — назови его путь сам.';
}

// Клон, в который резолвится текущий каталог процесса, — только для отказа выше.
function cwdRepo(host) {
  const r = spawnSync('git', ['-C', process.cwd(), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  let dir;
  try { dir = realpathSync(path.resolve(r.stdout.trim())); } catch { return null; }
  return { dir, nsPath: cloneRootOf(host.reposRoot(), dir)?.nsPath ?? null };
}

// Отказ — полем `refusal`, тем же исходом, что у `git()`. Цель и её git-toplevel
// возвращаются обе: по их расхождению planReview выбирает, чем отказывать.
function resolveRepoDir(target) {
  const start = path.resolve(target);
  const r = spawnSync('git', ['-C', start, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status !== 0) return { refusal: `${start}: не git-репозиторий` };
  // На Windows git печатает путь с прямыми слэшами — path.resolve возвращает нативный вид.
  return { targetDir: realpathSync(start), repoDir: realpathSync(path.resolve(r.stdout.trim())) };
}

// Корень клона, внутри которого лежит цель, и его namespace-путь под repos/. Спускаемся
// от repos/ по частям пути до первого каталога с `.git`. Брать второй сегмент пути
// нельзя: namespace бывает глубже двух сегментов, а цель бывает worktree.
function cloneRootOf(reposRoot, dir) {
  const rel = path.relative(reposRoot, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  let abs = reposRoot;
  const taken = [];
  for (const part of rel.split(path.sep)) {
    abs = path.join(abs, part);
    taken.push(part);
    if (existsSync(path.join(abs, '.git'))) return { abs, nsPath: taken.join('/') };
  }
  return null;
}

function detectBase(repoDir) {
  const head = spawnSync('git', ['-C', repoDir, 'symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], { encoding: 'utf8' });
  if (head.status === 0) return head.stdout.trim().replace('refs/remotes/', '');
  const cur = spawnSync('git', ['-C', repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    // Локальная ветка не может быть базой для себя. Сравнение точное: на локальной main
    // кандидат origin/main пропускать НЕ надо — незапушенные коммиты законный предмет ревью.
    if (cur === ref) continue;
    const r = spawnSync('git', ['-C', repoDir, 'rev-parse', '--verify', '-q', ref], { encoding: 'utf8' });
    if (r.status === 0) return ref;
  }
  return null;
}

// Имя файла диффа по слагу и номеру — один дом у соглашения на предсказание и на запись.
function diffFile(slug, n) {
  return n > 1 ? `review-${slug}-${n}.diff` : `review-${slug}.diff`;
}

// Дифф — в артефактах задачи: там его видит и reviewer, и человек, разбирающий журнал.
// Занятое имя получает номер: перетирать предыдущий нельзя, пока reviewer, возможно, его
// читает. Здесь имя только ПРЕДСКАЗЫВАЕТСЯ — занимает его сама запись (`writeDiff`).
function diffName(home, taskId, slug) {
  const dir = filesDir(home, taskId);
  let n = 1;
  while (existsSync(path.join(dir, diffFile(slug, n)))) n += 1;
  return diffFile(slug, n);
}

// Запись диффа, занимающая имя самой записью: между `existsSync` и записью вклинилось бы
// второе ревью того же слага. Флаг `wx` отказывает на существующем файле — сигнал взять
// следующий номер. Возвращает путь, который ЛЁГ на диск. Экспортируется ради теста:
// гонку не воспроизвести изнутри одной команды.
export function writeDiff(dir, slug, content) {
  mkdirSync(dir, { recursive: true });
  for (let n = 1; ; n += 1) {
    const at = path.join(dir, diffFile(slug, n));
    try {
      writeFileSync(at, content, { flag: 'wx' });
      return at;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

// Путь диффа стоит в трёх местах плана — в поле, в промпте и в сообщении переревью, — и
// после записи план пересобирает их по тому пути, который лёг на диск. Зовётся
// БЕЗУСЛОВНО: ветка «имя ушло вперёд» случается лишь в гонке, и её нечем закрыть тестом.
function retargetDiff(plan, diffPath) {
  const { taskId, nsPath, repoDir, address, stat, untracked, baseLine, rules, skill, driver, host } = plan;
  // Промпт уезжает последним позиционным аргументом — ищем его в argv по значению, а не
  // по позиции: порядок флагов правится чаще, чем этот код.
  const at = plan.argv.lastIndexOf(plan.prompt);
  plan.diffPath = diffPath;
  plan.prompt = buildPrompt({ taskId, nsPath, repoDir, address, diffPath, stat, untracked, baseLine, rules, skill, driver, host });
  plan.reReview = buildReReview({ diffPath, stat, untracked, baseLine });
  if (at >= 0) plan.argv[at] = plan.prompt;
}

function subject({ diffPath, stat, untracked, baseLine }) {
  return `Diff — в файле ${diffPath} (прочитай его целиком); ${baseLine}. Что лежит вне этой границы — не предмет ревью.
Сводка изменений:
${stat || '(только новые файлы)'}
${untracked.length ? `\nНовые неотслеживаемые файлы (пути относительно репозитория, прочитай их):\n${untracked.map((f) => `- ${f}`).join('\n')}` : ''}`;
}

function procedure(skill) {
  if (skill) {
    return `Процедуру ревью не изобретай: прочитай ${path.join(skill.dir, 'SKILL.md')} и следуй ему в режиме «только отчёт» — находки не чини и не предлагай «я поправлю». Материалы скилла лежат рядом с ним${skill.shared ? `, общие стандарты — в ${skill.shared}` : ''}; относительные пути в тексте скилла резолвь от его каталога. Шаги, требующие записи, запуска команд или недоступного MCP-сервера, пропусти и перечисли пропущенное в отчёте.`;
  }
  return `Формат замечания: <файл>:<строка> [critical|major|minor] суть — предлагаемое исправление.
Замечаний нет — так и скажи и одной строкой перечисли, что именно проверил. Не пересказывай diff и не хвали код.`;
}

function buildPrompt({ taskId, nsPath, repoDir, address, diffPath, stat, untracked, baseLine, rules, skill, driver, host }) {
  const bus = (name) => toolName(driver, PROMPTOBUS_SERVER, name);
  return `Ты — reviewer кода задачи ${taskId}. Предмет ревью — изменения репозитория ${nsPath}; его рабочая копия — ${repoDir}, читай её свободно: call sites изменённых методов, соседний код, тесты. Ты участник шины Promptobus с адресом ${address}; связь с оркестратором — инструменты MCP-сервера ${PROMPTOBUS_SERVER} (он уже подключён к этой сессии): ${bus('promptobus_send')}, ${bus('promptobus_mailbox')}, ${bus('promptobus_task')}.

## Предмет ревью

${subject({ diffPath, stat, untracked, baseLine })}

## Изоляция — держи её сам

- Контекст сессии, писавшей код, тебе не передан, и это защита от самоодобрения: доверяй коду и стандартам, а не тому, что «так было задумано».
- Правка файлов и запуск команд у тебя отключены механизмом. Ничего не правь — выдай замечания, чинит автор.
- Механические проверки (сборка, анализатор, тесты) тебе недоступны — не выдумывай их результат, а скажи в отчёте, что они не прогонялись.
- **MCP-инструменты внешних систем — только на чтение, и держишь это ты, а не механизм.** Тебе доступен весь canonical набор workspace, и каждое имя пре-аппрувлено: разрешения у тебя никто не спросит, а за сессией нет человека, который бы отказал. Читай сколько нужно — контракт события, карточку задачи, дифф merge request'а, метрику, факт из памяти команды. Не создавай, не меняй, не удаляй и не публикуй ничего: ни комментария в merge request или карточке, ни треда, ни дашборда, ни аннотации, ни тест-кейса, ни артефакта, ни факта в памяти команд. Отчёт уходит одним каналом — сообщением оркестратору; всё, что ты хотел бы куда-то записать, пиши в него.
- Предмет — только изменённый и новый код, не легаси вокруг.

## Прочитай правила до ревью

${rules.map((f) => `- ${f}`).join('\n')}

## Процедура

${procedure(skill)}

## Память команд

${memoryRule(driver, host)}

## Протокол связи

Ждать тебе нечем и не надо: mailbox'ы задачи слушает надзиратель шины, и он же будит тебя postcard'ом, когда тебе пишут. В postcard'е идёт текст коротких сообщений, но прочитанными их делает только mailbox — забери его первым делом, даже если из postcard'а всё понятно.

1. Закончил ревью — отправь отчёт целиком: ${bus('promptobus_send')} {to:"orchestrator", type:"result", body:"замечания, либо «Замечаний нет» плюс что проверено"}.
2. Упёрся в вопрос, без ответа на который не продолжить, — ${bus('promptobus_send')} {to:"orchestrator", type:"question", body:"вопрос"} и заверши ход. Ответ (type=answer) придёт postcard'ом. Не угадывай.
3. Работа затягивается дольше пары минут молчания — пошли status с её содержанием и оценкой срока («осталось три файла, ~5 минут») ДО того, как завершишь ход: молчащая сессия для оркестратора неотличима от зависшей. Срок называй объёмом и замером, а не ощущением.
4. После result заверши ход. Пришло сообщение type=task с путём нового диффа — это переревью: сначала забери mailbox, потом проверь по нему свои прошлые замечания, закрыты ли, затем посмотри, что изменилось ещё. Отвечай снова result.
5. Сессию закрывает человек.${driver.phrases.promptRules}`;
}

// Сообщение переревью: контекст (правила, скилл, изоляция) у reviewer'а уже есть.
function buildReReview({ diffPath, stat, untracked, baseLine }) {
  return `Переревью: автор прислал новую версию изменений.

${subject({ diffPath, stat, untracked, baseLine })}

Сначала проверь по новому диффу свои прошлые замечания — какие закрыты, какие нет, затем посмотри, что изменилось ещё. Отчёт — promptobus_send {to:"orchestrator", type:"result", body:"..."} как раньше.`;
}

// `core.quotePath=false` — на КАЖДЫЙ вызов git этого файла: иначе git отдаёт не-ASCII
// пути в октальном экранировании, и reviewer получает имена, которых на диске нет.
const GIT_OPTS = ['-c', 'core.quotePath=false'];

// Потолок вывода — общий с обходом зоны (`GIT_MAX_OUTPUT`, util.js): на дефолтном
// мегабайте `spawnSync` убивает процесс сигналом без статуса, и команда падала бы без
// причины — её называет ветка `error` (она есть ровно там, где статуса нет). Исход:
// `{ out }` — прочитанное, `{ refusal }` — текст отказа, который печатает команда.
function git(repoDir, args) {
  const r = spawnSync('git', ['-C', repoDir, ...GIT_OPTS, ...args], { encoding: 'utf8', maxBuffer: GIT_MAX_OUTPUT });
  if (r.error) return { refusal: `git ${args.join(' ')}: ${r.error.message}` };
  if (r.status !== 0) return { refusal: `git ${args.join(' ')}: ${(r.stderr ?? '').trim() || `код ${r.status}`}` };
  return { out: r.stdout.trim() };
}

// Потолок здесь свой и выше: предмет вызова — сам diff. Вывод не обрезается — в диффе
// значимы и первый, и последний перевод строки.
function gitRaw(repoDir, args) {
  const r = spawnSync('git', ['-C', repoDir, ...GIT_OPTS, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) return { refusal: `git ${args.join(' ')}: ${r.error.message}` };
  if (r.status !== 0) return { refusal: `git ${args.join(' ')}: ${(r.stderr ?? '').trim() || `код ${r.status}`}` };
  return { out: r.stdout };
}
