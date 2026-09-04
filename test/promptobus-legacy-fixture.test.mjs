// Legacy-fixture store шины: та ли она, за что себя выдаёт, и так ли её читает
// сегодняшний reader. Запуск: npm test
//
// Предмет — не поведение store: его держат promptobus.test.mjs и соседи. Здесь проверяется
// baseline миграции: fixture снята через store `v0.61.0`, и этот же срез читает миграция
// ([promptobus-migration.test.mjs](promptobus-migration.test.mjs)). Разъедься
// состав fixture с тем, что читает reader, — миграцию будут писать по несуществующему входу.
import { cpSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSandbox } from './sandbox.mjs';
import { captureSplit, quiet } from './console.mjs';
import { check } from './check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'promptobus', 'legacy-v061');
// Читает срез store `v0.61.0` — тот самый, что живёт в package namespace'ом `legacy`
//. Production store с cutover'а другой, и читать им legacy-раскладку незачем:
// смысл этого файла в том, что вход миграции по-прежнему читается своим reader'ом.
//
// Диагностика приходит reader'у АРГУМЕНТОМ: package в потоки процесса не пишет,
// и подставлять её через шов больше нечем — её называет вызывающий, как её называет
// миграция. Здесь вызывающий — набор, и он подаёт `console.warn`, чтобы `captureSplit`
// поймал ту же строку, какую человек увидел бы в stderr.
const { legacy: store } = await import(path.join(here, '..', 'dist', 'index.js'));
const warn = (m) => console.warn(m);
const { ORCHESTRATOR, MESSAGE_TYPES } = store;

const ACTIVE = 't20260831-090000';
const CLOSED = 't20260830-140000';
const SESSION = '00000000-0000-4000-8000-000000000001';

// Fixture лежит в дереве репозитория, а чтение mailbox'а его МЕНЯЕТ: прочитанное уезжает
// в `read/`, битое — в `broken/`. Читаем копию в песочнице; что оригинал остался цел,
// проверяется отдельно в хвосте файла.
const SB = makeSandbox('promptobus-promptobus-fixture-');
const home = path.join(SB, 'a2a');
cpSync(FIXTURE, home, { recursive: true });

const names = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')).sort() : []);
const msgsIn = (dir) => names(dir).map((n) => JSON.parse(readFileSync(path.join(dir, n), 'utf8')));

// --- задачи и участники -------------------------------------------------------

const tasks = quiet(() => store.listTasks(home, warn)).map((t) => t.id).sort();
check('fixture: две задачи — активная и закрытая',
  tasks.length === 2 && tasks.includes(ACTIVE) && tasks.includes(CLOSED), tasks.join(', '));

const active = store.readTask(home, ACTIVE);
const closed = store.readTask(home, CLOSED);
check('fixture: активная задача активна, закрытая закрыта и с датой',
  active.status === 'active' && closed.status === 'done' && typeof closed.closed === 'string',
  `${active.status} / ${closed.status} / ${closed.closed}`);
check('fixture: активной задачей резолв отдаёт одну',
  quiet(() => store.activeTasks(home, warn)).map((t) => t.id).join(',') === ACTIVE);

const addrs = active.participants.map((p) => p.address);
check('fixture: участники активной задачи — оркестратор, worker и reviewer',
  addrs.length === 3 && addrs.includes(ORCHESTRATOR) && addrs.includes('worker:demo') && addrs.includes('reviewer:demo'),
  addrs.join(', '));
check('fixture: у задачи есть owner и он же привязан сессией',
  store.taskOwner(home, ACTIVE) === SESSION && store.boundTaskId(home, SESSION) === ACTIVE,
  `${store.taskOwner(home, ACTIVE)} / ${store.boundTaskId(home, SESSION)}`);
check('fixture: закрытая задача сессией не привязана',
  store.boundTaskId(home, '00000000-0000-4000-8000-000000000002') === null);

// --- переписка: непрочитанное, история, артефакт -------------------------------

check('fixture: непрочитанное разложено по адресам (1 / 3 / 0)',
  store.countInbox(home, ACTIVE, ORCHESTRATOR) === 1
  && store.countInbox(home, ACTIVE, 'worker:demo') === 3
  && store.countInbox(home, ACTIVE, 'reviewer:demo') === 0,
  [ORCHESTRATOR, 'worker:demo', 'reviewer:demo'].map((a) => store.countInbox(home, ACTIVE, a)).join(' / '));

const history = msgsIn(store.readDir(home, ACTIVE, ORCHESTRATOR));
check('fixture: история оркестратора — три сообщения в порядке отправки',
  history.map((m) => m.type).join(',') === 'status,result,review', history.map((m) => m.type).join(','));
check('fixture: типы сообщений — из протокола v1',
  [...history, ...msgsIn(store.inboxDir(home, ACTIVE, ORCHESTRATOR))].every((m) => MESSAGE_TYPES.includes(m.type)));

const withArtifact = history.find((m) => m.artifact);
check('fixture: артефакт назван сообщением и лежит в задаче',
  withArtifact?.artifact === 'demo-diff.patch'
  && existsSync(path.join(store.artifactsDir(home, ACTIVE), 'demo-diff.patch')),
  JSON.stringify(withArtifact?.artifact));

check(`fixture: mailbox reviewer'а вычитан, ответ ушёл оркестратору`,
  msgsIn(store.readDir(home, ACTIVE, 'reviewer:demo')).map((m) => m.type).join(',') === 'review'
  && store.countInbox(home, ACTIVE, 'reviewer:demo') === 0);

