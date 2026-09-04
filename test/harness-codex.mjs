// Подставной harness Codex: бинарь `codex`, говорящий JSON-RPC `app-server` в stdio.
// Не `*.test.mjs` — раннер берёт из каталога только их.
//
// Стенд повторяет живые промахи протокола, на которых стоит driver:
// поток без хода не возобновляется, steer до turn/started отказывает, thread/items/list
// отвечает «not supported yet», запрос одобрения без ответа вешает ход, read-only
// песочница не пишет файл.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { PROVEN_CODEX_VERSION } from '../lib/driver-codex.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const CODEX_HOME_VAR = 'PROMPTOBUS_E2E_CODEX';
export const LIMIT_VAR = 'CODEX_STUB_LIMIT';
export const APPROVAL_VAR = 'CODEX_STUB_ASK_APPROVAL';
export const FIRST_DELAY_VAR = 'CODEX_STUB_FIRST_DELAY_MS';
export const HANG_FIRST_VAR = 'CODEX_STUB_HANG_FIRST';
export const HARNESS_VERSION = `codex-cli ${PROVEN_CODEX_VERSION}`;

export function addrKey(address) {
  return String(address).replace(/[^A-Za-z0-9._-]+/g, '-');
}

export function scriptFile(home, address) {
  return path.join(home, 'scripts', `${addrKey(address)}.json`);
}

export function traceFile(home, address) {
  return path.join(home, 'trace', `${addrKey(address)}.jsonl`);
}

export function planParticipant(home, address, script) {
  mkdirSync(path.dirname(scriptFile(home, address)), { recursive: true });
  writeFileSync(scriptFile(home, address), `${JSON.stringify(script, null, 2)}\n`);
  return script;
}

export function readTrace(home, address) {
  try {
    return readFileSync(traceFile(home, address), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  } catch {
    return [];
  }
}

export function diagnoseTrace(home, address, tail = 8) {
  return `след ${address}: ${JSON.stringify(readTrace(home, address).slice(-tail))}`;
}

function note(home, address, ev) {
  const file = traceFile(home, address ?? 'anon');
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...ev })}\n`);
}

function threadsDir(home) {
  return path.join(home, 'threads');
}

function threadFile(home, id) {
  return path.join(threadsDir(home), `${id}.json`);
}

function readThread(home, id) {
  try {
    return JSON.parse(readFileSync(threadFile(home, id), 'utf8'));
  } catch {
    return null;
  }
}

function writeThread(home, t) {
  mkdirSync(threadsDir(home), { recursive: true });
  writeFileSync(threadFile(home, t.id), `${JSON.stringify(t, null, 2)}\n`);
  return t;
}

function listThreads(home) {
  let names = [];
  try {
    names = readdirSync(threadsDir(home));
  } catch {
    return [];
  }
  return names.map((n) => {
    try {
      return JSON.parse(readFileSync(path.join(threadsDir(home), n), 'utf8'));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function newId() {
  return `01e2e${randomUUID().replace(/-/g, '').slice(0, 21)}`;
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

export async function installHarness({ binDir, env = process.env } = {}) {
  const { stubCommand, withStubPath } = await import('./sandbox.mjs');
  const home = mkdtempSync(path.join(os.tmpdir(), 'promptobus-codex-'));
  armCleanup(home);
  for (const dir of ['scripts', 'trace', 'threads', 'state']) {
    mkdirSync(path.join(home, dir), { recursive: true });
  }
  stubCommand(binDir, 'codex', `import { codexMain } from ${JSON.stringify(path.join(here, 'harness-codex.mjs'))};\n`
    + 'await codexMain(process.argv.slice(2));\n');
  const restore = withStubPath(binDir);
  const was = env.PROMPTOBUS_CODEX_HOME;
  env[CODEX_HOME_VAR] = home;
  env.PROMPTOBUS_CODEX_HOME = path.join(home, 'state');
  env.PROMPTOBUS_CODEX_READY_MS = env.PROMPTOBUS_CODEX_READY_MS ?? '20000';
  env.PROMPTOBUS_CODEX_TURN_MS = env.PROMPTOBUS_CODEX_TURN_MS ?? '20000';
  env.PROMPTOBUS_CODEX_LIMIT_MS = env.PROMPTOBUS_CODEX_LIMIT_MS ?? '400';
  return {
    home,
    stateHome: path.join(home, 'state'),
    restore: () => {
      restore();
      delete env[CODEX_HOME_VAR];
      if (was === undefined) delete env.PROMPTOBUS_CODEX_HOME;
      else env.PROMPTOBUS_CODEX_HOME = was;
    },
  };
}

const armed = new Set();
let hooked = false;
const exit0 = process.exit;

function armCleanup(home) {
  armed.add(home);
  if (hooked) return;
  hooked = true;
  const clean = () => {
    for (const dir of armed) {
      const state = path.join(dir, 'state', 'sessions');
      let files = [];
      try {
        files = readdirSync(state);
      } catch {
        files = [];
      }
      for (const f of files.filter((n) => n.endsWith('.json'))) {
        try {
          const rec = JSON.parse(readFileSync(path.join(state, f), 'utf8'));
          for (const pid of [rec.holderPid, rec.appPid]) {
            if (pidAlive(pid)) {
              try { process.kill(pid, 'SIGKILL'); } catch { /* уже нет */ }
            }
          }
        } catch {
          // Запись битая — сносить каталог всё равно.
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
  process.on('exit', clean);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { clean(); exit0.call(process, 130); });
  }
}

export async function codexMain(argv) {
  if (argv.includes('--version') || argv[0] === '--version') {
    process.stdout.write(`${HARNESS_VERSION}\n`);
    return;
  }
  if (argv[0] === 'resume') {
    process.stdout.write(`resuming ${argv[1] ?? '?'}\n`);
    return;
  }
  if (argv[0] === 'exec') {
    process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'smoke' })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'turn.completed', status: 'completed' })}\n`);
    return;
  }
  if (argv[0] === 'app-server' && argv.includes('--stdio')) {
    await appServer();
    return;
  }
  process.stderr.write(`codex-stub: неизвестная команда ${argv.join(' ')}\n`);
  process.exitCode = 2;
}

