import { Server } from 'node:net';

const params = new URL(import.meta.url).searchParams;
const code = params.get('code');
const syscall = params.get('syscall') ?? 'listen';
const site = Number(params.get('site') ?? 0);
const listen = Server.prototype.listen;
let calls = 0;

Server.prototype.listen = function (...args) {
  const options = args[0];
  const tcp = options === 0 && args[1] === '127.0.0.1'
    || options?.port === 0 && options?.host === '127.0.0.1';
  if (tcp && (++calls === site || site === 0)) {
    if (code === 'ERR_SOCKET_BAD_PORT') return listen.call(this, { port: -1, host: '127.0.0.1' });
    process.nextTick(() => this.emit('error', Object.assign(new Error(`injected ${syscall} ${code}`), {
      code, syscall,
    })));
    return this;
  }
  return listen.apply(this, args);
};
