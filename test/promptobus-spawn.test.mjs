// Регресс на запись участника, которую делает сам spawn. Запуск: npm test
//
// Соседний promptobus.test.mjs берёт под тест ПЛАН spawn'а и до `spawnSync` не доходит:
// граница покрытия там проходит по бинарю. Из-за этого девять полей, которые
// `upsertParticipant` кладёт в журнал задачи, не проверялись ни одним тестом — план
// проверялся, запись плана нет, и расхождение между ними было бы тихим. Живой случай
// уже дважды проходил рядом:  добавила `baseSha`,  — `title`, и оба
// поля закрыты только со стороны чтения (`planReview` берёт их из подложенного журнала).
//
// Поэтому здесь spawn исполняется целиком, а граница переносится на два шва:
//
// - **git настоящий.** Клон с локальным bare-origin вместо сети: `freshenRepo` делает
//   тот же `fetch origin`, только по пути на диске, а `createWorktree` заводит настоящую
//   ветку и отдаёт настоящий sha точки ветвления. Мока git тут нет вовсе — проверяется
//   то, что он действительно делает.
// - **`claude` подменён на PATH.** Тот же приём и тот же помощник (`stubCommand` из
//   sandbox.mjs), что в promptobus-review.test.mjs: скрипт отвечает на `claude agents --json`
//   заданным списком сессий и на `claude --bg` заданным кодом возврата. Живая сессия не
//   поднимается. Тем же способом подменяется `npm` в проверках установки зависимостей
//   worktree: настоящий `npm` набор не зовёт.
import {
  chmodSync, mkdirSync, writeFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync,
  symlinkSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { resetCliCaches, stubCommand, writeHostConfig } from './sandbox.mjs';
import { capture, quiet } from './console.mjs';
import { check } from './check.mjs';

// realpath: планировщик канонизирует корень (macOS: /var → /private/var), и ожидания
// теста должны сравниваться с каноническими путями.
// Пробел в имени песочницы — не украшение: команда, которую печатает `--dry-run`, идёт
// человеку в терминал, и проверять её квотирование на пути без пробелов значит не
// проверять вовсе (замечание ревью). Заодно весь spawn прогоняется на пути с пробелом.
const SB = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'promptobus-promptobus spawn-')));
const here = path.dirname(fileURLToPath(import.meta.url));
const spawnUrl = pathToFileURL(path.join(here, '..', 'lib', 'spawn.js')).href;
const { planSpawn, spawn: spawnRaw, sayWorktreeDeps, writeSecret, SKILL_KEYS, skillSettings } = await import(spawnUrl);
const stubClaude = () => path.join(BIN, process.platform === 'win32' ? 'claude.cmd' : 'claude');
const spawnWorker = (root, opts = {}) => spawnRaw(root, {
  tool: { ok: true, bin: stubClaude() },
  ...opts,
});
const { installWorktreeDeps, npmCiCommand } = await import(path.join(here, '..', 'lib', 'worktree.js'));
const { IDENTITY_VARS } = await import(path.join(here, 'hygiene.mjs'));
const { ULTRACODE_MIN_VERSION } = await import(path.join(here, '..', 'lib', 'driver-claude.js'));
const CLAUDE_MIN = '2.0.0';
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
const store = await import(path.join(here, '..', 'lib', 'store.js'));
const { hostOf } = await import(path.join(here, '..', 'lib', 'host.js'));
const { GUARD_HOOK_EVENT, guardHookCommand, guardHookSettings } = await import(path.join(here, '..', 'dist', 'hooks.js'));
const { shellQuote } = await import(path.join(here, '..', 'lib', 'util.js'));

check(`: ключи участника — skillOverrides, и spawn читает их из настроек workspace`,
  SKILL_KEYS.length > 0 && SKILL_KEYS.includes('skillOverrides'),
  SKILL_KEYS.join(', '));


const g = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

// --- рабочее место с настоящим клоном ----------------------------------------

const WS = path.join(SB, 'ws');
mkdirSync(WS, { recursive: true });
writeFileSync(path.join(WS, 'AGENTS.md'), 'workspace\n');
writeHostConfig(WS, { tools: ['claude', 'cursor', 'codex'] });
mkdirSync(path.join(WS, '.claude'), { recursive: true });
writeFileSync(path.join(WS, '.claude', 'settings.json'), JSON.stringify({
  skillOverrides: { 'ненужный-скилл': 'off' },
}));
const settingsSample = skillSettings(WS);
check(': spawn читает skillOverrides из настроек workspace',
  settingsSample.skillOverrides?.['ненужный-скилл'] === 'off',
  JSON.stringify(settingsSample));

// Origin — bare-репозиторий на диске: `freshenRepo` ходит в него настоящим fetch, но
// сети при этом не касается. Без origin вовсе default-ветка не определилась бы, и
// worktree ветвился бы от HEAD — то есть проверялась бы не та дорога, которой идёт жизнь.
const ORIGIN = path.join(SB, 'origin', 'cargos-api.git');
const SEED = path.join(SB, 'seed');
mkdirSync(ORIGIN, { recursive: true });
mkdirSync(SEED, { recursive: true });
spawnSync('git', ['init', '--bare', '-b', 'main', ORIGIN], { encoding: 'utf8' });
g(SEED, 'init', '-b', 'main');
writeFileSync(path.join(SEED, 'AGENTS.md'), 'Правила репозитория cargos-api.\n');
writeFileSync(path.join(SEED, 'a.txt'), 'v1\n');
g(SEED, 'add', '.');
g(SEED, 'commit', '-m', 'init', '-q');
g(SEED, 'remote', 'add', 'origin', ORIGIN);
g(SEED, 'push', '-q', 'origin', 'main');

const REPO = path.join(WS, 'cargos-api');

// Каталоги worktree клона — по штампу задачи, а не по собранному имени. Литерал имени в
// негативной проверке холостеет молча: половина такой пары («worktree не заведён») уже
// была холостой до  — литерал `a2a-ultra-ultracode-…` перечислял слаги в обратном
// порядке против шаблона `<слаг задачи>-<слаг worker'а>`, и путь, которого не бывает,
// проверка честно не находила. Штамп задачи в имени стоит всегда и от префикса не зависит.
const worktreesWithStamp = (stamp) => {
  const dir = path.join(REPO, '.claude', 'worktrees');
  return (existsSync(dir) ? readdirSync(dir) : []).filter((n) => n.includes(stamp));
};
spawnSync('git', ['clone', '-q', ORIGIN, REPO], { encoding: 'utf8' });

const BRIEF = path.join(SB, 'brief.md');
writeFileSync(BRIEF, '# Добавить поле source в событие CargoCreated\n\nПравки в контракте и публикации.\n');

// --- подставной claude --------------------------------------------------------

const BIN = path.join(SB, 'bin');
mkdirSync(BIN, { recursive: true });
const PATH0 = process.env.PATH;
// Один скрипт на оба вызова: `claude agents --json` спрашивает awaitSession, `claude
// --bg …` поднимает сессию. Различаем по первому аргументу — как это делает и сам
// бинарь. `bgStatus` задаёт исход запуска: 0 — поднялся, иначе ветка отказа.
// `--version` спрашивает резолв бинаря: spawn больше не запускает первый
// попавшийся `claude`, а сверяет его версию с объявленной минимальной.
//
// Сценарий — на JS через общий помощник песочницы (sandbox.mjs), а не сырым `#!/bin/sh`:
// файл без расширения на Windows не находится вовсе (`resolveCommand` перебирает
// PATH × PATHEXT), и тест краснел бы там при исправном коде.
const claudeSays = (sessions, bgStatus = 0, version = '2.1.237 (Claude Code)') => {
  stubCommand(BIN, 'claude', `const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write(${JSON.stringify(`${version}\n`)}); process.exit(0); }
if (args[0] === 'agents') { process.stdout.write(${JSON.stringify(JSON.stringify(sessions))}); process.exit(0); }
process.stdout.write('backgrounded · sess-0001\\n');
process.exit(${bgStatus});`);
  process.env.PATH = `${BIN}${path.delimiter}${PATH0}`;
};

// --- запись участника на удавшемся spawn'е ------------------------------------

const HOME = store.promptobusHome(WS, hostOf(WS));
const TASK = 'sobytie-t20260827-120000';
// Задачу заводим сами: у новой её id собирается из текущей секунды, и имя сессии,
// посчитанное до spawn'а ради подставного `claude`, разошлось бы с посчитанным внутри.
store.createTask(HOME, {
  id: TASK, title: 'событие CargoCreated в двух сервисах', slug: 'sobytie', stamp: 't20260827-120000',
});

const opts = { repo: 'cargos-api', brief: BRIEF, task: TASK, effort: 'high' };
const plan = await planSpawn(WS, opts);
const SESSION_ID = 'sess-0001';
claudeSays([{ id: SESSION_ID, name: plan.name, state: 'working', pid: 4242 }]);

await quiet(() => spawnWorker(WS, opts));

