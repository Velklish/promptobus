import type { RoleRegistry } from '../registry.js';
/** One tool declaration, as `tools/list` returns it. */
export interface McpTool {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties?: Record<string, unknown>;
        required?: string[];
        /** `false` — the server refuses a key the declaration does not carry, naming it. */
        additionalProperties?: false;
    };
}
export declare function mcpTools(registry: RoleRegistry): McpTool[];
