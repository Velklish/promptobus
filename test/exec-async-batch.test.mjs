import { check, skip } from './check.mjs';
// Force Windows planning only; the spawn seam records attempts, never starts a binary.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeSandbox } from './sandbox.mjs';

const SB = makeSandbox('promptobus-promptobus-async-batch-');
const bin = path.join(SB, 'bin');
mkdirSync(bin);
for (const name of ['agent.cmd', 'agent.bat', 'agent.exe']) writeFileSync(path.join(bin, name), '');
const source = readFileSync(new URL('../lib/exec.js', import.meta.url), 'utf8');
const fixture = source.replaceAll('process.platform', "'win32'")
  .replace("import { spawn } from 'node:child_process';", `import { EventEmitter } from 'node:events';
    export const launches = [];
    const spawn = (file, args) => {
      launches.push({ file, args });
      const child = new EventEmitter();
      child.pid = 123; child.kill = () => {};
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    };`);
const file = path.join(SB, 'exec.mjs');
writeFileSync(file, fixture);
const exec = await import(pathToFileURL(file).href);
const env = { PATH: bin, PATHEXT: '.EXE;.CMD;.BAT' };
for (const extension of ['cmd', 'bat']) {
  const before = exec.launches.length;
  const result = await exec.runAsync(path.join(bin, `agent.${extension}`), ['persist', 'stop', 'owned'], { env });
  check(`async batch: .${extension} refuses before the wrapper can start descendants`,
    result.error?.code === 'ERR_ASYNC_BATCH' && result.pid === 0 && result.status === null
    && result.stdout === '' && exec.launches.length === before
    && result.error.message.includes('native binary (.exe)'), JSON.stringify({ result, launches: exec.launches }));
  const syncPlan = exec.planRun(path.join(bin, `agent.${extension}`), ['persist', 'stop', 'owned'], { platform: 'win32', env });
  check(`async batch: synchronous .${extension} planning retains its cmd.exe route`,
    syncPlan.ok && syncPlan.verbatim && /cmd\.exe$/i.test(syncPlan.file), JSON.stringify(syncPlan));
}
const native = await exec.runAsync(path.join(bin, 'agent.exe'), [], { env });
check('async batch: a native Windows executable still reaches the asynchronous spawn boundary',
  native.error === null && native.status === 0 && exec.launches.at(-1)?.file === path.join(bin, 'agent.exe'), JSON.stringify(native));

// The production caller must keep its owned-session fallback when execution is refused.
const cursorSource = readFileSync(new URL('../lib/cursor-persist.js', import.meta.url), 'utf8');
const stopSource = cursorSource.slice(cursorSource.indexOf('export async function stopSession')).replace('export ', '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let present = true;
const calls = [];
const dependencies = {
  process, STOP_TIMEOUT_MS: 100, STOP_STEP_MS: 1, CURSOR_TMUX_SERVER: 'fixture',
  sessionMarker: () => 'owned', findSession: () => present ? { panePid: 123 } : null,
  treeOf: () => [124], reapOrphans: () => [], killPids: (pids) => { calls.push(['kill kids', pids]); return pids; },
  tmux: (args) => { calls.push(['tmux', args]); present = false; }, settle: async () => {},
  runAsync: (...args) => exec.runAsync(...args),
};
const stopSession = await new AsyncFunction(...Object.keys(dependencies), `${stopSource}; return stopSession;`)(...Object.values(dependencies));
const launchesBeforeStop = exec.launches.length;
const stopped = await stopSession({ sessionName: 'owned', cwd: SB }, { bin: path.join(bin, 'agent.cmd'), env, timeoutMs: 0 });
check('async batch: persist stop preserves the refusal diagnostic and stops the owned pane through its fallback',
  stopped.stopped === true && stopped.said?.includes('cancellable execution of a Windows command file is unsupported')
  && exec.launches.length === launchesBeforeStop
  && JSON.stringify(calls) === JSON.stringify([['tmux', ['kill-session', '-t', 'owned']], ['kill kids', [124]]]),
  JSON.stringify({ stopped, calls, launches: exec.launches }));

if (process.platform === 'win32') {
  const childFile = path.join(SB, 'descendant.cjs'), pidFile = path.join(SB, 'descendant.pid');
  const wrapper = path.join(bin, 'descendant.cmd');
  writeFileSync(childFile, `require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);`);
  writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${childFile}" "${pidFile}"\r\n`);
  const realExec = await import('../lib/exec.js');
  const result = await realExec.runAsync(wrapper, [], { timeoutMs: 2000 });
  try {
    check('async batch: a real Windows wrapper is refused before its Node descendant starts',
      result.error?.code === 'ERR_ASYNC_BATCH' && !existsSync(pidFile), JSON.stringify(result));
  } finally {
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already ended */ }
    }
  }
} else {
  skip('async batch: a real Windows wrapper is refused before its Node descendant starts', 'Windows runtime is unavailable on this platform; planning and caller checks run above');
}

check('async batch docs: refusal and unchanged synchronous execution are explicit',
  readFileSync(new URL('../docs/reference/02-host.md', import.meta.url), 'utf8')
    .includes('`runAsync` refuses Windows `.cmd` and `.bat` commands with `ERR_ASYNC_BATCH` before spawning a wrapper.')
  && readFileSync(new URL('../README.md', import.meta.url), 'utf8').includes('Synchronous batch execution is unchanged.'));
