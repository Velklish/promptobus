import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import {
  activeTasks, addrDir, addressOf, boundTaskId, countInbox, foreignSession, foreignSessionOf,
  identityLabel, markTurn, ORCHESTRATOR, ownership, participantOf, readHealth, readTask,
  readWake, resolveIdentity, sameOwnerSession, sessionIdentity, sessionIdOf, sessionOf,
  storePending, taskDir, taskExists, writeJsonAtomic,
} from './store.js';
import { ensureWarden } from './warden.js';
import { driverOrLift } from './drivers.js';
import { GUARD_START_EVENT } from '../dist/hooks.js';

// Сторож цикла шины. Зовёт его Stop-хук layout на КАЖДОМ завершении хода, и предмет один:
// не дать сессии закончить ход в состоянии, из которого её никто не разбудит. Ход,
// кончившийся отчётом человеку без вызова шины, страховок в ответах инструментов не зовёт.

// Своя метка ради узнаваемости в ленте: это не отказ команды, а возврат хода.
export const GUARD_MARK = 'СТОРОЖ ЦИКЛА';

// Сколько раз подряд сторож возвращает ход на ОДНОМ И ТОМ ЖЕ состоянии. Свой потолок нужен
// при потолке Claude Code в 8 подряд (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`): восемь возвратов —
// восемь ходов модели на одно и то же. Два достаточны: первый называет состояние, второй
// ловит ход, начатый мимо него.
export const GUARD_BLOCK_LIMIT = 2;

// Счётчик подряд идущих возвратов — файлом в `waits/` задачи, по файлу на адрес.
export function guardMarkFile(home, task, addr) {
  return path.join(taskDir(home, task), 'waits', `${addrDir(addr)}.guard.json`);
}

// Отметка «этой сессии уже сказали» — в waits/ задачи мёртвого владельца, файл на
// читателя. Общий файл на задачу съедал бы hint у следующей сессии в корне
// (неудачный чат, второй job): настоящий преемник на SessionStart молчал бы.
export function successorMarkFile(home, task, session) {
  const stem = String(session ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-') || 'unknown';
  return path.join(taskDir(home, task), 'waits', `successor.hint.${stem}.json`);
}

function readGuardMark(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Полезная нагрузка события `Stop`: JSON на stdin (`session_id`, `cwd` и другие поля).
// Читать её ОБЯЗАТЕЛЬНО: `CLAUDE_CODE_SESSION_ID` процессу хука ничем не обещана, а без неё
// сторож молча не работал бы, неотличимо от чистого прохода. Окружение остаётся запасным
// путём (ручной запуск нагрузки не несёт). Замер живым хуком 2026-08-29 (claude 2.1.251):
// работают оба пути, обещан один. `isTTY` — гейт против зависания: запущенная руками
// подкоманда ждала бы конца ввода вечно. Всё неразобранное — пустая нагрузка.
async function readEvent(stdin) {
  if (stdin.isTTY) return {};
  try {
    let raw = '';
    stdin.setEncoding('utf8');
    for await (const chunk of stdin) raw += chunk;
    const event = JSON.parse(raw);
    return event && typeof event === 'object' && !Array.isArray(event) ? event : {};
  } catch {
    return {};
  }
}

function said(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Состояние, из-за которого ход возвращать надо, или `null` — «чисто». `key` — признак
// «то же состояние» для счётчика возвратов; в него входит ЧИСЛО сообщений: пришло новое —
// состояние другое, счётчик сбрасывается.
export function guardVerdict(home, task, addr) {
  const unread = countInbox(home, task, addr);
  if (!unread) return null;
  return {
    key: `mailbox:${unread}`,
    reason: `в mailbox'е ${unread} — ход кончается, а сообщения не разобраны: `
      + 'забери их инструментом promptobus_mailbox и ответь по своей роли',
  };
}

// Сколько ждать ответа сокета владельца. Stop-хук живёт доли секунды, и висеть на
// мёртвом пути дольше порога стука нельзя: ENOENT файла отсекается до connect.
const SUCCESSOR_PROBE_MS = 200;

function sameWorkspaceRoot(cwd, home) {
  if (!cwd || !home) return false;
  try {
    return realpathSync(cwd) === realpathSync(path.dirname(home));
  } catch {
    return false;
  }
}

function declaredParticipant(identity) {
  const role = identity?.role;
  return typeof role === 'string' && (role.startsWith('worker:') || role.startsWith('reviewer:'));
}

function holdsSession(participant, session) {
  return Boolean(
    (sessionIdOf(participant) ?? sessionOf(participant))
    && foreignSessionOf(participant, session) === null,
  );
}

// Сессия уже на шине: привязка, владелец mailbox'а или worker/reviewer в журнале.
// Чужой в корне — ещё не преемник, пока сам не сделает claim.
function sessionOnBus(home, session, identity, tasks) {
  if (declaredParticipant(identity)) return true;
  if (!session) return false;
  if (boundTaskId(home, session)) return true;
  for (const meta of tasks) {
    const own = ownership(home, meta.id, ORCHESTRATOR, session);
    if (own.owner && !own.gated) return true;
    for (const p of meta.participants ?? []) {
      const addr = addressOf(p);
      if (!addr || addr === ORCHESTRATOR) continue;
      if (holdsSession(p, session)) return true;
    }
  }
  return false;
}

// Contact point мёртв, только если сокет сдан и его нет либо он не принимает.
// Нет записи — владелец мог просто ещё не кончить первый ход, это не смерть.
// Connect — только когда файл есть, а id в wake не совпадает с владельцем: у живого
// владельца harness получил бы соединение без auth на каждом конце хода каждой
// сессии в корне, а реакция на это не замерена.
export function probeContactPoint(socketPath, timeoutMs = SUCCESSOR_PROBE_MS) {
  return new Promise((resolve) => {
    if (!socketPath) {
      resolve({ dead: false, error: null });
      return;
    }
    if (!existsSync(socketPath)) {
      resolve({ dead: true, error: 'ENOENT' });
      return;
    }
    let settled = false;
    const done = (dead, error) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* закрывать нечего */ }
      resolve({ dead, error });
    };
    let sock;
    try {
      sock = createConnection(socketPath);
    } catch (e) {
      resolve({ dead: true, error: e.code ?? 'error' });
      return;
    }
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(false, null));
    sock.once('error', (e) => done(true, e.code ?? e.message));
    sock.once('timeout', () => done(true, 'timeout'));
  });
}

