// Регресс на раннер цепочки (run.mjs). Запуск: npm test
//
// Предмет — решения раннера, а не содержание тестов:
//
//   • потолок на файл — один зависший файл прежде вешал `npm test` навсегда,
//     потому что раннер ждал ребёнка без срока;
//   • гейт автоподъёма надзирателя — команда шины не вправе завести процесс,
//     переживающий прогон, и след такого подъёма обязан красить прогон;
//   • дом файла набора — уведён в каталог прогона, и свой у каждого файла;
//   • пул, серийная группа и по-файловая буферизация вывода.
//
// Проверять это на настоящем раннере нельзя — он прогоняет весь набор, — поэтому берётся
// его копия в песочнице и подставные файлы теста рядом. Копия — тот же код, а не пересказ:
// под пробу потолка подменяется одно число, под пробу пула не подменяется ничего.
import {
  closeSync, copyFileSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeSandbox } from './sandbox.mjs';
import { check } from './check.mjs';

const SB = makeSandbox('promptobus-runner-');
const here = path.dirname(fileURLToPath(import.meta.url));

const src = readFileSync(path.join(here, 'run.mjs'), 'utf8');
const CAP_MS = 2000;
const copy = src.replace(/const FILE_TIMEOUT_MS = [\d_]+;/, `const FILE_TIMEOUT_MS = ${CAP_MS};`);
// Без этой проверки подмена, промахнувшаяся мимо константы, дала бы зелёное на настоящем
// потолке (`FILE_TIMEOUT_MS` в run.mjs) — то есть проверку, которая ничего не проверяет.
check('потолок в копии подменён — проверяем укороченный, а не настоящий',
  copy !== src && copy.includes(`const FILE_TIMEOUT_MS = ${CAP_MS};`));

// Копия раннера ставится в песочницу вместе с перечнем гигиены и уборкой `$TMPDIR`: раннер
// импортирует оба по относительному пути, и без соседних файлов копия
// падает на импорте — красное указывало бы на пробу, а не на её предмет. Кладёт их одна
// рука, чтобы забыть было нечего.
//
// У уборки свой транзитивный импорт — общий модуль порогов из соседнего каталога, которого в
// песочнице нет вовсе. Тащить за ним всё дерево незачем: в копии переписывается одна строка
// импорта на абсолютный путь к настоящему модулю. Промахнувшаяся подмена дала бы копию,
// падающую на импорте, поэтому её стережёт своя сверка — как подмену потолка выше.
const sweepSrc = readFileSync(path.join(here, 'tmpdir-sweep.mjs'), 'utf8');
const RUNS_MOD = "'../scripts/canary-runs.mjs'";
const sweepCopy = sweepSrc.replace(RUNS_MOD,
  JSON.stringify(pathToFileURL(path.join(here, '..', 'scripts', 'canary-runs.mjs')).href));
check(': импорт порогов в копии уборки переписан на настоящий модуль',
  sweepCopy !== sweepSrc && !sweepCopy.includes(RUNS_MOD));

function plant(dir, source) {
  writeFileSync(path.join(dir, 'run.mjs'), source);
  copyFileSync(path.join(here, 'hygiene.mjs'), path.join(dir, 'hygiene.mjs'));
  writeFileSync(path.join(dir, 'tmpdir-sweep.mjs'), sweepCopy);
}
plant(SB, copy);

// Висит ровно тем способом, ради которого потолок и заведён: не резолвящийся промис при
// живом событийном цикле. Один промис без таймера файл не вешает — Node замечает пустой
// цикл и выходит кодом 13 (эту ветку сторожит check.test.mjs); вешает его то, что цикл
// держит: открытый наблюдатель, читающийся stdin, неотвеченный подпроцесс. Таймер здесь
// и стоит за них.
writeFileSync(path.join(SB, 'a-visyachiy.test.mjs'),
  'setInterval(() => {}, 1000);\nawait new Promise(() => {});\n');
writeFileSync(path.join(SB, 'b-zhivoy.test.mjs'), "console.log('живой файл дошёл до конца');\n");

