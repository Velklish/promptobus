// Driver Codex — третий production driver шины. Запуск: npm test
//
// Предмет — то, что у Codex устроено иначе, чем у Claude Code и Cursor: процесс
// app-server на участника, поток без хода не существует, turn/steer в идущий ход,
// review/start, гейт лимита, denyTools как песочница, пустой LaunchPlan.files.
// Круг идёт настоящим механизмом. Подменён ровно бинарь `codex`
// ([harness-codex.mjs](harness-codex.mjs)).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { buildWorkspace, cli, store } from './scenario.mjs';
import {
  APPROVAL_VAR, CODEX_HOME_VAR, FIRST_DELAY_VAR, HANG_FIRST_VAR, LIMIT_VAR,
  diagnoseTrace, installHarness, pidAlive, planParticipant, readTrace,
} from './harness-codex.mjs';
import { waitFor } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SB = makeSandbox('promptobus-codex-');
const { home: HARNESS, stateHome, restore } = await installHarness({ binDir: path.join(SB, 'bin') });

const {
  codexDriver, PHRASES, PROVEN_CODEX_VERSION, DEFAULT_MODEL, REVIEWER_DENY,
} = await import(path.join(here, '..', 'lib', 'driver-codex.js'));
const {
  readSession, writeSession, dropSession, decideApproval, readyMs, preambleMs, turnWaitMs,
  codexMcpServers, codexMcpName, CODEX_MCP_PREFIX,
} = await import(path.join(here, '..', 'lib', 'codex-session.js'));
const { liftDriver, REGISTRY } = await import(path.join(here, '..', 'lib', 'drivers.js'));
const { liftHarness, toolName } = await import(path.join(here, '..', 'lib', 'spawn.js'));

const TASK = 'codexbus-t20260903-000000';
const WORKER = 'worker:cdx';
const REVIEWER = 'reviewer:cdx';
const ORCH_SESSION = `orch-codex-${process.pid}`;

function thrown(fn) {
  try {
    fn();
    return { threw: false, msg: '' };
  } catch (e) {
    return { threw: true, msg: e.message };
  }
}

check(': driver Codex лежит в карте registry и берётся по имени',
  liftDriver('codex').id === 'codex' && Object.keys(REGISTRY.drivers).sort().join(',') === 'claude,codex,cursor',
  Object.keys(REGISTRY.drivers).join(','));

check(': без имени берётся прежний driver — argv Claude Code не двигается',
  liftDriver().id === 'claude');

check(': capabilities Codex объявлены все девять',
  ['spawn', 'attach', 'activation', 'inspect', 'stop', 'denyTools', 'systemPrompt', 'sessionList', 'enter']
    .every((k) => codexDriver.capabilities[k] !== undefined)
  && codexDriver.capabilities.attach === false && codexDriver.capabilities.activation === 'push',
  JSON.stringify(codexDriver.capabilities));

check(': readyMs по умолчанию = преамбула + ход, не прежние 60 с',
  readyMs({}) === preambleMs({}) + turnWaitMs({}) && readyMs({}) > 180_000,
  String(readyMs({})));

const patchRec = { cwd: '/tmp/wt', addDirs: [], role: 'worker' };
check(': патч вне cwd — deny',
  (() => {
    const d = decideApproval('applyPatchApproval', { changes: { '/etc/passwd': { type: 'add' } } }, patchRec);
    return d.allow === false && /вне cwd/.test(d.why);
  })());
check(': патч без разобранной цели — deny',
  (() => {
    const d = decideApproval('applyPatchApproval', {}, patchRec);
    return d.allow === false && /не разобрана/.test(d.why);
  })());
check(': относительный патч внутри cwd — allow',
  decideApproval('applyPatchApproval', { changes: { 'note.md': { type: 'add' } } }, patchRec).allow === true);
