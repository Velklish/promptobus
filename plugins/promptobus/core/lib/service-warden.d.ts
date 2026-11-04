import type { ParticipantV1, PromptobusHost, SessionSnapshot } from '../dist/index.js';
import type { TaskWardenResult } from './warden.js';
import type { RecordVersion, ServicePaths } from './service-state.js';
import type { HarnessContext } from './harness-home.js';
export interface WardenDiagnostics {
    tasks: {
        task: string;
        state: 'starting' | 'running' | 'stopping' | 'legacy-busy';
        pid: number;
    }[];
    observations: number;
}
export declare class ServiceWarden {
    private readonly paths;
    readonly ready: Promise<void>;
    private readonly worker;
    private readonly exit;
    private readonly file;
    private readonly demands;
    private readonly tasks;
    private readonly legacy;
    private readonly observations;
    private sequence;
    private closing;
    private closingPromise;
    private workerExited;
    private failure;
    private readonly failed;
    constructor(paths: ServicePaths, host: PromptobusHost, context: HarnessContext, env: NodeJS.ProcessEnv, fatal: (error: Error) => void);
    private send;
    private persist;
    private setDemand;
    private start;
    recover(): Promise<void>;
    ensure(task: string): {
        state: 'inactive';
    } | {
        state: "running" | "stopping";
    } | {
        state: 'starting';
    };
    abort(task: string): Promise<TaskWardenResult>;
    observe(participants: ParticipantV1[], records?: RecordVersion[]): Promise<SessionSnapshot>;
    active(): boolean;
    diagnostics(): WardenDiagnostics;
    hasExited(): boolean;
    close(): Promise<void>;
    private closeWorker;
}
