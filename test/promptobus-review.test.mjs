// Регресс на живого reviewer'а шины Promptobus. Запуск: npm test
//
// Предмет — план ревью: всё, что вычисляется до exec `claude --bg` — адрес и задача,
// резолв ревью-скилла модуля, промпт и его read-only-инварианты, путь диффа, ветка
// переревью тому же адресу. Сам exec под тест не берётся: он поднимает живую сессию.
//
// **Имена вида `a2a-…` в фикстурах оставлены намеренно**: так называл ветки,
// каталоги worktree и сессии прежний CLI, и на них проверяется, что hard rename не сломал
// уже заведённое. Разбор — в [promptobus.test.mjs](promptobus.test.mjs), шапка файла.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { stubCommand, writeHostConfig } from './sandbox.mjs';
import { capture, expectThrow } from './console.mjs';
import { check } from './check.mjs';

// realpath: планировщик канонизирует корень (macOS: /var → /private/var), и ожидания
// теста должны сравниваться с каноническими путями.
const SB = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'promptobus-promptobus-review-')));
const here = path.dirname(fileURLToPath(import.meta.url));
const reviewUrl = new URL('../lib/review.js', import.meta.url).href;
const { planReview, review, denyToolsRefusal, writeDiff } = await import(reviewUrl);
// Словарь harness'а — из дома driver'а: уровни effort, переменные, снимаемые у
// поднимаемой сессии, и список снятых инструментов — его, а не шины.
const { EFFORT_LEVELS, REVIEWER_DENY, SESSION_ENV_DROP } = await import(path.join(here, '..', 'lib', 'driver-claude.js'));
const store = await import(path.join(here, '..', 'lib', 'store.js'));
const { hostOf } = await import(path.join(here, '..', 'lib', 'host.js'));
const { GUARD_HOOK_EVENT, guardHookCommand } = await import(path.join(here, '..', 'dist', 'hooks.js'));
// Путь файла участника в `workers/` — в журнале, рядом с `workersDir`: его
// считают spawn, ревью и уборка, и общий у этих трёх только он.


// --- рабочее место: база, модуль с ревью-скиллом, плагин скиллов, живой git-клон ---

const WS = path.join(SB, 'ws');
mkdirSync(WS, { recursive: true });
writeFileSync(path.join(WS, 'AGENTS.md'), 'workspace\n');
writeHostConfig(WS, { tools: ['claude', 'cursor', 'codex'] });
mkdirSync(path.join(WS, '.claude'), { recursive: true });
writeFileSync(path.join(WS, '.claude', 'settings.json'), JSON.stringify({
  skillOverrides: { 'ненужный-скилл': 'off' },
}, null, 2));

