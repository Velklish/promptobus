// The mechanism's door into the bus — `lib/store.js`. What is checked here is
// what IT does, not the package: translating an address into a v1 participant
// record, the task journal in the mechanism's own fields, the task files folder,
// refusal to an unregistered recipient, the journal cache for one tool call, and
// the two channels reporting something broken.
//
// The checks moved here from the store suite along with their subject: the
// compatibility layer inside the package is gone — the package hands over a
// single v1 surface, and everything that speaks in addresses and mechanism
// fields now lives in the CLI. What stayed in the core: the bus dictionary, the
// journal lock, store operations ([v1-engine.test.mjs](v1-engine.test.mjs)), and
// the three mailbox reads ([store.test.mjs](store.test.mjs)).
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import { captureSplit, quiet } from './console.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SB = realpathSync(makeSandbox('promptobus-promptobus-adapter-'));

const store = await import(path.join(here, '..', 'lib', 'store.js'));

const home = path.join(SB, 'ws', '.promptobus');

function thrown(fn) {
  try {
    fn();
    return { threw: false, name: '', msg: '' };
  } catch (e) {
    return { threw: true, name: e?.constructor?.name, msg: e.message };
  }
}

// --- task journal in mechanism fields ------------------------------------------

const task = store.createTask(home, {
  id: 't20260813-120000', title: 'трасса события через два сервиса', owner: null,
});

check('createTask: status active, the orchestrator is a participant at its own address',
  task.status === 'active' && store.addressOf(task.participants[0]) === store.ORCHESTRATOR,
  `${task.status} · ${store.addressOf(task.participants[0])}`);

check('createTask: the title reads back',
  store.readTask(home, task.id).title === 'трасса события через два сервиса');

// The slug, the stamp, and the explicit-title flag are MECHANISM fields, and in the v1
// journal they live under `adapter`: the task's own fields there are the title, status,
// owner, and participants.
check('createTask: the task stamp lives in the journal\'s adapter and is written even without a slug',
  store.readTask(home, task.id).adapter.stamp === task.id
  && !store.readTask(home, task.id).adapter.slug,
  JSON.stringify(store.readTask(home, task.id).adapter));

// --- participant record: the address is rejected before the write -----------------------------

// : an invalid address is rejected before the write. We check both the failure class and
// the disk: a `GateError` after the write would look correct but would leave a corrupted
// journal.
const beforeInvalid = JSON.stringify(store.readTask(home, task.id).participants);
const invalid = thrown(() => store.upsertParticipant(home, task.id,
  store.participantRecord('worker:Плохой Адрес', { repo: 'ns/repo' })));

check(': participant record rejects an invalid address via a GateError',
  invalid.name === 'GateError' && /invalid participant address/.test(invalid.msg),
  `${invalid.name} · ${invalid.msg}`);

check(': the refusal happened before the write — the task participants did not change',
  JSON.stringify(store.readTask(home, task.id).participants) === beforeInvalid);

// The addressees in the checks below are on record as task participants: since  a message
// goes only to whoever is in the journal, and it is spawn that enrolls them there — there is
// no live spawn here.
for (const address of ['worker:a', 'worker:b']) {
  store.upsertParticipant(home, task.id, store.participantRecord(address, { repo: 'ns/repo' }));
}

check('participant record: the address lives in metadata, role and id are v1\'s own fields', (() => {
  const p = store.participantOf(store.readTask(home, task.id), 'worker:a');
  return p.id === 'worker-a' && p.role === 'worker' && p.metadata.address === 'worker:a'
    && p.metadata.repo === 'ns/repo' && p.harness === store.FALLBACK_HARNESS;
})());

// --- participant files in `workers/` ------------------------------------------------

// A participant's file name is derived from its address by one function; spawn, review, and
// `promptobus done` cleanup all compute it — three different subjects that share only the
// journal, and if the copies diverged, cleanup would sweep past its target. An address
// without a slug yields no name at all, and staying silent about that is not an option:
// before this, the concatenation returned `undefined`, and the path was assembled as
// `undefined.mcp.json` — a file that nobody looked for and nobody cleaned up.
check(': the participant\'s mcp-config path is assembled from its address',
  /workers[\\/]cargos-api\.mcp\.json$/.test(store.participantMcpPath(home, task.id, 'worker:cargos-api'))
  && /workers[\\/]reviewer-cargos-api\.settings\.json$/.test(
    store.participantSettingsPath(home, task.id, 'reviewer:cargos-api')),
  `${store.participantMcpPath(home, task.id, 'worker:cargos-api')} · ${store.participantSettingsPath(home, task.id, 'reviewer:cargos-api')}`);

