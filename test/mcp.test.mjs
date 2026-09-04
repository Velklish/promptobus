// Golden-протокол MCP-сервера шины у своей границы (`BL-407`). Запуск — своя команда
// package: `npm test --prefix cli/packages/promptobus` из корня репозитория; её же зовёт
// набор репозитория ([promptobus-package.test.mjs](../../../test/promptobus-package.test.mjs)).
//
// Родительского репозитория здесь нет вовсе: ни `AGENTS.md`, ни `modules.lock`, ни Git,
// ни бинаря Claude, ни `cli/lib`. Сервер поднимается factory с потоками в памяти, а всё,
// что знает про рабочее место, приходит подставными callbacks — ровно теми, которыми его
// поднимает adapter. Так и проверяется обещание границы: транспорт и диспетчер работают
// без harness'а.
//
// Снимок `tools/list` лежит рядом ([fixtures/tools.json](fixtures/tools.json)). Снят он с
// живого сервера `v0.61.0` тем же разговором по stdio, каким с ним говорит Claude Code, и
// на hard rename (`BL-411`) переписан руками под новые имена — больше ничем: расхождение с
// ним означает, что поверхность поехала.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import test from 'node:test';

const {
  addrDir, addressOf, createMcpServer, GateError, negotiateProtocol, openEngine, ORCHESTRATOR,
  ownerOf, PromptobusError, readableName, roleOf, summarizeMessages, ADDR_MARK, MESSAGE_TYPES,
} = await import('../dist/index.js');

// **Service подаётся factory, и дефолта у него нет** (`BL-430`): половина перечня стоит на
// идентичности сессии — владение mailbox'ом, привязка, резолв активной задачи и шапка
// ответа, — а окружение читает только adapter (ADR-032, §2). Здесь adapter'а нет, и его
// играет набор: собранный ниже service — вторая, независимая от CLI реализация того же
// интерфейса, и тем он и проверяется. Routing policy обязательна при открытии engine по той
// же причине; правило ATI («worker'у нельзя писать worker'у») живёт в CLI и проверяется там.
const engines = new Map();
const at = (home) => {
  if (!engines.has(home)) engines.set(home, openEngine({ home, policy: () => ({ allow: true }) }));
  return engines.get(home);
};

// Перевод адреса в запись участника v1 — дело adapter'а: адрес лежит полем `metadata`.
const rec = (address, fields = {}) => ({
  id: addrDir(address),
  role: roleOf(address),
  harness: 'proba',
  mode: 'attached',
  sessionRef: null,
  capabilities: null,
  metadata: { address, ...fields },
});

const createTask = (home, { id, title, owner = null }) => at(home).createTask({
  id, title, owner: rec(ORCHESTRATOR, owner ? { owner } : {}), adapter: {},
});
const upsertParticipant = (home, task, { address, ...fields }) => at(home)
  .putParticipant(task, rec(address, fields));
const taskFile = (home, task) => at(home).taskFile(task);
const filesDir = (home, task) => path.join(home, 'tasks', task, 'files');
const brokenLines = (notes) => notes.map((n) => `БИТОЕ СООБЩЕНИЕ ${n.name}: ${n.note}`);
// Отказ v1 человеку — `GateError`'ом: так его читает и вход в задачу (законный отказ там
// остаётся внутри, а поломка уходит наружу), и верхний catch CLI.
const readTask = (home, task) => {
  try {
    return at(home).readTask(task);
  } catch (e) {
    if (e instanceof PromptobusError) throw new GateError(e.message);
    throw e;
  }
};
const ownerOfTask = (home, task) => ownerOf(readTask(home, task).participants
  .find((p) => addressOf(p) === ORCHESTRATOR));

