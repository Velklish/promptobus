import type { PromptobusHost } from '../dist/index.js';
import type { GuardInput } from './guard.js';
import type { ServiceHostFactory } from './service.js';
interface CommandOutput {
    write?(chunk: string): unknown;
}
type CliHost = Pick<PromptobusHost, 'kind' | 'commandName' | 'version'>;
interface RunOptions {
    host?: CliHost | null;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: GuardInput;
    output?: CommandOutput;
    createHost?: ServiceHostFactory;
}
export declare const COMMANDS: readonly string[];
export declare function helpText(host: Pick<PromptobusHost, 'commandName'>): string;
export declare function runPromptobus(argv: readonly string[] | null | undefined, { host: suppliedHost, cwd, env, input, output, createHost }?: RunOptions): Promise<number>;
export {};
