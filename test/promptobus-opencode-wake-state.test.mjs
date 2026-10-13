import { check } from './check.mjs';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeSandbox } from './sandbox.mjs';
import { activate } from '../lib/driver-opencode.js';

const SB = makeSandbox('promptobus-driver-opencode-');
const file = path.join(SB, 'wake.json');
writeFileSync(file, JSON.stringify({ holderPid: process.pid, url: 'http://127.0.0.1:12345', password: 'fixture', sessionId: 'fixture' }));
const notification = { task: 'wake-state-t20261013-140000', address: 'worker:fixture', unread: 1, messages: [] };
const originalFetch = globalThis.fetch;
const idle = [{ type: 'idle', outcome: 'succeeded' }];
const busy = [{ type: 'assistant' }];
const cases = [
  ['HTTP 500', 500, { error: 'unreadable' }, false],
  ['HTTP 500 with idle payload', 500, { data: idle }, false],
  ['malformed JSON', 200, '{', false],
  ['null payload', 200, null, false],
  ['object without message list', 200, { data: {} }, false],
  ['empty bare list', 200, [], false],
  ['empty wrapped list', 200, { data: [] }, false],
  ['malformed newest message', 200, { data: [null] }, false],
  ['busy wrapped list', 200, { data: busy }, false],
  ['busy bare list', 200, busy, false],
  ['idle wrapped list', 200, { data: idle }, true],
  ['idle bare list', 200, idle, true],
  ['rejected state request', 200, { data: idle }, false],
  ['rejected follow-up status', 200, { data: idle }, false],
];
try {
  for (const [name, status, body, admitted] of cases) {
    let posts = 0;
    globalThis.fetch = async (url, options) => {
      if (options.method === 'GET') {
        if (name === 'rejected state request') throw new Error('connection rejected');
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
      }
      posts += 1;
      return new Response('{}', { status: name === 'rejected follow-up status' ? 500 : 200 });
    };
    let outcome;
    let thrown;
    try { outcome = await activate({ endpoint: { socket: file } }, notification); }
    catch (error) { thrown = error.message; }
    const expectedPosts = admitted || name === 'rejected follow-up status' ? 1 : 0;
    check(`: OpenCode wake ${name} ${admitted ? 'posts one proven-idle turn' : 'refuses without an extra turn'}`,
      outcome?.ok === admitted && posts === expectedPosts && !thrown,
      JSON.stringify({ outcome, posts, expectedPosts, thrown }));
  }
} finally { globalThis.fetch = originalFetch; }
