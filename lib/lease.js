// The machine lease: one measuring run on this machine at a time, whoever started it.
// [reference/01-overview.md#machine-lease](../docs/reference/01-overview.md#machine-lease)
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { GateError, pidAlive } from '../dist/index.js';
import { lockHolder, withDirLockAsync } from '../dist/fs/lock.js';
import { planRun } from './exec.js';

export const LEASE_DIR_VAR = 'PROMPTOBUS_LEASE_DIR';
export const LEASE_WAIT_SEC = 1800;
const RETRY_MS = 250;
const HOLDER_FILE = 'holder.json';
const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** Where the lease lives: outside every store home, so all workspaces of this user see one lease. */
export function leaseRoot(env = process.env) {
  if (env[LEASE_DIR_VAR]) return env[LEASE_DIR_VAR];
  if (process.platform === 'win32') return path.join(os.tmpdir(), 'promptobus-lease');
  return path.join('/tmp', `promptobus-${process.getuid()}`);
}

const lockOf = (root) => path.join(root, 'machine.lock');
const waitersOf = (root) => path.join(root, 'waiters');

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/** One party of the lease, for a person: who, in which task, running what, since when. */
export function describeParty(p, now = Date.now()) {
  const who = `${p.address ?? 'a caller that named no address'}${p.task ? ` (task ${p.task})` : ''}`;
  const since = p.since ? `since ${p.since} (${span(now - Date.parse(p.since))})` : 'since an unrecorded time';
  return `${who} · ${p.command ?? 'command not recorded yet'} · ${since} · pid ${p.pid ?? '?'}`;
}

/** The holder and the live waiters. Pid and time come from the lock's own owner file. */
export function readLease(root = leaseRoot()) {
  const lock = lockOf(root);
  const owner = lockHolder(lock);
  const holder = owner
    ? { ...readJson(path.join(lock, HOLDER_FILE)), pid: owner.pid, since: owner.since, alive: pidAlive(owner.pid) }
    : null;
  let names = [];
  try { names = readdirSync(waitersOf(root)); } catch { /* nobody has waited yet */ }
  const waiters = names
    .map((n) => readJson(path.join(waitersOf(root), n)))
    .filter((w) => w && pidAlive(w.pid))
    .sort((a, b) => String(a.since).localeCompare(String(b.since)));
  return { root, holder, waiters };
}

/** The `status` lines: the holder, or "free", then each waiter. */
export function leaseLines(root = leaseRoot(), now = Date.now()) {
  const { holder, waiters } = readLease(root);
  const head = !holder
    ? `machine lease: free (${lockOf(root)})`
    : holder.alive
      ? `machine lease: held by ${describeParty(holder, now)}`
      : `machine lease: left by a dead process — ${describeParty(holder, now)}; the next taker drops it`;
  return [head, ...waiters.map((w) => `machine lease: waiting — ${describeParty(w, now)}`)];
}

function parseWait(raw) {
  if (raw === undefined) return LEASE_WAIT_SEC;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new GateError(`lease: --wait takes whole seconds, got "${raw}"`);
  return n;
}

class LeaseBusy extends Error {}

// A directory another user owns could drop our lock or plant one: only our own is trusted.
function ownRoot(root) {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw new GateError(`lease: cannot create the lease directory ${root}: ${e.message} — your command was not run`);
  }
  const st = lstatSync(root);
  const uid = process.getuid?.();
  const why = st.isSymbolicLink() ? 'is a symbolic link'
    : !st.isDirectory() ? 'is not a directory'
      : uid !== undefined && st.uid !== uid ? `belongs to uid ${st.uid}, not to this user (uid ${uid})` : null;
  if (why) {
    throw new GateError(`lease: the lease directory ${root} ${why} — your command was not run. `
      + `Remove it, or point ${LEASE_DIR_VAR} at a directory of your own`);
  }
}

/** Hold the machine lease around `fn`. A live holder is waited out up to `waitMs`, with one
 * line each time the holder changes; past the bound the refusal carries that same line. */
