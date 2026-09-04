// Смешанный состав шины на подставных стендах: оркестратор Claude Code, worker Cursor,
// reviewer Codex. Запуск: npm test
//
// Каждый из трёх driver'ов до этой задачи проверялся ПООДИНОЧКЕ — своим файлом набора и
// своим живым прогоном, — и круг всегда шёл на одном harness'е. Здесь впервые идёт состав:
// worker поднимается `--harness cursor`, reviewer — `--harness codex`, а сценарий остаётся
// тем же модулем ([scenario.mjs](scenario.mjs)), что у подставного Claude
// ([promptobus-e2e.test.mjs](promptobus-e2e.test.mjs)) и у канарейки
// ([live-e2e.mjs](../scripts/live-e2e.mjs)). Различаются составы, а не проверки: разъехаться
// им негде — сверки лежат в общем модуле.
//
// **Два подставных бинаря разом — часть предмета.** Стенд Cursor ставит `agent` и `tmux`,
// стенд Codex — `codex`, и оба уводят свои дома переменными окружения. Складываются они
// потому, что каждый ставит СВОЙ бинарь в ОДИН каталог и правит только свои переменные:
// общего состояния у них нет вовсе, а PATH оба лишь дополняют этим каталогом. Порядок снятия
// обратный порядку установки — иначе восстановленный PATH унёс бы каталог соседа.
//
// **Чего этот состав не играет и почему** — не «шаг пропущен», а объявленная способность
// участника (`participantHarness` в сценарии):
//
//   - `blocks` — стоп на диалоге разрешения и на исчерпанном лимите. Поле `block` в ходе
//     понимает только подставной `claude` ([participant.mjs](participant.mjs));
//   - `stalls` — доклад о молчаливом конце хода. Сверяется он ПРИЧИНОЙ, которую сессия
//     написала о себе в `jobs/<id>/state.json` демона Claude; у Cursor конец хода приносят
//     `turn_ended` и хук `stop`, строки причины там нет;
//   - `files` — mcp-config участника файлом по пути store. Cursor читает проектный
//     `.cursor/mcp.json` своего рабочего каталога, Codex получает серверы полем запроса
//     подъёма;
//   - `guard` у reviewer'а — хуков под `codex app-server` нет вовсе, и отметки конца хода у
//     него не будет ни на одном ходе. У worker'а Cursor она есть, и вердикт о ней идёт.
//
// **Файл идёт серийной группой раннера** — по тому же доводу, что и его близнец на
// подставном Claude: круг стука идёт между процессами настоящими сокетами и tmux-панелями, и
// под нагрузкой пула эти пороги либо краснеют на исправном коде, либо зеленеют ни на чём.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox, makeSockPath, writeHostConfig } from './sandbox.mjs';
import * as cursorStub from './harness-cursor.mjs';
import * as codexStub from './harness-codex.mjs';
import { REVIEWER, runScenario, WORKER } from './scenario.mjs';
import { cursorDriver } from '../lib/driver-cursor.js';
import { codexDriver } from '../lib/driver-codex.js';
import * as cursorSession from '../lib/cursor-persist.js';
import * as codexSession from '../lib/codex-session.js';

// Префикс песочницы — из семейства `promptobus-promptobus`, а не своё новое имя: уборка
// набора метёт по перечню префиксов ([tmpdir-sweep.mjs](tmpdir-sweep.mjs)), перечень собран
// руками, и новое имя пришлось бы вписывать туда же — иначе каталог оборванного прогона
// оставался бы в общем `$TMPDIR` навсегда.
const SB = makeSandbox('promptobus-promptobus-mixed-');
const binDir = path.join(SB, 'bin');
// Дома стендов заводят они сами и ВНЕ песочницы файла: хук песочницы сносит её каталог
// раньше, чем стенд успевает погасить свои процессы.
const cursorHarness = await cursorStub.installHarness({ binDir });
const codexHarness = await codexStub.installHarness({ binDir });

// Рабочее место готовит вызывающий: `--harness` отказывает инструменту, которого нет в
// `promptobus.json`, — адаптеров под него `sync` не раскладывал, и участник остался бы без
// правил рабочего места. Остальную раскладку строит сам сценарий.
const WS = path.join(SB, 'ws');
mkdirSync(path.join(WS, '.agents'), { recursive: true });
writeHostConfig(WS, { tools: ['claude', 'cursor', 'codex'] });