// Поля механизма лежат в `metadata` записи v1: их пишет adapter, он же и читает.
const record = store.participantOf(store.readTask(HOME, TASK), 'worker:cargos-api');
const written = record?.metadata;
check(': spawn записал участника в журнал задачи', !!written, JSON.stringify(written));
// Девять полей поимённо. Проверять их одной строкой нельзя: расхождение по одному полю
// должно называть себя, а не прятаться за общим «объекты не равны».
check(': name — то, что уехало в --name, по нему участника ищут в claude agents',
  written?.name === plan.name && plan.argv[plan.argv.indexOf('--name') + 1] === plan.name, written?.name);
check(': worktreeName — машинная строка, из которой сделаны каталог и ветка',
  written?.worktreeName === plan.wtName && plan.branch.endsWith(plan.wtName), written?.worktreeName);
check(': baseSha — настоящий sha ветки, а не имя базы',
  /^[0-9a-f]{40}$/.test(written?.baseSha ?? '')
  && written.baseSha === spawnSync('git', ['-C', REPO, 'rev-parse', plan.branch], { encoding: 'utf8' }).stdout.trim(),
  written?.baseSha);
check(': title — заголовок куска работы, из него собрано имя сессии',
  written?.title === plan.workTitle && plan.name.includes(written.title), written?.title);
check(': session — идентификатор из claude agents, а не из разбора вывода',
  written?.session === SESSION_ID, written?.session);
check(`: branch — ветка, заведённая spawn'ом`,
  written?.branch === plan.branch && plan.branch.startsWith('worktree-'), written?.branch);
check(': worktree — абсолютный путь каталога, и каталог существует',
  written?.worktree === plan.worktreePath && path.isAbsolute(written.worktree) && existsSync(written.worktree),
  written?.worktree);
check(': repoAbs — абсолютный путь клона, репозиторий назван и коротким именем',
  written?.repoAbs === REPO && written?.repo === 'cargos-api', `${written?.repoAbs} · ${written?.repo}`);
check(': model и effort — те, что уехали в команду',
  written?.model === 'opus' && written?.effort === 'high'
  && plan.argv.includes('--effort') && plan.argv[plan.argv.indexOf('--effort') + 1] === 'high',
  `${written?.model} · ${written?.effort}`);
// Режим прав: без флага worker идёт в `auto`, флаг переопределяет на один spawn,
// неизвестное значение отказывает до подъёма (проверка без стека — ниже, вместе с --effort).
check(': без --permission-mode worker поднимается в auto — режим стоит в argv явно',
  plan.permissionMode === 'auto' && plan.argv[plan.argv.indexOf('--permission-mode') + 1] === 'auto',
  `${plan.permissionMode} · ${plan.argv.join(' ')}`);
const bypass = await planSpawn(WS, { ...opts, worker: 'bypass', permissionMode: 'bypassPermissions' });
check(': --permission-mode переопределяет режим на один spawn и уезжает в argv',
  bypass.permissionMode === 'bypassPermissions'
  && bypass.argv[bypass.argv.indexOf('--permission-mode') + 1] === 'bypassPermissions', bypass.argv.join(' '));
// Поля, которых план не выдумывает: без --effort его нет вовсе, а не пустой строкой.
check(': started — время подъёма в ISO', typeof written?.started === 'string'
  && !Number.isNaN(Date.parse(written.started)), written?.started);
// Журнал и git должны говорить одно: ветка из записи выписана в её же каталоге.
check(': запись сходится с git — в каталоге worktree стоит записанная ветка',
  spawnSync('git', ['-C', written.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' })
    .stdout.trim() === written.branch);


// --- : права mcp-конфига участника --------------------------------------
//
// В конфиге лежат подставленные токены — вывод spawn'а их поэтому и не печатает,
// — а файл ложился `-rw-r--r--` и читался любым пользователем машины. Проверяются оба
// шага правки: режим при создании и `chmod` при перезаписи. Второй нужен отдельно —
// `mode` у `writeFileSync` работает только на СОЗДАНИИ, и повторный spawn (штатный
// перезапуск умершего worker'а) иначе оставил бы прежние 0644 навсегда.
const modeOf = (f) => statSync(f).mode & 0o777;
check(`: mcp-конфиг worker'а создан с правами 0600`,
  modeOf(plan.mcpConfigPath) === 0o600, modeOf(plan.mcpConfigPath).toString(8));
check(': конфиг и правда несёт то, ради чего права закрыты — env шины участника',
  JSON.parse(readFileSync(plan.mcpConfigPath, 'utf8')).mcpServers['promptobus'].env.PROMPTOBUS_TASK === TASK);
// Перезапись проверяется самой записью, а не вторым spawn'ом: повторный spawn живого
// worker'а — отказ, и до записи конфига он не доходит вовсе.
chmodSync(plan.mcpConfigPath, 0o644);
writeSecret(plan.mcpConfigPath, readFileSync(plan.mcpConfigPath, 'utf8'));
check(': перезапись чинит права уже лежащего конфига, а не оставляет 0644',
  modeOf(plan.mcpConfigPath) === 0o600, modeOf(plan.mcpConfigPath).toString(8));
// Файл настроек секретов не несёт, и его прав правка не касается — иначе проверка выше
// проходила бы и на «закрыли всё подряд». Сравниваем с КОНТРОЛЬНЫМ файлом, записанным
// рядом обычным `writeFileSync`, а не с константой (замечание ревью): при `umask 077`
// обычная запись даёт ровно 0600, и сверка с числом покраснела бы не по делу. Обратное
// («конфиг отличается от контроля») здесь не утверждаем по той же причине: под `umask 077`
// он и не отличается, а закрытость конфига держит проверка выше — там 0600 стоит явным
// `chmod` и от umask не зависит вовсе.
const CONTROL = path.join(path.dirname(plan.settingsPath), 'control.json');
writeFileSync(CONTROL, '{}\n');
check(': файл настроек участника прав не менял — он такой же, как обычная запись рядом',
  modeOf(plan.settingsPath) === modeOf(CONTROL),
  `настройки ${modeOf(plan.settingsPath).toString(8)} · контроль ${modeOf(CONTROL).toString(8)}`);

// /: файл настроек участника несёт Stop-хук сторожа цикла. Хук из
// `.claude/settings.json` рабочего места до сессии участника не доезжает — её cwd в worktree
// клона. Сверяется ФАЙЛ, а не план: `--settings` читает харнес с диска, и разойдись они,
// никто бы не заметил. Команда сверяется с той же функцией, что кладёт хук оркестратору:
// второй её копии тут не заводим — расхождение двух команд и есть то, что ловится.
//
// : в команде участника стоит его ИДЕНТИЧНОСТЬ — адрес, задача и дом. Это её
// единственный путь до хука: окружение сессии фоновая сессия получает от демона, и класть
// её туда значило бы раздавать соседям чужой адрес.
const written426 = JSON.parse(readFileSync(plan.settingsPath, 'utf8'));
const guardGroup = written426.hooks?.[GUARD_HOOK_EVENT]?.[0]?.hooks?.[0];
const guardIdentity = { address: plan.address, taskId: plan.taskId, home: plan.home };
const wsHost = hostOf(WS);
check(': файл настроек участника несёт Stop-хук сторожа цикла — ту же команду, что у layout\'а',
  guardGroup?.type === 'command'
  && guardGroup?.command === guardHookCommand(wsHost, guardIdentity),
  JSON.stringify(written426.hooks ?? null));
check('участнику SessionStart не кладётся — детектор смотрит корень workspace',
  written426.hooks?.SessionStart === undefined,
  JSON.stringify(written426.hooks ?? null));
check(': команда хука участника несёт его идентичность аргументами, а хук layout\'а — нет',
  guardGroup?.command?.includes(` --role ${shellQuote(plan.address)} --task ${shellQuote(plan.taskId)}`
    + ` --home ${shellQuote(plan.home)}`)
  && !guardHookSettings(wsHost)[GUARD_HOOK_EVENT][0].hooks[0].command.includes('--role'),
  `${guardGroup?.command} · layout: ${guardHookSettings(wsHost)[GUARD_HOOK_EVENT][0].hooks[0].command}`);
// Замечание ревью: значения квотируются, а не оборачиваются в двойные кавычки — внутри тех
// шелл раскрывает `$`. Песочница этого файла уже несёт пробел в имени (см. шапку), и `--home`
// в команде обязан приехать в одинарных кавычках, а не разъехаться по аргументам.
check(': значение с пробелом уехало в команду хука квотированным, а не двумя аргументами',
  / --home '[^']*promptobus-promptobus spawn[^']*'/.test(guardGroup?.command ?? ''),
  String(guardGroup?.command));

// --- : --task-title доезжает от командной строки до журнала --------------
//
// Соседний cli-flags.test.mjs проверяет, что флаг переживает разбор; здесь — что он
// доезжает до дела. Между этими двумя точками у него две ловушки, обе тихие: спред
// `...values` кладёт кебабный ключ мимо опций библиотеки, а `planSpawn` читает
// `opts.taskTitle`. Прогон настоящей командой, а не библиотечным вызовом.
const CLI = path.join(here, '..', 'bin', 'promptobus.js');

// --- : отказы разбора флагов — настоящей командой без стека -------------
//
// Верхний catch живёт только в отдельном CLI-процессе: прямой вызов функции способен
// проверить класс броска, но не форму, которую увидит человек. По одному прогону на
// каждый достижимый вход разбора; у --brief дополнительно проверены обе ветки файла.
const cliRun = (args, env = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', cwd: WS, env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}`, ...env },
  });
  return { status: r.status, text: `${r.stdout}${r.stderr}` };
};
const noStack = (run) => run.status === 1 && !/\n\s+at /.test(run.text) && !/^Error:/m.test(run.text);
const EMPTY_BRIEF = path.join(SB, 'empty-brief.md');
writeFileSync(EMPTY_BRIEF, '');
const briefRefusals = [
  cliRun([ 'spawn', '--repo', 'cargos-api', '--dry-run']),
  cliRun([ 'spawn', '--repo', 'cargos-api', '--brief', path.join(SB, 'net-briefa.md'), '--dry-run']),
  cliRun([ 'spawn', '--repo', 'cargos-api', '--brief', EMPTY_BRIEF, '--dry-run']),
];
check(': --brief — отсутствие, несуществующий и пустой файл печатаются без стека',
  briefRefusals.every(noStack)
  && /нужен --brief/.test(briefRefusals[0].text)
  && /файла с заданием нет/.test(briefRefusals[1].text)
  && /файл с заданием пуст/.test(briefRefusals[2].text),
  briefRefusals.map((r) => `status=${r.status} ${r.text}`).join(' | '));