function deadSinceOf(home, id, wake) {
  const h = readHealth(home, id)[ORCHESTRATOR] ?? {};
  return h.triedAt ?? h.since ?? wake?.at ?? 'неизвестно';
}

export function successorLine(meta, owner, deadSince, unread) {
  const title = meta.title ? ` «${meta.title}»` : '';
  return `задача ${meta.id}${title}: оркестратор ${owner} мёртв с ${deadSince}, `
    + `непрочитанных ${unread} — ты в том же корне, забери mailbox: promptobus_mailbox {claim: true}`;
}

function successorItemKey(id, owner, unread) {
  return `${id}:${owner}:${unread}`;
}

async function deadOwnerItems(home, cwd, session, tasks, probe) {
  if (!session || !sameWorkspaceRoot(cwd, home)) return [];
  const items = [];
  for (const meta of tasks) {
    const own = ownership(home, meta.id, ORCHESTRATOR, session);
    if (!own.owner || !own.gated) continue;
    const unread = countInbox(home, meta.id, ORCHESTRATOR);
    if (!unread) continue;
    const wake = readWake(home, meta.id, ORCHESTRATOR);
    if (!wake?.socket) continue;
    let dead = false;
    if (!existsSync(wake.socket)) dead = true;
    else if (wake.session && sameOwnerSession(wake.session, own.owner)) dead = false;
    else dead = (await probe(wake.socket)).dead;
    if (!dead) continue;
    items.push({
      id: meta.id,
      line: successorLine(meta, own.owner, deadSinceOf(home, meta.id, wake), unread),
      key: successorItemKey(meta.id, own.owner, unread),
    });
  }
  return items;
}

// Преемник в корне: владелец mailbox'а orchestrator — другая сессия, сокет мёртв.
// Захват не делается: чужая сессия в том же корне не обязана быть преемником.
export async function successorVerdict(
  home, cwd, session, tasks = activeTasks(home), probe = probeContactPoint,
) {
  const items = await deadOwnerItems(home, cwd, session, tasks, probe);
  return items.length ? items.map((it) => it.line).join('\n') : null;
}

function hintPayload(line, event) {
  if (event?.hook_event_name === GUARD_START_EVENT) {
    return {
      hookSpecificOutput: { hookEventName: GUARD_START_EVENT, additionalContext: line },
      systemMessage: line,
    };
  }
  return { systemMessage: line };
}

