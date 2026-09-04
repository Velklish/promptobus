#!/usr/bin/env node
// Живая проверка driver'а Cursor на настоящем `agent`. Запуск:
//
//   node scripts/live-cursor.mjs [--model <id>]
//
// В `npm test` не входит и входить не будет: она поднимает живые сессии Cursor, тратит
// лимиты аккаунта и пишет в дом человека то, что пишет туда сам Cursor.
//
// **Почему не `live-e2e.mjs --harness cursor`.** Тот прогон — тот же сценарий, что у
// подставного harness'а ([scenario.mjs](../test/scenario.mjs)), и собран он под Claude Code
// целиком: свой messaging-сокет оркестратора, снимок сессий списком, ходы стопа
// `permission` и `limit`, которых у Cursor нет по природе. Прогнать его вторым harness'ом
// значило бы править сам сценарий, а не его чтения, — а вердикты и пороги сценария не
// двигаются. Здесь поэтому свой круг, короче и про своё: подъём участника Cursor, круг
// шины из его живой persist-сессии, пробуждение инъекцией, вход человека, доставка в идущий
// ход, read-only reviewer'а, чтение скилла из `.cursor/skills` своего `--workspace` и уборка.
//
// Что прогон проверяет и чего не проверяет. Проверяет: что механизм поднимает живую
// persist-сессию настоящим бинарём и находит её среди чужих, что шина доезжает до неё
// вызовом инструмента (а не текстом ответа), что надзиратель будит простаивающую сессию
// инъекцией и без нового процесса, что человек входит в ту же сессию вторым клиентом, что
// сообщение во время хода доходит и исполняется следующим ходом, что deny reviewer'а
// держится, что участник читает скилл из `.cursor/skills` своего `--workspace` (заглушка
// в каноне, маркер в первом сообщении шины), и что после круга на машине не остаётся ни
// сессий, ни процессов, ни записей реестра — а сессии человека целы. Не проверяет качество
// рассуждения модели: сверки идут по маркеру в начале тела.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { makeSandbox, writeHostConfig, resolveToolBin } from '../test/sandbox.mjs';
import { dropSessionLeaks, SESSION_LEAK_VARS } from '../test/hygiene.mjs';
import { buildWorkspace, cli, MECHANISM_ROOT, PROMPTOBUS_BIN, store } from '../test/scenario.mjs';
import { waitFor } from '../test/harness.mjs';
import { sweepPreviousRuns } from './canary-runs.mjs';
import { addrKey } from '../test/harness-cursor.mjs';

const { cursorDriver, reviewSandbox } = await import(path.join(MECHANISM_ROOT, 'lib', 'driver-cursor.js'));
const {
  cursorStateHome, listSessions, readSession, reapOrphans, sessionMarker, tmux, transcriptOf,
} = await import(path.join(MECHANISM_ROOT, 'lib', 'cursor-persist.js'));

// Модель называется флагом, а не берётся дефолтом driver'а: живую проверку гоняют на той,
// которую назвал владелец, и она уезжает в отчёт.
const argv = process.argv.slice(2);
const at = argv.indexOf('--model');
const MODEL = at >= 0 && at + 1 < argv.length ? argv[at + 1] : 'cursor-grok-4.6-xhigh-fast';

const tool = resolveToolBin('cursor');
if (!tool.ok) {
  console.error(`✖ живой прогон нечем гнать: ${tool.reason}`);
  process.exit(1);
}

// Идентичность сессии снимается со своего окружения тем же перечнем, что у набора
//: прогон гонят как раз из сессии, у которой все пять переменных стоят, и
// утёкший `PROMPTOBUS_TASK` увёл бы команды песочницы на задачу боевого run'а.
const leaked = SESSION_LEAK_VARS.filter((name) => name in process.env);
dropSessionLeaks(process.env);

const verdicts = [];
const times = [];
function check(name, cond, detail = '') {
  const ok = !!cond;
  verdicts.push({ name, ok, detail: ok ? '' : String(detail).slice(0, 600) });
  process.stdout.write(`${ok ? '✔' : '✖'} ${name}${ok ? '' : ` — ${String(detail).slice(0, 600)}`}\n`);
}
function at_(name, ms) {
  times.push(`${name} ${(ms / 1000).toFixed(1)} с`);
  process.stdout.write(`  · ${name}: ${(ms / 1000).toFixed(1)} с\n`);
}

