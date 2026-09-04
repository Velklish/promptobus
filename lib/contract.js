// Bus-contract values cited in prose: CLI help, the reference, the guide, and the
// orchestration skill. This is their only home.
//
// **Only harness-neutral lives here**. Effort levels, permission modes, binary versions,
// and the list of tools to deny moved to the driver ([driver-claude.js](driver-claude.js)):
// that is ONE harness's dictionary, and the second driver has its own — a shared home
// would mean the bus knows Claude Code values by heart. Contract citations in the docs
// still stand on them: `lint` takes the value from the new home, and the
// `<!-- contract:… -->` keys did not change.
//
// The module is a leaf — it has no imports of its own, and that is a working condition:
// the command help reads it, and that help is assembled before any work — there is no
// reason to pull a repository resolver for one line. Message types were removed from
// here at the same price: their home is the package, and importing them here would
// drag the store along.
//
// `lint` takes them from here too, checking prose against code: a documentation block
// marked with a contract key must list exactly these values.

// Name of the bus entry in a participant config. It is also the name of the base
// canonical server, and the match is not an accident: tool names (`mcp__promptobus__…`)
// on the orchestrator and the participant must be the same. spawn.js re-exports the
// constant.
export const PROMPTOBUS_SERVER = 'promptobus';

// The bus server tool set. The value lives here, not in `server.js`: documentation
// cites the list, and `lint` checks the citation against the code. The server itself
// declares them with descriptions and input schemas; that the set has not drifted from
// this list is held by a live `tools/list` check in `promptobus-mcp.test.mjs`. There is
// no expectation in the set and there will not be one. A task has one alarm, and that
// is the warden.
//
// **The name prefix is double on purpose**: the full name a session sees is
// `mcp__promptobus__promptobus_send`. The client namespaces names itself, and short
// `send` and `task` collide with foreign ones in the session's shared set. The cost is
// known and accepted: the client prepends `PostToolUse:mcp__<server>__<…> says:` to
// EVERY journal line in the tape.
export const PROMPTOBUS_TOOLS = ['promptobus_send', 'promptobus_mailbox', 'promptobus_task'];

// MCP protocol versions the bus server actually serves. The surface is the same for
// all three (`initialize`, `ping`, `tools/list`, `tools/call` with a text result) and
// did not change between revisions; divergences (structured result, elicitation,
// sampling) the server does not claim. Order matters: the first is its latest, and
// that is the reply to an unknown one.
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// Age threshold for task-journal cleanup, in days. Derived from a measurement
// (~3 MB a day of dense orchestration) and from why the journal is kept: people return
// to a finished run's mail in days, not weeks. Anything else is `--older-than`.
export const PRUNE_DEFAULT_DAYS = 14;

// How many characters of message text a warden notification carries. The budget is for
// the ENTIRE text block, not a per-message threshold: a pack of five short ones would
// otherwise make a notification five times the longest. The number is not a channel
// limit, it is policy: the channel was measured live to 16 MB character for character,
// the limit sits in the cost — a notification rides into a foreign context and costs
// tokens there, and the truth is still in the mailbox. Sized from live mail
// (768 messages, 2026-08-30): two thousand characters cover 46.5% of messages and the
// medians of types where a fast reply is needed; `result` (median 5298) goes as a
// count — it is read from the mailbox in full.
export const KNOCK_TEXT_MAX = 2000;
