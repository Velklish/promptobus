// Process launch inside the bus boundary: past `run` it does not go outside.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Process-wide output budget; Node's own default is smaller. A lost process result reads
// as "clean tree" or "state unknown", and the latter decides whether to clean a directory.
export const PROC_MAX_OUTPUT = 32 * 1024 * 1024;

// `spawnSync` has no default timeout: without an explicit value a hung harness,
// hook, npm, or npx stands forever together with the command that called it.
export const PROC_TIMEOUT_MS = 60_000;

// Single entry point for external processes; argv stays an array everywhere. Why, and the
// Windows routes: [02-host.md § Launching a process](../docs/reference/02-host.md#launching-a-process).

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const BATCH_EXT = new Set(['.cmd', '.bat']);

// These do not ride through cmd.exe: `%` expands before any quoting, a newline ends the
// command. Hence the refusal — running a truncated command is running an injection.
const UNCARRIABLE_BY_CMD = /[\r\n%]/;

// PATHEXT is written uppercase and glued lowercase: the filesystem ignores case, but the
// path stays predictable in an error message and when compared with .cmd/.bat.
function pathExtensions(env) {
  return (env.PATHEXT || DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// Search PATH only: CreateProcess starts with the current directory, and a `claude.exe`
// planted in a repository would beat the system one. The `;` separator is a literal.
export function resolveCommand(cmd, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return cmd;
  const exts = pathExtensions(env);
  const hasKnownExt = (p) => exts.some((e) => p.toLowerCase().endsWith(e));
  const candidates = (base) => (hasKnownExt(base) ? [base] : []).concat(exts.map((e) => base + e));

  if (/[\\/]/.test(cmd) || /^[A-Za-z]:/.test(cmd)) return candidates(cmd).find(existsSync) ?? null;

  for (const dir of (env.PATH || env.Path || '').split(';')) {
    if (!dir) continue;
    const hit = candidates(path.join(dir.replace(/^"|"$/g, ''), cmd)).find(existsSync);
    if (hit) return hit;
  }
  return null;
}

// A batch-file argument is parsed twice — cmd.exe, then the CRT of the program `%*` calls.
// The three rules: [02-host.md § Launching a process](../docs/reference/02-host.md#launching-a-process).
export function quoteCmdArg(arg) {
  const s = String(arg);
  let out = '"';
  let slashes = 0;
  for (const ch of s) {
    if (ch === '\\') { slashes += 1; continue; }
    if (ch === '"') { out += '\\'.repeat(slashes * 2) + '""'; slashes = 0; continue; }
    out += '\\'.repeat(slashes) + ch;
    slashes = 0;
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

// `/v:off` — no delayed expansion (`!VAR!` would expand inside quotes), `/d` — no registry
// AutoRun, `/s` — strip the outer quote pair, `/c` — run and exit.
export function buildCmdLine(file, args) {
  return `/v:off /d /s /c "${[file, ...args].map(quoteCmdArg).join(' ')}"`;
}

// ComSpec can be something other than cmd.exe (PowerShell), and the escaping above is
// about cmd.exe; a space in the path disqualifies too (verbatim).
function comSpec(env) {
  const v = env.ComSpec ?? env.COMSPEC ?? '';
  return /\\cmd\.exe$/i.test(v) && !/\s/.test(v) ? v : 'cmd.exe';
}

// Plan separate from launch: Windows branches can then be unit-tested on any platform.
export function planRun(cmd, args = [], { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return { ok: true, file: cmd, args, verbatim: false };

  const file = resolveCommand(cmd, { platform, env });
  if (!file) return { ok: false, code: 'ENOENT', message: `${cmd}: not found in PATH` };
  if (!BATCH_EXT.has(path.extname(file).toLowerCase())) {
    return { ok: true, file, args, verbatim: false };
  }

  const bad = args.find((a) => UNCARRIABLE_BY_CMD.test(String(a)));
  if (bad !== undefined) {
    return {
      ok: false,
      code: 'ERR_UNCARRIABLE_ARG',
      message: `${cmd}: ${path.basename(file)} is a Windows command file, and the argument contains a newline or "%";`
        + ' such an argument does not ride through cmd.exe. Put a native binary (.exe) in place of the npm wrapper.',
    };
  }
  return { ok: true, file: comSpec(env), args: [buildCmdLine(file, args)], verbatim: true };
}

// Refusal in spawnSync form with the same `error.code` Node would have returned:
// callers parse it the same way.
function failure({ code, message }) {
  const error = new Error(message);
  error.code = code;
  return { error, status: null, signal: null, stdout: '', stderr: '', pid: 0, output: [null, '', ''] };
}

// Resolve trace, off unless this variable names a file: the suite's sealed-PATH gate reads
// it — [contributing.md § Suite isolation](../docs/guides/contributing.md#suite-isolation).
const TRACE_VAR = 'PROMPTOBUS_EXEC_TRACE';

// Where PATH would find `cmd`, for the trace only — `run` on POSIX hands the bare name to
// the kernel. The execute bit is REQUIRED here, by the same test the seal builds with.
function wouldResolve(cmd, env) {
  if (process.platform === 'win32') return resolveCommand(cmd, { platform: process.platform, env });
  if (cmd.includes(path.sep) || path.isAbsolute(cmd)) return cmd;
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir.replace(/^"|"$/g, ''), cmd);
    try {
      if (existsSync(file) && (statSync(file).mode & 0o111)) return file;
    } catch {
      // Vanished between the two calls, or unreadable — the next directory answers.
    }
  }
  return null;
}

function trace(cmd, options) {
  const file = process.env[TRACE_VAR];
  if (!file) return;
  const env = options.env ?? process.env;
  try {
    appendFileSync(file, `${cmd}\t${wouldResolve(String(cmd), env) ?? '(unresolved)'}\n`);
  } catch {
    // No trace file, or it went with the run directory — tracing is never a refusal.
  }
}

export function run(cmd, args = [], options = {}) {
  trace(cmd, options);
  const plan = planRun(cmd, args, { env: options.env ?? process.env });
  if (!plan.ok) return failure(plan);
  return spawnSync(plan.file, plan.args, {
    timeout: PROC_TIMEOUT_MS,
    maxBuffer: PROC_MAX_OUTPUT,
    ...options,
    shell: false,
    ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
  });
}