// Свой срок у пробы: сломанный потолок означает вечное ожидание, и без него красное
// выглядело бы как зависший набор — то есть как та самая беда, которую чиним.
//
// Не `spawnSync` с его `timeout` и не трубы: снятый по сроку раннер оставляет зависший
// файл жить (тот запущен своим процессом), а труба остаётся открытой в НЁМ — и
// `spawnSync` продолжает висеть на чтении уже мёртвого раннера. Замер мутационной пробы:
// шестидесятисекундный срок не сработал и за три минуты. Поэтому вывод идёт в файл,
// группа процессов у копии своя (`detached`), и по сроку снимается вся группа разом.
async function runCopy(dir, env = {}) {
  const log = path.join(dir, 'run.log');
  const fd = openSync(log, 'w');
  const child = spawn(process.execPath, [path.join(dir, 'run.mjs')],
    { stdio: ['ignore', fd, fd], detached: true, env: { ...process.env, ...env } });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* группа уже мертва */ }
      resolve(null);
    }, 60_000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  closeSync(fd);
  return { status: code, out: readFileSync(log, 'utf8') };
}

const { status, out: all } = await runCopy(SB);

check('зависший файл снят по потолку, а не ждётся вечно',
  status !== null, `раннер не вышел за 60 с · ${all.slice(-300)}`);
check('снятый файл назван и назван зависшим, а не «не запустился»',
  /a-visyachiy\.test\.mjs — упал \(не уложился в 2 с — снят как зависший\)/.test(all)
  && !/не запустился/.test(all), all.slice(-500));
check('прогон при этом красный — зависание не проходит за успех',
  status === 1 && /упало 1 из 2 файлов/.test(all), `status=${status} ${all.slice(-300)}`);
// Цепочка не обрывается на снятом файле: остальные обязаны прогнаться, иначе потолок
// прятал бы картину так же, как остановка на первом падении.
check('следующий файл цепочки всё равно прогнан',
  /живой файл дошёл до конца/.test(all), all.slice(-300));
// Отрицательный контроль гейта автоподъёма: следа никто не оставлял — гейт обязан молчать,
// иначе красное ниже доказывало бы только то, что он краснеет всегда.
check(': без следа автоподъёма гейт молчит',
  !/поднялись надзиратели/.test(all), all.slice(-300));

// --- гейт автоподъёма надзирателя -----------------------------------
//
// Настоящий подъём тут не нужен и вреден: он завёл бы отвязанный процесс, переживающий
// прогон, — ровно то, что правило запрещает. Проверяется решение раннера, а не поведение
// шины, поэтому подставной файл пишет след сам, тем же способом, что и точка подъёма:
// дописывает строку в файл из `PROMPTOBUS_WARDEN_TRACE`. Переменную ставит копия раннера, и
// указывает она в каталог прогона КОПИИ — след этой пробы в настоящий прогон не попадает.
const SB2 = makeSandbox('promptobus-runner-raised-');
plant(SB2, copy);
writeFileSync(path.join(SB2, 'a-podnyal.test.mjs'),
  "import { appendFileSync } from 'node:fs';\n"
  + "appendFileSync(process.env.PROMPTOBUS_WARDEN_TRACE, 'автоподъём надзирателя · задача проба · pid 4242\\n');\n"
  + "console.log('файл со следом дошёл до конца');\n");

