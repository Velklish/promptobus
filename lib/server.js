import { busService, ORCHESTRATOR, participantOf, readTask, resolveIdentity } from './store.js';
import { createMcpServer } from '../dist/index.js';
import { blockedParticipants, stallLine, stallTail } from './status.js';
import { driverOrLift, forgetSessions } from './drivers.js';
import { ensureWarden } from './warden.js';
import { branchLine, worktreeBranch } from './worktree.js';
import { PROMPTOBUS_SERVER, PROTOCOL_VERSIONS } from './contract.js';

// Adapter MCP-сервера шины над Promptobus: подкоманда `promptobus mcp`,
// транспорт stdio, JSON-RPC 2.0 по одному сообщению на строку. Сам протокол — negotiation,
// `tools/list`, `tools/call`, разбор ошибок — живёт во вложенном package, в
// [mcp/server.ts](../src/mcp/server.ts), и о рабочем месте не знает
// ничего. Здесь остаётся ровно то, что package'у знать не положено, и подаётся оно factory
// callbacks: идентичность процесса, имя и версия CLI, сдача contact point'а и подъём
// надзирателя, строки участника про Git и фоновую сессию Claude, диагностика вставших и
// человеческий текст ошибок протокола.
//
// **Callbacks возвращают данные, а не печатают.** Канал stdout занят протоколом целиком, и
// посторонняя строка в нём ломает клиента-агента так же, как ломала набор.
//
// Метка машинного адреса приезжает из package вместе с рендером ответов; дверь к ней
// остаётся здесь — её берут фикстуры хука ленты.
export { ADDR_MARK } from '../dist/index.js';

// Строки участника, которых store не знает: репозиторий рабочей зоны, каталог worktree с
// его веткой (git) и фоновая сессия harness'а. Место их в строке — между владельцем и
// снятием с наблюдения; порядок держит `participantLine` package'а.
//
// Хука decoration для самой задачи нет: шапка ответа `task` — id, статус, каталог
// артефактов и свой mailbox — целиком store, и подавать туда adapter'у нечего.
function decorateParticipant(p) {
  // Репозиторий, worktree, ветка и bg-сессия — поля механизма: их пишет adapter, и лежат
  // они в `metadata` записи v1. Собственные поля записи — роль, harness, режим, session
  // reference и снимок capabilities; про рабочее место они не знают ничего.
  const m = p.metadata ?? {};
  const parts = [];
  if (m.repo) parts.push(`репозиторий ${m.repo}`);
  // Ветку называет git, а не журнал: worker мог уехать на свою по просьбе брифа.
  if (m.worktree) {
    // branchLine молчит (null), когда ветки нет нигде: в шаблоне была бы строка «null».
    const line = branchLine(m.branch, worktreeBranch(m.worktree));
    parts.push(`worktree ${m.worktree}${line ? ` (${line})` : ''}`);
  }
  if (m.session) parts.push(`bg-сессия ${m.session}`);
  return parts;
}

// Маршруты по вставшим: место здесь, потому что `mailbox` зовут ровно на пробуждении.
// Смотрит только оркестратор. Берутся ВСЕ текущие стопы, а не «свежие»: отметку
// доложенного держит команда, и общая на два канала глушила бы второй канал.
// MCP живёт процессом сессии, поэтому список сессий спрашивается на каждый вызов: без
// сброса внешний spawn/stop невидим до рестарта сервера.
export function stallNote(home, task, addr) {
  if (addr !== ORCHESTRATOR) return null;
  forgetSessions();
  const stalled = blockedParticipants(home, task, readTask(home, task).participants);
  if (!stalled?.length) return null;
  return [...stalled.map((s) => stallLine(s, task)), stallTail(stalled)].join('\n');
}

// Участник сдаёт свой contact point и, если слушателя нет, поднимает его. MCP-сервер
// живёт дочерним процессом сессии участника — адрес сокета и токен лежат в его
// `process.env`. Точку сдаёт только владелец mailbox'а: иначе чужая сессия вписала бы свой
// сокет в `wake/orchestrator.json` чужого run. `ensureWarden` гейта не требует.
function joinBus({ home, task, address, gated, host }) {
  if (host == null) throw new Error('joinBus: host обязателен');
  // Contact point сдаёт driver этого участника: переменные с адресом сокета и
  // токеном — словарь harness'а, и сервер шины их не знает. Дверь с откатом на driver
  // подъёма (замечание ревью): запись с чужим harness'ом здесь законна, а отказ стал бы
  // отказом рукопожатия — сессия осталась бы без шины целиком из-за того, что ей нечем
  // сдать contact point.
  const driver = driverOrLift(participantOf(readTask(home, task), address));
  if (!gated) driver.registerWake(home, task, address);
  ensureWarden(home, task, { host });
}

// Человеческий текст события протокола. Package называет событие типом и ставит код
// JSON-RPC, слова остаются здесь — вместе со всем остальным пользовательским выводом
// Отказ инструмента приходит текстом с `isError`, а не ошибкой протокола:
// агент обязан её прочитать и исправить вызов, а не потерять соединение.
// Ветка на каждое событие названа явно, а `default` полей события не читает вовсе:
// `errorText` зовётся и ВНЕ перехвата — на неизвестном методе и на неразобранной строке, —
// и `TypeError` из него уронил бы цикл сервера, то есть сессия потеряла бы соединение
// вместо строки об ошибке. Пятое событие package'а так получит невнятный, но безопасный
// текст, и чинить его будут словами, а не падением (замечание ревью).
function errorText(event) {
  switch (event.kind) {
    case 'parse':
      return 'не разобрано как JSON';
    case 'unknown-method':
      return `метод «${event.method}» не поддерживается`;
    case 'unknown-tool':
      return `ошибка: неизвестный инструмент «${event.tool}»`;
    case 'tool-failed':
      return `ошибка: ${event.cause.message}`;
    default:
      return 'ошибка: событие протокола не опознано';
  }
}

export async function serve({ host, env = process.env, cwd = process.cwd(), input = process.stdin, output = process.stdout } = {}) {
  if (host == null) throw new Error('serve: host обязателен');
  const server = createMcpServer({
    service: busService,
    // Дом списка — `contract.js`: его читает `lint`, сверяя цитату в справочнике, и второго
    // дома у значения не бывает. Package берёт список аргументом и своего не заводит.
    protocolVersions: PROTOCOL_VERSIONS,
    // Задача резолвится на каждом вызове, а идентичность процесса — один раз: сервер
    // оркестратора поднимается вместе с сессией, когда задачи ещё нет.
    resolveIdentity: () => resolveIdentity(env, cwd, { host }),
    // Имя — из своего дома (`contract.js`): им же зовётся запись сервера в конфигах.
    serverInfo: () => ({ name: PROMPTOBUS_SERVER, version: host.version }),
    onJoin: (ctx) => joinBus({ ...ctx, host }),
    decorateParticipant,
    stalls: ({ home, task, address }) => stallNote(home, task, address),
    errorText,
  });
  await server.serve({ input, output });
}
