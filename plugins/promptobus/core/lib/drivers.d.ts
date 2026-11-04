import type { ProcessIdentity, RecordVersion } from './service-state.js';
import { CLAUDE_SKILLS_REL, REPORTER_DENY } from './driver-claude.js';
import { CURSOR_SKILLS_REL } from './driver-cursor.js';
import { CODEX, CODEX_SKILLS_REL, codexDriver } from './driver-codex.js';
import type { LibDriver, LibLaunchPlan, LibMcpServer } from './driver-runtime.js';
import type { ActivationTarget, ActivateResult, ParticipantV1, PromptobusHost, StalledParticipant } from '../dist/index.js';
interface IdentityScope {
    home: string;
    task: string | null;
    address: string | null;
}
export type CodexDriver = typeof codexDriver;
interface IdentityCandidate {
    harness: string;
    variable: string | null;
    id: string;
    record?: string;
}
/** `fallback` is the harness for a record that names none at all — a pre-task participant
 * or the task owner. A non-empty unknown name is not saved by it: it refuses. */
export declare const REGISTRY: import("./driver-runtime.js").LibRegistry;
export { REPORTER_DENY };
export declare function replaceManagedMcpServers(driver: LibDriver, launch: LibLaunchPlan, servers: Record<string, LibMcpServer>): void;
export interface ManagedNativeStart {
    harness: 'claude' | 'cursor' | 'codex' | 'opencode';
    home: string;
    task: string;
    address: string;
    ref: string;
    record: string;
    launchId: string;
    nativeId: string;
    deferTaskBinding?: boolean;
    transcript?: unknown;
    nativeProcessEvidence?: {
        version: RecordVersion;
        process: ProcessIdentity;
        executable: RecordVersion;
    };
    nativeProof?: {
        version: RecordVersion;
        binding: {
            harness: 'claude';
            nativeStore: string;
            nativeId: string;
            process: ProcessIdentity;
        };
        evidence: {
            kind: 'native-session-start';
            source: 'startup';
            nativeStore: string;
            nativeId: string;
            process: ProcessIdentity;
            transcript: string;
            executable: RecordVersion;
        };
    };
}
export declare function bindManagedNativeStart(input: ManagedNativeStart): {
    published: boolean;
};
/** Availability adapter of a harness — the one door from the routing preflight to drivers.
 * No adapter means `unknown` / `probe_failed`, which the resolver penalises, never blocks. */
export declare function adapterOf(harness: string | null | undefined): import("./model-routing/adapter-common.js").RoutingAdapter | {
    probe: () => Omit<import("./model-routing/cache.js").SnapshotEntry, "models"> & {
        models?: import("./model-routing/adapter-common.js").AdapterModel[];
    };
};
/** The adapter a driver gets when it declares none: `unknown` / `probe_failed`, never a
 * throw. Exported so the suite pins this stand-in rather than whichever driver lacks one. */
export declare function standInAdapter(driver: Pick<LibDriver, 'id'>): {
    probe: () => Omit<import("./model-routing/cache.js").SnapshotEntry, "models"> & {
        models?: import("./model-routing/adapter-common.js").AdapterModel[];
    };
};
/** Snapshot of participant sessions — input to the state machine. Taken once per heartbeat:
 * a driver reply is an external harness poll, and the loop runs once a second. */
export declare function snapshotOf(participants: ParticipantV1[] | null | undefined): import("../dist/driver.js").SessionSnapshot;
/** Driver of a participant record, by the harness that record declared. A former-CLI record
 * carries no field and gets `fallback`; a non-empty unknown name refuses. */
export declare function driverOf(participant: ParticipantV1 | null | undefined): LibDriver;
/** Lift driver: the harness a command uses to spawn. No name — the map `fallback`; a name —
 * the one a person gave with `--harness`. An unknown one refuses before any write to disk. */
export declare function liftDriver(harness?: string | null): LibDriver;
/** Driver of a record; on a FOREIGN harness — the lift driver. A door for where refusing
 * costs more than imprecision: it gives WORDS, and everything that acts uses `driverOf`. */
export declare function driverOrLift(participant: ParticipantV1 | null | undefined): LibDriver;
/** Driver by the harness name from a stall report. No field means `fallback`: the report is
 * built from a participant record, and a former-CLI record has no harness. */
export declare function driverByHarness(harness: typeof CODEX): typeof codexDriver;
export declare function driverByHarness(harness: string | null | undefined): LibDriver;
/** Harnesses eligible to route a lift for the role — approver omits harnesses without `approverLift`. */
export declare function eligibleHarnessesForRole(host: Pick<PromptobusHost, 'declaredTools'>, role: string): string[];
/** @deprecated use eligibleHarnessesForRole — name kept for callers that mean the eligible set */
export declare const declaredHarnessesForRole: typeof eligibleHarnessesForRole;
/** Refusal when a declared harness cannot lift the role — explicit `--harness` and routing diagnostics. */
export declare function roleHarnessRefusal(driver: LibDriver, role: string): string | null;
/** Forget cached session lists on every driver, after a lift or a stop: the next reader
 * would otherwise see a closed session as live. A driver holding no registry has nothing. */
export declare function forgetSessions(): void;
/** Registry with substituted delivery — a suite seam. Another registry rather than a
 * module variable: the suite runs loops in parallel, and a shared one would mix them. */
export declare function knockRegistry(knock: ((endpoint: ActivationTarget['endpoint'], body: string) => ActivateResult | Promise<ActivateResult>) | null | undefined): import("./driver-runtime.js").LibRegistry;
/** Stall route — from the driver of the participant whose state was just read; the shared
 * line text stays with [stalls.js](stalls.js), so all three surfaces advise the same thing. */
export declare function stallRouteOf(stalled: StalledParticipant, task: string): string;
/** Every declared harness identity the environment carries, with the driver that declared
 * the variable. More than one answer is not a tie to break — 02-host.md § Session identity. */
export declare function identityCandidates(env?: NodeJS.ProcessEnv): IdentityCandidate[];
export declare function actorIdentityVariables(): string[];
/** Session records named by an MCP child, after the record proves the same bus identity: a
 * readable record is not enough — another task or address is another participant. */
export declare function mcpIdentityCandidates(env?: NodeJS.ProcessEnv, scope?: IdentityScope | null): IdentityCandidate[];
/** Who the session running this process is. `null` is an answer and not a silence, and
 * `reason` names which one — 02-host.md § Session identity. */
export declare function resolveSessionIdentity(env?: NodeJS.ProcessEnv, scope?: IdentityScope | null): {
    harness?: string | undefined;
    variable?: string | null | undefined;
    record?: string;
    id: string;
    candidates: IdentityCandidate[];
    reason: string;
    why: null;
} | {
    id: null;
    harness: null;
    variable: null;
    candidates: IdentityCandidate[];
    reason: string;
    why: string;
};
export { CLAUDE_SKILLS_REL, CURSOR_SKILLS_REL, CODEX_SKILLS_REL };
