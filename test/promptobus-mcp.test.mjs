// Регресс на MCP-сервер шины Promptobus: подкоманда `promptobus mcp`.
// Запуск: npm test
//
// Клиент здесь скриптованный: два настоящих stdio-процесса (оркестратор и worker)
// говорят построчным JSON-RPC 2.0 — ровно так с ними разговаривает Claude Code.
// Проверяется рукопашная реализация протокола и доставка сообщений между процессами.
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { stubCommand } from './sandbox.mjs';
import { check } from './check.mjs';

const SB = mkdtempSync(path.join(os.tmpdir(), 'promptobus-promptobus-mcp-'));
const ROOT = realpathSync(SB);
const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'promptobus.js');
const HOME = path.join(ROOT, '.promptobus');
const TASK = 't20260813-090000';
const WRONG_ROOT = path.join(ROOT, 'other-workspace');
const WRONG_HOME = path.join(WRONG_ROOT, '.promptobus');

// Два полноценных workspace с задачей одного id воспроизводят живой баг :
// CLI запускается из первого, а cwd stdio-процесса выбирает MCP-клиент и может
// оказаться вторым. Канонический конфиг обязан связать сервер с первым через PROMPTOBUS_HOME.
for (const root of [SB, WRONG_ROOT]) {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'AGENTS.md'), '# workspace\n');
  writeFileSync(path.join(root, 'promptobus.json'), `${JSON.stringify({
    commandName: 'promptobus',
    tools: ['claude'],
  })}\n`);
}

const store = await import(path.join(here, '..', 'lib', 'store.js'));
const { hostOf } = await import(path.join(here, '..', 'lib', 'host.js'));
// Имя поля маркера версии — из своего дома (`protocol.ts`), а не литералом: его пишет
// adapter и читает store, и разъехавшись, фикстура проверяла бы несуществующее поле.
const { MECHANISM_VERSION_FIELD } = await import(path.join(here, '..', 'dist', 'index.js'));
store.createTask(HOME, { id: TASK, title: 'событие CargoCreated в двух сервисах' });
store.createTask(WRONG_HOME, { id: TASK, title: 'другая задача с тем же id' });
// Worker числится участником: с  сообщение уходит только тому, кто в журнале
// задачи есть, а заводит его там spawn — живого spawn'а в этих тестах нет.
const joinWorker = (home, id) => store.upsertParticipant(home, id, store.participantRecord('worker:cargos-api', { repo: 'cargos-api' }));
joinWorker(HOME, TASK);
joinWorker(WRONG_HOME, TASK);
const { PROMPTOBUS_TOOLS, PROTOCOL_VERSIONS } = await import(path.join(here, '..', 'lib', 'contract.js'));
const { blockedParticipants } = await import(path.join(here, '..', 'lib', 'status.js'));
const canonicalPromptobus = {
  command: process.execPath,
  args: [BIN, 'mcp'],
  env: { PROMPTOBUS_HOME: HOME },
};

// Всё, что сервер написал в stdout мимо построчного JSON-RPC. Пусто — часть контракта:
// канал общий с протоколом, и любая посторонняя строка в нём ломает клиента-агента так же,
// как ломала этот файл.
const strays = [];

function startServer(role, { config = null, cwd = SB, task = TASK, env = {} } = {}) {
  const child = spawn(config?.command ?? process.execPath, config?.args ?? [BIN, 'mcp'], {
    cwd,
    env: {
      ...process.env,
      ...(config?.env ?? {}),
      PROMPTOBUS_ROLE: role,
      PROMPTOBUS_TASK: task,
      ...(config ? {} : { PROMPTOBUS_HOME: HOME }),
      // Идентичность сессии задаём явно: она приходит из окружения, и без
      // подстановки тест зависел бы от того, из-под чего запущен npm test.
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const unsolicited = [];
  // Порядок ПРИХОДА ответов (id по очереди). Обещания его не хранят: `await` отдаёт свой
  // ответ, а не тот, что пришёл первым, — а предмет проверки ниже ровно в порядке.
  const arrived = [];
  let stderr = '';
  let buf = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      // Разбор — под перехватом: `JSON.parse` в обработчике события бросает мимо всякого
      // `try` вызывающего, обработчик зовёт сам Node, и исключение из него становится
      // необработанным. Одна посторонняя строка сервера уносила весь файл, не назвав
      // виноватую. Копим и выносим вердиктом в конце — красная проверка вместо
      // смерти файла.
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        strays.push({ role, line });
        continue;
      }
      arrived.push(msg.id);
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); } else unsolicited.push(msg);
    }
  });
  let seq = 0;
  // Заявка готовится отдельно от записи: у конвейера все строки уходят ОДНОЙ записью, а
  // обещания ответов обязаны быть заведены до неё.
  const request = (method, params) => {
    const id = (seq += 1);
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`нет ответа на ${method}`)), 20000);
      pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    });
    return { line: JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', answer };
  };
  const call = (method, params) => {
    const { line, answer } = request(method, params);
    child.stdin.write(line);
    return answer;
  };
  // Конвейер — несколько запросов одной записью в трубу. Разными записями
  // «одновременность» зависела бы от того, склеит ли их труба в один чанк: сервер разбирает
  // строки чанка подряд, и такта событийного цикла между ними не случается.
  const batch = (reqs) => {
    const made = reqs.map((r) => request(r.method, r.params));
    child.stdin.write(made.map((m) => m.line).join(''));
    return made.map((m) => m.answer);
  };
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  // Строка как есть — ею подаётся неразбираемый вход: собрать его через `call` нельзя,
  // тот пишет готовый JSON.
  const raw = (line) => child.stdin.write(line);
  const stop = () => { child.stdin.end(); child.kill(); };
  return { call, batch, notify, raw, stop, unsolicited, arrived, stderr: () => stderr };
}

const text = (res) => res.result?.content?.map((c) => c.text).join('\n') ?? '';

// Оркестратор стартует намеренно из чужого workspace. До  канонический конфиг
// не задавал PROMPTOBUS_HOME, поэтому этот сервер честно смотрел в WRONG_HOME и отвечал «пусто»,
// пока сообщения лежали в HOME.
const orch = startServer('orchestrator', { config: canonicalPromptobus, cwd: WRONG_ROOT });
const worker = startServer('worker:cargos-api');

// --- рукопожатие -------------------------------------------------------------

check('канонический MCP-конфиг фиксирует абсолютный PROMPTOBUS_HOME',
  canonicalPromptobus?.env?.PROMPTOBUS_HOME === HOME, JSON.stringify(canonicalPromptobus));
const aliasIdentity = store.resolveIdentity({
  PROMPTOBUS_ROLE: 'orchestrator',
  PROMPTOBUS_TASK: TASK,
  PROMPTOBUS_HOME: path.join(SB, '.promptobus'),
}, WRONG_ROOT, { host: hostOf(WRONG_ROOT) });
check('identity: симлинк-алиас PROMPTOBUS_HOME приведён к той же физической форме',
  aliasIdentity.home === HOME, `${aliasIdentity.home} vs ${HOME}`);

const init = await orch.call('initialize', {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'test-client', version: '1' },
});
check('initialize: версия протокола — из запроса клиента, раз сервер её обслуживает',
  init.result?.protocolVersion === '2025-03-26', JSON.stringify(init.result));
// : прежде `initialize` возвращал эхом ЛЮБУЮ версию — сервер заявлял поддержку той,
// которой у него нет, и клиент новее списка вправе был ждать её возможностей.
const future = startServer('orchestrator');
const initFuture = await future.call('initialize', { protocolVersion: '2099-01-01', capabilities: {} });
check(': незнакомая версия протокола не возвращается эхом — сервер называет свою',
  initFuture.result?.protocolVersion === PROTOCOL_VERSIONS[0], JSON.stringify(initFuture.result));
future.stop();
// Сам договор о версии — чистая функция package'а, и проверен он в его наборе
// ([mcp.test.mjs](../packages/promptobus/test/mcp.test.mjs)). Здесь остаётся живая ветка:
// что сервер CLI поднят со списком из `contract.js`, а не с чужим.
check('initialize: сервер объявил себя и инструменты',
  init.result?.serverInfo?.name === 'promptobus' && !!init.result?.capabilities?.tools,
  JSON.stringify(init.result?.serverInfo));

orch.notify('notifications/initialized');
await worker.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
worker.notify('notifications/initialized');

const ping = await orch.call('ping', {});
check('ping: пустой результат', ping.result && Object.keys(ping.result).length === 0);

