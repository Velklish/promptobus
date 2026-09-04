import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ok, info, warn, fail, shellQuote } from './util.js';
import { hostOf } from './host.js';
import {
  addressOf, claimRoute, closeTask, foreignTaskLine, isAddress, listTasks,
  ORCHESTRATOR, ownership, participantDirs, participantMcpPath, patchTask, readTask, resolveTaskId,
  sessionIdentity,
  sweepBindings, wakeFile,
} from './store.js';
import { inspectWorktree, pruneWorktrees, removeWorktree, worktreeDisposition } from './worktree.js';
import { sweepJournals } from './prune.js';
import {
  driverFor, harnessOf, isManaged, snapshotSessions, stopParticipant,
} from '../dist/index.js';
import { driverOrLift, forgetSessions, liftDriver, REGISTRY, snapshotOf } from './drivers.js';
import { participantSession } from './status.js';

// Закрытие задачи и уборка за ней. Метёт команда все ЗАКРЫТЫЕ задачи, а не только что
// закрытую: сессии переживают своё `done`, и каталог из-под живого worker'а не
// уезжает — следующее закрытие приберёт за предыдущим. Живость участника спрашивается
// тем же предикатом, которым её называет `promptobus status`.

// Каталог worktree — полная копия репозитория, и оставленный он бьёт не по диску, а по
// поиску: шесть копий в клоне — каждый файл в grep семь раз. Снимается только доказанно
// безлюдное (решает worktreeDisposition), оставленное объясняется вслух. Ветку берём у
// git, а не из журнала: записанная spawn'ом могла устареть.

// Отметка «за задачей прибрано» — read-modify-write под локом, как `closeTask`.
function markWorktreesSwept(home, id) {
  try {
    patchTask(home, id, { adapter: { worktreesSwept: new Date().toISOString() } });
  } catch {
    // Занятый лок — один лишний обход в следующий раз, а не повод валить `promptobus done`.
  }
}

/**
 * Погасить managed-сессии закрытой задачи. Сессию, которую поднял механизм, он
 * же и закрывает: до этой задачи её гасил человек руками (`claude stop <id>` на приёмке),
 * и цена отсрочки была двойная — на машине копились живые сессии, а уборка worktree за
 * живой сессией не идёт вовсе, потому что каталог уехал бы из-под её `cwd`.
 *
 * Гасятся только `managed` с живой сессией: owner задачи сессии за собой не имеет вовсе, а
 * `attached` driver не поднимал и распоряжаться ею не вправе. Отказ одного участника обход
 * не прерывает — назван вслух и идём дальше: это тот же обход после закрытия задачи, из
 * которого нельзя бросать.
 *
 * `registry` — шов набора: подставной driver считает вызовы, не трогая живого `claude`.
 * `snapshot` — второй шов, функция по участникам: его подаёт `done`, чтобы вся
 * команда была герметична одним аргументом; без него снимок собирается тем же `registry`.
 */
