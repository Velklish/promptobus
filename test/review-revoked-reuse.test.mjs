import './home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { hostOf } from '../lib/host.js';
import { opencodeDriver } from '../lib/driver-opencode.js';
import { planReview, review } from '../lib/review.js';
import * as store from '../lib/store.js';

for (const phase of ['before plan', 'before publication', 'active binding']) test(`live reviewer reuse: ${phase}`, async t => {
  const root = realpathSync(makeSandbox('review-reuse-')), repo = path.join(root, 'orders');
  writeHostConfig(root, { tools: ['opencode'] });
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args]);
  git('init', '-qb', 'main');
  writeFileSync(path.join(repo, 'a'), 'old'); git('add', 'a'); git('commit', '-qm', 'base');
  writeFileSync(path.join(repo, 'a'), 'new');
  const host = hostOf(root), home = host.promptobusHome(), address = 'reviewer:orders';
  const task = store.createTask(home, { id: 't20261024-170000', title: 'Re-review binding' }).id;
  const participant = () => store.participantOf(store.readTask(home, task), address);
  store.upsertParticipant(home, task, store.participantRecord(address, { harness: 'opencode', mode: 'managed', sessionRef: 'review-orders',
    sessionId: 'ses_active', reviewLaunchId: 'this-launch', revokedReviewLaunchId: 'older-launch' }));
  store.sendMessage(home, task, { from: 'orchestrator', to: address, type: 'task', body: 'original assignment' });
  t.mock.method(opencodeDriver, 'inspect', () => ({ state: 'alive', busy: false }));
  t.mock.method(opencodeDriver, 'spawn', () => assert.fail('unexpected lift'));
  t.mock.method(opencodeDriver, 'stop', () => assert.fail('unexpected Stop'));
  const revoke = () => {
    const p = participant();
    store.upsertParticipant(home, task, { ...p, metadata: { ...p.metadata, sessionId: null, revokedReviewLaunchId: p.metadata.reviewLaunchId } });
  };
  const evidence = () => ({ assignment: participant().metadata.assignmentAfterId, messages: store.strictTaskFacts(home, task).messages,
    inbox: store.countInbox(home, task, address), files: readdirSync(store.filesDir(home, task)) });
  const before = evidence(), opts = { target: repo, task, base: 'HEAD', harness: 'opencode' };
  const refusal = /no active sender binding.*stop reviewer:orders --task .*replacement/i;
  if (phase === 'before plan') {
    revoke();
    assert.throws(() => planReview(host, opts), refusal);
  } else if (phase === 'before publication') {
    const prepare = opencodeDriver.prepare;
    t.mock.method(opencodeDriver, 'prepare', function (...args) { const result = prepare.apply(this, args); revoke(); return result; });
    await assert.rejects(review(host, opts), refusal);
  } else {
    const result = await review(host, opts);
    assert.equal(result.reuse, true);
    const after = evidence();
    assert.notEqual(after.assignment, before.assignment);
    assert.equal(after.messages.length, before.messages.length + 1);
    assert.equal(after.inbox, before.inbox + 1);
    return;
  }
  assert.deepEqual(evidence(), before);
});
