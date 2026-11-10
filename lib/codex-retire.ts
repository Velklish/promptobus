#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { holderAlive, pidAlive, readSession, selfStopLogFile } from './codex-session.js';
import { retireConfirmedCodex } from './driver-codex.js';

const [ref, launchId, threadId, deadlineText] = process.argv.slice(2);
const deadline = Number(deadlineText);
if (!ref || !launchId || !threadId || !Number.isSafeInteger(deadline)) throw new Error('Invalid self-Stop finalizer binding');
const log = selfStopLogFile(ref, launchId);
try {
  const initial = readSession(ref);
  if (!initial || initial.launchId !== launchId || initial.threadId !== threadId)
    throw new Error('launch identity changed before self-Stop finalizer readiness');
  if (!process.send) throw new Error('self-Stop finalizer readiness channel is absent');
  await new Promise<void>((resolve, reject) => process.send!({ ready: true, ref, launchId, threadId }, error => error ? reject(error) : resolve()));
  for (;;) {
    const current = readSession(ref);
    if (!current || current.launchId !== launchId || current.threadId !== threadId)
      throw new Error('launch identity changed before self-Stop retirement');
    if (Date.now() >= deadline) throw new Error('self-Stop finalizer deadline elapsed; record retained');
    if (current.stopConfirmed && !holderAlive(ref) && !pidAlive(current.appPid)) {
      retireConfirmedCodex(ref, launchId, threadId, deadline);
      appendFileSync(log, 'confirmed Stop receipt retained; matching record retired\n', { mode: 0o600 });
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
} catch (error) {
  try { appendFileSync(log, `self-Stop finalizer failed: ${(error as Error).message}\n`, { mode: 0o600 }); } catch {}
  process.exitCode = 1;
}
