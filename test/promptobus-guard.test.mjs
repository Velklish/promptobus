// Регресс на сторож цикла шины `promptobus promptobus guard` и его Stop-хук (этап 1).
// Запуск: npm test
//
// Предмет — ход, кончившийся с неразобранным mailbox'ом: стучаться в сессию, которая ход уже
// кончает, поздно, а все прочие страховки шины живут в ОТВЕТАХ инструментов — и ход,
// кончившийся отчётом человеку без единого вызова шины, не зовёт ни одной из них.
//
// Ветка одна: будильник в задаче один, и это надзиратель. Стеречь сторожу нечего, кроме
// неразобранного mailbox'а.
//
// Проверяется то, что увидит харнес: код возврата (2 — ход возвращается, 0 — нет),
// причина в stderr и молчание чистого прохода. Плюс защита от зацикливания: одно и то же
// состояние возвращается не больше двух раз подряд.
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, makeSockPath, stubCommand, writeHostConfig } from './sandbox.mjs';

const SB = makeSandbox('promptobus-promptobus-guard-');
const ROOT = realpathSync(SB);
const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'promptobus.js');
const HOME = path.join(ROOT, '.promptobus');
const TASK = 'guard-t20260829-120000';
const SESSION = 'sess-guard-1111';

const store = await import(path.join(here, '..', 'lib', 'store.js'));
const {
  guardVerdict, guardMarkFile, GUARD_MARK, GUARD_BLOCK_LIMIT,
  successorLine, successorVerdict, probeContactPoint,
} = await import(path.join(here, '..', 'lib', 'guard.js'));
const { GUARD_HOOK_EVENT, GUARD_START_EVENT, guardHookSettings } = await import(path.join(here, '..', 'dist', 'hooks.js'));
const { createStandaloneHost } = await import(path.join(here, '..', 'lib', 'host.js'));
writeHostConfig(ROOT);

store.createTask(HOME, { id: TASK, title: 'сторож цикла', owner: SESSION });
const WORKER_NAME = `a2a-${TASK}-api`;
store.upsertParticipant(HOME, TASK, store.participantRecord('worker:api', { name: WORKER_NAME }));

const send = (type, body) => store.sendMessage(HOME, TASK, { from: 'worker:api', to: 'orchestrator', type, body });

// Список сессий подставной: живость участника — это ответ внешнего `claude agents --json`,
// и зависеть от того, что отвечает настоящий claude на машине прогона, проверкам нельзя.
const LIVE = [{ id: 'liv001', name: WORKER_NAME, state: 'busy', pid: process.pid }];
const STUB = path.join(ROOT, 'bin');
stubCommand(STUB, 'claude', `process.stdout.write(${JSON.stringify(JSON.stringify(LIVE))});`);

// --- вердикт сторожа ----------------------------------------------------------

check('чистое состояние: mailbox пуст — вердикта нет',
  guardVerdict(HOME, TASK, 'orchestrator') === null,
  JSON.stringify(guardVerdict(HOME, TASK, 'orchestrator')));

send('status', 'взял в работу');
send('result', 'готово');
const unread = guardVerdict(HOME, TASK, 'orchestrator');
check(`непрочитанное в mailbox'е: вердикт называет число и маршрут через inbox`,
  unread?.key === 'mailbox:2' && /в mailbox'е 2/.test(unread.reason)
  && /забери их инструментом promptobus_mailbox/.test(unread.reason), JSON.stringify(unread));

// : живой надзиратель эту ветку не гасит. Он будит того, кому пишут, — а здесь ход
// кончает сам адресат, не разобрав mailbox: стучаться в сессию, которая уже кончает ход,
// поздно. Ветка стояла бы под гейтом надзирателя, будь она про notification; она про другое.
store.claimWarden(HOME, TASK, { cli: 'проба' });
// Путь сокета — из общего помощника: под `npm test` песочница уведена в каталог прогона,
// и `listen` на таком unix-пути падает EINVAL (предел sun_path), необработанным событием.
const sockPath = makeSockPath('ags-');
const ORCH_SOCK = sockPath('orch');
const orchLive = createServer((c) => { c.end(); });
await new Promise((res, rej) => {
  orchLive.once('error', rej);
  orchLive.listen(ORCH_SOCK, res);
});
store.writeWake(HOME, TASK, 'orchestrator', { socket: ORCH_SOCK, token: 't', session: SESSION });
check(': живой надзиратель непрочитанного не отменяет — ход всё равно возвращается',
  guardVerdict(HOME, TASK, 'orchestrator')?.key === 'mailbox:2',
  JSON.stringify(guardVerdict(HOME, TASK, 'orchestrator')));
store.clearWarden(HOME, TASK);

store.readInbox(HOME, TASK, 'orchestrator');
check(': mailbox забран — вердикта нет',
  guardVerdict(HOME, TASK, 'orchestrator') === null,
  JSON.stringify(guardVerdict(HOME, TASK, 'orchestrator')));

// --- CLI-процесс: код возврата и причина в stderr ------------------------------

// Идентичность приходит из окружения — тем же путём, что у `resolveIdentity`. `PROMPTOBUS_TASK`
// тут за объявленную привязку: у сессии оркестратора её пишет на диск spawn, а набору
// удобнее объявить задачу переменной.
const cli = (env = {}) => spawnSync(process.execPath, [BIN, 'guard'], {
  cwd: SB,
  env: {
    ...process.env,
    PATH: `${STUB}${path.delimiter}${process.env.PATH}`,
    PROMPTOBUS_HOME: HOME,
    PROMPTOBUS_TASK: TASK,
    PROMPTOBUS_ROLE: 'orchestrator',
    CLAUDE_CODE_SESSION_ID: SESSION,
    ...env,
  },
  encoding: 'utf8',
});

const MARK_FILE = guardMarkFile(HOME, TASK, 'orchestrator');

