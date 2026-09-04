// Канал пробуждения участника Cursor (переписан под persist-сессии в ).
// Запуск: npm test
//
// Предмет — круг, которого у не-Claude участника не было вовсе: сообщение легло в mailbox, и
// механизм ДОСТАВИЛ его в живую сессию. У Claude Code это инъекция в messaging-сокет; у
// Cursor — инъекция в поле ввода TUI через буфер tmux, и складывается канал из двух половин,
// обе проверяются здесь живьём:
//
//   1. **конец хода приносит хук `stop`** — он зовёт `promptobus guard`, тот сдаёт contact
//      point со счётчиком кончившихся ходов (`sessionEnd` под persist не стреляет вовсе);
//   2. **надзиратель активирует немедленно, когда contact point переписан** — и `activate`
//      driver'а вставляет текст пробуждения в живую сессию.
//
// **Разрыв с Claude Code сузился, и здесь же проверяется, до чего.** Сообщение, пришедшее во
// время хода, теперь ДОХОДИТ: оно встаёт в очередь сессии и исполняется отдельным ходом
// сразу после текущего, БЕЗ нового процесса. Внутрь идущего хода оно по-прежнему не
// попадает — и об этом механизм говорит словами, а не молчанием.
//
// **Файл идёт серийной группой раннера.** Он меряет настенные часы: ход участника держится
// паузой, круг надзирателя идёт раз в секунду, и под нагрузкой пула эти пороги либо краснеют
// на исправном коде, либо зеленеют ни на чём.
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { PROMPTOBUS_BIN, buildWorkspace, cli, store } from './scenario.mjs';
import { diagnoseTrace, installHarness, planParticipant } from './harness-cursor.mjs';
import { waitFor } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SB = makeSandbox('promptobus-cursor-wake-');
const { home: HARNESS, restore } = await installHarness({ binDir: path.join(SB, 'bin') });

const { cursorDriver } = await import(path.join(here, '..', 'lib', 'driver-cursor.js'));
const { listSessions, readSession } = await import(path.join(here, '..', 'lib', 'cursor-persist.js'));

const TASK = 'cursorwake-t20260903-000000';
const WORKER = 'worker:wake';
const ORCH_SESSION = `orch-wake-${process.pid}`;
const MARK = {
  first: 'WAKE-STATUS-1', second: 'WAKE-STATUS-2', third: 'WAKE-RESULT-3',
  answerA: 'WAKE-ANSWER-A', answerB: 'WAKE-ANSWER-B',
};

// Пауза внутри разбуженного хода — предмет, а не украшение: пока она идёт, приходит второе
// сообщение. Круг надзирателя идёт раз в секунду, и восьми секунд хватает и на доставку в
// занятую сессию, и на вердикт о ней; ход при этом остаётся коротким.
const TURN_HOLD_MS = 8000;

const { ws, repo } = buildWorkspace(SB);
writeHostConfig(ws, { tools: ['claude', 'cursor'] });
const home = path.join(ws, '.promptobus');
const brief = path.join(SB, 'brief.md');
writeFileSync(brief, '# Пробуждение участника Cursor\n\nРаботай по скрипту стенда.\n');

// Ходов три, и такова цена предмета. Первый кончается быстро — он сдаёт contact point, без
// которого будить нечем. Второй начинает надзиратель и ДЕРЖИТ паузой: ровно в это окно
// приходит второе сообщение, и на нём проверяется доставка в занятую сессию. Третий его
// разбирает — тем же процессом, без нового.
planParticipant(HARNESS, WORKER, {
  turns: [
    { do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: `${MARK.first}: первый ход` } }] },
    {
      do: [
        { tool: 'promptobus_mailbox' },
        // Отчёт идёт ДО паузы намеренно: он и есть признак «mailbox этого хода уже забран».
        // Пошли второе сообщение раньше — его забрал бы тот же ход, и разрыв, ради которого
        // файл заведён, остался бы непроверенным.
        { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: `${MARK.second}: разбудили первым сообщением` } },
        { wait: TURN_HOLD_MS },
      ],
    },
    {
      do: [
        { tool: 'promptobus_mailbox' },
        { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: `${MARK.third}: доставлено следующим ходом` } },
      ],
    },
  ],
});

