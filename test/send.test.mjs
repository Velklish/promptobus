// PB-179: the CLI door to the bus. Run: npm test
// Every check goes through `runPromptobus`, not through the module: the command's point is
// that the sender comes from the PROCESS, and a direct call would hand it in.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
const { runPromptobus } = await import(path.join(here, '..', 'lib', 'cli.js'));
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

const run = (argv, env = {}) => capture(() => runPromptobus(argv, {
  host, cwd: ROOT, env: { ...baseEnv, ...env },
}));
const refuse = (argv, env = {}) => expectFail(() => runPromptobus(argv, {
  host, cwd: ROOT, env: { ...baseEnv, ...env },
}));
// The environment EXACTLY as given: spreading a participant env over `baseEnv` would let
// a variable the lift DROPPED survive from underneath, and the check would then measure
// the merge instead of the drop.
const refuseWith = (argv, env) => expectFail(() => runPromptobus(argv, { host, cwd: ROOT, env }));

// `:` is not a legal filesystem character on Windows, so the store keeps a participant
// under `addrDir(address)` and stamps the same form on the message's `sender`.
const inbox = (addr) => {
  const dir = path.join(HOME, 'tasks', TASK, 'inbox', addrDir(addr));
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')).sort() : [];
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
    r.failed === true && /PROMPTOBUS_ROLE/.test(r.out) && inbox('orchestrator').length === before,
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
  // an unknown option must be refused rather than ignored.
  const r = await refuse(['send', 'orchestrator', '--body', 'borrowed', '--from', 'worker:one', '--task', TASK]);
  check(': --from is not an option — a sender that can be chosen can be borrowed',
    r.failed === true && /from/.test(r.out), `${r.failed} · ${r.out}`);
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