const noSlug = thrown(() => store.participantMcpPath(home, task.id, store.ORCHESTRATOR));
const noSlugSettings = thrown(() => store.participantSettingsPath(home, task.id, store.ORCHESTRATOR));
check(': an address without a slug yields no path — the refusal names the address instead of staying silent',
  noSlug.threw && /orchestrator/.test(noSlug.msg)
  && noSlugSettings.threw && /orchestrator/.test(noSlugSettings.msg),
  `${noSlug.msg} · ${noSlugSettings.msg}`);

// --- send validation -------------------------------------------------------

const bad = (patch) => thrown(() => store.sendMessage(home, task.id, {
  from: store.ORCHESTRATOR, to: 'worker:a', type: 'task', body: 'текст', ...patch,
}));

check('validation: an unknown message type is rejected', bad({ type: 'gossip' }).threw
  && /protocol/i.test(bad({ type: 'gossip' }).msg));
check('validation: unknown recipient address is rejected', bad({ to: 'somebody' }).threw);
check('validation: an empty body is rejected', bad({ body: '   ' }).threw);

const rejectedType = store.MESSAGE_TYPES.filter((t) => thrown(() => store.sendMessage(home, task.id, {
  from: store.ORCHESTRATOR, to: 'worker:a', type: t, body: t,
})).threw);
check(`validation: all ${store.MESSAGE_TYPES.length} protocol types are accepted`,
  rejectedType.length === 0, rejectedType.join(', '));

// --- routing policy ATI: a worker may not write to a worker ------------------------

// The consumer sets the rule, and the mechanism has exactly one: correspondence runs only
// with the task's orchestrator ( §3 — "routing policy is mandatory, the consumer hands over
// the rule"). There was not a single check for it: a mutation probe  (allow worker → worker)
// left `promptobus-mcp.test.mjs`, the E2E, and the entire root suite all green.
const between = thrown(() => store.sendMessage(home, task.id, {
  from: 'worker:a', to: 'worker:b', type: 'status', body: 'мимо оркестратора',
}));
check('policy ATI: worker does not write to worker — a refusal, not a silent delivery',
  between.threw && /do not write to each other/.test(between.msg), `${between.threw} · ${between.msg}`);

check('policy ATI: the refusal names the route — through the orchestrator',
  /through the orchestrator/.test(between.msg) && /pass this to them/.test(between.msg), between.msg);

// The refusal has no right to leave a single byte in the task: neither a link in the
// recipient's mailbox nor a record for the sender. The order is the same as in the engine —
// policy is asked BEFORE the side effect.
check('policy ATI: the refusal placed nothing — the recipient\'s mailbox is empty',
  store.countInbox(home, task.id, 'worker:b') === 0);

// Both lawful sides pass through: the rule forbids exactly "participant → participant".
const toOrch = thrown(() => store.sendMessage(home, task.id, {
  from: 'worker:a', to: store.ORCHESTRATOR, type: 'status', body: 'участник оркестратору',
}));
const fromOrch = thrown(() => store.sendMessage(home, task.id, {
  from: store.ORCHESTRATOR, to: 'worker:b', type: 'task', body: 'оркестратор участнику',
}));
check('policy ATI: "participant → orchestrator" and "orchestrator → participant" pass through',
  !toOrch.threw && !fromOrch.threw, `${toOrch.msg} · ${fromOrch.msg}`);

// Reviewer is a participant just the same: the rule looks at the record's role, not the
// address prefix.
store.upsertParticipant(home, task.id, store.participantRecord('reviewer:a', { repo: 'ns/repo' }));
const workerToReviewer = thrown(() => store.sendMessage(home, task.id, {
  from: 'worker:a', to: 'reviewer:a', type: 'question', body: 'напрямую ревьюеру',
}));
check('policy ATI: worker and reviewer do not correspond with each other either',
  workerToReviewer.threw && /do not write to each other/.test(workerToReviewer.msg),
  workerToReviewer.msg);

// --- delivery by address --------------------------------------------------------

const { messages: inbox } = store.readInbox(home, task.id, 'worker:a');

check('inbox: everything sent arrived, in send order',
  inbox.length === store.MESSAGE_TYPES.length
  && inbox.map((m) => m.type).join(',') === store.MESSAGE_TYPES.join(','),
  inbox.map((m) => m.type).join(','));

// The canon carries the participant record's ID; whoever prints assembles the address for
// humans.
check('inbox: sender and recipient are participant ids, task and stamp are in place',
  inbox[0].task === task.id && inbox[0].sender === 'orchestrator'
  && inbox[0].recipients.join(',') === 'worker-a'
  && typeof inbox[0].ts === 'string' && typeof inbox[0].id === 'string',
  JSON.stringify(inbox[0]));

