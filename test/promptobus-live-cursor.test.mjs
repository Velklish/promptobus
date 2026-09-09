// Regression probe for the live Cursor review verdict. Run: npm test
//
// The live script is intentionally not imported: importing it starts a real Cursor
// session. The probe uses the same v1 store records and checks the script's step-5
// matcher in place, so the live run remains outside the suite.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import { REVIEWER, sentBy, store, WORKER } from './scenario.mjs';

const SB = makeSandbox('promptobus-promptobus-live-cursor-');
const home = path.join(SB, 'matcher', '.promptobus');
const task = 'livecursormatcher-t20260909-000000';
store.createTask(home, { id: task, title: 'live Cursor review matcher' });
for (const [type, body] of [
  ['status', 'LIVE-CURSOR-HELLO: worker started'],
  ['result', 'LIVE-CURSOR-WOKE: worker wake result'],
  ['result', 'LIVE-CURSOR-PAIR-A: worker pair result'],
  ['result', 'LIVE-CURSOR-PAIR-B: worker pair result'],
]) {
  store.sendMessage(home, task, { from: WORKER, to: 'orchestrator', type, body });
}

const messages = store.glanceInbox(home, task, 'orchestrator');
const here = path.dirname(fileURLToPath(import.meta.url));
const liveCursor = readFileSync(path.join(here, '..', 'scripts', 'live-cursor.mjs'), 'utf8');
const step5 = liveCursor.slice(liveCursor.indexOf('const reviewSaid'), liveCursor.indexOf("check('step 5: the Cursor reviewer report"));
check('live-cursor step 5 matcher requires the reviewer sender',
  /sentBy\(m, REVIEWER\)\s*&&\s*m\.type === 'result'/.test(step5), step5);

const reviewSaid = messages
  .filter((m) => sentBy(m, REVIEWER) && m.type === 'result')
  .pop() ?? null;
check('live-cursor review matcher ignores four earlier worker messages',
  reviewSaid === null && messages.every((m) => !sentBy(m, REVIEWER)), JSON.stringify(messages));
