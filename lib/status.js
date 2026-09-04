import { existsSync } from 'node:fs';
import path from 'node:path';
import { ok, info, warn } from '../util.js';
import {
  promptobusHome, activeTasks, addressOf, countInbox, foreignTaskLine, listTasks, liveWarden,
  ORCHESTRATOR, ownership, readHealth, readTask, readWake, sameOwnerSession, sessionIdentity,
  taskOwner, WARDEN_BEAT_SEC, tailWardenLog,
} from './store.js';
import {
  blockedParticipants as blockedIn, justSpawned, liveParticipant, stallStands,
} from '../../packages/promptobus/dist/index.js';
import { branchLine, worktreeBranch } from './worktree.js';
import { driverOrLift, liftDriver, snapshotOf, stallRouteOf } from './drivers.js';
import { stallLine as lineOf } from './stalls.js';

// Состояние участников шины: как его назвать человеку и напечатать. Предикаты — стоп,
// занятость, живость, отметка доложенного — переехали в package (`BL-408`,
// [supervisor.ts](../../packages/promptobus/src/supervisor.ts)): печать `promptobus status`,
// доклад надзирателя о вставших и строки в ответах инструментов обязаны говорить о стопе
// одно, а не два разных совета об одном состоянии, и держится это тем, что предикат один.
//
// Здесь остаётся адаптер: снимок сессий берётся у driver'а через registry, слова состояния
// («встал», «ЧИСЛИТСЯ», «ИСЧЕЗ») — из общего листа [stalls.js](stalls.js), а МАРШРУТ по
// стопу приходит строкой от driver'а того участника, чьё состояние и разобрано (`BL-466`).
// Имени harness'а этот файл не знает вовсе — ни одного.

// Предикаты машины состояний — дверь для остального механизма: `server.js` берёт отсюда
// `blockedParticipants`, `stallLine` и `stallTail`, набор — остальное. Форма снимка у них
// одна, и умолчание у него тоже одно — снимок этого CLI.
export {
  commitStalls, pendingStalls, sessionBusy, stallStands, justSpawned, SPAWN_GRACE_SEC,
} from '../../packages/promptobus/dist/index.js';
export { stallTail } from './stalls.js';

/**
 * Строка о вставшем участнике: слова состояния — общие ([stalls.js](stalls.js)), маршрут —
 * у driver'а этого участника. Сигнатура прежняя, `(запись стопа, задача)`: её зовут
 * `server.js` и доклад надзирателя, и знать про registry им незачем.
 */
export function stallLine(s, task) {
  return lineOf(s, stallRouteOf(s, task));
}

/**
 * Участники задачи, от которых сообщений ждать нечего. Сигнатура та же, что была до выноса:
 * четвёртым аргументом идёт снимок сессий, и умолчание собирает его сам — трёхаргументный
 * вызов (`stallNote` MCP-сервера) работает как работал.
 */
export function blockedParticipants(home, task, participants, sessions = snapshotOf(participants)) {
  return blockedIn(home, task, participants, sessions);
}

/**
 * Состояние сессии участника: `alive` | `dead` | `unknown`. Умолчание снимает состояние
 * ровно по одному участнику: снимок собирается по перечню, а этому вопросу перечень не
 * нужен. Той же сверкой живёт переревью (promptobus/review.js).
 */
export function participantSession(participant, sessions = snapshotOf([participant])) {
  return liveParticipant(participant, sessions);
}

export const WARDEN_MARK = 'НАДЗИРАТЕЛЯ НЕТ';

export function wardenLine(home, id) {
  const lifter = liftDriver();
  const mark = liveWarden(home, id);
  if (!mark) {
    return {
      alive: false,
      line: `${WARDEN_MARK}: слушателя mailbox'ов задачи нет — участник узнает о сообщении, `
        + 'только когда сам позовёт mailbox. Поднимет его любая команда шины: состояние надзирателя лежит в сторе '
        + `задачи, терять при перезапуске нечего. Поднять руками: ati-agents promptobus warden --task ${id}`,
    };
  }
  return {
    alive: true,
    line: `надзиратель: жив (pid ${mark.pid}${mark.cli ? `, CLI ${mark.cli}` : ''}, удар сердца ${mark.beat}, `
      // Версию, на которой проверен канал, называет driver: числа этого harness'а знает он.
      + `период ${WARDEN_BEAT_SEC} с) · инъекция проверена на ${lifter.id} ${lifter.options.provenVersion}`,
  };
}

