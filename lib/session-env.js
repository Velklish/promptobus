// Identity and messaging of the PARENT harness. A participant must not be able to read its
// parent's session at all, whichever harness lifted it. Why: 03-cli § Spawn, PB-182.
export const PARENT_SESSION_ENV = [
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID', 'CLAUDE_EFFORT',
  'CODEX_HOME', 'CODEX_THREAD_ID',
  'CURSOR_CONVERSATION_ID', 'AGENT_CLI_SOCKET_PATH', 'AGENT_CLI_LOG_PATH', 'CURSOR_AGENT_SOCKET',
  'PROMPTOBUS_CURSOR_SESSION',
];

// The warden switch and its trace. A harness that REPLACES the MCP child's environment
// drops both unless the driver names them: measured on Codex and Cursor (PB-171).
export const WARDEN_ENV_VARS = ['PROMPTOBUS_WARDEN', 'PROMPTOBUS_WARDEN_TRACE'];
