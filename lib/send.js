import { ok, info, fail } from './util.js';
import { hostOf } from './host.js';
import { ensureWarden } from './warden.js';
import {
  addressesOf, bus, foreignSession, isAddress, MESSAGE_TYPES, ORCHESTRATOR, readTask,
  resolveIdentity, resolveTaskId, sendMessage, sessionIdentity, taskOwner,
} from './store.js';

// Write one bus message from the command line.
//
// It exists because the bus had no door but the MCP tool: a session that raised its own
// task could not reach that task's participants at all and drove a terminal multiplexer
// by hand instead (PB-179). There is no `--from`, and every way of naming a sender is
// PROVED before it is used — 03-cli § Send, ADR-011.
export function send(rootOrHost, { task, to, type = 'status', body, artifact } = {}, { env = process.env, cwd = process.cwd() } = {}) {
  const host = hostOf(rootOrHost);
  const identity = resolveIdentity(env, cwd, { host });
  const home = identity.home;
  // After the resolve, not before: the home this command writes to is the resolved one,
  // and priming the host's own would open a second store for nothing.
  bus(home, { cli: host.version });
  const id = resolveTaskId(home, task ?? identity.declaredTask, sessionIdentity(env), {
    spawnRepo: host.busCommand(['spawn', '--repo', '<name>', '--brief', '<file>']),
    spawnNewTask: host.busCommand(['spawn', '--new-task']),
  });
  const known = addressesOf(readTask(home, id));
  const route = `Task ${id} participants: ${known.join(', ')}`;
  // Everything the caller typed is checked HERE. The store's own refusals for these are
  // bare `Error`s, which the top-level catch prints with a stack before the one-line
  // refusal — a person reading a typo does not need a stack (PB-179 review).
  if (!to) fail(`name the recipient address: ${route}`);
  if (!isAddress(to)) fail(`«${to}» is not an address — orchestrator, worker:<slug> or reviewer:<slug>. ${route}`);
  if (!known.includes(to)) fail(`task ${id} has no participant «${to}» — nobody to deliver to. ${route}`);
  if (!String(body ?? '').trim()) fail(`the message body is empty — a message with nothing in it is not a message. ${route}`);
  if (!MESSAGE_TYPES.includes(type)) fail(`«${type}» is not a message type — one of ${MESSAGE_TYPES.join(', ')}. ${route}`);
  const from = senderOf(host, home, id, identity, env);
  const sent = sendMessage(home, id, { from, to, type, body, artifactPath: artifact ?? null }, {
    status: host.busCommand(['status']),
  });
  ok(`sent ${type} → ${to} · from ${from} · task ${id} · id ${sent.message.id}`);
  if (sent.artifact) info(`artifact ${sent.artifact.filename} → the task files directory`);
  // The listener, as every other write path on the bus does it: a message nobody is
  // watching for waits until its addressee happens to take a turn, and the hand-driven
  // multiplexer this command replaced is what that looks like from the other side.
  ensureWarden(home, id, { env, host });
  return 0;
}

/**
 * The address this process may write from, or a refusal.
 *
 * A declared `PROMPTOBUS_ROLE` is a CLAIM, not a proof: anyone can export one. So the
 * claim is checked against the task — the address must be a participant of it, and must
 * not be held by another session — and the orchestrator address is given only to the
 * session that owns the task. A task with no owner is refused rather than defaulted:
 * ownership cannot be proved there by construction, and "cannot prove" is the case this
 * command exists to answer with a refusal (ADR-011).
 */
function senderOf(host, home, id, identity, env) {
  const session = sessionIdentity(env);
  const declared = String(env?.PROMPTOBUS_ROLE ?? '').trim();
  const role = declared ? identity.role : ORCHESTRATOR;
  const hint = `${host.busCommand(['status', `--task ${id}`])} shows who this task belongs to`;
  if (!session) {
    fail('this process cannot name its own session, so no sender it claims can be checked. '
      + `Run it where the bus set the identity: ${hint}`);
  }
  if (role !== ORCHESTRATOR) {
    if (!addressesOf(readTask(home, id)).includes(role)) {
      fail(`PROMPTOBUS_ROLE names «${role}», which is not a participant of task ${id} — `
        + `a role is a claim, and this one does not match the task. ${hint}`);
    }
    const held = foreignSession(home, id, role, session);
    if (held) {
      fail(`«${role}» of task ${id} is held by session ${held}, and this one is ${session} — `
        + `writing as it would borrow that address. ${hint}`);
    }
    return role;
  }
  const owner = taskOwner(home, id);
  if (!owner) {
    fail(`task ${id} records no owner, so nothing can prove this process is its ${ORCHESTRATOR}. `
      + `Declare the participant this process is with PROMPTOBUS_ROLE. ${hint}`);
  }
  if (owner !== session) {
    fail(`task ${id} belongs to session ${owner}, and this one is ${session} — writing as `
      + `${ORCHESTRATOR} would borrow that address. ${hint}`);
  }
  return ORCHESTRATOR;
}