const tools = await orch.call('tools/list', {});
const names = (tools.result?.tools ?? []).map((t) => t.name).sort();
check('tools/list: сервер объявляет ровно набор из contract.js',
  names.join(',') === [...PROMPTOBUS_TOOLS].sort().join(','), `${names.join(',')} против ${[...PROMPTOBUS_TOOLS].sort().join(',')}`);
check('tools/list: у каждого есть описание и схема входа',
  (tools.result?.tools ?? []).every((t) => t.description && t.inputSchema?.type === 'object'));
// Греп по прозе описаний снят: он краснел на переписанном тексте и молчал на
// сломанном поведении. Потеря названа вслух: САМ ТЕКСТ описаний инструментов не сторожит
// никто — ни здесь, ни линтом (цитаты контракта его не покрывают). Проверки ниже
// закрывают текст ОТВЕТА инструмента, а не описания. Возвращать греп по прозе не надо;
// закрывать это стоит гейтом, а не подстроками.
const sendSchema = tools.result.tools.find((t) => t.name === 'promptobus_send').inputSchema;
check('tools/list: send требует to/type/body и знает типы протокола',
  sendSchema.required.join(',') === 'to,type,body'
  && sendSchema.properties.type.enum.join(',') === store.MESSAGE_TYPES.join(','),
  JSON.stringify(sendSchema.required));

const unknown = await orch.call('resources/list', {});
check('неизвестный метод → JSON-RPC ошибка -32601',
  unknown.error?.code === -32601, JSON.stringify(unknown.error));

// --- переписка двух процессов ------------------------------------------------

const empty = await worker.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check('inbox: пустой mailbox называет home, задачу и адрес',
  text(empty).startsWith('пусто')
    && text(empty).includes(`PROMPTOBUS_HOME=${HOME}`)
    && text(empty).includes(`task=${TASK}`)
    && text(empty).includes('address=worker:cargos-api'),
  text(empty));

const sent = await orch.call('tools/call', {
  name: 'promptobus_send',
  arguments: { to: 'worker:cargos-api', type: 'task', body: 'Добавь поле source в событие CargoCreated' },
});
check('send: отправлено', /отправлено task → cargos-api · адрес worker:cargos-api/.test(text(sent)), text(sent));

const got = await worker.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(`inbox: сообщение оркестратора дошло до worker'а`,
  text(got).includes('task от orchestrator') && text(got).includes('поле source'), text(got));
// : заголовок сообщения называет читаемое имя сессии отправителя — его поднимает в
// ленту хук, — а машинный адрес идёт следом, за меткой ` · адрес `. У orchestrator сессии
// нет вовсе: он назван словом, в позиции «от кого» — родительным падежом.
check(': у orchestrator сессии-имени нет — в заголовке он назван словом',
  text(got).includes('### task от оркестратора · адрес orchestrator · '), text(got));
const again = await worker.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check('inbox: прочитанное повторно не отдаётся', text(again).startsWith('пусто'), text(again));

// : подсказки «запусти ожидание снова» больше нет ни у кого. Переармировать
// ожидание протокол не требует: будильник в задаче один, и это надзиратель. Строка,
// зовущая делать то, чего протокол не просит, дороже своего отсутствия — по ней сессия
// заводила бы второй будильник на каждый ход.
check(': забранный mailbox ожидание заводить не зовёт',
  !/запусти ожидание снова/.test(text(got)) && !/mailbox забран/.test(text(got)), text(got));
check(': и пустой mailbox — тоже',
  !/запусти ожидание снова/.test(text(again)), text(again));

// Для reviewer'а `mailbox` — единственный способ получить сообщения: Bash у него снят
// deny-списком, и командой шины он до своей переписки не дотянется вовсе.
await orch.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'worker:cargos-api', type: 'task', body: 'единственным каналом' },
});
const onlyChannel = await worker.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(': mailbox отдал содержание и ожидание заводить не зовёт',
  text(onlyChannel).includes('единственным каналом')
  && !/запусти ожидание снова/.test(text(onlyChannel)), text(onlyChannel));

const taskNoHint = await worker.call('tools/call', { name: 'promptobus_task', arguments: {} });
const sendNoHint = await worker.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'orchestrator', type: 'status', body: 'подсказка тут не нужна' },
});
check(': task и send ожидание заводить не зовут',
  !/запусти ожидание снова/.test(text(taskNoHint)) && !/запусти ожидание снова/.test(text(sendNoHint)),
  `${text(taskNoHint)} | ${text(sendNoHint)}`);
await orch.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });

// Полный регресс : задачи в двух workspace одноимённые и различаются заголовком.
// MCP-сервер оркестратора запущен с cwd ВТОРОГО workspace, но его сгенерированный
// PROMPTOBUS_HOME указывает в первый — значит и mailbox он обязан забрать из первого.
await worker.call('tools/call', {
  name: 'promptobus_send',
  arguments: { to: 'orchestrator', type: 'status', body: 'первое непрочитанное' },
});
await worker.call('tools/call', {
  name: 'promptobus_send',
  arguments: { to: 'orchestrator', type: 'result', body: 'второе непрочитанное' },
});
check(': сообщения легли в HOME, а не в workspace, из которого запущен сервер',
  store.countInbox(HOME, TASK, 'orchestrator') === 2
  && store.countInbox(WRONG_HOME, TASK, 'orchestrator') === 0,
  `${store.countInbox(HOME, TASK, 'orchestrator')} / ${store.countInbox(WRONG_HOME, TASK, 'orchestrator')}`);
const sameInbox = await orch.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(': MCP inbox той же identity отдаёт те же два сообщения',
  text(sameInbox).includes('сообщений 2:')
    && text(sameInbox).includes('первое непрочитанное')
    && text(sameInbox).includes('второе непрочитанное')
    && text(sameInbox).includes(`PROMPTOBUS_HOME=${HOME}`)
    && store.countInbox(HOME, TASK, 'orchestrator') === 0
    && store.countInbox(WRONG_HOME, TASK, 'orchestrator') === 0,
  text(sameInbox));

// Доставка между процессами: worker отправляет, оркестратор забирает своим mailbox'ом.
await worker.call('tools/call', {
  name: 'promptobus_send',
  arguments: { to: 'orchestrator', type: 'result', body: 'Готово: contract.cs, publisher.cs' },
});
const delivered = await orch.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check('mailbox: пришедшее от worker\'а отдано целиком',
  text(delivered).includes('result от worker:cargos-api') && text(delivered).includes('contract.cs'),
  text(delivered));

const emptyBox = await orch.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check('mailbox: пусто — с identity, а не ошибка',
  text(emptyBox).startsWith('пусто') && text(emptyBox).includes(`PROMPTOBUS_HOME=${HOME}`), text(emptyBox));

// --- ошибки инструмента ------------------------------------------------------

const badType = await orch.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'worker:cargos-api', type: 'gossip', body: 'текст' },
});
check('tools/call: чужой тип — isError, соединение живо',
  badType.result?.isError === true && /protocol/i.test(text(badType)), text(badType));
const badAddr = await orch.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'boss', type: 'task', body: 'текст' },
});
check('tools/call: неизвестный адрес — isError', badAddr.result?.isError === true, text(badAddr));
const badTool = await orch.call('tools/call', { name: 'a2a_teleport', arguments: {} });
check('tools/call: unknown tool — isError',
  badTool.result?.isError === true && /a2a_teleport/.test(text(badTool)), text(badTool));

const stillAlive = await orch.call('tools/call', { name: 'promptobus_task', arguments: {} });
check('task: состав задачи после ошибок',
  text(stillAlive).includes(TASK) && text(stillAlive).includes('orchestrator')
  && text(stillAlive).includes('событие CargoCreated'), text(stillAlive));

check('сервер: в stdout ничего постороннего, в stderr тихо — у обоих соединений',
  orch.unsolicited.length === 0 && worker.unsolicited.length === 0
  && orch.stderr() === '' && worker.stderr() === '',
  `${orch.unsolicited.length}/${worker.unsolicited.length} · ${orch.stderr().slice(0, 120)}`
  + ` · worker: ${worker.stderr().slice(0, 120)}`);

// --- счётчик непрочитанного -----------------------------------------
//
// Стук надзирателя — best-effort: потерянный postcard ничего не теряет, но и не говорит
// ничего. Живой случай — `result` worker'а пролежал шесть минут. Поэтому свой mailbox
// называет каждый ход по шине — и только когда в нём что-то есть.
const quietSend = await orch.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'worker:cargos-api', type: 'task', body: 'ящик оркестратора пуст' },
});
check(': пустой свой mailbox send не называет — строка «всегда» перестаёт читаться',
  !/your mailbox/.test(text(quietSend)), text(quietSend));
