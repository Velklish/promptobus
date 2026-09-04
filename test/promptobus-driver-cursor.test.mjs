// Driver Cursor — второй production driver шины (; переведён на
// persist-сессии в ). Запуск: npm test
//
// Предмет — то, что у Cursor устроено ИНАЧЕ, чем у Claude Code, и потому не проверяется ни
// одним прежним файлом набора: план подъёма (свои флаги, свои файлы `.cursor/*`, своя
// песочница reviewer'а), живая persist-сессия в панели tmux вместо процесса хода, разбор
// стенограммы вместо потока `stream-json`, инъекция текста в поле ввода TUI, watchdog по
// тишине стенограммы и добор двух пород процессов после гашения.
//
// Круг идёт настоящим механизмом: CLI, driver `cursor`, надзиратель, MCP-сервер шины, store
// задачи, git. Подменены ровно два бинаря — `agent` и `tmux`
// ([harness-cursor.mjs](harness-cursor.mjs)), и подмена стоит на их границе: driver остаётся
// предметом проверки.
//
// **Круг пробуждения сюда не входит и живёт своим файлом**
// ([promptobus-cursor-wake.test.mjs](promptobus-cursor-wake.test.mjs)): он меряет
// настенные часы — круг надзирателя, паузу внутри хода — и потому идёт серийной группой
// раннера. Здесь всё, что судится без часов.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { buildWorkspace, cli, store } from './scenario.mjs';
import {
  CURSOR_HOME_VAR, HANG_CHILD_VAR, HANG_VAR, diagnoseTrace, installHarness, planParticipant,
  readTrace,
} from './harness-cursor.mjs';
import { waitFor } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SB = makeSandbox('promptobus-cursor-');
const { home: HARNESS, stateHome, restore } = await installHarness({ binDir: path.join(SB, 'bin') });

const {
  cursorDriver, reviewSandbox, PROVEN_CURSOR_VERSION, PHRASES, KNOWN_HOOK_EVENTS,
  skillsNoteOf,
} = await import(path.join(here, '..', 'lib', 'driver-cursor.js'));
const {
  dropSession, injectText, launchScript, listSessions, readSession, readTranscript, sessionFile,
  sessionKey, silentIsStall, isRuntimeCmd, mcpRuntimeNeedles, BUS_MCP_NEEDLE, toolKidsOf, tmux, transcriptOf,
  turnState,
  workspaceHash, writeSession,
} = await import(path.join(here, '..', 'lib', 'cursor-persist.js'));
const { liftDriver, REGISTRY } = await import(path.join(here, '..', 'lib', 'drivers.js'));
const { liftHarness, skillsNote, writeLaunchFiles } = await import(path.join(here, '..', 'lib', 'spawn.js'));

const TASK = 'cursorbus-t20260903-000000';
const WORKER = 'worker:cur';
const REVIEWER = 'reviewer:cur';
const ORCH_SESSION = `orch-cursor-${process.pid}`;

// --- registry и флаг --harness ------------------------------------------------------

check(': driver Cursor лежит в карте registry и берётся по имени',
  liftDriver('cursor').id === 'cursor' && Object.keys(REGISTRY.drivers).sort().join(',') === 'claude,codex,cursor',
  Object.keys(REGISTRY.drivers).join(','));

check(': без имени берётся прежний driver — argv Claude Code не двигается',
  liftDriver().id === 'claude' && liftDriver(null).id === 'claude' && liftDriver('').id === 'claude');

function thrown(fn) {
  try {
    fn();
    return { threw: false, msg: '' };
  } catch (e) {
    return { threw: true, msg: e.message };
  }
}

const unknown = thrown(() => liftDriver('no-such'));
check(': незнакомый harness отказывает в самой двери registry, с перечнем известных',
  unknown.threw && /no-such/.test(unknown.msg) && /cursor/.test(unknown.msg), unknown.msg);

// --- capabilities и словарь ----------------------------------------------------------

check(': capabilities Cursor объявлены все девять',
  ['spawn', 'attach', 'activation', 'inspect', 'stop', 'denyTools', 'systemPrompt', 'sessionList', 'enter']
    .every((k) => cursorDriver.capabilities[k] !== undefined)
  && cursorDriver.capabilities.attach === false,
  JSON.stringify(cursorDriver.capabilities));

// Вход человека у Cursor теперь настоящий: живая сессия принимает `agent persist attach`, и
// два клиента в ней уживаются. Под headless этой capability не было вовсе.
check(': вход человека и реестр сессий объявлены, и маршрут входа — команда persist',
  cursorDriver.capabilities.enter === true && cursorDriver.capabilities.sessionList === true
  && PHRASES.enter('cursor-a-1') === 'agent persist attach cursor-a-1'
  && PHRASES.sessions === 'agent persist list',
  `${PHRASES.enter('cursor-a-1')} · ${PHRASES.sessions}`);

check(': activation Cursor — push, и операция activate у driver’а есть',
  cursorDriver.capabilities.activation === 'push' && typeof cursorDriver.activate === 'function'
  && typeof cursorDriver.renderNotification === 'function');

// Канал — инъекция в живую сессию, а не сокет и не новый процесс. Признак объявленный:
// подставной канал набора подменяет доставку только там, где она и правда сокет.
check(': канал driver’а объявлен инъекцией — подменять в нём нечего',
  cursorDriver.options.knockChannel === 'inject', cursorDriver.options.knockChannel);

check(': тишина стенограммы сама по себе не стоп — стоп, только если детей панели нет',
  silentIsStall({ silent: true }, [4242]) === false
  && silentIsStall({ silent: true }, []) === true
  && silentIsStall({ silent: false }, [1]) === false
  && silentIsStall({ silent: false }, []) === false);

check(': рантайм — worker-server и игла шины; MCP — из конфига',
  isRuntimeCmd('node -e setTimeout(() => {}, 60_000); // worker-server') === true
  && isRuntimeCmd(`node ${BUS_MCP_NEEDLE}`) === true
  && isRuntimeCmd(`node ${BUS_MCP_NEEDLE.split(' promptobus mcp')[0]} promptobus warden --task t`) === false
  && isRuntimeCmd('node index.js --cursor-persist-restore abc sess') === false
  && isRuntimeCmd('foo --stdio', ['foo']) === true
  && isRuntimeCmd('/bin/zsh -c npm test') === false
  && isRuntimeCmd('npm test') === false
  && isRuntimeCmd('node') === false);

check(': голый интерпретатор из mcp.json — не игла',
  JSON.stringify(mcpRuntimeNeedles({ mcpServers: { x: { command: 'node' } } })) === JSON.stringify([])
  && JSON.stringify(mcpRuntimeNeedles({ mcpServers: { x: { command: 'node', args: ['foo'] } } })) === JSON.stringify(['foo']));

{
  const warden = `node ${BUS_MCP_NEEDLE.replace(/ promptobus mcp$/, ' promptobus warden --task t')}`;
  const stdout = [
    '    5     1 node persist-restore',
    `   10     5 node ${BUS_MCP_NEEDLE}`,
    `   20    10 ${warden}`,
  ].join('\n');
  const kids = toolKidsOf(5, { ps: () => ({ status: 0, stdout }) });
  check(': надзиратель под процессом шины — не инструмент, тишина = стоп',
    JSON.stringify(kids) === JSON.stringify([])
    && silentIsStall({ silent: true }, kids) === true, JSON.stringify(kids));
}

{
  const needles = mcpRuntimeNeedles({ mcpServers: { foo: { command: 'foo' } } });
  const stdout = [
    '   10     1 sh -c persist',
    '   20    10 foo --stdio',
    '   30    10 npm test',
  ].join('\n');
  const onlyFoo = toolKidsOf(10, {
    ps: () => ({ status: 0, stdout: '   20    10 foo --stdio\n' }),
    needles,
  });
  const withTool = toolKidsOf(10, { ps: () => ({ status: 0, stdout }), needles });
  check(': stdio-сервер из mcp.json — не инструмент',
    JSON.stringify(needles) === JSON.stringify(['foo'])
    && JSON.stringify(onlyFoo) === JSON.stringify([])
    && JSON.stringify(withTool) === JSON.stringify([30]),
    `${JSON.stringify(needles)} · ${JSON.stringify(onlyFoo)} · ${JSON.stringify(withTool)}`);
}