// Дом файла набора уведён в каталог прогона. Спрашиваем его у подставного файла,
// а не у себя: свой дом этому файлу подменил тот же раннер, и сверка сама с собой прошла бы
// и без подмены. Файл проходит зелёным и счётчик упавших не трогает — проверки следа рядом
// от него не зависят.
//
// Тот же файл спрашивает и остальной перечень гигиены: выключатель надзирателя и
// contact point своей сессии. Спрашивать их без подготовки бессмысленно — на машине без
// живой сессии переменных нет и так, и проверка зеленела бы ни на чём. Поэтому копия
// раннера запускается с ними, выставленными намеренно: раннер обязан накрыть их своим
// перечнем, а не унаследовать.
writeFileSync(path.join(SB2, 'b-dom.test.mjs'),
  "import os from 'node:os';\n"
  + "console.log(`ДОМ: ${os.homedir()} :: ${process.env.USERPROFILE ?? ''} :: ${process.env.CLAUDE_CONFIG_DIR ?? '(снят)'}`);\n"
  + "console.log(`ГИГИЕНА: ${process.env.PROMPTOBUS_WARDEN} :: "
  + "${process.env.CLAUDE_CODE_MESSAGING_SOCKET ?? '(снят)'} :: "
  + "${process.env.CLAUDE_CODE_MESSAGING_TOKEN ?? '(снят)'} :: "
  + "${process.env.CONTEXT_STORE_STOP_GATE ?? '(снят)'} :: "
  + "${process.env.PROMPTOBUS_E2E_ROOT ?? '(снят)'} :: "
  + "${process.env.PROMPTOBUS_ROLE ?? '(снят)'} :: "
  + "${process.env.PROMPTOBUS_TASK ?? '(снят)'} :: "
  + "${process.env.PROMPTOBUS_HOME ?? '(снят)'}`);\n");

const raised = await runCopy(SB2, {
  PROMPTOBUS_WARDEN: 'on',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/poddelnyy-probe.sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'tok-probe',
  CONTEXT_STORE_STOP_GATE: '0',
  PROMPTOBUS_E2E_ROOT: '/net/takogo/kataloga',
  // Идентичность участника: под worker'ом и reviewer'ом механизма она стоит в
  // окружении сессии ещё до `npm test`, поэтому копия раннера запускается с ней выставленной
  // намеренно — на машине без такой сессии переменных нет и так, и проверка зеленела бы ни
  // на чём. Дом указывает в несуществующий каталог: не сними его раннер, прогон ушёл бы
  // искать журнал задачи туда, а на настоящей машине — в боевой журнал шины.
  PROMPTOBUS_ROLE: 'worker:proba',
  PROMPTOBUS_TASK: 'proba-t20260902-000000',
  PROMPTOBUS_HOME: '/net/takogo/doma/.promptobus',
  // Каталог конфига Claude Code: харнес кладёт его сессии worker'а, и оттуда разбор
  // стопа читал бы состояние живых сессий человека. Указывает в несуществующий каталог.
  CLAUDE_CONFIG_DIR: '/net/takogo/konfiga/.claude',
});
check(': след автоподъёма красит прогон, хотя файлы прошли',
  raised.status === 1 && /файл со следом дошёл до конца/.test(raised.out)
  && !/упало /.test(raised.out), `status=${raised.status} ${raised.out.slice(-400)}`);
check(': гейт называет число, саму строку следа и выключатель',
  /поднялись надзиратели \(1\)/.test(raised.out)
  && /pid 4242/.test(raised.out)
  && /PROMPTOBUS_WARDEN=off/.test(raised.out), raised.out.slice(-400));

// --- дом пользователя не достаётся файлу набора ----------------------
//
// Зелёный прогон переписывал человеку хуки памяти и `~/.claude/settings.json`: файл набора
// спавнит настоящий CLI, а `sync` в хвосте ставит хуки в дом. Настоящий дом виден отсюда как
// `os.userInfo().homedir` — эта запись приходит от системы, а не из окружения, поэтому
// подмена её не двигает и сверка остаётся честной.
const [homeSeen = '', profileSeen = '', cfgSeen = ''] = (raised.out.match(/ДОМ: (.+)/)?.[1] ?? '').split(' :: ');
check(': файл набора видит дом внутри каталога прогона, а не настоящий',
  /promptobus-test-run-[^\n]*[\\/]home-[^\n\\/]+$/.test(homeSeen)
  && homeSeen !== os.userInfo().homedir, `дом файла набора: ${homeSeen || '(не назван)'}`);
// Windows смотрит в USERPROFILE, POSIX — в HOME, и подмена одного из двух оставляла бы
// дыру на другой платформе целиком.
check(': USERPROFILE уведён туда же, куда HOME',
  profileSeen === homeSeen && profileSeen !== '', `USERPROFILE: ${profileSeen || '(пуст)'}`);