const quietTask = await orch.call('tools/call', { name: 'promptobus_task', arguments: {} });
check(': пустой свой mailbox task не называет',
  !/your mailbox/.test(text(quietTask)), text(quietTask));

await worker.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
await worker.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'orchestrator', type: 'status', body: 'лежит и ждёт' },
});
const loudSend = await orch.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'worker:cargos-api', type: 'task', body: 'а в ящике непрочитанное' },
});
check(`: send называет счётчик своего mailbox'а и маршрут к нему`,
  /your mailbox: unread 1 — fetch it with the promptobus_mailbox tool/.test(loudSend.result ? text(loudSend) : ''),
  text(loudSend));
const loudTask = await orch.call('tools/call', { name: 'promptobus_task', arguments: {} });
check(': task отделяет свой mailbox от счётчиков участников',
  /your mailbox: unread 1/.test(text(loudTask)) && /^- orchestrator .*непрочитано 1$/m.test(text(loudTask)),
  text(loudTask));
check(': свой mailbox назван в шапке, до перечня участников',
  text(loudTask).indexOf('your mailbox:') < text(loudTask).indexOf('участники:'), text(loudTask));
const afterInbox = await orch.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(': inbox счётчика не печатает — он только что забрал сообщения',
  !/your mailbox/.test(text(afterInbox)) && text(afterInbox).includes('лежит и ждёт'), text(afterInbox));

// --- задача аргументом ----------------------------------------------
//
// Активных задач становится несколько, как только `promptobus review` заводит свою: резолв
// «единственной активной» тогда отказывает, а `PROMPTOBUS_TASK` закрепляется при старте
// сессии и в живой не меняется. Аргумент task — единственный способ дотянуться до
// нужной задачи из уже поднятой сессии; без него резолв прежний.
const SECOND = 'revyu-t20260813-100000';
store.createTask(HOME, { id: SECOND, title: 'ревью loads_search/cargos-api', slug: 'revyu', stamp: 't20260813-100000' });

const declared = await worker.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check('обратная совместимость: без аргумента берётся объявленная задача сессии',
  text(declared).includes(`task=${TASK}`), text(declared));

const loose = startServer('orchestrator', { task: '' });
await loose.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
loose.notify('notifications/initialized');

const ambiguous = await loose.call('tools/call', { name: 'promptobus_task', arguments: {} });
check('несколько активных задач без аргумента — отказ со списком, а не выбор наугад',
  ambiguous.result?.isError === true && text(ambiguous).includes(SECOND) && text(ambiguous).includes(TASK),
  text(ambiguous));

const picked = await loose.call('tools/call', { name: 'promptobus_task', arguments: { task: SECOND } });
check('task: аргумент task выбирает задачу, когда активных несколько',
  text(picked).includes(`задача ${SECOND}`) && text(picked).includes('ревью loads_search/cargos-api'), text(picked));

const sentSecond = await worker.call('tools/call', {
  name: 'promptobus_send',
  arguments: { to: 'orchestrator', type: 'status', body: 'отчёт по второй задаче', task: SECOND },
});
check('send: аргумент task сильнее объявленной сессии — сообщение ушло в указанную задачу',
  /отправлено status/.test(text(sentSecond))
  && store.countInbox(HOME, SECOND, 'orchestrator') === 1
  && store.countInbox(HOME, TASK, 'orchestrator') === 0, text(sentSecond));

// Отправитель, которого в чужой задаче не было, записывается её участником: без записи
// v1 нечего спросить у routing policy. Запись при этом СНЯТА С НАБЛЮДЕНИЯ — иначе
// надзиратель чужой задачи взял бы под присмотр сессию, которая просто написала туда
// однажды, и докладывал бы её оркестратору о стопе.
const guestIn = store.participantOf(store.readTask(HOME, SECOND), 'worker:cargos-api');
check(': отправитель чужой задачи записан участником и сразу снят с наблюдения',
  Boolean(guestIn) && Boolean(guestIn?.metadata.dismissed), JSON.stringify(guestIn));
check(': снятый с наблюдения гость в доклад о вставших не идёт',
  (blockedParticipants(HOME, SECOND, store.readTask(HOME, SECOND).participants,
    { 'worker:cargos-api': { state: 'gone', busy: false, stall: null, id: null } }) ?? []).length === 0);

const inboxSecond = await loose.call('tools/call', { name: 'promptobus_mailbox', arguments: { task: SECOND } });
check('inbox: аргумент task забирает mailbox указанной задачи',
  text(inboxSecond).includes('отчёт по второй задаче') && text(inboxSecond).includes(`task=${SECOND}`),
  text(inboxSecond));

const emptySecond = await loose.call('tools/call', { name: 'promptobus_mailbox', arguments: { task: SECOND } });
check('inbox: пустой mailbox указанной задачи называет её же',
  text(emptySecond).startsWith('пусто') && text(emptySecond).includes(`task=${SECOND}`), text(emptySecond));

const schemas = await loose.call('tools/list', {});
check('tools/list: аргумент task объявлен у всех трёх инструментов',
  (schemas.result?.tools ?? []).every((t) => t.inputSchema?.properties?.task?.type === 'string'),
  (schemas.result?.tools ?? []).map((t) => `${t.name}:${!!t.inputSchema?.properties?.task}`).join(','));

loose.stop();
store.closeTask(HOME, SECOND);

// --- имя задачи в identity ------------------------------------------
//
// Адрес `orchestrator` в задаче один, и владельца у него нет: сессия, не объявившая
// задачу, подцепляется к единственной активной — в живом случае к чужой — и читает её
// inbox. Запрета тут нет намеренно (сессия-преемник обязана дотянуться до своей же
// переписки), но id из слага и штампа чужую задачу не выдаёт, а тема выдаёт сразу.
const picking = startServer('orchestrator', { task: '' });
await picking.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
picking.notify('notifications/initialized');

const pickedInbox = await picking.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(': пустой inbox называет задачу по имени, а не одним id',
  text(pickedInbox).includes(`task=${TASK} "событие CargoCreated в двух сервисах"`), text(pickedInbox));

// Непустая ветка identity печатала и до  — новым тут стало имя задачи.
await worker.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'orchestrator', type: 'status', body: 'сообщение в подобранную задачу' },
});
const pickedMsgs = await picking.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(': непустой mailbox называет home, задачу с именем и адрес',
  text(pickedMsgs).includes('сообщение в подобранную задачу')
    && text(pickedMsgs).includes(`PROMPTOBUS_HOME=${HOME}`)
    && text(pickedMsgs).includes(`task=${TASK} "событие CargoCreated в двух сервисах"`)
    && text(pickedMsgs).includes('address=orchestrator'),
  text(pickedMsgs));
picking.stop();

// Зеркало той же беды: ответ на отправку не называл mailbox'а вовсе, и сообщение, ушедшее
// в чужую задачу, выглядело как ушедшее в свою.
const namedSend = await worker.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'orchestrator', type: 'status', body: 'проверка ящика отправки' },
});
check(': send называет mailbox, в который легло сообщение',
  /отправлено status → оркестратор · адрес orchestrator/.test(text(namedSend))
    && text(namedSend).includes(`PROMPTOBUS_HOME=${HOME}`)
    && text(namedSend).includes(`task=${TASK} "событие CargoCreated в двух сервисах"`)
    && text(namedSend).includes('address=worker:cargos-api'),
  text(namedSend));
store.readInbox(HOME, TASK, 'orchestrator');

// Задача, заведённая без заголовка, получает title = id: пустых кавычек и удвоенного
// id в identity быть не должно.
const NAMELESS = 't20260813-110000';
store.createTask(HOME, { id: NAMELESS });
check(': у задачи без имени печатается один id, без кавычек',
  store.identityLabel(HOME, NAMELESS, 'orchestrator') === `PROMPTOBUS_HOME=${HOME} · task=${NAMELESS} · address=orchestrator`,
  store.identityLabel(HOME, NAMELESS, 'orchestrator'));
store.closeTask(HOME, NAMELESS);

