// Юнит на сам подставной harness. Запуск: npm test
//
// Предмет — стенд, а не механизм: пока не доказано, что подставной `claude` печатает свой
// реестр в форме настоящего, поднимает живой процесс участника и гасит его, вердикты E2E
// ничего не значат — красный там был бы неотличим от кривого стенда. Поэтому проверки
// здесь идут ровно по трём обещаниям harness'а из постановки: `agents --json` печатает
// поднятого, участник принимает стук и отвечает, `stop` гасит.
//
// Механизм при этом настоящий и здесь: реестр читается `findSession`/`sessionLiveness` из
// [liftoff.js](../lib/liftoff.js), состояние — операцией `inspect` driver'а
// [claude](../lib/driver-claude.js), стук — его же `knockSocket`, contact point
// приезжает в store через `onJoin` живого MCP-сервера. Подменён ровно бинарь.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, makeSockPath } from './sandbox.mjs';
import {
  authorErrors, claudeConfigDir, diagnoseTrace, installHarness, listSessions, pidAlive, planParticipant,
  readLog, readTrace, sessionByName, stopAll, traceFile, waitFor,
} from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'promptobus.js');
const store = await import(path.join(here, '..', 'lib', 'store.js'));
const { claudeDriver, knockSocket } = await import(path.join(here, '..', 'lib', 'driver-claude.js'));
const { bgSessions, findSession, resetBgSessionsCache, sessionLiveness } = await import(path.join(here, '..', 'lib', 'liftoff.js'));

const SB = makeSandbox('promptobus-harness-');
const HOME = path.join(SB, 'promptobus');
const TASK = 'harness-t20260901-000000';
const ADDR = 'worker:probe';
const NAME = 'Worker: проба harness';
const ORCH_SESSION = 'orch-session-harness';

store.createTask(HOME, { id: TASK, title: 'проба подставного harness', owner: ORCH_SESSION });
store.upsertParticipant(HOME, TASK, store.participantRecord(ADDR, { name: NAME, sessionRef: NAME, harness: 'claude', mode: 'managed',
  started: new Date().toISOString() }));

// Конфиг участника собран той же формой, какой его пишет spawn: запись `promptobus` со своим
// `env` — единственное место, откуда участник узнаёт адрес, задачу и дом шины (spawn.js).
const CFG = path.join(SB, 'mcp.json');
writeFileSync(CFG, JSON.stringify({
  mcpServers: {
    promptobus: {
      type: 'stdio',
      command: process.execPath,
      args: [BIN, 'mcp'],
      env: { PROMPTOBUS_ROLE: ADDR, PROMPTOBUS_TASK: TASK, PROMPTOBUS_HOME: HOME },
    },
  },
}, null, 2));

const sock = makeSockPath('a2h-');
// Дом harness'а заводит он сам и вне песочницы: иначе уборка на выходе холостая — хук
// песочницы сносит каталог раньше, чем стенд успевает погасить свои процессы.
const { home: HARNESS, restore } = await installHarness({ binDir: path.join(SB, 'bin'), sock });
const { run } = await import(path.join(here, '..', 'lib', 'exec.js'));
const claude = (...args) => run('claude', args, { cwd: SB, encoding: 'utf8' });

planParticipant(HARNESS, ADDR, {
  turns: [
    {
      do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'первый ход участника' } }],
      detail: 'status sent; awaiting next cycle',
    },
    {
      do: [
        { tool: 'promptobus_mailbox' },
        { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: 'ответ после стука' } },
      ],
      detail: 'result sent; awaiting next cycle',
    },
  ],
});

// --- подъём -------------------------------------------------------------------

// Число здесь литеральное намеренно: `HARNESS_VERSION` — это `PROVEN_CLAUDE_VERSION` под
// именем стенда, и сверять константу с самой собой значило бы не сверять ничего. Литерал делает бамп
// версии красным — то есть напоминает перепроверить форму провода и `agents --json`.
const version = claude('--version');
check('подставной claude называет ту версию, с которой списан формат',
  version.stdout.trim().startsWith('2.1.251'), version.stdout);