const busService = {
  artifactsDir: filesDir,
  artifactName: (home, task, id) => {
    try {
      return at(home).readArtifact(task, id).filename;
    } catch {
      return undefined;
    }
  },
  bindSession: () => null,
  brokenNote: (broken) => (broken.length ? broken.join('\n') : null),
  claimOwnership: (home, task, session) => {
    const meta = at(home).readTask(task);
    const p = meta.participants.find((x) => addressOf(x) === ORCHESTRATOR);
    const was = ownerOf(p);
    at(home).patchParticipant(task, p.id, { metadata: { ...p.metadata, owner: session } });
    return was;
  },
  countInbox: (home, task, addr) => at(home).unread(task, addrDir(addr)),
  identityLabel: (home, task, addr) => `PROMPTOBUS_HOME=${home} · задача=${task} · адрес=${addr}`,
  ownership: (home, task, addr, session) => {
    if (addr !== ORCHESTRATOR) return { gated: false, owner: null, session };
    const owner = ownerOfTask(home, task);
    if (!owner || !session) return { gated: false, owner, session };
    return { gated: owner !== session, owner, session };
  },
  peekInbox: (home, task, addr) => {
    const { messages, broken } = at(home).peek(task, addrDir(addr));
    return { messages, broken: brokenLines(broken) };
  },
  readInbox: (home, task, addr) => {
    const { messages, broken } = at(home).read(task, addrDir(addr));
    return { messages, broken: brokenLines(broken) };
  },
  readTask,
  resolveTaskId: (home, declared) => {
    if (declared) return declared;
    const active = at(home).listTasks().tasks.filter((t) => t.status === 'active');
    if (active.length === 1) return active[0].id;
    throw new GateError(`активных задач ${active.length}`);
  },
  send: (home, task, { from, to, type, body }) => at(home)
    .sendSync(task, { from: addrDir(from), to: [addrDir(to)], type, body }),
  unreadNote: (home, task, addr) => {
    const n = at(home).unread(task, addrDir(addr));
    return n ? `твой mailbox: непрочитано ${n}` : null;
  },
  withTaskCache: (fn) => fn(),
};

const GOLDEN_TOOLS = JSON.parse(readFileSync(new URL('fixtures/tools.json', import.meta.url), 'utf8'));

// Снимок вморожен целиком, кроме одного места: enum типов сообщений в схеме `send` — это
// цитата контракта, чей дом `MESSAGE_TYPES` в store, и пополнить его `BL-409` вправе.
// Литерал в снимке покраснел бы тогда с диагнозом «поверхность поехала», хотя поехал бы
// контракт в другом файле, — а гейт литеральных копий в `.json` не заглядывает вовсе
// (замечание ревью). Поэтому перед сверкой enum берётся у дома: описания, имена и схемы
// остаются golden'ом, типы сверяются с кодом — и делает это соседняя проверка.
function expectedTools() {
  const tools = structuredClone(GOLDEN_TOOLS);
  tools.find((t) => t.name === 'promptobus_send').inputSchema.properties.type.enum = [...MESSAGE_TYPES];
  return tools;
}

const SB = mkdtempSync(path.join(os.tmpdir(), 'promptobus-mcp-'));
process.on('exit', () => rmSync(SB, { recursive: true, force: true }));

const home = path.join(SB, '.promptobus');
const TASK = 't20260813-090000';
const OWNER = 'session-orchestrator';
createTask(home, { id: TASK, title: 'событие CargoCreated в двух сервисах', owner: OWNER });
// Вторая задача того же дома — ради входа по ЯВНОМУ `task`: он законен и в разговоре, где
// сессия уже вошла в свою.
const SECOND = 't20260813-100000';
createTask(home, { id: SECOND, title: 'вторая задача того же дома', owner: OWNER });
upsertParticipant(home, TASK, {
  address: 'worker:cargos-api', repo: 'loads_search/cargos-api', session: 'bg-42',
});

// Версии протокола приходят конфигом: их дом у потребителя, и свой список package не
// заводит. Здесь он свой, тестовый, — и это часть проверки: negotiation работает по
// поданному списку, а не по вшитому.
const VERSIONS = ['2026-01-01', '2025-06-18', '2024-11-05'];