// --- владелец mailbox'а orchestrator ------------------------------------
//
// Роль по умолчанию — orchestrator, задача при одной активной берётся резолвом: в этот
// адрес попадает кто угодно, и чужая сессия уносила оригинал, а настоящий адресат его
// больше не видел. Запрета нет намеренно — сессия-преемник, чей демон умер, обязана
// дотянуться до своей же переписки. Поэтому чужому идёт копия и маршрут: не твоя
// переписка — назови свою задачу, твоя — забери mailbox аргументом claim.
const OWNED = 'owned-t20260827-000000';
const OWNER = 'owner-1111-2222';
const STRANGER = 'stranger-3333-4444';
store.createTask(HOME, { id: OWNED, title: 'ящик с владельцем', owner: OWNER });
check(': владелец записан в участника orchestrator при заведении задачи',
  store.taskOwner(HOME, OWNED) === OWNER, String(store.taskOwner(HOME, OWNED)));

const boot = async (srv) => {
  await srv.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  srv.notify('notifications/initialized');
  return srv;
};
const owns = await boot(startServer('orchestrator', { task: OWNED, env: { CLAUDE_CODE_SESSION_ID: OWNER } }));
const alien = await boot(startServer('orchestrator', { task: OWNED, env: { CLAUDE_CODE_SESSION_ID: STRANGER } }));
const anon = await boot(startServer('orchestrator', { task: OWNED, env: { CLAUDE_CODE_SESSION_ID: '' } }));
const putOwned = (body) => store.sendMessage(HOME, OWNED, { from: 'worker:cargos-api', to: 'orchestrator', type: 'result', body });

putOwned('оригинал владельца');
const alienInbox = await alien.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(': чужой сессии — копия с громкой шапкой, обоими id и маршрутом',
  /ЧУЖОЙ MAILBOX/.test(text(alienInbox)) && text(alienInbox).includes(OWNER) && text(alienInbox).includes(STRANGER)
  && text(alienInbox).includes('оригинал владельца') && /claim/.test(text(alienInbox)), text(alienInbox));
check(': чужой mailbox подсказки про ожидание не несёт',
  !/запусти ожидание снова/.test(text(alienInbox)), text(alienInbox));
check(`: оригинал остался в mailbox'е владельца`,
  store.countInbox(HOME, OWNED, 'orchestrator') === 1,
  String(store.countInbox(HOME, OWNED, 'orchestrator')));

// , замечание ревью: contact point сдаёт ТОЛЬКО владелец mailbox'а. Сессия,
// приехавшая в чужую задачу резолвом «единственной активной», иначе вписала бы свой сокет
// в `wake/orchestrator.json` чужого run'а — и надзиратель будил бы её вместо владельца.
// Цена двойная: стук уходит не туда, а mailbox настоящего владельца при этом не пустеет
// (чужому идут копии) — значит стук повторяется до потолка.
//
// Сокет здесь фиктивный: предмет проверки — записался файл или нет, а не доставка.
const wakeEnv = (id) => ({
  CLAUDE_CODE_SESSION_ID: id,
  CLAUDE_CODE_MESSAGING_SOCKET: `/tmp/promptobus-mcp-wake-${id}.sock`,
  CLAUDE_CODE_MESSAGING_TOKEN: `tok-${id}`,
});
const alienWake = await boot(startServer('orchestrator', { task: OWNED, env: wakeEnv(STRANGER) }));
await alienWake.call('tools/call', { name: 'promptobus_task', arguments: {} });
check(': чужая сессия contact point не сдаёт',
  store.readWake(HOME, OWNED, 'orchestrator') === null,
  JSON.stringify(store.readWake(HOME, OWNED, 'orchestrator')));
const ownerWake = await boot(startServer('orchestrator', { task: OWNED, env: wakeEnv(OWNER) }));
await ownerWake.call('tools/call', { name: 'promptobus_task', arguments: {} });
check(`: владелец mailbox'а contact point сдаёт`,
  store.readWake(HOME, OWNED, 'orchestrator')?.socket === `/tmp/promptobus-mcp-wake-${OWNER}.sock`,
  JSON.stringify(store.readWake(HOME, OWNED, 'orchestrator')));
// Оба сервера снимаются сразу: живой дочерний процесс держит событийный цикл файла, и
// файл не завершается вовсе — а раннер снимает его по потолку как зависший.
alienWake.stop();
ownerWake.stop();
rmSync(store.wakeFile(HOME, OWNED, 'orchestrator'), { force: true });

check(': чтение чужого оригинал не унесло',
  store.countInbox(HOME, OWNED, 'orchestrator') === 1,
  String(store.countInbox(HOME, OWNED, 'orchestrator')));

const anonInbox = await anon.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(': окружение не дало идентичности — механизм молчит, чтение прежнее',
  !/ЧУЖОЙ MAILBOX/.test(text(anonInbox)) && text(anonInbox).includes('оригинал владельца')
  && store.countInbox(HOME, OWNED, 'orchestrator') === 0, text(anonInbox));

putOwned('второй оригинал');
const ownerInbox = await owns.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(': владелец читает свой mailbox как прежде — оригиналы уходят',
  !/ЧУЖОЙ MAILBOX/.test(text(ownerInbox)) && text(ownerInbox).includes('второй оригинал')
  && store.countInbox(HOME, OWNED, 'orchestrator') === 0, text(ownerInbox));

putOwned('преемнику');
const claimed = await alien.call('tools/call', { name: 'promptobus_mailbox', arguments: { claim: true } });
check(': claim закрепляет mailbox за преемником, называет прежнего владельца и отдаёт оригиналы',
  /MAILBOX ЗАХВАЧЕН/.test(text(claimed)) && text(claimed).includes(OWNER) && text(claimed).includes(STRANGER)
  && text(claimed).includes('преемнику') && store.taskOwner(HOME, OWNED) === STRANGER
  && store.countInbox(HOME, OWNED, 'orchestrator') === 0, text(claimed));

// : захват — это и перепривязка, но обещание «дальше без аргумента» держится
// только по АКТИВНОЙ задаче (замечание ревью). Захват закрытой законен — её переписку
// читать никто не запрещал, — а привязывается только активная (`bindSession`), и резолв
// в закрытую задачу не придёт никогда: обещать его там значило бы соврать в ответе.
check(': захват активной задачи привязал сессию и обещал резолв без аргумента',
  store.boundTaskId(HOME, STRANGER) === OWNED
  && /дальше задача резолвится без аргумента/.test(text(claimed)), text(claimed));
const CLOSED_TASK = 'zakrytaya-t20260829-040000';
store.createTask(HOME, { id: CLOSED_TASK, title: 'закрытый заход', owner: OWNER });
store.closeTask(HOME, CLOSED_TASK);
const claimedClosed = await alien.call('tools/call', { name: 'promptobus_mailbox', arguments: { claim: true, task: CLOSED_TASK } });
check(': захват закрытой задачи проходит, но резолва без аргумента не обещает',
  /MAILBOX ЗАХВАЧЕН/.test(text(claimedClosed))
  && !/дальше задача резолвится без аргумента/.test(text(claimedClosed))
  && store.boundTaskId(HOME, STRANGER) === OWNED, text(claimedClosed));

const CLAIM_WAKE = 'claimwake-t20260904-030000';
const CLAIM_OLD = 'claim-old-sess';
const CLAIM_NEW = 'claim-new-sess';
store.createTask(HOME, { id: CLAIM_WAKE, title: 'claim сдаёт сокет', owner: CLAIM_OLD });
store.writeWake(HOME, CLAIM_WAKE, 'orchestrator', {
  socket: '/tmp/promptobus-mcp-wake-old.sock', token: 'old', session: CLAIM_OLD,
});
const heirMcp = await boot(startServer('orchestrator', { task: CLAIM_WAKE, env: wakeEnv(CLAIM_NEW) }));
const claimedWake = await heirMcp.call('tools/call', { name: 'promptobus_mailbox', arguments: { claim: true } });
check('преемник: claim тем же вызовом переписывает contact point на новую сессию',
  /MAILBOX ЗАХВАЧЕН/.test(text(claimedWake))
  && store.readWake(HOME, CLAIM_WAKE, 'orchestrator')?.session === CLAIM_NEW
  && store.readWake(HOME, CLAIM_WAKE, 'orchestrator')?.socket === `/tmp/promptobus-mcp-wake-${CLAIM_NEW}.sock`,
  `${text(claimedWake)}\n${JSON.stringify(store.readWake(HOME, CLAIM_WAKE, 'orchestrator'))}`);
heirMcp.stop();