const goneSub = cliRun([ 'wait', '--timeout', '10m'], {
  PROMPTOBUS_HOME: HOME, PROMPTOBUS_TASK: TASK, PROMPTOBUS_ROLE: 'orchestrator',
});
check(': снятая подкоманда wait — отказ неизвестной, без стека и без справки о ней',
  noStack(goneSub) && /неизвестная команда «wait»/.test(goneSub.text)
  && !/promptobus wait/.test(goneSub.text),
  `status=${goneSub.status} ${goneSub.text}`);

const badOlderThan = cliRun([ 'prune', '--older-than', '0d']);
check(': prune --older-than с негодным сроком печатается без стека',
  noStack(badOlderThan) && /--older-than <дней>/.test(badOlderThan.text),
  `status=${badOlderThan.status} ${badOlderThan.text}`);

const badEffort = cliRun([
  'promptobus', 'spawn', '--repo', 'cargos-api', '--brief', BRIEF, '--task', TASK,
  '--worker', 'bad-effort', '--effort', 'turbo', '--dry-run',
]);
check(': spawn --effort с неизвестным значением печатается без стека',
  noStack(badEffort) && /--effort: неизвестное значение «turbo»/.test(badEffort.text),
  `status=${badEffort.status} ${badEffort.text}`);
const badMode = cliRun([
  'promptobus', 'spawn', '--repo', 'cargos-api', '--brief', BRIEF, '--task', TASK,
  '--worker', 'bad-mode', '--permission-mode', 'svoy', '--dry-run',
]);
check(': spawn --permission-mode с неизвестным значением отказывает без стека и называет перечень',
  noStack(badMode) && /--permission-mode: неизвестное значение «svoy»/.test(badMode.text) && /bypassPermissions/.test(badMode.text),
  `status=${badMode.status} ${badMode.text}`);

const badWorker = cliRun([
  'promptobus', 'spawn', '--repo', 'cargos-api', '--brief', BRIEF, '--task', TASK,
  '--worker', '!!!', '--dry-run',
]);
check(': spawn --worker с негодным именем печатается без стека',
  noStack(badWorker) && /--worker «!!!» не даёт имени/.test(badWorker.text),
  `status=${badWorker.status} ${badWorker.text}`);

// --- : явный --task без журнала — настоящей командой без стека ----------
//
// Планировщик проверяет `taskExists` сам и бросал голый `Error`: опечатка в id
// приезжала со стеком, хотя `resolveTaskId` / `promptobus status` на том же тексте уже
// `GateError`. Верхний catch — только в отдельном CLI-процессе, как у .
const missingSpawnTask = cliRun([
  'promptobus', 'spawn', '--repo', 'cargos-api', '--brief', BRIEF,
  '--task', 'net-takoy-bl394', '--dry-run',
]);
check(': spawn --task несуществующей задачи печатается без стека',
  noStack(missingSpawnTask) && /задачи net-takoy-bl394 нет/.test(missingSpawnTask.text),
  `status=${missingSpawnTask.status} ${missingSpawnTask.text}`);

const DONE_TASK = 'bl-394-zakryta-t20260831-120000';
store.createTask(HOME, {
  id: DONE_TASK, title: 'закрытая задача ', slug: 'bl-394-zakryta', stamp: 't20260831-120000',
});
store.closeTask(HOME, DONE_TASK);
const closedSpawnTask = cliRun([
  'promptobus', 'spawn', '--repo', 'cargos-api', '--brief', BRIEF,
  '--task', DONE_TASK, '--dry-run',
]);
check(': spawn --task закрытой задачи печатается без стека',
  noStack(closedSpawnTask) && /задача bl-394-zakryta-t20260831-120000 закрыта/.test(closedSpawnTask.text),
  `status=${closedSpawnTask.status} ${closedSpawnTask.text}`);

// Новую задачу заводит только spawn без `--task`, а к этому месту файла активные задачи
// уже есть — команда подхватила бы одну из них и до заголовка новой задачи не дошла.
// Поэтому на время прогона они закрываются и возвращаются как были. Правка идёт мимо
// двери: `closeTask` необратим, а вернуть задачу в активные командами механизма нечем.
const setStatus = (id, status) => {
  const file = store.taskFile(HOME, id);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), status }, null, 2) + '\n');
};
const activeNow = store.activeTasks(HOME).map((t) => t.id);
for (const id of activeNow) setStatus(id, 'done');
const cliDry = spawnSync(process.execPath, [
  CLI, 'promptobus', 'spawn', '--repo', 'cargos-api', '--brief', BRIEF,
  '--task-title', 'Заход по бэклогу: spawn, ожидание, резолв', '--dry-run',
], { encoding: 'utf8', cwd: WS, env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}` } });
for (const id of activeNow) setStatus(id, 'active');
const cliText = `${cliDry.stdout}${cliDry.stderr}`;
check(': --task-title доезжает от командной строки до заголовка задачи',
  cliDry.status === 0 && cliText.includes('будет создана: Заход по бэклогу: spawn, ожидание, резолв'),
  `status=${cliDry.status} ${cliText}`);
// Заголовок КУСКА при этом остаётся заголовком куска — из него собрано имя сессии.
check(': --task-title не подменяет заголовок куска работы в имени сессии',
  cliText.includes('Worker: Добавить поле source в событие CargoCreated'),
  cliText.split('\n').filter((l) => /сессия/.test(l)).join(' | '));

// --- : чужая задача и пришпиленный заголовок — настоящей командой --------
//
// Предмет тот же, что у плана в promptobus.test.mjs, но проверяется ВЫВОД. Отказ и
// предупреждение печатает `spawn`, а не план: оставь их полями плана — и оба молчания,
// ради которых заведена задача, вернутся ровно там, где их читает человек.
const GUARD_TASK = 'bl-232-chuzhaya-t20260828-123535';
const GUARD_TITLE = 'Заход 0828c: справочник, живость цикла, правила';
store.createTask(HOME, {
  id: GUARD_TASK,
  title: GUARD_TITLE,
  adapter: { slug: 'bl-232-chuzhaya', stamp: 't20260828-123535', titleExplicit: true },
  owner: 'sess-hozyain',
});
// Активной задача должна быть одна: spawn без `--task` подсаживает в единственную, а при
// нескольких отказал бы списком — то есть не тем отказом, который проверяем.
const guardOthers = store.activeTasks(HOME).map((t) => t.id).filter((id) => id !== GUARD_TASK);
for (const id of guardOthers) setStatus(id, 'done');
// Идентичность сессии подставляем в окружение дочернего процесса: `sessionIdentity`
// читает `CLAUDE_CODE_SESSION_ID`, и без подстановки проверка зависела бы от того, кто
// запустил прогон.
const guardRun = (session, ...args) => {
  const r = spawnSync(process.execPath, [CLI, 'spawn', '--repo', 'cargos-api', '--brief', BRIEF, ...args],
    { encoding: 'utf8', cwd: WS, env: { ...process.env, CLAUDE_CODE_SESSION_ID: session, PATH: `${BIN}${path.delimiter}${PATH0}` } });
  return { status: r.status, text: `${r.stdout}${r.stderr}` };
};
const foreignRun = guardRun('sess-gost', '--dry-run');
check(`: команда отказывает чужому spawn'у без --task — владелец, заголовок и маршрут в тексте`,
  foreignRun.status === 1 && foreignRun.text.includes('sess-hozyain') && foreignRun.text.includes('sess-gost')
  && foreignRun.text.includes(GUARD_TITLE) && foreignRun.text.includes(`--task ${GUARD_TASK}`)
  && foreignRun.text.includes('mailbox {claim: true}') && foreignRun.text.includes('spawn с --new-task')
  && foreignRun.text.includes(`сообщения его track'а`)
  && /заканчивает его владелец/.test(foreignRun.text),
  `status=${foreignRun.status} ${foreignRun.text}`);