check('inbox: a repeat read is empty — what was read is gone',
  store.readInbox(home, task.id, 'worker:a').messages.length === 0);

check('inbox: the unread counter', store.countInbox(home, task.id, 'worker:a') === 0);

// --- artifacts in the task files folder ------------------------------------------

const artSrc = path.join(SB, 'contract.json');
writeFileSync(artSrc, '{"event":"CargoCreated"}\n');
const withArt = store.sendMessage(home, task.id, {
  from: 'worker:a', to: store.ORCHESTRATOR, type: 'artifact', body: 'контракт события', artifactPath: artSrc,
});

check('artifact: a hard link in the task files folder under its own name',
  withArt.artifact.filename === 'contract.json'
  && /CargoCreated/.test(readFileSync(path.join(store.filesDir(home, task.id), 'contract.json'), 'utf8')),
  withArt.artifact.filename);

writeFileSync(artSrc, '{"event":"CargoUpdated"}\n');
const withArt2 = store.sendMessage(home, task.id, {
  from: 'worker:b', to: store.ORCHESTRATOR, type: 'artifact', body: 'второй контракт', artifactPath: artSrc,
});

check('artifact: a same-named one does not overwrite the previous — the link itself claims the name',
  withArt2.artifact.filename === 'contract-2.json'
  && /CargoCreated/.test(readFileSync(path.join(store.filesDir(home, task.id), 'contract.json'), 'utf8')),
  withArt2.artifact.filename);

const noFile = thrown(() => store.sendMessage(home, task.id, {
  from: store.ORCHESTRATOR, to: 'worker:a', type: 'artifact', body: 'нет файла',
  artifactPath: path.join(SB, 'ghost.txt'),
}));
check('artifact: a nonexistent path → refusal', noFile.threw && /artifact is missing/.test(noFile.msg), noFile.msg);
store.readInbox(home, task.id, store.ORCHESTRATOR);

// --- task lifecycle ----------------------------------------------------

check('resolveTaskId: one active task — it is the current one',
  store.resolveTaskId(home, null, null) === task.id);

const second = store.createTask(home, { id: 't20260813-130000', title: 'вторая', owner: null });
const many = thrown(() => store.resolveTaskId(home, null, null));
check('resolveTaskId: several active → refusal with a list',
  many.threw && many.msg.includes(task.id) && many.msg.includes(second.id), many.msg);

check('resolveTaskId: an explicit declaration outweighs the search',
  store.resolveTaskId(home, second.id, null) === second.id);

store.closeTask(home, second.id);
check('closeTask: the task is closed, the closing mark lives in adapter, there is again one active',
  store.readTask(home, second.id).status === 'done'
  && typeof store.readTask(home, second.id).adapter.closed === 'string'
  && store.resolveTaskId(home, null, null) === task.id);

check('resolveTaskId: a nonexistent task → refusal',
  thrown(() => store.resolveTaskId(home, 'нет-такой', null)).threw);

// --- : message to a nonexistent addressee -------------------------------

const bl156 = path.join(SB, 'bl156', '.promptobus');
const addressed = store.createTask(bl156, { id: 't20260827-110000', title: 'адресация', owner: null });
store.upsertParticipant(bl156, addressed.id,
  store.participantRecord('worker:cargos-api', { repo: 'loads_search/cargos-api' }));
const ghostArt = path.join(SB, 'bl156-artifact.json');
writeFileSync(ghostArt, '{"never":"sent"}\n');
const toGhost = thrown(() => store.sendMessage(bl156, addressed.id, {
  from: store.ORCHESTRATOR, to: 'worker:opechatka', type: 'task', body: 'бриф в пустоту', artifactPath: ghostArt,
}));

check(': the addressee is outside the task participants — a refusal, not a silent success',
  toGhost.threw && toGhost.msg.includes('worker:opechatka'), toGhost.msg);

check(': the refusal names the task participants — a typo in the slug is fixed at a glance',
  toGhost.msg.includes('worker:cargos-api') && toGhost.msg.includes('orchestrator'), toGhost.msg);

check(': no ghost mailbox is created',
  !existsSync(path.join(store.taskDir(bl156, addressed.id), 'inbox', 'worker-opechatka')));

// The addressee check stands before the artifact write: a refusal must not leave in the
// task files folder a file that nobody ordered.
check(': the artifact of a rejected message is not copied into the task',
  !existsSync(path.join(store.filesDir(bl156, addressed.id), 'bl156-artifact.json')));

