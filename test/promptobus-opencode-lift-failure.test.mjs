import { check } from './check.mjs';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { makeSandbox } from './sandbox.mjs';
import * as store from '../lib/store.js';
import { opencodeDriver, registrySessionKey } from '../lib/driver-opencode.js';
import { pidAlive, reapHolder } from '../lib/opencode-session.js';

const SB = makeSandbox('promptobus-driver-opencode-');
const home = path.join(SB, 'bus');
process.env.PROMPTOBUS_OPENCODE_HOME = path.join(SB, 'registry');
const task = 'lift-failure-t20261013-140000';
store.createTask(home, { id: task, title: 'holder failure fixture' });
const originalFetch = globalThis.fetch;
const originalKill = process.kill;
try {
  for (const mode of ['create-reject', 'prompt-reject', 'create-500', 'prompt-500', 'persist-reject', 'success']) {
    const address = `worker:${mode}`;
    const ref = `${task}:${address}`;
    const file = store.participantSessionPath(home, task, address);
    const log = `${file}.holder.log`;
    const entry = path.join(process.env.PROMPTOBUS_OPENCODE_HOME, 'sessions', `${registrySessionKey(ref)}.json`);
    const failure = new Error(`connection rejected at ${mode}`);
    let pid = null;
    let terminations = 0;
    const calls = [];
    process.kill = (target, signal) => {
      if (signal === 'SIGTERM' && target === -pid) terminations += 1;
      return originalKill(target, signal);
    };
    globalThis.fetch = async (url, options) => {
      pid = JSON.parse(readFileSync(file, 'utf8')).holderPid;
      const route = `${options.method} ${new URL(url).pathname}`;
      calls.push(route);
      if (route === 'POST /api/session' && mode === 'create-reject') throw failure;
      if (route.endsWith('/prompt') && mode === 'prompt-reject') throw failure;
      const status = (route === 'POST /api/session' && mode === 'create-500')
        || (route.endsWith('/prompt') && mode === 'prompt-500') ? 500 : 200;
      return new Response(JSON.stringify({ data: { id: 'fixture-session' } }), { status });
    };
    let result;
    let error;
    try {
      result = await opencodeDriver.spawn({
        argv: ['-e', 'console.log("server listening on http://127.0.0.1:12345"); setInterval(() => {}, 1000);'],
        cwd: SB, env: { PATH: process.env.PATH }, prompt: 'fixture', holder: { password: 'fixture' },
      }, {
        tool: { bin: process.execPath }, home, task, address, ref,
        persist: () => { if (mode === 'persist-reject') throw failure; },
      });
    } catch (caught) { error = caught; }
    if (mode === 'success') {
      check(': successful OpenCode lift registers the holder and sends one first prompt',
        result?.session === 'fixture-session' && pidAlive(pid) && existsSync(entry)
        && calls.filter((call) => call.endsWith('/prompt')).length === 1 && terminations === 0,
        JSON.stringify({ result, calls, terminations }));
      await opencodeDriver.stop(ref);
    } else {
      check(`: OpenCode ${mode} preserves the original lift failure`,
        mode.endsWith('reject') ? error === failure : /answered 500/.test(error?.message ?? ''),
        JSON.stringify({ error: error?.message, expected: failure.message }));
      check(`: OpenCode ${mode} reaps once and removes holder record log and registry`,
        !pidAlive(pid) && terminations === 1 && [file, log, entry].every((at) => !existsSync(at)),
        JSON.stringify({ pid, alive: pidAlive(pid), terminations, files: [file, log, entry].map(existsSync) }));
    }
    await reapHolder(pid);
    for (const at of [file, log, entry]) {
      if (existsSync(at)) rmSync(at, { force: true });
    }
  }
} finally {
  globalThis.fetch = originalFetch;
  process.kill = originalKill;
}