const g = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};
// Корень workspace — сам git-репозиторий, как в жизни: без этого папка группы
// внутри repos/ не воспроизводит уход toplevel вверх, к корню.
g(WS, 'init', '-b', 'main');
const REPO = path.join(WS, 'repos', 'loads_search', 'cargos-api');
mkdirSync(REPO, { recursive: true });
g(REPO, 'init', '-b', 'main');
writeFileSync(path.join(REPO, 'AGENTS.md'), 'Правила репозитория.\n');
writeFileSync(path.join(REPO, 'a.txt'), 'v1\n');
g(REPO, 'add', '.');
g(REPO, 'commit', '-m', 'init', '-q');
// Ссылки origin, как у настоящего клона: `git clone` выставляет и `origin/<default>`,
// и `origin/HEAD` на неё. Детект default-ветки читает `origin/HEAD` первым и на этом
// заканчивается; без ссылок он перебирает лесенку кандидатов — пять процессов `git`,
// а с ссылками план платит ещё один `merge-base`: итого два процесса вместо пяти на
// план, планов по этому клону в файле больше сорока. Лесенку `detectBase`
// после этого держат `CLEAN` и `SUB` (обе → null), `no-local-default` (→ origin/main)
// и `flood-api` (→ origin/master); ветку `baseRef === null` — `CLEAN` и `SUB`;
// достижимость фолбэка `['master','main']` в `localDefault` — `rebase-api` и `merged-api`,
// а сам порядок в нём — promptobus-review-ladder.test.mjs (здесь у обеих по одной локальной ветке);
// `dual-default` держит лесенку `defaultBranch` из fresh.js (`origin/HEAD` → `origin/master`).
g(REPO, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
g(REPO, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
writeFileSync(path.join(REPO, 'a.txt'), 'v2\n');
writeFileSync(path.join(REPO, 'new.txt'), 'новый файл\n');

// --- первый вызов: spawn reviewer'а ---------------------------------------------

const unnamed = expectThrow(() => planReview(WS, { target: REPO }));
check('новая задача: без --title понятный отказ с названием флага',
  unnamed.threw && /новую задачу/.test(unnamed.msg) && /--title/.test(unnamed.msg), unnamed.msg);
const blankTitle = expectThrow(() => planReview(WS, { target: REPO, title: '  ' }));
check('новая задача: пустой --title тоже не считается именем',
  blankTitle.threw && /--title/.test(blankTitle.msg), blankTitle.msg);

// Гейт имени не отнимает у команды самый дешёвый её ход: на чистом клоне ответ
// «изменений нет — ревьюить нечего» стоит раньше любого требования имени, потому что
// задача в этом случае не заводится вовсе (замечание ревью по ).
const CLEAN = path.join(WS, 'repos', 'loads_search', 'clean-api');
mkdirSync(CLEAN, { recursive: true });
g(CLEAN, 'init', '-b', 'main');
writeFileSync(path.join(CLEAN, 'a.txt'), 'v1\n');
g(CLEAN, 'add', '.');
g(CLEAN, 'commit', '-m', 'init', '-q');
// Отказ ловим сами: гейт, вернувшийся выше расчёта диффа, бросает из planReview, и
// без перехвата проверка не краснела бы, а роняла весь файл — диагностика дороже.
let cleanOut = '';
let cleanThrew = null;
try {
  cleanOut = await capture(() => review(WS, { target: CLEAN }));
} catch (e) {
  cleanThrew = e.message;
}
check('чистый клон без --title: отвечает «ревьюить нечего», а не требует имя',
  !cleanThrew && /ревьюить нечего/.test(cleanOut) && !/--title/.test(cleanOut),
  cleanThrew ?? cleanOut.slice(-400));

// : имя, не переживающее транслитерацию (CJK, эмодзи, одна пунктуация), давало
// отказ «имени у неё нет — назови её --title» на команду, где --title назван. Человек
// звал её снова тем же именем и получал тот же отказ. Имя названо — задача заводится,
// id остаётся машинным штампом (его законная форма), а само имя не теряется.
// Отказ ловим сами, тем же приёмом, что у чистого клона выше: гейт бросает из
// planReview, и без перехвата проверка не краснела бы, а роняла весь файл.
let cjk = null;
let cjkErr = '';
try { cjk = planReview(WS, { target: REPO, title: '日本語の作業' }); } catch (e) { cjkErr = e.message; }
check(': имя без латиницы задачу не отменяет — отказа «имени нет» больше нет',
  // Слага в журнале нет вовсе, а не `null`: пустых полей журнал не несёт.
  !!cjk && cjk.createNew?.title === '日本語の作業' && cjk.createNew.adapter.slug === undefined,
  cjkErr || JSON.stringify(cjk?.createNew));
check(': id такой задачи — машинный штамп, и это сказано вслух, а не молча',
  !!cjk && /^t\d{8}-\d{6}$/.test(cjk.taskId)
  && (cjk.warnings ?? []).some((w) => w.includes('日本語の作業') && /машинным штампом/.test(w)),
  cjkErr || `${cjk?.taskId} · ${(cjk?.warnings ?? []).join(' | ')}`);
check(`: имя целиком уехало в имя сессии reviewer'а`,
  !!cjk && cjk.name.includes('日本語の作業'), cjkErr || String(cjk?.name));

// --- : путь обязателен, резолва по cwd нет ------------------------------
//
// Форма отказа — половина решения, поэтому проверяется не только сам факт отказа, но и
// его текст: репозиторий назван, готовая команда печатается ровно там, где её примет
// следующий гейт, и несёт те же флаги.
//
// Клон прямо в repos/ (без группы) — законная фикстура: гейт «ожидается
// repos/<group>/<repo>» такую цель отвергает, и готовой команды на неё быть не должно.
const LONELY = path.join(WS, 'repos', 'lonely-api');
mkdirSync(LONELY, { recursive: true });
g(LONELY, 'init', '-b', 'main');

const cwd0 = process.cwd();
let noTarget;
let noTargetDry;
let noTargetFlags;
let outsideRepos;
let shallowClone;
let notARepo;
try {
  process.chdir(REPO);
  noTarget = expectThrow(() => planReview(WS, {}));
  noTargetDry = expectThrow(() => planReview(WS, { dryRun: true }));
  noTargetFlags = expectThrow(() => planReview(WS, { task: 'нет-такой', title: 'моя работа', dryRun: true }));
  process.chdir(WS);
  outsideRepos = expectThrow(() => planReview(WS, {}));
  process.chdir(LONELY);
  shallowClone = expectThrow(() => planReview(WS, {}));
  // Третья форма отказа — текущий каталог вообще не в git-репозитории (песочница вне
  // рабочего места). Прогон в этом же процессе: сняв гейт пути, вызов уходит в
  // `resolveRepoDir`, а тот с  возвращает отказ полем и процесс не уносит —
  // мутация валит проверку честным ✖, а не весь файл мимо сводки вердиктов.
  process.chdir(SB);
  notARepo = expectThrow(() => planReview(WS, {}));
} finally {
  process.chdir(cwd0);
}

// Отказ помощника — значением, а не выходом из процесса. Проверяется прямо:
// не-git цель проходит гейт пути и уходит в `resolveRepoDir`, а тот отдаёт `refusal`.
// Прежде он звал `fail()`, и на этом держался отдельный процесс у соседней проверки.
const NOT_A_REPO = path.join(SB, 'ne-repozitorij');
mkdirSync(NOT_A_REPO, { recursive: true });
const notGit = planReview(WS, { target: NOT_A_REPO });
check(': не-git цель — план возвращает отказ полем, а не убивает процесс',
  notGit.refusal === `${NOT_A_REPO}: не git-репозиторий`, JSON.stringify(notGit.refusal ?? null));
check(': без пути команда отказывает, а не берёт текущий каталог',
  noTarget.threw && /путь к репозиторию обязателен/.test(noTarget.msg)
  && /Резолва по текущему каталогу у этой команды нет/.test(noTarget.msg), noTarget.msg);
// Названо должно быть именно «репозиторий»: cwdRepo отдаёт git-toplevel, и из
// repos/<group>/<repo>/src человек прочитал бы про каталог, в котором не стоит.
check(': отказ называет репозиторий текущего каталога и печатает готовую команду с ним',
  noTarget.msg.includes('Репозиторий текущего каталога — repos/loads_search/cargos-api')
  && noTarget.msg.includes(`promptobus review "${REPO}"`), noTarget.msg);
check(': флаги вызова уезжают в подсказку — повтор стоит одного раза',
  noTargetFlags.threw
  && noTargetFlags.msg.includes(`promptobus review "${REPO}" --task нет-такой --title "моя работа" --dry-run`),
  noTargetFlags.msg);
check(': --dry-run пути не отменяет — гейт стоит раньше плана',
  noTargetDry.threw && /путь к репозиторию обязателен/.test(noTargetDry.msg), noTargetDry.msg);
check(': cwd в корне рабочего места — отказ без готовой команды (toplevel workspace)',
  outsideRepos.threw && /вне рабочего места/.test(outsideRepos.msg)
  && !outsideRepos.msg.includes('повтори с ним'), outsideRepos.msg);
check(': клон на диске рабочего места — отказ называет путь и готовую команду',
  shallowClone.threw && /путь к репозиторию обязателен/.test(shallowClone.msg)
  && shallowClone.msg.includes('повтори с ним'), shallowClone.msg);
check(': каталог вне git — отказ без готовой команды',
  notARepo.threw && /не в git-репозитории/.test(notARepo.msg)
  && !notARepo.msg.includes('повтори с ним'), notARepo.msg);
const plan = planReview(WS, { target: REPO, title: 'работа оркестратора в cargos-api' });
check(`план: адрес reviewer'а из имени репозитория`, plan.address === 'reviewer:cargos-api', plan.address);
check('план: задача заводится с именем, которое дал человек',
  plan.createNew?.id === plan.taskId && plan.createNew.title === 'работа оркестратора в cargos-api',
  plan.createNew?.title);
// Имя даёт и слаг: id задачи человек копирует в команды ожидания и переревью, и
// читаемым он становится вместе с именем.
check('план: имя уехало в слаг задачи, id читаемый',
  plan.createNew.adapter.slug === store.slugify(plan.createNew.title)
  && plan.taskId.startsWith(`${plan.createNew.adapter.slug}-t`), `${plan.createNew.adapter.slug} · ${plan.taskId}`);
check('план: дифф не пуст и включает незакоммиченное',
  /a\.txt/.test(plan.diff) && plan.untracked.includes('new.txt'), plan.untracked.join(','));
// Заголовок уезжает в имя сессии, а в хвост — короткий штамп: сырой id там читался
// как пятнадцать служебных символов вместо даты и времени.
check(`имя сессии reviewer'а: роль первым словом, имя задачи, короткий штамп в хвосте`,
  /^Review: работа оркестратора в cargos-api \(\d{4}-\d{4}\)$/.test(plan.name)
  && plan.argv[plan.argv.indexOf('--name') + 1] === plan.name, plan.name);
// Reviewer поднимается без своего worktree — предмет ревью лежит в чужом дереве, а
// машинного имени ему не нужно вовсе: `--name` не проверяет ни пробелов, ни длины.
check('reviewer: worktree не заводится, машинное имя ему не нужно',
  !plan.argv.includes('--worktree') && plan.name.startsWith('Review: '), plan.argv.join(' '));
// Тот же рычаг, что у worker'а: гейт памяти для фоновой сессии неисполним — подтверждать
// кандидата в ней некому. Окружение живёт в плане, иначе `--dry-run` про него молчит.
// Протекающие переменные предка сняты обоим участникам одной функцией: разойдись
// сборка окружения worker'а и reviewer'а, две фоновые сессии одного run'а поднялись бы с разным.
check(`окружение reviewer'а: протекающие переменные предка сняты`,
  SESSION_ENV_DROP.every((k) => !(k in plan.env))
  && Object.keys(process.env).filter((k) => !SESSION_ENV_DROP.includes(k)).every((k) => k in plan.env),
  Object.keys(plan.env).filter((k) => SESSION_ENV_DROP.includes(k)).join(','));
// : идентичности шины в окружении сессии reviewer'а нет — той же функцией и по той
// же причине, что у worker'а. Окружение фоновой сессии harness выдаёт от первого spawn'а
// run'а, и положенная сюда тройка досталась бы соседям. Читает идентичность Stop-хук, и
// приезжает она ему аргументами команды в файле настроек (ниже).
check(`окружение reviewer'а: идентичности шины в нём нет`,
  ['PROMPTOBUS_ROLE', 'PROMPTOBUS_TASK', 'PROMPTOBUS_HOME'].every((k) => !(k in plan.env)),
  JSON.stringify({ role: plan.env.PROMPTOBUS_ROLE, task: plan.env.PROMPTOBUS_TASK, home: plan.env.PROMPTOBUS_HOME }));
check('план: дифф едет в артефакты задачи',
  plan.diffPath === path.join(WS, '.promptobus', 'tasks', plan.taskId, 'files', 'review-cargos-api.diff'),
  plan.diffPath);
check('план: standalone host не резолвит ревью-скилл модуля',
  plan.skill == null, JSON.stringify(plan.skill));
check('промпт: репозиторий назван, чужой раскладки модулей нет',
  plan.prompt.includes(path.join(REPO, 'AGENTS.md')));
check('промпт: standalone host не вписывает инструменты памяти команд',
  !plan.prompt.includes('search_facts'));
// Reviewer'у доезжает весь канон, и каждое имя пре-аппрувлено: permission-запроса не будет,
// человека за сессией нет, а deny-список пишущие MCP-инструменты не покрывает — он про
// Edit/Write/NotebookEdit/Bash/WebFetch/WebSearch. Границу здесь держит промпт, и она
// обязана быть в нём названа, а не подразумеваться (замечание ревью 2026-08-28).
check('промпт: MCP внешних систем — только на чтение, границу держит сам reviewer',
  plan.prompt.includes('только на чтение')
  && /Не создавай, не меняй, не удаляй и не публикуй/.test(plan.prompt)
  && plan.prompt.includes('пре-аппрувлено'));
check('промпт: standalone host — секции памяти команд нет',
  !plan.prompt.includes('`search_facts`') && !plan.prompt.includes('`save_fact`'));
// : ждать reviewer'у нечем и не надо — его будит надзиратель. Гейт парный
// worker'скому (promptobus.test.mjs): промпт участника лежит в его контексте всегда, поэтому
// уцелевшее там «wait» переживает любое правило, снятое где-то ещё.
check(': промпт reviewer\'а ожидание заводить не велит — будильник в задаче один',
  !/ожидан/i.test(plan.prompt) && !/\bwait\b/.test(plan.prompt)
  && /слушает надзиратель/.test(plan.prompt), plan.prompt);

// : та же норма, что у worker'а, с поправкой на набор reviewer'а — фоновой команды
// у него нет вовсе, объявляет он затянувшееся ревью.
check(': промпт требует объявить затянувшуюся работу status\'ом со сроком',
  /Работа затягивается дольше пары минут молчания/.test(plan.prompt) && /оценкой срока/.test(plan.prompt),
  plan.prompt);
check('промпт: механические проверки объявлены недоступными; standalone процедура без скилла',
  plan.prompt.includes('не прогонялись')
  && /Замечаний нет — так и скажи/.test(plan.prompt)
  && !plan.prompt.includes('только отчёт'));
check('промпт: правила — репозиторий (standalone: без модуля рабочего места)',
  plan.prompt.includes(path.join(REPO, 'AGENTS.md')) && !plan.prompt.includes(['.', 'agents/base/rules'].join('')));
check('read-only: deny перекрывает запись и исполнение',
  ['Edit', 'Write', 'NotebookEdit', 'Bash'].every((t) => plan.settings.permissions.deny.includes(t))
  && plan.settings.permissions.deny === REVIEWER_DENY);
// : read-only — не пожелание, а capability driver'а. Harness, не умеющий снимать
// инструменты, поднял бы reviewer'а с правом записи в ревьюируемое дерево, поэтому отказ
// стоит ДО подъёма и до всякой записи на диск. Живого driver'а без `denyTools` в карте нет,
// и ветка проверяется подставным объектом — тем же приёмом, что `restampOutcome`.
const denyLess = denyToolsRefusal({ id: 'bezrukiy', capabilities: { denyTools: false } });
check(': harness без denyTools ревью не поднимает — отказ называет harness и причину',
  typeof denyLess === 'string' && denyLess.includes('bezrukiy')
  && /снимать инструменты/.test(denyLess) && /правил бы/.test(denyLess), String(denyLess));
check(': у driver\'а с объявленным denyTools отказа нет',
  denyToolsRefusal(plan.driver) === null, String(denyToolsRefusal(plan.driver)));
// : имя файлов reviewer'а в `workers/` — тот же шов, которым их снимает уборка
// `promptobus done`. Разойдись план и уборка, конфиг reviewer'а с подставленными токенами остался
// бы на диске навсегда, и молча: `done` отчитался бы успехом.
check(`: путь конфига reviewer'а выводится из его адреса, а не собирается отдельно`,
  plan.mcpConfigPath === store.participantMcpPath(store.promptobusHome(WS, hostOf(WS)), plan.taskId, plan.address)
  && plan.settingsPath === store.participantSettingsPath(store.promptobusHome(WS, hostOf(WS)), plan.taskId, plan.address)
  && path.basename(plan.mcpConfigPath).startsWith('reviewer-'),
  `${path.basename(plan.mcpConfigPath)} · ${path.basename(plan.settingsPath)}`);
check('settings: MCP-серверы репозитория включены без интерактивного диалога',
  plan.settings.enableAllProjectMcpServers === true);
check(`settings: краткий вид транскрипта, как у worker'а`,
  plan.settings.viewMode === 'focus', JSON.stringify(plan.settings));
check('argv: настройки и шина объявлены, промпт последним',
  plan.argv.includes('--settings') && plan.argv[plan.argv.indexOf('--settings') + 1] === plan.settingsPath
  && plan.argv[plan.argv.indexOf('--allowedTools') + 1] === 'mcp__promptobus'
  && plan.argv[plan.argv.length - 1] === plan.prompt, plan.argv.slice(0, -1).join(' '));
// Канон скиллов reviewer'у — каталогом плагина на одну сессию, без установки:
// его собственная процедура ревью приезжает скиллом модуля, а правила требуют от него тех
// же скиллов, что от worker'а. Прежний канал (enabledPlugins в файле настроек) заставлял
// Claude Code ставить плагин на user-scope — для каталога фоновой сессии проектной
// установки нет.
check('argv: standalone — каталога плагина нет',
  plan.pluginDir == null && !plan.argv.includes('--plugin-dir'), String(plan.pluginDir));
check(`settings reviewer'а: ключей установки плагина в файле участника нет`,
  plan.settings.enabledPlugins === undefined && plan.settings.extraKnownMarketplaces === undefined,
  JSON.stringify(plan.settings));
check(`settings reviewer'а: личные дубли скиллов гасятся по имени`,
  plan.settings.skillOverrides?.['ненужный-скилл'] === 'off', JSON.stringify(plan.settings));
// Набор MCP reviewer'а равен набору worker'а (решение владельца 2026-08-28).
// Read-only держится deny-списком на правке рабочей копии, а не бедностью инструментов.
const rsrv = plan.mcpConfig.mcpServers;
check(`mcp-config reviewer'а: шина есть, внешне-авторизуемый канон ATI — нет`,
  rsrv['promptobus'] !== undefined && rsrv['teamly-mcp'] === undefined
  && rsrv['memory-hooks'] === undefined,
  JSON.stringify(Object.keys(rsrv)));
const rallowed = plan.argv.slice(plan.argv.indexOf('--allowedTools') + 1, plan.argv.indexOf('--add-dir'));
check('argv: каждый доставленный сервер пре-аппрувлен — reviewer поднимается без --permission-mode',
  Object.keys(rsrv).every((n) => rallowed.includes(`mcp__${n}`))
  && rallowed.length === Object.keys(rsrv).length, rallowed.join(' '));
// Положение дел по модулю — строкой рядом с перечнем правил.
check('сигнал модуля: standalone — модуль рабочего места не применяется',
  plan.module.level === 'info' && /host standalone/.test(plan.module.text),
  plan.module.text);
check('argv: модель по умолчанию opus', plan.argv[plan.argv.indexOf('--model') + 1] === 'opus');
// Правила базы лежат вне ревьюируемой копии, а чтение вне рабочей директории Claude Code
// спрашивает разрешением: без --add-dir reviewer встаёт на первом же чтении правил, и
// отчёта никто не дождётся. Запись это не открывает — её снимает deny-список.
const reviewAddDir = plan.argv.indexOf('--add-dir');
// : дифф лежит в артефактах задачи — вне рабочей директории reviewer'а и вне
// каталогов правил. По записанной в этом же файле модели доступа чтение оттуда требует
// разрешения, за которым в bg-сессии некому ответить, а первое указание промпта — как
// раз «прочитай дифф целиком».
check(': каталог диффа открыт --add-dir наравне с каталогами правил',
  plan.argv.includes(path.dirname(plan.diffPath))
  && plan.argv.indexOf(path.dirname(plan.diffPath)) > plan.argv.indexOf('--add-dir'),
  plan.argv.slice(plan.argv.indexOf('--add-dir'), plan.argv.indexOf('--add-dir') + 6).join(' '));

check('argv: каталоги правил открыты --add-dir — reviewer не встанет на чтении правил',
  reviewAddDir > 0 && plan.ruleDirs.length > 0
  && plan.ruleDirs.every((d, i) => plan.argv[reviewAddDir + 1 + i] === d),
  plan.ruleDirs.join(', '));
check(`mcp-config: идентичность reviewer'а в env`,
  plan.mcpConfig.mcpServers['promptobus'].env.PROMPTOBUS_ROLE === plan.address
  && plan.mcpConfig.mcpServers['promptobus'].env.PROMPTOBUS_TASK === plan.taskId);

// --- effort reviewer'а: зеркало контракта spawn ----------------

check('команда: без --effort сессия поднимается на effort по умолчанию — флага в argv нет',
  plan.effort === null && !plan.argv.includes('--effort'));
// Режим прав reviewer'а: без флага — режим бинаря, флаг уезжает в argv на один подъём.
check(': без --permission-mode reviewer идёт на режиме бинаря — флага в argv нет',
  plan.permissionMode === null && !plan.argv.includes('--permission-mode'), plan.argv.join(' '));
let withMode;
await capture(async () => {
  withMode = await review(WS, { target: REPO, title: 'работа оркестратора в cargos-api', dryRun: true, permissionMode: 'acceptEdits' });
});
check(': --permission-mode reviewer\'а уезжает в argv сессии',
  withMode.permissionMode === 'acceptEdits' && withMode.argv[withMode.argv.indexOf('--permission-mode') + 1] === 'acceptEdits',
  withMode.argv.slice(-6).join(' '));

// План на `--effort high` считается один раз на три проверки: `review()` возвращает
// тот же план, что `planReview()` (`dryRun` — вход отказа «путь обязателен», на
// посчитанный план он не влияет), и лишний его расчёт стоит десятка процессов `git`
//. Тем же приёмом ниже сведены пары «план + его же --dry-run».
let withEffort;
const dryEffort = await capture(async () => {
  withEffort = await review(WS, { target: REPO, title: 'работа оркестратора в cargos-api', dryRun: true, effort: 'high' });
});
check(`команда: --effort reviewer'а передаётся сессии сразу после --model <value>`,
  withEffort.effort === 'high'
  && withEffort.argv[withEffort.argv.indexOf('--effort') + 1] === 'high'
  && withEffort.argv.indexOf('--effort') === withEffort.argv.indexOf('--model') + 2
  && withEffort.argv.at(-1) === withEffort.prompt, withEffort.argv.slice(-6).join(' '));

for (const level of EFFORT_LEVELS) {
  const p = level === 'high'
    ? withEffort
    : planReview(WS, { target: REPO, title: 'работа оркестратора в cargos-api', effort: level });
  check(`--effort: значение «${level}» принято`, p.effort === level);
}

const badEffort = expectThrow(() => planReview(WS, { target: REPO, title: 'работа оркестратора в cargos-api', effort: 'super-high' }));
check('--effort: неизвестное значение → понятный отказ, а не молчаливый дефолт',
  badEffort.threw && /effort/i.test(badEffort.msg) && badEffort.msg.includes('super-high')
  && EFFORT_LEVELS.every((l) => badEffort.msg.includes(l)), badEffort.msg);

check('dry-run: заданный effort печатается как применяемый',
  /effort: high/.test(dryEffort) && !/effort: high \(не применяется/.test(dryEffort), dryEffort);
check(`dry-run без живого reviewer'а: модель тоже печатается как применяемая`,
  /модель: opus/.test(dryEffort) && !/модель: opus \(/.test(dryEffort), dryEffort);

// --- переревью: тот же адрес, но только в живую сессию ----------------
//
// Живость reviewer'а планировщик сверяет по `claude agents --json` — бинарь подменяем
// фейком на PATH: живой claude тесту не нужен, а состояние сессии задавать нужно.
const BIN = path.join(SB, 'bin');
mkdirSync(BIN, { recursive: true });
const PATH0 = process.env.PATH;
// Spawn через тот же фейк и записывает свой argv: последним аргументом там идёт промпт,
// и только по нему видно, ЧТО ушло поднятому reviewer'у — статические поля плана про
// выбранную ветку не говорят ничего.
//
// Сценарий фейка — на JS через общий помощник песочницы (sandbox.mjs): `#!/bin/sh` без
// расширения на Windows не находится вовсе, и тест краснел бы там при исправном коде
//. `claudeSays` принимает то, что фейк ПЕЧАТАЕТ; отказ — отдельным вызовом.
const BG_ARGV = path.join(SB, 'bg-argv.txt');
// Подъём reviewer'а сверяется со списком `claude agents`: «backgrounded» без
// сессии в списке успехом больше не считается. Поэтому фейк отвечает на `agents`
// по-разному до и после `--bg` — ровно как живой claude, у которого сессия появляется
// в списке только запуском. Имя поднятой сессии фейк берёт из `--name`, то есть оттуда
// же, откуда его берёт claude; сценарий (`claudeSays`, `claudeFails`) прошлый подъём
// сбрасывает — иначе он тянулся бы в следующую ветку теста.
const BG_RAISED = path.join(SB, 'bg-raised.txt');
const claudeStub = (body) => {
  stubCommand(BIN, 'claude', `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--bg') {
  writeFileSync(${JSON.stringify(BG_ARGV)}, args.join('\\n'));
  // STUB_SILENT_FAIL — молчаливый сбой демона: «backgrounded», код 0, сессии нет.
  // Наблюдался живьём и есть единственная причина, по которой сверка
  // подъёма вообще заведена.
  if (!process.env.STUB_SILENT_FAIL) writeFileSync(${JSON.stringify(BG_RAISED)}, args[args.indexOf('--name') + 1] ?? '');
}
if (args[0] === 'agents' && existsSync(${JSON.stringify(BG_RAISED)})) {
  const raised = readFileSync(${JSON.stringify(BG_RAISED)}, 'utf8');
  // STUB_GHOST — под именем лежит запись прошлой сессии, пережившая свой демон: имя
  // совпадает, pid'а нет, а у соседней записи он есть (самокалибровка sessionLiveness).
  process.stdout.write(JSON.stringify(process.env.STUB_GHOST
    ? [{ id: 'ghost1', name: raised, state: 'blocked' }, { id: 'alive9', name: 'Worker: чужой', pid: 4242 }]
    : [{ id: 'sess-live', name: raised, status: 'running' }]));
  process.exit(0);
}
${body}`);
  rmSync(BG_RAISED, { force: true });
  process.env.PATH = `${BIN}${path.delimiter}${PATH0}`;
};
const claudeSays = (out) => claudeStub(`process.stdout.write(${JSON.stringify(out)});`);
const claudeFails = () => claudeStub('process.exit(1);');
const bgArgv = () => (existsSync(BG_ARGV) ? readFileSync(BG_ARGV, 'utf8') : '');

const home = path.join(WS, '.promptobus');
const task = store.createTask(home, { id: 't20260824-100000', title: 'ревью loads_search/cargos-api' });
const SESSION = 'a2a-t20260824-100000-reviewer-cargos-api';
store.upsertParticipant(home, task.id, store.participantRecord('reviewer:cargos-api', { repo: 'loads_search/cargos-api', name: SESSION }));
writeFileSync(path.join(store.filesDir(home, task.id), 'review-cargos-api.diff'), 'старый дифф\n');

claudeSays(JSON.stringify([{ name: SESSION, status: 'running' }]));

// Резолв бинаря — не предмет веток ниже: «каким именно claude поднят reviewer» проверяет
//  своим `tool`, а поиск по PATH и разбор версии — tools.test.mjs. Каждый резолв
// запускает `claude --version`, то есть ещё один старт node подставным бинарём ценой
// около 71 мс; на двенадцать прогонов, которые до него доходят, это 0,85 с CPU.
// Прогонов в файле больше, но переревью бинаря не резолвит вовсе — гейт стоит под
// `if (!plan.reuse)`, а ветка reuse возвращается раньше второго вызова. Спрашиваем один
// раз и отдаём ответ швом `tool`, объявленным для этого самим review().
//
// Бесшовным остаётся `deadOut` ниже — прогон, с которого читают проверки «мёртвая
// сессия: новому reviewer'у ушёл полный промпт» и следующие за ней. Верни резолв не то
// (мутационная проба 2026-08-31: путь к несуществующему бинарю вместо найденного), и
// файл встаёт ровно на этом вызове — «бинарь пропал между проверкой и запуском». Ещё
// три прогона идут отдельными процессами (`liftoffRun` и запуск с `FAIL_TITLE`), и туда
// шов не передаётся вовсе: каждый резолвит бинарь сам.
const TOOL = { ok: true, bin: path.join(BIN, 'claude') };

// Что живой сессии уходит именно переревью, решает review() по plan.reuse — поле
// плана об этом не говорит: `prompt` и `reReview` в плане лежат оба и всегда. План
// берётся из этого же вызова: считать его вторым разом незачем.
let again;
const dryReuse = await capture(async () => { again = await review(WS, { target: REPO, task: task.id, dryRun: true }); });
check(`переревью: сессия жива — участник найден, второго spawn'а не будет`,
  !!again.participant && again.sessionState === 'alive' && again.reuse === true, again.sessionState);
check('переревью: живой сессии уходит переревью — про новый дифф, без повторного онбординга',
  dryReuse.includes(again.reReview) && !dryReuse.includes('## Протокол связи')
  && again.reReview.includes('Переревью') && again.reReview.includes(again.diffPath), dryReuse);
check('переревью: старый дифф не перетирается — имя с номером',
  again.diffPath.endsWith('review-cargos-api-2.diff'), again.diffPath);

// : имя занимает САМА запись, а не проверка перед ней. Прежде свободное имя искал
// цикл `existsSync`, а писал его вызывающий — между проверкой и записью успевало
// вклиниться второе ревью того же слага, и оно перетирало дифф, который живой reviewer,
// возможно, читал прямо сейчас. Гонку изнутри одной команды не воспроизвести (между
// планом и записью в ней не происходит ничего чужого), поэтому проверяется сама запись.
const RACE = path.join(SB, 'race-artifacts');
const firstDiff = writeDiff(RACE, 'gonka', 'дифф первого\n');
const secondDiff = writeDiff(RACE, 'gonka', 'дифф второго\n');
check(': второй дифф того же слага занял своё имя, а не перетёр чужой',
  firstDiff.endsWith('review-gonka.diff') && secondDiff.endsWith('review-gonka-2.diff')
  && readFileSync(firstDiff, 'utf8') === 'дифф первого\n'
  && readFileSync(secondDiff, 'utf8') === 'дифф второго\n',
  `${path.basename(firstDiff)} · ${path.basename(secondDiff)} · ${JSON.stringify(readFileSync(firstDiff, 'utf8'))}`);
check(': третий идёт следующим номером, а не встаёт на второй',
  writeDiff(RACE, 'gonka', 'дифф третьего\n').endsWith('review-gonka-3.diff')
  && readFileSync(secondDiff, 'utf8') === 'дифф второго\n');

let againEffort;
const dryReuseEffort = await capture(async () => {
  againEffort = await review(WS, { target: REPO, task: task.id, dryRun: true, effort: 'max' });
});
check('переревью: --effort не пересоздаёт живую сессию — дифф уходит той же',
  againEffort.reuse === true && againEffort.sessionState === 'alive'
  && againEffort.effort === 'max',
  `reuse=${againEffort.reuse} state=${againEffort.sessionState}`);
check('dry-run переревью alive: effort помечен как неприменённый — сессия уже жива',
  /effort: max \(не применяется — сессия уже жива\)/.test(dryReuseEffort), dryReuseEffort);
// Модель живой сессии переревью не меняет ровно так же, как effort: argv
// не исполняется, уходит только дифф.
const dryReuseModel = await capture(() => review(WS, { target: REPO, task: task.id, dryRun: true, model: 'sonnet' }));
check('dry-run переревью alive: --model помечен как неприменённый, а не выдан за применённый',
  /модель: sonnet \(не применяется — сессия уже жива\)/.test(dryReuseModel), dryReuseModel);

// Запись, сделанная ДО запуска, reviewer'ом не считается: сорвавшийся запуск оставляет её
// на месте, а живость подтвердить нечем — `claude agents --json` не добыт ровно там, где
// бинаря нет вовсе. Без пометки повтор уходил в переревью и слал `type=task` в inbox, за
// которым никого нет (замечание ревью по , беда класса ).
const pendingTask = store.createTask(home, { id: 't20260827-230000', title: 'ревью с сорвавшимся запуском' });
store.upsertParticipant(home, pendingTask.id, store.participantRecord('reviewer:cargos-api', { repo: 'loads_search/cargos-api',
  name: 'a2a-t20260827-230000-reviewer-cargos-api',
  pending: true }));
claudeStub('process.exit(1);');
const pendingUnknown = planReview(WS, { target: REPO, task: pendingTask.id });
check('запись до запуска: живость не подтверждена — переревью не шлётся, поднимается reviewer',
  pendingUnknown.sessionState === 'unknown' && pendingUnknown.unlaunched === true
  && pendingUnknown.reuse === false,
  `state=${pendingUnknown.sessionState} unlaunched=${pendingUnknown.unlaunched} reuse=${pendingUnknown.reuse}`);

// Обратная сторона той же поправки: запись с пометкой, чья сессия НАШЛАСЬ живой, —
// обычный reviewer. Иначе переревью перестало бы работать всякий раз, когда второй
// upsert не успел снять пометку.
claudeSays(JSON.stringify([{ name: 'a2a-t20260827-230000-reviewer-cargos-api', status: 'running' }]));
const pendingAlive = planReview(WS, { target: REPO, task: pendingTask.id });
check('запись до запуска: сессия нашлась живой — это обычное переревью, а не второй reviewer',
  pendingAlive.sessionState === 'alive' && pendingAlive.unlaunched === false
  && pendingAlive.reuse === true, `state=${pendingAlive.sessionState} reuse=${pendingAlive.reuse}`);

// Печать обязана говорить то же, что сделает реальный прогон: на записи до запуска он
// поднимет нового reviewer'а, а прежний текст обещал «уже на шине — уйдёт новый дифф».
claudeStub('process.exit(1);');
const dryPending = await capture(() => review(WS, { target: REPO, task: pendingTask.id, dryRun: true }));
check('dry-run на записи до запуска: сказано, что reviewer не поднимался, а не «уже на шине»',
  /запись сделана до запуска, reviewer не поднимался/.test(dryPending)
  && !/уже на шине/.test(dryPending), dryPending.slice(-600));

// Обратная половина пометки, и держится она на неочевидном: applyParticipant заменяет
// запись целиком, поэтому второй upsert без pending её и стирает. Поменяй кто-нибудь его
// на слияние — пометка залипнет, и каждое переревью молча поднимало бы второго reviewer'а
// на живую сессию: беда, зеркальная только что закрытой (замечание второго круга ревью).
claudeSays('[]');
await capture(() => review(WS, { tool: TOOL, target: REPO, task: pendingTask.id }));
const relaunched = store.participantOf(store.readTask(home, pendingTask.id), 'reviewer:cargos-api')?.metadata;
check(`: успешный запуск снимает pending — запись становится обычным reviewer'ом`,
  !!relaunched && !('pending' in relaunched), JSON.stringify(relaunched));

// : хук сторожа цикла нужен reviewer'у по той же причине, что worker'у, — он такой
// же участник с mailbox'ом, а до сессии в чужом каталоге хук рабочего места не доезжает.
// Сверяется ФАЙЛ с диска, и берётся он после НАСТОЯЩЕГО запуска: пишет его `review`, а не
// план, и сверка плана прошла бы при пустом файле. Команда — у той же функции, что кладёт
// хук в layout: вторая её копия разошлась бы молча (замечание ревью).
const reviewerSettings = JSON.parse(readFileSync(
  store.participantSettingsPath(home, pendingTask.id, 'reviewer:cargos-api'), 'utf8',
));
const reviewerGuard = reviewerSettings.hooks?.[GUARD_HOOK_EVENT]?.[0]?.hooks?.[0];
const reviewerIdentity = { address: 'reviewer:cargos-api', taskId: pendingTask.id, home };
check(`: настройки reviewer'а несут Stop-хук сторожа цикла — ту же команду, что у layout'а`,
  reviewerGuard?.type === 'command'
  && reviewerGuard?.command === guardHookCommand(WS, reviewerIdentity),
  JSON.stringify(reviewerSettings.hooks ?? null));
check(`участнику SessionStart не кладётся — детектор смотрит корень workspace`,
  reviewerSettings.hooks?.SessionStart === undefined,
  JSON.stringify(reviewerSettings.hooks ?? null));
// : адрес в команде хука — reviewer'ский, а не worker'ский. Ровно это и разъезжалось,
// пока идентичность приходила из окружения: две сессии одной задачи резолвились одним адресом,
// и вторая переписывала contact point первой.
check(`: команда хука reviewer'а несёт ЕГО адрес, задачу и дом`,
  reviewerGuard?.command?.includes(` --role reviewer:cargos-api --task ${pendingTask.id} --home ${home}`) === true,
  String(reviewerGuard?.command));

// --task и --title вместе: справка объявляет их взаимоисключающими, и молчаливая
// пропажа имени давала человеку чужой заголовок в имени сессии (замечание ревью).
let bothFlags;
const dryBoth = await capture(async () => {
  bothFlags = await review(WS, { target: REPO, task: task.id, title: 'моё имя', dryRun: true });
});
check('--task с --title: имя не применяется, и план об этом говорит',
  bothFlags.titleIgnored === true && bothFlags.createNew === null, String(bothFlags.titleIgnored));
check('--task с --title: dry-run называет журнал задачи источником имени',
  /--title не применяется — имя берётся из журнала задачи/.test(dryBoth), dryBoth.slice(-500));

// Сессия reviewer'а закрыта (`claude stop`): переревью ушло бы ей в inbox навсегда,
// и вызвавший ждал бы отчёта, которого не будет.
claudeSays('[]');
const dead = planReview(WS, { target: REPO, task: task.id });
check(`мёртвая сессия: переревью в inbox не уходит — план поднимает нового reviewer'а`,
  dead.sessionState === 'dead' && dead.reuse === false, dead.sessionState);
rmSync(BG_ARGV, { force: true });
const deadOut = await capture(() => review(WS, { target: REPO, task: task.id }));
check(`мёртвая сессия: новому reviewer'у ушёл полный промпт, а не «проверь свои прошлые замечания»`,
  bgArgv().includes('## Протокол связи') && !bgArgv().includes('Переревью'),
  bgArgv().slice(0, 200) || 'claude --bg не звался вовсе');
check('мёртвая сессия: предупреждение называет смерть сессии и потерю прошлых находок',
  /мертва/.test(deadOut) && /прошлые находки/.test(deadOut) && /поднят/.test(deadOut), deadOut);
// Подсказка после spawn'а давала имя сессии из вывода `claude --bg`, а `--task` его
// не принимает: печатаем готовые команды с настоящим id задачи.
check('spawn: подсказки печатают команды с id задачи, а не с именем сессии',
  deadOut.includes(`задачи ${task.id}`)
  && deadOut.includes(`promptobus review "${realpathSync(REPO)}" --task ${task.id}`)
  && !/--task a2a-/.test(deadOut), deadOut);
// : ждать отчёт нечем и не надо — разбудит надзиратель.
check(': подсказка ведёт к надзирателю и mailbox, а не к ожиданию',
  /разбудит тебя надзиратель/.test(deadOut) && !/promptobus wait/.test(deadOut), deadOut);
check('мёртвая сессия: в inbox мёртвого адреса ничего не легло',
  store.countInbox(home, task.id, 'reviewer:cargos-api') === 0,
  String(store.countInbox(home, task.id, 'reviewer:cargos-api')));

// --- : подъём reviewer'а сверяется с реестром сессий -----------------------
//
// Прежде этот блок был построчной копией блока worker'а и разъехался с ним ровно на
// сверку: worker после запуска ждал появления сессии в `claude agents` (`awaitSession`),
// reviewer брал id из вывода `claude --bg` как есть. Молчаливый сбой демона —
// «backgrounded», код 0, сессии нет — отчитывался успехом, и оркестратор ждал отчёта,
// которого не будет. Проверяется отдельным процессом: отказ идёт через `fail()`, а тот
// уносит процесс мимо сводки вердиктов.
const liftoffRun = (opts, env = {}) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(reviewUrl)});\n`
    + `await m.review(${JSON.stringify(WS)}, ${JSON.stringify(opts)});`,
  ], { encoding: 'utf8', cwd: SB, env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}`, ...env } });
  return { status: r.status, text: `${r.stdout}${r.stderr}` };
};

