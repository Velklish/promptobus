// The tool declarations.
// [reference/01-overview.md#the-tool-declarations](../../docs/reference/01-overview.md#the-tool-declarations)
import { MESSAGE_TYPES } from '../protocol.js';

/** One tool declaration, as `tools/list` returns it. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    /** `false` — the server refuses a key the declaration does not carry, naming it. */
    additionalProperties?: false;
  };
}

// Task as an argument — on every tool: `PROMPTOBUS_TASK` is bound when the
// session starts, cannot be changed while it is live, and there can be several
// active tasks.
const TASK_ARG = {
  task: {
    type: 'string',
    description: 'task id — needed when several tasks are active and this session has no binding; '
      + 'without it the session PROMPTOBUS_TASK is used, otherwise this session\'s declared binding '
      + '(written by spawn, review, and claim), otherwise the only active task',
  },
};

// Every declaration carries `additionalProperties: false`, and the server enforces it:
// a misspelt key used to be dropped in silence, and `claimed: true` reads as an ordinary take.
export const MCP_TOOLS: McpTool[] = [
  {
    name: 'promptobus_send',
    description: 'Send a message to a task participant. Address: orchestrator, worker:<slug>, reviewer:<slug> or approver:<slug>. '
      + 'Workers and approvers in the same task may write directly; other participant traffic goes through the orchestrator. '
      + 'The reply names PROMPTOBUS_HOME, your address, and the task the message landed in — by id and by name, '
      + 'and if your mailbox has unread mail — its count.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'recipient address: orchestrator, worker:<slug>, reviewer:<slug> or approver:<slug>' },
        type: { type: 'string', enum: MESSAGE_TYPES, description: 'v1 protocol message type' },
        body: { type: 'string', description: 'text: assignment, status, question, answer, result, or review remarks' },
        artifactPath: {
          type: 'string',
          description: 'absolute file path; copied into the task artifacts/, the message gets the name. '
            + 'Required when type is artifact: an artifact message always carries a file',
        },
        ...TASK_ARG,
      },
      required: ['to', 'type', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'promptobus_mailbox',
    description: 'Take the accumulated messages for your address without blocking. That same call '
      + 'marks them read: the warden postcard carries the text of short messages, but '
      + 'the truth stays in the mailbox, and a lost postcard loses nothing. '
      + 'The reply names PROMPTOBUS_HOME, the address, and the task — by id and by name; check them if you are waiting '
      + 'for a message that is not there. The orchestrator mailbox is bound to the session that started the task: '
      + 'a foreign session gets a copy, the originals stay with the owner. '
      + 'A call that names no session, on the orchestrator address, gets a copy and the originals stay; '
      + 'claim from that call is refused. If the correspondence is yours '
      + 'and this is a new session (the previous daemon died) — claim the mailbox with the claim argument.',
    inputSchema: {
      type: 'object',
      properties: {
        claim: {
          type: 'boolean',
          description: 'bind the orchestrator mailbox to this session and read it as yours; '
            + 'the reply will name the previous owner',
        },
        ...TASK_ARG,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'promptobus_task',
    description: 'Metadata of the current task: id, title, status, participants with repositories '
      + 'and bg-sessions, unread counts, path to the artifacts folder.',
    inputSchema: { type: 'object', properties: { ...TASK_ARG }, additionalProperties: false },
  },
];