/** Номер процесса panel'и участника Cursor — по тому же реестру, каким его смотрит driver. */
function cursorPid(ref) {
  const record = cursorSession.readSession(ref);
  if (!record?.sessionName) return null;
  const server = record.tmuxServer || cursorSession.CURSOR_TMUX_SERVER;
  return cursorSession.findSession(record.sessionName, { server })?.panePid ?? null;
}

/** Номер процесса держателя потока Codex: сессию держит `app-server`, а его — держатель. */
function codexPid(ref) {
  return codexSession.readSession(ref)?.holderPid ?? null;
}

// Живость и занятость спрашиваются у DRIVER'А участника, а не выводятся своей сверкой полей:
// реестры у Cursor и Codex разные (tmux-сервер против каталога записей), и собственное
// правило разошлось бы с тем, каким судит механизм.
const alive = (driver, refs) => refs.filter((ref) => driver.inspect(ref)?.state === 'alive');
const handedOver = (driver, ref) => {
  const view = driver.inspect(ref);
  return view?.state === 'alive' && view.busy === false;
};

const worker = {
  id: cursorDriver.id,
  // Ходы задаёт файл скрипта, а не бриф: подставной `agent` играет их буквально.
  scripted: true,
  // Сторож цикла зовёт хук `stop` из проектного `.cursor/hooks.json`, и стенд его стреляет.
  guard: true,
  blocks: false,
  stalls: false,
  files: false,
  spawnFlags: ['--harness', 'cursor'],
  plan: (address, script) => cursorStub.planParticipant(cursorHarness.home, address, script),
  liveSessions: (refs) => alive(cursorDriver, refs),
  pidsOf: (refs) => refs.map(cursorPid).filter((pid) => Number.isInteger(pid)),
  pidAlive: cursorSession.pidAlive,
  idle: (ref) => handedOver(cursorDriver, ref),
  inspect: (ref) => cursorDriver.inspect(ref),
  // Красный вердикт без следа участника не диагноз, а загадка: сюда уходит журнал его
  // действий и список живых panel'ей стенда.
  diagnose: (address) => `${cursorStub.diagnoseTrace(cursorHarness.home, address)}`
    + ` · панели tmux: ${JSON.stringify(cursorSession.listSessions().map((s) => [s.name, s.panePid]))}`,
};

const reviewer = {
  id: codexDriver.id,
  scripted: true,
  // Хуки под `app-server` не исполняются вовсе — звать сторож цикла участнику нечем.
  guard: false,
  blocks: false,
  stalls: false,
  files: false,
  reviewFlags: ['--harness', 'codex'],
  plan: (address, script) => codexStub.planParticipant(codexHarness.home, address, script),
  liveSessions: (refs) => alive(codexDriver, refs),
  pidsOf: (refs) => refs.map(codexPid).filter((pid) => Number.isInteger(pid)),
  pidAlive: codexSession.pidAlive,
  idle: (ref) => handedOver(codexDriver, ref),
  inspect: (ref) => codexDriver.inspect(ref),
  diagnose: (address) => `${codexStub.diagnoseTrace(codexHarness.home, address)}`
    + ` · потоки: ${JSON.stringify(codexSession.listSessions().map((r) => [r.threadId, r.holderPid, r.state]))}`,
};

// Состав: harness у участников разный, и объявляет его ВЫЗЫВАЮЩИЙ. Роль читается префиксом
// адреса — тем же правилом, каким её читает сам механизм (`address.startsWith('reviewer:')` в
// маршрутах стопа): своя таблица адресов разошлась бы со сценарием на первой же правке имён.
const harness = {
  label: 'смешанный',
  sock: makeSockPath('a2m-'),
  at: (address) => (String(address).startsWith('reviewer:') ? reviewer : worker),
  // Процессы стендов гасит `promptobus done` в сценарии, а за упавшим прогоном — хуки выхода
  // самих стендов: каждый бьёт panel'и и держателей своего дома и сносит его целиком. Второй
  // уборки здесь заводить нечего.
  cleanup: () => {},
};

