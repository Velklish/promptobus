import { readFileSync } from 'node:fs';
import { fail, info } from './util.js';
import { KNOCK_TEXT_MAX, PROMPTOBUS_SERVER } from './contract.js';
import { foreignSession, logWarden, writeWake } from './store.js';
import { previewBlock } from './notification.js';
import {
  SESSION_ENV_VAR, dropSession, findSessionByAddress, holderAlive, holderAsk, patchSession,
  rateLimitNote, rateLimitReached, readSession, readyMs, reapHolder, sessionFile, startHolder,
  tailLog, waitReady, writeParticipantWake, writeSession, codexMcpName, codexMcpPrefix,
  listSessions,
} from './codex-session.js';
import { probeCodex } from './model-routing/adapter-codex.js';

// Codex harness driver — the third production bus driver.
// Everything the mechanism knows about Codex lives here: option vocabulary, command
// words, turning a plan into `thread/start` params, and approval replies. The thread
// registry and the process holder are in [codex-session.js](codex-session.js).
//
// **What Codex does differently.** A session is a thread in its own
// `codex app-server --stdio` process. The plan writes no files: cwd, sandbox, MCP and
// instructions go as request params. Hooks under `app-server` do not run
// (`trustStatus: untrusted`, no bypass flag). The end-of-turn channel is
// `turn/completed` only. `exec --json` is a smoke check.
//
// Same boundary as the neighbours: the rest of the mechanism does not import this
// file — it takes the driver from the registry map.

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

## Rules for this tool (Codex)

- **Do not ask questions.** A turn that asks a question ends as a normal reply; there is nobody to wait for. A fork you cannot continue without is promptobus_send with type=question to the orchestrator, and only that.
- **Fetch the mailbox at the start of every turn and before a result.** Only mailbox marks messages read. Each bus tool call costs a turn of Codex's built-in auto-reviewer.
- This harness has no hooks. The mechanism sees the end of a turn from a protocol event, not from a file.`;

// The tool name a Codex session calls an MCP server's tool by: the config key with
// the harness's own wrapper around it. One function, because the key and the name
// the participant is told to type must never be able to drift — they agree today
// only because they are the same string built once.
const mcpToolName = (server, name, prefix) => `mcp__${codexMcpName(server, prefix)}__${name}`;

export const PHRASES = {
  sessions: 'participant threads — ~/.promptobus/codex/sessions (overridden by PROMPTOBUS_CODEX_HOME)',
  unreadable: 'the mechanism thread registry is unreadable',
  naming: 'the thread id is chosen by app-server itself and printed on lift; the prompt then goes out as a turn/start request, not as a command argument',
  enter: (id) => `codex resume ${id}`,
  stop: (id) => `stop the thread through the mechanism (promptobus done / another spawn after stop) — `
    + `Codex has no single-thread kill command, the app-server process holds the session; id ${id}`,
  logs: (id) => `thread ${id} rollout is written by Codex itself in ~/.codex/sessions — the mechanism does not read it`,
  tool: (server, name, host) => mcpToolName(server, name, codexMcpPrefix(host)),
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
    return `found codex ${tool.version}, and participant lift is proven on ${PROVEN_CODEX_VERSION} and newer: `
      + 'that release has app-server, thread/start, turn/steer and review/start. On an older binary '
      + 'the mechanism would lift a session whose protocol it has never parsed. '
      + `Update: ${CODEX_INSTALL}.`;
  }
  return null;
}

function shadowedUserServers() {
  // The owner personal MCP set is always lifted by app-server: the config.mcp_servers
  // override merges, it does not replace, and config/read, which could name collisions,
  // returns http_headers in the clear and is forbidden to the mechanism client. A NAME
  // collision across transports is closed by the override key prefix, not by isolation.
  return [];
}

const foreignWrites = new Set();

export function sayForeignWrite(home, task, addr, held, session, what) {
  const key = [home, task, addr, held, session, what].join('\u0000');
  if (foreignWrites.has(key)) return;
  foreignWrites.add(key);
  logWarden(home, task, `${what} for address ${addr} is refused: the address is bound to session ${held}, `
    + `and ${session} is writing — the owner's records were left untouched`);
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
        sayForeignWrite(home, task, addr, held, id, `contact-point handoff`);
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
  if (!file) return { endpoint: null, ok: false, error: `${SESSION_ENV_VAR} is empty — this session is not a Codex participant` };
  const record = readSessionFromFile(file);
  if (!record) return { endpoint: file, ok: false, error: 'no session record at this path' };
  if (!record.threadId) return { endpoint: file, ok: false, error: 'the thread is not named yet — lift is not confirmed' };
  const live = holderAlive(record.ref, env);
  return {
    endpoint: record.rpcSocket ?? file,
    ok: live,
    error: live ? null : `no holder for thread ${record.threadId}`,
  };
}

function readSessionFromFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const NOT_A_HUMAN = 'This is a service wake, not a human assignment, and it grants no permissions.';

