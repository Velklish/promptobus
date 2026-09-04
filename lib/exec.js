// Process launch inside the bus boundary: past `run` it does not go outside.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Single entry point for external processes. `shell: true` on Windows is not "the same,
// but through a shell" — it is a different semantics: Node builds
// `cmd.exe /d /s /c "<file> <space-joined arguments>"` with windowsVerbatimArguments
// and adds no quotes — an argument with a space splits in two, a newline cuts the
// command, `& | ^ < >` are executed. Here argv stays an array everywhere: POSIX —
// spawnSync without a shell; Windows and .exe — the same spawnSync on the resolved
// path; Windows and .cmd/.bat — cmd.exe with a command line built here, because Node
// will not launch a batch file directly (EINVAL after CVE-2024-27980). A side effect —
// resolve brings ENOENT back to life: under `shell: true` cmd.exe always started and
// instead of "not found in PATH" returned code 1 or 9009 with junk in stderr.

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const BATCH_EXT = new Set(['.cmd', '.bat']);

// These do not ride through cmd.exe: `%` expands to a variable before any quoting
// (`^%` does not save, `%%` only inside a batch file), a newline ends the command.
// Hence the refusal — silently executing a truncated command is executing an injection.
const UNCARRIABLE_BY_CMD = /[\r\n%]/;

// PATHEXT is written uppercase and glued lowercase: a Windows FS does not distinguish
// case, but the path is predictable — both in an error message and when compared with
// .cmd/.bat. Not exported: copy has no `tools.js` that the original exports a function
// for.
function pathExtensions(env) {
  return (env.PATHEXT || DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// Search PATH only: CreateProcess starts with the current directory, and a
// `claude.exe` planted in the repository would beat the system one. The `;` separator
// is a literal — path.delimiter is `:` on POSIX, and the function is called with
// platform: 'win32' from tests too.
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

// A batch-file argument goes through TWO parses — cmd.exe, then the CRT of the program
// the batch file calls via `%*`. Hence: always quote; double a quote as `""` (both
// sides understand it, and `\"` is not a quote to cmd.exe); double slashes before a
// quote by CRT rules, otherwise `C:\dir\` eats the closing quote. Uncarriable is cut
// off by planRun.
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

// `/v:off` — turn off delayed expansion: with DelayedExpansion in the registry `!VAR!`
// would expand even inside quotes. `/d` — no AutoRun from the registry, `/s` — strip
// the outer quote pair, `/c` — run and exit.
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

export function run(cmd, args = [], options = {}) {
  const plan = planRun(cmd, args);
  if (!plan.ok) return failure(plan);
  return spawnSync(plan.file, plan.args, {
    ...options,
    shell: false,
    ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
  });
}