// Так сторожа зовёт харнес: полезная нагрузка события `Stop` на stdin. Переменной
// `CLAUDE_CODE_SESSION_ID` в окружении при этом НЕТ — процессу хука она ничем не обещана,
// и весь смысл чтения нагрузки в том, чтобы идентичность приходила оттуда.
const stopEvent = (session = SESSION) => JSON.stringify({
  session_id: session,
  transcript_path: path.join(ROOT, 'transcript.jsonl'),
  cwd: SB,
  hook_event_name: 'Stop',
  stop_hook_active: false,
});
const asHook = (input, env = {}) => {
  const clean = { ...process.env, ...env };
  delete clean.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [BIN, 'guard'], {
    cwd: SB,
    input,
    env: {
      ...clean,
      PATH: `${STUB}${path.delimiter}${process.env.PATH}`,
      PROMPTOBUS_HOME: HOME,
      PROMPTOBUS_TASK: TASK,
      PROMPTOBUS_ROLE: 'orchestrator',
    },
    encoding: 'utf8',
  });
};

const clean = cli();
check('CLI: чисто — код 0 и НИ ОДНОЙ строки вывода',
  clean.status === 0 && clean.stdout === '' && clean.stderr === '',
  `status=${clean.status} out=${JSON.stringify(clean.stdout)} err=${JSON.stringify(clean.stderr)}`);
check('CLI: чистый проход счётчика за собой не оставляет', !existsSync(MARK_FILE));

send('question', 'какой контракт события?');
const blocked = cli();
check('CLI: непрочитанное возвращает ход кодом 2, причина — в stderr',
  blocked.status === 2 && blocked.stdout === ''
  && blocked.stderr.startsWith(`${GUARD_MARK}: `) && /в mailbox'е 1/.test(blocked.stderr),
  `status=${blocked.status} ${blocked.stderr}`);