function rememberSuccessorHints(home, session, items) {
  const fresh = items.filter((it) => readGuardMark(successorMarkFile(home, it.id, session))?.key !== it.key);
  if (!fresh.length) return null;
  for (const it of fresh) {
    writeJsonAtomic(successorMarkFile(home, it.id, session), { key: it.key, at: new Date().toISOString() });
  }
  return fresh.map((it) => it.line).join('\n');
}

async function successorHint(identity, cwd, session, event) {
  const tasks = activeTasks(identity.home);
  if (sessionOnBus(identity.home, session, identity, tasks)) return null;
  const items = await deadOwnerItems(identity.home, cwd, session, tasks, probeContactPoint);
  const line = rememberSuccessorHints(identity.home, session, items);
  return line ? { code: 0, payload: hintPayload(line, event) } : null;
}

// Решение сторожа: код возврата и то, что уходит в stderr. Контракт хуков Claude Code: код
// 2 даёт `blockingError`, любой другой ненулевой — предупреждение, ход не возвращающее.
// Чистый проход обязан быть кодом 0 и ПУСТЫМ выводом: строка на каждом ходе — шум.
async function decide(args, env, cwd, event) {
  // Кто эта сессия — из нагрузки события, а не из окружения (см. readEvent).
  const session = said(event.session_id) ?? sessionIdentity(env);
  // Идентичность участника — из АРГУМЕНТОВ команды хука, и это ПЕРВЫЙ источник.
  // Окружение остаётся запасным путём: у хука рабочего места аргументов нет вовсе, а ручной
  // запуск их может не нести. Верить ему первым нельзя — фоновой сессии harness кладёт в
  // окружение тройку от ПЕРВОГО spawn'а run'а, и второй участник задачи резолвился бы
  // адресом первого. Мишень мутационной пробы: поменяй порядок — E2E краснеет.
  //
  // Дом резолвится БЕЗ переезда: сторож его не инициирует. Причина не в осторожности, а в
  // том, что доклада отсюда не увидит никто — при коде 0 stderr хука никуда не поднимается,
  // а переезд обещан пользователю числами. Нужен переезд (или он отказывает) — сторож
  // молча пропускает ход: держать его на непрочитанном всё равно не на чем, store не
  // прочитать. Двигает store команда или подъём сервера шины, у обоих вывод виден.
  const here = said(event.cwd) ?? cwd;
  const identity = resolveIdentity(env, here, { move: false, declared: args, host: args.host ?? null });
  if (storePending(identity.home, args.host ?? null)) return null;
  // SessionStart в корне — только детектор преемника. Полный сторож (registerWake, возврат
  // хода, счётчик) на старте сжёг бы GUARD_BLOCK_LIMIT: id сессии переживает resume/clear,
  // и оркестратор с непрочитанным получил бы «СТОРОЖ ЦИКЛА» ещё до первого хода.
  if (event.hook_event_name === GUARD_START_EVENT) {
    return successorHint(identity, here, session, event);
  }
  // Задача — ТОЛЬКО из объявленного: `PROMPTOBUS_TASK` или привязка на диске. Хук стоит у КАЖДОЙ
  // сессии workspace, и «единственная активная» вернула бы ход посторонней сессии.
  const task = identity.declaredTask ?? boundTaskId(identity.home, session);
  if (!task || !taskExists(identity.home, task)) {
    return successorHint(identity, here, session, event);
  }
  // Закрытая задача не стережётся: `PROMPTOBUS_TASK` переживает закрытие, а слать туда нечего.
  const meta = readTask(identity.home, task);
  if (meta.status !== 'active') return null;
  const addr = identity.role;
  // Обе двери гейта владения адресом и сдача contact point'а — операции DRIVER'а этой
  // записи: где лежат адрес сокета и токен, знает только harness, а имени
  // harness'а сторож не знает вовсе. Дверь с откатом на driver подъёма: записи в журнале
  // может не быть вовсе (сессия человека), а на записи с чужим harness'ом отказ ушёл бы во
  // внешний `catch` — то есть сторож молча не работал бы на КАЖДОМ ходу такой сессии,
  // неотличимо от чистого прохода.
  const driver = driverOrLift(participantOf(meta, addr));
  // Mailbox чужой — стеречь нечего: оригиналы уйдут владельцу, «забери mailbox» было бы ложью.
  // В корне это и есть преемник после смены id: hint, не возврат хода и не авто-claim.
  if (ownership(identity.home, task, addr, session).gated) {
    return successorHint(identity, here, session, event);
  }
  // Адрес закреплён в журнале за ДРУГОЙ сессией — эта за него не пишет ничего:
  // ни contact point, ни отметку конца хода. Второй рубеж после аргументов хука: он держит
  // и ручной запуск с чужой тройкой в окружении, и участника, поднятого прежним релизом.
  // Отказ уходит в журнал надзирателя: это самый частый вход в беду — чужой Stop-хук, — и
  // молчаливый пропуск здесь неотличим от чистого прохода (второй раунд ревью).
  const held = foreignSession(identity.home, task, addr, session);
  if (held) {
    driver.sayForeignWrite(identity.home, task, addr, held, session, 'отметка конца хода');
    return null;
  }

  // Сторож — главный оживитель надзирателя: он один зовётся на каждом завершении хода. Тем
  // же ходом сессия сдаёт свой contact point — хук живёт её дочерним процессом. Сессия
  // уезжает туда ЯВНО: процессу хука `CLAUDE_CODE_SESSION_ID` ничем не обещана, а здесь она
  // уже разрезолвлена из нагрузки события — без этого запись легла бы без клейма владельца
  // и стирала бы его каждым концом хода (замечание ревью).
  driver.registerWake(identity.home, task, addr, env, session);
  ensureWarden(identity.home, task, { env, host: args.host ?? null });

  const file = guardMarkFile(identity.home, task, addr);
  const verdict = guardVerdict(identity.home, task, addr);
  if (!verdict) {
    // Чистый проход сбрасывает счётчик: следующая дыра — новая, и торговаться за неё
    // сторож обязан с полного счёта.
    rmSync(file, { force: true });
    // Ход и правда кончился. Отметка об этом — единственный признак «сессия свободна» у
    // участника без bg-сессии, и по ней надзиратель решает, стучать ли ему повторно
    //. Ставится она там, где ход ЗАКАНЧИВАЕТСЯ: возврат хода (код 2) ниже —
    // это продолжение работы, и отмечать его как конец значило бы звать стук в сессию,
    // которой только что вернули ход.
    markTurn(identity.home, task, addr);
    return null;
  }
  const was = readGuardMark(file);
  const count = was?.key === verdict.key ? (Number(was.count) || 0) + 1 : 1;
  writeJsonAtomic(file, { key: verdict.key, count, at: new Date().toISOString() });
  const label = identityLabel(identity.home, task, addr, session);
  if (count > GUARD_BLOCK_LIMIT) {
    // Потолок возвратов пройден — ход кончается, каким бы ни было состояние mailbox'а.
    markTurn(identity.home, task, addr);
    return {
      code: 0,
      line: `${GUARD_MARK} пропускает ход: то же состояние подряд ${count} раз, а ход уже возвращён `
        + `${GUARD_BLOCK_LIMIT} — дальше возвращать нельзя, иначе сессия не кончит ход никогда. `
        + `Состояние осталось прежним: ${verdict.reason} · ${label}`,
    };
  }
  return { code: 2, line: `${GUARD_MARK}: ${verdict.reason} · ${label}` };
}

export async function guard(args = {}, env = process.env, cwd = process.cwd(), stdin = process.stdin) {
  let out = null;
  try {
    out = await decide(args, env, cwd, await readEvent(stdin));
  } catch {
    // Сторож не вправе мешать сессии жить: запуск вне workspace, негодный `PROMPTOBUS_ROLE`,
    // битый журнал — не повод возвращать ход или писать в ленту.
    return;
  }
  if (!out) return;
  if (out.code === 0) {
    // Пропуск говорится каналом ленты — `{"systemMessage": …}` в stdout: при коде 0
    // stderr харнес никуда не поднимает, и страховка снималась бы молча. SessionStart
    // читает тот же JSON плюс additionalContext — иначе текст на старте в контекст не
    // попадает.
    const payload = out.payload ?? (out.line ? { systemMessage: out.line } : null);
    if (payload) process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  // Причина возврата уходит в stderr дословно, без цвета и без значка: её читает не
  // человек в терминале, а модель — харнес вклеивает stderr в свой `blockingError`.
  process.stderr.write(`${out.line}\n`);
  process.exitCode = out.code;
}
