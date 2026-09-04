#!/usr/bin/env node
// Живая проверка driver'а Codex на настоящем `codex app-server`. Запуск:
//
//   node scripts/live-codex.mjs [--model <id>]
//
// В `npm test` и в релизный гейт не входит: тратит лимит аккаунта Codex (он же
// ChatGPT.app владельца) и говорит с живым бинарём. Рабочее место — временное,
// `{claude, codex}` только в нём. Дом человека `~/.codex` скрипт не читает
// ради содержимого и не пишет; sha `config.toml` до и после — обязателен.
//
// **Права записи в ФС этот прогон не берёт.** Spawn идёт `--permission-mode read-only`.
// Вопрос «пишет ли `app-server` с `workspace-write` секцию `[projects."…"]`»
// здесь не проверяется.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { makeSandbox, writeHostConfig, resolveToolBin } from '../test/sandbox.mjs';
import { dropSessionLeaks, SESSION_LEAK_VARS } from '../test/hygiene.mjs';
import { buildWorkspace, cli, MECHANISM_ROOT, store } from '../test/scenario.mjs';
import { waitFor } from '../test/harness.mjs';

const { codexDriver, DEFAULT_MODEL } = await import(path.join(MECHANISM_ROOT, 'lib', 'driver-codex.js'));
const { readSession } = await import(path.join(MECHANISM_ROOT, 'lib', 'codex-session.js'));

const RELIED = [
  'initialize',
  'account/rateLimits/updated',
  'model/list',
  'thread/start',
  'thread/name/set',
  'turn/start',
  'turn/steer',
  'review/start',
  'turn/interrupt',
];

const argv = process.argv.slice(2);
const at = argv.indexOf('--model');
const MODEL = at >= 0 && at + 1 < argv.length ? argv[at + 1] : DEFAULT_MODEL;

const tool = resolveToolBin('codex');
if (!tool.ok) {
  console.error(`✖ живой прогон нечем гнать: ${tool.reason}`);
  process.exit(1);
}

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

function pgrep(pattern) {
  const r = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  return String(r.stdout ?? '').trim().split('\n').filter(Boolean);
}

const CONFIG = path.join(homedir(), '.codex', 'config.toml');
const shaBefore = shaFile(CONFIG);
const pgrepBefore = {
  cask: pgrep('Caskroom/codex'),
  app: pgrep('app-server --stdio'),
};

const SB = makeSandbox('promptobus-live-codex-');
const TASK = `livecodex-t${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
const WORKER = 'worker:live';
const ORCH_SESSION = `orch-live-codex-${process.pid}`;
const MARK = 'LIVE-CODEX-HELLO';
const stateHome = path.join(SB, 'codex-state');
process.env.PROMPTOBUS_CODEX_HOME = stateHome;

const { ws, repo } = buildWorkspace(SB);
writeHostConfig(ws, { tools: ['claude', 'codex'] });
const home = path.join(ws, '.promptobus');

const workerBrief = path.join(SB, 'worker-brief.md');
writeFileSync(workerBrief, `# Живая проверка круга шины из Codex

Ты участник шины Promptobus. Сделай ровно это и ничего сверх:

1. Отправь оркестратору сообщение типа status с телом, начинающимся строкой «${MARK}».
2. Закончи ход. Файлы не создавай и не правь.
`);

const env = {
  ...process.env,
  PROMPTOBUS_HOME: home,
  CLAUDE_CODE_SESSION_ID: ORCH_SESSION,
  PROMPTOBUS_WARDEN: 'off',
  PROMPTOBUS_CODEX_HOME: stateHome,
};

store.createTask(home, { id: TASK, title: 'живая проверка driver’а Codex', owner: ORCH_SESSION });

process.stdout.write(`▸ живой прогон Codex: ${tool.path}${tool.version ? ` (${tool.version})` : ''}\n`);
process.stdout.write(`▸ модель: ${MODEL} · sandbox: read-only · approvalPolicy: on-request\n`);
process.stdout.write(`▸ механизм: ${MECHANISM_ROOT}\n`);
process.stdout.write(`▸ песочница: ${SB} · store: ${home}\n`);
process.stdout.write(`▸ sha ~/.codex/config.toml до: ${shaBefore ?? '(файла нет)'}\n`);
if (leaked.length) process.stdout.write(`▸ снято с окружения прогона: ${leaked.join(', ')}\n`);

let ref = '';
let methodsCalled = [];
const t0 = Date.now();
try {
  const t2 = Date.now();
  const spawned = cli([ 'spawn', '--repo', repo, '--brief', workerBrief, '--task', TASK,
    '--worker', 'live', '--harness', 'codex', '--model', MODEL, '--permission-mode', 'read-only'],
  { cwd: ws, env });
  check('шаг 1: promptobus spawn --harness codex --permission-mode read-only поднял участника',
    spawned.status === 0 && /worker worker:live поднят/.test(spawned.out), spawned.out.slice(-800));
  at_('подъём участника', Date.now() - t2);

  const wp = store.participantOf(store.readTask(home, TASK), WORKER);
  ref = wp?.sessionRef ?? '';
  const record = readSession(ref, env);
  methodsCalled = [...(record?.methodsCalled ?? [])];
  check('шаг 1: поток лёг в реестр механизма, holder жив',
    !!record?.threadId && record.state === 'alive' && typeof record.holderPid === 'number',
    JSON.stringify({ threadId: record?.threadId, state: record?.state, holder: record?.holderPid }));
  check('шаг 1: sandbox потока — read-only (живой прогон права записи не берёт)',
    record?.sandbox === 'read-only', record?.sandbox);

  const statusOut = cli([ 'status', '--task', TASK], { cwd: ws, env });
  check('шаг 1: promptobus status показывает живость сессии Codex',
    statusOut.status === 0 && statusOut.out.includes(WORKER), statusOut.out.slice(-400));

  const t3 = Date.now();
  const hello = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
    .find((m) => String(m.body ?? '').includes(MARK)) ?? null, { timeoutMs: 300000 });
  check('шаг 2: status дошёл до оркестратора — круг шины из Codex замкнулся',
    !!hello, JSON.stringify(hello));
  at_('первый ход участника', Date.now() - t3);

  const idle = await waitFor(() => {
    const view = codexDriver.inspect(ref);
    return view && view.state === 'alive' && view.busy === false ? view : null;
  }, { timeoutMs: 30000 });
  check('шаг 2: ход кончился — сессия жива и не занята',
    idle?.state === 'alive' && idle?.busy === false, JSON.stringify(idle));

  const live = readSession(ref, env);
  methodsCalled = [...new Set([...(methodsCalled ?? []), ...(live?.methodsCalled ?? [])])];

  const t6 = Date.now();
  const stopped = await codexDriver.stop(ref);
  check('шаг 3: stop гасит держателя и снимает запись',
    stopped.ok && stopped.stopped && !readSession(ref, env), JSON.stringify(stopped));
  check('шаг 3: inspect после stop — gone',
    codexDriver.inspect(ref).state === 'gone', JSON.stringify(codexDriver.inspect(ref)));
  at_('гашение', Date.now() - t6);
} catch (e) {
  check('прогон дошёл до конца без обрыва', false, e.stack ?? e.message);
} finally {
  if (ref) await Promise.resolve(codexDriver.stop(ref)).catch(() => {});
  rmSync(SB, { recursive: true, force: true });
}

const shaAfter = shaFile(CONFIG);
check('личный ~/.codex/config.toml за прогон не изменился (sha)',
  shaBefore === shaAfter, `${shaBefore} → ${shaAfter}`);

const pgrepAfter = {
  cask: pgrep('Caskroom/codex'),
  app: pgrep('app-server --stdio'),
};
const extraCask = pgrepAfter.cask.filter((p) => !pgrepBefore.cask.includes(p));
const extraApp = pgrepAfter.app.filter((p) => !pgrepBefore.app.includes(p));
check('после круга нет новых процессов Caskroom/codex', extraCask.length === 0, extraCask.join(' | '));
check('после круга нет новых процессов app-server --stdio', extraApp.length === 0, extraApp.join(' | '));

const unobserved = RELIED.filter((m) => !methodsCalled.includes(m));

const passed = verdicts.filter((v) => v.ok).length;
process.stdout.write(`\n${passed}/${verdicts.length} вердиктов прошло\n`);
process.stdout.write(`длительности: ${times.join(' · ') || '—'} · всего ${((Date.now() - t0) / 1000).toFixed(1)} с\n`);
process.stdout.write(`бинарь: ${tool.path}${tool.version ? ` (${tool.version})` : ''} · модель: ${MODEL}\n`);
process.stdout.write(`методы, которые видел holder: ${methodsCalled.join(', ') || '(пусто)'}\n`);
process.stdout.write(`из объявленной поверхности ненаблюдавшиеся: ${unobserved.join(', ') || 'нет'}\n`);
process.stdout.write(`  (ненаблюдавшийся — не отсутствующий; стенд их закрывает)\n`);
process.stdout.write(`sha config.toml: ${shaBefore ?? '(нет)'} → ${shaAfter ?? '(нет)'}\n`);
process.stdout.write(`pgrep Caskroom/codex: было ${pgrepBefore.cask.length}, стало ${pgrepAfter.cask.length}\n`);
process.stdout.write(`pgrep 'app-server --stdio': было ${pgrepBefore.app.length}, стало ${pgrepAfter.app.length}\n`);
process.exitCode = passed === verdicts.length ? 0 : 1;
