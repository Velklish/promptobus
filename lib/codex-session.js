import { createHash } from 'node:crypto';
import {
  appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodexRpc } from './codex-rpc.js';
import { cliVersion } from '../base.js';
import { foreignSession, logWarden, writeWake } from './store.js';

// Реестр потоков участника Codex и держатель процесса `app-server`. Снаружи этот файл
// не импортирует никто, кроме driver'а Codex: гейт границы adapter'а держит и его.
//
// **Почему держатель отдельным процессом.** CLI `promptobus spawn` возвращается после
// первого хода и умирает. У Cursor процесс переживает родителя панелью tmux, у Claude Code —
// демоном. У `app-server` такого демона нет: stdio держит тот, кто его открыл. Отсоединённый
// holder и есть этот кто: он держит JSON-RPC, отвечает на одобрения и слушает unix-сокет,
// в который driver кладёт `turn/start` / `turn/steer` / `stop`. Один holder — один участник
// (ADR-037 §2): общий процесс на рабочее место уносит всех своей смертью, а замка на потоке
// у Codex нет.
//
// Дом реестра — `~/.agents/codex`, не `~/.codex`. Второе — дом человека, и писать туда
// сверх того, что кладёт сам Codex, механизм не вправе. `ATI_AGENTS_CODEX_HOME` уводит
// реестр целиком: ею набор ставит его в песочницу.

export const SESSION_ENV_VAR = 'PROMPTOBUS_CODEX_SESSION';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOLD_JS = path.join(here, 'codex-hold.js');

export function codexStateHome(env = process.env) {
  const named = String(env.ATI_AGENTS_CODEX_HOME ?? '').trim();
  return named || path.join(homedir(), '.agents', 'codex');
}

export function sessionsDir(env = process.env) {
  return path.join(codexStateHome(env), 'sessions');
}

export function sessionKey(ref) {
  const flat = String(ref ?? '');
  const head = flat.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).toLowerCase();
  const hash = createHash('sha1').update(flat).digest('hex').slice(0, 12);
  return head ? `${head}-${hash}` : hash;
}

export function sessionFile(ref, env = process.env) {
  return path.join(sessionsDir(env), `${sessionKey(ref)}.json`);
}

// sockaddr_un.sun_path на Darwin — 104 байта вместе с NUL. Дом песочницы набора
// (`$TMPDIR/promptobus-codex-…/state/sessions/…`) легко длиннее, и listen тогда
// даёт EINVAL: держатель не поднимается, а CLI видит только таймаут waitReady.
const SOCK_MAX = 103;

export function socketPath(ref, env = process.env) {
  const name = `${createHash('sha1').update(String(ref ?? '')).digest('hex').slice(0, 12)}.sock`;
  const nested = path.join(sessionsDir(env), name);
  if (Buffer.byteLength(nested) <= SOCK_MAX) return nested;
  return path.join(tmpdir(), `ati-cdx-${name}`);
}

export function holderLogFile(ref, env = process.env) {
  return path.join(sessionsDir(env), `${sessionKey(ref)}.log`);
}

function lockFile(ref, env = process.env) {
  return path.join(sessionsDir(env), `${sessionKey(ref)}.lock`);
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return value;
}

export function readSession(ref, env = process.env) {
  try {
    return JSON.parse(readFileSync(sessionFile(ref, env), 'utf8'));
  } catch {
    return null;
  }
}

export function writeSession(record, env = process.env) {
  return writeJson(sessionFile(record.ref, env), record);
}

export function patchSession(ref, patch, env = process.env) {
  const was = readSession(ref, env);
  if (!was) return null;
  return writeSession({ ...was, ...patch }, env);
}

