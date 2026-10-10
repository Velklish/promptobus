import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const LIVE_RECORD = '.promptobus-live-run.json';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const canonical = (file) => {
  try { return realpathSync(file); } catch (error) {
    if (error?.code !== 'ENOENT' || path.dirname(file) === file) throw error;
    return path.join(canonical(path.dirname(file)), path.basename(file));
  }
};
const under = (file, root) => {
  if (!text(file) || !text(root)) return false;
  const relative = path.relative(canonical(root), canonical(file));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export function processTable() {
  const r = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], { encoding: 'utf8' });
  if (r.error || r.status !== 0 || !r.stdout?.trim()) throw new Error('process discovery failed');
  return r.stdout.trim().split('\n').map((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) throw new Error('malformed process discovery');
    return { pid: Number(m[1]), parent: Number(m[2]), group: Number(m[3]), state: m[4], birth: m[5] };
  }).filter((row) => !row.state.startsWith('Z'));
}

const same = (a, b) => a.pid === b.pid && a.birth === b.birth;
const validProcess = (p) => Number.isInteger(p?.pid) && p.pid > 0 && text(p.birth);

export function parseLiveSessions(result) {
  if (result?.error || result?.status !== 0 || typeof result?.stdout !== 'string') {
    throw new Error('session registry command failed');
  }
  const parsed = JSON.parse(result.stdout);
  const list = Array.isArray(parsed) ? parsed : parsed?.agents ?? parsed?.sessions;
  if (!Array.isArray(list) || list.some((row) => !row || !text(row.sessionId) || !text(row.cwd)
    || !Number.isInteger(row.pid) || row.pid <= 0 || row.kind === 'background' && !text(row.id))) {
    throw new Error('malformed session registry');
  }
  return list;
}

export function priorRunIsLive(dir, { readProcesses = processTable } = {}) {
  try {
    const record = JSON.parse(readFileSync(path.join(dir, LIVE_RECORD), 'utf8'));
    if (record.version !== 1 || record.deathVerified !== true || !Array.isArray(record.processes)
      || !record.processes.every(validProcess)
      || ![record.groups, record.watchedGroups].every((groups) => Array.isArray(groups)
        && groups.every((group) => Number.isInteger(group) && group > 0))) return true;
    const table = readProcesses();
    return table.some((p) => record.processes.some((own) => same(own, p)) || [...record.groups, ...record.watchedGroups].includes(p.group));
  } catch { return true; }
}

export function onAbort(cleanup, { emitter = process, exit = (code) => process.exit(code) } = {}) {
  let pending = false;
  const listeners = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => {
    const listener = async () => {
      if (pending) return;
      pending = true;
      try { await cleanup(signal); } catch (error) {
        process.stderr.write(`abort cleanup failed: ${String(error?.message ?? error)}\n`);
      } finally { exit(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 129); }
    };
    emitter.on(signal, listener);
    return [signal, listener];
  });
  return () => { for (const [signal, listener] of listeners) emitter.off(signal, listener); };
}

