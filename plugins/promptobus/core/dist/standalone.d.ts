import type { PromptobusHost } from './host.js';
export declare const HOST_CONFIG = "promptobus.json";
export interface StandaloneHostOptions {
    cwd?: string;
    home?: string;
    id?: string;
    commandName?: string;
    version?: string;
    locale?: string;
    nodePath?: string;
    binPath?: string;
    extraEnv?: Record<string, string>;
    config?: Record<string, unknown>;
    /** Ceiling for one `--version`, milliseconds. Default 5 s. Not a config-file field. */
    versionReadMs?: number;
}
/** The directory whose `promptobus.json` is the root above `start`, or null: 02-host § Standalone host. */
export declare function findHostRoot(start: string): string | null;
export declare function pathOutsideRoot(root: string, candidate: string): boolean;
export declare function createStandaloneHost(options?: StandaloneHostOptions): PromptobusHost;
