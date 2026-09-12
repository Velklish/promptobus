// Stateless bus helpers. Workspace paths are not here — the host owns those.

import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { PROC_MAX_OUTPUT, PROC_TIMEOUT_MS, run } from './exec.js';

// Keep the established legacy import surface for callers that take process ceilings
// from util.js; the definition lives at the launch boundary in exec.js.
export { PROC_MAX_OUTPUT, PROC_MAX_OUTPUT as GIT_MAX_OUTPUT, PROC_TIMEOUT_MS };

const paintOn = (stream, code, s) => (stream.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const out = (code, s) => paintOn(process.stdout, code, s);
const err = (code, s) => paintOn(process.stderr, code, s);

export function ok(msg) { console.log(`${out(32, '✔')} ${msg}`); }
export function info(msg) { console.log(`  ${msg}`); }
export function warn(msg) { console.warn(`${err(33, '⚠')} ${msg}`); }
export function fail(msg) { console.error(`${err(31, '✖')} ${msg}`); process.exit(1); }
// Same level as fail, but without exit: diagnostics list EVERYTHING found.
export function bad(msg) { console.error(`${err(31, '✖')} ${msg}`); }

// Network wait ceiling for git, shared by fresh.js, refs.js, review.js and worktree.js:
// if they drifted, they would wait different times on the same dropped VPN (calls in
// worktree.js are local — there it guards a stuck index.lock).
export const GIT_NET_TIMEOUT_MS = 30_000;

// Git is deliberately direct rather than routed through `run`: Windows needs the
// native git executable instead of a possible `.cmd` wrapper. Every caller still
// gets the same output, wait and non-ASCII path contract.
export const gitIn = (dir, args, input) => spawnSync('git', [
  '-c', 'core.quotePath=false', '-C', dir, ...args,
], {
  encoding: 'utf8',
  maxBuffer: PROC_MAX_OUTPUT,
  timeout: GIT_NET_TIMEOUT_MS,
  ...(input === undefined ? {} : { input }),
});

// Cloning is timed separately: 30 seconds is for a query (`ls-remote`, `fetch` of one
// ref), and a clone carries whole repositories — minutes on a slow VPN are normal. A
// ceiling is required: without it `spawnSync` waits forever, and `sync` without VPN
// stands silent forever.
export const GIT_CLONE_TIMEOUT_MS = 5 * 60 * 1000;

// Package install gets its own timeout, ten times larger than the shared process
// ceiling.
export const PROC_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

// Child-process convenience: text encoding and piped stdio on top of `run`'s shared
// ceilings. Verbose npm hit the default megabyte `maxBuffer` and killed hook install
// with an opaque refusal.
export function runProc(cmd, args = [], options = {}) {
  return run(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: PROC_TIMEOUT_MS,
    maxBuffer: PROC_MAX_OUTPUT,
    ...options,
  });
}

// A process killed by timeout leaves neither stderr nor a status: spawnSync puts
// ETIMEDOUT in error and the signal in signal. Without this fork a person gets
// "exited null".
export function procTimedOut(r) {
  return r?.error?.code === 'ETIMEDOUT' || (!!r?.signal && r?.status === null);
}

// Last non-empty line: git and npm write the diagnosis in the tail, progress before it.
export function lastLine(text) {
  return String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';
}

// Output tail as the last `n` lines: `npm` and `claude` put the diagnosis in the
// second-to-last and print advice last, and `lastLine` would return the advice instead
// of the reason. The line separator includes `\r\n`: otherwise a Windows-process tail
// arrives with `\r` in the middle of a glued line.
export function lastLines(text, n = 2) {
  return String(text ?? '').trim().split(/\r?\n/).slice(-n).join(' ');
}

export function runLogged(argv, { cwd, timeout = PROC_TIMEOUT_MS, logPath, exec = runProc, env } = {}) {
  const started = Date.now();
  const r = exec(argv[0], argv.slice(1), { cwd, timeout, ...(env ? { env } : {}) });
  const ms = Date.now() - started;
  try {
    writeFileSync(logPath, `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`);
  } catch { /* the log is convenience; a write refusal does not roll back the run */ }
  if (r.status === 0) return { status: r.status, ms, logPath, why: null };
  let why;
  if (r.error?.code === 'ENOENT') why = `was not found in PATH (${argv[0]})`;
  else if (procTimedOut(r)) why = `did not respond in ${timeout / 1000} s`;
  else {
    const tail = lastLines(r.stderr || r.stdout || r.error?.message || '');
    const code = r.status ?? r.error?.code ?? '?';
    why = tail ? `exited with code ${code}: ${tail}` : `exited with code ${code}`;
  }
  return { status: r.status ?? null, ms, logPath, why };
}

// Refusal reason in one phrase. Sources from precise to coarse: what the process said,
// what Node said (ENOENT, ETIMEDOUT — stderr is empty there), exit code. `full`: all of
// stderr — that is how a clone refusal is printed, where the whole git reply matters.
export function procError(r, { label = 'process', full = false } = {}) {
  const err = (r?.stderr ?? '').toString().trim();
  const text = full ? err : lastLine(err);
  return text || r?.error?.message || `${label} exited ${r?.status}`;
}

// Kept as a compatibility export for existing adapter callers; the implementation
// belongs to the package source.
export { shellQuote } from '../dist/fs/shell.js';

export function toPosix(p) { return p.split(path.sep).join('/'); }

const ENV_NAME = '[A-Za-z_][A-Za-z0-9_]*';

// A fresh regex on every call: a global one keeps lastIndex, and a shared instance
// between `replace` and `matchAll` is a loaded trap for the next consumer.
export function envPlaceholderRe() {
  return new RegExp(`\\$\\{(${ENV_NAME})\\}`, 'g');
}

// ${VAR} substitution in an MCP config object with JSON-escaping of the value: Claude
// Code does not guarantee interpolation when reading .mcp.json. An unset variable is
// left as ${VAR} — let the server refuse explicitly instead of leaving with an empty
// header in silence.
export function substituteEnvVars(obj) {
  return JSON.parse(
    JSON.stringify(obj).replace(envPlaceholderRe(), (m, name) =>
      (process.env[name] ? JSON.stringify(process.env[name]).slice(1, -1) : m)),
  );
}