const toKnown = store.sendMessage(bl156, addressed.id, {
  from: store.ORCHESTRATOR, to: 'worker:cargos-api', type: 'task', body: 'бриф участнику',
});
check(': a message to a task participant still goes through as before',
  toKnown.message.recipients.join(',') === 'worker-cargos-api'
  && store.countInbox(bl156, addressed.id, 'worker:cargos-api') === 1);

// --- two channels reporting something broken ------------------------------------------------

// The report about an unreadable entry goes into two channels: diagnostics for the human
// (the adapter's stderr) and a list for the agent (on the MCP path, stderr is read by the
// harness, not the session, and without the list the message would disappear silently). The
// package itself does not write to the process streams at all — the door assembles the line.
const bl250 = path.join(SB, 'bl250', '.promptobus');
const dirty = store.createTask(bl250, { id: 'bitoe-t20260829-040000', title: 'битый вход', owner: null });
store.upsertParticipant(bl250, dirty.id, store.participantRecord('worker:a'));
for (const n of [1, 2, 3]) {
  store.sendMessage(bl250, dirty.id, {
    from: 'worker:a', to: store.ORCHESTRATOR, type: 'status', body: `цел ${n}`,
  });
}
const dirtyBox = store.inboxDir(bl250, dirty.id, store.ORCHESTRATOR);
const dirtyName = '20260829T040000000-9999-abcdef.json';
writeFileSync(path.join(dirtyBox, dirtyName), 'не json вовсе');
const read = captureSplit(() => store.readInbox(bl250, dirty.id, store.ORCHESTRATOR));

check('a broken file at the front of the queue does not take down the intact ones — all three reached the reader',
  read.value.messages.map((m) => m.body).join(',') === 'цел 1,цел 2,цел 3',
  read.value.messages.map((m) => m.body).join(','));

check('report to the agent: the broken list names the file and where it was set aside',
  read.value.broken.some((m) => m.includes(dirtyName) && m.includes('broken')),
  read.value.broken.join(' | '));

check('report to the human: the same line went to the door\'s stderr, not to the package\'s streams',
  read.err.includes(dirtyName), read.err);

check('mailbox is no longer jammed — what was read is gone, there is no broken entry left in it',
  store.countInbox(bl250, dirty.id, store.ORCHESTRATOR) === 0
  && !existsSync(path.join(dirtyBox, dirtyName)));

// --- : the task journal is read once per request ------------------------------

// Task resolution, the owner gate, the notification alarm, the reply header, and the render
// itself each ask the journal separately: one tool call used to cost four to six reads and
// parses. The cache lives exactly as long as the synchronous span it wraps; the proof that
// there is only one read is the disk itself: the file is removed between the two reads.
const bl261 = path.join(SB, 'bl261', '.promptobus');
const cached = store.createTask(bl261, { id: 'kesh-t20260829-070000', title: 'кэш журнала', owner: null });
const cachedFile = store.taskFile(bl261, cached.id);
const cachedRaw = readFileSync(cachedFile, 'utf8');
let inSpan = null;
const spanTry = thrown(() => {
  inSpan = store.withTaskCache(() => {
    const first = store.readTask(bl261, cached.id);
    rmSync(cachedFile, { force: true });
    return [first.title, store.readTask(bl261, cached.id).title];
  });
});
check(': inside a request the journal is read once — the second read never touches the disk',
  !spanTry.threw && inSpan?.join('|') === 'кэш журнала|кэш журнала', spanTry.msg || String(inSpan));

writeFileSync(cachedFile, cachedRaw);
const outOfSpan = thrown(() => {
  rmSync(cachedFile, { force: true });
  store.readTask(bl261, cached.id);
});
check(': outside a request the read is unchanged — a removed journal fails, same as before',
  outOfSpan.threw && /is not in/.test(outOfSpan.msg), outOfSpan.msg);

writeFileSync(cachedFile, cachedRaw);
const afterWrite = store.withTaskCache(() => {
  store.readTask(bl261, cached.id);
  store.patchTask(bl261, cached.id, { title: 'переименована' });
  return store.readTask(bl261, cached.id).title;
});
check(': writing the journal invalidates the cache — the next read within the same span sees the new value',
  afterWrite === 'переименована', afterWrite);

// Under the lock, the disk is read, not the cache: read-modify-write must see what the
// neighbor wrote, the one the lock waited for. The neighbor is played by a write that bypasses
// the door — that way the cache is left holding the old snapshot. What gets written is a STORE
// RECORD, not its view: the journal is versioned, and the reader will not accept a view without
// a version — it would not even be a neighbor's edit then.
const sneaky = { ...JSON.parse(readFileSync(cachedFile, 'utf8')), title: 'правка соседа' };
const underLock = store.withTaskCache(() => {
  store.readTask(bl261, cached.id);
  writeFileSync(cachedFile, JSON.stringify(sneaky, null, 2) + '\n');
  const seen = store.withTaskLock(bl261, cached.id, () => store.readTask(bl261, cached.id).title);
  return [seen, store.readTask(bl261, cached.id).title];
});
check(': under the lock the journal is read from disk, and the lock on exit invalidates the request cache',
  underLock.join('|') === 'правка соседа|правка соседа', underLock.join('|'));

