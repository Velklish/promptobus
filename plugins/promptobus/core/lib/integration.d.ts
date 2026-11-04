import { INSTALL_TARGETS, SKILL_OWNERSHIP_MARKER, packageSkills } from './install.js';
import { MAILBOX_UNREAD_MARK } from './status.js';
import { BRANCH_CHANGED_MARK, WORKTREE_BRANCH_TEMPLATE, npmCiCommand } from './worktree.js';
import type { DriverCapabilities, DriverOptions, PromptobusHost } from '../dist/index.js';
import type { InstallPlan, InstallPlanHost, InstallHarness, InstallPlanOptions } from './install.js';
export type { InstallHarness, InstallTarget, PackageSkillFile, PackageSkill, InstallPlanHost, InstallWrite, InstallPlan, InstallPlanOptions } from './install.js';
export { approveCodexRootProfile } from './root-launch.js';
export { approveStandaloneRootProfile } from './standalone-root.js';
export type { StandaloneRootProfileInput, StandaloneRootProfileDescriptor } from './standalone-root.js';
export interface DriverDeclaration {
    readonly id: string;
    readonly capabilities: Readonly<DriverCapabilities>;
    readonly options: Readonly<DriverOptions>;
}
export interface DriverDeclarations {
    readonly fallback: string;
    readonly drivers: Readonly<Record<string, DriverDeclaration>>;
}
export interface RoutingLayer {
    id: string;
    path: string;
    present: boolean;
    writable: boolean;
}
export interface RoutingFinding {
    code?: string;
    layer?: string;
    at?: string;
    rule?: string;
    message: string;
    [field: string]: unknown;
}
export interface RoutingWindow {
    kind: string;
    id: string;
    usedPercent: number;
    resetAt: string | null;
}
export interface RoutingHarness {
    harness: string;
    state: string;
    reason: string | null;
    message: string;
    tier: {
        name: string;
        source: string;
    } | null;
    windows: RoutingWindow[];
}
export interface RoutingDiagnosis {
    layers: RoutingLayer[];
    errors: RoutingFinding[];
    warnings: RoutingFinding[];
    cache: {
        file: string;
        present: boolean;
        takenAt: string | null;
    };
    strategy: {
        strategy: string;
        source: string | null;
    } | null;
    harnesses: RoutingHarness[];
    nearLimit: string[];
    skipped: 'layer-errors' | 'no-declared-harness' | null;
    failure: string | null;
}
export declare const PACKAGE_VERSION: string;
export declare const PROMPTOBUS_TOOLS: readonly string[];
export declare const PROTOCOL_VERSIONS: readonly string[];
export declare const KNOCK_TEXT_MAX: number, PRUNE_DEFAULT_DAYS: number;
export { BRANCH_CHANGED_MARK, INSTALL_TARGETS, MAILBOX_UNREAD_MARK, SKILL_OWNERSHIP_MARKER, WORKTREE_BRANCH_TEMPLATE, npmCiCommand, packageSkills, };
export declare const DRIVER_DECLARATIONS: DriverDeclarations;
export declare function checkWake(harness?: string | null, env?: NodeJS.ProcessEnv): Promise<{
    endpoint: string | null;
    ok: boolean;
    error: string | null;
    harness: string;
}>;
export declare function planHookInstall(host: InstallPlanHost, root: string, harnesses: readonly InstallHarness[], options?: InstallPlanOptions): InstallPlan;
export declare function routingDiagnosis(host: PromptobusHost, options?: {
    now?: number;
}): Promise<RoutingDiagnosis>;