// Сокет оркестратора пропал: файл снят либо надзиратель уже записал ENOENT.
// «не принимает» status не зондирует — команда только читает, hang на connect ей нельзя.
// knockError липкий: сбрасывается только на удавшемся стуке, а стук идёт лишь при
// непрочитанном. После claim с пустым mailbox'ом верить старому ENOENT нельзя — он про
// прежнего владельца. Доверяем ему, только когда wake ещё про текущего владельца и
// попытка не старше contact point'а.
export function orchestratorSocketGone(wake, h, owner) {
  const aboutOwner = !wake?.session || !owner || sameOwnerSession(wake.session, owner);
  if (wake?.socket && !existsSync(wake.socket) && aboutOwner) return true;
  if (h.knockError !== 'ENOENT' || !aboutOwner) return false;
  if (wake?.at && h.triedAt && h.triedAt < wake.at) return false;
  return true;
}

export function orchestratorDeadLine(owner, since) {
  return `владелец ${owner} мёртв с ${since} — преемник в том же корне забирает mailbox claim`;
}

// Чем надзиратель будит участника и молчит ли тот дольше порога — вся видимость эскалации.
function wakePart(home, id, addr) {
  const parts = [];
  const wake = readWake(home, id, addr);
  const h = readHealth(home, id)[addr] ?? {};
  if (addr === ORCHESTRATOR && orchestratorSocketGone(wake, h, taskOwner(home, id))) {
    const owner = taskOwner(home, id) ?? 'никем';
    const since = h.triedAt ?? h.since ?? wake?.at ?? 'неизвестно';
    // Не «self-wake»: будить оркестратора нечем, а преемник в корне иначе не видит
    // маршрута, пока сам не позовёт mailbox.
    parts.push(orchestratorDeadLine(owner, since));
  } else if (h.channel === 'self-wake' || !wake?.socket) {
    // Причина называется как есть, а не фразой журнала «<канал> не принял notification»:
    // откатов теперь два, и второй — перехваченный чужой сессией contact point (`BL-469`),
    // где канал доставки ни при чём. Журнал называет канал driver'а (`сокет` у Claude Code,
    // `inject` / `rpc` у остальных); строка эта — единственное место, где отказ гейта
    // виден человеку без чтения журнала.
    parts.push(`будильник: self-wake${h.knockError ? ` (причина: ${h.knockError})` : ''}`);
  } else {
    // `socket` в health — тот же транспорт, который строка давно зовёт «сокет». Другое
    // значение канала печатается как есть: contact point у inject/rpc полем `socket`
    // тоже называется, но messaging-сокетом не является.
    const label = !h.channel || h.channel === 'socket' ? 'сокет' : h.channel;
    parts.push(`будильник: ${label} сдан ${wake.at}${h.knocks ? `, стуков ${h.knocks}` : ''}`);
  }
  if (h.escalatedAt) parts.push(`МОЛЧИТ с ${h.since} (эскалировано ${h.escalatedAt})`);
  return parts;
}

// Шапка негодной записи участника. Цитируется прозой дословно, поэтому живёт константой:
// цитату сверяет с ней гейт contract quote (ключ `mailbox-unread-mark` в lint.js).
export const MAILBOX_UNREAD_MARK = 'MAILBOX НЕ ПРОЧИТАН';

// Счётчик непрочитанного — под try/catch: `addrDir` на неизвестном адресе бросает, и одна
// испорченная запись уносила бы весь `promptobus status`. Негодную называем вслух и идём дальше.
function unreadPart(home, id, addr) {
  try {
    return `непрочитано ${countInbox(home, id, addr)}`;
  } catch (e) {
    return `${MAILBOX_UNREAD_MARK}: адрес записи негоден (${e.message})`;
  }
}

