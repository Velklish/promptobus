// Identity and messaging of the PARENT harness, dropped by every driver's `SESSION_ENV_DROP`.
// A shared leaf, not a per-driver list: the names belong to no driver. Why: 03-cli § Spawn.
export const PARENT_SESSION_ENV = [
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID', 'CLAUDE_EFFORT',
  'CODEX_HOME', 'CODEX_THREAD_ID',
  'CURSOR_CONVERSATION_ID', 'AGENT_CLI_SOCKET_PATH', 'AGENT_CLI_LOG_PATH', 'CURSOR_AGENT_SOCKET',
  'PROMPTOBUS_CURSOR_SESSION',
];
