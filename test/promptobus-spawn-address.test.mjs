import { check } from './check.mjs';
import { refuseParticipantPrefix } from '../lib/spawn.js';
import { reviewerFor } from '../lib/review.js';
import { GateError, participantRecord } from '../lib/store.js';
import { SHIPPED_REGISTRY } from '../dist/index.js';

const unaddressed = (address) => {
  const record = participantRecord('worker:unaddressed');
  record.metadata.address = address;
  return record;
};

for (const address of [null, undefined, '', 42]) {
  let slug;
  let failure;
  try {
    slug = refuseParticipantPrefix('orders-api', 'Choose another worker.', SHIPPED_REGISTRY,
      [unaddressed(address)]);
  } catch (error) { failure = error; }
  check(`spawn: prefix scan skips an address read as null (${String(address)})`,
    slug === 'orders-api' && !failure, failure?.stack ?? String(slug));
}

const retiredReviewer = { ...SHIPPED_REGISTRY, activeSteps: ['worker'] };
let collision;
try {
  refuseParticipantPrefix('reviewer-orders-api', 'Choose another worker.', retiredReviewer,
    [unaddressed(null), participantRecord('reviewer:orders-api')]);
} catch (error) { collision = error; }
check('spawn: an unaddressed record does not hide a later sidecar collision',
  collision instanceof GateError && /existing participant reviewer:orders-api/.test(collision.message),
  collision?.stack ?? 'no refusal');

let reserved;
try {
  refuseParticipantPrefix('reviewer-orders-api', 'Choose another worker.', SHIPPED_REGISTRY,
    [unaddressed(null)]);
} catch (error) { reserved = error; }
check('spawn: an unaddressed record preserves the declared reviewer prefix refusal',
  reserved instanceof GateError && /prefix is taken by the reviewer/.test(reserved.message),
  reserved?.stack ?? 'no refusal');

const review = reviewerFor({ name: 'worker', kind: 'edits-tree' },
  { participants: [unaddressed(null)] }, process.cwd(), { abs: process.cwd() });
check('review: an unaddressed unrelated record does not own the subject',
  review.owner === null && review.address.startsWith('reviewer:'), JSON.stringify(review));
