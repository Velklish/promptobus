// Piece placement, the one rule the digest and the BB native panel board both read.
import { check } from './check.mjs';

const { currentResult, piecesOf } = await import('../dist/index.js');

const AFTER = '20261119T000000000-0000-000000';
const id = (n) => `20261119T0000000${String(n).padStart(2, '0')}-0000-00000${n % 10}`;
const participant = (address, assignmentAfterId = AFTER) => ({
  id: address.replace(':', '-'), role: address.split(':')[0], harness: 'bb', mode: 'managed', sessionRef: null,
  metadata: { address, assignmentAfterId },
});
const message = (n, sender, type, recipients = ['orchestrator']) => ({ id: id(n), sender, type, recipients });
const STEPS = ['worker', 'reviewer', 'approver'];
const placed = (participants, messages, steps = STEPS) =>
  Object.fromEntries(piecesOf(participants, messages, steps).map((piece) => [piece.slug, piece.step]));

const people = [
  participant('orchestrator'), participant('worker:alpha'),
  participant('worker:beta'), participant('reviewer:beta'),
  participant('worker:gamma'), participant('reviewer:gamma'), participant('approver:gamma'),
  participant('reviewer:solo'),
];
const journal = [
  message(1, 'worker-beta', 'result'),
  message(2, 'worker-gamma', 'result'), message(3, 'reviewer-gamma', 'result'), message(4, 'approver-gamma', 'result'),
];
const where = placed(people, journal);
check('a piece without a worker result stays at the worker step', where.alpha === 'worker', JSON.stringify(where));
check('a piece whose worker reported is held by its reviewer', where.beta === 'reviewer', JSON.stringify(where));
check('a piece the approver accepted is done', where.gamma === null, JSON.stringify(where));
check('a standalone review starts at the reviewer step', where.solo === 'reviewer', JSON.stringify(where));
check('governance addresses are no pieces', !('orchestrator' in where) && Object.keys(where).length === 4, JSON.stringify(where));

const order = piecesOf(people, journal, STEPS).map((piece) => piece.slug);
check('pieces sort by step with done last', JSON.stringify(order) === JSON.stringify(['alpha', 'beta', 'solo', 'gamma']),
  JSON.stringify(order));
const gamma = piecesOf(people, journal, STEPS).find((piece) => piece.slug === 'gamma');
check('a piece names its participant per step in pipeline order',
  JSON.stringify(gamma.participants) === JSON.stringify([
    { step: 'worker', id: 'worker-gamma' }, { step: 'reviewer', id: 'reviewer-gamma' }, { step: 'approver', id: 'approver-gamma' }]),
  JSON.stringify(gamma.participants));

const reassigned = [...journal, message(5, 'orchestrator', 'task', ['worker-beta'])];
check('a new assignment after the result returns the piece to its step', placed(people, reassigned).beta === 'worker',
  JSON.stringify(placed(people, reassigned)));

const declared = [participant('worker:delta'), participant('security:delta'), participant('approver:delta')];
const declaredJournal = [message(1, 'worker-delta', 'result')];
check('a step the shipped pipeline does not know holds a piece when the steps name it',
  placed(declared, declaredJournal, ['worker', 'security', 'approver']).delta === 'security',
  JSON.stringify(placed(declared, declaredJournal, ['worker', 'security', 'approver'])));
check('an address whose prefix is not a given step is no piece',
  placed([participant('security:only')], [], STEPS).only === undefined);

check('a participant without a valid boundary has no current result',
  currentResult(participant('worker:x', null), [message(1, 'worker-x', 'result')]) === null
    && currentResult(participant('worker:x', 'bogus'), [message(1, 'worker-x', 'result')]) === null);
check('the current result is the newest one after the boundary',
  currentResult(participant('worker:x'), [message(1, 'worker-x', 'result'), message(2, 'worker-x', 'result')])?.id === id(2));