check(': fileChange вне cwd — deny',
  (() => {
    const d = decideApproval('item/fileChange/requestApproval', { item: { path: '/etc/x' } }, patchRec);
    return d.allow === false && /вне cwd/.test(d.why);
  })());

check(': канал объявлен rpc — knockRegistry messaging-сокет не подменяет',
  codexDriver.options.knockChannel === 'rpc', codexDriver.options.knockChannel);

check(': словарь Codex свой — бинарь, модель, песочница reviewer’а',
  codexDriver.options.tool === 'codex' && codexDriver.options.defaultModel === DEFAULT_MODEL
  && JSON.stringify(codexDriver.options.denyTools) === JSON.stringify(REVIEWER_DENY)
  && codexDriver.options.skillsDir === false
  && JSON.stringify(codexDriver.options.permissionModes) === JSON.stringify(['read-only', 'workspace-write']),
  JSON.stringify(codexDriver.options));

check(': имена инструментов шины — mcp__<ключ оверрайда>__name',
  PHRASES.tool('promptobus', 'promptobus_send') === `mcp__${codexMcpName('promptobus')}__promptobus_send`
  && PHRASES.tool('promptobus', 'promptobus_send') !== 'mcp__promptobus__promptobus_send',
  PHRASES.tool('promptobus', 'promptobus_send'));

check(': правила harness’а запрещают вопросы и требуют mailbox каждым ходом',
  /Вопросов не задавай/.test(PHRASES.promptRules) && /mailbox в начале каждого хода/.test(PHRASES.promptRules));

check(': бинарь старше проверенной версии — отказ до подъёма',
  /0\.140/.test(String(codexDriver.optionRefusal({}, { version: '0.140.0' })))
  && codexDriver.optionRefusal({}, { version: PROVEN_CODEX_VERSION }) === null
  && codexDriver.optionRefusal({}, { version: null }) === null,
  String(codexDriver.optionRefusal({}, { version: '0.140.0' })).slice(0, 90));

check(': shadowedUserServers пуст — личный набор не изолируется, config/read запрещён',
  JSON.stringify(codexDriver.shadowedUserServers(['promptobus'])) === '[]');

// Форма оверрайда `config.mcp_servers` — сверкой полей, а не запуском бинаря.
// Стенд ниже конфиг не разбирает, а настоящий `codex` на лишнем поле отказывается грузить
// его ЦЕЛИКОМ и не поднимает участника вовсе; в боевом рабочем месте url-серверов 13 из 14.
// Отсюда две ступени: здесь сверяются поля перевода, у `worker:mcp` — то, что реально
// уехало в `thread/start`.
const translated = codexMcpServers({
  'es-mcp-prod': { type: 'http', url: 'http://es.invalid/mcp' },
  'ati-kaiten-mcp': { type: 'http', url: 'http://kaiten.invalid/mcp', headers: { api_key: 'ТОКЕН' } },
  promptobus: { type: 'stdio', command: 'node', args: ['bin.js'], env: { PROMPTOBUS_ROLE: WORKER } },
  'sse-legacy': { type: 'sse', url: 'http://sse.invalid/mcp' },
  'bez-komandy': { type: 'stdio', args: [], env: {} },
});
const fieldsOf = (name) => Object.keys(translated.servers[codexMcpName(name)] ?? {}).sort().join(',');

check(': url-сервер уезжает url-формой — ни args, ни env, ни command',
  fieldsOf('es-mcp-prod') === 'url'
  && fieldsOf('ati-kaiten-mcp') === 'http_headers,url'
  && translated.servers[codexMcpName('ati-kaiten-mcp')].http_headers.api_key === 'ТОКЕН',
  JSON.stringify(translated.servers));

check(': stdio-сервер уезжает stdio-формой — url ему не приписывается',
  fieldsOf('promptobus') === 'args,command,env'
  && translated.servers[codexMcpName('promptobus')].env.PROMPTOBUS_ROLE === WORKER,
  JSON.stringify(translated.servers[codexMcpName('promptobus')]));

