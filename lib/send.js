import { ok, info, fail } from './util.js';
import { hostOf } from './host.js';
import {
  addressesOf, bus, foreignTaskLine, isAddress, ORCHESTRATOR, ownership, readTask, resolveIdentity,
  resolveTaskId, sendMessage, sessionIdentity, taskOwner,
} from './store.js';

// Write one bus message from the command line.
//
// It exists because the bus had no door but the MCP tool: a session that raised its own
// task could not reach that task's participants at all and drove a terminal multiplexer
// by hand instead (PB-179). There is no `--from`, and the command REFUSES rather than
// guessing when it cannot establish its own role — 03-cli § Send, ADR-011.
export function send(rootOrHost, { task, to, type = 'status', body, artifact } = {}, { env = process.env, cwd = process.cwd() } = {}) {
  const host = hostOf(rootOrHost);
  const identity = resolveIdentity(env, cwd, { host });
  const home = identity.home;
  // After the resolve, not before: the home this command writes to is the resolved one,
  // and priming the host's own would open a second store for nothing (PB-179 review).
  bus(home, { cli: host.version });
  const id = resolveTaskId(home, task ?? identity.declaredTask, sessionIdentity(env), {
    spawnRepo: host.busCommand(['spawn', '--repo', '<name>', '--brief', '<file>']),
    spawnNewTask: host.busCommand(['spawn', '--new-task']),
  });
  const known = addressesOf(readTask(home, id));
  const route = `${host.busCommand(['send', '<address>', '--type <type>', '--body <text>', `--task ${id}`])}.`
    + ` Task participants: ${known.join(', ')}`;
  if (!to) fail(`name the recipient address: ${route}`);
  // Checked here rather than left to the store: `addrDir` throws a BARE error, which the
  // top-level catch prints with a stack before the one-line refusal.
  if (!isAddress(to)) fail(`«${to}» is not an address — orchestrator, worker:<slug> or reviewer:<slug>. ${route}`);
  if (!body) fail(`the message body is empty — a message with nothing in it is not a message. ${route}`);
  sendAs(host, home, id, identity, env);
  const sent = sendMessage(home, id, { from: identity.role, to, type, body, artifactPath: artifact ?? null }, {
    status: host.busCommand(['status']),
  });
  ok(`sent ${type} → ${to} · from ${identity.role} · task ${id} · id ${sent.message.id}`);
  if (sent.artifact) info(`artifact ${sent.artifact.filename} → the task files directory`);
  return 0;
}

/**
 * Refuse a sender the process cannot prove. A participant's session environment carries no
 * bus identity on purpose (`lib/spawn.js` `sessionEnv`), so an undeclared role is not
 * "orchestrator" — it is "unknown", and answering it with the orchestrator's address would
 * hand out the very borrowing ADR-011 refused `--from` to prevent.
 */
function sendAs(host, home, id, identity, env) {
  if (String(env?.PROMPTOBUS_ROLE ?? '').trim()) return;
  const session = sessionIdentity(env);
  const owner = taskOwner(home, id);
  const claim = `${host.busCommand(['send', '<address>', '--body <text>', `--task ${id}`])} with PROMPTOBUS_ROLE set`;
  if (!session) {
    fail('this process declares no PROMPTOBUS_ROLE and cannot name its own session, so the address it would '
      + `write from is a guess. Run it where the bus set the role, or set PROMPTOBUS_ROLE: ${claim}`);
  }
  if (!owner) return;
  const own = ownership(home, id, ORCHESTRATOR, session);
  if (own.gated) {
    fail(`${foreignTaskLine(readTask(home, id), own)}: writing as ${ORCHESTRATOR} without a declared role would `
      + `borrow that address. Set PROMPTOBUS_ROLE to the participant this process is: ${claim}`);
  }
}
