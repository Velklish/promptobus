import type { ProcessIdentity } from './service-state.js';
export declare function processExecutable(identity: ProcessIdentity): Promise<string | null>;
export declare function processParent(pid: number): Promise<number | null>;
export declare function observeRootProcess(pid: number): Promise<ProcessIdentity | null>;
export declare function isSupportedPosixShell(identity: ProcessIdentity): Promise<boolean>;
export declare function requireNativeHookAncestor(native: ProcessIdentity, start?: number): Promise<void>;
export declare function processHasOpenFile(identity: ProcessIdentity, file: string): Promise<boolean>;
