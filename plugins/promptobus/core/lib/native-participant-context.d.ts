import type { PreparedHostParticipantContextSelection, HostTaskContextDeclaration, Driver, LaunchFile } from '../dist/index.js';
import type { ParticipantContextHost, ParticipantContextCeiling } from './participant-context.js';
type Selection = PreparedHostParticipantContextSelection | null | undefined;
interface NativeContextOptions {
    contextDeclaration?: unknown;
    contextPurpose?: string;
}
interface PreparedContextInput {
    root: string;
    role: string;
    taskId: string;
    options?: NativeContextOptions;
    participant?: {
        metadata?: Record<string, unknown> | null;
    } | null;
    preparedSelection?: ParticipantContextCeiling | null;
}
export declare const CONTEXT_FLAGS: {
    readonly 'context-purpose': {
        readonly type: 'string';
    };
    readonly 'context-file': {
        readonly type: 'string';
    };
};
export declare function contextCliOptions(values: {
    'context-purpose'?: string;
    'context-file'?: string;
}, cwd?: string): {
    contextPurpose?: string | undefined;
    contextDeclaration?: HostTaskContextDeclaration | undefined;
};
export declare function prepareNativeContext(host: ParticipantContextHost, { root, role, taskId, options, participant, preparedSelection }: PreparedContextInput): PreparedHostParticipantContextSelection | null;
export declare function assertNativeContextDriver(selection: Selection, driver: Pick<Driver, 'id' | 'options'>): void;
export declare function nativeContextMetadata(selection: Selection): {};
export declare function contextRules(selection: Selection, legacyRules: () => string[], from?: string | null, to?: string | null, verify?: boolean): string[];
export declare function nativeContextPrompt(selection: Selection): string;
export declare function assertNativeContainer(directory: string, allowed: string[]): void;
export declare function assertNativePluginManifest(plugin: string, selection: PreparedHostParticipantContextSelection, manifestText: string): void;
export declare function selectedNativePrompt(selection: Selection, prompt: string, directory: string): {
    argument: string;
    files: LaunchFile[];
    addDirs: string[];
};
export declare function selectedNativeFiles(selection: Selection, destination: string | null): LaunchFile[];
export declare function assertSelectedNativeFiles(files: LaunchFile[]): void;
export declare function writeSelectedNativeFile(file: LaunchFile): boolean;
export declare function installSelectedNativeFiles(files: LaunchFile[]): void;
export {};
