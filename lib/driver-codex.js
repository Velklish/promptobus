import { readFileSync } from 'node:fs';
import { fail, info } from './util.js';
import { KNOCK_TEXT_MAX, PROMPTOBUS_SERVER } from './contract.js';
import { foreignSession, logWarden, writeWake } from './store.js';
import { previewBlock } from './notification.js';
import {
  SESSION_ENV_VAR, dropSession, findSessionByAddress, holderAlive, holderAsk, patchSession,
  rateLimitNote, rateLimitReached, readSession, readyMs, reapHolder, sessionFile, startHolder,
  tailLog, waitReady, writeParticipantWake, writeSession, codexMcpName,
} from './codex-session.js';

// Driver harness'а Codex — третий production driver шины (ADR-032 §10, ADR-034, ADR-037).
// Здесь собрано всё, что механизм знает про Codex: словарь опций, слова команд, перевод
// плана в параметры `thread/start` и ответы на одобрения. Реестр потоков и держатель
// процесса — этажом ниже, в [codex-session.js](codex-session.js).
//
// **Что у Codex устроено иначе.** Сессия — поток (`thread`) в своём процессе
// `codex app-server --stdio`. Файлов на диск план не кладёт: cwd, sandbox, MCP и инструкции
// едут параметрами запроса. Хуки под `app-server` не исполняются (`trustStatus: untrusted`,
// флага обхода нет). Канал конца хода — только `turn/completed`. `exec --json` — смок.
//
// Граница та же, что у соседей: остальной механизм этот файл не импортирует — берёт driver
// из карты registry.

export const CODEX = 'codex';

