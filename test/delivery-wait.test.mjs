import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import { waitDelivered } from './delivery-wait.mjs';

const root = makeSandbox('promptobus-test-delivery-wait-');
const home = path.join(root, 'bus');
const task = 'delivery-wait-t20261027-000001';
const address = 'worker:e2e';
const file = path.join(home, 'tasks', task, 'health.json');
mkdirSync(path.dirname(file), { recursive: true });

function writeMark(at) {
  writeFileSync(file, `${JSON.stringify({ [address]: { deliveredAt: at } })}\n`);
}

{
  writeMark('2026-10-27T12:00:00.000Z');
  const started = Date.now();
  setTimeout(() => writeMark('2026-10-27T12:00:01.000Z'), 80);
  const marked = await waitDelivered(home, task, address, 2_000);
  check('a newer deliveredAt ends the wait before the timeout',
    marked.ok === true && marked.deliveredAt === '2026-10-27T12:00:01.000Z' && Date.now() - started < 1_500,
    JSON.stringify(marked));
}

{
  writeFileSync(file, '{');
  const started = Date.now();
  setTimeout(() => writeMark('2026-10-27T12:00:02.000Z'), 80);
  const marked = await waitDelivered(home, task, address, 2_000);
  check('a torn health file is retried until it parses and the mark is newer',
    marked.ok === true && marked.deliveredAt === '2026-10-27T12:00:02.000Z' && Date.now() - started < 1_500,
    JSON.stringify(marked));
}

{
  writeMark('2026-10-27T12:00:03.000Z');
  const started = Date.now();
  const missed = await waitDelivered(home, task, address, 200);
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
check('a fetch-then-send pause polls for the delivery mark, and a busy hold stays a sleep',
  (scenario.match(/untilDelivered: TURN_PAUSE_MS/g) ?? []).length === 4
  && !scenario.includes('{ wait: TURN_PAUSE_MS }')
  && wake.includes('{ wait: TURN_HOLD_MS }') && !wake.includes('untilDelivered')
  && stands.every((src) => src.includes('action.untilDelivered') && src.includes('waitDelivered(')
    && src.includes('action.wait') && src.includes('setTimeout(r, action.wait)')),
  'a fetch-then-send pause is a sleep, or a busy hold ends on the delivery stamp');
