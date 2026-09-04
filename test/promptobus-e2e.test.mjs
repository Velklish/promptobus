// E2E шины на подставном harness'е. Запуск: npm test
//
// Здесь собирается ПОЛНЫЙ круг оркестрации — тот, которого до этой задачи не было ни в
// одном файле набора: spawn, первый `status`, ответ оркестратора, стук надзирателя в сокет
// участника, `result`, ревью с замечаниями, второй `result`, доклад о молчаливом конце
// хода, `promptobus done` с гашением сессий и уборкой, `promptobus prune`. Сам сценарий и все его сверки
// живут в [scenario.mjs](scenario.mjs) — он же общий с живым прогоном
// ([live-e2e.mjs](../scripts/live-e2e.mjs)); здесь остаётся ровно подмена harness'а.
//
// **Файл идёт серийной группой раннера.** Он меряет настенные часы дважды и оба раза
// по-настоящему: круг стука идёт через unix-сокет между четырьмя процессами, а доклад о
// стопе — ударом сердца надзирателя раз в `WARDEN_BEAT_SEC`. Под нагрузкой пула эти пороги
// либо краснеют на исправном коде, либо, что хуже, зеленеют ни на чём.
//
// Своё ожидание в файле одно и названо прямо: доклад о молчаливом конце хода приходит на
// первом ударе сердца надзирателя после самого хода, а удар идёт раз в 30 с. Надзиратель
// поэтому поднимается ПЕРВЫМ шагом, до spawn'а, — всё, что сценарий успевает сделать до
// молчаливого хода, вычитается из этого ожидания.
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox, makeSockPath } from './sandbox.mjs';
import {
  diagnoseTrace, installHarness, listSessions, pidAlive, planParticipant, readLog, stopAll,
} from './harness.mjs';
import { runScenario } from './scenario.mjs';

const SB = makeSandbox('promptobus-e2e-');
const sock = makeSockPath('a2e-');
// Дом harness'а заводит он сам и вне песочницы: иначе уборка на выходе холостая — хук
// песочницы сносит каталог раньше, чем стенд успевает погасить свои процессы.
const { home: HARNESS, restore } = await installHarness({ binDir: path.join(SB, 'bin'), sock });

// Подставной harness сценарию: подмена бинаря уже стоит, остаётся ответить на три вопроса —
// чем задаются ходы ролей, какие сессии живы и что показать на красном вердикте.
const harness = {
  label: 'подставной',
  // Ходы ролей задаёт файл скрипта, а не бриф: сценарию это разрешает шаги, которые живой
  // сессии не сыграть по команде — стоп на permission-запросе и на исчерпанном лимите
  //, и сторож цикла, которого подставной участник зовёт сам.
  scripted: true,
  sock,
  // Модель и эффорт подставной бинарь не читает вовсе: у него нет модели. Живой прогон
  // ставит здесь свои флаги — в этом вся разница между двумя harness'ами.
  spawnFlags: [],
  reviewFlags: [],
  plan: (address, script) => planParticipant(HARNESS, address, script),
  sessions: () => listSessions(HARNESS),
  liveSessions: (refs) => listSessions(HARNESS)
    .filter((s) => refs.includes(s.name) && pidAlive(s.pid)),
  // Номера процессов сессий — их снимают ДО гашения: реестр после `stop` пуст, и вердикт
  // «процессов не осталось» по нему был бы зелёным по построению (замечание ревью).
  pidsOf: (refs) => listSessions(HARNESS).filter((s) => refs.includes(s.name)).map((s) => s.pid),
  pidAlive,
  // Красный вердикт без следа участника не диагноз, а загадка: сюда уходит его журнал
  // действий — ошибки сценария первыми — и хвост лога процесса.
  diagnose: (address) => `${diagnoseTrace(HARNESS, address)}`
    + ` · логи: ${listSessions(HARNESS).map((s) => readLog(HARNESS, s.id, 6)).join(' | ')}`,
  cleanup: () => {},
};

const report = await runScenario({ check, harness, sandbox: SB, timeouts: { step: 30000, stall: 75000 } });

// Длительность шагов печатается всегда: по ней видно, что именно в файле ждёт, и она же
// уезжает в замер задачи. Это не вердикт — цифра, а не приговор.
process.stdout.write(`  ⏱ ${report.timings.map((t) => `${t.name} ${(t.ms / 1000).toFixed(1)} с`).join(' · ')}`
  + ` · всего ${(report.totalMs / 1000).toFixed(1)} с\n`);

// Страховка, а не проверка: вердикт о том, что процессов не осталось, стоит в сценарии, а
// это — уборка за упавшим прогоном, чтобы красный файл не оставил за собой живых детей.
// Страховка обязана проверять ОБЕ половины: что гасить было нечего (реестр пуст) и что
// пережившего kill не осталось. `stopAll` возвращает только вторых, и вердикт по одному
// его ответу зеленел бы и на полном реестре живых сессий (замечание ревью).
const before = listSessions(HARNESS);
const left = await stopAll(HARNESS);
check('за прогоном не осталось процессов участников — гасить было нечего',
  before.length === 0 && left.length === 0,
  `в реестре осталось ${JSON.stringify(before.map((s) => s.name))} · пережили kill ${JSON.stringify(left)}`);
restore();