// : тот же отказ, но проверяется его ФОРМА. Он живёт в `planSpawn`, которую зовут и
// как чистую функцию, — `fail()` там недоступен, и признак ожидаемой несёт класс
// `GateError`; верхний catch `agents.js` опознаёт его по имени и стек не печатает. Без
// признака самый частый законный исход шины приезжал оркестратору строкой `Error: задача…`
// с четырьмя строками стека, то есть выглядел внутренней поломкой CLI (класс ).
check(': отказ гейта владельца печатается без стека — законный исход, а не поломка',
  foreignRun.status === 1 && !/\n\s+at /.test(foreignRun.text) && !/^Error:/m.test(foreignRun.text),
  `status=${foreignRun.status} ${foreignRun.text}`);

// --- : явный и автоматический новый run --------------------------------
//
// Одна чужая активная остаётся гейтом  без флага. `--new-task` — явный форк,
// а при двух активных без привязки выбора для подсадки всё равно нет, поэтому новая
// задача становится автоматическим исходом.
const forkRun = guardRun('sess-gost', '--new-task', '--worker', 'fork', '--dry-run');
check(': --new-task заводит отдельную задачу рядом с одной чужой',
  forkRun.status === 0 && /будет создана:/.test(forkRun.text)
  && !forkRun.text.includes(`задача: ${GUARD_TASK}`),
  `status=${forkRun.status} ${forkRun.text}`);

const incompatibleNewTask = guardRun('sess-gost', '--new-task', '--task', GUARD_TASK, '--dry-run');
check(': --new-task несовместим с --task и отказывает без стека',
  noStack(incompatibleNewTask) && /--new-task несовместим с --task/.test(incompatibleNewTask.text),
  `status=${incompatibleNewTask.status} ${incompatibleNewTask.text}`);

store.bindSession(HOME, GUARD_TASK, 'sess-hozyain');
const boundNewTask = guardRun('sess-hozyain', '--new-task', '--dry-run');
check(': живая привязка не перепрыгивает в новый run',
  noStack(boundNewTask) && boundNewTask.text.includes(GUARD_TASK)
  && /promptobus done/.test(boundNewTask.text) && /другой сессии/.test(boundNewTask.text),
  `status=${boundNewTask.status} ${boundNewTask.text}`);

const SECOND_ACTIVE = 'bl-389-vtoraya-t20260831-120000';
store.createTask(HOME, {
  id: SECOND_ACTIVE, title: 'вторая активная задача', slug: 'bl-389-vtoraya',
  stamp: 't20260831-120000', owner: 'sess-drugaya',
});
const automaticNewTask = guardRun('sess-bez-privyazki', '--worker', 'avto', '--dry-run');
check(': две активные без привязки автоматически заводят новую задачу',
  automaticNewTask.status === 0 && /будет создана:/.test(automaticNewTask.text)
  && !automaticNewTask.text.includes(`задача: ${GUARD_TASK}`)
  && !automaticNewTask.text.includes(`задача: ${SECOND_ACTIVE}`),
  `status=${automaticNewTask.status} ${automaticNewTask.text}`);

const manyForOtherCommands = cliRun([ 'done'], { CLAUDE_CODE_SESSION_ID: 'sess-bez-privyazki' });
check(': отказ других команд при нескольких активных называет вход --new-task',
  noStack(manyForOtherCommands) && manyForOtherCommands.text.includes(GUARD_TASK)
  && manyForOtherCommands.text.includes(SECOND_ACTIVE)
  && manyForOtherCommands.text.includes('promptobus spawn --new-task'),
  `status=${manyForOtherCommands.status} ${manyForOtherCommands.text}`);

const keptRun = guardRun('sess-gost', '--task', GUARD_TASK, '--worker', 'yavno',
  '--task-title', 'LS-235543: флаги refresh в cargos-api', '--dry-run');
check(': явный --task проходит, а --task-title печатает предупреждение и заголовок не трогает',
  keptRun.status === 0 && keptRun.text.includes('--task-title проигнорирован')
  && keptRun.text.includes(GUARD_TITLE) && !keptRun.text.includes('будет переименована')
  && store.readTask(HOME, GUARD_TASK).title === GUARD_TITLE,
  `status=${keptRun.status} ${keptRun.text}`);
// : та же команда от ВЛАДЕЛЬЦА mailbox'а заголовок перештамповывает — явность двойная,
// `--task` плюс `--task-title`. Предмет тот же, что у отказа выше, — печать; журнал под
// `--dry-run` не трогается вовсе, и заголовок на диске обязан остаться прежним.
const RESTAMP_TITLE = 'Заход 0828c: справочник и живость цикла';
const stampRun = guardRun('sess-hozyain', '--task', GUARD_TASK, '--worker', 'peresh',
  '--task-title', RESTAMP_TITLE, '--dry-run');
check(': владелец с явным --task видит переименование, а не предупреждение',
  stampRun.status === 0 && stampRun.text.includes(`будет переименована: ${RESTAMP_TITLE}`)
  && !stampRun.text.includes('--task-title проигнорирован')
  && store.readTask(HOME, GUARD_TASK).title === GUARD_TITLE,
  `status=${stampRun.status} ${stampRun.text}`);
store.closeTask(HOME, GUARD_TASK);
store.closeTask(HOME, SECOND_ACTIVE);
const afterClosedBinding = guardRun('sess-hozyain', '--dry-run');
check(': закрытая привязка не считается живой и не мешает следующей задаче',
  afterClosedBinding.status === 0 && /будет создана:/.test(afterClosedBinding.text),
  `status=${afterClosedBinding.status} ${afterClosedBinding.text}`);
for (const id of guardOthers) setStatus(id, 'active');

// --- : неоднозначное имя печатает кандидатов, а не [object Object] ------
//
// Кандидаты в `ResolveError` — ДАННЫЕ `{ nsPath, kind, personal }`, а не готовые строки:
// печатает их `formatCandidate` ([resolve.js](../lib/resolve.js)). Spawn печатал их
// шаблонной подстановкой, то есть выдал бы `[object Object]` — оркестратору не из чего
// выбирать. Проверка смотрит на СТРОКУ кандидата, а не на факт отказа: факт отказа
// одинаков и у сломанного варианта.
const missingRepo = await planSpawn(WS, { repo: 'no-such-repo', brief: BRIEF })
  .then(() => '', (e) => e.message);
check(': неизвестное имя репозитория называет путь, а не [object Object]',
  /не найден/.test(missingRepo)
  && missingRepo.includes('no-such-repo')
  && !missingRepo.includes('[object Object]'), missingRepo);

// --- : подсадка track'а дописывает заголовок задачи -----------------------
//
// План проверяется соседним promptobus.test.mjs; здесь предмет — журнал: заголовок задачи
// обязан переехать на диск, иначе run из трёх track'ов так и останется работой одной.
const BRIEF2 = path.join(SB, 'brief2.md');
writeFileSync(BRIEF2, '# Резолв имени репозитория\n\nВторая линия того же захода.\n');
const opts2 = { repo: 'cargos-api', brief: BRIEF2, task: TASK, worker: 'resolve' };
const plan2 = await planSpawn(WS, opts2);
claudeSays([
  { id: SESSION_ID, name: plan.name, state: 'working', pid: 4242 },
  { id: 'sess-0002', name: plan2.name, state: 'working', pid: 4243 },
]);
// Между планом ВЫЗЫВАЮЩЕГО и записью подсаживается третий track — так выглядит соседний
// spawn run'а, ушедший вперёд. Что здесь проверяется, стоит назвать точно: `spawn()`
// считает план заново у себя внутри, поэтому это не воспроизведение гонки, а проверка
// сквозного пути — что в журнал уезжает сборка по журналу и подсевший track из неё не
// пропадает. Саму развилку «переданная строка против пересчёта под локом» закрывает
// прямая проверка `retitleTask` в promptobus.test.mjs, а форму намерения — проверка там же:
// одной стороны не хватило, на ней второй круг и упал.
store.upsertParticipant(HOME, TASK, store.participantRecord('worker:sosed', { repo: 'cargos-api', title: 'Линия соседа',
  name: 'Worker: Линия соседа (0827-1200)' }));
await quiet(() => spawnWorker(WS, opts2));
check(': в журнал легла сборка по журналу, а не предсказание из плана вызывающего',
  store.readTask(HOME, TASK).title
    === 'Добавить поле source в событие CargoCreated · Линия соседа · Резолв имени репозитория',
  `${store.readTask(HOME, TASK).title} · предсказание было «${plan2.retitle?.preview}»`);
