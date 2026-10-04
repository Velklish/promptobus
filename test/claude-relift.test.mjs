// Relift stand: a Claude Code worker lifted again on its address hears the warden before its
// first turn ends, on a stub `--bg` that ignores `--session-id` as claude 2.1.284 does. Run: npm test
import { check, skip } from './check.mjs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { listenTestSocket, makeSandbox, makeSockPath } from './sandbox.mjs';
import {
  BG_SESSION_ID_WARNING, harnessSessions, installHarness, pidAlive, planParticipant, readLog, readTrace,
  setHarnessMode, stopAll, waitFor,
} from './harness.mjs';
import { buildWorkspace, cli, store } from './scenario.mjs';

const { wardenRound } = await import('../lib/warden.js');
const { snapshotOf } = await import('../lib/drivers.js');

const SB = makeSandbox('promptobus-test-relift-');
const sock = makeSockPath('a2h-');
const probe = net.createServer();
const permission = await listenTestSocket(probe, sock('sandbox-bind-probe'));
if (permission.ok) await new Promise((resolve) => probe.close(resolve));

const { home: HARNESS, restore } = await installHarness({ binDir: path.join(SB, 'bin'), sock });
const { ws, repo } = buildWorkspace(SB);
const HOME = path.join(ws, '.promptobus');
const TASK = 'relift-t20261004-120000';
const ORCH = 'orch-relift-stand';
const WORKER = 'worker:relift';
const NOID = 'worker:noid';
const orchEnv = { ...process.env, CLAUDE_CODE_SESSION_ID: ORCH, PROMPTOBUS_HOME: HOME };
const brief = path.join(SB, 'brief.md');
writeFileSync(brief, '# Relift stand\n\nA scripted participant; nothing to do.\n');
store.createTask(HOME, { id: TASK, title: 'relift stand', owner: ORCH });

const recordOf = (addr) => store.participantOf(store.readTask(HOME, TASK), addr);
const liveSession = (addr) => {
  const ref = recordOf(addr)?.sessionRef;
  return harnessSessions(HARNESS).find((s) => s.name === ref && pidAlive(s.pid)) ?? null;
};
const notesOf = (addr, session, kind) => readTrace(HARNESS, addr).filter((n) => n.session === session && n.kind === kind);
const spawnWorker = (worker) => cli(['spawn', '--repo', repo, '--brief', brief, '--task', TASK, '--worker', worker],
  { cwd: ws, env: orchEnv });
const settle = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

stand: {
  if (!permission.ok) {
    skip('Claude Code relift stand', permission.reason);
    break stand;
  }
  setHarnessMode(HARNESS, { bgIgnoresSessionId: true, bgAwaitsHandshake: true });
  // The first turn outlasts the steps below, so a knock seen before its end came from the warden.
  planParticipant(HARNESS, WORKER, { turns: [{ do: [{ wait: 9000 }], detail: 'first turn' }, { do: [] }] });

  const first = spawnWorker('relift');
  check('stand: the first lift of the worker succeeds', first.status === 0, first.out.slice(-600));
  const s1 = liveSession(WORKER);
  const held = await waitFor(() => (store.readWake(HOME, TASK, WORKER)?.session === s1?.sessionId ? s1.sessionId : null),
    { timeoutMs: 20000 });
  check('stand: before the relift the contact point names the first session', !!held && held === s1?.sessionId,
    `${JSON.stringify(store.readWake(HOME, TASK, WORKER))} · ${JSON.stringify(s1)}`);

  spawnSync('claude', ['stop', s1?.id ?? 'none'], { encoding: 'utf8', env: process.env });
  const dead = await waitFor(() => !pidAlive(s1?.pid) && !harnessSessions(HARNESS).some((s) => s.id === s1?.id),
    { timeoutMs: 10000 });
  check('stand: the first session is dead and its record is gone, while its contact point stays',
    dead && store.readWake(HOME, TASK, WORKER)?.session === s1?.sessionId,
    JSON.stringify(store.readWake(HOME, TASK, WORKER)));

  const again = spawnWorker('relift');
  check('stand: the relift succeeds, and the stub --bg ignored --session-id with the warning 2.1.284 prints',
    again.status === 0 && again.out.includes(BG_SESSION_ID_WARNING), again.out.slice(-600));
  const s2 = liveSession(WORKER);
  const sent = cli(['send', WORKER, '--task', TASK, '--type', 'task', '--body', 'mail after the relift'],
    { cwd: ws, env: orchEnv });
  check('stand: the orchestrator sends to the relifted worker', sent.status === 0, sent.out);

  let knocked = [];
  for (let i = 0; i < 20 && !knocked.length; i += 1) {
    await wardenRound(HOME, TASK, { sessions: snapshotOf(store.readTask(HOME, TASK).participants) });
    knocked = notesOf(WORKER, s2?.id, 'knock');
    if (!knocked.length) await settle(200);
  }
  const ended = notesOf(WORKER, s2?.id, 'guard');
  check('relift: the warden knock reaches the new session before its first turn ends',
    knocked.length > 0 && (!ended.length || knocked[0].at < ended[0].at),
    `knocks ${JSON.stringify(knocked)} · turn ends ${JSON.stringify(ended)} · log: ${readLog(HARNESS, s2?.id, 8)}`);
  const record = recordOf(WORKER);
  check('relift: the participant record names the session\'s own id, not the UUID chosen before launch',
    !!s2?.sessionId && record?.metadata?.sessionId === s2.sessionId, JSON.stringify({ record: record?.metadata, s2 }));
  check('relift: the contact point names the new session',
    store.readWake(HOME, TASK, WORKER)?.session === s2?.sessionId, JSON.stringify(store.readWake(HOME, TASK, WORKER)));
  const before = notesOf(WORKER, s2?.id, 'wake-before-handshake')[0];
  check('relift: the dead session\'s contact point was gone before the new session\'s handshake',
    !!before && before.held === null, JSON.stringify(before));

  // Past the spawn grace a point held by another session reads as a deaf channel; the stand
  // moves `started` back rather than wait out the grace.
  store.upsertParticipant(HOME, TASK, { ...record, metadata: { ...record.metadata, started: new Date(Date.now() - 120000).toISOString() } });
  const printed = cli(['status', '--task', TASK], { cwd: ws, env: orchEnv });
  check('relift: status prints no deaf channel for the relifted worker',
    printed.status === 0 && !/deaf/.test(printed.out) && !printed.out.includes(`held by session ${s1?.sessionId}`),
    printed.out.slice(-1500));

  setHarnessMode(HARNESS, { bgIgnoresSessionId: true, bgAwaitsHandshake: true, listsNoSessionId: true });
  planParticipant(HARNESS, NOID, { turns: [{ do: [{ wait: 3000 }], detail: 'first turn' }] });
  const noid = spawnWorker('noid');
  const s3 = liveSession(NOID);
  check('no-id harness: the lift succeeds when claude agents names no session id',
    noid.status === 0 && !!s3, noid.out.slice(-600));
  check('no-id harness: the record is bound to the session\'s own id from its handshake',
    !!s3?.sessionId && recordOf(NOID)?.metadata?.sessionId === s3.sessionId
    && store.readWake(HOME, TASK, NOID)?.session === s3.sessionId,
    JSON.stringify({ record: recordOf(NOID)?.metadata, wake: store.readWake(HOME, TASK, NOID), s3 }));
}

const left = await stopAll(HARNESS);
check('no participant processes left after the stand', left.length === 0, JSON.stringify(left));
restore();
