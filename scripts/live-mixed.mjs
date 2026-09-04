#!/usr/bin/env node
// Живой прогон СМЕШАННОГО состава: оркестратор — этот скрипт, worker — живой Cursor,
// reviewer — живой Codex. Запуск:
//
//   node scripts/live-mixed.mjs [--cursor-model <id>] [--codex-model <id>]
//
// В `npm test` и в релизный гейт не входит: тратит лимиты ДВУХ аккаунтов сразу (Cursor и
// ChatGPT.app владельца) и говорит с живыми бинарями. Гоняет его владелец руками.
//
// **Почему свой скрипт, а не `live-e2e.mjs` смешанным составом.** Живой круг общего
// сценария ([scenario.mjs](../test/scenario.mjs)) идёт из сессии Claude Code: у него свой
// messaging-сокет оркестратора и ходы стопа, которых у Cursor и Codex нет по природе.
// Стендовый прогон смешанного состава ([promptobus-mixed.test.mjs](../test/promptobus-mixed.test.mjs))
// как раз и закрывает сценарий на подставных бинарях — а этот скрипт короче и про своё:
// что состав складывается на ЖИВЫХ инструментах и что после круга машина чистая.
//
// Что прогон проверяет: что worker поднимается `--harness cursor` и его `result` доходит до
// оркестратора; что reviewer поднимается `--harness codex` на том же круге, получает дифф и
// отвечает; что замечание доезжает до worker'а Cursor; что второй дифф уходит ТОМУ ЖЕ
// reviewer'у, а не поднимает второго; что `promptobus done` гасит всех троих; что за кругом
// не осталось ни процессов, ни записей реестров, ни каталогов в `$TMPDIR`, а личный
// `~/.codex/config.toml` не изменился.
//
// **Sha `~/.codex/config.toml` — отдельный вердикт, и он про право записи.** Reviewer идёт
// read-only, а `codex app-server` с `workspace-write` дописывает в этот файл секцию доверия
// `[projects."…"]` — то есть согласие человека доверять каталогу. Прогон, оставивший её,
// молча расширил доверие в личном конфиге; sha до и после — способ это увидеть.
//
// Маркеры отчётов reviewer'а едут ТЕЛОМ ДИФФА и только им: так вердикт «reviewer получил
// дифф» опирается на то, что реально прошло через файл диффа, а не на послушность модели
// брифу, которого она могла и не читать.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { makeSandbox, writeHostConfig, resolveToolBin } from '../test/sandbox.mjs';
import { dropSessionLeaks, SESSION_LEAK_VARS } from '../test/hygiene.mjs';
import { buildWorkspace, cli, MECHANISM_ROOT, PROMPTOBUS_BIN, store } from '../test/scenario.mjs';
import { waitFor } from '../test/harness.mjs';
import { sweepPreviousRuns, sweptLine } from './canary-runs.mjs';
import { addrKey } from '../test/harness-cursor.mjs';

const { cursorDriver } = await import(path.join(MECHANISM_ROOT, 'lib', 'driver-cursor.js'));
const { codexDriver, DEFAULT_MODEL: CODEX_DEFAULT } = await import(path.join(MECHANISM_ROOT, 'lib', 'driver-codex.js'));
const cursorPersist = await import(path.join(MECHANISM_ROOT, 'lib', 'cursor-persist.js'));
const codexSession = await import(path.join(MECHANISM_ROOT, 'lib', 'codex-session.js'));

// Обе модели называются флагами: прогон гонят на тех, которые назвал владелец, и они
// уезжают в отчёт. Дефолт Codex берётся у driver'а — своего числа тут заводить нечего.
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback;
};
const CURSOR_MODEL = flag('--cursor-model', 'cursor-grok-4.6-xhigh-fast');
const CODEX_MODEL = flag('--codex-model', CODEX_DEFAULT);

// Оба бинаря спрашиваются ДО всякой раскладки: круг из трёх участников без одного из них не
// проверяет ничего, а отказ на середине оставил бы за собой живую сессию второго.
const tools = { cursor: resolveToolBin('cursor'), codex: resolveToolBin('codex') };
const missing = Object.entries(tools).filter(([, t]) => !t.ok);
if (missing.length) {
  for (const [name, t] of missing) console.error(`✖ живой прогон нечем гнать: ${name} — ${t.reason}`);
  process.exit(1);
}

