import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { scheduled, receipt } from './fixture-order.mjs';
import { makeSandbox } from './sandbox.mjs';
import { waitDelivered } from './delivery-wait.mjs';
import { REVIEW_ROUND_TURN, REVIEWER_SCRIPT, WORKER_SCRIPT } from './scenario.mjs';

const root = makeSandbox('promptobus-test-delivery-wait-');
const home = path.join(root, 'bus');
const task = 'delivery-wait-t20261027-000001';
const address = 'worker:e2e';
const watchdog = (scheduled('paused-observer') || scheduled('logical-polls')) && setTimeout(() => {
  throw new Error('delivery wait experiment did not finish within 10 seconds');
}, 10000);
const file = path.join(home, 'tasks', task, 'health.json');
mkdirSync(path.dirname(file), { recursive: true });

function writeMark(at) {
  writeFileSync(file, `${JSON.stringify({ [address]: { deliveredAt: at } })}\n`);
}

async function pauseObserver(kind, result, started, bound) {
  receipt(`${kind}: wait returned`, { result, elapsedMs: Date.now() - started });
  await new Promise(resolve => setTimeout(resolve, Math.max(0, started + bound + 1 - Date.now())));
  receipt(`${kind}: controller samples elapsed`, { elapsedMs: Date.now() - started });
}

if (scheduled('logical-polls')) {
  for (const phase of ['update', 'torn', 'deadline']) {
    const before = '2026-10-27T12:00:03.000Z', after = '2026-10-27T12:00:04.000Z';
    writeMark(before);
    let time = 0;
    const result = await waitDelivered(home, task, address, 60, { clock: () => time, poll: async () => {
      time += 20;
      if (time > 60) throw new Error(`${phase}: exceeded three polls`);
      if (phase === 'torn' && time === 20) writeFileSync(file, '{');
      if (phase !== 'deadline' && time === 40) writeMark(after);
      receipt(`${phase}: next poll`, { time, bytes: readFileSync(file, 'utf8') });
    } });
    receipt(`${phase}: result`, { time, result });
    check(`logical polls: ${phase}`, phase === 'deadline'
      ? time === 60 && !result.ok && result.note.includes(file) && result.note.includes(address)
      : time === 40 && result.ok && result.deliveredAt === after, JSON.stringify(result));
  }
}

{
  writeMark('2026-10-27T12:00:00.000Z');
  const started = Date.now();
  setTimeout(() => writeMark('2026-10-27T12:00:01.000Z'), 80);
  const marked = await waitDelivered(home, task, address, 2_000);
  if (scheduled('paused-observer')) await pauseObserver('update', marked, started, 1500);
  check('a newer deliveredAt ends the wait before the timeout',
    marked.ok === true && marked.deliveredAt === '2026-10-27T12:00:01.000Z' && Date.now() - started < 1_500,
    JSON.stringify(marked));
}

{
  writeFileSync(file, '{');
  const started = Date.now();
  setTimeout(() => writeMark('2026-10-27T12:00:02.000Z'), 80);
  const marked = await waitDelivered(home, task, address, 2_000);
  if (scheduled('paused-observer')) await pauseObserver('torn', marked, started, 1500);
  check('a torn health file is retried until it parses and the mark is newer',
    marked.ok === true && marked.deliveredAt === '2026-10-27T12:00:02.000Z' && Date.now() - started < 1_500,
    JSON.stringify(marked));
}

{
  writeMark('2026-10-27T12:00:03.000Z');
  const started = Date.now();
  const missed = await waitDelivered(home, task, address, 200);
  if (scheduled('paused-observer')) await pauseObserver('deadline', missed, started, 1000);
  check('a delivery mark that never moves names the health file and the timeout',
    missed.ok === false && missed.note?.includes(`TIMEOUT after 200 ms waiting for ${file}`)
      && missed.note.includes(address) && Date.now() - started >= 200 && Date.now() - started < 1_000,
    JSON.stringify(missed));
}

{
  const none = await waitDelivered('', task, address, 50);
  check('a wait with no bus home does not invent a file',
    none.ok === false && none.file === null && none.note === 'no health file to wait on',
    JSON.stringify(none));
}

const here = path.dirname(fileURLToPath(import.meta.url));
const text = (name) => readFileSync(path.join(here, name), 'utf8');
const scenario = text('scenario.mjs');
const wake = text('promptobus-cursor-wake.test.mjs');
const stands = ['participant.mjs', 'harness-cursor.mjs', 'harness-codex.mjs'].map(text);
check('a fetch-then-send pause polls for the delivery mark, and a busy hold awaits explicit release',
  (scenario.match(/untilDelivered: TURN_PAUSE_MS/g) ?? []).length === 3
  && !scenario.includes('{ wait: TURN_PAUSE_MS }')
  && wake.includes('{ untilFile: RELEASE_FILE }') && !wake.includes('untilDelivered')
  && stands.every((src) => src.includes('action.untilDelivered') && src.includes('waitDelivered(')
    && src.includes('action.wait') && src.includes('setTimeout(r, action.wait)')),
  'a fetch-then-send pause is a sleep, or a busy hold does not await explicit release');

const waits = (turn) => turn.do.some((action) => action.untilDelivered);
const launched = [WORKER_SCRIPT.turns[0], REVIEWER_SCRIPT.turns[0]];
const knocked = [WORKER_SCRIPT.turns[1], WORKER_SCRIPT.turns[2], REVIEW_ROUND_TURN];
check('a turn started at launch sends without a delivery wait, and every knocked fetch-then-send turn waits for the mark',
  launched.every((turn) => !waits(turn)) && knocked.every(waits),
  JSON.stringify({ launched: launched.map(waits), knocked: knocked.map(waits) }));
if (watchdog) clearTimeout(watchdog);
