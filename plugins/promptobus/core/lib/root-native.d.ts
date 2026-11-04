import type { ProcessIdentity } from './service-state.js';
export declare function observeCodexAppServer(start?: number): ProcessIdentity;
export interface CodexRootTranscript {
    nativeStore: string;
    transcript: string;
    nativeThreadId: string;
}
declare function readCodexTranscript(input: CodexRootTranscript): {
    nativeThreadId: string;
    nativeStore: string;
    transcript: string;
    source: string;
};
export declare function readCodexRootTranscript(input: CodexRootTranscript): ReturnType<typeof readCodexTranscript> & {
    source: 'cli' | 'exec' | 'vscode';
};
export {};