claudeSays('[]');
const silentTask = store.createTask(home, { id: 't20260829-100000', title: 'ревью с молчаливым сбоем демона' });
const silent = liftoffRun(
  { target: REPO, task: silentTask.id, awaitOptions: { tries: 2, delayMs: 1 } },
  { STUB_SILENT_FAIL: '1' },
);
check(`: сессии reviewer'а в claude agents нет — отказ, а не доклад об успехе`,
  silent.status === 1 && /живой сессии .* в claude agents нет — reviewer НЕ поднят/.test(silent.text)
  && !/reviewer reviewer:cargos-api поднят/.test(silent.text), `status=${silent.status} ${silent.text}`);
check(`: отказ по несостоявшейся сессии называет маршрут переподъёма reviewer'а`,
  /Поднимай reviewer'а заново: promptobus review/.test(silent.text)
  && silent.text.includes(`--task ${silentTask.id}`), silent.text);
const silentPart = store.participantOf(store.readTask(home, silentTask.id), 'reviewer:cargos-api')?.metadata;
check(`: запись reviewer'а на месте и после отказа — повтор поднимет его тем же адресом`,
  !!silentPart, JSON.stringify(store.readTask(home, silentTask.id).participants));
// Замечание ревью: пометку `pending` снимает только удавшийся подъём. Второй upsert
// случается и на отказе (id сессии дописывается в любом исходе), а applyParticipant
// заменяет запись целиком — без этой развилки запись становилась неотличима от записи
// живого reviewer'а.
check('замечание ревью: отказ по несостоявшейся сессии пометку pending не снимает',
  silentPart?.pending === true, JSON.stringify(silentPart));