{
  // Хвост дополняет строку до >200 знаков при любой длине пути checkout'а: в worktree участника
  // `PROMPTOBUS_BIN` длиннее, чем в основном клоне (218 против 159 знаков на машине владельца), и
  // фикстура с постоянным хвостом краснела в main, проходя у worker'а.
  const busHead = `   10     5 node ${BUS_MCP_NEEDLE} `;
  const busLine = `${busHead}${'z'.repeat(Math.max(40, 221 - busHead.length))}`;
  const wardenLine = `   20    10 node ${BUS_MCP_NEEDLE.replace(/ promptobus mcp$/, ' promptobus warden --task t')}`;
  const longTool = `npm test ${'x'.repeat(200)}`;
  const raw = ['    5     1 persist', busLine, wardenLine, `   30     5 ${longTool}`].join('\n');
  let seenArgs;
  const kids = toolKidsOf(5, {
    ps: (_bin, args) => {
      seenArgs = args;
      const ww = (args ?? []).some((a) => String(a).includes('ww'));
      const stdout = ww ? raw : raw.split('\n').map((l) => l.slice(0, 131)).join('\n');
      return { status: 0, stdout };
    },
  });
  check(': ps -Awwo; командная строка длиннее 200 знаков читается целиком',
    Array.isArray(seenArgs) && seenArgs[0] === '-Awwo'
    && seenArgs.includes('pid=,ppid=,command=')
    && busLine.length > 200 && longTool.length > 200
    && JSON.stringify(kids) === JSON.stringify([30])
    && silentIsStall({ silent: true }, kids) === false,
    `${JSON.stringify(seenArgs)} · ${busLine.length} · ${JSON.stringify(kids)}`);
}

check(': текст пробуждения зовёт mailbox ИМЕНЕМ Cursor и несёт выжимку сообщения',
  (() => {
    const text = cursorDriver.renderNotification({
      kind: 'unread', task: 'T', address: 'worker:a', unread: 2,
      messages: [{ type: 'answer', from: 'orchestrator', ts: 'now', body: 'ТЕЛО-СООБЩЕНИЯ' }],
    });
    return text.includes('promptobus-promptobus_mailbox') && text.includes('ТЕЛО-СООБЩЕНИЯ')
      && text.includes('worker:a');
  })(), cursorDriver.renderNotification({ kind: 'unread', task: 'T', address: 'worker:a', unread: 0, messages: [] }).slice(0, 90));

check(': словарь Cursor свой — бинарь, модель по умолчанию и запреты read-only участника',
  cursorDriver.options.tool === 'cursor' && cursorDriver.options.defaultModel === 'composer-2.5'
  && JSON.stringify(cursorDriver.options.denyTools) === JSON.stringify(['Write(**)', 'Shell(**)'])
  && cursorDriver.options.skillsDir === false,
  JSON.stringify(cursorDriver.options));

// tmux — не harness, а утилита рабочего места, и объявляет её сам driver: без неё сессия
// участника не поднимается вовсе. Резолв и проверку версии зовёт adapter по этому имени.
check(': driver объявляет tmux своей утилитой рабочего места',
  JSON.stringify(cursorDriver.options.utils) === JSON.stringify(['tmux']),
  JSON.stringify(cursorDriver.options.utils));

check(': имена инструментов шины у Cursor через дефис — их и называет промпт участника',
  cursorDriver.phrases.tool('promptobus', 'promptobus_send') === 'promptobus-promptobus_send',
  cursorDriver.phrases.tool('promptobus', 'promptobus_send'));

check(': правила harness’а для промпта запрещают вопросы и требуют mailbox каждым ходом',
  /Вопросов не задавай/.test(cursorDriver.phrases.promptRules)
  && /mailbox в начале каждого хода/.test(cursorDriver.phrases.promptRules),
  cursorDriver.phrases.promptRules.slice(0, 120));

// Отказ по версии — свой, не общий `minVersion`: подъём участника стоит на раскладке
// `persist`, а она снята на проверенной версии и ни на чём другом.
check(': бинарь старше проверенной версии — отказ до подъёма, с числом',
  /2026\.08\.11/.test(String(cursorDriver.optionRefusal({}, { version: '2026.08.11' })))
  && cursorDriver.optionRefusal({}, { version: PROVEN_CURSOR_VERSION }) === null
  && cursorDriver.optionRefusal({}, { version: null }) === null,
  String(cursorDriver.optionRefusal({}, { version: '2026.08.11' })).slice(0, 90));

