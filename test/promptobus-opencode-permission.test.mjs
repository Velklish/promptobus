import { check } from './check.mjs';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSandbox } from './sandbox.mjs';
import * as store from '../lib/store.js';
import {
  PERMISSION_POLL_MS, coveredExternalDirectory, declaredRoots, opencodeDriver, pendingPermissionNote,
  prepare, remainingPermissionAsks, resourceInRoots, viewOf,
} from '../lib/driver-opencode.js';
import {
  HOLDER_HTTP_TIMEOUT_MS, HOLDER_REQUEST_SOURCE, holderRequestSync, parsePermissionList, pidAlive, reapHolder,
} from '../lib/opencode-session.js';
import { WARDEN_BEAT_SEC } from '../dist/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SB = makeSandbox('promptobus-driver-opencode-');
const home = path.join(SB, 'bus');
process.env.PROMPTOBUS_OPENCODE_HOME = path.join(SB, 'registry');
const task = 'permission-t20261028-060000';
store.createTask(home, { id: task, title: 'permission fixture' });
const outside = path.join(SB, 'outside');
const sibling = path.resolve(SB, '..', 'opencode-permission-sibling');

check(': declared roots are the absolute session directory and addDirs',
  declaredRoots(SB, [outside, 'relative', outside]).join('|') === `${path.resolve(SB)}|${path.resolve(outside)}`,
  declaredRoots(SB, [outside, 'relative']).join('|'));

check(': a filesystem root covers no other directory',
  resourceInRoots('/etc/*', ['/']) === false
  && declaredRoots('/', ['/']).length === 0
  && declaredRoots(SB, ['/']).join('|') === path.resolve(SB),
  declaredRoots('/', ['/']).join('|'));

check(': a directory pattern is inside its root and a neighbouring prefix is not',
  resourceInRoots(`${SB}/*`, [SB]) === true
  && resourceInRoots(`${path.join(SB, 'nested')}/**`, [SB]) === true
  && resourceInRoots(`${SB}-extra/*`, [SB]) === false
  && resourceInRoots('*', [SB]) === false
  && resourceInRoots(`${path.dirname(SB)}/*`, [SB]) === false,
  'root match');

check(': an external_directory resource inside a declared root is covered',
  coveredExternalDirectory({ action: 'external_directory', resource: `${outside}/*` }, [SB, outside]) === true
  && coveredExternalDirectory({
    action: 'external_directory', resource: `${outside}/*`, resources: [`${sibling}/*`],
  }, [outside]) === false
  && coveredExternalDirectory({ action: 'bash', resource: `${outside}/*` }, [outside]) === false
  && coveredExternalDirectory({ action: 'external_directory' }, [outside]) === false,
  'coverage');

const busy = [{ id: 'ses_x', time: {} }];
const ask = { id: 'per_outside', action: 'external_directory', resource: `${outside}/*` };
const pending = viewOf({ sessionId: 'ses_x' }, busy, [ask]);
check(': a pending ask is not reported as a running turn',
  pending.busy === true && pending.stall === null
  && pending.note.startsWith('permission ask pending:')
  && pending.note.includes('external_directory') && pending.note.includes(`${outside}/*`)
  && pending.note !== 'turn running',
  pending.note);
check(': a busy session with no ask is still a running turn',
  viewOf({ sessionId: 'ses_x' }, busy).note === 'turn running'
  && viewOf({ sessionId: 'ses_x' }, busy, []).note === 'turn running'
  && viewOf({ sessionId: 'ses_x' }, [{ id: 'ses_x', time: { idle: 1 } }]).note === 'idle',
  'model call');
check(': an unreadable permission list is not a running turn',
  viewOf({ sessionId: 'ses_x' }, busy, null).note === 'permission list unreadable',
  viewOf({ sessionId: 'ses_x' }, busy, null).note);
check(': a message list is not a permission list',
  parsePermissionList([{ type: 'idle', outcome: 'succeeded' }]) === null
  && parsePermissionList({ data: [] })?.length === 0
  && pendingPermissionNote([ask]).includes('external_directory'),
  'parse');

const drivers = readFileSync(path.join(ROOT, 'docs', 'reference', '05-drivers.md'), 'utf8');
const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const changelog = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
check(': the OpenCode reference names the permission poll and drops the unanswered stall',
  drivers.includes(`for ${PERMISSION_POLL_MS / 1000} seconds`)
  && drivers.includes('permission ask pending')
  && drivers.includes('promptobus-opencode-permission.test.mjs')
  && drivers.includes('filesystem root')
  && drivers.includes(`WARDEN_BEAT_SEC`)
  && drivers.includes(`${WARDEN_BEAT_SEC} seconds`)
  && !drivers.includes('once a second')
  && !drivers.includes('with nobody to answer it')
  && readme.includes('permission ask pending')
  && readme.includes('filesystem root')
  && changelog.includes('permission ask pending')
  && changelog.includes('filesystem root'),
  'docs');

