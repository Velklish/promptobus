import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import { notificationMark, store, WORKER } from './scenario.mjs';

const home = path.join(makeSandbox('promptobus-promptobus-delivery-'), '.promptobus');
const task = 'delivery-t20261102-000001';
store.createTask(home, { id: task, title: 'Delivery before first wake contact' });
const participant = sessionId => store.participantRecord(WORKER,
  { harness: 'cursor', mode: 'managed', sessionRef: 'fixture-worker', sessionId });
store.upsertParticipant(home, task, participant('first-native-session'));
const before = notificationMark(home, task, WORKER);
check('delivery snapshot retains the bound native identity before the first wake contact exists',
  store.readWake(home, task, WORKER) === null && before.session === 'first-native-session');

store.writeWake(home, task, WORKER, { socket: 'fixture-worker#1', token: null, session: 'first-native-session' });
check('the actual first wake contact matches the earlier participant identity snapshot',
  notificationMark(home, task, WORKER).session === before.session);

store.upsertParticipant(home, task, participant('replacement-native-session'));
check('an old wake contact cannot substitute for the currently bound native identity',
  notificationMark(home, task, WORKER).session === 'replacement-native-session'
    && store.readWake(home, task, WORKER).session === before.session);