export async function stopManaged(home, id, { registry = REGISTRY, snapshot = null } = {}) {
  let meta;
  try {
    meta = readTask(home, id);
  } catch {
    return { stopped: 0, idle: 0, failed: 0, unconfirmed: 0 };
  }
  const participants = meta.participants ?? [];
  // Снимок собирается ТЕМ ЖЕ registry, что и гасит (замечание ревью): половинчатый шов
  // подпирал бы живость подменой бинаря, и подставной driver в наборе оставался бы мёртвой
  // фикстурой — проверялось бы поведение настоящего `claude`, а не обход.
  const sessions = snapshot ? snapshot(participants) : snapshotSessions(participants, registry);
  // Слова про сессию — у driver'а, и берётся он из ТОГО ЖЕ registry, которым гасят: шов
  // набора подменяет карту целиком, и вторая карта для строк развела бы их между собой.
  // Откат на driver подъёма — тот же, что у двери (`driverOrLift`): обход идёт ПОСЛЕ
  // закрытия задачи, и отказ отсюда унёс бы с собой остальных участников.
  const driverAt = (p) => {
    try {
      return driverFor(registry, harnessOf(p, registry));
    } catch {
      return liftDriver();
    }
  };
  const targets = participants.filter((p) => isManaged(p)
    // Живость спрашивается тем же предикатом, что и вся уборка: мёртвую гасить нечего, а
    // неизвестную — тем более, у неё и состояние-то не разобрано.
    && participantSession(p, sessions) === 'alive');
  if (!targets.length) return { stopped: 0, idle: 0, failed: 0, unconfirmed: 0 };
  // Перечень называется ДО первого гашения: команда необратима, и человек, читающий вывод,
  // видит, что сейчас будет закрыто, а не узнаёт об этом задним числом.
  info(`гашу сессии участников (${targets.length}): ${targets.map((p) => addressOf(p)).join(', ')}`);
  let stopped = 0;
  let idle = 0;
  let failed = 0;
  // Четвёртый исход, а не оттенок третьего (замечание ревью): команда гашения
  // отработала, а подтвердить, что сессии не стало, driver не смог — потолок ожидания
  // вышел либо реестр после стопа не разобран. Печатать это как «гасить не пришлось»
  // значило бы отрицать первую половину строки второй: гасить как раз пришлось, не
  // подтвердилось. Различает их поле `attempted` исхода: без него `stopped: false`
  // означает «сессии не было ещё до команды».
  let unconfirmed = 0;
  for (const p of targets) {
    try {
      // Исход гашения `await`'ится: driver вправе дождаться, пока сессии у harness'а не
      // станет, и без ожидания уборка ниже пошла бы по состоянию, которого ещё
      // нет. Обход остаётся последовательным — гасим по одному, как и печатали перечень.
      const r = await stopParticipant(p, registry);
      if (!r?.ok) {
        failed += 1;
        warn(`сессию участника ${addressOf(p)} закрыть не удалось: ${r?.note ?? 'причина неизвестна'}`
          + ` — закрой её сам из ${driverAt(p).phrases.sessions}, иначе её worktree останется на месте`);
      } else if (r.stopped) {
        stopped += 1;
        ok(`сессия участника ${addressOf(p)} закрыта: ${r.note}`);
      } else if (r.attempted) {
        // Гашение пошло, а подтвердить его нечем. Уровень тревожный: каталог worktree
        // этого участника обход оставит — сессия для него не мертва, — и человеку это
        // надо видеть строкой, а не выводить из молчания.
        unconfirmed += 1;
        warn(`гашение сессии участника ${addressOf(p)} не подтвердилось: ${r.note}`
          + ` — её worktree останется на месте; закрой сессию сам из ${driverAt(p).phrases.sessions}`);
      } else {
        // Успех без гашения — свой исход: сессия исчезла между снимком и вызовом. Печатать
        // его как «закрыта» значило бы утверждать то, чего механизм не делал.
        idle += 1;
        info(`сессию участника ${addressOf(p)} гасить не пришлось: ${r.note}`);
      }
    } catch (e) {
      failed += 1;
      warn(`сессию участника ${addressOf(p)} закрыть не удалось: ${e.message}`);
    }
  }
  return { stopped, idle, failed, unconfirmed };
}

