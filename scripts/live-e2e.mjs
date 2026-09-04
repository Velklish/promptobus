#!/usr/bin/env node
// Канарейка шины: ТОТ ЖЕ сценарий E2E, но на настоящем Claude Code. Запуск:
//
//   node cli/scripts/live-e2e.mjs
//
// В `npm test` не входит и входить не будет: она поднимает живые сессии, стоит токенов и
// зависит от машины. Предмет у неё тот же, что у подставного прогона
// ([promptobus-e2e.test.mjs](../test/promptobus-e2e.test.mjs)), и сценарий — буквально тот же модуль
// ([scenario.mjs](../test/scenario.mjs)): различаются два harness'а, а не две проверки.
// Разъехаться им негде — сверки лежат в общем модуле, и правка сценария едет в оба прогона
// сразу.
//
// Что здесь другое:
//
// - бинарь настоящий. Подмены PATH нет вовсе, `--bg` поднимает живую фоновую сессию, а
//   `stop` её гасит;
// - ходы ролей задаёт БРИФ, а не файл скрипта: `say` каждого хода уезжает в промпт участника
//   («забери mailbox, ответь строкой …»). Поэтому сверки в сценарии идут по вхождению
//   маркера, а не по дословному телу: буквальность проверяла бы послушность модели;
// - модель `sonnet`, эффорт `low`: канарейка проверяет круг шины, а не качество ответа.
//
// Отчёт — вердикты и длительности шагов. Токенов в нём нет: слушатель сокета
// оркестратора кладёт в след только признак «токен совпал», а не сам токен.
import { rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { makeSandbox, makeSockDir } from '../test/sandbox.mjs';
import { pidAlive } from '../test/harness.mjs';
import { dropSessionLeaks, SESSION_LEAK_VARS } from '../test/hygiene.mjs';
import { MECHANISM_ROOT, runScenario, STEPS } from '../test/scenario.mjs';

// Механизм под проверкой — один корень на весь прогон, и объявляет его сценарий
// (`PROMPTOBUS_E2E_ROOT`). Не задан — чекаут, как было. Задан — установленное дерево, и
// тогда СВОИ модули этот скрипт обязан брать оттуда же: половинчатый резолв поднимал бы
// сессии одним механизмом, а судил бы о них другим.
const { bgSessions, findSession, resetBgSessionsCache, sessionLiveness } = await import(path.join(MECHANISM_ROOT, 'lib', 'liftoff.js'));
const { claudeDriver } = await import(path.join(MECHANISM_ROOT, 'lib', 'driver-claude.js'));
const { resolveToolBin } = await import(path.join(MECHANISM_ROOT, 'lib', 'tools.js'));

// Бинарь ищется тем же резолвом, каким его ищет spawn, — включая `~/.local/bin`. Но реестр
// сессий (`bgSessions`) зовёт `claude` через PATH, поэтому найденный вне PATH каталог в него
// и добавляется: иначе половина прогона видела бы бинарь, а половина — нет.
const tool = resolveToolBin('claude');
if (!tool.ok) {
  console.error(`✖ живой прогон нечем гнать: ${tool.reason}`);
  process.exit(1);
}
const binDir = path.dirname(tool.path);
if (!(process.env.PATH ?? '').split(path.delimiter).includes(binDir)) {
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
}
resetBgSessionsCache();

// Автоподъём надзирателя выключен намеренно: сценарий поднимает его сам и сам гасит, а
// отвязанный процесс, поднятый попутной командой, пережил бы канарейку и остался стучаться
// в её сокеты. Тот же довод, что у общего перечня гигиены набора (`hygiene.mjs`).
process.env.PROMPTOBUS_WARDEN = 'off';

// **Идентичность сессии снимается со своего окружения, а не только с детского**.
// Сценарий строит окружение команд из `process.env`, и гнать этот прогон принято как раз из
// сессии, у которой все пять переменных стоят: релизный чеклист велит гонять канарейку перед
// тегом, а в run'ах её гоняют worker'ы. Утёкший `PROMPTOBUS_TASK` уводит команды песочницы на
// задачу БОЕВОГО run'а (живой замер 2026-09-03: красный шаг 4, «задачи run'а нет в
// песочнице»), а `PROMPTOBUS_HOME` — в боевой журнал шины рабочего места. Перечень тот же и
// оттуда же, что у набора; свои `CLAUDE_CODE_MESSAGING_*` сценарий заводит заново, уже сокетом
// стенда. Дом и `CLAUDE_CONFIG_DIR` не трогаются: прогон живой, и настоящему `claude` нужен
// его настоящий дом.
const leaked = SESSION_LEAK_VARS.filter((name) => name in process.env);
dropSessionLeaks(process.env);

const SB = makeSandbox('promptobus-live-e2e-');
// Каталог сокетов прогона — свой, и убирается он в `finally` вместе с песочницей.
// Хук выхода [sandbox.mjs](../test/sandbox.mjs) его тоже снимает, но только на своём процессе:
// круг, оборванный посреди, до конца файла не доходит, а уборка обязана идти по любому исходу.
// Каталог берётся у самого помощника, а не выводится из строителя пути: на win32 строитель
// отдаёт имя канала, и каталога там нет вовсе — `dir` приходит `null`, и сносить нечего.
const { dir: sockDir, sock } = makeSockDir('a2l-');
const raised = new Set();

const harness = {
  label: 'живой',
  // Ходы задаёт бриф, а не скрипт: сыграть по команде стоп на permission-запросе или на
  // лимите живой сессии нечем, и шаги, требующие этого, канарейка не идёт.
  // Сюда же вердикт о стороже цикла участника: хук лежит в настройках рабочего
  // места, а cwd участника — в worktree клона, и доставку хука решает harness.
  scripted: false,
  sock,
  // Канарейка проверяет круг, а не рассуждение: дешёвая модель и низкий эффорт.
  spawnFlags: ['--model', 'sonnet', '--effort', 'low'],
  reviewFlags: ['--model', 'sonnet', '--effort', 'low'],
  // Ходы живой роли задаёт бриф, который сценарий уже собрал из тех же скриптов, — писать
  // на диск здесь нечего.
  plan: () => {},
  sessions: () => {
    resetBgSessionsCache();
    return bgSessions({ fresh: true }) ?? [];
  },
  liveSessions: (refs) => {
    resetBgSessionsCache();
    const list = bgSessions({ fresh: true });
    if (list === null) return [];
    return refs.map((ref) => {
      const hit = findSession(list, ref);
      if (hit) raised.add(ref);
      return hit && sessionLiveness(hit, list) === 'alive' ? hit : null;
    }).filter(Boolean);
  },
  // Номера процессов сессий — их снимают ДО гашения: после `claude stop` запись исчезает
  // из списка, и вердикт «процессов не осталось» по списку был бы зелёным по построению.
  pidsOf: (refs) => {
    const list = bgSessions({ fresh: true }) ?? [];
    return refs.map((ref) => findSession(list, ref)?.pid).filter((pid) => Number.isInteger(pid));
  },
  pidAlive,
  diagnose: (address) => {
    const list = bgSessions({ fresh: true }) ?? [];
    return `сессии harness'а: ${JSON.stringify(list.map((s) => ({ name: s.name, status: s.status, state: s.state })))}`
      + ` · участник ${address}`;
  },
  // Уборка канарейки: всё, что она подняла, гасится её же driver'ом. `promptobus done` в сценарии
  // делает это сам, но канарейка обязана прибрать и за упавшим прогоном.
  cleanup: () => {
    for (const ref of raised) {
      // Исход гашения — обещание: сама команда уходит бинарю синхронно, ждать
      // остаётся только исчезновения записи из реестра. Страховке за упавшим прогоном
      // этого довольно, и ждать её здесь нечем — сценарий зовёт уборку из своего
      // `finally`, без `await`. Ожидание поэтому снято НУЛЁМ (замечание ревью): с
      // потолком по умолчанию оборванный прогон досиживал бы до десяти секунд таймеров на
      // сессию уже после отчёта — скрипт выходит через `process.exitCode`, а не `exit`.
      Promise.resolve(claudeDriver.stop(ref, { timeoutMs: 0 })).catch(() => { /* гасить нечего */ });
    }
  },
};

const verdicts = [];
const check = (name, cond, detail = '') => {
  const ok = !!cond;
  verdicts.push({ name, ok, detail: ok ? '' : String(detail).slice(0, 500) });
  process.stdout.write(`${ok ? '✔' : '✖'} ${name}${ok ? '' : ` — ${String(detail).slice(0, 500)}`}\n`);
};

// Рабочее место готовит вызывающий, если оно у него есть: канарейка подаёт сюда
// РАЗЛОЖЕННЫЙ `sync`'ом workspace установленного tarball'а, и стенд обязан идти в нём, а не
// в заглушке рядом. Переменной нет — стенд строит своё, как раньше.
const WS = process.env.PROMPTOBUS_E2E_WORKSPACE || null;

process.stdout.write(`▸ живой прогон E2E: ${tool.path}${tool.version ? ` (${tool.version})` : ''}\n`);
process.stdout.write(`▸ механизм: ${MECHANISM_ROOT}\n`);
process.stdout.write(`▸ шагов ${STEPS.length}, песочница ${SB}${WS ? `, рабочее место ${WS}` : ''}\n`);
if (leaked.length) process.stdout.write(`▸ снято с окружения прогона: ${leaked.join(', ')}\n`);

let report = null;
let failure = null;
try {
  // Потолки на порядок больше подставных: живая сессия думает секундами и десятками секунд,
  // а доклад о стопе всё так же ждёт удара сердца надзирателя.
  report = await runScenario({
    check,
    harness,
    sandbox: SB,
    workspace: WS,
    timeouts: { step: 300000, stall: 300000 },
    trace: (line) => process.stdout.write(`  · ${line}\n`),
  });
} catch (e) {
  failure = e;
} finally {
  harness.cleanup();
  // Песочница и каталог сокетов — здесь, а не после отчёта: сюда прогон приходит любым
  // исходом, включая оборванный. Отчёт ниже читает только то, что уже собрано в памяти.
  rmSync(SB, { recursive: true, force: true });
  if (sockDir) rmSync(sockDir, { recursive: true, force: true });
}

const passed = verdicts.filter((v) => v.ok).length;
process.stdout.write(`\n${passed}/${verdicts.length} вердиктов прошло\n`);
if (report) {
  process.stdout.write(`длительности: ${report.timings.map((t) => `${t.name} ${(t.ms / 1000).toFixed(1)} с`).join(' · ')}\n`);
  process.stdout.write(`всего ${(report.totalMs / 1000).toFixed(1)} с\n`);
  // Строка для вызывающего: каким бинарём прогон шёл по слову самого поднятого процесса.
  // Канарейка сверяет её со своим install-деревом — сценарию знать, где «правильно», неоткуда.
  process.stdout.write(`механизм по слову процесса: ${report.mechanism.reported ?? 'не назван'}\n`);
}
if (failure) {
  process.stdout.write(`✖ прогон оборван: ${failure.message}\n`);
}
// Песочницу и каталог сокетов прогон убирает за собой сам, в `finally` выше: они живут в
// системном tmp, раннера над ними нет. Здесь только строка отчёта.
process.stdout.write(`▸ песочница убрана (${os.tmpdir()})${sockDir ? `, каталог сокетов ${sockDir}` : ''}\n`);
process.exitCode = passed === verdicts.length && !failure ? 0 : 1;