// Тексты событий — те же, что у adapter'а CLI: package называет событие типом и ставит код
// JSON-RPC, слова остаются у потребителя. Ветки названы явно, а `default` полей события не
// читает: подставной `errorText`, падающий там, где настоящий не падает, проверял бы не то.
function errorText(event) {
  switch (event.kind) {
    case 'parse': return 'не разобрано как JSON';
    case 'unknown-method': return `метод «${event.method}» не поддерживается`;
    case 'unknown-tool': return `ошибка: неизвестный инструмент «${event.tool}»`;
    case 'tool-failed': return `ошибка: ${event.cause.message}`;
    default: return 'ошибка: событие протокола не опознано';
  }
}

// Один разговор по stdio: строки уходят одной записью, ответы собираются в порядке
// прихода. Потоки в памяти, а не процесс: предмет здесь — сам протокол.
async function talk(lines, { role = 'orchestrator', session = OWNER, declaredTask = TASK, options = {} } = {}) {
  const calls = { identity: 0, info: 0, joins: [], decorated: [], stalls: [] };
  const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
  const written = [];
  const server = createMcpServer({
    service: busService,
    protocolVersions: VERSIONS,
    resolveIdentity: () => {
      calls.identity += 1;
      return { role, home, declaredTask, session };
    },
    serverInfo: () => {
      calls.info += 1;
      return { name: 'promptobus', version: '0.62.0' };
    },
    onJoin: (join) => calls.joins.push(join),
    decorateParticipant: (p) => {
      calls.decorated.push(addressOf(p));
      return p.metadata.repo ? [`репозиторий ${p.metadata.repo}`] : [];
    },
    stalls: (ctx) => {
      calls.stalls.push(ctx);
      return ctx.address === 'orchestrator' ? 'ВСТАЛА worker:cargos-api' : null;
    },
    errorText,
    ...options,
  });
  await server.serve({
    input: Readable.from([text], { objectMode: false }),
    output: { write: (chunk) => written.push(chunk) },
  });
  return { calls, written, responses: written.map((l) => JSON.parse(l)) };
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const textOf = (res) => res.result?.content?.map((c) => c.text).join('\n') ?? '';

test('negotiation: версия из поданного списка возвращается, незнакомая — первой из него', async () => {
  const { responses, calls } = await talk([
    rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} }),
    rpc(2, 'initialize', { protocolVersion: '2099-01-01', capabilities: {} }),
    rpc(3, 'initialize', { capabilities: {} }),
  ]);
  assert.equal(responses[0].result.protocolVersion, '2024-11-05');
  assert.equal(responses[1].result.protocolVersion, VERSIONS[0]);
  assert.equal(responses[2].result.protocolVersion, VERSIONS[0]);
  // Идентичность процесса спрашивается один раз на соединение, имя сервера — на каждый
  // `initialize`: версия потребителя меняется его релизом, а не ходом разговора.
  assert.equal(calls.identity, 1);
  assert.equal(calls.info, 3);
});

test('пустой список версий — отказ при создании сервера, а не undefined в initialize', () => {
  // Гейт стоит у factory: до первого соединения, там, где список приходит config'ом (`BL-423`).
  const opts = {
    service: busService, resolveIdentity: () => ({ role: 'orchestrator', home, declaredTask: TASK, session: OWNER }),
    serverInfo: () => ({ name: 'promptobus', version: '0.62.0' }), onJoin: () => {},
    decorateParticipant: () => [], stalls: () => null, errorText,
  };
  assert.throws(() => createMcpServer({ ...opts, protocolVersions: [] }), /protocolVersions пуст/);
  assert.throws(() => createMcpServer({ ...opts, protocolVersions: undefined }), /protocolVersions пуст/);
  assert.doesNotThrow(() => createMcpServer({ ...opts, protocolVersions: VERSIONS }));
});

