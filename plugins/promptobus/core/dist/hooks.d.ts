import { PROMPTOBUS_SERVER as BUS_SERVER } from './contract.js';
import type { PromptobusHost } from './host.js';
export declare const BUS_HOOK_EVENT = "PostToolUse";
export { BUS_SERVER };
export declare const GUARD_HOOK_EVENT = "Stop";
export declare const GUARD_START_EVENT = "SessionStart";
export interface GuardIdentity {
    address: string;
    taskId: string;
    home: string;
}
export declare function guardHookCommand(host: Pick<PromptobusHost, 'nodePath' | 'guardArgv'>, identity?: GuardIdentity | null, platform?: string): string;
export declare function guardHookSettings(host: Pick<PromptobusHost, 'nodePath' | 'guardArgv'>, identity?: GuardIdentity | null, platform?: string): Record<string, unknown>;
export interface HookPlan {
    settings: Record<string, unknown>;
}
export type PromptobusHookHost = Pick<PromptobusHost, 'nodePath' | 'guardArgv'>;
export declare function planPromptobusHooks(host: PromptobusHookHost, identity?: GuardIdentity | null, platform?: string): HookPlan;
