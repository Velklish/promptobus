import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, watch } from 'node:fs';
import { ok, info, warn } from './util.js';
import {
  addressOf, bus, claimWarden, clearWarden, inboxDir, liveWarden, logWarden, readTask, resolveIdentity,
  sessionIdentity,
  resolveTaskId, WARDEN_BEAT_SEC,
} from './store.js';
import {
  beatRound, ROUND_FAIL_LIMIT, stallRound, supervisorRound, TICK_MS,
} from '../dist/index.js';
import { forgetSessions, knockRegistry, REGISTRY, snapshotOf } from './drivers.js';
import { stallLine } from './status.js';

// Надзиратель задачи (ADR-028, ADR-029) — ПРОЦЕСС, а не машина состояний.
//
// Слушание шины держится на процессе, а не на дисциплине модели: надзиратель —
// единственный слушатель всех mailbox'ов задачи и её единственный activator. Заметив
// непрочитанное, он будит адресата и тем начинает его ход. Своего состояния у процесса
// нет — всё лежит в store задачи, поэтому его смерть ничего не теряет, а поднять заново
// вправе любая команда CLI (`ensureWarden`).
//
// **Решения принимает не этот файл**. Круги, пороги перестука, health
// непрочитанного, эскалация молчания, разбор стопа и решение «кого активировать» живут в
// package ([supervisor.ts](../src/supervisor.ts)) и про harness не
// знают ничего. Здесь остаётся то, что harness'у и рабочему месту принадлежит целиком:
// отвязанный процесс, наблюдатели `fs.watch`, снимок сессий через driver registry, человеческая
// диагностика и цикл. Канал доставки — driver, и берётся он из registry
// ([drivers.js](drivers.js)).
//
// Доставка — best-effort: признак «доставлено» один, mailbox забран. Отказ активации
// процесс не валит: участник помечается каналом `self-wake`, доставка остальным идёт дальше.

// Пороги и интервалы — там же, где машина состояний. Реэкспорт: их читают команды и набор,
// а второй дом у числа означал бы два разных значения одного порога.
export {
  KNOCK_RETRY_SEC, ROUND_FAIL_LIMIT, SILENCE_SEC, TICK_MS, WARDEN_TOTAL_SEC,
} from '../dist/index.js';

// Предикаты и удар сердца — там же, реэкспортом: их зовут набор и команды шины.
export { beatRound, liveWatched } from '../dist/index.js';

/**
 * Один круг присмотра. Обёртка над машиной состояний: сюда приходит снимок сессий, отсюда
 * уходит registry. `knock` — шов набора: подставной driver на один круг.
 *
 * **Снимок круг не запрашивает и запрашивать не вправе**. Он приходит аргументом
 * и держится в переменной цикла до удара сердца; круг идёт раз в секунду, а за снимком
 * стоит запуск процесса опроса harness'а. Замер 2026-09-02 (счёт по argv подставного
 * бинаря, три участника с сессиями): круг — 0 запусков `claude agents --json` и со
 * снимком, и без него; удар сердца — 1, и на разобранном ответе, и на неразобранном.
 *
 * Цена «улучшения» — там же, но она counterfactual: снимай круг состояние сам и БЕЗ
 * сброса кэша, шестьдесят снимков (минута) стоили бы 1 запуска на разобранном ответе и 60
 * на неразобранном — отказ разбора не кэшируется намеренно ([liftoff.js](liftoff.js)).
 * Сегодня этой цены нет ни у кого: снимок гаснет на ПЕРВОМ `null`, а цикл перед снимком
 * удара сердца кэш сбрасывает сам.
 */
export function wardenRound(home, task, { now = Date.now(), knock = null, sessions = null } = {}) {
  return supervisorRound(home, task, { now, sessions, registry: knockRegistry(knock) });
}

/**
 * Стоп участников: свежие пишутся в журнал, postcard не шлётся. Адресат видимости —
 * owner задачи: участнику докладывать не о ком.
 */
export async function reportStalls(home, task, { sessions = undefined, now = Date.now() } = {}) {
  const fresh = await stallRound(home, task, {
    now,
    sessions: sessions === undefined ? snapshotOf(readTask(home, task).participants) : sessions,
  });
  return fresh.map((s) => stallLine(s, task));
}