const env = { ...process.env, PROMPTOBUS_HOME: home, CLAUDE_CODE_SESSION_ID: ORCH_SESSION };
// Надзиратель поднимается РУКАМИ, как в E2E: общий перечень гигиены гасит автоподъём, и
// вердикт раннера краснеет на нём. Отдельный процесс при этом настоящий.
const wardenEnv = { ...env };
delete wardenEnv.PROMPTOBUS_WARDEN;
store.createTask(home, { id: TASK, title: 'пробуждение участника Cursor', owner: ORCH_SESSION });
const wardenLog = path.join(SB, 'warden.out');
const warden = spawn(process.execPath, [PROMPTOBUS_BIN, 'warden', '--task', TASK], {
  cwd: ws, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: wardenEnv,
});
const keep = (c) => { try { appendFileSync(wardenLog, c); } catch { /* песочницы уже нет */ } };
warden.stdout.on('data', keep);
warden.stderr.on('data', keep);

const live = await waitFor(() => store.liveWarden(home, TASK), { timeoutMs: 20000 });
check('шаг 1: надзиратель задачи поднят настоящим процессом', !!live?.pid, JSON.stringify(live));

const spawned = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'wake', '--harness', 'cursor'], { cwd: ws, env });
check('шаг 2: участник Cursor поднят, и его сессия живая',
  spawned.status === 0 && /worker worker:wake поднят/.test(spawned.out), spawned.out.slice(-400));

const wp = store.participantOf(store.readTask(home, TASK), WORKER);
const ref = wp?.sessionRef ?? '';
check('шаг 2: снимок capabilities участника объявляет push — надзиратель будет его будить',
  wp?.harness === 'cursor' && wp?.capabilities?.activation === 'push', JSON.stringify(wp?.capabilities));

// --- первый конец хода сдаёт contact point ------------------------------------------

const record = readSession(ref, env);
const panePid = record?.panePid ?? null;
const wake0 = await waitFor(() => store.readWake(home, TASK, WORKER), { timeoutMs: 30000 });
check('шаг 3: конец хода сдал contact point со счётчиком ходов — по нему надзиратель и видит перемену',
  typeof wake0?.socket === 'string' && /#\d+$/.test(wake0.socket) && wake0.session === record?.chatId,
  `${JSON.stringify(wake0)} · чат ${record?.chatId}`);

check('шаг 3: первый ход участника кончился и отчитался — круг начат',
  !!(await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
    .find((m) => String(m.body ?? '').includes(MARK.first)) ?? null, { timeoutMs: 30000 })),
  diagnoseTrace(HARNESS, WORKER));

// --- сообщение простаивающей сессии: надзиратель вставляет его в живую сессию ---------

store.sendMessage(home, TASK, {
  from: 'orchestrator', to: WORKER, type: 'answer', body: `${MARK.answerA}: сессия простаивала`,
});

// Признак пробуждения — отчёт ЭТОГО хода: он уходит сразу за забором mailbox'а, то есть
// доказывает и то, что ход начался, и то, что своё непрочитанное он уже разобрал.
const woken = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
  .find((m) => String(m.body ?? '').includes(MARK.second)) ?? null, { timeoutMs: 60000 });
check('шаг 4: надзиратель разбудил простаивающую сессию — текст доехал в неё инъекцией',
  !!woken,
  `${JSON.stringify(woken)} · журнал надзирателя: ${store.tailWardenLog(home, TASK).slice(-6).join(' | ')}`);