export function status(root, { task, sessions = undefined } = {}) {
  const home = promptobusHome(root);
  const tasks = task ? [readTask(home, task)] : activeTasks(home);
  if (!tasks.length) {
    const all = listTasks(home);
    ok(`активных задач нет${all.length ? ` (всего в журнале: ${all.length})` : ''}`);
    return;
  }
  const session = sessionIdentity();
  for (const meta of tasks) {
    // Снимок берётся по перечню участников этой задачи: за ним стоит опрос harness'а, и
    // один снимок на задачу дешевле опроса на участника.
    //
    // Аргументом он приходит швом — тем же, что у `wardenRound` и `reportStalls`
    // ([warden.js](warden.js)): без него печать спрашивала бы живой `claude agents --json`
    // машины прогона, и проверки команды зависели бы от сессий человека, запустившего
    // набор (`BL-419`). Поданный снимок — на ВЕСЬ вызов, а не на задачу: `status` без
    // `--task` печатает все активные, а адреса участников у разных задач совпадают.
    // Умолчание отличает `undefined` («снимка не подали — сними сам») от `null` («список не
    // разобран»): `null` — законное состояние снимка, и переснимать его нельзя, иначе
    // строка «состояние сессии неизвестно» была бы недостижима.
    const snap = sessions === undefined ? snapshotOf(meta.participants) : sessions;
    ok(`${meta.id} · ${meta.title} · ${meta.status}`);
    // Чужая задача. Гейта нет: `status` только читает. Молчать нельзя — сессия,
    // подхватившая чужую задачу резолвом «единственной активной», читает её как свою.
    const own = ownership(home, meta.id, ORCHESTRATOR, session);
    if (own.gated) warn(`${foreignTaskLine(meta, own)} — эта сессия смотрит чужой run.`);
    // Надзиратель — до перечня участников: его смерть объясняет молчание строк ниже.
    const wdn = wardenLine(home, meta.id);
    if (wdn.alive) info(wdn.line);
    else warn(wdn.line);
    for (const p of meta.participants ?? []) {
      // Поля механизма лежат в `metadata` записи v1: их пишет adapter, он же и читает.
      // Собственные поля v1 — роль, harness, режим, session reference, capabilities.
      const m = p.metadata ?? {};
      const addr = addressOf(p);
      const parts = [addr];
      // Единственное место, где человек сверит, за какой сессией закреплён mailbox.
      if (m.owner) parts.push(`владелец ${m.owner}`);
      if (m.repo) parts.push(m.repo);
      // Путь worktree — аргумент `promptobus review <путь>`; в журнале он и хранится.
      if (m.worktree) parts.push(`worktree ${m.worktree}`);
      // Ветку называет git, а не журнал: worker мог уехать на свою по просьбе брифа.
      if (m.branch || m.worktree) {
        const line = branchLine(m.branch, worktreeBranch(m.worktree));
        if (line) parts.push(line);
      }
      parts.push(unreadPart(home, meta.id, addr));
      try {
        parts.push(...wakePart(home, meta.id, addr));
      } catch {
        // Негодная запись не имеет права уносить строки остальных.
      }
      // Снятие с наблюдения видно здесь и только здесь: без строки молчание докладов
      // неотличимо от поломки надзирателя.
      if (m.dismissed) parts.push(`СНЯТ С НАБЛЮДЕНИЯ ${m.dismissed} — докладов о его сессии не будет`);
      if (m.name) {
        const view = snap?.[addr] ?? null;
        // Слова про сессию — у driver'а этого участника: как называется его реестр и чем
        // смотрят журнал сессии, знает только он. Driver'а по чужому harness'у в карте нет
        // вовсе, и отказ отсюда унёс бы печать остальных участников — берётся дверь с
        // откатом на driver подъёма (`driverOrLift`); строку с его словами такой участник
        // всё равно не получает, его ветка ниже — «спросить о ней некому».
        const driver = driverOrLift(p);
        // Имя сессии называем — оно не совпадает с именем ветки, и без него участника не
        // найти взглядом в реестре сессий harness'а.
        if (snap === null) parts.push(`состояние сессии «${m.name}» неизвестно (${driver.phrases.unreadable})`);
        // Спросить о нём некого: driver'а по его harness'у нет либо тот не смотрит. Это
        // неизвестность, а не «сессии нет»: сессия может быть жива, и говорить о ней
        // «нет в списке» значило бы звать поднимать её заново.
        else if (view?.state === 'unknown') {
          parts.push(`состояние сессии «${m.name}» неизвестно: harness «${p.harness}» — `
            + 'спросить о ней некому');
        } else if (!view || view.state === 'gone') parts.push(`сессии «${m.name}» нет в списке`);
        else if (view.state === 'stale' && justSpawned(p)) {
          // То же окно регистрации: «поднимай заново» на только что поднятом неверно.
          parts.push(`сессия «${m.name}» поднимается — spawn только что, pid ещё не объявлен;`
            + ` состояние будет видно через несколько секунд`);
        } else if (view.state === 'stale') {
          parts.push(`сессия «${m.name}» ЧИСЛИТСЯ, но процесса за ней нет — запись пережила свой демон.`
            + ` Проверь: ${driver.phrases.logs(view.id ?? m.name)}. Сообщений от неё не будет`);
        } else if (stallStands(home, meta.id, p, view.stall)) {
          parts.push(`сессия «${m.name}» ВСТАЛА: ${view.stall.reason} — `
            + stallRouteOf({
              ...view.stall, address: addr, repoAbs: m.repoAbs, harness: p.harness, id: view.id ?? m.name, ref: m.name,
            }, meta.id));
        } else if (view.stall) {
          // Штатный конец хода — обычное состояние участника между ходами (`BL-416`), и
          // своих слов ему нужно ровно потому, что `blocked` тут не признак жизни:
          // прежняя ветка печатала «жива (blocked)» и спорила сама с собой.
          parts.push(`сессия «${m.name}» ход закончила, ждёт сообщения`);
        } else parts.push(`сессия «${m.name}» жива (${view.note ?? 'running'})`);
      }
      info(parts.join(' · '));
    }
    // Хвост журнала надзирателя: строка «МОЛЧИТ» называет факт, но не историю.
    const tail = tailWardenLog(home, meta.id);
    if (tail.length) info(`журнал надзирателя (последние ${tail.length}):\n    ${tail.join('\n    ')}`);
    info(`переписка и артефакты: ${path.join(home, 'tasks', meta.id)}`);
  }
}