// Ради чего всё: на неразобранном `claude agents --json` повтор без пометки считал бы
// reviewer'а живым и слал `type=task` в mailbox, за которым никого нет.
claudeStub('process.exit(1);');
const afterSilent = planReview(WS, { target: REPO, task: silentTask.id });
check(`замечание ревью: повтор после отказа поднимает reviewer'а, а не шлёт переревью в пустой mailbox`,
  afterSilent.unlaunched === true && afterSilent.reuse === false
  && afterSilent.sessionState === 'unknown',
  `unlaunched=${afterSilent.unlaunched} reuse=${afterSilent.reuse} state=${afterSilent.sessionState}`);
// Сценарий обратно: следующая проверка поднимает reviewer'а, и `--bg` ей нужен удачным.
claudeSays('[]');

// Совпавшего имени мало: запись прошлой сессии из списка не исчезает, и перезапуск
// reviewer'а тем же адресом отчитался бы её id — тот самый живой призрак .
const ghostTask = store.createTask(home, { id: 't20260829-101500', title: 'ревью на призрачной записи' });
const ghost = liftoffRun(
  { target: REPO, task: ghostTask.id, awaitOptions: { tries: 2, delayMs: 1 } },
  { STUB_GHOST: '1' },
);
check(': призрак под тем же именем подъёмом не считается — отказ называет его',
  ghost.status === 1 && /запись прошлой сессии \(ghost1\)/.test(ghost.text), `status=${ghost.status} ${ghost.text}`);

// Обратная сторона сверки: список не разобран — это не смерть. Reviewer поднят,
// но неподтверждённость названа вслух, как у worker'а.
const unverifiedTask = store.createTask(home, { id: 't20260829-103000', title: 'ревью без разбора списка' });
// Запуск удаётся, а список сессий не добывается: `agents` отвечает ненулевым кодом, и
// отметку о подъёме фейк не ставит — иначе её увидела бы сверка вместо неразобранного
// списка.
claudeStub("if (args[0] === 'agents') process.exit(1);\nprocess.stdout.write('backgrounded · abc123');");
process.env.STUB_SILENT_FAIL = '1';
const unverified = await capture(() => review(WS, {
  tool: TOOL, target: REPO, task: unverifiedTask.id, awaitOptions: { tries: 2, delayMs: 1 },
}));
delete process.env.STUB_SILENT_FAIL;
check(': список сессий не разобран — не отказ, а названная вслух неподтверждённость',
  /reviewer reviewer:cargos-api поднят/.test(unverified)
  && /подъём сессии .* не подтверждён/.test(unverified), unverified);

// Порядок источников id тот же, что у worker'а (`spawnedSessionId`): запись из `claude agents`
// — прямой ответ harness'а, разбор вывода `claude --bg` остаётся запасным.
claudeSays('[]');
const idTask = store.createTask(home, { id: 't20260829-104500', title: 'ревью и id сессии' });
await capture(() => review(WS, { tool: TOOL, target: REPO, task: idTask.id }));
const idPart = store.participantOf(store.readTask(home, idTask.id), 'reviewer:cargos-api')?.metadata;
check(`: id сессии reviewer'а взят из claude agents, а не из разбора вывода`,
  idPart?.session === 'sess-live', JSON.stringify(idPart));

// Вывод `claude agents --json` не разобран: состояние неизвестно, а не «мертво» —
// консервативно шлём прежним адресом, но говорим, что живость не подтверждена.
claudeFails();
const unknown = planReview(WS, { target: REPO, task: task.id });
check(`состояние сессии неизвестно — прежний адрес, второго reviewer'а не поднимаем`,
  unknown.sessionState === 'unknown' && unknown.reuse === true, unknown.sessionState);
const dryUnknownEffort = await capture(() => review(WS, { target: REPO, task: task.id, dryRun: true, effort: 'high', model: 'sonnet' }));
check('dry-run unknown: effort и модель нейтральны, не утверждают что сессия жива',
  /effort: high \(не применяется — дифф уйдёт прежнему адресу\)/.test(dryUnknownEffort)
  && /модель: sonnet \(не применяется — дифф уйдёт прежнему адресу\)/.test(dryUnknownEffort)
  && !/сессия уже жива/.test(dryUnknownEffort)
  && /живость сессии не подтверждена/.test(dryUnknownEffort), dryUnknownEffort);
const unknownOut = await capture(() => review(WS, { target: REPO, task: task.id }));
check('неизвестное состояние: дифф ушёл прежним адресом с честным предупреждением',
  /подтвердить нечем/.test(unknownOut) && store.countInbox(home, task.id, 'reviewer:cargos-api') === 1,
  unknownOut);
check('переревью: подсказка тоже называет id задачи',
  unknownOut.includes(`задачи ${task.id}`) && !/promptobus wait/.test(unknownOut), unknownOut);

// --- счётчик непрочитанного -----------------------------------------
//
// `promptobus review` — ход оркестратора, и о накопившемся в его собственном mailbox'е вывод
// команды остаётся последним местом, где можно сказать. Ноль не называем: строка,
// печатающаяся всегда, перестаёт читаться вместе с непустой.
const quietReview = await capture(() => review(WS, { target: REPO, task: task.id }));
check(': пустой mailbox оркестратора вывод `promptobus review` не называет',
  !/твой mailbox/.test(quietReview), quietReview);
store.sendMessage(home, task.id, {
  from: 'reviewer:cargos-api', to: 'orchestrator', type: 'result', body: `отчёт reviewer'а лежит непрочитанным`,
});
const loudReview = await capture(() => review(WS, { target: REPO, task: task.id }));
check(`: непрочитанное в mailbox'е оркестратора названо в выводе \`promptobus review\` вместе с маршрутом`,
  /твой mailbox: непрочитано 1 — забери инструментом promptobus_mailbox/.test(loudReview), loudReview);
check(': счётчик — notification, а не читатель: сообщение осталось в inbox',
  store.countInbox(home, task.id, 'orchestrator') === 1,
  String(store.countInbox(home, task.id, 'orchestrator')));
store.readInbox(home, task.id, 'orchestrator');

claudeSays('backgrounded · cafe12 · a2a-reviewer');
const effortTask = store.createTask(home, { id: 't20260825-140000', title: 'ревью effort' });
await capture(() => review(WS, { tool: TOOL, target: REPO, task: effortTask.id, effort: 'high' }));
const effortPart = store.participantOf(store.readTask(home, effortTask.id), 'reviewer:cargos-api')?.metadata;
check(`spawn reviewer'а: effort пишется в участника, как у worker'а`,
  effortPart?.effort === 'high', JSON.stringify(effortPart));

// Задача, которую этот же вызов и заводит (`--task` не задан), счётчика не получает:
// её mailbox пуст по построению, а накопившееся лежит в той задаче, откуда пришли, —
// и какая она, здесь неизвестно. Гадать по «единственной активной» нельзя.
store.sendMessage(home, task.id, {
  from: 'reviewer:cargos-api', to: 'orchestrator', type: 'result', body: 'лежит в чужой задаче',
});
const freshTaskOut = await capture(() => review(WS, { tool: TOOL, target: REPO, title: 'работа оркестратора в cargos-api' }));
check(': ревью, заводящее свою задачу, чужого счётчика не называет',
  !/непрочитано/.test(freshTaskOut), freshTaskOut);
store.readInbox(home, task.id, 'orchestrator');

const plainTask = store.createTask(home, { id: 't20260825-150000', title: 'ревью без effort' });
await capture(() => review(WS, { tool: TOOL, target: REPO, task: plainTask.id }));
const plainPart = store.participantOf(store.readTask(home, plainTask.id), 'reviewer:cargos-api')?.metadata;
check('spawn без --effort: поля effort в участнике нет',
  plainPart && !('effort' in plainPart), JSON.stringify(plainPart));
// Ревью входит в задачу worker'а: слаг задачи берётся из её журнала и встаёт в
// начало имени reviewer'а, машинный штамп остаётся в хвосте.
const slugged = store.createTask(home, {
  id: 'bl-076-imena-t20260825-160000', title: ' читаемые имена',
  slug: 'bl-076-imena', stamp: 't20260825-160000',
});
const namedPlan = planReview(WS, { target: REPO, task: slugged.id });
check(`имя сессии reviewer'а: заголовок задачи словами, штамп в скобках`,
  namedPlan.name === 'Review:  читаемые имена (0825-1600)', namedPlan.name);
store.closeTask(home, slugged.id);

// Ревью без --task заводит свою задачу, даже когда рядом висит активная чужая:
// подселённое ревью кладёт два несвязанных предмета в один журнал, и надзиратель такой
// задачи будит её оркестратора на чужие сообщения.
const foreign = store.createTask(home, {
  id: 'chuzhaya-t20260825-170000', title: 'Бриф: чужая задача',
  slug: 'chuzhaya', stamp: 't20260825-170000',
});
let own;
const secondOut = await capture(async () => {
  own = await review(WS, { target: REPO, title: 'работа оркестратора в cargos-api', dryRun: true });
});
check('без --task: ревью заводит свою задачу, а не подселяется в активную чужую',
  own.taskId !== foreign.id && own.createNew?.title === 'работа оркестратора в cargos-api',
  `${own.taskId} vs ${foreign.id}`);
const joined = planReview(WS, { target: REPO, task: foreign.id });
check('--task: присоединение к существующей задаче — только явным флагом',
  joined.taskId === foreign.id && joined.createNew === null, joined.taskId);
// Активных задач становится несколько, и резолв «единственной активной» перестаёт
// срабатывать: об этом команда предупреждает сразу, а не отказом в следующем вызове.
check('план знает о соседних активных задачах',
  own.otherActive.includes(foreign.id) && joined.otherActive.length === 0, own.otherActive.join(','));
check('предупреждение о второй активной задаче с готовой командой закрытия',
  /активн[аы] ещё задач/.test(secondOut) && secondOut.includes(foreign.id)
  && /--task/.test(secondOut) && /promptobus done --task/.test(secondOut), secondOut);
store.closeTask(home, foreign.id);

store.closeTask(home, effortTask.id);
store.closeTask(home, plainTask.id);

// --- worktree клона: законная цель --------------------------------------------

const WT = path.join(REPO, '.claude', 'worktrees', 'a2a-worker');
g(REPO, 'worktree', 'add', '-q', '-b', 'worktree-a2a', WT);
const wt = planReview(WS, { target: WT, task: task.id });
check('worktree клона — законная цель, репозиторий берётся из пути',
  wt.nsPath === 'loads_search/cargos-api' && wt.repoDir === realpathSync(WT), wt.repoDir);