// Снимок дома человека: что Cursor туда пишет, отчёт называет поимённо. Абсолютных меток
// времени тут не нужно — сравниваются составы каталогов до и после.
const CURSOR_HOME = path.join(homedir(), '.cursor');
function snapshotHome() {
  const listing = (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  return {
    chats: new Set(listing(path.join(CURSOR_HOME, 'chats'))),
    projects: new Set(listing(path.join(CURSOR_HOME, 'projects'))),
  };
}
const before = snapshotHome();

// Реестр сессий механизма живёт в доме человека и в живом прогоне НЕ уводится: предмет
// проверки — то, как это работает у пользователя. Что после круга там ничего не осталось,
// прогон и сверяет — составами до и после.
const STATE_HOME = cursorStateHome();
function snapshotState() {
  try {
    return readdirSync(path.join(STATE_HOME, 'sessions'));
  } catch {
    return [];
  }
}
const stateBefore = snapshotState();

// Persist-сессии на общем сервере до прогона: рядом законно живут сессии человека, и
// вычитать их обязательно — «список пуст» после круга было бы неверным вердиктом на машине,
// где человек работает своей сессией.
const sessionsBefore = new Set(listSessions().map((s) => s.name));

const SB = makeSandbox('promptobus-live-cursor-');
// Журналы ходов переживают прогон: песочница сносится, а поток нужен для разбора красного.
const LOGS_PREFIX = 'promptobus-live-cursor-logs-';
const KEPT_LOGS = path.join(tmpdir(), `${LOGS_PREFIX}${process.pid}`);
const TASK = `livecursor-t${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
const WORKER = 'worker:live';
const REVIEWER = 'reviewer:live';
const ORCH_SESSION = `orch-live-cursor-${process.pid}`;
const MARK = {
  hello: 'LIVE-CURSOR-HELLO',
  skill: 'LIVE-CURSOR-SKILL',
  woke: 'LIVE-CURSOR-WOKE',
  pairA: 'LIVE-CURSOR-PAIR-A',
  pairB: 'LIVE-CURSOR-PAIR-B',
  review: 'LIVE-CURSOR-REVIEW',
};

const { ws, repoAbs, repo } = buildWorkspace(SB);
writeHostConfig(ws, { tools: ['claude', 'cursor'] });
mkdirSync(path.join(ws, '.cursor', 'skills', 'live-cursor-probe'), { recursive: true });
writeFileSync(path.join(ws, '.cursor', 'skills', 'live-cursor-probe', 'SKILL.md'),
  `---\nname: live-cursor-probe\ndescription: заглушка живого прогона Cursor — верни маркер в первом сообщении шины\n---\n\nМаркер этого скилла: ${MARK.skill}\n`);
const home = path.join(ws, '.promptobus');

const workerBrief = path.join(SB, 'worker-brief.md');
writeFileSync(workerBrief, `# Живая проверка круга шины из Cursor

Ты участник шины Promptobus. Сделай ровно это и ничего сверх:

1. Прочитай скилл \`live-cursor-probe\` в \`.cursor/skills\` своего рабочего каталога.
2. Отправь оркестратору сообщение типа status с телом, начинающимся строкой «${MARK.hello}»,
   и включи в это же тело маркер из того скилла.
3. Закончи ход.

Дальше тебе будут приходить сообщения. На каждое: забери mailbox, прочитай, что в нём
просят, и отправь оркестратору сообщение типа result с телом, начинающимся ровно той
строкой-маркером, которую сообщение назвало. Маркер ставь ПЕРВОЙ строкой тела и ничего перед
ним не пиши. Одно сообщение — один result. Больше ничего не делай.
`);

const env = { ...process.env, PROMPTOBUS_HOME: home, CLAUDE_CODE_SESSION_ID: ORCH_SESSION };
const wardenEnv = { ...env };
delete wardenEnv.PROMPTOBUS_WARDEN;

store.createTask(home, { id: TASK, title: 'живая проверка driver’а Cursor', owner: ORCH_SESSION });
const warden = spawn(process.execPath, [PROMPTOBUS_BIN, 'warden', '--task', TASK], {
  cwd: ws, detached: true, stdio: 'ignore', env: wardenEnv,
});
warden.unref();

