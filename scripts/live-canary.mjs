#!/usr/bin/env node
// Живая канарейка релиза. Запуск из корня репозитория механизма:
//
//   node scripts/live-canary.mjs
//
// Гейты релиза ([release-gates.mjs](release-gates.mjs)) доказывают, что tarball собран и
// содержит то, что обещано. Канарейка доказывает следующее: собранный пакет РАБОТАЕТ — в
// отдельном чистом рабочем месте, на настоящем Claude, полным кругом оркестрации.
//
// Что здесь делается и чего здесь НЕ делается. Круг шины целиком лежит в сценарии
// ([scenario.mjs](../test/scenario.mjs)) — одном на подставной и живой harness'ы, и правка
// проверки едет в оба прогона сразу. Этот скрипт готовит и убирает мир вокруг сценария:
// временное рабочее место, установку пакета, `sync` и `doctor` из него, запуск живого
// прогона проверяемым деревом и доказательство уборки. Ни одной сверки шины он не делает.
//
// **Базу рабочее место получает клоном ЭТОЙ ветки по локальному пути.** Не из GitLab: база
// и CLI обязаны быть одной версией (гейт равенства в [base.js](../lib/base.js)), а версия
// проверяемого коммита в реестре ещё не лежит. Клон локальный — канарейка идёт без сети.
//
// **Дом человека канарейка не трогает вовсе, и это её предмет, а не её вежливость**
//. `sync` зовётся режимом `--no-global`: регистрация плагина у Claude Code, хуки
// памяти в доме и глобальная установка `ast-grep` пропускаются. Раньше здесь стояло обратное
// — прогон писал, а потом убирал за собой, — и цена была двойная: предусловие, вправе
// остановить канарейку на разошедшихся хуках, и уборка, которой можно не успеть (исключение
// или Ctrl-C между `sync` и концом круга оставляли запись у человека навсегда). Теперь
// доказывается не уборка, а нетронутость: снимок дома до `sync` и сверка с ним дважды —
// сразу после `sync` и в самом конце, за весь прогон. Разошлось — красный вердикт с
// перечнем и командой снятия: убирать за режимом руками значило бы прятать его поломку.
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { run } from '../lib/exec.js';
import { dropSessionLeaks, SESSION_LEAK_VARS } from '../test/hygiene.mjs';
import { writeHostConfig, resolveToolBin } from '../test/sandbox.mjs';
import { CANARY_PREFIX, sweepPreviousRuns, sweptLine } from './canary-runs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..');
const REPO = CLI;
const LIVE_E2E = path.join(here, 'live-e2e.mjs');
// Всё, что `sync` пишет за пределы каталога workspace тремя своими дверями: глобальное
// состояние Claude Code, дом хуков памяти и личные настройки Claude Code. Режим
// `--no-global` не трогает ни одного из этих путей, и снимок по ним — предмет проверки.
const CLAUDE_PLUGINS = path.join(os.homedir(), '.claude', 'plugins');
const KNOWN_MARKETPLACES = path.join(CLAUDE_PLUGINS, 'known_marketplaces.json');
const INSTALLED_PLUGINS = path.join(CLAUDE_PLUGINS, 'installed_plugins.json');
const PLUGIN_CACHE = path.join(CLAUDE_PLUGINS, 'cache');
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

// Id задачи, которую заводит сценарий: по нему опознаются его сессии в общем реестре
// harness'а. Подстрока «e2e» цепляла бы посторонние сессии человека, гоняющего релиз.
const E2E_TASK = 'e2ebus';
// Что не имеет права пережить прогон. Перечень тот же, что у гейтов релиза
// ([release-gates.mjs](release-gates.mjs)): живой круг поднимает и участников, и надзирателя,
// и stdio-серверы шины, и гасит последние без ожидания.
//
// **Судится он по СВОЕМУ дереву, а не по всей машине**. Команды эти запускает не
// только канарейка: на машине с идущим run'ом те же три шаблона матчат чужие процессы из
// `workspace/node_modules`, и вердикт краснел на них — замер 2026-09-03 (прогон worker'а
// `sync`): четыре процесса чужого run'а, ни одного своего. Отсечка — `under()` по каталогу
// прогона: своё дерево канарейка ставит сама и целиком в него, поэтому путь бинаря в
// командной строке процесса и есть признак принадлежности.
const LEFTOVERS = [/promptobus\s+warden/, /test[/\\]participant\.mjs/, /promptobus\s+mcp/];

