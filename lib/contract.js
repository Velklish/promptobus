// The bus contract constants.
// [reference/04-protocol.md#the-bus-contract-constants](../docs/reference/04-protocol.md#the-bus-contract-constants)

// Name of the bus entry in a participant config, and of the base canonical server: tool
// names (`mcp__promptobus__…`) must be the same on the orchestrator and the participant.
export { PROMPTOBUS_SERVER } from '../dist/contract.js';

// The bus server tool set; the value lives here so `test/promptobus-mcp.test.mjs` can check
// the live server's `tools/list` against it — [01-overview.md § The tool declarations](../docs/reference/01-overview.md#the-tool-declarations).
export const PROMPTOBUS_TOOLS = [
  'promptobus_send', 'promptobus_mailbox', 'promptobus_task',
  'promptobus_digest', 'promptobus_status', 'promptobus_ask',
];

// MCP protocol versions the server actually serves: the surface did not change between
// them, and order matters — the first is its latest, and the reply to an unknown one.
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// Age threshold for task-journal cleanup, in days: people return to a finished run's mail
// in days, not weeks. Anything else is `--older-than`.
export const PRUNE_DEFAULT_DAYS = 14;

// How many characters of stub lines a warden notification carries — a budget for the
// ENTIRE block, and policy rather than a channel limit ([03-cli.md § Guard and warden](../docs/reference/03-cli.md#guard-and-warden)).
export const KNOCK_TEXT_MAX = 2000;

// Harnesses a teamlead lifts on at the install root. The `spawn --teamlead` help and refusal name
// this list, so a change of admission changes both with it.
export const TEAMLEAD_HARNESSES = ['claude', 'codex'];

const HARNESS_NAMES = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
export const harnessName = (id) => HARNESS_NAMES[id] ?? id;