// --- listing survives a broken journal --------------------------------------

const bl149 = path.join(SB, 'bl149', '.promptobus');
const sane = store.createTask(bl149, { id: 't20260827-100000', title: 'исправная', owner: null });
const brokenTask = store.createTask(bl149, { id: 't20260827-100001', title: 'битая', owner: null });
// This is what the journal of a process that died mid non-atomic write looks like.
writeFileSync(store.taskFile(bl149, brokenTask.id), '{\n  "id": "t20260827-1000');
const listed = captureSplit(() => store.listTasks(bl149));

check(': a broken journal does not crash the listing — the sound task is in place',
  listed.value.map((t) => t.id).join(',') === sane.id, listed.value.map((t) => t.id).join(','));

check(': the skipped task is named to the human by its file',
  listed.err.includes(brokenTask.id) && listed.err.includes('task.json'), listed.err);

mkdirSync(path.join(store.tasksDir(bl149), 'не id задачи'), { recursive: true });
check(': a foreign directory next to the tasks is filtered out, not thrown as a refusal',
  !thrown(() => quiet(() => store.listTasks(bl149))).threw);

// --- : the adapter's boundary — the driver is reached only through the registry ---------
//
// A second production driver must be laid into the `harness → driver` map without touching a
// single file outside it. This holds because nobody but the map itself imports a driver: the
// line `import … from './driver-claude.js'` in any mechanism module is exactly the link that
// would force every next harness to be threaded by name through all these files.
//
// The gate stands here, not in the package suite: that one guards the OPPOSITE direction —
// harness names in the core's sources ([promptobus-package.test.mjs](promptobus-package.test.mjs)).
// The whole of `lib/**` and `bin/**` is checked: a command that reaches a driver past the map
// breaks the boundary the same way a bus module would.
//
// Mutation probe: bring back `import { stallRoute } from './driver-claude.js'` in `status.js`
// — the gate goes red with the file's name and the imported module's name.

// The driver files themselves: the map, two drivers, and their session registries. Importing
// each other is lawful for them — it is one subject spread across files. The harness
// availability adapter is a file of that same subject: it asks the harness about the ACCOUNT
// using the harness's own protocol, the driver declares it as the `availability` field, and
// nothing sticks out of it to the outside — the map remains the one and only door (`adapterOf`
// in `drivers.js`).
const DRIVER_OWN = new Set([
  'lib/drivers.js',
  'lib/driver-claude.js',
  'lib/liftoff.js',
  'lib/driver-cursor.js',
  'lib/cursor-persist.js',
  'lib/driver-codex.js',
  'lib/codex-rpc.js',
  'lib/codex-session.js',
  'lib/codex-hold.js',
  'lib/model-routing/adapter-codex.js',
]);

// Modules that nothing from outside touches at all: the drivers themselves and their session
// registries. The map (`drivers.js`) is not on the list — it is the door itself, and everyone
// imports it.
// `adapter-claude` is here and NOT in `DRIVER_OWN` above: the Claude availability
// adapter imports no driver module at all, so it needs no exemption — but the
// driver's own dictionary reaches it as an argument, and nothing else in the
// mechanism has business calling a harness probe directly.
const DRIVER_PRIVATE = /(?:^|\/)(driver-claude|adapter-claude|liftoff|driver-cursor|cursor-persist|driver-codex|codex-rpc|codex-session|codex-hold|adapter-codex)\.js$/;

// A module specifier in a static import, a re-export, and a dynamic `import(...)`. Prose is
// not affected by this: `from` or `import` must stand right before the quote.
const MODULE_SPEC = /(?:\bfrom|\bimport)\s*\(?\s*'([^']+)'/g;

function jsFilesUnder(dir, rel, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const at = path.join(dir, e.name);
    const key = `${rel}/${e.name}`;
    if (e.isDirectory()) jsFilesUnder(at, key, out);
    else if (e.name.endsWith('.js')) out.push([key, at]);
  }
  return out;
}

const MECHANISM_ROOT = path.join(here, '..');
const adapterFiles = [
  ...jsFilesUnder(path.join(MECHANISM_ROOT, 'lib'), 'lib'),
  ...jsFilesUnder(path.join(MECHANISM_ROOT, 'bin'), 'bin'),
];