// Пробуждение по `fs.watch` поверх опроса: событие приходит за миллисекунды, а опрос
// подстраховывает — на сетевых и виртуальных ФС `fs.watch` события теряет молча.
function watchInboxes(home, task, addrs) {
  const watchers = [];
  let wake = null;
  for (const addr of addrs) {
    try {
      const dir = inboxDir(home, task, addr);
      mkdirSync(dir, { recursive: true });
      const w = watch(dir, () => {
        const f = wake;
        wake = null;
        if (f) f();
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch {
      // остаётся опрос
    }
  }
  return {
    addrs: [...addrs].sort().join(','),
    next(ms) {
      return new Promise((resolve) => {
        const t = setTimeout(() => {
          wake = null;
          resolve();
        }, ms);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    },
    close() {
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // закрывать нечего
        }
      }
    },
  };
}

// Поднять надзирателя отдельным процессом — отвязанным (`detached` + `unref`) и без
// потоков: он обязан пережить команду, которая его завела, вплоть до Stop-хука, живущего
// доли секунды. Окружение чистится от идентичности шины и contact point'а родителя.
function wardenArgv(host, task) {
  const node = host?.nodePath?.() ?? process.execPath;
  const bin = host?.binPath?.() ?? process.argv[1];
  return { node, argv: [bin, 'warden', '--task', task] };
}

function launchWarden(home, task, env, host) {
  const clean = { ...env, PROMPTOBUS_HOME: home };
  delete clean.PROMPTOBUS_ROLE;
  delete clean.PROMPTOBUS_TASK;
  delete clean.CLAUDE_CODE_MESSAGING_SOCKET;
  delete clean.CLAUDE_CODE_MESSAGING_TOKEN;
  const { node, argv } = wardenArgv(host, task);
  const child = spawn(node, argv, {
    detached: true,
    stdio: 'ignore',
    env: clean,
  });
  child.unref();
  return child.pid ?? null;
}

// След автоподъёма для набора тестов. Журнал надзирателя не годится: он лежит внутри
// песочницы, которую тест сносит за собой. Путь — переменная `PROMPTOBUS_WARDEN_TRACE` (её
// ставит раннер). Пишем в точке решения «поднимаем», а не внутри отвязанного процесса:
// запись синхронна с запрещённым действием, и гейт раннера читает готовый файл.
function traceLaunch(env, line) {
  const file = env?.PROMPTOBUS_WARDEN_TRACE;
  if (!file) return;
  try {
    appendFileSync(file, `${line}\n`);
  } catch {
    // След — диагностика набора, и отказ записи не повод валить подъём надзирателя
  }
}

// Выключатель автоподъёма: `PROMPTOBUS_WARDEN=off`. Нужен набору тестов — без него команды
// шины в песочнице поднимали отвязанные процессы, стучавшиеся в сессию разработчика по
// адресам из фикстур. Выключается только АВТОподъём: сообщения тогда лежат в mailbox'ах,
// пока участник не позовёт `mailbox` сам.
export function wardenOff(env = process.env) {
  return String(env.PROMPTOBUS_WARDEN ?? '').trim().toLowerCase() === 'off';
}

// «Надзиратель жив? Нет — подними». Зовут команды, которые и так ходят по шине: guard
// (на каждом завершении хода — главный оживитель), spawn, review и MCP-сервер.
// `promptobus status` не зовёт: команда только читает. Молчит на любой неожиданности: страховка
// не вправе уронить spawn или ход сессии.
export function ensureWarden(home, task, { env = process.env, launch = launchWarden, host = null } = {}) {
  try {
    if (wardenOff(env)) return null;
    if (liveWarden(home, task)) return null;
    if (readTask(home, task).status !== 'active') return null;
    const pid = launch(home, task, env, host);
    traceLaunch(env, `${new Date().toISOString()} автоподъём надзирателя · задача ${task} · pid ${pid ?? '?'}`);
    return pid;
  } catch {
    return null;
  }
}

// Сам процесс. Запускается `<commandName> warden --task <id>`; корня рабочего места ему
// не нужно — home и задача приходят через окружение и флаг.
export async function warden(opts = {}, env = process.env, cwd = process.cwd()) {
  const host = opts.host ?? null;
  const identity = resolveIdentity(env, cwd, { host });
  const home = identity.home;
  const task = resolveTaskId(home, opts.task?.trim() || identity.declaredTask, identity.session);
  const cli = host?.version ?? '0.0.0';
  bus(home, { cli });

  // Место занимается «первым выигрывает» под локом задачи: иначе два стука на сообщение.
  const claimed = claimWarden(home, task, { cli, session: sessionIdentity() });
  if (claimed.busy) {
    warn(`надзиратель задачи ${task} уже работает: pid ${claimed.busy.pid}, удар сердца ${claimed.busy.beat}`);
    return;
  }
  ok(`надзиратель задачи ${task}: pid ${process.pid} · CLI ${cli}`);
  logWarden(home, task, `надзиратель поднят · pid ${process.pid} · CLI ${cli}`);

  const startedMs = Date.now();
  const addrsOf = () => (readTask(home, task).participants ?? []).map((p) => addressOf(p)).filter(Boolean);
  let watcher = watchInboxes(home, task, addrsOf());
  let lastBeat = Date.now();
  // Снимок сессий берётся раз в удар сердца и держится между кругами НАМЕРЕННО: круг идёт
  // раз в секунду, а каждый снимок — запуск процесса опроса harness'а. Свежести до
  // WARDEN_BEAT_SEC хватает обоим читателям — докладу о вставших и порогу перестука в
  // KNOCK_RETRY_SEC; «улучшать» это опросом на каждом круге не надо.
  //
  // `undefined` — «ещё не снимали»: первый снимок делает первый же круг, ВНУТРИ охраны
  // (замечание ревью). Отказ здесь до неё уносил бы процесс мимо `finally` — то есть без
  // снятия отметки и без строки в журнале, — а следующая команда шины поднимала бы
  // надзирателя в ту же смерть. `null` от снимка — законное состояние, оно не переснимается.
  let sessions;
  let why = null;
  // Умереть исключением надзиратель не вправе: `stdio` у него `ignore`, стек уехал бы в
  // никуда, и run просто перестал бы доставлять — тихо.
  let failures = 0;
  try {
    for (;;) {
      try {
        if (sessions === undefined) sessions = snapshotOf(readTask(home, task).participants);
        const tick = await supervisorRound(home, task, { sessions, registry: REGISTRY });
        if (tick.stop) {
          why = tick.stop;
          break;
        }
        if (Date.now() - lastBeat >= WARDEN_BEAT_SEC * 1000) {
          lastBeat = Date.now();
          forgetSessions();
          sessions = snapshotOf(readTask(home, task).participants);
          // Стоп в журнал — ДО вердикта: последний стоп задачи виден ровно на том круге,
          // где `beatRound` решает выйти, и после вердикта он не попал бы в журнал.
          for (const line of await reportStalls(home, task, { sessions })) {
            logWarden(home, task, line);
          }
          why = beatRound(home, task, startedMs, { sessions, session: sessionIdentity() });
          if (why) break;
          // Состав участников меняется по ходу run'а — наблюдатели пересобираются на ударе.
          const addrs = addrsOf();
          if ([...addrs].sort().join(',') !== watcher.addrs) {
            watcher.close();
            watcher = watchInboxes(home, task, addrs);
          }
        }
        failures = 0;
      } catch (e) {
        failures += 1;
        logWarden(home, task, `круг присмотра отказал (${failures}/${ROUND_FAIL_LIMIT}): ${e.message}`);
        if (failures >= ROUND_FAIL_LIMIT) {
          why = `круг присмотра отказал ${failures} раза подряд: ${e.message}`;
          break;
        }
      }
      await watcher.next(TICK_MS);
    }
  } finally {
    watcher.close();
    try {
      clearWarden(home, task, process.pid, { session: sessionIdentity() });
    } catch {
      // Отметка переживёт процесс, но живой её никто не сочтёт: живость читается по pid.
    }
  }
  logWarden(home, task, `надзиратель вышел · ${why}`);
  info(`надзиратель задачи ${task} вышел: ${why}`);
}
