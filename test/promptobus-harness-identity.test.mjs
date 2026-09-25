// Lone harness identity through status, the owner gate, and the mailbox.
// Each child environment carries exactly one identity variable. Run: node test/promptobus-harness-identity.test.mjs
import { spawn, spawnSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { REGISTRY } from '../lib/drivers.js';
import { countInbox, readTask, sendMessage, taskOwner } from '../lib/store.js';

const SB = makeSandbox('promptobus-owner-gate-harness-');
const ROOT = realpathSync(SB);
const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(ROOT, '.promptobus');
const BIN = path.join(here, '..', 'bin', 'promptobus.js');
const driversHref = pathToFileURL(path.join(here, '..', 'lib', 'drivers.js')).href;
const storeHref = pathToFileURL(path.join(here, '..', 'lib', 'store.js')).href;
const doneHref = pathToFileURL(path.join(here, '..', 'lib', 'done.js')).href;
const stopHref = pathToFileURL(path.join(here, '..', 'lib', 'stop.js')).href;
const dismissHref = pathToFileURL(path.join(here, '..', 'lib', 'dismiss.js')).href;

writeFileSync(path.join(ROOT, 'AGENTS.md'), '# stand\n');
writeHostConfig(ROOT);

const DROP = [...new Set(Object.values(REGISTRY.drivers).flatMap((driver) => [
  driver?.options?.identityVar,
  driver?.options?.mcpIdentity?.recordVar,
]).filter((name) => typeof name === 'string'))];

const HARNESSES = ['claude', 'cursor', 'codex'];

function isolated(extra = {}) {
  const env = { ...process.env };
  for (const name of DROP) delete env[name];
  delete env.PROMPTOBUS_ROLE;
  delete env.PROMPTOBUS_TASK;
  delete env.PROMPTOBUS_HOME;
  return {
    ...env,
    PROMPTOBUS_HOME: HOME,
    PROMPTOBUS_WARDEN: 'off',
    ...extra,
  };
}

function nodeEval(env, code) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 60000,
  });
}

