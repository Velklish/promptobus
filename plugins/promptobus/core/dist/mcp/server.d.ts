import type { DeclaredStep, RoleRegistry } from '../registry.js';
import type { PromptobusService } from './service.js';
import type { DecorateParticipant } from './render.js';
/** Who this process is on the bus. The adapter computes it: environment and workspace root are its. */
export interface McpIdentity {
    /** The mailbox this process reads: the declared role, `orchestrator` when none is declared. */
    role: string;
    /** The declared role alone, `null` when none: a hint about `declaredTask` the sender record must agree with. */
    hint?: string | null;
    home: string;
    declaredTask: string | null;
    session: string | null;
    /** Why `session` is `null`, in the resolver's words. */
    why?: string | null;
}
/** Server name and version in the `initialize` reply. Both are consumer facts. */
export interface McpServerInfo {
    name: string;
    version: string;
}
/** A participant entered a task: handing over the contact point and lifting a listener is the adapter's job. */
export interface McpJoin {
    home: string;
    task: string;
    address: string;
    gated: boolean;
    /** Whether this call's `right` may take the contact point — false for `no-identity` and `foreign`. */
    mayRegister: boolean;
}
/** Who stall diagnosis is asked about. */
export interface McpStalls {
    home: string;
    task: string;
    address: string;
}
/** Event the consumer gives text for. The JSON-RPC code stays with the package. */
export type McpEvent = {
    kind: 'parse';
} | {
    kind: 'unknown-method';
    method: string;
} | {
    kind: 'unknown-tool';
    tool: string;
} | {
    kind: 'tool-failed';
    cause: Error;
};
/** Line stream the server reads requests from. */
export interface McpInput {
    setEncoding(encoding: string): unknown;
    [Symbol.asyncIterator](): AsyncIterator<string>;
}
/** Stream the server writes replies to. */
export interface McpOutput {
    write(chunk: string): unknown;
}
export interface McpOptions {
    /** Store operations. Passed explicitly — the factory does not supply a default of its own. */
    service: PromptobusService;
    /** The host's registry value for the addresses this server advertises. */
    registry?: RoleRegistry;
    /** Protocol versions the server serves. The first is its latest. */
    protocolVersions: string[];
    /** Process identity. A callback, not a value: only the adapter reads the environment. */
    resolveIdentity: () => McpIdentity;
    /** Server name and version. */
    serverInfo: () => McpServerInfo;
    /** A participant entered a task — before any tool work. `false` says the gate refused the handover. */
    onJoin: (join: McpJoin) => unknown;
    /** Participant lines the store does not know: repository, worktree, background session. */
    decorateParticipant: DecorateParticipant;
    /** The host's pipeline steps in order, for the `task` reply; absent — the default pipeline. */
    pipeline?: () => readonly DeclaredStep[];
    /** Stall routes in the `mailbox` reply; `null` — nothing to say. */
    stalls: (ctx: McpStalls) => string | null;
    /** Human text of the event. */
    errorText: (event: McpEvent) => string;
}
export interface JsonRpcMessage {
    id?: number | string | null;
    method?: string;
    params?: Record<string, unknown>;
}
export declare function negotiateProtocol(versions: string[], asked: unknown): string;
export declare function createMcpServer(options: McpOptions): {
    serve: (streams: {
        input: McpInput;
        output: McpOutput;
    }) => Promise<void>;
    connect: () => {
        handle: (message: JsonRpcMessage) => object | null;
    };
};