putOwned('после захвата');
const afterClaim = await alien.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(': после захвата преемник читает без копий',
  !/ЧУЖОЙ MAILBOX/.test(text(afterClaim)) && text(afterClaim).includes('после захвата'), text(afterClaim));

putOwned('уже не твоё');
const wasOwner = await owns.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(': прежний владелец после захвата сам стал чужим — mailbox один, владелец один',
  /ЧУЖОЙ MAILBOX/.test(text(wasOwner)) && store.countInbox(HOME, OWNED, 'orchestrator') === 1, text(wasOwner));
store.readInbox(HOME, OWNED, 'orchestrator');

// Пустота чужого mailbox'а без шапки читается как «сообщений нет»: маршрут
// «назови свою задачу или забери mailbox» жил только в stdout команды — в канале, которого
// агент не читает. `mailbox` зовут раз на ход, а не в цикле опроса, поэтому шумом шапка
// тут не станет.
const emptyForeignInbox = await owns.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(': пустой чужой mailbox тоже назван чужим — с маршрутом к claim',
  text(emptyForeignInbox).startsWith('ЧУЖОЙ MAILBOX')
  && /claim/.test(text(emptyForeignInbox)), text(emptyForeignInbox));

// Счётчик непрочитанного чужому mailbox'у говорит другое: «забери инструментом inbox»
// там ложь и ведёт ровно туда, куда гейт ходить запрещает, — сигнал работал бы против
// защиты в том самом сценарии, ради которого задача и делалась.
putOwned('счётчик чужому');
const foreignCount = await owns.call('tools/call', { name: 'promptobus_task', arguments: {} });
check(': чужому счётчик не зовёт в inbox — сигнал не работает против гейта',
  /ЧУЖОЙ MAILBOX: unread 1/.test(text(foreignCount)) && !/your mailbox/.test(text(foreignCount))
  && /claim/.test(text(foreignCount)), text(foreignCount));
joinWorker(HOME, OWNED);
const foreignSend = await owns.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'worker:cargos-api', type: 'status', body: 'счётчик в ответе отправки' },
});
check(': та же формулировка в ответе send',
  /ЧУЖОЙ MAILBOX: unread 1/.test(text(foreignSend)) && !/your mailbox/.test(text(foreignSend)),
  text(foreignSend));
store.readInbox(HOME, OWNED, 'orchestrator');

const ownedTask = await alien.call('tools/call', { name: 'promptobus_task', arguments: {} });
check(': владелец назван в перечне участников, отдельного рендера ему не нужно',
  new RegExp(`- orchestrator · владелец ${STRANGER}`).test(text(ownedTask)), text(ownedTask));

// Совместимость назад: задача, заведённая прежним CLI, владельца не имеет — механизм
// выключен целиком, иначе старые задачи стали бы нечитаемыми.
const LEGACY = 'legacy-t20260827-000000';
store.createTask(HOME, { id: LEGACY, title: 'задача прежнего CLI', owner: null });
store.sendMessage(HOME, LEGACY, { from: 'worker:cargos-api', to: 'orchestrator', type: 'status', body: 'наследство' });
const legacyRead = await alien.call('tools/call', { name: 'promptobus_mailbox', arguments: { task: LEGACY } });
check(': у задачи без владельца поведение прежнее — ни копий, ни предупреждений',
  !/ЧУЖОЙ MAILBOX/.test(text(legacyRead)) && text(legacyRead).includes('наследство')
  && store.countInbox(HOME, LEGACY, 'orchestrator') === 0, text(legacyRead));

const legacyClaim = await alien.call('tools/call', { name: 'promptobus_mailbox', arguments: { task: LEGACY, claim: true } });
check(': claim на задаче без владельца — отказ, гейт задним числом не включаем',
  /владельца нет/.test(text(legacyClaim)) && store.taskOwner(HOME, LEGACY) === null, text(legacyClaim));

const anonClaim = await anon.call('tools/call', { name: 'promptobus_mailbox', arguments: { claim: true } });
check(': claim без идентичности сессии — громкий отказ, а не молчаливый ноль',
  /захватить mailbox нечем/.test(text(anonClaim)) && store.taskOwner(HOME, OWNED) === STRANGER, text(anonClaim));

const workerClaim = await worker.call('tools/call', { name: 'promptobus_mailbox', arguments: { claim: true } });
check(`: claim у worker'а — громкий отказ: его адрес владельца не имеет`,
  /владельца не имеет/.test(text(workerClaim)), text(workerClaim));

store.closeTask(HOME, OWNED);
store.closeTask(HOME, LEGACY);
owns.stop();
alien.stop();
anon.stop();

// --- задача не объявлена -----------------------------------------------------

const lost = await new Promise((resolve) => {
  const child = spawn(process.execPath, [BIN, 'mcp'], {
    cwd: SB,
    env: { ...process.env, PROMPTOBUS_ROLE: 'orchestrator', PROMPTOBUS_HOME: path.join(SB, 'empty'), PROMPTOBUS_TASK: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    out += c;
    if (out.includes('\n')) {
      child.kill();
      resolve(JSON.parse(out.split('\n')[0]));
    }
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'promptobus_task', arguments: {} } }) + '\n');
});
check('без активной задачи: инструмент объясняет, как её завести',
  lost.result?.isError === true && /promptobus spawn/.test(lost.result.content[0].text),
  lost.result?.content?.[0]?.text?.slice(0, 120));

// --- : первая строка называет, а не считает ----------------------------
//
// Ответ MCP-инструмента Claude Code кладёт в свёрнутый tool-блок, и человек видит
// только превью первой строки. По «сообщений: 3» не понять, стоит ли раскрывать блок.
// Сама сборка первой строки и читаемое имя участника — чистые функции package'а, и все их
// ветки проверены в его наборе ([mcp.test.mjs](../packages/promptobus/test/mcp.test.mjs)).
// Здесь остаётся то, чего там нет: живой ответ сервера CLI.
// Живой ответ — не только сама функция: без этой проверки её можно было бы отцепить от
// renderMessages, и первая строка снова считала бы, а вердикт молчал.
const sameHead = text(sameInbox).split('\n')[0];
check(': первая строка живого ответа называет отправителя и оба типа',
  sameHead.startsWith('сообщений 2: status от worker:cargos-api, result от worker:cargos-api ·'), sameHead);
// Служебный хвост на месте — ради него строку и читают.
check(': служебный хвост первой строки сохранён целиком',
  sameHead.includes(`PROMPTOBUS_HOME=${HOME}`) && sameHead.includes('address=orchestrator')
  && sameHead.includes(TASK), sameHead);
// Ответ отправки называет тип и адресата первым делом — до служебного хвоста.
check(': ответ send начинается с того, что и кому ушло',
  /^отправлено task → cargos-api · адрес worker:cargos-api/.test(text(sent)), text(sent).split('\n')[0]);

// --- : тревоги «звонка нет» больше нет ---------------------------------
//
// Отметку снимаем — прежде ровно это состояние поднимало тревогу первой строкой ответа.
// Ожидание ушло из протокола вместе с ней: заводить нечего, и звать нечего. Стерегут это
// первые строки обоих ответов: место у тревоги было ровно там, и занято оно существом
// ответа — что и кому ушло, какая задача.
const gapSend = await orch.call('tools/call', {
  name: 'promptobus_send',
  arguments: { to: 'worker:cargos-api', type: 'status', body: 'звонка нет и не надо' },
});
check(': send начинается с того, что и кому ушло',
  /^отправлено status → cargos-api · адрес worker:cargos-api/.test(text(gapSend)),
  text(gapSend).split('\n')[0]);

const gapTask = await orch.call('tools/call', { name: 'promptobus_task', arguments: {} });
check(': task начинается с задачи, а не с тревоги',
  text(gapTask).split('\n')[0].startsWith(`задача ${TASK}`),
  text(gapTask).split('\n')[0]);

// --- : читаемое имя сессии в ответах шины ------------------------------
//
// Хук ленты видит только `tool_input` и `tool_response` события — журнала задачи у него
// нет, и имя сессии в ответ обязан положить сервер. Имя берётся из поля `name` записи
// участника (по нему же ищет `findSession`), а хвостовая скобочная метка `(ММДД-ЧЧММ)`
// снимается: в строке ленты она стоит места, а различает — имя работы, не штамп.
const NAMED = 'worker:gates';
const NAMED_FULL = 'Worker: Гейты lint: слепые зоны, контрактный маркер';
store.upsertParticipant(HOME, TASK, store.participantRecord(NAMED, { repo: 'agent-workspace/promptobus', name: `${NAMED_FULL} (0829-1208)` }));
const toNamed = await orch.call('tools/call', {
  name: 'promptobus_send', arguments: { to: NAMED, type: 'status', body: 'проверка имени' },
});
check(': отправка называет читаемое имя получателя — без хвостовой скобочной метки',
  text(toNamed).startsWith(`отправлено status → ${NAMED_FULL} · адрес ${NAMED} · id `),
  text(toNamed).split('\n')[0]);