const rootsPlan = prepare({
  ref: 'worker:roots', mcp: { servers: {} }, prompt: 'work', model: null, permissionMode: 'auto',
  mcpConfigPath: path.join(SB, 'opencode.json'), env: {}, cwd: SB, addDirs: [outside],
});
const grantedPermission = JSON.parse(rootsPlan.files[0].text).permission?.external_directory;
check(': the lift plan grants external_directory for the session directory and addDirs',
  rootsPlan.roots.join('|') === `${path.resolve(SB)}|${path.resolve(outside)}`
  && grantedPermission?.[`${path.resolve(SB)}/*`] === 'allow'
  && grantedPermission?.[`${path.resolve(SB)}/**`] === 'allow'
  && grantedPermission?.[`${path.resolve(outside)}/*`] === 'allow'
  && grantedPermission?.[`${path.resolve(outside)}/**`] === 'allow',
  JSON.stringify(grantedPermission));
const diskPlan = prepare({
  ref: 'worker:disk', mcp: { servers: {} }, prompt: 'work', model: null, permissionMode: 'auto',
  mcpConfigPath: path.join(SB, 'disk.json'), env: {}, cwd: '/', addDirs: [outside],
});
const diskPermission = JSON.parse(diskPlan.files[0].text).permission?.external_directory ?? {};
check(': a filesystem root is omitted from the permission grant',
  diskPlan.roots.join('|') === path.resolve(outside)
  && diskPermission['/*'] === undefined
  && diskPermission['/**'] === undefined
  && diskPermission[`${path.resolve(outside)}/*`] === 'allow'
  && diskPermission[`${path.resolve(outside)}/**`] === 'allow',
  JSON.stringify({ roots: diskPlan.roots, diskPermission }));
const deniedPlan = prepare({
  ref: 'worker:roots', mcp: { servers: {} }, prompt: 'work', model: null, permissionMode: 'auto',
  mcpConfigPath: path.join(SB, 'opencode.json'), env: {}, cwd: SB, addDirs: [outside], denyTools: ['edit'],
});
const deniedPermission = JSON.parse(deniedPlan.files[0].text).permission;
check(': a deny map and the directory grant share one permission object',
  deniedPermission?.edit === 'deny' && deniedPermission?.external_directory?.[`${path.resolve(outside)}/*`] === 'allow',
  JSON.stringify(deniedPermission));

const originalFetch = globalThis.fetch;
const originalKill = process.kill;
function recordedSession(address) {
  try {
    return JSON.parse(readFileSync(store.participantSessionPath(home, task, `worker:${address}`), 'utf8')).sessionId ?? null;
  } catch {
    return null;
  }
}

async function lift(address, { asks, roots, pollMs = 0, delayed = false, cwd = SB, sticky = false }) {
  const ref = `${task}:worker:${address}`;
  let pid = null;
  let reads = 0;
  const calls = [];
  process.kill = (target, signal) => {
    if (signal === 'SIGTERM' && target === -pid) return true;
    return originalKill(target, signal);
  };
  globalThis.fetch = async (url, options) => {
    const route = `${options.method} ${new URL(url).pathname}`;
    calls.push({ route, body: options.body ? JSON.parse(options.body) : null });
    if (route === 'POST /api/session') {
      return new Response(JSON.stringify({ data: { id: 'fixture-session' } }), { status: 200 });
    }
    if (route.endsWith('/prompt')) return new Response(JSON.stringify({ data: {} }), { status: 200 });
    if (route.endsWith('/reply')) return new Response(null, { status: 204 });
    if (route.endsWith('/permission')) {
      reads += 1;
      const listed = delayed && reads < 3 ? [] : asks;
      if (!sticky && calls.some((call) => call.route.endsWith('/reply'))) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: listed }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  };
  let result;
  let error;
  try {
    result = await opencodeDriver.spawn({
      argv: ['-e', 'console.log("server listening on http://127.0.0.1:12345"); setInterval(() => {}, 1000);'],
      cwd, roots, prompt: 'read the outside file', holder: { password: 'fixture' }, permissionPollMs: pollMs,
    }, { tool: { bin: process.execPath }, home, task, address: `worker:${address}`, ref });
    pid = JSON.parse(readFileSync(store.participantSessionPath(home, task, `worker:${address}`), 'utf8')).holderPid;
  } catch (caught) {
    error = caught;
  }
  if (pid && pidAlive(pid)) await reapHolder(pid);
  try { await opencodeDriver.stop(ref); } catch { /* already reaped */ }
  return { result, error, calls };
}