process.stdout.write(`▸ живой прогон Cursor: ${tool.path}${tool.version ? ` (${tool.version})` : ''}\n`);
process.stdout.write(`▸ модель: ${MODEL}\n`);
process.stdout.write(`▸ механизм: ${MECHANISM_ROOT}\n`);
process.stdout.write(`▸ песочница: ${SB} · store: ${home}\n`);
if (leaked.length) process.stdout.write(`▸ снято с окружения прогона: ${leaked.join(', ')}\n`);

// Стенограммы обоих участников — в каталог, переживающий прогон. Под persist они и есть тот
// поток, по которому разбирают красное: своего журнала ходов механизм больше не ведёт.
// Копия нужна потому, что путь стенограммы лежит в записи сессии, а её снимает гашение —
// после круга найти файл в доме Cursor не по чему. Зовётся из `finally`, поэтому молчит на
// любой неожиданности: диагностика не вправе уронить уборку.
const transcripts = new Map();
function rememberTranscript(addr) {
  try {
    const kept = store.participantOf(store.readTask(home, TASK), addr)?.sessionRef;
    const from = kept ? transcriptOf(readSession(kept) ?? {}) : null;
    if (from) transcripts.set(addr, from);
    return from;
  } catch {
    return null;
  }
}

function keepTranscripts() {
  for (const addr of [WORKER, REVIEWER]) {
    try {
      const from = transcripts.get(addr) ?? rememberTranscript(addr);
      if (!from || !existsSync(from)) continue;
      mkdirSync(KEPT_LOGS, { recursive: true });
      copyFileSync(from, path.join(KEPT_LOGS, `${addrKey(addr)}.jsonl`));
    } catch {
      // Стенограммы нет либо каталог не создался — прогон это не отменяет.
    }
  }
}