function sweepWorktrees(home, snapshot, host) {
  const prune = new Set();
  for (const meta of listTasks(home)) {
    if (meta.status !== 'done') continue;
    // Прибранная полностью задача второй раз не обходится: без отметки стоимость уборки
    // росла бы с историей run'ов. Отметка ставится, только когда после обхода не осталось
    // ни одного каталога; всё оставленное переинспектируется.
    if (meta.adapter.worktreesSwept) continue;
    // Снимок сессий берётся по участникам ЭТОЙ задачи: он ключуется адресом, а один адрес
    // живёт в разных задачах разными сессиями. Стоит он опроса driver'а, поэтому снимается
    // ПОСЛЕ отсечки прибранного (замечание ревью) — иначе прибранная задача платила бы за
    // него на каждом `done`. Запусков внешнего опроса это не добавляет: реестр сессий
    // помнит удачный разбор до сброса (liftoff.js).
    const sessions = snapshot(meta.participants);
    let left = 0;
    for (const p of meta.participants ?? []) {
      const { worktree, repoAbs } = p.metadata;
      if (!worktree || !repoAbs) continue;
      // Каталога нет — регистрация в .git/worktrees могла осиротеть. Репозиторий метём
      // один раз, а не на каждого участника.
      if (!existsSync(worktree)) { prune.add(repoAbs); continue; }
      // `git worktree remove` смотрит на грязь и lock, но не на процессы: каталог уехал бы
      // из-под работающей сессии, чей cwd в нём. Неизвестное состояние — тоже не трогаем,
      // той же логикой, что переревью в review.js.
      const state = participantSession(p, sessions);
      if (state !== 'dead') {
        info(`worktree ${worktree} оставлен: сессия участника ${state === 'alive' ? 'ещё жива' : 'неизвестна'}`
          + ` — закрой её из ${driverOrLift(p).phrases.sessions}, уберётся при следующем promptobus done`);
        left += 1;
        continue;
      }
      const info_ = inspectWorktree(repoAbs, worktree, host.defaultBranch(repoAbs));
      const { action, reason } = worktreeDisposition(info_);
      if (action === 'keep') {
        info(`worktree ${worktree} оставлен: ${reason}`);
        left += 1;
        continue;
      }
      const r = removeWorktree(repoAbs, worktree, info_.branch);
      if (r.removed) {
        ok(`worktree ${worktree} убран (${reason})${r.branchDeleted ? `, ветка ${info_.branch} удалена` : ''}`);
        if (r.branchKept) info(`ветка ${r.branchKept} оставлена: её завёл не spawn — удалять чужую ветку не наше дело`);
        if (r.branchStuck) {
          info(`ветка ${r.branchStuck} оставлена: git -d не считает её слитой (так бывает после squash-мержа).`
            + ` Удалить: git -C ${shellQuote(repoAbs)} branch -D ${shellQuote(r.branchStuck)}`);
        }
      } else {
        warn(`worktree ${worktree} убрать не вышло: ${r.error ?? 'git не объяснил'}`);
        left += 1;
      }
    }
    if (!left) markWorktreesSwept(home, meta.id);
  }
  for (const repoAbs of prune) pruneWorktrees(repoAbs);
}

