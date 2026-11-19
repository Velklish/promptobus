// Poll health.json until deliveredAt is newer. A miss names the file.
// See docs/guides/contributing.md § Suite isolation.
import { readFileSync } from 'node:fs';
import path from 'node:path';

function deliveredAt(file, address) {
  try {
    const health = JSON.parse(readFileSync(file, 'utf8'));
    if (!health || typeof health !== 'object' || Array.isArray(health)) return undefined;
    if (!Object.hasOwn(health, address)) return null;
    const mark = health[address];
    if (!mark || typeof mark !== 'object' || Array.isArray(mark)) return undefined;
    const at = mark.deliveredAt;
    return at == null ? null : typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : undefined;
  } catch (error) {
    return error.code === 'ENOENT' ? null : undefined;
  }
}

function newer(next, prev) {
  if (!next || next === prev) return false;
  const a = Date.parse(next);
  const b = Date.parse(prev ?? '');
  return Number.isFinite(a) && (!Number.isFinite(b) || a > b);
}

/** Establish a readable baseline before taking the mailbox; both waits share one deadline. */
export async function deliveryBarrier(home, task, address, timeoutMs, {
  clock = Date.now, poll = () => new Promise(r => setTimeout(r, 20)),
} = {}) {
  const file = home && task ? path.join(home, 'tasks', task, 'health.json') : null;
  const bound = Number(timeoutMs);
  const failure = (note, deliveredAt = null) => ({ ok: false, file, deliveredAt, note });
  if (!file || !address || !Number.isFinite(bound) || bound <= 0) return failure('no health file to wait on');
  const deadline = clock() + bound;
  let before = deliveredAt(file, address);
  while (before === undefined && clock() < deadline) {
    await poll();
    before = deliveredAt(file, address);
  }
  const timeout = `TIMEOUT after ${bound} ms waiting for ${file}`;
  if (before === undefined || clock() >= deadline) return failure(`${timeout} — no readable deliveredAt baseline before reading mail for ${address}`);
  async function wait() {
    let latest = before;
    for (;;) {
      const now = deliveredAt(file, address);
      if (newer(now, before)) return { ok: true, file, deliveredAt: now, note: null };
      if (now !== undefined) latest = now;
      if (clock() >= deadline) return failure(`${timeout} — the warden had not written a newer deliveredAt for ${address}`, latest);
      await poll();
    }
  }
  return { ok: true, file, deliveredAt: before, note: null, wait };
}

/** Observe delivery without taking mail, for fixtures that only exercise polling. */
export async function waitDelivered(home, task, address, timeoutMs, options) {
  const barrier = await deliveryBarrier(home, task, address, timeoutMs, options);
  if (!barrier.ok) return barrier;
  return barrier.wait();
}
