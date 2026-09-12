// PB-179: the bus door that was built and WITHDRAWN before release. Run: npm test
// `send` is not registered as a command (ADR-011 § The first implementation), so these
// drive `lib/send.js` directly — the dispatch is what was withdrawn, the logic is what
// stays covered. The environment is still passed in rather than the sender: the command's
// point is that the sender comes from the process, and handing it in would prove nothing.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { capture, expectFail, expectThrow } from './console.mjs';

const { addrDir } = await import('../dist/protocol.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const SB = makeSandbox('promptobus-send-');
const ROOT = realpathSync(SB);
const HOME = path.join(ROOT, '.promptobus');
const TASK = 'sendtest-t20260912-000000';

const store = await import(path.join(here, '..', 'lib', 'store.js'));
const { send } = await import(path.join(here, '..', 'lib', 'send.js'));
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

// `argv` keeps the command shape the withdrawn dispatch parsed, so a future registration
// can be checked against these same cases without rewriting them.
const call = (argv, env) => {
  const [, to, ...rest] = argv;
  const opt = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (rest.includes('--from')) throw new Error('unknown option --from');
  return send(host, { to, task: opt('task'), type: opt('type'), body: opt('body'), artifact: opt('artifact') },
    { cwd: ROOT, env });
};
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
  await run(['send', 'orchestrator', '--body', 'from a worker', '--task', TASK],
    { PROMPTOBUS_ROLE: 'worker:one' });
  check(': PROMPTOBUS_ROLE makes the sender that participant, not the orchestrator',
    last('orchestrator')?.sender === addrDir('worker:one'), JSON.stringify(last('orchestrator')?.sender));
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
  // There is no `--from`, and its absence is the decision (ADR-011), not a parsing gap.
  // The withdrawn dispatch refused it by not declaring the option; here the stand-in
  // parser refuses it the same way, so the case keeps its meaning for a re-registration.
  const r = await expectThrow(() => call(['send', 'orchestrator', '--body', 'borrowed', '--from', 'worker:one', '--task', TASK], baseEnv));
  check(': --from is not an option — a sender that can be chosen can be borrowed',
    r.threw === true && /unknown option --from/.test(r.msg ?? ''), JSON.stringify(r));
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