check(': транспорт, которого у Codex нет, и половинная запись не отдаются вовсе',
  !(codexMcpName('sse-legacy') in translated.servers) && !(codexMcpName('bez-komandy') in translated.servers)
  && translated.skipped.slice().sort().join(',') === 'bez-komandy,sse-legacy',
  JSON.stringify(translated.skipped));

check(': ключи оверрайда несут префикс — канонические имена в конфиг не едут',
  CODEX_MCP_PREFIX === 'promptobus-'
  && !('promptobus' in translated.servers) && !('es-mcp-prod' in translated.servers)
  && codexMcpName('promptobus') in translated.servers
  && codexMcpName('es-mcp-prod') in translated.servers
  && codexMcpName('promptobus') === `${CODEX_MCP_PREFIX}promptobus`
  && codexMcpName(`${CODEX_MCP_PREFIX}promptobus`) === `${CODEX_MCP_PREFIX}promptobus`,
  JSON.stringify(Object.keys(translated.servers)));

check(': toolName и phrases.tool зовут ключ оверрайда, не каноническое имя',
  toolName(codexDriver, 'promptobus', 'promptobus_send') === `mcp__${CODEX_MCP_PREFIX}promptobus__promptobus_send`
  && toolName(codexDriver, 'promptobus', 'promptobus_mailbox') === PHRASES.tool('promptobus', 'promptobus_mailbox')
  && toolName(codexDriver, 'memory-hooks', 'search_facts') === `mcp__${CODEX_MCP_PREFIX}memory-hooks__search_facts`,
  toolName(codexDriver, 'promptobus', 'promptobus_send'));

const ctx = {
  mcp: { servers: { promptobus: { command: 'node', args: ['x'], env: {} } } },
  prompt: 'ПРОМПТ',
  model: DEFAULT_MODEL,
  cwd: '/tmp/wt',
  addDirs: ['/tmp/rules'],
};
const workerPlan = codexDriver.prepare(ctx);
check(': argv — app-server --stdio, промпт последним; файлов на диск нет',
  workerPlan.argv[0] === 'app-server' && workerPlan.argv[1] === '--stdio'
  && workerPlan.argv.at(-1) === 'ПРОМПТ' && workerPlan.files.length === 0
  && workerPlan.settings.sandbox === 'workspace-write'
  && workerPlan.settings.approvalPolicy === 'on-request',
  JSON.stringify({ argv: workerPlan.argv.slice(0, 2), files: workerPlan.files.length, settings: workerPlan.settings }));

const reviewerPlan = codexDriver.prepare({ ...ctx, denyTools: REVIEWER_DENY, role: 'reviewer' });
check(': reviewer — sandbox read-only, cwd тот же, файлов нет',
  reviewerPlan.settings.sandbox === 'read-only' && reviewerPlan.cwd === ctx.cwd
  && reviewerPlan.files.length === 0,
  JSON.stringify(reviewerPlan.settings));

check(': текст пробуждения зовёт mailbox именем Codex',
  (() => {
    const text = codexDriver.renderNotification({
      kind: 'unread', task: 'T', address: 'worker:a', unread: 1,
      messages: [{ type: 'answer', from: 'orchestrator', ts: 'now', body: 'ТЕЛО' }],
    });
    return text.includes(`mcp__${codexMcpName('promptobus')}__promptobus_mailbox`) && text.includes('ТЕЛО');
  })());

const { ws, repoAbs, repo } = buildWorkspace(SB);
writeHostConfig(ws, { tools: ['claude', 'codex'] });
const home = path.join(ws, '.promptobus');
const brief = path.join(SB, 'worker-brief.md');
writeFileSync(brief, '# Проба driver’а Codex\n\nОтправь оркестратору status и закончи ход.\n');