// Причина уезжает модели дословно (харнес вклеивает stderr в свой blockingError), и
// значок с цветом там были бы мусором посреди фразы.
check('CLI: причина без значка и без ANSI — её читает модель, а не терминал',
  !/\u001b\[/.test(blocked.stderr) && !/[✖⚠✔]/.test(blocked.stderr), JSON.stringify(blocked.stderr));
check(`CLI: причина называет задачу и адрес — по ней видно, о каком mailbox'е речь`,
  blocked.stderr.includes(`PROMPTOBUS_HOME=${HOME}`) && blocked.stderr.includes(`задача=${TASK}`)
  && blocked.stderr.includes('адрес=orchestrator'), blocked.stderr);
check(`CLI: сообщение из mailbox'а не тронуто — сторож не читатель`,
  store.countInbox(HOME, TASK, 'orchestrator') === 1);

// --- защита от зацикливания ----------------------------------------------------
//
// Хук, возвращающий ход бесконечно, вешает сессию наглухо. Свой потолок нужен, хотя
// потолок есть и у Claude Code (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP ?? 8): восемь возвратов —
// это восемь ходов модели на одно и то же, и снимает их харнес предупреждением, из
// которого не следует, что делать.
const again = cli();
check(`защита: второй ход на том же состоянии ход ещё возвращает (потолок ${GUARD_BLOCK_LIMIT})`,
  again.status === 2, `status=${again.status} ${again.stderr}`);
const third = cli();
// Канал пропуска — `{"systemMessage": …}` в stdout, а не stderr: при коде 0 харнес stderr
// никуда не поднимает, и предупреждение о снятой страховке не прочитал бы никто.
const thirdSaid = (() => { try { return JSON.parse(third.stdout); } catch { return null; } })();
check('защита: третий ход на том же состоянии пропущен — код 0 и строка в ленту вместо возврата',
  third.status === 0 && /пропускает ход/.test(thirdSaid?.systemMessage ?? '')
  && /возвращён 2/.test(thirdSaid?.systemMessage ?? ''),
  `status=${third.status} out=${JSON.stringify(third.stdout)} err=${JSON.stringify(third.stderr)}`);
check('защита: пропуск не пишет в stderr — при коде 0 его никто не читает',
  third.stderr === '', JSON.stringify(third.stderr));
const fourth = cli();
check('защита: и дальше пропускает — счётчик не сбрасывается сам собой',
  fourth.status === 0, `status=${fourth.status} ${fourth.stderr}`);

// Новое сообщение — ДРУГОЕ состояние: счётчик считает подряд идущие одинаковые, и
// пришедшее, пока модель работала, обязано снова вернуть ход.
send('status', 'а это пришло, пока модель работала');
const changed = cli();
check('защита: новое сообщение меняет состояние — ход возвращается снова',
  changed.status === 2 && /в mailbox'е 2/.test(changed.stderr), `status=${changed.status} ${changed.stderr}`);

// Отметку конца хода уводим в прошлое ПЕРЕД чистым проходом: выше её уже поставил проход
// по исчерпанному потолку возвратов, и проверка ниже была бы зелена от него — то есть
// прошла бы при любой реализации чистого прохода.
const turnWas = store.markTurn(HOME, TASK, 'orchestrator', '2020-01-01T00:00:00.000Z');
store.readInbox(HOME, TASK, 'orchestrator');
const cleared = cli();
check('защита: чистый проход сбрасывает счётчик и снимает файл',
  cleared.status === 0 && cleared.stderr === '' && !existsSync(MARK_FILE),
  `status=${cleared.status} ${cleared.stderr}`);
// , замечание ревью: у оркестратора bg-сессии нет, и «отдал ли он ход» надзиратель
// узнаёт только отсюда. Счётчик возвратов для этого не годится — чистый проход его СНОСИТ
// (строкой выше), — поэтому отметка своя и переживает сброс счётчика.
check(': чистый проход ставит отметку конца хода — по ней надзиратель судит о занятости',
  store.lastTurnAt(HOME, TASK, 'orchestrator') > Date.parse(turnWas),
  `${store.lastTurnAt(HOME, TASK, 'orchestrator')} против ${Date.parse(turnWas)}`);
send('status', 'после чистого прохода');
check('защита: после сброса ход снова возвращается с полного счёта', cli().status === 2);
store.readInbox(HOME, TASK, 'orchestrator');
cli();

// --- сессия без привязки -------------------------------------------------------
//
// Хук стоит у КАЖДОЙ сессии рабочего места. Резолва «единственная активная» у сторожа нет
// намеренно: иначе посторонняя сессия получала бы возврат хода по чужому run'у — человек
// правит свой код, а ему возвращают ход из-за непрочитанного mailbox'а чужого оркестратора.
send('result', 'лежит и ждёт владельца');
const unbound = cli({ PROMPTOBUS_TASK: '', CLAUDE_CODE_SESSION_ID: 'sess-postoronnyaya-9999' });
check(`сессия без привязки: сторож молчит, хотя в mailbox'е задачи лежит непрочитанное`,
  unbound.status === 0 && unbound.stdout === '' && unbound.stderr === '',
  `status=${unbound.status} out=${JSON.stringify(unbound.stdout)} err=${JSON.stringify(unbound.stderr)}`);

// Привязка на диске работает наравне с объявленной переменной: её пишет spawn
// сессии-владельцу, и без неё сторож у живого оркестратора не сработал бы вовсе.
store.bindSession(HOME, TASK, SESSION);
const bound = cli({ PROMPTOBUS_TASK: '' });
check('привязка на диске: задача резолвится без PROMPTOBUS_TASK, ход возвращается',
  bound.status === 2 && bound.stderr.includes(`задача=${TASK}`), `status=${bound.status} ${bound.stderr}`);

// Mailbox чужой — стеречь нечего: оригиналы уйдут владельцу, и «забери mailbox» тут ложь.
const foreign = cli({ CLAUDE_CODE_SESSION_ID: 'sess-chuzhaya-3333' });
check('чужой mailbox: сторож молчит — забирать оттуда нечего',
  foreign.status === 0 && foreign.stderr === '', `status=${foreign.status} ${foreign.stderr}`);

// --- участник: сторож общий, а не только оркестраторский --------
//
// Идентичность участника приезжает хуку АРГУМЕНТАМИ его команды: их вписывает в
// файл настроек участника подъём. До  сторож участника не работал вовсе —
// `PROMPTOBUS_ROLE` резолвился в `orchestrator`, привязки по сессии участника не находилось,
// и `decide` возвращал `null`;  положил тройку в окружение сессии, а  забрал
// её оттуда: окружение фоновой сессии приходит от демона и несёт идентичность ЧУЖОГО spawn'а.
//
// В окружении запускателя тройка при этом стоит ЧУЖАЯ — так и живёт настоящая фоновая
// сессия. Проверяется ровно то, что аргументы её перебивают.
//
// Привязки на диске у этой сессии нет намеренно: она и не пишется участнику, и вся
// идентичность здесь обязана прийти из аргументов — иначе проверка была бы про оркестратора.
const WORKER_SESSION = 'sess-worker-2222';
const ALIEN_ENV = {
  PROMPTOBUS_ROLE: 'worker:sosed',
  PROMPTOBUS_TASK: 'chuzhaya-t20260101-000000',
  PROMPTOBUS_HOME: path.join(ROOT, 'chuzhoy-dom'),
};
// Свой запускатель, а не `asHook`: тот вписывает `PROMPTOBUS_ROLE: 'orchestrator'` последним
// и переписал бы роль участника. Всё остальное то же — нагрузка события на stdin и никакой
// `CLAUDE_CODE_SESSION_ID` в окружении.
const asWorker = (role = 'worker:api', { args = true } = {}) => spawnSync(process.execPath, [
  BIN, 'promptobus', 'guard',
  ...(args && role ? ['--role', role, '--task', TASK, '--home', HOME] : []),
], {
  cwd: SB,
  input: stopEvent(WORKER_SESSION),
  env: Object.fromEntries(Object.entries({
    ...process.env,
    PATH: `${STUB}${path.delimiter}${process.env.PATH}`,
    // Окружение сессии — чужое, от демона: ровно то, ради чего идентичность уехала в аргументы.
    ...(args ? ALIEN_ENV : { PROMPTOBUS_HOME: HOME, PROMPTOBUS_TASK: TASK, PROMPTOBUS_ROLE: role }),
  }).filter(([k, v]) => k !== 'CLAUDE_CODE_SESSION_ID' && v !== '')),
  encoding: 'utf8',
});
store.sendMessage(HOME, TASK, { from: 'orchestrator', to: 'worker:api', type: 'review', body: 'закрой замечание' });
const workerBlocked = asWorker();
check(': аргументы команды сильнее чужой тройки в окружении — сторож взял адрес из них',
  workerBlocked.stderr.includes('адрес=worker:api') && !workerBlocked.stderr.includes('worker:sosed'),
  `status=${workerBlocked.status} ${workerBlocked.stderr}`);
check(': участнику с неразобранным mailbox\'ом сторож возвращает ход — кодом 2, как оркестратору',
  workerBlocked.status === 2 && /в mailbox'е 1/.test(workerBlocked.stderr)
  && workerBlocked.stderr.includes('адрес=worker:api'),
  `status=${workerBlocked.status} ${workerBlocked.stderr}`);
check(': привязки на диске у сессии участника нет — идентичность пришла из окружения',
  store.boundTaskId(HOME, WORKER_SESSION) === null, String(store.boundTaskId(HOME, WORKER_SESSION)));
// Отметку уводим в прошлое ПЕРЕД чистым проходом: возврат хода её тоже не ставит, но
// потолок возвратов ниже поставил бы, и вердикт зеленел бы от него.
const workerTurnWas = store.markTurn(HOME, TASK, 'worker:api', '2020-01-01T00:00:00.000Z');
store.readInbox(HOME, TASK, 'worker:api');
const workerClean = asWorker();
check(': чистый проход участника ставит отметку конца хода — прежде её получал только оркестратор',
  workerClean.status === 0 && workerClean.stderr === ''
  && store.lastTurnAt(HOME, TASK, 'worker:api') > Date.parse(workerTurnWas),
  `status=${workerClean.status} ${workerClean.stderr}`
  + ` · ${store.lastTurnAt(HOME, TASK, 'worker:api')} против ${Date.parse(workerTurnWas)}`);
// Окружение осталось ЗАПАСНЫМ путём и работать не перестало: так сторожа зовут руками, и
// так же живёт хук рабочего места, у которого аргументов нет вовсе. Отними у него и это —
// и роль резолвится в `orchestrator`, то есть ровно в то состояние, в котором механизм жил
// до .
store.sendMessage(HOME, TASK, { from: 'orchestrator', to: 'worker:api', type: 'review', body: 'второе замечание' });
const byEnv = asWorker('worker:api', { args: false });
check(': без аргументов идентичность берётся из окружения — запасной путь ручного запуска',
  byEnv.status === 2 && byEnv.stderr.includes('адрес=worker:api'), `status=${byEnv.status} ${byEnv.stderr}`);
const roleless = asWorker('', { args: false });
check(': без роли в окружении сессия участника снова резолвится оркестратором и его ход не держится',
  roleless.status === 0 && roleless.stderr === '' && store.countInbox(HOME, TASK, 'worker:api') === 1,
  `status=${roleless.status} ${roleless.stderr} · непрочитано у worker:api ${store.countInbox(HOME, TASK, 'worker:api')}`);
store.readInbox(HOME, TASK, 'worker:api');

// --- : за адрес, закреплённый за другой сессией, сторож не пишет ничего ----
//
// Второй рубеж после аргументов. Он держит то, чего аргументы не покрывают: ручной запуск с
// чужой тройкой в окружении и участника, поднятого прежним релизом, — там идентичность
// по-прежнему приходит из окружения демона. Записать сюда чужой contact point значит увести
// notification'ы адресата в свою сессию, а отметку конца хода — соврать о чужом ходе.
// Короткий id журнала против полного uuid пишущего — два написания одной сессии (замер
// 2026-09-03 на `claude` 2.1.251: `id: "e8c5be23"` при `sessionId: "e8c5be23-dfef-…"`).
const OWN_SHORT = 'e8c5be23';
const OWN_FULL = 'e8c5be23-dfef-4d20-bd96-e2a40a366b97';
const ALIEN_SESSION = '7f3a01bc-2210-4f61-9a0e-1c4d5e6f7a8b';
const CHUZHOY = 'chuzhoy-t20260903-020000';
store.createTask(HOME, { id: CHUZHOY, title: 'адрес за другой сессией', owner: SESSION });
store.upsertParticipant(HOME, CHUZHOY, store.participantRecord('worker:api', { name: 'w-ch', session: OWN_SHORT }));
store.writeWake(HOME, CHUZHOY, 'worker:api', {
  socket: path.join(ROOT, 'svoy.sock'), token: 't', session: OWN_FULL,
});
store.markTurn(HOME, CHUZHOY, 'worker:api', '2020-01-01T00:00:00.000Z');
store.sendMessage(HOME, CHUZHOY, { from: 'orchestrator', to: 'worker:api', type: 'task', body: 'кусок' });
const alienGuard = spawnSync(process.execPath, [
  BIN, 'promptobus', 'guard', '--role', 'worker:api', '--task', CHUZHOY, '--home', HOME,
], {
  cwd: SB,
  input: JSON.stringify({ session_id: ALIEN_SESSION, cwd: SB, hook_event_name: 'Stop' }),
  env: { ...process.env, PATH: `${STUB}${path.delimiter}${process.env.PATH}` },
  encoding: 'utf8',
});
check(': чужая сессия за этот адрес не пишет ни contact point, ни отметку конца хода',
  alienGuard.status === 0 && alienGuard.stderr === ''
  && store.readWake(HOME, CHUZHOY, 'worker:api')?.socket === path.join(ROOT, 'svoy.sock')
  && store.lastTurnAt(HOME, CHUZHOY, 'worker:api') === Date.parse('2020-01-01T00:00:00.000Z'),
  `status=${alienGuard.status} ${alienGuard.stderr}`
  + ` · ${JSON.stringify(store.readWake(HOME, CHUZHOY, 'worker:api'))}`
  + ` · отметка ${store.lastTurnAt(HOME, CHUZHOY, 'worker:api')}`);
// Отказ обязан быть виден и с ЭТОЙ двери: у сторожа гейт стоит раньше `registerWake`, и
// молчи он здесь, самый частый вход в беду — чужой Stop-хук — прошёл бы неотличимо от
// чистого прохода (второй раунд ревью).
check(': сторож записал свой отказ в журнал надзирателя',
  store.tailWardenLog(HOME, CHUZHOY, 10).some((l) => l.includes('отметка конца хода за адрес worker:api не идёт')
    && l.includes(ALIEN_SESSION)),
  store.tailWardenLog(HOME, CHUZHOY, 5).join('\n') || '(журнал пуст)');
// Своя сессия тем же вызовом пишет обе записи: гейт отличает чужого от владельца, а не
// запрещает запись вовсе. Короткий id журнала против полного uuid — сверка префиксная.
const ownGuard = spawnSync(process.execPath, [
  BIN, 'promptobus', 'guard', '--role', 'worker:api', '--task', CHUZHOY, '--home', HOME,
], {
  cwd: SB,
  input: JSON.stringify({ session_id: OWN_FULL, cwd: SB, hook_event_name: 'Stop' }),
  env: { ...process.env, PATH: `${STUB}${path.delimiter}${process.env.PATH}` },
  encoding: 'utf8',
});
check(': своя сессия тем же вызовом ход возвращает — гейт отличает чужого, а не запирает адрес',
  ownGuard.status === 2 && /в mailbox'е 1/.test(ownGuard.stderr), `status=${ownGuard.status} ${ownGuard.stderr}`);

// --- , замечание ревью: сессия доезжает до contact point'а из НАГРУЗКИ события ------
//
// `CLAUDE_CODE_SESSION_ID` процессу хука ничем не обещана ([15]),
// и свою сессию сторож резолвит из `session_id` нагрузки. Читай `registerWake` одно окружение
// — на машине без переменной запись легла бы БЕЗ поля `session`, то есть каждый конец хода
// стирал бы клеймо владельца, и второй рубеж переставал бы различать вовсе. Окружение здесь
// поэтому без неё, ровно как у настоящего хука.
const SDACHA = 'sdacha-t20260903-030000';
const SDACHA_SOCK = path.join(ROOT, 'sdacha.sock');
store.createTask(HOME, { id: SDACHA, title: 'contact point от хука', owner: SESSION });
store.upsertParticipant(HOME, SDACHA, store.participantRecord('worker:api', { name: 'w-sd' }));
const handedOver = spawnSync(process.execPath, [
  BIN, 'promptobus', 'guard', '--role', 'worker:api', '--task', SDACHA, '--home', HOME,
], {
  cwd: SB,
  input: JSON.stringify({ session_id: OWN_FULL, cwd: SB, hook_event_name: 'Stop' }),
  env: Object.fromEntries(Object.entries({
    ...process.env,
    PATH: `${STUB}${path.delimiter}${process.env.PATH}`,
    CLAUDE_CODE_MESSAGING_SOCKET: SDACHA_SOCK,
    CLAUDE_CODE_MESSAGING_TOKEN: 'sd',
  }).filter(([k]) => k !== 'CLAUDE_CODE_SESSION_ID')),
  encoding: 'utf8',
});
check(': contact point сдан с id сессии из нагрузки события, а не из окружения',
  handedOver.status === 0 && store.readWake(HOME, SDACHA, 'worker:api')?.session === OWN_FULL
  && store.readWake(HOME, SDACHA, 'worker:api')?.socket === SDACHA_SOCK,
  `status=${handedOver.status} ${handedOver.stderr} · ${JSON.stringify(store.readWake(HOME, SDACHA, 'worker:api'))}`);

// Каталога `waits/` у задачи нет вовсе — счётчик сторожа обязан завестись сам, а не
// упереться в отсутствующий каталог: молчаливый отказ записи обнулил бы страховку целиком.
const FRESH = 'guard-fresh-t20260829-130000';
store.createTask(HOME, { id: FRESH, title: 'счётчик заводится на пустом месте', owner: SESSION });
store.upsertParticipant(HOME, FRESH, store.participantRecord('worker:api', { name: WORKER_NAME }));
store.sendMessage(HOME, FRESH, { from: 'worker:api', to: 'orchestrator', type: 'result', body: 'итог' });
const fresh = cli({ PROMPTOBUS_TASK: FRESH });
check('waits/ ещё нет: ход возвращается на непрочитанном, счётчик заводится сам',
  fresh.status === 2 && /в mailbox'е 1/.test(fresh.stderr)
  && existsSync(guardMarkFile(HOME, FRESH, 'orchestrator')),
  `status=${fresh.status} ${fresh.stderr}`);

// Закрытая задача не стережётся: прислать туда больше нечего. Привязка после `promptobus done`
// не живёт, но объявленная PROMPTOBUS_TASK закрытие переживает.
store.closeTask(HOME, FRESH);
const closed = cli({ PROMPTOBUS_TASK: FRESH });
check(`закрытая задача: сторож молчит, хотя в mailbox'е лежит непрочитанное`,
  closed.status === 0 && closed.stderr === '', `status=${closed.status} ${closed.stderr}`);

// Рабочего места нет и PROMPTOBUS_HOME не задан — сторож молчит, а не падает: он стоит у каждого
// завершения хода, и запуск из чужого каталога не повод мешать сессии.
const NOWHERE = makeSandbox('promptobus-promptobus-guard-nowhere-');
const homeless = spawnSync(process.execPath, [BIN, 'guard'], {
  cwd: NOWHERE,
  env: Object.fromEntries(Object.entries({ ...process.env, CLAUDE_CODE_SESSION_ID: SESSION })
    .filter(([k]) => !['PROMPTOBUS_HOME', 'PROMPTOBUS_TASK', 'PROMPTOBUS_ROLE', ['ATI', 'AGENTS_ROOT'].join('_')].includes(k))),
  encoding: 'utf8',
});
check('вне workspace: молчит и выходит нулём, а не падает',
  homeless.status === 0 && homeless.stdout === '' && homeless.stderr === '',
  `status=${homeless.status} out=${JSON.stringify(homeless.stdout)} err=${JSON.stringify(homeless.stderr)}`);

// --- секция layout'а и живой прогон хука ---------------------------------------

// : команда хука живёт на диске дольше процесса, который её записал, поэтому
// бинарь в ней — из рабочего места. Пакета в фикстуре нет, и путь остаётся своим;
// проверяется здесь только то, что root доходит до layoutAgentsBin, а не игнорируется.
const PACK_BIN = path.join(here, '..', 'bin', 'promptobus.js');
const layoutHost = createStandaloneHost({ cwd: ROOT, binPath: PACK_BIN });
const guardRoot = path.join(SB, 'guard-root');
writeHostConfig(guardRoot);
const plantedBin = path.join(guardRoot, 'node_modules', 'promptobus', 'bin', 'promptobus.js');
mkdirSync(path.dirname(plantedBin), { recursive: true });
writeFileSync(plantedBin, '// stub entry\n');
const plantedHost = createStandaloneHost({ cwd: guardRoot, binPath: plantedBin });
check(': команда сторожа зовёт CLI, который назвал host, а не запущенный процесс',
  guardHookSettings(plantedHost)[GUARD_HOOK_EVENT][0].hooks[0].command.includes(`"${plantedBin}"`),
  guardHookSettings(plantedHost)[GUARD_HOOK_EVENT][0].hooks[0].command);

const section = guardHookSettings(layoutHost);
const group = section[GUARD_HOOK_EVENT][0];
check('секция: Stop и SessionStart в корне, одна группа на событие без матчера',
  Object.keys(section).length === 2 && section[GUARD_HOOK_EVENT].length === 1
  && section[GUARD_START_EVENT].length === 1
  && group.matcher === undefined && group.hooks.length === 1, JSON.stringify(section));
check('секция: SessionStart зовёт ту же команду, что и Stop',
  section[GUARD_START_EVENT][0].hooks[0].command === group.hooks[0].command,
  section[GUARD_START_EVENT][0].hooks[0].command);
check('секция: команда зовёт абсолютный node, абсолютный бинарь и подкоманду guard',
  group.hooks[0].type === 'command'
  && group.hooks[0].command === `"${process.execPath}" "${PACK_BIN}" promptobus guard`,
  group.hooks[0].command);

// Живой прогон связки: ровно та команда, которую layout кладёт в settings.json,
// запускается с полезной нагрузкой события `Stop` на stdin — так её зовёт Claude Code.
// Проверяем то, что увидит харнес: код 2 и причина в stderr. Замер по бинарю 2.1.251:
// код 2 даёт `blockingError` с текстом stderr, любой другой ненулевой код — всего лишь
// предупреждение, которое ход не возвращает.
send('question', 'живой прогон хука');
const hookRun = asHook(stopEvent());
check('живой прогон: событие Stop на stdin — код 2 и причина в stderr',
  hookRun.status === 2 && hookRun.stderr.includes(GUARD_MARK) && hookRun.stdout === '',
  `status=${hookRun.status} out=${JSON.stringify(hookRun.stdout)} err=${hookRun.stderr}`);

// Идентичность пришла ИЗ НАГРУЗКИ: переменной окружения в этом прогоне нет вовсе.
// Замер  про `CLAUDE_CODE_SESSION_ID` был снят на дочернем процессе MCP-сервера, а
// процессу хука эта переменная ничем не обещана — не окажись её, сторож молча не работал бы
// на каждом ходу, неотличимо от чистого прохода.
check('идентичность: session_id взят из нагрузки, а не из окружения',
  hookRun.stderr.includes(`задача=${TASK}`), hookRun.stderr);
const wrongSession = asHook(stopEvent('sess-postoronnyaya-9999'), { PROMPTOBUS_TASK: '' });
check('идентичность: чужой session_id из нагрузки привязки не находит — молчание',
  wrongSession.status === 0 && wrongSession.stdout === '' && wrongSession.stderr === '',
  `status=${wrongSession.status} out=${JSON.stringify(wrongSession.stdout)}`);
// Привязка на диске у SESSION уже есть (выше) — и по ней задача резолвится без PROMPTOBUS_TASK.
const boundByEvent = asHook(stopEvent(), { PROMPTOBUS_TASK: '' });
check('идентичность: по session_id из нагрузки находится привязка на диске',
  boundByEvent.status === 2 && boundByEvent.stderr.includes(`задача=${TASK}`),
  `status=${boundByEvent.status} ${boundByEvent.stderr}`);

// Нагрузки нет или она не разбирается — запасной путь через окружение. Так сторожа зовёт
// человек руками, и отказывать ему из-за пустого stdin незачем. Второе сообщение здесь не
// для красоты: два возврата на этом состоянии уже случились, и без смены состояния третий
// был бы законным пропуском — проверка молчала бы не о том.
send('status', 'второе — состояние стало другим');
const noPayload = spawnSync(process.execPath, [BIN, 'guard'], {
  cwd: SB,
  input: 'не json вовсе',
  env: {
    ...process.env,
    PATH: `${STUB}${path.delimiter}${process.env.PATH}`,
    PROMPTOBUS_HOME: HOME,
    PROMPTOBUS_TASK: TASK,
    PROMPTOBUS_ROLE: 'orchestrator',
    CLAUDE_CODE_SESSION_ID: SESSION,
  },
  encoding: 'utf8',
});
check('запасной путь: нагрузка не разобралась — идентичность берётся из окружения',
  noPayload.status === 2 && noPayload.stderr.includes(GUARD_MARK),
  `status=${noPayload.status} ${noPayload.stderr}`);
store.readInbox(HOME, TASK, 'orchestrator');

// Dest has no plugin settings merge. Standalone host does not plant Stop groups into
// a consumer's ~/.claude/settings.json — that is the host adapter's job.
check('standalone: секция сторожа самодостаточна — команда хука на месте',
  typeof group.hooks[0].command === 'string' && group.hooks[0].command.includes('guard'),
  group.hooks[0].command);

// Счётчик лежит внутри каталога задачи, а не в своём: уборка задачи метёт его вместе с
// остальным её состоянием.
check('счётчик лежит в waits/ каталога задачи',
  path.dirname(MARK_FILE) === path.join(store.taskDir(HOME, TASK), 'waits'),
  `${MARK_FILE} · ${store.taskDir(HOME, TASK)}`);
// Имя — адрес плюс суффикс, и двоеточие в имени файла уступает дефису (Windows). У двух
// адресов одной задачи счётчики поэтому разные: общий сбрасывался бы чужим ходом.
const workerMark = guardMarkFile(HOME, TASK, 'worker:api');
check('счётчик назван по адресу: двоеточие уступает дефису, суффикс .guard.json',
  path.basename(MARK_FILE) === 'orchestrator.guard.json'
  && path.basename(workerMark) === 'worker-api.guard.json',
  `${path.basename(MARK_FILE)} · ${path.basename(workerMark)}`);

// --- : сторож переезд не инициирует ------------------------------------
//
// Доклада отсюда не увидит никто: при коде 0 stderr хука никуда не поднимается, а переезд
// обещан пользователю числами. Сторож поэтому дом резолвит, а store не двигает — и на
// рабочем месте, которому переезд нужен, молча пропускает ход.
// --- leftover foreign store: standalone host has no legacyLayout, so guard
// neither migrates nor skips the live mailbox. ---------------------------------
const MIG_ROOT = path.join(ROOT, 'ne-dvigay');
writeHostConfig(MIG_ROOT);
const MIG_LEFTOVER = path.join(MIG_ROOT, 'legacy', 'a2a');
const MIG_TASK = 'guard-migr-t20260902-100000';
const { legacy } = await import(path.join(here, '..', 'dist', 'index.js'));
legacy.createTask(MIG_LEFTOVER, { id: MIG_TASK, title: 'store прежней шины', owner: SESSION });
legacy.upsertParticipant(MIG_LEFTOVER, MIG_TASK, { address: 'worker:api', name: WORKER_NAME });
legacy.sendMessage(MIG_LEFTOVER, MIG_TASK, {
  from: 'worker:api', to: 'orchestrator', type: 'result', body: 'непрочитанное прежнего store',
});
legacy.closeTask(MIG_LEFTOVER, MIG_TASK);
const beforeGuard = readdirSync(path.join(MIG_LEFTOVER, 'tasks')).sort();

const migRun = spawnSync(process.execPath, [BIN, 'guard'], {
  cwd: MIG_ROOT,
  env: {
    ...process.env,
    PATH: `${STUB}${path.delimiter}${process.env.PATH}`,
    PROMPTOBUS_HOME: path.join(MIG_ROOT, '.promptobus'),
    PROMPTOBUS_TASK: MIG_TASK,
    PROMPTOBUS_ROLE: 'orchestrator',
    CLAUDE_CODE_SESSION_ID: SESSION,
  },
  input: JSON.stringify({ session_id: SESSION, cwd: MIG_ROOT }),
  encoding: 'utf8',
});

check(': leftover foreign store: standalone guard does not migrate it',
  existsSync(MIG_LEFTOVER)
  && readdirSync(path.join(MIG_LEFTOVER, 'tasks')).sort().join(',') === beforeGuard.join(','),
  `legacy ${existsSync(MIG_LEFTOVER) ? 'kept' : 'gone'} · guard ${migRun.status} ${migRun.stderr}`);
check(': leftover foreign store: guard does not treat it as the live mailbox',
  migRun.status === 0 && !migRun.stderr.includes(GUARD_MARK),
  `код ${migRun.status} · out «${migRun.stdout.trim()}» · err «${migRun.stderr.trim()}»`);

// Unread in the live .promptobus still returns the turn even if a leftover catalog sits nearby.
const BOTH_ROOT = path.join(ROOT, 'oba-kornya');
writeHostConfig(BOTH_ROOT);
const BOTH_HOME = path.join(BOTH_ROOT, '.promptobus');
const BOTH_TASK = 'guard-oba-t20260902-101000';
store.createTask(BOTH_HOME, { id: BOTH_TASK, title: 'оба корня сразу', owner: SESSION });
store.upsertParticipant(BOTH_HOME, BOTH_TASK, store.participantRecord('worker:api', { name: WORKER_NAME }));
store.sendMessage(BOTH_HOME, BOTH_TASK, {
  from: 'worker:api', to: 'orchestrator', type: 'result', body: 'непрочитанное в новом корне',
});
mkdirSync(path.join(BOTH_ROOT, 'legacy', 'a2a', 'tasks'), { recursive: true });

const bothRun = spawnSync(process.execPath, [BIN, 'guard'], {
  cwd: BOTH_ROOT,
  env: {
    ...process.env,
    PATH: `${STUB}${path.delimiter}${process.env.PATH}`,
    PROMPTOBUS_HOME: BOTH_HOME,
    PROMPTOBUS_TASK: BOTH_TASK,
    PROMPTOBUS_ROLE: 'orchestrator',
    CLAUDE_CODE_SESSION_ID: SESSION,
  },
  input: JSON.stringify({ session_id: SESSION, cwd: BOTH_ROOT }),
  encoding: 'utf8',
});

check(': leftover catalog does not skip the live mailbox — unread still returns the turn',
  bothRun.status === 2 && /в mailbox'е 1/.test(bothRun.stderr)
  && store.countInbox(BOTH_HOME, BOTH_TASK, 'orchestrator') === 1,
  `код ${bothRun.status} · out «${bothRun.stdout.trim()}» · err «${bothRun.stderr.trim()}»`
  + ` · непрочитано ${store.countInbox(BOTH_HOME, BOTH_TASK, 'orchestrator')}`);
check(': leftover catalog and live store both stay on disk',
  existsSync(path.join(BOTH_ROOT, 'legacy', 'a2a')) && existsSync(BOTH_HOME));

// --- преемник оркестратора: детектор в корне, не авто-claim --------------------
const SUCC = 'succ-t20260904-010000';
const OLD_ORCH = 'sess-old-orch-aaaa';
const HEIR = 'sess-heir-bbbb';
const WORKER_SID = 'sess-worker-succ-cccc';
const asHeir = (session, { cwd = SB, role = '', task = '', event = 'Stop' } = {}) => spawnSync(
  process.execPath, [BIN, 'guard'], {
    cwd,
    input: JSON.stringify({ session_id: session, cwd, hook_event_name: event }),
    env: Object.fromEntries(Object.entries({
      ...process.env,
      PATH: `${STUB}${path.delimiter}${process.env.PATH}`,
      PROMPTOBUS_HOME: HOME,
      PROMPTOBUS_TASK: task,
      PROMPTOBUS_ROLE: role,
    }).filter(([k, v]) => k !== 'CLAUDE_CODE_SESSION_ID' && v !== '')),
    encoding: 'utf8',
  },
);
const heirSaid = (run) => { try { return JSON.parse(run.stdout); } catch { return null; } };

let probeCalls = 0;
const countingProbe = async (socket) => {
  probeCalls += 1;
  return probeContactPoint(socket);
};
await successorVerdict(HOME, SB, HEIR, undefined, countingProbe);
check('преемник: живой владелец — probe не зовётся',
  probeCalls === 0, String(probeCalls));

const liveOwner = asHeir(HEIR);
check('преемник: владелец жив — сторож чужой сессии в корне молчит',
  liveOwner.status === 0 && liveOwner.stdout === '' && liveOwner.stderr === '',
  `status=${liveOwner.status} out=${JSON.stringify(liveOwner.stdout)} err=${JSON.stringify(liveOwner.stderr)}`);

const START_SID = 'sess-bound-start-dddd';
const START_TASK = 'start-t20260904-030000';
store.createTask(HOME, { id: START_TASK, title: 'SessionStart не сторожит', owner: START_SID });
store.upsertParticipant(HOME, START_TASK, store.participantRecord('worker:api', { name: 'w-start' }));
store.sendMessage(HOME, START_TASK, {
  from: 'worker:api', to: 'orchestrator', type: 'result', body: 'непрочитанное на старте',
});
store.bindIfOwner(HOME, START_TASK, START_SID);
const startBound = asHeir(START_SID, { event: 'SessionStart', role: 'orchestrator', task: START_TASK });
const startBoundMark = guardMarkFile(HOME, START_TASK, 'orchestrator');
check('преемник: SessionStart у сессии с живой привязкой ход не возвращает',
  startBound.status === 0 && !startBound.stderr.includes(GUARD_MARK)
  && !existsSync(startBoundMark),
  `status=${startBound.status} err=${JSON.stringify(startBound.stderr)} mark=${existsSync(startBoundMark)}`);

store.createTask(HOME, { id: SUCC, title: 'преемник после смены id', owner: OLD_ORCH });
store.upsertParticipant(HOME, SUCC, store.participantRecord('worker:api', {
  name: 'w-succ', session: WORKER_SID,
}));
store.writeWake(HOME, SUCC, 'orchestrator', {
  socket: path.join(ROOT, 'dead-orch.sock'), token: 't', session: OLD_ORCH,
});
store.writeHealth(HOME, SUCC, {
  orchestrator: { channel: 'self-wake', knockError: 'ENOENT', triedAt: '2026-09-03T20:31:43.000Z' },
});
store.sendMessage(HOME, SUCC, { from: 'worker:api', to: 'orchestrator', type: 'result', body: 'итог преемнику' });

const emptyDead = 'empty-t20260904-040000';
store.createTask(HOME, { id: emptyDead, title: 'мёртвый без непрочитанного', owner: OLD_ORCH });
store.writeWake(HOME, emptyDead, 'orchestrator', {
  socket: path.join(ROOT, 'empty-dead.sock'), token: 't', session: OLD_ORCH,
});

const deadHint = asHeir(HEIR);
const deadText = heirSaid(deadHint)?.systemMessage ?? '';
check('преемник: сокет владельца ENOENT — сторож печатает id задачи и команду claim',
  deadHint.status === 0 && deadHint.stderr === ''
  && deadText.includes(SUCC) && deadText.includes('преемник после смены id')
  && deadText.includes(OLD_ORCH) && deadText.includes('2026-09-03T20:31:43.000Z')
  && /непрочитанных 1/.test(deadText)
  && deadText.includes('promptobus_mailbox {claim: true}')
  && !deadText.includes(emptyDead),
  `status=${deadHint.status} out=${JSON.stringify(deadHint.stdout)} err=${JSON.stringify(deadHint.stderr)}`);
check('преемник: ход не возвращается — чужая сессия в корне не обязана быть преемником',
  deadHint.status === 0 && !deadHint.stderr.includes(GUARD_MARK),
  `status=${deadHint.status} ${deadHint.stderr}`);

const HEIR2 = 'sess-heir-eeee';
const otherHeir = asHeir(HEIR2);
const otherText = heirSaid(otherHeir)?.systemMessage ?? '';
check('преемник: вторая сессия в корне на том же состоянии тоже получает hint',
  otherHeir.status === 0 && otherText.includes(SUCC) && otherText.includes('promptobus_mailbox {claim: true}'),
  `status=${otherHeir.status} out=${JSON.stringify(otherHeir.stdout)}`);

const deadHintAgain = asHeir(HEIR);
check('преемник: второй конец хода на том же состоянии молчит',
  deadHintAgain.status === 0 && deadHintAgain.stdout === '' && deadHintAgain.stderr === '',
  `status=${deadHintAgain.status} out=${JSON.stringify(deadHintAgain.stdout)}`);

const workerHint = asHeir(WORKER_SID, { role: 'worker:api', task: SUCC });
check('преемник: сессия-участник — сторож молчит, даже при мёртвом оркестраторе',
  workerHint.status === 0 && workerHint.stdout === '' && workerHint.stderr === '',
  `status=${workerHint.status} out=${JSON.stringify(workerHint.stdout)} err=${JSON.stringify(workerHint.stderr)}`);

store.sendMessage(HOME, SUCC, { from: 'worker:api', to: 'orchestrator', type: 'status', body: 'ещё одно' });
const startHint = asHeir(HEIR, { event: 'SessionStart' });
const startOut = heirSaid(startHint);
const startText = startOut?.hookSpecificOutput?.additionalContext ?? startOut?.systemMessage ?? '';
check('преемник: SessionStart в корне несёт тот же текст в additionalContext',
  startHint.status === 0 && startText.includes(SUCC) && startText.includes('promptobus_mailbox {claim: true}')
  && startOut?.hookSpecificOutput?.hookEventName === 'SessionStart',
  `status=${startHint.status} out=${JSON.stringify(startHint.stdout)}`);

const elsewhere = path.join(ROOT, 'not-root');
mkdirSync(elsewhere, { recursive: true });
const otherCwd = asHeir(HEIR, { cwd: elsewhere });
check('преемник: cwd не корень workspace — молчит',
  otherCwd.status === 0 && otherCwd.stdout === '' && otherCwd.stderr === '',
  `status=${otherCwd.status} out=${JSON.stringify(otherCwd.stdout)}`);

const verdictLine = successorLine(
  { id: SUCC, title: 'преемник после смены id' }, OLD_ORCH, '2026-09-03T20:31:43.000Z', 2,
);
check('преемник: successorLine называет задачу, владельца, время и claim',
  verdictLine.includes(SUCC) && verdictLine.includes(OLD_ORCH)
  && verdictLine.includes('promptobus_mailbox {claim: true}'),
  verdictLine);
const direct = await successorVerdict(HOME, SB, HEIR);
check('преемник: successorVerdict видит мёртвый сокет SUCC и молчит про живой TASK',
  typeof direct === 'string' && direct.includes(SUCC) && !direct.includes(TASK),
  String(direct));
check('преемник: mailbox после hint не тронут — сторож не читатель и не claim',
  store.countInbox(HOME, SUCC, 'orchestrator') === 2
  && store.taskOwner(HOME, SUCC) === OLD_ORCH,
  `${store.countInbox(HOME, SUCC, 'orchestrator')} · ${store.taskOwner(HOME, SUCC)}`);
orchLive.close();
