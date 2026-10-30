import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, chmodSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CodexRpc } from './codex-rpc.js';
import { reviewerFiles as readReviewerFiles, REVIEW_FILE_TOOLS as readReviewerTools } from './reviewer-files.js';

export type ReviewerTool = { name: string; description: string; inputSchema: unknown };
export const REVIEW_FILE_TOOLS: { name: string; description: string; inputSchema: unknown }[] = readReviewerTools;
export const reviewerFiles: (roots: string[], canonicalFiles?: string[]) => (name: string, args: unknown) => unknown = readReviewerFiles as typeof reviewerFiles;

interface ToolCall { threadId: string; turnId: string | null; callId: string; tool: string; arguments: Record<string, unknown> }
interface Notification { method: string; params?: unknown }
interface ConnectInput {
  directory: string; tools?: ReviewerTool[]; invoke?: (params: ToolCall) => Promise<unknown>;
  notify?: (message: Notification) => void; executable?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal;
}
interface OpenInput extends ConnectInput {
  model: string; effort?: string; instructions?: string; threadId?: string | null;
  invoke: (params: ToolCall) => Promise<unknown>;
}
interface ThreadResult { sandbox?: { type?: unknown; networkAccess?: unknown }; approvalPolicy?: unknown; model?: unknown; reasoningEffort?: unknown; thread?: { id?: string } }


export const BB_REVIEWER_TOOLS = ['pb_review_read_file', 'pb_review_read_files', 'pb_review_list_files', 'pb_review_search_text'];
export const BB_REVIEWER_PROTOCOL_TOOLS = ['promptobus_send', 'promptobus_mailbox', 'promptobus_task', 'promptobus_artifact'];
export const BB_REVIEWER_HOST_TOOLS = ['promptobus_host_context', 'promptobus_host_call'];
const disabledFeatures = ['apps', 'plugins', 'remote_plugin', 'shell_tool', 'unified_exec', 'hooks',
  'multi_agent', 'multi_agent_v2', 'browser_use', 'computer_use', 'image_generation', 'view_image',
  'memories', 'skill_search', 'skill_mcp_dependency_install', 'workspace_dependencies', 'goals'];