// Уборка mcp-конфигов закрытых задач: в конфиге участника подставленные токены, и без
// уборки файл на каждого участника копился бы в `workers/` навсегда. Только у мёртвой
// сессии: переживший `--resume` участник поднимается по тому же пути, и снятый из-под
// живого файл оставил бы его без шины.
//
// Contact point — второй секрет задачи (токен messaging-сокета). Убирается у ВСЕХ
// адресов и без оглядки на живость: закрытой задаче стучаться некому.
function sweepParticipantSecrets(home, snapshot) {
  for (const meta of listTasks(home)) {
    if (meta.status !== 'done') continue;
    // Снимок — по участникам этой задачи, по той же причине, что и у обхода worktree.
    // Второй снимок на задачу — не второй опрос harness'а: разбор `claude agents --json`
    // помнится до `resetBgSessionsCache()` ниже, и `inspect` идёт по списку в памяти. Замер
    //  (2026-09-02, дом с 20 закрытыми задачами по 3 участника с сессиями): запусков
    // `claude` за весь `done` — 1, второй снимок на 20 задач — 0,06 мс CPU. Передавать снимок из
    // обхода worktree сюда незачем: экономить нечего, а общий аргумент связал бы две независимые
    // уборки.
    const sessions = snapshot(meta.participants);
    for (const p of meta.participants ?? []) {
      const addr = addressOf(p);
      if (!addr) continue;
      // Негодный адрес записи обход не обрывает. Уборка идёт ПОСЛЕ закрытия задачи, и
      // брошенный отсюда отказ уносил с собой и остальных участников этой задачи, и все
      // следующие закрытые задачи, и `sweepBindings` за ними: на диске оставались токены
      // сессий, а починить это было нечем — запись из журнала не исчезает, и так повторялось
      // на каждом закрытии в этом доме. Тем же приёмом, что счётчик непрочитанного в
      // `promptobus status`: назвать вслух и идти дальше.
      if (!isAddress(addr)) {
        warn(`участник «${addr}» в задаче ${meta.id} пропущен: адрес записи негоден`
          + ' (ожидается orchestrator, worker:<slug> или reviewer:<slug>) — contact point и mcp-config'
          + ' под ним остались на диске, а в них токены сессии. Поправь адрес в'
          + ` ${path.join(home, 'tasks', meta.id, 'task.json')}`);
        continue;
      }
      const wake = wakeFile(home, meta.id, addr);
      if (existsSync(wake)) {
        rmSync(wake, { force: true });
        info(`contact point ${addr} убран (${wake}) — в нём токен сессии, а задача закрыта`);
      }
      if (addr === ORCHESTRATOR) continue;
      const file = participantMcpPath(home, meta.id, addr);
      const dirs = participantDirs(home, meta.id, addr);
      if (!existsSync(file) && !dirs.length) continue;
      if (participantSession(p, sessions) !== 'dead') continue;
      if (existsSync(file)) {
        rmSync(file, { force: true });
        info(`mcp-config ${addr} убран (${file}) — в нём подставленные токены, а сессия участника мертва`);
      }
      // Каталоги участника, заведённые driver'ом: у Cursor в них лежит рабочее
      // место reviewer'а, а в нём — тот же конфиг MCP с подставленными токенами. Driver'а
      // уборка не спрашивает: каталоги узнаются по стеблю адреса, и у harness'а, который их
      // не заводит, перечень пуст.
      for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true });
        info(`рабочее место ${addr} убрано (${dir}) — в нём конфиг MCP с токенами, а сессия участника мертва`);
      }
    }
  }
}