// Идентичность сессии снимается со своего окружения тем же перечнем, что у набора
//: прогон гонят из сессии, у которой все переменные стоят, и утёкший
// `PROMPTOBUS_TASK` увёл бы команды на задачу боевого run'а.
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

function shaFile(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

// Процессы Codex ищутся ДВУМЯ шаблонами и оба нужны: `pgrep -fl codex` ловит и чужие
// команды со словом codex в пути (в том числе сам этот скрипт), а держатель потока виден
// только как `app-server --stdio`.
function pgrep(pattern) {
  const r = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  return String(r.stdout ?? '').trim().split('\n').filter(Boolean);
}

const CODEX_CONFIG = path.join(homedir(), '.codex', 'config.toml');
const shaBefore = shaFile(CODEX_CONFIG);
const pgrepBefore = { cask: pgrep('Caskroom/codex'), app: pgrep('app-server --stdio') };

// Реестры сессий механизма живут в доме человека и в живом прогоне НЕ уводятся: предмет
// проверки — то, как это работает у пользователя. Что после круга там ничего не осталось,
// прогон сверяет составами до и после. Сессии человека рядом законны, и вычитать их
// обязательно: «список пуст» было бы неверным вердиктом на машине, где он работает.
const CURSOR_STATE = path.join(homedir(), '.agents', 'cursor', 'sessions');
const CODEX_STATE = path.join(homedir(), '.agents', 'codex', 'sessions');
const listing = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
const stateBefore = { cursor: listing(CURSOR_STATE), codex: listing(CODEX_STATE) };
const panesBefore = new Set(cursorPersist.listSessions().map((s) => s.name));

// Префикс песочницы не является ПРЕФИКСОМ префикса журналов, и это условие, а не стиль:
// вердикт следов в `$TMPDIR` ищет каталоги прогона по началу имени, а журналы законно
// переживают прогон и метутся своей уборкой. Общее начало `promptobus-live-mixed-` у обоих
// означало бы, что второй прогон краснеет на журналах первого.
const RUN_PREFIX = 'promptobus-live-mixed-run-';
const SB = makeSandbox(RUN_PREFIX);
// Журналы ходов переживают прогон: песочница сносится, а стенограмма Cursor и лог держателя
// Codex — то, по чему разбирают красное.
const LOGS_PREFIX = 'promptobus-live-mixed-logs-';
const KEPT_LOGS = path.join(tmpdir(), `${LOGS_PREFIX}${process.pid}`);
const TASK = `livemixed-t${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
const WORKER = 'worker:live';
const REVIEWER = 'reviewer:live';
const ORCH_SESSION = `orch-live-mixed-${process.pid}`;
const MARK = {
  hello: 'LIVE-MIXED-HELLO',
  fix: 'LIVE-MIXED-FIX',
  reviewA: 'LIVE-MIXED-REVIEW-A',
  reviewB: 'LIVE-MIXED-REVIEW-B',
};

const { ws, repoAbs, repo } = buildWorkspace(SB);
writeHostConfig(ws, { tools: ['claude', 'cursor', 'codex'] });
const home = path.join(ws, '.promptobus');

const workerBrief = path.join(SB, 'worker-brief.md');
writeFileSync(workerBrief, `# Живая проверка смешанного круга шины

Ты участник шины Promptobus. Сделай ровно это и ничего сверх:

1. Отправь оркестратору сообщение типа result с телом, начинающимся строкой «${MARK.hello}».
2. Закончи ход.

Дальше тебе будут приходить сообщения, в том числе замечания ревью. На каждое: забери
mailbox, прочитай, что в нём просят, и отправь оркестратору сообщение типа result с телом,
начинающимся ровно той строкой-маркером, которую сообщение назвало. Маркер ставь ПЕРВОЙ
строкой тела и ничего перед ним не пиши. Одно сообщение — один result. Больше ничего не делай.
`);

const env = { ...process.env, PROMPTOBUS_HOME: home, CLAUDE_CODE_SESSION_ID: ORCH_SESSION };
const wardenEnv = { ...env };
delete wardenEnv.PROMPTOBUS_WARDEN;

store.createTask(home, { id: TASK, title: 'живая проверка смешанного состава', owner: ORCH_SESSION });
const warden = spawn(process.execPath, [PROMPTOBUS_BIN, 'warden', '--task', TASK], {
  cwd: ws, detached: true, stdio: 'ignore', env: wardenEnv,
});
warden.unref();

process.stdout.write(`▸ живой прогон смешанного состава: worker Cursor + reviewer Codex\n`);
process.stdout.write(`▸ cursor: ${tools.cursor.path}${tools.cursor.version ? ` (${tools.cursor.version})` : ''} · модель ${CURSOR_MODEL}\n`);
process.stdout.write(`▸ codex: ${tools.codex.path}${tools.codex.version ? ` (${tools.codex.version})` : ''} · модель ${CODEX_MODEL} · sandbox reviewer'а: read-only\n`);
process.stdout.write(`▸ механизм: ${MECHANISM_ROOT}\n`);
process.stdout.write(`▸ песочница: ${SB} · store: ${home}\n`);
process.stdout.write(`▸ sha ~/.codex/config.toml до: ${shaBefore ?? '(файла нет)'}\n`);
if (leaked.length) process.stdout.write(`▸ снято с окружения прогона: ${leaked.join(', ')}\n`);

/** Предмет ревью: правка в worktree worker'а, коммит и маркер отчёта ВНУТРИ содержимого. */
function commitSubject(wt, mark, note) {
  writeFileSync(path.join(wt, 'live-note.md'), `# Предмет ревью смешанного круга

${note}

Пометка автора правки для ревьюера: начни свой отчёт первой строкой «${mark}» —
по ней автор поймёт, какую редакцию диффа ты смотрел.
`);
  const git = (...args) => spawnSync('git', ['-C', wt, '-c', 'user.name=live', '-c', 'user.email=live@example.invalid', ...args], { encoding: 'utf8' });
  git('add', '-A');
  return git('commit', '-m', `live: предмет ревью (${mark})`);
}

const orchInbox = () => store.glanceInbox(home, TASK, 'orchestrator');
/** Сообщение от адреса с маркером ПЕРВОЙ строкой: вхождение ловило бы пересказ плана. */
const said = (from, type, mark) => orchInbox()
  .find((m) => m.from === from && m.type === type && String(m.body ?? '').trimStart().startsWith(mark)) ?? null;

let workerRef = '';
let reviewerRef = '';
let transcriptPath = null;
// Журналы ходов забираются ДО гашения, и способы у половин состава разные, потому что разное
// сносит `done`. Стенограмму Cursor он не трогает — она в доме Cursor, — но ПУТЬ к ней лежит
// в записи сессии, которую гашение снимает: запоминается путь. Лог держателя Codex
// `dropSession` сносит ФАЙЛОМ вместе с записью, и после `done` копировать нечего вовсе:
// копируется он сразу, пока живой.
function rememberTranscript() {
  try {
    const from = workerRef ? cursorPersist.transcriptOf(cursorPersist.readSession(workerRef) ?? {}) : null;
    if (from) transcriptPath = from;
  } catch {
    // Записи сессии нет — путь стенограммы не восстановить, прогон это не отменяет.
  }
  return transcriptPath;
}

// Метка persist-сессии ЭТОГО прогона: по ней после круга опознаются свои `cursor-agent` и
// `worker-server` среди чужих. Снимается она с записи сессии и потому до гашения — после
// `done` записи нет, а сирота, ради которой вердикт и заведён, как раз переживает её.
const probeMarks = [];
function rememberProbeMark() {
  try {
    const mark = workerRef ? cursorPersist.sessionMarker(cursorPersist.readSession(workerRef) ?? {}) : null;
    if (mark && !probeMarks.includes(mark)) probeMarks.push(mark);
  } catch {
    // Записи уже нет — leftover тогда судится каталогом прогона.
  }
}

/** Каталог журналов заводится ТОЛЬКО когда есть что класть: пустой соврал бы отчёту. */
function logsDir() {
  mkdirSync(KEPT_LOGS, { recursive: true });
  return KEPT_LOGS;
}

function keepHolderLog() {
  try {
    const from = reviewerRef ? codexSession.holderLogFile(reviewerRef) : null;
    if (!from || !existsSync(from)) return;
    copyFileSync(from, path.join(logsDir(), `${addrKey(REVIEWER)}.log`));
  } catch {
    // Журнала нет либо каталог не создался — прогон это не отменяет.
  }
}

function keepTranscript() {
  try {
    const from = rememberTranscript();
    if (!from || !existsSync(from)) return;
    copyFileSync(from, path.join(logsDir(), `${addrKey(WORKER)}.jsonl`));
  } catch {
    // Журнала нет либо каталог не создался — прогон это не отменяет.
  }
}

/** Любой исход: копия держателя — повтор для красного круга, где до гашения не дошли. */
function keepLogs() {
  keepTranscript();
  keepHolderLog();
}

const t0 = Date.now();
try {
  const live = await waitFor(() => store.liveWarden(home, TASK), { timeoutMs: 30000 });
  check('шаг 1: надзиратель задачи поднят настоящим процессом', !!live?.pid, JSON.stringify(live));

  // --- шаг 2: worker поднимается harness'ом cursor -----------------------------------
  const t2 = Date.now();
  const spawned = cli([ 'spawn', '--repo', repo, '--brief', workerBrief, '--task', TASK,
    '--worker', 'live', '--harness', 'cursor', '--model', CURSOR_MODEL], { cwd: ws, env });
  check('шаг 2: promptobus spawn --harness cursor поднял живого worker’а',
    spawned.status === 0 && /worker worker:live поднят/.test(spawned.out), spawned.out.slice(-600));
  const wp = store.participantOf(store.readTask(home, TASK), WORKER);
  workerRef = wp?.sessionRef ?? '';
  const record = cursorPersist.readSession(workerRef);
  check('шаг 2: persist-сессия worker’а поднята и лежит в записи участника',
    !!record?.sessionName && wp?.metadata?.harness === cursorDriver.id
    && cursorDriver.inspect(workerRef)?.state === 'alive',
    `${JSON.stringify(record)} · ${JSON.stringify(wp?.metadata)}`);
  rememberTranscript();
  rememberProbeMark();
  at_('подъём worker’а', Date.now() - t2);

  // --- шаг 3: result worker’а дошёл до оркестратора -----------------------------------
  const t3 = Date.now();
  const hello = await waitFor(() => said(WORKER, 'result', MARK.hello), { timeoutMs: 300000 });
  check('шаг 3: result worker’а Cursor дошёл до оркестратора — круг шины замкнулся',
    !!hello, `${JSON.stringify(cursorPersist.readSession(workerRef)?.last)} · ${store.tailWardenLog(home, TASK).slice(-6).join(' | ')}`);
  at_('первый ход worker’а', Date.now() - t3);

  // --- шаг 4: reviewer поднимается harness'ом codex ------------------------------------
  const t4 = Date.now();
  const wt = wp?.metadata?.worktree ?? repoAbs;
  const committed = commitSubject(wt, MARK.reviewA, 'Первая редакция: предмет первого round’а ревью.');
  check('шаг 4: предмет ревью закоммичен в worktree worker’а',
    committed.status === 0, `${committed.stdout ?? ''}${committed.stderr ?? ''}`.slice(-400));

  const reviewed = cli([ 'review', wt, '--task', TASK, '--harness', 'codex', '--model', CODEX_MODEL],
    { cwd: ws, env });
  check('шаг 4: promptobus review --harness codex поднял живого reviewer’а',
    reviewed.status === 0 && /reviewer reviewer:live поднят/.test(reviewed.out), reviewed.out.slice(-800));
  const rp = store.participantOf(store.readTask(home, TASK), REVIEWER);
  reviewerRef = rp?.sessionRef ?? '';
  const thread = codexSession.readSession(reviewerRef);
  check('шаг 4: поток reviewer’а лёг в реестр Codex, держатель жив, sandbox — read-only',
    !!thread?.threadId && thread.state === 'alive' && codexSession.pidAlive(thread.holderPid)
    && thread.sandbox === 'read-only',
    JSON.stringify({ threadId: thread?.threadId, state: thread?.state, holder: thread?.holderPid, sandbox: thread?.sandbox }));

  // Дифф уходит reviewer'у ФАЙЛОМ в каталоге задачи, и перечень его файлов — то, чем
  // отличаются раунды. Спрашивается он каталогом, а не разбором прозы вывода: путь в строке
  // отчёта — вывод для человека, и вердикт на его формулировке холост при первой же правке
  // фразы.
  const diffsOf = () => listing(store.filesDir(home, TASK)).filter((n) => n.endsWith('.diff'));
  const diffsA = diffsOf();
  check('шаг 4: дифф первого round’а лёг файлом задачи и несёт первую редакцию',
    diffsA.length === 1
    && readFileSync(path.join(store.filesDir(home, TASK), diffsA[0]), 'utf8').includes(MARK.reviewA),
    JSON.stringify(diffsA));
  const reviewA = await waitFor(() => orchInbox().find((m) => m.from === REVIEWER && m.type === 'result') ?? null,
    { timeoutMs: 600000 });
  check('шаг 4: reviewer Codex получил дифф и прислал result той же шиной',
    !!reviewA, codexSession.tailLog(reviewerRef, process.env, 12));
  check('шаг 4: отчёт reviewer’а про ТОТ дифф — маркер из тела диффа стоит в отчёте',
    !!reviewA && String(reviewA.body ?? '').includes(MARK.reviewA),
    `${JSON.stringify(reviewA?.body ?? null).slice(0, 400)} · дифф ${diffsA.join(', ')}`);
  at_('первый round ревью', Date.now() - t4);

  // --- шаг 5: замечание доставлено worker'у Cursor -------------------------------------
  const t5 = Date.now();
  store.sendMessage(home, TASK, {
    from: 'orchestrator',
    to: WORKER,
    type: 'review',
    body: `Замечания ревью по твоей правке. Забери mailbox и ответь оркестратору сообщением типа result с телом, начинающимся строкой «${MARK.fix}».`,
  });
  const fixed = await waitFor(() => said(WORKER, 'result', MARK.fix), { timeoutMs: 300000 });
  check('шаг 5: замечание ревью доставлено worker’у Cursor, и он ответил',
    !!fixed, `${JSON.stringify(cursorPersist.readSession(workerRef)?.last)} · ${store.tailWardenLog(home, TASK).slice(-6).join(' | ')}`);
  check('шаг 5: mailbox worker забрал сам — доставку подтверждает он',
    store.countInbox(home, TASK, WORKER) === 0, String(store.countInbox(home, TASK, WORKER)));
  at_('замечание и ответ worker’а', Date.now() - t5);

  // --- шаг 6: второй дифф — ТОМУ ЖЕ reviewer'у ------------------------------------------
  const t6 = Date.now();
  const again = commitSubject(wt, MARK.reviewB, 'Вторая редакция: та же правка после замечаний.');
  check('шаг 6: вторая редакция предмета закоммичена', again.status === 0,
    `${again.stdout ?? ''}${again.stderr ?? ''}`.slice(-400));
  const reReview = cli([ 'review', wt, '--task', TASK], { cwd: ws, env });
  const rp2 = store.participantOf(store.readTask(home, TASK), REVIEWER);
  // Тот же reviewer — это ТРИ вещи разом: механизм сказал «уже на шине», session reference
  // не сменился и второго адреса reviewer'а в задаче не появилось. Любая одна из них
  // зеленела бы и на поднятом заново reviewer'е.
  const reviewerAddrs = store.addressesOf(store.readTask(home, TASK)).filter((a) => String(a).startsWith('reviewer:'));
  check('шаг 6: второй дифф ушёл ТОМУ ЖЕ reviewer’у — второй сессии не появилось',
    reReview.status === 0 && /уже на шине — отправлен новый дифф/.test(reReview.out)
    && rp2?.sessionRef === reviewerRef && reviewerAddrs.length === 1,
    `${reReview.out.slice(-500)} · сессия ${reviewerRef} → ${rp2?.sessionRef} · адреса ${JSON.stringify(reviewerAddrs)}`);
  const diffsB = diffsOf().filter((n) => !diffsA.includes(n));
  check('шаг 6: второй дифф лёг ОТДЕЛЬНЫМ файлом и несёт вторую редакцию',
    diffsB.length === 1
    && readFileSync(path.join(store.filesDir(home, TASK), diffsB[0]), 'utf8').includes(MARK.reviewB),
    `${diffsA.join(', ')} → ${diffsOf().join(', ')}`);
  const reviewB = await waitFor(() => orchInbox()
    .find((m) => m.from === REVIEWER && m.type === 'result' && String(m.body ?? '').includes(MARK.reviewB)) ?? null,
  { timeoutMs: 600000 });
  check('шаг 6: reviewer разобрал НОВЫЙ дифф в том же контексте и прислал второй result',
    !!reviewB, codexSession.tailLog(reviewerRef, process.env, 12));
  at_('второй round ревью', Date.now() - t6);

  // --- шаг 7: promptobus done гасит всех троих ------------------------------------------
  const t7 = Date.now();
  // Журналы — до гашения: `done` сносит лог держателя Codex файлом, а запись сессии Cursor
  // уносит с собой путь стенограммы.
  keepLogs();
  const done = cli([ 'done', '--task', TASK], { cwd: ws, env });
  check('шаг 7: promptobus done закрыл задачу и назвал обе сессии, которые гасит',
    done.status === 0 && done.out.includes(WORKER) && done.out.includes(REVIEWER), done.out.slice(-800));
  check('шаг 7: сессия worker’а Cursor погашена, записи в реестре нет',
    cursorDriver.inspect(workerRef)?.state === 'gone', JSON.stringify(cursorDriver.inspect(workerRef)));
  check('шаг 7: поток reviewer’а Codex погашен вместе с держателем',
    codexDriver.inspect(reviewerRef)?.state === 'gone' && !codexSession.readSession(reviewerRef)
    && !codexSession.pidAlive(thread?.holderPid),
    `${JSON.stringify(codexDriver.inspect(reviewerRef))} · держатель ${thread?.holderPid}`);
  const wardenLeft = await waitFor(() => (store.liveWarden(home, TASK) ? null : true), { timeoutMs: 30000 });
  check('шаг 7: надзиратель задачи вышел вместе с закрытием — третий участник тоже погашен',
    !!wardenLeft, JSON.stringify(store.liveWarden(home, TASK)));
  at_('гашение', Date.now() - t7);
} catch (e) {
  check('прогон дошёл до конца без обрыва', false, e.stack ?? e.message);
} finally {
  keepLogs();
  // Уборка идёт любым исходом: за упавшим прогоном не должно оставаться ни процессов, ни
  // каталогов. Гашение — своими driver'ами, каждый по своей записи.
  if (workerRef) await Promise.resolve(cursorDriver.stop(workerRef, { timeoutMs: 0 })).catch(() => {});
  if (reviewerRef) await Promise.resolve(codexDriver.stop(reviewerRef)).catch(() => {});
  try {
    process.kill(-warden.pid, 'SIGTERM');
  } catch {
    // Группы нет либо процесс уже вышел.
  }
  rmSync(SB, { recursive: true, force: true });
}

// --- гигиена: дом человека и машина после круга ----------------------------------------

const shaAfter = shaFile(CODEX_CONFIG);
// Главный вердикт гигиены Codex: reviewer шёл read-only, и секцию доверия
// `[projects."…"]` в личный конфиг он писать не должен. Sha сравнивается, а не парсится:
// изменение файла ЛЮБОЙ формы — уже расширение личных настроек прогоном.
check('личный ~/.codex/config.toml за круг не изменился (sha) — секцию доверия reviewer не писал',
  shaBefore === shaAfter, `${shaBefore} → ${shaAfter}`);

const pgrepAfter = { cask: pgrep('Caskroom/codex'), app: pgrep('app-server --stdio') };
const extraCask = pgrepAfter.cask.filter((p) => !pgrepBefore.cask.includes(p));
const extraApp = pgrepAfter.app.filter((p) => !pgrepBefore.app.includes(p));
check('после круга нет новых процессов Caskroom/codex', extraCask.length === 0, extraCask.join(' | '));
check('после круга нет новых процессов app-server --stdio', extraApp.length === 0, extraApp.join(' | '));

// Половина состава Cursor судится своей проверкой: держатель Codex опознаётся именем команды
// (`pgrep` выше), а `cursor-agent` и `worker-server` — нет, их поднимает каждая
// persist-сессия на машине, включая сессию человека в IDE. Свои — те, в чьём argv, cwd или
// окружении есть каталог ЭТОГО прогона либо метка его сессии; чужие идут строкой в отчёт и
// вердикта не красят. Проверка снята с `live-cursor.mjs`, где на ней и ловились сироты
// ( — держатель, переживший родителя).
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
check('после круга процессов Cursor прогона не осталось', ours.length === 0, ours.join(' | '));
if (foreign.length) {
  process.stdout.write(`  · процессов тех же команд вне каталога прогона: ${foreign.length} (не наши)\n`);
}

// Persist-сессии Cursor судятся ВЫЧИТАНИЕМ: рядом законно живут сессии человека и других
// прогонов, и «список пуст» было бы неверным вердиктом на рабочей машине.
const panesLeft = cursorPersist.listSessions().filter((s) => !panesBefore.has(s.name));
check('после круга persist-сессий прогона на tmux-сервере нет, чужие целы',
  panesLeft.length === 0 && [...panesBefore].every((n) => cursorPersist.listSessions().some((s) => s.name === n)),
  `осталось: ${JSON.stringify(panesLeft.map((s) => s.name))} · было: ${[...panesBefore].join(', ') || 'ничего'}`);

const stateLeft = {
  cursor: listing(CURSOR_STATE).filter((n) => !stateBefore.cursor.includes(n)),
  codex: listing(CODEX_STATE).filter((n) => !stateBefore.codex.includes(n)),
};
check('после круга реестры сессий механизма чисты — записи снял `done`',
  stateLeft.cursor.length === 0 && stateLeft.codex.length === 0,
  `cursor: ${stateLeft.cursor.join(', ') || 'чисто'} · codex: ${stateLeft.codex.join(', ') || 'чисто'}`);

// Следы в `$TMPDIR` ищутся по ПРЕФИКСУ прогона, а не по имени каталога целиком: имя даёт
// генератор песочницы, и литерал стал бы холостым при первой же его смене.
// Журналы под своим префиксом сюда не попадают вовсе — они законно живут до уборки, и
// каталоги прошлых прогонов вычитанием одного текущего pid'а не отсеять.
const tmpLeft = listing(tmpdir()).filter((n) => n.startsWith(RUN_PREFIX));
check('после круга каталогов прогона в $TMPDIR не осталось',
  tmpLeft.length === 0 && !existsSync(SB),
  `${tmpLeft.join(', ') || 'чисто'} · песочница ${existsSync(SB) ? SB : 'снесена'}`);

const passed = verdicts.filter((v) => v.ok).length;
process.stdout.write(`\n${passed}/${verdicts.length} вердиктов прошло\n`);
process.stdout.write(`длительности: ${times.join(' · ') || '—'} · всего ${((Date.now() - t0) / 1000).toFixed(1)} с\n`);
process.stdout.write(`бинари: cursor ${tools.cursor.path}${tools.cursor.version ? ` (${tools.cursor.version})` : ''}`
  + ` · codex ${tools.codex.path}${tools.codex.version ? ` (${tools.codex.version})` : ''}\n`);
process.stdout.write(`модели: worker ${CURSOR_MODEL} · reviewer ${CODEX_MODEL}\n`);
process.stdout.write(`sha ~/.codex/config.toml: ${shaBefore ?? '(нет)'} → ${shaAfter ?? '(нет)'}\n`);
process.stdout.write(`pgrep Caskroom/codex: было ${pgrepBefore.cask.length}, стало ${pgrepAfter.cask.length}`
  + ` · pgrep 'app-server --stdio': было ${pgrepBefore.app.length}, стало ${pgrepAfter.app.length}\n`);
// Каталог журналов метётся тем же модулем, что каталоги канарейки: три
// самых свежих остаются, моложе часа не сносится ничего. Беда общая — накопление в общем
// `$TMPDIR`, — и лечится она общим кодом, а не второй копией порогов.
process.stdout.write(`${sweptLine('журналов прежних прогонов', sweepPreviousRuns(tmpdir(), { prefix: LOGS_PREFIX, current: KEPT_LOGS }))}\n`);
// Строка про журналы печатается ПО ФАКТУ: их может не быть вовсе — прогон оборвался до
// первого хода, — и обещать каталог, которого нет, значит послать человека в пустоту.
process.stdout.write(existsSync(KEPT_LOGS)
  ? `журналы ходов прогона: ${KEPT_LOGS}\n`
  : 'журналов ходов прогона нет — до первого хода дело не дошло\n');
process.exitCode = passed === verdicts.length ? 0 : 1;
