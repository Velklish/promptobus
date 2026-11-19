// Poll health.json until deliveredAt is newer. A miss names the file.
// See docs/guides/contributing.md § Suite isolation.
import { readFileSync } from 'node:fs';
import path from 'node:path';

function deliveredAt(file, address) {
  try {
    const health = JSON.parse(readFileSync(file, 'utf8'));
    const mark = health?.[address];
    const at = mark && typeof mark === 'object' ? mark.deliveredAt : null;
    return typeof at === 'string' && at ? at : null;
  } catch {
    return null;
  }
}

function newer(next, prev) {
  if (!next || next === prev) return false;
  const a = Date.parse(next);
  const b = Date.parse(prev ?? '');
  return Number.isFinite(a) && (!Number.isFinite(b) || a > b);
}

/** Poll `health.json` until `address` has a delivery mark newer than the one at entry. */
export async function waitDelivered(home, task, address, timeoutMs, { clock = Date.now, poll = () => new Promise(r => setTimeout(r, 20)) } = {}) {
  const file = home && task ? path.join(home, 'tasks', task, 'health.json') : null;
  const bound = Number(timeoutMs);
  if (!file || !address || !(bound > 0)) {
    return { ok: false, file, deliveredAt: null, note: 'no health file to wait on' };
  }
  const before = deliveredAt(file, address);
  const deadline = clock() + bound;
  let now = before;
  while (clock() < deadline) {
    now = deliveredAt(file, address);
    if (newer(now, before)) return { ok: true, file, deliveredAt: now, note: null };
    await poll();
  }
  now = deliveredAt(file, address);
  if (newer(now, before)) return { ok: true, file, deliveredAt: now, note: null };
  return {
    ok: false,
    file,
    deliveredAt: now,
    note: `TIMEOUT after ${bound} ms waiting for ${file} — the warden had not written a newer deliveredAt for ${address}`,
  };
}