// Адрес и id из ответа не пропали: в ленту хук их не поднимает, а человеку, читающему
// сырой ответ, отвечать по ним.
check(': машинные адрес и id остались в ответе отправки',
  text(toNamed).includes(` · адрес ${NAMED} · id `) && /· id \S+ · PROMPTOBUS_HOME=/.test(text(toNamed)),
  text(toNamed).split('\n')[0]);

const gates = startServer(NAMED);
await gates.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
await gates.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'orchestrator', type: 'result', body: 'гейты закрыты' },
});
gates.stop();
const fromNamed = await orch.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(`: заголовок в mailbox'е называет имя сессии, машинный адрес — следом`,
  text(fromNamed).includes(`### result от ${NAMED_FULL} · адрес ${NAMED} · `), text(fromNamed));
// Участник без записанного имени (запись прежнего CLI, участник мимо spawn'а) — адрес без
// префикса роли: так его печатал хук и до этой правки.
check(': участник без записанного имени назван адресом без префикса роли',
  /отправлено task → cargos-api · адрес worker:cargos-api/.test(text(sent)), text(sent).split('\n')[0]);


// --- : маршрут по вставшему доходит до агента --------------------------
//
// Прежде он жил только в stdout завершившейся фоновой команды — в канале, которого
// агент не читает: нотификация несёт код возврата и путь к файлу. Место ему — ответ
// `inbox`: его зовут ровно на пробуждении, до решения о следующем шаге.
const STALLED = 'stalled-t20260828-150000';
const GHOST_NAME = 'Worker: призрак';
store.createTask(HOME, { id: STALLED, title: 'вставший участник' });
store.upsertParticipant(HOME, STALLED, store.participantRecord('worker:cargos-api', { name: GHOST_NAME }));
// Запись без pid рядом с живой записью с pid — «LISTED, but no process behind it»
//: признак самокалибрующийся, и одной записи для него мало.
const STALL_BIN = path.join(ROOT, 'stall-bin');
// Замечание ревью: ответ `mailbox` — третий потребитель предиката стопа, и
// молчать о штатном конце хода он обязан наравне с postcard'ом и `promptobus status`. Участник
// `worker:sdal` прислал `result` и закончил ход: его запись `blocked` с живым pid, но
// сообщение на шине новее его последней активации.
const SDAL_NAME = 'Worker: сдавший';
store.upsertParticipant(HOME, STALLED, store.participantRecord('worker:sdal', { name: SDAL_NAME }));
const sdalMsg = store.sendMessage(HOME, STALLED,
  { from: 'worker:sdal', to: 'orchestrator', type: 'result', body: 'итог куска' });
store.writeHealth(HOME, STALLED,
  { 'worker:sdal': { deliveredAt: new Date(Date.parse(sdalMsg.message.ts) - 60000).toISOString() } });
stubCommand(STALL_BIN, 'claude', `process.stdout.write(${JSON.stringify(JSON.stringify([
  { id: 'live9', name: 'Worker: живой', state: 'working', pid: 9191 },
  { id: 'ghost9', name: GHOST_NAME, state: 'blocked' },
  { id: 'sdal9', name: SDAL_NAME, state: 'blocked', pid: 7777 },
]))});`);
const watcher = startServer('orchestrator', {
  task: STALLED,
  env: { PATH: `${STALL_BIN}${path.delimiter}${process.env.PATH}` },
});
await watcher.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
watcher.notify('notifications/initialized');
const stalledInbox = text(await watcher.call('tools/call', { name: 'promptobus_mailbox', arguments: {} }));
check(': inbox докладывает вставшего участника — теми же словами, что и команда',
  /worker:cargos-api LISTED, but no process behind it/.test(stalledInbox)
  && /claude logs ghost9/.test(stalledInbox) && /each has its own route/.test(stalledInbox), stalledInbox);
// Доклад приходит в ответе инструмента, а не только в stdout завершившейся команды: его
// читает агент, и маршрут по вставшему обязан доехать до него.
check(': доклад ведёт заводить ожидание не зовёт — маршрут по каждому свой',
  !/запусти ожидание снова/.test(stalledInbox), stalledInbox);
check('замечание ревью: ответ mailbox не зовёт вставшим того, кто только что прислал сообщение',
  !/worker:sdal stalled/.test(stalledInbox) && /worker:cargos-api LISTED/.test(stalledInbox), stalledInbox);
watcher.stop();

// Worker'у смотреть не за кем: его собеседник не bg-session, а сессия человека, и в
// `claude agents --json` её стопа не видно — то же условие, что у команды.
const watcherWorker = startServer('worker:cargos-api', {
  task: STALLED,
  env: { PATH: `${STALL_BIN}${path.delimiter}${process.env.PATH}` },
});
await watcherWorker.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
watcherWorker.notify('notifications/initialized');
const workerInbox = text(await watcherWorker.call('tools/call', { name: 'promptobus_mailbox', arguments: {} }));
check(`: worker'у доклада о вставших нет — смотреть ему не за кем`,
  !/LISTED/.test(workerInbox), workerInbox);
watcherWorker.stop();

// --- : негодная запись участника не роняет task --------------------
//
// Адрес участника уезжает в имя каталога mailbox'а, и на записи с испорченным адресом падал
// `countInbox`, унося весь ответ инструмента: сессия переставала видеть и участников, и
// артефакты, и непрочитанное — из-за одной строки журнала, которую по этому же ответу и
// чинят. Порча кладётся в журнал напрямую: через `upsertParticipant` такой адрес не
// пройдёт, а на диск он попадает от прежнего CLI и от правки руками.
const BADREC = 'negodnaya-t20260829-060000';
const badTask = store.createTask(HOME, { id: BADREC, title: 'негодная запись участника' });
// Запись годна по схеме store и негодна по адресу: адрес — поле adapter'а, и схема его не
// смотрит вовсе. Годной по схеме она обязана быть, иначе испорчен весь журнал, а это другой
// случай со своим ответом («задача повреждена»).
const spoiled = (id, address, repo) => ({
  id, role: 'worker', harness: 'claude', mode: 'attached', sessionRef: null, capabilities: null,
  metadata: { address, repo },
});
badTask.participants.push(spoiled('worker-ne-adres', 'worker:НЕ АДРЕС', 'ns/repo'));
badTask.participants.push(spoiled('worker-cargos-api', 'worker:cargos-api', 'loads_search/cargos-api'));
writeFileSync(store.taskFile(HOME, BADREC), JSON.stringify(badTask, null, 2) + '\n');
const badServer = startServer('orchestrator', { task: BADREC });
await badServer.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
badServer.notify('notifications/initialized');
const badOut = await badServer.call('tools/call', { name: 'promptobus_task', arguments: {} });
const badText = text(badOut);
check(': одна негодная запись не валит task — ответ пришёл, а не ошибка',
  badOut.result?.isError !== true && /задача negodnaya-t20260829-060000/.test(badText), badText);
check(': негодная запись названа в ответе целиком — по ней журнал и чинят',
  /НЕГОДНАЯ ЗАПИСЬ УЧАСТНИКА/.test(badText) && badText.includes('worker:НЕ АДРЕС'), badText);
check(': остальные участники живут — orchestrator и worker на месте со счётчиками',
  /- orchestrator .*непрочитано 0/.test(badText)
  && /- worker:cargos-api .*непрочитано 0/.test(badText), badText);
badServer.stop();

