// PB-179: the CLI door to the bus. Run: npm test
// Every check goes through `runPromptobus`, not through the module: the command's point is
// that the sender comes from the PROCESS, and a direct call would hand it in.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
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

writeHostConfig(ROOT);
const host = hostOf(ROOT);
store.createTask(HOME, { id: TASK, title: 'send door', owner: 'orch-session' });
store.upsertParticipant(HOME, TASK, store.participantRecord('worker:one', { harness: 'claude' }));

const baseEnv = { PROMPTOBUS_HOME: HOME, PROMPTOBUS_WARDEN: 'off' };
const run = (argv, env = {}) => capture(() => runPromptobus(argv, {
  host, cwd: ROOT, env: { ...baseEnv, ...env },
}));
const refuse = (argv, env = {}) => expectFail(() => runPromptobus(argv, {
  host, cwd: ROOT, env: { ...baseEnv, ...env },
}));

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
  // The sender comes from the environment the process was started with — the same place
  // the MCP server reads it. This is the half PB-179 says no argument can move.
  await run(['send', 'orchestrator', '--body', 'from a worker', '--task', TASK],
    { PROMPTOBUS_ROLE: 'worker:one' });
  check(': PROMPTOBUS_ROLE makes the sender that participant, not the orchestrator',
    last('orchestrator')?.sender === addrDir('worker:one'), JSON.stringify(last('orchestrator')?.sender));
}

{
  // Negative control for the check above: the same argv without the variable sends as the
  // orchestrator again, so the check is reading the environment and not a constant.
  const before = inbox('orchestrator').length;
  await run(['send', 'orchestrator', '--body', 'again bare', '--task', TASK]);
  check(': and without it the same command sends as the orchestrator again',
    inbox('orchestrator').length === before + 1 && last('orchestrator')?.sender === 'orchestrator',
    JSON.stringify({ before, now: inbox('orchestrator').length, sender: last('orchestrator')?.sender }));
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
