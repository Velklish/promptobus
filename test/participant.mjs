// Scripted-участник подставного harness'а. Не `*.test.mjs` — раннер (run.mjs)
// берёт из каталога только их, и этот файл в прогон не попадает.
//
// Это ПРОЦЕСС, а не заглушка: его поднимает подставной `claude --bg`
// ([harness.mjs](harness.mjs)), он живёт до `stop` и делает ровно то, что механизм ждёт от
// сессии участника ([13]):
//
//   1. узнаёт себя из `--mcp-config` — адрес, задачу и дом шины spawn кладёт в `env`
//      записи `promptobus` того файла (spawn.js). В окружении САМОЙ сессии их нет вовсе
//     : оно приходит от демона и принадлежит чужому spawn'у;
//   2. поднимает настоящий `promptobus mcp` своим дочерним процессом и разговаривает с ним
//      построчным JSON-RPC — тем же транспортом, что и Claude Code. Contact point при этом
//      сдаёт не участник руками, а `onJoin` сервера — на рукопожатии: адрес
//      сокета и токен приезжают к нему в окружении (`registerWake`);
//   3. слушает свой messaging-сокет по wire-протоколу driver'а: auth-строка, следом JSON
//      инъекции (`dial`/`knockSocket` в driver-claude.js);
//   4. на стуке играет очередной ход своего скрипта — зовёт `promptobus_mailbox`, `promptobus_send`, `promptobus_task`;
//   5. заканчивает ход: пишет `jobs/<id>/state.json`, зовёт Stop-хук КОМАНДОЙ ИЗ ФАЙЛА
//      НАСТРОЕК (`--settings`) и метит свою запись в реестре `idle`/`blocked` — так помечает
//      конец хода настоящий harness.
//
// Скрипт хода приходит файлом от теста, ключ — адрес участника. Молчаливый ход (пустой
// список действий) — законный сценарий: на нём проверяется доклад о стопе.
// Ход с полем `block` — сессия, ВСТАВШАЯ на конце хода: `{ waitingFor }` для диалога
// разрешения, `{ limit }` для исчерпанного лимита.
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, appendFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  HARNESS_HOME_VAR, claudeConfigDir, readSession, scriptFile, traceFile, writeSession,
} from './harness.mjs';

const argv = process.argv.slice(2);
const home = process.env[HARNESS_HOME_VAR];
const id = process.env.PROMPTOBUS_E2E_SESSION;
const socketPath = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
const sessionId = process.env.CLAUDE_CODE_SESSION_ID;

function argValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

// Промпт стоит последним аргументом всегда — `--mcp-config` и `--allowedTools` у бинаря
// вариадические, и после них позиционный аргумент уехал бы в их список (spawnArgv).
const prompt = argv[argv.length - 1];
const mcpConfigPath = argValue('--mcp-config');
const settingsPath = argValue('--settings');
const cfg = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
const bus = cfg.mcpServers?.promptobus;
const address = bus?.env?.PROMPTOBUS_ROLE;
const task = bus?.env?.PROMPTOBUS_TASK;
const busHome = bus?.env?.PROMPTOBUS_HOME;
// Команда Stop-хука — ИЗ ФАЙЛА НАСТРОЕК участника, того, что уехал флагом `--settings`
//. Собрать её здесь самому значило бы проверять стенд: настоящий харнес исполняет
// то, что записано в файле, а с этой задачи в записи стоит идентичность участника
// аргументами. Записи нет — хука нет, и ход просто кончается: так живёт сессия, которой
// сторожа не положили.
function guardCommand() {
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const cmd = settings?.hooks?.Stop?.[0]?.hooks?.[0]?.command;
    return typeof cmd === 'string' && cmd.trim() ? cmd : null;
  } catch {
    return null;
  }
}

let script = { turns: [] };
try {
  script = JSON.parse(readFileSync(scriptFile(home, address), 'utf8'));
} catch {
  // Скрипта нет — участник просто молчит: это законный сценарий, а не поломка стенда.
}