// Каталог конфига Claude Code — туда же, куда дом: разбор стопа участника читает из
// него `jobs/<id>/state.json`, и утёкшая переменная сессии worker'а увела бы его в состояние
// живых сессий человека. Копия раннера получила переменную с несуществующим путём.
check(': CLAUDE_CONFIG_DIR уведён в каталог прогона — разбор стопа не читает дом человека',
  homeSeen !== '' && cfgSeen === path.join(homeSeen, '.claude'),
  `CLAUDE_CONFIG_DIR=${cfgSeen || '(не назван)'} · дом ${homeSeen || '(не назван)'}`);

// --- перечень гигиены накладывается целиком ------------------
//
// Дом — только один пункт перечня, и проверка одного пункта молчала бы о снятом соседе.
// Копия раннера получила выключатель во включённом положении, подставную точку
// пробуждения и рычаг хука памяти — в том положении, в каком его ставит шина (`=0`):
// обязана накрыть все три.
const [
  wdnSeen = '', sockSeen = '', tokenSeen = '', csSeen = '', e2eSeen = '',
  roleSeen = '', taskSeen = '', busHomeSeen = '',
] = (raised.out.match(/ГИГИЕНА: (.+)/)?.[1] ?? '').split(' :: ');
check(': раннер гасит автоподъём надзирателя и снимает contact point сессии',
  wdnSeen === 'off' && sockSeen === '(снят)' && tokenSeen === '(снят)',
  `PROMPTOBUS_WARDEN=${wdnSeen || '(не назван)'} · сокет=${sockSeen} · токен=${tokenSeen}`);
check(': раннер снимает рычаг хука памяти',
  csSeen === '(снят)', `CONTEXT_STORE_STOP_GATE=${csSeen || '(не назван)'}`);
// Корень проверяемого механизма задаёт канарейка релиза, и только она. Оставшись
// в окружении после ручного прогона, он молча уводит весь набор на чужое дерево: сценарий
// резолвит от него и бинарь, и store, и driver.
check(': раннер снимает корень проверяемого механизма',
  e2eSeen === '(снят)', `PROMPTOBUS_E2E_ROOT=${e2eSeen || '(не назван)'}`);
// Идентичность участника — тот же класс, что рычаг памяти: её кладёт в окружение
// сессии сам spawn, и под worker'ом механизма она стоит там раньше `npm test`. Цена утечки
// выше, чем у соседей: `PROMPTOBUS_HOME` сильнее поиска дома от cwd, и файл набора, своего
// дома не объявляющий, ушёл бы работать в БОЕВОЙ журнал шины рабочего места. Проверяются все
// три: снятая пара без третьей оставила бы дыру ровно там, где она дороже всего.
check(': раннер снимает идентичность участника — роль, задачу и дом шины',
  roleSeen === '(снят)' && taskSeen === '(снят)' && busHomeSeen === '(снят)',
  `PROMPTOBUS_ROLE=${roleSeen || '(не назван)'} · PROMPTOBUS_TASK=${taskSeen || '(не назван)'}`
  + ` · PROMPTOBUS_HOME=${busHomeSeen || '(не назван)'}`);

