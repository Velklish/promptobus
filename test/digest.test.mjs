import './home.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { check } from './check.mjs';
import { capture } from './console.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

const ROOT = makeSandbox('promptobus-digest-');
writeHostConfig(ROOT);
const store = await import('../lib/store.js');
const { hostOf } = await import('../lib/host.js');
const { buildDigest, digest } = await import('../lib/digest.js');
const { runPromptobus } = await import('../lib/cli.js');
const { writeStalls } = await import('../dist/index.js');
const host = hostOf(ROOT);
const HOME = store.promptobusHome(ROOT, host);
const ROOT_TASK = 'digest-root-t20260926-120000';
const CHILD_A = 'digest-child-a-t20260926-120000';
const CHILD_B = 'digest-child-b-t20260926-120000';
const SENT_AT = '2026-09-26T12:00:00.000Z';
const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const sequence = new Map();

function put(task, from, to, type, body, ts = SENT_AT) {
  const next = (sequence.get(task) ?? 0) + 1;
  sequence.set(task, next);
  const stamp = `${ts.slice(0, 10).replaceAll('-', '')}T${ts.slice(11, 23).replaceAll(':', '').replace('.', '')}`;
  const id = `${stamp}-${String(next).padStart(4, '0')}-abcdef`;
  const record = {
    protocolVersion: 1, id, task, sender: store.addrDir(from),
    recipients: [store.addrDir(to)], type, body, ts,
  };
  const dir = store.messagesDir(HOME, task);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

store.createTask(HOME, { id: ROOT_TASK, title: 'Root', owner: 'root-session', adapter: { slug: 'root' } });
store.createTask(HOME, {
  id: CHILD_A, title: 'Child A', owner: 'child-a-session', parent: ROOT_TASK,
  adapter: { slug: 'child-a' }, teamlead: 'teamlead:child-a',
});
store.createTask(HOME, {
  id: CHILD_B, title: 'Child B', owner: 'child-b-session', parent: ROOT_TASK,
  adapter: { slug: 'child-b' }, teamlead: 'teamlead:child-b',
});
store.upsertParticipant(HOME, ROOT_TASK, store.participantRecord('user'));
store.upsertParticipant(HOME, CHILD_A, store.participantRecord('user'));
store.upsertParticipant(HOME, CHILD_B, store.participantRecord('user'));

const pieces = Array.from({ length: 33 }, (_, i) => `p${String(i).padStart(2, '0')}`);
for (let i = 0; i < pieces.length; i += 1) {
  const slug = pieces[i];
  store.upsertParticipant(HOME, ROOT_TASK, store.participantRecord(`worker:${slug}`));
  if (i >= 11) store.upsertParticipant(HOME, ROOT_TASK, store.participantRecord(`reviewer:${slug}`));
  if (i >= 22) store.upsertParticipant(HOME, ROOT_TASK, store.participantRecord(`approver:${slug}`));
}

for (let i = 0; i < 86; i += 1) {
  const from = i < 9 ? 'user' : `worker:${pieces[i % pieces.length]}`;
  put(ROOT_TASK, from, 'orchestrator', 'question', `question ${i}`);
}
for (let i = 0; i < 329; i += 1) {
  put(ROOT_TASK, `worker:${pieces[i % pieces.length]}`, 'orchestrator', 'status',
    `${i === 328 ? '\n\n' : ''}status ${i}\nPRIVATE STATUS BODY ${i}`);
}
for (let i = 11; i < pieces.length; i += 1) {
  put(ROOT_TASK, `worker:${pieces[i]}`, 'orchestrator', 'result', `worker result ${i}`);
  if (i >= 22) put(ROOT_TASK, `reviewer:${pieces[i]}`, 'orchestrator', 'result', `reviewer result ${i}`);
}
put(CHILD_A, 'user', 'orchestrator', 'question', 'answered child question');
put(CHILD_A, 'orchestrator', 'user', 'answer', 'child answer');
put(CHILD_B, 'user', 'orchestrator', 'question', 'open child question');
store.writeHealth(HOME, ROOT_TASK, {
  'worker:p00': { since: SENT_AT, escalatedAt: SENT_AT },
});
writeStalls(HOME, ROOT_TASK, { 'worker:p01': { reason: 'waiting for the holder', at: SENT_AT } });

const headerReads = [];
const headers = store.withMessageReadHook((read) => headerReads.push(read),
  () => store.taskMessageHeaders(HOME, ROOT_TASK));
check('header projection does not open any body',
  headers.length === sequence.get(ROOT_TASK) && headerReads.length === 0
    && headers.every((header) => header.task === ROOT_TASK && !Object.hasOwn(header, 'body')),
  `${headers.length} headers, ${headerReads.length} body accesses`);

const reads = [];
const page = store.withMessageReadHook((read) => reads.push(read),
  () => buildDigest(host, { task: ROOT_TASK, now: NOW }));
const statusReads = reads.filter((read) => read.type === 'status');
check('digest reads each status only through the first-line accessor',
  statusReads.length === 329 && statusReads.every((read) => read.purpose === 'firstLine'),
  `${statusReads.length} status body accesses; ${statusReads.filter((read) => read.purpose !== 'firstLine').length} beyond first line`);
check('generated journal exposes all 33 pieces at their current pipeline steps',
  page.tasks[0].pieces.length === 33
    && page.tasks[0].pieces.filter((piece) => piece.step === 'worker').length === 11
    && page.tasks[0].pieces.filter((piece) => piece.step === 'reviewer').length === 11
    && page.tasks[0].pieces.filter((piece) => piece.step === 'approver').length === 11);
check('all 86 open questions have an addressee and age, with user questions first',
  page.tasks[0].questions.length === 86
    && page.tasks[0].questions.slice(0, 9).every((question) => question.from === 'user')
    && page.tasks[0].questions.every((question) => question.to === 'orchestrator'
      && question.ageSeconds === 86400));
check('all 329 status messages yield one latest first line per sending participant',
  page.tasks[0].participants.filter((participant) => participant.address.startsWith('worker:'))
    .every((participant) => participant.lastStatus?.firstLine.startsWith('status ')
      && participant.lastStatus.ageSeconds === 86400)
    && page.tasks[0].participants.find((participant) => participant.address === 'worker:p31')
      ?.lastStatus.firstLine === 'status 328');
check('status first lines exclude every later body line',
  !JSON.stringify(page).includes('PRIVATE STATUS BODY'));
check('root and two children appear in tree order; answered child question is closed',
  page.tasks.map((task) => task.id).join(',') === [ROOT_TASK, CHILD_A, CHILD_B].join(',')
    && page.tasks[1].questions.length === 0 && page.tasks[2].questions.length === 1);
check('--task on a child selects its whole root tree',
  buildDigest(host, { task: CHILD_A, now: NOW }).tasks.map((task) => task.id).join(',')
    === [ROOT_TASK, CHILD_A, CHILD_B].join(','));
check('digest reuses persisted stall, SILENT and user UNANSWERED states',
  page.tasks[0].participants.find((p) => p.address === 'worker:p01')?.stall?.reason === 'waiting for the holder'
    && page.tasks[0].participants.find((p) => p.address === 'worker:p00')?.silent?.since === SENT_AT
    && page.tasks[0].participants.find((p) => p.address === 'orchestrator')?.unanswered?.since === SENT_AT);

const printed = capture(() => digest(host, { task: ROOT_TASK, now: NOW }));
const lines = printed.split('\n');
const groups = new Map(['worker', 'reviewer', 'approver'].map((step) => [step,
  lines.find((line) => line.trimStart().startsWith(`${step}: `)) ?? '',
]));
check('text prints every piece and question, all three blocks and the state words',
  page.tasks[0].pieces.every((piece) => groups.get(piece.step)?.includes(piece.slug))
    && Array.from({ length: 86 }, (_, i) => `question ${i}`).every((question) => printed.includes(question))
    && printed.indexOf(ROOT_TASK) < printed.indexOf(CHILD_A)
    && printed.indexOf(CHILD_A) < printed.indexOf(CHILD_B)
    && printed.includes('question user → orchestrator · 1d ago: question 0')
    && printed.includes('status 1d ago: status 328')
    && /STALLED/.test(printed) && /SILENT/.test(printed) && /UNANSWERED/.test(printed)
    && !printed.includes('PRIVATE STATUS BODY'), printed.slice(0, 300));

const schema = JSON.parse(readFileSync(new URL('../schemas/v1/digest.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv2020({ strict: false }).compile(schema);
const json = JSON.parse(capture(() => digest(host, { task: ROOT_TASK, now: NOW, json: true })));
check('--json validates against the digest schema and matches the text page',
  validate(json) && JSON.stringify(json) === JSON.stringify(page),
  JSON.stringify(validate.errors ?? []));
let cliExit;
const cliJson = JSON.parse(await capture(async () => {
  cliExit = await runPromptobus(['digest', '--task', ROOT_TASK, '--json'], {
    host, cwd: ROOT, env: { ...process.env, PROMPTOBUS_WARDEN: 'off' },
  });
}));
check('the CLI dispatches digest --json to the same schema-valid page',
  cliExit === 0 && validate(cliJson) && cliJson.tasks.length === 3
    && cliJson.tasks[0].pieces.length === 33, JSON.stringify(validate.errors ?? []));

const assignment = '2026-09-26T12:00:01.000Z';
const formerStep = buildDigest(host, { task: ROOT_TASK, now: NOW }).tasks[0]
  .pieces.find((piece) => piece.slug === 'p22')?.step;
store.upsertParticipant(HOME, ROOT_TASK, store.participantRecord('reviewer:p22', {
  started: assignment, reviewAssignedAt: assignment,
}));
store.upsertParticipant(HOME, ROOT_TASK, store.participantRecord('reviewer:p23', {
  started: assignment,
}));
const relaunched = buildDigest(host, { task: ROOT_TASK, now: NOW }).tasks[0].pieces;
put(ROOT_TASK, 'reviewer:p22', 'orchestrator', 'result', 'new review result',
  '2026-09-26T12:00:02.000Z');
const afterResult = buildDigest(host, { task: ROOT_TASK, now: NOW }).tasks[0].pieces;
check('a relaunched reviewer holds its piece until a result after its assignment',
  formerStep === 'approver'
    && relaunched.find((piece) => piece.slug === 'p22')?.step === 'reviewer'
    && relaunched.find((piece) => piece.slug === 'p23')?.step === 'reviewer'
    && afterResult.find((piece) => piece.slug === 'p22')?.step === 'approver',
  JSON.stringify({ formerStep, held22: relaunched.find((piece) => piece.slug === 'p22')?.step,
    held23: relaunched.find((piece) => piece.slug === 'p23')?.step,
    after: afterResult.find((piece) => piece.slug === 'p22')?.step }));

const SOLO = 'digest-solo-t20260926-120000';
store.createTask(HOME, { id: SOLO, title: 'Standalone review', owner: 'solo-owner',
  adapter: { slug: 'solo' } });
store.upsertParticipant(HOME, SOLO, store.participantRecord('reviewer:solo', {
  started: SENT_AT, reviewAssignedAt: SENT_AT,
}));
const standalone = buildDigest(host, { task: SOLO, now: NOW }).tasks[0];
check('a standalone review starts at its recorded reviewer step',
  !standalone.participants.some((participant) => participant.address.startsWith('worker:'))
    && standalone.pieces.length === 1 && standalone.pieces[0].slug === 'solo'
    && standalone.pieces[0].step === 'reviewer');

const ALPHA = 'digest-peer-alpha-t20260926-120000';
const ALPHA_2 = 'digest-peer-alpha-2-t20260926-120000';
const BETA = 'digest-peer-beta-t20260926-120000';
const BETA_2 = 'digest-peer-beta-2-t20260926-120000';
store.createTask(HOME, { id: ALPHA, title: 'Alpha', owner: 'owner-a',
  adapter: { slug: 'alpha' } });
store.createTask(HOME, { id: BETA, title: 'Beta', owner: 'owner-b',
  adapter: { slug: 'beta' } });
store.bus(HOME, { cli: host.version });
store.changePeerLink(HOME, ALPHA, BETA, { session: 'owner-a' });
const firstQuestion = store.sendMessage(HOME, ALPHA, {
  from: 'orchestrator', to: 'peer:beta', type: 'question', body: 'old peer question',
  session: 'owner-a',
});
const peerOpen = buildDigest(host, { task: BETA, now: NOW }).tasks[0].questions;
store.changePeerLink(HOME, ALPHA, BETA, { session: 'owner-a', unlink: true });
store.createTask(HOME, { id: ALPHA_2, title: 'Another alpha', owner: 'owner-a-2',
  adapter: { slug: 'alpha' } });
store.changePeerLink(HOME, ALPHA_2, BETA, { session: 'owner-b' });
const secondQuestion = store.sendMessage(HOME, ALPHA_2, {
  from: 'orchestrator', to: 'peer:beta', type: 'question', body: 'new peer question',
  session: 'owner-a-2',
});
const secondAnswer = store.sendMessage(HOME, BETA, {
  from: 'orchestrator', to: 'peer:alpha', type: 'answer', body: 'new peer answer',
  session: 'owner-b',
});
const peerRelinked = buildDigest(host, { task: BETA, now: NOW }).tasks[0].questions;
store.changePeerLink(HOME, ALPHA_2, BETA, { session: 'owner-b', unlink: true });
const peerUnlinked = buildDigest(host, { task: BETA, now: NOW }).tasks[0].questions;
check('peer messages record their origin root task id',
  firstQuestion.message.task === BETA && firstQuestion.message.originTask === ALPHA
    && secondQuestion.message.task === BETA && secondQuestion.message.originTask === ALPHA_2
    && secondAnswer.message.task === ALPHA_2 && secondAnswer.message.originTask === BETA
    && store.taskMessageHeaders(HOME, BETA).some((message) => message.id === firstQuestion.message.id
      && message.originTask === ALPHA)
    && store.taskMessageHeaders(HOME, ALPHA_2).some((message) => message.id === secondAnswer.message.id
      && message.originTask === BETA));
check('a routed peer answer in the other root closes its question',
  peerOpen.length === 1 && peerOpen[0].id === firstQuestion.message.id
    && peerOpen[0].state === 'open' && peerOpen[0].originTask === ALPHA
    && peerRelinked.length === 1 && peerRelinked[0].id === firstQuestion.message.id
    && peerRelinked[0].state === 'open' && peerRelinked[0].originTask === ALPHA
    && peerUnlinked.length === 1 && peerUnlinked[0].id === firstQuestion.message.id
    && peerUnlinked[0].state === 'open' && peerUnlinked[0].originTask === ALPHA,
  JSON.stringify({ open: peerOpen, relinked: peerRelinked, unlinked: peerUnlinked }));
store.createTask(HOME, { id: BETA_2, title: 'Another beta', owner: 'owner-b-2',
  adapter: { slug: 'beta' } });
store.changePeerLink(HOME, ALPHA, BETA_2, { session: 'owner-a' });
const otherBetaAnswer = store.sendMessage(HOME, BETA_2, {
  from: 'orchestrator', to: 'peer:alpha', type: 'answer', body: 'another beta answer',
  session: 'owner-b-2',
});
const peerAfterOtherBeta = buildDigest(host, { task: BETA, now: NOW }).tasks[0].questions;
store.changePeerLink(HOME, ALPHA, BETA_2, { session: 'owner-a', unlink: true });
check('an answer from another same-slug root does not close the old question',
  otherBetaAnswer.message.task === ALPHA && otherBetaAnswer.message.originTask === BETA_2
    && peerAfterOtherBeta.length === 1 && peerAfterOtherBeta[0].id === firstQuestion.message.id
    && peerAfterOtherBeta[0].state === 'open',
  JSON.stringify(peerAfterOtherBeta));
const legacyQuestion = put(BETA, 'peer:alpha', 'orchestrator', 'question', 'legacy peer question');
const peerWithLegacy = buildDigest(host, { task: BETA, now: NOW }).tasks[0].questions;
const peerPrinted = capture(() => digest(host, { task: BETA, now: NOW }));
check('a legacy peer question without origin remains unresolved',
  peerWithLegacy.length === 2
    && peerWithLegacy.find((question) => question.id === firstQuestion.message.id)?.state === 'open'
    && peerWithLegacy.find((question) => question.id === legacyQuestion.id)?.state === 'unresolved-provenance'
    && !Object.hasOwn(peerWithLegacy.find((question) => question.id === legacyQuestion.id), 'originTask')
    && validate(buildDigest(host, { task: BETA, now: NOW }))
    && peerPrinted.includes('question [UNRESOLVED PROVENANCE] peer:alpha → orchestrator'),
  JSON.stringify({ questions: peerWithLegacy, schema: validate.errors }));
put(ALPHA, 'peer:beta', 'orchestrator', 'answer', 'legacy peer answer',
  new Date(Date.parse(firstQuestion.message.ts) + 1000).toISOString());
const peerWithLegacyAnswer = buildDigest(host, { task: BETA, now: NOW }).tasks[0].questions;
check('an answer without origin cannot close a recorded peer question',
  peerWithLegacyAnswer.find((question) => question.id === firstQuestion.message.id)?.state
    === 'unresolved-provenance'
    && peerWithLegacyAnswer.find((question) => question.id === legacyQuestion.id)?.state
      === 'unresolved-provenance',
  JSON.stringify(peerWithLegacyAnswer));