let ref = '';
let sandboxDir = '';
// Метки сессий ЭТОГО прогона: `~/legacy/cursor/sessions/` общий на все persist-сессии
// механизма на машине, и судить leftover по нему нельзя (замер ниже).
const probeMarks = [];
function rememberProbeMarks() {
  for (const addr of [WORKER, REVIEWER]) {
    try {
      const kept = store.participantOf(store.readTask(home, TASK), addr)?.sessionRef;
      const mark = kept ? sessionMarker(readSession(kept) ?? {}) : null;
      if (mark && !probeMarks.includes(mark)) probeMarks.push(mark);
    } catch {
      // Записи уже нет — метку не восстановить, leftover тогда судится каталогом прогона.
    }
  }
}
const t0 = Date.now();
try {
  const live = await waitFor(() => store.liveWarden(home, TASK), { timeoutMs: 30000 });
  check('шаг 1: надзиратель задачи поднят настоящим процессом', !!live?.pid, JSON.stringify(live));

  // --- шаг 2: подъём участника Cursor ------------------------------------------------
  const t2 = Date.now();
  const spawned = cli([ 'spawn', '--repo', repo, '--brief', workerBrief, '--task', TASK,
    '--worker', 'live', '--harness', 'cursor', '--model', MODEL], { cwd: ws, env });
  check('шаг 2: promptobus spawn --harness cursor поднял живого участника',
    spawned.status === 0 && /worker worker:live поднят/.test(spawned.out), spawned.out.slice(-600));
  at_('подъём участника', Date.now() - t2);

  const wp = store.participantOf(store.readTask(home, TASK), WORKER);
  ref = wp?.sessionRef ?? '';
  const record = readSession(ref);
  check('шаг 2: persist-сессия поднята, чат опознан, и оба лежат в записи участника',
    !!record?.sessionName && !!record?.chatId
    && wp?.metadata?.session === record.sessionName && wp?.metadata?.sessionId === record.chatId,
    `${JSON.stringify(record)} · ${wp?.metadata?.session} · ${wp?.metadata?.sessionId}`);

  const mine = listSessions().find((s) => s.name === record?.sessionName) ?? null;
  check('шаг 2: сессия видна в списке tmux, помечена задачей и адресом, и её чат тот же',
    !!mine && mine.managed && mine.task === TASK && mine.address === WORKER && mine.chatId === record?.chatId,
    JSON.stringify(listSessions()));

  const listOut = spawnSync(tool.path, ['persist', 'list'], { encoding: 'utf8' });
  check('шаг 2: сессию механизма видно человеческим agent persist list — она на общем сервере',
    listOut.status === 0 && String(listOut.stdout ?? '').includes((record?.sessionName || 'имени-нет')),
    String(listOut.stdout ?? '').slice(-500));

  check('шаг 2: одноразовая панель-поставщик pty погашена — на своём сервере пусто',
    listSessions({ server: 'promptobus-launch' }).length === 0,
    JSON.stringify(listSessions({ server: 'promptobus-launch' })));

  const statusOut = cli([ 'status', '--task', TASK], { cwd: ws, env });
  check('шаг 2: promptobus status показывает живость сессии Cursor',
    statusOut.status === 0 && statusOut.out.includes(WORKER) && /сесси/.test(statusOut.out),
    statusOut.out.slice(-500));

  const liveWt = wp?.metadata?.worktree ?? '';
  check('шаг 2: заглушка скилла легла в worktree участника',
    existsSync(path.join(liveWt, '.cursor', 'skills', 'live-cursor-probe', 'SKILL.md'))
    && readFileSync(path.join(liveWt, '.cursor', 'skills', 'live-cursor-probe', 'SKILL.md'), 'utf8').includes(MARK.skill),
    liveWt);

  // --- шаг 3: круг шины из живой сессии Cursor ---------------------------------------
  const t3 = Date.now();
  const hello = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
    .find((m) => String(m.body ?? '').includes(MARK.hello)) ?? null, { timeoutMs: 300000 });
  check('шаг 3: result первого хода дошёл до оркестратора — круг шины из Cursor замкнулся',
    !!hello, JSON.stringify(hello ?? readSession(ref)?.last));
  check('шаг 3: участник прочитал скилл из своего .cursor/skills — маркер в первом сообщении',
    !!hello && String(hello.body ?? '').includes(MARK.skill),
    JSON.stringify(hello ?? readSession(ref)?.last));
  at_('первый ход участника', Date.now() - t3);

  // Признак «шина доехала ИНСТРУМЕНТОМ» — вызов в стенограмме, а не факт доставки: под
  // `--force` модель вправе поднять сервер шины шеллом сама, и сообщение в сторе выглядело бы
  // так же. Потока `stream-json` под persist нет вовсе, поэтому читается стенограмма.
  const toolCalls = () => {
    const file = transcriptOf(readSession(ref) ?? {});
    if (!file || !existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return [];
      }
      return (event?.message?.content ?? []).filter((c) => c?.type === 'tool_use')
        .map((c) => JSON.stringify(c).slice(0, 400));
    });
  };
  const calledBus = await waitFor(() => (toolCalls().some((n) => /promptobus/.test(String(n))) ? toolCalls() : null),
    { timeoutMs: 120000 });
  check('шаг 3: шина позвана ИНСТРУМЕНТОМ — вызов виден в стенограмме чата',
    !!calledBus, `вызовы стенограммы: ${JSON.stringify(toolCalls()).slice(0, 500)}`);
  rememberTranscript(WORKER);

  // --- шаг 4: пробуждение инъекцией в живую сессию ------------------------------------
  const t4 = Date.now();
  const paneWas = readSession(ref)?.panePid ?? null;
  store.sendMessage(home, TASK, {
    from: 'orchestrator', to: WORKER, type: 'answer',
    body: `Разбудили. Забери mailbox и ответь оркестратору сообщением типа result с телом, начинающимся строкой «${MARK.woke}».`,
  });
  // Сверка по ТИПУ и НАЧАЛУ тела, а не по вхождению: живая модель пересказывает следующий
  // шаг своими словами и в первом же ходе цитирует маркер второго — вхождение тогда ловит
  // не тот ход, и вердикт зеленеет ни на чём (замер 2026-09-03: первый прогон так и дал
  // «пробуждение 0,0 с»).
  const woke = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
    .find((m) => m.type === 'result' && String(m.body ?? '').trimStart().startsWith(MARK.woke)) ?? null,
  { timeoutMs: 300000 });
  check('шаг 4: надзиратель разбудил сессию Cursor инъекцией, и участник ответил',
    !!woke, `${JSON.stringify(readSession(ref)?.last)} · ${store.tailWardenLog(home, TASK).slice(-6).join(' | ')}`);
  // Главное отличие от headless: нового ПРОЦЕССА пробуждение не заводит. Панель
  // сессии та же — значит контекст не регидратировался, и это тот самый выигрыш, ради
  // которого driver и переведён на persist.
  check('шаг 4: пробуждение прошло БЕЗ нового процесса — панель сессии та же',
    !!paneWas && readSession(ref)?.panePid === paneWas
    && listSessions().some((s) => s.name === record?.sessionName && s.panePid === paneWas),
    `${paneWas} → ${readSession(ref)?.panePid} · ${JSON.stringify(listSessions())}`);
  check('шаг 4: mailbox участник забрал сам — доставку подтверждает он',
    store.countInbox(home, TASK, WORKER) === 0, String(store.countInbox(home, TASK, WORKER)));
  at_('пробуждение и второй ход', Date.now() - t4);

  // --- шаг 4б: вход человека в ту же сессию -------------------------------------------
  //
  // Вход моделируется вторым клиентом из одноразовой панели механизма: живьём человек делает
  // ровно это из своего терминала. Плата названа в отчёте спайка — tmux ужимает окно до
  // самого узкого клиента, — поэтому панель входа поднимается широкой.
  const t4b = Date.now();
  const seat = `promptobus-live-attach-${process.pid}`;
  tmux(['new-session', '-d', '-s', seat, '-x', '200', '-y', '50',
    `${tool.path} persist attach ${record?.sessionName}`], { server: 'promptobus-launch' });
  const attached = await waitFor(() => {
    const s = listSessions().find((x) => x.name === record?.sessionName);
    return s && s.attached > 0 ? s : null;
  }, { timeoutMs: 30000 });
  check('шаг 4б: человек входит в живую сессию — attach даёт второго клиента',
    !!attached, `${JSON.stringify(listSessions())} · панель входа: ${JSON.stringify(listSessions({ server: 'promptobus-launch' }))}`);
  tmux(['kill-session', '-t', seat], { server: 'promptobus-launch' });
  const leftSeat = await waitFor(() => {
    const s = listSessions().find((x) => x.name === record?.sessionName);
    return s && s.attached === 0 ? s : null;
  }, { timeoutMs: 30000 });
  check('шаг 4б: человек вышел, а сессия осталась живой — она переживает своих клиентов',
    !!leftSeat, JSON.stringify(listSessions()));
  at_('вход человека и выход', Date.now() - t4b);

  // --- шаг 4в: доставка ВО ВРЕМЯ хода --------------------------------------------------
  //
  // Разрыв с Claude Code сузился до «ждёт конца хода»: текст встаёт в очередь сессии и
  // исполняется отдельным ходом сразу после текущего. Проверяется это двумя доставками
  // подряд — вторая уходит, пока идёт ход первой, — и тем, что процесс за обе не сменился.
  const t4c = Date.now();
  store.sendMessage(home, TASK, {
    from: 'orchestrator', to: WORKER, type: 'answer',
    body: `Первое из пары. Забери mailbox и ответь оркестратору result с телом, начинающимся строкой «${MARK.pairA}».`,
  });
  const first = await cursorDriver.activate({ ref }, {
    kind: 'unread', task: TASK, address: WORKER, unread: 1, messages: [],
  });
  check('шаг 4в: первая доставка ушла в простаивающую сессию', first?.ok === true, JSON.stringify(first));
  // Ждём, пока ход и правда пойдёт: инъекция в НЕидущий ход разрыва не проверяет.
  const busy = await waitFor(() => (cursorDriver.inspect(ref)?.busy ? cursorDriver.inspect(ref) : null),
    { timeoutMs: 60000 });
  check('шаг 4в: ход участника пошёл — есть во что доставлять', !!busy, JSON.stringify(cursorDriver.inspect(ref)));
  store.sendMessage(home, TASK, {
    from: 'orchestrator', to: WORKER, type: 'answer',
    body: `Второе из пары, пришло во время хода. Ответь оркестратору result с телом, начинающимся строкой «${MARK.pairB}».`,
  });
  const second = await cursorDriver.activate({ ref }, {
    kind: 'unread', task: TASK, address: WORKER, unread: 1, messages: [],
  });
  check('шаг 4в: доставка в ИДУЩИЙ ход проходит, а не отвергается «ход идёт»',
    second?.ok === true, `${JSON.stringify(second)} · ${JSON.stringify(cursorDriver.inspect(ref))}`);
  const pairA = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
    .find((m) => m.type === 'result' && String(m.body ?? '').trimStart().startsWith(MARK.pairA)) ?? null,
  { timeoutMs: 300000 });
  const pairB = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
    .find((m) => m.type === 'result' && String(m.body ?? '').trimStart().startsWith(MARK.pairB)) ?? null,
  { timeoutMs: 300000 });
  check('шаг 4в: оба сообщения разобраны — второе следующим ходом, без нового процесса',
    !!pairA && !!pairB && readSession(ref)?.panePid === paneWas,
    `${JSON.stringify(pairA)} · ${JSON.stringify(pairB)} · панель ${paneWas} → ${readSession(ref)?.panePid}`);
  at_('пара сообщений подряд', Date.now() - t4c);

  // --- шаг 4г: гонка двух инъекций ------------------------------------------------------
  //
  // Открытый вопрос 4 отчёта спайка: что будет, если в одну сессию пишут двое. Ответ
  // механизма — лок на инъекцию: writer у сессии один, иначе текст второй лёг бы в поле
  // ввода поверх первой, между её вставкой и Enter, и в стенограмму ушло бы одно склеенное
  // сообщение.
  const race = await Promise.all([1, 2].map(() => cursorDriver.activate({ ref }, {
    kind: 'unread', task: TASK, address: WORKER, unread: 1, messages: [],
  })));
  check('шаг 4г: две инъекции разом — одна доставлена, вторая отказала локом',
    race.filter((r) => r.ok).length === 1 && /уже пишет процесс/.test(String(race.find((r) => !r.ok)?.error)),
    JSON.stringify(race));

  // --- шаг 5: reviewer Cursor и его read-only ----------------------------------------
  const t5 = Date.now();
  const wt = wp?.metadata?.worktree ?? repoAbs;
  writeFileSync(path.join(wt, 'live-note.md'), `# ${MARK.hello}\n\nПравка для предмета ревью.\n`);
  spawnSync('git', ['-C', wt, '-c', 'user.name=live', '-c', 'user.email=live@example.invalid', 'add', '-A'], { encoding: 'utf8' });
  spawnSync('git', ['-C', wt, '-c', 'user.name=live', '-c', 'user.email=live@example.invalid', 'commit', '-m', 'live: предмет ревью'], { encoding: 'utf8' });

  const reviewed = cli([ 'review', wt, '--task', TASK, '--harness', 'cursor', '--model', MODEL],
    { cwd: ws, env });
  check('шаг 5: promptobus review --harness cursor поднял живого reviewer’а',
    reviewed.status === 0 && /reviewer reviewer:live поднят/.test(reviewed.out), reviewed.out.slice(-600));
  sandboxDir = reviewSandbox(store.participantSettingsPath(home, TASK, REVIEWER));
  check('шаг 5: песочница reviewer’а — git-каталог со своим deny',
    existsSync(path.join(sandboxDir, '.git'))
    && /Write\(\*\*\)/.test(readFileSync(path.join(sandboxDir, '.cursor', 'cli.json'), 'utf8')),
    sandboxDir);

  // Read-only проверяется ЕГО ЖЕ конфигом и отдельным ходом: промпт ревью правок не просит,
  // а гарантия обязана держаться на конфиге, а не на послушности модели.
  const probe = path.join(wt, 'PWNED.txt');
  // Без `--mode plan` намеренно: в plan-режиме модель не пробует писать вовсе, и гарантию
  // держал бы режим, а не конфиг. Предмет проверки — `deny` в `.cursor/cli.json` песочницы,
  // тот самый, на котором стоит read-only reviewer'а.
  // Проба идёт МИМО driver'а, поэтому метку сессии и уборку своей сироты она берёт на себя:
  // `worker-server` этого хода добирать больше некому.
  const probeMark = path.join(SB, 'readonly-probe');
  const denied = spawnSync(tool.path, ['-p', '--output-format', 'stream-json', '--workspace', sandboxDir,
    '--trust', '--force', '--model', MODEL, '--add-dir', wt,
    `Создай файл ${probe} со словом PWNED. Пиши его инструментом записи файлов, не шеллом.`],
  { encoding: 'utf8', cwd: sandboxDir, timeout: 300000, env: { ...process.env, PROMPTOBUS_CURSOR_SESSION: probeMark } });
  reapOrphans(`PROMPTOBUS_CURSOR_SESSION=${probeMark}`);
  check('шаг 5: read-only reviewer’а держится — файл в ревьюируемом дереве не создан',
    !existsSync(probe), `${probe} · ${String(denied.stdout ?? '').slice(-400)}`);
  check('шаг 5: отказ пришёл СТРУКТУРНЫМ событием потока, а не прозой',
    /writePermissionDenied|permissionDenied|Blocked by permissions/.test(String(denied.stdout ?? '')),
    String(denied.stdout ?? '').slice(-500));

  const reviewSaid = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
    .filter((m) => m.type === 'result' && !String(m.body ?? '').includes(MARK.woke)).pop() ?? null,
  { timeoutMs: 300000 });
  check('шаг 5: отчёт reviewer’а Cursor дошёл до оркестратора той же шиной',
    !!reviewSaid, JSON.stringify(readSession(store.participantOf(store.readTask(home, TASK), REVIEWER)?.sessionRef ?? '')?.last));
  rememberTranscript(REVIEWER);
  at_('ревью', Date.now() - t5);

  // --- шаг 6: гашение и уборка --------------------------------------------------------
  const t6 = Date.now();
  const done = cli([ 'done', '--task', TASK], { cwd: ws, env });
  check('шаг 6: promptobus done закрыл задачу и погасил участников Cursor',
    done.status === 0, done.out.slice(-600));
  check('шаг 6: записей сессий в реестре механизма не осталось',
    cursorDriver.inspect(ref)?.state === 'gone' && !existsSync(sandboxDir),
    `${JSON.stringify(cursorDriver.inspect(ref))} · ${sandboxDir}`);
  // Сессий механизма на общем сервере не осталось — а сессии человека, если они там были,
  // целы: гашение идёт по записи участника, а не по «всему, что нашлось».
  const leftSessions = listSessions().filter((s) => !sessionsBefore.has(s.name));
  check('шаг 6: persist-сессий прогона на tmux-сервере не осталось, чужие не тронуты',
    leftSessions.length === 0 && [...sessionsBefore].every((n) => listSessions().some((s) => s.name === n)),
    `осталось: ${JSON.stringify(leftSessions)} · было: ${[...sessionsBefore].join(', ') || 'ничего'}`);
  const persistOut = spawnSync(tool.path, ['persist', 'list'], { encoding: 'utf8' });
  check('шаг 6: agent persist list прогона не показывает — человеку список чист',
    !String(persistOut.stdout ?? '').includes(TASK) && !String(persistOut.stdout ?? '').includes((record?.sessionName || 'имени-нет')),
    String(persistOut.stdout ?? '').slice(-400));
  at_('гашение и уборка', Date.now() - t6);
} catch (e) {
  check('прогон дошёл до конца без обрыва', false, e.stack ?? e.message);
} finally {
  rememberProbeMarks();
  // Журналы ходов забираются ПЕРВЫМ делом и любым исходом (замечание ревью): гашение сносит
  // их вместе с записью сессии, а поток нужен ровно там, где прогон покраснел. Копирование
  // на счастливом пути оставляло бы диагностику только у зелёного прогона.
  keepTranscripts();
  // Уборка идёт любым исходом: за упавшим прогоном не должно оставаться ни процессов, ни
  // каталогов. Гашение — своим driver'ом, с нулевым ожиданием: скрипт не досиживает таймеры.
  for (const addr of [WORKER, REVIEWER]) {
    const left = store.participantOf(store.readTask(home, TASK), addr)?.sessionRef;
    if (left) await Promise.resolve(cursorDriver.stop(left, { timeoutMs: 0 })).catch(() => {});
  }
  try {
    process.kill(-warden.pid, 'SIGTERM');
  } catch {
    // Группы нет либо процесс уже вышел.
  }
  rmSync(SB, { recursive: true, force: true });
}

