import { busService, ORCHESTRATOR, participantOf, readTask, resolveIdentity } from './store.js';
import { createMcpServer } from '../dist/index.js';
import { blockedParticipants, stallLine, stallTail } from './status.js';
import { driverOrLift, forgetSessions } from './drivers.js';
import { ensureWarden } from './warden.js';
import { branchLine, worktreeBranch } from './worktree.js';
import { PROMPTOBUS_SERVER, PROTOCOL_VERSIONS } from './contract.js';

// Adapter of the bus MCP server over Promptobus: the `promptobus mcp` subcommand,
// stdio transport, JSON-RPC 2.0 one message per line. The protocol itself —
// negotiation, `tools/list`, `tools/call`, error parsing — lives in the nested package,
// in [mcp/server.ts](../src/mcp/server.ts), and knows nothing about the workspace.
// What remains here is exactly what the package must not know, fed as factory
// callbacks: process identity, CLI name and version, contact-point handoff and warden
// start, participant lines about Git and a background Claude session, stall diagnostics,
// and human protocol-error text.
//
// **Callbacks return data; they do not print.** stdout is the protocol channel in full,
// and a stray line in it breaks an agent client the same way it broke the suite.
//
// The machine-address mark arrives from the package together with reply rendering; the
// door to it stays here — tape-hook fixtures take it.
export { ADDR_MARK } from '../dist/index.js';

// Participant lines the store does not know: the workspace repository, the worktree
// directory with its branch (git), and the harness background session. Their place in
// the line is between the owner and dismiss-from-watch; order is held by the package
// `participantLine`.
//
// There is no decoration hook for the task itself: the `task` reply header — id, status,
// artifact directory, and its mailbox — is entirely store, and the adapter has nothing
// to feed in.
function decorateParticipant(p) {
  // Repository, worktree, branch, and bg-session are mechanism fields: the adapter
  // writes them, and they live in the v1 record `metadata`. The record's own fields are
  // role, harness, mode, session reference, and a capabilities snapshot; they know
  // nothing about the workspace.
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
  return parts;
}

// Stall routes: they live here because `mailbox` is called exactly on wake.
// Only the orchestrator looks. ALL current stalls are taken, not "fresh" ones: the
// "already reported" mark is held by the command, and a shared one across two channels
// would mute the second channel.
// MCP lives as a session process, so the session list is queried on every call: without
// a reset an external spawn/stop is invisible until the server restarts.
export function stallNote(home, task, addr) {
  if (addr !== ORCHESTRATOR) return null;
  forgetSessions();
  const stalled = blockedParticipants(home, task, readTask(home, task).participants);
  if (!stalled?.length) return null;
  return [...stalled.map((s) => stallLine(s, task)), stallTail(stalled)].join('\n');
}

// A participant hands over their contact point and, if there is no listener, starts it.
// The MCP server lives as a child process of the participant session — socket address
// and token sit in its `process.env`. Only the mailbox owner hands over the point:
// otherwise a foreign session would write its socket into another run's
// `wake/orchestrator.json`. `ensureWarden` does not require the gate.
function joinBus({ home, task, address, gated, host }) {
  if (host == null) throw new Error('joinBus: host is required');
  // The contact point is handed over by this participant's driver: the socket-address
  // and token variables are a harness dictionary, and the bus server does not know
  // them. Door with fallback to the lift driver (review note): a record with a foreign
  // harness is legal here, and a refusal would become a handshake refusal — the session
  // would be left without the bus entirely because it had nothing to hand a contact
  // point with.
  const driver = driverOrLift(participantOf(readTask(home, task), address));
  if (!gated) driver.registerWake(home, task, address);
  ensureWarden(home, task, { host });
}

// Human text of a protocol event. The package names the event by type and sets a
// JSON-RPC code; the words stay here — with the rest of the user-facing output.
// A tool refusal arrives as text with `isError`, not a protocol error:
// the agent must read it and fix the call, not lose the connection.
// Each event branch is named explicitly, and `default` does not read event fields at
// all: `errorText` is also called OUTSIDE a catch — on an unknown method and on an
// unparsed line — and a `TypeError` from it would bring down the server loop, so the
// session would lose the connection instead of getting an error line. A fifth package
// event would then get a vague but safe text, and it would be fixed in words, not by a
// crash (review note).
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

export async function serve({ host, env = process.env, cwd = process.cwd(), input = process.stdin, output = process.stdout } = {}) {
  if (host == null) throw new Error('serve: host is required');
  const server = createMcpServer({
    service: busService,
    // The list's home is `contract.js`: `lint` reads it, checking the reference citation,
    // and the value has no second home. The package takes the list as an argument and
    // does not keep its own.
    protocolVersions: PROTOCOL_VERSIONS,
    // The task is resolved on every call; process identity is resolved once: the
    // orchestrator server starts with the session, when there is no task yet.
    resolveIdentity: () => resolveIdentity(env, cwd, { host }),
    // The name comes from its home (`contract.js`): the same name is used for the server
    // entry in configs.
    serverInfo: () => ({ name: PROMPTOBUS_SERVER, version: host.version }),
    onJoin: (ctx) => joinBus({ ...ctx, host }),
    decorateParticipant,
    stalls: ({ home, task, address }) => stallNote(home, task, address),
    errorText,
  });
  await server.serve({ input, output });
}