// Утилиту резолвит adapter по имени, которое назвал driver, — и версию спрашивает у самого
// бинаря, а не берёт из объявления: `doctor` и гейт подъёма обязаны судить ту же машину.
//
// **Чем спрашивать, знает утилита** (замечание ревью): живой tmux на `--version` отвечает
// usage'ом и кодом 1, версию печатает только `-V`. Спроси общим флагом — и версия «не
// определена», то есть гейт `minVersion` не срабатывает НИКОГДА. Стенд отвечает ровно на
// `-V`, поэтому вердикт ниже краснеет, если аргументы пробы разъедутся с объявлением.
const driverSrc = readFileSync(path.join(here, '..', 'lib', 'driver-cursor.js'), 'utf8');
const tmuxFound = cursorDriver.optionRefusal({}, { version: PROVEN_CURSOR_VERSION }, {
  util: () => ({ ok: true, version: '3.6' }),
});
check(': driver Cursor спрашивает tmux флагом -V и принимает найденную версию',
  /run\('tmux', \['-V'\]/.test(driverSrc) && tmuxFound === null,
  `${tmuxFound} · ${/run\('tmux', \['-V'\]/.test(driverSrc)}`);

// Второй отказ того же гейта: tmux. Спрашивается он ровно там же, до первой записи на диск,
// иначе подъём упирался бы в «панель-поставщик pty не поднялась» уже с worktree и веткой.
const noTmux = cursorDriver.optionRefusal({}, { version: PROVEN_CURSOR_VERSION }, {
  util: () => ({ ok: false, reason: 'tmux (tmux): не найден в PATH и в известных местах установки (~/.local/bin).' }),
});
check(': tmux не найден — отказ до подъёма, теми же словами, что у doctor',
  /tmux/.test(String(noTmux)) && /не найден в PATH/.test(String(noTmux)),
  String(noTmux));

// --- план подъёма --------------------------------------------------------------------

const ctx = {
  ref: 'Worker: проба (0903-1200)',
  address: WORKER,
  task: TASK,
  home: '/tmp/home',
  role: 'worker',
  mcp: { address: WORKER, task: TASK, home: '/tmp/home', servers: { promptobus: { type: 'stdio', command: 'node', args: [] } } },
  prompt: 'ПРОМПТ',
  cwd: '/tmp/wt',
  model: 'cursor-grok-4.6-xhigh-fast',
  effort: null,
  permissionMode: 'force',
  addDirs: ['/tmp/rules'],
  pluginDir: '/tmp/plugin',
  mcpConfigPath: '/tmp/home/tasks/t/workers/cur.mcp.json',
  settingsPath: '/tmp/home/tasks/t/workers/cur.settings.json',
  guardCommand: '"/bin/node" "/bin/agents.js" promptobus guard --role worker:cur',
};
const workerPlan = cursorDriver.prepare(ctx);

// Сессия участника — живой TUI, а не headless-ход: первым аргументом идёт подкоманда
// `persist`, потока `stream-json` в argv нет вовсе.
check(': argv поднимает persist-сессию, а не headless-ход',
  workerPlan.argv[0] === 'persist' && !workerPlan.argv.includes('-p')
  && !workerPlan.argv.includes('--output-format'),
  workerPlan.argv.join(' '));

// `--workspace` перекрывает cwd целиком: без него стор чатов ключуется каталогом запуска, и
// сессия участника уехала бы в чужой чат. Им же механизм узнаёт свою сессию в списке tmux.
check(': argv worker’а несёт --workspace своим рабочим каталогом',
  workerPlan.argv[workerPlan.argv.indexOf('--workspace') + 1] === '/tmp/wt',
  workerPlan.argv.join(' '));

check(': argv — доверие каталогу и модель как назвали',
  workerPlan.argv.includes('--trust') && workerPlan.argv.includes('--force')
  && workerPlan.argv[workerPlan.argv.indexOf('--model') + 1] === 'cursor-grok-4.6-xhigh-fast',
  workerPlan.argv.join(' '));

// `--approve-mcps` одобряет ВСЕ серверы выше по дереву и пишет одобрение в запись чужого
// проекта (REPORT §4.4, §11). Гейт, а не пожелание: driver его не даёт никогда.
check(': driver не даёт --approve-mcps ни worker’у, ни reviewer’у',
  !workerPlan.argv.includes('--approve-mcps'), workerPlan.argv.join(' '));

check(': промпт стоит последним аргументом и несёт правила harness’а',
  workerPlan.argv[workerPlan.argv.length - 1] === 'ПРОМПТ',
  workerPlan.argv.slice(-2).join(' | '));

check(': каталог скиллов Claude Code в argv не идёт — Cursor его не читает',
  !workerPlan.argv.includes('--plugin-dir'), workerPlan.argv.join(' '));

const files = Object.fromEntries(workerPlan.files.map((f) => [path.basename(f.path), f]));
check(': план кладёт четыре файла .cursor/ рабочего каталога — mcp, права, хуки и gitignore',
  workerPlan.files.every((f) => f.path.startsWith(path.join('/tmp/wt', '.cursor')))
  && !!files['mcp.json'] && !!files['cli.json'] && !!files['hooks.json'] && !!files['.gitignore']
  && files['.gitignore'].text === '*\n' && workerPlan.files.length === 4,
  workerPlan.files.map((f) => f.path).join(' · '));

check(': без корня рабочего места план честно говорит, что скиллов нет, и копии не просит',
  /нет \.cursor\/skills/.test(workerPlan.skillsNote)
  && !workerPlan.files.some((f) => f.copyFrom)
  && /нет \.cursor\/skills/.test(skillsNote({ launch: workerPlan, pluginDir: null, driver: cursorDriver }))
  && !/не читает плагин/.test(skillsNote({ launch: workerPlan, pluginDir: null, driver: cursorDriver })),
  workerPlan.skillsNote);

const skillsRoot = path.join(SB, 'skills-src');
mkdirSync(path.join(skillsRoot, '.cursor', 'skills', 'techdoc-style-ru'), { recursive: true });
writeFileSync(path.join(skillsRoot, '.cursor', 'skills', 'techdoc-style-ru', 'SKILL.md'),
  '---\nname: techdoc-style-ru\ndescription: проба\n---\nтело\n');
mkdirSync(path.join(skillsRoot, '.cursor', 'skills', '_shared'), { recursive: true });
writeFileSync(path.join(skillsRoot, '.cursor', 'skills', '_shared', 'standards.md'), 'общие\n');
const skillScript = path.join(skillsRoot, '.cursor', 'skills', 'techdoc-style-ru', 'run.sh');
writeFileSync(skillScript, '#!/bin/sh\n');
chmodSync(skillScript, 0o755);
writeFileSync(path.join(skillsRoot, '.cursor', 'mcp.json'), '{"from":"workspace-root"}\n');
mkdirSync(path.join(skillsRoot, '.cursor', 'agents'), { recursive: true });
writeFileSync(path.join(skillsRoot, '.cursor', 'agents', 'ls-reviewer.md'), 'субагент\n');
mkdirSync(path.join(skillsRoot, '.cursor', 'rules'), { recursive: true });
writeFileSync(path.join(skillsRoot, '.cursor', 'rules', 'x.mdc'), 'правило\n');

const skillsWt = path.join(SB, 'skills-wt');
const skillsPlan = cursorDriver.prepare({ ...ctx, root: skillsRoot, cwd: skillsWt });
check(': план копирует .cursor/skills из корня — не mcp, не agents, не rules',
  skillsPlan.files.some((f) => f.copyFrom === path.join(skillsRoot, '.cursor', 'skills')
    && f.path === path.join(skillsWt, '.cursor', 'skills'))
  && skillsPlan.files.filter((f) => f.copyFrom).length === 1
  && /1 из /.test(skillsPlan.skillsNote)
  && skillsPlan.skillsNote.includes(path.join(skillsRoot, '.cursor', 'skills'))
  && skillsPlan.skillsNote.includes(path.join(skillsWt, '.cursor', 'skills')),
  skillsPlan.skillsNote);

const reviewerSkills = cursorDriver.prepare({
  ...ctx, role: 'reviewer', cwd: '/tmp/clone', root: skillsRoot,
  denyTools: cursorDriver.options.denyTools,
});
check(': reviewer получает ту же копию скиллов в песочницу',
  reviewerSkills.files.some((f) => f.copyFrom === path.join(skillsRoot, '.cursor', 'skills')
    && f.path.startsWith(reviewSandbox(ctx.settingsPath))),
  reviewerSkills.files.filter((f) => f.copyFrom).map((f) => f.path).join(' · '));

mkdirSync(skillsWt, { recursive: true });
spawnSync('git', ['init', '-q', skillsWt], { encoding: 'utf8' });
writeLaunchFiles(skillsPlan.files);
const copiedScript = path.join(skillsWt, '.cursor', 'skills', 'techdoc-style-ru', 'run.sh');
check(': скиллы скопированы, +x на месте, mcp/agents/rules рабочего места не едут',
  existsSync(path.join(skillsWt, '.cursor', 'skills', 'techdoc-style-ru', 'SKILL.md'))
  && existsSync(path.join(skillsWt, '.cursor', 'skills', '_shared', 'standards.md'))
  && (statSync(copiedScript).mode & 0o111) !== 0
  && !existsSync(path.join(skillsWt, '.cursor', 'agents'))
  && !existsSync(path.join(skillsWt, '.cursor', 'rules'))
  && !readFileSync(path.join(skillsWt, '.cursor', 'mcp.json'), 'utf8').includes('workspace-root'),
  readdirSync(path.join(skillsWt, '.cursor')).join(','));

check(': .cursor/.gitignore самоигнорирует каталог — git status этого дерева чистый',
  readFileSync(path.join(skillsWt, '.cursor', '.gitignore'), 'utf8') === '*\n'
  && String(spawnSync('git', ['-C', skillsWt, 'status', '--porcelain'], { encoding: 'utf8' }).stdout ?? '').trim() === '');

mkdirSync(path.join(skillsWt, '.cursor', 'skills', 'leftover'), { recursive: true });
writeFileSync(path.join(skillsWt, '.cursor', 'skills', 'leftover', 'SKILL.md'), 'выпавший\n');
symlinkSync(path.join(skillsRoot, '.cursor', 'skills', '_shared', 'standards.md'),
  path.join(skillsRoot, '.cursor', 'skills', 'ghost-link'));
let copyWarns = '';
const copyWarn0 = console.warn;
console.warn = (m) => { copyWarns += `${m}\n`; };
writeLaunchFiles(skillsPlan.files);
console.warn = copyWarn0;
check(': повторная копия сносит выпавший скилл и предупреждает про симлинк',
  !existsSync(path.join(skillsWt, '.cursor', 'skills', 'leftover'))
  && !existsSync(path.join(skillsWt, '.cursor', 'skills', 'ghost-link'))
  && /ghost-link/.test(copyWarns) && /символическая ссылка/.test(copyWarns),
  copyWarns);
rmSync(path.join(skillsRoot, '.cursor', 'skills', 'ghost-link'), { force: true });

const gitAt = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
  { encoding: 'utf8' });
