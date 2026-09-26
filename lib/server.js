import { bus, busService, ORCHESTRATOR, participantOf, readTask, resolveIdentity } from './store.js';
import { createMcpServer } from '../dist/index.js';
import { blockedParticipants, stallLine, stallTail } from './status.js';
import { driverOrLift, forgetSessions } from './drivers.js';
import { ensureWarden } from './warden.js';
import { branchLine, worktreeBranch } from './worktree.js';
import { PROMPTOBUS_SERVER, PROTOCOL_VERSIONS } from './contract.js';

// Adapter of the bus MCP server over Promptobus; the protocol itself is in
// [mcp/server.ts](../src/mcp/server.ts) — [01-overview.md § The stdio server](../docs/reference/01-overview.md#the-stdio-server-transport-rules).
export { ADDR_MARK } from '../dist/index.js';

// Participant lines the store does not know: repository, worktree with its branch, and the
// harness background session. The `task` reply has no such hook — it is all store.
function decorateParticipant(p) {
  // Repository, worktree, branch and bg-session are mechanism fields kept in the v1
  // record `metadata`; the record's own fields know nothing about a workspace.
  const m = p.metadata ?? {};
  const parts = [];
  if (m.repo) parts.push(`repository ${m.repo}`);
  // Git names the branch, not the journal: a worker may have moved to their own on a
  // brief request.
  if (m.worktree) {
    // branchLine is silent (null) when there is no branch anywhere: the template would
    // otherwise print the string "null".
    const line = branchLine(m.branch, worktreeBranch(m.worktree));
    parts.push(`worktree ${m.worktree}${line ? ` (${line})` : ''}`);
  }
  if (m.session) parts.push(`bg-session ${m.session}`);
  // Which snapshot the reviewer is holding: the diff file is written once, and its age
  // and tracked-tree state are the reviewer's blind spots — the orchestrator reads them here.
  if (m.diffAt) {
    const modified = Array.isArray(m.diffModifiedTracked) ? m.diffModifiedTracked : [];
    const tree = m.diffClean === true ? ', tracked tree clean'
      : m.diffClean === false
        ? `, tracked tree dirty${modified.length ? ` (modified tracked paths: ${modified.join(', ')})` : ''}`
        : '';
    parts.push(`diff snapshot ${m.diffAt}${m.diffHead ? ` at ${m.diffHead}` : ''}${tree}`);
  }
  return parts;
}

// Here because `mailbox` is called exactly on wake, and only the orchestrator looks. ALL
// stalls are taken (a shared mark mutes a channel); the session list is re-queried per call.
export function stallNote(home, task, addr, host = null) {
  if (addr !== ORCHESTRATOR) return null;
  forgetSessions();
  const stalled = blockedParticipants(home, task, readTask(home, task).participants);
  if (!stalled?.length) return null;
  return [...stalled.map((s) => stallLine(s, task, host)), stallTail(stalled)].join('\n');
}

// A participant hands over their contact point and starts a listener if there is none.
// Only a proven right may: a foreign or no-identity socket would land in another run's wake file.
function joinBus({ home, task, address, mayRegister, host }) {
  if (host == null) throw new Error('joinBus: host is required');
  // The contact point is handed over by this participant's own driver; the fallback to the
  // lift driver is deliberate — a refusal here would leave the session without the bus.
  const driver = driverOrLift(participantOf(readTask(home, task), address));
  if (mayRegister) driver.registerWake(home, task, address);
  ensureWarden(home, task, { host });
}

// Human text of a protocol event; the package names the event and sets the JSON-RPC code.
// `default` reads no event fields — `errorText` is also called outside a catch.
function errorText(event) {
  switch (event.kind) {
    case 'parse':
      return 'not parsed as JSON';
    case 'unknown-method':
      return `method "${event.method}" is not supported`;
    case 'unknown-tool':
      return `error: unknown tool "${event.tool}"`;
    case 'tool-failed':
      return `error: ${event.cause.message}`;
    default:
      return 'error: protocol event not recognized';
  }
}

function serviceFor(host) {
  const hints = {
    status: host.busCommand(['status']),
    spawnRepo: host.busCommand(['spawn', '--repo', '<name>', '--brief', '<file>']),
    spawnNewTask: host.busCommand(['spawn', '--new-task']),
  };
  return {
    ...busService,
    resolveTaskId: (home, declared, session) => busService.resolveTaskId(home, declared, session, hints),
    send: (home, task, outgoing) => busService.send(home, task, outgoing, hints),
  };
}

export async function serve({ host, env = process.env, cwd = process.cwd(), input = process.stdin, output = process.stdout } = {}) {
  if (host == null) throw new Error('serve: host is required');
  const server = createMcpServer({
    service: serviceFor(host),
    // The list's home is `contract.js` — `lint` checks the reference citation against it,
    // and the value has no second home.
    protocolVersions: PROTOCOL_VERSIONS,
    // Stable bus coordinates are read at start; a tool call refreshes session proof because
    // its record may gain the harness id after the MCP child has already connected.
    resolveIdentity: () => {
      const identity = resolveIdentity(env, cwd, { host });
      bus(identity.home, { cli: host.version });
      return identity;
    },
    // The name comes from its home (`contract.js`): the same name is used for the server
    // entry in configs.
    serverInfo: () => ({ name: PROMPTOBUS_SERVER, version: host.version }),
    onJoin: (ctx) => joinBus({ ...ctx, host }),
    decorateParticipant,
    stalls: ({ home, task, address }) => stallNote(home, task, address, host),
    errorText,
  });
  await server.serve({ input, output });
}