const trace = traceFile(home, address);
mkdirSync(path.dirname(trace), { recursive: true });

function note(entry) {
  try {
    appendFileSync(trace, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    // След — диагностика теста, и отказ записи не повод ронять участника.
  }
}

// Занятость сессии в реестре harness'а: `busy` пока идёт ход, `idle` — когда отдан.
// Отсюда её и берёт driver (`inspect` читает поле `status`), а машина состояний — из
// снимка (`sessionBusy`).
function mark(patch) {
  const record = readSession(home, id);
  if (record) writeSession(home, { ...record, ...patch });
}

// --- MCP-клиент ------------------------------------------------------------------

// Сервер поднимается ОДИН на всю жизнь участника, а не на вызов: так с ним разговаривает
// Claude Code, и идентичность процесса сервер резолвит один раз, при старте.
const mcp = spawn(bus.command, bus.args, {
  cwd: process.cwd(),
  env: { ...process.env, ...bus.env },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
let seq = 0;
let buf = '';
mcp.stdout.setEncoding('utf8');
mcp.stdout.on('data', (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf('\n');
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // Посторонняя строка в канале протокола — беда сервера, а не участника: называем её
      // следом и живём дальше, иначе диагноза у теста не останется вовсе.
      note({ kind: 'stray', line });
      continue;
    }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});
mcp.stderr.setEncoding('utf8');
mcp.stderr.on('data', (chunk) => note({ kind: 'mcp-stderr', text: String(chunk).trim() }));

function rpc(method, params) {
  const rid = (seq += 1);
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`нет ответа на ${method}`)), 30000);
    pending.set(rid, (m) => { clearTimeout(timer); resolve(m); });
  });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
  return answer;
}

function textOf(res) {
  return res?.result?.content?.map((c) => c.text).join('\n') ?? '';
}

// --- ход --------------------------------------------------------------------------