const humanClone = path.join(SB, 'human-clone');
mkdirSync(humanClone, { recursive: true });
gitAt(humanClone, 'init', '-q', '-b', 'master');
writeFileSync(path.join(humanClone, 'f'), 'первый\n');
gitAt(humanClone, 'add', 'f');
gitAt(humanClone, 'commit', '-qm', 'первый');
mkdirSync(path.join(humanClone, '.cursor'), { recursive: true });
writeFileSync(path.join(humanClone, '.cursor', 'human.md'), 'личный\n');
const linkedWt = path.join(SB, 'human-wt');
const linkedAdd = gitAt(humanClone, 'worktree', 'add', '-q', '--detach', linkedWt);
writeLaunchFiles(cursorDriver.prepare({ ...ctx, root: skillsRoot, cwd: linkedWt }).files);
const commonDirRaw = String(gitAt(linkedWt, 'rev-parse', '--git-common-dir').stdout ?? '').trim();
const commonDir = path.isAbsolute(commonDirRaw) ? commonDirRaw : path.join(linkedWt, commonDirRaw);
const commonExclude = path.join(commonDir, 'info', 'exclude');
const commonText = existsSync(commonExclude) ? readFileSync(commonExclude, 'utf8') : '';
const linkedPorc = String(gitAt(linkedWt, 'status', '--porcelain', '-uall').stdout ?? '');
const clonePorc = String(gitAt(humanClone, 'status', '--porcelain', '-uall').stdout ?? '');
check(': linked worktree прячет свой .cursor, общий exclude клона чист, личный .cursor человека виден',
  linkedAdd.status === 0
  && readFileSync(path.join(linkedWt, '.cursor', '.gitignore'), 'utf8') === '*\n'
  && !commonText.split('\n').some((l) => l.trim() === '.cursor/' || l.trim() === '.cursor')
  && !linkedPorc.split('\n').some((l) => l.includes('.cursor/'))
  && clonePorc.includes('.cursor/human.md'),
  `${linkedAdd.status} · ${commonExclude} · ${commonText} · wt:${linkedPorc.trim()} · clone:${clonePorc.trim()}`);

const tracked = path.join(SB, 'tracked-clone');
mkdirSync(path.join(tracked, '.cursor'), { recursive: true });
gitAt(tracked, 'init', '-q', '-b', 'master');
writeFileSync(path.join(tracked, '.cursor', 'cli.json'), '{"old":true}\n');
gitAt(tracked, 'add', '.cursor/cli.json');
gitAt(tracked, 'commit', '-qm', 'tracked cursor');
let trackedWarns = '';
const trackedWarn0 = console.warn;
console.warn = (m) => { trackedWarns += `${m}\n`; };
writeLaunchFiles(cursorDriver.prepare({ ...ctx, cwd: tracked, root: null }).files);
console.warn = trackedWarn0;
check(': подъём называет уже отслеживаемые файлы .cursor — gitignore их не защитит',
  /cli\.json/.test(trackedWarns) && trackedWarns.includes(tracked),
  trackedWarns);

check(': skillsNoteOf без источника — та же честная строка, что у плана без корня',
  skillsNoteOf({ src: null }) === workerPlan.skillsNote, skillsNoteOf({ src: null }));

check(': конфиг MCP помечен секретом — в нём подставленные токены',
  files['mcp.json'].secret === true && !files['cli.json'].secret && !files['hooks.json'].secret
  && !files['.gitignore'].secret);

const hooks = JSON.parse(files['hooks.json'].text);
// Под persist сторож цикла стоит на `stop`: `sessionEnd` в живой сессии не стреляет вовсе —
// ни на конце хода, ни на гашении. Самая дорогая тихая ошибка перевода, и потому вердикт
// сверяет ОБА имени, а не одно.
check(': сторож цикла стоит на stop, а не на sessionEnd, и зовёт ту же команду',
  hooks.hooks?.stop?.[0]?.command === ctx.guardCommand && !hooks.hooks?.sessionEnd,
  JSON.stringify(hooks));

// Неизвестное имя события МОЛЧА убивает весь файл хуков: не стреляет ни один, включая
// правильно названные (REPORT §4.4). Поэтому гейт не на одно имя, а на весь файл.
check(': driver пишет в hooks.json только известные имена событий',
  Object.keys(hooks.hooks).every((name) => KNOWN_HOOK_EVENTS.includes(name))
  && KNOWN_HOOK_EVENTS.includes('stop') && KNOWN_HOOK_EVENTS.length === 5,
  `${Object.keys(hooks.hooks).join(',')} · известны: ${KNOWN_HOOK_EVENTS.join(',')}`);

check(': права worker’а — свой .cursor/cli.json с пустыми списками',
  JSON.stringify(JSON.parse(files['cli.json'].text)) === JSON.stringify({ permissions: { allow: [], deny: [] } }),
  files['cli.json'].text);

// Скрипт подъёма: панель-поставщик pty зовёт бинарь через него. Две вещи в нём предметны —
// снятые `TMUX`/`TMUX_PANE` (иначе persist молча не персистит) и метка сессии в окружении,
// по которой добираются её процессы и её хук находит свою запись.
const script = launchScript({
  bin: '/bin/agent',
  argv: workerPlan.argv,
  env: { PATH: '/usr/bin', PROMPTOBUS_CURSOR_SESSION: '/state/sessions/a.json' },
});
check(': скрипт подъёма снимает TMUX и несёт метку сессии в окружении',
  /env -u TMUX -u TMUX_PANE/.test(script)
  && /PROMPTOBUS_CURSOR_SESSION=\/state\/sessions\/a\.json/.test(script)
  && /persist/.test(script),
  script);

const scriptFromTmux = launchScript({
  bin: '/bin/agent',
  argv: ['persist'],
  env: { PATH: '/usr/bin', TMUX: '/tmp/sock,1,0', TMUX_PANE: '%0', FOO: 'ok' },
});
check(': скрипт не возвращает TMUX после -u — иначе persist снова видит чужую сессию',
  /env -u TMUX -u TMUX_PANE/.test(scriptFromTmux)
  && !/\bTMUX=/.test(scriptFromTmux)
  && !/\bTMUX_PANE=/.test(scriptFromTmux)
  && /FOO=ok/.test(scriptFromTmux),
  scriptFromTmux);

// Reviewer: своя песочница, ревьюируемый каталог на чтение, deny в файле прав.
const reviewerPlan = cursorDriver.prepare({
  ...ctx, role: 'reviewer', cwd: '/tmp/clone', permissionMode: null, denyTools: cursorDriver.options.denyTools,
});
const sandboxDir = reviewSandbox(ctx.settingsPath);
check(': reviewer садится в свою песочницу, а не в ревьюируемый клон',
  reviewerPlan.cwd === sandboxDir
  && reviewerPlan.argv[reviewerPlan.argv.indexOf('--workspace') + 1] === sandboxDir
  && reviewerPlan.files.every((f) => f.path.startsWith(sandboxDir)),
  `${reviewerPlan.cwd} · ${reviewerPlan.files.map((f) => f.path).join(' · ')}`);

check(': ревьюируемый каталог подключён reviewer’у на чтение --add-dir',
  reviewerPlan.argv.includes('--add-dir') && reviewerPlan.argv.includes('/tmp/clone'),
  reviewerPlan.argv.join(' '));

// Read-only держит ФАЙЛ прав, и под persist он проверен живьём (REPORT §4.7 спайка ):
// ход «выполни echo» получил `Permission denied`. Режим `plan` вторым рубежом снят — в живой
// сессии он меняет поведение TUI, а гарантию даёт не он.
const reviewerCli = JSON.parse(reviewerPlan.files.find((f) => f.path.endsWith('cli.json')).text);
check(': read-only reviewer’а — deny в .cursor/cli.json, без режима plan',
  JSON.stringify(reviewerCli.permissions.deny) === JSON.stringify(['Write(**)', 'Shell(**)'])
  && !reviewerPlan.argv.includes('--mode'),
  `${JSON.stringify(reviewerCli)} · ${reviewerPlan.argv.join(' ')}`);

// Effort у Cursor — суффикс id модели, а не флаг: скобочная форма отвергается бинарём.
const effortPlan = cursorDriver.prepare({ ...ctx, model: 'cursor-grok-4.6', effort: 'xhigh' });
check(': --effort дописывает суффикс к id модели, отдельного флага у Cursor нет',
  effortPlan.argv[effortPlan.argv.indexOf('--model') + 1] === 'cursor-grok-4.6-xhigh'
  && !effortPlan.argv.includes('--effort'),
  effortPlan.argv.join(' '));

// --- разбор стенограммы ---------------------------------------------------------------

