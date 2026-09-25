// Claude Code driver — the two halves PB-165 touches. Run: npm test
//
// Subject: what a participant lifted in a PROMPT-BYPASSING mode costs the bus,
// and how the state machine reads the mark such a session leaves.
//
// The two halves are one fact seen from both ends. A session lifted with
// `--permission-mode bypassPermissions` does not deliver a peer message whose
// sender did not attest its permission mode — it HOLDS it as a dialog and reports
// `waitingFor: "permission prompt"` while its own turn runs on and finishes. So
// the bus loses the one notification the participant must never miss, and calls a
// person to a session that is working.
//
// **The numbers here come from a live measurement, not from reading the flag
// names** (2026-09-11, claude 2.1.263, one background session per mode, the
// warden's postcard knocked into its messaging socket and the record and log read
// back):
//
//   bypassPermissions  → HELD. `status: waiting`, `state: done`,
//                        `waitingFor: "permission prompt"`; the log carries
//                        "Held peer message … not delivered to Claude (1 held).
//                        The sender did not attest its permission mode and this
//                        session bypasses prompts. … or set "crossSessionInbound"
//                        to "accept"". The session finished its shell command and
//                        answered with the dialog still standing.
//   bypassPermissions with "crossSessionInbound": "accept"
//                      → delivered. No dialog at all: the record stayed
//                        `busy`/`working` through the knock and the body reached
//                        the session.
//   dontAsk, acceptEdits, auto
//                      → delivered, each without the key. `dontAsk` is NOT a
//                        prompt-bypassing mode in the sense the dialog means,
//                        however its name reads.
//
// Nothing here lifts a live session: the subject is the file the driver writes and
// the predicate the state machine applies to the mark, both pure.
import { check } from './check.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSandbox, resetCliCaches, stubCommand } from './sandbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SB = makeSandbox('promptobus-driver-claude-');
const HOME = path.join(SB, '.promptobus');

const store = await import(path.join(here, '..', 'lib', 'store.js'));
const {
  claudeDriver, PERMISSION_MODES, PROMPT_BYPASS_MODES, bypassesPrompts, stallRoute, sessionStall,
} = await import(path.join(here, '..', 'lib', 'driver-claude.js'));
const { stallStands } = await import(path.join(here, '..', 'lib', 'status.js'));

// --- the participant settings file, per permission mode ----------------------

const planFor = (permissionMode) => claudeDriver.prepare({
  ref: 'a2a-probe-t20260911-000000-api',
  mcp: { servers: {} },
  prompt: 'work',
  model: 'opus',
  permissionMode,
  mcpConfigPath: path.join(SB, 'mcp.json'),
  settingsPath: path.join(SB, 'settings.json'),
  guardCommand: 'promptobus guard',
});

const settingsOf = (mode) => planFor(mode).settings;

check('PB-165: the measured list of prompt-bypassing modes is a subset of the modes the flag takes',
  PROMPT_BYPASS_MODES.length > 0 && PROMPT_BYPASS_MODES.every((m) => PERMISSION_MODES.includes(m)),
  PROMPT_BYPASS_MODES.join(', '));

check(': bypassPermissions is the one mode measured to hold an unattested peer message',
  bypassesPrompts('bypassPermissions') === true
  && PROMPT_BYPASS_MODES.length === 1,
  PROMPT_BYPASS_MODES.join(', '));

check(': dontAsk is not one of them, however its name reads — it took the postcard in the live probe',
  bypassesPrompts('dontAsk') === false);

check(': a participant lifted with bypassPermissions carries the key the harness dialog names',
  settingsOf('bypassPermissions').crossSessionInbound === 'accept',
  JSON.stringify(settingsOf('bypassPermissions')));

