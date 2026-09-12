import { ok, info, fail } from './util.js';
import { hostOf } from './host.js';
import {
  addressesOf, ORCHESTRATOR, readTask, resolveIdentity, resolveTaskId, sendMessage, sessionIdentity,
} from './store.js';

// Write one bus message from the command line.
//
// It exists because the bus had no door but the MCP tool: a session that raised its own
// task could not reach that task's participants at all and drove a terminal multiplexer by
// hand instead (PB-179). The command does exactly what the process could already do —
// write FROM ITS OWN ADDRESS — and adds no contract: the sender is resolved the same way
// the MCP server resolves it, from `PROMPTOBUS_ROLE` or the orchestrator default, and
// there is no `--from`. Why not, and what would have to change for one, is in
// [ADR-011](../docs/adr/adr-011-a-session-address-is-per-task.md).
export function send(rootOrHost, { task, to, type = 'status', body, artifact } = {}, { env = process.env, cwd = process.cwd() } = {}) {
  const host = hostOf(rootOrHost);
  const identity = resolveIdentity(env, cwd, { host });
  const home = identity.home;
  const id = resolveTaskId(home, task ?? identity.declaredTask, sessionIdentity(env), {
    spawnRepo: host.busCommand(['spawn', '--repo', '<name>', '--brief', '<file>']),
    spawnNewTask: host.busCommand(['spawn', '--new-task']),
  });
  const meta = readTask(home, id);
  const known = addressesOf(meta);
  const route = `${host.busCommand(['send', '<address>', '--type <type>', '--body <text>', `--task ${id}`])}.`
    + ` Task participants: ${known.join(', ')}`;
  if (!to) fail(`name the recipient address: ${route}`);
  if (!body) fail(`the message body is empty — a message with nothing in it is not a message. ${route}`);
  const sent = sendMessage(home, id, { from: identity.role, to, type, body, artifactPath: artifact ?? null }, {
    status: host.busCommand(['status']),
  });
  ok(`sent ${type} → ${to} · from ${identity.role} · task ${id} · id ${sent.message.id}`);
  if (sent.artifact) info(`artifact ${sent.artifact.name} → the task files directory`);
  // The sender is the process's address and cannot be chosen. A worker writing to the
  // orchestrator is the ordinary case; anything else the routing policy judges, and its
  // refusal already names the reason.
  if (identity.role !== ORCHESTRATOR && to !== ORCHESTRATOR) {
    info('both sides are participants — if this was refused, the rule is that context goes through the orchestrator');
  }
  return 0;
}