export function dropSession(ref, env = process.env) {
  for (const file of [sessionFile(ref, env), socketPath(ref, env), lockFile(ref, env), holderLogFile(ref, env)]) {
    rmSync(file, { force: true });
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function listSessions(env = process.env) {
  let names = [];
  try {
    names = readdirSync(sessionsDir(env));
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith('.json')).map((n) => {
    try {
      return JSON.parse(readFileSync(path.join(sessionsDir(env), n), 'utf8'));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

export function findSessionByAddress(home, task, address, env = process.env) {
  return listSessions(env).find((r) => r.home === home && r.task === task && r.address === address) ?? null;
}

// Бюджет преамбулы держателя — те же таймауты, что стоят на запросах в holdMain.
// Окно waitReady без них ловило ложный отказ: initialize + лимит + model/list +
// thread/start + name/set укладываются почти в прежние 60 с, а первый ход ещё
// не начался.
export const INIT_TIMEOUT_MS = 30_000;
export const MODEL_LIST_TIMEOUT_MS = 15_000;
export const THREAD_START_TIMEOUT_MS = 60_000;
export const NAME_SET_TIMEOUT_MS = 10_000;

export function turnWaitMs(env = process.env) {
  const named = Number(env.PROMPTOBUS_CODEX_TURN_MS);
  return Number.isFinite(named) && named > 0 ? named : 120_000;
}

export function limitWaitMs(env = process.env) {
  const named = Number(env.PROMPTOBUS_CODEX_LIMIT_MS);
  return Number.isFinite(named) && named > 0 ? named : 3_000;
}

export function preambleMs(env = process.env) {
  return INIT_TIMEOUT_MS + limitWaitMs(env) + MODEL_LIST_TIMEOUT_MS
    + THREAD_START_TIMEOUT_MS + NAME_SET_TIMEOUT_MS;
}

export function readyMs(env = process.env) {
  const named = Number(env.PROMPTOBUS_CODEX_READY_MS);
  return Number.isFinite(named) && named > 0 ? named : preambleMs(env) + turnWaitMs(env);
}

export const STOP_TIMEOUT_MS = 10_000;
export const STOP_STEP_MS = 100;

export function rateLimitReached(snap) {
  if (!snap || typeof snap !== 'object') return false;
  if (snap.rateLimitReachedType) return true;
  const windows = [snap.primary, snap.secondary, snap].filter(Boolean);
  return windows.some((w) => Number(w.usedPercent) >= 100);
}

export function rateLimitNote(snap) {
  if (!snap) return null;
  const pct = snap.primary?.usedPercent ?? snap.usedPercent;
  const resets = snap.primary?.resetsAt ?? snap.resetsAt;
  const parts = [
    pct != null ? `лимит ${pct}%` : null,
    resets ? `сброс ${resets}` : null,
    snap.planType ? `план ${snap.planType}` : null,
    snap.rateLimitReachedType ? `достигнут (${snap.rateLimitReachedType})` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

// --- лок одного держателя на поток ------------------------------------------------

export function takeHolderLock(ref, env = process.env) {
  const file = lockFile(ref, env);
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, { flag: 'wx', mode: 0o600 });
    return { ok: true, file };
  } catch {
    let held = null;
    try {
      held = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      held = null;
    }
    if (held && pidAlive(Number(held.pid))) {
      return { ok: false, file, error: `поток уже держит процесс ${held.pid}` };
    }
    rmSync(file, { force: true });
    try {
      writeFileSync(file, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, { flag: 'wx', mode: 0o600 });
      return { ok: true, file };
    } catch {
      return { ok: false, file, error: `лок держателя не взять: ${file}` };
    }
  }
}

export function dropHolderLock(ref, env = process.env) {
  rmSync(lockFile(ref, env), { force: true });
}

// --- клиент держателя -------------------------------------------------------------

function sendHolder(sock, obj, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const client = net.connect(sock);
    let buf = '';
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error(`держатель не ответил за ${timeoutMs} мс`));
    }, timeoutMs);
    client.setEncoding('utf8');
    client.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    client.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf.slice(0, nl)));
      } catch (err) {
        reject(err);
      }
      client.end();
    });
    client.on('connect', () => {
      client.write(`${JSON.stringify(obj)}\n`);
    });
  });
}