const crossings = [];
for (const [rel, file] of adapterFiles) {
  if (DRIVER_OWN.has(rel)) continue;
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(MODULE_SPEC)) {
    if (!DRIVER_PRIVATE.test(m[1])) continue;
    crossings.push(`${rel} → ${m[1]} (line ${text.slice(0, m.index).split('\n').length})`);
  }
}

check(': the boundary gate sees the mechanism files — there is something to check',
  adapterFiles.length > 20 && adapterFiles.some(([rel]) => rel === 'lib/status.js')
  && adapterFiles.some(([rel]) => rel === 'bin/promptobus.js'),
  `${adapterFiles.length} files`);

check(': nobody but the registry map imports a driver and its session registry',
  crossings.length === 0, crossings.join(' | '));

// There is one door, and it is not empty: the map itself must import a driver — otherwise the
// gate above would be green on a mechanism that has no drivers at all.
const doorSrc = readFileSync(path.join(MECHANISM_ROOT, 'lib', 'drivers.js'), 'utf8');
check(': the registry map imports a driver itself — the gate is not green on emptiness',
  /from '\.\/driver-claude\.js'/.test(doorSrc)
  && /export const REGISTRY/.test(doorSrc), doorSrc.split('\n').slice(0, 3).join(' | '));

// : there are two drivers in the map, and both are taken by it itself. This check is not a
// duplicate of the previous one: that one guards the gate against emptiness, this one against
// a map where a second production driver is declared but not wired in, and `--harness cursor`
// would refuse with "unknown harness".
check(': the registry map holds both production drivers — claude and cursor',
  /from '\.\/driver-cursor\.js'/.test(doorSrc)
  && /\[CLAUDE\]: claudeDriver/.test(doorSrc) && /\[CURSOR\]: cursorDriver/.test(doorSrc),
  doorSrc.split('\n').filter((l) => /driver-|Driver/.test(l)).join(' | '));
check(': the registry map holds a third production driver — codex',
  /from '\.\/driver-codex\.js'/.test(doorSrc) && /\[CODEX\]: codexDriver/.test(doorSrc),
  doorSrc.split('\n').filter((l) => /codex|CODEX/.test(l)).join(' | '));

// Halves of the liftoff no longer stick out of the driver: `spawn.js` and `review.js` used to
// assemble argv and the config themselves, calling `driver.spawnArgv` and `driver.mcpConfig`.
// Now it is one operation, `prepare`, and bringing back the halves would mean bringing the
// command assembly back outside the driver.
const driverSrc = readFileSync(path.join(MECHANISM_ROOT, 'lib', 'driver-claude.js'), 'utf8');
check(': the argv and config assembly is not exported outward — it is half of `prepare`',
  !/^export function (spawnArgv|mcpConfig)\b/m.test(driverSrc),
  (driverSrc.match(/^export function \w+/gm) ?? []).join(', '));

// --- : the driver's surface — only what the contract declares ---------------
//
// The boundary gate above holds the IMPORT: a driver is taken through the door, not directly.
// It does not hold the second half — that what is called on the object taken is exactly what
// the contract declared. Review found four such mismatches at once: `probeWake` in the
// declaration against `checkWake` in the implementation and at the call site, `sessionEnv`
// with one parameter in the declaration against two at the call, an undeclared
// `shadowedUserServers`, and optional `options`/`phrases` that the adapter dereferences
// without a check. None of these is caught by the import: the driver WAS taken correctly.
//
// The parsing goes by the DECLARATIONS in `driver.ts`, not by substring: a name encountered in
// its prose is not a declaration, and a gate that reads the whole file would go green on a
// comment.
//
// The convention this gate holds by doing so: a driver is put into a variable named `driver`
// or `lifter` (or the plan's `.driver` field), and the dictionaries are taken by member —
// `.options.<name>`, `.phrases.<name>`, `.capabilities.<name>`. A helper that hands over the
// whole dictionary would hide the name from the parsing, and the surface would stop being
// checked again.

const DRIVER_TS = path.join(MECHANISM_ROOT, 'src', 'driver.ts');

/** An interface body by name — with brace counting: there are nested object types inside. */
function interfaceBody(src, name) {
  const head = `export interface ${name} {`;
  const at = src.indexOf(head);
  if (at < 0) return null;
  let i = at + head.length;
  let depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') depth -= 1;
    i += 1;
  }
  return depth === 0 ? src.slice(at + head.length, i - 1) : null;
}