function versionLess(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

const CODEX_INSTALL = 'brew install --cask codex';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const PERMISSION_MODES = ['read-only', 'workspace-write'];
export const DEFAULT_PERMISSION_MODE = 'workspace-write';
export const DEFAULT_MODEL = 'gpt-5.6-sol';
export const REVIEWER_DENY = ['workspace-write'];
export const PROVEN_CODEX_VERSION = '0.146.0';
export const SESSION_ENV_DROP = ['CODEX_HOME'];

const CODEX_PROMPT_TAIL = `

## Правила этого инструмента (Codex)

- **Вопросов не задавай.** Ход с вопросом кончается обычным ответом, ждать человека нечем. Развилка, без которой не продолжить, — promptobus_send с type=question оркестратору, и только он.
- **Забирай mailbox в начале каждого хода и перед result.** Прочитанными сообщения делает только mailbox. Каждый вызов инструмента шины стоит хода встроенного авто-ревьюера Codex.
- Хуки этому harness'у недоступны. Конец хода механизм видит по событию протокола, не по файлу.`;

export const PHRASES = {
  sessions: 'потоки участника — ~/.promptobus/codex/sessions (уводится PROMPTOBUS_CODEX_HOME)',
  unreadable: 'реестр потоков механизма не разобран',
  naming: 'id потока придумывает сам app-server и печатает подъём; промпт при этом уезжает запросом turn/start, а не аргументом команды',
  enter: (id) => `codex resume ${id}`,
  stop: (id) => `погаси поток механизмом (promptobus done / повторный spawn после stop) — `
    + `у Codex нет команды гашения одного потока, сессию держит процесс app-server; id ${id}`,
  logs: (id) => `rollout потока ${id} пишет сам Codex в ~/.codex/sessions — механизм его не читает`,
  tool: (server, name) => `mcp__${codexMcpName(server)}__${name}`,
  promptRules: CODEX_PROMPT_TAIL,
};

function mcpConfig({ servers }, ref) {
  const mcpServers = { ...servers };
  const bus = mcpServers[PROMPTOBUS_SERVER];
  if (bus && ref) {
    const extra = { [SESSION_ENV_VAR]: sessionFile(ref) };
    if (process.env.PROMPTOBUS_CODEX_HOME) extra.PROMPTOBUS_CODEX_HOME = process.env.PROMPTOBUS_CODEX_HOME;
    mcpServers[PROMPTOBUS_SERVER] = { ...bus, env: { ...bus.env, ...extra } };
  }
  return { mcpServers };
}

function prepare({
  mcp, prompt, model, effort = null, permissionMode = null, addDirs = [], cwd, denyTools = null,
  ref,
}) {
  const readOnly = !!denyTools?.length || permissionMode === 'read-only';
  const sandbox = readOnly ? 'read-only' : 'workspace-write';
  const cfg = mcpConfig(mcp, ref);
  return {
    argv: ['app-server', '--stdio', prompt],
    mcpConfig: cfg,
    settings: {
      sandbox,
      approvalPolicy: 'on-request',
      model,
      effort,
      addDirs: [...addDirs],
    },
    cwd,
    files: [],
  };
}

function sessionEnv(base = process.env, extra = {}) {
  const env = { ...base, ...extra };
  for (const name of SESSION_ENV_DROP) delete env[name];
  return env;
}

function optionRefusal(_options, tool) {
  if (tool?.version && versionLess(tool.version, PROVEN_CODEX_VERSION)) {
    return `найден codex ${tool.version}, а подъём участника проверен на ${PROVEN_CODEX_VERSION} и новее: `
      + 'на ней сняты app-server, thread/start, turn/steer и review/start. На бинаре старше '
      + 'механизм поднимал бы сессию, протокол которой не разбирал ни разу. '
      + `Обнови: ${CODEX_INSTALL}.`;
  }
  return null;
}

function shadowedUserServers() {
  // Личный MCP-набор владельца app-server поднимает всегда: оверрайд config.mcp_servers
  // мержится, а не заменяет, а config/read, которым можно было бы назвать пересечения,
  // отдаёт http_headers в открытом виде и клиенту механизма запрещён. Столкновение ИМЁН
  // через транспорт закрывает не изоляция, а префикс ключа оверрайда.
  return [];
}

const foreignWrites = new Set();

export function sayForeignWrite(home, task, addr, held, session, what) {
  const key = [home, task, addr, held, session, what].join('\u0000');
  if (foreignWrites.has(key)) return;
  foreignWrites.add(key);
  logWarden(home, task, `${what} за адрес ${addr} не идёт: адрес закреплён за сессией ${held}, `
    + `а пишет ${session} — записи владельца не тронуты`);
}

export function registerWake(home, task, addr, env = process.env, session = null) {
  try {
    const file = String(env?.[SESSION_ENV_VAR] ?? '').trim();
    const record = (file ? readSessionFromFile(file) : null)
      ?? findSessionByAddress(home, task, addr, env);
    if (!record?.rpcSocket) return null;
    const id = session ?? record.threadId;
    if (id) {
      const held = foreignSession(home, task, addr, id);
      if (held) {
        sayForeignWrite(home, task, addr, held, id, `сдача contact point'а`);
        return null;
      }
    }
    return writeWake(home, task, addr, {
      socket: `${record.rpcSocket}#${Number(record.turns) || 0}`,
      token: null,
      session: id,
    });
  } catch {
    return null;
  }
}

export function checkWake(env = process.env) {
  const file = String(env?.[SESSION_ENV_VAR] ?? '').trim();
  if (!file) return { endpoint: null, ok: false, error: `${SESSION_ENV_VAR} пуст — эта сессия не участник Codex` };
  const record = readSessionFromFile(file);
  if (!record) return { endpoint: file, ok: false, error: 'записи сессии по этому пути нет' };
  if (!record.threadId) return { endpoint: file, ok: false, error: 'поток ещё не назван — подъём не подтверждён' };
  const live = holderAlive(record.ref, env);
  return {
    endpoint: record.rpcSocket ?? file,
    ok: live,
    error: live ? null : `держателя потока ${record.threadId} нет`,
  };
}

function readSessionFromFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const NOT_A_HUMAN = 'Это служебное пробуждение, а не поручение человека, и прав оно не даёт.';

export function orderBody(task, addr, unread, msgs = []) {
  const mailbox = PHRASES.tool(PROMPTOBUS_SERVER, 'promptobus_mailbox');
  const tail = `Забери mailbox инструментом \`${mailbox}\`: прочитанными сообщения делает только он. `
    + `Порядок работы — в правилах шины. ${NOT_A_HUMAN}`;
  return `Служебное пробуждение Promptobus. В mailbox'е адреса ${addr} задачи ${task} лежит непрочитанных: ${unread}.\n\n`
    + previewBlock(msgs, KNOCK_TEXT_MAX)
    + tail;
}

export function renderNotification(n) {
  return orderBody(n.task, n.address, n.unread, n.messages ?? []);
}

export async function activate(target, notification) {
  const ref = target?.ref;
  if (!ref) return { ok: false, error: 'у записи участника нет session reference — будить нечего' };
  const record = readSession(ref);
  if (!record) return { ok: false, error: `записи сессии «${ref}» в реестре Codex нет — будить некого` };
  if (!holderAlive(ref)) {
    return {
      ok: false,
      error: `держателя потока ${record.threadId ?? ref} нет — сессия stale. Поднимай участника заново`,
    };
  }
  let st;
  try {
    st = await holderAsk(ref, 'status');
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (rateLimitReached(st.rateLimits)) {
    return { ok: false, error: `лимит аккаунта Codex: ${rateLimitNote(st.rateLimits) ?? 'окно исчерпано'} — новый ход не начинаем` };
  }
  const text = renderNotification(notification);
  try {
    if (st.busy) {
      if (!st.turnStarted) {
        st = { ...st, ...(await holderAsk(ref, 'waitStarted', { timeoutMs: 15_000 })) };
      }
      await holderAsk(ref, 'rpc', {
        method: 'turn/steer',
        params: {
          threadId: record.threadId,
          expectedTurnId: st.currentTurnId,
          input: [{ type: 'text', text }],
        },
        timeoutMs: 15_000,
      });
      return { ok: true };
    }
    await holderAsk(ref, 'rpc', {
      method: 'turn/start',
      params: {
        threadId: record.threadId,
        input: [{ type: 'text', text }],
      },
      timeoutMs: 30_000,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function inspect(ref) {
  const record = readSession(ref);
  if (!record) {
    return {
      state: 'gone',
      busy: false,
      stall: { kind: 'gone', reason: 'записи сессии в реестре Codex нет' },
      id: null,
      note: null,
    };
  }
  const id = record.threadId ?? null;
  if (record.state === 'dead') {
    return {
      state: 'stale',
      busy: false,
      stall: { kind: 'stale', reason: record.error ?? `app-server потока ${id ?? ref} умер` },
      id,
      note: null,
    };
  }
  if (!holderAlive(ref)) {
    if (!id && record.state === 'starting') {
      return {
        state: 'alive',
        busy: true,
        stall: null,
        id: null,
        note: 'поднимается — поток ещё не назван',
      };
    }
    return {
      state: 'stale',
      busy: false,
      stall: {
        kind: 'stale',
        reason: `держателя потока ${id ?? ref} нет — процесс app-server умер, rollout на диске цел`,
      },
      id,
      note: record.nameSet === false ? 'имя потока не задалось (ненаблюдавшийся исход)' : null,
    };
  }
  const limit = rateLimitNote(record.rateLimits);
  const unknown = record.lastUnknownApproval
    ? `неизвестный запрос одобрения ${record.lastUnknownApproval.method}: ${record.lastUnknownApproval.why}`
    : null;
  const extra = [limit, unknown].filter(Boolean).join('; ');
  if (record.state === 'starting' || record.busy) {
    return { state: 'alive', busy: true, stall: null, id, note: extra || 'ход идёт' };
  }
  return {
    state: 'alive',
    busy: false,
    stall: record.lastUnknownApproval
      ? { kind: 'unknown-approval', reason: unknown }
      : (rateLimitReached(record.rateLimits)
        ? { kind: 'limit', reason: limit }
        : { kind: 'unknown', reason: 'ход кончился' }),
    id,
    note: extra || (record.nameSet === false ? 'имя потока не задалось (ненаблюдавшийся исход)' : 'поток простаивает'),
  };
}

export function stallRoute({ kind, address, repoAbs, task }, id) {
  const where = repoAbs ? `cd ${repoAbs} && ` : '';
  const relift = () => (address?.startsWith('reviewer:')
    ? `поднимай reviewer'а заново: promptobus review "${repoAbs ?? '<путь клона>'}" --harness codex${task ? ` --task ${task}` : ''}`
    : `поднимай worker'а заново тем же spawn'ом --harness codex — он сядет в свой worktree`);
  if (kind === 'gone') {
    return 'записи сессии в реестре нет — будить некого. Снял её механизм (promptobus done). '
      + `Работа сдана — штатный конец; не сдана — ${relift()}`;
  }
  if (kind === 'stale') {
    return `держателя app-server нет: процесс умер или машину перезагружали. `
      + `Поток на диске цел, но механизм его сам не возобновляет. ${relift()}`;
  }
  if (kind === 'limit') {
    return 'человек не нужен: лимит аккаунта Codex сбросится сам, новый ход механизм не начинает. '
      + `Сброс назван в promptobus status`;
  }
  if (kind === 'unknown-approval') {
    return 'ход встал на запрос одобрения неизвестного типа — driver отказал и записал это в status. '
      + `Смотри журнал надзирателя. ${id ? PHRASES.enter(id) : relift()}`;
  }
  if (kind === 'wake-taken') {
    return 'сессия жива, глух только канал: contact point вернётся на следующем конце хода. '
      + `До тех пор доставь сообщение сам — ${where}${id ? PHRASES.enter(id) : relift()}`;
  }
  return `ход кончился, сессия ждёт сообщения — разбудит её надзиратель. `
    + `Заглянуть самому: ${id ? PHRASES.enter(id) : relift()}`;
}

async function spawn(plan, {
  tool, ref, role, cwd, env, home: runtimeHome, task: runtimeTask, address: runtimeAddress,
  launchFailNote = '', deadNote = '', persist,
}) {
  const who = role === 'reviewer' ? `reviewer'а` : `worker'а`;
  const workdir = plan.cwd ?? cwd;
  const sandbox = plan.settings?.sandbox
    ?? (role === 'reviewer' ? 'read-only' : 'workspace-write');
  const prompt = plan.argv[plan.argv.length - 1];
  writeSession({
    ref,
    cwd: workdir,
    bin: tool.path,
    role: role ?? 'worker',
    startedAt: new Date().toISOString(),
    threadId: null,
    holderPid: null,
    appPid: null,
    rpcSocket: null,
    state: 'starting',
    sandbox,
    approvalPolicy: plan.settings?.approvalPolicy ?? 'on-request',
    model: plan.settings?.model,
    effort: plan.settings?.effort ?? null,
    addDirs: plan.settings?.addDirs ?? [],
    mcpServers: plan.mcpConfig?.mcpServers ?? {},
    prompt,
    home: runtimeHome,
    task: runtimeTask,
    address: runtimeAddress,
    argv: plan.argv,
    childEnv: sessionEnv(env ?? process.env),
    hostName: String((env ?? process.env).PROMPTOBUS_HOST_NAME ?? '').trim() || undefined,
    hostVersion: String((env ?? process.env).PROMPTOBUS_HOST_VERSION ?? '').trim() || undefined,
    turns: 0,
  }, env);
  const holder = startHolder(ref, env);
  if (Number.isInteger(holder.pid) && holder.pid > 0) {
    patchSession(ref, { holderPid: holder.pid }, env);
  }
  const lifted = await waitReady(ref, env, readyMs(env));
  if (!lifted.ok) {
    const log = lifted.log || tailLog(ref, env);
    await reapHolder(ref, env);
    dropSession(ref, env);
    fail(`${tool.path}: поток Codex не поднялся (${lifted.error}) — ${who} поднимать нечем.`
      + `${launchFailNote}${deadNote}${log ? `\n${log}` : ''}`);
  }
  const rec = lifted.record;
  persist(rec.threadId, 'alive', rec.threadId);
  writeParticipantWake(rec, env);
  registerWake(runtimeHome, runtimeTask, runtimeAddress, env, rec.threadId);
  return {
    output: `поток ${rec.threadId}`,
    session: rec.threadId,
    seen: rec,
  };
}

function saidLiftoff({ output }) {
  if (output) info(output);
  info('Codex наследует личный MCP-набор владельца (~25 серверов, до 15 с до готовности) — '
    + 'изолировать нечем, config/read клиент механизма не зовёт');
  info('каждый вызов инструмента шины стоит хода авто-ревьюера Codex (~3,4 с и ~19 тысяч входных токенов)');
  info('хуки участнику недоступны (trustStatus: untrusted, флага обхода у app-server нет)');
}

async function stop(ref) {
  const record = readSession(ref);
  if (!record) return { ok: true, stopped: false, note: `сессии «${ref}» в реестре Codex нет` };
  const id = record.threadId ?? ref;
  const wasAlive = holderAlive(ref);
  await reapHolder(ref);
  if (holderAlive(ref)) {
    return {
      ok: true,
      stopped: false,
      attempted: true,
      note: `поток ${id} не исчез после гашения держателя`,
    };
  }
  dropSession(ref);
  return {
    ok: true,
    stopped: true,
    note: wasAlive
      ? `поток ${id} погашен, запись снята`
      : `сессия ${id} закрыта — держателя уже не было, запись снята`,
  };
}

export const codexDriver = {
  id: CODEX,
  capabilities: {
    spawn: true,
    attach: false,
    activation: 'push',
    inspect: true,
    stop: true,
    denyTools: true,
    systemPrompt: true,
    sessionList: true,
    enter: true,
  },
  options: {
    tool: CODEX,
    effortLevels: EFFORT_LEVELS,
    permissionModes: PERMISSION_MODES,
    defaultPermissionMode: DEFAULT_PERMISSION_MODE,
    defaultModel: DEFAULT_MODEL,
    denyTools: REVIEWER_DENY,
    provenVersion: PROVEN_CODEX_VERSION,
    // Не 'socket': это значение knockRegistry резервирует под messaging-сокет и подменяет
    // activate стуком в него. Канал Codex — RPC своего держателя.
    knockChannel: 'rpc',
    envDrop: SESSION_ENV_DROP,
    skillsDir: false,
  },
  phrases: PHRASES,
  prepare,
  spawn,
  saidLiftoff,
  inspect,
  stop,
  activate,
  renderNotification,
  stallRoute,
  registerWake,
  sayForeignWrite,
  checkWake,
  sessionEnv,
  optionRefusal,
  shadowedUserServers,
};