export function reviewerTools(tools: ReviewerTool[] = []): ReviewerTool[] {
  return tools.filter(tool => BB_REVIEWER_TOOLS.includes(tool.name) || BB_REVIEWER_PROTOCOL_TOOLS.includes(tool.name) || BB_REVIEWER_HOST_TOOLS.includes(tool.name))
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export function reviewerProfile({ cwd, model, effort, instructions, tools = [] }: { cwd: string; model: string; effort?: string; instructions?: string; tools?: ReviewerTool[] }): Record<string, unknown> {
  if (!model) throw new Error('An explicit Codex model is required for the reviewer');
  return { cwd, model, sandbox: 'read-only', approvalPolicy: 'never',
    developerInstructions: instructions ?? null, dynamicTools: reviewerTools(tools),
    config: { web_search: 'disabled', ...Object.fromEntries(disabledFeatures.map(name => [`features.${name}`, false])),
      ...(effort ? { model_reasoning_effort: effort } : {}) } };
}

export function verifyReviewerProfile(value: unknown, model: string): void {
  const result = value as ThreadResult | null | undefined;
  if (result?.sandbox?.type !== 'readOnly' || result.sandbox.networkAccess !== false
    || result?.approvalPolicy !== 'never' || result?.model !== model) {
    throw new Error('Codex reviewer profile mismatch; no model turn started');
  }
}

export function verifyReviewerConfig(value: unknown): void {
  const config = value as { features?: Record<string, unknown>; web_search?: unknown; mcp_servers?: unknown } | null | undefined;
  if (disabledFeatures.some(name => config?.features?.[name] !== false) || config?.web_search !== 'disabled'
    || !config?.mcp_servers || Object.keys(config.mcp_servers).length !== 0) {
    throw new Error('Codex reviewer startup restrictions unavailable; no thread started');
  }
}

async function connect({ directory, tools = [], invoke, notify = () => {}, executable = 'codex', env = process.env, signal }: ConnectInput) {
  signal?.throwIfAborted();
  const home = path.join(directory, 'codex');
  const cwd = path.join(directory, 'sandbox');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const auth = path.join(env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'auth.json');
  if (existsSync(auth)) {
    copyFileSync(auth, path.join(home, 'auth.json'));
    chmodSync(path.join(home, 'auth.json'), 0o600);
  }
  const childEnv: NodeJS.ProcessEnv = { ...env, CODEX_HOME: home };
  for (const key of Object.keys(childEnv)) if (key.startsWith('BB_') || key.startsWith('PROMPTOBUS_')) delete childEnv[key];
  const child = spawn(executable, ['app-server', '--stdio', '-c', 'web_search="disabled"',
    ...disabledFeatures.flatMap(name => ['--disable', name])],
    { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  const rpc = CodexRpc(child);
  child.stdin.on('error', () => {});
  child.stderr.resume();
  let closing: Promise<void> | undefined;
  let terminated = false;
  const ended = (params: unknown) => {
    rpc.close();
    if (!closing && !terminated) notify({ method: 'reviewer/closed', params });
    terminated = true;
  };
  child.on('error', error => ended({ error: error.message }));
  child.on('exit', (code, signal) => ended({ code, signal }));
  const off = rpc.onNotification(notify as (message: unknown) => void);
  const allowed = new Set(reviewerTools(tools).map(tool => tool.name));
  rpc.onServerRequest(async value => {
    const message = value as { method?: unknown; params?: { tool?: string } };
    if (message.method !== 'item/tool/call' || !allowed.has(message.params?.tool!)) {
      return { __error: { code: -32000, message: 'Codex reviewer operation denied' } };
    }
    return invoke!(message.params as ToolCall);
  });
  const request = async (method: string, params?: unknown, timeoutMs?: number): Promise<unknown> => {
    const result = await rpc.request(method, params, timeoutMs) as { error?: { message: string }; result?: unknown };
    if (result.error) throw new Error(result.error.message);
    return result.result;
  };
  const close = () => closing ??= (async () => {
    signal?.removeEventListener('abort', aborted);
    off(); rpc.close();
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
    try { await exited; } finally { clearTimeout(timer); }
  })();
  const aborted = () => { void close(); };
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) await close();
  try {
    const initialized = await request('initialize', { clientInfo: { name: 'promptobus_bb_reviewer', version: '0.1.0' }, capabilities: { experimentalApi: true } }) as { codexHome?: unknown };
    if (typeof initialized.codexHome !== 'string' || realpathSync(initialized.codexHome) !== realpathSync(home)) {
      throw new Error('Codex reviewer did not use its private home; no thread started');
    }
    verifyReviewerConfig((await request('config/read', { includeLayers: false }) as { config?: unknown }).config);
    return { cwd, request, close, pid: child.pid! };
  } catch (error) { await close(); throw error; }
}

export function queryBbReviewer(input: { directory: string; signal?: AbortSignal }, method: string, params?: unknown): Promise<any>;
export async function queryBbReviewer(input: ConnectInput, method: string, params: unknown = {}): Promise<unknown> {
  const transport = await connect(input);
  try { return await transport.request(method, params); } finally { await transport.close(); }
}

export function openBbReviewer(input: {
  directory: string; model: string; effort?: string; instructions?: string; tools?: ReviewerTool[]; threadId?: string | null;
  invoke: (params: { threadId: string; turnId: string | null; callId: string; tool: string; arguments: Record<string, unknown> }) => Promise<unknown>;
  notify?: (message: { method: string; params?: any }) => void; executable?: string; env?: Record<string, string | undefined>; signal?: AbortSignal;
}): Promise<{ threadId: string; pid: number; profile: unknown; request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>; close: () => Promise<void> }>;
export async function openBbReviewer(input: OpenInput) {
  const { model, effort, instructions, tools = [], threadId = null } = input;
  const transport = await connect(input);
  const { cwd, request, close } = transport;
  try {
    const profile = reviewerProfile({ cwd, model, effort, instructions, tools });
    const started = await request(threadId ? 'thread/resume' : 'thread/start', { ...profile, ...(threadId ? { threadId } : {}) }) as ThreadResult;
    verifyReviewerProfile(started, model);
    if (effort && started.reasoningEffort !== effort) throw new Error('Codex reviewer effective effort mismatch');
    const id = started.thread?.id;
    if (!id || (threadId && id !== threadId)) throw new Error('Codex reviewer returned a different thread identity');
    return { threadId: id, pid: transport.pid, profile: { model: started.model, effort: started.reasoningEffort ?? null,
      sandbox: started.sandbox, approvalPolicy: started.approvalPolicy }, request, close };
  } catch (error) { await close(); throw error; }
}
