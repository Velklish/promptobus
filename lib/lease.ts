// Opt-in machine measurement lease and keyed clone publication leases.
// [reference/01-overview.md#machine-lease](../docs/reference/01-overview.md#machine-lease)
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { GateError, pidAlive } from '../dist/index.js';
import { lockHolder, withDirLockAsync } from '../dist/fs/lock.js';
import { planRun } from './exec.js';
import type { PromptobusHost } from '../dist/index.js';

interface LeaseParty {
  pid?: number | null; since?: string | null; address?: string | null; task?: string | null; command?: string | null; cwd?: string;
}
interface LeaseWaiter extends LeaseParty { pid: number }
interface LeaseHolder extends LeaseParty { alive: boolean; ambiguous?: boolean; childPid?: number | null }
interface LeaseState { root: string; holder: LeaseHolder | null; waiters: LeaseWaiter[] }
interface LeaseOptions {
  key?: string | null; waitMs?: number; retryMs?: number; log?: (line: string) => void;
}

export const LEASE_DIR_VAR = 'PROMPTOBUS_LEASE_DIR';
export const LEASE_WAIT_SEC = 1800;
const RETRY_MS = 250;
const HOLDER_FILE = 'holder.json';
const CHILD_FILE = 'child.pid';
const FORWARDED: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** Where the lease lives: outside every store home, so all workspaces of this user see one lease. */
export function leaseRoot(env = process.env) {
  if (env[LEASE_DIR_VAR]) return env[LEASE_DIR_VAR];
  if (process.platform === 'win32') return path.join(os.tmpdir(), 'promptobus-lease');
  return path.join('/tmp', `promptobus-${process.getuid!()}`);
}

function scopeOf(key: unknown) {
  if (key === null || key === undefined) return null;
  let canonical;
  try { canonical = realpathSync(String(key)); } catch (e) {
    throw new GateError(`lease: --key ${key} is not a directory (${(e as Error).message}) — your command was not run`);
  }
  if (!statSync(canonical).isDirectory()) {
    throw new GateError(`lease: --key ${key} is not a directory — your command was not run`);
  }
  return createHash('sha256').update(canonical).digest('hex');
}

const lockOf = (root: string, scope: string | null = null) => scope
  ? path.join(root, 'keys', `${scope}.lock`) : path.join(root, 'machine.lock');
const waitersOf = (root: string, scope: string | null = null) => scope
  ? path.join(root, 'key-waiters', scope) : path.join(root, 'waiters');