// Every other mode is left alone: the dialog is a real review step there, and a
// person is in reach to answer it. Opening every session to unattested peers
// would be a change no measurement asked for.
for (const mode of PERMISSION_MODES.filter((m) => !bypassesPrompts(m))) {
  check(`: ${mode} leaves the key out — its sessions take the postcard without one`,
    settingsOf(mode).crossSessionInbound === undefined,
    JSON.stringify(settingsOf(mode)));
}
check(': a lift with no mode at all is the harness default and carries no key either',
  settingsOf(null).crossSessionInbound === undefined
  && settingsOf(undefined).crossSessionInbound === undefined,
  JSON.stringify(settingsOf(null)));

// The plan is what `--dry-run` prints and what the lift executes, so the key has
// to be in the FILE, not only in the object beside it.
const written = planFor('bypassPermissions').files
  .find((f) => f.path === path.join(SB, 'settings.json'));
check(': the key is in the file the lift writes, not only in the plan object',
  JSON.parse(written.text).crossSessionInbound === 'accept', written.text);
check(': and the rest of the file is untouched by it',
  JSON.parse(written.text).enableAllProjectMcpServers === true
  && JSON.parse(written.text).disableRemoteControl === true
  && JSON.parse(written.text).viewMode === 'focus'
  && Array.isArray(JSON.parse(written.text).hooks?.Stop), written.text);

// --- the participant settings file, per role ---------------------------------

// Measured 2026-09-24 on claude 2.1.280: without the key a lifted session's Write in the
// clone root is refused; with it in this file the Write lands (05-drivers, the approver's guard).
const roleFile = (role) => claudeDriver.prepare({
  ref: 'a2a-probe-t20260911-000000-api',
  role,
  mcp: { servers: {} },
  prompt: 'work',
  model: 'opus',
  permissionMode: 'auto',
  mcpConfigPath: path.join(SB, 'mcp.json'),
  settingsPath: path.join(SB, 'settings.json'),
  guardCommand: 'promptobus guard',
}).files.find((f) => f.path === path.join(SB, 'settings.json'));

check('PB-240: the approver\'s settings file switches off the background-session worktree guard',
  JSON.parse(roleFile('approver').text).worktree?.bgIsolation === 'none', roleFile('approver').text);
for (const role of ['worker', 'reviewer', null]) {
  check(`: a ${role ?? 'role-less'} lift keeps the guard — its file names no worktree key`,
    JSON.parse(roleFile(role).text).worktree === undefined, roleFile(role).text);
}

for (const role of ['worker', 'reviewer', 'approver']) {
  const article = role === 'approver' ? 'an' : 'a';
  check(`: ${article} ${role} lift carries disableRemoteControl: true`,
    JSON.parse(roleFile(role).text).disableRemoteControl === true, roleFile(role).text);
}

// --- the mark such a session leaves, and what the state machine does with it ---

// The driver still classifies the dialog as `permission`: it sees one field, and
// the harness puts both dialogs behind it. What changed is the predicate above it.
check(': the driver reads the record it was given — a dialog is a permission stall',
  sessionStall({ status: 'waiting', state: 'done', waitingFor: 'permission prompt' }, null).kind === 'permission');

const TASK = 'held-t20260911-000000';
store.createTask(HOME, { id: TASK, title: 'a held postcard is not a permission prompt' });
const NAME = `a2a-${TASK}-api`;
store.upsertParticipant(HOME, TASK, store.participantRecord('worker:api', { name: NAME }));
// The predicate reads the participant RECORD — `address` lives in its metadata,
// as it does in the task journal the report is built from.
const P = store.participantRecord('worker:api', { name: NAME });
const DIALOG = { kind: 'permission', reason: 'permission prompt' };

const at = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const activatedAt = at(-60000);

check(': no end-of-turn mark at all — the stall stays a stall, the first prompt of a run is not silenced',
  stallStands(HOME, TASK, P, DIALOG) === true);

