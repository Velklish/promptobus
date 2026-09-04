// Promptobus service as the MCP layer sees it: the list of operations the
// tools use. The list is explicit, not "the whole store", and that is the
// point of the file — the boundary is visible to the eye, not inferred by
// reading four modules. Operations take home as an argument: it arrives with
// the process identity, and there is no second source for it.
//
// The service is passed to the factory explicitly, and it has no default
// implementation: half the list is the adapter's business, not the store.
// Mailbox ownership, the "session → task" binding, active-task resolve, and
// the `PROMPTOBUS_HOME=… · task=… · address=…` heading rest on session
// identity, and only the adapter reads the environment. The consumer adapter
// assembles the service.
//
// Addresses, not participant ids. Bus tools talk in addresses: the address is
// declared to the participant by their mcp-config, health and contact points
// are keyed by it, and a person reads it. Translating an address into a v1
// record id is the adapter's job — where the adapter lives.
import type { Ownership } from '../protocol.js';
import type { ArtifactV1, MessageV1, TaskV1 } from '../v1/model.js';

/** What the `promptobus_send` tool sends on the bus. */
export interface OutgoingMessage {
  from: string;
  to: string;
  type: string;
  body: string;
  artifactPath?: string | null;
}

/** Send outcome: the canon and the artifact metadata, if there was one. */
export interface SentMessage {
  message: MessageV1;
  artifact: ArtifactV1 | null;
}

/** What was found in the mailbox: messages and human lines about unreadable ones. */
export interface MailboxRead {
  messages: MessageV1[];
  broken: string[];
}

/** Operations the MCP layer uses. The adapter assembles them. */
export interface PromptobusService {
  /** Task files folder: `promptobus_task` prints its path; artifacts live in it. */
  artifactsDir(home: string, task: string): string;
  /** Artifact file name by its metadata-record id; `undefined` — the record did not read. */
  artifactName(home: string, task: string, artifact: string): string | undefined;
  /** Bind a session to the task it owns. */
  bindSession(home: string, task: string, session: string | null): unknown;
  /** Line about unreadable records for a tool reply; `null` — nothing to say. */
  brokenNote(broken: string[]): string | null;
  /** Claim the `orchestrator` mailbox. Returns the previous owner. */
  claimOwnership(home: string, task: string, owner: string): string | null;
  /** How much unread mail sits at the address. */
  countInbox(home: string, task: string, addr: string): number;
  /** Reply heading: home, task by id and name, address, and drift from the session binding. */
  identityLabel(home: string, task: string, addr: string, session?: string | null): string;
  /** Mailbox ownership: whether it is closed for another session. */
  ownership(home: string, task: string, addr: string, session: string | null): Ownership;
  /** Read without taking: the originals stay with the owner. */
  peekInbox(home: string, task: string, addr: string): MailboxRead;
  /** Take incoming mail: read items move to history. */
  readInbox(home: string, task: string, addr: string): MailboxRead;
  readTask(home: string, task: string): TaskV1;
  /** Active task of the process: declared → session binding → the only active one. */
  resolveTaskId(home: string, declared: string | null | undefined, session: string | null): string;
  send(home: string, task: string, outgoing: OutgoingMessage): SentMessage;
  /** Tail `your mailbox: unread N`; `null` — zero, or nothing to say. */
  unreadNote(home: string, task: string, addr: string, session: string | null): string | null;
  /** Journal cache for one tool call: the journal is read four to six times. */
  withTaskCache<T>(fn: () => T): T;
}