const MARK = 'CODEX-STATUS-1';
const WOKE = 'CODEX-WOKE-1';
const STEERED = 'CODEX-STEER-1';
const REVIEW_MARK = 'CODEX-REVIEW-1';
const NOTE_FILE = 'codex/note.md';
const FORBIDDEN = 'codex/forbidden.md';

planParticipant(HARNESS, WORKER, {
  turns: [
    {
      do: [
        { write: { path: NOTE_FILE, text: `# ${MARK}\n` } },
        { commit: { message: ': правка worker’а Codex' } },
        { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: `${MARK}: worker Codex на связи` } },
      ],
    },
    { do: [{ wait: 900 }, { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: `${STEERED}: второй ход` } }] },
    { do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: `${WOKE}: разбужен` } }] },
  ],
});
planParticipant(HARNESS, REVIEWER, {
  turns: [
    {
      do: [
        { write: { path: FORBIDDEN, text: 'не должно появиться\n' } },
        { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: `${REVIEW_MARK}: замечаний нет` } },
      ],
    },
  ],
});

const env = {
  ...process.env,
  PROMPTOBUS_HOME: home,
  CLAUDE_CODE_SESSION_ID: ORCH_SESSION,
  PROMPTOBUS_WARDEN: 'off',
  [CODEX_HOME_VAR]: HARNESS,
  PROMPTOBUS_CODEX_HOME: stateHome,
};
store.createTask(home, { id: TASK, title: 'проба driver’а Codex', owner: ORCH_SESSION });

const bare = path.join(SB, 'bare-ws');
writeHostConfig(bare, { tools: ['claude'] });
const undeclared = thrown(() => liftHarness(bare, 'codex'));
check(': harness вне promptobus.json отказывает до подъёма',
  undeclared.threw && /tools add codex/.test(undeclared.msg), undeclared.msg);
check(': объявленный harness проходит тот же гейт',
  liftHarness(ws, 'codex').id === 'codex');

const dry = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'cdx', '--harness', 'codex', '--dry-run'], { cwd: ws, env });
check(': --dry-run печатает app-server --stdio и не пишет на диск',
  dry.status === 0 && /app-server --stdio/.test(dry.out) && /dry-run: на диск ничего не записано/.test(dry.out),
  dry.out.slice(-500));
check(': --dry-run называет id потока и что промпт уезжает turn/start',
  /имя сессии у harness'а: id потока придумывает сам app-server/.test(dry.out)
  && /промпт при этом уезжает запросом turn\/start, а не аргументом команды/.test(dry.out),
  dry.out.slice(-400));

const spawned = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'cdx', '--harness', 'codex'], { cwd: ws, env });
check('шаг 1: promptobus spawn --harness codex поднял участника',
  spawned.status === 0 && /worker worker:cdx поднят/.test(spawned.out), spawned.out.slice(-800));

const wp = store.participantOf(store.readTask(home, TASK), WORKER);
check('шаг 1: запись несёт harness codex и снимок capabilities',
  wp?.harness === 'codex' && wp?.mode === 'managed' && wp?.capabilities?.activation === 'push'
  && wp?.capabilities?.sessionList === true, JSON.stringify(wp?.capabilities));

const ref = wp?.sessionRef ?? '';
const record = readSession(ref, env);
check('шаг 1: поток лёг в реестр механизма — thread id и держатель живы',
  !!record?.threadId && record.state === 'alive' && typeof record.holderPid === 'number',
  JSON.stringify({ threadId: record?.threadId, state: record?.state, holder: record?.holderPid }));

check('шаг 1: ручка сессии — id потока',
  wp?.metadata?.session === record?.threadId, `${wp?.metadata?.session} · ${record?.threadId}`);

const sent = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
  .find((m) => String(m.body ?? '').includes(MARK)) ?? null, { timeoutMs: 25000 });
check('шаг 2: круг шины из Codex замкнулся — status дошёл до оркестратора',
  !!sent, `${JSON.stringify(sent)} · ${diagnoseTrace(HARNESS, WORKER)}`);

