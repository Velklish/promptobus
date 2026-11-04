import { EventEmitter } from 'node:events';
interface RpcStreams {
    stdout: NodeJS.ReadableStream;
    stdin: NodeJS.WritableStream;
}
type RpcIo = RpcStreams | (NodeJS.ReadWriteStream & Partial<RpcStreams>);
type ServerHandler = (message: unknown) => unknown;
interface RpcOptions {
    onLog?: ((direction: 'in' | 'out' | 'orphan' | 'raw', value: unknown) => void) | null;
}
export declare function CodexRpc(io: RpcIo, { onLog }?: RpcOptions): {
    request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
    notify(method: string, params?: unknown): void;
    onNotification(fn: (message: unknown) => void): () => EventEmitter<[never]>;
    onServerRequest(fn: ServerHandler): void;
    waitNotification(method: string, pred?: (params: unknown, message: unknown) => boolean, timeoutMs?: number): Promise<unknown>;
    close(): void;
};
export {};