check(': track, подсевший после плана, из заголовка не потерялся',
  store.readTask(HOME, TASK).title.includes('Линия соседа')
  && !plan2.retitle.preview.includes('Линия соседа'),
  `${store.readTask(HOME, TASK).title} · ${plan2.retitle?.preview}`);
check(': заголовок собран, а не задан человеком — пометки явного нет',
  store.readTask(HOME, TASK).adapter.titleExplicit === undefined,
  String(store.readTask(HOME, TASK).adapter.titleExplicit));
// Имена сессий при этом остаются заголовками КУСКОВ: переименование задачи их
// не трогает — они уже в журнале.
check(`: имена сессий track'ов заголовком задачи не переписаны`,
  store.participantOf(store.readTask(HOME, TASK), 'worker:cargos-api').metadata.name === plan.name
  && store.participantOf(store.readTask(HOME, TASK), 'worker:resolve').metadata.name === plan2.name);

// --- : старый бинарь — отказ по версии, до записи на диск ----------------
//
// Отказ уносит процесс через fail(), поэтому spawn исполняется отдельным процессом.
// Смотрим на две вещи сразу: что сказано и что после этого осталось на диске.
const OLD_TASK = 'staryy-t20260827-140000';
store.createTask(HOME, {
  id: OLD_TASK, title: 'spawn на старом бинаре', slug: 'staryy', stamp: 't20260827-140000',
});
claudeSays([], 0, '2.1.100 (Claude Code)');
// Standalone resolveToolBin does not probe --version. The version gate is the
// tool object spawn already accepts: pass the declared HostToolBin refusal.
const oldTool = {
  ok: false, found: true, version: '2.1.100',
  reason: 'Claude Code: найдена версия 2.1.100, нужна 2.1.169 или новее',
};
const oldRun = spawnSync(process.execPath, ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(spawnUrl)});\n`
  + `await m.spawn(${JSON.stringify(WS)}, ${JSON.stringify({ repo: 'cargos-api', brief: BRIEF, task: OLD_TASK, worker: 'staryy', tool: oldTool })});`,
], { encoding: 'utf8', env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}` } });
const oldText = `${oldRun.stdout}${oldRun.stderr}`;
check(': отказ называет версию, а не неизвестный флаг',
  oldRun.status === 1 && /2\.1\.100/.test(oldText) && /2\.1\.169/.test(oldText) && !/неизвестн\w+ флаг/.test(oldText),
  `status=${oldRun.status} ${oldText}`);
// Один текст не должен приходить дважды подряд, ⚠ и ✖: ради `note` `sayTool` переехал
// перед отказом, но причину печатает `fail`, а не он.
check(': причина отказа печатается один раз, а не предупреждением и отказом подряд',
  (oldText.match(/найдена версия 2\.1\.100/g) ?? []).length === 1,
  oldText.split('\n').filter((l) => /2\.1\.100/.test(l)).join(' | '));
check(': ничего не заводит на диске — ни участника, ни worktree',
  !store.readTask(HOME, OLD_TASK).participants.some((p) => store.addressOf(p) === 'worker:staryy')
  && worktreesWithStamp('t20260827-140000').length === 0,
  `${JSON.stringify(store.readTask(HOME, OLD_TASK).participants)} · ${worktreesWithStamp('t20260827-140000')}`);

// --- : `--effort ultracode` на бинаре старее границы ---------------------
//
// Отказ точечный: тот же бинарь без `ultracode` spawn проходит, поэтому проверяем обе
// стороны — иначе гейт мог бы оказаться подъёмом общей minVersion под другим именем.
// Отказ уносит процесс через fail(), поэтому spawn исполняется отдельным процессом.
const ULTRA_TASK = 'ultracode-t20260828-170000';
store.createTask(HOME, {
  id: ULTRA_TASK, title: 'ultracode на старом бинаре', slug: 'ultracode', stamp: 't20260828-170000',
});
const spawnRun = (opts) => spawnSync(process.execPath, ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(spawnUrl)});\n`
  + `await m.spawn(${JSON.stringify(WS)}, ${JSON.stringify(opts)});`,
], { encoding: 'utf8', env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}` } });
// Посылка фикстуры: версия обязана проходить общий минимум и НЕ проходить порог
// ultracode. Совпади оба числа — обе проверки ниже стали бы зелёными ни на чём, и понять
// это по их вердиктам было бы нечем (замечание ревью).
check(': объявленный минимум claude строго младше минимума ultracode — есть что различать',
  versionLess(CLAUDE_MIN, ULTRACODE_MIN_VERSION), `${CLAUDE_MIN} против ${ULTRACODE_MIN_VERSION}`);
claudeSays([], 0, `${CLAUDE_MIN} (Claude Code)`);
const oldEnough = { ok: true, bin: stubClaude(), version: CLAUDE_MIN };
const ultraRun = spawnRun({
  repo: 'cargos-api', brief: BRIEF, task: ULTRA_TASK, worker: 'ultra', effort: 'ultracode',
  tool: oldEnough,
});
const ultraText = `${ultraRun.stdout}${ultraRun.stderr}`;
check(`: ultracode на ${CLAUDE_MIN} — отказ, а не тихий подъём на дефолтном эффорте`,
  ultraRun.status === 1 && ultraText.includes(CLAUDE_MIN) && ultraText.includes(ULTRACODE_MIN_VERSION)
  && /ДЕФОЛТНОМ эффорте/.test(ultraText), `status=${ultraRun.status} ${ultraText}`);
check(': отказ ничего не оставляет на диске — ни участника, ни worktree',
  !store.readTask(HOME, ULTRA_TASK).participants.some((p) => store.addressOf(p) === 'worker:ultra')
  && worktreesWithStamp('t20260828-170000').length === 0,
  `${JSON.stringify(store.readTask(HOME, ULTRA_TASK).participants)} · ${worktreesWithStamp('t20260828-170000')}`);
// Тот же бинарь и тот же spawn без `ultracode` — гейт не общий подъём минимальной версии.
const xhighPlan = await planSpawn(WS, {
  repo: 'cargos-api', brief: BRIEF, task: ULTRA_TASK, worker: 'ultra', effort: 'xhigh',
});
claudeSays([{ id: 'sess-xhigh', name: xhighPlan.name, state: 'working', pid: 4246 }], 0, `${CLAUDE_MIN} (Claude Code)`);
const xhighRun = spawnRun({
  repo: 'cargos-api', brief: BRIEF, task: ULTRA_TASK, worker: 'ultra', effort: 'xhigh',
  tool: oldEnough,
});
check(': на том же бинаре прочие эффорты проходят — отказ точечный',
  xhighRun.status === 0
  && store.readTask(HOME, ULTRA_TASK).participants.some((p) => store.addressOf(p) === 'worker:ultra'),
  `status=${xhighRun.status} ${xhighRun.stdout}${xhighRun.stderr}`);

// --- : standalone host does not search install dirs ----------------------
//
// Origin ATI host walked ~/.local/bin. Dest resolveToolBin returns { ok, bin: name }
// and does not look at HOME. A missing name is an explicit HostToolBin refusal
// (the seam spawn already has); liftoff then never runs.
const GITONLY = path.join(SB, 'gitonly');
mkdirSync(GITONLY, { recursive: true });
symlinkSync(spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim(), path.join(GITONLY, 'git'));
const FOUND_TASK = 'naydennyy-t20260827-150000';
store.createTask(HOME, {
  id: FOUND_TASK, title: 'spawn бинарём вне PATH', slug: 'naydennyy', stamp: 't20260827-150000',
});
const foundPlan = await planSpawn(WS, { repo: 'cargos-api', brief: BRIEF, task: FOUND_TASK, worker: 'naydennyy' });
const offPathBin = path.join(SB, 'off-path');
stubCommand(offPathBin, 'claude', `const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('2.1.237 (Claude Code)\\n'); process.exit(0); }
if (args[0] === 'agents') { process.stdout.write(${JSON.stringify(JSON.stringify([{ id: 'sess-0003', name: foundPlan.name, state: 'working', pid: 4244 }]))}); process.exit(0); }
process.stdout.write('backgrounded · sess-0003\\n');`);
const foundBin = path.join(offPathBin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
const foundNote = `claude не найден в PATH — взят из ${offPathBin}`;
const foundRun = spawnSync(process.execPath, ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(spawnUrl)});\n`
  + `await m.spawn(${JSON.stringify(WS)}, ${JSON.stringify({
    repo: 'cargos-api', brief: BRIEF, task: FOUND_TASK, worker: 'naydennyy',
    tool: { ok: true, bin: foundBin, note: foundNote },
  })});`,
], { encoding: 'utf8', env: { ...process.env, PATH: GITONLY } });
const foundText = `${foundRun.stdout}${foundRun.stderr}`;
check(`: бинаря нет в PATH — spawn поднимает worker'а абсолютным bin из HostToolBin`,
  foundRun.status === 0 && store.readTask(HOME, FOUND_TASK).participants.some((p) => store.addressOf(p) === 'worker:naydennyy'),
  `status=${foundRun.status} ${foundText}`);