// Потока `stream-json` под persist нет вовсе: о ходе говорит стенограмма чата. `turn_ended`
// пишется ОДИН раз на переход в простой, а не на каждое сообщение (REPORT §4.6), поэтому
// «идёт ли ход» читается порядком: сообщение пользователя открывает ход, `turn_ended` его
// закрывает.
const transcriptSample = path.join(SB, 'sample.jsonl');
const lines = [
  { role: 'user', message: { content: [{ type: 'text', text: '<user_query>раз</user_query>' }] } },
  { role: 'assistant', message: { content: [{ type: 'text', text: 'ответ' }] } },
  { type: 'turn_ended', status: 'success' },
];
writeFileSync(transcriptSample, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
const seenIdle = readTranscript(transcriptSample);
writeFileSync(transcriptSample, `${[...lines, { role: 'user', message: { content: [] } }].map((l) => JSON.stringify(l)).join('\n')}\n`);
const seenBusy = readTranscript(transcriptSample);
check(': конец хода читается из стенограммы — turn_ended закрывает ход, сообщение открывает',
  seenIdle.busy === false && seenIdle.ended === 1 && seenIdle.status === 'success'
  && seenBusy.busy === true && seenBusy.ended === 1,
  `${JSON.stringify(seenIdle)} · ${JSON.stringify(seenBusy)}`);

// `turn_ended` — маркер конца ФАЙЛА, а не запись события: стенограмма переписывается, и на
// пяти строках двух ходов он ровно один (живой замер 2026-09-03). Считать им ходы нельзя —
// счётчик ведёт хук; от разбора требуется пережить форму с несколькими маркерами и назвать
// состояние по ПОСЛЕДНЕМУ.
writeFileSync(transcriptSample, `${[...lines, ...lines].map((l) => JSON.stringify(l)).join('\n')}\n`);
check(': несколько маркеров в файле разбор переживает — состояние по последнему',
  readTranscript(transcriptSample).busy === false && readTranscript(transcriptSample).ended === 2,
  JSON.stringify(readTranscript(transcriptSample)));

check(': стенограммы нет — разбор молчит, а не выдумывает состояние',
  readTranscript(path.join(SB, 'нет-такого.jsonl')) === null);

// --- хэш рабочего каталога и лок инъекции ------------------------------------------------

// Cursor хэширует РАЗРЕШЁННЫЙ путь: на macOS `$TMPDIR` — симлинк, и подъём из такого каталога
// иначе не находит свою же сессию (живой замер 2026-09-03). Проверяем свойство на паре
// «симлинк — цель», а не литералом хэша: литерал ничего не сказал бы о правиле.
const hashTarget = path.join(SB, 'hash-target');
const hashLink = path.join(SB, 'hash-link');
mkdirSync(hashTarget, { recursive: true });
symlinkSync(hashTarget, hashLink);
check(': хэш рабочего каталога считается по разрешённому пути, а не по симлинку',
  workspaceHash(hashLink) === workspaceHash(hashTarget),
  `${hashLink} → ${workspaceHash(hashLink)} · ${hashTarget} → ${workspaceHash(hashTarget)}`);

// Лок инъекции переживает своего писателя: умри процесс между взятием и снятием — и каждая
// следующая доставка отказывала бы до самого гашения участника. Живой pid держит лок,
// мёртвый — нет.
const lockRef = 'Worker: лок (0903-1200)';
const lockRecord = { ref: lockRef, sessionName: 'нет-такой-сессии', tmuxServer: 'нет-такого-сервера' };
writeSession({ ...lockRecord, cwd: SB }, process.env);
const lockPath = path.join(stateHome, 'sessions', `${sessionKey(lockRef)}.inject.lock`);
mkdirSync(path.dirname(lockPath), { recursive: true });
writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
const liveLock = await injectText(lockRecord, 'текст', { env: process.env });
check(': лок с ЖИВЫМ писателем держит — вторая инъекция отказывает и называет процесс',
  liveLock.ok === false && /уже пишет процесс/.test(String(liveLock.error))
  && String(liveLock.error).includes(lockPath) && existsSync(lockPath),
  JSON.stringify(liveLock));

// Мёртвый pid: берём заведомо свободный номер — свежесозданный процесс, которого уже нет.
const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
writeFileSync(lockPath, `${JSON.stringify({ pid: dead.pid, at: new Date().toISOString() })}\n`);
const staleLock = await injectText(lockRecord, 'текст', { env: process.env });
check(': бесхозный лок перехватывается — доставка идёт дальше и упирается уже в сессию',
  staleLock.ok === false && !/уже пишет процесс/.test(String(staleLock.error)),
  `${JSON.stringify(staleLock)} · мёртвый pid ${dead.pid}`);
dropSession(lockRef, process.env);

// --- живой круг на подставных бинарях ----------------------------------------------------

const { ws, repoAbs, repo } = buildWorkspace(SB);
writeHostConfig(ws, { tools: ['claude', 'cursor'] });
mkdirSync(path.join(ws, '.cursor', 'skills', 'techdoc-style-ru'), { recursive: true });
writeFileSync(path.join(ws, '.cursor', 'skills', 'techdoc-style-ru', 'SKILL.md'),
  '---\nname: techdoc-style-ru\ndescription: канон стенда\n---\n');
mkdirSync(path.join(ws, '.cursor', 'skills', '_shared'), { recursive: true });
writeFileSync(path.join(ws, '.cursor', 'skills', '_shared', 'standards.md'), 'общие\n');
writeFileSync(path.join(ws, '.cursor', 'mcp.json'), '{"from":"workspace-root"}\n');
mkdirSync(path.join(ws, '.cursor', 'agents'), { recursive: true });
writeFileSync(path.join(ws, '.cursor', 'agents', 'ls-reviewer.md'), 'субагент\n');
const home = path.join(ws, '.promptobus');
const brief = path.join(SB, 'worker-brief.md');
writeFileSync(brief, '# Проба driver’а Cursor\n\nОтправь оркестратору status и закончи ход.\n');

const MARK = 'CURSOR-STATUS-1';
const REVIEW_MARK = 'CURSOR-REVIEW-1';
const NOTE_FILE = 'cursor/note.md';
planParticipant(HARNESS, WORKER, {
  turns: [
    {
      do: [
        // Правка с коммитом нужна ревью: на пустом диффе `promptobus review` возвращается,
        // не подняв reviewer'а, и путь Cursor остался бы неисполненным.
        { write: { path: NOTE_FILE, text: `# ${MARK}\n\nПравка worker'а Cursor.\n` } },
        { commit: { message: `: правка worker'а Cursor` } },
        { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: `${MARK}: worker Cursor на связи` } },
      ],
    },
  ],
});
planParticipant(HARNESS, REVIEWER, {
  turns: [
    { do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: `${REVIEW_MARK}: замечаний нет` } }] },
  ],
});

// Порог тишины живого watchdog'а мерится минутами: набору он укорочен швом. Ставится он на
// `process.env`, а не только в окружение команд: `inspect` driver'а зовётся и ЗДЕСЬ, прямо
// из процесса теста, и своего окружения контракт ему не передаёт.
process.env.PROMPTOBUS_CURSOR_IDLE_MS = '1500';

const env = {
  ...process.env,
  PROMPTOBUS_HOME: home,
  CLAUDE_CODE_SESSION_ID: ORCH_SESSION,
  // Надзиратель в этом файле не нужен: круг пробуждения живёт своим файлом, а отвязанный
  // процесс пережил бы прогон.
  PROMPTOBUS_WARDEN: 'off',
};
store.createTask(home, { id: TASK, title: 'проба driver’а Cursor', owner: ORCH_SESSION });

// Гейт декларации: harness, не объявленный в `promptobus.json`, участника не поднимает —
// адаптеров под него `sync` не раскладывал.
const bare = path.join(SB, 'bare-ws');
writeHostConfig(bare, { tools: ['claude'] });
const undeclared = thrown(() => liftHarness(bare, 'cursor'));
check(': harness вне promptobus.json отказывает до подъёма и называет маршрут',
  undeclared.threw && /tools add cursor/.test(undeclared.msg), undeclared.msg);
check(': объявленный harness проходит тот же гейт',
  liftHarness(ws, 'cursor').id === 'cursor');

// `--dry-run` печатает то, что исполнит подъём, — и говорит, чего в его выводе НЕТ: имя
// persist-сессии придумывает сам бинарь на старте, заранее его не напечатать. Молчание об
// этом читалось бы как пропуск, а у Claude Code строки нет вовсе — там имя выбирает механизм.
const dry = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'cur', '--harness', 'cursor', '--dry-run'], { cwd: ws, env });
const dryClaude = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'cl', '--dry-run'], { cwd: ws, env });
check(': --dry-run печатает команду подъёма и форму имени persist-сессии',
  dry.status === 0 && /persist --workspace/.test(dry.out) && /имя сессии у harness'а/.test(dry.out)
  && /cursor-<слаг каталога>/.test(dry.out) && !/имя сессии у harness'а/.test(dryClaude.out),
  `${dry.out.slice(-600)} · claude: ${dryClaude.out.slice(-200)}`);