test('договор о версии — чистой функцией по списку обслуживаемых, а не по слову клиента', () => {
  assert.ok(VERSIONS.every((v) => negotiateProtocol(VERSIONS, v) === v));
  assert.equal(negotiateProtocol(VERSIONS, '2099-01-01'), VERSIONS[0]);
  assert.equal(negotiateProtocol(VERSIONS, undefined), VERSIONS[0]);
});

test('initialize: сервер объявил себя callback\'ом потребителя и заявил инструменты', async () => {
  const { responses } = await talk([rpc(1, 'initialize', { capabilities: {} })]);
  assert.deepEqual(responses[0].result.serverInfo, { name: 'promptobus', version: '0.62.0' });
  assert.deepEqual(responses[0].result.capabilities, { tools: {} });
});

test('contact point сдаётся на initialize и второй раз за соединение не сдаётся', async () => {
  // `BL-427`: до этой задачи вход в задачу висел только на `tools/call`, и сессия, сделавшая
  // рукопожатие и не позвавшая ни одного инструмента, оставалась для надзирателя глухой —
  // тот законно откатывался на `self-wake`. Идентичность к `initialize` уже резолвлена,
  // ждать инструмента незачем.
  const one = await talk([rpc(1, 'initialize', { capabilities: {} })]);
  assert.deepEqual(one.calls.joins, [{ home, task: TASK, address: 'orchestrator', gated: false }]);
  // Повтор — не работа: `onJoin` пишет в store и поднимает процесс, а сессия за соединение
  // входит в задачу однажды. Считается это по задаче, поэтому три `initialize` и два вызова
  // инструмента подряд дают ровно один вход.
  //
  // Считается ИМЕННО по задаче, а не «однажды за соединение»: последним вызовом идёт
  // `promptobus_task` с ДРУГОЙ задачей аргументом, и её вход законен — булев флаг соединения
  // прошёл бы всё, кроме этой строки (замечание ревью).
  const many = await talk([
    rpc(1, 'initialize', { capabilities: {} }),
    rpc(2, 'initialize', { capabilities: {} }),
    rpc(3, 'tools/call', { name: 'promptobus_task', arguments: {} }),
    rpc(4, 'tools/call', { name: 'promptobus_task', arguments: { task: TASK } }),
    rpc(5, 'tools/call', { name: 'promptobus_task', arguments: { task: SECOND } }),
  ]);
  assert.deepEqual(many.calls.joins, [
    { home, task: TASK, address: 'orchestrator', gated: false },
    { home, task: SECOND, address: 'orchestrator', gated: false },
  ]);
});

test('вход, отказавший на рукопожатии, отметки не оставляет — следующий вызов входит', async () => {
  // `ownership` — первое настоящее чтение журнала: `resolveTaskId` проверяет только его
  // существование. На неразобранном журнале вход законно отказывает, и вся цена ошибки — в
  // том, осталась ли за ним отметка: осталась бы — сессия числилась бы вошедшей, не войдя, и
  // contact point не сдался бы ни разу за её жизнь (замечание ревью).
  //
  // Журнал чинится ПОСРЕДИ разговора, и шов для этого — `serverInfo`: он зовётся на том же
  // `initialize`, но ПОСЛЕ входа. Хук между строками потока тут не годится вовсе: строки
  // уходят одной записью, и `Readable` набирает их в буфер раньше, чем потребитель разберёт
  // первую, — починка успевала бы до рукопожатия, и проверка была бы зелена при любой
  // реализации отметки (проверено мутационной пробой: с отметкой ДО входа она не краснела).
  const brokenHome = path.join(SB, 'broken', '.promptobus');
  createTask(brokenHome, { id: TASK, title: 'журнал, который чинят посреди разговора', owner: OWNER });
  const file = taskFile(brokenHome, TASK);
  const good = readFileSync(file, 'utf8');
  writeFileSync(file, '{ это не json');
  const { responses, calls } = await talk([
    rpc(1, 'initialize', { capabilities: {} }),
    rpc(2, 'tools/call', { name: 'promptobus_task', arguments: {} }),
  ], {
    options: {
      resolveIdentity: () => ({ role: 'orchestrator', home: brokenHome, declaredTask: TASK, session: OWNER }),
      serverInfo: () => {
        writeFileSync(file, good);
        return { name: 'promptobus', version: '0.62.0' };
      },
    },
  });
  // Рукопожатие живо: законный отказ входа его не роняет — сессия без шины осталась бы
  // ровно из-за того, что ей нечем сдать contact point.
  assert.equal(responses[0].result.protocolVersion, VERSIONS[0]);
  assert.deepEqual(calls.joins, [{ home: brokenHome, task: TASK, address: 'orchestrator', gated: false }]);
  assert.match(textOf(responses[1]), new RegExp(`^задача ${TASK} · журнал, который чинят`));
});

