import './home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeOwnedSample } from '../scripts/owned-process-sample.mjs';

const clock = 'fixture-boot:ticks';
const first = { pid: 11, birth: '100', clock, role: 'service' };
const next = { ...first, birth: '200' };
const child = { pid: 22, birth: '110', clock, role: 'provider' };
const roster = [first, child, next];
const live = (proc, rssKiB) => ({ ...proc, state: 'live', rssKiB });
const absent = ({ pid }) => ({ pid, clock, state: 'absent' });
const sample = (...observations) => summarizeOwnedSample({ roster, observations });

test('restart on the same PID counts only its current owned lifetime; detached child still counts', () => {
  const report = sample(live(next, 12), live(child, 20));
  assert.deepEqual(report.lifetimes.map(p => p.state), ['replaced', 'live', 'live']);
  assert.deepEqual(report.counts, { service: 1, stdio: 0, warden: 0, provider: 1, other: 0 });
  assert.equal(report.liveProcesses, 2);
  assert.equal(report.rssKiB, 32);
});

test('confirmed absence differs from occupancy by an unowned replacement', () => {
  const report = sample(live({ ...next, birth: '300' }, 40), absent(child));
  assert.deepEqual(report.lifetimes.map(p => p.state), ['replaced', 'exited', 'replaced']);
  assert.equal(report.liveProcesses, 0);
  assert.equal(report.rssKiB, 0);
});

test('an unobserved, inaccessible or incomparable detached child prevents a zero total', () => {
  for (const childRows of [[], [{ pid: child.pid, state: 'unknown' }],
    [{ ...live(child, 4), clock: 'other-clock' }], [{ ...absent(child), clock: 'other-boot' }]]) {
    const report = sample(absent(first), ...childRows);
    assert.equal(report.lifetimes[1].state, 'unknown');
    assert.deepEqual([report.counts, report.liveProcesses, report.rssKiB], [null, null, null]);
  }
});

test('duplicate lifetimes or conflicting observations are invalid input', () => {
  assert.throws(() => summarizeOwnedSample({ roster: [first, first], observations: [] }));
  assert.throws(() => sample(absent(first), live(next, 12)));
});