check(': --dry-run называет источник, число скиллов и куда лягут',
  dry.status === 0 && /скиллы workspace: 1 из /.test(dry.out)
  && dry.out.includes(path.join(ws, '.cursor', 'skills'))
  && /не читает плагин/.test(dry.out) === false,
  dry.out.split('\n').find((l) => l.includes('скиллы workspace')) ?? dry.out.slice(0, 300));

const spawned = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'cur', '--harness', 'cursor'], { cwd: ws, env });
check('шаг 1: promptobus spawn --harness cursor поднял участника',
  spawned.status === 0 && /worker worker:cur поднят/.test(spawned.out), spawned.out.slice(-500));

const wp = store.participantOf(store.readTask(home, TASK), WORKER);
check('шаг 1: запись участника несёт harness cursor и снимок его capabilities',
  wp?.harness === 'cursor' && wp?.mode === 'managed' && wp?.capabilities?.activation === 'push'
  && wp?.capabilities?.sessionList === true && wp?.capabilities?.enter === true, JSON.stringify(wp));

const ref = wp?.sessionRef ?? '';
const record = readSession(ref, env);
check('шаг 1: сессия легла в реестр механизма — имя persist-сессии, чат и tmux-сервер',
  !!record && typeof record.sessionName === 'string' && record.sessionName.startsWith('cursor-')
  && typeof record.chatId === 'string' && record.chatId.length > 10
  && record.tmuxServer === 'cursor-agent' && record.cwd === wp?.metadata?.worktree,
  JSON.stringify(record));

// Человеку в записи участника едет ИМЯ сессии — им зовутся `attach` и `stop`; полный id —
// чат, и по нему же сверяется владение адресом, потому что его приносит хук конца хода.
check('шаг 1: ручка сессии у человека — её имя, полный id — чат',
  wp?.metadata?.session === record?.sessionName && wp?.metadata?.sessionId === record?.chatId,
  `${wp?.metadata?.session} · ${wp?.metadata?.sessionId} · ${record?.sessionName} · ${record?.chatId}`);

const listed = listSessions({ env });
const mine = listed.find((s) => s.name === record?.sessionName) ?? null;
check('шаг 1: persist-сессия живёт на общем сервере и помечена задачей и адресом механизма',
  !!mine && mine.managed === true && mine.chatId === record?.chatId
  && mine.task === TASK && mine.address === WORKER,
  JSON.stringify(listed));

// Панель-поставщик pty гасится сразу за подтверждением: она машинерия подъёма, а не сессия
// участника, и в списке человека ей делать нечего.
check('шаг 1: одноразовая панель-поставщик pty погашена — на своём сервере пусто',
  listSessions({ server: 'promptobus-launch', env }).length === 0,
  JSON.stringify(listSessions({ server: 'promptobus-launch', env })));

// Свой сервер шины одобрен ТОЧЕЧНО, из каталога участника: `--approve-mcps` одобрил бы все
// серверы workspace в записи чужого проекта.
const approvals = readdirSync(path.join(HARNESS, 'approvals'))
  .flatMap((f) => JSON.parse(readFileSync(path.join(HARNESS, 'approvals', f), 'utf8')));
check('шаг 1: одобрен ровно свой сервер шины, точечно',
  JSON.stringify(approvals) === JSON.stringify(['promptobus']), JSON.stringify(approvals));

const wt = wp?.metadata?.worktree ?? ws;
check('шаг 1: четыре файла .cursor/ легли в worktree участника — mcp, права, хуки и gitignore',
  existsSync(path.join(wt, '.cursor', 'mcp.json')) && existsSync(path.join(wt, '.cursor', 'cli.json'))
  && existsSync(path.join(wt, '.cursor', 'hooks.json'))
  && readFileSync(path.join(wt, '.cursor', '.gitignore'), 'utf8') === '*\n',
  readdirSync(path.join(wt, '.cursor')).join(','));

check('шаг 1: скиллы канона легли в worktree, mcp/agents корня не ехали',
  existsSync(path.join(wt, '.cursor', 'skills', 'techdoc-style-ru', 'SKILL.md'))
  && existsSync(path.join(wt, '.cursor', 'skills', '_shared', 'standards.md'))
  && !existsSync(path.join(wt, '.cursor', 'agents'))
  && !readFileSync(path.join(wt, '.cursor', 'mcp.json'), 'utf8').includes('workspace-root'),
  readdirSync(path.join(wt, '.cursor')).join(','));

const wtDirty = spawnSync('git', ['-C', wt, 'status', '--porcelain'], { encoding: 'utf8' });
const wtPorc = String(wtDirty.stdout ?? '');
const cloneCommonRaw = String(spawnSync('git', ['-C', repoAbs, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).stdout ?? '').trim();
const cloneCommon = path.isAbsolute(cloneCommonRaw) ? cloneCommonRaw : path.join(repoAbs, cloneCommonRaw);
const cloneExclude = path.join(cloneCommon, 'info', 'exclude');
const cloneExcludeText = existsSync(cloneExclude) ? readFileSync(cloneExclude, 'utf8') : '';
check('шаг 1: .cursor участника прячет свой .gitignore — общий exclude клона без .cursor/, status его не видит',
  !cloneExcludeText.split('\n').some((l) => l.trim() === '.cursor/' || l.trim() === '.cursor')
  && !wtPorc.split('\n').some((l) => l.includes('.cursor/')),
  `${cloneExclude} · ${cloneExcludeText} · ${wtPorc.trim()}`);

// Файлы `.cursor/*` не грязнят клон: они лежат ВНУТРИ служебного worktree, а тот исключён
// целиком (`WORKTREE_DIR_REL`). Сам worktree без своего `.gitignore` видел бы `.cursor/` как
// untracked и `done` оставил бы каталог. Проверяем свойство клона, не строку.
const dirty = spawnSync('git', ['-C', repoAbs, 'status', '--porcelain'], { encoding: 'utf8' });
check('шаг 1: .cursor участника не грязнит рабочую копию — worktree исключён целиком',
  dirty.status === 0 && String(dirty.stdout ?? '').trim() === '',
  `${String(dirty.stdout ?? '').trim()} · ${cloneExcludeText.split('\n').filter(Boolean).slice(-2).join(' | ')}`);

const sent = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
  .find((m) => String(m.body ?? '').includes(MARK)) ?? null, { timeoutMs: 30000 });
check('шаг 2: круг шины из Cursor замкнулся — status участника дошёл до оркестратора',
  !!sent, `${JSON.stringify(sent)} · ${diagnoseTrace(HARNESS, WORKER)}`);

// Конец хода под persist приносит хук `stop`: он же ставит отметку конца хода и сдаёт
// contact point. `sessionEnd` при этом не стреляет вовсе — не будь перевода, отметки бы не
// появилось никогда.
check('шаг 2: хук stop отработал — отметка конца хода участника на месте',
  await waitFor(() => store.lastTurnAt(home, TASK, WORKER) !== null, { timeoutMs: 20000 }),
  String(store.lastTurnAt(home, TASK, WORKER)));

const wake = await waitFor(() => store.readWake(home, TASK, WORKER), { timeoutMs: 20000 });
check('шаг 2: contact point сдан хуком и несёт счётчик кончившихся ходов',
  typeof wake?.socket === 'string' && /#\d+$/.test(wake.socket) && wake.session === record?.chatId,
  `${JSON.stringify(wake)} · чат ${record?.chatId}`);

const idle = await waitFor(() => {
  const view = cursorDriver.inspect(ref);
  return view && view.busy === false ? view : null;
}, { timeoutMs: 20000 });
check('шаг 3: ход кончился — сессия жива, не занята, и названа именем persist-сессии',
  idle?.state === 'alive' && idle?.busy === false && idle?.id === record?.sessionName,
  JSON.stringify(idle));

