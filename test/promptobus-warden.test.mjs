// Регресс на надзирателя задачи шины (этап 2).
// Запуск: npm test
//
// Предмет — слушание шины, вынесенное из модели в процесс: единственный слушатель всех
// mailbox'ов задачи будит адресата инъекцией в его messaging-сокет, а состояние держит в сторе,
// не в себе. С  он же и единственный будильник задачи. Проверяются пять
// веток, ради которых всё и заведено:
//
//   • доставка — стук уходит тому, у кого лежит непрочитанное, и не уходит тому, у кого пусто;
//   • содержание postcard'а — текст коротких сообщений едет в нём, длинное и артефакт идут
//     счётчиком, и общий бюджет postcard'а не превышается;
//   • стоп — пишется в журнал, postcard не шлётся;
//   • откат на self-wake — contact point'а нет либо канал driver'а не принял notification;
//   • health — молчание дольше порога эскалируется, и ровно один раз.
//
// С  здесь же живёт разбор состояния участника (`status.js`): доклад о вставших —
// единственный его потребитель на шине, и переехал он сюда вместе с ним.
//
// Сокет здесь настоящий (`net.createServer` на unix-пути): проверяется в том числе форма
// провода — две строки JSON, auth первой. Живого `claude` тест не трогает.
import { createServer } from 'node:net';
import { existsSync, linkSync, mkdirSync, statSync, readFileSync, utimesSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, makeSockPath, snapshotOfList, stubCommand, withStubPath } from './sandbox.mjs';
import { capture } from './console.mjs';

const SB = makeSandbox('promptobus-promptobus-warden-');
const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(SB, '.promptobus');
const TASK = 'sup-t20260829-150000';
const SESSION = 'sess-sup-0001';

const store = await import(path.join(here, '..', 'lib', 'store.js'));
const wdn = await import(path.join(here, '..', 'lib', 'warden.js'));
const { wardenLine, status, WARDEN_MARK, stallLine, blockedParticipants, orchestratorDeadLine } =
  await import(path.join(here, '..', 'lib', 'status.js'));
// Канал доставки, его текст, сдача contact point'а и разбор состояния сессии живут за
// контрактом driver'а: `warden.js` их больше не реэкспортирует — он вообще не
// импортирует driver, и это сторожит гейт границы adapter'а. Набор берёт их из дома.
const {
  claudeDriver, KNOCK_FROM, knockSocket, orderBody, probeWake, registerWake, sayForeignWrite,
  sessionDetail, sessionStall, renderNotification, stallRoute,
} = await import(path.join(here, '..', 'lib', 'driver-claude.js'));
// Живой снимок — только у стража проверки : им доказывается, что ноль вызовов у круга
// присмотра берётся от круга, а не от записей без имени сессии.
const { snapshotOf } = await import(path.join(here, '..', 'lib', 'drivers.js'));
const { KNOCK_TEXT_MAX } = await import(path.join(here, '..', 'lib', 'contract.js'));
// Версия берётся у объявления, а не литералом: подняли проверенную — фикстура обязана
// переехать вместе с ней, иначе тест сверяет прошлое требование.
const { PROVEN_CLAUDE_VERSION } = await import(path.join(here, '..', 'lib', 'driver-claude.js'));

store.createTask(HOME, { id: TASK, title: 'надзиратель задачи', owner: SESSION });
store.upsertParticipant(HOME, TASK, store.participantRecord('worker:api'));

const send = (to, body) => store.sendMessage(HOME, TASK, { from: 'orchestrator', to, type: 'task', body });
const health = () => store.readHealth(HOME, TASK);

// Снимок сессий — вход машины состояний и шов печати. Дом помощника
// один на весь набор ([sandbox.mjs](sandbox.mjs)): собирает снимок настоящий driver Claude
// по подставному ответу harness'а, живого `claude` набор не трогает.
const snapOf = snapshotOfList;

const snap = (task, list) => snapOf(store.readTask(HOME, task).participants, list);

// Разбор стопа по подставному ответу harness'а: снимок собирается по тем же участникам,
// которых спрашивает предикат, — как его собирает круг присмотра.
// Участник приходит сюда плоским — адрес и имя сессии, — а разбор стопа работает записями
// v1. Перевод делает adapter, и здесь его играет набор: тот же `participantRecord`, каким
// пишет участника дверь механизма.
const asRecords = (ps) => ps.map((p) => (p.metadata ? p : store.participantRecord(p.address, p)));
const asRecord = (p) => asRecords([p])[0];
const blocked = (task, ps, list) => {
  const recs = asRecords(ps);
  return blockedParticipants(HOME, task, recs, snapOf(recs, list));
};

// Стук-заглушка: копит вызовы и отвечает тем, что ей велели. Это единственная точка, где
// круг присмотра выходит наружу, — весь остальной круг проверяется без сокетов и таймеров.
function stubKnock(reply = { ok: true }) {
  const calls = [];
  const fn = async (endpoint, body) => {
    calls.push({ endpoint, body });
    return typeof reply === 'function' ? reply(calls.length) : reply;
  };
  fn.calls = calls;
  return fn;
}

// --- отметка надзирателя: живость, захват, удар сердца ------------------------

check('надзирателя нет — отметки нет', store.liveWarden(HOME, TASK) === null);

const claimed = store.claimWarden(HOME, TASK, { cli: '0.45.0' });
check('место занято: отметка своя, с pid и версией CLI',
  claimed.mark?.pid === process.pid && claimed.mark.cli === '0.45.0',
  JSON.stringify(claimed));
check('живой надзиратель читается по своей отметке', store.liveWarden(HOME, TASK)?.pid === process.pid);

const second = store.claimWarden(HOME, TASK, { pid: process.pid + 100000 });
check('второй захват при живом первом отказывает и называет держателя',
  !second.mark && second.busy?.pid === process.pid, JSON.stringify(second));

// Живость — это pid И свежесть удара сердца, оба условия. Номера процессов система
// переиспользует, поэтому одного pid мало; убитый между ударами процесс иначе числился бы
// живым до конца срока, а доставки в это время не было бы вовсе.
store.writeJsonAtomic(store.wardenMarkFile(HOME, TASK), {
  pid: process.pid,
  started: new Date(Date.now() - 3600_000).toISOString(),
  beat: new Date(Date.now() - store.WARDEN_BEAT_SEC * 4000).toISOString(),
});
check('живой pid с протухшим ударом сердца живым не считается', store.liveWarden(HOME, TASK) === null);

store.writeJsonAtomic(store.wardenMarkFile(HOME, TASK), {
  pid: 999_999_999,
  started: new Date().toISOString(),
  beat: new Date().toISOString(),
});
check('свежий удар сердца мёртвого процесса живым не делает', store.liveWarden(HOME, TASK) === null);

check('чужую отметку удар сердца не продлевает',
  store.beatWarden(HOME, TASK, { pid: process.pid }) === null);
check('чужую отметку не снимает и уборка', store.clearWarden(HOME, TASK, process.pid) === false);

store.claimWarden(HOME, TASK, { cli: '0.45.0' });
const beat = store.beatWarden(HOME, TASK);
check('свою отметку удар сердца продлевает', typeof beat?.beat === 'string' && beat.pid === process.pid);

// --- contact point --------------------------------------------------------

// Путь сокета — из общего помощника ([sandbox.mjs](sandbox.mjs)): предел `sun_path`, форма
// пути на Windows и уборка каталога — его забота, а не этого файла.
const sockPath = makeSockPath('a2s-');
const SOCK = sockPath('w');

check('сдавать нечего — файла не появляется',
  registerWake(HOME, TASK, 'worker:api', {}) === null && store.readWake(HOME, TASK, 'worker:api') === null);

const wake = registerWake(HOME, TASK, 'worker:api', {
  CLAUDE_CODE_MESSAGING_SOCKET: SOCK,
  CLAUDE_CODE_MESSAGING_TOKEN: 'deadbeef',
});
check('сданный contact point держит адрес сокета и токен',
  wake?.socket === SOCK && wake.token === 'deadbeef', JSON.stringify(wake));

// Токен — секрет: файл обязан быть закрыт от прочих пользователей машины. Тот же урок,
// что у mcp-конфига участника.
check(`файл contact point'а закрыт правами 0600`,
  (statSync(store.wakeFile(HOME, TASK, 'worker:api')).mode & 0o777) === 0o600,
  (statSync(store.wakeFile(HOME, TASK, 'worker:api')).mode & 0o777).toString(8));

// Идентичность сессии в contact point'е. Поле `session` — единственное, что
// привязывает точку к сессии при разборе постфактум, а имя переменной у неё одно:
// `CLAUDE_CODE_SESSION_ID`. Опечатка стоила полю содержимого совсем — оно было пустым
// всегда, и молча: на доставку `session` не влияет, стук идёт по сокету.
const wakeSess = registerWake(HOME, TASK, 'worker:sess', {
  CLAUDE_CODE_MESSAGING_SOCKET: SOCK,
  CLAUDE_CODE_MESSAGING_TOKEN: 'deadbeef',
  CLAUDE_CODE_SESSION_ID: 'sess-a2a-0042',
});
check(': contact point несёт id сдавшей его сессии',
  wakeSess?.session === 'sess-a2a-0042' && store.readWake(HOME, TASK, 'worker:sess')?.session === 'sess-a2a-0042',
  JSON.stringify(wakeSess));
check(': имени CLAUDE_SESSION_ID окружение не знает — по нему поле не заполняется',
  registerWake(HOME, TASK, 'worker:mis', {
    CLAUDE_CODE_MESSAGING_SOCKET: SOCK, CLAUDE_SESSION_ID: 'sess-мимо',
  })?.session === undefined,
  JSON.stringify(store.readWake(HOME, TASK, 'worker:mis')));

const before = readFileSync(store.wakeFile(HOME, TASK, 'worker:api'), 'utf8');
registerWake(HOME, TASK, 'worker:api', {
  CLAUDE_CODE_MESSAGING_SOCKET: SOCK,
  CLAUDE_CODE_MESSAGING_TOKEN: 'deadbeef',
});
check('повторная сдача того же ничего не переписывает',
  readFileSync(store.wakeFile(HOME, TASK, 'worker:api'), 'utf8') === before);

// --- доставка -----------------------------------------------------------------

const idle = stubKnock();
await wdn.wardenRound(HOME, TASK, { knock: idle });
check(`пустые mailbox'и — стучать некому`, idle.calls.length === 0);

send('worker:api', 'бриф');
const first = stubKnock();
const r1 = await wdn.wardenRound(HOME, TASK, { knock: first });
check(`непрочитанное в mailbox'е — стук уходит его адресату`,
  first.calls.length === 1 && first.calls[0].endpoint.socket === SOCK,
  JSON.stringify(first.calls.map((c) => c.endpoint)));
check(`стучат только тому, у кого лежит: у оркестратора пусто — notification'а нет`,
  !first.calls.some((c) => c.endpoint.address === 'orchestrator'));

// Тело инъекции получатель обернёт рамкой «Another Claude session sent a message» с абзацем
// предостережений, и обойти её отправитель не может. Значит текст обязан быть
// самодостаточным и опираться на протокол шины, а не на авторитет человека: замер спайка
// показал, что просьбу, звучащую как поручение от пользователя, участник откладывает.
const body = first.calls[0].body;
check('тело инъекции называет задачу, адрес и число непрочитанных',
  body.includes(TASK) && body.includes('worker:api') && /непрочитанных: 1/.test(body), body);
check(`: короткое сообщение едет в postcard'е текстом`,
  body.includes('бриф') && /task от orchestrator/.test(body), body);