const emptyList = claude('agents', '--json');
check('пустой реестр печатается пустым массивом, а не отказом',
  emptyList.stdout.trim() === '[]', emptyList.stdout);

const bg = claude('--bg', '--name', NAME, '--mcp-config', CFG, '--model', 'opus', 'промпт участника');
check('claude --bg отчитался формой, из которой механизм разбирает id сессии',
  bg.status === 0 && /backgrounded · [0-9a-f]{6,} · /.test(bg.stdout), `${bg.status}: ${bg.stdout}${bg.stderr}`);

resetBgSessionsCache();
const listed = bgSessions();
const record = sessionByName(HARNESS, NAME);
const REQUIRED = ['pid', 'cwd', 'kind', 'startedAt', 'sessionId', 'name', 'id', 'status', 'state'];
check('agents --json печатает поднятого — голым массивом и полями формы 2.1.251',
  Array.isArray(listed) && listed.length === 1 && REQUIRED.every((f) => listed[0][f] !== undefined),
  JSON.stringify(listed));
check('запись находится тем же findSession, каким её ищет механизм, и считается живой',
  findSession(listed, NAME)?.id === record?.id && sessionLiveness(findSession(listed, NAME), listed) === 'alive',
  JSON.stringify(record));

const wake = await waitFor(() => {
  const w = store.readWake(HOME, TASK, ADDR);
  return w?.socket ? w : null;
}, { timeoutMs: 20000 });
check('участник сдал contact point через onJoin живого MCP-сервера, а не руками в store',
  !!wake?.socket && !!wake?.token && wake.session === record?.sessionId,
  `${JSON.stringify(wake)} · лог: ${readLog(HARNESS, record?.id)}`);

const first = await waitFor(() => {
  const msgs = store.glanceInbox(HOME, TASK, store.ORCHESTRATOR);
  return msgs.length ? msgs : null;
}, { timeoutMs: 20000 });
check('первый ход участника доехал до оркестратора настоящим send',
  first?.[0]?.sender === store.addrDir(ADDR) && first?.[0]?.body === 'первый ход участника',
  `${JSON.stringify(first)} · след: ${JSON.stringify(readTrace(HARNESS, ADDR))} · лог: ${readLog(HARNESS, record?.id)}`);

// --- конец хода ---------------------------------------------------------------

const idle = await waitFor(() => {
  const s = sessionByName(HARNESS, NAME);
  return s?.status === 'idle' ? s : null;
}, { timeoutMs: 20000 });
check('конец хода помечен в реестре так же, как метит его харнес: idle + done',
  idle?.status === 'idle' && idle?.state === 'done', JSON.stringify(idle));
const stateFile = path.join(claudeConfigDir(HARNESS), 'jobs', String(record?.id), 'state.json');
check('причина стопа лежит в jobs/<id>/state.json — там, где её читает driver',
  JSON.parse(readFileSync(stateFile, 'utf8')).detail === 'status sent; awaiting next cycle', stateFile);

resetBgSessionsCache();
const view = claudeDriver.inspect(NAME);
check('driver видит участника живым, свободным и со своей причиной стопа',
  view?.state === 'alive' && view.busy === false && view.stall?.kind === 'unknown'
  && view.stall?.reason === 'status sent; awaiting next cycle', JSON.stringify(view));

// --- стук ---------------------------------------------------------------------

store.sendMessage(HOME, TASK, {
  from: store.ORCHESTRATOR, to: ADDR, type: 'answer', body: 'ответ оркестратора участнику',
});
const knocked = await knockSocket({ socket: wake.socket, token: wake.token }, 'служебный стук пробы');
check('стук настоящим knockSocket driver\'а принят участником',
  knocked.ok === true, JSON.stringify(knocked));

const answered = await waitFor(() => {
  const hit = store.glanceInbox(HOME, TASK, store.ORCHESTRATOR).find((m) => m.type === 'result');
  return hit ?? null;
}, { timeoutMs: 20000 });
check('по стуку участник сыграл следующий ход и ответил',
  answered?.body === 'ответ после стука',
  `${JSON.stringify(answered)} · лог: ${readLog(HARNESS, record?.id)}`);