{
  const idleStatus = cli([ 'status', '--task', TASK], { cwd: ws, env });
  const idleLine = idleStatus.out.split('\n').find((l) => l.includes(WORKER)) ?? idleStatus.out;
  check(': простой после хода — inspect.unknown, status не стоп неизвестной природы',
    idle?.stall?.kind === 'unknown' && /ход кончился/.test(String(idle?.stall?.reason))
    && idleStatus.status === 0 && /ждёт сообщения/.test(idleLine) && !/ВСТАЛА/.test(idleLine),
    `${JSON.stringify(idle)} · ${idleLine}`);
}

check('шаг 3: стенограмма чата найдена по его id и записана в реестр',
  !!transcriptOf(readSession(ref, env), env) && readSession(ref, env)?.transcript?.includes(record?.chatId),
  String(readSession(ref, env)?.transcript));

check('шаг 3: маршрут по стопу зовёт человека в сессию командой persist',
  cursorDriver.stallRoute({ kind: 'unknown', address: WORKER, repoAbs: wt }, record?.sessionName)
    .includes(`agent persist attach ${record?.sessionName}`),
  cursorDriver.stallRoute({ kind: 'unknown', address: WORKER, repoAbs: wt }, record?.sessionName));

// Writer у сессии один, и держит это лок: две инъекции разом склеили бы два сообщения в
// одно — текст второй лёг бы в поле ввода поверх первой, между вставкой и Enter.
const race = await Promise.all([1, 2].map(() => cursorDriver.activate({ ref }, {
  kind: 'unread', task: TASK, address: WORKER, unread: 1, messages: [],
})));
check(': две инъекции разом — одна доставлена, вторая отказала локом',
  race.filter((r) => r.ok).length === 1
  && /уже пишет процесс/.test(String(race.find((r) => !r.ok)?.error)),
  JSON.stringify(race));

const statusOut = cli([ 'status', '--task', TASK], { cwd: ws, env });
check('шаг 3: promptobus status показывает живость сессии Cursor словами её driver’а',
  statusOut.status === 0 && statusOut.out.includes(WORKER) && /сесси/.test(statusOut.out),
  statusOut.out.slice(-400));

// --- reviewer Cursor: своя песочница и своя уборка ---------------------------------------

const reviewed = cli([ 'review', wt, '--task', TASK, '--harness', 'cursor'], { cwd: ws, env });
check('шаг 4: promptobus review --harness cursor поднял reviewer’а',
  reviewed.status === 0 && /reviewer reviewer:cur поднят/.test(reviewed.out), reviewed.out.slice(-500));

const rp = store.participantOf(store.readTask(home, TASK), REVIEWER);
check('шаг 4: запись reviewer’а несёт тот же harness и снятые инструменты объявлены',
  rp?.harness === 'cursor' && rp?.capabilities?.denyTools === true, JSON.stringify(rp?.capabilities));

// Reviewer садится в СВОЮ песочницу: файла настроек на один подъём у бинаря нет, и сесть в
// ревьюируемый клон значило бы писать три файла в чужое рабочее дерево.
const sandbox = reviewSandbox(store.participantSettingsPath(home, TASK, REVIEWER));
check('шаг 4: песочница reviewer’а заведена, и это git-каталог — иначе конфиг шины не читается',
  existsSync(path.join(sandbox, '.git')) && existsSync(path.join(sandbox, '.cursor', 'mcp.json'))
  && existsSync(path.join(sandbox, '.cursor', 'cli.json')),
  existsSync(sandbox) ? readdirSync(sandbox).join(',') : 'песочницы нет');

check('шаг 4: reviewer получил скиллы канона в песочницу',
  existsSync(path.join(sandbox, '.cursor', 'skills', 'techdoc-style-ru', 'SKILL.md')),
  existsSync(path.join(sandbox, '.cursor')) ? readdirSync(path.join(sandbox, '.cursor')).join(',') : 'нет .cursor');

check('шаг 4: read-only reviewer’а лежит в его .cursor/cli.json',
  JSON.stringify(JSON.parse(readFileSync(path.join(sandbox, '.cursor', 'cli.json'), 'utf8')).permissions.deny)
  === JSON.stringify(['Write(**)', 'Shell(**)']),
  readFileSync(path.join(sandbox, '.cursor', 'cli.json'), 'utf8'));

const reviewSent = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
  .find((m) => String(m.body ?? '').includes(REVIEW_MARK)) ?? null, { timeoutMs: 30000 });
check('шаг 4: отчёт reviewer’а Cursor дошёл до оркестратора той же шиной',
  !!reviewSent, `${JSON.stringify(reviewSent)} · ${diagnoseTrace(HARNESS, REVIEWER)}`);

// Словарь опций спрашивается у driver'а ЭТОГО участника, а не у driver'а подъёма
// (замечание ревью): у переревью запись уже есть, и сверка по чужому словарю пропустила бы
// в Cursor уровень Claude Code — тот уехал бы суффиксом id модели.
const alienEffort = cli([ 'review', wt, '--task', TASK, '--effort', 'ultracode'], { cwd: ws, env });
check('шаг 4: --effort сверяется по словарю harness’а самого reviewer’а, а не подъёма',
  alienEffort.status !== 0 && /ultracode/.test(alienEffort.out) && !/ultracode/.test(cursorDriver.options.effortLevels.join(',')),
  alienEffort.out.slice(-260));

const alienHarness = cli([ 'review', wt, '--task', TASK, '--harness', 'claude'], { cwd: ws, env });
check('шаг 4: --harness у уже поднятого reviewer’а отказывает, а не игнорируется молча',
  alienHarness.status !== 0 && /поднят harness'ом cursor/.test(alienHarness.out), alienHarness.out.slice(-260));

// Отказ «адрес уже работает» обязан называть ИСПОЛНИМЫЙ маршрут harness'а. Под persist он
// появился: `agent persist stop <имя>` и правда гасит сессию, после чего повторный spawn
// проходит — под headless гасить одну сессию было нечем вовсе.
const busyAddr = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'cur', '--harness', 'cursor'], { cwd: ws, env });
check('шаг 4: spawn на живом адресе отказывает маршрутом, который и правда гасит сессию',
  busyAddr.status !== 0 && /agent persist stop/.test(busyAddr.out) && /--worker/.test(busyAddr.out),
  busyAddr.out.slice(-300));

const dirtyAfterReview = spawnSync('git', ['-C', repoAbs, 'status', '--porcelain'], { encoding: 'utf8' });
check('шаг 4: ревьюируемый клон остался чистым — reviewer в него ничего не положил',
  String(dirtyAfterReview.stdout ?? '').trim() === '', String(dirtyAfterReview.stdout ?? '').trim());

// --- гашение и уборка -------------------------------------------------------------------

// Процессов после сессии остаётся две породы, и обе — замер спайка (REPORT §4.8): дети
// инструментов, которых `persist stop` не трогает вовсе, и сирота `worker-server`, живущая
// минутами и после ШТАТНОГО конца хода. Снимаем перечень ДО гашения — после него он пуст по
// построению, и вердикт был бы зелёным, даже не будь их никогда.
function processesOf(pattern, marker = null) {
  const listedPs = spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' });
  const out = [];
  for (const line of String(listedPs.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!m || !pattern.test(m[2])) continue;
    if (marker) {
      const dump = spawnSync('ps', ['eww', '-o', 'command=', '-p', m[1]], { encoding: 'utf8' });
      if (!String(dump.stdout ?? '').includes(marker)) continue;
    }
    out.push(Number(m[1]));
  }
  return out;
}
const marker = `PROMPTOBUS_CURSOR_SESSION=${sessionFile(ref, env)}`;
const orphansBefore = processesOf(/worker-server/, marker);
const paneBefore = readSession(ref, env)?.panePid ?? null;
const kidsBefore = processesOf(/tool child/).filter((pid) => {
  const dump = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
  return Number(String(dump.stdout ?? '').trim()) === Number(paneBefore);
});
check('шаг 5: до гашения живы обе породы процессов — сирота и ребёнок инструмента',
  orphansBefore.length > 0 && kidsBefore.length > 0,
  `сироты ${JSON.stringify(orphansBefore)} · дети ${JSON.stringify(kidsBefore)} панели ${paneBefore}`);

const done = cli([ 'done', '--task', TASK], { cwd: ws, env });
check('шаг 5: promptobus done закрыл задачу и погасил участников Cursor',
  done.status === 0, done.out.slice(-600));

