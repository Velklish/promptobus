import './home.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scheduled, receipt } from './fixture-order.mjs';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import { deliveryBarrier, waitDelivered } from './delivery-wait.mjs';
import { REVIEW_ROUND_TURN, REVIEWER_SCRIPT, WORKER_SCRIPT, store } from './scenario.mjs';
import { createRegistry, lastActivation, stallStands, supervisorRound } from '../dist/index.js';

const root = makeSandbox('promptobus-test-delivery-wait-');
const home = path.join(root, 'bus');
const task = 'delivery-wait-t20261027-000001';
const address = 'worker:e2e';
const file = path.join(home, 'tasks', task, 'health.json');
mkdirSync(path.dirname(file), { recursive: true });

function writeMark(at) {
  writeFileSync(file, `${JSON.stringify({ [address]: { deliveredAt: at } })}\n`);
}

const watchdog = setTimeout(() => { throw new Error('delivery wait experiment exceeded 10 seconds'); }, 10_000);
const before = '2026-10-27T12:00:03.000Z', after = '2026-10-27T12:00:04.000Z';
async function pauseObserver(kind, result, started, bound) {
  receipt(`${kind}: wait returned`, { result, elapsedMs: Date.now() - started });
  await new Promise(resolve => setTimeout(resolve, Math.max(0, started + bound + 1 - Date.now())));
  receipt(`${kind}: controller samples elapsed`, { elapsedMs: Date.now() - started });
}

if (!scheduled('paused-observer')) {
for (const phase of ['update', 'torn', 'deadline', 'absent', 'unreadable']) {
  writeMark(before);
  if (phase === 'absent') writeFileSync(file, '{}');
  if (phase === 'unreadable') writeFileSync(file, '{');
  let time = 0;
  const result = await waitDelivered(home, task, address, 60, { clock: () => time, poll: async () => {
    time += 20;
    if (time > 60) throw new Error(`${phase}: exceeded three polls`);
    if (phase === 'torn' && time === 20) writeFileSync(file, '{');
    if (time === 40 && !['unreadable', 'deadline'].includes(phase)) writeMark(after);
  } });
  const timeout = `TIMEOUT after 60 ms waiting for ${file}`;
  check(`logical polls: ${phase}`, phase === 'unreadable'
    ? time === 60 && !result.ok && result.note.includes(`${timeout} — no readable deliveredAt baseline`) && result.note.includes(address)
    : phase === 'deadline' ? time === 60 && !result.ok && result.note.includes(timeout) && result.note.includes(address)
      : time === 40 && result.ok && result.deliveredAt === after, JSON.stringify({ time, result }));
}

for (const publishNew of [false, true]) {
  writeFileSync(file, '{');
  let time = 0;
  const barrier = await deliveryBarrier(home, task, address, 60, { clock: () => time, poll: async () => {
    time += 20;
    if (time > 60) throw new Error('initially torn: exceeded three polls');
    if (time === 20) writeMark(before);
    if (time === 40 && publishNew) writeMark(after);
  } });
  const takeAt = barrier.ok ? time : null;
  const result = barrier.ok ? await barrier.wait() : barrier;
  const replyAt = result.ok ? time : null;
  check(publishNew ? 'logical polls: restore old mark before fetch, then allow a reply only on new delivery'
    : 'logical polls: restoring only the old mark never lets the stand reply',
  barrier.deliveredAt === before && takeAt === 20
    && (publishNew ? replyAt === 40 && result.deliveredAt === after
      : time === 60 && replyAt === null && result.deliveredAt === before && result.note.includes('newer deliveredAt')),
  JSON.stringify({ time, takeAt, replyAt, result }));
}

} else {
{
  writeMark('2026-10-27T12:00:00.000Z');
  const started = Date.now();
  setTimeout(() => writeMark('2026-10-27T12:00:01.000Z'), 80);
  const marked = await waitDelivered(home, task, address, 2_000);
  await pauseObserver('update', marked, started, 1500);
  check('a newer deliveredAt ends the wait before the timeout',
    marked.ok === true && marked.deliveredAt === '2026-10-27T12:00:01.000Z' && Date.now() - started < 1_500,
    JSON.stringify(marked));
}

{
  writeMark(before);
  setTimeout(() => writeFileSync(file, '{'), 10);
  const started = Date.now();
  setTimeout(() => writeMark('2026-10-27T12:00:02.000Z'), 80);
  const marked = await waitDelivered(home, task, address, 2_000);
  await pauseObserver('torn', marked, started, 1500);
  check('a torn health file is retried until it parses and the mark is newer',
    marked.ok === true && marked.deliveredAt === '2026-10-27T12:00:02.000Z' && Date.now() - started < 1_500,
    JSON.stringify(marked));
}

{
  writeMark('2026-10-27T12:00:03.000Z');
  const started = Date.now();
  const missed = await waitDelivered(home, task, address, 200);
  await pauseObserver('deadline', missed, started, 1000);
  check('a delivery mark that never moves names the health file and the timeout',
    missed.ok === false && missed.note?.includes(`TIMEOUT after 200 ms waiting for ${file}`)
      && missed.note.includes(address) && Date.now() - started >= 200 && Date.now() - started < 1_000,
    JSON.stringify(missed));
}
}

