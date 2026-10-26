import assert from 'node:assert/strict';
import { test } from 'node:test';
import { poll } from '../poll.js';

test('poll waits for each response and ignores completion after disconnect', async () => {
  let resolve: (value: number) => void = () => {};
  let calls = 0;
  const received: number[] = [];
  const stop = poll(() => { calls++; return new Promise<number>(done => { resolve = done; }); }, value => received.push(value), () => assert.fail('Unexpected poll failure'), 0);
  assert.equal(calls, 1);
  await new Promise(done => setTimeout(done, 5)); assert.equal(calls, 1);
  resolve(1); await new Promise(done => setTimeout(done, 5)); assert.equal(calls, 2);
  stop(); resolve(2); await new Promise(done => setTimeout(done, 5));
  assert.deepEqual(received, [1]); assert.equal(calls, 2);
});

test('poll recovers after failure and a remount ignores the earlier generation', async () => {
  let stop = () => {}, resolveOld!: (value: string) => void;
  const received: string[] = [], errors: unknown[] = [];
  const old = poll(() => new Promise<string>(resolve => { resolveOld = resolve; }), value => received.push(value), error => errors.push(error), 0);
  old();
  let calls = 0;
  const recovered = new Promise<void>(done => {
    stop = poll(async () => { if (++calls === 1) throw new Error('Offline'); return 'same-task-new-sample'; }, value => { received.push(value); done(); }, error => errors.push(error), 0);
  });
  await recovered; stop(); resolveOld('old-task-stale-sample');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(received, ['same-task-new-sample']);
  assert.equal(errors.length, 1); assert.match(String(errors[0]), /Offline/);
});