async function appServer() {
  const home = process.env[CODEX_HOME_VAR];
  if (!home) {
    process.stderr.write('codex-stub: нет PROMPTOBUS_E2E_CODEX\n');
    process.exit(2);
  }
  let buf = '';
  const pendingApprovals = new Map();
  const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  const reply = (id, result) => emit({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => emit({ jsonrpc: '2.0', id, error: { code, message } });
  const notify = (method, params) => emit({ jsonrpc: '2.0', method, params });

  const ask = (method, params) => new Promise((resolve) => {
    const id = `srv-${randomUUID()}`;
    pendingApprovals.set(id, resolve);
    emit({ jsonrpc: '2.0', id, method, params });
  });

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
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
        continue;
      }
      if (msg.id !== undefined && pendingApprovals.has(msg.id)) {
        pendingApprovals.get(msg.id)(msg.result ?? msg);
        pendingApprovals.delete(msg.id);
        continue;
      }
      if (!msg.method) continue;
      try {
        await handle(msg);
      } catch (err) {
        if (msg.id !== undefined) fail(msg.id, -32000, err.message);
      }
    }
  });

  async function handle(msg) {
    const { id, method, params = {} } = msg;
    if (method === 'initialize') {
      reply(id, { userAgent: 'codex-stub', platformOs: process.platform, experimentalApi: true });
      const exhausted = process.env[LIMIT_VAR] === '1';
      setTimeout(() => {
        notify('account/rateLimits/updated', {
          usedPercent: exhausted ? 100 : 12,
          primary: { usedPercent: exhausted ? 100 : 12, resetsAt: '2099-01-01T00:00:00Z' },
          planType: 'plus',
          rateLimitReachedType: exhausted ? 'primary' : null,
        });
      }, 20);
      return;
    }
    if (method === 'model/list') {
      reply(id, { data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.4-mini' }] });
      return;
    }
    if (method === 'thread/items/list') {
      fail(id, -32601, 'not supported yet');
      return;
    }
    if (method === 'thread/start') {
      const t = writeThread(home, {
        id: newId(),
        cwd: params.cwd,
        sandbox: params.sandbox,
        approvalPolicy: params.approvalPolicy,
        model: params.model,
        config: params.config ?? {},
        name: null,
        rollout: false,
        busy: false,
        turnStarted: false,
        turnId: null,
        status: 'idle',
      });
      reply(id, { thread: { id: t.id, status: { type: 'idle' } } });
      notify('thread/status/changed', { type: 'idle' });
      return;
    }
    if (method === 'thread/resume') {
      const t = readThread(home, params.threadId);
      if (!t || !t.rollout) {
        fail(id, -32600, `no rollout found for thread id ${params.threadId}`);
        return;
      }
      reply(id, { thread: { id: t.id, status: { type: 'idle' } } });
      return;
    }
    if (method === 'thread/name/set') {
      const t = readThread(home, params.threadId);
      if (!t) {
        fail(id, -32602, 'thread not loaded');
        return;
      }
      t.name = params.name;
      writeThread(home, t);
      reply(id, { ok: true, name: t.name });
      return;
    }
    if (method === 'thread/read' || method === 'thread/list' || method === 'thread/loaded/list') {
      const all = listThreads(home);
      if (method === 'thread/read') {
        const t = readThread(home, params.threadId);
        if (!t) {
          fail(id, -32602, 'thread not loaded');
          return;
        }
        reply(id, { thread: t });
        return;
      }
      reply(id, { data: all, threads: all });
      return;
    }
    if (method === 'turn/start' || method === 'review/start') {
      const threadId = params.threadId;
      const t = readThread(home, threadId);
      if (!t) {
        fail(id, -32602, 'thread not loaded');
        return;
      }
      const turnId = newId();
      t.busy = true;
      t.turnStarted = false;
      t.turnId = turnId;
      t.status = 'active';
      writeThread(home, t);
      reply(id, { turn: { id: turnId, status: 'inProgress' } });
      setTimeout(() => playTurn(home, t, turnId, params, ask, notify), 40);
      return;
    }
    if (method === 'turn/steer') {
      const t = readThread(home, params.threadId);
      if (!t || !t.turnStarted) {
        fail(id, -32600, 'no active turn to steer');
        return;
      }
      const address = addressOf(t);
      note(home, address, { kind: 'steer', turnId: t.turnId, expected: params.expectedTurnId });
      t.steered = (t.steered ?? 0) + 1;
      writeThread(home, t);
      reply(id, { turn: { id: t.turnId, status: 'inProgress' } });
      return;
    }
    if (method === 'turn/interrupt') {
      const t = readThread(home, params.threadId);
      if (t) {
        t.busy = false;
        t.turnStarted = false;
        t.status = 'idle';
        writeThread(home, t);
        notify('turn/completed', { id: t.turnId, status: 'interrupted' });
        notify('thread/status/changed', { type: 'idle' });
      }
      reply(id, { ok: true });
      return;
    }
    fail(id, -32601, `Method not found: ${method}`);
  }
}

// Шина в оверрайде едет не каноническим ключом `promptobus`, а с префиксом.
// Настоящий Codex именует инструменты ключом конфига; stub зовёт короткие имена
// `tools/call` и должен найти НАШ stdio-сервер среди записей. Идентичность шины —
// env `PROMPTOBUS_ROLE` / `PROMPTOBUS_ADDRESS`, а не литерал ключа: после переименования
// литерал молча отдавал бы null, круг E2E зеленел бы подъёмом без вызова инструментов.
function busServer(thread) {
  const servers = thread.config?.mcp_servers;
  if (!servers || typeof servers !== 'object') return null;
  for (const cfg of Object.values(servers)) {
    const env = cfg?.env;
    if (!env || typeof env !== 'object') continue;
    if (env.PROMPTOBUS_ROLE || env.PROMPTOBUS_ADDRESS) return cfg;
  }
  return null;
}

function addressOf(thread) {
  const env = busServer(thread)?.env;
  return env?.PROMPTOBUS_ROLE ?? env?.PROMPTOBUS_ADDRESS ?? null;
}

async function playTurn(home, started, turnId, params, ask, notify) {
  const hang = process.env[HANG_FIRST_VAR] === '1';
  const delay = Number(process.env[FIRST_DELAY_VAR]);
  if (Number.isFinite(delay) && delay > 0) {
    await new Promise((r) => { setTimeout(r, delay); });
  }
  if (hang) {
    await new Promise(() => {});
    return;
  }
  const t = readThread(home, started.id) ?? started;
  t.turnStarted = true;
  t.turnId = turnId;
  writeThread(home, t);
  notify('thread/status/changed', { type: 'active', activeFlags: [] });
  notify('turn/started', { id: turnId, status: 'inProgress' });
  const address = addressOf(t);
  const sandbox = t.sandbox;
  if (process.env[APPROVAL_VAR] === '1') {
    await ask('execCommandApproval', { command: 'true', cwd: t.cwd });
  }
  const input = params.input?.[0]?.text
    ?? params.target?.instructions
    ?? '';
  note(home, address, { kind: 'turn-start', turnId, text: String(input).slice(0, 80), sandbox });
  await runScript({ home, address, thread: t, sandbox });
  const live = readThread(home, t.id) ?? t;
  live.busy = false;
  live.turnStarted = false;
  live.rollout = true;
  live.status = 'idle';
  writeThread(home, live);
  notify('item/completed', { type: 'agentMessage', item: { type: 'agentMessage', text: 'ход сыгран' } });
  notify('turn/completed', { id: turnId, status: 'completed' });
  notify('thread/status/changed', { type: 'idle' });
  note(home, address, { kind: 'turn-end', turnId, steered: live.steered ?? 0 });
}

async function runScript({ home, address, thread, sandbox }) {
  if (!address) return;
  let script = { turns: [] };
  try {
    script = JSON.parse(readFileSync(scriptFile(home, address), 'utf8'));
  } catch {
    return;
  }
  const nFile = path.join(home, 'turns', `${addrKey(address)}.json`);
  let n = 0;
  try {
    n = Number(JSON.parse(readFileSync(nFile, 'utf8')).n) || 0;
  } catch {
    n = 0;
  }
  mkdirSync(path.dirname(nFile), { recursive: true });
  writeFileSync(nFile, `${JSON.stringify({ n: n + 1 })}\n`);
  const plan = script.turns?.[n] ?? null;
  if (!plan) return;
  const cfg = busServer(thread);
  let bus = null;
  if (cfg && (plan.do ?? []).some((a) => a.tool)) bus = await openBus(cfg);
  for (const action of plan.do ?? []) {
    if (action.wait) {
      await new Promise((r) => { setTimeout(r, action.wait); });
      continue;
    }
    if (action.write) {
      if (sandbox === 'read-only') {
        note(home, address, { kind: 'write-denied', path: action.write.path });
        continue;
      }
      const file = path.join(thread.cwd, action.write.path);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, action.write.text);
      note(home, address, { kind: 'write', path: action.write.path });
      continue;
    }
    if (action.commit) {
      spawnSync('git', ['-C', thread.cwd, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'add', '-A']);
      spawnSync('git', ['-C', thread.cwd, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid',
        'commit', '-m', action.commit.message]);
      note(home, address, { kind: 'commit' });
      continue;
    }
    if (action.tool && bus) {
      try {
        const answer = await bus.rpc('tools/call', { name: action.tool, arguments: action.args ?? {} });
        const text = answer?.result?.content?.map((c) => c.text).join('\n') ?? '';
        note(home, address, { kind: 'tool', tool: action.tool, isError: !!answer?.result?.isError, text: text.slice(0, 400) });
      } catch (e) {
        note(home, address, { kind: 'action-failed', tool: action.tool, error: e.message });
      }
    }
  }
  if (bus) await bus.close();
}

async function openBus(cfg) {
  const child = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let seq = 0;
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const resolve = pending.get(msg.id);
        if (resolve) {
          pending.delete(msg.id);
          resolve(msg);
        }
      } catch {
        // Посторонняя строка — беда сервера.
      }
    }
  });
  const rpc = (method, params) => {
    const rid = (seq += 1);
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`нет ответа на ${method}`)), 30000);
      pending.set(rid, (m) => { clearTimeout(timer); resolve(m); });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: rid, method, params })}\n`);
    return answer;
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-stub', version: '1' } });
  return { rpc, close: () => new Promise((r) => { child.on('close', r); child.stdin.end(); }) };
}
