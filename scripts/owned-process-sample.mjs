import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const roles = ['service', 'stdio', 'warden', 'provider', 'other'];
const positive = n => Number.isSafeInteger(n) && n > 0;
const label = value => typeof value === 'string' && value.trim() !== '';

export function summarizeOwnedSample({ roster, observations }) {
  if (!Array.isArray(roster) || !roster.length || !Array.isArray(observations)) {
    throw new Error('Expected a nonempty owned roster and an observations array');
  }
  const identities = new Set(), pids = new Set();
  for (const { pid, birth, clock, role } of roster) {
    const key = JSON.stringify([pid, birth]);
    if (!positive(pid) || !label(birth) || !label(clock) || clock !== roster[0].clock || !roles.includes(role) || identities.has(key)) {
      throw new Error('Invalid or duplicate owned process identity');
    }
    identities.add(key);
    pids.add(pid);
  }
  const byPid = new Map();
  for (const observation of observations) {
    const { pid, state, birth, clock, rssKiB } = observation;
    if (!pids.has(pid) || byPid.has(pid)) throw new Error('Unexpected or repeated PID observation');
    if (!['live', 'absent', 'unknown'].includes(state) || (state === 'live'
      ? !label(birth) || !label(clock) || !Number.isSafeInteger(rssKiB) || rssKiB < 0
      : birth !== undefined || rssKiB !== undefined || (state === 'absent' && !label(clock)))) {
      throw new Error('Invalid process observation');
    }
    byPid.set(pid, observation);
  }
  const counts = Object.fromEntries(roles.map(role => [role, 0]));
  let rssKiB = 0;
  const lifetimes = roster.map(({ pid, birth, clock, role }) => {
    const sample = byPid.get(pid);
    let state = 'unknown';
    if (sample?.clock === clock && sample.state === 'absent') state = 'exited';
    if (sample?.clock === clock && sample.state === 'live') {
      state = sample.birth === birth ? 'live' : 'replaced';
      if (state === 'live') {
        counts[role]++;
        rssKiB += sample.rssKiB;
        if (!Number.isSafeInteger(rssKiB)) throw new Error('RSS sum outside integer range');
      }
    }
    return { pid, birth, clock, role, state };
  });
  if (lifetimes.some(proc => proc.state === 'unknown')) return { lifetimes, counts: null, liveProcesses: null, rssKiB: null };
  return { lifetimes, counts, liveProcesses: Object.values(counts).reduce((a, b) => a + b), rssKiB };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  console.log(JSON.stringify(summarizeOwnedSample(JSON.parse(readFileSync(0, 'utf8')))));
}