check('шаг 4: пробуждение прошло БЕЗ нового процесса — панель сессии та же',
  readSession(ref, env)?.panePid === panePid && listSessions({ env })
    .some((s) => s.name === record?.sessionName),
  `${panePid} → ${readSession(ref, env)?.panePid} · ${JSON.stringify(listSessions({ env }))}`);

// --- сообщение ВО ВРЕМЯ хода: доходит, но исполняется следующим ------------------------
//
// Шлём его СТРОГО после отчёта пробуждённого хода: пришедшее раньше забрал бы тот же ход, и
// разрыв, ради которого файл заведён, остался бы непроверенным.

store.sendMessage(home, TASK, {
  from: 'orchestrator', to: WORKER, type: 'answer', body: `${MARK.answerB}: ответ пришёл во время хода`,
});

const busyDelivery = await cursorDriver.activate({ ref }, {
  kind: 'unread', task: TASK, address: WORKER, unread: 1, messages: [],
});
check('шаг 5: доставка в ИДУЩИЙ ход проходит — текст встаёт в очередь, а не отвергается',
  busyDelivery?.ok === true, JSON.stringify(busyDelivery));

check('шаг 5: идущий ход её не увидел — сообщение всё ещё лежит непрочитанным',
  store.countInbox(home, TASK, WORKER) >= 1, String(store.countInbox(home, TASK, WORKER)));

check('шаг 5: второго процесса от доставки не завелось — panePid прежний, сессия одна',
  readSession(ref, env)?.panePid === panePid
  && listSessions({ env }).filter((s) => s.name === record?.sessionName).length === 1,
  `${panePid} → ${readSession(ref, env)?.panePid} · ${JSON.stringify(listSessions({ env }))}`);

// --- очередь исполняется следующим ходом ---------------------------------------------

const answered = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
  .find((m) => String(m.body ?? '').includes(MARK.third)) ?? null, { timeoutMs: 90000 });
check('шаг 6: круг замкнулся — сообщение, пришедшее во время хода, разобрано СЛЕДУЮЩИМ',
  !!answered, `${JSON.stringify(answered)} · журнал надзирателя: ${store.tailWardenLog(home, TASK).slice(-14).join(' | ')} · ${diagnoseTrace(HARNESS, WORKER)}`);

check('шаг 6: mailbox участника забран им самим — доставку подтверждает он, а не надзиратель',
  await waitFor(() => store.countInbox(home, TASK, WORKER) === 0, { timeoutMs: 20000 }),
  String(store.countInbox(home, TASK, WORKER)));

check('шаг 6: и этот ход прошёл в той же сессии — процесс за круг не сменился',
  readSession(ref, env)?.panePid === panePid, `${panePid} → ${readSession(ref, env)?.panePid}`);

const wakeAfter = store.readWake(home, TASK, WORKER);
check('шаг 6: каждый конец хода переписывает отпечаток — счётчик ходов вырос',
  wakeAfter?.socket !== wake0?.socket, `${wake0?.socket} → ${wakeAfter?.socket}`);

// --- уборка ------------------------------------------------------------------------

const done = cli([ 'done', '--task', TASK], { cwd: ws, env });
check('шаг 6: promptobus done закрыл задачу, погасил участника и убрал persist-сессию',
  done.status === 0 && cursorDriver.inspect(ref)?.state === 'gone' && listSessions({ env }).length === 0,
  `${done.out.slice(-300)} · ${JSON.stringify(cursorDriver.inspect(ref))} · ${JSON.stringify(listSessions({ env }))}`);

const gone = await waitFor(() => (store.liveWarden(home, TASK) ? null : true), { timeoutMs: 30000 });
check('шаг 6: надзиратель закрытой задачи вышел сам',
  gone === true, `${JSON.stringify(store.liveWarden(home, TASK))} · ${wardenLog}`);

try {
  process.kill(-warden.pid, 'SIGTERM');
} catch {
  // Группы нет либо процесс уже вышел — обе ветки законны.
}
restore();