/** Names of interface members: a field or method at the start of a line, `readonly` and `?` are optional. */
function interfaceMembers(src, name) {
  const body = interfaceBody(src, name);
  if (body === null) return null;
  const out = new Set();
  for (const line of body.split('\n')) {
    const m = /^\s*(?:readonly\s+)?([A-Za-z_]\w*)\??\s*[(:]/.exec(line);
    // Comment lines are cut off by a marker, not a match: `* `foo`: something` in JSDoc would
    // otherwise be read as a declaration.
    if (m && !/^\s*(?:\/\/|\/?\*)/.test(line)) out.add(m[1]);
  }
  return out;
}

const driverTs = readFileSync(DRIVER_TS, 'utf8');
const SURFACE = {
  Driver: interfaceMembers(driverTs, 'Driver'),
  DriverPhrases: interfaceMembers(driverTs, 'DriverPhrases'),
  DriverOptions: interfaceMembers(driverTs, 'DriverOptions'),
  DriverCapabilities: interfaceMembers(driverTs, 'DriverCapabilities'),
};

check(': the contract\'s declarations are parsed — there is something to check against',
  Object.entries(SURFACE).every(([, set]) => set && set.size >= 4)
  && SURFACE.Driver.has('prepare') && SURFACE.Driver.has('stop')
  && SURFACE.DriverPhrases.has('sessions') && SURFACE.DriverOptions.has('effortLevels')
  && SURFACE.DriverCapabilities.has('denyTools'),
  Object.entries(SURFACE).map(([k, v]) => `${k}: ${v ? [...v].join(',') : 'not parsed'}`).join(' | '));

// Prose does not count as a declaration — that is exactly what distinguishes parsing from a
// grep. The words below are present in `driver.ts` (in comments and in neighboring types), but
// are not members of the four interfaces: a naive edit reading "the name occurs in the file"
// would turn this check red.
const PROSE_ONLY = ['registry', 'notification', 'harness', 'participant'];
check(': a name from driver.ts prose does not count as declared — parsing goes by declarations, not by substring',
  PROSE_ONLY.every((word) => driverTs.includes(word)
    && !Object.values(SURFACE).some((set) => set.has(word))),
  PROSE_ONLY.filter((w) => Object.values(SURFACE).some((set) => set.has(w))).join(', ') || 'none');

// Comments are stripped before parsing — the same trick as at the package boundary: prose
// legitimately names the driver's operations, and a gate reading it on par with code would go
// red on the retelling. A line comment is taken only from the start of a line: `//` also turns
// up inside URLs.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter((l) => !/^\s*(?:\/\/|\*)/.test(l)).join('\n');
}

const USE = {
  // `.options.<name>`, `.phrases.<name>`, `.capabilities.<name>` — the dictionary is taken by member.
  member: /\.(options|phrases|capabilities)\??\.([A-Za-z_]\w*)/g,
  // Dictionary destructuring: `const { a, b: c } = <something>.options;`.
  destructure: /(?:const|let)\s*\{([^}]+)\}\s*=\s*[^;]*?\.(options|phrases)\b/g,
  // The dictionary is taken whole into a variable: `const HARNESS = <something>.options;`.
  bind: /(?:const|let)\s+([A-Za-z_]\w*)\s*=\s*[^;]*?\.(options|phrases)\s*;/g,
  // A driver operation: reference to the variable it is stored in.
  op: /\b(?:driver|lifter)\??\.([A-Za-z_]\w*)/g,
};
const IFACE = { options: 'DriverOptions', phrases: 'DriverPhrases', capabilities: 'DriverCapabilities' };

const undeclared = [];
const seen = { Driver: new Set(), DriverPhrases: new Set(), DriverOptions: new Set(), DriverCapabilities: new Set() };
for (const [rel, file] of adapterFiles) {
  if (DRIVER_OWN.has(rel)) continue;
  const text = stripComments(readFileSync(file, 'utf8'));
  const want = (iface, name) => {
    seen[iface].add(name);
    if (!SURFACE[iface].has(name)) undeclared.push(`${rel}: ${iface}.${name}`);
  };
  for (const m of text.matchAll(USE.member)) want(IFACE[m[1]], m[2]);
  for (const m of text.matchAll(USE.destructure)) {
    for (const part of m[1].split(',')) {
      const key = part.split(':')[0].trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_]\w*$/.test(key)) want(IFACE[m[2]], key);
    }
  }
  for (const m of text.matchAll(USE.bind)) {
    const iface = IFACE[m[2]];
    for (const use of text.matchAll(new RegExp(`\\b${m[1]}\\??\\.([A-Za-z_]\\w*)`, 'g'))) want(iface, use[1]);
  }
  for (const m of text.matchAll(USE.op)) want('Driver', m[1]);
}