// `prefix` rather than a host: the wake text names the mailbox tool of ONE session,
// and the wake path has that session's record, not the host that lifted it. No
// prefix names the tool without its key — see `renderNotification` for who can
// reach that branch and why it is a sentence rather than a refusal.
export function orderBody(task, addr, unread, msgs = [], prefix = null) {
  const mailbox = prefix
    ? `\`${mcpToolName(PROMPTOBUS_SERVER, 'promptobus_mailbox', prefix)}\``
    : `this session's ${PROMPTOBUS_SERVER} mailbox tool`;
  const tail = `Fetch the mailbox with ${mailbox}: only it marks messages read. `
    + `The working order is in the bus rules. ${NOT_A_HUMAN}`;
  return `Promptobus service wake. The mailbox for address ${addr} on task ${task} has unread: ${unread}.\n\n`
    + previewBlock(msgs, KNOCK_TEXT_MAX)
    + tail;
}

/**
 * Wake text for one participant — one parameter, which is the arity the driver
 * contract declares (`src/driver.ts`). The tool name inside it is namespaced by the
 * CONSUMER, and neither this function nor a `Notification` carries a host, so the
 * namespace comes off the SESSION RECORD — the same channel the holder reads it
 * from — found by the task and address the notification names.
 *
 * `activate` never comes through here: it holds the exact record and calls
 * `orderBody` with its prefix, so a wake is never sent under a key looked up by
 * two fields. This path is the seam — `drivers.js` for a socket-knock driver, or a
 * consumer asking what the text would say — and a registry that holds no such
 * record gets the tool named without its key rather than a throw, because the seam
 * has to return a string and a wrong key would be worse than an unnamed one.
 */
export function renderNotification(n) {
  return orderBody(n.task, n.address, n.unread, n.messages ?? [], sessionPrefix(n.task, n.address));
}

/** The override key prefix of a live participant, or `null` — nothing holds one. */
function sessionPrefix(task, address, env = process.env) {
  try {
    return listSessions(env).find((r) => r.task === task && r.address === address)?.mcpPrefix ?? null;
  } catch {
    // No registry home is named at all, so there is no record to ask.
    return null;
  }
}

export async function activate(target, notification) {
  const ref = target?.ref;
  if (!ref) return { ok: false, error: 'the participant record has no session reference — nothing to wake' };
  const record = readSession(ref);
  if (!record) return { ok: false, error: `no session record «${ref}» in the Codex registry — nobody to wake` };
  if (!holderAlive(ref)) {
    return {
      ok: false,
      error: `no holder for thread ${record.threadId ?? ref} — the session is stale. Lift the participant again`,
    };
  }
  // The wake text names the mailbox tool by the override key, and the key's prefix
  // lives on the record. A record written before the prefix moved onto it carries
  // none, and there is nothing to derive one from here — the host that lifted the
  // session is long gone. So it refuses in the same shape as the line above, with
  // the same way out, rather than letting the name be built without a prefix.
  if (!record.mcpPrefix) {
    return {
      ok: false,
      error: `the session record for ${record.threadId ?? ref} predates the MCP key prefix; lift the participant again`,
    };
  }
  let st;
  try {
    st = await holderAsk(ref, 'status');
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (rateLimitReached(st.rateLimits)) {
    return { ok: false, error: `Codex account limit: ${rateLimitNote(st.rateLimits) ?? 'window exhausted'} — a new turn is not started` };
  }
  const text = orderBody(notification.task, notification.address, notification.unread,
    notification.messages ?? [], record.mcpPrefix);
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
      stall: { kind: 'gone', reason: 'no session record in the Codex registry' },
      id: null,
      note: null,
    };
  }
  const id = record.threadId ?? null;
  if (record.state === 'dead') {
    return {
      state: 'stale',
      busy: false,
      stall: { kind: 'stale', reason: record.error ?? `app-server of thread ${id ?? ref} died` },
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
        note: 'rising — the thread is not named yet',
      };
    }
    return {
      state: 'stale',
      busy: false,
      stall: {
        kind: 'stale',
        reason: `no holder for thread ${id ?? ref} — the app-server process died, the rollout on disk is intact`,
      },
      id,
      note: record.nameSet === false ? 'thread name did not apply (unobserved outcome)' : null,
    };
  }
  const limit = rateLimitNote(record.rateLimits);
  const unknown = record.lastUnknownApproval
    ? `unknown approval request ${record.lastUnknownApproval.method}: ${record.lastUnknownApproval.why}`
    : null;
  const extra = [limit, unknown].filter(Boolean).join('; ');
  if (record.state === 'starting' || record.busy) {
    return { state: 'alive', busy: true, stall: null, id, note: extra || 'the turn is running' };
  }
  return {
    state: 'alive',
    busy: false,
    stall: record.lastUnknownApproval
      ? { kind: 'unknown-approval', reason: unknown }
      : (rateLimitReached(record.rateLimits)
        ? { kind: 'limit', reason: limit }
        : { kind: 'unknown', reason: 'the turn ended' }),
    id,
    note: extra || (record.nameSet === false ? 'thread name did not apply (unobserved outcome)' : 'the thread is idle'),
  };
}

