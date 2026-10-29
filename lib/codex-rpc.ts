import { EventEmitter } from 'node:events';

interface RpcStreams { stdout: NodeJS.ReadableStream; stdin: NodeJS.WritableStream }
type RpcIo = RpcStreams | (NodeJS.ReadWriteStream & Partial<RpcStreams>);
type ServerHandler = (message: unknown) => unknown;
interface RpcOptions { onLog?: ((direction: 'in' | 'out' | 'orphan' | 'raw', value: unknown) => void) | null }

function property(value: unknown, key: string): unknown {
  // Keep the native nullish property-access failure.
  if (value == null) return (value as never)[key];
  return Reflect.get(Object(value), key);
}

// Line-delimited JSON-RPC 2.0 over one stream, the way `codex app-server --stdio` talks:
// one object per line, no Content-Length. An unanswered server request stalls the turn.

let nextId = 1;

export function CodexRpc(io: RpcIo, { onLog = null }: RpcOptions = {}) {
  const incoming = (io.stdout ?? io) as NodeJS.ReadableStream;
  const outgoing = (io.stdin ?? io) as NodeJS.WritableStream;
  const pending = new Map<unknown, { resolve: (message: unknown) => void }>();
  const events = new EventEmitter();
  events.setMaxListeners(0);
  let buf = '';
  let serverHandler: ServerHandler | null = null;
  let closed = false;

  const write = (obj: unknown) => {
    if (closed) throw new Error('JSON-RPC stream is closed');
    onLog?.('out', obj);
    outgoing.write(`${JSON.stringify(obj)}\n`);
  };

  const dispatch = (msg: unknown) => {
    onLog?.('in', msg);
    // Each direction owns its id space, so a server request may reuse an integer still
    // in `pending`: `method` present means a request, not the awaited reply.
    if (property(msg, 'method')) {
      if (property(msg, 'id') !== undefined) {
        Promise.resolve(serverHandler ? serverHandler(msg) : defaultDeny(msg))
          .then((result) => {
            if (closed) return;
            if (result && property(result, '__error')) write({ jsonrpc: '2.0', id: property(msg, 'id'), error: property(result, '__error') });
            else write({ jsonrpc: '2.0', id: property(msg, 'id'), result: result ?? {} });
          })
          .catch((err) => {
            if (closed) return;
            write({
              jsonrpc: '2.0',
              id: property(msg, 'id'),
              error: { code: -32000, message: String((err == null ? undefined : property(err, 'message')) ?? err) },
            });
          });
        return;
      }
      events.emit('notification', msg);
      return;
    }
    if (property(msg, 'id') !== undefined && pending.has(property(msg, 'id'))) {
      const { resolve } = pending.get(property(msg, 'id'))!;
      pending.delete(property(msg, 'id'));
      resolve(msg);
      return;
    }
    if (property(msg, 'id') !== undefined) onLog?.('orphan', msg);
  };

  const onData = (chunk: string | Buffer) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const message: unknown = JSON.parse(line);
        dispatch(message);
      } catch {
        onLog?.('raw', line);
      }
    }
  };

  incoming.setEncoding?.('utf8');
  incoming.on('data', onData);

  return {
    request(method: string, params: unknown = {}, timeoutMs = 60_000) {
      const id = nextId++;
      const req = { jsonrpc: '2.0', id, method, params };
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`no reply to ${method} in ${timeoutMs} ms`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          },
        });
        try {
          write(req);
        } catch (err) {
          clearTimeout(timer);
          pending.delete(id);
          reject(err);
        }
      });
    },
    notify(method: string, params: unknown = {}) {
      write({ jsonrpc: '2.0', method, params });
    },
    onNotification(fn: (message: unknown) => void) {
      events.on('notification', fn);
      return () => events.off('notification', fn);
    },
    onServerRequest(fn: ServerHandler) {
      serverHandler = fn;
    },
    waitNotification(method: string, pred: (params: unknown, message: unknown) => boolean = () => true, timeoutMs = 30_000) {
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error(`no notification ${method} in ${timeoutMs} ms`));
        }, timeoutMs);
        const off = this.onNotification((msg) => {
          if (property(msg, 'method') !== method) return;
          if (!pred(property(msg, 'params') ?? {}, msg)) return;
          clearTimeout(timer);
          off();
          resolve(msg);
        });
      });
    },
    close() {
      closed = true;
      if (buf.trim()) onLog?.('raw', buf);
      buf = '';
      for (const [id, { resolve }] of pending) {
        pending.delete(id);
        resolve({ error: { code: -32000, message: 'stream is closed' } });
      }
    },
  };
}

function defaultDeny(msg: unknown) {
  return {
    __error: { code: -32601, message: `no handler for server request ${property(msg, 'method')}` },
  };
}