try {
  const granted = await lift('granted', { asks: [ask], roots: [SB, outside] });
  const reply = granted.calls.find((call) => call.route.endsWith('/reply'));
  check(': a declared-root external_directory ask is replied once and the lift succeeds',
    granted.result?.session === 'fixture-session' && !granted.error
    && reply?.body?.decision === 'once'
    && granted.calls.filter((call) => call.route.endsWith('/reply')).length === 1,
    JSON.stringify({ error: granted.error?.message, reply, session: granted.result?.session }));

  const refused = await lift('refused', { asks: [{ id: 'per_no', action: 'external_directory', resource: `${sibling}/*` }], roots: [SB] });
  check(': an ask outside the declared roots fails the lift by name',
    !refused.result && /permission ask pending: external_directory/.test(refused.error?.message ?? '')
    && refused.error.message.includes(`${sibling}/*`)
    && !refused.calls.some((call) => call.route.endsWith('/reply')),
    refused.error?.message ?? 'no error');

  const late = await lift('late', {
    asks: [{ id: 'per_late', action: 'bash', resource: `${sibling}/*` }], roots: [SB], pollMs: 400, delayed: true,
  });
  check(': the permission poll sees an ask that is absent from the first reads',
    !late.result && /permission ask pending: bash/.test(late.error?.message ?? '')
    && late.calls.filter((call) => call.route.endsWith('/permission') && !call.route.endsWith('/reply')).length >= 3,
    late.error?.message ?? 'no error');

  const stuck = await lift('stuck', {
    asks: [{ id: 'per_stuck', action: 'external_directory', resource: `${outside}/*` }],
    roots: [SB, outside], sticky: true,
  });
  check(': an ask still listed after the reply fails the lift',
    !stuck.result && recordedSession('stuck') === null
    && /permission ask pending: external_directory/.test(stuck.error?.message ?? '')
    && stuck.calls.filter((call) => call.route.endsWith('/reply') && call.body?.decision === 'once').length === 1,
    JSON.stringify({ error: stuck.error?.message, session: recordedSession('stuck') }));

  const disk = await lift('disk', {
    asks: [{ id: 'per_disk', action: 'external_directory', resource: '/etc/*' }],
    roots: ['/'], cwd: '/',
  });
  check(': a lift whose only root is the filesystem root does not reply',
    !disk.result && recordedSession('disk') === null
    && /permission ask pending: external_directory/.test(disk.error?.message ?? '')
    && disk.error.message.includes('/etc/*')
    && !disk.calls.some((call) => call.route.endsWith('/reply')),
    JSON.stringify({ error: disk.error?.message, replies: disk.calls.filter((call) => call.route.endsWith('/reply')) }));
} finally {
  globalThis.fetch = originalFetch;
  process.kill = originalKill;
}

const listed = [ask];
const seen = [];
const runFn = (_cmd, _args, options) => {
  const input = JSON.parse(options.input);
  seen.push(`${input.method} ${input.path}`);
  if (input.method === 'POST') {
    listed.length = 0;
    return { status: 0, stdout: JSON.stringify({ status: 204, text: '' }) };
  }
  return { status: 0, stdout: JSON.stringify({ status: 200, text: JSON.stringify({ data: [...listed] }) }) };
};
const left = remainingPermissionAsks({
  url: 'http://127.0.0.1:9', password: 'secret', sessionId: 'ses_x', cwd: SB, roots: [SB, outside],
}, runFn);
check(': inspect replies once for a declared-root ask and drops it from the pending list',
  Array.isArray(left) && left.length === 0
  && seen.filter((call) => call.startsWith('POST ')).length === 1
  && seen.some((call) => call.includes('/permission/per_outside/reply')),
  JSON.stringify({ left, seen }));

check(': the synchronous permission fetch aborts on the async holder budget',
  HOLDER_HTTP_TIMEOUT_MS === 10_000
  && HOLDER_REQUEST_SOURCE.includes('signal: ctrl.signal')
  && HOLDER_REQUEST_SOURCE.includes(`setTimeout(() => ctrl.abort(), ${HOLDER_HTTP_TIMEOUT_MS})`),
  'abort');

const server = spawn(process.execPath, ['-e', [
  'const http = require("node:http");',
  'const server = http.createServer((req, res) => {',
  '  res.writeHead(200, { "Content-Type": "application/json" });',
  '  res.end(JSON.stringify({ data: [{ id: "per_outside", action: "external_directory", resource: "/x/*" }] }));',
  '});',
  'server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port)));',
].join('')], { stdio: ['ignore', 'pipe', 'pipe'] });
const port = await new Promise((resolve, reject) => {
  const chunks = [];
  server.stdout.on('data', (chunk) => {
    chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    if (/^\d+$/.test(text)) resolve(text);
  });
  server.once('error', reject);
  server.once('exit', (code) => reject(new Error(`permission stub exited ${code}`)));
});
try {
  const synced = holderRequestSync(`http://127.0.0.1:${port}`, 'secret', 'GET', '/api/session/ses_x/permission');
  check(': the synchronous permission read parses the holder list',
    synced?.status === 200 && synced.data?.data?.[0]?.id === 'per_outside',
    JSON.stringify(synced));
} finally {
  server.kill('SIGKILL');
}
