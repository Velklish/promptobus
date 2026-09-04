// Регресс на снятие сданного участника с наблюдения — `promptobus promptobus dismiss`.
// Запуск: npm test
//
// Предмет — молчание доклада ровно о снятом адресе. Оркестратор принимает работу и сам
// закрывает сессию участника (`claude stop`), а надзиратель докладывает об этом «ИСЧЕЗ» с
// маршрутом подъёма и повторяет доклад до трёх раз: run 0830c дал шесть postcard'ов на двух
// закрытых участников. Отметка снятия — недостающее надзирателю знание, и ставит её тот,
// кто сессию закрыл.
//
// Проверяется обе стороны разом: снятый из перечня вставших уходит, НЕ снятый остаётся с
// прежним исходом, прежними словами и прежним маршрутом. Плюс сама команда — гейт
// владельца, отказы, идемпотентность — и возврат под наблюдение повторным подъёмом.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, snapshotOfList, stubCommand, writeHostConfig } from './sandbox.mjs';
import { capture, captureSplit, expectFail } from './console.mjs';

const SB = makeSandbox('promptobus-promptobus-dismiss-');
const ROOT = realpathSync(SB);
const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(ROOT, '.promptobus');
const TASK = 'dismiss-t20260830-140000';
const OWNER = 'sess-hozyain-0830';

const store = await import(path.join(here, '..', 'lib', 'store.js'));
const {
  blockedParticipants, pendingStalls, stallLine, status, SPAWN_GRACE_SEC,
} = await import(path.join(here, '..', 'lib', 'status.js'));
const { dismiss } = await import(path.join(here, '..', 'lib', 'dismiss.js'));

