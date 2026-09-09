// Generation of project-level bus hooks. The record shape is the harness
// contract; the command is the host: absolute node and bin, script path from
// host.busHookRel(). A consumer layout is not baked in here.
//
// The hook script lives as a template next to the sources (`templates/bus-hook.mjs`),
// not as a string literal: generated edits stay apart from the TypeScript core.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PROMPTOBUS_SERVER as BUS_SERVER } from './contract.js';
import type { PromptobusHost } from './host.js';

export const BUS_HOOK_EVENT = 'PostToolUse';
export const BUS_HOOK_SEP = '\n';
// Bus server name. `src/contract.ts` owns the literal; this alias and
// `lib/contract.js` both expose its compiled value. Drift from the server name
// would break the staged-hook matcher: the group would not be found.
export { BUS_SERVER };
export const BUS_HOOK_MATCHER = `mcp__${BUS_SERVER}__(promptobus_send|promptobus_mailbox)`;

export const GUARD_HOOK_EVENT = 'Stop';
export const GUARD_START_EVENT = 'SessionStart';

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

function shellQuote(arg: string): string {
  const s = String(arg);
  return SHELL_SAFE.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function quoteFlag(value: string, platform: string): string {
  return platform === 'win32'
    ? `"${String(value).replace(/"/g, '""')}"`
    : shellQuote(value);
}

export interface GuardIdentity {
  address: string;
  taskId: string;
  home: string;
}

export function renderBusHook(host: Pick<PromptobusHost, 'syncHint'>): string {
  const file = new URL('../templates/bus-hook.mjs', import.meta.url);
  return readFileSync(file, 'utf8').replaceAll('__SYNC__', host.syncHint());
}

export function busHookCommand(
  host: Pick<PromptobusHost, 'nodePath' | 'workspaceRoot' | 'busHookRel'>,
  extraArgs: readonly string[] = [],
  platform = 'posix',
): string {
  const script = path.join(host.workspaceRoot(), host.busHookRel());
  const extra = extraArgs.map((arg) => quoteFlag(arg, platform)).join(' ');
  return `"${host.nodePath()}" "${script}"${extra ? ` ${extra}` : ''}`;
}

export function busHookSettings(host: Pick<PromptobusHost, 'nodePath' | 'workspaceRoot' | 'busHookRel'>): Record<string, unknown> {
  return {
    [BUS_HOOK_EVENT]: [{
      matcher: BUS_HOOK_MATCHER,
      hooks: [{ type: 'command', command: busHookCommand(host) }],
    }],
  };
}

export function guardHookCommand(
  host: Pick<PromptobusHost, 'nodePath' | 'guardArgv'>,
  identity: GuardIdentity | null = null,
  platform = 'posix',
): string {
  const argv = host.guardArgv(['guard']);
  const identityFlags = identity
    ? [
      '--role', quoteFlag(identity.address, platform),
      '--task', quoteFlag(identity.taskId, platform),
      '--home', quoteFlag(identity.home, platform),
    ]
    : [];
  return [
    `"${host.nodePath()}"`,
    ...argv.map((arg, index) => index === 0 ? `"${arg}"` : arg),
    ...identityFlags,
  ].join(' ');
}

export function guardHookSettings(
  host: Pick<PromptobusHost, 'nodePath' | 'guardArgv'>,
  identity: GuardIdentity | null = null,
  platform = 'posix',
): Record<string, unknown> {
  const command = guardHookCommand(host, identity, platform);
  const group = () => [{ hooks: [{ type: 'command', command }] }];
  return { [GUARD_HOOK_EVENT]: group(), [GUARD_START_EVENT]: group() };
}

export interface HookPlan {
  rel: string;
  text: string;
  settings: Record<string, unknown>;
}

// Not a full PromptobusHost: the type declares which members the plan asks for,
// and sync passes exactly those.
export type PromptobusHookHost = Pick<PromptobusHost,
  'syncHint' | 'workspaceRoot' | 'busHookRel' | 'nodePath' | 'guardArgv'>;

export function planPromptobusHooks(
  host: PromptobusHookHost,
  identity: GuardIdentity | null = null,
  platform = 'posix',
): HookPlan {
  return {
    rel: host.busHookRel(),
    text: renderBusHook(host),
    settings: {
      ...busHookSettings(host),
      ...guardHookSettings(host, identity, platform),
    },
  };
}
