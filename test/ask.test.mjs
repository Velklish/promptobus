import './home.mjs';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { capture, expectFail } from './console.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'promptobus.js');
const ROOT = makeSandbox('promptobus-ask-');
const HOME = path.join(ROOT, '.promptobus');
const ROOT_TASK = 'ask-root-t20260927-000000';
const CHILD_TASK = 'ask-child-t20260927-000000';
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ![
  'CLAUDE_CODE_SESSION_ID', 'CURSOR_CONVERSATION_ID', 'CODEX_THREAD_ID',
  'PROMPTOBUS_CODEX_SESSION', 'PROMPTOBUS_CURSOR_SESSION',
  'PROMPTOBUS_ROLE', 'PROMPTOBUS_TASK',
].includes(key)));
Object.assign(env, { PROMPTOBUS_HOME: HOME, PROMPTOBUS_WARDEN: 'off' });

writeHostConfig(ROOT);
const store = await import('../lib/store.js');
const { hostOf } = await import('../lib/host.js');
const { runPromptobus } = await import('../lib/cli.js');
const { answerOwedSince, unansweredUserQuestions } = await import('../lib/answers.js');
const { status } = await import('../lib/status.js');
const host = hostOf(ROOT);
store.createTask(HOME, { id: ROOT_TASK, title: 'root', owner: 'root-session', adapter: { slug: 'root' } });
store.createTask(HOME, {
  id: CHILD_TASK, title: 'child', owner: 'lead-session', adapter: { slug: 'lead' },
  parent: ROOT_TASK, teamlead: 'teamlead:lead',
});
store.upsertParticipant(HOME, ROOT_TASK, store.participantRecord('worker:one'));

const cli = (args, more = {}) => runPromptobus(args, { host, cwd: ROOT, env: { ...env, ...more } });
const run = (args, more = {}) => capture(() => cli(args, more));
const refuse = (args, more = {}) => expectFail(() => cli(args, more));
const guard = (task, session) => spawnSync(process.execPath, [BIN, 'guard'], {
  cwd: ROOT,
  input: JSON.stringify({ session_id: session, cwd: ROOT, hook_event_name: 'Stop' }),
  env: { ...env, PROMPTOBUS_TASK: task, PROMPTOBUS_ROLE: 'orchestrator' },
  encoding: 'utf8',
});

const inherited = await refuse(['ask', 'blocked', '--task', ROOT_TASK], {
  CLAUDE_CODE_SESSION_ID: 'root-session',
});
check('ask refuses an inherited harness identity and names the parent-session risk',
  inherited.failed && /CLAUDE_CODE_SESSION_ID/.test(inherited.out)
    && /inherit its parent session identity/.test(inherited.out)
    && !store.participantOf(store.readTask(HOME, ROOT_TASK), 'user'), inherited.out);

const addressed = await refuse(['ask', 'blocked', '--task', ROOT_TASK], {
  PROMPTOBUS_ROLE: 'worker:one',
});
check('ask refuses a bus address even without a harness session',
  addressed.failed && /PROMPTOBUS_ROLE=worker:one/.test(addressed.out), addressed.out);

await run(['ask', 'Who owns this?', '--task', ROOT_TASK]);
const rootUser = store.participantOf(store.readTask(HOME, ROOT_TASK), 'user');
const rootQuestion = store.glanceInbox(HOME, ROOT_TASK, 'orchestrator').at(-1);
check('plain-terminal ask registers a sessionless user and lands a question',
  rootUser?.sessionRef === null && rootQuestion?.sender === 'user'
    && rootQuestion?.type === 'question' && rootQuestion?.body === 'Who owns this?',
  JSON.stringify({ rootUser, rootQuestion }));
check('an unread user question is already an orchestrator debt',
  answerOwedSince(HOME, ROOT_TASK, 'orchestrator', null) === rootQuestion.ts
    && unansweredUserQuestions(HOME, ROOT_TASK).length === 1);