check(': найденный бинарь назван в выводе вместе с каталогом',
  foundText.includes(offPathBin) && /не найден в PATH/.test(foundText), foundText);

const NONE_TASK = 'nekem-t20260827-160000';
store.createTask(HOME, {
  id: NONE_TASK, title: 'spawn без бинаря', slug: 'nekem', stamp: 't20260827-160000',
});
const noneReason = 'claude: не найден в PATH. Поставь: npm install -g @anthropic-ai/claude-code';
const noneRun = spawnSync(process.execPath, ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(spawnUrl)});\n`
  + `await m.spawn(${JSON.stringify(WS)}, ${JSON.stringify({
    repo: 'cargos-api', brief: BRIEF, task: NONE_TASK, worker: 'nekem',
    tool: { ok: false, reason: noneReason },
  })});`,
], { encoding: 'utf8', env: { ...process.env, PATH: GITONLY } });
const noneText = `${noneRun.stdout}${noneRun.stderr}`;
check(': бинаря нет — отказ идёт по HostToolBin.reason до записи на диск',
  noneRun.status === 1 && noneText.includes(noneReason),
  `status=${noneRun.status} ${noneText}`);
check(': отказ без бинаря на диске ничего не оставляет',
  !store.readTask(HOME, NONE_TASK).participants.some((p) => store.addressOf(p) === 'worker:nekem'),
  JSON.stringify(store.readTask(HOME, NONE_TASK).participants));
claudeSays([], 0);

// --- : участник пишется ДО запуска claude ------------------------------
//
// Ветка отказа запуска уносит процесс через fail() → process.exit(1), поэтому spawn
// исполняется отдельным процессом: иначе он унёс бы и сам тест. Смотрим потом на
// журнал — участник обязан быть на месте, хотя сессия не поднялась.
const FAIL_TASK = 'sboy-t20260827-130000';
store.createTask(HOME, {
  id: FAIL_TASK, title: 'spawn, который не поднялся', slug: 'sboy', stamp: 't20260827-130000',
});
claudeSays([], 3);
const failed = spawnSync(process.execPath, ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(spawnUrl)});\n`
  + `await m.spawn(${JSON.stringify(WS)}, ${JSON.stringify({ repo: 'cargos-api', brief: BRIEF, task: FAIL_TASK, worker: 'sboy' })});`,
], { encoding: 'utf8', env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}` } });
const failText = `${failed.stdout}${failed.stderr}`;
check(': spawn с неподнявшимся claude отказывает, а не молчит',
  failed.status === 1 && /claude --bg завершился с кодом 3/.test(failText), `status=${failed.status} ${failText}`);
const afterFail = store.participantOf(store.readTask(HOME, FAIL_TASK), 'worker:sboy')?.metadata;
check(': участник записан, хотя запуск claude провалился',
  !!afterFail && !!afterFail.worktreeName && !!afterFail.branch, JSON.stringify(afterFail));
check(': session у неподнявшегося не выдуман', !!afterFail && !afterFail.session, String(afterFail?.session));
check(': отказ называет маршрут — повтори ту же команду',
  /повтори spawn той же командой/.test(failText), failText);
// Ради чего всё: повтор той же команды больше не упирается в «имя совпало с чужим».
// Каталог worktree на диске остался, и без записи в журнале planSpawn отказал бы.
const failedWt = afterFail?.worktree;
check(`: каталог worktree от сорвавшегося spawn'а остался на диске`,
  !!failedWt && existsSync(failedWt), String(failedWt));
// Отказ здесь не падение теста, а найденная беда: без записи в журнале planSpawn
// бросает «имя совпало с чужим», и проверка обязана назвать это, а не унести процесс.
let retry = null;
let retryErr = '';
try {
  retry = await planSpawn(WS, { repo: 'cargos-api', brief: BRIEF, task: FAIL_TASK, worker: 'sboy', sessions: [] });
} catch (e) {
  retryErr = e.message;
}
check(': повтор узнаёт свой каталог, а не принимает его за чужой',
  !!retry && !!failedWt && retry.worktreePath === failedWt && retry.branch === afterFail.branch,
  retryErr || String(retry?.worktreePath));

// --- : в `--dry-run` версия не спрашивается ------------------------------
//
// Резолв бинаря запускает `<bin> --version` — процесс порядка двухсот миллисекунд, — а
// `--dry-run` не поднимает ничего: run из четырёх track'ов платил эту пробу четырежды за
// ответ, который ни на что не влияет. Проверяем не по выводу, а по следу: подставной
// `claude` пишет отметку на каждый свой запуск, и после вхолостую прогнанного spawn'а
// отметки быть не должно вовсе. Проверка по одной строке вывода прошла бы и на запущенной
// пробе — предмет здесь именно запуск процесса.
const PROBE_MARK = path.join(SB, 'probe-calls.log');
const DRY_TASK = 'suhoy-t20260828-160000';
store.createTask(HOME, {
  id: DRY_TASK, title: 'spawn вхолостую', slug: 'suhoy', stamp: 't20260828-160000',
});
const dryPlan = await planSpawn(WS, { repo: 'cargos-api', brief: BRIEF, task: DRY_TASK, worker: 'suhoy' });
const drySessions = JSON.stringify([{ id: 'sess-dry', name: dryPlan.name, state: 'working', pid: 4245 }]);
stubCommand(BIN, 'claude', `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(PROBE_MARK)}, args.join(' ') + '\\n');
if (args[0] === '--version') { process.stdout.write('2.1.237 (Claude Code)\\n'); process.exit(0); }
if (args[0] === 'agents') { process.stdout.write(${JSON.stringify(drySessions)}); process.exit(0); }
process.stdout.write('backgrounded · sess-dry\\n');`);
process.env.PATH = `${BIN}${path.delimiter}${PATH0}`;
const dryOut = await capture(() => spawnWorker(WS, {
  repo: 'cargos-api', brief: BRIEF, task: DRY_TASK, worker: 'suhoy', dryRun: true,
}));
check(': --dry-run не запускает бинарь вовсе — ни одной пробы версии',
  !existsSync(PROBE_MARK), existsSync(PROBE_MARK) ? readFileSync(PROBE_MARK, 'utf8') : '');
check(': молчание о версии названо вслух, а не оставлено догадкой',
  dryOut.includes('версия не проверялась: dry-run'), dryOut.split('\n').slice(-6).join(' | '));
// Команду из `--dry-run` человек копирует в терминал. В argv лежит имя сессии
// с пробелами и `·`, и склейка через пробел давала строку, распадавшуюся на десяток
// аргументов: скопированная, она не исполнялась вовсе. Печатается она ровно для копирования.
const dryCmd = dryOut.split('\n').find((l) => l.includes('&& claude ')) ?? '';
check(': имя сессии в команде --dry-run заквотировано целиком',
  dryCmd.includes(`'${dryPlan.name}'`), dryCmd);
// Проверка точная, а не «или так, или эдак»: в пути песочницы есть пробел, значит
// квотирование обязано сработать, и незаквотированный путь её не проходит.
check(': каталог в `cd` заквотирован — в пути песочницы есть пробел',
  dryPlan.cwd.includes(' ') && dryCmd.includes(`cd '${dryPlan.cwd}' && claude `), dryCmd);

// Dest HostToolBin does not probe `--version`. Real spawn still launches the
// bin (agents / --bg); the dry-run early return is what keeps PROBE_MARK empty
// until this call.
await quiet(() => spawnWorker(WS, { repo: 'cargos-api', brief: BRIEF, task: DRY_TASK, worker: 'suhoy' }));
const probeLog = existsSync(PROBE_MARK) ? readFileSync(PROBE_MARK, 'utf8') : '';
check(': dest host does not probe --version; real spawn still launches the bin',
  probeLog.length > 0 && !/--version/.test(probeLog),
  probeLog || 'отметки нет');

// --- : подъём worker'а и reviewer'а идёт одним хелпером ---------------------
//
// Сверка «сессия появилась в claude agents» живёт теперь в `promptobus/liftoff.js` и досталась
// обоим участникам. Прежде она была только у worker'а, а блок reviewer'а — построчной
// копией без неё. Здесь проверяется половина worker'а: `claude --bg` отчитывается
// успехом («backgrounded», код 0), а сессии в списке нет — тот самый молчаливый сбой
// демона, ради которого сверка и заведена. Отдельным процессом: отказ
// идёт через fail() → process.exit(1).
const SILENT_TASK = 'tihiy-t20260829-110000';
store.createTask(HOME, {
  id: SILENT_TASK, title: 'spawn с молчаливым сбоем демона', slug: 'tihiy', stamp: 't20260829-110000',
});
claudeSays([], 0);
const silent = spawnSync(process.execPath, ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(spawnUrl)});\n`
  + `await m.spawn(${JSON.stringify(WS)}, ${JSON.stringify({
    repo: 'cargos-api', brief: BRIEF, task: SILENT_TASK, worker: 'tihiy', awaitOptions: { tries: 2, delayMs: 1 },
  })});`,
], { encoding: 'utf8', env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}` } });
const silentText = `${silent.stdout}${silent.stderr}`;
check(`: сессии worker'а в claude agents нет — отказ, а не доклад об успехе`,
  silent.status === 1
  && /claude --bg отчитался успехом, но живой сессии .* нет — worker НЕ поднят/.test(silentText)
  && !/worker worker:tihiy поднят/.test(silentText), `status=${silent.status} ${silentText}`);