export async function done(rootOrHost, opts = {}) {
  const host = hostOf(rootOrHost);
  const root = host.workspaceRoot();
  const task = opts.task;
  // Кебабный ключ читается своим именем: `agents.js` отдаёт сюда весь объект `values`,
  // и перевод на шве тут не нужен ([reference/10](../../../docs/reference/10-validation.md)).
  const keepSessions = Boolean(opts['keep-sessions']);
  // Снимок сессий — швом набора, как `sessions` у `status` и `wardenRound`: без него
  // обходы спрашивали бы живой `claude agents --json` машины прогона, и проверки уборки
  // держались бы на подмене PATH. Здесь шов — функция по участникам, а не готовый снимок:
  // обходы снимают состояние на КАЖДУЮ закрытую задачу, потому что снимок ключуется адресом,
  // а один адрес живёт в разных задачах разными сессиями.
  const snapshot = typeof opts.snapshot === 'function' ? opts.snapshot : snapshotOf;
  const home = host.promptobusHome();
  const id = resolveTaskId(home, task);
  // Гейт владельца: без него чужая сессия закрывала бы живой чужой run — уборка метёт
  // каталоги закрытых задач, включая те, работу из которых никто не принимал. Явный
  // `--task` пропуском НЕ служит — в отличие от spawn'а и ревью: те подсаживают track, этот
  // run заканчивает. Отказ печатает `fail()`, а не бросок: верхний catch CLI
  // печатает `e.stack`, и законный отказ приезжал бы признаком внутренней поломки CLI. Те
  // же слова и код возврата, что у `promptobus dismiss`.
  const own = ownership(home, id, ORCHESTRATOR, sessionIdentity());
  if (own.gated) {
    fail(`${foreignTaskLine(readTask(home, id), own)}: run заканчивает его владелец. `
      + 'promptobus done снимает задачу с активных и метёт каталоги worktree закрытых задач — чужой рукой '
      + 'это обрывает живую работу. Явный --task пропуском здесь не служит: spawn и ревью им '
      + `подсаживают track, а этот закрывает run. ${claimRoute('promptobus done')}`);
  }
  closeTask(home, id);
  ok(`задача ${id} закрыта — переписка остаётся в ${path.join(home, 'tasks', id)}`);
  // Реестр сессий сбрасывается один раз на всю уборку: дальше обходы читают один и тот же
  // разобранный список, а снимок собирают каждый по своей задаче.
  forgetSessions();
  // Сессии гасятся ДО уборки worktree и не позже: `git worktree remove` не смотрит на
  // процессы, и каталог уехал бы из-под живой сессии, чей `cwd` в нём стоит. Погашены —
  // значит слитые worktree снимаются тем же ходом, а не «при следующем promptobus done».
  //
  // `--keep-sessions` — выключатель необратимого действия (решение оркестратора):
  // задача закрывается, сессии остаются жить. Уборка каталогов за живой сессией тогда не
  // идёт — про это она скажет сама, своей строкой по каждому оставленному каталогу.
  if (keepSessions) {
    const lifter = liftDriver();
    info('--keep-sessions: сессии участников оставлены живыми — закрой их сам из '
      + lifter.phrases.sessions);
  } else {
    const stop = await stopManaged(home, id, { snapshot });
    if (!stop.stopped && !stop.idle && !stop.failed && !stop.unconfirmed) {
      info(`гасить нечего: живых сессий, поднятых механизмом, в задаче ${id} не осталось`);
    }
    // Состояние сессий обход берёт ЗАНОВО — уже после гашения. Реестр driver'а
    // помнит разобранный список до сброса, и снимок, снятый ДО гашения, показал бы уборке
    // только что погашенные сессии живыми: каталоги остались бы на месте с честной, но
    // неверной причиной «сессия ещё жива». Сброс стоит под условием, а не безусловно:
    // гасить было нечего — список не менялся, и лишний опрос harness'а стоил бы запуска
    // процесса на каждом `promptobus done` (счёт запусков там же).
    if (stop.stopped || stop.unconfirmed) forgetSessions();
  }
  sweepWorktrees(home, snapshot, host);
  sweepParticipantSecrets(home, snapshot);
  // Привязки, потерявшие живость вместе с задачей (ADR-027). Механизму они не мешают —
  // `liveBinding` мёртвую не отдаёт, — но каталог рос бы файлом на сессию за run.
  const dropped = sweepBindings(home);
  if (dropped) info(`привязок сессий снято: ${dropped} — их задачи закрыты`);
  // Журналы ДАВНО закрытых задач — та же уборка, что у `prune --yes`, порогом по умолчанию
  // (решение владельца 2026-09-02). Только что закрытая под неё не попадает ни при
  // каком вызове: ей от роду секунды. Идёт последней — после гашения сессий и после обхода
  // worktree: обход читает журналы всех закрытых задач, и снеси их раньше, каталог остался
  // бы сиротой без имени.
  //
  // Отказ уборки закрытие не откатывает: `done` уже сделал своё, а обратного хода у него
  // нет. Права на каталог, занятый лок, нечитаемая запись — это предупреждение с маршрутом,
  // а не отказ команды.
  try {
    sweepJournals(home);
  } catch (e) {
    warn(`журналы давно закрытых задач не убраны (${e.message}) — задача ${id} закрыта, `
      + `это её не отменяет. Убрать руками: ${host.busCommand(['prune', '--yes'])}`);
  }
}