// --- клон в подгруппе и его worktree ---------------------------------
//
// Namespace бывает глубже двух сегментов, а у worktree свой git-toplevel — он
// указывает внутрь клона, а не на его корень. Второй сегмент пути раньше брался
// за репозиторий, и reviewer живой оркестрации получил адрес по промежуточной
// подгруппе: `reviewer:cargo-vibe` вместо `reviewer:ls-ai-skills`.
const SUB = path.join(WS, 'repos', 'ls', 'cargo-vibe', 'ls-ai-skills');
mkdirSync(SUB, { recursive: true });
g(SUB, 'init', '-b', 'main');
writeFileSync(path.join(SUB, 'a.txt'), 'v1\n');
g(SUB, 'add', '.');
g(SUB, 'commit', '-m', 'init', '-q');
writeFileSync(path.join(SUB, 'a.txt'), 'v2\n');
const sub = planReview(WS, { target: SUB, task: task.id });
check('клон в подгруппе: репозиторий — сам клон, а не промежуточная подгруппа',
  sub.nsPath === 'ls/cargo-vibe/ls-ai-skills' && sub.address === 'reviewer:ls-ai-skills',
  `${sub.nsPath} · ${sub.address}`);

const SUBWT = path.join(SUB, '.claude', 'worktrees', 'a2a-ls-ai-skills-0826-0215');
g(SUB, 'worktree', 'add', '-q', '-b', 'worktree-a2a-ls', SUBWT);
writeFileSync(path.join(SUBWT, 'a.txt'), 'v3\n');
const subWt = planReview(WS, { target: SUBWT, task: task.id });
check('worktree клона в подгруппе: адрес по репозиторию, дифф — по worktree',
  subWt.nsPath === 'ls/cargo-vibe/ls-ai-skills'
  && subWt.address === 'reviewer:ls-ai-skills'
  && subWt.repoDir === realpathSync(SUBWT),
  `${subWt.nsPath} · ${subWt.address} · ${subWt.repoDir}`);

