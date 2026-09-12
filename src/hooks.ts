// Generation of project-level bus hooks. The record shape is the harness
// contract; the command is the host: absolute node and bin.

import { PROMPTOBUS_SERVER as BUS_SERVER } from './contract.js';
import type { PromptobusHost } from './host.js';

// What the installer knows and never writes.
// [guides/install.md](../docs/guides/install.md#what-the-installer-writes)
export const BUS_HOOK_EVENT = 'PostToolUse';
export { BUS_SERVER };

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

// No `rel`/`text`: the plan wrote a runner script while the feed hook existed,
// and the guard needs no file of its own — it runs the bin.
export interface HookPlan {
  settings: Record<string, unknown>;
}

// Not a full PromptobusHost: the type declares which members the plan asks for,
// and sync passes exactly those.
export type PromptobusHookHost = Pick<PromptobusHost, 'nodePath' | 'guardArgv'>;

export function planPromptobusHooks(
  host: PromptobusHookHost,
  identity: GuardIdentity | null = null,
  platform = 'posix',
): HookPlan {
  return { settings: guardHookSettings(host, identity, platform) };
}