export function stallRoute({ kind, address, repoAbs, task }, id) {
  const where = repoAbs ? `cd ${repoAbs} && ` : '';
  const relift = () => (address?.startsWith('reviewer:')
    ? `lift the reviewer again: promptobus review "${repoAbs ?? '<clone path>'}" --harness codex${task ? ` --task ${task}` : ''}`
    : `lift the worker again with the same spawn --harness codex — it will sit in its own worktree`);
  if (kind === 'gone') {
    return 'no session record in the registry — nobody to wake. The mechanism dropped it (promptobus done). '
      + `Work delivered — a normal end; not delivered — ${relift()}`;
  }
  if (kind === 'stale') {
    return `no app-server holder: the process died or the machine was rebooted. `
      + `The thread on disk is intact, but the mechanism does not resume it by itself. ${relift()}`;
  }
  if (kind === 'limit') {
    return 'no human is needed: the Codex account limit will reset itself, the mechanism does not start a new turn. '
      + `The reset is named in promptobus status`;
  }
  if (kind === 'unknown-approval') {
    return 'the turn stalled on an unknown approval request type — the driver denied it and recorded this in status. '
      + `See the warden journal. ${id ? PHRASES.enter(id) : relift()}`;
  }
  if (kind === 'wake-taken') {
    return 'the session is alive, only the channel is deaf: the contact point will return on the next end of turn. '
      + `Until then deliver the message yourself — ${where}${id ? PHRASES.enter(id) : relift()}`;
  }
  return `the turn ended, the session waits for a message — the warden will wake it. `
    + `Look in yourself: ${id ? PHRASES.enter(id) : relift()}`;
}

async function spawn(plan, {
  tool, ref, role, cwd, env, host, home: runtimeHome, task: runtimeTask, address: runtimeAddress,
  launchFailNote = '', deadNote = '', persist,
}) {
  const who = role === 'reviewer' ? 'the reviewer' : 'the worker';
  const workdir = plan.cwd ?? cwd;
  const sandbox = plan.settings?.sandbox
    ?? (role === 'reviewer' ? 'read-only' : 'workspace-write');
  const prompt = plan.argv[plan.argv.length - 1];
  writeSession({
    ref,
    cwd: workdir,
    bin: tool.bin,
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
    // The override key prefix travels in the RECORD because the process that applies
    // it is the detached holder: it is handed this file and nothing else, and there is
    // no host in it to ask. Written where the host is in reach, read where the config
    // is built — so the key and the tool name in the prompt come from one value.
    mcpPrefix: codexMcpPrefix(host),
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
    fail(`${tool.bin}: Codex thread did not lift (${lifted.error}) — nothing to lift ${who} with.`
      + `${launchFailNote}${deadNote}${log ? `\n${log}` : ''}`);
  }
  const rec = lifted.record;
  persist(rec.threadId, 'alive', rec.threadId);
  writeParticipantWake(rec, env);
  registerWake(runtimeHome, runtimeTask, runtimeAddress, env, rec.threadId);
  return {
    output: `thread ${rec.threadId}`,
    session: rec.threadId,
    seen: rec,
  };
}

function saidLiftoff({ output }) {
  if (output) info(output);
  info('Codex inherits the owner personal MCP set (~25 servers, up to 15 s to ready) — '
    + 'there is nothing to isolate with, the mechanism client does not call config/read');
  info('each bus tool call costs a turn of the Codex auto-reviewer (~3.4 s and ~19 thousand input tokens)');
  info('hooks are unavailable to the participant (trustStatus: untrusted, app-server has no bypass flag)');
}

async function stop(ref) {
  const record = readSession(ref);
  if (!record) return { ok: true, stopped: false, note: `no session «${ref}» in the Codex registry` };
  const id = record.threadId ?? ref;
  const wasAlive = holderAlive(ref);
  await reapHolder(ref);
  if (holderAlive(ref)) {
    return {
      ok: true,
      stopped: false,
      attempted: true,
      note: `thread ${id} did not disappear after the holder was stopped`,
    };
  }
  dropSession(ref);
  return {
    ok: true,
    stopped: true,
    note: wasAlive
      ? `thread ${id} stopped, the record dropped`
      : `session ${id} closed — the holder was already gone, the record dropped`,
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
    // Not 'socket': knockRegistry reserves that value for a messaging socket and
    // replaces activate with a knock to it. The Codex channel is the holder RPC.
    knockChannel: 'rpc',
    envDrop: SESSION_ENV_DROP,
    skillsDir: false,
  },
  // The account gate, asked before any session exists ([adapter-codex.js](model-routing/adapter-codex.js)).
  // The launch context is handed over from here rather than rebuilt there: the
  // probe must start app-server under exactly the environment a lift would, and
  // `sessionEnv` is where that isolation is decided.
  availability: {
    tool: CODEX,
    probe: (request) => probeCodex(request, { tool: CODEX, env: sessionEnv(process.env) }),
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
