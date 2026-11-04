import type { PromptobusHost } from '../dist/index.js';
import type { McpOutput } from '../dist/mcp/server.js';
import type { PromptobusService } from '../dist/mcp/service.js';
import type { GuardInput } from './guard.js';
export { ADDR_MARK } from '../dist/index.js';
export declare function stallNote(home: string, task: string, addr: string, host?: PromptobusHost | null): string | null;
export declare function serviceFor(host: PromptobusHost, env?: NodeJS.ProcessEnv): PromptobusService;
export declare function busConnection(host: PromptobusHost, env: NodeJS.ProcessEnv, cwd: string): {
    handle: (message: Parameters<(message: import("../dist/mcp/server.js").JsonRpcMessage) => object | null>[0]) => object | null;
};
export declare function serve({ host, env, cwd, input, output }?: {
    host?: PromptobusHost | null;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    input?: GuardInput;
    output?: McpOutput;
}): Promise<void>;