const trace = readTrace(HARNESS, ADDR);
const knock = trace.find((e) => e.kind === 'knock');
check('провод дошёл до участника целым: auth первой строкой, токен тот, тело от надзирателя',
  knock?.lines === 2 && knock.auth === true && knock.tokenOk === true
  && knock.msgV === 1 && knock.from === 'promptobus-warden' && knock.body === 'служебный стук пробы',
  JSON.stringify(knock));
const box = trace.find((e) => e.kind === 'mailbox');
check('участник забрал mailbox настоящим инструментом и увидел там ответ оркестратора',
  typeof box?.text === 'string' && box.text.includes('ответ оркестратора участнику'), JSON.stringify(box));
check('нечитаемых строк в канале протокола сервер не писал',
  !trace.some((e) => e.kind === 'stray'), JSON.stringify(trace.filter((e) => e.kind === 'stray')));

// --- гашение ------------------------------------------------------------------

const stopped = await claudeDriver.stop(NAME);
check('driver погасил сессию через claude stop и сказал об этом',
  stopped.ok === true && stopped.stopped === true, JSON.stringify(stopped));
// Судим по pid, снятому ДО стопа: подставной `claude stop` сносит запись, и вердикт по
// строкам реестра был бы зелёным по построению — сломанное гашение осталось бы невидимым
// (замечание ревью). Короткое ожидание нужно: смерти процесса `stop` дожидается сам, но
// система освобождает его не в ту же миллисекунду.
const dead = await waitFor(() => !pidAlive(record.pid), { timeoutMs: 5000 });
check('после стопа процесса участника не осталось, а запись ушла из реестра',
  dead === true && listSessions(HARNESS).length === 0,
  `pid ${record?.pid} жив: ${pidAlive(record?.pid)} · ${JSON.stringify(listSessions(HARNESS))}`);
const idempotent = await claudeDriver.stop(NAME);
check('повторный стоп — исход со своими словами, а не отказ',
  idempotent.ok === true && idempotent.stopped === false, JSON.stringify(idempotent));

// --- диагноз по следу --------------------------------------------------

// Ошибки сценария участник не останавливают, и E2E краснеет шагами позже: диагноз обязан
// назвать их первыми, а не оставлять в начале следа, срезанного хвостом.
const PROBE = 'worker:probe';
const probeTrace = [
  { kind: 'up' }, { kind: 'turn', no: 0 }, { kind: 'unknown-action', action: { tool: 'send' } },
  { kind: 'mailbox' }, { kind: 'turn', no: 1 }, { kind: 'action-failed', action: { tool: 'promptobus_send' }, error: 'boom' },
  { kind: 'send' }, { kind: 'turn', no: 2 }, { kind: 'mailbox' }, { kind: 'stopped', code: 0 },
];
mkdirSync(path.dirname(traceFile(HARNESS, PROBE)), { recursive: true });
writeFileSync(traceFile(HARNESS, PROBE), probeTrace.map((e) => JSON.stringify(e)).join('\n') + '\n');
const errs = authorErrors(readTrace(HARNESS, PROBE));
check(': ошибки сценария выбираются из следа целиком и по порядку',
  errs.length === 2 && errs[0].kind === 'unknown-action' && errs[1].kind === 'action-failed', JSON.stringify(errs));
const diag = diagnoseTrace(HARNESS, PROBE);
check(': диагноз называет ошибки сценария первыми, до хвоста следа',
  diag.startsWith(`ошибки сценария ${PROBE}`) && diag.indexOf('unknown-action') < diag.indexOf('след '), diag.slice(0, 160));
check(': хвост следа в диагнозе остался — шесть последних записей',
  diag.endsWith(JSON.stringify(probeTrace.slice(-6))), diag.slice(-120));
writeFileSync(traceFile(HARNESS, PROBE), probeTrace.filter((e) => !['unknown-action', 'action-failed'].includes(e.kind))
  .map((e) => JSON.stringify(e)).join('\n') + '\n');
check(': без ошибок сценария диагноз начинается со следа — префикса нет',
  diagnoseTrace(HARNESS, PROBE).startsWith(`след ${PROBE}`), diagnoseTrace(HARNESS, PROBE).slice(0, 80));

await stopAll(HARNESS);
restore();