export async function holderAsk(ref, op, extra = {}, env = process.env, timeoutMs = 30_000) {
  const rec = readSession(ref, env);
  const sock = rec?.rpcSocket;
  if (!sock) throw new Error('у сессии нет сокета держателя');
  const id = `${process.pid}-${Date.now()}`;
  const ans = await sendHolder(sock, { id, op, ...extra }, timeoutMs);
  if (ans?.error) throw new Error(typeof ans.error === 'string' ? ans.error : ans.error.message ?? JSON.stringify(ans.error));
  return ans?.result ?? ans;
}

export function holderAlive(ref, env = process.env) {
  const rec = readSession(ref, env);
  return !!(rec?.holderPid && pidAlive(rec.holderPid));
}

export function startHolder(ref, env = process.env) {
  const child = spawn(process.execPath, [HOLD_JS, sessionFile(ref, env)], {
    detached: true,
    stdio: 'ignore',
    env: { ...env, ATI_AGENTS_CODEX_HOME: codexStateHome(env) },
  });
  child.unref();
  return child;
}

export async function waitReady(ref, env = process.env, timeoutMs = readyMs(env)) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rec = readSession(ref, env);
    if (rec?.error) return { ok: false, error: rec.error, record: rec };
    if (rec?.state === 'alive' && rec.threadId) return { ok: true, record: rec };
    await new Promise((r) => { setTimeout(r, 50); });
  }
  const rec = readSession(ref, env);
  return {
    ok: false,
    error: rec?.error ?? `держатель не подтвердил подъём за ${timeoutMs} мс`,
    record: rec,
    log: tailLog(ref, env),
  };
}

export function tailLog(ref, env = process.env, n = 20) {
  try {
    return readFileSync(holderLogFile(ref, env), 'utf8').trim().split('\n').slice(-n).join('\n');
  } catch {
    return '';
  }
}

function killRecordPids(record) {
  for (const pid of [record?.holderPid, record?.appPid]) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try { process.kill(-pid, 'SIGKILL'); } catch { /* группы нет или нет прав */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* уже нет */ }
  }
}

export async function reapHolder(ref, env = process.env) {
  const record = readSession(ref, env);
  if (!record) return;
  if (holderAlive(ref, env)) {
    try {
      await holderAsk(ref, 'shutdown', {}, env, 5_000);
    } catch {
      killRecordPids(record);
    }
    await waitStopped(ref, env);
    return;
  }
  killRecordPids(record);
}

export async function waitStopped(ref, env = process.env, timeoutMs = STOP_TIMEOUT_MS) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!holderAlive(ref, env)) return true;
    await new Promise((r) => { setTimeout(r, STOP_STEP_MS); });
  }
  return !holderAlive(ref, env);
}

// --- contact point ----------------------------------------------------------------

export function writeParticipantWake(record, env = process.env) {
  if (!record?.home || !record?.task || !record?.address || !record?.rpcSocket) return null;
  const session = record.threadId ?? null;
  if (session) {
    const held = foreignSession(record.home, record.task, record.address, session);
    if (held) return null;
  }
  const turns = Number(record.turns) || 0;
  return writeWake(record.home, record.task, record.address, {
    socket: `${record.rpcSocket}#${turns}`,
    token: null,
    session,
  });
}

// --- держатель --------------------------------------------------------------------

const APPROVE = {
  execCommandApproval: { ok: { decision: 'approved' }, no: { decision: 'denied' } },
  applyPatchApproval: { ok: { decision: 'approved' }, no: { decision: 'denied' } },
  'item/commandExecution/requestApproval': { ok: { decision: 'accept' }, no: { decision: 'reject' } },
  'item/fileChange/requestApproval': { ok: { decision: 'accept' }, no: { decision: 'reject' } },
  'item/permissions/requestApproval': { ok: { permissions: {}, scope: 'session' }, no: { permissions: {}, scope: 'once' } },
  'mcpServer/elicitation/request': { ok: { action: 'accept', content: {} }, no: { action: 'decline' } },
  'item/tool/requestUserInput': { ok: { response: 'ок' }, no: { response: '' } },
  'currentTime/read': { ok: { currentTime: new Date().toISOString() }, no: { currentTime: new Date().toISOString() } },
};

