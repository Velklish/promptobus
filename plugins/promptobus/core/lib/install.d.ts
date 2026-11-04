import type { PromptobusHost } from '../dist/index.js';
import type { CodexRootProfileDescriptor } from './root-launch.js';
import type { StandaloneRootProfileDescriptor } from './standalone-root.js';
export type InstallHarness = 'claude' | 'cursor' | 'codex';
export interface InstallTarget {
    readonly hooksRel: string;
    readonly skillsRel: string;
}
export interface PackageSkillFile {
    rel: string;
    abs: string;
    buffer: Uint8Array;
    text: string;
}
export interface PackageSkill {
    name: string;
    files: PackageSkillFile[];
}
export type InstallPlanHost = Pick<PromptobusHost, 'nodePath' | 'guardArgv' | 'busHookRel' | 'installManifestRel'>;
export interface InstallWrite {
    rel: string;
    abs: string;
    text: string | null;
    buffer?: Uint8Array | null;
    remove?: true;
}
interface PlannedWrite extends InstallWrite {
    foreign?: boolean;
}
export interface InstallPlan {
    writes: InstallWrite[];
    owned: Record<InstallHarness, string[]>;
    ownedSkills: Record<InstallHarness, string[]>;
    unproven: string[];
}
export interface InstallPlanOptions {
    rootProfile?: CodexRootProfileDescriptor | StandaloneRootProfileDescriptor;
}
interface InstallOptions {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    harnesses?: unknown;
    check?: boolean;
    dryRun?: boolean;
    skillsDir?: string;
}
export declare const INSTALL_HARNESSES: InstallHarness[];
export declare const HOME_HOOK_DIRS: string[];
export declare const HARNESSES_FIELD = "harnesses";
export declare const MANIFEST_KIND = "promptobus-hooks";
export declare const SKILL_OWNERSHIP_MARKER: string;
export declare const CURSOR_HOOK_EVENTS: string[];
export declare const CURSOR_PROVEN_HOOK_EVENTS: string[];
export declare const CURSOR_HOOK_EVENTS_SOURCE_VERSION = "2026.09.10-fd3934a";
export declare function cursorUnprovenHookEvents(hooks: unknown): string[];
export declare function assertCursorHookEvents(hooks: unknown): void;
export declare function homeHookRoots(env?: NodeJS.ProcessEnv): string[];
export declare function parseHarnessList(raw: unknown): InstallHarness[];
export declare function resolveProjectRoot(host: Pick<PromptobusHost, 'workspaceRoot'>, cwd?: string): string;
export declare function packageSkills(skillsDir?: string): PackageSkill[];
export declare const INSTALL_TARGETS: Readonly<Record<InstallHarness, InstallTarget>>;
export declare function planHookInstall(host: InstallPlanHost, root: string, wanted: readonly InstallHarness[], { check, dryRun, skillsDir, rootProfile }?: {
    check?: boolean;
    dryRun?: boolean;
    skillsDir?: string;
} & InstallPlanOptions): {
    writes: PlannedWrite[];
    owned: Record<InstallHarness, string[]>;
    ownedSkills: Record<InstallHarness, string[]>;
    prev: {
        abs: string;
        rel: string;
        doc: Record<string, unknown>;
        missing: boolean;
        owned: Record<InstallHarness, string[]>;
        ownedSkills: Record<InstallHarness, string[]>;
    };
    hookHost: {
        commandName: string | undefined;
        syncHint: () => string;
        nodePath: () => string;
        guardArgv: (args: string[]) => string[];
        workspaceRoot: () => string;
        busHookRel: () => string;
    };
    runnerAbs: string;
    runnerRel: string;
    unproven: string[];
};
export declare function install(rootOrHost: unknown, opts?: InstallOptions): 0 | 1;
export declare function uninstall(rootOrHost: unknown, opts?: InstallOptions): 0 | 1;
export {};