function combined(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function lastJson(text) {
  const lines = String(text).trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

const CREATE = `
import { identityCandidates } from ${JSON.stringify(driversHref)};
import { createTask, taskOwner } from ${JSON.stringify(storeHref)};
const home = process.env.PROMPTOBUS_HOME;
const id = process.env.PB_TASK;
createTask(home, { id, title: 'lone identity' });
process.stdout.write(JSON.stringify({
  owner: taskOwner(home, id),
  candidates: identityCandidates().map((c) => ({ harness: c.harness, variable: c.variable, id: c.id })),
}) + '\\n');
`;

const GATE = `
import ${JSON.stringify(driversHref)};
const root = process.env.PB_ROOT;
const task = process.env.PB_TASK;
const which = process.env.PB_WHICH;
if (which === 'done') {
  const { done } = await import(${JSON.stringify(doneHref)});
  await done(root, { task, snapshot: () => ({}), 'keep-sessions': true });
} else if (which === 'stop') {
  const { stop } = await import(${JSON.stringify(stopHref)});
  await stop(root, { task });
} else if (which === 'dismiss') {
  const { dismiss } = await import(${JSON.stringify(dismissHref)});
  dismiss(root, { task });
} else {
  throw new Error('unknown gate ' + which);
}
`;

function runGate(env, task, which) {
  return nodeEval({ ...env, PB_ROOT: ROOT, PB_TASK: task, PB_WHICH: which }, GATE);
}

function cliStatus(env, task) {
  return spawnSync(process.execPath, [BIN, 'status', '--task', task], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 60000,
  });
}

function textOf(message) {
  return message?.result?.content?.map((part) => part.text).join('\n') ?? '';
}

function startMcp(env) {
  const child = spawn(process.execPath, [BIN, 'mcp'], {
    cwd: ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  const pending = new Map();
  let buf = '';
  let seq = 0;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  const write = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const call = (method, params) => {
    const id = (seq += 1);
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no response to ${method}\n${stderr.slice(-800)}`));
      }, 20000);
      pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    });
    write({ jsonrpc: '2.0', id, method, params });
    return answer;
  };
  const notify = (method, params) => write({ jsonrpc: '2.0', method, params });
  const stop = () => new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.stdin.end();
    child.kill();
  });
  return { call, notify, stop };
}

async function mailbox(env, task, args) {
  const srv = startMcp(env);
  try {
    await srv.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    srv.notify('notifications/initialized');
    const res = await srv.call('tools/call', {
      name: 'promptobus_mailbox',
      arguments: { task, ...args },
    });
    return textOf(res);
  } finally {
    await srv.stop();
  }
}

{
  const bare = nodeEval(isolated({ PB_TASK: 'none-t20260925-178900' }), CREATE);
  const said = bare.status === 0 ? lastJson(bare.stdout) : null;
  check(': a child whose environment names no harness records no owner',
    said?.owner === null && said?.candidates?.length === 0,
    combined(bare));
}

for (const harness of HARNESSES) {
  const variable = REGISTRY.drivers[harness].options.identityVar;
  const owner = `${harness}-owner-sid`;
  const foreign = `${harness}-foreign-sid`;
  const main = `${harness}-main-t20260925-178000`;
  const claimId = `${harness}-claim-t20260925-178100`;
  const ownerEnv = isolated({ [variable]: owner });
  const foreignEnv = isolated({ [variable]: foreign });

  const made = nodeEval({ ...ownerEnv, PB_TASK: main }, CREATE);
  const recorded = made.status === 0 ? lastJson(made.stdout) : null;
  check(`: lone ${harness} identity is the only candidate and the recorded owner`,
    recorded?.owner === owner
      && recorded.candidates.length === 1
      && recorded.candidates[0].harness === harness
      && recorded.candidates[0].variable === variable
      && recorded.candidates[0].id === owner,
    combined(made));
  nodeEval({ ...ownerEnv, PB_TASK: claimId }, CREATE);

  const status = cliStatus(ownerEnv, main);
  const statusText = combined(status);
  check(`: status under a lone ${harness} identity prints that owner`,
    status.status === 0
      && statusText.includes(`owner ${owner}`)
      && !/looking at a foreign run/.test(statusText),
    statusText);
  const foreignStatus = cliStatus(foreignEnv, main);
  const foreignStatusText = combined(foreignStatus);
  check(`: status under a foreign ${harness} identity warns that this session is looking at a foreign run`,
    foreignStatus.status === 0 && /looking at a foreign run/.test(foreignStatusText),
    foreignStatusText);

  for (const which of ['done', 'stop', 'dismiss']) {
    const refused = runGate(foreignEnv, main, which);
    const refusedText = combined(refused);
    check(`: ${which} from a foreign ${harness} session is refused by the owner gate`,
      refused.status === 1
        && refusedText.includes(owner)
        && refusedText.includes(foreign)
        && /is bound to session/.test(refusedText)
        && /mailbox \{claim: true\}/.test(refusedText)
        && readTask(HOME, main).status === 'active'
        && taskOwner(HOME, main) === owner,
      refusedText);
  }

  sendMessage(HOME, main, {
    from: 'orchestrator', to: 'orchestrator', type: 'status', body: `original ${harness}`,
  });
  let copy = '';
  let copyErr = '';
  try {
    copy = await mailbox(foreignEnv, main, {});
  } catch (e) {
    copyErr = e instanceof Error ? e.message : String(e);
  }
  check(`: a foreign ${harness} mailbox is a copy and the originals stay`,
    !copyErr
      && /FOREIGN MAILBOX/.test(copy)
      && copy.includes(owner)
      && copy.includes(foreign)
      && copy.includes(`original ${harness}`)
      && countInbox(HOME, main, 'orchestrator') === 1,
    copyErr || copy);

  for (const which of ['stop', 'dismiss']) {
    const passed = runGate(ownerEnv, main, which);
    const passedText = combined(passed);
    check(`: the ${harness} owner passes the ${which} gate and is stopped only by the missing address`,
      passed.status === 1
        && /name the participant address/.test(passedText)
        && !/is bound to session/.test(passedText)
        && !/carries no session identity/.test(passedText),
      passedText);
  }

  let claimed = '';
  let claimErr = '';
  try {
    claimed = await mailbox({
      ...foreignEnv,
      PROMPTOBUS_ROLE: 'orchestrator',
      PROMPTOBUS_TASK: claimId,
    }, claimId, { claim: true });
  } catch (e) {
    claimErr = e instanceof Error ? e.message : String(e);
  }
  check(`: claim from a foreign ${harness} session rebinds the mailbox`,
    !claimErr
      && /MAILBOX CLAIMED/.test(claimed)
      && claimed.includes(foreign)
      && taskOwner(HOME, claimId) === foreign
      && taskOwner(HOME, main) === owner,
    claimErr || claimed);

  const closed = runGate(ownerEnv, main, 'done');
  const closedText = combined(closed);
  check(`: the ${harness} owner closes the task`,
    closed.status === 0 && /closed/.test(closedText) && readTask(HOME, main).status === 'done',
    closedText);
}