test('initialize без резолвимой задачи рукопожатия не роняет — входить некуда', async () => {
  // Сервер оркестратора поднимается вместе с его сессией, когда задачи в доме ещё нет вовсе:
  // `resolveTaskId` там законно отказывает, и отказ обязан остаться внутри входа. Упади он
  // наружу — сессия осталась бы без шины целиком, из-за того что ей нечем сдать contact point.
  const empty = path.join(SB, 'no-tasks', '.promptobus');
  const { responses, calls } = await talk([
    rpc(1, 'initialize', { capabilities: {} }),
    rpc(2, 'ping', {}),
  ], { options: { resolveIdentity: () => ({ role: 'orchestrator', home: empty, declaredTask: null, session: OWNER }) } });
  assert.equal(responses[0].result.protocolVersion, VERSIONS[0]);
  assert.deepEqual(responses[1].result, {});
  assert.deepEqual(calls.joins, []);
});

test('notifications/initialized ответа не получает, а ping — пустой результат', async () => {
  const { responses } = await talk([
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    rpc(1, 'ping', {}),
  ]);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, 1);
  assert.deepEqual(responses[0].result, {});
});

test('tools/list совпадает со снимком живого сервера v0.61.0 — до знака', async () => {
  const { responses } = await talk([rpc(1, 'tools/list', {})]);
  assert.deepEqual(responses[0].result.tools, expectedTools());
});

test('схема send требует to/type/body и знает типы протокола v1', async () => {
  const { responses } = await talk([rpc(1, 'tools/list', {})]);
  const send = responses[0].result.tools.find((t) => t.name === 'promptobus_send');
  assert.deepEqual(send.inputSchema.required, ['to', 'type', 'body']);
  assert.deepEqual(send.inputSchema.properties.type.enum, MESSAGE_TYPES);
  // Задача аргументом — у каждого инструмента: `PROMPTOBUS_TASK` в живой сессии не поменять.
  assert.ok(responses[0].result.tools.every((t) => t.inputSchema.properties.task));
});

test('tools/call: send кладёт сообщение и называет получателя, адрес и mailbox', async () => {
  const { responses, calls } = await talk([
    rpc(1, 'tools/call', {
      name: 'promptobus_send',
      arguments: { to: 'worker:cargos-api', type: 'task', body: 'разбери контракт' },
    }),
  ]);
  const said = textOf(responses[0]);
  assert.match(said, /^отправлено task → cargos-api/);
  assert.ok(said.includes(`${ADDR_MARK}worker:cargos-api`));
  assert.ok(said.includes(`задача=${TASK}`));
  // Вход в задачу — до работы инструмента, и владение считает package: сдаёт contact point
  // и поднимает слушателя потребитель, но только он и знает, чем.
  assert.deepEqual(calls.joins, [{ home, task: TASK, address: 'orchestrator', gated: false }]);
});

