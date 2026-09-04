// MCP-сервер шины: транспорт stdio, JSON-RPC 2.0 по одному сообщению на строку,
// negotiation (`initialize` → `notifications/initialized` → `ping`), `tools/list` и
// `tools/call`. Реализация рукопашная — у package зависимостей нет вовсе.
//
// Здесь только протокол и диспетчер. Всё, что знает про рабочее место, harness и версию
// потребителя, приходит callbacks (ADR-032, §2): идентичность процесса, имя и версия
// сервера, сдача contact point'а, строки участника про Git и фоновую сессию, диагностика
// вставших и человеческий текст ошибок. Callbacks ВОЗВРАЩАЮТ данные и не печатают: канал
// stdout занят протоколом, и одна посторонняя строка в нём ломает клиента.
//
// Ошибку package объявляет типизированным событием, а текст ей даёт потребитель: коды
// JSON-RPC — часть протокола и живут здесь, слова — часть вывода и живут у adapter'а.
import {
  GateError, MAILBOX_CLAIMED_MARK, ORCHESTRATOR,
} from '../protocol.js';
import type { Ownership } from '../protocol.js';
import { MCP_TOOLS } from './tools.js';
import type { PromptobusService } from './service.js';
import {
  ADDR_MARK, foreignNote, readableName, renderMessages, renderTask,
} from './render.js';
import type { DecorateParticipant } from './render.js';

/** Кто этот процесс на шине. Считает adapter: окружение и корень рабочего места — его. */
export interface McpIdentity {
  role: string;
  home: string;
  declaredTask: string | null;
  session: string | null;
}

/** Имя и версия сервера в ответе `initialize`. И то, и другое — сведения потребителя. */
export interface McpServerInfo {
  name: string;
  version: string;
}

/** Участник вошёл в задачу: сдать contact point и поднять слушателя — дело adapter'а. */
export interface McpJoin {
  home: string;
  task: string;
  address: string;
  gated: boolean;
}

/** О ком спрашивают диагностику вставших. */
export interface McpStalls {
  home: string;
  task: string;
  address: string;
}

/** Событие, которому потребитель даёт текст. Код JSON-RPC при этом остаётся за package. */
export type McpEvent =
  | { kind: 'parse' }
  | { kind: 'unknown-method'; method: string }
  | { kind: 'unknown-tool'; tool: string }
  | { kind: 'tool-failed'; cause: Error };

/** Поток строк, из которого сервер читает запросы. */
export interface McpInput {
  setEncoding(encoding: string): unknown;
  [Symbol.asyncIterator](): AsyncIterator<string>;
}

/** Поток, в который сервер пишет ответы. */
export interface McpOutput {
  write(chunk: string): unknown;
}

export interface McpOptions {
  /** Операции store. Передаётся явно — своего дефолта factory не подставляет. */
  service: PromptobusService;
  /** Версии протокола, которые сервер обслуживает. Первая — своя последняя. */
  protocolVersions: string[];
  /** Идентичность процесса. Callback, а не значение: окружение читает только adapter. */
  resolveIdentity: () => McpIdentity;
  /** Имя и версия сервера. */
  serverInfo: () => McpServerInfo;
  /** Участник вошёл в задачу — до всякой работы инструмента. */
  onJoin: (join: McpJoin) => void;
  /** Строки участника, которых store не знает: репозиторий, worktree, фоновая сессия. */
  decorateParticipant: DecorateParticipant;
  /** Маршруты по вставшим участникам в ответе `mailbox`; `null` — говорить не о чем. */
  stalls: (ctx: McpStalls) => string | null;
  /** Человеческий текст события. */
  errorText: (event: McpEvent) => string;
}

interface JsonRpcMessage {
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

// Договор о версии протокола: эхо любой версии клиента заявляло бы поддержку той,
// которой у сервера нет. Названная — если в списке обслуживаемых, иначе своя последняя.
export function negotiateProtocol(versions: string[], asked: unknown): string {
  return versions.includes(asked as string) ? (asked as string) : versions[0]!;
}

// Инструмента с таким именем нет. Отдельный класс, а не готовая строка: текст ошибки —
// дело потребителя, и package называет только событие.
class UnknownToolError extends Error {
  readonly tool: string;