// The participant was knocked at, carried on with the turn it was in, ENDED that
// turn and reported. Both marks are newer than the activation, so the dialog
// standing on its record did not stop it: that is the held postcard, and nobody
// is called to it.
store.writeHealth(HOME, TASK, { 'worker:api': { knockedAt: activatedAt } });
store.markTurn(HOME, TASK, 'worker:api', at(-30000));
const said = store.sendMessage(HOME, TASK, {
  from: 'worker:api', to: 'orchestrator', type: 'status', body: 'carried on with the turn',
});
check(': a participant that ended its turn AND reported after the knock held a message, it is not at a prompt',
  stallStands(HOME, TASK, P, DIALOG) === false, JSON.stringify(said.message.ts));

// Neither mark lifts the stall on its own, and this is the half the stub harness
// plays: a turn that ended AFTER the activation with nothing sent since is still
// reported. The knock is placed past the one message this participant ever sent,
// and the turn end past the knock — so only the sent-message half of the
// conjunction can hold the stall here, and a predicate that dropped it would go
// red on this line.
const knockPast = Date.parse(said.message.ts) + 1000;
store.writeHealth(HOME, TASK, { 'worker:api': { knockedAt: new Date(knockPast).toISOString() } });
store.markTurn(HOME, TASK, 'worker:api', new Date(knockPast + 1000).toISOString());
check(': a turn that ended after the knock but said nothing since is a prompt, and it is reported',
  stallStands(HOME, TASK, P, DIALOG) === true);

// The other half: it spoke, but the turn never reached its end — which is what a
// prompt hit mid-turn looks like.
store.writeHealth(HOME, TASK, { 'worker:api': { knockedAt: activatedAt } });
store.markTurn(HOME, TASK, 'worker:api', new Date(Date.parse(activatedAt) - 1000).toISOString());
check(': a dialog inside a turn that never ended is a real prompt, and it is reported',
  stallStands(HOME, TASK, P, DIALOG) === true);

// The end of the same fact: a participant that had already yielded its turn before
// the knock never wakes from a held postcard at all. Its turn mark is OLDER than
// the activation, so the stall stands — deaf is not the same as working, and a
// person has something to do there.
store.markTurn(HOME, TASK, 'worker:api', at(-20000));
store.writeHealth(HOME, TASK, { 'worker:api': { knockedAt: at(-5000) } });
check(': a participant that ended its turn before the knock is still reported — it is deaf, not working',
  stallStands(HOME, TASK, P, DIALOG) === true);

// The gate is the `permission` branch only. A limit is cleared by time, not by a
// turn or a message, and it is reported on marks that would lift a dialog.
store.markTurn(HOME, TASK, 'worker:api', at(-1000));
store.writeHealth(HOME, TASK, { 'worker:api': { knockedAt: activatedAt } });
check(': a limit is still reported however the marks fall — time lifts it, not a turn',
  stallStands(HOME, TASK, P, { kind: 'limit', reason: 'session limit' }) === true);
check(': and on those same marks the dialog is not',
  stallStands(HOME, TASK, P, DIALOG) === false);

// --- the route a person reads ------------------------------------------------

const route = stallRoute({ kind: 'permission' }, 'abc123', 'Worker: X');
check(': the permission route still names the session route for a prompt of its own work',
  /claude attach abc123/.test(route) && /claude stop abc123/.test(route), route);
check(': and it names the other dialog behind the same field, with the key that ends it',
  /held message from another session/i.test(route)
  && /crossSessionInbound/.test(route)
  && /bypassPermissions/.test(route), route);
// PB-176: the same field is also set where nothing is standing, and the route said a
// person was needed anyway. It must name the third reading and claim none of them.
check(': and the third reading — a refusal that has already returned, where nobody is wanted',
  /refusal that has already returned/i.test(route)
  && /nothing is standing/i.test(route)
  && /permission rule decided outside it/i.test(route), route);
check(': and it no longer asserts that only a person can answer',
  !/only a person/i.test(route), route);

const approverRoute = stallRoute({ kind: 'gone', address: 'approver:api' }, null, null);
check(': an approver without a session is returned to the review --approver lift, never worker spawn',
  /lift the approver again/.test(approverRoute)
  && !/lift the worker/.test(approverRoute), approverRoute);