const idle = await waitFor(() => {
  const view = codexDriver.inspect(ref);
  return view && view.state === 'alive' && view.busy === false ? view : null;
}, { timeoutMs: 15000 });
check('шаг 3: ход кончился — сессия жива и не занята',
  idle?.state === 'alive' && idle?.busy === false && idle?.id === record?.threadId,
  JSON.stringify(idle));

{
  const idleStatus = cli([ 'status', '--task', TASK], { cwd: ws, env });
  const idleLine = idleStatus.out.split('\n').find((l) => l.includes(WORKER)) ?? idleStatus.out;
  check(': простой после хода Codex — inspect.unknown, status не стоп неизвестной природы',
    idle?.stall?.kind === 'unknown' && /ход кончился/.test(String(idle?.stall?.reason))
    && idleStatus.status === 0 && /ждёт сообщения/.test(idleLine) && !/ВСТАЛА/.test(idleLine),
    `${JSON.stringify(idle)} · ${idleLine}`);
}

{
  const idleRec = readSession(ref);
  writeSession({ ...idleRec, busy: true });
  const during = codexDriver.inspect(ref);
  check(': идущий turn Codex не красится стопом',
    during?.busy === true && during?.stall === null
    && !/встал/i.test(String(during?.note ?? '')),
    JSON.stringify(during));
  writeSession({ ...idleRec, busy: false });
}

const statusOut = cli([ 'status', '--task', TASK], { cwd: ws, env });
check('шаг 3: promptobus status показывает живость сессии Codex',
  statusOut.status === 0 && statusOut.out.includes(WORKER), statusOut.out.slice(-400));

const second = await codexDriver.activate({ ref }, {
  kind: 'unread', task: TASK, address: WORKER, unread: 1,
  messages: [{ type: 'task', from: 'orchestrator', ts: 'now', body: 'второй ход' }],
});
check('шаг 4: activate в простой начинает ход', second.ok === true, JSON.stringify(second));

await new Promise((r) => { setTimeout(r, 80); });
const steered = await codexDriver.activate({ ref }, {
  kind: 'unread', task: TASK, address: WORKER, unread: 2,
  messages: [{ type: 'task', from: 'orchestrator', ts: 'now', body: 'steer' }],
});
check('шаг 4: activate в идущий ход — turn/steer, не отказ',
  steered.ok === true, JSON.stringify(steered));

const steerTrace = await waitFor(() => {
  const tr = readTrace(HARNESS, WORKER);
  return tr.find((e) => e.kind === 'steer') ?? null;
}, { timeoutMs: 15000 });
check('шаг 4: стенд видел steer тем же turnId',
  !!steerTrace && typeof steerTrace.turnId === 'string', JSON.stringify(steerTrace));

const secondSent = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
  .find((m) => String(m.body ?? '').includes(STEERED)) ?? null, { timeoutMs: 20000 });
check('шаг 4: второй ход дошёл result’ом',
  !!secondSent, `${JSON.stringify(secondSent)} · ${diagnoseTrace(HARNESS, WORKER)}`);

const wt = wp?.metadata?.worktree ?? ws;
const reviewed = cli([ 'review', wt, '--task', TASK, '--harness', 'codex'], { cwd: ws, env });
check('шаг 5: promptobus review --harness codex поднял reviewer’а',
  reviewed.status === 0 && /reviewer reviewer:cdx поднят/.test(reviewed.out), reviewed.out.slice(-600));

const reviewSent = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
  .find((m) => String(m.body ?? '').includes(REVIEW_MARK)) ?? null, { timeoutMs: 25000 });
check('шаг 5: отчёт reviewer’а дошёл до оркестратора',
  !!reviewSent, `${JSON.stringify(reviewSent)} · ${diagnoseTrace(HARNESS, REVIEWER)}`);

