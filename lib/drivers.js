import { createRegistry, driverFor, harnessOf, snapshotSessions } from '../dist/index.js';
import { CLAUDE, claudeDriver } from './driver-claude.js';
import { CURSOR, cursorDriver } from './driver-cursor.js';
import { CODEX, codexDriver } from './driver-codex.js';

// Driver registry этого CLI: карта `harness → driver`, которую он передаёт в машину
// состояний надзирателя ЯВНО (ADR-032, §3). Карта живёт отдельным модулем, а не внутри
// driver'а: driver знает свой harness и не обязан знать про соседей.
//
// **Этот файл — единственная дверь механизма к driver'ам** (ADR-034). Остальные
// модули шины (`spawn`, `review`, `done`, `server`, `warden`, `status`, `doctor`, `guard`)
// не импортируют ни `driver-claude.js`, ни `liftoff.js` вовсе: они берут объект отсюда и
// зовут объявленные контрактом операции. Второй production driver кладётся в карту ниже, не
// трогая ни одного файла за пределами этого и своего `driver-<harness>.js`.
//
// Driver'ов в ней трое — Claude Code, Cursor и Codex (ADR-035, ADR-037). Подставные
// driver'ы живут только в наборе package и в карту не входят.

/**
 * `fallback` — harness записи, которая его не называет ВОВСЕ. Таких записей две породы:
 * участники, заведённые CLI до этой задачи, и owner задачи — его пишет `createTask`, а тот
 * про driver'ы не знает. Непустое незнакомое имя fallback не
 * спасает: заявленный чужой harness — отказ.
 */
export const REGISTRY = createRegistry({
  drivers: { [CLAUDE]: claudeDriver, [CURSOR]: cursorDriver, [CODEX]: codexDriver },
  fallback: CLAUDE,
});

/**
 * Снимок сессий участников — вход машины состояний. Берётся раз в удар сердца: за ответом
 * driver'а стоит внешний опрос harness'а, а круг идёт раз в секунду.
 */
export function snapshotOf(participants) {
  return snapshotSessions(participants, REGISTRY);
}

/**
 * Driver записи участника — по harness'у, который она объявила. Записи прежнего CLI поля не
 * несут вовсе, и им достаётся `fallback`; непустое незнакомое имя отказывает.
 */
export function driverOf(participant) {
  return driverFor(REGISTRY, harnessOf(participant, REGISTRY));
}

/**
 * Driver ПОДЪЁМА: harness, которым команда поднимает сессию. Без имени — `fallback` карты,
 * то есть прежний harness и прежний argv; с именем — тот, что назвал человек флагом
 * `--harness`.
 *
 * Дверь одна ровно за этим: флаг правит эту функцию, а не каждую команду подъёма, и
 * константы имени driver'а вызывающие по-прежнему не знают. Неизвестное имя отказывает
 * здесь же, до всякой записи на диск, — `driverFor` бросает `GateError` с перечнем
 * известных.
 */
export function liftDriver(harness = null) {
  const named = String(harness ?? '').trim();
  return driverFor(REGISTRY, named || REGISTRY.fallback);
}

/**
 * Driver записи участника, а на ЧУЖОМ harness'е — driver ПОДЪЁМА (замечание ревью).
 * Отдельная дверь нужна там, где отказ дороже неточности: уборка `promptobus done` идёт
 * ПОСЛЕ закрытия задачи, и брошенный оттуда `GateError` унёс бы с собой и уборку секретов
 * участников, и метение журналов — ровно то, ради чего в том же файле заведено правило «из
 * обхода после закрытия не бросают». Запись с чужим harness'ом туда попадает
 * штатно: снимок даёт ей `unknown`, а неизвестность — не смерть, и каталог такой записи
 * обход законно оставляет со словами.
 *
 * Неточность здесь безобидна: driver подъёма даёт СЛОВА человеку, а не действие над чужой
 * сессией. Всё, что действует — гашение, подъём, стук, — идёт через `driverOf` и отказывает
 * как отказывало.
 */
export function driverOrLift(participant) {
  try {
    return driverOf(participant);
  } catch {
    return liftDriver();
  }
}

/**
 * Driver по имени harness'а из доклада о стопе. Поля нет — берётся `fallback`: доклад
 * собран по записи участника, а у записи прежнего CLI harness'а не бывает.
 */
export function driverByHarness(harness) {
  return driverFor(REGISTRY, harness || REGISTRY.fallback);
}

/**
 * Забыть запомненные списки сессий у всех driver'ов. Зовут после подъёма и гашения: список
 * после них меняется, и следующий читатель увидел бы закрытую сессию живой. Driver, реестра
 * не держащий (`sessionList: false`), операции не объявляет — забывать ему нечего.
 */
export function forgetSessions() {
  for (const driver of Object.values(REGISTRY.drivers)) driver.forgetSessions?.();
}

/**
 * Registry с подменённой доставкой — шов набора: подставной канал на один круг. Подменяется
 * ровно `activate` у КАЖДОГО driver'а, а текст остаётся его собственным: круг проверяется
 * тот же, что в жизни, и меняется только провод. Registry передаётся в машину состояний
 * явно, поэтому шов — это другой registry, а не переменная внутри модуля: набор гоняет
 * круги параллельно, и общая переменная развела бы их между собой.
 */
export function knockRegistry(knock) {
  if (!knock) return REGISTRY;
  const drivers = Object.fromEntries(Object.entries(REGISTRY.drivers).map(([harness, driver]) => [
    harness,
    // Подменяется доставка ТОЛЬКО там, где она и правда сокет (замечание ревью). У driver'а,
    // который будит новым ходом, `endpoint` сокетом не является вовсе — это ссылка на его
    // запись в реестре ходов, — и подставной канал стучал бы в неё как в сокет, проверяя
    // круг, которого у этого harness'а нет. Признак спрашивается объявленный, а не
    // выведенный из наличия операции: второй driver рендерит текст и будит сам.
    driver.options.knockChannel === 'socket'
      ? { ...driver, activate: (target, notification) => knock(target.endpoint, driver.renderNotification(notification)) }
      : driver,
  ]));
  return { ...REGISTRY, drivers };
}

/**
 * Маршрут по стопу — у driver'а того участника, чьё состояние и разобрано. Общий текст
 * строки остаётся у adapter'а ([stalls.js](stalls.js)), harness-specific команда приходит
 * отсюда: `status`, ответ `mailbox` и доклад надзирателя обязаны советовать одно.
 */
export function stallRouteOf(stalled, task) {
  const driver = driverByHarness(stalled.harness);
  return driver.stallRoute({ ...stalled, task }, stalled.id ?? stalled.ref, stalled.ref);
}
