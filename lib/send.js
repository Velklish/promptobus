import { readFileSync } from 'node:fs';
import { ok, info, fail } from './util.js';
import { hostOf } from './host.js';
import { ensureWarden } from './warden.js';
import {
  addressesOf, bus, MESSAGE_TYPES, readTask, resolveIdentity, resolveTaskId, sendMessage, senderFor,
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
  });
  ok(`sent ${type} → ${to} · from ${from} · task ${id} · id ${sent.message.id}`);
  if (sent.artifact) info(`artifact ${sent.artifact.filename} → the task files directory`);
  // Said plainly, not as a warning: a repeat send is lawful, and without this line the
  // reply to the same bytes is indistinguishable from the reply to a corrected file.
  if (sent.sameContent) {
    info(`the same content as ${sent.sameContent.filename}`
      + `${sent.sameContent.names > 1 ? ` — ${sent.sameContent.names} names on this payload` : ''}`);
  }
  // The listener, as on every other write path on the bus: a message nobody is watching
  // for waits until its addressee happens to take a turn.
  ensureWarden(home, id, { env, host });
  return 0;
}

function bodyFile(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    return fail(`--file ${file}: ${e.code ?? e.message} — the message body is read from that file`);
  }
}