function looksLikeConfigRead(method, params) {
  if (method === 'config/read') return true;
  const blob = JSON.stringify(params ?? {});
  return /config\/read/.test(blob);
}

const MUTATION_APPROVALS = new Set([
  'execCommandApproval',
  'applyPatchApproval',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
]);

function pathsOfApproval(params) {
  const out = [];
  const add = (p) => {
    if (p != null && p !== '') out.push(String(p));
  };
  add(params?.cwd);
  add(params?.path);
  add(params?.file);
  add(params?.cwdOverride);
  const changes = params?.changes ?? params?.fileChanges ?? params?.files ?? params?.patches
    ?? params?.item?.changes ?? params?.item?.fileChanges;
  if (Array.isArray(changes)) {
    for (const c of changes) add(c?.path ?? c?.file ?? c?.filename ?? c?.target);
  } else if (changes && typeof changes === 'object') {
    for (const k of Object.keys(changes)) add(k);
  }
  add(params?.item?.path);
  add(params?.item?.file);
  add(params?.change?.path);
  add(params?.patch?.path);
  return out;
}

function resolveTarget(raw, cwd) {
  const s = String(raw ?? '');
  if (!s) return null;
  if (path.isAbsolute(s)) return s;
  if (!cwd) return null;
  return path.resolve(cwd, s);
}

function insideRoots(abs, roots) {
  if (!abs) return false;
  return roots.some((root) => abs === root || abs.startsWith(`${root}${path.sep}`));
}

export function decideApproval(method, params, record) {
  if (looksLikeConfigRead(method, params)) {
    return { allow: false, why: 'config/read отдаёт секреты личного конфига — клиент механизма его не зовёт и не одобряет' };
  }
  const known = APPROVE[method];
  if (!known) {
    return { allow: false, why: `неизвестный тип запроса одобрения «${method}»`, unknown: true };
  }
  if (method === 'mcpServer/elicitation/request' || method === 'currentTime/read' || method === 'item/tool/requestUserInput') {
    return { allow: true };
  }
  const reviewer = record.role === 'reviewer';
  if (reviewer) {
    if (method === 'item/permissions/requestApproval') {
      return { allow: false, why: 'reviewer не расширяет права' };
    }
    if (method === 'execCommandApproval' || method === 'applyPatchApproval'
      || method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      return { allow: false, why: 'reviewer read-only: мутация дерева отказана' };
    }
    return { allow: true };
  }
  if (MUTATION_APPROVALS.has(method)) {
    const roots = [record.cwd, ...(record.addDirs ?? [])].filter(Boolean);
    const raws = pathsOfApproval(params);
    if (!raws.length) {
      return { allow: false, why: 'цель действия не разобрана' };
    }
    for (const raw of raws) {
      const abs = resolveTarget(raw, record.cwd);
      if (!abs) return { allow: false, why: 'цель действия не разобрана' };
      if (!insideRoots(abs, roots)) {
        return { allow: false, why: `действие вне cwd/addDirs: ${abs}` };
      }
    }
  }
  const blob = JSON.stringify(params ?? {});
  if (/danger-full-access|dangerously-bypass|workspace-write.*outside/i.test(blob)) {
    return { allow: false, why: 'повышение прав отказано' };
  }
  return { allow: true };
}

// Префикс ключей оверрайда `config.mcp_servers`. Оверрайд мержится с личным конфигом
// владельца ПОЛЯМИ, не записями: одно имя и два транспорта валят загрузку целиком
// (`url is not supported for stdio`). Личный набор driver не видит (`config/read` отдаёт
// секреты). Префикс уводит наши записи в пространство, которого в каноне нет. Имя
// инструмента, которое видит модель, собирается из ключа конфига (`mcp__<ключ>__<инструмент>`
// — строка бинаря Codex и замер BL-509), поэтому `phrases.tool` обязан звать то же имя.
export const CODEX_MCP_PREFIX = 'ati-agents-';