// --- предмет ревью: worktree worker'а --------------------------
//
// Живой расклад 2026-08-26. Оркестратор закоммитил работу локально и не запушил, а
// worker ветвился от локальной default-ветки: `origin/main` этой работы не содержит,
// и она целиком уезжала в дифф reviewer'а — двенадцать файлов и 205 строк вместо трёх и
// 26. Фикстура ставит `origin/main` намеренно позади локальной `main` — ровно та
// картина. Второй worker того же репозитория здесь же: до  слаг reviewer'а брался
// с корня клона, и ревью второго уходило живому reviewer'у первого как переревью.
const gOut = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).stdout.trim();
const OWN = path.join(WS, 'repos', 'loads_search', 'base-api');
mkdirSync(OWN, { recursive: true });
g(OWN, 'init', '-b', 'main');
writeFileSync(path.join(OWN, 'AGENTS.md'), 'Правила репозитория.\n');
writeFileSync(path.join(OWN, 'obshee.txt'), 'общий код\n');
g(OWN, 'add', '.');
g(OWN, 'commit', '-m', 'init', '-q');
const PUSHED = gOut(OWN, 'rev-parse', 'HEAD');
g(OWN, 'update-ref', 'refs/remotes/origin/main', PUSHED);
// `origin/HEAD` — по той же причине, что у cargos-api выше: детект default-ветки
// заканчивается на первой ссылке. Картину  она не трогает — `origin/main` как
// стояла позади локальной `main`, так и стоит.
g(OWN, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
writeFileSync(path.join(OWN, 'orkestrator.txt'), 'незапушенная работа оркестратора\n');
g(OWN, 'add', '.');
g(OWN, 'commit', '-m', 'работа оркестратора мимо origin', '-q');
const FORK = gOut(OWN, 'rev-parse', 'HEAD');

const W1 = path.join(OWN, '.claude', 'worktrees', 'a2a-pervyy');
g(OWN, 'worktree', 'add', '-q', '-b', 'worktree-a2a-pervyy', W1, 'main');
writeFileSync(path.join(W1, 'pervyy.txt'), `работа первого worker'а\n`);
g(W1, 'add', '.');
g(W1, 'commit', '-m', 'работа первого', '-q');
const W2 = path.join(OWN, '.claude', 'worktrees', 'a2a-vtoroy');
g(OWN, 'worktree', 'add', '-q', '-b', 'worktree-a2a-vtoroy', W2, 'main');
writeFileSync(path.join(W2, 'vtoroy.txt'), `работа второго worker'а\n`);
g(W2, 'add', '.');
g(W2, 'commit', '-m', 'работа второго', '-q');
// Третий worker ещё ничего не сделал: его дифф пуст.
const W3 = path.join(OWN, '.claude', 'worktrees', 'a2a-tretiy');
g(OWN, 'worktree', 'add', '-q', '-b', 'worktree-a2a-tretiy', W3, 'main');

const owned = store.createTask(home, {
  id: 'bl-118-baza-t20260826-120000', title: ' база диффа', slug: 'bl-118-baza', stamp: 't20260826-120000',
});
// `title` — заголовок куска работы worker'а: из него собрано имя его сессии, и по нему
// же зовётся сессия его reviewer'а. Без него — запись прежнего CLI: этого поля
// у неё нет, и заголовок берётся у задачи, как раньше.
// Запись участника собирает дверь механизма: адрес и поля механизма едут в `metadata`,
// собственные поля v1 — роль, harness, режим, session reference и снимок capabilities.
const worker = (address, worktree, wtName, title = null, extra = {}) => store.participantRecord(address, {
  repo: 'loads_search/base-api',
  repoAbs: OWN,
  worktree,
  worktreeName: wtName,
  branch: `worktree-${wtName}`,
  ...(title ? { title } : {}),
  name: `Worker: ${title ?? owned.title} (0826-1200, ${address.slice('worker:'.length)})`,
  ...extra,
});
store.upsertParticipant(home, owned.id, worker('worker:pervyy', W1, 'a2a-pervyy', `Точка ветвления worker'а`, { baseSha: FORK }));
store.upsertParticipant(home, owned.id, worker('worker:vtoroy', W2, 'a2a-vtoroy', 'Reviewer по предмету ревью', { baseSha: FORK }));

// Фикстура обязана воспроизводить беду, иначе проверки ниже зелёные по любой причине:
// от прежней базы дифф worker'а действительно тащит чужую работу.
check(`фикстура: от origin/main в дифф первого worker'а попадает работа оркестратора`,
  gOut(W1, 'diff', gOut(W1, 'merge-base', 'origin/main', 'HEAD'), '--stat').includes('orkestrator.txt'),
  gOut(W1, 'diff', gOut(W1, 'merge-base', 'origin/main', 'HEAD'), '--stat'));

const first = planReview(WS, { target: W1, task: owned.id });
check(`: адрес reviewer'а — по worker'у, чей это worktree, а не по имени клона`,
  first.address === 'reviewer:pervyy' && store.addressOf(first.owner) === 'worker:pervyy', first.address);
check(': база диффа — точка ветвления из журнала, а не origin/<default>',
  first.baseRef === FORK, `${first.baseRef} vs ${FORK}`);
check(`: работа оркестратора мимо origin в дифф worker'а не попадает`,
  first.diff.includes('pervyy.txt') && !first.diff.includes('orkestrator.txt'), first.stat);
check(`: база названа вслух — в плане, в промпте reviewer'а и в сообщении переревью`,
  String(first.baseLine).includes(FORK) && String(first.baseLine).includes('worker:pervyy')
  && first.prompt.includes(String(first.baseLine)) && first.reReview.includes(String(first.baseLine)),
  String(first.baseLine));

const second = planReview(WS, { target: W2, task: owned.id });
check(': второй worker одного репозитория — свой reviewer, а не reviewer первого',
  second.address === 'reviewer:vtoroy' && second.address !== first.address, second.address);
check(': reviewer второго видит его собственный дифф',
  second.diff.includes('vtoroy.txt') && !second.diff.includes('pervyy.txt'), second.stat);
// Имя reviewer'а называет тот же кусок, что и имя его worker'а: reviewer'ов на
// задачу теперь несколько, и по строке в `claude agents` должно быть видно, чью работу
// каждый смотрит.
check(`: имя reviewer'а называет кусок его worker'а, а не задачу целиком`,
  first.name === `Review: Точка ветвления worker'а (0826-1200)`
  && second.name === 'Review: Reviewer по предмету ревью (0826-1200)'
  && !first.name.includes(owned.title), `${first.name} · ${second.name}`);
check(`: дифф второго не перетирает дифф первого — имена по слагам worker'ов`,
  first.diffPath.endsWith('review-pervyy.diff') && second.diffPath.endsWith('review-vtoroy.diff'),
  `${first.diffPath} · ${second.diffPath}`);

// `--base` остаётся ручным переопределением и сильнее записанного.
const forced = planReview(WS, { target: W1, task: owned.id, base: PUSHED });
check('--base сильнее записанной точки ветвления, и вывод говорит, что база задана флагом',
  forced.baseRef === PUSHED && /--base/.test(String(forced.baseLine)), String(forced.baseLine));

// Реальный прогон, а не только `--dry-run`: база и адрес должны быть названы и там —
// тихость и была второй половиной .
claudeSays('backgrounded · cafe34 · reviewer');
const liveOut = await capture(() => review(WS, { tool: TOOL, target: W2, task: owned.id }));
check(`: реальный прогон называет базу, worker'а и адрес reviewer'а`,
  liveOut.includes(FORK) && /по worker'у worker:vtoroy/.test(liveOut)
  && liveOut.includes('reviewer:vtoroy') && /база диффа/.test(liveOut), liveOut);

// Переревью того же предмета обязано остаться прежним: тот же каталог и тот же --task
// уходят тому же reviewer'у, а не поднимают второго.
const revPart = store.participantOf(store.readTask(home, owned.id), 'reviewer:vtoroy')?.metadata;
check(`: в журнал задачи reviewer записан адресом worker'а, а не именем клона`,
  !!revPart, (store.readTask(home, owned.id).participants ?? []).map((p) => store.addressOf(p)).join(', '));
claudeSays(JSON.stringify([{ name: revPart?.name ?? 'сессии нет', pid: 4242 }]));
const reReviewed = planReview(WS, { target: W2, task: owned.id });
check('переревью того же предмета — тот же адрес и та же живая сессия',
  reReviewed.address === 'reviewer:vtoroy' && reReviewed.reuse === true
  && reReviewed.sessionState === 'alive', `${reReviewed.address} · ${reReviewed.sessionState}`);

// Основной клон в журнале worktree никому не принадлежит — ревью работы самого
// оркестратора остаётся на прежнем поведении по обеим задачам.
const cloneWide = planReview(WS, { target: OWN, task: owned.id });
check('основной клон: адрес по имени клона, база по default-ветке — прежнее поведение',
  cloneWide.owner === null && cloneWide.address === 'reviewer:base-api'
  && cloneWide.baseRef === 'origin/main', `${cloneWide.address} · ${cloneWide.baseRef}`);
check(`основной клон: имя reviewer'а — заголовок задачи, участника у этого каталога нет`,
  cloneWide.name === `Review: ${owned.title} (0826-1200)`, cloneWide.name);

// Запись участника, сделанную прежним CLI, точки ветвления не имеет — и это больше не
// значит съезд базы на default-ветку. Точку считает merge-base с локальной
// default-веткой, поэтому работа оркестратора мимо origin в дифф не попадает и здесь.
// Адрес идёт по worker'у —  от записанной точки не зависит.
store.upsertParticipant(home, owned.id, worker('worker:pervyy', W1, 'a2a-pervyy'));
const legacyBase = planReview(WS, { target: W1, task: owned.id });
check('запись прежнего CLI без точки ветвления: база считается merge-base, чужой работы в диффе нет',
  legacyBase.baseRef === FORK && !legacyBase.diff.includes('orkestrator.txt')
  && legacyBase.diff.includes('pervyy.txt') && legacyBase.address === 'reviewer:pervyy',
  `${legacyBase.baseRef} · ${legacyBase.address}`);
check('запись прежнего CLI: предупреждения о догадочной базе нет — база не догадка',
  (legacyBase.warnings ?? []).every((w) => !/цель — worktree/.test(w)),
  (legacyBase.warnings ?? []).join(' | '));
// Своего заголовка у такой записи тоже нет — имя reviewer'а остаётся прежним, заголовком
// задачи, и это не отказ.
check(`запись прежнего CLI без заголовка куска: имя reviewer'а — заголовок задачи`,
  legacyBase.name === `Review: ${owned.title} (0826-1200)`, legacyBase.name);

// Записанная точка на веру не берётся (замечание ревью). Ветку могли перебазировать, а
// коммита может не быть в клоне вовсе: `merge-base <нет такого sha> HEAD` отказывает, и
// прежде команда падала на нём сырым текстом git. Сверка `--is-ancestor` откатывает на
// default-ветку и говорит об этом — обещать в строке базы больше, чем проверил код,
// нельзя.
const GONE = '0123456789abcdef0123456789abcdef01234567';
store.upsertParticipant(home, owned.id, worker('worker:pervyy', W1, 'a2a-pervyy', null, { baseSha: GONE }));
const stale = planReview(WS, { target: W1, task: owned.id });
check('точка ветвления не в истории HEAD: откат на посчитанную базу, а не падение на git',
  stale.baseRef === FORK && !String(stale.baseLine).includes(GONE)
  && !stale.diff.includes('orkestrator.txt'),
  `${stale.baseRef} · ${(stale.warnings ?? []).join(' | ')}`);
// Ветка второго worker'а — настоящий коммит, но не предок HEAD первого: та же развилка,
// только «перебазировали», а не «коммита нет».
const OTHER_TIP = gOut(W2, 'rev-parse', 'HEAD');
store.upsertParticipant(home, owned.id, worker('worker:pervyy', W1, 'a2a-pervyy', null, { baseSha: OTHER_TIP }));
const rebased = planReview(WS, { target: W1, task: owned.id });
check('точка ветвления из чужой истории тоже отвергается, а не берётся вслепую',
  rebased.baseRef === FORK && !String(rebased.baseLine).includes(OTHER_TIP)
  && !rebased.diff.includes('vtoroy.txt'),
  `${rebased.baseRef} · ${(rebased.warnings ?? []).join(' | ')}`);
store.upsertParticipant(home, owned.id, worker('worker:pervyy', W1, 'a2a-pervyy', null, { baseSha: FORK }));

// Каталог, не числящийся в названной задаче, базу всё равно получает точную: считает
// её merge-base, а не журнал. Предупреждать не о чем — чужой работы в диффе
// нет. Гейт догадочной базы проверяется ниже, на клоне без локальной default-ветки.
let forcedPlan;
const orphan = await capture(async () => {
  forcedPlan = await review(WS, { target: W1, task: task.id, dryRun: true });
});
check('worktree вне журнала названной задачи: база посчитана, громкого предупреждения нет',
  !/цель — worktree/.test(orphan) && orphan.includes(FORK), orphan);
// : забытый `--task` на worktree своего же worker'а больше не беда. Активную
// задачу, в чьём журнале этот каталог числится, команда подхватывает сама — и вместе
// с задачей берёт владельца каталога, его адрес и его точку ветвления. Прежде она
// заводила свою вторую активную задачу и предупреждала о съехавшей базе.
let noTaskPlan;
const noTask = await capture(async () => { noTaskPlan = await review(WS, { target: W1, dryRun: true }); });
check(`: worktree своего worker'а без --task подхватывает его активную задачу`,
  !/цель — worktree/.test(noTask) && noTask.includes(owned.id) && !/будет создана/.test(noTask)
  && /reviewer:pervyy/.test(noTask) && noTask.includes(FORK), noTask);
check(': подхваченная задача — та же, что назвал бы --task, и второй активной не заводит',
  noTaskPlan.taskId === owned.id && noTaskPlan.createNew === null
  && store.addressOf(noTaskPlan.owner) === 'worker:pervyy' && noTaskPlan.baseRef === FORK,
  `${noTaskPlan.taskId} · ${noTaskPlan.baseRef}`);
// Явный --task сильнее подхвата — он и раньше был сильнее всего. План тот же, что у
// `orphan` выше (те же цель и --task, между ними журнал не менялся), и берётся оттуда.
check(': явный --task сильнее подхвата',
  forcedPlan.taskId === task.id, forcedPlan.taskId);
// Посторонний каталог подхвата не получает: ревью вне текущей задачи — законный ход,
// ради которого  и решался. Там прежнее поведение — своя задача и предупреждение
// о том, что активных станет несколько.
const outsideTask = await capture(() => review(WS, { target: OWN, title: 'работа оркестратора в base-api', dryRun: true }));
check(': цель вне журналов активных задач заводит свою — и говорит об этом',
  /будет создана/.test(outsideTask) && !outsideTask.includes(`задача: ${owned.id}`)
  && new RegExp(`активн\\S* ещё задач\\S*[^\\n]*${owned.id}`).test(outsideTask), outsideTask);
// Выбирать задачу за человека команда не станет ни при каком устройстве журнала:
// журнал правится и руками, а два живых журнала на один каталог — уже не подхват, а
// догадка.
const twin = store.createTask(home, { id: 'twin-t20260827-090000', title: 'двойник', slug: 'twin', stamp: 't20260827-090000' });
store.upsertParticipant(home, twin.id, worker('worker:pervyy', W1, 'a2a-pervyy-twin'));
let ambiguous = '';
try { planReview(WS, { target: W1 }); } catch (e) { ambiguous = e.message; }
check(': каталог в двух активных журналах — отказ со списком, а не выбор наугад',
  /нескольких активных задачах/.test(ambiguous) && ambiguous.includes(twin.id)
  && ambiguous.includes(owned.id) && /--task/.test(ambiguous), ambiguous);
store.closeTask(home, twin.id);

// --- : гейт владельца ПОВЕРХ подхвата по каталогу -----------------------
//
// Напряжение с  разрешается порядком, а не отменой: подхват по каталогу остаётся
// признаком «своё», и законный его случай — свой worker, своя задача — гейта не касается,
// потому что владелец mailbox'а там эта же сессия. Ловится обратное: каталог числится в задаче,
// чей mailbox закреплён за ДРУГОЙ сессией. Прежде такая подсадка шла молча, и поднятый reviewer
// отчитывался оркестратору чужой задачи.
//
// Идентичность сессии подставляем: `sessionIdentity` читает `CLAUDE_CODE_SESSION_ID`, и без
// подстановки проверка была бы разной у сессии Claude Code и у CI.
const withSession = (id, fn) => {
  const was = process.env.CLAUDE_CODE_SESSION_ID;
  if (id === null) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = id;
  try { return fn(); } finally {
    if (was === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = was;
  }
};
const REVIEW_OWNER = 'sess-hozyain-zahoda';
const ownerWas = store.taskOwner(home, owned.id);
store.claimOwnership(home, owned.id, REVIEW_OWNER);
const gatedReview = withSession('sess-gost', () => {
  try { planReview(WS, { target: W1 }); return ''; } catch (e) { return e.message; }
});
check(': подхват по каталогу в чужую задачу — отказ с владельцем и обеими маршрутами',
  gatedReview.includes(REVIEW_OWNER) && gatedReview.includes('sess-gost')
  && gatedReview.includes(`--task ${owned.id}`) && gatedReview.includes('mailbox {claim: true}')
  && gatedReview.includes(W1), gatedReview);
// : тот же отказ настоящей командой. `fail()` планировщику недоступен — его зовут и
// как чистую функцию, — поэтому признак ожидаемой несёт класс `GateError`, а стек не
// печатает верхний catch `agents.js`. Проверяется отдельным процессом с настоящим бинарём:
// в общем процессе верхнего catch'а нет вовсе, и форму вывода там увидеть нечем.
const gateCli = spawnSync(process.execPath, [path.join(here, '..', 'bin', 'promptobus.js'), 'review', W1],
  {
    encoding: 'utf8',
    cwd: WS,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'sess-gost', PATH: `${BIN}${path.delimiter}${PATH0}` },
  });
const gateCliText = `${gateCli.stdout}${gateCli.stderr}`;
check(': отказ гейта владельца приезжает без стека — это законный исход, а не поломка',
  gateCli.status === 1 && gateCliText.includes(REVIEW_OWNER) && gateCliText.includes('mailbox {claim: true}')
  && !/\n\s+at /.test(gateCliText) && !/^Error:/m.test(gateCliText),
  `status=${gateCli.status} ${gateCliText}`);

// --- : явный --task без журнала — настоящей командой без стека ----------
//
// `planReview` проверяет `taskExists` сам и бросал голый `Error`. Форму без стека
// видно только в отдельном CLI-процессе — тот же шов, что  / .
const reviewCli = (args) => {
  const r = spawnSync(process.execPath, [path.join(here, '..', 'bin', 'promptobus.js'), 'review', ...args], {
    encoding: 'utf8', cwd: WS,
    env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}` },
  });
  return { status: r.status, text: `${r.stdout}${r.stderr}` };
};
const noStack = (run) => run.status === 1 && !/\n\s+at /.test(run.text) && !/^Error:/m.test(run.text);
const missingReviewTask = reviewCli([REPO, '--task', 'net-takoy-bl394', '--dry-run']);
check(': review --task несуществующей задачи печатается без стека',
  noStack(missingReviewTask) && /задачи net-takoy-bl394 нет/.test(missingReviewTask.text),
  `status=${missingReviewTask.status} ${missingReviewTask.text}`);

// --- : явный --task на закрытый журнал — той же формой, что spawn -------
//
// `planReview` смотрел только `taskExists`: закрытый файл до prune на месте, и
// review шёл дальше. Форму без стека видно только в отдельном CLI-процессе.
const DONE_REVIEW = 'bl-395-zakryta-t20260831-120000';
store.createTask(home, {
  id: DONE_REVIEW, title: 'закрытая задача ', slug: 'bl-395-zakryta', stamp: 't20260831-120000',
});
store.closeTask(home, DONE_REVIEW);
const closedReviewThrow = expectThrow(() => planReview(WS, { target: REPO, task: DONE_REVIEW, dryRun: true }));
check(': planReview на закрытой задаче бросает GateError',
  closedReviewThrow.threw && closedReviewThrow.name === 'GateError'
  && /задача bl-395-zakryta-t20260831-120000 закрыта/.test(closedReviewThrow.msg)
  && /worktree/.test(closedReviewThrow.msg),
  `${closedReviewThrow.name}: ${closedReviewThrow.msg}`);
check(': отказ называет --title, а не «без --task заведёт сама»',
  /--title/.test(closedReviewThrow.msg) && /не этот id/.test(closedReviewThrow.msg)
  && !/заведёт задачу сама/.test(closedReviewThrow.msg),
  closedReviewThrow.msg);
const closedReviewTask = reviewCli([REPO, '--task', DONE_REVIEW, '--dry-run']);
check(': review --task закрытой задачи печатается без стека',
  noStack(closedReviewTask) && /задача bl-395-zakryta-t20260831-120000 закрыта/.test(closedReviewTask.text),
  `status=${closedReviewTask.status} ${closedReviewTask.text}`);

// Явный `--task` — вход по договорённости, и гейт его не знает: тот же порядок, что в spawn'е.
const invitedReview = withSession('sess-gost', () => planReview(WS, { target: W1, task: owned.id }));
check(': явный --task проходит — гейт стоит только на неявном подхвате',
  invitedReview.taskId === owned.id && store.addressOf(invitedReview.owner) === 'worker:pervyy',
  invitedReview.taskId);
// Законный сценарий  гейтом не задет: свой worker, своя задача, владелец — эта сессия.
const ownReview = withSession(REVIEW_OWNER, () => planReview(WS, { target: W1 }));
check(': свой worktree своей задачи подхватывается без --task, как и раньше',
  ownReview.taskId === owned.id && ownReview.createNew === null, ownReview.taskId);
// Идентичности нет вовсе — сравнивать нечем, гейт молчит: то же обещание, что у .
const anonReview = withSession(null, () => planReview(WS, { target: W1 }));
check(': сессия не объявила идентичности — прежнее поведение, а не отказ',
  anonReview.taskId === owned.id, anonReview.taskId);
store.claimOwnership(home, owned.id, ownerWas);

// --- : какая задача становится текущей для сессии ----------------------
//
// Привязку пишет `review()`, а не план, поэтому проверка идёт на РЕАЛЬНОМ прогоне.
// `withSession` выше синхронный: он вернул бы окружение раньше, чем доработает промис.
const withSessionAsync = async (id, fn) => {
  const was = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = id;
  try { return await fn(); } finally {
    if (was === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = was;
  }
};
const BIND_SESS = 'sess-vedyot-zahod';
const ownerWasBind = store.taskOwner(home, owned.id);
store.claimOwnership(home, owned.id, BIND_SESS);
check(': фикстура — сессия ведёт свой run, привязка стоит на его задаче',
  store.boundTaskId(home, BIND_SESS) === owned.id, String(store.boundTaskId(home, BIND_SESS)));

// Заведённая ревью задача привязку не крадёт. Привяжи её — и `mailbox` без аргумента
// ушёл бы читать ящик задачи ревью, пока сообщения worker'ов основного run'а копятся
// незамеченными, а следующий `promptobus spawn` посадил бы worker'а туда же.
// Прежде на это был громкий отказ «активных задач несколько»; молча увести туда резолв —
// та же беда без единого слова, и с ней возвращается .
const strayReview = await withSessionAsync(BIND_SESS,
  () => capture(() => review(WS, { tool: TOOL, target: OWN, title: 'ревью постороннего каталога' })));
check(': ревью постороннего каталога не крадёт привязку сессии',
  store.boundTaskId(home, BIND_SESS) === owned.id,
  `${store.boundTaskId(home, BIND_SESS)} · ${strayReview.split('\n')[0]}`);

// Подхват своей же задачи привязку пишет: обычно она там и так своя, но уборка соседнего
// `promptobus done` файл сносит, и подхват его восстанавливает.
rmSync(store.sessionFile(home, BIND_SESS), { force: true });
await withSessionAsync(BIND_SESS, () => capture(() => review(WS, { tool: TOOL, target: W1 })));
check(`: подхват задачи своего worker'а привязку пишет`,
  store.boundTaskId(home, BIND_SESS) === owned.id, String(store.boundTaskId(home, BIND_SESS)));
store.claimOwnership(home, owned.id, ownerWasBind);

// Владельца нет ни в одном живом журнале — и это тоже не повод предупреждать, пока
// база считается от локальной default-ветки.
const orphanNoTask = await capture(() => review(WS, { target: W3, title: 'ревью worktree без владельца', dryRun: true }));
check('worktree без владельца в живых журналах: база посчитана, предупреждения нет',
  !/цель — worktree/.test(orphanNoTask), orphanNoTask);
// Законные цели предупреждения не получают: основной клон и worktree со своим владельцем.
const quietClone = await capture(() => review(WS, { target: OWN, task: owned.id, dryRun: true }));
const quietOwned = await capture(() => review(WS, { target: W1, task: owned.id, dryRun: true }));
check('основной клон и worktree со своим владельцем предупреждения не получают',
  !/цель — worktree/.test(quietClone) && !/цель — worktree/.test(quietOwned),
  `${/цель — worktree/.test(quietClone)} · ${/цель — worktree/.test(quietOwned)}`);

// Пустой дифф — ровно тот случай, когда база подозрительна первым делом («почему
// пусто?»), а выход стоит раньше всякой печати базы.
store.upsertParticipant(home, owned.id, worker('worker:tretiy', W3, 'a2a-tretiy', null, { baseSha: FORK }));
const emptyOut = await capture(() => review(WS, { target: W3, task: owned.id }));
check('пустой дифф: сообщение «ревьюить нечего» называет базу',
  /ревьюить нечего/.test(emptyOut) && emptyOut.includes(FORK), emptyOut);

// --- отказы -------------------------------------------------------------------

const OUT = path.join(SB, 'outside');
mkdirSync(OUT, { recursive: true });
g(OUT, 'init', '-b', 'main');
const outside = expectThrow(() => planReview(WS, { target: OUT, title: 'посторонний каталог' }));
check('вне рабочего места — отказ, а не ревью без правил',
  outside.threw && /вне рабочего места/.test(outside.msg), outside.msg);

// Папка группы: путь внутри рабочего места, но своего .git нет — toplevel уезжает в корень
// workspace. Отказ должен звать в конкретный клон, а не врать про «вне рабочего места».
const GROUP = path.join(WS, 'repos', 'loads_search');
const group = expectThrow(() => planReview(WS, { target: GROUP, title: 'папка группы' }));
check('папка группы — отказ про клон, а не «вне рабочего места»',
  group.threw && /не клон/.test(group.msg)
  && !/вне рабочего места/.test(group.msg), group.msg);

check('standalone: ревью-скилл модуля не резолвится — встроенный формат замечаний',
  plan.skill === null && plan.prompt.includes('[critical|major|minor]'));

// --- база на момент ревью: worker влил default-ветку ------------------
//
// Второй кусок работы на той же ветке требует влить default-ветку, иначе он лежит
// поверх устаревшего кода. Записанная точка ветвления после этого остаётся позади
// всего, что приехало со слиянием, — и предком HEAD быть не перестаёт, поэтому
// сверка `--is-ancestor` подмены не видит. Живой случай: 63 файла чужой принятой
// работы вместо 7 своих.
writeFileSync(path.join(OWN, 'chuzhaya.txt'), 'чужая принятая работа\n');
g(OWN, 'add', '.');
g(OWN, 'commit', '-m', 'чужая работа, уже принятая в main', '-q');
const MERGED = gOut(OWN, 'rev-parse', 'HEAD');
g(W1, 'merge', '--no-edit', '-q', 'main');
store.upsertParticipant(home, owned.id, worker('worker:pervyy', W1, 'a2a-pervyy', null, { baseSha: FORK }));

check(`фикстура: от записанной точки в дифф worker'а попадает чужая принятая работа`,
  gOut(W1, 'diff', FORK, '--stat').includes('chuzhaya.txt'), gOut(W1, 'diff', FORK, '--stat'));

const merged = planReview(WS, { target: W1, task: owned.id });
check(': база считается на момент ревью, а не берётся записанной',
  merged.baseRef === MERGED, `${merged.baseRef} vs ${MERGED} (записано ${FORK})`);
check(': чужая принятая работа в дифф не попадает, своя остаётся',
  !merged.diff.includes('chuzhaya.txt') && merged.diff.includes('pervyy.txt'), merged.stat);
check(': расхождение записанной и посчитанной базы названо вслух',
  String(merged.baseLine).includes(MERGED) && String(merged.baseLine).includes(FORK)
  && /осталась позади/.test(String(merged.baseLine)), String(merged.baseLine));

// --- гейт догадочной базы: смотрит на источник, а не на поля записи ----
//
// Запись с worktree, но без baseSha проваливалась мимо обоих прежних условий:
// владелец найден, значит первое ложно; baseSha пуст, значит ложно и второе. База
// молча бралась по default-ветке. Здесь локальной default-ветки в клоне нет вовсе —
// посчитать точку неоткуда, и это единственный расклад, в котором база остаётся
// догадкой.
const NOLOCAL = path.join(WS, 'repos', 'loads_search', 'no-local-default');
mkdirSync(NOLOCAL, { recursive: true });
g(NOLOCAL, 'init', '-b', 'work');
writeFileSync(path.join(NOLOCAL, 'AGENTS.md'), 'Правила репозитория.\n');
g(NOLOCAL, 'add', '.');
g(NOLOCAL, 'commit', '-m', 'init', '-q');
g(NOLOCAL, 'update-ref', 'refs/remotes/origin/main', gOut(NOLOCAL, 'rev-parse', 'HEAD'));
const NLWT = path.join(NOLOCAL, '.claude', 'worktrees', 'a2a-bez-bazy');
g(NOLOCAL, 'worktree', 'add', '-q', '-b', 'worktree-a2a-bez-bazy', NLWT, 'work');
writeFileSync(path.join(NLWT, 'rabota.txt'), `работа worker'а\n`);
g(NLWT, 'add', '.');
g(NLWT, 'commit', '-m', 'работа', '-q');
store.upsertParticipant(home, owned.id, store.participantRecord('worker:bezbazy', { repo: 'loads_search/no-local-default', repoAbs: NOLOCAL,
  worktree: NLWT, worktreeName: 'a2a-bez-bazy', branch: 'worktree-a2a-bez-bazy',
  name: 'Worker: без базы (0826-1200, bezbazy)' }));

const noBase = planReview(WS, { target: NLWT, task: owned.id });
check(': запись с worktree и без baseSha даёт предупреждение, а не спокойную строку',
  (noBase.warnings ?? []).some((w) => /цель — worktree/.test(w) && /точки ветвления нет/.test(w)
    && /--base/.test(w)),
  (noBase.warnings ?? []).join(' | '));
check(': база при этом честно названа догадкой по default-ветке',
  noBase.baseRef === 'origin/main' && /default-ветка репозитория/.test(String(noBase.baseLine)),
  String(noBase.baseLine));

// --- : детект default-ветки один на spawn и ревью ------------------------
//
// Детекта было два, и отвечали они по-разному: fresh.js (им выбирает базу spawn) идёт
// `origin/HEAD` → `origin/master` → `origin/main`, review.js шла `origin/HEAD` →
// локальные `main` → `master`. В клоне, где `origin/HEAD` не выставлен, а локальные
// `main` и `master` есть обе, worker ветвился от `master`, а reviewer считал дифф от
// `main` — и работа оркестратора, лежащая на `master`, уезжала в дифф worker'а, то есть
// беда  через разъехавшуюся догадку.
const DUAL = path.join(WS, 'repos', 'loads_search', 'dual-default');
mkdirSync(DUAL, { recursive: true });
g(DUAL, 'init', '-b', 'master');
writeFileSync(path.join(DUAL, 'AGENTS.md'), 'Правила репозитория.\n');
g(DUAL, 'add', '.');
g(DUAL, 'commit', '-m', 'init', '-q');
const D0 = gOut(DUAL, 'rev-parse', 'HEAD');
// Обе локальные ветки на месте, origin/HEAD не выставлен, а из origin есть только master:
// ровно тот клон, на котором детекты и расходились.
g(DUAL, 'branch', 'main');
g(DUAL, 'update-ref', 'refs/remotes/origin/master', D0);
writeFileSync(path.join(DUAL, 'ork.txt'), 'работа оркестратора на master\n');
g(DUAL, 'add', '.');
g(DUAL, 'commit', '-m', 'работа оркестратора', '-q');
const D1 = gOut(DUAL, 'rev-parse', 'HEAD');
const DW = path.join(DUAL, '.claude', 'worktrees', 'a2a-dual');
g(DUAL, 'worktree', 'add', '-q', '-b', 'worktree-a2a-dual', DW, 'master');
writeFileSync(path.join(DW, 'rabota.txt'), `работа worker'а\n`);
g(DW, 'add', '.');
g(DW, 'commit', '-m', 'работа', '-q');
// Запись без baseSha (её сделал прежний CLI) — единственный расклад, в котором база
// считается от default-ветки, а не берётся записанной: он детект и обнажает.
store.upsertParticipant(home, owned.id, store.participantRecord('worker:dual', { repo: 'loads_search/dual-default', repoAbs: DUAL,
  worktree: DW, worktreeName: 'a2a-dual', branch: 'worktree-a2a-dual',
  name: 'Worker: две default-ветки (0826-1200, dual)' }));
check('фикстура: spawn ветвился бы от master — так его выбирает detect fresh.js',
  gOut(DUAL, 'rev-parse', 'master') === D1 && gOut(DUAL, 'rev-parse', 'main') === D0,
  `master=${gOut(DUAL, 'rev-parse', 'master')} main=${gOut(DUAL, 'rev-parse', 'main')}`);

// Неотслеживаемый файл с кириллицей в имени — здесь же: git по умолчанию отдаёт такой
// путь в октальном экранировании, и reviewer получал в промпте имя, которого на диске
// нет.
writeFileSync(path.join(DW, 'новая заметка.txt'), 'заметка\n');
// И отслеживаемый — тем же именем беда приходит в тело диффа и в сводку --stat, а
// настройка стояла у одного вызова из трёх (замечание ревью).
writeFileSync(path.join(DW, 'закоммиченная заметка.txt'), 'в индексе\n');
g(DW, 'add', 'закоммиченная заметка.txt');
g(DW, 'commit', '-m', 'заметка в индексе', '-q');

const dual = planReview(WS, { target: DW, task: owned.id });
check(': reviewer считает базу от той же ветки, от которой ветвится spawn',
  dual.baseRef === D1 && /merge-base с master/.test(String(dual.baseLine)), String(dual.baseLine));
check(`: работа оркестратора на master в дифф worker'а не попадает`,
  !dual.diff.includes('ork.txt') && dual.diff.includes('rabota.txt'), dual.stat);
check(`: неотслеживаемые файлы едут reviewer'у своими именами, а не в октальном виде`,
  dual.untracked.includes('новая заметка.txt') && !dual.untracked.some((f) => /\\3\d\d/.test(f)),
  JSON.stringify(dual.untracked));
check(`: то же имя стоит и в промпте reviewer'а — читать он будет его`,
  dual.prompt.includes('новая заметка.txt'),
  dual.prompt.split('\n').filter((l) => /заметк|\\3/.test(l)).join(' | '));
check('замечание ревью: имя отслеживаемого файла не экранировано ни в теле диффа, ни в сводке',
  dual.diff.includes('закоммиченная заметка.txt') && dual.stat.includes('закоммиченная заметка.txt')
  && !/\\3\d\d/.test(dual.diff) && !/\\3\d\d/.test(dual.stat),
  `${dual.stat} | ${dual.diff.split('\n').filter((l) => /^\+\+\+|^---/.test(l)).join(' ')}`);

// --- посчитанная база не всегда лучше записанной (замечание ревью) -------------
//
// Свежесть сама по себе точности не значит. Две ветки, где merge-base хуже записанной
// точки: переписанная локальная default-ветка (в фазе разработки коммит идёт прямо в
// main, и amend при живых worker'ах законен) и уже слитая ветка worker'а.
const REB = path.join(WS, 'repos', 'loads_search', 'rebase-api');
mkdirSync(REB, { recursive: true });
g(REB, 'init', '-b', 'main');
writeFileSync(path.join(REB, 'AGENTS.md'), 'Правила репозитория.\n');
g(REB, 'add', '.');
g(REB, 'commit', '-m', 'init', '-q');
writeFileSync(path.join(REB, 'ork.txt'), 'работа оркестратора\n');
g(REB, 'add', '.');
g(REB, 'commit', '-m', 'работа оркестратора', '-q');
const R_FORK = gOut(REB, 'rev-parse', 'HEAD');
const RW = path.join(REB, '.claude', 'worktrees', 'a2a-reb');
g(REB, 'worktree', 'add', '-q', '-b', 'worktree-a2a-reb', RW, 'main');
writeFileSync(path.join(RW, 'rabota.txt'), `работа worker'а\n`);
g(RW, 'add', '.');
g(RW, 'commit', '-m', `работа worker'а`, '-q');
store.upsertParticipant(home, owned.id, store.participantRecord('worker:reb', { repo: 'loads_search/rebase-api', repoAbs: REB,
  worktree: RW, worktreeName: 'a2a-reb', branch: 'worktree-a2a-reb', baseSha: R_FORK,
  name: 'Worker: переписанная база (0826-1200, reb)' }));
g(REB, 'commit', '--amend', '-q', '-m', 'работа оркестратора, переписанная');

check('фикстура: merge-base с переписанной default-веткой ушёл назад от записанной точки',
  gOut(RW, 'merge-base', 'main', 'HEAD') !== R_FORK, `${gOut(RW, 'merge-base', 'main', 'HEAD')} vs ${R_FORK}`);
const rewound = planReview(WS, { target: RW, task: owned.id });
check('замечание ревью: посчитанная база позади записанной — берётся записанная',
  rewound.baseRef === R_FORK, `${rewound.baseRef} vs ${R_FORK}`);
check('замечание ревью: работа оркестратора в дифф не возвращается',
  !rewound.diff.includes('ork.txt') && rewound.diff.includes('rabota.txt'), rewound.stat);
check('замечание ревью: причина названа переписыванием, а не влитой веткой',
  /переписана/.test(String(rewound.baseLine)) && !/влита в ветку worker'а/.test(String(rewound.baseLine)),
  String(rewound.baseLine));

// Ветку worker'а слили в default-ветку — штатный конец run'а. merge-base становится
// равен HEAD, и дифф был бы пуст: переревью после слияния перестало бы работать.
const MRG = path.join(WS, 'repos', 'loads_search', 'merged-api');
mkdirSync(MRG, { recursive: true });
g(MRG, 'init', '-b', 'main');
writeFileSync(path.join(MRG, 'AGENTS.md'), 'Правила репозитория.\n');
g(MRG, 'add', '.');
g(MRG, 'commit', '-m', 'init', '-q');
const M_FORK = gOut(MRG, 'rev-parse', 'HEAD');
const MW = path.join(MRG, '.claude', 'worktrees', 'a2a-mrg');
g(MRG, 'worktree', 'add', '-q', '-b', 'worktree-a2a-mrg', MW, 'main');
writeFileSync(path.join(MW, 'sdelano.txt'), `работа worker'а\n`);
g(MW, 'add', '.');
g(MW, 'commit', '-m', `работа worker'а`, '-q');
g(MRG, 'merge', '--ff-only', '-q', 'worktree-a2a-mrg');
store.upsertParticipant(home, owned.id, store.participantRecord('worker:mrg', { repo: 'loads_search/merged-api', repoAbs: MRG,
  worktree: MW, worktreeName: 'a2a-mrg', branch: 'worktree-a2a-mrg', baseSha: M_FORK,
  name: 'Worker: слитая ветка (0826-1200, mrg)' }));

check(`фикстура: после слияния merge-base с default-веткой равен HEAD worker'а`,
  gOut(MW, 'merge-base', 'main', 'HEAD') === gOut(MW, 'rev-parse', 'HEAD'));
const mergedBack = planReview(WS, { target: MW, task: owned.id });
check('замечание ревью: слитая ветка ревьюится от записанной точки, а не отдаёт пустой дифф',
  mergedBack.baseRef === M_FORK && mergedBack.diff.includes('sdelano.txt'),
  `${mergedBack.baseRef} · ${mergedBack.stat}`);
check('замечание ревью: строка базы называет, что работа уже влита',
  /работа уже влита/.test(String(mergedBack.baseLine)), String(mergedBack.baseLine));

// Та же слитая ветка, но точки ветвления в журнале нет: дифф честно пуст, и команда
// говорит, почему — «ревьюить нечего» без объяснения было бы неправдой.
store.upsertParticipant(home, owned.id, store.participantRecord('worker:mrg', { repo: 'loads_search/merged-api', repoAbs: MRG,
  worktree: MW, worktreeName: 'a2a-mrg', branch: 'worktree-a2a-mrg',
  name: 'Worker: слитая ветка (0826-1200, mrg)' }));
const mergedNoBase = planReview(WS, { target: MW, task: owned.id });
check('замечание ревью: пустой дифф на слитой ветке объяснён, а не выдан за отсутствие работы',
  (mergedNoBase.warnings ?? []).some((w) => /совпадает с main/.test(w) && /--base/.test(w)),
  (mergedNoBase.warnings ?? []).join(' | '));

// Свежий worktree, где worker ещё ничего не коммитил: HEAD равен вершине
// default-ветки и записанной точке разом. «Работа уже влита» здесь было бы неправдой —
// в default-ветку ничего не уезжало (замечание ревью).
const untouched = planReview(WS, { target: W3, task: owned.id });
check(`замечание ревью: у worker'а без единого коммита строка базы не обещает влитой работы`,
  untouched.baseRef === FORK && !/влита/.test(String(untouched.baseLine))
  && /точка ветвления worktree worker:tretiy/.test(String(untouched.baseLine)),
  String(untouched.baseLine));
// owned.id держали активным: проверки базы диффа зовут его явным `--task`, и закрытый
// журнал теперь отказ, а не фикстура.
store.closeTask(home, owned.id);

// --- : участник пишется ДО запуска claude ------------------------------
//
// `fail()` завершает процесс, поэтому ветка отказа исполняется отдельно. Новая задача
// уже получила diff и конфиги; после сорванного запуска в ней должна остаться запись
// reviewer'а без выдуманной session, а отказ — назвать сироту и точную уборку.
const FAIL_TITLE = 'ревью, которое не поднялось';
claudeFails();
const failed = spawnSync(process.execPath, ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(reviewUrl)});\n`
  + `await m.review(${JSON.stringify(WS)}, ${JSON.stringify({ target: REPO, title: FAIL_TITLE })});`,
], { encoding: 'utf8', env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}` } });
const failText = `${failed.stdout}${failed.stderr}`;
const orphanTask = store.activeTasks(home).find((t) => t.title === FAIL_TITLE);
const failedReviewer = store.participantOf(orphanTask, 'reviewer:cargos-api')?.metadata;
check(': сорванный запуск отказывает, а не молчит',
  failed.status === 1 && /claude --bg завершился с кодом 1/.test(failText),
  `status=${failed.status} ${failText}`);
