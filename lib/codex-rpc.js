import { EventEmitter } from 'node:events';

// Line-delimited JSON-RPC 2.0 over one stream. This is how `codex app-server --stdio`
// talks (spike: one object per line, no Content-Length). One client per process: a
// request pool keyed by `id`, server notifications as events, server-to-client requests
// (approvals) on a separate handler. Without a reply to such a request the turn stalls
// forever: Codex auto-reviewer is not a contract, and a request may arrive at any time.

let nextId = 1;

export function CodexRpc(io, { onLog = null } = {}) {
  const incoming = io.stdout ?? io;
  const outgoing = io.stdin ?? io;
  const pending = new Map();
  const events = new EventEmitter();
  events.setMaxListeners(0);
  let buf = '';
  let serverHandler = null;
  let closed = false;

  const write = (obj) => {
    if (closed) throw new Error('JSON-RPC stream is closed');
    onLog?.('out', obj);
    outgoing.write(`${JSON.stringify(obj)}\n`);
  };

  const dispatch = (msg) => {
    onLog?.('in', msg);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
      return;
    }
    if (msg.id !== undefined && msg.method) {
      Promise.resolve(serverHandler ? serverHandler(msg) : defaultDeny(msg))
        .then((result) => {
          if (result && result.__error) write({ jsonrpc: '2.0', id: msg.id, error: result.__error });
          else write({ jsonrpc: '2.0', id: msg.id, result: result ?? {} });
        })
        .catch((err) => {
          write({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: String(err?.message ?? err) },
          });
        });
      return;
    }
    if (msg.method) events.emit('notification', msg);
  };

  const onData = (chunk) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        dispatch(JSON.parse(line));
      } catch {
        onLog?.('raw', line);
      }
    }
  };

  incoming.setEncoding?.('utf8');
  incoming.on('data', onData);

  return {
    request(method, params = {}, timeoutMs = 60_000) {
      const id = nextId++;
      const req = { jsonrpc: '2.0', id, method, params };
      return new Promise((resolve, reject) => {
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
    notify(method, params = {}) {
      write({ jsonrpc: '2.0', method, params });
    },
    onNotification(fn) {
      events.on('notification', fn);
      return () => events.off('notification', fn);
    },
    onServerRequest(fn) {
      serverHandler = fn;
    },
    waitNotification(method, pred = () => true, timeoutMs = 30_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error(`no notification ${method} in ${timeoutMs} ms`));
        }, timeoutMs);
        const off = this.onNotification((msg) => {
          if (msg.method !== method) return;
          if (!pred(msg.params ?? {}, msg)) return;
          clearTimeout(timer);
          off();
          resolve(msg);
        });
      });
    },
    close() {
      closed = true;
      for (const [id, { resolve }] of pending) {
        pending.delete(id);
        resolve({ error: { code: -32000, message: 'stream is closed' } });
      }
    },
  };
}

function defaultDeny(msg) {
  return {
    __error: { code: -32601, message: `no handler for server request ${msg.method}` },
  };
}