const RUN = mkdtempSync(path.join(os.tmpdir(), CANARY_PREFIX));
const startedAt = new Date();
const born = startedAt.getTime();

// Что канарейка делает — прозой, без нумерации: число шагов круга живёт в сценарии и там же
// меняется, а подпись с числом протухает молча.
const STEPS = [
  'tarball установлен в чистое рабочее место, установленный bin отвечает --version',
  'живой круг оркестрации проверяемым деревом — полностью, шагами сценария',
  'дом человека не тронут: снимок до установки сверяется с ним после --version и в конце прогона',
  'уборка: сессии, песочницы, сокеты, процессы, само рабочее место',
];

const verdicts = [];
function check(name, cond, detail = '') {
  const ok = !!cond;
  verdicts.push({ name, ok, detail: ok ? '' : String(detail).trim().slice(0, 600) });
  process.stdout.write(`${ok ? '✔' : '✖'} ${name}${ok ? '' : ` — ${String(detail).trim().slice(0, 600)}`}\n`);
  return ok;
}
const notes = [];
const note = (line) => { notes.push(line); process.stdout.write(`  · ${line}\n`); };

const tail = (text, n = 700) => {
  const s = String(text ?? '').trim();
  return s.length > n ? `…${s.slice(-n)}` : s;
};
const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
const under = (child, parent) => {
  const c = real(child);
  const r = real(parent);
  return c === r || c.startsWith(r + path.sep);
};
const listOf = (dir) => { try { return readdirSync(dir); } catch { return []; } };
const bornAfter = (file) => {
  try {
    const st = statSync(file);
    return (st.birthtimeMs || st.mtimeMs) >= born;
  } catch { return false; }
};
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
/** Имена marketplace'ов в глобальном реестре Claude Code. Файла нет — пустой список. */
const marketplaceIds = () => Object.keys(readJson(KNOWN_MARKETPLACES)?.marketplaces
  ?? readJson(KNOWN_MARKETPLACES) ?? {});

// Каталоги прежних прогонов метёт сама канарейка, оставляя три самых свежих.
// Свой каталог она оставляет намеренно — путь печатается, отчёт читают после прогона, — но
// мести накопленное было некому: замер 2026-09-03 на машине владельца — девять каталогов по
// 20 КБ. Снесённое печатается перечнем: молчаливая уборка в общем `$TMPDIR` читается как
// пропажа. Идущий рядом чужой прогон держит возрастная отсечка, а не порядок по mtime: его
// каталог перестаёт расти через секунды после старта и порогом «три самых свежих» не защищён.
const refusedRuns = [];
const swept = sweepPreviousRuns(os.tmpdir(), { current: RUN, refused: refusedRuns });
note(sweptLine('каталогов прежних прогонов', swept));
if (refusedRuns.length) note(`снести не дали (заняты или чужие права): ${refusedRuns.join(', ')}`);

