// PB-223: the owner gate of `done`, `stop` and `dismiss` is a POSITIVE proof. Run: npm test
//
// The gate used to answer "pass" whenever it had nothing to compare — no recorded owner or
// no session identity — so a call from a shell that names no session got `done` over any
// task in the store, a live foreign one included. What the file pins is the direction of
// the default: `allowed` is granted by evidence, and each absence is named rather than
// waved through. The three commands share one gate, so all three are checked, and the
// refusal is checked to leave the task tree byte for byte as it was.
//
// Session identity is a SEAM here, not an environment: the suite strips harness variables,
// and a file that could not name its caller would only ever see the refusal.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { capture, expectFail } from './console.mjs';

const SB = makeSandbox('promptobus-owner-gate-');
const ROOT = realpathSync(SB);
const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(ROOT, '.promptobus');

const store = await import(path.join(here, '..', 'lib', 'store.js'));
const { dismiss } = await import(path.join(here, '..', 'lib', 'dismiss.js'));
const { stop } = await import(path.join(here, '..', 'lib', 'stop.js'));
const { done } = await import(path.join(here, '..', 'lib', 'done.js'));
// Imported here and not later: `lib/drivers.js` binds the real resolver at import, and it
// would take the seam below with it.
const { resolveSessionIdentity } = await import(path.join(here, '..', 'lib', 'drivers.js'));
const { legacy } = await import(path.join(here, '..', 'dist', 'index.js'));

writeFileSync(path.join(ROOT, 'AGENTS.md'), '# stand\n');
writeHostConfig(ROOT);

const OWNER = 'sess-hozyain';
const FOREIGN = 'sess-sosed';
const WORKER = 'worker:api';

let SESSION = OWNER;
store.bindSessionIdentity(() => ({ id: SESSION }));

const OWNED = 'gate-t20260913-100000';
const OWNERLESS = 'gate-nobody-t20260913-100100';
const CONTESTED = 'gate-contested-t20260913-100200';
store.createTask(HOME, { id: OWNED, title: 'у задачи есть владелец', owner: OWNER });
store.createTask(HOME, { id: OWNERLESS, title: 'владельца нет по построению', owner: null });
store.createTask(HOME, { id: CONTESTED, title: 'две переменные идентичности разом', owner: OWNER });
for (const id of [OWNED, OWNERLESS, CONTESTED]) {
  store.upsertParticipant(HOME, id, store.participantRecord(WORKER, { name: `sess-${id}`, mode: 'attached' }));
}

// Every file of the task directory by content, so that "the refusal changed nothing" is a
// measurement and not the absence of a visible line.
function treeOf(id) {
  const at = path.join(HOME, 'tasks', id);
  const walk = (dir, rel) => readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory()
      ? walk(path.join(dir, e.name), `${rel}${e.name}/`)
      : [`${rel}${e.name}:${createHash('sha256').update(readFileSync(path.join(dir, e.name))).digest('hex')}`]));
  return walk(at, '').join('\n');
}

const withSession = (id, fn) => {
  const was = SESSION;
  SESSION = id;
  try { return fn(); } finally { SESSION = was; }
};