// ---  и : битое сообщение доходит до АГЕНТА, а не только в stderr ------
//
// Доклад о битом жил одним `warn`. У MCP-пути stderr — лог harness'а, в который сессия не
// смотрит: сообщение исчезало из mailbox'а без единого слова в ответе инструмента. Класс тот же, что у маршрутов по вставшим
//, и решается так же — обязательное для агента живёт в ответе.
const BROKEN = 'bitoe-t20260829-071000';
store.createTask(HOME, { id: BROKEN, title: 'битое доходит до агента' });
joinWorker(HOME, BROKEN);
const brokenBox = store.inboxDir(HOME, BROKEN, 'worker:cargos-api');
mkdirSync(brokenBox, { recursive: true });
// Так выглядит файл процесса, умершего посреди записи прежним CLI (без link/rename).
const BROKEN_NAME = '20260829T071000000-0001-orchestrator.json';
writeFileSync(path.join(brokenBox, BROKEN_NAME), 'не json вовсе');
store.sendMessage(HOME, BROKEN, {
  from: 'orchestrator', to: 'worker:cargos-api', type: 'status', body: 'целое рядом с битым',
});
const brokenSrv = startServer('worker:cargos-api', { task: BROKEN });
await brokenSrv.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
brokenSrv.notify('notifications/initialized');
const brokenInbox = text(await brokenSrv.call('tools/call', { name: 'promptobus_mailbox', arguments: {} }));
check(': inbox называет битое сообщение в ОТВЕТЕ, а не только в stderr',
  brokenInbox.includes('BROKEN MESSAGE') && brokenInbox.includes(BROKEN_NAME), brokenInbox);
check(': доклад идёт первой строкой — это находка, а хвост длинного ответа читают не всегда',
  brokenInbox.startsWith('BROKEN MESSAGE'), brokenInbox.split('\n')[0]);
check(': целое рядом с битым дошло тем же ответом',
  brokenInbox.includes('целое рядом с битым'), brokenInbox);

// Тот же доклад — на ПУСТОМ ответе: битое mailbox покинуло, целого рядом нет, и без строки
// в ответе агент увидел бы обычное «пусто».
const SECOND_BROKEN = '20260829T071500000-0001-orchestrator.json';
writeFileSync(path.join(brokenBox, SECOND_BROKEN), '{"оборван');
const brokenEmpty = text(await brokenSrv.call('tools/call', { name: 'promptobus_mailbox', arguments: {} }));
check(': mailbox называет битое и на пустом ответе',
  brokenEmpty.includes('BROKEN MESSAGE') && brokenEmpty.includes(SECOND_BROKEN)
  && brokenEmpty.includes('пусто'), brokenEmpty);
check(': оба битых уехали в broken/, mailbox не заткнут',
  store.countInbox(HOME, BROKEN, 'worker:cargos-api') === 0
  && readdirSync(store.brokenDir(HOME, BROKEN, 'worker:cargos-api')).length === 2,
  readdirSync(store.brokenDir(HOME, BROKEN, 'worker:cargos-api')).join(','));
brokenSrv.stop();

// --- пачка сообщений уходит одним ответом -----------------------------------
//
// Задача и mailbox здесь свои: сообщения, залежавшиеся от прежних проверок, смешались бы
// с пачкой этой.
const RACE = 'pachka-t20260829-070500';
store.createTask(HOME, { id: RACE, title: 'пачка одним ответом' });
joinWorker(HOME, RACE);
const racer = startServer('worker:cargos-api', { task: RACE });
await racer.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
racer.notify('notifications/initialized');

for (const body of ['первое из пачки', 'второе из пачки', 'третье из пачки']) {
  store.sendMessage(HOME, RACE, { from: 'orchestrator', to: 'worker:cargos-api', type: 'status', body });
}
check(`пачка целиком лежит в mailbox'е — делить её некому`,
  store.countInbox(HOME, RACE, 'worker:cargos-api') === 3,
  String(store.countInbox(HOME, RACE, 'worker:cargos-api')));
const whole = await racer.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check('пачка целиком в одном ответе',
  ['первое из пачки', 'второе из пачки', 'третье из пачки'].every((b) => text(whole).includes(b))
  && store.countInbox(HOME, RACE, 'worker:cargos-api') === 0, text(whole));

// --- порядок ответов — порядок запросов --------------------------------------
//
// Инструменты синхронны, поэтому запросы идут строго по одному и ответы приходят в
// порядке запросов. Заведи асинхронный — порядок пришлось бы разбирать заново каждому,
// кто читает этот канал, и первым делом самому сервером.
const ordered = racer.batch([
  { method: 'ping', params: {} },
  { method: 'tools/call', params: { name: 'promptobus_task', arguments: {} } },
  { method: 'tools/list', params: {} },
  { method: 'tools/call', params: { name: 'promptobus_mailbox', arguments: {} } },
  { method: 'tools/call', params: { name: 'promptobus_send', arguments: { to: 'orchestrator', type: 'status', body: 'по очереди' } } },
  { method: 'ping', params: {} },
]);
const answers = await Promise.all(ordered);
const asked = answers.map((a) => a.id);
const came = racer.arrived.filter((id) => asked.includes(id));
check('порядок методов сохранён — ответы пришли в порядке запросов',
  came.join(',') === asked.join(','), `${came.join(',')} против ${asked.join(',')}`);
check('и ответил каждый из них, без ошибки инструмента',
  answers.every((a) => a.result !== undefined && a.result.isError !== true),
  JSON.stringify(answers.map((a) => a.result?.isError ?? 'ok')));
racer.stop();

// Итог по настоящим серверам — ДО пробы ниже, а не после: проба заводит сервер, который
// пишет мусор нарочно, и вердикт, стоящий за ней, краснеть уже не может ни при каком коде.
check('в stdout серверов не было ничего, кроме построчного JSON-RPC',
  strays.length === 0, strays.slice(0, 3).map((x) => `${x.role}: ${x.line}`).join(' | '));

// --- : посторонняя строка в stdout — красная проверка, а не смерть файла ---
//
// Проба живьём, а не рассуждением: сервером назначается процесс, который пишет в stdout
// не-JSON. До починки этот же ввод уносил весь файл на первом же чанке. Считаем дельту, а
// не длину: настоящие серверы выше свой вердикт уже получили, и обнулять накопитель под
// ними значило бы стирать улику.
const straysBefore = strays.length;
const noisy = startServer('worker:cargos-api', {
  config: { command: process.execPath, args: ['-e', "process.stdout.write('не json вовсе\\n')"] },
});
for (let i = 0; i < 200 && strays.length === straysBefore; i += 1) await new Promise((r) => { setTimeout(r, 20); });
noisy.stop();
check(': посторонняя строка сервера записана и названа, а файл жив',
  strays.length - straysBefore === 1 && strays[strays.length - 1].line === 'не json вовсе',
  JSON.stringify(strays.slice(straysBefore)));

// --- : слова ошибки протокола остаются у adapter'а ---------------------
//
// Package называет событие типом и ставит код JSON-RPC, а слова даёт `errorText` в
// [server.js](../lib/server.js). Коды проверены выше, слова — нигде: уехав в callback,
// текст мог бы поехать молча. Соединение отдельное: ответ на неразобранную строку идёт с
// `id: null`, обещания у него нет, и он лёг бы в незапрошенные соседних серверов — а там
// проверяется, что незапрошенного не было.
const words = startServer('orchestrator');
await words.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
const noMethod = await words.call('resources/list', {});
check(': текст неизвестного метода прежний, слово в слово',
  noMethod.error?.message === 'method "resources/list" is not supported', JSON.stringify(noMethod.error));
const noTool = await words.call('tools/call', { name: 'teleport', arguments: {} });
check(': текст неизвестного инструмента прежний, слово в слово',
  text(noTool) === 'error: unknown tool "teleport"', text(noTool));
const failedTool = await words.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'worker:cargos-api', type: 'gossip', body: 'текст' },
});
check(': отказ инструмента идёт зачином "error: " и без стека',
  text(failedTool).startsWith('error: ') && !/\n\s+at /.test(text(failedTool)), text(failedTool));
words.raw('{ это не json\n');
for (let i = 0; i < 200 && words.unsolicited.length === 0; i += 1) await new Promise((r) => { setTimeout(r, 20); });
const parseFail = words.unsolicited[0];
check(': неразобранная строка — -32700 прежним текстом и с id null',
  parseFail?.id === null && parseFail?.error?.code === -32700
  && parseFail?.error?.message === 'not parsed as JSON', JSON.stringify(parseFail));
const afterParse = await words.call('ping', {});
check(': соединение неразобранную строку пережило',
  afterParse.result && Object.keys(afterParse.result).length === 0, JSON.stringify(afterParse));
words.stop();