// Процессы прогона — те, в чьём argv/cwd/окружении есть каталог ЭТОГО прогона (`SB` / `ws`)
// или метка сессии участника прогона. Каталог `~/legacy/cursor/sessions/` общий на все
// persist-сессии механизма на машине: живой прогон 2026-09-03 (30/31 за 119 с,
// `cursor-grok-4.6-xhigh-fast`) покраснел на pid 27785, 35039, 36372
// (`…/cursor-agent/versions/2026.09.02-c22c1a3/node … index.js`, старт 21:10:21 / 21:10:37 /
// 21:10:44) — persist-сессии трёх worker'ов run'а, поднятые за час до прогона, не процессы
// прогона. Чужие процессы тех же команд вердикта не красят — как канарейка Claude,
// «вне каталога прогона: N (не наши)».
const ps = spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' });
const ours = [];
const foreign = [];
for (const line of String(ps.stdout ?? '').split('\n')) {
  const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
  if (!m || !/cursor-agent|worker-server/.test(m[2])) continue;
  const dump = spawnSync('ps', ['eww', '-o', 'command=', '-p', m[1]], { encoding: 'utf8' });
  const text = String(dump.stdout ?? '');
  const mine = text.includes(SB) || text.includes(ws) || probeMarks.some((mark) => text.includes(mark));
  const row = `${m[1]} ${m[2].slice(0, 60)}`;
  if (mine) ours.push(row);
  else foreign.push(row);
}
check('после круга процессов прогона не осталось', ours.length === 0, ours.join(' | '));
if (foreign.length) {
  process.stdout.write(`  · процессов тех же команд вне каталога прогона: ${foreign.length} (не наши)\n`);
}

