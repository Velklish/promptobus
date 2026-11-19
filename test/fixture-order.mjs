import { setTimeout as delay } from 'node:timers/promises';

export const scheduled = name => process.argv.slice(2).includes(`--schedule=${name}`);
export function receipt(event, fields = {}) {
  console.log(JSON.stringify({ event, pid: process.pid, at: performance.now(), ...fields }));
}

export async function observe(event, read, timeoutMs) {
  const start = performance.now();
  let value;
  while (!(value = read()) && performance.now() - start < timeoutMs) await delay(10);
  receipt(event, { observed: Boolean(value), elapsedMs: performance.now() - start, value });
  return value;
}