export function liveRun({ sandbox, socketDir = null, readSessions, stopSession,
  readProcesses = processTable, kill = process.kill.bind(process), timeoutMs = 10_000,
  remove = (dir) => rmSync(dir, { recursive: true, force: true }),
}) {
  const record = { version: 1, deathVerified: false, processes: [], groups: [], watchedGroups: [], sessions: [], captureErrors: [] };
  const children = [];
  const resources = [];
  let context = null;
  let aborted = false;
  let cleanupPromise = null;
  const save = () => writeFileSync(path.join(sandbox, LIVE_RECORD), JSON.stringify(record), { mode: 0o600 });
  save();
  const assertRunning = () => { if (aborted) throw new Error('live run aborted'); };
  const observe = () => {
    const table = readProcesses();
    const trusted = record.processes.filter((own) => table.some((p) => same(own, p)));
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of table) {
        if (record.processes.some((own) => same(own, p))) continue;
        const ancestor = trusted.find((own) => own.pid === p.parent
          || [...record.groups, ...record.watchedGroups].includes(own.group) && own.group === p.group);
        if (ancestor) {
          const owned = { ...p, ownedChild: ancestor.ownedChild === true };
          record.processes.push(owned); trusted.push(owned); changed = true;
        }
      }
    }
    save();
    return table;
  };
  const child = (handle, { detached = false } = {}) => {
    assertRunning();
    children.push(handle);
    let p;
    try { p = readProcesses().find((row) => row.pid === handle.pid); } catch (error) {
      record.captureErrors.push('child process discovery failed'); save(); throw error;
    }
    if (!p) {
      record.captureErrors.push('child identity unavailable'); save();
      throw new Error('child identity unavailable');
    }
    record.processes.push({ ...p, ownedChild: true });
    if (detached && p.group === p.pid) record.groups.push(p.group);
    save();
  };
  const sessions = () => {
    const list = readSessions();
    if (!Array.isArray(list) || list.some((row) => !row || !text(row.sessionId))) {
      throw new Error('session registry unreadable');
    }
    return list;
  };
  const captureSessions = () => {
    if (!context) return;
    const participants = context.participants();
    if (!Array.isArray(participants)) throw new Error('task participants unreadable');
    const list = sessions();
    if (!Array.isArray(list)) throw new Error('session registry unreadable');
    for (const participant of participants) {
      const meta = participant?.metadata;
      if (!text(meta?.sessionId)) {
        if (text(meta?.session) || text(participant?.sessionRef)) throw new Error('participant full identity unavailable');
        continue;
      }
      if (!under(meta.worktree, context.workspace)) throw new Error('participant worktree is outside the stand');
      const hits = list.filter((row) => row?.sessionId === meta.sessionId);
      if (hits.length > 1) throw new Error('ambiguous owned session');
      const hit = hits[0];
      if (hit && (!text(hit.id) || hit.cwd !== meta.worktree || !Number.isInteger(hit.pid) || hit.pid <= 0)) {
        throw new Error('owned session identity mismatch');
      }
      let own = record.sessions.find((s) => s.sessionId === meta.sessionId);
      if (!hit && !own) throw new Error('task-bound session was never observed in the registry');
      if (!own) {
        own = { sessionId: meta.sessionId, cwd: meta.worktree, id: hit?.id ?? null };
        record.sessions.push(own);
      }
      if (hit) {
        if (own.id && own.id !== hit.id) throw new Error('owned session registry id changed');
        own.id = hit.id;
        const p = readProcesses().find((row) => row.pid === hit.pid);
        if (!p) throw new Error('owned session process identity unavailable');
        if (own.process && !same(own.process, p)) throw new Error('owned session process identity changed');
        own.process = { pid: p.pid, birth: p.birth };
        if (p.group === p.pid && !record.watchedGroups.includes(p.group)) record.watchedGroups.push(p.group);
        if (!record.processes.some((known) => same(known, p))) record.processes.push(p);
      }
    }
    save();
  };
  const signalOwned = (own, signal, group = false) => {
    const fresh = readProcesses().find((row) => same(row, own));
    if (!fresh) return;
    const target = group && fresh.group === own.group ? -own.group : own.pid;
    try { kill(target, signal); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  };
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    aborted = true;
    cleanupPromise = (async () => {
      const failures = [...record.captureErrors];
      try { observe(); } catch (error) { failures.push(String(error?.message ?? error)); }
      for (const close of resources) {
        let timer;
        try {
          await Promise.race([Promise.resolve().then(close), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('resource close unconfirmed')), 1000);
          })]);
        } catch (error) { failures.push(String(error?.message ?? error)); } finally { clearTimeout(timer); }
      }
      try { observe(); captureSessions(); observe(); } catch (error) { failures.push(String(error?.message ?? error)); }
      for (const own of record.sessions) {
        try {
          const list = sessions();
          if (!Array.isArray(list)) throw new Error('session registry unreadable');
          const hits = list.filter((s) => s?.sessionId === own.sessionId);
          if (hits.length > 1 || (hits[0] && (hits[0].cwd !== own.cwd || hits[0].id !== own.id
              || list.filter((s) => s.id === own.id).length !== 1))) {
            throw new Error('owned session changed before stop');
          }
          if (hits[0]) {
            const p = readProcesses().find((row) => row.pid === hits[0].pid);
            if (!p || !own.process || !same(p, own.process)) throw new Error('owned session process changed before stop');
            const stopped = await stopSession(own.sessionId, own.id);
            if (stopped?.ok !== true || stopped?.stopped !== true && stopped?.attempted !== true) {
              throw new Error('owned session stop unconfirmed');
            }
            const edge = Date.now() + timeoutMs;
            while (sessions().some((s) => s.sessionId === own.sessionId) && Date.now() < edge) await pause(25);
            if (sessions().some((s) => s.sessionId === own.sessionId)) throw new Error('owned session death unconfirmed');
          }
        } catch (error) { failures.push(String(error?.message ?? error)); }
      }
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        try {
          const table = observe();
          for (const handle of children) {
            const own = record.processes.find((p) => p.pid === handle.pid);
            if (!own || !table.some((p) => same(p, own))) continue;
            signalOwned(own, signal, record.groups.includes(own.group));
          }
          for (const own of record.processes.filter((p) => p.ownedChild === true)) {
            if (table.some((p) => same(p, own))) {
              signalOwned(own, signal);
            }
          }
          const edge = Date.now() + timeoutMs;
          while (Date.now() < edge) {
            const fresh = observe();
            if (!fresh.some((p) => record.processes.some((own) => same(own, p)) || [...record.groups, ...record.watchedGroups].includes(p.group))) break;
            await pause(25);
          }
        } catch (error) { failures.push(String(error?.message ?? error)); }
      }
      let livePids = null;
      try {
        const table = observe();
        livePids = table.filter((p) => record.processes.some((own) => same(own, p)) || [...record.groups, ...record.watchedGroups].includes(p.group)).map((p) => p.pid);
        const list = sessions();
        if (!Array.isArray(list)) throw new Error('post-stop registry unreadable');
        if (record.sessions.some((own) => list.some((s) => s?.sessionId === own.sessionId))) failures.push('owned sessions remain');
        if (livePids.length) failures.push('owned processes remain');
      } catch (error) { failures.push(String(error?.message ?? error)); }
      const safe = failures.length === 0 && livePids?.length === 0;
      record.deathVerified = safe;
      save();
      if (safe) {
        if (socketDir) remove(socketDir);
        remove(sandbox);
      }
      return { safe, livePids, failures, sandboxRemoved: safe };
    })();
    return cleanupPromise;
  };
  return { assertRunning, child, captureSessions, cleanup,
    resource: (close) => { assertRunning(); resources.push(close); },
    start: (value) => { assertRunning(); context = value; record.task = value.task ?? null; save(); },
  };
}