check(`: отказ по несостоявшейся сессии worker'а называет маршрут — повтори spawn`,
  /повтори spawn той же командой/.test(silentText)
  && /Сообщений от этого адреса не будет/.test(silentText), silentText);
check(`: запись worker'а на месте и после отказа — повтор сядет в свой каталог`,
  !!store.readTask(HOME, SILENT_TASK).participants.find((p) => store.addressOf(p) === 'worker:tihiy'),
  JSON.stringify(store.readTask(HOME, SILENT_TASK).participants));

// --- : повторный spawn на снятый адрес зовёт кусок по НОВОМУ брифу ----------
//
// Живой случай оркестратора: `spawn --worker store` в задаче, где адрес уже работал
// прежним track'ом и был снят с наблюдения на приёмке, поднял сессию «Worker: 
// Вынос store в package» под брифом про /448/449. Механически worker работал по
// новому брифу — врало только имя, а по имени человек в `claude agents` и оркестратор
// находят кусок работы. Проверяется вся тройка полей записи, заголовок задачи и то, что
// `--dry-run` обещает то же имя, которое получится живьём.
const TASK453 = 'povtor-t20260902-100000';
const TITLE_OLD = ' Вынос store в package';
const TITLE_NEW = '   Recover и стенд гонок';
// Dest `shortTitle` / brief heading trim collapse runs of space. Fixture bodies
// stay as transferred; checks compare the stored dest form.
const TITLE_NEW_STORED = 'Recover и стенд гонок';
store.createTask(HOME, { id: TASK453, title: TITLE_OLD, slug: 'povtor', stamp: 't20260902-100000' });
const BRIEF_OLD = path.join(SB, 'brief-406.md');
writeFileSync(BRIEF_OLD, `# ${TITLE_OLD}\n\nВынос шины во вложенный package.\n`);
const BRIEF_NEW = path.join(SB, 'brief-447.md');
writeFileSync(BRIEF_NEW, `# ${TITLE_NEW}\n\nRecover журнала и стенд гонок.\n`);

const optsOld453 = { repo: 'cargos-api', brief: BRIEF_OLD, task: TASK453, worker: 'store' };
const planOld453 = await planSpawn(WS, optsOld453);
claudeSays([{ id: 'sess-0406', name: planOld453.name, state: 'working', pid: 4406 }]);
resetCliCaches();
await quiet(() => spawnWorker(WS, optsOld453));
// Приёмка куска: сессию закрыли, адрес сняли с наблюдения. Список сессий пуст — сессия
// прежнего track'а мертва, и повторный spawn этим адресом законен.
store.dismissParticipant(HOME, TASK453, 'worker:store');
claudeSays([]);
resetCliCaches();

// `sessions: {}` — тот же шов, которым живут планы в promptobus.test.mjs: сессия прежнего
// track'а закрыта, и гейт «этот адрес уже работает» её видеть не должен. Без шва проверка
// зависела бы от того, НАСКОЛЬКО различаются имена: верни заголовок из старой записи, и
// имя совпало бы с именем подставной сессии — spawn отказал бы «участник жив», файл
// оборвался бы отказом вместо красной проверки, и мутационная проба ничего не назвала бы.
const optsNew453 = { repo: 'cargos-api', brief: BRIEF_NEW, task: TASK453, worker: 'store', sessions: {} };
const dry453 = await capture(() => spawnWorker(WS, { ...optsNew453, dryRun: true }));
resetCliCaches();
const planNew453 = await planSpawn(WS, optsNew453);
claudeSays([{ id: 'sess-0447', name: planNew453.name, state: 'working', pid: 4447 }]);
resetCliCaches();
await quiet(() => spawnWorker(WS, optsNew453));
const backRec = store.participantOf(store.readTask(HOME, TASK453), 'worker:store');
const back = backRec?.metadata;

check(': заголовок куска у поднятого заново — из нового брифа, а не из старой записи',
  back?.title === TITLE_NEW_STORED, `${back?.title} (в брифе «${TITLE_NEW}»)`);
check(': имя сессии собрано из нового заголовка, старого в нём нет',
  back?.name?.includes(TITLE_NEW_STORED) && !back?.name?.includes('Вынос store'), back?.name);
check(': sessionRef переписан вместе с именем — по нему участника ищут в claude agents',
  backRec?.sessionRef === back?.name && back?.name === planNew453.name,
  `${backRec?.sessionRef} · план обещал «${planNew453.name}»`);
check(`: заголовок задачи пересчитан по строкам участников и при повторном spawn'е`,
  store.readTask(HOME, TASK453).title === TITLE_NEW_STORED,
  store.readTask(HOME, TASK453).title);
// Обещание `--dry-run` и живой прогон обязаны совпасть: план печатается человеку до
// подъёма, и разойдись они — вхолостую проверялось бы не то, что поднимется.
check(': --dry-run печатает то же имя сессии и тот же будущий заголовок задачи',
  dry453.includes(`сессия: «${back?.name}»`) && dry453.includes(`будет переименована: ${TITLE_NEW_STORED}`),
  dry453.split('\n').filter((l) => /сессия|переименована/.test(l)).join(' | '));

// --- : идентичность шины в окружении САМОЙ сессии участника ----------------------
//
// Три переменные лежат и в `env` записи шины внутри `--mcp-config`, но достаются они
// процессу MCP-сервера. Stop-хук сторожа цикла харнес зовёт дочерним процессом СЕССИИ и
// читает её окружение — без этих трёх участник резолвился бы адресом `orchestrator`, его
// привязки не находилось, и сторож не держал бы ему ход ни разу.
//
// Проверяется ФАКТ, а не намерение: подставной бинарь пишет полученное окружение в файл, и
// сверка идёт по нему. `plan.env` рядом — это то, что уедет в `--dry-run` и в driver.
const TASK426 = 'storozh-t20260902-140000';
store.createTask(HOME, { id: TASK426, title: 'сторож участника', slug: 'storozh', stamp: 't20260902-140000' });
const ENV_MARK = path.join(SB, 'seen-env.json');
const opts426 = { repo: 'cargos-api', brief: BRIEF, task: TASK426, worker: 'storozh' };
const plan426 = await planSpawn(WS, opts426);
const sessions426 = JSON.stringify([{ id: 'sess-0426', name: plan426.name, state: 'working', pid: 4426 }]);
stubCommand(BIN, 'claude', `import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('2.1.251 (Claude Code)\\n'); process.exit(0); }
if (args[0] === 'agents') { process.stdout.write(${JSON.stringify(sessions426)}); process.exit(0); }
writeFileSync(${JSON.stringify(ENV_MARK)}, JSON.stringify({
  role: process.env.PROMPTOBUS_ROLE ?? null,
  task: process.env.PROMPTOBUS_TASK ?? null,
  home: process.env.PROMPTOBUS_HOME ?? null,
}));
process.stdout.write('backgrounded · sess-0426\\n');`);
process.env.PATH = `${BIN}${path.delimiter}${PATH0}`;
resetCliCaches();
await quiet(() => spawnWorker(WS, opts426));
const seenEnv = existsSync(ENV_MARK) ? JSON.parse(readFileSync(ENV_MARK, 'utf8')) : null;
check(': сессия участника поднята БЕЗ идентичности шины в окружении',
  seenEnv !== null && seenEnv.role === null && seenEnv.task === null && seenEnv.home === null,
  `${JSON.stringify(seenEnv)} · тройки в окружении сессии быть не должно`);
check(': того же нет и в плане — его печатает --dry-run и его отдаёт driver\'у',
  IDENTITY_VARS.every((name) => !(name in plan426.env)),
  JSON.stringify(Object.fromEntries(IDENTITY_VARS.map((n) => [n, plan426.env[n] ?? null]))));
check(': идентичность уехала в команду хука файла настроек, а не в окружение',
  JSON.parse(readFileSync(plan426.settingsPath, 'utf8'))
    .hooks?.[GUARD_HOOK_EVENT]?.[0]?.hooks?.[0]?.command
    ?.includes(` --role ${shellQuote(plan426.address)} --task ${shellQuote(TASK426)}`
      + ` --home ${shellQuote(HOME)}`) === true,
  readFileSync(plan426.settingsPath, 'utf8'));

// --- : spawn ставит зависимости по package-lock.json --------------------
//
// Три исхода на подставном `npm` в PATH — настоящий бинарь набор не зовёт. Lock в
// отдельном клоне: у cargos-api его нет, и прежние spawn'ы этого файла шаг не трогали.