check('шаг 5: read-only reviewer не записал файл — машинного признака отказа нет, сверяем диск',
  !existsSync(path.join(wt, FORBIDDEN)),
  existsSync(path.join(wt, FORBIDDEN)) ? 'файл есть' : 'файла нет');

const reviewDenied = readTrace(HARNESS, REVIEWER).some((e) => e.kind === 'write-denied');
check('шаг 5: стенд отказал reviewer’у в записи',
  reviewDenied, diagnoseTrace(HARNESS, REVIEWER));

const stopped = await codexDriver.stop(ref);
check('шаг 6: stop гасит держателя и снимает запись',
  stopped.ok && stopped.stopped && !readSession(ref, env),
  JSON.stringify(stopped));

const gone = codexDriver.inspect(ref);
check('шаг 6: inspect после stop — gone',
  gone.state === 'gone', JSON.stringify(gone));

const limitEnv = { ...env, [LIMIT_VAR]: '1' };
const limited = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'lim', '--harness', 'codex'], { cwd: ws, env: limitEnv });
check('шаг 7: лимит аккаунта — отказ до thread/start',
  limited.status !== 0 && /лимит/i.test(limited.out), limited.out.slice(-400));

const approvalEnv = { ...env, [APPROVAL_VAR]: '1' };
planParticipant(HARNESS, 'worker:apr', {
  turns: [{ do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'CODEX-APR' } }] }],
});
const approved = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'apr', '--harness', 'codex'], { cwd: ws, env: approvalEnv });
check('шаг 7: запрос одобрения без зависания — driver ответил, участник поднялся',
  approved.status === 0 && /worker worker:apr поднят/.test(approved.out), approved.out.slice(-500));

const apr = store.participantOf(store.readTask(home, TASK), 'worker:apr');
if (apr?.sessionRef) await codexDriver.stop(apr.sessionRef);
const rev = store.participantOf(store.readTask(home, TASK), REVIEWER);
if (rev?.sessionRef) await codexDriver.stop(rev.sessionRef);

const deadRef = 'dead-probe';
writeSession({
  ref: deadRef, state: 'dead', threadId: 't-dead', holderPid: process.pid,
  error: 'app-server завершился (9)',
}, process.env);
const deadView = codexDriver.inspect(deadRef);
check(': inspect при state=dead — stall, даже если holderPid жив',
  deadView.state === 'stale' && deadView.stall?.kind === 'stale' && /умер|завершился/.test(deadView.stall.reason),
  JSON.stringify(deadView));
dropSession(deadRef, process.env);

function pgrep(pattern) {
  const r = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  return String(r.stdout ?? '').trim().split('\n').filter(Boolean);
}

planParticipant(HARNESS, 'worker:hang', {
  turns: [{ do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'HANG' } }] }],
});
const beforeHold = pgrep('codex-hold.js');
const beforeApp = pgrep('app-server --stdio');
const hangEnv = { ...env, PROMPTOBUS_CODEX_READY_MS: '3000', [HANG_FIRST_VAR]: '1' };
const hung = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'hang', '--harness', 'codex'], { cwd: ws, env: hangEnv });
check(': отказ подъёма по таймауту — код ненулевой',
  hung.status !== 0 && /не поднялся/.test(hung.out), hung.out.slice(-400));
const extraHold = pgrep('codex-hold.js').filter((p) => !beforeHold.includes(p));
const extraApp = pgrep('app-server --stdio').filter((p) => !beforeApp.includes(p));
check(': после отказа подъёма процессов держателя нет',
  extraHold.length === 0 && extraApp.length === 0,
  `hold ${extraHold.join(',')} · app ${extraApp.join(',')}`);

planParticipant(HARNESS, 'worker:die', {
  turns: [{ do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'DIE' } }] }],
});
const diedUp = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'die', '--harness', 'codex'], { cwd: ws, env });
check(': участник для пробы смерти app-server поднялся',
  diedUp.status === 0, diedUp.out.slice(-300));