check(': участник записан до запуска и session не выдумана',
  !!failedReviewer && failedReviewer.repo === 'loads_search/cargos-api'
  && failedReviewer.repoAbs === REPO && failedReviewer.name?.startsWith('Review: ')
  && !failedReviewer.session, JSON.stringify(failedReviewer));
// Пометку ставит сам review(), а не тест: без неё повтор команды принял бы эту запись
// за живого reviewer'а и отправил дифф в mailbox, за которым никого нет.
check(': запись сорвавшегося запуска помечена pending',
  failedReviewer?.pending === true, JSON.stringify(failedReviewer));
check(': diff и конфиги задачи-сироты сохранены для диагностики',
  !!orphanTask
  && existsSync(path.join(store.filesDir(home, orphanTask.id), 'review-cargos-api.diff'))
  && existsSync(path.join(store.workersDir(home, orphanTask.id), 'reviewer-cargos-api.settings.json'))
  && existsSync(path.join(store.workersDir(home, orphanTask.id), 'reviewer-cargos-api.mcp.json')),
  String(orphanTask?.id));
check(': отказ называет сироту и готовую команду закрытия',
  !!orphanTask && /активная задача-сирота/.test(failText)
  && failText.includes(orphanTask.id)
  && failText.includes(`promptobus done --task ${orphanTask.id}`), failText);
