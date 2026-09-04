// Stateless bus helpers. Workspace paths are not here — the host owns those.

import {
  chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { run } from './exec.js';

const paintOn = (stream, code, s) => (stream.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const out = (code, s) => paintOn(process.stdout, code, s);
const err = (code, s) => paintOn(process.stderr, code, s);

export function ok(msg) { console.log(`${out(32, '✔')} ${msg}`); }
export function info(msg) { console.log(`  ${msg}`); }
export function warn(msg) { console.warn(`${err(33, '⚠')} ${msg}`); }
export function fail(msg) { console.error(`${err(31, '✖')} ${msg}`); process.exit(1); }
// Same level as fail, but without exit: diagnostics list EVERYTHING found.
export function bad(msg) { console.error(`${err(31, '✖')} ${msg}`); }

// Network wait ceiling for git, shared by fresh.js, refs.js, and promptobus/worktree.js:
// if they drifted, they would wait different times on the same dropped VPN (calls in
// worktree.js are local — there it guards a stuck index.lock).
export const GIT_NET_TIMEOUT_MS = 30_000;

// Cloning is timed separately: 30 seconds is for a query (`ls-remote`, `fetch` of one
// ref), and a clone carries whole repositories — minutes on a slow VPN are normal. A
// ceiling is required: without it `spawnSync` waits forever, and `sync` without VPN
// stands silent forever.
export const GIT_CLONE_TIMEOUT_MS = 5 * 60 * 1000;

// Git output ceiling. The default megabyte overflows the uncommitted list of a dirty
// clone: the process is killed, and the answer is read as "clean tree" or "state
// unknown", and the latter decides whether to clean a worker directory. 32 MB is
// hundreds of thousands of status lines; the constant is shared, otherwise they would
// give different answers on the same clone.
export const GIT_MAX_OUTPUT = 32 * 1024 * 1024;

// `spawnSync` has no default at all: without an explicit value a hung hook, npm, or npx
// stands forever together with the command that called it. Package install gets its own,
// ten times larger.
export const PROC_TIMEOUT_MS = 60_000;
export const PROC_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

// Single child-process wrapper: timeout and output ceiling. Verbose npm hit the default
// megabyte `maxBuffer` and killed hook install with an opaque refusal.
export function runProc(cmd, args = [], options = {}) {
  return run(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: PROC_TIMEOUT_MS,
    maxBuffer: GIT_MAX_OUTPUT,
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

// Refusal reason in one phrase. Sources from precise to coarse: what the process said,
// what Node said (ENOENT, ETIMEDOUT — stderr is empty there), exit code. `full`: all of
// stderr — that is how a clone refusal is printed, where the whole git reply matters.
export function procError(r, { label = 'process', full = false } = {}) {
  const err = (r?.stderr ?? '').toString().trim();
  const text = full ? err : lastLine(err);
  return text || r?.error?.message || `${label} exited ${r?.status}`;
}

// Argument for pasting into a terminal: ready spawn and cleanup commands carry session
// names with spaces and paths, and a space-joined string splits into a dozen arguments.
// POSIX quoting: a safe word as-is, the rest in single quotes, the quote itself arrives
// escaped (`'\''`); an empty string gets them too.
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function shellQuote(arg) {
  const s = String(arg);
  return SHELL_SAFE.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

// Write via tmp+rename: `writeFileSync` into the target truncates it to zero in front of
// a parallel reader, and a process that dies mid-write leaves a stump forever. tmp sits
// next to the target: `rename` is atomic only within one filesystem, and the bus home
// and `/tmp` are often on different ones; the name holds the target, pid, and a counter,
// otherwise two writers would meet on a shared tmp. `preserveMode` takes permissions
// from the former target — `rename` replaces it together with the mode, and 0600 on a
// foreign `info/exclude` would silently slide to the default; `mode` is permissions for
// a new file when there is nothing to carry over, and the carry-over wins.
let atomicSeq = 0;

export function writeFileAtomic(file, content, { mode = null, preserveMode = false } = {}) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  atomicSeq += 1;
  const tmp = path.join(dir, `.tmp-${path.basename(file)}-${process.pid}-${atomicSeq}`);
  const kept = preserveMode && existsSync(file) ? (statSync(file).mode & 0o777) : null;
  const m = kept ?? mode;
  try {
    writeFileSync(tmp, content, m === null ? undefined : { mode: m });
    // `mode` on `writeFileSync` is cut by umask: with the usual 022 a request of 0o660
    // arrives as 0o640, and carrying permissions of a group file would lose the group.
    // `chmod` after creation does not touch umask.
    if (m !== null) chmodSync(tmp, m);
    renameSync(tmp, file);
  } catch (e) {
    // recursive: a directory can sit where tmp should be (a cut-off pass, a foreign FS);
    // `force` alone does not remove it, and the next write would hit it forever.
    rmSync(tmp, { force: true, recursive: true });
    throw e;
  }
}

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
