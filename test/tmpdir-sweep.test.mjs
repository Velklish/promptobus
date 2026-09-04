// Следы прогонов механизма в `$TMPDIR`. Запуск: npm test
//
// Предмета два, и оба — накопление каталогов в общем `$TMPDIR`. Гейты релиза
// ([release-gates.mjs](../scripts/release-gates.mjs)) оставляют каталог прогона с отчётом;
// набор оставляет песочницу оборванного прогона — Ctrl-C, снятие по потолку, падение
// процесса до хука выхода не доходят. Лечит оба одна уборка `sweepPreviousRuns`
// ([canary-runs.mjs](../scripts/canary-runs.mjs)) со своим префиксом и своим
// `keep`: у гейтов три последних каталога остаются (отчёт читают после прогона), у набора не
// остаётся ничего, кроме молодого, — читать в песочнице нечего.
//
// Проверяется на песочнице, а не на настоящем `$TMPDIR`: уборка сносит каталоги, и чужой
// прогон на той же машине набор трогать не вправе. Времена подкладываются `utimesSync` и
// считаются ОТ `Date.now()` — у уборки возрастная отсечка, и календарные литералы делали бы
// вердикты зависимыми от дня прогона.
//
// Самого `release-gates.mjs` файл не запускает и не импортирует: тот исполняется целиком уже
// при импорте — требует чистого дерева, пакует tarball и ставит его. Поэтому вызов уборки в
// нём сверяется по исходнику: без такой сверки снятый вызов не покрасил бы ничего.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import { SOCK_PREFIXES } from './sock-prefixes.mjs';
import { SUITE_PREFIXES, sweepTestSandboxes } from './tmpdir-sweep.mjs';
import { KEEP_RUNS, sweepPreviousRuns, sweptLine } from '../scripts/canary-runs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.now();

// Непустой каталог с файлом внутри: уборка сносит его целиком, и непустой каталог — то, что
// она встречает на самом деле.
function plant(dir, name, ageMs) {
  const box = path.join(dir, name);
  mkdirSync(box, { recursive: true });
  writeFileSync(path.join(box, 'run.md'), `# ${name}\n`);
  const at = new Date(NOW - ageMs);
  utimesSync(box, at, at);
  return box;
}
const listOf = (dir) => readdirSync(dir).sort();

// ── Гейты релиза: свой префикс, пороги канарейки ──────────────────────────────────────
//
// Все подложенные каталоги старше возрастной отсечки, поэтому судит их только «три самых
// свежих». Ожидания заданы перечнем имён, а НЕ выводом из `KEEP_RUNS`: проверка, считающая
// ожидаемое из того же числа, которое проверяет, проходит при любом его значении.
const GATES_PREFIX = 'promptobus-release-gates-';
const TMP = makeSandbox('promptobus-sweep-tmp-');
for (const [name, age] of [['keep-2h', 2 * HOUR], ['keep-3h', 3 * HOUR], ['keep-4h', 4 * HOUR],
  ['gone-5h', 5 * HOUR], ['gone-3d', 3 * DAY]]) plant(TMP, `${GATES_PREFIX}${name}`, age);
// Каталог текущего прогона гейтов: по mtime он самый свежий, но уборка не считает его вовсе.
const CURRENT = plant(TMP, `${GATES_PREFIX}current`, 0);
// Каталог канарейки в том же `$TMPDIR`: другой префикс — уборке гейтов не его дело.
const CANARY = plant(TMP, 'promptobus-canary-abc123', 3 * DAY);

const sweptGates = sweepPreviousRuns(TMP, { prefix: GATES_PREFIX, current: CURRENT });

check(`: уборка гейтов оставляет ${KEEP_RUNS} самых свежих каталога прогона и свой текущий`,
  listOf(TMP).join(',') === ['promptobus-canary-abc123', `${GATES_PREFIX}current`,
    `${GATES_PREFIX}keep-2h`, `${GATES_PREFIX}keep-3h`, `${GATES_PREFIX}keep-4h`].join(','),
  `осталось: ${listOf(TMP).join(', ')}`);

check(': снесены самые старые каталоги гейтов, и снесённое отдано перечнем',
  sweptGates.join(',') === [`${GATES_PREFIX}gone-5h`, `${GATES_PREFIX}gone-3d`].join(','),
  `снесено: ${sweptGates.join(', ') || 'ничего'}`);

check(': каталог текущего прогона гейтов уборка не трогает',
  existsSync(CURRENT) && !sweptGates.includes(path.basename(CURRENT)), CURRENT);

check(': каталог канарейки уборка гейтов не трогает',
  existsSync(CANARY) && !sweptGates.includes(path.basename(CANARY)), CANARY);