// Ход участника кончается ровно так, как его кончает сессия Claude Code, и порядок здесь
// не декоративный: сперва причина стопа в `jobs/<id>/state.json` (её читает driver), потом
// Stop-хук, потом отметка «свободна» в реестре.
//
// Stop-хук зовётся КОМАНДОЙ ИЗ ФАЙЛА НАСТРОЕК и своим окружением участника — ровно так, как
// его зовёт харнес. Идентичность шины стоит в самой команде аргументами, а
// окружение сессии её больше не несёт: оно приходит от демона и принадлежит чужому spawn'у.
// Поэтому сторож работает и здесь: отметку конца хода (`waits/<адрес>.turn.json`) получает и
// участник, а не один оркестратор. Занятость его при этом по-прежнему берётся из снимка
// сессий — ветку в `sessionBusy` выбирает род участника, а не наличие отметки.
//
// **Ход может кончиться стопом, а не свободой**. Поле `block` хода метит запись
// в тех формах, которые НАБЛЮДЕНЫ у живого харнеса ([15]),
// а не в удобных стенду:
//
//   - `{ waitingFor }` — сессия встала на диалоге. `waitingFor` живой харнес выдаёт только
//     при `status: "waiting"`, и значением там короткая метка (`permission prompt`,
//     `sandbox request`, `input needed`), а не текст запроса. Состояние при этом остаётся
//     `working`: диалог прерывает ход, а не кончает его, — и `sessionStall` смотрит метку
//     первой, состояния не спрашивая;
//   - `{ limit }` — исчерпан лимит. Запись тут ничем не отличается от обычного конца хода
//     (`idle`/`done`, замер ), а лимит виден только строкой, которую сам харнес
//     пишет в `detail` файла `jobs/<id>/state.json`, — оттуда её и читает разбор.
//
// `state: blocked` стенд не ставит нигде: у фоновых сессий живого харнеса такой пары не
// встретилось ни разу, и зелёный на ней стенд был бы зелёным ни на чём — ровно беда,
// снятая . Признак диалога СНИМАЕТСЯ на каждом следующем ходе: живая сессия,
// которой человек ответил, его не носит.
function endTurn(detail, block = null) {
  const jobs = path.join(claudeConfigDir(home), 'jobs', String(id));
  mkdirSync(jobs, { recursive: true });
  writeFileSync(path.join(jobs, 'state.json'), JSON.stringify({ detail }, null, 2) + '\n');
  const command = guardCommand();
  if (!command) {
    note({ kind: 'guard', code: null, stdout: '', stderr: 'записи Stop-хука в файле настроек нет' });
    mark(block?.waitingFor
      ? { status: 'waiting', state: 'working', waitingFor: block.waitingFor }
      : { status: 'idle', state: 'done', waitingFor: null });
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    // `shell: true` — потому что в файле настроек лежит СТРОКА команды, и разбирает её
    // шелл: так её исполняет настоящий харнес, и кавычки вокруг путей ставятся ради него.
    const hook = spawn(command, {
      cwd: process.cwd(),
      env: process.env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    hook.stdout.on('data', (c) => { out += c; });
    hook.stderr.on('data', (c) => { err += c; });
    hook.on('close', (code) => {
      note({ kind: 'guard', code, stdout: out.trim(), stderr: err.trim() });
      // `idle`/`done` — то, чем настоящий Claude Code метит сессию, отдавшую ход: замер
      // 2026-09-02 на 2.1.251. Прежде стенд метил её `blocked`, и подставной
      // прогон был зелёным на состоянии, которого живой harness не выдаёт вовсе. Разбор
      // такого стопа — предмет : доклад идёт только на МОЛЧАЛИВЫЙ конец хода, а
      // после отправленного сообщения не идёт.
      mark(block?.waitingFor
        ? { status: 'waiting', state: 'working', waitingFor: block.waitingFor }
        : { status: 'idle', state: 'done', waitingFor: null });
      resolve(code);
    });
    hook.stdin.end(JSON.stringify({ session_id: sessionId, cwd: process.cwd() }));
  });
}

function git(args) {
  const r = spawnSync('git', ['-C', process.cwd(), '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', ...args], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

async function act(action) {
  // Пауза внутри хода — не украшение. Отметки store ложатся кругами надзирателя: забор
  // mailbox'а он замечает своим кругом, а отправку видит сразу. Ход живой сессии идёт
  // секундами и минутами, и порядок отметок там задан с запасом; схлопнутый в миллисекунды
  // ход этот порядок ломает — `deliveredAt` может лечь ПОЗЖЕ отправки, и штатный конец хода
  // прочитался бы как молчаливый (`stallStands`). Пауза возвращает стенду масштаб
  // жизни, а не обходит проверку.
  if (action.wait) {
    await new Promise((r) => { setTimeout(r, action.wait); });
    note({ kind: 'wait', ms: action.wait });
    return;
  }
  // Правка в рабочем дереве: без неё `promptobus review` возвращается на пустом диффе, не подняв
  // reviewer'а вовсе, — то есть половина круга оркестрации не проверялась бы.
  if (action.write) {
    const file = path.join(process.cwd(), action.write.path);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, action.write.text);
    note({ kind: 'write', path: action.write.path });
    return;
  }
  // Коммит нужен уборке: `promptobus done` снимает только доказанно безлюдный и слитый каталог, а
  // незакоммиченная правка держит worktree на месте по построению.
  if (action.commit) {
    const added = git(['add', '-A']);
    const made = git(['commit', '-m', action.commit.message, '-q']);
    note({ kind: 'commit', status: made.status, out: `${added.out}\n${made.out}`.trim() });
    return;
  }
  if (action.tool === 'promptobus_mailbox') {
    const res = await rpc('tools/call', { name: 'promptobus_mailbox', arguments: action.args ?? {} });
    note({ kind: 'mailbox', text: textOf(res), isError: res?.result?.isError === true });
    return;
  }
  if (action.tool === 'promptobus_send') {
    const res = await rpc('tools/call', { name: 'promptobus_send', arguments: action.args ?? {} });
    note({ kind: 'send', args: action.args, text: textOf(res), isError: res?.result?.isError === true });
    return;
  }
  if (action.tool === 'promptobus_task') {
    const res = await rpc('tools/call', { name: 'promptobus_task', arguments: action.args ?? {} });
    note({ kind: 'task', text: textOf(res), isError: res?.result?.isError === true });
    return;
  }
  note({ kind: 'unknown-action', action });
}

let turnNo = 0;
// Ходы играются по одному: стук может прийти посреди хода, и два хода внахлёст перепутали
// бы порядок сообщений на шине. Очередь — цепочка обещаний, длиной в один ход.
let queue = Promise.resolve();

function playTurn(reason) {
  queue = queue.then(async () => {
    const turn = script.turns?.[turnNo] ?? null;
    const no = turnNo;
    turnNo += 1;
    mark({ status: 'busy', state: 'working', waitingFor: null });
    note({ kind: 'turn', no, reason, actions: (turn?.do ?? []).length });
    for (const action of turn?.do ?? []) {
      try {
        await act(action);
      } catch (e) {
        note({ kind: 'action-failed', action, error: e.message });
      }
    }
    // Причина стопа: своя у хода, иначе общая. Строка уезжает в `detail` и оттуда в разбор
    // стопа — она и есть то, что человек прочитает в докладе надзирателя. У хода с лимитом
    // причина и есть строка лимита: разбор ловит её шаблоном в том же `detail`.
    const block = turn?.block ?? null;
    await endTurn(block?.limit ?? turn?.detail ?? 'turn finished; awaiting next cycle', block);
  }).catch((e) => { note({ kind: 'turn-failed', error: e.message }); });
  return queue;
}

// --- сокет --------------------------------------------------------------------------

// Провод driver'а: одно соединение, две строки построчного JSON — auth и сама инъекция.
// Токен здесь СВЕРЯЕТСЯ следом, но соединение не рвётся: на macOS настоящий слушатель его
// не проверяет вовсе (`authRequired` включается только на Windows), и отказ здесь красил
// бы стенд там, где живой канал работает.
const server = createServer((conn) => {
  let data = '';
  conn.setEncoding('utf8');
  conn.on('data', (chunk) => { data += chunk; });
  conn.on('error', () => {});
  conn.on('end', () => {
    const lines = data.split('\n').filter((l) => l.trim());
    const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
    const auth = parsed[0];
    const injection = parsed[1];
    note({
      kind: 'knock',
      lines: lines.length,
      auth: auth?.type === 'auth',
      tokenOk: auth?.token === token,
      from: injection?.from ?? null,
      msgV: injection?.msgV ?? null,
      body: injection?.message?.content ?? null,
    });
    conn.destroy();
    // Соединение без второй строки — смок `doctor`: чужого хода он не трогает.
    if (injection) playTurn('knock');
  });
});

function farewell(code) {
  try { server.close(); } catch { /* уже закрыт */ }
  try { rmSync(socketPath, { force: true }); } catch { /* сокета могло не быть */ }
  try { mcp.kill('SIGTERM'); } catch { /* ребёнок уже мёртв */ }
  note({ kind: 'stopped', code });
  process.exit(0);
}

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => farewell(sig));

server.listen(socketPath, async () => {
  note({ kind: 'up', address, task, home: busHome, socket: socketPath, prompt: (prompt ?? '').length });
  // Рукопожатие — то же, что делает Claude Code: `initialize`, следом уведомление о
  // готовности. Им же участник сдаёт свой contact point (`onJoin` сервера), и без
  // него будить его было бы нечем.
  const hello = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'promptobus-e2e-participant', version: '1' },
  });
  note({ kind: 'initialize', protocol: hello?.result?.protocolVersion ?? null, server: hello?.result?.serverInfo?.name ?? null });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await playTurn('start');
});