const report = await runScenario({
  check,
  harness,
  sandbox: SB,
  workspace: WS,
  // Потолок шага выше подставного Claude, и это не запас «на всякий случай». Доставка в
  // живую persist-сессию Cursor стоит своих секунд: driver ждёт свободного поля ввода
  // (`INPUT_WAIT_MS`), держит паузу перед Enter (`ENTER_PAUSE_MS`) и на идущем ходе кладёт
  // текст в очередь сессии — ход по нему начинается только после текущего. Замер: шаг
  // «замечания worker'у и второй result» — 21,4–22,7 с в четырёх прогонах подряд при
  // остальных шагах до четырёх секунд и круге целиком 45 с. Потолок 90 с даёт худшему шагу
  // запас вчетверо; меньший превращал бы медленную машину в диагноз «участник не ответил».
  // Порог доклада о стопе прежний: этот состав шага молчания не идёт вовсе.
  timeouts: { step: 90000, stall: 75000 },
  // Второй round ревью — предмет этой задачи: reviewer Codex получает НОВЫЙ дифф тем же
  // адресом, без второй сессии.
  reviewRounds: 2,
});

process.stdout.write(`  ⏱ ${report.timings.map((t) => `${t.name} ${(t.ms / 1000).toFixed(1)} с`).join(' · ')}`
  + ` · всего ${(report.totalMs / 1000).toFixed(1)} с\n`);

// Оба стенда ОТРАБОТАЛИ, а не просто встали в PATH. Судим по следу каждого: ход сыгран
// (`turn-end`) и инструмент шины из него позван (`tool`). Без этой пары зелень круга можно
// было бы получить и на одном стенде — второй участник просто молчал бы, а его вердикты
// краснели бы по другой причине; сверка следа отделяет «состав сложился» от «повезло».
const workerTrace = cursorStub.readTrace(cursorHarness.home, WORKER);
const reviewerTrace = codexStub.readTrace(codexHarness.home, REVIEWER);
const served = (trace) => trace.some((e) => e.kind === 'turn-end') && trace.some((e) => e.kind === 'tool');
check('оба подставных стенда играли ходы одного круга — worker бинарём agent, reviewer бинарём codex',
  served(workerTrace) && served(reviewerTrace),
  `ходов Cursor ${workerTrace.filter((e) => e.kind === 'turn-end').length},`
  + ` вызовов шины ${workerTrace.filter((e) => e.kind === 'tool').length}`
  + ` · ходов Codex ${reviewerTrace.filter((e) => e.kind === 'turn-end').length},`
  + ` вызовов шины ${reviewerTrace.filter((e) => e.kind === 'tool').length}`);

// Дома обоих harness'ей уведены в песочницы стендов. Это и есть проверяемое «в дом человека
// прогон не писал»: резолв дома у механизма один на все его двери, и уведён он тем же
// способом, каким его уводит живой прогон. Сверять mtime `~/.cursor` было бы нельзя — по нему
// пишет живая сессия человека, идущая рядом, и вердикт краснел бы от неё.
const inside = (p, home) => String(p).startsWith(String(home));
check('дома обоих harness\'ей уведены в песочницы стендов — в дом человека прогон не писал',
  inside(cursorSession.cursorStateHome(), cursorHarness.home)
  && inside(cursorSession.cursorUserHome(), cursorHarness.home)
  && inside(codexSession.codexStateHome(), codexHarness.home),
  `Cursor: реестр ${cursorSession.cursorStateHome()}, дом ${cursorSession.cursorUserHome()}`
  + ` · Codex: реестр ${codexSession.codexStateHome()}`);

// Страховка, а не проверка: вердикт «процессов участников не осталось» стоит в сценарии, а
// это — уборка за упавшим прогоном. Проверяются ОБЕ половины у каждого стенда: что гасить
// было нечего (реестр пуст) и что живого процесса за записью не осталось.
const panes = cursorSession.listSessions();
const threads = codexSession.listSessions();
const heldThreads = threads.filter((r) => codexSession.pidAlive(r.holderPid));
check('за прогоном не осталось ни панели Cursor, ни потока Codex — гасить было нечего',
  panes.length === 0 && threads.length === 0 && heldThreads.length === 0,
  `панели ${JSON.stringify(panes.map((s) => s.name))} · потоки ${JSON.stringify(threads.map((r) => r.threadId))}`
  + ` · живые держатели ${JSON.stringify(heldThreads.map((r) => r.holderPid))}`);

// Порядок снятия обратный порядку установки: `withStubPath` восстанавливает PATH тем
// значением, которое видел САМ, и снятие в прямом порядке вернуло бы PATH без каталога,
// поставленного вторым стендом.
codexHarness.restore();
cursorHarness.restore();