check(': postcard всё равно ведёт в inbox — прочитанным делает он',
  body.includes('mailbox') && /истина остаётся в mailbox'е|прочитанными.*делает только mailbox/.test(body), body);
check('тело инъекции опирается на правила шины и отказывается от эскалации прав',
  /в правилах шины/.test(body) && /прав оно не даёт/.test(body), body);

const h1 = health()['worker:api'];
check(`health записал канал driver'а (у Claude Code — socket), счётчик стуков и начало ожидания`,
  h1.channel === 'socket' && h1.knocks === 1 && h1.unread === 1 && typeof h1.since === 'string',
  JSON.stringify(h1));
check('событие доставки ушло в журнал надзирателя',
  r1.events.some((e) => /notification worker:api/.test(e))
  && store.tailWardenLog(HOME, TASK, 20).some((l) => /notification worker:api/.test(l)),
  JSON.stringify(r1.events));

// Перестук не чаще порога: сессия, получившая notification, доходит до mailbox'а за секунды, а
// занятая длинным ходом законно молчит минуты — стук на каждом круге был бы шумом в
// чужой ленте.
const again = stubKnock();
await wdn.wardenRound(HOME, TASK, { knock: again });
check('повторный круг на том же состоянии не стучит', again.calls.length === 0);

const retry = stubKnock();
await wdn.wardenRound(HOME, TASK, { knock: retry, now: Date.now() + wdn.KNOCK_RETRY_SEC * 1000 + 1000 });
check('после порога перестука notification повторяется', retry.calls.length === 1);
check('счётчик стуков растёт', health()['worker:api'].knocks === 2);

// Новое сообщение поверх старого — это другое состояние: ждать порога перестука нельзя,
// участник мог не получить первый notification вовсе.
send('worker:api', 'уточнение');
const grew = stubKnock();
await wdn.wardenRound(HOME, TASK, { knock: grew });
check('новое сообщение будит немедленно, не дожидаясь порога', grew.calls.length === 1);
check(`в теле notification'а новое число непрочитанных`, /непрочитанных: 2/.test(grew.calls[0].body));

// --- подтверждение доставки: наблюдаемая реакция ------------------------------

// Нулевой код возврата сокета доставку не подтверждает: отброс пределами очереди молчалив
// для отправителя. Признак один — mailbox забран.
const sinceBefore = health()['worker:api'].since;
store.readInbox(HOME, TASK, 'worker:api');
const done = stubKnock();
const r2 = await wdn.wardenRound(HOME, TASK, { knock: done });
check('забранный mailbox — это и есть подтверждение доставки',
  r2.events.some((e) => /доставлено worker:api/.test(e)), JSON.stringify(r2.events));
check('счётчики ожидания сброшены, доставка отмечена временем',
  health()['worker:api'].unread === 0 && health()['worker:api'].since === null
  && typeof health()['worker:api'].deliveredAt === 'string' && sinceBefore !== null,
  JSON.stringify(health()['worker:api']));
check(`на пустом mailbox'е стука нет`, done.calls.length === 0);

// --- откат на self-wake -------------------------------------------------------

// Отказ канала надзирателя не валит: участник помечается self-wake, событие уходит в
// журнал, доставка остальным идёт дальше.
send('orchestrator', 'отчёт');
const noWake = stubKnock();
const r3 = await wdn.wardenRound(HOME, TASK, { knock: noWake });
check(`contact point'а нет — стука нет и канал self-wake`,
  noWake.calls.length === 0 && health().orchestrator.channel === 'self-wake',
  JSON.stringify(health().orchestrator));
check('откат назван в журнале надзирателя',
  r3.events.some((e) => /откат на self-wake orchestrator/.test(e)), JSON.stringify(r3.events));

// Участник без contact point'а входит в ветку доставки КАЖДЫЙ круг: `knockedAt` ему не
// ставится никогда, а сокет он может сдать уже после того, как сообщение легло. Значит
// сама ветка входить обязана — но записывать health на каждом круге не должна, иначе
// круг присмотра пишет на диск раз в секунду до тех пор, пока mailbox не заберут. Ловим это
// временем правки файла: круг без изменений его не трогает.
const HFILE = store.healthFile(HOME, TASK);
const PAST = Math.floor(Date.now() / 1000) - 3600;
utimesSync(HFILE, PAST, PAST);
await wdn.wardenRound(HOME, TASK, { knock: stubKnock() });
check('круг без изменений health не переписывает',
  Math.floor(statSync(HFILE).mtimeMs / 1000) === PAST,
  `${Math.floor(statSync(HFILE).mtimeMs / 1000)} vs ${PAST}`);

registerWake(HOME, TASK, 'orchestrator', { CLAUDE_CODE_MESSAGING_SOCKET: SOCK, CLAUDE_CODE_MESSAGING_TOKEN: 't' });
const T1 = Date.now() + wdn.KNOCK_RETRY_SEC * 1000 + 1000;
const refused = stubKnock({ ok: false, error: 'ENOENT' });
const r4 = await wdn.wardenRound(HOME, TASK, { knock: refused, now: T1 });
// Claude Code: канал `socket`, в журнале слово «сокет». Иные harness'ы — package
// (`driver.test.mjs`): отказ пишет `inject` / `rpc`, не литерал «сокет».
check('сокет не принял notification — канал откатывается на self-wake с причиной',
  health().orchestrator.channel === 'self-wake' && health().orchestrator.knockError === 'ENOENT',
  JSON.stringify(health().orchestrator));
check('причина отказа названа в журнале',
  r4.events.some((e) => /сокет не принял notification \(ENOENT\)/.test(e)), JSON.stringify(r4.events));

// Отказ throttl-ится тем же порогом, что и успех, — иначе неотвечающий сокет получал бы
// попытку каждую секунду (за шесть часов больше двадцати тысяч соединений), а сокет,
// который принимает, но молчит, отдавал бы KNOCK_TIMEOUT_MS на круг и задерживал бы
// notification'и остальным участникам. Порог считается по времени ПОПЫТКИ, а `knockedAt`
// остаётся временем последней удавшейся доставки.
const again2 = stubKnock({ ok: false, error: 'ENOENT' });
await wdn.wardenRound(HOME, TASK, { knock: again2, now: T1 + 1000 });
check('отказавший стук не повторяется каждый круг — порог считается по времени попытки',
  again2.calls.length === 0, String(again2.calls.length));
check('время попытки записано, а время доставки не подменено неудачей',
  typeof health().orchestrator.triedAt === 'string' && !health().orchestrator.knockedAt,
  JSON.stringify(health().orchestrator));
check('повторный отказ с той же причиной журнал не заливает',
  !(await wdn.wardenRound(HOME, TASK, { knock: stubKnock({ ok: false, error: 'ENOENT' }), now: T1 + wdn.KNOCK_RETRY_SEC * 1000 + 1000 }))
    .events.some((e) => /откат на self-wake orchestrator/.test(e)));

// Участник перезапустился и сдал ДРУГОЙ сокет: прежний адрес мёртв по построению, и
// досиживать порог по нему значит держать участника спящим ровно там, где он только что
// стал достижим.
const SOCK2 = sockPath('orch2');
registerWake(HOME, TASK, 'orchestrator', { CLAUDE_CODE_MESSAGING_SOCKET: SOCK2, CLAUDE_CODE_MESSAGING_TOKEN: 't' });
const moved = stubKnock();
const rm = await wdn.wardenRound(HOME, TASK, { knock: moved, now: T1 + 2000 });
check('переписанный contact point будит немедленно, не досиживая порог',
  moved.calls.length === 1 && moved.calls[0].endpoint.socket === SOCK2,
  JSON.stringify(moved.calls.map((c) => c.endpoint.socket)));
check('переписанный contact point назван в журнале',
  rm.events.some((e) => /contact point переписан/.test(e)), JSON.stringify(rm.events));

// --- health: молчание дольше порога -------------------------------------------

const late = Date.now() + (wdn.SILENCE_SEC + 60) * 1000;
const r5 = await wdn.wardenRound(HOME, TASK, { knock: stubKnock(), now: late });
check('молчание дольше порога эскалируется с причиной',
  r5.events.some((e) => /МОЛЧИТ orchestrator/.test(e)) && typeof health().orchestrator.escalatedAt === 'string',
  JSON.stringify(r5.events));

const r6 = await wdn.wardenRound(HOME, TASK, { knock: stubKnock(), now: late + 60_000 });
check('эскалация однократна — журнал не заливается одним фактом',
  !r6.events.some((e) => /МОЛЧИТ orchestrator/.test(e)), JSON.stringify(r6.events));

// --- : круг присмотра снимок сессий не запрашивает -----------------------
//
// Снимок приходит кругу аргументом и держится в переменной цикла до удара сердца. Пока это
// так, отказ разбора `claude agents --json` кэшировать незачем; начни круг спрашивать
// снимок сам — и на неразобранном ответе процесс запускался бы каждую секунду (замер и
// условие — в комментарии `wardenRound`, [warden.js](../lib/warden.js)).
// Проверка сторожит именно это свойство: круг идёт БЕЗ снимка и всё равно не зовёт бинарь.
// Счёт по argv подставного бинаря, а не по точкам в коде.
const ROUND_BIN = path.join(SB, 'round-bin');
const ROUND_LOG = path.join(SB, 'round-calls.log');
stubCommand(ROUND_BIN, 'claude', [
  "import { appendFileSync } from 'node:fs';",
  `appendFileSync(${JSON.stringify(ROUND_LOG)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
  "process.stdout.write('[]');",
].join('\n'));
const roundCalls = () => (existsSync(ROUND_LOG) ? readFileSync(ROUND_LOG, 'utf8') : '')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((argv) => argv[0] === 'agents' && argv.includes('--json'));
// Задача своя, и участники в ней ОБЯЗАНЫ нести имя сессии: снимок собирается только по
// таким записям, и на безымянных проверка была бы холостой — снимающий состояние сам круг
// не звал бы бинарь и на них (мутационная проба ловит это ровно здесь).
const ROUND_TASK = 'krug-t20260902-110000';
store.createTask(HOME, { id: ROUND_TASK, title: 'круг и снимок', owner: SESSION });
for (const [i, addr] of ['worker:api', 'worker:web'].entries()) {
  store.upsertParticipant(HOME, ROUND_TASK, store.participantRecord(addr, { name: `Worker: круг ${i}` }));
  store.sendMessage(HOME, ROUND_TASK, { from: 'orchestrator', to: addr, type: 'task', body: 'работай' });
}
const roundBack = withStubPath(ROUND_BIN);
const rounds = [];
try {
  for (let i = 0; i < 3; i += 1) {
    rounds.push(await wdn.wardenRound(HOME, ROUND_TASK, { knock: stubKnock(), now: Date.now() }));
  }
} finally { roundBack(); }
check(': круг присмотра снимок сессий не запрашивает — `claude agents --json` не зовётся ни разу за три круга',
  roundCalls().length === 0 && rounds.length === 3 && rounds.every((r) => r.stop === null),
  `${JSON.stringify(roundCalls())} · ${JSON.stringify(rounds.map((r) => r.stop))}`);
// Страж самой проверки: снимок по этим участникам стоит запуска бинаря, значит ноль выше —
// свойство круга, а не безымянные записи.
const roundSnapCalls = (() => {
  const back = withStubPath(ROUND_BIN);
  try {
    snapshotOf(store.readTask(HOME, ROUND_TASK).participants);
    return roundCalls().length;
  } finally { back(); }
})();
check(': снимок по тем же участникам бинарь зовёт — проверка круга не холостая',
  roundSnapCalls === 1, String(roundSnapCalls));

// --- видимость надзирателя ----------------------------------------------------

const aliveLine = wardenLine(HOME, TASK);
check('живой надзиратель виден строкой с pid и проверенной версией бинаря',
  aliveLine.alive && aliveLine.line.includes(String(process.pid)) && aliveLine.line.includes(`claude ${PROVEN_CLAUDE_VERSION}`),
  aliveLine.line);

// Смерть надзирателя обязана быть видимой: процесс, который никто не сторожит, тихо
// перестаёт доставлять, и run выглядит «просто медленным».
store.clearWarden(HOME, TASK);
const deadLine = wardenLine(HOME, TASK);
check('мёртвый надзиратель назван вслух и с маршрутом перезапуска',
  !deadLine.alive && deadLine.line.startsWith(WARDEN_MARK) && deadLine.line.includes('promptobus warden'),
  deadLine.line);

// Снимок сессий печать берёт швом — тем же, каким его берёт круг присмотра:
// без него `status` спрашивал бы живой `claude agents --json` машины прогона.
const out = capture(() => status(SB, { task: TASK, sessions: snap(TASK, []) }));
check('promptobus status печатает смерть надзирателя', out.includes(WARDEN_MARK), out);
const deadOrch = health().orchestrator ?? {};
check('promptobus status при ENOENT оркестратора называет мёртвого владельца и claim, не self-wake',
  out.includes(orchestratorDeadLine(SESSION, deadOrch.triedAt ?? deadOrch.since))
  && /МОЛЧИТ/.test(out)
  && !/будильник: self-wake \(причина: ENOENT\)/.test(out),
  out);
check('promptobus status печатает хвост журнала надзирателя', /журнал надзирателя/.test(out), out);

// --- : что несёт postcard -----------------------------------------------

// Бюджет текста общий на весь postcard, а не порог на сообщение: пакет из пяти коротких
// иначе давал бы postcard впятеро больше самого длинного из них.
const short = { type: 'answer', from: 'orchestrator', ts: 'T1', body: 'да, делай' };
const long = { type: 'result', from: 'worker:api', ts: 'T2', body: 'ы'.repeat(KNOCK_TEXT_MAX + 1) };
const withArt = { type: 'artifact', from: 'worker:api', ts: 'T3', body: 'дифф', artifact: 'diff.patch' };

const one = orderBody(TASK, 'orchestrator', 1, [short]);
check(': короткое сообщение уезжает текстом целиком',
  one.includes('да, делай') && one.includes('answer от orchestrator'), one);

const big = orderBody(TASK, 'orchestrator', 1, [long]);
check(': длинное сообщение уезжает счётчиком со своим размером, а не обрывком',
  !big.includes('ыыы') && big.includes(`текст ${KNOCK_TEXT_MAX + 1} знаков`), big);

const art = orderBody(TASK, 'orchestrator', 1, [withArt]);
check(': сообщение с артефактом уезжает счётчиком, каким бы коротким ни было',
  !art.includes('дифф') && art.includes('артефакт diff.patch'), art);

// Бюджет тратится по порядку прихода: первым уезжает то, что пришло первым. Съевшее
// почти весь бюджет сообщение не оставляет места соседу — тот уходит счётчиком или в
// хвост, но молча не пропадает.
const half = { type: 'status', from: 'worker:api', ts: 'T4', body: 'я'.repeat(KNOCK_TEXT_MAX - 60) };
const pack = orderBody(TASK, 'orchestrator', 2, [half, short]);
check(': бюджет общий на postcard — первое влезло целиком, второе уже нет',
  pack.includes(half.body) && !pack.includes('да, делай'), pack.slice(0, 400));
check(': не поместившееся названо, а не проглочено',
  /— и ещё 1: забери mailbox|текст 9 знаков/.test(pack), pack.slice(-300));
check(': postcard не разрастается сверх бюджета плюс своя рамка',
  pack.length < KNOCK_TEXT_MAX * 2, String(pack.length));

// Бюджет держит ВЕСЬ блок выжимок, а не сумму тел (замечание ревью): у каждой строки есть
// заголовок «тип от адреса · время», и полсотни непрочитанных давали бы postcard в
// килобайты при формально соблюдённом бюджете. Не поместившееся считается хвостом —
// обрывать пакет молча нельзя.
const pack50 = Array.from({ length: 50 }, (_, i) => (
  { type: 'status', from: 'worker:api', ts: `T${i}`, body: `тело сообщения ${i} `.repeat(8) }));
const packed = orderBody(TASK, 'orchestrator', 50, pack50);
// Предел проверяется ТОЧНО, а не «примерно»: рамка postcard'а постоянна и снимается пустым
// вызовом, всё остальное — блок выжимок, и он обязан уложиться в бюджет целиком, вместе с
// разделителями строк и местом под хвост. Мягкая проверка «бюджет плюс запас» пропускала
// мутацию, снявшую место под хвост.
const frame = orderBody(TASK, 'orchestrator', 0, []).length;
check(': пакет из полусотни укладывается в бюджет целиком',
  packed.length - frame <= KNOCK_TEXT_MAX, `${packed.length - frame} при бюджете ${KNOCK_TEXT_MAX}`);
check(': бюджет тратится, а не простаивает — пакет занял его почти весь',
  packed.length - frame > KNOCK_TEXT_MAX - 100, String(packed.length - frame));
check(': не поместившееся названо хвостом, а не проглочено',
  /— и ещё \d+: забери mailbox/.test(packed), packed.slice(-300));
// Заголовки идут в бюджет наравне с телами: пакет коротких строк, где тела почти ничего не
// весят, всё равно упирается в предел и даёт хвост.
const tiny = Array.from({ length: 60 }, (_, i) => (
  { type: 'status', from: 'worker:very-long-address-here', ts: `2026-08-30T00:00:${i}`, body: 'ок' }));
const tinyCard = orderBody(TASK, 'orchestrator', 60, tiny);
check(': заголовки считаются в бюджет — на коротких телах хвост всё равно есть',
  /— и ещё \d+: забери mailbox/.test(tinyCard), tinyCard.slice(-200));
// Худший случай для бюджета — не длинные тела, а МНОГО коротких строк: там больше всего
// разделителей, и там же тесней всего место под хвост. Мутации, снявшие любой из этих двух
// расходов, на длинном пакете оставались зелёными и ловятся только здесь.
check(': пакет коротких строк тоже укладывается в бюджет целиком',
  tinyCard.length - frame <= KNOCK_TEXT_MAX, `${tinyCard.length - frame} при бюджете ${KNOCK_TEXT_MAX}`);

// Битое сообщение надзиратель не разбирает и в сторону не откладывает: этот доклад
// адресован читателю mailbox'а, а его `warn` уходит в stdio: 'ignore'.
const GLANCE = 'sup-glance-t20260829-160003';
store.createTask(HOME, { id: GLANCE, title: 'заглянуть в ящик', owner: SESSION });
store.upsertParticipant(HOME, GLANCE, store.participantRecord('worker:api'));
store.sendMessage(HOME, GLANCE, { from: 'orchestrator', to: 'worker:api', type: 'task', body: 'целое' });
const inbox = store.inboxDir(HOME, GLANCE, 'worker:api');
writeFileSync(path.join(inbox, '20260829T000000000-9999-orchestrator.json'), '{битое');
const glanced = store.glanceInbox(HOME, GLANCE, 'worker:api');
check(': glanceInbox отдаёт целые сообщения и молчит о битом',
  glanced.length === 1 && glanced[0].body === 'целое', JSON.stringify(glanced));
check(`: битое остаётся в mailbox'е — его разберёт читатель, а не надзиратель`,
  existsSync(path.join(inbox, '20260829T000000000-9999-orchestrator.json')));

// --- подъём надзирателя любой командой ----------------------------------------

// Отметку выше сняли ради проверки «мёртвый надзиратель виден» — возвращаем её: ветка
// «живого никто не поднимает заново» проверяется именно на живом.
store.claimWarden(HOME, TASK, { cli: '0.45.0' });

let launches = 0;
const launch = () => { launches += 1; return 4242; };
check('живого надзирателя никто не поднимает заново',
  wdn.ensureWarden(HOME, TASK, { env: {}, launch }) === null && launches === 0);

store.clearWarden(HOME, TASK);
check('мёртвого поднимает любая команда, и подъём называет pid',
  wdn.ensureWarden(HOME, TASK, { env: {}, launch }) === 4242 && launches === 1);

check('выключатель PROMPTOBUS_WARDEN=off гасит автоподъём',
  wdn.ensureWarden(HOME, TASK, { env: { PROMPTOBUS_WARDEN: 'off' }, launch }) === null && launches === 1);
check('выключатель нечувствителен к регистру и пробелам',
  wdn.wardenOff({ PROMPTOBUS_WARDEN: ' OFF ' }) === true && wdn.wardenOff({}) === false);

const CLOSED = 'sup-closed-t20260829-150001';
store.createTask(HOME, { id: CLOSED, title: 'закрытая', owner: SESSION });
store.closeTask(HOME, CLOSED);
check('закрытую задачу не стережёт никто',
  wdn.ensureWarden(HOME, CLOSED, { env: {}, launch }) === null && launches === 1);
const stopped = await wdn.wardenRound(HOME, CLOSED, { knock: stubKnock() });
check('круг присмотра по закрытой задаче выходит с причиной', stopped.stop === 'задача закрыта', stopped.stop);

// След автоподъёма для гейта раннера. Пишется в точке решения «поднимаем», а не
// внутри отвязанного процесса: гейт читает файл сразу после прогона, гнаться за только что
// запущенным процессом ему нечем. Переменной нет — файла нет вовсе: вне набора тестов
// этого следа не существует.
const TRACE = path.join(SB, 'raised.log');
// Читаем мягко: не написанный след — это красная проверка, а не обрыв файла на исключении.
// Обрыв унёс бы и соседние вердикты, а мутационная проба перестала бы отличать «солгала» от
// «не дожила».
const traceLines = () => {
  try {
    return readFileSync(TRACE, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
store.clearWarden(HOME, TASK);
wdn.ensureWarden(HOME, TASK, { env: { PROMPTOBUS_WARDEN_TRACE: TRACE }, launch });
const trace1 = traceLines();
check(': автоподъём оставляет след с задачей и pid',
  trace1.length === 1 && trace1[0].includes(`задача ${TASK}`) && trace1[0].includes('pid 4242'),
  JSON.stringify(trace1));

wdn.ensureWarden(HOME, TASK, { env: { PROMPTOBUS_WARDEN: 'off', PROMPTOBUS_WARDEN_TRACE: TRACE }, launch });
check(': погашенный выключателем автоподъём следа не оставляет',
  traceLines().length === 1, JSON.stringify(traceLines()));

// --- провод: настоящий unix-сокет ---------------------------------------------

// Форма провода снята с бинаря спайком: построчный JSON, auth первой строкой, следом
// сообщение с `msgV`, `msg_id` и телом в `message.content`. Проверяем её на настоящем
// сокете — заглушка стука такую ошибку не поймала бы вовсе.
const LIVE_SOCK = sockPath('live');
const seen = [];
const server = createServer((c) => {
  let buf = '';
  c.on('data', (d) => { buf += d; });
  c.on('end', () => { seen.push(buf); c.destroy(); });
});
await new Promise((res) => server.listen(LIVE_SOCK, res));

const knocked = await knockSocket({ socket: LIVE_SOCK, token: 'tok123' }, 'проверка провода');
await new Promise((res) => setTimeout(res, 50));
const lines = (seen[0] ?? '').trim().split('\n').map((l) => JSON.parse(l));
check('стук доехал и лёг двумя строками JSON', knocked.ok === true && lines.length === 2, JSON.stringify(seen));
check('первая строка — auth с токеном',
  lines[0]?.type === 'auth' && lines[0].token === 'tok123', JSON.stringify(lines[0]));
check('вторая — сообщение протокола инъекции с телом приказа',
  lines[1]?.msgV === 1 && lines[1].type === 'user' && typeof lines[1].msg_id === 'string'
  && lines[1].message?.content === 'проверка провода' && lines[1].from === KNOCK_FROM,
  JSON.stringify(lines[1]));

// Auth-строка шлётся всегда, даже когда токена нет: на macOS он не проверяется вовсе, на
// Windows обязателен, и код без неё непереносим.
seen.length = 0;
await knockSocket({ socket: LIVE_SOCK }, 'без токена');
await new Promise((res) => setTimeout(res, 50));
check('без токена auth-строка всё равно уходит',
  JSON.parse((seen[0] ?? '{}').split('\n')[0]).type === 'auth', JSON.stringify(seen));

seen.length = 0;
const probed = await probeWake(LIVE_SOCK, 'tok123');
await new Promise((res) => setTimeout(res, 50));
check('смоук doctor соединяется и шлёт ТОЛЬКО auth — чужого хода не трогает',
  probed.ok === true && (seen[0] ?? '').trim().split('\n').length === 1, JSON.stringify(seen));

const dead = await knockSocket({ socket: sockPath('no-such') }, 'в пустоту');
check('несуществующий сокет — отказ с причиной, а не исключение',
  dead.ok === false && typeof dead.error === 'string', JSON.stringify(dead));

await new Promise((res) => server.close(res));

// --- : стук уходит на любом непрочитанном ------------------------------
//
// Будильник в задаче один, и это надзиратель: непрочитанное — единственное условие стука.
// Проверяется на НАСТОЯЩЕМ сокете и настоящим `knockSocket` (шов `knock` здесь не
// подставляется): «стук был» на заглушке значило бы только то, что заглушку позвали, а
// вопрос стоит о проводе — пришло соединение или нет.
const WAITED = 'sup-knock-t20260829-160000';
store.createTask(HOME, { id: WAITED, title: 'стук на непрочитанном', owner: SESSION });
store.upsertParticipant(HOME, WAITED, store.participantRecord('worker:api', { name: 'Worker: адресат стука' }));
const WSOCK = sockPath('bl312');
const knocks = [];
const wserver = createServer((c) => {
  let buf = '';
  c.on('data', (d) => { buf += d; });
  c.on('end', () => { knocks.push(buf); c.destroy(); });
});
await new Promise((res) => wserver.listen(WSOCK, res));
registerWake(HOME, WAITED, 'worker:api', {
  CLAUDE_CODE_MESSAGING_SOCKET: WSOCK, CLAUDE_CODE_MESSAGING_TOKEN: 'tok312',
});
const settle = () => new Promise((res) => setTimeout(res, 50));

store.sendMessage(HOME, WAITED, { from: 'orchestrator', to: 'worker:api', type: 'task', body: 'бриф' });
await wdn.wardenRound(HOME, WAITED);
await settle();
const wired = (knocks[0] ?? '').trim().split('\n').map((l) => JSON.parse(l));
check(': стук уходит немедленно — непрочитанное и есть всё условие',
  knocks.length === 1 && wired.length === 2 && wired[0]?.type === 'auth'
  && wired[1]?.message?.content.includes('worker:api') && wired[1].message.content.includes('бриф'),
  JSON.stringify(knocks).slice(0, 300));

// --- : стоп не рождает notification --------------------------------------
//
// Вставшая сессия сообщений не шлёт: в mailbox'е оркестратора пусто, и по нему о стопе не
// узнать. Эскалация — видимость: журнал надзирателя и строка `promptobus status`. Postcard
// о стопе снят: он сжигал ходы оркестратора на каждом круге, пока стоп не снят.
const STALLED = 'sup-stall-t20260829-160004';
store.createTask(HOME, { id: STALLED, title: 'доклад о вставших', owner: SESSION });
store.upsertParticipant(HOME, STALLED, store.participantRecord('orchestrator', { owner: SESSION }));
store.upsertParticipant(HOME, STALLED, store.participantRecord('worker:api', { name: 'Worker: вставший' }));
registerWake(HOME, STALLED, 'orchestrator', {
  CLAUDE_CODE_MESSAGING_SOCKET: WSOCK, CLAUDE_CODE_MESSAGING_TOKEN: 'tok312',
});
const BLOCKED = [{ id: 'sb', name: 'Worker: вставший', state: 'blocked', pid: process.pid, waitingFor: 'permission prompt' }];

knocks.length = 0;
const rs1 = await wdn.reportStalls(HOME, STALLED, { sessions: snap(STALLED, BLOCKED) });
await settle();
check(': стоп не рождает notification',
  knocks.length === 0, String(knocks.length));
const stallLineOf = (taskId, sessions) => {
  const listed = blockedParticipants(HOME, taskId, store.readTask(HOME, taskId).participants, sessions);
  return listed.map((s) => stallLine(s, taskId));
};
check(': стоп назван в журнале надзирателя',
  rs1.length === 1 && rs1[0] === stallLineOf(STALLED, snap(STALLED, BLOCKED))[0]
  && /permission prompt/.test(rs1[0]) && /claude attach/.test(rs1[0]),
  JSON.stringify(rs1));

knocks.length = 0;
const rs2 = await wdn.reportStalls(HOME, STALLED, { sessions: snap(STALLED, BLOCKED) });
await settle();
check(': тот же стоп второй раз журнал не заливает и стука нет',
  knocks.length === 0 && rs2.length === 0, `${knocks.length} · ${JSON.stringify(rs2)}`);

// Contact point не нужен: доставлять нечего. Отметка ставится сразу.
const LOST = 'sup-lost-t20260829-160005';
store.createTask(HOME, { id: LOST, title: 'стоп без сокета', owner: SESSION });
store.upsertParticipant(HOME, LOST, store.participantRecord('orchestrator', { owner: SESSION }));
store.upsertParticipant(HOME, LOST, store.participantRecord('worker:api', { name: 'Worker: вставший' }));
knocks.length = 0;
const rl1 = await wdn.reportStalls(HOME, LOST, { sessions: snap(LOST, BLOCKED) });
check(': без contact point стоп всё равно пишется, стука нет',
  knocks.length === 0 && rl1.length === 1 && /worker:api встал: permission prompt/.test(rl1[0]),
  `${knocks.length} · ${JSON.stringify(rl1)}`);
const rl2 = await wdn.reportStalls(HOME, LOST, { sessions: snap(LOST, BLOCKED) });
check(': повтор без сокета стука тоже не даёт',
  knocks.length === 0 && rl2.length === 0, `${knocks.length} · ${JSON.stringify(rl2)}`);

// Участник отвис — отметка снимается, иначе следующий его стоп с той же причиной свежим
// не сочтётся.
const ALIVE_AGAIN = [{ id: 'sb', name: 'Worker: вставший', state: 'busy', pid: process.pid }];
await wdn.reportStalls(HOME, STALLED, { sessions: snap(STALLED, ALIVE_AGAIN) });
knocks.length = 0;
const rsAgain = await wdn.reportStalls(HOME, STALLED, { sessions: snap(STALLED, BLOCKED) });
await settle();
check(': участник отвис и встал снова — новая запись в журнале, стука нет',
  knocks.length === 0 && rsAgain.length === 1 && /worker:api встал: permission prompt/.test(rsAgain[0]),
  `${knocks.length} · ${JSON.stringify(rsAgain)}`);

const later = (n) => Date.now() + n * (wdn.KNOCK_RETRY_SEC * 1000 + 1000);
knocks.length = 0;
await wdn.reportStalls(HOME, STALLED, { sessions: snap(STALLED, BLOCKED), now: later(1) });
await settle();
check(': порог перестука стоп не повторяет — postcard снят вместе с повторами',
  knocks.length === 0, String(knocks.length));

const OTHER = [{ id: 'sb', name: 'Worker: вставший', state: 'blocked', pid: process.pid, waitingFor: 'sandbox request' }];
knocks.length = 0;
const rsOther = await wdn.reportStalls(HOME, STALLED, { sessions: snap(STALLED, OTHER), now: later(10) });
await settle();
const otherLine = stallLineOf(STALLED, snap(STALLED, OTHER))[0];
check(': смена причины — новая запись в журнале, стука нет',
  knocks.length === 0 && rsOther.length === 1 && rsOther[0] === otherLine
  && /sandbox request/.test(rsOther[0]),
  `${knocks.length} · ${JSON.stringify(rsOther)}`);

knocks.length = 0;
const rn = await wdn.reportStalls(HOME, STALLED, { sessions: null });
check(': неразобранный список сессий стопа не даёт',
  knocks.length === 0 && rn.length === 0, JSON.stringify(rn));
const afterUnknown = await wdn.reportStalls(HOME, STALLED, { sessions: snap(STALLED, OTHER) });
await settle();
check(': отметку неизвестность не стирает — тот же стоп журнал не повторяет',
  knocks.length === 0 && afterUnknown.length === 0, `${knocks.length} · ${JSON.stringify(afterUnknown)}`);

const NOWAKE = 'sup-nowake-t20260829-160006';
store.createTask(HOME, { id: NOWAKE, title: 'стоп без сокета оркестратора', owner: SESSION });
store.upsertParticipant(HOME, NOWAKE, store.participantRecord('orchestrator', { owner: SESSION }));
store.upsertParticipant(HOME, NOWAKE, store.participantRecord('worker:api', { name: 'Worker: вставший' }));
const rnw = await wdn.reportStalls(HOME, NOWAKE, { sessions: snap(NOWAKE, BLOCKED) });
check(': оркестратор не сдал сокет — стоп всё равно в журнале, стука нет',
  rnw.length === 1 && /worker:api встал: permission prompt/.test(rnw[0]), JSON.stringify(rnw));

await new Promise((res) => wserver.close(res));

// --- удар сердца и ветки выхода ------------------------------

// Процесс `warden` не был покрыт вовсе: проверялись круг присмотра и
// примитивы стора, а цикл, удар сердца и причины выхода — ничем. Прямым следствием этого
// прожил : выход «живых участников не осталось» был недостижим, и заметить это
// было нечем.
//
// Список bg-сессий здесь всегда фикстурой: за настоящим стоит внешний `claude agents
// --json`, а живого `claude` набор не трогает.

const BEAT = 'sup-beat-t20260829-150002';
store.createTask(HOME, { id: BEAT, title: 'удар сердца', owner: SESSION });
store.upsertParticipant(HOME, BEAT, store.participantRecord('orchestrator', { owner: SESSION }));
store.upsertParticipant(HOME, BEAT, store.participantRecord('worker:api', { name: 'Worker: удар сердца' }));
const ALIVE = [{ id: 'sx', name: 'Worker: удар сердца', state: 'busy', pid: process.pid }];

// Вопрос надзирателя — «есть ли ещё кого будить», и `orchestrator` (сессия человека, в
// `claude agents` её не видно) на него не отвечает: считая живым его, список не пустел
// никогда — это и был .
check(': живым считается участник с наблюдаемой сессией, orchestrator без неё — нет',
  wdn.liveWatched(HOME, BEAT, snap(BEAT, ALIVE)).join(',') === 'worker:api',
  wdn.liveWatched(HOME, BEAT, snap(BEAT, ALIVE)).join(','));
check(': сессии участников мертвы — задача опустела, и это видно',
  wdn.liveWatched(HOME, BEAT, snap(BEAT, [])).length === 0, wdn.liveWatched(HOME, BEAT, snap(BEAT, [])).join(','));
check('неразобранный список сессий в мёртвые не записывает',
  wdn.liveWatched(HOME, BEAT, null).join(',') === 'worker:api',
  wdn.liveWatched(HOME, BEAT, null).join(','));

// Окно регистрации: только что поднятой сессии в списке нет ВООБЩЕ, и без окна свежий
// worker объявлялся бы мёртвым в ту же секунду, ради которой окно и заведено.
const FRESH = 'sup-fresh-t20260829-150003';
store.createTask(HOME, { id: FRESH, title: 'окно регистрации', owner: SESSION });
store.upsertParticipant(HOME, FRESH, store.participantRecord('worker:new', { name: 'Worker: только что', started: new Date().toISOString() }));
check('только что поднятая сессия в списке ещё не числится, но мёртвой не считается',
  wdn.liveWatched(HOME, FRESH, snap(FRESH, [])).join(',') === 'worker:new',
  wdn.liveWatched(HOME, FRESH, snap(FRESH, [])).join(','));

// Отметку перехватил преемник — эту сочли мёртвой, и стеречь задачу вдвоём нельзя.
store.writeJsonAtomic(store.wardenMarkFile(HOME, BEAT), {
  pid: 999_999_999, started: new Date().toISOString(), beat: new Date().toISOString(),
});
check('удар сердца по чужой отметке — выход, а не молчаливое продление',
  wdn.beatRound(HOME, BEAT, Date.now(), { sessions: snap(BEAT, ALIVE) }) === 'место надзирателя занял другой процесс',
  String(wdn.beatRound(HOME, BEAT, Date.now(), { sessions: snap(BEAT, ALIVE) })));

// Своя отметка, но состаренная: удар сердца обязан её подвинуть — по свежести отметки
// живость надзирателя и читается.
const staleBeat = new Date(Date.now() - 60_000).toISOString();
store.writeJsonAtomic(store.wardenMarkFile(HOME, BEAT),
  { pid: process.pid, started: staleBeat, beat: staleBeat });
const startedMs = Date.now();
check('живые участники и своя отметка — стеречь дальше',
  wdn.beatRound(HOME, BEAT, startedMs, { sessions: snap(BEAT, ALIVE) }) === null,
  String(wdn.beatRound(HOME, BEAT, startedMs, { sessions: snap(BEAT, ALIVE) })));
check('удар сердца продлил свою отметку',
  store.liveWarden(HOME, BEAT)?.beat > staleBeat, store.liveWarden(HOME, BEAT)?.beat);

check(': живых участников не осталось — причина выхода названа',
  wdn.beatRound(HOME, BEAT, startedMs, { sessions: snap(BEAT, []) }) === 'живых участников не осталось',
  String(wdn.beatRound(HOME, BEAT, startedMs, { sessions: snap(BEAT, []) })));

// «Некого будить» и «нечего доставлять» — не одно и то же (замечание ревью). Worker
// прислал `result`, его сессию погасили: живых нет, а непрочитанное лежит, и путь
// перестука ещё нужен — отброс пределами очереди молчалив, и уйди надзиратель сейчас,
// вместе с ним ушла бы и запись о доставке.
store.sendMessage(HOME, BEAT, { from: 'worker:api', to: 'orchestrator', type: 'result', body: 'итог' });
check('непрочитанное держит слушателя, даже когда живых не осталось',
  wdn.beatRound(HOME, BEAT, startedMs, { sessions: snap(BEAT, []) }) === null,
  String(wdn.beatRound(HOME, BEAT, startedMs, { sessions: snap(BEAT, []) })));
store.readInbox(HOME, BEAT, 'orchestrator');
check('mailbox забран — держать больше нечего, и процесс выходит',
  wdn.beatRound(HOME, BEAT, startedMs, { sessions: snap(BEAT, []) }) === 'живых участников не осталось',
  String(wdn.beatRound(HOME, BEAT, startedMs, { sessions: snap(BEAT, []) })));

// Потолок проверяется подстановкой времени, а не шестью часами ожидания.
const capped = wdn.beatRound(HOME, BEAT, startedMs - wdn.WARDEN_TOTAL_SEC * 1000,
  { now: startedMs, sessions: snap(BEAT, ALIVE) });
check('просиженный общий потолок называет себя причиной выхода',
  capped === 'просидел общий потолок 6 ч', String(capped));
check('секунды до потолка не хватило — сидим дальше',
  wdn.beatRound(HOME, BEAT, startedMs - wdn.WARDEN_TOTAL_SEC * 1000 + 1000,
    { now: startedMs, sessions: snap(BEAT, ALIVE) }) === null);

// --- сам процесс --------------------------------------------------------------

// Место занято живым процессом — второй не поднимается вовсе: один mailbox, стерегомый
// двумя, дал бы два стука на одно сообщение.
const BUSY = 'sup-busy-t20260829-150004';
store.createTask(HOME, { id: BUSY, title: 'занятое место', owner: SESSION });
store.claimWarden(HOME, BUSY, { cli: '0.45.0' });
const busyOut = await capture(() => wdn.warden({ task: BUSY }, { PROMPTOBUS_HOME: HOME }, SB));
check('место занято живым — процесс уходит, назвав держателя',
  /уже работает/.test(busyOut) && busyOut.includes(String(process.pid))
  && !store.tailWardenLog(HOME, BUSY, 20).some((l) => /надзиратель поднят/.test(l)),
  busyOut);

// Задача закрылась — процесс кончается сам, первым же кругом, и снимает свою отметку.
const closedOut = await capture(() => wdn.warden({ task: CLOSED }, { PROMPTOBUS_HOME: HOME }, SB));
check('закрытая задача: процесс выходит с причиной и отметку за собой снимает',
  /вышел: задача закрыта/.test(closedOut) && store.liveWarden(HOME, CLOSED) === null, closedOut);
check('причина выхода ушла и в журнал задачи',
  store.tailWardenLog(HOME, CLOSED, 20).some((l) => /надзиратель вышел · задача закрыта/.test(l)),
  store.tailWardenLog(HOME, CLOSED, 20).join('\n'));

// Цикл выходит по опустевшей задаче. Тридцати секунд удара сердца набор не
// ждёт: подменяются часы процесса, а не константа. `new Date()` от подмены не зависит,
// поэтому метки времени в сторе остаются настоящими.
const LOOP = 'sup-loop-t20260829-150005';
store.createTask(HOME, { id: LOOP, title: 'цикл надзирателя', owner: SESSION });
store.upsertParticipant(HOME, LOOP, store.participantRecord('orchestrator', { owner: SESSION }));
store.upsertParticipant(HOME, LOOP, store.participantRecord('worker:api'));
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow.call(Date) + skew;
// Часы сдвигаются уже ПОСЛЕ старта: `lastBeat` снимается при входе, и постоянный сдвиг
// удара сердца не приблизил бы.
const shift = setTimeout(() => { skew = (store.WARDEN_BEAT_SEC + 1) * 1000; }, 20);
// Страховка от вечного цикла: не сработай выход по живым — задача закроется, процесс
// выйдет другой причиной, и красным станет вердикт, а не весь прогон.
const guard = setTimeout(() => store.closeTask(HOME, LOOP), 15_000);
const loopOut = await capture(() => wdn.warden({ task: LOOP }, { PROMPTOBUS_HOME: HOME }, SB));
clearTimeout(shift);
clearTimeout(guard);
Date.now = realNow;
check(': цикл выходит по опустевшей задаче, а не досиживает потолок',
  /вышел: живых участников не осталось/.test(loopOut), loopOut);
check('отметка надзирателя снята на выходе', store.liveWarden(HOME, LOOP) === null);

// --- : последний стоп задачи пишется в журнал на том же круге, что и выход ---------
//
// Участник умер, mailbox'и пусты — `beatRound` возвращает «живых не осталось» и цикл выходит.
// Стой запись о стопе ПОСЛЕ вердикта, этот стоп не попал бы в журнал никогда. Postcard при
// этом не шлётся.
const LAST = 'sup-last-t20260829-150007';
store.createTask(HOME, { id: LAST, title: 'последний стоп', owner: SESSION });
store.upsertParticipant(HOME, LAST, store.participantRecord('orchestrator', { owner: SESSION }));
store.upsertParticipant(HOME, LAST, store.participantRecord('worker:api', { name: 'Worker: исчезнувший' }));
const LSOCK = sockPath('bl312last');
const lastCards = [];
const lserver = createServer((c) => {
  let buf = '';
  c.on('data', (d) => { buf += d; });
  c.on('end', () => { lastCards.push(buf); c.destroy(); });
});
await new Promise((res) => lserver.listen(LSOCK, res));
registerWake(HOME, LAST, 'orchestrator', {
  CLAUDE_CODE_MESSAGING_SOCKET: LSOCK, CLAUDE_CODE_MESSAGING_TOKEN: 'toklast',
});
// Подставной `claude agents --json` отдаёт пустой список: сессии участника нет вовсе —
// это исход `gone`, он же «живых не осталось» для `liveWatched`.
const LAST_BIN = path.join(SB, 'binlast');
mkdirSync(LAST_BIN, { recursive: true });
writeFileSync(path.join(LAST_BIN, 'claude'), '#!/bin/sh\nprintf \'%s\' \'[]\'\n');
chmodSync(path.join(LAST_BIN, 'claude'), 0o755);
const PATH_WAS = process.env.PATH;
process.env.PATH = `${LAST_BIN}${path.delimiter}${PATH_WAS}`;
const realNowLast = Date.now;
let skewLast = 0;
Date.now = () => realNowLast.call(Date) + skewLast;
const shiftLast = setTimeout(() => { skewLast = (store.WARDEN_BEAT_SEC + 1) * 1000; }, 20);
const guardLast = setTimeout(() => store.closeTask(HOME, LAST), 15_000);
const lastOut = await capture(() => wdn.warden({ task: LAST }, { PROMPTOBUS_HOME: HOME }, SB));
clearTimeout(shiftLast);
clearTimeout(guardLast);
Date.now = realNowLast;
process.env.PATH = PATH_WAS;
await new Promise((res) => setTimeout(res, 100));
check(': цикл вышел по опустевшей задаче',
  /вышел: живых участников не осталось/.test(lastOut), lastOut);
const lastLog = store.tailWardenLog(HOME, LAST, 40);
check(': последний стоп в журнале тем же кругом — postcard нет',
  lastCards.length === 0 && lastLog.some((l) => /worker:api ИСЧЕЗ/.test(l)),
  `карточек ${lastCards.length} · ${lastLog.slice(-8).join(' | ')}`);
await new Promise((res) => lserver.close(res));

// Круг отказал подряд — процесс выходит с причиной, а не молотит в отказ до потолка.
// Отказ настоящий: на месте health.json стоит каталог, и атомарная запись не проходит
// ни разу.
const FAIL = 'sup-fail-t20260829-150006';
store.createTask(HOME, { id: FAIL, title: 'отказ круга', owner: SESSION });
store.upsertParticipant(HOME, FAIL, store.participantRecord('worker:api'));
store.sendMessage(HOME, FAIL, { from: 'orchestrator', to: 'worker:api', type: 'task', body: 'бриф' });
mkdirSync(store.healthFile(HOME, FAIL), { recursive: true });
const failOut = await capture(() => wdn.warden({ task: FAIL }, { PROMPTOBUS_HOME: HOME }, SB));
check(`круг присмотра отказал ${wdn.ROUND_FAIL_LIMIT} раза подряд — выход с причиной`,
  new RegExp(`вышел: круг присмотра отказал ${wdn.ROUND_FAIL_LIMIT} раза подряд`).test(failOut), failOut);
check('каждый отказ пронумерован в журнале надзирателя',
  store.tailWardenLog(HOME, FAIL, 20)
    .filter((l) => new RegExp(`круг присмотра отказал \\(\\d/${wdn.ROUND_FAIL_LIMIT}\\)`).test(l))
    .length === wdn.ROUND_FAIL_LIMIT,
  store.tailWardenLog(HOME, FAIL, 20).join('\n'));

// --- диагностика состояния участника (, , ) ----
//
// Вставшая сессия сообщений не шлёт, и заметить её можно только по состоянию сессий.
// Разбор состояния и обе строки о нём живут в status.js: их читают доклад надзирателя
// выше, печать `promptobus status` и ответ `mailbox`. Проба состояния здесь подставная — живой
// `claude agents --json` не зовётся, предмет один: что докладывается и сколько раз.
const {
  stallTail, justSpawned,
  SPAWN_GRACE_SEC, pendingStalls, commitStalls, stallStands, sessionBusy,
} = await import(path.join(here, '..', 'lib', 'status.js'));

const DIAG = 'sup-diag-t20260829-170000';
store.createTask(HOME, { id: DIAG, title: 'диагностика состояния участника' });

// Вопрос «что нового» и запись отметки разведены намеренно: у надзирателя канал
// доклада один, и «доложено» раньше ушедшего стука теряло бы доклад молча. Здесь их зовут
// парой — предмет проверок ниже в том, ЧТО пара считает свежим.
const freshStalls = (task, probe) => {
  const { fresh, current } = pendingStalls(HOME, task, probe);
  commitStalls(HOME, task, current);
  return fresh;
};

check('sessionStall: сессия без метки стопа живой и остаётся',
  sessionStall({ status: 'waiting' }, null) === null && sessionStall(null, null) === null);

// : причин у стопа минимум две, и лечатся они по-разному. Различает их не факт
// стопа, а то, чем сессия занята: `waitingFor` выдаётся только у стоящей на диалоге,
// а исчерпанный лимит опознаётся по строке самого harness'а из state.json.
const LIMIT = "You've hit your session limit · resets 6:20am (Europe/Moscow)";
check(': диалог — permission, причина из waitingFor',
  JSON.stringify(sessionStall({ state: 'blocked', waitingFor: 'permission prompt' }, null))
  === JSON.stringify({ kind: 'permission', reason: 'permission prompt' }));
check(': лимит опознаётся по строке harness"а, а не по факту стопа',
  JSON.stringify(sessionStall({ state: 'blocked' }, LIMIT))
  === JSON.stringify({ kind: 'limit', reason: LIMIT }));
check(': своими словами написанная причина остаётся причиной, но маршрут по ней не выводится',
  JSON.stringify(sessionStall({ state: 'blocked' }, 'awaiting reviewer'))
  === JSON.stringify({ kind: 'unknown', reason: 'awaiting reviewer' }));
check(': причины нет вовсе — печатается голый blocked, а не выдумка',
  sessionStall({ state: 'blocked' }, null).reason === 'blocked');
check(': диалог сильнее строки — на permission-запросе человек нужен, что бы ни было в detail',
  sessionStall({ state: 'blocked', waitingFor: 'permission prompt' }, LIMIT).kind === 'permission');
// Ветка permission строки из state.json не использует, а надзиратель опрашивает состояние
// на каждом ударе сердца по каждому вставшему: файл ради неё не читается вовсе.
let peeked = 0;
const counting = new Proxy({ state: 'blocked', waitingFor: 'permission prompt' }, {
  get(t, k) { if (k === 'id') peeked += 1; return t[k]; },
});
sessionStall(counting);
check(': на диалоге state.json не читается — лишнего файла на каждом ударе сердца не будет',
  peeked === 0, String(peeked));

// Маршруты разные, и это весь смысл разделения: на лимите человека звать не с чем.
const rPerm = stallRoute({ kind: 'permission' }, 'abc123', 'Worker: X');
const rLimit = stallRoute({ kind: 'limit' }, 'abc123', 'Worker: X');
const rUnknown = stallRoute({ kind: 'unknown' }, 'abc123', 'Worker: X');
check(': permission зовёт человека к сессии',
  /claude attach abc123/.test(rPerm) && /человек/.test(rPerm), rPerm);
check(': лимит человека не зовёт — сбросится сам, будится сообщением',
  /человек не нужен/.test(rLimit) && /сообщением/.test(rLimit) && !/claude attach/.test(rLimit), rLimit);
check(': неопознанная причина не выдумывает маршрут, а посылает в логи',
  /claude logs abc123/.test(rUnknown), rUnknown);

// Строка причины лежит у демона фоновых сессий, а не в списке сессий. Формат не
// контракт: нет каталога, нет файла, не разобран JSON — причины нет.
const CLAUDE_HOME = path.join(SB, 'claude-home');
mkdirSync(path.join(CLAUDE_HOME, 'jobs', 'abc123'), { recursive: true });
writeFileSync(path.join(CLAUDE_HOME, 'jobs', 'abc123', 'state.json'),
  JSON.stringify({ state: 'blocked', detail: LIMIT, tempo: 'blocked' }));
mkdirSync(path.join(CLAUDE_HOME, 'jobs', 'broken'), { recursive: true });
writeFileSync(path.join(CLAUDE_HOME, 'jobs', 'broken', 'state.json'), '{не json');
check(': detail читается из jobs/<id>/state.json',
  sessionDetail('abc123', CLAUDE_HOME) === LIMIT, String(sessionDetail('abc123', CLAUDE_HOME)));
check(': неразобранный или отсутствующий state.json — причины нет, а не падение',
  sessionDetail('broken', CLAUDE_HOME) === null && sessionDetail('net-takogo', CLAUDE_HOME) === null
  && sessionDetail(null, CLAUDE_HOME) === null);

// Формат не контракт, значит многострочное и очень длинное значение — законный вход,
// а не порча: сессия пишет свой статус туда сама, и в него попадал целый абзац
// задания. Причина печатается в однострочный вывод — строку участника `promptobus status` и
// строку доклада, — поэтому сводим к одной строке здесь.
mkdirSync(path.join(CLAUDE_HOME, 'jobs', 'multi'), { recursive: true });
writeFileSync(path.join(CLAUDE_HOME, 'jobs', 'multi', 'state.json'),
  JSON.stringify({ state: 'blocked', detail: `  Ты — worker задачи\n\n\tправь только его\n${'х'.repeat(400)}  ` }));
const flatDetail = sessionDetail('multi', CLAUDE_HOME);
check(': многострочный detail сводится к одной строке и режется по длине',
  !/[\n\r\t]/.test(flatDetail) && flatDetail.length <= 160 && flatDetail.endsWith('…')
  && flatDetail.startsWith('Ты — worker задачи правь только его'), `${flatDetail.length}: ${flatDetail}`);
mkdirSync(path.join(CLAUDE_HOME, 'jobs', 'blank'), { recursive: true });
writeFileSync(path.join(CLAUDE_HOME, 'jobs', 'blank', 'state.json'),
  JSON.stringify({ state: 'blocked', detail: '   \n\t ' }));
check(': пробельный detail — это отсутствие причины, а не пустая строка',
  sessionDetail('blank', CLAUDE_HOME) === null, JSON.stringify(sessionDetail('blank', CLAUDE_HOME)));
check(': причина, пришедшая аргументом, нормализуется тем же правилом',
  sessionStall({ state: 'blocked' }, `жду\nответа\treviewer'а`).reason === `жду ответа reviewer'а`,
  sessionStall({ state: 'blocked' }, `жду\nответа\treviewer'а`).reason);

store.upsertParticipant(HOME, DIAG, store.participantRecord('worker:api', { name: `a2a-${DIAG}-api` }));
const diagStall = [{
  address: 'worker:api', name: `a2a-${DIAG}-api`, id: 'abc123', kind: 'permission', reason: 'permission prompt',
}];
const firstStall = freshStalls(DIAG, () => diagStall);
check('стоп участника: докладывается с причиной и адресом',
  firstStall.length === 1 && firstStall[0].address === 'worker:api' && firstStall[0].reason === 'permission prompt',
  JSON.stringify(firstStall));
check('стоп участника: тот же стоп второй раз не будит — иначе оркестратор жжёт ход за ходом',
  freshStalls(DIAG, () => diagStall).length === 0);
check('стоп участника: отвис — отметка снята', freshStalls(DIAG, () => []).length === 0);
check('стоп участника: вставший заново докладывается снова',
  freshStalls(DIAG, () => diagStall).length === 1);
check('стоп участника: состояние сессий не разобрано — тревоги нет',
  freshStalls(DIAG, () => null).length === 0);
// Причина сменилась — стоп другой, и молчать о нём нельзя: лечится он иначе.
const limitStall = [{
  address: 'worker:api', name: `a2a-${DIAG}-api`, id: 'abc123', kind: 'limit', reason: LIMIT,
}];
check(': сменившаяся причина докладывается заново, а не считается тем же стопом',
  freshStalls(DIAG, () => limitStall).length === 1);

// stalls.json приезжает на место через rename, как журнал задачи: жёсткая ссылка
// на прежний файл держит прежнее содержимое. Записанный поверх себя, он менялся бы и по
// ссылке — а читатель, застигший его усечённым, разбирает пустоту как «ни о чём не
// докладывали» и докладывает тот же стоп второй раз.
const STALLS = 'otmetki-t20260829-050000';
store.createTask(HOME, { id: STALLS, title: 'отметка доложенных стопов' });
const oneStall = [{ address: 'worker:api', name: 'api', id: 'sess-1', kind: 'limit', reason: 'лимит' }];
freshStalls(STALLS, () => oneStall);
const stallsPath = path.join(store.taskDir(HOME, STALLS), 'stalls.json');
const heldStalls = path.join(SB, 'stalls-held.json');
linkSync(stallsPath, heldStalls);
freshStalls(STALLS, () => [{ ...oneStall[0], reason: 'другая причина' }]);
check(': stalls.json не пишется поверх себя — новый файл поставлен через rename',
  !readFileSync(heldStalls, 'utf8').includes('другая причина')
  && readFileSync(stallsPath, 'utf8').includes('другая причина'));

// --- : за мёртвой записью никого нет, и это не стоп --------------------

// Запись, пережившая свой демон, отличается от живой отсутствием `pid`, и признак
// самокалибрующийся: объявлять по нему «числится» можно только там, где этот claude
// вообще печатает pid. Поэтому в списке рядом стоит живая запись с pid.
const GHOST_NAME = `a2a-${DIAG}-ghost`;
const ghostList = [
  { id: 'live1', name: `a2a-${DIAG}-alive`, state: 'working', pid: 5151 },
  { id: 'ghost1', name: GHOST_NAME, state: 'blocked' },
];
const ghostSeen = blocked(DIAG, [{ address: 'worker:ghost', name: GHOST_NAME }], ghostList);
check(': мёртвая запись помечена stale, а не стопом — у неё тоже state=blocked',
  ghostSeen.length === 1 && ghostSeen[0].kind === 'stale' && ghostSeen[0].id === 'ghost1',
  JSON.stringify(ghostSeen));
check(': молчать о ней тоже нельзя — сообщений от неё не будет никогда',
  ghostSeen.length === 1, JSON.stringify(ghostSeen));
// Та же запись, но с pid: процесс за ней есть, и это обычный стоп со своим маршрутом.
const alivePaused = blocked(DIAG,
  [{ address: 'worker:ghost', name: GHOST_NAME }],
  [{ id: 'ghost1', name: GHOST_NAME, state: 'blocked', pid: 7373 }],
);
check(': живая вставшая сессия по-прежнему стоп, а не «числится»',
  alivePaused[0].kind !== 'stale', JSON.stringify(alivePaused));
const rStale = stallRoute({ kind: 'stale', address: 'worker:ghost' }, 'ghost1', GHOST_NAME);
check(': маршрут по мёртвой записи не зовёт будить сообщением — будить некого',
  /будить некого/.test(rStale) && !/SendMessage/.test(rStale) && /claude logs ghost1/.test(rStale), rStale);
check(`: маршрут по мёртвой записи worker'а зовёт поднять его тем же spawn'ом`,
  /spawn'ом/.test(rStale) && /worktree/.test(rStale), rStale);
// Reviewer'а поднимают другой командой, и адрес `worker:<слаг>` ему не подходит: `promptobus spawn`
// заводит worker'а, а worktree у reviewer'а нет вовсе (замечание ревью). Единственный
// задокументированный живой призрак — как раз сессия reviewer'а.
const REVIEWER_REPO = path.join(SB, 'repos', 'loads_search', 'cargos-api');
const rStaleReviewer = stallRoute(
  { kind: 'stale', address: 'reviewer:cargos-api', repoAbs: REVIEWER_REPO, task: DIAG },
  'ghost2', 'Review: X',
);
check(`: мёртвую запись reviewer'а поднимают promptobus review, а не spawn'ом worker'а`,
  rStaleReviewer.includes(`promptobus review "${REVIEWER_REPO}" --task ${DIAG}`)
  && !/spawn'ом/.test(rStaleReviewer) && !/worktree/.test(rStaleReviewer), rStaleReviewer);
check(': путь клона неизвестен — маршрут не выдумывает его, а называет место',
  stallRoute({ kind: 'stale', address: 'reviewer:x' }, 'g', 'n').includes('<путь клона>'),
  stallRoute({ kind: 'stale', address: 'reviewer:x' }, 'g', 'n'));

// --- : строки о вставших — одни на все каналы --------------------------
//
// Маршрут по вставшему обязан быть один: разъехавшись, каналы стали бы двумя разными
// советами об одном состоянии. Строку собирает общая функция, её печатает `promptobus status`,
// её же повторяют ответ `mailbox` и postcard надзирателя.
const stallSample = [{
  address: 'worker:api', ref: 'Worker: X', id: 'abc123', kind: 'permission', reason: 'permission prompt',
}];
const sampleLine = stallLine(stallSample[0], DIAG);
check(': строка вставшего собирается одной функцией — адрес, причина, маршрут',
  sampleLine.startsWith('worker:api встал: permission prompt')
  && sampleLine.includes('claude attach abc123'), sampleLine);
const staleLine = stallLine({ ...stallSample[0], kind: 'stale', reason: 'запись пережила свой демон' }, DIAG);
check(': та же функция даёт «ЧИСЛИТСЯ» для пережившей демон записи',
  staleLine.includes('ЧИСЛИТСЯ, но процесса за ней нет'), staleLine);
// Причина и слова вызывающего не должны повторять друг друга: до правки строка говорила
// «процесса за ней нет» дважды подряд.
check(': строка не заикается — про отсутствие процесса сказано один раз',
  staleLine.split('процесса за ней нет').length - 1 === 1, staleLine);
check(': хвост на живом стопе обещает возврат, на мёртвой записи — нет',
  /пока стоп не снят/.test(stallTail(stallSample))
  && !/пока стоп не снят/.test(stallTail([{ ...stallSample[0], kind: 'stale' }])), stallTail(stallSample));
// Общего совета на всех вставших нет: маршрут у каждого свой и стоит в его строке. Прежняя
// общая строка звала снять сессию сразу после маршрута, который на лимите только что
// сказал «человек не нужен», — и сливала два разных исхода обратно в один. `claude stop`
// законно стоит ВНУТРИ маршрута исчезнувшего: там он объясняет, куда делась запись.
check(': хвост не даёт общего совета поверх маршрута',
  !/claude stop/.test(stallTail([{ kind: 'limit' }, { kind: 'gone' }])),
  stallTail([{ kind: 'limit' }, { kind: 'gone' }]));

// --- : свежеспавненный участник не призрак -----------------------------
//
// `promptobus spawn` пишет участника в журнал РАНЬШЕ, чем поднятая сессия появляется в
// `claude agents --json` со своим pid. Живой прогон 2026-08-28: присмотр за сессиями
// объявил только что поднятого worker'а призраком и позвал «поднимай заново» — а `claude
// agents --json` секундой позже показывал его сессию живой (pid 63976, state working).
const FRESH_NAME = `a2a-${DIAG}-fresh`;
const registering = [
  { id: 'live2', name: `a2a-${DIAG}-alive`, state: 'working', pid: 5252 },
  { id: 'fresh1', name: FRESH_NAME, state: 'blocked' },
];
const freshP = { address: 'worker:fresh', name: FRESH_NAME, started: new Date().toISOString() };
check(': участник, записанный только что, призраком не объявляется',
  blocked(DIAG, [freshP], registering).length === 0,
  JSON.stringify(blocked(DIAG, [freshP], registering)));
const oldP = { ...freshP, started: new Date(Date.now() - (SPAWN_GRACE_SEC + 5) * 1000).toISOString() };
check(': окно кончилось — та же запись снова читается как призрак',
  blocked(DIAG, [oldP], registering)[0]?.kind === 'stale',
  JSON.stringify(blocked(DIAG, [oldP], registering)));
check(': записи без started окно не даётся — прежнее поведение',
  blocked(DIAG, [{ address: 'worker:fresh', name: FRESH_NAME }], registering)[0]?.kind === 'stale');
check(': окно считается по started, вперёд и назад',
  justSpawned({ metadata: { started: new Date().toISOString() } }) === true
  && justSpawned({ metadata: { started: new Date(Date.now() - (SPAWN_GRACE_SEC + 1) * 1000).toISOString() } }) === false
  && justSpawned({ metadata: { started: 'не дата' } }) === false && justSpawned({ metadata: {} }) === false
  && justSpawned({ metadata: { started: new Date(Date.now() + 60000).toISOString() } }) === false);
// Отметка «о стопе доложено» в окне не ложится: настоящий стоп после него обязан быть
// доложен как новый, а не съеден ложной тревогой.
const FRESH_TASK = 'fresh-t20260828-160000';
store.createTask(HOME, { id: FRESH_TASK, title: 'окно регистрации' });
store.upsertParticipant(HOME, FRESH_TASK, asRecords([freshP])[0]);
check(': в окне отметка не ложится и доклада нет',
  freshStalls(FRESH_TASK, (ps) => blocked(FRESH_TASK, ps, registering)).length === 0);
store.upsertParticipant(HOME, FRESH_TASK, asRecords([oldP])[0]);
check(': после окна тот же стоп докладывается как новый',
  freshStalls(FRESH_TASK, (ps) => blocked(FRESH_TASK, ps, registering)).length === 1);

// --- : «записи нет» и «часы сдвинулись» --------------------------------
//
// Участник, чьей записи в `claude agents` больше нет, прежде просто пропускался: сессия
// снята человеком или подъём сорвался — присмотр об этом не узнавал никогда, ровно в том
// случае, ради которого он и заведён.
const goneP = {
  address: 'worker:snyat', name: `a2a-${DIAG}-snyat`, repoAbs: '/tmp/klon',
  session: 'was42', started: new Date(Date.now() - (SPAWN_GRACE_SEC + 5) * 1000).toISOString(),
};
const goneSeen = blocked(DIAG, [goneP], registering);
check(': записи участника в списке нет — доклад, а не молчание',
  goneSeen.length === 1 && goneSeen[0].kind === 'gone'
  && goneSeen[0].address === 'worker:snyat', JSON.stringify(goneSeen));
check(': «записи нет» и «запись жива» — разные исходы, живой в доклад не идёт',
  blocked(DIAG, [{ address: 'worker:alive', name: `a2a-${DIAG}-alive` }], registering).length === 0,
  JSON.stringify(blocked(DIAG, [{ address: 'worker:alive', name: `a2a-${DIAG}-alive` }], registering)));
// Окно регистрации накрывает и эту ветку, причём в первую очередь: только что поднятой
// сессии в списке нет ВООБЩЕ, а не «есть без pid».
check(': только что записанного участника исчезнувшим не объявляют',
  blocked(DIAG, [{ ...goneP, started: new Date().toISOString() }], registering).length === 0,
  JSON.stringify(blocked(DIAG, [{ ...goneP, started: new Date().toISOString() }], registering)));
const goneRoute = stallRoute({ ...goneSeen[0], task: DIAG }, goneSeen[0].id, goneSeen[0].ref);
check(`: маршрут исчезнувшего worker'а — переподъём spawn'ом, без claude logs`,
  /поднимай worker'а заново тем же spawn'ом/.test(goneRoute) && !/claude logs/.test(goneRoute), goneRoute);
// Замечание ревью: строку повторяет каждый mailbox до закрытия задачи, а исчезнуть
// сессия могла и штатно — человек снял её после сданной работы. Голое «поднимай заново»
// звало бы поднимать участника, чью работу уже приняли.
check('замечание ревью: маршрут исчезнувшего различает сданную работу и несданную',
  /claude stop/.test(goneRoute) && /[Рр]абота сдана/.test(goneRoute)
  && /не сдана/.test(goneRoute), goneRoute);
check(`: маршрут исчезнувшего reviewer'а — promptobus review по его клону, а не spawn`,
  stallRoute({ kind: 'gone', address: 'reviewer:api', repoAbs: '/tmp/klon', task: DIAG }, null, 'n')
    .includes(`promptobus review "/tmp/klon" --task ${DIAG}`),
  stallRoute({ kind: 'gone', address: 'reviewer:api', repoAbs: '/tmp/klon', task: DIAG }, null, 'n'));
check(': строка исчезнувшего — своя, не «встал» и не «числится»',
  stallLine(goneSeen[0], DIAG).includes('ИСЧЕЗ: записи сессии в claude agents нет')
  && !/встал|ЧИСЛИТСЯ/.test(stallLine(goneSeen[0], DIAG)), stallLine(goneSeen[0], DIAG));
check(': хвост на исчезнувшем возврата сообщений не обещает',
  !/пока стоп не снят/.test(stallTail(goneSeen)), stallTail(goneSeen));

// Часы, сдвинутые назад после spawn'а, делали свежую запись «из будущего», грейс-окно
// снималось, и поднимающийся участник объявлялся призраком в ту же секунду, ради которой
// окно и заведено. Окно теперь симметрично: тот же срок вперёд.
check(': запись из будущего в пределах окна — окно ей даётся, а не снимается',
  justSpawned({ metadata: { started: new Date(Date.now() + (SPAWN_GRACE_SEC - 5) * 1000).toISOString() } }) === true,
  String(justSpawned({ metadata: { started: new Date(Date.now() + (SPAWN_GRACE_SEC - 5) * 1000).toISOString() } })));
check(': сдвинутые назад часы не объявляют поднимающегося участника призраком',
  blocked(DIAG, [{
    address: 'worker:chasy', name: FRESH_NAME,
    started: new Date(Date.now() + (SPAWN_GRACE_SEC - 5) * 1000).toISOString(),
  }], registering).length === 0);

// Живость процесса читают двое: снятие протухшего лока задачи и отметка надзирателя.
// Номер переиспользуется системой, поэтому мусор и заведомо свободный номер обязаны быть
// мёртвыми, а свой — живым.
check(': pidAlive — свой процесс жив, заведомо свободный номер мёртв, мусор мёртв',
  store.pidAlive(process.pid) === true && store.pidAlive(2147483646) === false
  && store.pidAlive(0) === false && store.pidAlive(null) === false && store.pidAlive(-1) === false);

// --- : штатный конец хода участника — не стоп ---------------------------
//
// Пока на шине было ожидание, участник между сообщениями сидел внутри вызова инструмента
// и для harness'а был `working`. С  он, отправив сообщение, ход заканчивает, и
// harness метит фоновую сессию `blocked` со строкой вроде «result sent; awaiting next
// cycle»: для `sessionStall` это `unknown`, и доклад уходил на каждый штатный конец хода.
// Замер 2026-09-01, задача promptobus: четыре доклада «встал» за 15 минут, все четыре
// после только что присланного `result`, настоящих стопов (`permission`, `limit`) ноль.
// Отличает одно — молчал ли участник ПОСЛЕ того, как его активировали.
const TURN_END = '9 review notes closed, result sent; awaiting next cycle';
check(': строку штатного конца хода сессия пишет своими словами — это kind unknown',
  sessionStall({ state: 'blocked' }, TURN_END).kind === 'unknown',
  JSON.stringify(sessionStall({ state: 'blocked' }, TURN_END)));

const CYCLE = 'cikl-t20260901-190000';
store.createTask(HOME, { id: CYCLE, title: 'штатный конец хода участника' });
const CYCLE_NAME = `a2a-${CYCLE}-api`;
store.upsertParticipant(HOME, CYCLE, store.participantRecord('worker:api', { name: CYCLE_NAME }));
// Рядом живая запись с pid: без неё признак «числится» самокалибруется, и вставшая сессия
// читалась бы как пережившая свой демон.
const cycleSessions = [
  { id: 'live3', name: `a2a-${CYCLE}-alive`, state: 'working', pid: 5353 },
  { id: 'cyc1', name: CYCLE_NAME, state: 'blocked', pid: 8484 },
];
// Участник прислал `result` и закончил ход. Время активации отмеряем ОТ метки сообщения,
// а не от текущего времени: `Date.now()` рядом с отправкой попадает в ту же миллисекунду,
// и проверка краснела бы через раз.
const cycleMsg = store.sendMessage(HOME, CYCLE, {
  from: 'worker:api', to: 'orchestrator', type: 'result', body: 'итог первой задачи',
});
const beforeMsg = new Date(Date.parse(cycleMsg.message.ts) - 60000).toISOString();
const afterMsg = new Date(Date.parse(cycleMsg.message.ts) + 60000).toISOString();
const cycleP = { address: 'worker:api', name: CYCLE_NAME, started: beforeMsg };
const cycleSeen = () => blocked(CYCLE, [cycleP], cycleSessions);

store.writeHealth(HOME, CYCLE, { 'worker:api': { deliveredAt: beforeMsg } });
check(': конец хода после отправленного сообщения не докладывается',
  cycleSeen().length === 0, JSON.stringify(cycleSeen()));

// Тот же участник и та же сессия: изменилось одно — после активации он не написал ничего.
store.writeHealth(HOME, CYCLE, { 'worker:api': { deliveredAt: afterMsg } });
check(': молчал после активации — это стоп, и он докладывается как unknown',
  cycleSeen().length === 1 && cycleSeen()[0].kind === 'unknown'
  && cycleSeen()[0].address === 'worker:api', JSON.stringify(cycleSeen()));

// Считается отправленное САМИМ адресом: имя файла сообщения несёт отправителя, и
// присланное участнику за его собственный ход не выдаётся.
store.sendMessage(HOME, CYCLE, { from: 'orchestrator', to: 'worker:api', type: 'task', body: 'ещё задача' });
check(': присланное участнику за его собственное сообщение не считается',
  cycleSeen().length === 1, JSON.stringify(cycleSeen()));

// Забранное из mailbox'а сообщение уезжает в `read/` — счёт от этого не меняется.
store.readInbox(HOME, CYCLE, 'orchestrator');
store.writeHealth(HOME, CYCLE, { 'worker:api': { deliveredAt: beforeMsg } });
check(`: прочитанное сообщение считается наравне с лежащим в mailbox'е`,
  cycleSeen().length === 0, JSON.stringify(cycleSeen()));

// Удавшийся стук — тоже активация: забранный mailbox не единственная её отметка.
store.writeHealth(HOME, CYCLE, { 'worker:api': { knockedAt: afterMsg } });
check(': активацией считается и удавшийся стук, не только забранный mailbox',
  cycleSeen().length === 1, JSON.stringify(cycleSeen()));

// Попытка стука активацией не считается: неудавшийся стук хода не начал, и молчание после
// него говорит о глухом канале, а не о стопе — про это у шины свои слова (`self-wake`).
store.writeHealth(HOME, CYCLE, { 'worker:api': { deliveredAt: beforeMsg, triedAt: afterMsg } });
check(': попытка стука активацией не считается — участника она не достала',
  cycleSeen().length === 0, JSON.stringify(cycleSeen()));

// `permission` и `limit` — настоящие стопы, и снимает их человек или время, а не
// сообщение на шине: у участника, только что приславшего `result`, может стоять и диалог.
store.writeHealth(HOME, CYCLE, { 'worker:api': { deliveredAt: beforeMsg } });
const permSeen = blocked(CYCLE, [cycleP], [
  cycleSessions[0],
  { id: 'cyc2', name: CYCLE_NAME, state: 'blocked', waitingFor: 'permission prompt', pid: 8484 },
]);
check(': permission докладывается и после отправленного сообщения',
  permSeen.length === 1 && permSeen[0].kind === 'permission', JSON.stringify(permSeen));
// Лимит опознаётся по `detail` из каталога демона фоновых сессий, а его
// `blockedParticipants` читает у настоящего claude. Поэтому его проверяем общим
// предикатом — тем самым, которым идут и доклад, и печать `promptobus status`.
check(': limit докладывается и после отправленного сообщения',
  stallStands(HOME, CYCLE, asRecord(cycleP), { kind: 'limit', reason: LIMIT }) === true);
check(': тот же предикат на unknown после отправленного сообщения говорит «не стоп»',
  stallStands(HOME, CYCLE, asRecord(cycleP), { kind: 'unknown', reason: TURN_END }) === false);
check(': времени активации нет вовсе — сравнивать не с чем, и стоп остаётся стопом',
  stallStands(HOME, CYCLE, { address: 'worker:bez-otmetok' }, { kind: 'unknown', reason: TURN_END }) === true);

// --- : вход в разбор стопа — конец хода, а не состояние `blocked` -------
//
//  опирался на то, что харнес метит закончившую ход сессию `blocked`. На `claude`
// 2.1.251 это не так: замер живого прогона E2E 2026-09-02 — шесть снимков `claude agents
// --json` с шагом 20 с — дал у обеих сессий `status: idle`, `state: done`, `waitingFor: null`,
// а по всем девяти записям машины у фоновых сессий встретились ровно две пары состояний:
// `busy/working` и `idle/done`. Вход по `blocked` не срабатывал вовсе, и молчаливый участник
// был невидим целиком. Фикстуры поэтому идут ПАРАМИ — `done` рядом с `blocked`: обе формы
// живые, и проверять одну значило бы снова закрепить половину правды.
const IDLE_DONE = { id: 'done1', name: 'Worker: отдал ход', status: 'idle', state: 'done', pid: process.pid };
const BUSY_WORKING = { id: 'work1', name: 'Worker: думает', status: 'busy', state: 'working', pid: process.pid };
// Исход называется явно, а не только сверяется с соседом: сравнение двух вызовов на
// мутации, отдающей `null` в обеих ветках, дало бы `'null' === 'null'` и зелень
// (замечание ревью) — то есть проверка прошла бы при снятом входе.
check(': закончившая ход сессия 2.1.251 (idle/done) — стоп того же рода, что прежний blocked',
  sessionStall(IDLE_DONE, TURN_END)?.kind === 'unknown'
  && JSON.stringify(sessionStall(IDLE_DONE, TURN_END))
  === JSON.stringify(sessionStall({ state: 'blocked' }, TURN_END)),
  JSON.stringify(sessionStall(IDLE_DONE, TURN_END)));
// Обращения к результату идут через `?.`: на мутационной пробе `sessionStall` отдаёт здесь
// `null`, и жёсткое чтение поля унесло бы файл целиком — вердиктов ниже не было бы вовсе, а
// проба обязана показывать, СКОЛЬКО проверок она красит.
check(': причины нет — называется признак входа, а не выдуманное состояние',
  sessionStall(IDLE_DONE, null)?.reason === 'idle'
  && sessionStall({ state: 'blocked' }, null)?.reason === 'blocked',
  `${sessionStall(IDLE_DONE, null)?.reason} · ${sessionStall({ state: 'blocked' }, null)?.reason}`);
check(': идущий ход стопом не считается — busy/working остаётся вне разбора',
  sessionStall(BUSY_WORKING, TURN_END) === null, JSON.stringify(sessionStall(BUSY_WORKING, TURN_END)));
// Метка диалога состояния не спрашивает и стоит выше гейта: сессия, упёршаяся в
// permission-запрос ПОСРЕДИ хода, ждёт человека независимо от того, чем занята. Без этой
// фикстуры порядок веток держался бы на прозе (замечание ревью).
check(': метка диалога сильнее состояния — идущий ход с ней всё равно permission',
  sessionStall({ ...BUSY_WORKING, waitingFor: 'permission prompt' }, TURN_END)?.kind === 'permission',
  JSON.stringify(sessionStall({ ...BUSY_WORKING, waitingFor: 'permission prompt' }, TURN_END)));
check(': лимит и диалог опознаются на idle/done так же, как на blocked',
  sessionStall(IDLE_DONE, LIMIT)?.kind === 'limit'
  && sessionStall({ ...IDLE_DONE, waitingFor: 'permission prompt' }, LIMIT)?.kind === 'permission',
  JSON.stringify([sessionStall(IDLE_DONE, LIMIT), sessionStall({ ...IDLE_DONE, waitingFor: 'permission prompt' }, LIMIT)]));

// Снимок driver'а: `idle/done` обязана доехать до машины состояний как «жива, ход
// закончен», а не как исчезнувшая или пережившая свой демон. Живость там считается по
// `pid`, и состояние на неё не влияет — но проверить это надо явно: молча разъехавшись,
// стоп доложился бы маршрутом «будить некого».
const doneView = claudeDriver.inspect(IDLE_DONE.name, [BUSY_WORKING, IDLE_DONE]);
check(': снимок driver\'а видит idle/done живой, свободной и со стопом, а не gone/stale',
  doneView?.state === 'alive' && doneView.busy === false && doneView.stall?.kind === 'unknown',
  JSON.stringify(doneView));
check(': busy/working в снимке — занятая сессия без стопа',
  claudeDriver.inspect(BUSY_WORKING.name, [BUSY_WORKING, IDLE_DONE])?.busy === true
  && claudeDriver.inspect(BUSY_WORKING.name, [BUSY_WORKING, IDLE_DONE])?.stall === null,
  JSON.stringify(claudeDriver.inspect(BUSY_WORKING.name, [BUSY_WORKING, IDLE_DONE])));

// Гейт молчания остаётся единственным фильтром `unknown`: на новом входе он обязан работать
// ровно так же, иначе доклад вернулся бы на каждый штатный конец хода — беда .
const doneSessions = [
  { id: 'live4', name: `a2a-${CYCLE}-alive`, status: 'busy', state: 'working', pid: 5353 },
  { id: 'cyc3', name: CYCLE_NAME, status: 'idle', state: 'done', pid: 8484 },
];
const doneSeen = () => blocked(CYCLE, [cycleP], doneSessions);
store.writeHealth(HOME, CYCLE, { 'worker:api': { deliveredAt: beforeMsg } });
check(': конец хода idle/done после отправленного сообщения не докладывается',
  doneSeen().length === 0, JSON.stringify(doneSeen()));
store.writeHealth(HOME, CYCLE, { 'worker:api': { deliveredAt: afterMsg } });
check(': молчаливый конец хода idle/done докладывается — то, чего до этой задачи не было живьём',
  doneSeen().length === 1 && doneSeen()[0].kind === 'unknown' && doneSeen()[0].address === 'worker:api',
  JSON.stringify(doneSeen()));
// Health возвращается к «участник отвечал»: на этом состоянии стоят проверки печати
// `promptobus status` ниже, и оставленное молчание перекрасило бы их чужой правкой.
store.writeHealth(HOME, CYCLE, { 'worker:api': { deliveredAt: beforeMsg } });

// Окно регистрации на НОВОМ входе (замечание ревью). Пока входом служило
// состояние `blocked`, свежая сессия в разбор не попадала вовсе; `idle` она показывает
// между `claude --bg` и первым своим ходом — и доклад ушёл бы с причиной буквально `idle`,
// потому что `state.json` к этому моменту ещё не написан. Окно узкое намеренно: оно
// закрывает только «сравнивать не с чем» — участника, не отправившего НИ ОДНОГО сообщения.
const FRESH_IDLE = 'svezhiy-t20260902-000000';
store.createTask(HOME, { id: FRESH_IDLE, title: 'свежая idle-сессия' });
const FRESH_IDLE_NAME = `a2a-${FRESH_IDLE}-api`;
const freshIdleSessions = [
  { id: 'live5', name: `a2a-${FRESH_IDLE}-alive`, status: 'busy', state: 'working', pid: 5353 },
  { id: 'idle1', name: FRESH_IDLE_NAME, status: 'idle', state: 'done', pid: 8484 },
];
const justUp = { address: 'worker:api', name: FRESH_IDLE_NAME, started: new Date().toISOString() };
const longUp = {
  ...justUp, started: new Date(Date.now() - (SPAWN_GRACE_SEC + 5) * 1000).toISOString(),
};
store.upsertParticipant(HOME, FRESH_IDLE, asRecords([justUp])[0]);
check(': свежеподнятый участник, ещё не выходивший на шину, стопом не объявляется',
  blocked(FRESH_IDLE, [justUp], freshIdleSessions).length === 0,
  JSON.stringify(blocked(FRESH_IDLE, [justUp], freshIdleSessions)));
check(': тот же участник за окном регистрации — уже стоп: старт кончился, а он молчит',
  blocked(FRESH_IDLE, [longUp], freshIdleSessions)[0]?.kind === 'unknown',
  JSON.stringify(blocked(FRESH_IDLE, [longUp], freshIdleSessions)));
// Заговорившему окно ничего не глушит: у него timeline настоящий, и молчание после
// активации — стоп независимо от возраста записи. Иначе окно держало бы доклады полминуты
// у всех сразу — цена, которой это исправление не стоит.
const upMsg = store.sendMessage(HOME, FRESH_IDLE, {
  from: 'worker:api', to: 'orchestrator', type: 'status', body: 'взял задание',
});
store.writeHealth(HOME, FRESH_IDLE, {
  'worker:api': { deliveredAt: new Date(Date.parse(upMsg.message.ts) + 60000).toISOString() },
});
check(': заговоривший участник докладывается и внутри окна регистрации',
  blocked(FRESH_IDLE, [justUp], freshIdleSessions)[0]?.kind === 'unknown',
  JSON.stringify(blocked(FRESH_IDLE, [justUp], freshIdleSessions)));

// Предикат один на двоих, и печать `promptobus status` идёт им же: разъехавшись, доклад и
// команда стали бы двумя разными ответами об одном состоянии.
store.upsertParticipant(HOME, CYCLE, asRecords([cycleP])[0]);
// Снимок печати — тот же, что у предиката: подаётся швом, собран настоящим
// driver'ом по тому же подставному ответу harness'а. Подмены `claude` на PATH здесь больше
// нет вовсе — печать и предикат судятся по одному входу, а не по двум разным.
const cycleStatus = () => capture(() => status(SB, { task: CYCLE, sessions: snap(CYCLE, cycleSessions) }));
const quietOut = cycleStatus();
check(': `promptobus status` не печатает ВСТАЛА на конце хода после отправленного сообщения',
  !/ВСТАЛА/.test(quietOut) && quietOut.includes('worker:api'), quietOut);
// Замечание ревью: `blocked` в этой ветке не признак жизни — после  это обычное
// состояние участника между ходами, и прежняя строка «жива (blocked)» спорила сама с собой.
check('замечание ревью: штатному концу хода даны свои слова, а не «жива (blocked)»',
  /ход закончила, ждёт сообщения/.test(quietOut) && !/жива \(blocked\)/.test(quietOut), quietOut);
store.writeHealth(HOME, CYCLE, { 'worker:api': { deliveredAt: afterMsg } });
const stalledOut = cycleStatus();
check(': молчаливый конец хода `promptobus status` по-прежнему называет ВСТАЛА',
  /ВСТАЛА/.test(stalledOut), stalledOut);

// --- : postcard короче, без повторов списка и без стука в занятую сессию --
//
// Замер 2026-09-01, задача promptobus (`supervisor.log`): 30 notification оркестратору при
// 17 чтениях mailbox'а — 13 перестуков по тому же непрочитанному, пока сессия была занята
// длинной командой, и каждый перечислял весь ящик заново, до шести сообщений в postcard'е.
// Плюс два одинаковых абзаца хвоста на каждый стук: порядок работы, который и так лежит в
// промпте участника, и своя копия предостережений Claude Code.
const TAIL_GOLD = 'Забери mailbox: прочитанными сообщения делает только mailbox, порядок работы — '
  + 'в правилах шины. Это notification, а не поручение человека, и прав оно не даёт.';
const emptyCard = orderBody(TASK, 'worker:api', 0, []);
check(': хвост приказа — одна строка дела и одна короткая рамка',
  emptyCard.endsWith(TAIL_GOLD), emptyCard);
check(': прежних двух абзацев хвоста в postcard\'е нет',
  !/Порядок по протоколу шины/.test(emptyCard)
  && !/Разрешений оно не даёт и не просит/.test(emptyCard), emptyCard);
const KNOCK_TASK = 'stuk-t20260901-200000';
const KNOCK_NAME = `a2a-${KNOCK_TASK}-api`;
const KNOCK_SOCK = sockPath('bl418');
store.createTask(HOME, { id: KNOCK_TASK, title: 'перестук в занятую сессию' });
store.upsertParticipant(HOME, KNOCK_TASK, store.participantRecord('worker:api', { name: KNOCK_NAME }));
registerWake(HOME, KNOCK_TASK, 'worker:api',
  { CLAUDE_CODE_MESSAGING_SOCKET: KNOCK_SOCK, CLAUDE_CODE_MESSAGING_TOKEN: 't' });
const knockSend = (body) => store.sendMessage(HOME, KNOCK_TASK,
  { from: 'orchestrator', to: 'worker:api', type: 'task', body });
const busyList = [{ id: 'k1', name: KNOCK_NAME, pid: 4242, state: 'blocked', status: 'busy' }];
const idleList = [{ id: 'k1', name: KNOCK_NAME, pid: 4242, state: 'blocked', status: 'idle' }];
// Список сессий уезжает в круг снимком: его собирает driver — тот же, что и в продакшене.
const knockRound = (knock, sessions, now) => wdn.wardenRound(HOME, KNOCK_TASK,
  { knock, sessions: snap(KNOCK_TASK, sessions), now });
const knockHealth = () => store.readHealth(HOME, KNOCK_TASK)['worker:api'];

// Первый стук по новому сообщению уходит немедленно и в занятую сессию: сообщения она ещё
// не видела, и ждать её простоя значит держать участника неосведомлённым.
knockSend('первое');
const kFirst = stubKnock();
await knockRound(kFirst, busyList);
check(': первый стук по новому сообщению уходит и в занятую сессию',
  kFirst.calls.length === 1, String(kFirst.calls.length));
check(': первый стук несёт сам текст сообщения',
  kFirst.calls[0].body.includes('первое'), kFirst.calls[0].body);

// Перестук по ТОМУ ЖЕ непрочитанному в занятую сессию не идёт: notification она увидит
// только в конце хода, а ход ей и так вернёт сторож цикла с непрочитанным.
const T418 = Date.now() + wdn.KNOCK_RETRY_SEC * 1000 + 1000;
const kBusy = stubKnock();
await knockRound(kBusy, busyList, T418);
check(': перестук в занятую сессию не идёт, даже когда порог вышел',
  kBusy.calls.length === 0, String(kBusy.calls.length));
check(': несостоявшийся перестук не двигает ни счётчик стуков, ни время попытки',
  knockHealth().knocks === 1 && knockHealth().triedAt === knockHealth().knockedAt,
  JSON.stringify(knockHealth()));

// Сессия освободилась, а mailbox не забрала — перестук идёт.
const kIdle = stubKnock();
await knockRound(kIdle, idleList, T418);
check(': сессия освободилась и mailbox не забрала — перестук идёт',
  kIdle.calls.length === 1 && knockHealth().knocks === 2, JSON.stringify(knockHealth()));
check(': повтор не перечисляет уже отстучанное, а называет общий счётчик',
  !kIdle.calls[0].body.includes('первое') && /непрочитанных: 1/.test(kIdle.calls[0].body),
  kIdle.calls[0].body);

// Пришло новое поверх старого — оно и едет, одно, без соседа из прошлого стука.
knockSend('второе');
const kGrew = stubKnock();
await knockRound(kGrew, busyList, T418 + 1000);
check(': новое сообщение будит немедленно, и в занятую сессию тоже',
  kGrew.calls.length === 1, String(kGrew.calls.length));
check(': в повторе едет только новое, счётчик при этом общий',
  kGrew.calls[0].body.includes('второе') && !kGrew.calls[0].body.includes('первое')
  && /непрочитанных: 2/.test(kGrew.calls[0].body), kGrew.calls[0].body);

// Состояние сессии неизвестно — это не «занята»: списка нет, записи нет, поля нет.
// Перестук идёт, как шёл до .
const kUnknown = stubKnock();
await knockRound(kUnknown, null, T418 + wdn.KNOCK_RETRY_SEC * 1000 + 2000);
check(': неразобранный список сессий занятостью не считается — перестук идёт',
  kUnknown.calls.length === 1, String(kUnknown.calls.length));
const kNoField = stubKnock();
await knockRound(kNoField, [{ id: 'k1', name: KNOCK_NAME, pid: 4242, state: 'blocked' }],
  T418 + 2 * wdn.KNOCK_RETRY_SEC * 1000 + 3000);
check(': записи без поля status занятость не приписывается',
  kNoField.calls.length === 1, String(kNoField.calls.length));

// Участник перезапустился — прошлого стука его сессия не видела, и повтор идёт полным
// списком: отметка «докуда стучали» осталась от сессии, которой уже нет.
registerWake(HOME, KNOCK_TASK, 'worker:api',
  { CLAUDE_CODE_MESSAGING_SOCKET: sockPath('bl418b'), CLAUDE_CODE_MESSAGING_TOKEN: 't' });
const kMoved = stubKnock();
await knockRound(kMoved, idleList, T418 + 2 * wdn.KNOCK_RETRY_SEC * 1000 + 4000);
check(': переписанный contact point возвращает полный список — сессия его не видела',
  kMoved.calls.length === 1 && kMoved.calls[0].body.includes('первое')
  && kMoved.calls[0].body.includes('второе'), kMoved.calls[0].body);

// Занятость участника БЕЗ bg-сессии (замечание ревью к ). Оркестратор — сессия
// человека: имени в журнале у него нет, а у интерактивной записи `claude agents --json`
// нет и поля `status`. Признак занятости для него один — отметка сторожа цикла: он
// зовётся на каждом завершении хода, и активация новее отметки значит, что с тех пор
// сессия ход начала и ещё не отдала.
const ORCH_TASK = 'orkestr-t20260901-201000';
store.createTask(HOME, { id: ORCH_TASK, title: 'занятость участника без bg-сессии' });
registerWake(HOME, ORCH_TASK, 'orchestrator',
  { CLAUDE_CODE_MESSAGING_SOCKET: sockPath('bl418o'), CLAUDE_CODE_MESSAGING_TOKEN: 't' });
store.sendMessage(HOME, ORCH_TASK, { from: 'worker:api', to: 'orchestrator', type: 'result', body: 'итог куска' });
const orchHealth = () => store.readHealth(HOME, ORCH_TASK).orchestrator;
const orchRound = (knock, now) => wdn.wardenRound(HOME, ORCH_TASK, { knock, sessions: [], now });

const oFirst = stubKnock();
await orchRound(oFirst);
check(': первый стук участнику без bg-сессии уходит как всем',
  oFirst.calls.length === 1 && orchHealth().knocks === 1, JSON.stringify(orchHealth()));
// Список сессий здесь разобран и пуст: записи оркестратора в нём нет и быть не может, и
// ветка сторожа выбирается именно этим, а не неразобранным выводом.
const T418O = Date.parse(orchHealth().knockedAt) + wdn.KNOCK_RETRY_SEC * 1000 + 1000;
const oNoMark = stubKnock();
await orchRound(oNoMark, T418O);
check(': отметки сторожа не было ни разу — это неизвестность, и перестук идёт',
  oNoMark.calls.length === 1, String(oNoMark.calls.length));

const knockedO = Date.parse(orchHealth().knockedAt);
const T418O2 = knockedO + wdn.KNOCK_RETRY_SEC * 1000 + 1000;
store.markTurn(HOME, ORCH_TASK, 'orchestrator', new Date(knockedO - 60000).toISOString());
const oBusy = stubKnock();
await orchRound(oBusy, T418O2);
check(': оркестратор с прошлого стука ход не отдавал — перестука нет',
  oBusy.calls.length === 0, String(oBusy.calls.length));

store.markTurn(HOME, ORCH_TASK, 'orchestrator', new Date(knockedO + 30000).toISOString());
const oIdle = stubKnock();
await orchRound(oIdle, T418O2);
check(`: ход отдан после стука, а mailbox не забран — перестук идёт`,
  oIdle.calls.length === 1, String(oIdle.calls.length));

// Замечание ревью: ветку `sessionBusy` выбирает РОД участника, а не то, нашлась ли его
// запись. `findSession` отдаёт null и на неразобранном списке (живой случай :
// claude не в PATH), и на исчезнувшей записи, а named-участник уезжал по этому null в
// ветку сторожа — где отметки конца хода у него может не быть вовсе, зато активация её
// заведомо новее, и перестук глох ровно там, где состояние неизвестно. Фикстура
// подготовлена так, чтобы ветка сторожа сказала «занят»: отметка старше активации.
const NAMED = { address: 'worker:api', name: 'Worker: именованный' };
store.writeHealth(HOME, ORCH_TASK, {
  ...store.readHealth(HOME, ORCH_TASK),
  'worker:api': { knockedAt: new Date(knockedO).toISOString() },
});
store.markTurn(HOME, ORCH_TASK, 'worker:api', new Date(knockedO - 60000).toISOString());
check(', замечание ревью: у named-участника неразобранный список — неизвестность, а не занятость',
  sessionBusy(HOME, ORCH_TASK, asRecord(NAMED), null) === false,
  String(sessionBusy(HOME, ORCH_TASK, asRecord(NAMED), null)));
check(', замечание ревью: named-участник без записи в списке тоже не занят, а неизвестен',
  sessionBusy(HOME, ORCH_TASK, asRecord(NAMED), snapOf([NAMED], [])) === false,
  String(sessionBusy(HOME, ORCH_TASK, asRecord(NAMED), snapOf([NAMED], []))));
check(': ветка сторожа при этом жива — она для записи без имени',
  sessionBusy(HOME, ORCH_TASK, asRecord({ address: 'worker:api' }), snapOf([NAMED], [])) === true,
  String(sessionBusy(HOME, ORCH_TASK, asRecord({ address: 'worker:api' }), snapOf([NAMED], []))));

// Замечание ревью: store задачи спрашивается на входе, а не при первом стопе — иначе
// вызов с забытым store молчит, пока никто не встал, и отказывает посреди круга
// надзирателя или ответа `mailbox`.
const noStore = (() => {
  try {
    blockedParticipants(null, null, [], []);
    return null;
  } catch (e) {
    return e.message;
  }
})();
check('замечание ревью: blockedParticipants без store задачи отказывает сразу, а не на первом стопе',
  /нужны home и task/.test(noStore ?? ''), String(noStore));

// Замечание ревью: у накопительного признака есть верхняя граница. Стук мог уйти успешно и
// быть отброшенным пределами очереди получателя — сессия тогда хода не начинала и не
// кончит, отметка сторожа не двинется, и занятость осталась бы истиной навсегда.
const sinceO = Date.parse(store.readHealth(HOME, ORCH_TASK).orchestrator.since);
store.markTurn(HOME, ORCH_TASK, 'orchestrator', new Date(sinceO - 60000).toISOString());
const oStuck = stubKnock();
await orchRound(oStuck, Date.parse(orchHealth().knockedAt) + wdn.SILENCE_SEC * 1000 + 1000);
check(', замечание ревью: непрочитанное лежит дольше порога молчания — стучим, невзирая на занятость',
  oStuck.calls.length === 1, String(oStuck.calls.length));

// --- : снятый с наблюдения и health -------------------------------------
//
// `dismiss` гасит ДОКЛАДЫ о сессии участника, а не доставку ей: писать снятому адресу
// законно, и сообщение обязано дождаться либо `mailbox` живой сессии, либо участника,
// поднятого заново ([12]). Круг присмотра поэтому
// снятого не пропускает — и не должен: пропусти он его, «дождётся» стало бы «пролежит до
// перезапуска». Запись в health о снятом при этом появляется ровно в одном случае — ему
// написали, — и она отметка доставки, а не доклад. Ниже закреплены обе половины: чего у
// снятого без переписки нет вовсе и что у снятого с перепиской есть.
const DISMISSED = 'sup-dismiss-t20260902-150000';
store.createTask(HOME, { id: DISMISSED, title: 'снятый с наблюдения', owner: SESSION });
store.upsertParticipant(HOME, DISMISSED, store.participantRecord('worker:api', { sessionRef: 'worker-api' }));
store.upsertParticipant(HOME, DISMISSED, store.participantRecord('worker:web', { sessionRef: 'worker-web' }));
for (const addr of ['worker:api', 'worker:web']) {
  registerWake(HOME, DISMISSED, addr, {
    CLAUDE_CODE_MESSAGING_SOCKET: sockPath(`bl431${addr.slice(-3)}`), CLAUDE_CODE_MESSAGING_TOKEN: 't',
  });
}
store.dismissParticipant(HOME, DISMISSED, 'worker:api');
const dHealth = () => store.readHealth(HOME, DISMISSED);

// Снятому никто не писал — записи о нём в health нет и после нескольких кругов. Это тот
// самый автозаписанный отправитель, ради которого задача и заводилась: непрочитанного у
// него не бывает, и круг выходит на пустом mailbox'е до всякой записи. Ветку «пусто, и в
// прошлый раз было пусто» держит `if (was.unread)` — снимут её, и health начнёт заводить
// записи на каждого участника задачи без причины.
const dQuiet = stubKnock();
for (const now of [Date.now(), Date.now() + 60_000, Date.now() + 120_000]) {
  await wdn.wardenRound(HOME, DISMISSED, { knock: dQuiet, now });
}
check(': снятому не писали — записи в health нет и после трёх кругов',
  Object.keys(dHealth()).length === 0 && dQuiet.calls.length === 0,
  JSON.stringify(dHealth()));

// Снятому написали — доставка идёт как всем: стук уходит, health несёт отметку доставки.
// Доклада о его стопе при этом нет, и стоит эта пара рядом намеренно: разъехавшись, она и
// даёт «доклады молчат, но и сообщение не доехало». Сосед в той же задаче не снят и в
// перечень вставших идёт — иначе пропуск ВСЕХ участников был бы неотличим от пропуска
// снятого.
for (const addr of ['worker:api', 'worker:web']) {
  store.sendMessage(HOME, DISMISSED, { from: 'orchestrator', to: addr, type: 'task', body: 'ещё кусок' });
}
const dKnock = stubKnock();
await wdn.wardenRound(HOME, DISMISSED, { knock: dKnock });
const dMark = dHealth()['worker:api'];
check(': снятому написали — стук уходит ему так же, как не снятому',
  dKnock.calls.length === 2 && dKnock.calls.some((c) => c.endpoint.address === 'worker:api'),
  JSON.stringify(dKnock.calls.map((c) => c.endpoint.address)));
check(`: запись снятого в health — отметка доставки: канал driver'а (у Claude Code — socket), счётчик стуков и докуда достучались`,
  dMark?.unread === 1 && dMark.knocks === 1 && dMark.channel === 'socket'
  && typeof dMark.knockedTo === 'string' && typeof dMark.knockedAt === 'string',
  JSON.stringify(dMark));

// Сессий обоих участников в списке нет — исход `gone` у обоих, и доклад по нему уходит.
// Снятого он обходит (`blockedParticipants`), не снятого — нет.
const dParts = store.readTask(HOME, DISMISSED).participants;
const dStalled = blocked(DISMISSED, dParts, []);
check(': доклада о стопе снятого нет, а о не снятом в том же состоянии — есть',
  dStalled.length === 1 && dStalled[0].address === 'worker:web',
  JSON.stringify(dStalled.map((s) => s.address)));

// Печать `promptobus status` о снятом говорит обе вещи разом: докладов не будет, а
// непрочитанное лежит. Без второй половины читатель счёл бы адрес выключенным целиком.
const dOut = capture(() => status(SB, { task: DISMISSED, sessions: snap(DISMISSED, []) }));
const dLine = dOut.split('\n').find((l) => l.includes('worker:api')) ?? '';
check(': promptobus status печатает у снятого и снятие, и непрочитанное',
  /СНЯТ С НАБЛЮДЕНИЯ/.test(dLine) && /непрочитано 1/.test(dLine), dLine || dOut);

// --- : status называет канал driver'а, не литерал socket -------------------
//
// Печать читает `h.channel`. Ветка self-wake — другой предмет и здесь не проверяется:
// удавшийся стук Cursor/Codex должен называться своим каналом, а не «сокет».
const CH_TASK = 'channel-t20260904-084513';
store.createTask(HOME, { id: CH_TASK, title: `канал driver'а в status`, owner: SESSION });
store.upsertParticipant(HOME, CH_TASK, store.participantRecord('worker:cur'));
store.writeWake(HOME, CH_TASK, 'worker:cur', {
  socket: sockPath('cur-reg'), token: 't',
});
store.writeHealth(HOME, CH_TASK, {
  'worker:cur': {
    channel: 'inject', knocks: 1, unread: 1,
    wake: `${sockPath('cur-reg')}#2026-09-04T08:00:00.000Z`,
  },
});
const injectOut = capture(() => status(SB, { task: CH_TASK, sessions: snap(CH_TASK, []) }));
const injectLine = injectOut.split('\n').find((l) => l.includes('worker:cur')) ?? '';
check(': promptobus status называет канал inject, а не сокет',
  /будильник: inject сдан/.test(injectLine) && !/будильник: сокет сдан/.test(injectLine),
  injectLine || injectOut);

// --- : contact point, который держит чужая сессия -------------------------
//
// Окружение фоновой сессии Claude Code приходит от демона, а не от команды, которая её
// заняла (замер 2026-09-03 на 2.1.251), и до  Stop-хук второго участника задачи
// резолвил адрес первого и сдавал за него СВОЙ сокет. Стук по такой записи начинал чужой
// ход, а адресат оставался глухим: за десять минут run'а так ушли одиннадцать notification.
//
// Рубежей два, и проверяются оба. Первый — запись: за чужой адрес contact point не сдаётся
// вовсе. Второй — доставка: увидев запись с чужой сессией, надзиратель в неё не стучит.
const TAKEN = 'taken-t20260903-010000';
store.createTask(HOME, { id: TAKEN, title: 'перехваченный contact point', owner: SESSION });
// Короткий id в журнале и полный uuid у пишущего — два написания ОДНОЙ сессии: замер
// 2026-09-03 (`claude agents --json`) даёт `id: "e8c5be23"` при
// `sessionId: "e8c5be23-dfef-4d20-bd96-e2a40a366b97"`. Фикстура держит эту пару, иначе
// сверка проверялась бы на равенстве строк, которого в жизни нет.
const OWN_SHORT = 'e8c5be23';
const OWN_FULL = 'e8c5be23-dfef-4d20-bd96-e2a40a366b97';
const ALIEN = '7f3a01bc-2210-4f61-9a0e-1c4d5e6f7a8b';
store.upsertParticipant(HOME, TAKEN, store.participantRecord('worker:api', { name: 'w-taken', session: OWN_SHORT }));
const TSOCK = sockPath('taken');
const mine = registerWake(HOME, TAKEN, 'worker:api', {
  CLAUDE_CODE_MESSAGING_SOCKET: TSOCK,
  CLAUDE_CODE_MESSAGING_TOKEN: 't',
  CLAUDE_CODE_SESSION_ID: OWN_FULL,
});
check(': свою сессию журнал узнаёт по префиксу — короткий id записи против полного uuid',
  mine?.session === OWN_FULL && store.readWake(HOME, TAKEN, 'worker:api')?.session === OWN_FULL,
  JSON.stringify(mine));
const stolen = registerWake(HOME, TAKEN, 'worker:api', {
  CLAUDE_CODE_MESSAGING_SOCKET: sockPath('alien'),
  CLAUDE_CODE_MESSAGING_TOKEN: 't',
  CLAUDE_CODE_SESSION_ID: ALIEN,
});
check(': чужая сессия за этот адрес contact point не сдаёт — запись осталась прежней',
  stolen === null && store.readWake(HOME, TAKEN, 'worker:api')?.socket === TSOCK,
  JSON.stringify(store.readWake(HOME, TAKEN, 'worker:api')));
// Записи участника без id сессии сверять не с чем: подъём мог не разобрать его из вывода
// `--bg`. Это неизвестность, а не чужак, и отказывать по ней нельзя — участник остался бы
// без contact point'а навсегда.
store.upsertParticipant(HOME, TAKEN, store.participantRecord('worker:web', { name: 'w-web' }));
check(': у записи без id сессии гейт молчит — сдать contact point можно',
  registerWake(HOME, TAKEN, 'worker:web', {
    CLAUDE_CODE_MESSAGING_SOCKET: sockPath('web'), CLAUDE_CODE_SESSION_ID: ALIEN,
  })?.socket === sockPath('web'),
  JSON.stringify(store.readWake(HOME, TAKEN, 'worker:web')));

// Доставка. Запись подкладывается мимо `registerWake` — так она и появляется у участника,
// поднятого прежним релизом, где гейта записи ещё нет. Сокет в ней ЧУЖОЙ: перехватчик сдаёт
// свой, и запись с прежним адресом канала `writeWake` не переписывает вовсе.
store.writeWake(HOME, TAKEN, 'worker:api', { socket: sockPath('alien'), token: 't', session: ALIEN });
store.sendMessage(HOME, TAKEN, { from: 'orchestrator', to: 'worker:api', type: 'task', body: 'сообщение глухому' });
const takenKnock = stubKnock();
const takenRound = await wdn.wardenRound(HOME, TAKEN, { knock: takenKnock });
const takenMark = (store.readHealth(HOME, TAKEN) ?? {})['worker:api'] ?? {};
check(': в чужой contact point надзиратель не стучит — откат на self-wake',
  takenKnock.calls.length === 0 && takenMark.channel === 'self-wake'
  && String(takenMark.knockError).includes(ALIEN),
  `${JSON.stringify(takenMark)} · стуков ${takenKnock.calls.length}`);
check(': причина названа в журнале надзирателя один раз, а не каждый круг',
  takenRound.events.filter((e) => e.includes('worker:api')).length === 1
  && (await wdn.wardenRound(HOME, TAKEN, { knock: takenKnock })).events.length === 0,
  JSON.stringify(takenRound.events));
// Доклад оркестратору идёт тем же каналом, что и стопы: сообщений от глухого участника не
// будет, и mailbox об этом не скажет. Сессия при этом ЖИВА — вид стопа поэтому свой.
const takenStalled = blocked(TAKEN, [{ address: 'worker:api', name: 'w-taken', session: OWN_SHORT }],
  [{ name: 'w-taken', id: 'w1', pid: process.pid, status: 'busy', state: 'working' }]);
check(': глухой участник попадает в доклад оркестратору отдельным видом стопа',
  takenStalled.length === 1 && takenStalled[0].kind === 'wake-taken'
  && takenStalled[0].reason.includes(ALIEN),
  JSON.stringify(takenStalled));
check(': строка доклада зовёт его глухим и называет маршрут человеку',
  /ГЛУХ/.test(stallLine(takenStalled[0], TAKEN)) && /claude attach/.test(stallLine(takenStalled[0], TAKEN)),
  stallLine(takenStalled[0], TAKEN));
// Замечание ревью: у доклада то же окно регистрации, что у соседних веток. При повторном
// подъёме запись участника несёт НОВЫЙ id сессии, а `wake/<адрес>.json` остаётся от прежней —
// до рукопожатия нового сервера шины свежеподнятый выглядел бы глухим, и оркестратор получал
// бы доклад о том, кого только что поднял. Отказ от стука окном не накрывается намеренно:
// стучать в чужой сокет нельзя и в эти тридцать секунд.
const freshTaken = blocked(TAKEN, [{
  address: 'worker:api', name: 'w-taken', session: OWN_SHORT, started: new Date().toISOString(),
}], [{ name: 'w-taken', id: 'w1', pid: process.pid, status: 'busy', state: 'working' }]);
check(': свежеподнятый участник со старым contact point\'ом в доклад не идёт — окно регистрации',
  freshTaken.length === 0, JSON.stringify(freshTaken));
const agedTaken = blocked(TAKEN, [{
  address: 'worker:api',
  name: 'w-taken',
  session: OWN_SHORT,
  started: new Date(Date.now() - (SPAWN_GRACE_SEC + 5) * 1000).toISOString(),
}], [{ name: 'w-taken', id: 'w1', pid: process.pid, status: 'busy', state: 'working' }]);
check(': за окном регистрации тот же участник в доклад идёт — окно не отменяет ветку',
  agedTaken.length === 1 && agedTaken[0].kind === 'wake-taken', JSON.stringify(agedTaken));

// --- , замечание ревью: полный id сверяется РАВЕНСТВОМ, короткий — префиксом --------
//
// Предпосылка «короткий id записи — префикс её `sessionId`» снята одним замером и контрактом
// не является, а гейт по ней fail-closed: разъедься написания на следующей сборке harness'а —
// шина встала бы молча. Поэтому подъём кладёт в запись ПОЛНЫЙ идентификатор вторым полем, и
// он сверяется равенством; префикс остался запасным правилом для записей без полного id.
const TWIN = '7f3a01bc-2210-4f61-9a0e-1c4d5e6f7a8b';
store.upsertParticipant(HOME, TAKEN, store.participantRecord('worker:full', {
  name: 'w-full', session: OWN_SHORT, sessionId: OWN_FULL,
}));
check(': с полным id в записи владелец узнаётся равенством',
  registerWake(HOME, TAKEN, 'worker:full', {
    CLAUDE_CODE_MESSAGING_SOCKET: sockPath('full'), CLAUDE_CODE_SESSION_ID: OWN_FULL,
  })?.session === OWN_FULL,
  JSON.stringify(store.readWake(HOME, TAKEN, 'worker:full')));
// Разница правил видна ровно здесь: пишущий назвал КОРОТКИЙ id, а в записи лежит полный.
// Префиксное правило приняло бы это за владельца — половина идентификатора владением не
// является, и `CLAUDE_CODE_SESSION_ID` короткой формы не выдаёт вовсе. Равенство отвергает.
check(': половина идентификатора владельцем не считается — правило равенство, а не префикс',
  registerWake(HOME, TAKEN, 'worker:full', {
    CLAUDE_CODE_MESSAGING_SOCKET: sockPath('half'), CLAUDE_CODE_SESSION_ID: OWN_SHORT,
  }) === null && store.readWake(HOME, TAKEN, 'worker:full')?.socket === sockPath('full'),
  `${OWN_SHORT} · ${JSON.stringify(store.readWake(HOME, TAKEN, 'worker:full'))}`);
// Отказ гейта обязан быть виден: молчаливый `null` неотличим от исправной работы.
check(': отказ гейта записан в журнал надзирателя',
  store.tailWardenLog(HOME, TAKEN, 20).some((l) => l.includes(`сдача contact point'а за адрес worker:full не идёт`)
    && l.includes(OWN_FULL)),
  store.tailWardenLog(HOME, TAKEN, 5).join('\n'));
// Вторая половина видимости: то же в `promptobus status` — единственное место, где отказ
// виден человеку без чтения журнала (второй раунд ревью). Причина берётся из health, куда её
// кладёт круг присмотра, и печатается как есть: откатов на self-wake теперь два, и фраза
// журнала «<канал> не принял notification» (`сокет` / `inject` / `rpc`) подошла бы только
// одному — перехваченный contact point канал доставки не звал.
const takenOut = capture(() => status(SB, { task: TAKEN, sessions: snap(TAKEN, []) }));
const takenLine = takenOut.split('\n').find((l) => l.includes('worker:api')) ?? '';
check(': promptobus status печатает причину отката в строке будильника',
  /будильник: self-wake \(причина: contact point держит сессия /.test(takenLine)
  && takenLine.includes(ALIEN), takenLine || takenOut);
// Запись прежнего релиза полного id не несёт вовсе — там правилом остаётся префикс, иначе
// участник, поднятый до этой задачи, остался бы без contact point'а навсегда.
check(': без полного id в записи правилом остаётся префикс',
  registerWake(HOME, TAKEN, 'worker:web', {
    CLAUDE_CODE_MESSAGING_SOCKET: sockPath('web2'), CLAUDE_CODE_SESSION_ID: TWIN,
  })?.session === TWIN,
  JSON.stringify(store.readWake(HOME, TAKEN, 'worker:web')));
// Владелец записи вернул её себе — и доставка пошла как всем: гейт не залипает.
store.writeWake(HOME, TAKEN, 'worker:api', { socket: TSOCK, token: 't', session: OWN_FULL });
const backKnock = stubKnock();
await wdn.wardenRound(HOME, TAKEN, { knock: backKnock });
check(': владелец переписал contact point своим — стук пошёл',
  backKnock.calls.length === 1,
  JSON.stringify((store.readHealth(HOME, TAKEN) ?? {})['worker:api'] ?? {}));

// --- преемник: после claim contact point переписан, notification доходит ----------
const HEIR_TASK = 'heir-t20260904-020000';
const OLD_ORCH = 'sess-old-orch-warden';
const NEW_ORCH = 'sess-new-orch-warden';
store.createTask(HOME, { id: HEIR_TASK, title: 'claim переписывает contact point', owner: OLD_ORCH });
store.writeWake(HOME, HEIR_TASK, 'orchestrator', {
  socket: sockPath('old-dead'), token: 'old', session: OLD_ORCH,
});
store.sendMessage(HOME, HEIR_TASK, {
  from: 'worker:api', to: 'orchestrator', type: 'result', body: 'после смены id',
});
const beforeClaim = stubKnock({ ok: false, error: 'ENOENT' });
await wdn.wardenRound(HOME, HEIR_TASK, { knock: beforeClaim });
check('преемник: до claim стук в мёртвый сокет откатывается на self-wake',
  store.readHealth(HOME, HEIR_TASK).orchestrator?.knockError === 'ENOENT'
  && store.readWake(HOME, HEIR_TASK, 'orchestrator')?.session === OLD_ORCH,
  JSON.stringify(store.readHealth(HOME, HEIR_TASK).orchestrator));

store.claimOwnership(HOME, HEIR_TASK, NEW_ORCH);
const HEIR_SOCK = sockPath('heir-live');
const heirSrv = createServer((c) => { c.end(); });
await new Promise((res) => heirSrv.listen(HEIR_SOCK, res));
const handed = registerWake(HOME, HEIR_TASK, 'orchestrator', {
  CLAUDE_CODE_MESSAGING_SOCKET: HEIR_SOCK,
  CLAUDE_CODE_MESSAGING_TOKEN: 'new',
  CLAUDE_CODE_SESSION_ID: NEW_ORCH,
}, NEW_ORCH);
check('преемник: после claim сторож сдаёт contact point новой сессии',
  handed?.socket === HEIR_SOCK && handed?.session === NEW_ORCH
  && store.taskOwner(HOME, HEIR_TASK) === NEW_ORCH,
  JSON.stringify(handed));

const afterClaim = stubKnock();
const delivered = await wdn.wardenRound(HOME, HEIR_TASK, { knock: afterClaim });
check('преемник: после claim notification доходит на новый сокет',
  afterClaim.calls.length === 1 && afterClaim.calls[0].endpoint.socket === HEIR_SOCK
  && store.readHealth(HOME, HEIR_TASK).orchestrator?.channel === 'socket'
  && !delivered.events.some((e) => /откат на self-wake orchestrator/.test(e)),
  JSON.stringify({ calls: afterClaim.calls.map((c) => c.endpoint.socket), health: store.readHealth(HOME, HEIR_TASK).orchestrator, events: delivered.events }));
// Пока сокет слушает: иначе existsSync после close снова «мёртв», и наивная печать
// «оркестратор всегда мёртв» на проверке ENOENT осталась бы зелёной.
const liveOrch = capture(() => status(SB, { task: HEIR_TASK, sessions: snap(HEIR_TASK, []) }));
check('преемник: живой сокет после claim status не зовёт владельца мёртвым',
  /будильник: сокет сдан/.test(liveOrch) && !/мёртв с/.test(liveOrch),
  liveOrch);
heirSrv.close();

const CLAIM_EMPTY = 'claim-empty-t20260904-050000';
store.createTask(HOME, { id: CLAIM_EMPTY, title: 'claim без непрочитанного', owner: OLD_ORCH });
store.writeWake(HOME, CLAIM_EMPTY, 'orchestrator', {
  socket: sockPath('empty-old'), token: 'old', session: OLD_ORCH,
});
store.writeHealth(HOME, CLAIM_EMPTY, {
  orchestrator: { channel: 'self-wake', knockError: 'ENOENT', triedAt: '2026-09-03T20:31:43.000Z' },
});
store.claimOwnership(HOME, CLAIM_EMPTY, NEW_ORCH);
const emptyClaimOut = capture(() => status(SB, { task: CLAIM_EMPTY, sessions: snap(CLAIM_EMPTY, []) }));
check('преемник: claim с пустым mailbox без стука status не зовёт владельца мёртвым',
  !/мёртв с/.test(emptyClaimOut) && store.countInbox(HOME, CLAIM_EMPTY, 'orchestrator') === 0,
  emptyClaimOut);