// Вызов уборки в самом скрипте — по исходнику: импортировать его нельзя, а без этой сверки
// снятый вызов не покрасил бы ни одной проверки. Здесь же сверяется, что префикс у
// `mkdtempSync` и у уборки ОДИН: разъехавшись, они дали бы скрипту метущий чужое или
// не метущий вовсе прогон.
const gatesFile = path.join(here, '..', 'scripts', 'release-gates.mjs');
const gatesPresent = existsSync(gatesFile);
const gatesSrc = gatesPresent ? readFileSync(gatesFile, 'utf8') : '';
if (gatesPresent) {
  const literals = gatesSrc.split(`'${GATES_PREFIX}'`).length - 1;
  check(': release-gates метёт прежние каталоги, и префикс у него один дом',
    /const RUN_PREFIX = 'promptobus-release-gates-';/.test(gatesSrc)
    && /mkdtempSync\(path\.join\(os\.tmpdir\(\), RUN_PREFIX\)\)/.test(gatesSrc)
    && /sweepPreviousRuns\(os\.tmpdir\(\), \{ prefix: RUN_PREFIX[^)]*\)/.test(gatesSrc)
    && literals === 1,
    `литералов префикса: ${literals} · уборка: ${/sweepPreviousRuns/.test(gatesSrc)}`);
} else {
  check(': release-gates.mjs is not in this repository — suite sweep is owned by run.mjs',
    /sweepTestSandboxes\(os\.tmpdir\(\)/.test(readFileSync(path.join(here, 'run.mjs'), 'utf8')));
}

// Строка итога у всех вызывающих одна, и пустой её случай обязан назвать ОБА порога: у гейтов
// сносить бывает нечего и по счёту, и по возрасту, а «сверх трёх оставленных не нашлось»
// говорит только про счёт — то есть врёт ровно в половине случаев. Пороги в вердикте заданы
// числами, а не выводом из констант: иначе он прошёл бы при любом их значении.
check(': пустой итог уборки называет оба порога, а при keep = 0 — только возраст',
  /сносить нечего: всё в пределах 3 оставленных или моложе 60 минут/.test(sweptLine('к', [], { keep: 3 }))
  && /сносить нечего: всё моложе 60 минут/.test(sweptLine('п', [], { keep: 0 }))
  && !/оставленных/.test(sweptLine('п', [], { keep: 0 })),
  `${sweptLine('к', [], { keep: 3 })} · ${sweptLine('п', [], { keep: 0 })}`);

// ── Песочницы набора: сносится всё своё старше отсечки ────────────────────────────────
//
// `keep = 0` снимает защиту счётом: свежую песочницу держит ТОЛЬКО возрастная отсечка.
// Поэтому в сцене есть и молодые каталоги, и старые, и чужие: без молодых зелёным был бы
// снос всего подряд, без старых — уборка, не снёсшая вообще ничего.
const BOXES = makeSandbox('promptobus-sweep-tmp-');
const OLD = ['promptobus-sync-old', 'promptobus-promptobus spawn-old', 'promptobus-bushook-old',
  'promptobus-cursor-wake-old', 'promptobus-test-run-old',
  // Песочница набора вложенного package: ручной `npm test --prefix` льёт её в тот же
  // системный `$TMPDIR`, и метётся она наравне со своими (слита в ).
  'promptobus-store-old'];
for (const name of OLD) plant(BOXES, name, 3 * DAY);
// Молодые: своя песочница идущего рядом файла и каталог прогона параллельного `npm test`.
const FRESH = ['promptobus-sync-fresh', 'promptobus-test-run-fresh'];
for (const name of FRESH) plant(BOXES, name, 5 * MIN);
// Чужие: живые прогоны, гейты релиза, канарейка и боевой код CLI. Все старые — то есть
// снеслись бы, будь дело в возрасте, а не в префиксе.
const FOREIGN = ['promptobus-canary-old', 'promptobus-release-gates-old', 'promptobus-live-e2e-old',
  'promptobus-live-cursor-logs-42', 'agents-review-old'];
for (const name of FOREIGN) plant(BOXES, name, 3 * DAY);
// Каталог ЭТОГО прогона: стар по mtime, но его завёл сам раннер — уборка его не считает.
const RUN_TMP = plant(BOXES, 'promptobus-test-run-current', 3 * DAY);

const swept = sweepTestSandboxes(BOXES, { current: RUN_TMP });

check(': песочницы набора старше отсечки снесены — все свои префиксы, включая пробел в имени',
  swept.join(',') === [...OLD].sort().join(','),
  `снесено: ${swept.join(', ') || 'ничего'}`);

check(': свежая песочница не сносится — её держит возрастная отсечка, а не счёт',
  FRESH.every((n) => existsSync(path.join(BOXES, n))),
  `осталось: ${listOf(BOXES).join(', ')}`);

check(': каталоги чужих префиксов уборка набора не трогает',
  FOREIGN.every((n) => existsSync(path.join(BOXES, n))),
  `снесено: ${swept.join(', ') || 'ничего'}`);

check(': каталог текущего прогона не сносится, хотя стар',
  existsSync(RUN_TMP) && !swept.includes(path.basename(RUN_TMP)), RUN_TMP);

// Второй проход по тому же каталогу: сносить больше нечего, и уборка это говорит пустым
// перечнем, а не сносом остатка.
check(': второй проход сносить нечего — остаток не трогается',
  sweepTestSandboxes(BOXES, { current: RUN_TMP }).length === 0
  && listOf(BOXES).length === FRESH.length + FOREIGN.length + 1,
  listOf(BOXES).join(', '));

// Вызов уборки в раннере — по исходнику, тем же приёмом и по той же причине, что у гейтов
// выше: импортировать [run.mjs](run.mjs) нельзя, он прогоняет весь набор. Без сверки снятый
// вызов не покрасил бы ничего — саму уборку проверяют сцены на песочницах, а зовут её из
// одного места, и место это здесь единственное покрытие.
const runSrc = readFileSync(path.join(here, 'run.mjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
check(': раннер зовёт уборку при старте и отдаёт ей каталог своего прогона',
  /sweepTestSandboxes\(os\.tmpdir\(\), \{ current: RUN_TMP[^)]*\)/.test(runSrc),
  `импорт: ${/from '.\/tmpdir-sweep.mjs'/.test(runSrc)} · вызов: ${/sweepTestSandboxes\(/.test(runSrc)}`);

// ── Отказ сноса набор не роняет ───────────────────────────────────────────────────────
//
// Каталог занят или прав на него нет — уборка тут гигиена, а не гейт, и прогон из-за неё
// краснеть не вправе. Сцена смешанная: рядом с неподатливым каталогом лежит обычный, и
// вердикт требует, чтобы снесённый был НАЗВАН. Охрана на весь обход стирала бы это имя —
// раннер печатал бы «снесено: 0» на прогоне, где снос был.
//
// Неподатливость подкладывается правами ВНУТРЕННЕГО каталога, а не родителя: `rmSync` идёт
// вглубь и спотыкается на файле внутри закрытого каталога, а соседний каталог того же
// `$TMPDIR` сносится как ни в чём не бывало.
//
// Оба каталога сцены — ОДНОГО префикса, и сносимый идёт первым (он моложе, а обход идёт от
// свежего к старому). Разные префиксы уходят в разные вызовы уборки, и охрана на весь вызов
// прошла бы такую сцену незамеченной — а ловится здесь ровно она.
//
// Охрана двойная. На Windows такой формы прав нет вовсе. Под root биты прав не значат ничего
// — `rmSync` снесёт и закрытое, — и вердикт «уборка не бросила» зеленел бы ни на чём;
// официальный образ node в CI идёт как раз от root.
if (process.platform !== 'win32' && process.getuid?.() !== 0) {
  const LOCKED = makeSandbox('promptobus-sweep-tmp-');
  const stuck = plant(LOCKED, 'promptobus-sync-locked', 3 * DAY);
  const lock = path.join(stuck, 'lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(path.join(lock, 'held'), 'занято\n');
  chmodSync(lock, 0o555);
  // Время каталога ставится ПОСЛЕ того, как в него положили содержимое: mtime каталога растёт
  // на каждую запись внутрь, и подложенный возраст без этого сбрасывался бы в «только что» —
  // возрастная отсечка тогда сама защитила бы каталог, и сцена проверяла бы не отказ сноса.
  const aged = new Date(NOW - 3 * DAY);
  utimesSync(stuck, aged, aged);
  const doomed = plant(LOCKED, 'promptobus-sync-doomed', 2 * DAY);

  let threw = null;
  let sweptLocked = [];
  const refused = [];
  try { sweptLocked = sweepTestSandboxes(LOCKED, { refused }); } catch (e) { threw = e; }
  chmodSync(lock, 0o755);

  check(': отказ сноса уборка проглатывает — набор от него не падает',
    threw === null, `брошено: ${threw?.message ?? '—'}`);

  check(': отказ не уносит имя снесённого соседа — перечень называет его',
    sweptLocked.join(',') === 'promptobus-sync-doomed' && !existsSync(doomed),
    `снесено: ${sweptLocked.join(', ') || 'ничего'}`);

  check(': не поддавшийся каталог назван отдельным перечнем и остался на месте',
    refused.join(',') === 'promptobus-sync-locked' && existsSync(stuck),
    `отказано: ${refused.join(', ') || 'ничего'} · ${existsSync(stuck)}`);
}

// ── Сторож перечня префиксов ──────────────────────────────────────────────────────────
//
// Перечень собран руками грепом по каталогу, и новый префикс утекал бы мимо уборки молча.
// Сторож повторяет тот же греп: каждый литерал `makeSandbox('…')` и
// `mkdtempSync(path.join(os.tmpdir(), '…'))` в `cli/test/` обязан покрываться перечнем. Так
// же [runner.test.mjs](runner.test.mjs) сверяет с каталогом состав `SERIAL`.
//
// Нелитеральные аргументы (переменная `prefix` в самом [sandbox.mjs](sandbox.mjs)) греп не
// берёт по построению — искать нечего. `makeSockDir` живёт под `/tmp` мимо `os.tmpdir()`
// и в предмет ЭТОЙ уборки не входит: его префиксы сторожит секция  ниже.
const declared = [];
const SCAN = [here];
for (const dir of SCAN) {
  for (const file of readdirSync(dir).filter((n) => n.endsWith('.mjs'))) {
    // Строки-комментарии срезаются: прозой те же вызовы цитируют и этот файл, и сам
    // [tmpdir-sweep.mjs](tmpdir-sweep.mjs), а цитата песочницы не заводит.
    const src = readFileSync(path.join(dir, file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    // Кавычка любая из трёх и закрывается собой же (обратная ссылка): литерал, переведённый
    // в backtick'и, иначе проехал бы мимо сторожа молча — а переводят их в этом репозитории
    // пакетно, целыми волнами.
    for (const m of src.matchAll(/makeSandbox\(\s*(['"`])([^'"`]+)\1/g)) declared.push([file, m[2]]);
    for (const m of src.matchAll(/mkdtempSync\(path\.join\(os\.tmpdir\(\),\s*(['"`])([^'"`]+)\1/g)) {
      declared.push([file, m[2]]);
    }
  }
}
const uncovered = declared.filter(([, pre]) => !SUITE_PREFIXES.some((known) => pre.startsWith(known)));

check(': перечень префиксов уборки покрывает все песочницы набора',
  declared.length > 0 && uncovered.length === 0,
  `найдено литералов: ${declared.length} · не покрыты: `
  + `${uncovered.map(([f, p]) => `${p} (${f})`).join(', ') || '—'}`);

// ── Сторож сокетных префиксов гейта релиза ────────────────────────────
//
// Вердикт «за прогоном не осталось сокетов» смотрит `/tmp` по SOCK_PREFIXES. Перечень
// собран руками, и новый префикс утекал бы мимо вердикта молча — живой случай: `ags-`
// в promptobus-guard.test.mjs в литерале гейта не входил. Сторож тот же, что у
// SUITE_PREFIXES выше: каждый литерал `makeSockPath('…')` / `makeSockDir('…')` обязан
// покрываться перечнем. Нелитеральный `prefix` в sandbox.mjs греп не берёт — заводит
// каталог вызывающий.
//
// Сканируются и `cli/scripts/`: живой прогон кладёт сокет через `makeSockDir`, не через
// набор. Сам release-gates.mjs импортировать нельзя — исполняется при импорте, — поэтому
// вызов сверяется по исходнику, как уборка каталога прогона выше.
const sockDeclared = [];
const SOCK_SCAN = [here, path.join(here, '..', 'scripts')];
for (const dir of SOCK_SCAN) {
  for (const file of readdirSync(dir).filter((n) => n.endsWith('.mjs'))) {
    const src = readFileSync(path.join(dir, file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/makeSock(?:Path|Dir)\(\s*(['"`])([^'"`]+)\1/g)) {
      sockDeclared.push([file, m[2]]);
    }
  }
}
const sockUncovered = sockDeclared.filter(([, pre]) => !SOCK_PREFIXES.some((known) => pre.startsWith(known)));

check(': перечень сокетных префиксов покрывает все makeSockPath/makeSockDir',
  sockDeclared.length > 0 && sockUncovered.length === 0,
  `найдено литералов: ${sockDeclared.length} · не покрыты: `
  + `${sockUncovered.map(([f, p]) => `${p} (${f})`).join(', ') || '—'}`);

if (gatesPresent) {
  check(': release-gates смотрит сокеты по SOCK_PREFIXES, а не по литералу',
    /from '\.\.\/test\/sock-prefixes\.mjs'/.test(gatesSrc)
    && /younger\('\/tmp',\s*SOCK_PREFIXES\)/.test(gatesSrc),
    `импорт: ${/sock-prefixes/.test(gatesSrc)} · younger: ${/younger\('\/tmp'/.test(gatesSrc)}`);
}