check('шаг 5: persist-сессий механизма на tmux-сервере не осталось',
  listSessions({ env }).length === 0, JSON.stringify(listSessions({ env })));

check('шаг 5: записи сессии в реестре не осталось — каталог не копится',
  !existsSync(sessionFile(ref, env)) && cursorDriver.inspect(ref)?.state === 'gone',
  `${sessionFile(ref, env)} · ${JSON.stringify(cursorDriver.inspect(ref))}`);

check('шаг 5: гашение добрало и сироту, и ребёнка инструмента — на машине не осталось',
  processesOf(/worker-server/, marker).length === 0
  && kidsBefore.every((pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      return e.code !== 'EPERM';
    }
  }),
  `сироты было ${JSON.stringify(orphansBefore)}, стало ${JSON.stringify(processesOf(/worker-server/, marker))};`
  + ` дети ${JSON.stringify(kidsBefore)}`);

check('шаг 5: конфиг MCP участника с токенами убран уборкой задачи',
  !existsSync(store.participantMcpPath(home, TASK, WORKER)),
  store.participantMcpPath(home, TASK, WORKER));

// Песочницу reviewer'а метёт та же уборка: внутри неё тот же конфиг MCP с подставленными
// токенами, и оставить её значило бы оставить их на диске.
check('шаг 5: рабочее место reviewer’а убрано уборкой задачи вместе с его конфигом шины',
  !existsSync(sandbox), sandbox);

// Песочницу `done` снимает всегда. Worktree — только безлюдный: ветка worker'а с коммитом
// вне default остаётся, и скиллы с ней — та же жизнь, что у остальных файлов `.cursor/`.
check('шаг 5: скиллы живут с каталогом участника — у песочницы сняты, у оставленного worktree на месте',
  !existsSync(path.join(sandbox, '.cursor', 'skills'))
  && (existsSync(wt)
    ? existsSync(path.join(wt, '.cursor', 'skills', 'techdoc-style-ru', 'SKILL.md'))
    : true),
  `${wt} · ${sandbox}`);

// --- watchdog по тишине стенограммы и состояние stale --------------------------------------

// Ход, который не кончается, под persist убивать нечем: процесса хода у механизма больше
// нет. Порог тишины поэтому даёт ВЕРДИКТ — «стенограмма молчит дольше порога», — а сессия
// при этом остаётся живой, и сообщение ей доставится.
const HANG_TASK = 'cursorhang-t20260903-000000';
const HANG_WORKER = 'worker:hang';
store.createTask(home, { id: HANG_TASK, title: 'молчащий ход Cursor', owner: ORCH_SESSION });
const hangEnv = { ...env, [HANG_VAR]: '1' };
// Свой бриф: заголовок куска работы задаёт имя сессии, а имя сессии — ключ реестра.
const hangBrief = path.join(SB, 'hang-brief.md');
writeFileSync(hangBrief, '# Молчащий ход Cursor\n\nНичего не делай.\n');
const hangSpawn = cli([ 'spawn', '--repo', repo, '--brief', hangBrief, '--task', HANG_TASK,
  '--worker', 'hang', '--harness', 'cursor'], { cwd: ws, env: hangEnv });
const hangRef = store.participantOf(store.readTask(home, HANG_TASK), HANG_WORKER)?.sessionRef ?? '';
check(': участник с молчащим ходом поднялся — сессия живая, а ход не кончается',
  hangSpawn.status === 0 && !!hangRef && hangRef !== ref, `${hangSpawn.out.slice(-200)} · ${hangRef}`);

const silent = await waitFor(() => {
  const view = cursorDriver.inspect(hangRef);
  return view?.stall?.kind === 'watchdog' ? view : null;
}, { timeoutMs: 30000 });
check(': ход, молчащий дольше порога, — вердикт watchdog’а, а сессия остаётся живой',
  silent?.state === 'alive' && silent?.busy === true && /молчит/.test(String(silent?.stall?.reason)),
  `${JSON.stringify(silent)} · ${JSON.stringify(turnState(readSession(hangRef, env), env))}`);

const hangStatus = cli([ 'status', '--task', HANG_TASK], { cwd: ws, env });
const hangLine = hangStatus.out.split('\n').find((l) => l.includes(HANG_WORKER)) ?? hangStatus.out;
check(': строка status стоящего Cursor не содержит claude — маршрут от его driver’а',
  hangStatus.status === 0 && /ВСТАЛА/.test(hangLine) && !/claude /.test(hangLine)
  && /agent persist/.test(hangLine),
  hangLine);

const HANG_CHILD_TASK = 'cursorhangchild-t20260903-000000';
const HANG_CHILD_WORKER = 'worker:hangchild';
store.createTask(home, { id: HANG_CHILD_TASK, title: 'молчащий ход с живым процессом', owner: ORCH_SESSION });
const hangChildEnv = { ...env, [HANG_CHILD_VAR]: '1' };
const hangChildBrief = path.join(SB, 'hang-child-brief.md');
writeFileSync(hangChildBrief, '# Молчащий ход Cursor с живым ребёнком\n\nЖди.\n');
const hangChildSpawn = cli([ 'spawn', '--repo', repo, '--brief', hangChildBrief,
  '--task', HANG_CHILD_TASK, '--worker', 'hangchild', '--harness', 'cursor'],
{ cwd: ws, env: hangChildEnv });
const hangChildRef = store.participantOf(store.readTask(home, HANG_CHILD_TASK), HANG_CHILD_WORKER)
  ?.sessionRef ?? '';
check(': участник с тишиной и живым ребёнком панели поднялся',
  hangChildSpawn.status === 0 && !!hangChildRef, `${hangChildSpawn.out.slice(-200)} · ${hangChildRef}`);

const living = await waitFor(() => {
  const view = cursorDriver.inspect(hangChildRef);
  return view?.busy && !view?.stall && /процессы живы/.test(String(view?.note)) ? view : null;
}, { timeoutMs: 30000 });
check(': тишина стенограммы при живом ребёнке панели — не стоп, строка честная',
  living?.state === 'alive' && living?.stall === null
  && /молчит \d+ с, процессы живы/.test(String(living?.note))
  && !/встал/i.test(String(living?.note)),
  JSON.stringify(living));

const livingStatus = cli([ 'status', '--task', HANG_CHILD_TASK], { cwd: ws, env });
const livingLine = livingStatus.out.split('\n').find((l) => l.includes(HANG_CHILD_WORKER))
  ?? livingStatus.out;
check(': status при тишине с живыми процессами не говорит «встал»',
  livingStatus.status === 0 && /жива/.test(livingLine) && !/ВСТАЛА/.test(livingLine)
  && !/встал/.test(livingLine) && /процессы живы/.test(livingLine),
  livingLine);

cli([ 'done', '--task', HANG_CHILD_TASK], { cwd: ws, env });

check(': молчание и правда было — стенд отметил его в следе участника',
  readTrace(HARNESS, HANG_WORKER).some((e) => e.kind === 'hang'),
  diagnoseTrace(HARNESS, HANG_WORKER));

// Состояние `stale` под persist появилось: сессию можно погасить снаружи, а состояние
// `persist` живёт в `/tmp` и перезагрузку не переживает. Под headless его не было
// ни при каком исходе.
const hangRecord = readSession(hangRef, env);
tmux(['kill-session', '-t', hangRecord.sessionName], { env });
const gone = cursorDriver.inspect(hangRef);
check(': сессии нет на tmux-сервере, а запись есть — это stale, и маршрут зовёт список',
  gone?.state === 'stale' && gone?.stall?.kind === 'stale'
  && /persist list/.test(cursorDriver.stallRoute({ kind: 'stale', address: HANG_WORKER }, gone.id)),
  `${JSON.stringify(gone)} · ${cursorDriver.stallRoute({ kind: 'stale', address: HANG_WORKER }, gone.id)}`);

const wakeStale = await cursorDriver.activate({ ref: hangRef }, {
  kind: 'unread', task: HANG_TASK, address: HANG_WORKER, unread: 1, messages: [],
});
check(': в погашенную снаружи сессию доставить нечем — отказ называет причину',
  wakeStale?.ok === false && /на tmux-сервере/.test(String(wakeStale?.error)), JSON.stringify(wakeStale));

cli([ 'done', '--task', HANG_TASK], { cwd: ws, env });
restore();
