// The `send` door, driven through the dispatcher a person reaches. Run: npm test
// The environment is passed in rather than the sender: the sender comes from the record the
// session holds in the task, and handing it in would prove nothing (04-protocol § Addresses).
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { capture, expectFail } from './console.mjs';

const { addrDir } = await import('../dist/protocol.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const SB = makeSandbox('promptobus-send-');
const ROOT = realpathSync(SB);
const HOME = path.join(ROOT, '.promptobus');
const TASK = 'sendtest-t20260912-000000';

const store = await import(path.join(here, '..', 'lib', 'store.js'));
const { helpText, runPromptobus } = await import(path.join(here, '..', 'lib', 'cli.js'));
const { serve } = await import(path.join(here, '..', 'lib', 'server.js'));
const runPromptobusHelp = () => { console.log(helpText(host)); };
const { hostOf } = await import(path.join(here, '..', 'lib', 'host.js'));
const { sessionEnv } = await import(path.join(here, '..', 'lib', 'spawn.js'));
const { driverByHarness } = await import(path.join(here, '..', 'lib', 'drivers.js'));

const OWNER = 'orch-session';
// The identity this process presents. Without it `send` cannot prove it is the task owner
// and refuses — which is the whole of finding 1, so the fixture says it out loud.
const baseEnv = { PROMPTOBUS_HOME: HOME, PROMPTOBUS_WARDEN: 'off', CLAUDE_CODE_SESSION_ID: OWNER };

writeHostConfig(ROOT);
const host = hostOf(ROOT);
store.createTask(HOME, { id: TASK, title: 'send door', owner: OWNER });
store.upsertParticipant(HOME, TASK, store.participantRecord('worker:one', { harness: 'claude' }));

// The argv of every case goes to the dispatcher as a person types it.
const call = (argv, env) => runPromptobus(argv, { host, cwd: ROOT, env });
const run = (argv, env = {}) => capture(() => call(argv, { ...baseEnv, ...env }));
const refuse = (argv, env = {}) => expectFail(() => call(argv, { ...baseEnv, ...env }));
// The environment EXACTLY as given: spreading a participant env over `baseEnv` would let
// a variable the lift DROPPED survive from underneath, and the check would then measure
// the merge instead of the drop.
const refuseWith = (argv, env) => expectFail(() => call(argv, env));

// `:` is not a legal filesystem character on Windows, so the store keeps a participant
// under `addrDir(address)` and stamps the same form on the message's `sender`.
const inbox = (addr) => {
  const dir = path.join(HOME, 'tasks', TASK, 'inbox', addrDir(addr));
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')).sort() : [];
};
const inbox2 = (task, addr) => {
  const dir = path.join(HOME, 'tasks', task, 'inbox', addrDir(addr));
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')) : [];
};
const last = (addr) => {
  const files = inbox(addr);
  if (!files.length) return null;
  return JSON.parse(readFileSync(path.join(HOME, 'tasks', TASK, 'inbox', addrDir(addr), files.at(-1)), 'utf8'));
};

{
  await run(['send', 'orchestrator', '--body', 'from a bare process', '--task', TASK]);
  check(': a process with no role writes as the orchestrator, and the message lands',
    inbox('orchestrator').length === 1 && last('orchestrator')?.sender === 'orchestrator',
    JSON.stringify({ n: inbox('orchestrator').length, sender: last('orchestrator')?.sender }));
}

{
  // `worker:one` carries no session binding: "nobody else is known to hold it" is not a proof
  // that this session does, so the declared role is refused and nothing is written.
  const before = inbox('orchestrator').length;
  const r = await refuse(['send', 'orchestrator', '--body', 'from a worker', '--task', TASK],
    { PROMPTOBUS_ROLE: 'worker:one' });
  check(': an unbound participant address is refused, and the refusal names the missing binding',
    r.failed === true && /«worker:one» of task \S+ carries no session binding/.test(r.out)
      && inbox('orchestrator').length === before,
    `${r.failed} · ${inbox('orchestrator').length - before} written · ${r.out}`);
}

// The environment a REAL participant gets, taken from the lift path rather than typed
// here: `sessionEnv` is what `spawn` hands the session. It carries no bus identity on
// purpose, so a participant running this command cannot name its own address — and the
// command must refuse instead of falling back to the orchestrator's (PB-179 review).
// `cursor` only: the other two drivers still hand the parent's `CLAUDE_CODE_SESSION_ID`
// on (PB-182's halves for them belong to other tracks), so a participant of theirs can
// still name itself — with someone else's id. That is PB-182's defect, not this one's,
// and asserting a refusal there would pass for the wrong reason.
for (const harness of ['cursor']) {
  const participant = sessionEnv(driverByHarness(harness), { ...baseEnv }, host);
  check(`: the ${harness} participant environment carries no PROMPTOBUS_ROLE — the fixture is the lift's own`,
    participant.PROMPTOBUS_ROLE === undefined, JSON.stringify(participant.PROMPTOBUS_ROLE));
  const before = inbox('orchestrator').length;
  const r = await refuseWith(['send', 'orchestrator', '--body', 'borrowed silently', '--task', TASK], {
    ...participant, PROMPTOBUS_HOME: HOME, PROMPTOBUS_WARDEN: 'off',
  });
  check(`: a ${harness} participant is REFUSED, not silently turned into the orchestrator`,
    r.failed === true && /cannot name its own session/.test(r.out) && inbox('orchestrator').length === before,
    `${r.failed} · ${inbox('orchestrator').length - before} written · ${r.out}`);
}

{
  // Negative control for the pair above: the same argv from a process that CAN name
  // itself and owns the task still sends, so the refusal is reading the environment and
  // not simply refusing everything.
  const before = inbox('orchestrator').length;
  await run(['send', 'orchestrator', '--body', 'again bare', '--task', TASK]);
  check(': the owner with a known session still sends as the orchestrator',
    inbox('orchestrator').length === before + 1 && last('orchestrator')?.sender === 'orchestrator',
    JSON.stringify({ before, now: inbox('orchestrator').length, sender: last('orchestrator')?.sender }));
}

{
  // The other half of finding 1: naming a FOREIGN task and writing into it as the
  // orchestrator. The task is owned by someone else, this process is not them.
  const FOREIGN = 'sendtest-foreign-t20260912-000000';
  store.createTask(HOME, { id: FOREIGN, title: 'someone else', owner: 'another-session' });
  const r = await refuse(['send', 'orchestrator', '--body', 'into a foreign task', '--task', FOREIGN]);
  check(': a foreign task is refused rather than written to as its orchestrator',
    r.failed === true && /borrow/.test(r.out), `${r.failed} · ${r.out}`);
}

{
  const r = await refuse(['send', 'not-an-address', '--body', 'x', '--task', TASK]);
  check(': a malformed address is refused at the boundary, with no stack in the output',
    r.failed === true && /is not an address/.test(r.out) && !/\bat \S+:\d+:\d+/.test(r.out),
    `${r.failed} · ${r.out}`);
}

{
  // There is no `--from`, and its absence is the decision (ADR-011), not a parsing gap:
  // the dispatcher refuses it by not declaring the option.
  const before = inbox('orchestrator').length;
  const r = await refuse(['send', 'orchestrator', '--body', 'borrowed', '--from', 'worker:one', '--task', TASK]);
  check(': --from is not an option — a sender that can be chosen can be borrowed',
    r.failed === true && /Unknown option '--from'/.test(r.out) && inbox('orchestrator').length === before,
    `${r.failed} · ${r.out}`);
}

{
  const r = await refuse(['send', '--body', 'nowhere', '--task', TASK]);
  check(': a message with no recipient is refused and the participants are named',
    r.failed === true && /worker:one/.test(r.out), `${r.failed} · ${r.out}`);
}

{
  const r = await refuse(['send', 'orchestrator', '--task', TASK]);
  check(': an empty body is refused — a message with nothing in it is not a message',
    r.failed === true && /body/.test(r.out), `${r.failed} · ${r.out}`);
}

{
  await run(['send', 'worker:one', '--body', 'ping', '--type', 'task', '--task', TASK]);
  check(': the orchestrator writes to a participant, and --type reaches the message',
    inbox('worker:one').length === 1 && last('worker:one')?.type === 'task',
    JSON.stringify({ n: inbox('worker:one').length, type: last('worker:one')?.type }));
}

{
  const file = path.join(ROOT, 'note.txt');
  writeFileSync(file, 'attached body\n');
  const r = await run(['send', 'worker:one', '--body', 'with a file', '--artifact', file, '--task', TASK]);
  const dir = path.join(HOME, 'tasks', TASK, 'files');
  const saved = existsSync(dir) ? readdirSync(dir) : [];
  check(': an artifact is named in the output and lands in the task files directory',
    /artifact note\.txt/.test(r) && saved.includes('note.txt'),
    `${JSON.stringify(saved)} · ${r}`);
}

// The refusal lives in `sendMessage`, where this caller and the `promptobus_send` tool meet
// ([04-protocol](../docs/reference/04-protocol.md) § Artifacts); the tool half is checked live in promptobus-mcp.
{
  const before = inbox('worker:one').length;
  // A `GateError` and not a bare one is what the top-level catch prints without a stack.
  const r = await refuse(['send', 'worker:one', '--body', 'record attached', '--type', 'artifact', '--task', TASK]);
  check(': type artifact with no file is refused here too, in the words the tool uses',
    r.failed === true && /artifactPath/.test(r.out) && !/\bat \S+:\d+:\d+/.test(r.out)
    && inbox('worker:one').length === before,
    `${r.failed} · ${inbox('worker:one').length} against ${before} · ${r.out}`);
}

// A declared role is a CLAIM. These are the ways of claiming one that must not work, and
// each is checked by what it would have WRITTEN, not only by the exit code.
{
  const FOREIGN = 'sendtest-forged-t20260912-000000';
  store.createTask(HOME, { id: FOREIGN, title: 'someone else', owner: 'another-session' });
  store.upsertParticipant(HOME, FOREIGN, store.participantRecord('worker:theirs', { harness: 'claude' }));

  const asOrch = await refuse(['send', 'worker:theirs', '--body', 'borrowed', '--task', FOREIGN],
    { PROMPTOBUS_ROLE: 'orchestrator' });
  check(': declaring PROMPTOBUS_ROLE=orchestrator does not borrow a foreign task',
    asOrch.failed === true && /belongs to session another-session/.test(asOrch.out)
      && inbox2(FOREIGN, 'worker:theirs').length === 0,
    `${asOrch.failed} · ${asOrch.out}`);

  const asStranger = await refuse(['send', 'worker:theirs', '--body', 'invented', '--task', FOREIGN],
    { PROMPTOBUS_ROLE: 'worker:invented' });
  check(': a role that is not a participant of the target task is refused, not auto-registered',
    asStranger.failed === true && /not a participant/.test(asStranger.out)
      && !store.addressesOf(store.readTask(HOME, FOREIGN)).includes('worker:invented'),
    `${asStranger.failed} · ${JSON.stringify(store.addressesOf(store.readTask(HOME, FOREIGN)))} · ${asStranger.out}`);
}

{
  // A task with no owner: ownership cannot be proved there BY CONSTRUCTION, so the
  // orchestrator address is refused rather than defaulted to.
  const OWNERLESS = 'sendtest-ownerless-t20260912-000000';
  store.createTask(HOME, { id: OWNERLESS, title: 'no owner', owner: null });
  store.upsertParticipant(HOME, OWNERLESS, store.participantRecord('worker:two', { harness: 'claude' }));
  const r = await refuse(['send', 'worker:two', '--body', 'unowned', '--task', OWNERLESS]);
  check(': a task with no owner refuses the orchestrator address instead of defaulting to it',
    r.failed === true && /records no owner/.test(r.out) && inbox2(OWNERLESS, 'worker:two').length === 0,
    `${r.failed} · ${r.out}`);
}

// No refusal on a typed argument may print a stack: the store's own refusals for these
// are bare `Error`s, and the top-level catch prints one before the single-line refusal.
for (const [name, argv] of [
  ['a body of only spaces', ['send', 'orchestrator', '--body', '   ', '--task', TASK]],
  ['an unknown --type', ['send', 'orchestrator', '--body', 'x', '--type', 'nonsense', '--task', TASK]],
  ['a well-formed address nobody registered', ['send', 'worker:ghost', '--body', 'x', '--task', TASK]],
  ['a malformed address', ['send', 'not-an-address', '--body', 'x', '--task', TASK]],
]) {
  const r = await refuse(argv);
  check(`: ${name} is refused with no stack in the output`,
    r.failed === true && !/\bat \S+:\d+:\d+/.test(r.out), `${r.failed} · ${r.out}`);
}

// The listener. `send` prints `sent` — and a message nobody watches for waits until its
// addressee happens to take a turn, which is the hand-driven multiplexer this command
// replaced. The fixture does NOT set PROMPTOBUS_WARDEN=off here: switching the warden off
// and then asserting it started would measure the switch. The trace file is the warden's
// own record of an auto-start, written by `ensureWarden` itself.
{
  const trace = path.join(ROOT, 'warden-trace.log');
  const wardenEnv = {
    PROMPTOBUS_HOME: HOME,
    CLAUDE_CODE_SESSION_ID: OWNER,
    PROMPTOBUS_WARDEN_TRACE: trace,
  };
  await capture(() => call(['send', 'worker:one', '--body', 'wake up', '--task', TASK], wardenEnv));
  const line = existsSync(trace) ? readFileSync(trace, 'utf8') : '';
  check(': a successful send starts the task warden, as every other bus write path does',
    line.includes(`warden auto-start · task ${TASK}`), JSON.stringify(line));
}

{
  // Negative control: a REFUSED send must not start one — nothing was written, so there
  // is nothing to watch for, and the check above would pass on any call otherwise.
  const trace = path.join(ROOT, 'warden-trace-refused.log');
  await refuseWith(['send', 'worker:one', '--body', 'never sent', '--task', TASK], {
    PROMPTOBUS_HOME: HOME, PROMPTOBUS_WARDEN_TRACE: trace,
  });
  check(': a refused send starts no warden',
    !existsSync(trace), existsSync(trace) ? readFileSync(trace, 'utf8') : 'absent');
}

// The registration itself: the argv carries no `--task`, and the session's declared task
// is what resolves it, as it does for a participant.
{
  const before = inbox('orchestrator').length;
  const r = await run(['send', 'orchestrator', '--body', 'republished'], { PROMPTOBUS_TASK: TASK });
  check(': `send` is a command — the dispatcher reaches the door, and the message lands',
    /sent status → orchestrator · from orchestrator/.test(r) && inbox('orchestrator').length === before + 1,
    `${inbox('orchestrator').length - before} written · ${r}`);
}

{
  const help = await capture(() => runPromptobusHelp());
  const unknown = await refuse(['nonsense']);
  check(': `send` is named where a person would find it — help and the subcommand list',
    /promptobus send <address> \(--body <text> \| --file <path>\)/.test(help)
      && /status, send, link, unlink, done/.test(unknown.out),
    `${help.slice(0, 200)} · ${unknown.out}`);
}

const lastIn = (task, addr) => {
  const files = inbox2(task, addr).sort();
  if (!files.length) return null;
  return JSON.parse(readFileSync(path.join(HOME, 'tasks', task, 'inbox', addrDir(addr), files.at(-1)), 'utf8'));
};

// A participant bound by its lift: the record carries the session the lift wrote.
const WORKER_SESSION = 'worker-bound-session';
const BOUND = 'sendtest-bound-t20260926-000000';
store.createTask(HOME, { id: BOUND, title: 'bound worker', owner: OWNER });
store.upsertParticipant(HOME, BOUND, store.participantRecord('worker:bound', {
  harness: 'claude', session: 'worker-b', sessionId: WORKER_SESSION,
}));

{
  const r = await run(['send', 'orchestrator', '--body', 'from the bound worker', '--task', BOUND],
    { CLAUDE_CODE_SESSION_ID: WORKER_SESSION, PROMPTOBUS_ROLE: 'worker:bound' });
  check(': a participant whose record holds this session sends as it',
    lastIn(BOUND, 'orchestrator')?.sender === addrDir('worker:bound') && /from worker:bound/.test(r),
    `${JSON.stringify(lastIn(BOUND, 'orchestrator')?.sender)} · ${r}`);
}

{
  const before = inbox2(BOUND, 'orchestrator').length;
  const r = await refuse(['send', 'orchestrator', '--body', 'borrowed by the owner', '--task', BOUND],
    { PROMPTOBUS_ROLE: 'worker:bound' });
  check(': a declared role that disagrees with the record is refused, naming both',
    r.failed === true
      && /PROMPTOBUS_ROLE names «worker:bound», but that record of task \S+ is held by session worker-bound-session, and this one is orch-session; this session holds orchestrator there/.test(r.out)
      && inbox2(BOUND, 'orchestrator').length === before,
    `${r.failed} · ${inbox2(BOUND, 'orchestrator').length - before} written · ${r.out}`);
}

{
  // A task with no owner has no provable orchestrator; a participant bound by its lift
  // proves its own address, and that proof does not rest on the owner.
  const OWNERLESS_BOUND = 'sendtest-ownerless-bound-t20260926-000000';
  store.createTask(HOME, { id: OWNERLESS_BOUND, title: 'no owner, bound worker', owner: null });
  store.upsertParticipant(HOME, OWNERLESS_BOUND, store.participantRecord('worker:three', {
    harness: 'claude', sessionId: WORKER_SESSION,
  }));
  await run(['send', 'orchestrator', '--body', 'from a bound worker, no owner', '--task', OWNERLESS_BOUND],
    { CLAUDE_CODE_SESSION_ID: WORKER_SESSION });
  const asOrch = await refuse(['send', 'worker:three', '--body', 'no owner', '--task', OWNERLESS_BOUND],
    { PROMPTOBUS_ROLE: 'orchestrator' });
  check(': a task with no owner takes a bound participant\'s message and refuses the orchestrator address',
    lastIn(OWNERLESS_BOUND, 'orchestrator')?.sender === addrDir('worker:three')
      && asOrch.failed === true && /records no owner/.test(asOrch.out) && /no claim route/.test(asOrch.out)
      && inbox2(OWNERLESS_BOUND, 'worker:three').length === 0,
    `${JSON.stringify(lastIn(OWNERLESS_BOUND, 'orchestrator')?.sender)} · ${asOrch.out}`);
}

// One session, two tasks: `teamlead:x` in the parent, `orchestrator` in its own.
const LEAD = 'teamlead-session';
const PARENT = 'sendtest-parent-t20260926-000000';
const CHILD = 'sendtest-child-t20260926-000000';
store.createTask(HOME, { id: PARENT, title: 'parent', owner: 'parent-session' });
store.upsertParticipant(HOME, PARENT, store.participantRecord('teamlead:x', { session: LEAD, sessionId: LEAD }));
store.createTask(HOME, { id: CHILD, title: 'child', owner: LEAD });
store.upsertParticipant(HOME, CHILD, store.participantRecord('worker:child', { harness: 'claude' }));

{
  await run(['send', 'orchestrator', '--type', 'status', '--body', 'parent status', '--task', PARENT],
    { CLAUDE_CODE_SESSION_ID: LEAD });
  await run(['send', 'worker:child', '--type', 'status', '--body', 'child status', '--task', CHILD],
    { CLAUDE_CODE_SESSION_ID: LEAD });
  check(': one session sends status in two tasks, and each message carries its sender for that task',
    lastIn(PARENT, 'orchestrator')?.sender === addrDir('teamlead:x')
      && lastIn(CHILD, 'worker:child')?.sender === 'orchestrator',
    JSON.stringify({ parent: lastIn(PARENT, 'orchestrator')?.sender, child: lastIn(CHILD, 'worker:child')?.sender }));
}

{
  // The declared role speaks about its declared task: on the other task the record decides,
  // and with no declared task the hint is checked against the task the call names.
  const leadEnv = { CLAUDE_CODE_SESSION_ID: LEAD, PROMPTOBUS_ROLE: 'orchestrator' };
  const before = inbox2(PARENT, 'orchestrator').length;
  const r = await run(['send', 'orchestrator', '--body', 'hint for the child', '--task', PARENT],
    { ...leadEnv, PROMPTOBUS_TASK: CHILD });
  const unscoped = await refuse(['send', 'orchestrator', '--body', 'hint with no task', '--task', PARENT], leadEnv);
  check(': a declared role binds only its declared task — elsewhere the record decides',
    /from teamlead:x/.test(r) && inbox2(PARENT, 'orchestrator').length === before + 1
      && unscoped.failed === true && /belongs to session parent-session/.test(unscoped.out)
      && /holds teamlead:x/.test(unscoped.out),
    `${r} · ${unscoped.out}`);
}

// The MCP door asks the same resolution: `promptobus_send` from the lead's own server.
const mcpSend = async (env, args) => {
  const output = [];
  await serve({
    host,
    env,
    cwd: ROOT,
    input: Readable.from([`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'promptobus_send', arguments: args },
    })}\n`]),
    output: { write: (chunk) => output.push(chunk) },
  });
  const answer = JSON.parse(output.join(''));
  return { error: answer.result?.isError === true, text: answer.result?.content?.map((c) => c.text).join('\n') ?? '' };
};

{
  const before = inbox2(PARENT, 'orchestrator').length;
  const r = await mcpSend({
    PROMPTOBUS_HOME: HOME, PROMPTOBUS_WARDEN: 'off', PROMPTOBUS_ROLE: 'orchestrator', PROMPTOBUS_TASK: CHILD,
    CLAUDE_CODE_SESSION_ID: LEAD,
  }, { to: 'orchestrator', type: 'status', body: 'parent status over mcp', task: PARENT });
  check(': promptobus_send resolves the sender per task — the lead writes to the parent as teamlead:x',
    !r.error && lastIn(PARENT, 'orchestrator')?.sender === addrDir('teamlead:x')
      && inbox2(PARENT, 'orchestrator').length === before + 1 && /address=teamlead:x/.test(r.text),
    r.text);
}

{
  const before = inbox('orchestrator').length;
  const r = await mcpSend({
    PROMPTOBUS_HOME: HOME, PROMPTOBUS_WARDEN: 'off', PROMPTOBUS_ROLE: 'worker:one', PROMPTOBUS_TASK: TASK,
    CLAUDE_CODE_SESSION_ID: OWNER,
  }, { to: 'orchestrator', type: 'status', body: 'unbound over mcp' });
  check(': promptobus_send refuses an unbound record too, naming the missing binding',
    r.error && /«worker:one» of task \S+ carries no session binding/.test(r.text)
      && inbox('orchestrator').length === before,
    r.text);
}

{
  // Two records held by one session in one task: the declared role picks the held one, on any task —
  // it grants nothing there, it only names a record the session already proves.
  const TWO = 'sendtest-two-t20260926-000000';
  store.createTask(HOME, { id: TWO, title: 'two held addresses', owner: 'two-owner' });
  for (const address of ['teamlead:y', 'peer:y']) {
    store.upsertParticipant(HOME, TWO, store.participantRecord(address, { sessionId: LEAD }));
  }
  const unnamed = await refuse(['send', 'orchestrator', '--body', 'which one', '--task', TWO],
    { CLAUDE_CODE_SESSION_ID: LEAD });
  const r = await run(['send', 'orchestrator', '--body', 'as the teamlead', '--task', TWO],
    { CLAUDE_CODE_SESSION_ID: LEAD, PROMPTOBUS_ROLE: 'teamlead:y', PROMPTOBUS_TASK: CHILD });
  check(': a session holding two addresses in one task sends as the one its declared role names',
    unnamed.failed === true && /holds teamlead:y and peer:y in task/.test(unnamed.out)
      && lastIn(TWO, 'orchestrator')?.sender === addrDir('teamlead:y') && /from teamlead:y/.test(r),
    `${unnamed.out} · ${JSON.stringify(lastIn(TWO, 'orchestrator')?.sender)} · ${r}`);
}

{
  const file = path.join(ROOT, 'body.md');
  writeFileSync(file, 'body from a file\n');
  await run(['send', 'worker:one', '--file', file, '--task', TASK]);
  const landed = last('worker:one');
  const before = inbox('worker:one').length;
  const both = await refuse(['send', 'worker:one', '--body', 'x', '--file', file, '--task', TASK]);
  check(': --file reads the body from that file, and --body with --file is refused naming both',
    landed?.body === 'body from a file\n'
      && both.failed === true && /--body and --file/.test(both.out) && inbox('worker:one').length === before,
    `${JSON.stringify(landed?.body)} · ${both.out}`);
}
