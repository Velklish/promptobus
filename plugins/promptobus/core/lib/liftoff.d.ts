import type { HostToolBin, RoleRegistry } from '../dist/index.js';
import type { LibLaunchPlan } from './driver-runtime.js';
import type { LegacyLaunchBinding } from './native-lifecycle.js';
export interface BgSession {
    id?: string;
    sessionId?: string;
    name?: string;
    pid?: number;
    waitingFor?: string | null;
    state?: string | null;
    status?: string | null;
}
export type RawBgSession = Partial<Record<keyof BgSession, unknown>>;
export interface AwaitSeen {
    state: 'alive' | 'dead' | 'unknown';
    session: RawBgSession | null;
    ghost?: RawBgSession | null;
}
export interface LaunchResult {
    output: string;
    session: string | null;
    seen: AwaitSeen;
}
export interface AwaitSessionOptions {
    tries?: number;
    delayMs?: number;
    sessions?: () => unknown[] | null;
    launchId?: string | null;
}
interface LiftoffInput {
    tool: Pick<HostToolBin, 'bin'>;
    argv: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    name: string;
    role: string;
    registry?: RoleRegistry;
    launchFailNote?: string;
    deadNote?: string;
    unboundNote?: string;
    persist: (session: string | null, state: AwaitSeen['state'], full: string | null) => unknown;
    beforeStart?: () => Promise<void>;
    afterBind?: (id: string) => Promise<void>;
    awaitOptions?: AwaitSessionOptions;
    sayLimit?: ((output: string) => string | null) | null;
    home?: string | null;
    task?: string | null;
    address?: string | null;
    preboundSessionId?: string | null;
    preboundSessionRecord?: string | null;
    noun?: string | null;
    requireFullSession?: boolean;
    requireLaunchMatch?: boolean;
    launch?: LibLaunchPlan;
    expectedBinding?: LegacyLaunchBinding;
}
export { bindBeforeLaunch } from './driver-common.js';
export declare function liftoffParticipant({ tool, argv, cwd, env, name, role, registry, launchFailNote, deadNote, unboundNote, persist, awaitOptions, sayLimit, home, task, address, preboundSessionId, preboundSessionRecord, noun, requireFullSession, requireLaunchMatch, beforeStart, afterBind, launch, expectedBinding, }: LiftoffInput): Promise<LaunchResult>;
export declare function sayLiftoff({ name, seen, session, output }: {
    name: string;
    output: string;
    session: string | null;
    seen: object;
}): void;
export declare function parseSessionId(output: unknown): string | null;
export declare function spawnedSessionId(seen: AwaitSeen | null | undefined, output: unknown): {} | null;
export declare function sessionIdFull(seen: AwaitSeen | null | undefined): string | null;
export declare function awaitSession(name: string, { tries, delayMs, sessions, launchId }?: AwaitSessionOptions): Promise<AwaitSeen>;
export declare function resetBgSessionsCache(): void;
export declare function bgSessions({ fresh }?: {
    fresh?: boolean | undefined;
}): unknown[] | null;
export declare function readBgSessions({ fresh }?: {
    fresh?: boolean | undefined;
}): {
    list: unknown[] | null;
    missing: string | null;
};
export declare function runClaude(args: readonly string[]): {
    r: null;
    missing: string;
} | {
    r: import("./exec.js").AsyncRunResult<string> | import("child_process").SpawnSyncReturns<string>;
    missing: null;
};
export declare function findSession(sessions: readonly unknown[] | null | undefined, name: string, launchId?: string | null): RawBgSession | null;
export declare function sessionLiveness(session: unknown, sessions?: readonly unknown[] | null): "alive" | "dead" | "stale";