test('tools/call: mailbox отдаёт пришедшее и приклеивает диагностику вставших', async () => {
  await talk([
    rpc(1, 'tools/call', {
      name: 'promptobus_send',
      arguments: { to: 'orchestrator', type: 'status', body: 'взял в работу' },
    }),
  ], { role: 'worker:cargos-api', session: 'session-worker' });
  const { responses, calls } = await talk([
    rpc(1, 'tools/call', { name: 'promptobus_mailbox', arguments: {} }),
  ]);
  const said = textOf(responses[0]);
  assert.match(said, /^сообщений 1: status от worker:cargos-api/);
  assert.ok(said.endsWith('ВСТАЛА worker:cargos-api'));
  assert.deepEqual(calls.stalls, [{ home, task: TASK, address: 'orchestrator' }]);
});

test('tools/call: mailbox чужой сессии — копия с громкой шапкой, оригиналы у владельца', async () => {
  const { responses, calls } = await talk([
    rpc(1, 'tools/call', { name: 'promptobus_mailbox', arguments: {} }),
  ], { session: 'session-чужая' });
  const said = textOf(responses[0]);
  assert.match(said, /^ЧУЖОЙ MAILBOX: адрес orchestrator задачи /);
  // Чужому диагностика вставших не идёт: маршрут в ней ведёт туда, куда гейт не пускает.
  assert.deepEqual(calls.stalls, []);
  assert.deepEqual(calls.joins, [{ home, task: TASK, address: 'orchestrator', gated: true }]);
});

test('чужая сессия отметки входа не получает — став владельцем, она входит тем же соединением', async () => {
  // `onJoin` чужой сессии contact point'а не пишет (гейт владения у потребителя), а стать
  // владельцем она вправе тем же соединением — `mailbox {claim: true}`. Отметь вход чужого,
  // и `wake/<адрес>.json` до конца хода указывал бы на сокет прежнего владельца (замечание
  // ревью). Дом свой: захват переписывает владельца задачи, и соседние проверки читали бы
  // потом чужой исход.
  const claimHome = path.join(SB, 'claim', '.promptobus');
  createTask(claimHome, { id: TASK, title: 'захват посреди соединения', owner: OWNER });
  const heir = 'session-preemnik';
  const { calls } = await talk([
    rpc(1, 'initialize', { capabilities: {} }),
    rpc(2, 'tools/call', { name: 'promptobus_mailbox', arguments: { claim: true } }),
    rpc(3, 'tools/call', { name: 'promptobus_task', arguments: {} }),
  ], {
    options: { resolveIdentity: () => ({ role: 'orchestrator', home: claimHome, declaredTask: TASK, session: heir }) },
  });
  assert.deepEqual(calls.joins, [
    { home: claimHome, task: TASK, address: 'orchestrator', gated: true },
    { home: claimHome, task: TASK, address: 'orchestrator', gated: true },
    { home: claimHome, task: TASK, address: 'orchestrator', gated: false },
  ]);
});

test('tools/call: task печатает участников, а строки рабочего места даёт потребитель', async () => {
  const { responses, calls } = await talk([rpc(1, 'tools/call', { name: 'promptobus_task', arguments: {} })]);
  const said = textOf(responses[0]);
  assert.match(said, new RegExp(`^задача ${TASK} · событие CargoCreated в двух сервисах\n`));
  assert.ok(said.includes(`- orchestrator · владелец ${OWNER} · непрочитано 0`));
  assert.ok(said.includes('- worker:cargos-api · репозиторий loads_search/cargos-api · непрочитано 1'));
  assert.deepEqual(calls.decorated, ['orchestrator', 'worker:cargos-api']);
});

