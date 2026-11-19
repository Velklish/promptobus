import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const roles = ['service', 'stdio', 'warden', 'provider', 'other'];
const positive = n => Number.isSafeInteger(n) && n > 0;

export function summarizeOwnedSample({ roster, observations }) {
  if (!Array.isArray(roster) || !roster.length || !Array.isArray(observations)) {
    throw new Error('Expected a nonempty owned roster and an observations array');
  }
  const byPid = new Map();
  for (const { pid, birth, role } of roster) {
    if (!positive(pid) || typeof birth !== 'string' || !birth.trim() || !roles.includes(role) || byPid.has(pid)) {
      throw new Error('Invalid or duplicate owned process identity');
    }
    byPid.set(pid, { birth, role });
  }
  const seen = new Set();
  const counts = Object.fromEntries(roles.map(role => [role, 0]));
  let rssKiB = 0;
  for (const { pid, birth, state, rssKiB: rss } of observations) {
    const owned = byPid.get(pid);
    if (!owned || owned.birth !== birth || seen.has(pid)) throw new Error('Unmatched process observation');
    seen.add(pid);
    if (state === 'absent' && rss === undefined) continue;
    if (state !== 'live' || !Number.isSafeInteger(rss) || rss < 0) throw new Error('Incomplete process observation');
    counts[owned.role]++;
    rssKiB += rss;
    if (!Number.isSafeInteger(rssKiB)) throw new Error('RSS sum outside integer range');
  }
  if (seen.size !== byPid.size) throw new Error('Missing owned process observation');
  return { counts, liveProcesses: Object.values(counts).reduce((a, b) => a + b), rssKiB };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  console.log(JSON.stringify(summarizeOwnedSample(JSON.parse(readFileSync(0, 'utf8')))));
}