// Идентичность сессии тест задаёт сам: `sessionIdentity` читает `CLAUDE_CODE_SESSION_ID`,
// и без подстановки гейт владельца проверялся бы по-разному у сессии Claude Code
// (переменная есть) и в CI (её нет). Приём тот же, что в promptobus.test.mjs.
const withSession = async (id, fn) => {
  const was = process.env.CLAUDE_CODE_SESSION_ID;
  if (id === null) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = id;
  try { return await fn(); } finally {
    if (was === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = was;
  }
};

store.createTask(HOME, { id: TASK, title: 'приёмка куска и снятие участника', owner: OWNER });

const WORKER = 'worker:api';
const REVIEWER = 'reviewer:api';
const WORKER_NAME = `a2a-${TASK}-api`;
const REVIEWER_NAME = `Review: приёмка (0830-1400)`;
// Оба записаны давно: окно регистрации свежеспавненного участника накрыло бы
// исход «записи нет» раньше всякого снятия, и проверка молчала бы не о том.
const started = new Date(Date.now() - (SPAWN_GRACE_SEC + 5) * 1000).toISOString();
store.upsertParticipant(HOME, TASK, store.participantRecord(WORKER, { name: WORKER_NAME, repoAbs: path.join(ROOT, 'klon'), started }));
store.upsertParticipant(HOME, TASK, store.participantRecord(REVIEWER, { name: REVIEWER_NAME, repoAbs: path.join(ROOT, 'klon'), started }));

// Снимок сессий подставной: живость участника — ответ driver'а, спросившего свой harness,
// и зависеть от того, что отвечает настоящий claude на машине прогона, проверкам нельзя.
// Снимок ключуется АДРЕСОМ участника и собирается НАСТОЯЩИМ driver'ом по
// подставному ответу harness'а — помощником с одним домом на весь набор
// ([sandbox.mjs](sandbox.mjs)). Чужая живая запись в списке нужна для самокалибровки
// живости: признак «числится» объявляется только там, где этот harness вообще печатает pid.
const HARNESS_LIST = [{ id: 'liv001', name: 'Worker: сосед', state: 'working', pid: process.pid }];
const snapOf = snapshotOfList;
const OTHERS = () => snapOf(participants(), HARNESS_LIST);
const participants = () => store.readTask(HOME, TASK).participants;
const seen = () => blockedParticipants(HOME, TASK, participants(), OTHERS());

// --- до снятия: докладываются оба ---------------------------------------------
const before = seen();
check(': до снятия исчезнувшие участники докладываются оба',
  before.length === 2 && before.every((s) => s.kind === 'gone'), JSON.stringify(before));

// --- снятие: команда -----------------------------------------------------------
const out = await withSession(OWNER, () => capture(() => dismiss(ROOT, { task: TASK, address: REVIEWER })));
check(': команда называет снятого и говорит, что докладов о нём не будет',
  new RegExp(`${REVIEWER} снят с наблюдения`).test(out) && /докладов о его сессии/.test(out), out.trim());
check(': команда называет границу — отправленные доклады не отзываются',
  /уже отправленные доклады/.test(out), out.trim());
check(': команда называет, что mailbox снятого остаётся',
  /писать снятому адресу законно/.test(out), out.trim());

const mark = participants().find((p) => store.addressOf(p) === REVIEWER)?.metadata?.dismissed;
check(': отметка лежит в store задачи, а не в памяти надзирателя',
  typeof mark === 'string' && Number.isFinite(Date.parse(mark)), String(mark));

// --- главное: доклад молчит о снятом и не меняется о прочих --------------------
const after = seen();
check(': о снятом участнике доклада нет',
  after.every((s) => s.address !== REVIEWER), JSON.stringify(after));
check(': НЕ снятый докладывается по-прежнему — тот же исход и тот же адрес',
  after.length === 1 && after[0].address === WORKER && after[0].kind === 'gone'
  && after[0].reason === 'записи сессии в claude agents нет', JSON.stringify(after));
const workerLine = stallLine(after[0], TASK);
check(': слова и маршрут не снятого не изменились ни в чём',
  /ИСЧЕЗ: записи сессии в claude agents нет/.test(workerLine)
  && /поднимай worker'а заново тем же spawn'ом/.test(workerLine), workerLine);

// Канал доклада надзирателя — тот же предикат: `reportStalls` спрашивает `pendingStalls`,
// и снятый не доходит до журнала ровно потому, что не доходит до перечня вставших.
const { fresh } = pendingStalls(HOME, TASK, (ps) => blockedParticipants(HOME, TASK, ps, snapOf(ps, HARNESS_LIST)));
check(': до журнала надзирателя снятый не доходит, а не снятый доходит',
  fresh.length === 1 && fresh[0].address === WORKER, JSON.stringify(fresh.map((s) => s.address)));

// --- снятие целиком, а не только исход «ИСЧЕЗ» ---------------------------------
//
// Между снятием и `claude stop` сессия ещё жива и может встать на permission-запросе.
// Фильтр по исходу поставил бы молчание в зависимость от гонки двух команд оркестратора:
// успел оркестратор закрыть сессию до warden round'а — тихо, не успел — postcard.
const BLOCKED = snapOf(participants(), [
  ...HARNESS_LIST,
  { id: 'p111', name: REVIEWER_NAME, state: 'blocked', waitingFor: 'permission prompt', pid: 4242 },
  { id: 'p222', name: WORKER_NAME, state: 'blocked', waitingFor: 'permission prompt', pid: 4243 },
]);
const stalls = blockedParticipants(HOME, TASK, participants(), BLOCKED);
check(': снятый молчит и на стопе живой сессии — снято наблюдение целиком',
  stalls.length === 1 && stalls[0].address === WORKER && stalls[0].kind === 'permission',
  JSON.stringify(stalls));

// --- повтор идемпотентен -------------------------------------------------------
const again = await withSession(OWNER, () => capture(() => dismiss(ROOT, { task: TASK, address: REVIEWER })));
check(': повторное снятие говорит «уже снят» и журнал не трогает',
  /уже снят/.test(again) && participants().find((p) => store.addressOf(p) === REVIEWER)?.metadata?.dismissed === mark,
  `${again.trim()} · ${participants().find((p) => store.addressOf(p) === REVIEWER)?.metadata?.dismissed}`);

// --- писать снятому законно ----------------------------------------------------
//
// Решение по коду: снятие гасит доклады надзирателя, а не адрес. Отказ `send` означал бы
// потерянное сообщение там, где механизм обещает доставку, — истина шины лежит в mailbox'е,
// и повторно поднятый участник заберёт его первым же `inbox`.
store.sendMessage(HOME, TASK, {
  from: 'orchestrator', to: REVIEWER, type: 'review', body: 'ещё один круг по тому же диффу',
});
check(': снятому адресу пишется, и сообщение лежит в его mailbox\'е',
  store.countInbox(HOME, TASK, REVIEWER) === 1, String(store.countInbox(HOME, TASK, REVIEWER)));

// --- возврат под наблюдение повторным подъёмом ---------------------------------
//
// Ни `promptobus spawn`, ни `promptobus review` прежнюю запись участника не переносят — они кладут её
// целиком заново. Отметки в новой записи нет, и поднятый заново адрес снова под
// наблюдением: отдельной команды на это не нужно.
store.upsertParticipant(HOME, TASK, store.participantRecord(REVIEWER, { name: REVIEWER_NAME, repoAbs: path.join(ROOT, 'klon'), started }));
const relifted = seen();
check(': подняли заново — участник снова под наблюдением',
  relifted.length === 2 && relifted.some((s) => s.address === REVIEWER), JSON.stringify(relifted));

// --- гейт владельца ------------------------------------------------------------
// Отказ идёт через `fail()` — печать и выход, без стека: стек в отказе,
// адресованном человеку, перестал бы быть признаком внутренней поломки CLI.
const foreign = await withSession('sess-gost', () => expectFail(() => dismiss(ROOT, { task: TASK, address: WORKER })));
check(': чужая сессия участника не снимает — доклады идут владельцу mailbox\'а',
  foreign.failed && /владелец mailbox/.test(foreign.out) && foreign.out.includes(OWNER)
  && foreign.out.includes('sess-gost') && /mailbox \{claim: true\}/.test(foreign.out), foreign.out);
check(': отказ гейта журнал не трогает',
  participants().find((p) => store.addressOf(p) === WORKER)?.metadata?.dismissed === undefined,
  JSON.stringify(participants().find((p) => store.addressOf(p) === WORKER)));

// --- отказы --------------------------------------------------------------------
const noAddr = await withSession(OWNER, () => expectFail(() => dismiss(ROOT, { task: TASK })));
check(': без адреса — отказ с готовой командой и списком участников',
  noAddr.failed && /назови адрес участника/.test(noAddr.out) && noAddr.out.includes(WORKER), noAddr.out);

const stranger = await withSession(OWNER,
  () => expectFail(() => dismiss(ROOT, { task: TASK, address: 'worker:net-takogo' })));
check(': посторонний адрес — отказ со списком участников, а не молчаливая отметка',
  stranger.failed && /нет участника/.test(stranger.out) && stranger.out.includes(REVIEWER), stranger.out);

const self = await withSession(OWNER,
  () => expectFail(() => dismiss(ROOT, { task: TASK, address: 'orchestrator' })));
check(': оркестратор не снимается — докладов о нём не бывает',
  self.failed && /докладов о нём не бывает/.test(self.out), self.out);

// --- снятие видно в promptobus status -------------------------------------------------
//
// Без строки молчание доклада неотличимо от смерти надзирателя. Снимок сессий печать берёт
// швом — тем же подставным, что и предикат выше. Подмены `claude` на PATH здесь
// нет вовсе: сама `dismiss` harness не спрашивает — резолв задачи, гейт владельца и запись
// участника до списка сессий не доходят.
await withSession(OWNER, () => capture(() => dismiss(ROOT, { task: TASK, address: REVIEWER })));
const printed = await withSession(OWNER,
  () => captureSplit(() => status(ROOT, { task: TASK, sessions: OTHERS() })));
const reviewerLine = printed.out.split('\n').find((l) => l.includes(REVIEWER)) ?? '';
const workerStatusLine = printed.out.split('\n').find((l) => l.includes(WORKER)) ?? '';
check(': promptobus status называет снятие — иначе молчание докладов не объяснить',
  /СНЯТ С НАБЛЮДЕНИЯ/.test(reviewerLine), reviewerLine || printed.out.trim());
check(': не снятому строка promptobus status не приписывается',
  !/СНЯТ С НАБЛЮДЕНИЯ/.test(workerStatusLine), workerStatusLine || printed.out.trim());

// Задача-фикстура для проверки, что снятие не притворяется закрытием: статус её прежний.
check(': снятие участника задачу не закрывает',
  store.readTask(HOME, TASK).status === 'active', store.readTask(HOME, TASK).status);

// --- : переревью живой сессии возвращает участника под наблюдение ---------
//
// Ветка `plan.reuse` в [review.js](../lib/review.js) записи участника не переписывает
// вовсе — живому reviewer'у уходит только сообщение с новым диффом. Поэтому dismissed
// reviewer, получивший новый круг, работал бы без наблюдения и встал бы молча: оркестратор
// ждал бы отчёта, которого не будет, а доклад о стопе не пришёл бы.
//
// Проверка идёт ЧЕРЕЗ настоящий путь `promptobus review`, а не имитацией `upsertParticipant`:
// предмет здесь — что нужный вызов стоит в нужной ветке команды, и подделанная запись
// участника доказала бы только работу store'а.
const g = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

// Рабочее место поверх той же песочницы: `promptobusHome(ROOT)` у команды и у проверок один.
writeFileSync(path.join(ROOT, 'AGENTS.md'), 'workspace\n');
writeHostConfig(ROOT);
// Корень рабочего места — сам git-репозиторий, как в жизни: без этого toplevel клона
// уходит вверх, к корню.
g(ROOT, 'init', '-b', 'main');
const REPO = path.join(ROOT, 'repos', 'loads_search', 'cargos-api');
mkdirSync(REPO, { recursive: true });
g(REPO, 'init', '-b', 'main');
writeFileSync(path.join(REPO, 'a.txt'), 'v1\n');
g(REPO, 'add', '.');
g(REPO, 'commit', '-m', 'init', '-q');
// Дифф — предмет ревью: без изменений команда ответит «ревьюить нечего» и до ветки
// переревью не дойдёт вовсе.
writeFileSync(path.join(REPO, 'a.txt'), 'v2\n');

const REUSE_TASK = 'reuse-t20260830-160000';
const REUSE_ADDR = 'reviewer:cargos-api';
const REUSE_SESSION = 'Review: переревью снятого (0830-1600)';
store.createTask(HOME, { id: REUSE_TASK, title: 'переревью снятого', owner: OWNER });
store.upsertParticipant(HOME, REUSE_TASK, store.participantRecord(REUSE_ADDR, { repo: 'loads_search/cargos-api', repoAbs: REPO,
  name: REUSE_SESSION, session: 'cafe12', started }));
// Живая сессия reviewer'а: по ней план решает, что второго поднимать не надо (`plan.reuse`).
// Здесь подмена `claude` на PATH нужна по-настоящему: `promptobus review` спрашивает список
// сессий сам, своего шва у команды нет, и живой `claude agents --json` машины прогона
// решал бы за проверку, поднимать ли второго reviewer'а.
const LIVE = [{ id: 'cafe12', name: REUSE_SESSION, state: 'working', pid: process.pid }];
const BIN = path.join(ROOT, 'bin');
mkdirSync(BIN, { recursive: true });
stubCommand(BIN, 'claude', `process.stdout.write(${JSON.stringify(JSON.stringify(LIVE))});`);
const PATH_WAS = process.env.PATH;
process.env.PATH = `${BIN}${path.delimiter}${PATH_WAS}`;

await withSession(OWNER, () => capture(() => dismiss(ROOT, { task: REUSE_TASK, address: REUSE_ADDR })));
const dismissedBefore = () => store.readTask(HOME, REUSE_TASK).participants
  .find((p) => store.addressOf(p) === REUSE_ADDR)?.metadata?.dismissed;
check(': reviewer снят и до переревью числится снятым',
  typeof dismissedBefore() === 'string'
  && blockedParticipants(HOME, REUSE_TASK, store.readTask(HOME, REUSE_TASK).participants,
    snapOf(store.readTask(HOME, REUSE_TASK).participants, [])).length === 0,
  String(dismissedBefore()));

const { review } = await import(path.join(here, '..', 'lib', 'review.js'));
const reviewOut = await withSession(OWNER,
  () => capture(() => review(ROOT, { target: REPO, task: REUSE_TASK })));
process.env.PATH = PATH_WAS;
check(': команда пошла веткой переревью живой сессии, а не подъёмом второго',
  /уже на шине/.test(reviewOut), reviewOut.trim().split('\n').slice(-4).join(' | '));
check(': переревью сняло отметку — новое задание вернуло участника под наблюдение',
  dismissedBefore() === undefined, JSON.stringify(store.readTask(HOME, REUSE_TASK).participants));
check(': возврат назван вслух — оркестратор видит, что доклады снова идут',
  /снят с наблюдения — новое задание вернуло его/.test(reviewOut),
  reviewOut.trim().split('\n').slice(-4).join(' | '));
// Сессия жива, но встала — и доклад о ней снова уходит: наблюдение вернулось не на словах.
const backUnderWatch = blockedParticipants(HOME, REUSE_TASK, store.readTask(HOME, REUSE_TASK).participants,
  snapOf(store.readTask(HOME, REUSE_TASK).participants,
    [{ id: 'cafe12', name: REUSE_SESSION, state: 'blocked', waitingFor: 'permission prompt', pid: process.pid }]));
check(': вернувшийся под наблюдение снова докладывается — и стопом, а не исчезновением',
  backUnderWatch.length === 1 && backUnderWatch[0].address === REUSE_ADDR
  && backUnderWatch[0].kind === 'permission',
  JSON.stringify(backUnderWatch));