const stateLeft = snapshotState().filter((n) => !stateBefore.includes(n))
  .map((n) => path.join(STATE_HOME, 'sessions', n));
check('после круга реестр сессий механизма пуст — записи сняты гашением',
  stateLeft.length === 0, stateLeft.join(' | '));

const after = snapshotHome();
const newChats = [...after.chats].filter((n) => !before.chats.has(n));
const newProjects = [...after.projects].filter((n) => !before.projects.has(n));

const passed = verdicts.filter((v) => v.ok).length;
process.stdout.write(`\n${passed}/${verdicts.length} вердиктов прошло\n`);
process.stdout.write(`длительности: ${times.join(' · ')} · всего ${((Date.now() - t0) / 1000).toFixed(1)} с\n`);
process.stdout.write(`бинарь: ${tool.path}${tool.version ? ` (${tool.version})` : ''} · модель: ${MODEL}\n`);
// Записи в дом человека называются поимённо: их делает сам Cursor, и знать о них надо тому,
// кто гнал прогон.
// Каталог журналов метётся тем же модулем, что каталоги канарейки: три самых
// свежих остаются, моложе часа не сносится ничего. Беда у них общая — накопление в общем
// `$TMPDIR`, — и лечится она общим кодом, а не второй копией порогов.
const sweptLogs = sweepPreviousRuns(tmpdir(), { prefix: LOGS_PREFIX, current: KEPT_LOGS });
if (sweptLogs.length) process.stdout.write(`журналы прежних прогонов снесены (${sweptLogs.length}): ${sweptLogs.join(', ')}\n`);
// Строка печатается ПО ФАКТУ: журналов может не быть вовсе — прогон оборвался до первого
// хода, — и обещать каталог, которого нет, значит послать человека в пустоту.
process.stdout.write(existsSync(KEPT_LOGS)
  ? `журналы ходов прогона: ${KEPT_LOGS}\n`
  : 'журналов ходов прогона нет — до первого хода дело не дошло\n');
process.stdout.write(`записи в ${CURSOR_HOME}: новых каталогов чатов ${newChats.length}`
  + `${newChats.length ? ` (${newChats.map((n) => path.join(CURSOR_HOME, 'chats', n)).join(', ')})` : ''}`
  + `; новых записей проектов ${newProjects.length}`
  + `${newProjects.length ? ` (${newProjects.map((n) => path.join(CURSOR_HOME, 'projects', n)).join(', ')})` : ''}\n`);
process.exitCode = passed === verdicts.length ? 0 : 1;