  constructor(tool: string) {
    super(tool);
    this.tool = tool;
  }
}

export function createMcpServer(options: McpOptions): {
  serve: (streams: { input: McpInput; output: McpOutput }) => Promise<void>;
} {
  const {
    service, protocolVersions, resolveIdentity, serverInfo,
    onJoin, decorateParticipant, stalls, errorText,
  } = options;
  // Пустой список версий — отказ здесь, при создании, а не `undefined` в ответе на первый
  // `initialize` (`BL-423`): `negotiateProtocol` берёт `versions[0]` за свою последнюю, и
  // сервер без единой версии объявлял бы клиенту протокол `undefined` — согласие ни на что.
  // Сегодня список — литерал контракта потребителя, пустым его делает только правка руками;
  // гейт стоит там, где ошибку видно до первого соединения.
  if (!Array.isArray(protocolVersions) || protocolVersions.length === 0) {
    throw new TypeError('protocolVersions пуст: серверу нечем договориться о версии протокола — список обслуживаемых версий обязан быть непустым');
  }

  // Захват mailbox'а преемником. Отказы громкие: молчаливый отказ читался бы как успех.
  function claim(home: string, task: string, addr: string, session: string | null, own: Ownership): string {
    if (addr !== ORCHESTRATOR) {
      return `mailbox ${addr} владельца не имеет — захватывать нечего: адрес приходит worker'у `
        + `объявлением в его mcp-config. Читай обычным вызовом, без claim · ${service.identityLabel(home, task, addr, session)}`;
    }
    if (!session) {
      return 'захватить mailbox нечем: harness не дал идентичности сессии — '
        + 'владельца у адреса и не проверяют, читай обычным вызовом '
        + `· ${service.identityLabel(home, task, addr)}`;
    }
    // Задача без владельца гейта не имеет — и захват включил бы его задним числом для всех
    // прочих сессий, включая живого оркестратора: дальше он видел бы одни копии.
    if (!own.owner) {
      return `у задачи ${task} владельца нет — гейта нет, и захватывать нечего: она заведена `
        + `прежним CLI. Читай обычным вызовом, без claim · ${service.identityLabel(home, task, addr, session)}`;
    }
    // Захват — это и перепривязка (ADR-027): пишется и владелец, и объявленная задача.
    const mine = own.owner === session;
    if (mine) service.bindSession(home, task, session);
    const previous = mine ? null : service.claimOwnership(home, task, session);
    // «Дальше без аргумента» — только по АКТИВНОЙ задаче: захват закрытой законен, но
    // привязывается только активная.
    const bound = service.readTask(home, task).status === 'active';
    const tail = bound ? ' — дальше задача резолвится без аргумента' : '';
    const head = mine
      ? `mailbox уже закреплён за этой сессией ${session}${bound ? ', привязка обновлена' : ''}${tail}`
      : `${MAILBOX_CLAIMED_MARK}: адрес orchestrator задачи ${task} закреплён за этой сессией ${session}, `
        + `прежний владелец — ${previous ?? 'ничей'}${tail}`;
    const { messages, broken } = service.readInbox(home, task, addr);
    const alarm = service.brokenNote(broken);
    return (alarm ? `${alarm}\n\n` : '')
      + `${head}\n\n${renderMessages(service, home, task, addr, messages, session)}`;
  }

  function syncTool(identity: McpIdentity, name: string, args: Record<string, unknown>, task: string): string {
    const { home, role, session } = identity;
    switch (name) {
      case 'promptobus_mailbox': {
        const own = service.ownership(home, task, role, session);
        if (args?.claim === true) return claim(home, task, role, session, own);
        const { messages, broken } = own.gated
          ? service.peekInbox(home, task, role)
          : service.readInbox(home, task, role);
        const alarm = service.brokenNote(broken);
        const head = alarm ? `${alarm}\n\n` : '';
        const body = renderMessages(service, home, task, role, messages, session);
        // Шапку чужой mailbox получает и на пустом ответе: без неё сессия читала бы пустоту
        // как «сообщений нет». `mailbox` зовут раз на ход, а не в цикле опроса.
        if (own.gated) return `${head}${foreignNote(task, own)}${messages.length ? `\n\n${body}` : ''}`;
        // Маршруты по вставшим спрашиваются ровно на пробуждении: `mailbox` зовут первым
        // ходом, и другого места, где доклад дойдёт вовремя, у него нет.
        const stalled = stalls({ home, task, address: role });
        return `${head}${body}${stalled ? `\n\n${stalled}` : ''}`;
      }
      case 'promptobus_send': {
        const to = args?.to as string;
        const { message, artifact } = service.send(home, task, {
          from: role,
          to,
          type: args?.type as string,
          body: args?.body as string,
          artifactPath: args?.artifactPath as string,
        });
        // Отправитель тоже мог подцепиться к чужой задаче. Отправка — ход, который делают и
        // не забрав своё: последнее место, где накопившееся ещё можно назвать.
        const unread = service.unreadNote(home, task, role, session);
        return `отправлено ${message.type} → ${readableName(service.readTask(home, task), to)}${ADDR_MARK}${to}`
          + ` · id ${message.id}${artifact ? ` · артефакт ${artifact.filename}` : ''}`
          + ` · ${service.identityLabel(home, task, role, session)}`
          + (unread ? `\n${unread}` : '');
      }
      case 'promptobus_task':
        return renderTask(service, home, task, role, session, decorateParticipant);
      default:
        throw new UnknownToolError(name);
    }
  }

  // Вход в задачу: сдать contact point и поднять слушателя. За соединение это делается ОДИН
  // раз на задачу — `joined` и есть та отметка. Повтор не ошибка, но и не работа: `onJoin`
  // пишет в store и поднимает процесс, а сессия за соединение входит в задачу однажды.
  // Ключ — id задачи, а не адрес: явный `task` аргументом инструмента вправе назвать другую,
  // и её вход законен.
  //
  // **Отметка ставится ПОСЛЕ удавшегося входа и только за сдавшего contact point.** Порядок
  // тут не косметика: `ownership` — первое настоящее чтение журнала задачи (`resolveTaskId`
  // ограничивается его существованием), и на снесённом или неразобранном журнале оно
  // отказывает. Отметив вход заранее, сервер запомнил бы как вошедшую сессию, которая не
  // вошла, — и следующий `tools/call` вход бы пропустил, то есть contact point не сдавался бы
  // ни разу за жизнь сессии (замечание ревью). Гейт владения — вторая половина того же:
  // чужой сессии `onJoin` сокета не пишет (`joinBus`), а она вправе стать владельцем тем же
  // соединением — `mailbox {claim: true}`, — и отметка держала бы `wake/<адрес>.json` на
  // сокете прежнего владельца до конца хода.
  function join(identity: McpIdentity, task: string, joined: Set<string>): void {
    if (joined.has(task)) return;
    const { home, role, session } = identity;
    // Владение спрашивается здесь: сдача contact point'а обязана случиться до работы —
    // иначе первый вызов чужой сессии успел бы вписать свой сокет.
    const { gated } = service.ownership(home, task, role, session);
    onJoin({ home, task, address: role, gated });
    if (!gated) joined.add(task);
  }

  // Вход по ОБЪЯВЛЕННОМУ — так входят на рукопожатии, где аргумента `task` ещё нет.
  // Задача резолвится тем же путём, что и у инструмента (объявление → привязка сессии →
  // единственная активная).
  //
  // Под перехватом — только законный отказ (`GateError`): задачи в доме ещё нет вовсе,
  // активных несколько, названной не существует, журнал не читается. Сервер оркестратора
  // поднимается вместе с его сессией, когда задачи нет, и ронять таким отказом `initialize`
  // нельзя — сессия осталась бы вовсе без шины. Всё прочее уходит наружу: неожиданная
  // ошибка — это поломка, и прятать её здесь значило бы чинить её вслепую. Отметки вход при
  // отказе не оставляет, поэтому следующий `tools/call` пробует снова.
  function joinDeclared(identity: McpIdentity, joined: Set<string>): void {
    service.withTaskCache(() => {
      try {
        join(identity, service.resolveTaskId(identity.home, identity.declaredTask, identity.session), joined);
      } catch (e) {
        if (!(e instanceof GateError)) throw e;
      }
    });
  }

  function callTool(identity: McpIdentity, name: string, args: Record<string, unknown>, joined: Set<string>): string {
    const { home, declaredTask, session } = identity;
    // Явная задача аргументом сильнее объявленной сессии — как `--task` сильнее `PROMPTOBUS_TASK`.
    const asked = typeof args?.task === 'string' ? args.task.trim() : '';
    return service.withTaskCache(() => {
      const task = service.resolveTaskId(home, asked || declaredTask, session);
      join(identity, task, joined);
      const text = syncTool(identity, name, args, task);
      // `claim` меняет владение ПОСЛЕ первого входа: на нём join ещё видел чужой mailbox
      // и сокет не сдал. Второй вход — уже владельца, и contact point переписывается
      // тем же вызовом, не дожидаясь следующего инструмента.
      if (name === 'promptobus_mailbox' && args?.claim === true) join(identity, task, joined);
      return text;
    });
  }

  function handle(msg: JsonRpcMessage, identity: McpIdentity, joined: Set<string>): object | null {
    const { id, method, params } = msg;
    // Уведомление (нет id) — ответа быть не должно.
    if (id === undefined || id === null) return null;
    switch (method) {
      case 'initialize': {
        // Contact point сдаётся на РУКОПОЖАТИИ (`BL-427`): идентичность к этому моменту уже
        // резолвлена, и ждать первого инструмента незачем — сессия, сделавшая handshake и не
        // позвавшая ничего, иначе остаётся для надзирателя глухой, а тот законно откатывается
        // на `self-wake`. Вход на `tools/call` при этом остаётся: инструмент зовут и без
        // рукопожатия, и другой задачей аргументом.
        joinDeclared(identity, joined);
        const info = serverInfo();
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: negotiateProtocol(protocolVersions, params?.protocolVersion),
            capabilities: { tools: {} },
            serverInfo: { name: info.name, version: info.version },
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
      case 'tools/call': {
        const name = params?.name as string;
        try {
          const text = callTool(identity, name, (params?.arguments as Record<string, unknown>) ?? {}, joined);
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
        } catch (e) {
          // Ошибка инструмента — не ошибка протокола: соединение терять нельзя.
          const event: McpEvent = e instanceof UnknownToolError
            ? { kind: 'unknown-tool', tool: e.tool }
            : { kind: 'tool-failed', cause: e as Error };
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: errorText(event) }], isError: true } };
        }
      }
      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: errorText({ kind: 'unknown-method', method: method as string }) },
        };
    }
  }

  // Инструменты синхронны, поэтому запросы идут строго по одному, в порядке прихода.
  // Заведёшь асинхронный — он заморозит весь канал на своё время: `ping` и соседние
  // вызовы той же сессии дождутся его конца. Такой отвязывай от этой очереди.
  async function serve({ input, output }: { input: McpInput; output: McpOutput }): Promise<void> {
    const identity = resolveIdentity();
    // Задачи, в которые это СОЕДИНЕНИЕ уже вошло. Отметка живёт у соединения, а не у factory:
    // сервер поднимается процессом сессии, и вход — свойство разговора, а не модуля.
    const joined = new Set<string>();
    const write = (obj: object): unknown => output.write(JSON.stringify(obj) + '\n');
    input.setEncoding('utf8');
    let buf = '';
    for await (const chunk of input) {
      buf += chunk;
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(line) as JsonRpcMessage;
        } catch {
          write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: errorText({ kind: 'parse' }) } });
          continue;
        }
        const answer = handle(msg, identity, joined);
        if (answer) write(answer);
      }
    }
  }

  return { serve };
}
