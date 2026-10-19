import { codexInitParams } from '../lib/codex-session.js';
import { PROVEN_CODEX_VERSION } from '../lib/driver-codex.js';

export const holderParams = {
  InitializeParams: codexInitParams({ hostName: 'promptobus', hostVersion: '0.21.0' }, {}),
  ThreadStartParams: { cwd: '/fixture/root', sandbox: 'workspace-write', approvalPolicy: 'on-request',
    model: 'gpt-6-astra', runtimeWorkspaceRoots: ['/fixture/rules'],
    config: { 'features.hooks': false, 'skills.config': [{ path: '/fixture/personal/SKILL.md', enabled: false }] } },
  ThreadResumeParams: { threadId: 'fixture-thread', cwd: '/fixture/root', sandbox: 'workspace-write',
    approvalPolicy: 'on-request', model: 'gpt-6-astra', excludeTurns: true,
    config: { 'features.hooks': false, 'skills.config': [{ path: '/fixture/personal/SKILL.md', enabled: false }] } },
  SkillsListParams: { cwds: ['/fixture/root'], forceReload: true },
  GetAccountParams: { refreshToken: false },
  TurnStartParams: { threadId: 'fixture-thread', input: [{ type: 'text', text: 'Read mailbox' }], effort: 'low' },
  TurnSteerParams: { threadId: 'fixture-thread', expectedTurnId: 'fixture-turn', input: [{ type: 'text', text: 'Mail arrived' }] },
  ThreadReadParams: { threadId: 'fixture-thread', includeTurns: true },
  ThreadInjectItemsParams: { threadId: 'fixture-thread', items: [{ type: 'message', role: 'user',
    content: [{ type: 'input_text', text: 'Original authorized assignment' }] }] },
};
Object.assign(holderParams, {
  ModelListParams: { includeHidden: true },
  ThreadSetNameParams: { threadId: 'fixture-thread', name: 'Fixture participant' },
  TurnInterruptParams: { threadId: 'fixture-thread', turnId: 'fixture-turn' },
  ReviewStartParams: { threadId: 'fixture-thread', target: { type: 'uncommittedChanges' }, delivery: 'inline' },
});
export function protocolTurn(turn) {
  return { ...turn, status: turn.status ?? 'inProgress', items: (turn.items ?? []).map((item, index) => ({
    ...item, id: item.id ?? `${turn.id}-item-${index}`,
  })) };
}

export function protocolThread(thread, includeTurns = true) {
  return {
    id: thread.id, sessionId: thread.id, cliVersion: PROVEN_CODEX_VERSION,
    createdAt: 0, updatedAt: 0, cwd: thread.cwd, ephemeral: false,
    modelProvider: 'openai', preview: '', projectId: null, source: 'appServer',
    name: thread.name ?? null, status: { type: thread.busy ? 'active' : 'idle', ...(thread.busy ? { activeFlags: [] } : {}) },
    turns: includeTurns ? (thread.turns ?? []).map(protocolTurn) : [],
  };
}

export function protocolThreadResponse(thread, includeTurns = true) {
  const sandbox = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' };
  return {
    thread: protocolThread(thread, includeTurns), cwd: thread.cwd,
    model: thread.model ?? 'gpt-6-astra', modelProvider: 'openai',
    approvalPolicy: thread.approvalPolicy ?? 'on-request', approvalsReviewer: 'user',
    sandbox: { type: sandbox[thread.sandbox] ?? 'workspaceWrite' },
    ...(thread.config?.model_reasoning_effort ? { reasoningEffort: thread.config.model_reasoning_effort } : {}),
  };
}

