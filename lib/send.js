import { readFileSync } from 'node:fs';
import { ok, info, fail } from './util.js';
import { hostOf } from './host.js';
import { ensureWarden } from './warden.js';
import {
  addressesOf, bus, MESSAGE_TYPES, participantOf, participantRecord, readInbox,
  readTask, resolveIdentity, resolveTaskId, sendMessage, senderFor, sessionIdentityReport,
  upsertParticipant,
} from './store.js';
import { addressList, admitsAddress, registryOf } from '../dist/index.js';

// Write one bus message from the command line. There is no `--from`: the sender is the address
// this session PROVABLY holds in the named task — [03-cli.md § Send](../docs/reference/03-cli.md#send), ADR-019.
export function send(rootOrHost, { task, to, type = 'status', body, file, artifact } = {}, { env = process.env, cwd = process.cwd() } = {}) {
  const host = hostOf(rootOrHost);
  const identity = resolveIdentity(env, cwd, { host });
  const home = identity.home;
  // After the resolve, not before: the home this command writes to is the resolved one,
  // and priming the host's own would open a second store for nothing.
  bus(home, { cli: host.version });
  const { session } = identity;
  const id = resolveTaskId(home, task ?? identity.declaredTask, session, {
    spawnRepo: host.busCommand(['spawn', '--repo', '<name>', '--brief', '<file>']),
    spawnNewTask: host.busCommand(['spawn', '--new-task']),
  });
  const known = addressesOf(readTask(home, id));
  const route = `Task ${id} participants: ${known.join(', ')}`;
  // Everything the caller typed is checked HERE: the store's own refusals are bare
  // `Error`s, and the catch above prints a stack a person reading a typo does not need.
  if (!to) fail(`name the recipient address: ${route}`);
  const registry = registryOf(host);
  if (!admitsAddress(registry, to)) fail(`«${to}» is not an address — ${addressList(registry)}. ${route}`);
  if (!known.includes(to)) fail(`task ${id} has no participant «${to}» — nobody to deliver to. ${route}`);
  if (body !== undefined && file !== undefined) {
    fail('--body and --file both name the message body — give one of them');
  }
  const text = file === undefined ? body : bodyFile(file);
  if (!String(text ?? '').trim()) fail(`the message body is empty — a message with nothing in it is not a message. ${route}`);
  if (!MESSAGE_TYPES.includes(type)) fail(`«${type}» is not a message type — one of ${MESSAGE_TYPES.join(', ')}. ${route}`);
  const from = senderFor(home, id, identity);
  const sent = sendMessage(home, id, { from, to, type, body: text, artifactPath: artifact ?? null, session }, {
    status: host.busCommand(['status']),
    registry,
  });
  const landedTask = sent.deliveredTask ?? id;
  const landedTo = sent.deliveredTask ? 'orchestrator' : to;
  const landedFrom = sent.deliveredTask ? `peer:${readTask(home, id).adapter.slug}` : from;
  ok(`sent ${type} → ${landedTo} · from ${landedFrom} · task ${landedTask} · id ${sent.message.id}`
    + (sent.deliveredTask ? ` · via ${to} of task ${id}` : ''));
  if (sent.artifact) info(`artifact ${sent.artifact.filename} → the task files directory`);
  // Said plainly, not as a warning: a repeat send is lawful, and without this line the
  // reply to the same bytes is indistinguishable from the reply to a corrected file.
  if (sent.sameContent) {
    info(`the same content as ${sent.sameContent.filename}`
      + `${sent.sameContent.names > 1 ? ` — ${sent.sameContent.names} names on this payload` : ''}`);
  }
  // The listener, as on every other write path on the bus: a message nobody is watching
  // for waits until its addressee happens to take a turn.
  ensureWarden(home, landedTask, { env, host });
  return 0;
}

function bodyFile(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    return fail(`--file ${file}: ${e.code ?? e.message} — the message body is read from that file`);
  }
}

function refuseAskParticipant(role, candidates) {
  if (!role && !candidates.length) return;
  const carried = [
    ...(role ? [`bus address PROMPTOBUS_ROLE=${role}`] : []),
    ...candidates.map((one) => `harness identity ${one.variable} (${one.harness})`),
  ];
  fail(`ask is for the person at a terminal; this process carries ${carried.join(' and ')}. `
    + 'A participant shell can inherit its parent session identity; run ask from a plain terminal');
}

export function ask(rootOrHost, { task, to = 'orchestrator', body, answers = false } = {},
  { env = process.env, cwd = process.cwd() } = {}) {
  if (!task) fail('ask needs --task <id> to name the task whose orchestrator should answer');
  if (answers && body !== undefined) fail('ask --answers takes no question text');
  if (!answers && !String(body ?? '').trim()) {
    fail('ask needs question text, or --answers to read the user mailbox');
  }
  const role = String(env.PROMPTOBUS_ROLE ?? '').trim();
  refuseAskParticipant(role, sessionIdentityReport(env).candidates);
  const host = hostOf(rootOrHost);
  const identity = resolveIdentity(env, cwd, { host });
  const { home } = identity;
  refuseAskParticipant('', sessionIdentityReport(env, {
    home, task: identity.declaredTask ?? task, address: identity.role,
  }).candidates);
  bus(home, { cli: host.version });
  const root = readTask(home, task);
  let id = task;
  if (to !== 'orchestrator') {
    const lead = participantOf(root, to);
    const childId = lead?.metadata?.childTask;
    if (!to.startsWith('teamlead:') || root.parent !== undefined || !childId) {
      fail(`task ${task} has no linked ${to} — --to names orchestrator or a teamlead:<slug> of a root task`);
    }
    const child = readTask(home, childId);
    if (child.parent !== task) {
      fail(`task ${task} has no linked ${to} — the child task link does not match`);
    }
    id = childId;
  }
  if (!addressesOf(readTask(home, id)).includes('user')) {
    upsertParticipant(home, id, participantRecord('user', {}, registryOf(host)));
  }
  if (answers) {
    const { messages } = readInbox(home, id, 'user');
    if (!messages.length) ok(`user mailbox empty · task ${id}`);
    for (const message of messages) {
      info(`${message.type} from ${message.sender} · ${message.ts} · task ${id}`);
      console.log(message.body);
    }
    return 0;
  }
  const sent = sendMessage(home, id, {
    from: 'user', to: 'orchestrator', type: 'question', body, session: null,
  }, { status: host.busCommand(['status']), registry: registryOf(host) });
  ok(`asked orchestrator · from user · task ${id} · id ${sent.message.id}`);
  ensureWarden(home, id, { env, host });
  return 0;
}