// --- : переезд при объявленном PROMPTOBUS_HOME --------------------------------
//
// Самое частое первое касание store — вызов инструмента шины из сессии, а дом ей объявлен
// переменной. Standalone host не объявляет прежнюю раскладку (`legacyLayout() === null`),
// поэтому переезд здесь зовётся тем же adapter'ом с явным layout, каким его зовут команды.
const MIG_ROOT = path.join(SB, 'pereezd');
mkdirSync(MIG_ROOT, { recursive: true });
writeFileSync(path.join(MIG_ROOT, 'promptobus.json'), `${JSON.stringify({ commandName: 'promptobus', tools: ['claude'] })}\n`);
const MIG_LEGACY = path.join(MIG_ROOT, 'legacy', 'a2a');
const MIG_TASK = 'pereezd-t20260902-090000';
const { legacy } = await import(path.join(here, '..', 'dist', 'index.js'));
legacy.createTask(MIG_LEGACY, { id: MIG_TASK, title: 'задача прежнего store', owner: OWNER });
legacy.upsertParticipant(MIG_LEGACY, MIG_TASK, { address: 'worker:cargos-api', repo: 'cargos-api' });
legacy.sendMessage(MIG_LEGACY, MIG_TASK, {
  from: 'worker:cargos-api', to: 'orchestrator', type: 'result', body: 'итог из прежнего store',
});
legacy.closeTask(MIG_LEGACY, MIG_TASK);

const migHost = { legacyLayout: () => ({ rel: 'legacy/a2a', done: 'promptobus done <id>' }) };
const movedId = store.resolveIdentity({
  PROMPTOBUS_ROLE: 'orchestrator',
  PROMPTOBUS_HOME: MIG_LEGACY,
  PROMPTOBUS_TASK: MIG_TASK,
}, MIG_ROOT, { host: migHost });
check(': resolveIdentity с host, который называет прежнюю раскладку, переезжает в новый store',
  movedId.home === realpathSync(path.join(MIG_ROOT, '.promptobus'))
  && !existsSync(MIG_LEGACY)
  && existsSync(path.join(MIG_ROOT, '.promptobus', 'tasks', MIG_TASK, 'task.json')),
  `${movedId.home} · прежний ${existsSync(MIG_LEGACY)}`);

const stale = store.resolveIdentity({
  PROMPTOBUS_ROLE: 'orchestrator', PROMPTOBUS_HOME: MIG_LEGACY,
}, MIG_ROOT, { host: migHost });
check(': устаревший PROMPTOBUS_HOME ведёт в новый корень и не воссоздаёт прежний',
  stale.home === realpathSync(path.join(MIG_ROOT, '.promptobus')) && !existsSync(MIG_LEGACY),
  `${stale.home} · прежний ${existsSync(MIG_LEGACY) ? 'воскрес' : 'снят'}`);

// --- : строки участника, которые собирает adapter ----------------------
//
// `repository`, `worktree … (branch)` и `bg-session` в ответе `task` собирает
// `decorateParticipant` ([server.js](../lib/server.js)) — store этих полей не
// печатает. До этой задачи их не сверял никто: мутационная проба  отцепила хук
// decoration целиком, и файл остался зелёным — краснел только golden набора package и
// только по строке `repository`. Worktree здесь НАСТОЯЩИЙ: ветку в этой строке называет
// git, а не журнал, и на выдуманном пути проверялась бы ветка журнальная.
const DECOR = 'decor-t20260902-130000';
const DECOR_REPO = path.join(ROOT, 'repo-decor');
const DECOR_BRANCH = 'worktree-promptobus-decor';
const DECOR_WT = path.join(DECOR_REPO, '.claude', 'worktrees', 'promptobus-decor');
// Код возврата у самого git, а не у стенда: упавший `worktree add` (или `init -b` на git
// старше 2.28) дал бы красную «git did not answer — worktree removed?», то есть подменил бы
// предмет проверки журнальной веткой и назвал бы виноватым механизм.
const git = (...args) => {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr ?? r.error?.message ?? 'без диагноза'}`);
  return r;
};
mkdirSync(DECOR_REPO, { recursive: true });
git('init', '-q', '-b', 'main', DECOR_REPO);
git('-C', DECOR_REPO, 'config', 'user.email', 'stend@example.invalid');
git('-C', DECOR_REPO, 'config', 'user.name', 'stend');
git('-C', DECOR_REPO, 'commit', '-q', '--allow-empty', '-m', 'init');
git('-C', DECOR_REPO, 'worktree', 'add', '-q', '-b', DECOR_BRANCH, DECOR_WT);
store.createTask(HOME, { id: DECOR, title: 'строки участника в ответе task', owner: OWNER });
store.upsertParticipant(HOME, DECOR, store.participantRecord('worker:cargos-api', { repo: 'loads_search/cargos-api',
  worktree: DECOR_WT,
  branch: DECOR_BRANCH,
  session: 'ab12cd34' }));
// Соседняя запись без единого поля adapter'а: строки не выдумываются — `orchestrator`
// каталога не имеет вовсе, и `worktree undefined` в его строке было бы ложью.
store.upsertParticipant(HOME, DECOR, store.participantRecord('worker:web'));
const decorSrv = startServer('orchestrator', { task: DECOR });
await decorSrv.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
decorSrv.notify('notifications/initialized');
const decorOut = text(await decorSrv.call('tools/call', { name: 'promptobus_task', arguments: {} }));
decorSrv.stop();
const decorLine = decorOut.split('\n').find((l) => l.startsWith('- worker:cargos-api')) ?? '';
const bareLine = decorOut.split('\n').find((l) => l.startsWith('- worker:web')) ?? '';
check(': ответ task печатает repository участника',
  decorLine.includes('repository loads_search/cargos-api'), decorLine || decorOut);
// Кусок строки целиком, а не три вхождения порознь: порядок частей — контракт, общий с
// `promptobus status`, и проверка по одному `includes` пережила бы перестановку молча.
check(': ответ task печатает worktree участника с настоящей веткой git — перед bg-session',
  decorLine.includes(`worktree ${DECOR_WT} (branch ${DECOR_BRANCH}) · bg-session ab12cd34`),
  decorLine || decorOut);
check(': у участника без repository, worktree и сессии этих строк нет',
  bareLine.startsWith('- worker:web · непрочитано')
  && !/(repository |worktree |bg-session)/.test(bareLine), bareLine || decorOut);

// --- : смесь версий — текст отказа доходит до инструментов -------------
//
// Отказ читателя журнала собирает package, а до агента его доносит adapter строкой
// `error: <текст>` ([server.js](../lib/server.js), `tool-failed`). Путь этот
// общий у всех инструментов, но проверяется он именно здесь: живой случай  пришёл
// не из CLI, а из `promptobus_send` сессии, работавшей с сервером прежнего релиза.
//
// Журнал правится на диске руками: механизм этой версии записи новее себя не делает, и
// собрать её иначе нечем — она и есть запись механизма, которого ещё нет.
const MIXED = 'smes-t20260903-090000';
store.createTask(HOME, { id: MIXED, title: 'смесь версий механизма', owner: OWNER });
store.upsertParticipant(HOME, MIXED, store.participantRecord('worker:cargos-api', { repo: 'loads_search/cargos-api' }));
{
  const file = path.join(HOME, 'tasks', MIXED, 'task.json');
  const meta = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({
    ...meta,
    participants: meta.participants.map((p) => (p.role === 'worker'
      ? {
        ...p,
        // Поле снимка, которого этот релиз не знает, и версия механизма новее его самого.
        capabilities: { ...(p.capabilities ?? {}), resume: true },
        metadata: { ...p.metadata, [MECHANISM_VERSION_FIELD]: '99.0.0' },
      }
      : p)),
  }, null, 2) + '\n');
}
const mixedSrv = startServer('worker:cargos-api', { task: MIXED });
await mixedSrv.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
mixedSrv.notify('notifications/initialized');
const mixedSend = await mixedSrv.call('tools/call',
  { name: 'promptobus_send', arguments: { to: 'orchestrator', type: 'status', body: 'проба' } });
const mixedBox = await mixedSrv.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
mixedSrv.stop();
const sendText = text(mixedSend);
const boxText = text(mixedBox);
check(': promptobus_send отвечает «начни новую сессию», а не «журнал не по схеме»',
  mixedSend.result?.isError === true && /сделана механизмом 99\.0\.0/.test(sendText)
  && /начни новую сессию/.test(sendText) && !/не по схеме/.test(sendText), sendText);
check(': promptobus_mailbox отвечает тем же текстом — путь у отказа один',
  mixedBox.result?.isError === true && /начни новую сессию/.test(boxText)
  && /MCP-сервер шины стартует из установленного релиза/.test(boxText), boxText);

orch.stop();
worker.stop();
rmSync(SB, { recursive: true, force: true });
