import type { PromptobusHost } from '../dist/index.js';
export declare function authorizeManagedClaudeExecution(host: PromptobusHost, event: Readonly<Record<string, unknown>>, env: NodeJS.ProcessEnv, cwd: string): Promise<void>;
export declare function authorizeManagedNativeStart(host: PromptobusHost, event: Readonly<Record<string, unknown>>, env: NodeJS.ProcessEnv, cwd: string): Promise<boolean>;