const diePart = store.participantOf(store.readTask(home, TASK), 'worker:die');
const dieRec = readSession(diePart?.sessionRef ?? '', env);
if (dieRec?.appPid) {
  try { process.kill(dieRec.appPid, 'SIGKILL'); } catch { /* нет */ }
}
const died = await waitFor(() => {
  const r = readSession(diePart?.sessionRef ?? '', env);
  const view = r ? codexDriver.inspect(diePart.sessionRef) : null;
  return r?.state === 'dead' && !pidAlive(dieRec.holderPid) && view?.stall ? view : null;
}, { timeoutMs: 8000 });
check(': смерть app-server гасит держателя и inspect ставит stall',
  !!died && died.stall?.kind === 'stale' && !pidAlive(dieRec?.holderPid),
  JSON.stringify({ died, holder: dieRec?.holderPid }));
if (diePart?.sessionRef) await codexDriver.stop(diePart.sessionRef);

planParticipant(HARNESS, 'worker:slow', {
  turns: [{ do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'SLOW' } }] }],
});
const slowEnv = { ...env, PROMPTOBUS_CODEX_READY_MS: '25000', [FIRST_DELAY_VAR]: '5000' };
const slow = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'slow', '--harness', 'codex'], { cwd: ws, env: slowEnv });
check(': waitReady ждёт задержанный первый ход и не сдаётся раньше держателя',
  slow.status === 0 && /worker worker:slow поднят/.test(slow.out), slow.out.slice(-500));
const slowPart = store.participantOf(store.readTask(home, TASK), 'worker:slow');
if (slowPart?.sessionRef) await codexDriver.stop(slowPart.sessionRef);

// Вторая ступень : что реально уехало в `thread/start`. Стенд кладёт `params.config`
// в свою запись потока — её и читаем. До этого места канон рабочего места стенда состоял из
// одной записи шины, то есть url-сервера подъём не видел ни разу; здесь канон получает его
// и участник поднимается с обоими транспортами разом.
writeHostConfig(ws, {
  tools: ['claude', 'codex'],
  mcp: {
    'probe-http': { type: 'http', url: 'http://probe.invalid/mcp', headers: { api_key: 'ПРОБНЫЙ-ТОКЕН' } },
  },
});

planParticipant(HARNESS, 'worker:mcp', {
  turns: [{ do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'CODEX-MCP' } }] }],
});
const mcpUp = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'mcp', '--harness', 'codex'], { cwd: ws, env });
check(': участник с url-сервером в наборе поднимается — конфиг Codex принят',
  mcpUp.status === 0 && /worker worker:mcp поднят/.test(mcpUp.out), mcpUp.out.slice(-600));

const mcpPart = store.participantOf(store.readTask(home, TASK), 'worker:mcp');
const mcpThread = (() => {
  const id = readSession(mcpPart?.sessionRef ?? '', env)?.threadId;
  try {
    return JSON.parse(readFileSync(path.join(HARNESS, 'threads', `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
})();
const started = mcpThread?.config?.mcp_servers ?? {};
const busKey = codexMcpName('promptobus');
const httpKey = codexMcpName('probe-http');
check(': в thread/start url-сервер уехал url-формой, шина — stdio-формой',
  Object.keys(started[httpKey] ?? {}).sort().join(',') === 'http_headers,url'
  && started[httpKey].http_headers.api_key === 'ПРОБНЫЙ-ТОКЕН'
  && Object.keys(started[busKey] ?? {}).sort().join(',') === 'args,command,env',
  JSON.stringify(started));
check(': в thread/start канонических имён нет — шина уехала под префиксом',
  !('promptobus' in started) && !('probe-http' in started)
  && busKey in started && httpKey in started,
  JSON.stringify(Object.keys(started)));
if (mcpPart?.sessionRef) await codexDriver.stop(mcpPart.sessionRef);

restore();