export async function underLease(root, me, fn, { waitMs = LEASE_WAIT_SEC * 1000, retryMs = RETRY_MS, log = () => {} } = {}) {
  ownRoot(root);
  mkdirSync(waitersOf(root), { recursive: true, mode: 0o700 });
  const lock = lockOf(root);
  const waiterFile = path.join(waitersOf(root), `${me.pid}.json`);
  const started = Date.now();
  let shown = null;
  let registered = false;
  try {
    for (;;) {
      try {
        return await withDirLockAsync(lock, async () => {
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
      const { holder } = readLease(root);
      const line = `machine lease is held by ${holder ? describeParty(holder) : 'a process that is still writing its record'}`;
      if (Date.now() - started >= waitMs) {
        throw new GateError(`${line} — waited ${span(Date.now() - started)}, the bound; your command was not run`);
      }
      if (!registered) {
        writeFileSync(waiterFile, `${JSON.stringify({ ...me, since: new Date().toISOString() })}\n`);
        registered = true;
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

// Signals reach the child and the wrapper waits for its exit: releasing first would let a
// waiter in while the killed run is still on the machine.
function runChild(command, env, cwd) {
  const plan = planRun(command[0], command.slice(1), { env });
  if (!plan.ok) throw new GateError(`lease: ${plan.message}`);
  return new Promise((resolve, reject) => {
    const child = spawn(plan.file, plan.args, {
      stdio: 'inherit', env, cwd, windowsVerbatimArguments: plan.verbatim,
    });
    const forward = (sig) => { child.kill(sig); };
    for (const sig of FORWARDED) process.on(sig, forward);
    const off = () => { for (const sig of FORWARDED) process.off(sig, forward); };
    child.on('error', (e) => { off(); reject(new GateError(`lease: ${command[0]}: ${e.message}`)); });
    child.on('exit', (code, signal) => {
      off();
      resolve(code ?? 128 + (os.constants.signals[signal] ?? 0));
    });
  });
}

/** `lease [--as <address>] [--task <id>] [--wait <seconds>] -- <command…>`: the command's exit code. */
export async function lease(host, { command, as, task, wait, env = process.env, cwd = process.cwd() }) {
  if (!command?.length) {
    throw new GateError(`${host.commandName} lease: no command to run — `
      + `${host.commandName} lease [--as <address>] [--task <id>] [--wait <seconds>] -- <command…>`);
  }
  const waitSec = parseWait(wait);
  const me = { pid: process.pid, address: as ?? null, task: task ?? null, command: command.join(' '), cwd };
  return underLease(leaseRoot(env), me, () => runChild(command, env, cwd), {
    waitMs: waitSec * 1000,
    log: (line) => process.stderr.write(`${line}\n`),
  });
}

/** The preamble paragraph for a participant that measures. */
export function leaseRule({ host, taskId, address }) {
  const cmd = host.busCommand(['lease', '--as', address, '--task', taskId, '--', '<command…>']);
  return '## Machine lease\n\n'
    + 'This machine is shared with other participants — of this task and of others — so whatever you measure is '
    + `measured on a box they load too. Run every measuring command under the bus's machine lease: \`${cmd}\`. `
    + 'It waits while another participant holds the machine, printing who holds it, in which task, running what and '
    + `since when; after ${LEASE_WAIT_SEC / 60} minutes it gives up with that same line and runs nothing. It releases `
    + 'the machine when your command exits, and a holder that dies releases it by liveness. A measuring command is '
    + 'one whose outcome depends on wall-clock or on machine load: this repository\'s full test suite and its gate '
    + 'command, as its own AGENTS.md, README or contributing guide names them. A single test file, a lint, a build '
    + 'or a type check is not — run those bare. Do not nest one leased command inside another: the inner one would '
    + `wait for the outer. Who holds the machine: \`${host.busCommand(['status'])}\`.`;
}
