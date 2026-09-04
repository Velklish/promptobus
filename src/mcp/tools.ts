// Объявление инструментов MCP-сервера шины: имена, описания и схемы входа. Дом здесь, а
// не у потребителя: описание инструмента — часть протокола, и оно обязано ехать вместе с
// кодом, который его исполняет. Состав набора при этом объявлен и на стороне CLI
// (`PROMPTOBUS_TOOLS` у потребителя) — оттуда его берёт `lint`, сверяя цитату в
// документации; что два объявления не разъехались, держит проверка живого `tools/list`.
//
// **Prefix у имён двойной намеренно**: полное имя, которое видит сессия, —
// `mcp__promptobus__promptobus_send`. Клиент неймспейсит имена сам, а короткие `send` и
// `task` в общем наборе сессии сталкиваются с чужими.
import { MESSAGE_TYPES } from '../protocol.js';

/** Объявление одного инструмента, как его отдаёт `tools/list`. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

// Задача аргументом — у каждого инструмента: `PROMPTOBUS_TASK` закрепляется при старте сессии,
// в живой её не поменять, а активных задач бывает несколько.
const TASK_ARG = {
  task: {
    type: 'string',
    description: 'id задачи — нужен, когда активных задач несколько, а привязки у сессии нет; '
      + 'без него берётся PROMPTOBUS_TASK сессии, иначе объявленная привязка этой сессии '
      + '(её пишут spawn, ревью и claim), иначе единственная активная',
  },
};

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'promptobus_send',
    description: 'Отправить сообщение участнику задачи. Адрес: orchestrator, worker:<slug> или reviewer:<slug>. '
      + `Worker'ы между собой не переписываются — контекст и артефакты идут через оркестратора. `
      + 'Ответ называет PROMPTOBUS_HOME, свой адрес и задачу, в которую сообщение легло, — по id и по имени, '
      + `а если в твоём mailbox'е лежит непрочитанное — его счётчик.`,
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'адрес получателя: orchestrator, worker:<slug> или reviewer:<slug>' },
        type: { type: 'string', enum: MESSAGE_TYPES, description: 'тип сообщения протокола v1' },
        body: { type: 'string', description: 'текст: задание, статус, вопрос, ответ, итог или замечания ревью' },
        artifactPath: { type: 'string', description: 'абсолютный путь к файлу; копируется в artifacts/ задачи, в сообщение попадает имя' },
        ...TASK_ARG,
      },
      required: ['to', 'type', 'body'],
    },
  },
  {
    name: 'promptobus_mailbox',
    description: 'Забрать накопившиеся сообщения своего адреса не блокируясь. Им же они '
      + 'становятся прочитанными: postcard надзирателя несёт текст коротких сообщений, но '
      + `истина остаётся в mailbox'е, и потерянный postcard ничего не теряет. `
      + 'Ответ называет PROMPTOBUS_HOME, адрес и задачу — по id и по имени; сверь их, если ждёшь '
      + 'сообщение, которого нет. Mailbox orchestrator закреплён за сессией, при которой задача '
      + 'завелась: чужая сессия получает копию, оригиналы остаются владельцу. Переписка твоя, '
      + 'а сессия новая (демон прежней умер) — забери mailbox себе аргументом claim.',
    inputSchema: {
      type: 'object',
      properties: {
        claim: {
          type: 'boolean',
          description: 'закрепить mailbox orchestrator за этой сессией и читать его как свой; '
            + 'ответ назовёт прежнего владельца',
        },
        ...TASK_ARG,
      },
    },
  },
  {
    name: 'promptobus_task',
    description: 'Метаданные текущей задачи: id, заголовок, статус, участники с репозиториями '
      + 'и bg-сессиями, счётчики непрочитанного, путь к папке артефактов.',
    inputSchema: { type: 'object', properties: { ...TASK_ARG } },
  },
];