export function codexMcpName(name) {
  const n = String(name ?? '');
  if (!n) return n;
  return n.startsWith(CODEX_MCP_PREFIX) ? n : `${CODEX_MCP_PREFIX}${n}`;
}

/**
 * Набор MCP рабочего места — в форму `mcp_servers` конфига Codex. Транспорта у него два, и
 * поля их НЕ пересекаются: `streamable_http` знает `url`, `http_headers`,
 * `bearer_token_env_var`; `stdio` — `command`, `args`, `env`, `cwd`. Чужое поле не
 * игнорируется, а валит загрузку КОНФИГА ЦЕЛИКОМ, и участник не поднимается вовсе —
 * `thread/start` отвечает «failed to load configuration: args is not supported for
 * streamable_http in `mcp_servers.<имя>`». Достаётся это и записи, которой мы поля не
 * давали: оверрайд `config.mcp_servers` мержится с личным конфигом владельца ПОЛЯМИ, и
 * `args` из перевода склеивается с его `url` по тому же имени.
 *
 * Замер codex-cli 0.146.0, `thread/start` в изолированный `CODEX_HOME`: `{args, env}` поверх
 * url-сервера — тот самый отказ; `{url, http_headers}` — поток поднялся. Столкновение ИМЁН
 * через транспорт закрывает префикс ключа (`BL-509`): наш url поверх личного stdio того же
 * канонического имени больше не склеивается, потому что в оверрайд уезжает `ati-agents-<имя>`.
 * Обезвредить чужую половину пустым `command` по-прежнему нельзя — `null` разбирается как
 * значение; личный конфиг для сверки имён механизму недоступен (`config/read` отдаёт секреты
 * и клиенту запрещён).
 *
 * Незнакомый транспорт (`sse` у Claude Code своего вида в Codex не имеет) не отдаётся вовсе:
 * запись без `url` и без `command` — та же несобираемая половина.
 */
export function codexMcpServers(servers) {
  const out = {};
  const skipped = [];
  for (const [name, cfg] of Object.entries(servers ?? {})) {
    if (!cfg || typeof cfg !== 'object') {
      skipped.push(name);
      continue;
    }
    const type = String(cfg.type ?? (cfg.url ? 'http' : 'stdio'));
    const key = codexMcpName(name);
    if (type === 'http' || type === 'streamable_http') {
      if (!cfg.url) {
        skipped.push(name);
        continue;
      }
      out[key] = { url: String(cfg.url) };
      const headers = cfg.headers ?? cfg.http_headers;
      if (headers && typeof headers === 'object' && Object.keys(headers).length) {
        out[key].http_headers = { ...headers };
      }
      continue;
    }
    if (type === 'stdio' && cfg.command) {
      out[key] = { command: cfg.command, args: cfg.args ?? [], env: cfg.env ?? {} };
      continue;
    }
    skipped.push(name);
  }
  return { servers: out, skipped };
}

function logHold(file, line) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
}

/**
 * Тело отсоединённого держателя. Аргумент — путь к записи сессии: ref из argv держатель
 * не собирает, чтобы не разъехаться с ключом файла.
 */