if (orphanTask) store.closeTask(home, orphanTask.id);

// --- : гейт стоит раньше завода задачи и раньше подъёма сессии ----------
//
// Проверяется через `review()`, а не `planReview()`: задачу заводит именно она. Сам гейт
// `fail()` не зовёт — он бросает из `planReview`, и подпроцесс отдаёт код выхода явным
// catch'ем. Отдельный процесс нужен не отказу, а его мутации: сняв гейт, этот вызов
// доходит до `claude --bg`, а оттуда до `fail()`, который уносит процесс мимо сводки
// вердиктов — то есть в общем процессе проверка не смогла бы покраснеть
// честно. Каталог процесса — клон, имя задачи задано: без гейта вызов завёл бы задачу
// по текущему каталогу ровно так, как это случилось 2026-08-27.
const GATE_TITLE = 'ревью, которого не должно быть';
const activeBefore = store.activeTasks(home).length;
const gated = spawnSync(process.execPath, ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(reviewUrl)});\n`
  + `try { await m.review(${JSON.stringify(WS)}, ${JSON.stringify({ title: GATE_TITLE })}); }\n`
  + 'catch (e) { console.error(e.message); process.exit(1); }',
], { encoding: 'utf8', cwd: REPO, env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}` } });
const gateText = `${gated.stdout}${gated.stderr}`;
check(': вызов без пути из каталога клона отказывает до всего остального',
  gated.status === 1 && /путь к репозиторию обязателен/.test(gateText), `status=${gated.status} ${gateText}`);
check(': задача по текущему каталогу не заводится',
  store.activeTasks(home).length === activeBefore
  && !store.activeTasks(home).some((t) => t.title === GATE_TITLE),
  String(store.activeTasks(home).length));

// Отказ плана печатает и выходит КОМАНДА: план его только возвращает полем.
// Тем же приёмом и по той же причине — проверяется дом `fail()`, а не текст отказа, и
// увидеть его можно лишь по коду выхода процесса. Пропади `fail(plan.refusal)` в начале
// `review()` — команда пошла бы дальше по плану-отказу и упала бы TypeError на
// `plan.warnings`: код выхода тот же, а сообщение другое, поэтому проверяются оба.
const refused = spawnSync(process.execPath, ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(reviewUrl)});\n`
  + `await m.review(${JSON.stringify(WS)}, ${JSON.stringify({ target: NOT_A_REPO })});`,
], { encoding: 'utf8', cwd: REPO, env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}` } });
const refusedText = `${refused.stdout}${refused.stderr}`;
check(': отказ плана печатает и выходит команда, а не план',
  refused.status === 1 && refusedText.includes(`${NOT_A_REPO}: не git-репозиторий`)
  && !/TypeError|plan\.warnings/.test(refusedText),
  `status=${refused.status} ${refusedText}`);

// --- /: reviewer поднимается тем бинарём, который назвал резолв ----
//
// Каталог со ВТОРЫМ подставным `claude` вне PATH: spawn reviewer'а обязан взять путь из
// резолва, а не имя из PATH. Иначе правка «искать по известным местам» дошла бы до
// worker'а и не дошла бы до reviewer'а — молча.
const ALT = path.join(SB, 'alt-bin');
const ALT_ARGV = path.join(SB, 'alt-argv.txt');
// Сессию поднимает этот бинарь, а список `claude agents` спрашивается у того, что в
// PATH: отметку о подъёме второй фейк ставит ту же, иначе сверка подъёма
// объявила бы reviewer'а непоставленным на исправном коде.
stubCommand(ALT, 'claude', `import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--bg') {
  writeFileSync(${JSON.stringify(ALT_ARGV)}, args.join(' '));
  writeFileSync(${JSON.stringify(BG_RAISED)}, args[args.indexOf('--name') + 1] ?? '');
}
process.stdout.write('[]');`);
const ALT_BIN = path.join(ALT, process.platform === 'win32' ? 'claude.cmd' : 'claude');
const altTask = store.createTask(home, { id: 't20260828-124500', title: 'ревью чужим бинарём' });
claudeSays('[]');
const altOut = await capture(() => review(WS, {
  target: REPO,
  task: altTask.id,
  tool: { ok: true, path: ALT_BIN, source: 'installDirs', dir: ALT, version: '2.1.237', note: `claude не найден в PATH — взят из ${ALT}` },
}));
check(`: reviewer'а поднял бинарь из резолва, а не одноимённый из PATH`,
  existsSync(ALT_ARGV) && readFileSync(ALT_ARGV, 'utf8').includes('--bg'), String(existsSync(ALT_ARGV)));
check(`: найденный вне PATH бинарь reviewer'а назван в выводе`,
  altOut.includes(ALT), altOut.split('\n').filter((l) => /claude/.test(l)).join(' | '));

// Отказ по версии уносит процесс через fail() — отдельным процессом, тем же приёмом,
// что гейт обязательного пути ниже.
const oldTask = store.createTask(home, { id: 't20260828-124600', title: 'ревью на старом бинаре' });
const oldRun = spawnSync(process.execPath, ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(reviewUrl)});
`
  + `await m.review(${JSON.stringify(WS)}, ${JSON.stringify({
    target: REPO,
    task: oldTask.id,
    tool: { ok: false, found: true, reason: 'Claude Code: найдена версия 2.1.100, нужна 2.1.169 или новее' },
  })});`,
], { encoding: 'utf8', cwd: SB, env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}` } });
const oldText = `${oldRun.stdout}${oldRun.stderr}`;
check(': ревью на старом бинаре отказывает с обеими версиями',
  oldRun.status === 1 && /2\.1\.100/.test(oldText) && /2\.1\.169/.test(oldText), `status=${oldRun.status} ${oldText}`);
check(`: отказ по версии reviewer'а в журнал не пишет`,
  !store.readTask(home, oldTask.id).participants.some((p) => String(store.addressOf(p)).startsWith('reviewer:')),
  JSON.stringify(store.readTask(home, oldTask.id).participants));

// --- : на переревью набор MCP не объявляется -----------------------------
//
// Строка описывает то, что УЕЗЖАЕТ участнику. На переревью новая сессия не поднимается,
// а `mcpConfigPath` даже не перезаписывается — живой reviewer работает со старым
// конфигом, и строка описывала бы набор, которого нет. Задача своя: лишнее переревью
// сдвинуло бы счётчики mailbox'ов у соседних проверок.
const reuseTask = store.createTask(home, { id: 't20260828-130000', title: 'переревью и набор MCP' });
const REUSE_SESSION = 'Review: переревью и набор MCP (0828-1300)';
store.upsertParticipant(home, reuseTask.id, store.participantRecord('reviewer:cargos-api', { repo: 'loads_search/cargos-api', name: REUSE_SESSION,
  session: 'cafe12' }));
claudeSays(JSON.stringify([{ id: 'cafe12', name: REUSE_SESSION, state: 'working', pid: 4242 }]));
const reuseRun = await capture(() => review(WS, { target: REPO, task: reuseTask.id }));
check(': на переревью строка про набор MCP не печатается',
  /уже на шине/.test(reuseRun) && !/MCP reviewer'а/.test(reuseRun),
  reuseRun.split('\n').filter((l) => /MCP|шине/.test(l)).join(' | '));
claudeSays('[]');

// --- : потолок вывода git ------------------------------------------------
//
// Обёртка git() шла с дефолтным потолком `spawnSync` — мегабайт. Перечень
// неотслеживаемых файлов настоящего клона (сборка, выгрузка, каталог без .gitignore) его
// перебирает легко: процесс убивается сигналом, статуса у него нет, stderr пуст — и
// команда падала с «git ls-files:» и пустым хвостом, то есть без причины вовсе. Здесь
// перечень заведомо больше мегабайта: длинные имена дешевле числа файлов.
// Пути короткие намеренно (замечание ревью): полный путь длиннее MAX_PATH (260) не
// пережил бы Windows, и набор краснел бы там при исправном коде — класс . Тот же
// перебор набирается числом файлов, а не их длиной.
const FLOOD = path.join(WS, 'repos', 'loads_search', 'flood-api');
const FLOOD_DIR = path.join(FLOOD, 'd'.repeat(30));
mkdirSync(FLOOD_DIR, { recursive: true });
g(FLOOD, 'init', '-b', 'master');
writeFileSync(path.join(FLOOD, 'AGENTS.md'), 'Правила репозитория.\n');
g(FLOOD, 'add', 'AGENTS.md');
g(FLOOD, 'commit', '-m', 'init', '-q');
g(FLOOD, 'update-ref', 'refs/remotes/origin/master', gOut(FLOOD, 'rev-parse', 'HEAD'));
// Число подобрано замером: 14000 путей по 91 байту — 1,29 МБ, и процесс git убивается
// сигналом раньше, чем допишет вывод (`status` тогда `null`, а `stderr` пуст, и прежняя
// обёртка падала с пустой причиной). Меньший перебор вреден иначе: `spawnSync` отдаёт
// усечённый вывод молча, и reviewer получал бы неполный перечень без единого слова.
const FLOOD_N = 14000;
for (let i = 0; i < FLOOD_N; i += 1) {
  writeFileSync(path.join(FLOOD_DIR, `${'f'.repeat(50)}${String(i).padStart(6, '0')}.txt`), '');
}
// : имя диффа выбирает запись, а промпт собран планом до неё — значит план обязан
// пересобраться по тому пути, который лёг на диск. Задача своя: подъём reviewer'а сдвинул
// бы счётчики mailbox'ов у соседних проверок.
const writtenTask = store.createTask(home, { id: 't20260829-113000', title: 'ревью и записанный дифф' });
let writtenPlan = null;
await capture(async () => { writtenPlan = await review(WS, { tool: TOOL, target: REPO, task: writtenTask.id }); });
check(': промпт называет тот файл диффа, который лёг на диск, и в нём тот же дифф',
  !!writtenPlan && writtenPlan.prompt.includes(writtenPlan.diffPath)
  && existsSync(writtenPlan.diffPath)
  && readFileSync(writtenPlan.diffPath, 'utf8') === writtenPlan.diff,
  String(writtenPlan && writtenPlan.diffPath));
check(': сообщение переревью называет тот же файл',
  !!writtenPlan && writtenPlan.reReview.includes(writtenPlan.diffPath),
  String(writtenPlan && writtenPlan.diffPath));
store.closeTask(home, writtenTask.id);

const floodTask = store.createTask(home, { id: 't20260829-120000', title: 'ревью клона с длинным перечнем' });
const flood = planReview(WS, { target: FLOOD, task: floodTask.id });
check(': перечень неотслеживаемых длиннее мегабайта команду не валит',
  flood.untracked.length === FLOOD_N, `${flood.untracked.length} из ${FLOOD_N}`);
store.closeTask(home, floodTask.id);

// PATH держался подменённым до конца: планировщик сверяет живость на каждом вызове
// с уже заведённым участником, и звать за этим живого claude тест не должен.
process.env.PATH = PATH0;
rmSync(SB, { recursive: true, force: true });