const NPM_MARK = path.join(SB, 'npm-calls.log');
const npmSays = (status = 0, { stdout = '', stderr = '' } = {}) => {
  stubCommand(BIN, 'npm', `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(NPM_MARK)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
${stdout ? `process.stdout.write(${JSON.stringify(stdout)});` : ''}
${stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : ''}
process.exit(${status});`);
  process.env.PATH = `${BIN}${path.delimiter}${PATH0}`;
};
const npmCalls = () => (existsSync(NPM_MARK) ? readFileSync(NPM_MARK, 'utf8') : '')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const clearNpm = () => { if (existsSync(NPM_MARK)) rmSync(NPM_MARK); };

const NODE_REPO = path.join(WS, 'node-svc');
spawnSync('git', ['clone', '-q', ORIGIN, NODE_REPO], { encoding: 'utf8' });
writeFileSync(path.join(NODE_REPO, 'package.json'), `${JSON.stringify({ name: 'node-svc', private: true })}\n`);
writeFileSync(path.join(NODE_REPO, 'package-lock.json'), `${JSON.stringify({
  name: 'node-svc', lockfileVersion: 3, requires: true, packages: {},
})}\n`);
writeFileSync(path.join(NODE_REPO, '.gitignore'), 'node_modules\n');
g(NODE_REPO, 'add', '.');
g(NODE_REPO, 'commit', '-m', 'lock', '-q');

const BARE_REPO = path.join(WS, 'node-bare');
spawnSync('git', ['clone', '-q', ORIGIN, BARE_REPO], { encoding: 'utf8' });
writeFileSync(path.join(BARE_REPO, 'package.json'), `${JSON.stringify({ name: 'node-bare', private: true })}\n`);
writeFileSync(path.join(BARE_REPO, 'package-lock.json'), `${JSON.stringify({
  name: 'node-bare', lockfileVersion: 3, requires: true, packages: {},
})}\n`);
g(BARE_REPO, 'add', '.');
g(BARE_REPO, 'commit', '-m', 'lock без ignore', '-q');

const DEPS_TASK = 'deps-t20260903-180000';
store.createTask(HOME, {
  id: DEPS_TASK, title: 'зависимости worktree', slug: 'deps', stamp: 't20260903-180000',
});

clearNpm();
npmSays(0, { stdout: 'added 1 package in 12ms\n' });
const optsLock = { repo: 'node-svc', brief: BRIEF, task: DEPS_TASK, worker: 'withlock' };
const planLock = await planSpawn(WS, optsLock);
claudeSays([{ id: 'sess-lock', name: planLock.name, state: 'working', pid: 4501 }]);
resetCliCaches();
const lockOut = await capture(() => spawnWorker(WS, optsLock));
const lockCalls = npmCalls();
const lockLog = `${planLock.worktreePath}.npm-ci.log`;
const ciArgs = npmCiCommand().split(' ').slice(1).join(' ');
check(': в worktree с package-lock.json spawn зовёт команду установки',
  lockCalls.length === 1
  && lockCalls[0].cwd === planLock.worktreePath
  && lockCalls[0].args.join(' ') === ciArgs,
  JSON.stringify(lockCalls));
check(': успешная установка названа в выводе вместе с длительностью',
  /зависимости worktree поставлены \(npm ci, \d+\.\d+ с\)/.test(lockOut)
  && lockOut.includes(`ставлю зависимости по package-lock.json (${npmCiCommand()})`), lockOut);
check(': лог установки лежит рядом с каталогом и несёт вывод npm',
  existsSync(lockLog) && readFileSync(lockLog, 'utf8').includes('added 1 package'),
  existsSync(lockLog) ? readFileSync(lockLog, 'utf8') : `нет ${lockLog}`);

clearNpm();
npmSays(0);
const dryLock = await capture(() => spawnWorker(WS, { ...optsLock, worker: 'drylock', dryRun: true }));
check(': --dry-run печатает намерение установки и сам npm не зовёт',
  dryLock.includes(`зависимости worktree: ${npmCiCommand()}`)
  && npmCalls().length === 0, dryLock);

clearNpm();
npmSays(0);
const optsNoLock = { repo: 'cargos-api', brief: BRIEF, task: DEPS_TASK, worker: 'nolock' };
const planNoLock = await planSpawn(WS, optsNoLock);
claudeSays([{ id: 'sess-nolock', name: planNoLock.name, state: 'working', pid: 4502 }]);
resetCliCaches();
const noLockOut = await capture(() => spawnWorker(WS, optsNoLock));
check(': без package-lock.json npm не зовётся и строка установки не печатается',
  npmCalls().length === 0 && !/зависимости worktree/.test(noLockOut),
  `${JSON.stringify(npmCalls())} · ${noLockOut.split('\n').filter((l) => /зависимост|npm ci/.test(l)).join(' | ')}`);

clearNpm();
npmSays(7, { stderr: 'ERESOLVE unable to resolve dependency tree\n' });
const optsFail = { repo: 'node-svc', brief: BRIEF, task: DEPS_TASK, worker: 'faillock' };
const planFail = await planSpawn(WS, optsFail);
claudeSays([{ id: 'sess-fail', name: planFail.name, state: 'working', pid: 4503 }]);
resetCliCaches();
const failDepsOut = await capture(() => spawnWorker(WS, optsFail));
const failLog = `${planFail.worktreePath}.npm-ci.log`;
check(': отказ npm ci не срывает spawn — worker поднят, есть предупреждение с кодом и командой',
  failDepsOut.includes('зависимости worktree не поставлены')
  && failDepsOut.includes('завершился с кодом 7')
  && failDepsOut.includes('ERESOLVE unable to resolve')
  && failDepsOut.includes(`worker сделает сам: ${npmCiCommand()}`)
  && failDepsOut.includes(`лог ${failLog}`)
  && failDepsOut.includes(`ставлю зависимости по package-lock.json (${npmCiCommand()})`)
  && /worker worker:faillock поднят/.test(failDepsOut)
  && !!store.participantOf(store.readTask(HOME, DEPS_TASK), 'worker:faillock'),
  failDepsOut);
check(': лог отказа записан и назван в предупреждении',
  existsSync(failLog) && readFileSync(failLog, 'utf8').includes('ERESOLVE'),
  existsSync(failLog) ? readFileSync(failLog, 'utf8') : `нет ${failLog}`);

clearNpm();
process.env.PATH = `${BIN}${path.delimiter}${PATH0}`;
const emptyPath = path.join(SB, 'empty-path');
mkdirSync(emptyPath, { recursive: true });
const miss = installWorktreeDeps(planLock.worktreePath, { env: { ...process.env, PATH: emptyPath } });
check(': нет npm в PATH — why называет PATH, не код ENOENT',
  miss.ran === true && miss.ok === false && miss.why === 'npm не найден в PATH',
  JSON.stringify(miss));
const missSay = await capture(() => sayWorktreeDeps(miss));
check(': предупреждение называет «npm не найден в PATH» и команду',
  missSay.includes('npm не найден в PATH') && missSay.includes(`worker сделает сам: ${npmCiCommand()}`),
  missSay);

clearNpm();
npmSays(0);
const optsBare = { repo: 'node-bare', brief: BRIEF, task: DEPS_TASK, worker: 'barelock' };
const planBare = await planSpawn(WS, optsBare);
claudeSays([{ id: 'sess-bare', name: planBare.name, state: 'working', pid: 4505 }]);
resetCliCaches();
const bareOut = await capture(() => spawnWorker(WS, optsBare));
check(': node_modules вне ignore — предупреждение, spawn прошёл',
  bareOut.includes('node_modules в worktree git не игнорирует')
  && /worker worker:barelock поднят/.test(bareOut)
  && !lockOut.includes('node_modules в worktree git не игнорирует'),
  bareOut);

// HostToolBin: consumers read `bin`. A host that returns only the declared
// fields must still launch. A consumer that reads `path` again throws
// "file must be of type string" here — that is the mutation probe target.
const CONTRACT_TASK = 'bin-only-t20260904-000000';
store.createTask(HOME, {
  id: CONTRACT_TASK, title: 'host tool bin contract', slug: 'bin-only', stamp: 't20260904-000000',
});
const contractHost = hostOf(WS);
contractHost.resolveToolBin = () => ({ ok: true, bin: stubClaude() });
const contractOpts = { repo: 'cargos-api', brief: BRIEF, task: CONTRACT_TASK, worker: 'binonly' };
const contractPlan = await planSpawn(contractHost, contractOpts);
claudeSays([{ id: 'sess-bin', name: contractPlan.name, state: 'working', pid: 4600 }]);
resetCliCaches();
await quiet(() => spawnRaw(contractHost, contractOpts));
const contractRec = store.participantOf(store.readTask(HOME, CONTRACT_TASK), 'worker:binonly');
check('HostToolBin: resolveToolBin returning only `bin` launches the worker',
  contractRec?.metadata?.session === 'sess-bin', JSON.stringify(contractRec?.metadata));

process.env.PATH = PATH0;
rmSync(SB, { recursive: true, force: true });
