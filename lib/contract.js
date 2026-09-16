// The bus contract constants.
// [reference/04-protocol.md#the-bus-contract-constants](../docs/reference/04-protocol.md#the-bus-contract-constants)

// Name of the bus entry in a participant config, and of the base canonical server: tool
// names (`mcp__promptobus__…`) must be the same on the orchestrator and the participant.
export { PROMPTOBUS_SERVER } from '../dist/contract.js';

// The bus server tool set; the value lives here so `lint` can check the documentation's
// citation against the code — [01-overview.md § The tool declarations](../docs/reference/01-overview.md#the-tool-declarations).
export const PROMPTOBUS_TOOLS = ['promptobus_send', 'promptobus_mailbox', 'promptobus_task'];

// MCP protocol versions the server actually serves: the surface did not change between
// them, and order matters — the first is its latest, and the reply to an unknown one.
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// Age threshold for task-journal cleanup, in days: people return to a finished run's mail
// in days, not weeks. Anything else is `--older-than`.
export const PRUNE_DEFAULT_DAYS = 14;

// How many characters of message text a warden notification carries — a budget for the
// ENTIRE block, and policy rather than a channel limit ([03-cli.md § Guard and warden](../docs/reference/03-cli.md#guard-and-warden)).
export const KNOCK_TEXT_MAX = 2000;