check(': the adapter calls on the driver only what the contract declared',
  undeclared.length === 0, undeclared.join(' | '));

// A gate that found no references is green on emptiness — and that is exactly how it would
// look if the variable-naming convention drifted apart from the code.
check(': the gate sees the driver\'s surface — operations, the options dictionary, and words',
  seen.Driver.size >= 8 && seen.DriverOptions.size >= 4 && seen.DriverPhrases.size >= 2,
  `Driver: ${[...seen.Driver].sort().join(',')} · options: ${[...seen.DriverOptions].sort().join(',')}`
  + ` · phrases: ${[...seen.DriverPhrases].sort().join(',')}`);

// --- : the required dictionary is declared by EVERY production driver -----------
//
// The surface gate above holds one side — that the adapter calls only what is declared. The
// other side is a mirror image: that every driver in the map declared everything the contract
// named required. Neither one catches the other. The price of non-compliance is known by name:
// without `defaultModel` a participant is spun up with a model its binary does not have, and
// without `promptRules` its prompt silently loses the harness's rules.
//
// Being required is read from `driver.ts` itself: a member marked `?` is optional, and
// requiring it anyway would mean inventing a contract on its behalf.
function requiredMembers(src, name) {
  const body = interfaceBody(src, name);
  const out = new Set();
  for (const line of (body ?? '').split('\n')) {
    const m = /^\s*(?:readonly\s+)?([A-Za-z_]\w*)(\??)\s*[(:]/.exec(line);
    if (m && !/^\s*(?:\/\/|\/?\*)/.test(line) && !m[2]) out.add(m[1]);
  }
  return out;
}

const REQUIRED = {
  options: requiredMembers(driverTs, 'DriverOptions'),
  phrases: requiredMembers(driverTs, 'DriverPhrases'),
};
const { REGISTRY } = await import(path.join(MECHANISM_ROOT, 'lib', 'drivers.js'));
const missingSurface = [];
for (const [harness, driver] of Object.entries(REGISTRY.drivers)) {
  for (const key of ['options', 'phrases']) {
    for (const name of REQUIRED[key]) {
      if (driver[key]?.[name] === undefined) missingSurface.push(`${harness}: ${key}.${name}`);
    }
  }
}
check(': the contract\'s required dictionary is declared by every driver in the map',
  missingSurface.length === 0 && REQUIRED.options.has('defaultModel') && REQUIRED.phrases.has('tool')
  && Object.keys(REGISTRY.drivers).length >= 2,
  `${missingSurface.join(' | ') || 'all declared'} · drivers ${Object.keys(REGISTRY.drivers).length}`);

// Harness words in the adapter are lawful only at the driver. The status/stalls/notification/
// warden printing is harness-neutral: the route and the confirmation ("job not found") arrive
// via phrases or stallRoute. The cutoff is the list of printing files: without it the grep goes
// red on spawn/review, where `claude --bg` is the subject of a liftoff, not status printing.
const PRINT_SURFACE = new Set([
  'lib/status.js',
  'lib/stalls.js',
  'lib/notification.js',
  'lib/warden.js',
]);
check(': the print surface is found in adapterFiles — the gate is not green on a rename',
  [...PRINT_SURFACE].every((rel) => adapterFiles.some(([r]) => r === rel)),
  [...PRINT_SURFACE].filter((rel) => !adapterFiles.some(([r]) => r === rel)).join(', ') || 'all in place');
const HARNESS_WORDS = /job not found|claude |agent |codex /;
function harnessWordHits(rel, text, { comments = false } = {}) {
  return (comments ? text : stripComments(text)).split('\n')
    .filter((line) => HARNESS_WORDS.test(line))
    .map((line) => `${rel}: ${line.trim().slice(0, 90)}`);
}
const surfaceHits = [];
const naiveHits = [];
for (const [rel, file] of adapterFiles) {
  if (DRIVER_OWN.has(rel)) continue;
  const text = readFileSync(file, 'utf8');
  // Print surface is judged on code: comments may name a harness as the subject of
  // a lift (`claude --bg` in spawn.js). Naive grep keeps comments so the cutoff
  // is proven non-empty — dest adapter code outside drivers is already clean.
  naiveHits.push(...harnessWordHits(rel, text, { comments: true }));
  if (PRINT_SURFACE.has(rel)) surfaceHits.push(...harnessWordHits(rel, text));
}
check(': harness-neutral printing does not contain harness words',
  surfaceHits.length === 0, surfaceHits.join(' | '));
check(': the gate\'s cutoff is not empty — a naive grep without it falsely triggers',
  naiveHits.length > surfaceHits.length, naiveHits.slice(0, 4).join(' | '));