test('негодная запись участника — находка в ответе, а не смерть инструмента', async () => {
  const spoiled = path.join(SB, 'spoiled');
  createTask(spoiled, { id: TASK, title: 'журнал с испорченной записью', owner: OWNER });
  const meta = JSON.parse(readFileSync(taskFile(spoiled, TASK), 'utf8'));
  // Запись годна по схеме store и негодна по адресу: адрес — поле adapter'а, и схема его
  // не смотрит вовсе. Годной по схеме она обязана быть, иначе испорчен весь журнал, а это
  // другой случай со своим ответом («задача повреждена»).
  meta.participants.push({
    id: 'worker-spoiled',
    role: 'worker',
    harness: 'claude',
    mode: 'attached',
    sessionRef: null,
    capabilities: null,
    metadata: { address: 'worker:НЕ АДРЕС' },
  });
  writeFileSync(taskFile(spoiled, TASK), JSON.stringify(meta, null, 2) + '\n');
  const { responses } = await talk([rpc(1, 'tools/call', { name: 'promptobus_task', arguments: {} })], {
    options: { resolveIdentity: () => ({ role: 'orchestrator', home: spoiled, declaredTask: TASK, session: OWNER }) },
  });
  const said = textOf(responses[0]);
  assert.ok(said.includes('- НЕГОДНАЯ ЗАПИСЬ УЧАСТНИКА'));
  assert.ok(said.includes('- orchestrator · владелец'));
});

test('malformed JSON → −32700 текстом потребителя, и соединение живо', async () => {
  const { responses } = await talk(['{ битый json', rpc(1, 'ping', {})]);
  assert.equal(responses[0].id, null);
  assert.equal(responses[0].error.code, -32700);
  assert.equal(responses[0].error.message, 'не разобрано как JSON');
  assert.deepEqual(responses[1].result, {});
});

test('неизвестный метод → −32601 текстом потребителя', async () => {
  const { responses } = await talk([rpc(1, 'resources/list', {})]);
  assert.equal(responses[0].error.code, -32601);
  assert.equal(responses[0].error.message, 'метод «resources/list» не поддерживается');
});

test('неизвестный инструмент — isError с текстом потребителя, а не ошибка протокола', async () => {
  const { responses } = await talk([rpc(1, 'tools/call', { name: 'nosuch', arguments: {} })]);
  assert.equal(responses[0].error, undefined);
  assert.equal(responses[0].result.isError, true);
  assert.equal(textOf(responses[0]), 'ошибка: неизвестный инструмент «nosuch»');
});

test('отказ инструмента приходит текстом потребителя, соединение не теряется', async () => {
  const { responses } = await talk([
    rpc(1, 'tools/call', {
      name: 'promptobus_send',
      arguments: { to: 'worker:cargos-api', type: 'nope', body: 'x' },
    }),
    rpc(2, 'ping', {}),
  ]);
  assert.equal(responses[0].result.isError, true);
  assert.match(textOf(responses[0]), /^ошибка: тип «nope» не из протокола v1/);
  assert.deepEqual(responses[1].result, {});
});