check('fixture: переписка закрытой задачи вычитана целиком',
  msgsIn(store.readDir(home, CLOSED, ORCHESTRATOR)).length === 1
  && msgsIn(store.readDir(home, CLOSED, 'worker:stale')).length === 1
  && store.countInbox(home, CLOSED, ORCHESTRATOR) === 0);

// --- повреждённое сообщение: изоляция в broken/ --------------------------------

const BROKEN = '20260831T095500000-0009-orchestrator.json';
const attic = store.brokenDir(home, ACTIVE, 'worker:demo');
check(`fixture: битое сообщение лежит в mailbox'е, а не в broken/`,
  names(store.inboxDir(home, ACTIVE, 'worker:demo')).includes(BROKEN) && !existsSync(attic));

const read = captureSplit(() => store.readInbox(home, ACTIVE, 'worker:demo', warn));
const { msgs, broken } = read.value;
check('reader: исправные сообщения дошли, битое их не унесло',
  msgs.length === 2 && msgs.map((m) => m.type).join(',') === 'task,review',
  msgs.map((m) => m.type).join(','));
check('reader: битое отложено в broken/ под своим именем',
  names(attic).join(',') === BROKEN && !names(store.inboxDir(home, ACTIVE, 'worker:demo')).includes(BROKEN),
  names(attic).join(','));
check('reader: доклад о битом идёт и агенту, и человеку',
  broken.length === 1 && broken[0].includes(BROKEN) && read.err.includes(BROKEN),
  `${broken.length} / ${JSON.stringify(read.err)}`);
check('reader: исправные сообщения помечены прочитанными',
  store.countInbox(home, ACTIVE, 'worker:demo') === 0
  && msgsIn(store.readDir(home, ACTIVE, 'worker:demo')).length === 2);

// --- health и состояние надзирателя --------------------------------------------

const health = store.readHealth(home, ACTIVE);
check('fixture: health знает все три адреса и непрочитанное по каждому',
  Object.keys(health).length === 3 && health[ORCHESTRATOR]?.unread === 1
  && health['worker:demo']?.unread === 3 && health['reviewer:demo']?.unread === 0,
  Object.keys(health).join(', '));
// Срез держит оба исхода, которые миграция обязана перенести: удавшийся стук и откат
// с кодом ошибки. Удавшийся здесь `socket` — значение driver'а Claude Code в момент
// снятия среза, не единственное законное: живой надзиратель пишет `knockChannel`
// driver'а (`inject` у Cursor, `rpc` у Codex).
check('fixture: в health оба канала — удавшийся стук и откат на self-wake',
  health[ORCHESTRATOR].channel === 'socket' && health[ORCHESTRATOR].knockError === null
  && health['worker:demo'].channel === 'self-wake' && health['worker:demo'].knockError === 'ENOENT',
  `${health[ORCHESTRATOR].channel} / ${health['worker:demo'].channel}`);
check(`fixture: отпечаток contact point'а есть у всех трёх, а сокет подставной`,
  Object.values(health).every((h) => /^\/tmp\/promptobus-demo\/[a-z-]+\.sock#\d{4}-/.test(h.wake)),
  Object.values(health).map((h) => h.wake).join(' | '));
check('fixture: доставленный адрес сохранил поля прежнего стука',
  health['reviewer:demo'].deliveredAt === '2026-08-31T09:46:00.000Z'
  && health['reviewer:demo'].channel === 'socket' && health['reviewer:demo'].since === null
  && health['reviewer:demo'].knocks === 0,
  JSON.stringify(health['reviewer:demo']));
check('fixture: молчание обоих адресов эскалировано',
  typeof health[ORCHESTRATOR].escalatedAt === 'string'
  && typeof health['worker:demo'].escalatedAt === 'string');

const mark = JSON.parse(readFileSync(store.wardenMarkFile(home, ACTIVE), 'utf8'));
check('fixture: отметка надзирателя снята, но живым он не числится',
  mark.pid === 424242 && typeof mark.beat === 'string' && store.liveWarden(home, ACTIVE) === null,
  JSON.stringify(mark));
// Строки журнала цитируются шаблонами самого надзирателя: разъедься формат — срез
// перестанет быть входом миграции, а сверка форму держит.
const log = readFileSync(store.wardenLogFile(home, ACTIVE), 'utf8').split('\n').filter(Boolean);
check('fixture: журнал надзирателя ведёт подъём, стуки, доставку, откат и молчание',
  log.length === 11
  && /надзиратель поднят · pid 424242 · CLI /.test(log[0])
  && log.some((l) => /notification worker:demo: непрочитанных 1, стук 1$/.test(l))
  && log.some((l) => /доставлено reviewer:demo: mailbox забран \(лежало 1, стуков 1\)$/.test(l))
  && log.some((l) => /откат на self-wake worker:demo: сокет не принял notification \(ENOENT\)$/.test(l))
  && /МОЛЧИТ worker:demo: mailbox не забран \d+ мин, непрочитанных 3, канал self-wake$/.test(log[log.length - 1]),
  `строк ${log.length}`);
check('fixture: журнал читается с хвоста',
  store.tailWardenLog(home, ACTIVE, 3).length === 3
  && store.tailWardenLog(home, ACTIVE, 1)[0] === log[log.length - 1]);
check(`fixture: contact point'ов в fixture нет — в них токен живой сессии`,
  !existsSync(path.join(store.taskDir(home, ACTIVE), 'wake')));

// --- гигиена: оригинал fixture не тронут ---------------------------------------

check('гигиена: чтение шло по копии, дерево репозитория не изменилось',
  !existsSync(path.join(FIXTURE, 'tasks', ACTIVE, 'broken'))
  && readdirSync(path.join(FIXTURE, 'tasks', ACTIVE, 'inbox', 'worker-demo')).length === 3);