{
  const none = await waitDelivered('', task, address, 50);
  check('a wait with no bus home does not invent a file',
    none.ok === false && none.file === null && none.note === 'no health file to wait on',
    JSON.stringify(none));
}

const registry = createRegistry({ drivers: { fake: {
  id: 'fake', capabilities: { activation: 'push' }, activate: async () => ({ ok: true }),
} }, fallback: 'fake' });
const ownHome = path.join(root, 'warden');
const stall = { kind: 'unknown', reason: 'turn yielded' };
for (const [i, holdRound] of [false, true].entries()) {
  const id = `barrier-t20261027-00000${i + 1}`;
  store.createTask(ownHome, { id, title: 'Delivery barrier' });
  const participant = store.participantRecord(address, { harness: 'fake', sessionRef: 'fixture' });
  store.upsertParticipant(ownHome, id, participant);
  store.writeWake(ownHome, id, address, { socket: path.join(root, 'unused.sock') });
  const mail = store.sendMessage(ownHome, id, { from: 'orchestrator', to: address, type: 'review', body: 'review note' });
  const knock = await supervisorRound(ownHome, id, { registry });
  const barrier = await deliveryBarrier(ownHome, id, address, 500);
  if (!barrier.ok) throw new Error(barrier.note);
  const taken = store.readInbox(ownHome, id, address).messages;
  const reply = () => store.sendMessage(ownHome, id, { from: address, to: 'orchestrator', type: 'result', body: 'reply' });
  const legacy = holdRound ? reply() : null;
  const priorSend = store.lastSentAt(ownHome, id, address);
  const roundAt = holdRound ? priorSend + 20 : Date.now() - 1;
  const delivery = await supervisorRound(ownHome, id, { registry, now: roundAt });
  const confirmed = await barrier.wait();
  if (!holdRound && confirmed.ok) reply();
  const sent = store.lastSentAt(ownHome, id, address);
  const since = lastActivation(ownHome, id, participant);
  const predicate = stallStands(ownHome, id, participant, stall);
  const evidence = { knocked: knock.knocked, delivered: delivery.events, mailbox: taken.map(m => m.id),
    deliveryAt: confirmed.deliveredAt, sent, since, predicate };
  console.log(`  ${holdRound ? 'reply-first control' : 'delivery-first control'}: ${JSON.stringify(evidence)}`);
  check(holdRound ? 'reply-first control is a late delivery, not a second knock or a predicate defect'
    : 'the barrier accepts the round persisted between mailbox take and entering the wait',
  knock.knocked.includes(address) && taken.some(m => m.id === mail.message.id)
    && delivery.events.some(e => e.startsWith(`delivered ${address}:`)) && delivery.knocked.length === 0
    && confirmed.ok && confirmed.deliveredAt === new Date(roundAt).toISOString() && since === roundAt
    && (holdRound ? legacy && sent < since && predicate : sent >= since && !predicate), JSON.stringify(evidence));
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
  && stands.every((src) => src.includes('action.untilDelivered') && src.includes('deliveryBarrier(')
    && src.includes('action.wait') && src.includes('setTimeout(r, action.wait)')),
  'a fetch-then-send pause is a sleep, or a busy hold does not await explicit release');

const waits = (turn) => turn.do.some((action) => action.untilDelivered);
const launched = [WORKER_SCRIPT.turns[0], REVIEWER_SCRIPT.turns[0]];
const knocked = [WORKER_SCRIPT.turns[1], WORKER_SCRIPT.turns[2], REVIEW_ROUND_TURN];
check('a turn started at launch sends without a delivery wait, and every knocked fetch-then-send turn waits for the mark',
  launched.every((turn) => !waits(turn)) && knocked.every(waits),
  JSON.stringify({ launched: launched.map(waits), knocked: knocked.map(waits) }));
clearTimeout(watchdog);