// --- the answer itself ------------------------------------------------------------
{
  const none = withSession(null, () => store.ownership(HOME, OWNED, store.ORCHESTRATOR, store.sessionIdentity()));
  check('PB-223: no session identity on an owned task proves no right — and is not called foreign either',
    none.allowed === false && none.right === 'no-identity' && none.gated === false && none.owner === OWNER,
    JSON.stringify(none));
  const foreign = withSession(FOREIGN, () => store.ownership(HOME, OWNED, store.ORCHESTRATOR, store.sessionIdentity()));
  check('PB-223: a named foreign session is the one case that was already proved — it stays proved',
    foreign.allowed === false && foreign.right === 'foreign' && foreign.gated === true,
    JSON.stringify(foreign));
  const mine = store.ownership(HOME, OWNED, store.ORCHESTRATOR, store.sessionIdentity());
  check('PB-223: the owner is allowed, and the right is named rather than inferred from silence',
    mine.allowed === true && mine.right === 'owner' && mine.gated === false, JSON.stringify(mine));
}
{
  // The named decision on a task with no recorded owner: it belongs to nobody, and the
  // exception is that a session naming ITSELF may act on it — nothing more can be proved.
  const named = store.ownership(HOME, OWNERLESS, store.ORCHESTRATOR, store.sessionIdentity());
  check('PB-223: a task with no owner admits a session that names itself, under that name',
    named.allowed === true && named.right === 'ownerless' && named.owner === null, JSON.stringify(named));
  const unnamed = withSession(null, () => store.ownership(HOME, OWNERLESS, store.ORCHESTRATOR, store.sessionIdentity()));
  check('PB-223: and refuses one that names nothing — "nobody owns it" is not "anybody may"',
    unnamed.allowed === false && unnamed.right === 'no-identity', JSON.stringify(unnamed));
}
{
  const other = store.ownership(HOME, OWNED, WORKER, OWNER);
  check('PB-223: an address this gate does not judge grants no right — absence of a question is not a yes',
    other.allowed === false && other.right === 'other-address' && other.gated === false, JSON.stringify(other));
  // Its `owner` is null because nobody looked, not because the task has none. Both refusal
  // texts would read "records no mailbox owner" about a task that has one, so they throw.
  const meta = store.readTask(HOME, OWNED);
  const threw = (fn) => { try { return { threw: false, said: fn() }; } catch (e) { return { threw: true, said: e.message }; } };
  const head = threw(() => store.unprovenOwnerLine(HOME, meta, other));
  const route = threw(() => store.ownerRoute(HOME, meta, other, 'promptobus done'));
  check('PB-223: and neither refusal text is built from it — an answer this gate never gave has no branch',
    head.threw && route.threw
    && /owner gate only/.test(head.said) && /owner gate only/.test(route.said)
    && !/records no mailbox owner/.test(head.said) && !/records no mailbox owner/.test(route.said),
    JSON.stringify({ head, route }));
}

// --- the three commands that read it ----------------------------------------------
//
// `stop` and `dismiss` are driven past the gate by the owner and left to refuse on the
// MISSING ADDRESS: that refusal is the proof the gate let them through, and it needs
// neither a live session nor a driver.
const CONSUMERS = [
  ['done', () => done(ROOT, { task: OWNED, snapshot: () => ({}) })],
  ['stop', () => stop(ROOT, { task: OWNED })],
  ['dismiss', () => dismiss(ROOT, { task: OWNED })],
];

for (const [name, call] of CONSUMERS) {
  const before = treeOf(OWNED);
  const refused = await withSession(null, () => expectFail(call));
  check(`PB-223: ${name} from a call with no session identity is refused on a task that has an owner`,
    refused.failed && /carries no session identity/.test(refused.out) && refused.out.includes(OWNER),
    refused.out);
  check(`PB-223: and ${name} left the task tree byte for byte as it was`,
    treeOf(OWNED) === before, `${before}\n---\n${treeOf(OWNED)}`);
  check(`PB-223: the ${name} refusal does not offer claim — a call that cannot name itself cannot claim either`,
    !/mailbox \{claim: true\}/.test(refused.out), refused.out);

  const foreign = await withSession(FOREIGN, () => expectFail(call));
  check(`PB-223: ${name} from a named foreign session is still refused, and the wording is the old one`,
    foreign.failed && foreign.out.includes(OWNER) && foreign.out.includes(FOREIGN)
    && /is bound to session/.test(foreign.out), foreign.out);
  check(`PB-223: and ${name} left the task tree byte for byte as it was`,
    treeOf(OWNED) === before, `${before}\n---\n${treeOf(OWNED)}`);
}

// The owner passes the gate: `stop` and `dismiss` refuse further on, for the address.
for (const [name, call] of CONSUMERS.slice(1)) {
  const owner = await expectFail(call);
  check(`PB-223: the owner passes the ${name} gate and is stopped only by what comes after it`,
    owner.failed && /name the participant address/.test(owner.out), owner.out);
}

// --- the named decision, through the commands -------------------------------------
{
  const before = treeOf(OWNERLESS);
  const unnamed = await withSession(null, () => expectFail(() => dismiss(ROOT, { task: OWNERLESS, address: WORKER })));
  check('PB-223: on a task with no owner the refusal says WHICH decision it is applying',
    unnamed.failed && /records no mailbox owner/.test(unnamed.out)
    && /carries no session identity/.test(unnamed.out), unnamed.out);
  check('PB-223: and it changed nothing in that task either',
    treeOf(OWNERLESS) === before, `${before}\n---\n${treeOf(OWNERLESS)}`);
  check('PB-223: the route it offers is walkable — a task with no owner has no owning session to send anyone to',
    /from any session that names itself/.test(unnamed.out)
    && !/from the session that owns the task/.test(unnamed.out), unnamed.out);
  const named = capture(() => dismiss(ROOT, { task: OWNERLESS, address: WORKER }));
  check('PB-223: a session that names itself is let through on the same task',
    /dismissed from watch/.test(named), named);
}