const askedStatus = await capture(() => status(host, { task: ROOT_TASK, sessions: null }));
check('status names the orchestrator debt before the user question is read',
  /orchestrator.*UNANSWERED.*person's question/.test(askedStatus), askedStatus);

const unreadGuard = guard(ROOT_TASK, 'root-session');
check('guard exits 2 and names the person while the question is unread',
  unreadGuard.status === 2 && /the person's question/.test(unreadGuard.stderr),
  `${unreadGuard.status} ${unreadGuard.stderr}`);
store.readInbox(HOME, ROOT_TASK, 'orchestrator');
await run(['send', 'worker:one', '--type', 'status', '--body', 'work continues', '--task', ROOT_TASK], {
  CLAUDE_CODE_SESSION_ID: 'root-session',
});
await run(['send', 'user', '--type', 'status', '--body', 'still working', '--task', ROOT_TASK], {
  CLAUDE_CODE_SESSION_ID: 'root-session',
});
store.markTurn(HOME, ROOT_TASK, 'orchestrator');
const rootStatus = await capture(() => status(host, { task: ROOT_TASK, sessions: null }));
check('status and unrelated sends leave the user question owed and status marks UNANSWERED',
  answerOwedSince(HOME, ROOT_TASK, 'orchestrator', null) === rootQuestion.ts
    && /orchestrator.*UNANSWERED.*person's question/.test(rootStatus), rootStatus);
const readGuard = guard(ROOT_TASK, 'root-session');
check('guard still exits 2 after the mailbox is read and only status was sent',
  readGuard.status === 2 && /answer to user/.test(readGuard.stderr),
  `${readGuard.status} ${readGuard.stderr}`);

await run(['send', 'user', '--type', 'answer', '--body', 'The root owner.', '--task', ROOT_TASK], {
  CLAUDE_CODE_SESSION_ID: 'root-session',
});
check('an answer to user evens the debt and lets guard exit 0',
  answerOwedSince(HOME, ROOT_TASK, 'orchestrator', null) === null
    && guard(ROOT_TASK, 'root-session').status === 0);
const recordEnv = {};
const waitingUserMail = store.countInbox(HOME, ROOT_TASK, 'user');
const waitingOrchestratorMail = store.countInbox(HOME, ROOT_TASK, 'orchestrator');
for (const [harness, variable, field] of [
  ['Codex', 'PROMPTOBUS_CODEX_SESSION', 'threadId'],
  ['Cursor', 'PROMPTOBUS_CURSOR_SESSION', 'chatId'],
]) {
  const record = path.join(ROOT, `${harness.toLowerCase()}-mcp-session.json`);
  writeFileSync(record, `${JSON.stringify({
    home: HOME, task: ROOT_TASK, address: 'orchestrator', [field]: 'root-session',
  })}\n`);
  recordEnv[variable] = record;
  const processEnv = { PROMPTOBUS_TASK: ROOT_TASK, [variable]: record };
  const blockedQuestion = await refuse(['ask', 'borrowed', '--task', ROOT_TASK], processEnv);
  check(`ask refuses a ${harness} MCP session record without a bus role`,
    blockedQuestion.failed && blockedQuestion.out.includes(variable)
      && store.countInbox(HOME, ROOT_TASK, 'orchestrator') === waitingOrchestratorMail,
    blockedQuestion.out);
  const blockedRead = await refuse(['ask', '--answers', '--task', ROOT_TASK], processEnv);
  check(`ask --answers refuses a ${harness} MCP session record without consuming user mail`,
    blockedRead.failed && blockedRead.out.includes(variable)
      && store.countInbox(HOME, ROOT_TASK, 'user') === waitingUserMail,
    blockedRead.out);
}
const contestedRecords = await refuse(['ask', 'borrowed', '--task', ROOT_TASK], {
  PROMPTOBUS_TASK: ROOT_TASK, ...recordEnv,
});
check('ask names both record-backed identities when two harnesses claim the process',
  contestedRecords.failed && contestedRecords.out.includes('PROMPTOBUS_CODEX_SESSION')
    && contestedRecords.out.includes('PROMPTOBUS_CURSOR_SESSION')
    && store.countInbox(HOME, ROOT_TASK, 'orchestrator') === waitingOrchestratorMail,
  contestedRecords.out);
const firstAnswers = await run(['ask', '--answers', '--task', ROOT_TASK]);
const secondAnswers = await run(['ask', '--answers', '--task', ROOT_TASK]);
check('ask --answers prints the answer once and then an empty mailbox',
  firstAnswers.includes('The root owner.') && !secondAnswers.includes('The root owner.')
    && secondAnswers.includes('user mailbox empty') && store.countInbox(HOME, ROOT_TASK, 'user') === 0,
  `${firstAnswers}\n${secondAnswers}`);

await run(['ask', 'One more question', '--task', ROOT_TASK]);
const latestRootQuestion = store.glanceInbox(HOME, ROOT_TASK, 'orchestrator').at(-1);
check('a question after an answer opens a new debt on the latest question',
  answerOwedSince(HOME, ROOT_TASK, 'orchestrator', null) === latestRootQuestion.ts
    && unansweredUserQuestions(HOME, ROOT_TASK).map((m) => m.id).join(',') === latestRootQuestion.id);
store.readInbox(HOME, ROOT_TASK, 'orchestrator');
await run(['send', 'user', '--type', 'answer', '--body', 'The same owner.', '--task', ROOT_TASK], {
  CLAUDE_CODE_SESSION_ID: 'root-session',
});

await run(['ask', 'Can you take this?', '--task', ROOT_TASK, '--to', 'teamlead:lead']);
const childQuestion = store.glanceInbox(HOME, CHILD_TASK, 'orchestrator').at(-1);
check('teamlead target asks the child orchestrator and registers user in that task',
  childQuestion?.sender === 'user' && childQuestion?.body === 'Can you take this?'
    && store.participantOf(store.readTask(HOME, CHILD_TASK), 'user')?.sessionRef === null,
  JSON.stringify(childQuestion));
store.readInbox(HOME, CHILD_TASK, 'orchestrator');
store.markTurn(HOME, CHILD_TASK, 'orchestrator');
const childStatus = await capture(() => status(host, { task: CHILD_TASK, sessions: null }));
check('child orchestrator owes the person after its turn ends',
  /orchestrator.*UNANSWERED.*person's question/.test(childStatus), childStatus);
const childAnswer = await run(['send', 'user', '--type', 'answer', '--body', 'Yes, I can.', '--task', CHILD_TASK], {
  CLAUDE_CODE_SESSION_ID: 'lead-session',
});
check('child orchestrator can answer user and clear its own debt',
  childAnswer.includes('sent answer') && answerOwedSince(HOME, CHILD_TASK, 'orchestrator', null) === null
    && guard(CHILD_TASK, 'lead-session').status === 0, childAnswer);
const childRead = await run(['ask', '--answers', '--task', CHILD_TASK]);
check('child-task answer is read from the child user mailbox', childRead.includes('Yes, I can.'), childRead);