// --- the harness binary after a lift: the host's door, not PATH ------------------
// The operations are called directly; `sweep` and `stop` read the same answers through the snapshot.
const { bindHarnessBins } = await import(path.join(here, '..', 'lib', 'harness-home.js'));
bindHarnessBins(null);
bindHarnessBins({ resolveToolBin: () => ({ ok: false, reason: 'claude: not found in PATH or in ~/.local/bin' }) });
let refused = null;
try {
  claudeDriver.inspect('sess-offpath');
} catch (e) {
  refused = e;
}
check('PB-239: inspect with no binary to run refuses with the host reason — the snapshot keeps it on that line',
  refused?.constructor?.name === 'GateError'
  && /the harness binary was not found: claude: not found in PATH or in ~\/\.local\/bin/.test(refused.message),
  String(refused));
const noBinary = await claudeDriver.stop('sess-offpath');
check(': stop with no binary is a refusal naming it — not "nothing to stop"',
  noBinary.ok === false && noBinary.stopped === false && /the harness binary was not found/.test(noBinary.note),
  JSON.stringify(noBinary));

const GARBLED = path.join(SB, 'garbled-bin');
stubCommand(GARBLED, 'claude', "process.stdout.write('not a list');");
bindHarnessBins(null);
bindHarnessBins({ resolveToolBin: () => ({ ok: true, bin: path.join(GARBLED, 'claude') }) });
resetCliCaches();
check(': a binary that ran and answered nothing readable leaves inspect at null — unknown, not a refusal',
  claudeDriver.inspect('sess-offpath') === null);
const unread = await claudeDriver.stop('sess-offpath');
check(': and stop on that unread registry refuses too — an unread list says nothing about the session',
  unread.ok === false && unread.stopped === false && /claude agents --json is unreadable/.test(unread.note),
  JSON.stringify(unread));

const LISTING = path.join(SB, 'listing-bin');
stubCommand(LISTING, 'claude',
  "process.stdout.write(JSON.stringify([{ name: 'sess-offpath', id: 'off-1', pid: 4242, status: 'idle' }]));");
bindHarnessBins(null);
bindHarnessBins({
  resolveToolBin: () => ({ ok: false, bin: path.join(LISTING, 'claude'), reason: 'claude 2.1.100 is below the floor' }),
});
resetCliCaches();
let refusedVersion = null;
try {
  refusedVersion = claudeDriver.inspect('sess-offpath');
} catch (e) {
  refusedVersion = String(e);
}
check(': a host that refuses the version but names the binary still has it read — the version gate is the lift\'s',
  refusedVersion?.state === 'alive', JSON.stringify(refusedVersion));

bindHarnessBins(null);
bindHarnessBins({ resolveToolBin: () => ({ ok: true, bin: path.join(LISTING, 'claude') }) });
bindHarnessBins({ resolveToolBin: () => ({ ok: false, reason: 'a second host, bound later' }) });
resetCliCaches();
let movedBy = null;
let firstHost = null;
try {
  firstHost = claudeDriver.inspect('sess-offpath');
} catch (e) {
  movedBy = e;
}
check(': the first host bound wins — a host bound later does not move the binary',
  !movedBy && firstHost?.state === 'alive', String(movedBy ?? JSON.stringify(firstHost)));

const LOCKED = path.join(SB, 'locked-bin');
mkdirSync(LOCKED, { recursive: true });
writeFileSync(path.join(LOCKED, 'claude'), '#!/bin/sh\n', { mode: 0o644 });
bindHarnessBins(null);
bindHarnessBins({ resolveToolBin: () => ({ ok: true, bin: path.join(LOCKED, 'claude') }) });
resetCliCaches();
const locked = await claudeDriver.stop('sess-offpath');
check(': a named binary the system will not start is named with its code — not an unread registry',
  locked.ok === false && /the harness binary does not start: .*locked-bin\/claude \(EACCES\)/.test(locked.note),
  JSON.stringify(locked));
bindHarnessBins(null);