// --- an environment that names TWO harnesses -------------------------------------
//
// PB-218 separated "nothing names a session" from "more than one does" in the resolver, and
// this gate sees only the `null` both produce. Told apart nowhere, its refusal would send the
// reader hunting for a variable that is there twice over — the very defect PB-218 removed
// from the direct route in the same pass. The real resolver is bound for this block: the seam
// above answers for a stand, and the subject here is what the environment does.
{
  const was = { claude: process.env.CLAUDE_CODE_SESSION_ID, codex: process.env.CODEX_THREAD_ID };
  process.env.CLAUDE_CODE_SESSION_ID = 'parent-session';
  process.env.CODEX_THREAD_ID = 'own-thread';
  store.bindSessionIdentity(resolveSessionIdentity);
  const before = treeOf(CONTESTED);
  const refused = await expectFail(() => done(ROOT, { task: CONTESTED, snapshot: () => ({}) }));
  check('PB-223/PB-218: with two identity variables the refusal names both, and does not call it none',
    refused.failed && /CLAUDE_CODE_SESSION_ID/.test(refused.out) && /CODEX_THREAD_ID/.test(refused.out)
    && !/carries no session identity/.test(refused.out), refused.out);
  check('PB-223/PB-218: and it says to remove the extra variable, not to find a session',
    /removing it answers/.test(refused.out) && /Clear the environment down to one identity variable/.test(refused.out)
    && !/from the session that owns the task/.test(refused.out), refused.out);
  check('PB-223/PB-218: the contested refusal left the task tree byte for byte as it was',
    treeOf(CONTESTED) === before, `${before}\n---\n${treeOf(CONTESTED)}`);
  store.bindSessionIdentity(() => ({ id: SESSION }));
  for (const [name, value] of [['CLAUDE_CODE_SESSION_ID', was.claude], ['CODEX_THREAD_ID', was.codex]]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

// --- the second producer of the same answer ---------------------------------------
//
// `ownership` is written twice: here and in the legacy store the migration reads. The copies
// cannot be merged — the two stores have different journals — so the five outcomes are run
// through both, and a silent divergence becomes a red check rather than a surprise later.
{
  const LEGACY = path.join(ROOT, 'legacy');
  const write = (id, owner) => {
    const dir = path.join(LEGACY, 'tasks', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'task.json'), `${JSON.stringify({
      id, title: id, status: 'active', participants: [{ address: 'orchestrator', ...(owner ? { owner } : {}) }],
    })}\n`);
  };
  write(OWNED, OWNER);
  write(OWNERLESS, null);
  const cases = [
    ['no-identity on an owned task', OWNED, store.ORCHESTRATOR, null],
    ['the owner', OWNED, store.ORCHESTRATOR, OWNER],
    ['a foreign session', OWNED, store.ORCHESTRATOR, FOREIGN],
    ['a task with no owner', OWNERLESS, store.ORCHESTRATOR, OWNER],
    ['no-identity on a task with no owner', OWNERLESS, store.ORCHESTRATOR, null],
    ['an address this gate does not judge', OWNED, WORKER, OWNER],
  ];
  const diverged = cases.filter(([, id, addr, session]) => {
    const mine = store.ownership(HOME, id, addr, session);
    const theirs = legacy.ownership(LEGACY, id, addr, session);
    return mine.gated !== theirs.gated || mine.allowed !== theirs.allowed || mine.right !== theirs.right;
  });
  check('PB-223: the legacy store answers the same five outcomes — the two copies of the gate have not drifted',
    diverged.length === 0,
    JSON.stringify(diverged.map(([label, id, addr, session]) => ({
      label, mine: store.ownership(HOME, id, addr, session), theirs: legacy.ownership(LEGACY, id, addr, session),
    }))));
}

// The owner closes their own run — the case the whole gate exists to keep working.
{
  const closed = await capture(async () => done(ROOT, { task: OWNED, snapshot: () => ({}), 'keep-sessions': true }));
  check('PB-223: the owner closes their own task, and the positive proof did not get in the way',
    /closed/.test(closed) && store.readTask(HOME, OWNED).status === 'done', closed);
}
