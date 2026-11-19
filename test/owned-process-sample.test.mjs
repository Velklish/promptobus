import './home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeOwnedSample } from '../scripts/owned-process-sample.mjs';

const owner = { pid: 11, birth: 'birth-a', role: 'service' };
const app = { pid: 22, birth: 'birth-b', role: 'provider' };
const roster = [owner, app];
const live = (proc, rssKiB) => ({ ...proc, state: 'live', rssKiB });
const absent = proc => ({ ...proc, state: 'absent' });

test('account separately for the shared owner and provider, including after shutdown', () => {
  assert.deepEqual(summarizeOwnedSample({ roster, observations: [live(app, 20), live(owner, 12)] }), {
    counts: { service: 1, provider: 1, stdio: 0, warden: 0, other: 0 }, liveProcesses: 2, rssKiB: 32,
  });
  assert.equal(summarizeOwnedSample({ roster, observations: roster.map(absent) }).liveProcesses, 0);
});

test('unknown, missing, reused or repeated identity cannot establish cleanup', () => {
  for (const observations of [[absent(owner)], [absent(owner), { ...app, state: 'unknown' }],
    [absent(owner), { ...absent(app), birth: 'replacement' }], [absent(owner), absent(owner)]]) {
    assert.throws(() => summarizeOwnedSample({ roster, observations }));
  }
});
