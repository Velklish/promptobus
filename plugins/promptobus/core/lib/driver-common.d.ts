import { requireCurrentNativeLaunch } from './native-lifecycle.js';
import type { LibLaunchPlan } from './driver-runtime.js';
export declare function revokeFailedManagedLaunch(launch: LibLaunchPlan, error: unknown, afterRevoke?: () => void | Promise<void>, revokeRegistered?: () => Promise<void>): Promise<never>;
export declare function parseVersion(value: unknown): number[] | null;
export declare function versionLess(a: unknown, b: unknown): boolean;
export declare function versionParseRefusal(name: string, value: unknown): string;
export declare function sessionEnv(dropList: readonly string[] | null | undefined, base?: NodeJS.ProcessEnv, extra?: NodeJS.ProcessEnv): {
    [x: string]: string | undefined;
};
export declare function sessionEnvFor(dropList: readonly string[] | null | undefined): (base?: NodeJS.ProcessEnv, extra?: NodeJS.ProcessEnv) => {
    [x: string]: string | undefined;
};
export declare function readRecordAt<T = Record<string, unknown>>(file: string): T | null;
export declare function sayForeignWrite(home: string, task: string, addr: string, held: string, session: string | null, what: string): void;
export declare function bindBeforeLaunch(home: string | null, task: string | null, address: string | null, binding?: Record<string, unknown>, expected?: Parameters<typeof requireCurrentNativeLaunch>[1]): () => void;