export async function holdMain(argv = process.argv.slice(2), env = process.env) {
  const file = argv[0];
  if (!file) {
    process.stderr.write('codex-hold: нет пути записи сессии\n');
    process.exit(2);
  }
  let record;
  try {
    record = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    process.stderr.write(`codex-hold: не прочитана запись: ${err.message}\n`);
    process.exit(2);
  }
  const ref = record.ref;
  const logFile = holderLogFile(ref, env);
  const log = (line) => logHold(logFile, line);
  const lock = takeHolderLock(ref, env);
  if (!lock.ok) {
    patchSession(ref, { error: lock.error }, env);
    log(`лок: ${lock.error}`);
    process.exit(3);
  }

  const sock = socketPath(ref, env);
  rmSync(sock, { force: true });

  const child = spawn(record.bin, ['app-server', '--stdio'], {
    cwd: record.cwd,
    env: record.childEnv ?? env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  log(`app-server pid ${child.pid} bin ${record.bin}`);

  const methodsCalled = [];
  const noteMethod = (m) => {
    if (!methodsCalled.includes(m)) methodsCalled.push(m);
  };

  const rpc = CodexRpc({ stdin: child.stdin, stdout: child.stdout }, {
    onLog: (_dir, obj) => {
      if (obj.method) noteMethod(obj.method);
    },
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => log(`stderr ${String(chunk).slice(0, 400)}`));

  const state = {
    threadId: null,
    busy: false,
    turnStarted: false,
    currentTurnId: null,
    threadStatus: null,
    rateLimits: null,
    lastUnknownApproval: null,
    nameSet: null,
    turns: 0,
    methodsCalled,
  };
  const waiters = new Set();
  const wakeWaiters = (pred) => {
    for (const w of [...waiters]) {
      if (w.pred()) {
        waiters.delete(w);
        w.resolve();
      }
    }
  };

  rpc.onNotification((msg) => {
    const p = msg.params ?? {};
    if (msg.method === 'account/rateLimits/updated') {
      state.rateLimits = p;
      patchSession(ref, { rateLimits: p }, env);
      log(`rateLimits usedPercent=${p.primary?.usedPercent ?? p.usedPercent ?? '?'}`);
    }
    if (msg.method === 'thread/status/changed') {
      state.threadStatus = p.type ?? p.status ?? p;
      if (p.type === 'idle' || p.status === 'idle') state.busy = false;
      if (p.type === 'active') state.busy = true;
    }
    if (msg.method === 'turn/started') {
      state.busy = true;
      state.turnStarted = true;
      state.currentTurnId = p.id ?? p.turn?.id ?? state.currentTurnId;
      patchSession(ref, { busy: true, currentTurnId: state.currentTurnId }, env);
      wakeWaiters(() => state.turnStarted);
      log(`turn/started ${state.currentTurnId}`);
    }
    if (msg.method === 'turn/completed') {
      state.busy = false;
      state.turnStarted = false;
      state.currentTurnId = p.id ?? p.turn?.id ?? state.currentTurnId;
      state.turns += 1;
      state.lastTurn = p;
      patchSession(ref, {
        busy: false,
        turns: state.turns,
        lastTurn: { id: state.currentTurnId, status: p.status ?? p.turn?.status ?? null, at: new Date().toISOString() },
        methodsCalled,
      }, env);
      writeParticipantWake({ ...readSession(ref, env), turns: state.turns, rpcSocket: sock, threadId: state.threadId }, env);
      wakeWaiters(() => !state.busy);
      log(`turn/completed ${state.currentTurnId} ${p.status ?? ''}`);
    }
  });

  rpc.onServerRequest((msg) => {
    noteMethod(`srv:${msg.method}`);
    const rec = readSession(ref, env) ?? record;
    const decision = decideApproval(msg.method, msg.params, rec);
    const known = APPROVE[msg.method];
    if (decision.unknown) {
      state.lastUnknownApproval = { method: msg.method, at: new Date().toISOString(), why: decision.why };
      patchSession(ref, { lastUnknownApproval: state.lastUnknownApproval }, env);
      if (rec.home && rec.task) {
        logWarden(rec.home, rec.task, `Codex: ${decision.why} — ход отказан, смотри promptobus status`);
      }
      log(`одобрение unknown deny ${msg.method}`);
      return known?.no ?? { decision: 'denied' };
    }
    if (!decision.allow) {
      log(`одобрение deny ${msg.method} ${decision.why}`);
      if (rec.home && rec.task) logWarden(rec.home, rec.task, `Codex: отказ одобрения ${msg.method}: ${decision.why}`);
      return known?.no ?? { decision: 'denied' };
    }
    log(`одобрение allow ${msg.method}`);
    if (msg.method === 'currentTime/read') return { currentTime: new Date().toISOString() };
    return known.ok;
  });

  let server = null;

  const failHold = (error) => {
    patchSession(ref, { error, state: 'failed', methodsCalled }, env);
    log(`отказ: ${error}`);
    try {
      child.kill('SIGKILL');
    } catch {
      // Процесса уже нет.
    }
    dropHolderLock(ref, env);
    rmSync(sock, { force: true });
    process.exit(1);
  };

  child.on('exit', (code, sig) => {
    log(`app-server exit ${code} ${sig ?? ''}`);
    const rec = readSession(ref, env);
    if (rec?.stopping) return;
    if (rec && rec.state !== 'failed') {
      patchSession(ref, { state: 'dead', error: `app-server завершился (${code ?? sig})` }, env);
    }
    dropHolderLock(ref, env);
    rmSync(sock, { force: true });
    try { server?.close(); } catch { /* listen мог ещё не состояться */ }
    process.exit(1);
  });

  server = net.createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', async (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let req;
      try {
        req = JSON.parse(buf.slice(0, nl));
      } catch (err) {
        conn.write(`${JSON.stringify({ id: null, error: err.message })}\n`);
        conn.end();
        return;
      }
      buf = buf.slice(nl + 1);
      try {
        const result = await handleOp(req);
        conn.write(`${JSON.stringify({ id: req.id, result })}\n`);
      } catch (err) {
        conn.write(`${JSON.stringify({ id: req.id, error: err.message })}\n`);
      }
      conn.end();
    });
  });

  async function handleOp(req) {
    if (req.op === 'status') {
      return {
        threadId: state.threadId,
        busy: state.busy,
        turnStarted: state.turnStarted,
        currentTurnId: state.currentTurnId,
        threadStatus: state.threadStatus,
        rateLimits: state.rateLimits,
        lastUnknownApproval: state.lastUnknownApproval,
        nameSet: state.nameSet,
        turns: state.turns,
        methodsCalled,
        appPid: child.pid,
      };
    }
    if (req.op === 'waitStarted') {
      if (state.turnStarted) return { currentTurnId: state.currentTurnId };
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('нет turn/started')), req.timeoutMs ?? 15_000);
        waiters.add({
          pred: () => state.turnStarted,
          resolve: () => { clearTimeout(timer); resolve(); },
        });
      });
      return { currentTurnId: state.currentTurnId };
    }
    if (req.op === 'rpc') {
      const ans = await rpc.request(req.method, req.params ?? {}, req.timeoutMs ?? 60_000);
      if (ans.error) throw new Error(ans.error.message ?? JSON.stringify(ans.error));
      return ans.result ?? {};
    }
    if (req.op === 'shutdown') {
      patchSession(ref, { stopping: true }, env);
      try {
        if (state.busy && state.threadId) {
          await rpc.request('turn/interrupt', { threadId: state.threadId }, 5_000);
        }
      } catch {
        // Прерывать уже нечего.
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // Процесса уже нет.
      }
      setTimeout(() => {
        dropHolderLock(ref, env);
        rmSync(sock, { force: true });
        process.exit(0);
      }, 50);
      return { ok: true };
    }
    throw new Error(`неизвестная операция держателя «${req.op}»`);
  }

  const listenHolder = () => new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(sock, () => {
      try { chmodSync(sock, 0o600); } catch { /* платформа без chmod на сокете */ }
      log(`listen ${sock}`);
      resolve();
    });
  });

  try {
    const init = await rpc.request('initialize', {
      clientInfo: { name: 'ati-agents', version: cliVersion() },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: ['mcpServer/startupStatus/updated'],
      },
    }, INIT_TIMEOUT_MS);
    if (init.error) throw new Error(init.error.message ?? JSON.stringify(init.error));
    log('initialize ok');

    try {
      const lim = await rpc.waitNotification('account/rateLimits/updated', () => true, limitWaitMs(env));
      state.rateLimits = lim.params ?? null;
    } catch {
      log('rateLimits: уведомления не было — не отказ');
    }
    if (rateLimitReached(state.rateLimits)) {
      const note = rateLimitNote(state.rateLimits);
      failHold(`лимит аккаунта Codex${note ? `: ${note}` : ''} — подъём отложен до сброса`);
      return;
    }

    if (record.model) {
      try {
        const listed = await rpc.request('model/list', {}, MODEL_LIST_TIMEOUT_MS);
        const ids = (listed.result?.data ?? listed.result?.models ?? listed.result ?? [])
          .map((m) => m.id ?? m);
        if (Array.isArray(ids) && ids.length && !ids.includes(record.model)) {
          failHold(`модель «${record.model}» неизвестна app-server (model/list)`);
          return;
        }
      } catch (err) {
        log(`model/list: ${err.message} — сверка пропущена`);
      }
    }

    const mcp = codexMcpServers(record.mcpServers);
    if (mcp.skipped.length) {
      log(`MCP не поехали — транспорта такой формы у Codex нет: ${mcp.skipped.join(', ')}`);
    }
    const startParams = {
      cwd: record.cwd,
      sandbox: record.sandbox,
      approvalPolicy: record.approvalPolicy,
      model: record.model,
      config: { mcp_servers: mcp.servers },
    };
    if (record.addDirs?.length) startParams.runtimeWorkspaceRoots = record.addDirs;
    const started = await rpc.request('thread/start', startParams, THREAD_START_TIMEOUT_MS);
    if (started.error) throw new Error(started.error.message ?? JSON.stringify(started.error));
    state.threadId = started.result?.thread?.id ?? started.result?.id;
    if (!state.threadId) throw new Error('thread/start не вернул id потока');
    log(`thread/start ${state.threadId}`);

    const threadName = `promptobus:${record.task}:${record.address}`;
    try {
      const named = await rpc.request('thread/name/set', { threadId: state.threadId, name: threadName }, NAME_SET_TIMEOUT_MS);
      state.nameSet = !named.error;
      if (named.error) log(`thread/name/set: ${named.error.message ?? 'отказ'} — слой имени ненаблюдавшийся`);
    } catch (err) {
      state.nameSet = false;
      log(`thread/name/set: ${err.message} — слой имени ненаблюдавшийся`);
    }

    patchSession(ref, {
      holderPid: process.pid,
      appPid: child.pid,
      rpcSocket: sock,
      threadId: state.threadId,
      nameSet: state.nameSet,
      rateLimits: state.rateLimits,
      methodsCalled,
      state: 'starting',
      busy: true,
    }, env);

    await listenHolder();

    const first = record.role === 'reviewer'
      ? await rpc.request('review/start', {
        threadId: state.threadId,
        target: { type: 'custom', instructions: record.prompt },
        delivery: 'inline',
      }, turnWaitMs(env))
      : await rpc.request('turn/start', {
        threadId: state.threadId,
        ...(record.effort ? { effort: record.effort } : {}),
        input: [{ type: 'text', text: record.prompt }],
      }, turnWaitMs(env));
    if (first.error) throw new Error(first.error.message ?? JSON.stringify(first.error));
    state.currentTurnId = first.result?.turn?.id ?? first.result?.id ?? state.currentTurnId;
    state.busy = true;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('первый ход не кончился — поток без хода на диске не существует')), turnWaitMs(env));
      waiters.add({
        pred: () => !state.busy && state.turns > 0,
        resolve: () => { clearTimeout(timer); resolve(); },
      });
      if (!state.busy && state.turns > 0) {
        clearTimeout(timer);
        resolve();
      }
    });

    patchSession(ref, {
      state: 'alive',
      busy: false,
      threadId: state.threadId,
      holderPid: process.pid,
      appPid: child.pid,
      rpcSocket: sock,
      nameSet: state.nameSet,
      turns: state.turns,
      rateLimits: state.rateLimits,
      methodsCalled,
      error: null,
    }, env);
    writeParticipantWake({
      ...readSession(ref, env), rpcSocket: sock, threadId: state.threadId, turns: state.turns,
    }, env);
    log('alive');
  } catch (err) {
    failHold(err.message);
  }
}
