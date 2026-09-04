// Bus MCP server: stdio transport, JSON-RPC 2.0 one message per line,
// negotiation (`initialize` → `notifications/initialized` → `ping`),
// `tools/list` and `tools/call`. The implementation is hand-rolled — the
// package has no dependencies at all.
//
// Protocol and dispatcher only. Everything that knows about the workspace,
// harness, and consumer version arrives as callbacks: process identity, server
// name and version, contact-point handoff, participant lines about Git and
// the background session, stall diagnosis, and human error text. Callbacks
// RETURN data and do not print: the stdout channel is taken by the protocol,
// and one stray line in it breaks the client.
//
// The package declares an error as a typed event; the consumer supplies the
// text: JSON-RPC codes are part of the protocol and live here; the words are
// part of the output and live at the adapter.
import {
  GateError, MAILBOX_CLAIMED_MARK, ORCHESTRATOR,
} from '../protocol.js';
import type { Ownership } from '../protocol.js';
import { MCP_TOOLS } from './tools.js';
import type { PromptobusService } from './service.js';
import {
  ADDR_MARK, SENT_PREFIX, foreignNote, readableName, renderMessages, renderTask,
} from './render.js';
import type { DecorateParticipant } from './render.js';

/** Who this process is on the bus. The adapter computes it: environment and workspace root are its. */
export interface McpIdentity {
  role: string;
  home: string;
  declaredTask: string | null;
  session: string | null;
}

/** Server name and version in the `initialize` reply. Both are consumer facts. */
export interface McpServerInfo {
  name: string;
  version: string;
}

/** A participant entered a task: handing over the contact point and lifting a listener is the adapter's job. */
export interface McpJoin {
  home: string;
  task: string;
  address: string;
  gated: boolean;
}

/** Who stall diagnosis is asked about. */
export interface McpStalls {
  home: string;
  task: string;
  address: string;
}

/** Event the consumer gives text for. The JSON-RPC code stays with the package. */
export type McpEvent =
  | { kind: 'parse' }
  | { kind: 'unknown-method'; method: string }
  | { kind: 'unknown-tool'; tool: string }
  | { kind: 'tool-failed'; cause: Error };

/** Line stream the server reads requests from. */
export interface McpInput {
  setEncoding(encoding: string): unknown;
  [Symbol.asyncIterator](): AsyncIterator<string>;
}

/** Stream the server writes replies to. */
export interface McpOutput {
  write(chunk: string): unknown;
}

export interface McpOptions {
  /** Store operations. Passed explicitly — the factory does not supply a default of its own. */
  service: PromptobusService;
  /** Protocol versions the server serves. The first is its latest. */
  protocolVersions: string[];
  /** Process identity. A callback, not a value: only the adapter reads the environment. */
  resolveIdentity: () => McpIdentity;
  /** Server name and version. */
  serverInfo: () => McpServerInfo;
  /** A participant entered a task — before any tool work. */
  onJoin: (join: McpJoin) => void;
  /** Participant lines the store does not know: repository, worktree, background session. */
  decorateParticipant: DecorateParticipant;
  /** Stall routes in the `mailbox` reply; `null` — nothing to say. */
  stalls: (ctx: McpStalls) => string | null;
  /** Human text of the event. */
  errorText: (event: McpEvent) => string;
}

interface JsonRpcMessage {
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

// Protocol-version agreement: echoing any client version would claim support
// for one the server does not have. Named — if it is in the served list,
// otherwise the server's latest.
export function negotiateProtocol(versions: string[], asked: unknown): string {
  return versions.includes(asked as string) ? (asked as string) : versions[0]!;
}

// No tool of that name. A separate class, not a ready string: error text is
// the consumer's business, and the package names only the event.
class UnknownToolError extends Error {
  readonly tool: string;