test('порядок ответов — порядок запросов, и постороннего в потоке нет', async () => {
  const { responses, written } = await talk([
    rpc(1, 'ping', {}),
    rpc(2, 'tools/list', {}),
    rpc(3, 'ping', {}),
    rpc(4, 'tools/call', { name: 'promptobus_task', arguments: {} }),
  ]);
  assert.deepEqual(responses.map((r) => r.id), [1, 2, 3, 4]);
  // Канал общий с протоколом: каждая запись — ровно одна строка JSON-RPC и перевод строки.
  assert.ok(written.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n')));
});

test('задача аргументом сильнее объявленной сессии', async () => {
  const other = 't20260814-101010';
  createTask(home, { id: other, title: 'вторая активная задача', owner: OWNER });
  const { responses } = await talk([
    rpc(1, 'tools/call', { name: 'promptobus_task', arguments: { task: other } }),
  ]);
  assert.match(textOf(responses[0]), new RegExp(`^задача ${other} · вторая активная задача\n`));
});

// --- первая строка называет, а не считает (перенесено из cli/test/promptobus-mcp.test.mjs) ---

// Канон несёт ID записи участника, а адрес отправителя собирается из журнала задачи. Здесь
// журнала нет вовсе, и `summarizeMessages` берёт того, кого ей дали: по умолчанию — id.
const g = (type, from) => ({ type, sender: from });

test('первая строка называет отправителей и типы', () => {
  assert.equal(
    summarizeMessages([g('result', 'worker:gates'), g('status', 'worker:spawn'), g('status', 'worker:spawn')]),
    'сообщений 3: status от worker:spawn ×2, result от worker:gates',
  );
});

test('одно сообщение множителя не получает', () => {
  assert.equal(summarizeMessages([g('result', 'worker:gates')]), 'сообщений 1: result от worker:gates');
});

test('один адрес с разными типами — разные группы', () => {
  assert.equal(
    summarizeMessages([g('status', 'worker:a'), g('result', 'worker:a')]),
    'сообщений 2: status от worker:a, result от worker:a',
  );
});

test('перечень ограничен, остальное сворачивается в «+ ещё N» числом сообщений', () => {
  const many = [
    g('status', 'worker:a'), g('status', 'worker:a'),
    g('result', 'worker:b'), g('question', 'worker:c'), g('review', 'worker:d'), g('review', 'worker:d'),
  ];
  const line = summarizeMessages(many);
  assert.ok(line.startsWith('сообщений 6: '));
  assert.equal(line.split(', ').length, 3);
  assert.ok(line.endsWith('+ ещё 1'));
});

test('длинные имена режутся по символьному потолку, а не по числу групп', () => {
  const long = summarizeMessages([
    g('status', `worker:${'a'.repeat(60)}`),
    g('result', `worker:${'b'.repeat(60)}`),
    g('review', 'worker:c'),
  ]);
  assert.ok(long.endsWith('+ ещё 2'));
});

test('одна группа печатается даже длиннее потолка', () => {
  const huge = summarizeMessages([g('status', `worker:${'x'.repeat(200)}`), g('result', 'worker:b')]);
  assert.ok(huge.includes('x'.repeat(200)));
  assert.ok(huge.endsWith('+ ещё 1'));
});

// --- читаемое имя участника (перенесено из cli/test/promptobus-mcp.test.mjs) ---

const named = (name) => ({
  participants: [{ id: 'worker-gates', metadata: { address: 'worker:gates', ...(name ? { name } : {}) } }],
});

test('имя участника — из журнала, без хвостовой метки «(ММДД-ЧЧММ)»', () => {
  assert.equal(readableName(named('Worker: Гейты lint (0829-1208)'), 'worker:gates'), 'Worker: Гейты lint');
});

test('метка со слагом снимается той же формой', () => {
  assert.equal(readableName(named('Worker: Гейты lint (0829-1208, gates)'), 'worker:gates'), 'Worker: Гейты lint');
});

test('скобка, не похожая на метку, остаётся в имени', () => {
  assert.equal(readableName(named('Worker: Дома значений (протокол)'), 'worker:gates'), 'Worker: Дома значений (протокол)');
});

test('запись без имени — адрес без префикса роли', () => {
  assert.equal(readableName(named(null), 'worker:gates'), 'gates');
});

test('участника в журнале нет — тот же фолбэк', () => {
  assert.equal(readableName({ participants: [] }, 'worker:gates'), 'gates');
  assert.equal(readableName({}, 'worker:gates'), 'gates');
  assert.equal(readableName(null, 'worker:gates'), 'gates');
});

test("префикс reviewer'а снимается наравне с префиксом worker'а", () => {
  assert.equal(readableName({ participants: [] }, 'reviewer:bus'), 'bus');
});

test('orchestrator назван словом, в позиции «от кого» — родительным падежом', () => {
  assert.equal(readableName(named(null), 'orchestrator'), 'оркестратор');
  assert.equal(readableName(named(null), 'orchestrator', true), 'оркестратора');
});