function readJson(file: string): LeaseParty | null {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function readWaiters(root: string, scope: string | null): LeaseWaiter[] {
  const dir = waitersOf(root, scope);
  if (scope && !ownRoot(path.join(root, 'key-waiters'), false)) return [];
  if (!ownRoot(dir, false)) return [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { /* nobody has waited yet */ }
  return (names.map((name) => {
    if (!/^[1-9]\d*\.json$/.test(name)) return null;
    const pid = Number(name.slice(0, -5));
    if (!Number.isSafeInteger(pid)) return null;
    const file = path.join(dir, name);
    let st;
    try { st = lstatSync(file); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    if (!st.isFile() || (process.getuid && st.uid !== process.getuid!())) return null;
    const waiter = readJson(file);
    if (waiter !== null && waiter.pid !== pid) return null;
    if (pidAlive(pid)) return waiter;
    rmSync(file, { force: true });
    return null;
  }).filter(Boolean) as LeaseWaiter[]).sort((a, b) => String(a.since).localeCompare(String(b.since)) || a.pid - b.pid);
}

function keyedState(lock: string) {
  if (!existsSync(lock)) return null;
  const owner = lockHolder(lock);
  const raw = (() => { try { return readFileSync(path.join(lock, CHILD_FILE), 'utf8').trim(); } catch { return ''; } })();
  const childPid = /^[1-9]\d*$/.test(raw) ? Number(raw) : null;
  const wrapperAlive = Boolean(owner?.pid && pidAlive(owner.pid));
  const childAlive = Boolean(childPid && pidAlive(childPid));
  return {
    owner, childPid,
    state: wrapperAlive || childAlive ? 'live' : owner?.pid && childPid ? 'dead' : 'ambiguous',
  };
}

async function dropDeadKeyedLock(lock: string) {
  const recovery = `${lock}.recovery`;
  return withDirLockAsync(recovery, async () => {
    if (keyedState(lock)?.state !== 'dead') return false;
    const tomb = `${lock}.dead.${randomUUID()}`;
    try { renameSync(lock, tomb); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    }
    rmSync(tomb, { recursive: true, force: true });
    return true;
  }, {
    waitMs: 0,
    onMissing: () => new GateError(`lease: recovery directory for ${lock} vanished`),
    onBusy: () => new LeaseBusy(),
  });
}

function span(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/** One party of the lease, for a person: who, in which task, running what, since when. */
export function describeParty(p: LeaseParty, now = Date.now()) {
  const who = `${p.address ?? 'a caller that named no address'}${p.task ? ` (task ${p.task})` : ''}`;
  const since = p.since ? `since ${p.since} (${span(now - Date.parse(p.since))})` : 'since an unrecorded time';
  return `${who} · ${p.command ?? 'command not recorded yet'} · ${since} · pid ${p.pid ?? '?'}`;
}

/** The holder and the live waiters. Pid and time come from the lock's own owner file. */
export function readLease(root = leaseRoot(), key: string | null = null): LeaseState {
  root = path.resolve(root);
  const scope = scopeOf(key);
  if (!ownRoot(root, false)) return { root, holder: null, waiters: [] };
  const lock = lockOf(root, scope);
  const state = scope ? keyedState(lock) : null;
  const owner = state?.owner ?? (scope ? null : lockHolder(lock));
  const holder = scope && state
    ? { ...readJson(path.join(lock, HOLDER_FILE)), pid: owner?.pid ?? null, since: owner?.since ?? null,
      childPid: state.childPid, alive: state.state === 'live', ambiguous: state.state === 'ambiguous' }
    : owner
      ? { ...readJson(path.join(lock, HOLDER_FILE)), pid: owner.pid, since: owner.since, alive: pidAlive(owner.pid) }
      : null;
  return { root, holder, waiters: readWaiters(root, scope) };
}

/** The `status` lines: the holder, or "free", then each waiter. */
export function leaseLines(root = leaseRoot(), now = Date.now(), key: string | null = null) {
  const scope = scopeOf(key);
  const label = scope ? 'clone publication lease' : 'machine lease';
  const { holder, waiters } = readLease(root, key);
  const head = !holder
    ? `${label}: free (${lockOf(root, scope)})`
    : holder.ambiguous
      ? `${label}: recovery required for ${lockOf(root, scope)} — verify the publisher and child are dead before removing this lock`
    : holder.alive
      ? `${label}: held by ${describeParty(holder, now)}`
      : `${label}: left by ${scope ? 'dead processes' : 'a dead process'} — ${describeParty(holder, now)}; the next taker drops it`;
  return [head, ...waiters.map((w) => `${label}: waiting — ${describeParty(w, now)}`)];
}

function parseWait(raw: unknown) {
  if (raw === undefined) return LEASE_WAIT_SEC;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new GateError(`lease: --wait takes whole seconds, got "${raw}"`);
  return n;
}

class LeaseBusy extends Error {}

// A directory another user owns could drop our lock or plant one: only our own is trusted.
function ownRoot(root: string, create = true) {
  if (create) {
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new GateError(`lease: cannot create the lease directory ${root}: ${(e as Error).message} — your command was not run`);
    }
  }
  let st;
  try { st = lstatSync(root); } catch (e) {
    if (!create && (e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
  const uid = process.getuid?.();
  const why = st.isSymbolicLink() ? 'is a symbolic link'
    : !st.isDirectory() ? 'is not a directory'
      : uid !== undefined && st.uid !== uid ? `belongs to uid ${st.uid}, not to this user (uid ${uid})` : null;
  if (why) {
    throw new GateError(`lease: the lease directory ${root} ${why} — your command was not run. `
      + `Remove it, or point ${LEASE_DIR_VAR} at a directory of your own`);
  }
  return true;
}

/** Hold the selected lease around `fn`. A live holder is waited out up to `waitMs`, with one
 * line each time the holder changes; past the bound the refusal carries that same line. */
export async function underLease<T>(root: string, me: LeaseParty, fn: (lock?: string) => T | Promise<T>, { key = null, waitMs = LEASE_WAIT_SEC * 1000, retryMs = RETRY_MS, log = () => {} }: LeaseOptions = {}): Promise<T> {
  root = path.resolve(root);
  ownRoot(root);
  const scope = scopeOf(key);
  const lock = lockOf(root, scope);
  mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  mkdirSync(waitersOf(root, scope), { recursive: true, mode: 0o700 });
  const waiterFile = path.join(waitersOf(root, scope), `${me.pid}.json`);
  const started = Date.now();
  let shown: number | null | undefined = null;
  const takeTurn = () => {
    if (readWaiters(root, scope)[0]?.pid !== me.pid) throw new LeaseBusy();
  };
  try {
    writeFileSync(waiterFile, `${JSON.stringify({ ...me, since: new Date().toISOString() })}\n`);
    for (;;) {
      try {
        if (scope) {
          try { mkdirSync(lock); } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new LeaseBusy();
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new GateError(`lease: the lease directory ${root} vanished`);
            throw e;
          }
          try {
            writeFileSync(path.join(lock, 'owner'), `${JSON.stringify({
              pid: process.pid, session: null, since: new Date().toISOString(),
            })}\n`);
            takeTurn();
            rmSync(waiterFile, { force: true });
            writeFileSync(path.join(lock, HOLDER_FILE), `${JSON.stringify(me)}\n`);
            return await fn(lock);
          } finally {
            rmSync(lock, { recursive: true, force: true });
          }
        }
        return await withDirLockAsync(lock, async () => {
          takeTurn();
          rmSync(waiterFile, { force: true });
          writeFileSync(path.join(lock, HOLDER_FILE), `${JSON.stringify(me)}\n`);
          return fn();
        }, {
          waitMs: 0,
          onMissing: () => new GateError(`lease: the lease directory ${root} vanished`),
          onBusy: () => new LeaseBusy(),
        });
      } catch (e) {
        if (!(e instanceof LeaseBusy)) throw e;
      }
      if (scope) {
        const state = keyedState(lock);
        if (state?.state === 'ambiguous' && !state.owner?.pid) {
          throw new GateError(`lease: clone publication lock ${lock} has no known wrapper — `
            + 'verify the publisher and child are dead before removing this lock; your command was not run');
        }
        if (state?.state === 'ambiguous' && !pidAlive(state.owner!.pid)) {
          throw new GateError(`lease: clone publication lock ${lock} has no known child pid — `
            + 'verify the publisher and child are dead before removing this lock; your command was not run');
        }
        if (state?.state === 'dead') {
          try { if (await dropDeadKeyedLock(lock)) continue; } catch (e) {
            if (!(e instanceof LeaseBusy)) throw e;
          }
        }
      }
      const { holder } = readLease(root, key);
      const label = scope ? 'clone publication lease' : 'machine lease';
      const line = `${label} is held by ${holder ? describeParty(holder) : 'a process that is still writing its record'}`;
      if (Date.now() - started >= waitMs) {
        throw new GateError(`${line} — waited ${span(Date.now() - started)}, the bound; your command was not run`);
      }
      // A holder between its `mkdir` and its record is not named yet: wait for the record.
      if (holder?.command && holder.pid !== shown) {
        log(`${line} — waiting, up to ${span(waitMs)}`);
        shown = holder.pid;
      }
      await new Promise((resolve) => { setTimeout(resolve, retryMs); });
    }
  } finally {
    rmSync(waiterFile, { force: true });
  }
}

export function keyedCommandPlan(command: string[], env: NodeJS.ProcessEnv, keyedLocks: string[] = []) {
  const plan = planRun(command[0], command.slice(1), { env });
  if (!plan.ok) throw new GateError(`lease: ${plan.message}`);
  if (keyedLocks.length && process.platform === 'win32') {
    throw new GateError('lease: keyed publication requires a POSIX shell to record the command pid before exec; your command was not run');
  }
  const file = keyedLocks.length ? '/bin/sh' : plan.file;
  const args = keyedLocks.length
    ? ['-c', 'count="$1"; shift; while [ "$count" -gt 0 ]; do printf "%s\\n" "$$" > "$1" || exit 125; shift; count=$((count - 1)); done; exec "$@"',
      'promptobus-key-child', String(keyedLocks.length), ...keyedLocks.map(lock => path.join(lock, CHILD_FILE)), plan.file, ...plan.args]
    : plan.args;
  return { file, args, verbatim: plan.verbatim };
}

// Signals reach the child and the wrapper waits for its exit: releasing first would let a
// waiter in while the killed run is still on the machine.
function runChild(command: string[], env: NodeJS.ProcessEnv, cwd: string, keyedLock: string | null | undefined = null): Promise<number> {
  const plan = keyedCommandPlan(command, env, keyedLock ? [keyedLock] : []);
  return new Promise<number>((resolve, reject) => {
    const child = spawn(plan.file, plan.args, {
      stdio: 'inherit', env, cwd, windowsVerbatimArguments: plan.verbatim,
    });
    const forward = (sig: NodeJS.Signals) => { child.kill(sig); };
    for (const sig of FORWARDED) process.on(sig, forward);
    const off = () => { for (const sig of FORWARDED) process.off(sig, forward); };
    child.on('error', (e) => { off(); reject(new GateError(`lease: ${command[0]}: ${(e as Error).message}`)); });
    child.on('exit', (code, signal) => {
      off();
      resolve(code ?? 128 + (os.constants.signals[signal!] ?? 0));
    });
  });
}

/** `lease [--key <clone-root>] [--wait <seconds>] -- <command…>`: the command's exit code. */
export async function lease(host: Pick<PromptobusHost, 'commandName'>, { command, as, task, key = null, wait, env = process.env, cwd = process.cwd() }: { command?: string[]; as?: string | null; task?: string | null; key?: string | null; wait?: unknown; env?: NodeJS.ProcessEnv; cwd?: string }) {
  if (!command?.length) {
    throw new GateError(`${host.commandName} lease: no command to run — `
      + `${host.commandName} lease [--as <address>] [--task <id>] [--key <clone-root>] [--wait <seconds>] -- <command…>`);
  }
  const waitSec = parseWait(wait);
  const me = { pid: process.pid, address: as ?? null, task: task ?? null, command: command.join(' '), cwd };
  return underLease(leaseRoot(env), me, (lock) => runChild(command, env, cwd, lock), {
    key,
    waitMs: waitSec * 1000,
    log: (line) => process.stderr.write(`${line}\n`),
  });
}

/** Resource ownership and optional machine lease guidance for executable participants. */
export function leaseRule({ host, taskId, address }: { host: Pick<PromptobusHost, 'busCommand'>; taskId: string; address: string }) {
  const cmd = host.busCommand(['lease', '--as', address, '--task', taskId, '--', '<command…>']);
  return '## Machine lease\n\n'
    + 'Independent source reads, setup, builds, no-model checks, focused tests, full suites and gates may run concurrently '
    + 'within the approved actor/card limit after distinct worktree, output, temporary-directory and writable-cache ownership '
    + 'is established. A full suite or gate is not by itself a controlled measurement. Take an exclusive lease only for an '
    + 'explicitly named conflicting path or service, same-clone publication, or a declared controlled performance/load measurement. '
    + 'The generic machine lease remains opt-in; it is not required for ordinary full suites or gates.\n\n'
    + `For a declared machine-wide measurement or another explicitly requested machine lease, use \`${cmd}\`. `
    + 'It waits while another participant holds the machine, printing who holds it, in which task, running what and '
    + `since when; after ${LEASE_WAIT_SEC / 60} minutes it gives up with that same line and runs nothing. It releases `
    + 'the machine when your command exits. Do not nest one leased command inside another: the inner one would '
    + `wait for the outer. Who holds the machine: \`${host.busCommand(['status'])}\`.`;
}