  constructor(tool: string) {
    super(tool);
    this.tool = tool;
  }
}

export function createMcpServer(options: McpOptions): {
  serve: (streams: { input: McpInput; output: McpOutput }) => Promise<void>;
} {
  const {
    service, protocolVersions, resolveIdentity, serverInfo,
    onJoin, decorateParticipant, stalls, errorText,
  } = options;
  // An empty version list is a refusal here, at create, not `undefined` in the
  // reply to the first `initialize`: `negotiateProtocol` takes `versions[0]`
  // as its latest, and a server with no version at all would tell the client
  // protocol `undefined` — agreement on nothing. Today the list is a consumer
  // contract literal; only a hand edit makes it empty; the gate stands where
  // the error is visible before the first connection.
  if (!Array.isArray(protocolVersions) || protocolVersions.length === 0) {
    throw new TypeError('protocolVersions is empty: the server has nothing to agree a protocol version on — the served-versions list must be non-empty');
  }

  // Successor claiming the mailbox. Refusals are loud: a silent refusal would read as success.
  function claim(home: string, task: string, addr: string, session: string | null, own: Ownership): string {
    if (addr !== ORCHESTRATOR) {
      return `mailbox ${addr} has no owner — there is nothing to claim: a worker gets the address `
        + `by declaration in its mcp-config. Read with an ordinary call, without claim · ${service.identityLabel(home, task, addr, session)}`;
    }
    if (!session) {
      return 'nothing to claim the mailbox with: the harness gave no session identity — '
        + 'the address owner is not even checked, read with an ordinary call '
        + `· ${service.identityLabel(home, task, addr)}`;
    }
    // A task with no owner has no gate — and a claim would turn it on after
    // the fact for every other session, including the live orchestrator:
    // after that it would see only copies.
    if (!own.owner) {
      return `task ${task} has no owner — there is no gate, and nothing to claim: it was created `
        + `by the former CLI. Read with an ordinary call, without claim · ${service.identityLabel(home, task, addr, session)}`;
    }
    // A claim is also a rebind: both the owner and the declared task are written.
    const mine = own.owner === session;
    if (mine) service.bindSession(home, task, session);
    const previous = mine ? null : service.claimOwnership(home, task, session);
    // "From now on without an argument" — only for an ACTIVE task: claiming a
    // closed one is lawful, but only an active one is bound.
    const bound = service.readTask(home, task).status === 'active';
    const tail = bound ? ' — from now on the task resolves without an argument' : '';
    const head = mine
      ? `mailbox is already bound to this session ${session}${bound ? ', binding updated' : ''}${tail}`
      : `${MAILBOX_CLAIMED_MARK}: the orchestrator address of task ${task} is bound to this session ${session}, `
        + `previous owner — ${previous ?? 'nobody'}${tail}`;
    const { messages, broken } = service.readInbox(home, task, addr);
    const alarm = service.brokenNote(broken);
    return (alarm ? `${alarm}\n\n` : '')
      + `${head}\n\n${renderMessages(service, home, task, addr, messages, session)}`;
  }

  function syncTool(identity: McpIdentity, name: string, args: Record<string, unknown>, task: string): string {
    const { home, role, session } = identity;
    switch (name) {
      case 'promptobus_mailbox': {
        const own = service.ownership(home, task, role, session);
        if (args?.claim === true) return claim(home, task, role, session, own);
        const { messages, broken } = own.gated
          ? service.peekInbox(home, task, role)
          : service.readInbox(home, task, role);
        const alarm = service.brokenNote(broken);
        const head = alarm ? `${alarm}\n\n` : '';
        const body = renderMessages(service, home, task, role, messages, session);
        // A foreign mailbox gets the heading even on an empty reply: without
        // it the session would read emptiness as "no messages". `mailbox` is
        // called once per turn, not in a poll loop.
        if (own.gated) return `${head}${foreignNote(task, own)}${messages.length ? `\n\n${body}` : ''}`;
        // Stall routes are asked exactly on wake: `mailbox` is called first
        // thing, and it has no other place where the report would arrive in time.
        const stalled = stalls({ home, task, address: role });
        return `${head}${body}${stalled ? `\n\n${stalled}` : ''}`;
      }
      case 'promptobus_send': {
        const to = args?.to as string;
        const { message, artifact } = service.send(home, task, {
          from: role,
          to,
          type: args?.type as string,
          body: args?.body as string,
          artifactPath: args?.artifactPath as string,
        });
        // The sender may also have attached to a foreign task. Send is a turn
        // people make without having taken their own mail: the last place
        // where what has piled up can still be named.
        const unread = service.unreadNote(home, task, role, session);
        return `${SENT_PREFIX}${message.type} → ${readableName(service.readTask(home, task), to)}${ADDR_MARK}${to}`
          + ` · id ${message.id}${artifact ? ` · artifact ${artifact.filename}` : ''}`
          + ` · ${service.identityLabel(home, task, role, session)}`
          + (unread ? `\n${unread}` : '');
      }
      case 'promptobus_task':
        return renderTask(service, home, task, role, session, decorateParticipant);
      default:
        throw new UnknownToolError(name);
    }
  }

  // Entering a task: hand over the contact point and lift a listener. Per
  // connection this is done ONCE per task — `joined` is that mark. A repeat
  // is not an error, but it is not work either: `onJoin` writes to the store
  // and lifts a process, and a session enters a task once per connection. The
  // key is the task id, not the address: an explicit `task` tool argument may
  // name another, and entering that one is lawful.
  //
  // **The mark is set AFTER a successful enter and only for whoever handed
  // over a contact point.** The order is not cosmetic: `ownership` is the
  // first real read of the task journal (`resolveTaskId` only checks that it
  // exists), and on a wiped or unreadable journal it refuses. Marking enter
  // early, the server would remember as entered a session that did not enter
  // — and the next `tools/call` would skip enter, so the contact point would
  // never be handed over in the life of the session (review remark). The
  // ownership gate is the other half of the same: a foreign session does not
  // get a socket written (`joinBus`), but it may become the owner on the same
  // connection — `mailbox {claim: true}` — and the mark would keep
  // `wake/<address>.json` on the previous owner's socket until the end of the turn.
  function join(identity: McpIdentity, task: string, joined: Set<string>): void {
    if (joined.has(task)) return;
    const { home, role, session } = identity;
    // Ownership is asked here: contact-point handoff must happen before work
    // — otherwise the first call of a foreign session would have time to
    // write its own socket.
    const { gated } = service.ownership(home, task, role, session);
    onJoin({ home, task, address: role, gated });
    if (!gated) joined.add(task);
  }

  // Enter by the DECLARED task — that is how enter happens on handshake, where
  // there is no `task` argument yet. The task is resolved the same way as for
  // a tool (declaration → session binding → the only active one).
  //
  // Only a lawful refusal (`GateError`) is caught: there is no task in the
  // home yet, several are active, the named one does not exist, the journal
  // does not read. The orchestrator server is lifted with its session when
  // there is no task, and `initialize` must not be dropped by such a refusal
  // — the session would be left with no bus at all. Everything else goes out:
  // an unexpected error is a crash, and hiding it here would mean fixing it
  // blind. Enter leaves no mark on a refusal, so the next `tools/call` tries again.
  function joinDeclared(identity: McpIdentity, joined: Set<string>): void {
    service.withTaskCache(() => {
      try {
        join(identity, service.resolveTaskId(identity.home, identity.declaredTask, identity.session), joined);
      } catch (e) {
        if (!(e instanceof GateError)) throw e;
      }
    });
  }

  function callTool(identity: McpIdentity, name: string, args: Record<string, unknown>, joined: Set<string>): string {
    const { home, declaredTask, session } = identity;
    // An explicit task argument outranks the session's declared one — the same way `--task` outranks `PROMPTOBUS_TASK`.
    const asked = typeof args?.task === 'string' ? args.task.trim() : '';
    return service.withTaskCache(() => {
      const task = service.resolveTaskId(home, asked || declaredTask, session);
      join(identity, task, joined);
      const text = syncTool(identity, name, args, task);
      // `claim` changes ownership AFTER the first enter: on it join still saw
      // a foreign mailbox and did not hand over a socket. The second enter is
      // already the owner's, and the contact point is rewritten by the same
      // call, without waiting for the next tool.
      if (name === 'promptobus_mailbox' && args?.claim === true) join(identity, task, joined);
      return text;
    });
  }

  function handle(msg: JsonRpcMessage, identity: McpIdentity, joined: Set<string>): object | null {
    const { id, method, params } = msg;
    // A notification (no id) must not get a reply.
    if (id === undefined || id === null) return null;
    switch (method) {
      case 'initialize': {
        // The contact point is handed over on HANDSHAKE: identity is already
        // resolved by then, and there is no need to wait for the first tool —
        // a session that did the handshake and called nothing otherwise stays
        // deaf to the warden, and the warden lawfully falls back to
        // `self-wake`. Enter on `tools/call` still stays: a tool is also
        // called without a handshake, and with another task as an argument.
        joinDeclared(identity, joined);
        const info = serverInfo();
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: negotiateProtocol(protocolVersions, params?.protocolVersion),
            capabilities: { tools: {} },
            serverInfo: { name: info.name, version: info.version },
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
      case 'tools/call': {
        const name = params?.name as string;
        try {
          const text = callTool(identity, name, (params?.arguments as Record<string, unknown>) ?? {}, joined);
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
        } catch (e) {
          // A tool error is not a protocol error: the connection must not be lost.
          const event: McpEvent = e instanceof UnknownToolError
            ? { kind: 'unknown-tool', tool: e.tool }
            : { kind: 'tool-failed', cause: e as Error };
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: errorText(event) }], isError: true } };
        }
      }
      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: errorText({ kind: 'unknown-method', method: method as string }) },
        };
    }
  }

  // Tools are synchronous, so requests go strictly one at a time, in arrival
  // order. Start an async one — it will freeze the whole channel for its
  // duration: `ping` and neighbouring calls of the same session will wait for
  // it to finish. Detach that kind from this queue.
  async function serve({ input, output }: { input: McpInput; output: McpOutput }): Promise<void> {
    const identity = resolveIdentity();
    // Tasks this CONNECTION has already entered. The mark lives on the
    // connection, not on the factory: the server is lifted by the session
    // process, and enter is a property of the conversation, not of the module.
    const joined = new Set<string>();
    const write = (obj: object): unknown => output.write(JSON.stringify(obj) + '\n');
    input.setEncoding('utf8');
    let buf = '';
    for await (const chunk of input) {
      buf += chunk;
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(line) as JsonRpcMessage;
        } catch {
          write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: errorText({ kind: 'parse' }) } });
          continue;
        }
        const answer = handle(msg, identity, joined);
        if (answer) write(answer);
      }
    }
  }

  return { serve };
}