// --- : пул, серийная группа и буферизация вывода ------------------------
//
// Три решения разом, и все три видны только снаружи: файлы пула идут одновременно,
// серийная группа идёт после пула и по одному, вывод каждого файла печатается целым куском.
// Копия здесь берётся неправленой — предмет как раз в настоящих `POOL` и `SERIAL`, и
// подменённые они проверяли бы подмену.
//
// Состав серийной группы вычитывается из исходника, а не повторяется здесь списком: копия
// перечня разошлась бы с раннером ровно так же, как разъехалась гигиена.
const SERIAL_NAMES = (() => {
  try { return JSON.parse((src.match(/const SERIAL = (\[[^\]]*\]);/)?.[1] ?? '').replace(/'/g, '"')); }
  catch { return null; }
})();
check(': серийная группа названа в раннере списком имён и он прочитан',
  Array.isArray(SERIAL_NAMES) && SERIAL_NAMES.length > 0, JSON.stringify(SERIAL_NAMES));
// Группа задана именами файлов, и переименованный файл тихо уехал бы в пул — под нагрузку,
// от которой его и уводили. Красное здесь дешевле плавающего теста через месяц.
const strayNames = (SERIAL_NAMES ?? []).filter((n) => !readdirSync(here).includes(n));
check(': каждый файл серийной группы лежит в каталоге набора',
  strayNames.length === 0, `нет в каталоге: ${strayNames.join(', ')}`);

const SB3 = makeSandbox('promptobus-runner-pool-');
plant(SB3, src);
const TIMES = path.join(SB3, 'times');
mkdirSync(TIMES);
// Подставной файл отмечает свои настоящие границы на диске и печатает три строки с паузами.
// Паузы нужны вердикту буферизации: без них строки соседей не успели бы вклиниться в чужой
// вывод — слитный вывод доказывал бы только то, что печатать было нечего. Одновременность
// пула по этим штампам не судим: Date.now() в ребёнке меряет, когда он получил CPU.
const probe = (name) => writeFileSync(path.join(SB3, name),
  "import { writeFileSync } from 'node:fs';\n"
  + 'const start = Date.now();\n'
  + 'const pause = () => new Promise((r) => { setTimeout(r, 120); });\n'
  + `for (let i = 1; i <= 3; i += 1) { console.log('${name} ' + i); await pause(); }\n`
  + `writeFileSync(${JSON.stringify(path.join(TIMES, `${name}.json`))}, `
  + 'JSON.stringify({ start, end: Date.now() }));\n');

// Ширина пула считается той же формулой, что в раннере. Подставных файлов ровно столько,
// сколько полос, но не больше трёх: проба требует, чтобы ВСЕ они были живы одновременно, и
// четыре файла на двух полосах красили бы исправный раннер. Потолок в три — цена пробы:
// больше файлов ту же параллельность не доказывают.
const POOL_HERE = Math.max(1, Math.min(6, os.cpus().length - 2));
const POOLED = ['p-1.test.mjs', 'p-2.test.mjs', 'p-3.test.mjs'].slice(0, Math.min(3, POOL_HERE));
for (const name of [...POOLED, ...(SERIAL_NAMES ?? [])]) probe(name);
const pooled = await runCopy(SB3);
const peakLive = Number(pooled.out.match(/пик пула: (\d+)/)?.[1]);
check(': проба пула прошла целиком — есть о чём судить',
  pooled.status === 0 && Number.isInteger(peakLive),
  `status=${pooled.status} пик=${peakLive} ${pooled.out.slice(-400)}`);

// Отметка читается мягко: файла может не быть вовсе — раннер не запустил подставной файл,
// тот упал раньше записи. Исключение отсюда унесло бы весь файл теста, и красное пришло бы
// обрывом без вердикта, то есть без имени того, что сломалось.
const at = (name) => {
  try { return JSON.parse(readFileSync(path.join(TIMES, `${name}.json`), 'utf8')); }
  catch { return null; }
};
const poolTimes = POOLED.map(at);
const serialTimes = (SERIAL_NAMES ?? []).map(at);
const noMark = [...POOLED, ...(SERIAL_NAMES ?? [])].filter((name) => at(name) === null);
check(': каждый подставной файл отметил свои границы — есть по чему судить',
  noMark.length === 0, `без отметки: ${noMark.join(', ') || '—'}`);

// Машину с одной полосой проба называет прямо, а не молчит о том, что ничего не проверила.
check(': пул этой машины шире одной полосы — параллельность есть чем мерить',
  POOL_HERE >= 2, `${os.cpus().length} ядер — пул в ${POOL_HERE} полосу`);
const starts = (list) => list.filter(Boolean).map((t) => t.start);
const ends = (list) => list.filter(Boolean).map((t) => t.end);
// Пик — сколько детей раннер держал в `live` сразу после spawn, не пересечение
// настенных окон. Окна краснеют, когда планировщик развёл детей, а полосы при
// этом открыты все: счётчик о соседях по машине не знает.
check(': файлы пула идут одновременно, а не по очереди',
  peakLive === POOLED.length,
  `пик ${peakLive} при ${POOLED.length} файлах на ${POOL_HERE} полосах: ${JSON.stringify(poolTimes)}`);

const lastPool = Math.max(...ends(poolTimes), 0);
// Пустой список меток печатается словом, а не нулём: `Math.min()` без аргументов отдаёт
// бесконечность, а с добавленным нулём — ноль, и деталь красного врала бы о времени старта.
const bound = (pick, list) => (list.length ? pick(...list) : '(нет отметок)');
check(': серийная группа стартует после последнего файла пула',
  poolTimes.every(Boolean) && serialTimes.every(Boolean)
  && Math.min(...starts(serialTimes)) >= lastPool,
  `пул кончился ${bound(Math.max, ends(poolTimes))}, `
  + `группа началась ${bound(Math.min, starts(serialTimes))}`);
check(': внутри серийной группы файлы не перекрываются — соседей у них нет',
  serialTimes.every(Boolean) && [...serialTimes].sort((a, b) => a.start - b.start)
    .every((t, i, all) => i === 0 || t.start >= all[i - 1].end),
  JSON.stringify(serialTimes));

// Буферизация: строки файла обязаны лежать подряд. Считаем не порядок файлов, а число
// блоков — вывод, разорванный соседом, даёт второй блок с тем же именем.
const marks = pooled.out.split('\n')
  .map((l) => l.match(/^(\S+\.test\.mjs) [123]$/)?.[1]).filter(Boolean);
const blocks = marks.filter((name, i) => i === 0 || marks[i - 1] !== name);
check(': строки файла напечатаны подряд — вывод буферизован по-файлово',
  marks.length === 3 * (POOLED.length + (SERIAL_NAMES ?? []).length)
  && blocks.length === new Set(blocks).size, `${marks.length} строк · ${blocks.join(',')}`);

// --- : код выхода не обрубает буфер --------------------------------------
//
// Вывод файлов идёт через `process.stdout.write`, а на macOS запись в трубу асинхронна:
// `process.exit()` в хвосте раннера уносит процесс раньше, чем труба разберётся, и хвост
// последних напечатанных буферов пропадает — ровно то, ради чего буферы и заведены. Замер
// пробы: подставной файл печатает четыре тысячи строк и краснеет; через `process.exit(1)`
// до читателя доезжает 1586 строк из 4000, через `process.exitCode` — все четыре тысячи, и
// так три раза из трёх.
//
// Труба здесь безопасна, в отличие от `runCopy`: зависших файлов в этой песочнице нет, и
// держать её открытой после смерти раннера некому.
//
// Проба платформенная по предмету. Node пишет в трубу асинхронно на macOS и Windows и
// синхронно на Linux — там обрыва не бывает вовсе, и проба работает отрицательным контролем:
// зелёная она и на исправном коде, и на `process.exit`. Красной её делает только та машина,
// где беда и водится, и это законно — гейт держится на разработчиках под macOS.
const SB4 = makeSandbox('promptobus-runner-pipe-');
plant(SB4, src);
const LINES = 4000;
writeFileSync(path.join(SB4, 'a-mnogo.test.mjs'),
  `for (let i = 0; i < ${LINES}; i += 1) console.log('строка вывода номер ' + i);\n`
  + 'process.exit(1);\n');
// Свой срок, по тому же доводу, что у `runCopy`: проба запускает раннер, а
// зависший раннер без потолка вешает весь файл набора — и красное выглядело бы как
// зависание, то есть как беда, которую чинили.
const piped = spawnSync(process.execPath, [path.join(SB4, 'run.mjs')],
  { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
const arrived = (piped.stdout ?? '').split('\n')
  .filter((l) => l.startsWith('строка вывода номер ')).length;
check(': красный прогон дописывает буфер в трубу, а не обрывает его на выходе',
  arrived === LINES && piped.status === 1,
  `доехало ${arrived} строк из ${LINES}, код ${piped.status}`);
