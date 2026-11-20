import { spawnSync } from 'node:child_process';

// Require a readable command for each candidate before attributing it to another run.
export function cursorProcessVerdict(marks) {
  const ps = spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const lines = String(ps.stdout ?? '').split('\n');
  if (ps.status !== 0 || !lines.some(line => Number(line.trim().split(/\s+/)[0]) === process.pid)) {
    return { ok: false, detail: `ps did not list this process (exit ${ps.status}: ${ps.error?.message ?? ps.stderr ?? ''})` };
  }
  const remaining = [];
  for (const line of lines) {
    const row = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!row || !/cursor-agent|worker-server/.test(row[2])) continue;
    const detail = spawnSync('ps', ['eww', '-o', 'command=', '-p', row[1]], { encoding: 'utf8' });
    if (detail.status !== 0 || !detail.stdout?.trim()) {
      // A candidate can exit between the two ps calls. ESRCH confirms its absence.
      try { process.kill(Number(row[1]), 0); } catch (error) { if (error.code === 'ESRCH') continue; }
      remaining.push(`ps could not identify PID ${row[1]}: ${detail.error?.message ?? detail.stderr ?? ''}`);
    } else if (marks.some(mark => detail.stdout.includes(mark))) remaining.push(`${row[1]} ${row[2].slice(0, 60)}`);
  }
  return { ok: !remaining.length, detail: remaining.join(' | ') };
}