// ── Шаг 1: чистое рабочее место, установка, sync и doctor ─────────────────────────────
const branch = (spawnSync('git', ['-C', REPO, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim();
const head = (spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim();

const packDir = path.join(RUN, 'pack');
mkdirSync(packDir, { recursive: true });
const packed = run('npm', ['pack', '--pack-destination', packDir], { cwd: CLI, encoding: 'utf8' });
const tgzName = listOf(packDir).find((n) => n.endsWith('.tgz'));
const tgz = tgzName ? path.join(packDir, tgzName) : null;

// Источник базы — bare-клон ЭТОЙ ветки: `sync` пойдёт в него настоящим `git clone`, но
// сети не коснётся, а гейт равенства версий сойдётся сам — база и CLI одного коммита.
const baseOrigin = path.join(RUN, 'base-origin.git');
const mirrored = spawnSync('git', ['clone', '--bare', '--quiet', '--single-branch', '--branch', branch, REPO, baseOrigin], { encoding: 'utf8' });

const ws = path.join(RUN, 'ws');
mkdirSync(ws, { recursive: true });
writeFileSync(path.join(ws, 'AGENTS.md'), '# Канареечное рабочее место\n\nВременное: живёт один прогон.\n');
writeFileSync(path.join(ws, 'package.json'), `${JSON.stringify({
  name: 'promptobus-canary-workspace', private: true, version: '0.0.0',
}, null, 2)}\n`);
writeHostConfig(ws, { tools: ['claude'] });

const installed = tgz
  ? run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--offline', tgz], { cwd: ws, encoding: 'utf8' })
  : { status: 1, stderr: 'tarball не собран' };
const PKG = path.join(ws, 'node_modules', 'promptobus');
const BIN = path.join(PKG, 'bin', 'promptobus.js');
check('канарейка: tarball собран и установлен в чистое рабочее место',
  packed.status === 0 && installed.status === 0 && existsSync(BIN),
  `pack ${packed.status} · install ${installed.status} ${tail(installed.stderr, 300)} · bin ${existsSync(BIN)}`);
if (tgz) note(`tarball ${tgzName} (${(statSync(tgz).size / 1024).toFixed(0)} КБ), ветка ${branch}, коммит ${head.slice(0, 8)}`);

// **Окружение детей — без идентичности сессии**. Гонят канарейку как раз из
// сессий, у которых все пять переменных стоят: релизный чеклист велит гонять её перед тегом,
// а в run'ах её гоняют worker'ы. Утёкший `PROMPTOBUS_HOME` сильнее поиска дома от cwd и увёл
// бы прогон в БОЕВОЙ журнал шины рабочего места, `PROMPTOBUS_TASK` — на задачу боевого run'а
// (замер 2026-09-03: живой круг worker'а `sync` поднимал spawn, review и надзирателя с
// окружением боевой задачи). Перечень импортируется из одного дома с набором
// ([hygiene.mjs](../test/hygiene.mjs)), второй копии здесь нет.
//
// Снимается у ДЕТЕЙ, а не у своего процесса: вердикт ниже судит по тому, что и правда уехало
// ребёнку, и на подчищенном `process.env` он был бы зелен по построению.
//
// Считается на КАЖДЫЙ вызов, а не один раз при загрузке файла (замечание ревью): ниже в
// `process.env.PATH` дописывается каталог найденного `claude`, и снятая до этого копия
// увела бы `sync` и `doctor` без него — ровно в тот отказ, ради которого prepend и заведён.
// Копия окружения на вызов стоит микросекунды, а вызовов у канарейки единицы.
const childEnv = () => dropSessionLeaks({ ...process.env });

const cli = (args, opts = {}) => spawnSync(process.execPath, [BIN, ...args], {
  cwd: ws, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: childEnv(), ...opts,
});

// Бинарь harness'а ищется ТЕМ ЖЕ резолвом, каким его ищет spawn, — включая `~/.local/bin`.
// Через PATH его звать нельзя: установка Claude Code туда себя не кладёт, и `run('claude', …)`
// возвращает ENOENT с пустым stdout. Вердикт уборки на таком ответе прошёл бы за успех —
// «список сессий пуст» и «списка не дали» неразличимы. Живой случай прогона 2026-09-02
//: ровно так и вышло.
let claudeBin = null;
try {
  const { resolveToolBin } = await import(new URL('../test/sandbox.mjs', import.meta.url));
  const found = resolveToolBin('claude');
  claudeBin = found.ok ? found.path : null;
} catch { claudeBin = null; }

// Реестр сессий читается ТЕМ ЖЕ разбором, что у механизма (`bgSessions` из установленного
// дерева), а не своим. Формы ответа `claude agents --json` три — голый массив, `{agents:[…]}`
// и `{sessions:[…]}`, — и вторая копия разбора разъехалась бы с первой молча. Сам `bgSessions`
// зовёт `claude` через PATH, поэтому найденный вне PATH каталог в него и добавляется — тем же
// приёмом, что в live-e2e.mjs.
if (claudeBin) {
  const binDir = path.dirname(claudeBin);
  if (!(process.env.PATH ?? '').split(path.delimiter).includes(binDir)) {
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
  }
}
let bgSessions = null;
let resetBgSessionsCache = null;
try {
  ({ bgSessions, resetBgSessionsCache } = await import(path.join(PKG, 'lib', 'liftoff.js')));
} catch { bgSessions = null; }

// **Снимок дома — ДО `sync`, и он же мера всей проверки**. Прежде здесь стояло
// предусловие: `sync` писал хуки памяти в ДОМ пользователя, и на разошедшихся хуках канарейка
// отказывалась, не запуская прогон, — иначе переписала бы человеку настройки живых сессий,
// в том числе той, из которой релиз и катят. С режимом `--no-global` писать за пределы
// каталога рабочего места `sync` не имеет права вовсе, поэтому спрашивать разрешения не у
// чего: снимаем состояние всех трёх дверей и сверяем с ним дважды.
//
// Состояние хуков спрашивается у САМОГО механизма (`hooksState` установленного дерева), а не
// своим сравнением файлов: своя копия правила разъехалась бы с ним молча и не отличила бы
// «разошлись» от «в доме нет вовсе». Рядом с его вердиктом лежат хеши самих файлов — вердикт
// отвечает на вопрос «свежие ли», а снимку нужен другой: «те же ли байты».
let hooksState = null;
try {
  ({ hooksState } = await import(path.join(PKG, 'dist', 'hooks.js')));
} catch { hooksState = null; }

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);
const fileMark = (file) => { try { return sha(readFileSync(file)); } catch { return '(нет файла)'; } };
const dirMark = (dir) => listOf(dir).sort().map((n) => `${n}:${fileMark(path.join(dir, n))}`).join(' ');
/**
 * Состояние трёх дверей `sync` наружу одним объектом. Сравнение идёт по всему объекту, а не
 * по одному полю: дверей три, и закрытость каждой — половина ответа. Разница печатается
 * пофамильно, поэтому поля называются так, как их зовёт человек.
 */
const homeSnapshot = () => ({
  'записи marketplace': marketplaceIds().sort().join(' ') || '(нет)',
  'установки плагинов': fileMark(INSTALLED_PLUGINS),
  'кэш плагинов': listOf(PLUGIN_CACHE).sort().join(' ') || '(нет)',
  'личные настройки Claude Code': fileMark(CLAUDE_SETTINGS),
});
/** Что разошлось между двумя снимками — построчно, чтобы вердикт называл дверь. */
const homeDiff = (before, after) => Object.keys(before)
  .filter((k) => before[k] !== after[k])
  .map((k) => `${k}: было «${before[k]}» стало «${after[k]}»`);

const homeBefore = homeSnapshot();
note(`снимок дома до sync: ${Object.entries(homeBefore).map(([k, v]) => `${k}=${v}`).join(' · ')}`);

const versioned = existsSync(BIN) ? cli(['--version']) : { status: 1, stdout: '', stderr: `нет ${BIN}` };
check('канарейка: установленный tarball отвечает --version',
  versioned.status === 0,
  `код ${versioned.status} · ${tail(`${versioned.stdout}${versioned.stderr}`)}`);

// **Вердикт режима — сверка со снимком, а не пересчёт имён.** Раньше здесь стояло обратное:
// прогон искал СВОЮ новую запись marketplace разницей реестра и снимал её. Разницей потому,
// что пересчитать имя снаружи нельзя — правило (`marketplaceName` в
// the host adapter) считает хеш от пути корня, а корень команда резолвит своим
// `requireRoot()`: под временным каталогом macOS он приходит как `/private/var/…`, тогда как
// здесь тот же каталог зовётся `/var/…`, и хеши двух написаний разные (живой случай прогона
// 2026-09-02, : `sync` зарегистрировал `ati-workspace-005c0315`, пересчёт правила дал
// `ati-workspace-d6c0cbf8`). Снимку это знать не обязано тем более: он сверяет ВЕСЬ реестр, а
// не одно имя, и вместе с ним обе другие двери.
//
// Уборки за собой здесь нет намеренно: режим, который всё-таки написал в дом, — это красный
// вердикт, а не повод убрать следы руками. Поэтому деталь называет и то, что осталось, и
// команду снятия — человек решает сам.
const homeAfterSync = homeSnapshot();
const syncDiff = homeDiff(homeBefore, homeAfterSync);
check('канарейка: sync --no-global не написал за пределы каталога рабочего места',
  syncDiff.length === 0,
  `${syncDiff.join(' · ')}. Снять запись marketplace: claude plugin marketplace remove <id>;`
  + ` каталог кэша ${PLUGIN_CACHE}/<id> та же команда не убирает — его сносят руками`);

let failure = null;
try {

  // ── Живой круг ──────────────────────────────────────────────────────────────────────
  // Механизм под проверкой — установленное дерево целиком, одним корнем. Рабочее место —
  // разложенное `sync`'ом: сценарий обязан идти в том мире, ради которого канарейка заведена.
  const liveEnv = {
    ...childEnv(),
    PROMPTOBUS_E2E_ROOT: PKG,
    PROMPTOBUS_E2E_WORKSPACE: ws,
  };
  // Вердикт по ФАКТИЧЕСКОМУ окружению ребёнка, а не по `process.env` в момент проверки: своё
  // окружение канарейка не трогает, и судить по нему значило бы судить не то. Мишень
  // мутационной пробы: верни сюда `{ ...process.env }` — вердикт краснеет ровно тогда, когда
  // канарейку гонят из сессии участника, то есть в самом частом случае.
  const dirty = SESSION_LEAK_VARS.filter((name) => name in liveEnv);
  const carried = SESSION_LEAK_VARS.filter((name) => name in process.env);
  check('канарейка: окружение живого прогона чистое от идентичности сессии',
    dirty.length === 0,
    `уехало ребёнку: ${dirty.join(', ')} · было у самой канарейки: ${carried.join(', ') || 'ничего'}`);
  note(`идентичность сессии у канарейки: ${carried.join(', ') || 'ничего'}; в окружении прогона: `
    + `${dirty.join(', ') || 'ничего'}`);
  const live = spawnSync(process.execPath, [LIVE_E2E], {
    cwd: REPO, env: liveEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const liveOut = `${live.stdout ?? ''}${live.stderr ?? ''}`;
  writeFileSync(path.join(RUN, 'live-e2e.out'), liveOut);
  const tally = /(\d+)\/(\d+) вердиктов прошло/.exec(liveOut);
  check('канарейка: живой круг оркестрации прошёл целиком',
    live.status === 0 && !!tally && tally[1] === tally[2],
    `код ${live.status} · ${tally ? `${tally[1]}/${tally[2]}` : 'счёт не разобран'} · ${tail(liveOut, 900)}`);
  if (tally) note(`живых вердиктов ${tally[1]}/${tally[2]}`);
  const total = /всего ([\d.]+) с/.exec(liveOut);
  if (total) note(`круг занял ${total[1]} с`);

  // Каким механизмом шёл прогон — по слову самого поднятого процесса, а не по резолву путей
  // в скрипте. Мишень мутационной пробы: `PROMPTOBUS_E2E_ROOT` на чекаут — вердикт краснеет.
  const reported = (/механизм по слову процесса: (.+)/.exec(liveOut) ?? [])[1]?.trim() ?? null;
  check('канарейка: живой прогон шёл бинарём из установленного дерева, а не из чекаута',
    !!reported && reported !== 'не назван' && under(reported, PKG) && !under(reported, REPO),
    `назван ${reported} · установка ${PKG}`);
} catch (e) {
  failure = e;
} finally {
  // ── Дом человека ──────────────────────────────────────────────────────────────────
  // Второй вердикт того же снимка и первый в `finally`: сверка идёт за ВЕСЬ прогон, а не за
  // один `sync`. Живой круг поднимает настоящие сессии Claude Code, и они дом человека тоже
  // трогать не вправе — участнику canonical плагин приезжает флагом `--plugin-dir`, а не
  // установкой. Стоит он в `finally`, потому что оборванный прогон обязан сказать
  // о своём следе в чужом доме, даже если о вердиктах круга отчитаться уже нечем.
  const homeAfterRun = homeSnapshot();
  const runDiff = homeDiff(homeBefore, homeAfterRun);
  check('дом человека: за весь прогон не изменилось ничего из того, что пишет sync',
    runDiff.length === 0,
    `${runDiff.join(' · ')}. Снять запись marketplace: claude plugin marketplace remove <id>;`
    + ` каталог кэша ${PLUGIN_CACHE}/<id> та же команда не убирает — его сносят руками`);
  note(`снимок дома после прогона: ${Object.entries(homeAfterRun).map(([k, v]) => `${k}=${v}`).join(' · ')}`);

  // ── Уборка ────────────────────────────────────────────────────────────────────────

  // Сессии прогона: спрашиваем harness тем же разбором, что и механизм. Разбор — половина
  // вердикта: нечитаемый ответ дал бы пустой список и зелень на пустом месте.
  let sessions = null;
  try {
    resetBgSessionsCache?.();
    sessions = bgSessions ? bgSessions({ fresh: true }) : null;
  } catch { sessions = null; }
  // Судим по рабочему каталогу сессии под каталогом прогона и по id задачи сценария:
  // подстрока «e2e» цепляла бы посторонние сессии человека, гоняющего релиз.
  const ours = Array.isArray(sessions)
    ? sessions.filter((x) => (x?.cwd && under(x.cwd, RUN)) || (x?.name && String(x.name).includes(E2E_TASK)))
    : [];
  check('уборка: сессий прогона в реестре harness\'а не осталось',
    Array.isArray(sessions) && ours.length === 0,
    Array.isArray(sessions)
      ? JSON.stringify(ours.map((x) => ({ name: x.name, cwd: x.cwd, status: x.status })))
      : 'реестр сессий не разобран — bgSessions вернул не список');
  if (Array.isArray(sessions)) note(`сессий в реестре harness'а после прогона: ${sessions.length}`);

  // Процессы: сперва доказываем, что смотреть УМЕЕМ — свой pid обязан быть в выдаче. Без
  // этого отказ `ps` читался бы как «ничего не осталось». Перечень тот же, что у гейтов:
  // живой круг поднимает и стоп-серверы шины, и их отсутствие проверяется наравне.
  const ps = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const psLines = (ps.stdout ?? '').split('\n').filter((l) => l.trim());
  const seesSelf = psLines.some((l) => Number(l.trim().split(/\s+/)[0]) === process.pid);
  // Отсечка по своему дереву (`LEFTOVERS` выше): из командной строки берутся все абсолютные
  // пути и спрашивается тот же `under()`, каким судится и бинарь прогона. Без неё вердикт
  // краснеет на чужом run'е той же машины, а зелёным от этого честнее не становится.
  const underRun = (line) => (line.match(/\/[^\s]+/g) ?? []).some((token) => under(token, RUN));
  const stray = psLines.filter((l) => Number(l.trim().split(/\s+/)[0]) !== process.pid
    && LEFTOVERS.some((re) => re.test(l)) && underRun(l));
  const elsewhere = psLines.filter((l) => Number(l.trim().split(/\s+/)[0]) !== process.pid
    && LEFTOVERS.some((re) => re.test(l)) && !underRun(l));
  check('уборка: процессов участников, надзирателей и серверов шины прогона не осталось',
    ps.status === 0 && seesSelf && stray.length === 0,
    seesSelf ? stray.join('\n') : `ps не показал даже свой процесс (${tail(ps.stderr, 200)})`);
  // Чужие процессы тех же команд вердикта не красят, но и молчать о них нельзя: человек,
  // читающий отчёт, обязан знать, что на машине идёт ещё один run.
  if (elsewhere.length) note(`процессов тех же команд вне каталога прогона: ${elsewhere.length} (не наши)`);

  // Песочницы и сокеты — только моложе начала прогона: литерал имени без отсечки по времени
  // красил бы вердикт чужим хвостом, а при смене префикса зеленел бы молча.
  const sandboxes = listOf(os.tmpdir())
    .filter((n) => n.startsWith('promptobus-live-e2e-'))
    .filter((n) => bornAfter(path.join(os.tmpdir(), n)));
  const socks = listOf('/tmp')
    .filter((n) => ['a2l-', 'a2e-', 'a2h-'].some((pref) => n.startsWith(pref)))
    .filter((n) => bornAfter(path.join('/tmp', n)));
  check('уборка: песочниц прогона и сокетов шины не осталось',
    sandboxes.length === 0 && socks.length === 0,
    `песочницы ${JSON.stringify(sandboxes)} · сокеты ${JSON.stringify(socks)}`);

  // Само рабочее место со своим store — последним: до него доходят команды уборки выше.
  rmSync(ws, { recursive: true, force: true });
  rmSync(packDir, { recursive: true, force: true });
  rmSync(baseOrigin, { recursive: true, force: true });
  check('уборка: канареечное рабочее место со своим store снесено',
    !existsSync(ws) && !existsSync(packDir), `${ws} · ${packDir}`);

  check('канарейка: прогон дошёл до конца без обрыва', !failure, failure ? String(failure.stack ?? failure) : '');
}

report();

function report() {
  const passed = verdicts.filter((v) => v.ok).length;
  // Отчёт печатается и на раннем отказе — до живого прогона: пустые поля честнее молчания.
  const liveLogPath = path.join(RUN, 'live-e2e.out');
  const liveText = existsSync(liveLogPath) ? readFileSync(liveLogPath, 'utf8') : '(живой прогон не запускался)';
  const green = passed === verdicts.length;
  const lines = [
    `# Живая канарейка релиза — ${green ? 'ЗЕЛЁНАЯ' : 'КРАСНАЯ'}`,
    '',
    `- Дата: ${startedAt.toISOString()}`,
    `- Репозиторий: ${REPO}`,
    `- Ветка: ${branch} · коммит: ${head}`,
    `- Каталог прогона: ${RUN}`,
    `- Node: ${process.version} · платформа ${process.platform}/${process.arch}`,
    '',
    '## Шаги постановки',
    '',
    ...STEPS.map((s) => `- ${s}`),
    '',
    `## Вердикты обёртки: ${passed}/${verdicts.length}`,
    '',
    ...verdicts.map((v) => `- ${v.ok ? '✔' : '✖'} ${v.name}${v.ok ? '' : ` — ${v.detail}`}`),
    '',
    '## Числа',
    '',
    ...notes.map((n) => `- ${n}`),
    '',
    '## Живой прогон',
    '',
    `Полный вывод: ${liveLogPath}`,
    '',
    '```',
    tail(liveText, 4000),
    '```',
    '',
  ];
  const file = path.join(RUN, 'live-canary.md');
  writeFileSync(file, lines.join('\n'));
  process.stdout.write(`\n${passed}/${verdicts.length} вердиктов обёртки прошло\n`);
  process.stdout.write(`▸ отчёт: ${file}\n`);
  process.exit(green ? 0 : 1);
}
