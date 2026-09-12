// Codex driver — the third production bus driver. Run: npm test
//
// Subject — what Codex does differently from Claude Code and Cursor: an app-server
// process per participant, a rollout appears at turn/started, turn/start queues behind
// a turn in progress, the limit gate, denyTools as the sandbox, an empty
// LaunchPlan.files. The loop runs on the real mechanism. Only the `codex` binary is
// substituted ([harness-codex.mjs](harness-codex.mjs)).
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import Ajv from 'ajv';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { buildWorkspace, cli, store } from './scenario.mjs';
import {
  APPROVAL_VAR, CODEX_HOME_VAR, CURRENT_TIME_VAR, ELICIT_HANG_VAR, ELICIT_OVERLAP_VAR, ELICIT_VAR, FAIL_TURN_VAR, FIRST_DELAY_VAR,
  HANG_AFTER_START_VAR, HANG_FIRST_VAR, LIMIT_VAR, ORPHAN_VAR, PROBE_VAR,
  diagnoseTrace, installHarness, parseHomeToml, pidAlive, planParticipant, readTrace, traceFile,
} from './harness-codex.mjs';
import { waitFor } from './harness.mjs';
import { capture } from './console.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_PATH = path.join(here, '..', 'package.json');
const PACKAGE_VERSION = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')).version;
const SB = makeSandbox('promptobus-codex-');
const { home: HARNESS, stateHome, restore } = await installHarness({ binDir: path.join(SB, 'bin') });

const DIAGNOSE_ADDRESS = 'worker:diagnose';
const diagnosisTrace = [
  { kind: 'up' },
  { kind: 'action-failed', action: { tool: 'legacy_send' }, error: 'not supported' },
  { kind: 'turn', no: 1 },
  { kind: 'later-red-verdict' },
];
writeFileSync(traceFile(HARNESS, DIAGNOSE_ADDRESS), diagnosisTrace.map((e) => JSON.stringify(e)).join('\n') + '\n');
const diagnosis = diagnoseTrace(HARNESS, DIAGNOSE_ADDRESS);

// A thread file is written by the stand's holder, a separate process, so reading it once races
// the writer: under load the reader wins and the check reports the product wrong (PB-184).
// Nine reads: 135 s if every one expires, under the 240 s watchdog and the 300 s runner
// deadline. Arithmetic, not a measurement — a slower stand needs the budget re-checked.
const THREAD_WAIT_MS = 15000;
async function awaitThread(id, { timeoutMs = THREAD_WAIT_MS } = {}) {
  const file = path.join(HARNESS, 'threads', `${id ?? ''}.json`);
  const got = await waitFor(() => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }, { timeoutMs });
  return got ?? { __timedOut: `TIMEOUT after ${timeoutMs} ms waiting for ${file} — the stand had not written the thread; this says nothing about the product` };
}

check(': Codex diagnosis surfaces scenario errors before the later red verdict',
  diagnosis.startsWith(`scenario errors for ${DIAGNOSE_ADDRESS} (the cause is usually here):`)
    && diagnosis.includes('action-failed') && diagnosis.includes('later-red-verdict'),
  diagnosis);

const {
  codexDriver, PHRASES, PROVEN_CODEX_VERSION, DEFAULT_MODEL, REVIEWER_DENY, codexToolSegment,
  codexHomeConfig, makeParticipantHome, participantHomesRoot, removeParticipantHome, reviewSandbox,
  skillsNoteOf, sweepParticipantHomes, trustPath, workspaceSkillsDir,
} = await import(path.join(here, '..', 'lib', 'driver-codex.js'));
const {
  readSession, writeSession, dropSession, approvalReply, decideApproval, readyMs, preambleMs,
  TURN_STARTED_TIMEOUT_MS, holderLogFile, socketPath, startHolder, waitReady, reapHolder,
  codexMcpServers, codexMcpName, codexMcpPrefix, sessionsDir, SESSION_ENV_VAR, PARTICIPANT_ARGV,
} = await import(path.join(here, '..', 'lib', 'codex-session.js'));
const { bindHarnessHomes } = await import(path.join(here, '..', 'lib', 'harness-home.js'));
const { status: printStatus, stallStands } = await import(path.join(here, '..', 'lib', 'status.js'));
const { liftDriver, REGISTRY } = await import(path.join(here, '..', 'lib', 'drivers.js'));
const { liftHarness, skillsNote, toolName, writeLaunchFiles } = await import(path.join(here, '..', 'lib', 'spawn.js'));
const { createStandaloneHost } = await import(path.join(here, '..', 'dist', 'host-index.js'));

// The override key prefix is the CONSUMER's name, so it comes from a host and not from
// a constant. `HOST` stands in for the workspace everywhere below; `OTHER` is a second
// consumer in the same process, which is what the prefix has to keep separate.
const HOST = createStandaloneHost({ cwd: SB, commandName: 'promptobus' });
const OTHER = createStandaloneHost({ cwd: SB, commandName: 'otherbus' });
const PREFIX = codexMcpPrefix(HOST);

const TASK = 'codexbus-t20260903-000000';
const WORKER = 'worker:cdx';
const SECOND_WORKER = 'worker:cdx-second';
const REVIEWER = 'reviewer:cdx';
const ORCH_SESSION = `orch-codex-${process.pid}`;

// The owner's Codex home: read-only to the mechanism, and the only place `auth.json`
// is copied from. The content is a stand-in — nothing reads it, the MODE is what a
// check asks about. The config gets one personal server, so a check can say the
// participant did not get it.
const callerCodexHome = path.join(SB, 'caller-codex-home');
mkdirSync(callerCodexHome, { recursive: true });
writeFileSync(path.join(callerCodexHome, 'auth.json'), '{"stub":"credentials"}\n', { mode: 0o600 });
writeFileSync(path.join(callerCodexHome, 'config.toml'), '[mcp_servers.owner_personal]\nurl = "http://owner.invalid/mcp"\n');
const ownerConfigBefore = readFileSync(path.join(callerCodexHome, 'config.toml'), 'utf8');
const participantHome = codexDriver.participantCodexHome({ task: TASK, address: WORKER });
// Participant homes live in `$TMPDIR` and go away with their session — `stop` removes
// them. A participant this file lifts and never stops, or one whose lift was refused
// on purpose, would leave its home behind; the sweep is by this task's own name prefix,
// which every home of this file carries and no neighbour's does.
const homePrefix = `${TASK.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-`;
process.on('exit', () => {
  let names = [];
  try {
    names = readdirSync(participantHomesRoot());
  } catch {
    names = [];
  }
  for (const name of names.filter((n) => n.startsWith(homePrefix))) {
    rmSync(path.join(participantHomesRoot(), name), { recursive: true, force: true });
  }
});

const collisionRef = 'same-ref-in-two-registries';
const collisionEnvA = {
  PROMPTOBUS_CODEX_HOME: path.join(SB, `state-${'a'.repeat(120)}`),
};
const collisionEnvB = {
  PROMPTOBUS_CODEX_HOME: path.join(SB, `state-${'b'.repeat(120)}`),
};
const collisionSocketA = socketPath(collisionRef, collisionEnvA);
const collisionSocketB = socketPath(collisionRef, collisionEnvB);
check(': long registry homes scope fallback socket paths by registry home',
  collisionSocketA !== collisionSocketB
    && collisionSocketA.startsWith(path.join(tmpdir(), 'pb-cdx-'))
    && collisionSocketB.startsWith(path.join(tmpdir(), 'pb-cdx-')),
  JSON.stringify({ collisionSocketA, collisionSocketB }));

function thrown(fn) {
  try {
    fn();
    return { threw: false, msg: '' };
  } catch (e) {
    return { threw: true, msg: e.message };
  }
}

check(': the Codex driver sits in the registry map and is taken by name',
  liftDriver('codex').id === 'codex' && Object.keys(REGISTRY.drivers).sort().join(',') === 'claude,codex,cursor',
  Object.keys(REGISTRY.drivers).join(','));

check(': without a name the previous driver is taken — Claude Code argv does not move',
  liftDriver().id === 'claude');

check(': Codex capabilities are declared, all ten',
  ['spawn', 'attach', 'activation', 'inspect', 'stop', 'denyTools', 'mcpDenyTools', 'systemPrompt', 'sessionList', 'enter']
    .every((k) => codexDriver.capabilities[k] !== undefined)
  && codexDriver.capabilities.attach === false && codexDriver.capabilities.activation === 'push',
  JSON.stringify(codexDriver.capabilities));

check(': default readyMs = preamble + turn/started, independent of the full-turn override',
  readyMs({ PROMPTOBUS_CODEX_TURN_MS: '999999' })
    === preambleMs({ PROMPTOBUS_CODEX_TURN_MS: '999999' }) + TURN_STARTED_TIMEOUT_MS,
  String(readyMs({})));

const patchRec = { cwd: '/tmp/wt', addDirs: [], role: 'worker' };
const policyRec = { ...patchRec, sandbox: 'workspace-write', approvalPolicy: 'on-failure' };
const codexFixtureDir = path.join(here, 'fixtures', 'codex-app-server', '0.146.0');
const codexFixtureAjv = new Ajv({
  strict: false,
  allErrors: true,
  formats: { int64: true, uint64: true, uint32: true, uint: true, double: true },
});
const codexServerRequest = codexFixtureAjv.compile(
  JSON.parse(readFileSync(path.join(codexFixtureDir, 'ServerRequest.json'), 'utf8')),
);
const mcpDenyCapture = JSON.parse(readFileSync(
  path.join(codexFixtureDir, 'McpServerStatusList-0.146.0-2026-09-10.json'), 'utf8',
));
const mcpCaptureMessages = mcpDenyCapture.exchange.map(({ message }) => message);
const mcpThreadStart = mcpCaptureMessages.find((message) => message.method === 'thread/start');
const mcpStatusRequest = mcpCaptureMessages.find((message) => message.method === 'mcpServerStatus/list');
check('PB-87.1: the Codex MCP capture accepts disabled_tools without a model turn',
  mcpDenyCapture.turnStarted === false
  && mcpThreadStart?.params?.config?.mcp_servers?.['promptobus-probe']?.disabled_tools?.join(',') === 'write_tool'
  && mcpDenyCapture.observed?.threadStartAccepted === true
  && mcpDenyCapture.observed?.serverStartupStatus === 'ready'
  && mcpStatusRequest?.id === 3
  && !mcpCaptureMessages.some((message) => message.method === 'turn/start')
  && !mcpDenyCapture.exchange.some(({ direction, message }) => direction === 'reply' && message.id === mcpStatusRequest?.id),
  JSON.stringify(mcpDenyCapture.observed));
// PB-87.3: the enforcement capture. The two branches differ only in `disabled_tools`,
// so the check is that they differ in exactly one tool and in the right direction —
// and that the MCP server itself was told to hand over both, which is what makes the
// filtering app-server's rather than the server's.
const enforcement = JSON.parse(readFileSync(
  path.join(codexFixtureDir, 'DisabledToolsEnforcement-0.146.0-2026-09-11.json'), 'utf8',
));
check('PB-87.3: a disabled tool is absent from the thread inventory and present without the key',
  enforcement.decisive.turnStarted === false
  && enforcement.decisive.withDisabledTools.threadInventory.join(',') === 'read_tool'
  && enforcement.decisive.withoutDisabledTools.threadInventory.join(',') === 'read_tool,write_tool'
  && enforcement.decisive.withDisabledTools.serverAnsweredWith.join(',') === 'read_tool,write_tool'
  && enforcement.decisive.withDisabledTools.serverAskedForItsTools === true
  && enforcement.observed.enforcementObserved === true,
  JSON.stringify(enforcement.decisive));

check('PB-87.3: the capture names its ceiling and does not lean on the turns that answered nothing',
  enforcement.observed.modelRequestPayloadObserved === false
  && enforcement.observed.turnAnswerUsable === false
  && enforcement.paidTurns.length === 2
  && enforcement.paidTurns.every((t) => t.turnStatus === 'completed')
  && enforcement.paidTurns[1].captured === true
  && enforcement.paidTurns[1].rolloutAssistantMessage === ''
  && enforcement.form.threadStartCarriedMcpServers === false
  && enforcement.form.mcpEntriesFrom === 'CODEX_HOME/config.toml',
  JSON.stringify({ observed: enforcement.observed, turns: enforcement.paidTurns.map((t) => t.captured) }));

check('PB-87.3: the reviewer prompt phrase says the measured thing and no more',
  /absent from the thread's tool inventory, measured/.test(PHRASES.mcpBoundary)
  && /isolated Codex home/.test(PHRASES.mcpBoundary)
  && !/personal MCP set/.test(PHRASES.mcpBoundary)
  && !/was not observed/.test(PHRASES.mcpBoundary)
  && /forbidden by this prompt as well/.test(PHRASES.mcpBoundary),
  PHRASES.mcpBoundary);

const approvalResponseNames = new Map([
  ['applyPatchApproval', 'ApplyPatchApproval'],
  ['item/commandExecution/requestApproval', 'CommandExecutionRequestApproval'],
  ['execCommandApproval', 'ExecCommandApproval'],
  ['item/fileChange/requestApproval', 'FileChangeRequestApproval'],
  ['item/permissions/requestApproval', 'PermissionsRequestApproval'],
]);
const codexApprovalResponses = new Map(
  [...approvalResponseNames].map(([method, name]) => [
    method,
    codexFixtureAjv.compile(JSON.parse(readFileSync(path.join(codexFixtureDir, `${name}Response.json`), 'utf8'))),
  ]),
);

const approvalReplyChecks = [...approvalResponseNames].map(([method]) => {
  const validate = codexApprovalResponses.get(method);
  const checkReply = (allow) => {
    const reply = approvalReply(method, allow);
    const valid = validate(reply);
    return { valid, ...(valid ? {} : { errors: validate.errors }), reply };
  };
  return { method, ok: checkReply(true), no: checkReply(false) };
});
check(': every measured approval reply row validates against its response schema',
  approvalReplyChecks.every(({ ok, no }) => ok.valid && no.valid),
  JSON.stringify(approvalReplyChecks));

// PB-88.4: the list is READ from the measured `ServerRequest`, not retyped. The three
// requests that have no approval row are a property of the protocol, and a re-capture
// that adds a fourth must fail here rather than have it answered by a fallback nobody
// decided on.
const serverRequestMethods = JSON.parse(readFileSync(path.join(codexFixtureDir, 'ServerRequest.json'), 'utf8'))
  .oneOf.flatMap((arm) => arm.properties?.method?.enum ?? []);
const unhandledApprovalMethods = serverRequestMethods
  .filter((method) => approvalReply(method, false).__error)
  .sort();
const unhandledApprovalReplies = unhandledApprovalMethods.map((method) => ({
  method,
  reply: approvalReply(method, false),
  decision: decideApproval(method, {}, patchRec),
}));
check('PB-88.4: exactly three measured server requests have no approval row, and each is answered -32601',
  unhandledApprovalMethods.join(',') === 'account/chatgptAuthTokens/refresh,attestation/generate,item/tool/call'
  && unhandledApprovalReplies.every(({ method, reply, decision }) => reply.__error?.code === -32601
    && reply.__error.message === `no handler for server request ${method}`
    && decision.allow === false && decision.unknown === true),
  JSON.stringify(unhandledApprovalReplies));

const measuredPatchRequest = {
  jsonrpc: '2.0',
  id: 'server-1',
  method: 'applyPatchApproval',
  params: {
    callId: 'call-1',
    conversationId: 'thread-1',
    fileChanges: { '/tmp/wt/note.md': { type: 'add', content: '' } },
    grantRoot: null,
    reason: null,
  },
};
check(': measured applyPatchApproval request and reply validate against the fixture',
  codexServerRequest(measuredPatchRequest)
    && codexApprovalResponses.get('applyPatchApproval')(approvalReply('applyPatchApproval', true)),
  `${JSON.stringify(codexServerRequest.errors)} · ${JSON.stringify(codexApprovalResponses.get('applyPatchApproval').errors)}`);

const grantRootApproval = decideApproval('applyPatchApproval', {
  ...measuredPatchRequest.params,
  grantRoot: '/tmp/outside',
}, patchRec);
const reviewerGrantRootApproval = decideApproval('applyPatchApproval', {
  ...measuredPatchRequest.params,
  grantRoot: '/tmp/outside',
}, { ...patchRec, role: 'reviewer' });

const measuredFileChangeRequest = {
  jsonrpc: '2.0',
  id: 'server-2',
  method: 'item/fileChange/requestApproval',
  params: {
    itemId: 'item-1',
    startedAtMs: 1,
    threadId: 'thread-1',
    turnId: 'turn-1',
    grantRoot: null,
    reason: null,
  },
};
const fileChangeApproval = decideApproval(measuredFileChangeRequest.method, measuredFileChangeRequest.params, patchRec);
const fileChangeGrantRootApproval = decideApproval(measuredFileChangeRequest.method, {
  ...measuredFileChangeRequest.params,
  grantRoot: '/tmp/outside',
}, patchRec);
const reviewerFileChangeGrantRootApproval = decideApproval(measuredFileChangeRequest.method, {
  ...measuredFileChangeRequest.params,
  grantRoot: '/tmp/outside',
}, { ...patchRec, role: 'reviewer' });
check(': grantRoot escalation is denied for workers and reviewers',
  [grantRootApproval, reviewerGrantRootApproval, fileChangeGrantRootApproval, reviewerFileChangeGrantRootApproval]
    .every((approval) => approval.allow === false && /grantRoot/.test(approval.why)),
  JSON.stringify({ grantRootApproval, reviewerGrantRootApproval, fileChangeGrantRootApproval, reviewerFileChangeGrantRootApproval }));
check(': measured fileChange approval without paths is denied because the request has no path',
  codexServerRequest(measuredFileChangeRequest)
    && fileChangeApproval.allow === false
    && /no path/i.test(fileChangeApproval.why)
    && codexApprovalResponses.get('item/fileChange/requestApproval')(approvalReply(
      'item/fileChange/requestApproval', fileChangeApproval.allow,
    )),
  `${JSON.stringify(fileChangeApproval)} · ${JSON.stringify(codexServerRequest.errors)}`);

const permissionsResponse = codexApprovalResponses.get('item/permissions/requestApproval');
const permissionCases = [
  {
    name: 'outside cwd',
    permissions: {
      fileSystem: {
        entries: [{ access: 'write', path: { type: 'path', path: '/tmp/outside' } }],
        read: [],
        write: [],
      },
      network: { enabled: false },
    },
    names: ['/tmp/outside', 'network.enabled=false'],
  },
  {
    name: 'inside cwd',
    permissions: {
      fileSystem: {
        entries: [{ access: 'write', path: { type: 'path', path: '/tmp/wt/inside' } }],
        read: [],
        write: [],
      },
      network: { enabled: false },
    },
    names: ['/tmp/wt/inside', 'network.enabled=false'],
  },
  {
    name: 'network',
    permissions: {
      fileSystem: {
        entries: [{ access: 'write', path: { type: 'path', path: '/tmp/wt/network-request.md' } }],
        read: [],
        write: [],
      },
      network: { enabled: true },
    },
    names: ['/tmp/wt/network-request.md', 'network.enabled=true'],
  },
  {
    name: 'named danger value',
    record: { ...patchRec, role: 'reviewer' },
    permissions: 'danger-full-access',
    names: ['danger-full-access'],
    measured: false,
  },
];
for (const { name, record = patchRec, permissions, names, measured = true } of permissionCases) {
  const request = {
    jsonrpc: '2.0',
    id: `permissions-${name}`,
    method: 'item/permissions/requestApproval',
    params: {
      cwd: '/tmp/wt',
      itemId: `item-${name}`,
      permissions,
      reason: null,
      startedAtMs: 1,
      threadId: 'thread-1',
      turnId: 'turn-1',
    },
  };
  const decision = decideApproval(request.method, request.params, record);
  const reply = approvalReply(request.method, decision.allow);
  check(`: ${record.role} permissions request ${name} — deny`,
    (measured ? codexServerRequest(request) : true)
      && decision.allow === false
      && names.every((value) => decision.why.includes(value))
      && permissionsResponse(reply),
    `${JSON.stringify({ decision, reply })} · ${JSON.stringify(codexServerRequest.errors)} · ${JSON.stringify(permissionsResponse.errors)}`);
}
check(': permissions approvals have no granting reply',
  JSON.stringify(approvalReply('item/permissions/requestApproval', true))
    === JSON.stringify(approvalReply('item/permissions/requestApproval', false))
    && permissionsResponse(approvalReply('item/permissions/requestApproval', false)),
  JSON.stringify({
    ok: approvalReply('item/permissions/requestApproval', true),
    no: approvalReply('item/permissions/requestApproval', false),
  }));

check(': a patch outside cwd — deny',
  (() => {
    const d = decideApproval('applyPatchApproval', { fileChanges: { '/etc/passwd': { type: 'add' } } }, patchRec);
    return d.allow === false && /outside cwd/.test(d.why);
  })());
check(': a patch with an unreadable target — deny',
  (() => {
    const d = decideApproval('applyPatchApproval', {}, patchRec);
    return d.allow === false && /unreadable/.test(d.why);
  })());
check(': a relative patch inside cwd — allow',
  decideApproval('applyPatchApproval', { fileChanges: { 'note.md': { type: 'add' } } }, patchRec).allow === true);
function skipApprovalSymlinkCheck(name, reason) {
  process.stdout.write(`↷ ${name} — skipped: ${reason}\n`);
}

const approvalSymlinkCheckNames = [
  ': a target in the resolved spelling of a symlinked cwd — allow',
  ': a target through the symlinked cwd — allow',
  ': a parent traversal that remains inside — allow',
  ': a plain parent traversal outside the root — deny',
  ': a missing target through an escaping symlink — deny',
  ': a missing segment cannot hide a later symlink escape — deny',
  ': a symlink content with parent traversal — deny',
  ': a relative symlink to the parent — deny',
  ': a symlink chain escaping the root — deny',
  ': a target with parent traversal — deny',
  ': a dangling symlink target outside cwd — deny',
  ': a symlink loop target is unreadable — deny',
  ': a partly unresolved root is named on outside denial — deny',
  ': a mixed-case spelling of an existing root — allow',
  ': a differently-cased target under a case-insensitive root — deny',
];
const approvalSymlinkBase = path.join(SB, 'approval-symlinks');
const approvalAllowed = path.join(approvalSymlinkBase, 'allowed');
const approvalOutside = path.join(approvalSymlinkBase, 'outside');
const approvalRootLink = path.join(approvalSymlinkBase, 'root-link');
const approvalEscapeLink = path.join(approvalAllowed, 'escape');
const approvalChainA = path.join(approvalAllowed, 'chain-a');
const approvalChainB = path.join(approvalAllowed, 'chain-b');
const approvalLinkWithParent = path.join(approvalAllowed, 'link-with-parent');
const approvalUpLink = path.join(approvalAllowed, 'up');
const approvalDanglingLink = path.join(approvalAllowed, 'dangling.md');
const approvalDanglingTarget = path.join(approvalOutside, 'dangling.md');
const approvalLoopA = path.join(approvalAllowed, 'loop-a');
const approvalLoopB = path.join(approvalAllowed, 'loop-b');
const approvalLinkType = process.platform === 'win32' ? 'junction' : 'dir';
let approvalSymlinkReason = '';
let approvalResolvedRoot = null;
try {
  mkdirSync(approvalAllowed, { recursive: true });
  mkdirSync(approvalOutside, { recursive: true });
  mkdirSync(path.join(approvalAllowed, 'subdir'));
  symlinkSync(approvalAllowed, approvalRootLink, approvalLinkType);
  symlinkSync(approvalOutside, approvalEscapeLink, approvalLinkType);
  symlinkSync(approvalOutside, approvalChainB, approvalLinkType);
  symlinkSync('chain-b', approvalChainA, approvalLinkType);
  symlinkSync('escape/..', approvalLinkWithParent, approvalLinkType);
  symlinkSync('..', approvalUpLink, approvalLinkType);
  symlinkSync(approvalDanglingTarget, approvalDanglingLink, 'file');
  symlinkSync(approvalLoopB, approvalLoopA, 'file');
  symlinkSync(approvalLoopA, approvalLoopB, 'file');
  approvalResolvedRoot = realpathSync(approvalRootLink);
} catch (error) {
  approvalSymlinkReason = `symlink fixture unavailable (${error.code ?? error.message})`;
}
if (approvalSymlinkReason) {
  for (const name of approvalSymlinkCheckNames) skipApprovalSymlinkCheck(name, approvalSymlinkReason);
} else {
  const symlinkApprovalRec = { cwd: approvalRootLink, addDirs: [], role: 'worker' };
  const resolvedRootTarget = path.join(approvalResolvedRoot, 'not-yet-created.md');
  const resolvedRootApproval = decideApproval(
    'applyPatchApproval', { fileChanges: { [resolvedRootTarget]: { type: 'add' } } }, symlinkApprovalRec,
  );
  check(': a target in the resolved spelling of a symlinked cwd — allow',
    resolvedRootApproval.allow === true, JSON.stringify(resolvedRootApproval));

  const linkedRootTarget = path.join(approvalRootLink, 'through-link.md');
  const linkedRootApproval = decideApproval(
    'applyPatchApproval', { fileChanges: { [linkedRootTarget]: { type: 'add' } } }, symlinkApprovalRec,
  );
  check(': a target through the symlinked cwd — allow',
    linkedRootApproval.allow === true, JSON.stringify(linkedRootApproval));

  const safeParentTraversalTarget = `${approvalRootLink}${path.sep}subdir${path.sep}..${path.sep}safe.md`;
  const safeParentTraversalApproval = decideApproval(
    'applyPatchApproval', { fileChanges: { [safeParentTraversalTarget]: { type: 'add' } } }, symlinkApprovalRec,
  );
  check(': a parent traversal that remains inside — allow',
    safeParentTraversalApproval.allow === true, JSON.stringify(safeParentTraversalApproval));

  const approvalOutsideCanonical = realpathSync(approvalOutside);
  const plainParentTraversalTarget = `${approvalRootLink}${path.sep}..${path.sep}plain-evil.md`;
  const plainParentTraversalCanonicalTarget = path.join(path.dirname(approvalOutsideCanonical), 'plain-evil.md');
  const plainParentTraversalApproval = decideApproval(
    'applyPatchApproval', { fileChanges: { [plainParentTraversalTarget]: { type: 'add' } } }, symlinkApprovalRec,
  );
  check(': a plain parent traversal outside the root — deny',
    plainParentTraversalApproval.allow === false
    && plainParentTraversalApproval.why
      === `action outside cwd/addDirs: ${plainParentTraversalTarget} → ${plainParentTraversalCanonicalTarget}`,
    JSON.stringify(plainParentTraversalApproval));

  const escapedTarget = path.join(approvalRootLink, 'escape', 'not-yet-created.md');
  const escapedCanonicalTarget = path.join(approvalOutsideCanonical, 'not-yet-created.md');
  const escapedApproval = decideApproval(
    'applyPatchApproval', { fileChanges: { [escapedTarget]: { type: 'add' } } }, symlinkApprovalRec,
  );
  check(': a missing target through an escaping symlink — deny',
    escapedApproval.allow === false
    && escapedApproval.why === `action outside cwd/addDirs: ${escapedTarget} → ${escapedCanonicalTarget}`,
    JSON.stringify(escapedApproval));

  const missingTailTarget = `${approvalRootLink}${path.sep}nope${path.sep}..${path.sep}escape${path.sep}evil.md`;
  const missingTailCanonicalTarget = path.join(approvalOutsideCanonical, 'evil.md');
  const missingTailApproval = decideApproval(
    'applyPatchApproval', { fileChanges: { [missingTailTarget]: { type: 'add' } } }, symlinkApprovalRec,
  );
  check(': a missing segment cannot hide a later symlink escape — deny',
    missingTailApproval.allow === false
    && missingTailApproval.why
      === `action outside cwd/addDirs: ${missingTailTarget} → ${missingTailCanonicalTarget}`,
    JSON.stringify(missingTailApproval));

  const linkContentParentTarget = path.join(approvalLinkWithParent, 'evil.md');
  const linkContentParentCanonicalTarget = path.join(path.dirname(approvalOutsideCanonical), 'evil.md');
  const linkContentParentApproval = decideApproval(
    'applyPatchApproval', { fileChanges: { [linkContentParentTarget]: { type: 'add' } } }, symlinkApprovalRec,
  );
  check(': a symlink content with parent traversal — deny',
    linkContentParentApproval.allow === false
    && linkContentParentApproval.why
      === `action outside cwd/addDirs: ${linkContentParentTarget} → ${linkContentParentCanonicalTarget}`,
    JSON.stringify(linkContentParentApproval));

  const relativeLinkTarget = path.join(approvalUpLink, 'relative-link.md');
  const relativeLinkCanonicalTarget = path.join(path.dirname(approvalOutsideCanonical), 'relative-link.md');
  const relativeLinkApproval = decideApproval(
    'applyPatchApproval', { fileChanges: { [relativeLinkTarget]: { type: 'add' } } }, symlinkApprovalRec,
  );
  check(': a relative symlink to the parent — deny',
    relativeLinkApproval.allow === false
    && relativeLinkApproval.why
      === `action outside cwd/addDirs: ${relativeLinkTarget} → ${relativeLinkCanonicalTarget}`,
    JSON.stringify(relativeLinkApproval));

  const chainTarget = path.join(approvalChainA, 'chain-evil.md');
  const chainCanonicalTarget = path.join(approvalOutsideCanonical, 'chain-evil.md');
  const chainApproval = decideApproval(
    'applyPatchApproval', { fileChanges: { [chainTarget]: { type: 'add' } } }, symlinkApprovalRec,
  );
  check(': a symlink chain escaping the root — deny',
    chainApproval.allow === false
    && chainApproval.why === `action outside cwd/addDirs: ${chainTarget} → ${chainCanonicalTarget}`,
    JSON.stringify(chainApproval));

  const parentTraversalTarget = `${approvalRootLink}${path.sep}escape${path.sep}..${path.sep}evil.md`;
  const parentTraversalApproval = decideApproval(
    'applyPatchApproval', { fileChanges: { [parentTraversalTarget]: { type: 'add' } } }, symlinkApprovalRec,
  );
  check(': a target with parent traversal — deny',
    parentTraversalApproval.allow === false
    && parentTraversalApproval.why
      === `action outside cwd/addDirs: ${parentTraversalTarget} → ${path.join(path.dirname(approvalOutsideCanonical), 'evil.md')}`,
    JSON.stringify(parentTraversalApproval));

  const danglingCanonicalTarget = path.join(approvalOutsideCanonical, 'dangling.md');
  const danglingApproval = decideApproval(
    'applyPatchApproval', { fileChanges: { [approvalDanglingLink]: { type: 'add' } } }, symlinkApprovalRec,
  );
  check(': a dangling symlink target outside cwd — deny',
    danglingApproval.allow === false
    && danglingApproval.why === `action outside cwd/addDirs: ${approvalDanglingLink} → ${danglingCanonicalTarget}`,
    JSON.stringify(danglingApproval));

  const loopApproval = decideApproval(
    'applyPatchApproval', { fileChanges: { [approvalLoopA]: { type: 'add' } } }, symlinkApprovalRec,
  );
  check(': a symlink loop target is unreadable — deny',
    loopApproval.allow === false
    && loopApproval.why === `action target could not be resolved: ${approvalLoopA}`,
    JSON.stringify(loopApproval));

  const unresolvedRootsApproval = decideApproval(
    'applyPatchApproval',
    { fileChanges: { [path.join(approvalAllowed, 'unresolved-roots.md')]: { type: 'add' } } },
    { cwd: approvalLoopA, addDirs: [approvalLoopB], role: 'worker' },
  );
  check(': unresolved approval roots name the recorded cwd — deny',
    unresolvedRootsApproval.allow === false
    && unresolvedRootsApproval.why === 'the recorded cwd could not be resolved',
    JSON.stringify(unresolvedRootsApproval));

  const partlyUnresolvedTarget = path.join(approvalOutside, 'partly-unresolved.md');
  const partlyUnresolvedCanonicalTarget = path.join(approvalOutsideCanonical, 'partly-unresolved.md');
  const partlyUnresolvedRootApproval = decideApproval(
    'applyPatchApproval', { fileChanges: { [partlyUnresolvedTarget]: { type: 'add' } } },
    { cwd: approvalRootLink, addDirs: [approvalLoopA], role: 'worker' },
  );
  check(': a partly unresolved root is named on outside denial — deny',
    partlyUnresolvedRootApproval.allow === false
    && partlyUnresolvedRootApproval.why
      === `action outside cwd/addDirs: ${partlyUnresolvedTarget} → ${partlyUnresolvedCanonicalTarget}`
        + ` (unresolved roots: ${approvalLoopA})`,
    JSON.stringify(partlyUnresolvedRootApproval));

  const approvalAllowedCanonical = realpathSync(approvalAllowed);
  const mixedCaseAllowedSpelling = path.join(approvalSymlinkBase, 'ALLOWED');
  let mixedCaseAllowedCanonical = null;
  try {
    mixedCaseAllowedCanonical = realpathSync(mixedCaseAllowedSpelling);
  } catch {
    // A case-sensitive volume has no mixed-case spelling to compare.
  }
  if (mixedCaseAllowedCanonical && mixedCaseAllowedCanonical !== approvalAllowedCanonical) {
    const mixedCaseRec = { cwd: mixedCaseAllowedSpelling, addDirs: [], role: 'worker' };
    const mixedCaseTarget = path.join(mixedCaseAllowedSpelling, 'mixed-case.md');
    const mixedCaseApproval = decideApproval(
      'applyPatchApproval', { fileChanges: { [mixedCaseTarget]: { type: 'add' } } }, mixedCaseRec,
    );
    check(': a mixed-case spelling of an existing root — allow',
      mixedCaseAllowedCanonical !== approvalAllowedCanonical && mixedCaseApproval.allow === true,
      JSON.stringify({ approvalAllowedCanonical, mixedCaseAllowedCanonical, mixedCaseApproval }));

    const differentlyCasedTarget = path.join(approvalAllowedCanonical, 'different-case.md');
    const differentlyCasedApproval = decideApproval(
      'applyPatchApproval', { fileChanges: { [differentlyCasedTarget]: { type: 'add' } } }, mixedCaseRec,
    );
    process.stdout.write(`ℹ mixed-case fail-closed reason: ${differentlyCasedApproval.why}\n`);
    check(': a differently-cased target under a case-insensitive root — deny',
      differentlyCasedApproval.allow === false
      && differentlyCasedApproval.why
        === `action outside cwd/addDirs: ${differentlyCasedTarget} → ${differentlyCasedTarget}`,
      JSON.stringify({ approvalAllowedCanonical, mixedCaseAllowedCanonical, differentlyCasedApproval }));
  } else if (!mixedCaseAllowedCanonical) {
    skipApprovalSymlinkCheck(
      ': a mixed-case spelling of an existing root — allow',
      'filesystem is case-sensitive; no alternate spelling resolves to the existing root',
    );
    skipApprovalSymlinkCheck(
      ': a differently-cased target under a case-insensitive root — deny',
      'filesystem is case-sensitive; no alternate spelling resolves to the existing root',
    );
  } else {
    const reason = 'filesystem canonical spellings coincide; alternate case behavior is not observable';
    skipApprovalSymlinkCheck(': a mixed-case spelling of an existing root — allow', reason);
    skipApprovalSymlinkCheck(': a differently-cased target under a case-insensitive root — deny', reason);
  }
}
check(': an escalation flag in an in-cwd patch diff is not an escalation request',
  decideApproval('applyPatchApproval', {
    fileChanges: { 'note.md': { type: 'edit', diff: 'do not use --dangerously-bypass-approvals' } },
  }, patchRec).allow === true);
check(': config/read in an in-cwd command is not a config/read request',
  decideApproval('execCommandApproval', {
    cwd: '/tmp/wt', command: 'grep -rn config/read lib/',
  }, patchRec).allow === true);
check(': workspace-write and outside in unrelated fields are not an escalation request',
  decideApproval('execCommandApproval', {
    cwd: '/tmp/wt', command: 'echo workspace-write', note: 'outside',
  }, patchRec).allow === true);
check(': danger-full-access in the named permissions field is still denied',
  (() => {
    const d = decideApproval('item/permissions/requestApproval', { permissions: 'danger-full-access' }, patchRec);
    return d.allow === false && /privilege escalation denied/.test(d.why);
  })());
check(': a named sandbox mode is denied after containment passes',
  (() => {
    const d = decideApproval('execCommandApproval', {
      cwd: '/tmp/wt', command: 'echo hi', sandbox: 'danger-full-access',
    }, patchRec);
    return d.allow === false && /privilege escalation denied/.test(d.why);
  })());
check(': a nested permissions value is denied',
  (() => {
    const d = decideApproval('item/permissions/requestApproval', {
      permissions: { mode: 'Danger-Full-Access' }, reason: 'ordinary text',
    }, patchRec);
    return d.allow === false && /privilege escalation denied/.test(d.why);
  })());
check(': an array permission value is denied',
  (() => {
    const d = decideApproval('item/permissions/requestApproval', {
      permissions: [{ mode: 'danger-full-access' }],
    }, patchRec);
    return d.allow === false && /privilege escalation denied/.test(d.why);
  })());
check(': an item wrapper is not an escalation field',
  decideApproval('execCommandApproval', {
    callId: 'call-1',
    command: ['true'],
    conversationId: 'thread-1',
    cwd: '/tmp/wt',
    parsedCmd: [{ cmd: 'true', type: 'unknown' }],
    item: { permissions: 'danger-full-access' },
    reason: null,
  }, patchRec).allow === true);
check(': a permission map key is treated as a named mode',
  (() => {
    const d = decideApproval('item/permissions/requestApproval', {
      permissions: { 'danger-full-access': true },
    }, patchRec);
    return d.allow === false && /privilege escalation denied/.test(d.why);
  })());
check(': approvalPolicy never is denied',
  (() => {
    const d = decideApproval('item/permissions/requestApproval', { approvalPolicy: 'never' }, patchRec);
    return d.allow === false && /privilege escalation denied/.test(d.why);
  })());
check(': approvalPolicy on-failure is denied',
  (() => {
    const d = decideApproval('item/permissions/requestApproval', { approvalPolicy: 'on-failure' }, patchRec);
    return d.allow === false && /privilege escalation denied/.test(d.why);
  })());
check(': an approval policy echo is allowed',
  decideApproval('execCommandApproval', {
    cwd: '/tmp/wt', command: 'echo hi', approvalPolicy: 'on-failure',
  }, policyRec).allow === true);
check(': an approval policy change is denied',
  (() => {
    const d = decideApproval('execCommandApproval', {
      cwd: '/tmp/wt', command: 'echo hi', approvalPolicy: 'never',
    }, policyRec);
    return d.allow === false && /privilege escalation denied/.test(d.why);
  })());
// --- PB-88.3: a command that asks to leave the network sandbox -----------------------
//
// The refusal is driven by the measured shape, so the shape is read from the fixture
// rather than retyped: a re-capture that drops either field turns the deny into dead
// code, and this is where that shows.
const commandApprovalParams = JSON.parse(readFileSync(
  path.join(codexFixtureDir, 'CommandExecutionRequestApprovalParams.json'), 'utf8',
));
const networkContextShape = commandApprovalParams.definitions?.NetworkApprovalContext?.required ?? [];
const networkAmendmentShape = commandApprovalParams.definitions?.NetworkPolicyAmendment?.required ?? [];
check('PB-88.3: the measured command approval still carries both network fields',
  'networkApprovalContext' in (commandApprovalParams.properties ?? {})
  && 'proposedNetworkPolicyAmendments' in (commandApprovalParams.properties ?? {})
  && networkContextShape.slice().sort().join(',') === 'host,protocol'
  && networkAmendmentShape.slice().sort().join(',') === 'action,host',
  JSON.stringify({ networkContextShape, networkAmendmentShape }));

const inRootNetwork = {
  cwd: '/tmp/wt',
  command: 'curl https://packages.invalid/x',
  networkApprovalContext: Object.fromEntries(networkContextShape.map((k) => [k, k === 'host' ? 'packages.invalid' : 'https'])),
};
check('PB-88.3: a worker command inside the roots is refused when it asks for network egress',
  (() => {
    const d = decideApproval('item/commandExecution/requestApproval', inRootNetwork, patchRec);
    const plain = decideApproval('item/commandExecution/requestApproval',
      { cwd: '/tmp/wt', command: 'curl https://packages.invalid/x' }, patchRec);
    return d.allow === false && /network egress denied: https to packages\.invalid/.test(d.why)
      && plain.allow === true;
  })(),
  JSON.stringify(decideApproval('item/commandExecution/requestApproval', inRootNetwork, patchRec)));

check('PB-88.3: a proposed network policy amendment alone is enough to refuse, for either role',
  (() => {
    const params = {
      cwd: '/tmp/wt',
      command: 'true',
      networkApprovalContext: null,
      proposedNetworkPolicyAmendments: [
        Object.fromEntries(networkAmendmentShape.map((k) => [k, k === 'host' ? 'packages.invalid' : 'allow'])),
      ],
    };
    const worker = decideApproval('item/commandExecution/requestApproval', params, patchRec);
    const legacy = decideApproval('execCommandApproval', params, patchRec);
    const reviewer = decideApproval('item/commandExecution/requestApproval', params,
      { ...patchRec, role: 'reviewer' });
    return worker.allow === false && /network policy amendment denied: packages\.invalid/.test(worker.why)
      && legacy.allow === false && /network policy amendment denied/.test(legacy.why)
      && reviewer.allow === false && /network policy amendment denied/.test(reviewer.why);
  })(),
  JSON.stringify(decideApproval('item/commandExecution/requestApproval', {
    cwd: '/tmp/wt', proposedNetworkPolicyAmendments: [{ action: 'allow', host: 'packages.invalid' }],
  }, patchRec)));

// The fields Codex sends as `null` and `[]` on every ordinary command are not an
// escalation, and the check is scoped to command approvals: a file change does not
// carry them in the measured shape, and reading them there would invent a refusal.
check('PB-88.3: a null context and an empty amendment list are not an escalation, and the check is command-scoped',
  decideApproval('item/commandExecution/requestApproval',
    { cwd: '/tmp/wt', networkApprovalContext: null, proposedNetworkPolicyAmendments: [] }, patchRec).allow === true
  && decideApproval('item/fileChange/requestApproval',
    { cwd: '/tmp/wt', networkApprovalContext: { host: 'x', protocol: 'https' }, fileChanges: { '/tmp/wt/a': {} } },
    patchRec).allow === true,
  JSON.stringify(decideApproval('item/fileChange/requestApproval',
    { cwd: '/tmp/wt', networkApprovalContext: { host: 'x', protocol: 'https' }, fileChanges: { '/tmp/wt/a': {} } },
    patchRec)));

check('PB-88.3: the refusal reply is the measured decline — no amendment arm is ever sent',
  JSON.stringify(approvalReply('item/commandExecution/requestApproval', false)) === '{"decision":"decline"}'
  && !JSON.stringify(approvalReply('item/commandExecution/requestApproval', false)).includes('NetworkPolicyAmendment'),
  JSON.stringify(approvalReply('item/commandExecution/requestApproval', false)));

check(': mixed-case dangerous sandbox mode is denied',
  (() => {
    const d = decideApproval('item/permissions/requestApproval', { sandbox: 'DANGER-FULL-ACCESS' }, patchRec);
    return d.allow === false && /privilege escalation denied/.test(d.why);
  })());

check(': the channel is declared rpc — knockRegistry does not substitute the messaging socket',
  codexDriver.options.knockChannel === 'rpc', codexDriver.options.knockChannel);

check(': the Codex vocabulary is its own — binary, model, reviewer sandbox',
  codexDriver.options.tool === 'codex' && codexDriver.options.defaultModel === DEFAULT_MODEL
  && JSON.stringify(codexDriver.options.denyTools) === JSON.stringify(REVIEWER_DENY)
  && codexDriver.options.skillsDir === false
  && JSON.stringify(codexDriver.options.permissionModes) === JSON.stringify(['read-only', 'workspace-write']),
  JSON.stringify(codexDriver.options));

// The told name is the key AS CODEX EXPOSES IT: sanitized, every character outside
// `[A-Za-z0-9_]` → `_` (PB-160, measured on codex-cli 0.146.0). The raw key is what
// the participant was told before, and every call by it died in 0 ms.
const codexSees = (key, tool) => `mcp__${key.replace(/[^A-Za-z0-9_]/g, '_')}__${tool}`;
check(': bus tool names are mcp__<override key as Codex exposes it>__name',
  PHRASES.tool('promptobus', 'promptobus_send', HOST) === codexSees(codexMcpName('promptobus', PREFIX), 'promptobus_send')
  && PHRASES.tool('promptobus', 'promptobus_send', HOST) !== 'mcp__promptobus__promptobus_send'
  && !PHRASES.tool('promptobus', 'promptobus_send', HOST).includes('-'),
  PHRASES.tool('promptobus', 'promptobus_send', HOST));
check(': a hyphenated consumer prefix is told as Codex lists it, not as the config key',
  (() => {
    const hyphenHost = { ...HOST, commandName: 'acme-tools' };
    const told = PHRASES.tool('promptobus', 'promptobus_send', hyphenHost);
    return codexMcpPrefix(hyphenHost) === 'acme-tools-'
      && told === 'mcp__acme_tools_promptobus__promptobus_send'
      && codexToolSegment('acme-tools-promptobus') === 'acme_tools_promptobus';
  })(),
  `${codexMcpPrefix({ ...HOST, commandName: 'acme-tools' })} → ${PHRASES.tool('promptobus', 'promptobus_send', { ...HOST, commandName: 'acme-tools' })}`);

check(': harness rules forbid questions and require the mailbox on every turn',
  /Do not ask questions/.test(PHRASES.promptRules) && /Fetch the mailbox at the start of every turn/.test(PHRASES.promptRules));
check(': Codex naming describes only the harness-owned thread id',
  PHRASES.naming === 'the thread id is chosen by app-server itself and printed on lift', PHRASES.naming);

const hostSessionsHome = path.join(SB, 'host-selected-codex-home');
const previousCodexHome = process.env.PROMPTOBUS_CODEX_HOME;
delete process.env.PROMPTOBUS_CODEX_HOME;
bindHarnessHomes({ harnessStateHome: (harness) => harness === 'codex' ? hostSessionsHome : null });
check(': Codex sessions phrase follows the host-selected registry home',
  PHRASES.sessions === `participant threads — ${path.join(hostSessionsHome, 'sessions')}`,
  PHRASES.sessions);
bindHarnessHomes(null);
check(': without a host home, Codex sessions phrase names its source',
  PHRASES.sessions === 'participant threads — the registry the host names for `codex` (`PROMPTOBUS_CODEX_HOME` overrides it)',
  PHRASES.sessions);
if (previousCodexHome === undefined) delete process.env.PROMPTOBUS_CODEX_HOME;
else process.env.PROMPTOBUS_CODEX_HOME = previousCodexHome;

check(': a binary older than the proven version — refuse before lift',
  /0\.140/.test(String(codexDriver.optionRefusal({}, { version: '0.140.0' })))
  && codexDriver.optionRefusal({}, { version: PROVEN_CODEX_VERSION }) === null
  && codexDriver.optionRefusal({}, { version: null }) === null,
  String(codexDriver.optionRefusal({}, { version: '0.140.0' })).slice(0, 90));

check(': shadowedUserServers is empty — the personal set is not isolated, config/read is forbidden',
  JSON.stringify(codexDriver.shadowedUserServers(['promptobus'])) === '[]');

// The `config.mcp_servers` override form is checked by field comparison, not by running
// the binary. The stand below does not parse the config, and a real `codex` refuses to
// load it WHOLE on an extra field and does not lift the participant at all; a live
// workspace has 13 of 14 url-servers. Hence two steps: here the translation fields are
// checked, and at `worker:mcp` — what actually went into `thread/start`.
const translated = codexMcpServers({
  'es-mcp-prod': { type: 'http', url: 'http://es.invalid/mcp' },
  'ati-kaiten-mcp': { type: 'http', url: 'http://kaiten.invalid/mcp', headers: { api_key: 'TOKEN' } },
  promptobus: { type: 'stdio', command: 'node', args: ['bin.js'], env: { PROMPTOBUS_ROLE: WORKER } },
  'sse-legacy': { type: 'sse', url: 'http://sse.invalid/mcp' },
  'bez-komandy': { type: 'stdio', args: [], env: {} },
}, PREFIX);
const fieldsOf = (name) => Object.keys(translated.servers[codexMcpName(name, PREFIX)] ?? {}).sort().join(',');

check(': a url-server goes out in url form — no args, no env, no command',
  fieldsOf('es-mcp-prod') === 'url'
  && fieldsOf('ati-kaiten-mcp') === 'http_headers,url'
  && translated.servers[codexMcpName('ati-kaiten-mcp', PREFIX)].http_headers.api_key === 'TOKEN',
  JSON.stringify(translated.servers));

check(': a stdio-server goes out in stdio form — no url is attached to it',
  fieldsOf('promptobus') === 'args,command,env'
  && translated.servers[codexMcpName('promptobus', PREFIX)].env.PROMPTOBUS_ROLE === WORKER,
  JSON.stringify(translated.servers[codexMcpName('promptobus', PREFIX)]));

check(': a transport Codex does not have, and a half-record, are not given out at all',
  !(codexMcpName('sse-legacy', PREFIX) in translated.servers) && !(codexMcpName('bez-komandy', PREFIX) in translated.servers)
  && translated.skipped.slice().sort().join(',') === 'bez-komandy,sse-legacy',
  JSON.stringify(translated.skipped));

check(': override keys carry the prefix — canonical names do not go into the config',
  PREFIX === 'promptobus-'
  && !('promptobus' in translated.servers) && !('es-mcp-prod' in translated.servers)
  && codexMcpName('promptobus', PREFIX) in translated.servers
  && codexMcpName('es-mcp-prod', PREFIX) in translated.servers
  && codexMcpName('promptobus', PREFIX) === `${PREFIX}promptobus`
  && codexMcpName(`${PREFIX}promptobus`, PREFIX) === `${PREFIX}promptobus`,
  JSON.stringify(Object.keys(translated.servers)));

check(': toolName and phrases.tool call the override key, not the canonical name',
  toolName(codexDriver, 'promptobus', 'promptobus_send', HOST) === codexSees(`${PREFIX}promptobus`, 'promptobus_send')
  && toolName(codexDriver, 'promptobus', 'promptobus_mailbox', HOST) === PHRASES.tool('promptobus', 'promptobus_mailbox', HOST)
  && toolName(codexDriver, 'memory-hooks', 'search_facts', HOST) === codexSees(`${PREFIX}memory-hooks`, 'search_facts'),
  toolName(codexDriver, 'promptobus', 'promptobus_send', HOST));

// The prefix is the consumer's identity, and two consumers in one process are lawful:
// the host contract forbids a process-wide host. What has to hold for each of them
// separately is that the config key the holder writes and the tool name the prompt
// hands the participant are THE SAME string. They agree today only because they are
// one function called twice, and this is the check that keeps it one.
check(': two hosts in one process — different keys, and each prompt names its own config key',
  (() => {
    const set = { promptobus: { type: 'stdio', command: 'node', args: [], env: {} } };
    const myKey = Object.keys(codexMcpServers(set, codexMcpPrefix(HOST)).servers)[0];
    const theirKey = Object.keys(codexMcpServers(set, codexMcpPrefix(OTHER)).servers)[0];
    return myKey === 'promptobus-promptobus' && theirKey === 'otherbus-promptobus'
      && toolName(codexDriver, 'promptobus', 'promptobus_send', HOST) === codexSees(myKey, 'promptobus_send')
      && toolName(codexDriver, 'promptobus', 'promptobus_send', OTHER) === codexSees(theirKey, 'promptobus_send');
  })(),
  `${toolName(codexDriver, 'promptobus', 'promptobus_send', HOST)} / ${toolName(codexDriver, 'promptobus', 'promptobus_send', OTHER)}`);

// A key built with no prefix is the collision the whole mechanism exists for, and it
// fails in silence at both ends: the Codex config load dies whole, and a participant is
// told a tool name it does not have. So it refuses instead of handing back the bare name.
check(': a name built without a prefix refuses rather than falling back to the canonical one',
  thrown(() => codexMcpName('promptobus')).threw
  && /prefix/.test(thrown(() => codexMcpName('promptobus')).msg),
  thrown(() => codexMcpName('promptobus')).msg);

const ctx = {
  mcp: { servers: { promptobus: { command: 'node', args: ['x'], env: {} } } },
  prompt: 'PROMPT',
  model: DEFAULT_MODEL,
  cwd: '/tmp/wt',
  addDirs: ['/tmp/rules'],
  // The reviewer's own working directory is derived from this path, the way the Cursor
  // sandbox is: one participant file stem, one directory beside it in the task store.
  settingsPath: path.join(SB, 'plan', 'reviewer-cdx.settings.json'),
};
const workerPlan = codexDriver.prepare(ctx);
// PB-170: the hook-trust bypass is a GLOBAL option and the whole defect was its position,
// so the assertion is on the ORDER — `argv.includes(flag)` is green on the broken form too.
check(': argv is the bypass flag, then app-server --stdio; prompt separate; no files on disk',
  workerPlan.argv.length === 3
  && workerPlan.argv.indexOf('--dangerously-bypass-hook-trust') < workerPlan.argv.indexOf('app-server')
  && workerPlan.argv[1] === 'app-server' && workerPlan.argv[2] === '--stdio'
  && workerPlan.prompt === 'PROMPT'
  // `.codex/.gitignore` стал безусловным в этой же ветке — один файл, не ноль.
  && workerPlan.files.length === 1
  && workerPlan.files[0].path === path.join(ctx.cwd, '.codex', '.gitignore')
  && workerPlan.settings.sandbox === 'workspace-write'
  && workerPlan.settings.approvalPolicy === 'on-request',
  JSON.stringify({ argv: workerPlan.argv, files: workerPlan.files, settings: workerPlan.settings }));

const reviewerPlan = codexDriver.prepare({ ...ctx, denyTools: REVIEWER_DENY, role: 'reviewer' });
check('PB-161.2: reviewer — read-only, a working directory of its own, the reviewed tree attached as a read',
  reviewerPlan.settings.sandbox === 'read-only'
  && reviewerPlan.cwd === reviewSandbox(ctx.settingsPath)
  && reviewerPlan.cwd !== ctx.cwd
  && reviewerPlan.settings.addDirs.includes(ctx.cwd)
  && reviewerPlan.settings.addDirs.includes('/tmp/rules')
  // No canon and no guard command here, so one file: the `.gitignore` that creates the
  // reviewer's directory before the lift, which app-server is handed as the thread cwd.
  && reviewerPlan.files.length === 1
  && reviewerPlan.files[0].path === path.join(reviewSandbox(ctx.settingsPath), '.codex', '.gitignore')
  && reviewerPlan.files[0].text === '*\n',
  JSON.stringify({ cwd: reviewerPlan.cwd, files: reviewerPlan.files, settings: reviewerPlan.settings }));

// --- PB-180: the participant's hooks land where the participant looks ----------------

// `install` writes `.codex/hooks.json` at the WORKSPACE ROOT, and a participant's cwd is
// its worktree or its reviewer sandbox — neither is that root, and neither would see it.
// The working directory is also the one project this participant trusts, so the hooks go
// there. Measured on the plan, which is where the decision lives; whether the harness
// then runs them is the holder journal's answer and costs a paid turn.
const GUARD_CMD = '"/abs/node" "/abs/promptobus.js" guard --role worker:api --task T --home /abs/home';
const hookedWorker = codexDriver.prepare({ ...ctx, guardCommand: GUARD_CMD });
const hookedReviewer = codexDriver.prepare({
  ...ctx, guardCommand: GUARD_CMD, denyTools: REVIEWER_DENY, role: 'reviewer',
});
const hooksOf = (plan, dir) => {
  const file = plan.files.find((f) => f.path === path.join(dir, '.codex', 'hooks.json'));
  return file ? JSON.parse(file.text) : null;
};
const workerHooks = hooksOf(hookedWorker, ctx.cwd);
const reviewerHooks = hooksOf(hookedReviewer, reviewSandbox(ctx.settingsPath));
check('PB-180: both roles get a hooks file in their own working directory, not at the workspace root',
  // A reviewer's directory is not the worker's: a fix that only reached the worker would
  // leave half the contract, and that half is the one the live measurement was made on.
  workerHooks !== null && reviewerHooks !== null
  && !hookedWorker.files.some((f) => f.path.includes(`${path.sep}.codex${path.sep}hooks.json`)
    && !f.path.startsWith(ctx.cwd + path.sep)),
  JSON.stringify({ worker: hookedWorker.files.map((f) => f.path), reviewer: hookedReviewer.files.map((f) => f.path) }));
check('PB-180: the hooks file carries the guard for both events, with THIS participant identity',
  [workerHooks, reviewerHooks].every((doc) =>
    doc.hooks.Stop[0].hooks[0].command === GUARD_CMD
    && doc.hooks.SessionStart[0].hooks[0].command === GUARD_CMD),
  JSON.stringify({ worker: workerHooks, reviewer: reviewerHooks }));
// Negative control: without a guard command the plan writes no hooks file at all, so the
// two checks above are measuring the command and not the shape of `files`.
check('PB-180: no guard command, no hooks file',
  hooksOf(workerPlan, ctx.cwd) === null && hooksOf(reviewerPlan, reviewSandbox(ctx.settingsPath)) === null,
  JSON.stringify(workerPlan.files.map((f) => f.path)));
// The copy stays out of a worker's diff: `.codex` now always holds a file, so the
// self-ignoring `.gitignore` is no longer conditional on there being a canon.
check('PB-180: the .gitignore that hides .codex is written whether or not a canon travels',
  hookedWorker.files.some((f) => f.path === path.join(ctx.cwd, '.codex', '.gitignore') && f.text === '*\n'),
  JSON.stringify(hookedWorker.files.map((f) => f.path)));

// --- PB-161: the plan names a home, and the skills canon travels as files ------------

check('PB-161: two participants of one task get two homes, both under the homes root',
  codexDriver.participantCodexHome({ task: TASK, address: WORKER })
    !== codexDriver.participantCodexHome({ task: TASK, address: REVIEWER })
  && path.dirname(codexDriver.participantCodexHome({ task: TASK, address: WORKER })) === participantHomesRoot()
  && participantHomesRoot().startsWith(tmpdir())
  && codexDriver.participantCodexHome({ task: TASK, address: WORKER })
    === codexDriver.participantCodexHome({ task: TASK, address: WORKER }),
  codexDriver.participantCodexHome({ task: TASK, address: WORKER }));

// Two addresses whose readable head is identical past the truncation point. The head
// is cosmetic; the hash carries task and address in full, and it is what keeps them apart.
const longA = `worker:${'a'.repeat(60)}-one`;
const longB = `worker:${'a'.repeat(60)}-two`;
check('PB-161: two long addresses with the same readable head do not share a home',
  codexDriver.participantCodexHome({ task: TASK, address: longA })
    !== codexDriver.participantCodexHome({ task: TASK, address: longB }),
  `${codexDriver.participantCodexHome({ task: TASK, address: longA })} / ${codexDriver.participantCodexHome({ task: TASK, address: longB })}`);

// The owner's home is the directory this guard exists for, so whether it is there is
// read ONCE, before the calls, and compared with what is there after them.
const ownerHomeWasThere = existsSync(path.join(homedir(), '.codex'));
check('PB-161: an owner home is never removed as a participant home',
  removeParticipantHome(path.join(homedir(), '.codex')) === false
  && removeParticipantHome(participantHomesRoot()) === false
  && removeParticipantHome(path.join(participantHomesRoot(), 'x', 'nested')) === false
  && removeParticipantHome('') === false
  && existsSync(path.join(homedir(), '.codex')) === ownerHomeWasThere,
  `owner home present before: ${ownerHomeWasThere}, after: ${existsSync(path.join(homedir(), '.codex'))}`);

const guardVictim = path.join(participantHomesRoot(), 'pb161-guard-probe');
mkdirSync(guardVictim, { recursive: true });
check('PB-161: a direct child of the homes root is removed',
  removeParticipantHome(guardVictim) === true && !existsSync(guardVictim), guardVictim);

// The home path is derived from task and address, so a neighbour on a shared temporary
// directory can get there first. `mkdirSync` with `recursive` follows an existing
// symlink without a word, and a link aimed at the owner's home would have the mechanism
// write its `config.toml` over theirs.
const symVictim = path.join(SB, 'sym-victim-codex-home');
const symHome = path.join(participantHomesRoot(), 'pb161-symlink-probe');
mkdirSync(symVictim, { recursive: true });
writeFileSync(path.join(symVictim, 'config.toml'), 'owner = "do not touch"\n');
// The homes root is shared with every other run on this machine, so the probe clears
// its own name first: a link left by a run that died mid-file would make this one
// throw on `symlinkSync` instead of checking anything. `unlinkSync` removes the LINK;
// `rmSync` calls a link to a directory EISDIR.
try { unlinkSync(symHome); } catch { rmSync(symHome, { recursive: true, force: true }); }
symlinkSync(symVictim, symHome);
const symRefusal = thrown(() => makeParticipantHome({ dir: symHome, config: '[mcp_servers.x]\ncommand = "node"\n' }));
check('PB-161: a symlink at the home path is refused, and what it points at is untouched',
  symRefusal.threw && /not a directory \(symbolic link\)/.test(symRefusal.msg)
  && readFileSync(path.join(symVictim, 'config.toml'), 'utf8') === 'owner = "do not touch"\n'
  && !existsSync(path.join(symVictim, 'auth.json')),
  `${symRefusal.msg} · ${readFileSync(path.join(symVictim, 'config.toml'), 'utf8')}`);
unlinkSync(symHome); // the link itself, not what it points at — rmSync calls a link to a directory EISDIR

// A home nothing names is a home whose session is over. The sweep is what covers the
// ways the record-bound removal cannot be reached: a holder killed outright, a lift
// that died before writing its record, a task closed on a dead app-server.
const orphanHome = path.join(participantHomesRoot(), 'pb161-orphan-probe');
mkdirSync(orphanHome, { recursive: true });
writeFileSync(path.join(orphanHome, 'auth.json'), '{"stub":"credentials"}\n', { mode: 0o600 });
const sweptOrphans = sweepParticipantHomes({ PROMPTOBUS_CODEX_HOME: path.join(SB, 'sweep-empty-registry') });
check('PB-161: a home no session record names is swept, credentials copy and all',
  sweptOrphans.includes(orphanHome) && !existsSync(orphanHome),
  JSON.stringify(sweptOrphans));

// And the reverse, which is what makes the sweep safe to run at every lift: a home a
// live record names is not touched by it.
const liveHome = path.join(participantHomesRoot(), 'pb161-live-probe');
const sweepRegistry = { PROMPTOBUS_CODEX_HOME: path.join(SB, 'sweep-live-registry') };
mkdirSync(liveHome, { recursive: true });
writeSession({ ref: 'pb161-live-ref', codexHome: liveHome, state: 'alive' }, sweepRegistry);
const sweptBeside = sweepParticipantHomes(sweepRegistry);
check('PB-161: a home a live record names survives the sweep',
  !sweptBeside.includes(liveHome) && existsSync(liveHome), JSON.stringify(sweptBeside));

// `dropSession` is where the record goes, so it is where the home goes: every path
// that drops a record — stop, a failed lift, anything later — takes the home with it
// without having to remember to.
dropSession('pb161-live-ref', sweepRegistry);
check('PB-161: dropping the record drops the home it names',
  !existsSync(liveHome), liveHome);

// `done` calls this for a participant whose session is dead, with or without a
// worktree. A reviewer has none, and its home holds the same credentials copy.
const sweptByTask = path.join(participantHomesRoot(), path.basename(
  codexDriver.participantCodexHome({ task: 'pb161-sweep-task', address: 'reviewer:none' }),
));
mkdirSync(sweptByTask, { recursive: true });
check('PB-161: a closed participant with no session record is swept by task and address',
  codexDriver.sweepParticipant({ metadata: { address: 'reviewer:none' } }, 'pb161-sweep-task', sweepRegistry) === true
  && !existsSync(sweptByTask)
  && codexDriver.sweepParticipant({ metadata: {} }, 'pb161-sweep-task', sweepRegistry) === false,
  sweptByTask);

// The trust key measured on codex-cli 0.146.0: the RESOLVED spelling is trusted and
// the unresolved one is not, so a link in the path is the case that decides it. A
// sandbox whose paths are already resolved cannot tell `realpath` from `resolve`.
const trustReal = path.join(SB, 'trust-real');
const trustLink = path.join(SB, 'trust-link');
mkdirSync(path.join(trustReal, 'inner'), { recursive: true });
symlinkSync(trustReal, trustLink);
check('PB-161: the trust key follows the link to the real directory',
  trustPath(path.join(trustLink, 'inner')) === path.join(realpathSync(trustReal), 'inner')
  && trustPath(path.join(trustLink, 'inner')) !== path.join(trustLink, 'inner')
  && path.resolve(path.join(trustLink, 'inner')) === path.join(trustLink, 'inner')
  // A directory that is not there yet still gets a record, and it is the resolved one.
  && trustPath(path.join(SB, 'trust-absent')) === path.resolve(path.join(SB, 'trust-absent')),
  `${trustPath(path.join(trustLink, 'inner'))} vs ${path.join(trustLink, 'inner')}`);

check('PB-161: the home config carries quoted keys for a prefixed server and an absolute project path',
  (() => {
    const text = codexHomeConfig({
      servers: { 'promptobus-bus': { command: 'node', args: ['a b'], env: { K: 'v"q' } } },
      trusted: ['/private/var/a b/wt'],
    });
    return text.includes('[mcp_servers.promptobus-bus]')
      && text.includes('args = ["a b"]')
      && text.includes('[mcp_servers.promptobus-bus.env]')
      && text.includes('K = "v\\"q"')
      && text.includes('[projects."/private/var/a b/wt"]')
      && text.includes('trust_level = "trusted"');
  })(),
  codexHomeConfig({ servers: { 'promptobus-bus': { command: 'node', args: ['a b'], env: { K: 'v"q' } } }, trusted: ['/private/var/a b/wt'] }));

check('PB-161: an empty set writes an empty config rather than an empty table',
  codexHomeConfig({}) === '' && codexHomeConfig({ servers: { a: { command: 'x', args: [], env: {} } } })
    === '[mcp_servers.a]\ncommand = "x"\nargs = []\n',
  JSON.stringify(codexHomeConfig({ servers: { a: { command: 'x', args: [], env: {} } } })));

const skillsRoot = path.join(SB, 'skills-root');
mkdirSync(path.join(skillsRoot, '.codex', 'skills', 'alpha'), { recursive: true });
writeFileSync(path.join(skillsRoot, '.codex', 'skills', 'alpha', 'SKILL.md'), '# alpha\n');
mkdirSync(path.join(skillsRoot, '.codex', 'skills', '_shared'), { recursive: true });
const skillsPlan = codexDriver.prepare({ ...ctx, root: skillsRoot, task: TASK, address: WORKER });
check('PB-161: the worker plan copies the canon into <worktree>/.codex/skills and hides it from git',
  skillsPlan.files.length === 2
  && skillsPlan.files[0].path === path.join(ctx.cwd, '.codex', '.gitignore')
  && skillsPlan.files[0].text === '*\n'
  && skillsPlan.files[1].copyFrom === path.join(skillsRoot, '.codex', 'skills')
  && skillsPlan.files[1].path === path.join(ctx.cwd, '.codex', 'skills')
  && /^1 from /.test(skillsPlan.skillsNote)
  && skillsPlan.codexHome === participantHome,
  JSON.stringify({ files: skillsPlan.files, note: skillsPlan.skillsNote }));

check('PB-161.2: skillsNote has one sentence for both roles — a count, or the honest absence',
  workerPlan.skillsNote === skillsNoteOf({ src: null })
  && /no \.codex\/skills/.test(workerPlan.skillsNote)
  && reviewerPlan.skillsNote === workerPlan.skillsNote
  && skillsNote({ launch: skillsPlan, pluginDir: null, driver: codexDriver }) === skillsPlan.skillsNote
  && workspaceSkillsDir(null) === null
  && workspaceSkillsDir(path.join(SB, 'no-such-root')) === null,
  `${workerPlan.skillsNote} | ${reviewerPlan.skillsNote}`);

const reviewerSkills = codexDriver.prepare({
  ...ctx, root: skillsRoot, denyTools: REVIEWER_DENY, role: 'reviewer',
});
check('PB-161.2: the reviewer copy lands in its own directory, and nothing of it in the tree under review',
  reviewerSkills.files.length === 2
  && reviewerSkills.files.every((f) => f.path.startsWith(`${reviewSandbox(ctx.settingsPath)}${path.sep}`))
  && !reviewerSkills.files.some((f) => f.path.startsWith(`${ctx.cwd}${path.sep}`))
  && reviewerSkills.files[1].copyFrom === path.join(skillsRoot, '.codex', 'skills')
  && reviewerSkills.files[1].path === path.join(reviewSandbox(ctx.settingsPath), '.codex', 'skills')
  && /^1 from /.test(reviewerSkills.skillsNote),
  JSON.stringify({ files: reviewerSkills.files, note: reviewerSkills.skillsNote }));

// PB-161.1: the copy WIPES its destination before writing, so a repository that lawfully
// tracks `.codex/skills` of its own would lose it at lift and its branch would be dirty
// from the first second — `done` would not sweep the directory either. The guard is the
// hazard's, not one harness's: the driver names the directory its launch files claim and
// Git is asked about that one.
const gitIn = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
  { encoding: 'utf8' });
const trackedCodex = path.join(SB, 'tracked-codex-clone');
mkdirSync(path.join(trackedCodex, '.codex', 'skills', 'own'), { recursive: true });
gitIn(trackedCodex, 'init', '-q', '-b', 'master');
writeFileSync(path.join(trackedCodex, '.codex', 'skills', 'own', 'SKILL.md'), '# the repository`s own\n');
gitIn(trackedCodex, 'add', '.codex/skills/own/SKILL.md');
gitIn(trackedCodex, 'commit', '-qm', 'tracked codex skills');
let codexTrackedWarns = '';
const codexWarn0 = console.warn;
console.warn = (m) => { codexTrackedWarns += `${m}\n`; };
writeLaunchFiles(
  codexDriver.prepare({ ...ctx, cwd: trackedCodex, root: skillsRoot, task: TASK, address: WORKER }).files,
  codexDriver.options.launchDirs,
);
console.warn = codexWarn0;
check('PB-161.1: lift names an already-tracked .codex path the copy is about to wipe',
  /own\/SKILL\.md/.test(codexTrackedWarns)
  && codexTrackedWarns.includes(trackedCodex)
  && JSON.stringify(codexDriver.options.launchDirs) === JSON.stringify(['.codex']),
  codexTrackedWarns || '(silent)');

// The check above matched through the `.gitignore` written BESIDE the copy. The copy
// destination itself is the shape that wipes, and the guard must not need a sibling file
// to notice it: handed that one path alone, it names the same tracked file. (`git
// ls-files` reads the index, so the path is still tracked after the copy above removed
// it from disk — which is exactly the loss this warning exists to announce.)
let destOnlyWarns = '';
const destOnlyWarn0 = console.warn;
console.warn = (m) => { destOnlyWarns += `${m}\n`; };
writeLaunchFiles(
  [{
    path: path.join(trackedCodex, '.codex', 'skills'),
    copyFrom: path.join(skillsRoot, '.codex', 'skills'),
    text: '',
    secret: false,
  }],
  codexDriver.options.launchDirs,
);
console.warn = destOnlyWarn0;
check('PB-161.1: the copy destination alone is enough — the guard needs no sibling file',
  /own\/SKILL\.md/.test(destOnlyWarns) && destOnlyWarns.includes(trackedCodex),
  destOnlyWarns || '(silent)');

// And the other half of the same rule, which is the one a false warning would live in.
// A repository may lawfully keep its own `.codex/config.toml` and `.codex/agents` — the
// trust record of ADR-007 exists so a worker READS exactly those — and no lift writes
// them. Asking Git about the claimed directory whole would name them on every single
// lift and call them about to be overwritten; asking about the paths the lift writes
// says nothing.
const lawfulCodex = path.join(SB, 'lawful-codex-clone');
mkdirSync(path.join(lawfulCodex, '.codex', 'agents'), { recursive: true });
gitIn(lawfulCodex, 'init', '-q', '-b', 'master');
writeFileSync(path.join(lawfulCodex, '.codex', 'config.toml'), '[mcp_servers.own]\ncommand = "node"\n');
writeFileSync(path.join(lawfulCodex, '.codex', 'agents', 'reviewer.md'), '# the project`s own agent\n');
gitIn(lawfulCodex, 'add', '.codex/config.toml', '.codex/agents/reviewer.md');
gitIn(lawfulCodex, 'commit', '-qm', 'a lawful project codex layer');
let lawfulWarns = '';
const lawfulWarn0 = console.warn;
console.warn = (m) => { lawfulWarns += `${m}\n`; };
writeLaunchFiles(
  codexDriver.prepare({ ...ctx, cwd: lawfulCodex, root: skillsRoot, task: TASK, address: WORKER }).files,
  codexDriver.options.launchDirs,
);
console.warn = lawfulWarn0;
check('PB-161.1: a tracked .codex path the lift does not write is not called about to be overwritten',
  lawfulWarns === ''
  // …and the files are still tracked afterwards, so the silence is the guard's judgement
  // and not a tree that lost them.
  && String(gitIn(lawfulCodex, 'ls-files', '--', '.codex').stdout ?? '').includes('.codex/config.toml'),
  lawfulWarns || '(silent)');

const classifiedCodexPlan = codexDriver.prepare({
  ...ctx,
  mcp: {
    servers: {
      promptobus: { command: 'node', args: ['x'], env: {} },
      catalog: { type: 'http', url: 'http://catalog.invalid/mcp' },
    },
  },
  denyTools: [...REVIEWER_DENY, { server: 'catalog', tool: 'create_entry' }],
  role: 'reviewer',
});
const classifiedCodexServers = codexMcpServers(classifiedCodexPlan.mcpConfig.mcpServers, PREFIX).servers;
check('PB-87.1: Codex carries the classified MCP tool into prefixed disabled_tools',
  classifiedCodexPlan.mcpConfig.mcpServers.catalog?.disabled_tools?.join(',') === 'create_entry'
  && classifiedCodexServers[codexMcpName('catalog', PREFIX)]?.disabled_tools?.join(',') === 'create_entry',
  JSON.stringify({ config: classifiedCodexPlan.mcpConfig, servers: classifiedCodexServers }));

// PB-166.2: the composition, not a lift — the lift is a paid turn and carries no more.
// A sentinel, not the run's own trace path: the run already has both names set.
const wardenEnv0 = {
  PROMPTOBUS_WARDEN: process.env.PROMPTOBUS_WARDEN,
  PROMPTOBUS_WARDEN_TRACE: process.env.PROMPTOBUS_WARDEN_TRACE,
};
const WARDEN_TRACE_SENTINEL = path.join(SB, 'warden-forward-probe.log');
process.env.PROMPTOBUS_WARDEN = 'off';
process.env.PROMPTOBUS_WARDEN_TRACE = WARDEN_TRACE_SENTINEL;
const wardenOnBus = codexDriver.prepare({ ...ctx, ref: 'warden-forward-probe' })
  .mcpConfig.mcpServers.promptobus?.env ?? {};
// Negative control: an unconditional forward writes `undefined`, which only `in` catches.
delete process.env.PROMPTOBUS_WARDEN;
delete process.env.PROMPTOBUS_WARDEN_TRACE;
const wardenOffBus = codexDriver.prepare({ ...ctx, ref: 'warden-forward-probe' })
  .mcpConfig.mcpServers.promptobus?.env ?? {};
for (const [name, was] of Object.entries(wardenEnv0)) {
  if (was === undefined) delete process.env[name];
  else process.env[name] = was;
}
check('PB-166.2: the warden switch and its trace reach the participant MCP entry, and only when set',
  wardenOnBus.PROMPTOBUS_WARDEN === 'off'
  && wardenOnBus.PROMPTOBUS_WARDEN_TRACE === WARDEN_TRACE_SENTINEL
  // The session file survives beside them: the forward adds, it does not swap.
  && typeof wardenOnBus[SESSION_ENV_VAR] === 'string' && wardenOnBus[SESSION_ENV_VAR] !== ''
  && !('PROMPTOBUS_WARDEN' in wardenOffBus) && !('PROMPTOBUS_WARDEN_TRACE' in wardenOffBus),
  JSON.stringify({ set: wardenOnBus, unset: wardenOffBus }));

// `renderNotification` takes ONE argument — the arity the driver contract declares —
// and finds the override key prefix on the session record, the same channel the
// holder reads it from. A `Notification` carries no host and no ref, so the record
// is found by the task and address it does name.
const SEAM_REF = 'seam-render-probe';
writeSession({
  ref: SEAM_REF, task: 'T', address: 'worker:a', mcpPrefix: PREFIX, state: 'alive',
});
const seamNote = {
  kind: 'unread', task: 'T', address: 'worker:a', unread: 1,
  messages: [{ type: 'answer', from: 'orchestrator', ts: 'now', body: 'BODY' }],
};
check(': the wake text calls the mailbox by the Codex name, taken off the session record',
  (() => {
    const text = codexDriver.renderNotification(seamNote);
    return text.includes(codexSees(codexMcpName('promptobus', PREFIX), 'promptobus_mailbox')) && text.includes('BODY');
  })());

// The seam has to return a string. A registry that holds no such record cannot know
// the key, and naming a key it guessed would be worse than naming none — so the tool
// is named without one, and nothing throws. A live session never reaches this branch:
// `activate` refuses first, with the record in hand.
dropSession(SEAM_REF);
check(': with no record behind it the seam names the tool without a key, and does not throw',
  (() => {
    const r = thrown(() => codexDriver.renderNotification(seamNote));
    if (r.threw) return false;
    const text = codexDriver.renderNotification(seamNote);
    return !text.includes('mcp__') && /mailbox tool/.test(text) && text.includes('BODY');
  })(), thrown(() => codexDriver.renderNotification(seamNote)).msg);

const { ws, repoAbs, repo } = buildWorkspace(SB);
writeHostConfig(ws, { tools: ['claude', 'codex'] });

// The workspace `sync` render of the Codex skills canon — the source the participant
// worktree gets a copy of. One skill with a marker file, so a check can say the copy
// arrived rather than that a directory exists.
mkdirSync(path.join(ws, '.codex', 'skills', 'codex-canon-probe'), { recursive: true });
writeFileSync(path.join(ws, '.codex', 'skills', 'codex-canon-probe', 'SKILL.md'), '# codex canon probe\n');
const home = path.join(ws, '.promptobus');
const brief = path.join(SB, 'worker-brief.md');
writeFileSync(brief, '# Codex driver probe\n\nSend the orchestrator a status and end the turn.\n');

const MARK = 'CODEX-STATUS-1';
const WOKE = 'CODEX-WOKE-1';
const STEERED = 'CODEX-STEER-1';
const REVIEW_MARK = 'CODEX-REVIEW-1';
const NOTE_FILE = 'codex/note.md';
const FORBIDDEN = 'codex/forbidden.md';

planParticipant(HARNESS, WORKER, {
  turns: [
    {
      do: [
        { write: { path: NOTE_FILE, text: `# ${MARK}\n` } },
        { commit: { message: ': правка worker’а Codex' } },
        { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: `${MARK}: worker Codex на связи` } },
      ],
    },
    { do: [{ wait: 900 }, { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: `${STEERED}: второй ход` } }] },
    { do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: `${WOKE}: разбужен` } }] },
  ],
});
planParticipant(HARNESS, REVIEWER, {
  turns: [
    {
      do: [
        { write: { path: FORBIDDEN, text: 'must not appear\n' } },
        { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: `${REVIEW_MARK}: замечаний нет` } },
      ],
    },
  ],
});

const env = {
  ...process.env,
  PROMPTOBUS_HOME: home,
  CLAUDE_CODE_SESSION_ID: ORCH_SESSION,
  PROMPTOBUS_WARDEN: 'off',
  CODEX_HOME: callerCodexHome,
  [CODEX_HOME_VAR]: HARNESS,
  PROMPTOBUS_CODEX_HOME: stateHome,
};
const elicitEnv = { ...env, [ELICIT_VAR]: '1' };
store.createTask(home, { id: TASK, title: 'проба driver’а Codex', owner: ORCH_SESSION });

const bare = path.join(SB, 'bare-ws');
writeHostConfig(bare, { tools: ['claude'] });
const undeclared = thrown(() => liftHarness(bare, 'codex'));
check(': a harness outside promptobus.json is refused before lift and names the file and the field',
  undeclared.threw && /promptobus\.json/.test(undeclared.msg) && /"tools" array/.test(undeclared.msg)
  && /"codex"/.test(undeclared.msg) && !/tools add/.test(undeclared.msg), undeclared.msg);
check(': a declared harness passes the same gate',
  liftHarness(ws, 'codex').id === 'codex');

const dry = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'cdx', '--harness', 'codex', '--dry-run'], { cwd: ws, env });
check(': --dry-run prints app-server --stdio and writes nothing to disk',
  dry.status === 0 && /app-server --stdio/.test(dry.out) && /dry-run: nothing written to disk, worker not started/.test(dry.out),
  dry.out.slice(-500));
check(': --dry-run names the harness-owned thread id',
  /harness session name: the thread id is chosen by app-server itself and printed on lift/.test(dry.out),
  dry.out.slice(-400));
// PB-161 review: `--dry-run` has to print the home. The line above it says CODEX_HOME
// is dropped from the parent, which alone reads as "the session will use ~/.codex" —
// the opposite of what happens. And the path must be the one a real lift uses, which
// is what makes the name deterministic rather than mkdtemp.
check('PB-161: spawn --dry-run names the participant home, next to the dropped-variable line',
  /dropped from the parent[^\n]*CODEX_HOME/.test(dry.out)
  && dry.out.includes(`Codex home: ${codexDriver.participantCodexHome({ task: TASK, address: WORKER })}`)
  && /CODEX_HOME is dropped from the parent and set to this/.test(dry.out)
  && dry.out.indexOf('Codex home:') > dry.out.indexOf('dropped from the parent'),
  dry.out.split('\n').filter((l) => /CODEX_HOME|Codex home/.test(l)).join(' | '));

check(': Codex --dry-run does not present the prompt as a positional app-server argument',
  !/app-server --stdio <prompt>/.test(dry.out)
  && /turn\/start request/.test(dry.out), dry.out.slice(-600));

const CHOSEN_TITLE = 'Codex named slice';
const spawned = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'cdx', '--title', CHOSEN_TITLE, '--harness', 'codex'], { cwd: ws, env });
check('step 1: promptobus spawn --harness codex lifted the participant',
  spawned.status === 0 && /worker worker:cdx lifted/.test(spawned.out), spawned.out.slice(-800));

const wp = store.participantOf(store.readTask(home, TASK), WORKER);
check('step 1: the record carries harness codex and a capabilities snapshot',
  wp?.harness === 'codex' && wp?.mode === 'managed' && wp?.capabilities?.activation === 'push'
  && wp?.capabilities?.sessionList === true, JSON.stringify(wp?.capabilities));

const ref = wp?.sessionRef ?? '';
const record = readSession(ref, env);
let holderJournal = '';
try { holderJournal = readFileSync(holderLogFile(ref, env), 'utf8'); } catch { /* not yet */ }
const holderFirstLine = holderJournal.split('\n')[0];
check('step 1: the thread landed in the mechanism registry — thread id and holder are alive',
  !!record?.threadId && record.state === 'alive' && typeof record.holderPid === 'number',
  JSON.stringify({ threadId: record?.threadId, state: record?.state, holder: record?.holderPid }));

check(': the Codex holder journal starts with launch provenance',
  typeof record?.provenance === 'string'
  && record.provenance.startsWith('promptobus copy: cli=')
  && record.provenance.includes('package=' + PACKAGE_PATH + '@' + PACKAGE_VERSION)
  && record.provenance.includes('host=' + PACKAGE_VERSION)
  && record.provenance.includes('participant=' + record.bin)
  && record.provenance.includes('version=')
  && record.packagePath === PACKAGE_PATH
  && record.packageVersion === PACKAGE_VERSION
  && record.mechanismVersion === record.hostVersion
  && record.hostVersion === PACKAGE_VERSION
  && typeof record?.mechanismPath === 'string'
  && holderFirstLine.includes(record.provenance),
  JSON.stringify({ provenance: record?.provenance, holderFirstLine }));

check(': the session record does not persist the caller environment',
  !!record && !('childEnv' in record), Object.keys(record ?? {}).sort().join(','));

const appThread = await awaitThread(record?.threadId);
check('PB-161: the holder app-server runs in the participant home, not the caller CODEX_HOME',
  appThread?.appServerEnv?.CODEX_HOME === participantHome
    && appThread?.appServerEnv?.CODEX_HOME !== callerCodexHome
    && record?.codexHome === participantHome
    && appThread?.appServerEnv?.PROMPTOBUS_CODEX_HOME === stateHome,
  JSON.stringify({ env: appThread?.appServerEnv ?? null, record: record?.codexHome, want: participantHome }));

// What the app-server found in that home at `thread/start`: the mechanism's MCP
// entries, the trust record for the worktree by its RESOLVED path, and a copy of the
// owner's credentials at 0600. The owner's own home is not read for any of it beyond
// the one file that is copied.
const homeSeen = appThread?.codexHome ?? null;
check('PB-161: the participant home carries the mechanism MCP set and nothing of the owner`s',
  typeof homeSeen?.config === 'string'
    && homeSeen.config.includes(`[mcp_servers.${codexMcpName('promptobus', PREFIX)}]`)
    && !homeSeen.config.includes('[mcp_servers.promptobus]')
    && homeSeen.entries.includes('config.toml'),
  JSON.stringify({ entries: homeSeen?.entries, config: homeSeen?.config }));

check('PB-161: the worktree is trusted by its realpath, and the record is in the home, not in the owner`s config',
  typeof homeSeen?.config === 'string'
    && homeSeen.config.includes(`[projects."${realpathSync(wp?.metadata?.worktree ?? repoAbs)}"]`)
    && /trust_level = "trusted"/.test(homeSeen.config),
  String(homeSeen?.config).slice(-300));

check('PB-161: the owner auth travels as a copy at mode 0600',
  homeSeen?.auth === '0600' && homeSeen.entries.includes('auth.json'),
  JSON.stringify({ auth: homeSeen?.auth, entries: homeSeen?.entries }));

check('PB-161: no config.mcp_servers override rides on thread/start any more',
  appThread?.config?.mcp_servers === undefined,
  JSON.stringify(appThread?.config ?? null));

check('PB-161: the workspace .codex/skills canon is copied into the worktree and ignored by git',
  existsSync(path.join(wp?.metadata?.worktree ?? '', '.codex', 'skills', 'codex-canon-probe', 'SKILL.md'))
    && readFileSync(path.join(wp?.metadata?.worktree ?? '', '.codex', '.gitignore'), 'utf8') === '*\n'
    && spawnSync('git', ['-C', wp?.metadata?.worktree ?? '.', 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim() === '',
  spawnSync('git', ['-C', wp?.metadata?.worktree ?? '.', 'status', '--porcelain'], { encoding: 'utf8' }).stdout);

check(': Codex thread name equals the chosen session name in the participant record',
  /^Worker: Codex named slice \(\d{4}-\d{4}\)$/.test(wp?.metadata?.name ?? '')
    && record?.name === wp?.metadata?.name
    && appThread?.name === wp?.metadata?.name,
  JSON.stringify({ recordName: record?.name, sessionRef: wp?.metadata?.name, threadName: appThread?.name }));

const legacyRef = 'legacy-codex-name-fallback';
writeSession({
  ref: legacyRef,
  cwd: ws,
  bin: path.join(SB, 'bin', 'codex'),
  role: 'worker',
  startedAt: new Date().toISOString(),
  threadId: null,
  holderPid: null,
  appPid: null,
  rpcSocket: null,
  state: 'starting',
  sandbox: 'workspace-write',
  approvalPolicy: 'on-request',
  model: DEFAULT_MODEL,
  effort: null,
  addDirs: [],
  mcpServers: {},
  mcpPrefix: PREFIX,
  prompt: 'legacy prompt',
  home,
  task: TASK,
  address: 'worker:legacy-name',
  argv: ['app-server', '--stdio'],
  turns: 0,
}, env);
startHolder(legacyRef, env);
const legacyReady = await waitReady(legacyRef, env, 20000);
const legacyThread = await awaitThread(legacyReady.record?.threadId);
check(': an old Codex record without a name uses the machine-name fallback',
  legacyReady.ok && legacyThread?.name === `promptobus:${TASK}:worker:legacy-name`,
  JSON.stringify({ ready: legacyReady, name: legacyThread?.name, timedOut: legacyThread?.__timedOut }));
await reapHolder(legacyRef, env);
dropSession(legacyRef, env);

const SECOND_TITLE = 'Second Codex named slice';
planParticipant(HARNESS, SECOND_WORKER, { turns: [{ do: [] }] });
const secondSpawned = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'cdx-second', '--title', SECOND_TITLE, '--harness', 'codex'], { cwd: ws, env });
const secondWp = store.participantOf(store.readTask(home, TASK), SECOND_WORKER);
const secondRef = secondWp?.sessionRef ?? '';
const secondRecord = readSession(secondRef, env);
const secondThread = await awaitThread(secondRecord?.threadId);
check(': two Codex workers on one task keep distinct title-based names',
  secondSpawned.status === 0
    && wp?.metadata?.name !== secondWp?.metadata?.name
    && wp?.metadata?.name?.includes(CHOSEN_TITLE)
    && secondWp?.metadata?.name?.includes(SECOND_TITLE)
    && secondRecord?.name === secondWp?.metadata?.name
    && secondThread?.name === secondWp?.metadata?.name
    && !wp?.metadata?.name?.includes(WORKER)
    && !secondWp?.metadata?.name?.includes(SECOND_WORKER),
  JSON.stringify({ first: wp?.metadata?.name, second: secondWp?.metadata?.name,
    firstThread: appThread?.name, secondThread: secondThread?.name }));
if (secondRef) await codexDriver.stop(secondRef);

const modeEnv = { ...env, PROMPTOBUS_CODEX_HOME: path.join(SB, 'fresh-mode-state') };
const modeRef = 'fresh-mode-probe';
writeSession({ ref: modeRef }, modeEnv);
const sessionsMode = statSync(sessionsDir(modeEnv)).mode & 0o777;
check(': a freshly created Codex sessions directory is private',
  process.platform === 'win32' || sessionsMode === 0o700,
  process.platform === 'win32'
    ? 'win32: POSIX mode assertion skipped because Windows uses ACLs'
    : sessionsMode.toString(8));
dropSession(modeRef, modeEnv);

const timeEnv = { ...env, [CURRENT_TIME_VAR]: '1' };
planParticipant(HARNESS, 'worker:time', { turns: [{ do: [] }] });
const timeSpawned = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'time', '--harness', 'codex'], { cwd: ws, env: timeEnv });
const timeWp = store.participantOf(store.readTask(home, TASK), 'worker:time');
const timeRef = timeWp?.sessionRef ?? '';
const timeThread = await waitFor(() => {
  try {
    const thread = JSON.parse(readFileSync(path.join(HARNESS, 'threads', `${timeWp?.metadata?.session ?? ''}.json`), 'utf8'));
    return thread.currentTimes?.length === 2 ? thread : null;
  } catch {
    return null;
  }
}, { timeoutMs: 15000 });
let timeHolderLog = '';
try { timeHolderLog = readFileSync(holderLogFile(timeRef, timeEnv), 'utf8'); } catch { /* none */ }
const timeWardenLog = store.tailWardenLog(home, TASK, 100).join('\n');
check(': currentTime/read gets a fresh timestamp per holder request without denial',
  timeSpawned.status === 0
    && timeThread?.currentTimes?.[0]
    && timeThread?.currentTimes?.[1]
    && timeThread.currentTimes[0] !== timeThread.currentTimes[1]
    && /approval allow currentTime\/read/.test(timeHolderLog)
    && !/approval (?:deny|unknown deny) currentTime\/read/.test(timeHolderLog)
    && !/currentTime\/read/.test(timeWardenLog),
  `${timeSpawned.status} · ${JSON.stringify(timeThread?.currentTimes)} · holder=${timeHolderLog.slice(-500)} · warden=${timeWardenLog.slice(-500)}`);
if (timeRef) await codexDriver.stop(timeRef);

check('step 1: the session handle is the thread id',
  wp?.metadata?.session === record?.threadId, `${wp?.metadata?.session} · ${record?.threadId}`);

const sent = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
  .find((m) => String(m.body ?? '').includes(MARK)) ?? null, { timeoutMs: 25000 });
check('step 2: the bus loop from Codex closed — status reached the orchestrator',
  !!sent, `${JSON.stringify(sent)} · ${diagnoseTrace(HARNESS, WORKER)}`);

const idle = await waitFor(() => {
  const view = codexDriver.inspect(ref);
  return view && view.state === 'alive' && view.busy === false ? view : null;
}, { timeoutMs: 15000 });
check('step 3: the turn ended — the session is alive and not busy',
  idle?.state === 'alive' && idle?.busy === false && idle?.id === record?.threadId,
  JSON.stringify(idle));

{
  const idleStatus = cli([ 'status', '--task', TASK], { cwd: ws, env });
  const idleLine = idleStatus.out.split('\n').find((l) => l.includes(WORKER)) ?? idleStatus.out;
  check(': idle after a Codex turn — inspect.unknown, status is not a stall of unknown nature',
    idle?.stall?.kind === 'unknown' && /the turn ended/.test(String(idle?.stall?.reason))
    && idleStatus.status === 0 && /waiting for a message/.test(idleLine) && !/STALLED/.test(idleLine),
    `${JSON.stringify(idle)} · ${idleLine}`);
}

{
  const idleRec = readSession(ref);
  writeSession({ ...idleRec, busy: true });
  const during = codexDriver.inspect(ref);
  check(': a Codex turn in progress is not painted as a stall',
    during?.busy === true && during?.stall === null
      && !/stood/i.test(String(during?.note ?? '')),
    JSON.stringify(during));
  writeSession({
    ...idleRec,
    busy: false,
    lastTurn: {
      id: 'turn-fail',
      status: 'failed',
      at: new Date().toISOString(),
      error: 'invalid_request_error: probe',
    },
  });
  const failedView = codexDriver.inspect(ref);
  check(': a failed turn is a named stall even after a prior bus status',
    failedView.stall?.kind === 'failed'
      && /invalid_request_error: probe/.test(String(failedView.stall.reason))
      && stallStands(home, TASK, wp, failedView.stall) === true,
    JSON.stringify(failedView));
  const failedStatus = cli(['status', '--task', TASK], { cwd: ws, env });
  const failedLine = failedStatus.out.split('\n').find((l) => l.includes(WORKER)) ?? failedStatus.out;
  check(': promptobus status prints STALLED for a failed Codex turn',
    /STALLED/.test(failedLine) && /invalid_request_error: probe/.test(failedLine),
    failedLine);
  writeSession({
    ...idleRec,
    busy: false,
    lastTurn: { id: 'turn-ok', status: 'completed', at: new Date().toISOString() },
  });
  const recoveredView = codexDriver.inspect(ref);
  check(': a later successful turn does not retain the old failure',
    recoveredView.stall?.kind === 'unknown' && /the turn ended/.test(String(recoveredView.stall.reason)),
    JSON.stringify(recoveredView));
  writeSession({ ...idleRec, busy: false });
}

const statusOut = cli([ 'status', '--task', TASK], { cwd: ws, env });
check('step 3: promptobus status shows Codex session liveness',
  statusOut.status === 0 && statusOut.out.includes(WORKER), statusOut.out.slice(-400));

const second = await codexDriver.activate({ ref }, {
  kind: 'unread', task: TASK, address: WORKER, unread: 1,
  messages: [{ type: 'task', from: 'orchestrator', ts: 'now', body: 'второй ход' }],
});
check('step 4: activate while idle starts a turn', second.ok === true, JSON.stringify(second));

await new Promise((r) => { setTimeout(r, 80); });
const queued = await codexDriver.activate({ ref }, {
  kind: 'unread', task: TASK, address: WORKER, unread: 2,
  messages: [{ type: 'task', from: 'orchestrator', ts: 'now', body: 'steer' }],
});
check('step 4: activate during a turn queues a later turn, not a refusal',
  queued.ok === true, JSON.stringify(queued));

const secondSent = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
  .find((m) => String(m.body ?? '').includes(STEERED)) ?? null, { timeoutMs: 20000 });
check('step 4: the second turn arrived as a result',
  !!secondSent, `${JSON.stringify(secondSent)} · ${diagnoseTrace(HARNESS, WORKER)}`);
const queuedSent = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
  .find((m) => String(m.body ?? '').includes(WOKE)) ?? null, { timeoutMs: 20000 });
check('step 4: the queued wake ran only after the busy turn ended, without turn/steer',
  !!queuedSent && !readTrace(HARNESS, WORKER).some((e) => e.kind === 'steer'),
  `${JSON.stringify(queuedSent)} · ${diagnoseTrace(HARNESS, WORKER)}`);

const wt = wp?.metadata?.worktree ?? ws;
// PB-161.2: a marker in the reviewed tree's own `.codex/skills`. A reviewer copy into
// that tree would WIPE the destination first and take this file with it, so its survival
// is the check that the lift wrote nothing there.
const reviewedTreeMarker = path.join(wt, '.codex', 'skills', 'reviewed-tree-marker.md');
mkdirSync(path.dirname(reviewedTreeMarker), { recursive: true });
writeFileSync(reviewedTreeMarker, '# the reviewed tree keeps its own\n');
// The store home as the MECHANISM spells it: `planReview` realpaths the workspace root,
// and on macOS `/var/…` resolves to `/private/var/…`. A path built from the unresolved
// spelling would name a directory that exists and is not the one the lift used.
const reviewerSandboxDir = reviewSandbox(store.participantSettingsPath(realpathSync(home), TASK, REVIEWER));
const reviewed = cli([ 'review', wt, '--task', TASK, '--harness', 'codex'], { cwd: ws, env: elicitEnv });
check('step 5: promptobus review --harness codex lifted the reviewer',
  reviewed.status === 0 && /reviewer reviewer:cdx started/.test(reviewed.out), reviewed.out.slice(-600));

const reviewSent = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
  .find((m) => m.sender === store.addrDir(REVIEWER) && m.type === 'result'
    && String(m.body ?? '').includes(REVIEW_MARK)) ?? null, { timeoutMs: 25000 });
check('step 5: the reviewer report reached the orchestrator',
  !!reviewSent && reviewSent.sender === store.addrDir(REVIEWER) && reviewSent.type === 'result',
  `${JSON.stringify(reviewSent)} · ${diagnoseTrace(HARNESS, REVIEWER)}`);

check('step 5: the read-only reviewer did not write a file — there is no machine sign of refusal, we check the disk',
  // Both places: the reviewer's cwd is its own directory now, and a write that slipped
  // through would land there rather than in the tree under review.
  !existsSync(path.join(wt, FORBIDDEN)) && !existsSync(path.join(reviewerSandboxDir, FORBIDDEN)),
  existsSync(path.join(wt, FORBIDDEN)) ? 'file exists in the reviewed tree' : 'no file');

const reviewDenied = readTrace(HARNESS, REVIEWER).some((e) => e.kind === 'write-denied');
check('step 5: the stand refused the reviewer a write',
  reviewDenied, diagnoseTrace(HARNESS, REVIEWER));
const revPart = store.participantOf(store.readTask(home, TASK), REVIEWER);
let revElicitLog = '';
try { revElicitLog = readFileSync(holderLogFile(revPart?.sessionRef ?? '', env), 'utf8'); } catch { /* none */ }
check(': a reviewer elicitation is declined and the report still arrives',
  /approval deny mcpServer\/elicitation\/request/.test(revElicitLog)
    && /server=probe-mcp/.test(revElicitLog) && /mode=form/.test(revElicitLog)
    && !revElicitLog.includes('SECRET-PROMPT-DO-NOT-LOG'),
  revElicitLog.slice(-500));

// The reviewer's own home and its own working directory. The trust record names that
// directory — never the tree under review, which would let the repository being judged
// hand MCP servers to the session judging it — and the record lands in the participant's
// disposable home, not in the owner's `~/.codex/config.toml`.
const revThread = await awaitThread(readSession(revPart?.sessionRef ?? '', env)?.threadId);
check('PB-161: the reviewer lifts in a home of its own, carrying the mechanism MCP set',
  revThread?.appServerEnv?.CODEX_HOME === codexDriver.participantCodexHome({ task: TASK, address: REVIEWER })
    && revThread.appServerEnv.CODEX_HOME !== participantHome
    && typeof revThread.codexHome?.config === 'string'
    && revThread.codexHome.config.includes(`[mcp_servers.${codexMcpName('promptobus', PREFIX)}]`),
  JSON.stringify({ home: revThread?.appServerEnv?.CODEX_HOME, config: revThread?.codexHome?.config, timedOut: revThread?.__timedOut }));

const revSession = readSession(revPart?.sessionRef ?? '', env);
check('PB-161.2: the reviewer thread runs in a directory of its own, with the reviewed tree attached as a read',
  revThread?.cwd === reviewerSandboxDir
    && revThread.cwd !== wt
    && (revSession?.addDirs ?? []).includes(wt)
    // Containment roots are the record's cwd and addDirs — they moved with the directory.
    && revSession?.cwd === reviewerSandboxDir,
  JSON.stringify({ cwd: revThread?.cwd, sandbox: reviewerSandboxDir, addDirs: revSession?.addDirs, timedOut: revThread?.__timedOut }));

check('PB-161.2: the trust record names the reviewer directory, never the tree under review, and lands in the participant home',
  revThread?.codexHome?.dir === codexDriver.participantCodexHome({ task: TASK, address: REVIEWER })
    && revThread.codexHome.dir !== callerCodexHome
    && revThread.codexHome.config.includes(`[projects."${realpathSync(reviewerSandboxDir)}"]`)
    && !revThread.codexHome.config.includes(realpathSync(wt))
    && /trust_level = "trusted"/.test(revThread.codexHome.config),
  JSON.stringify({ dir: revThread?.codexHome?.dir, config: String(revThread?.codexHome?.config).slice(-300), timedOut: revThread?.__timedOut }));

check('PB-161.2: the workspace canon reached the reviewer directory, and the reviewed tree kept its own',
  existsSync(path.join(reviewerSandboxDir, '.codex', 'skills', 'codex-canon-probe', 'SKILL.md'))
    // The reviewed tree is this run's worker worktree, so it holds the canon the WORKER
    // lift copied. What the reviewer must not have done is wipe it: the marker laid
    // before the review lift is the file a copy into that tree would have taken.
    && existsSync(reviewedTreeMarker),
  JSON.stringify({
    sandbox: readdirSync(path.join(reviewerSandboxDir, '.codex', 'skills')),
    reviewed: readdirSync(path.join(wt, '.codex', 'skills')),
  }));

check('PB-161.2: the real lift names the reviewer directory and the canon that went into it',
  reviewed.out.includes(`reviewer home: ${reviewerSandboxDir}`)
    // The canon travels as files, so whether it arrived is a fact about THIS lift, and
    // `--dry-run` is not where an operator of a real one can read it.
    && reviewed.out.includes('workspace skills: 1 from ')
    && reviewed.out.includes(path.join(reviewerSandboxDir, '.codex', 'skills')),
  reviewed.out.split('\n').filter((l) => /reviewer home|workspace skills/.test(l)).join(' | ') || '(no line)');

// The directory is TRUSTED, so what sits in its project layer is what the lifted session
// may load. The lift erases the skills destination and nothing above it, so the claim
// that holds it safe is «nothing else writes here» — pinned by this check rather than
// left as a sentence in ADR-008. It fails the day the mechanism puts something else in.
check('PB-161.2: the trusted directory holds exactly what the lift put there',
  // The ROOT as well as `.codex/`: the root is the working directory of the trusted
  // session, and a file dropped beside `.codex` is as much «something else wrote here»
  // as one inside it. The lift writes only `.codex/…`, so both assertions are exact.
  readdirSync(reviewerSandboxDir).sort().join(',') === '.codex'
    && readdirSync(path.join(reviewerSandboxDir, '.codex')).sort().join(',') === '.gitignore,hooks.json,skills',
  `${readdirSync(reviewerSandboxDir).sort().join(',')} · ${readdirSync(path.join(reviewerSandboxDir, '.codex')).sort().join(',')}`);

const reviewDry = cli(['review', wt, '--task', TASK, '--harness', 'codex', '--dry-run'], { cwd: ws, env });
check('PB-161.2: the dry run names the same directory a real lift used, and the canon that goes into it',
  reviewDry.out.includes(`reviewer home: ${revThread.cwd}`)
    && reviewDry.out.includes('workspace skills: 1 from ')
    && reviewDry.out.includes(path.join(revThread.cwd, '.codex', 'skills'))
    && /dry-run: nothing written to disk/.test(reviewDry.out),
  reviewDry.out.slice(-900));

check('PB-161: review --dry-run names the reviewer home too — both dry-run paths print it',
  reviewDry.out.includes(`Codex home: ${codexDriver.participantCodexHome({ task: TASK, address: REVIEWER })}`)
    && /CODEX_HOME is dropped from the parent and set to this/.test(reviewDry.out),
  reviewDry.out.split('\n').filter((l) => /CODEX_HOME|Codex home/.test(l)).join(' | '));

// The owner's `~/.codex` after a worker, a reviewer and a stop: section by section,
// not by file hash. The marketplace snapshot rewrites that file on its own schedule
// without a turn on its own schedule, so a hash is not a gate — the sections the
// mechanism could have written are.
const ownerConfigAfter = readFileSync(path.join(callerCodexHome, 'config.toml'), 'utf8');
const sectionsOf = (text) => (text.match(/^\[[^\]]+\]/gm) ?? []);
check('PB-161: the owner config gained no [projects] and no section at all across the run',
  sectionsOf(ownerConfigAfter).join(',') === sectionsOf(ownerConfigBefore).join(',')
    && !/\[projects/.test(ownerConfigAfter)
    && !existsSync(path.join(callerCodexHome, 'sessions')),
  JSON.stringify({ before: sectionsOf(ownerConfigBefore), after: sectionsOf(ownerConfigAfter) }));

const stopped = await codexDriver.stop(ref);
check('step 6: stop kills the holder and drops the record',
  stopped.ok && stopped.stopped && !readSession(ref, env),
  JSON.stringify(stopped));

check('PB-161: stop takes the participant home with the record — the credentials copy does not outlive the session',
  !existsSync(participantHome) && existsSync(path.join(callerCodexHome, 'auth.json')),
  JSON.stringify({ participantHome, gone: !existsSync(participantHome) }));

const gone = codexDriver.inspect(ref);
check('step 6: inspect after stop — gone',
  gone.state === 'gone', JSON.stringify(gone));

const limitEnv = { ...env, [LIMIT_VAR]: '1' };
const limited = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'lim', '--harness', 'codex'], { cwd: ws, env: limitEnv });
check('step 7: account limit — refuse before thread/start',
  limited.status !== 0 && /limit/i.test(limited.out), limited.out.slice(-400));

const approvalEnv = { ...env, [APPROVAL_VAR]: '1' };
planParticipant(HARNESS, 'worker:apr', {
  turns: [{ do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'CODEX-APR' } }] }],
});
const approved = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'apr', '--harness', 'codex'], { cwd: ws, env: approvalEnv });
check('step 7: an approval request without a hang — the driver replied, the participant is up',
  approved.status === 0 && /worker worker:apr lifted/.test(approved.out), approved.out.slice(-500));

const apr = store.participantOf(store.readTask(home, TASK), 'worker:apr');
// The approvals are asked INSIDE the turn, and `spawn` returns at `turn/started`. The
// participant's own status is the first event that is provably after all of them.
const aprSent = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
  .find((m) => String(m.body ?? '').includes('CODEX-APR')) ?? null, { timeoutMs: 20000 });
const aprThread = await harnessThread(apr, env);
let aprLog = '';
try { aprLog = readFileSync(holderLogFile(apr?.sessionRef ?? '', env), 'utf8'); } catch { /* none */ }
check('PB-88.3: the live network escalation is declined and the same command without it is accepted',
  !!aprSent
  && JSON.stringify(aprThread?.networkApproval) === '{"decision":"decline"}'
  && JSON.stringify(aprThread?.plainApproval) === '{"decision":"accept"}'
  && /approval deny item\/commandExecution\/requestApproval network egress denied: https to packages\.invalid/.test(aprLog),
  `${JSON.stringify({ network: aprThread?.networkApproval, plain: aprThread?.plainApproval })} · ${aprLog.slice(-400)}`);
if (apr?.sessionRef) await codexDriver.stop(apr.sessionRef);
const rev = store.participantOf(store.readTask(home, TASK), REVIEWER);
if (rev?.sessionRef) await codexDriver.stop(rev.sessionRef);

planParticipant(HARNESS, 'worker:elicit', {
  turns: [{ do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'CODEX-ELICIT-W' } }] }],
});
const elicitW = cli(['spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'elicit', '--harness', 'codex'], { cwd: ws, env: elicitEnv });
const elicitWp = store.participantOf(store.readTask(home, TASK), 'worker:elicit');
const elicitWsent = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
  .find((m) => m.sender === store.addrDir('worker:elicit') && m.type === 'status'
    && String(m.body ?? '').includes('CODEX-ELICIT-W')) ?? null, { timeoutMs: 20000 });
const elicitWdone = await waitFor(() => {
  const r = readSession(elicitWp?.sessionRef ?? '', env);
  return r && r.busy === false && (r.turns ?? 0) >= 1 ? r : null;
}, { timeoutMs: 20000 });
let elicitWlog = '';
try { elicitWlog = readFileSync(holderLogFile(elicitWp?.sessionRef ?? '', env), 'utf8'); } catch { /* none */ }
const elicitWthread = await awaitThread(elicitWdone?.threadId);
check(': a worker elicitation is declined and the turn still completes',
  elicitW.status === 0 && !!elicitWdone
    && elicitWsent?.sender === store.addrDir('worker:elicit') && elicitWsent?.type === 'status'
    && elicitWthread?.elicitation?.action === 'decline'
    && /approval deny mcpServer\/elicitation\/request/.test(elicitWlog)
    && /server=probe-mcp/.test(elicitWlog) && /mode=form/.test(elicitWlog)
    && !elicitWlog.includes('SECRET-PROMPT-DO-NOT-LOG'),
  `${elicitW.status} · ${JSON.stringify(elicitWsent)} · action=${elicitWthread?.elicitation?.action} · log=${elicitWlog.slice(-400)}`);
if (elicitWp?.sessionRef) await codexDriver.stop(elicitWp.sessionRef);

planParticipant(HARNESS, 'worker:failturn', {
  turns: [{ do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'CODEX-FAIL' } }] }],
});
const failEnv = { ...env, [FAIL_TURN_VAR]: '1', [ORPHAN_VAR]: '1' };
const failW = cli(['spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'failturn', '--harness', 'codex'], { cwd: ws, env: failEnv });
const failWp = store.participantOf(store.readTask(home, TASK), 'worker:failturn');
const failDone = await waitFor(() => {
  const r = readSession(failWp?.sessionRef ?? '', env);
  return r && r.busy === false && (r.turns ?? 0) >= 1 ? r : null;
}, { timeoutMs: 20000 });
const failView = codexDriver.inspect(failWp?.sessionRef ?? '');
let failLog = '';
try { failLog = readFileSync(holderLogFile(failWp?.sessionRef ?? '', env), 'utf8'); } catch { /* none */ }
check(': a failed turn is recorded with its error and inspect names it',
  failW.status === 0 && failDone?.lastTurn?.status === 'failed'
    && failDone?.lastTurn?.error === 'invalid_request_error: probe'
    && failView.stall?.kind === 'failed'
    && /invalid_request_error: probe/.test(String(failView.stall.reason)),
  `${failW.status} · ${JSON.stringify(failDone?.lastTurn)} · ${JSON.stringify(failView.stall)}`);
check(': an unmatched JSON-RPC response is logged by id, not by payload',
  /orphan id=999001/.test(failLog) && !failLog.includes('unexpected'),
  failLog.slice(-500));
check(': the holder log names every notification method, including thread/status/changed and account/rateLimits/updated',
  /event thread\/status\/changed/.test(failLog)
    && /event account\/rateLimits\/updated/.test(failLog)
    && /event turn\/started/.test(failLog)
    && /event turn\/completed/.test(failLog),
  failLog);
if (failWp?.sessionRef) await codexDriver.stop(failWp.sessionRef);

planParticipant(HARNESS, 'worker:pend', {
  turns: [{ do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'CODEX-PEND' } }] }],
});
const pendEnv = { ...env, [ELICIT_HANG_VAR]: '1' };
const pendW = cli(['spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'pend', '--harness', 'codex'], { cwd: ws, env: pendEnv });
const pendWp = store.participantOf(store.readTask(home, TASK), 'worker:pend');
const pendRec = await waitFor(() => {
  const r = readSession(pendWp?.sessionRef ?? '', env);
  return r?.pendingRequest?.method ? r : null;
}, { timeoutMs: 20000 });
const pendView = codexDriver.inspect(pendWp?.sessionRef ?? '');
let pendLog = '';
try { pendLog = readFileSync(holderLogFile(pendWp?.sessionRef ?? '', env), 'utf8'); } catch { /* none */ }
check(': a holder reply without serverRequest/resolved is waiting, not yet a stall',
  pendW.status === 0 && pendRec?.pendingRequest?.method === 'mcpServer/elicitation/request'
    && pendRec?.pendingRequest?.server === 'probe-mcp'
    && pendRec?.lastEvent === 'holder-reply:mcpServer/elicitation/request'
    && pendView.stall === null
    && /waiting on mcpServer\/elicitation\/request/.test(String(pendView.note ?? ''))
    && /from probe-mcp/.test(String(pendView.note ?? ''))
    && !/the turn is running/.test(String(pendView.note ?? ''))
    && /approval deny mcpServer\/elicitation\/request/.test(pendLog)
    && !pendLog.includes('SECRET-PROMPT-DO-NOT-LOG'),
  `${pendW.status} · event=${pendRec?.lastEvent} · ${JSON.stringify(pendView)} · log=${pendLog.slice(-300)}`);
{
  const wasIdle = process.env.PROMPTOBUS_CODEX_IDLE_MS;
  process.env.PROMPTOBUS_CODEX_IDLE_MS = '50';
  await new Promise((r) => { setTimeout(r, 80); });
  const aged = codexDriver.inspect(pendWp?.sessionRef ?? '');
  check(': an unresolved server request past the idle budget is a pending-request stall',
    aged.stall?.kind === 'pending-request'
      && /waiting on mcpServer\/elicitation\/request/.test(String(aged.stall.reason))
      && aged.stall.kind !== 'watchdog',
    JSON.stringify(aged));
  if (wasIdle === undefined) delete process.env.PROMPTOBUS_CODEX_IDLE_MS;
  else process.env.PROMPTOBUS_CODEX_IDLE_MS = wasIdle;
}
if (pendWp?.sessionRef) await codexDriver.stop(pendWp.sessionRef);

planParticipant(HARNESS, 'worker:overlap', {
  turns: [{ do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'CODEX-OVER' } }] }],
});
const overlapEnv = { ...env, [ELICIT_OVERLAP_VAR]: '1' };
const overlapW = cli(['spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'overlap', '--harness', 'codex'], { cwd: ws, env: overlapEnv });
const overlapWp = store.participantOf(store.readTask(home, TASK), 'worker:overlap');
const overlapRec = await waitFor(() => {
  const r = readSession(overlapWp?.sessionRef ?? '', env);
  return r?.pendingRequest?.server === 'probe-b' ? r : null;
}, { timeoutMs: 20000 });
check(': resolving the first of two overlapping server requests leaves the other pending',
  overlapW.status === 0 && overlapRec?.pendingRequest?.server === 'probe-b'
    && overlapRec?.pendingRequest?.method === 'mcpServer/elicitation/request'
    && (overlapRec?.pendingRequests ?? []).length === 1
    && overlapRec.pendingRequests[0].server === 'probe-b',
  JSON.stringify({ pending: overlapRec?.pendingRequest, all: overlapRec?.pendingRequests }));
if (overlapWp?.sessionRef) await codexDriver.stop(overlapWp.sessionRef);

// The wake's socket wait has to outlast the turn budget it declares. `activate` sends
// `turn/start` with an inner `timeoutMs` of `turnWaitMs()`, and the outer `holderAsk`
// wait used to sit at its 30 s default: any `PROMPTOBUS_CODEX_TURN_MS` above that was
// silently truncated — the client hung up while the holder was still waiting on
// app-server, and the wake was reported failed although the turn may already have been
// queued. The stand's own 20 000 is below the default, which is why nothing caught it.
//
// The probe uses a SMALL budget rather than one above 30 s so the file does not spend
// half a minute proving arithmetic: a holder that answers `status` and then goes deaf
// makes the wait state its own length, and the length is the derived one, not the
// default. That is the whole property — the outer wait follows the budget.
const deafRef = 'deaf-holder-probe';
// In tmpdir directly, and short, like the holder's own socket: under the suite runner
// the sandbox sits several nested temp directories deep, and a unix path over the
// 104-byte sun_path limit fails `listen` with EINVAL — which passes standalone and
// aborts the file inside a run.
const deafSock = path.join(tmpdir(), `pb-deaf-${process.pid}.sock`);
const deafServer = net.createServer((conn) => {
  conn.setEncoding('utf8');
  conn.on('data', (chunk) => {
    // Only `status` is answered. `rpc` is read and left without a reply, which is the
    // holder still waiting on app-server.
    if (JSON.parse(chunk.trim()).op === 'status') conn.write(`${JSON.stringify({ result: { rateLimits: null } })}\n`);
  });
  conn.on('error', () => {});
});
await new Promise((r) => { deafServer.listen(deafSock, r); });
writeSession({
  ref: deafRef, task: TASK, address: 'worker:deaf', mcpPrefix: PREFIX, state: 'alive',
  threadId: 't-deaf', holderPid: process.pid, rpcSocket: deafSock,
}, process.env);
const wasTurnMs = process.env.PROMPTOBUS_CODEX_TURN_MS;
process.env.PROMPTOBUS_CODEX_TURN_MS = '1200';
const deafAt = Date.now();
const deaf = await codexDriver.activate({ ref: deafRef }, {
  kind: 'unread', task: TASK, address: 'worker:deaf', unread: 1,
  messages: [{ type: 'task', from: 'orchestrator', ts: 'now', body: 'deaf' }],
});
const deafTook = Date.now() - deafAt;
if (wasTurnMs === undefined) delete process.env.PROMPTOBUS_CODEX_TURN_MS;
else process.env.PROMPTOBUS_CODEX_TURN_MS = wasTurnMs;
check(': the wake socket waits the declared turn budget, not the 30 s socket default',
  deaf.ok === false && / 2200 ms/.test(deaf.error ?? '') && !/ 30000 ms/.test(deaf.error ?? '')
    && deafTook < 10_000,
  `${JSON.stringify(deaf)} · took ${deafTook} ms`);
deafServer.close();
rmSync(deafSock, { force: true });
dropSession(deafRef, process.env);

const deadRef = 'dead-probe';
writeSession({
  ref: deadRef, state: 'dead', threadId: 't-dead', holderPid: process.pid,
  error: 'app-server exited (9)',
}, process.env);
const deadView = codexDriver.inspect(deadRef);
check(': inspect at state=dead — stall, even if holderPid is alive',
  deadView.state === 'stale' && deadView.stall?.kind === 'stale' && /died|exited/.test(deadView.stall.reason),
  JSON.stringify(deadView));
dropSession(deadRef, process.env);

// Holder and app-server processes of THIS file, and nobody else's.
//
// `pgrep -f` reads the whole machine, and the patterns here used to be
// `codex-hold.js` and `app-server --stdio` — names every run on the machine
// carries. A worker run by tracks puts a second `npm test` on the same machine as
// a matter of course, and its holders then counted against this file's verdict.
// Reproduced deliberately 2026-09-05: two runs started 3.2 s apart, and the check
// below went red in BOTH — one saw `app 19472`, the other `hold 24233,25179 ·
// app 24653`, each of them the neighbour's pids (PB-14.4).
//
// The scope is the file's own sandbox, and each process carries it in its own
// argv: the holder is started as `codex-hold.js <session file>`, and that file
// lives under this stand's state home (`promptobus-codex-…/state`); the app-server
// is the stub binary, started from this file's own `bin` directory inside the file
// sandbox. So each pattern is a path this run alone owns, not a program name — a
// neighbouring run has other directories and cannot match either of them.
//
// The snapshot-and-subtract around the spawn (`beforeHold` / `beforeApp`) stays.
// It answers a different question — processes of THIS file that were already up
// before the refusal — and holders leaked by an earlier run of this same suite are
// exactly what it filters out.
const ere = (s) => s.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
const HOLD_PATTERN = `codex-hold\\.js ${ere(sessionsDir(env))}`;
// Built from the argv constant rather than retyped, and joined loosely: PB-170 put a
// global option BETWEEN the binary and the subcommand, and a literal pattern stopped
// matching — the leak check went green because it found nothing.
const APP_PATTERN = [ere(`${path.join(SB, 'bin')}/codex.stub.mjs`), ...PARTICIPANT_ARGV.map(ere)].join('.*');

function pgrep(pattern) {
  const r = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  return String(r.stdout ?? '').trim().split('\n').filter(Boolean);
}

// Sentinel over the two patterns above. Widening one back to a bare program name
// is a one-word edit, and its cost is a red verdict in someone else's run days
// later — so the sandbox path is required to be in both, here, where the edit
// happens.
check(': both process reads are scoped to this file\'s own directories, not to a program name',
  HOLD_PATTERN.includes(ere(stateHome)) && APP_PATTERN.includes(ere(SB)),
  `hold ${HOLD_PATTERN} · app ${APP_PATTERN}`);

// Proof that the pattern SEES a live app-server, not merely that it finds none. Without
// it «no leak» means «found nothing», which is what a literal pattern started meaning the
// moment a global option was built between the binary and the subcommand (PB-170).
{
  const bait = spawn(process.execPath, [path.join(SB, 'bin', 'codex.stub.mjs'), ...PARTICIPANT_ARGV], {
    stdio: ['pipe', 'ignore', 'ignore'],
    env,
  });
  const nap = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  let found = [];
  for (let i = 0; i < 60 && !found.length; i += 1) {
    found = pgrep(APP_PATTERN).filter((pid) => String(pid) === String(bait.pid));
    if (!found.length) nap();
  }
  check(': the app-server pattern finds a live stub — otherwise «nothing left» proves nothing',
    found.length === 1, `pid ${bait.pid} · ${APP_PATTERN} · found ${JSON.stringify(pgrep(APP_PATTERN))}`);
  try { process.kill(bait.pid, 'SIGKILL'); } catch { /* already gone */ }
  for (let i = 0; i < 60 && pgrep(APP_PATTERN).includes(String(bait.pid)); i += 1) nap();
}


planParticipant(HARNESS, 'worker:long-first', { turns: [{ do: [] }] });
const longEnv = { ...env, PROMPTOBUS_CODEX_READY_MS: '3000', [HANG_AFTER_START_VAR]: '1' };
const longFirst = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'long-first', '--harness', 'codex'], { cwd: ws, env: longEnv });
const longPart = store.participantOf(store.readTask(home, TASK), 'worker:long-first');
const longRec = readSession(longPart?.sessionRef ?? '', env);
check(': a first turn that started and never ends still confirms lift',
  longFirst.status === 0 && /worker worker:long-first lifted/.test(longFirst.out)
    && longRec?.state === 'alive' && longRec.busy === true && longRec.turns === 0
    && !!longRec.firstTurnStartedAt && !longRec.firstTurnEndedAt,
  `${longFirst.out.slice(-300)} · ${JSON.stringify(longRec)}`);
const longStatus = cli([ 'status', '--task', TASK], { cwd: ws, env: longEnv });
const longLine = longStatus.out.split('\n').find((l) => l.includes('worker:long-first')) ?? '';
check(': status calls the participant in its running first turn alive, not GONE',
  /is alive/.test(longLine) && !/not in the list|GONE/.test(longLine), longLine);
{
  const wasIdle = process.env.PROMPTOBUS_CODEX_IDLE_MS;
  process.env.PROMPTOBUS_CODEX_IDLE_MS = '50';
  await new Promise((r) => { setTimeout(r, 80); });
  const silentView = codexDriver.inspect(longPart?.sessionRef ?? '');
  const silentRec = readSession(longPart?.sessionRef ?? '', env);
  check(': a first turn that stays silent past the idle budget is a watchdog stall',
    silentView?.stall?.kind === 'watchdog'
      && silentRec?.lastEvent
      && !/the turn is running/.test(String(silentView?.note ?? '')),
    `${JSON.stringify(silentView)} · lastEvent=${silentRec?.lastEvent}`);
  if (wasIdle === undefined) delete process.env.PROMPTOBUS_CODEX_IDLE_MS;
  else process.env.PROMPTOBUS_CODEX_IDLE_MS = wasIdle;
}
const queuedOnFirst = await codexDriver.activate({ ref: longPart?.sessionRef }, {
  kind: 'unread', task: TASK, address: 'worker:long-first', unread: 1,
  messages: [{ type: 'review', from: 'orchestrator', ts: 'now', body: 'queued review' }],
});
check(': a review arriving during the running first turn is accepted into the next-turn queue',
  queuedOnFirst.ok === true, JSON.stringify(queuedOnFirst));
if (longPart?.sessionRef) await codexDriver.stop(longPart.sessionRef);

planParticipant(HARNESS, 'worker:hang', {
  turns: [{ do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'HANG' } }] }],
});
const beforeHold = pgrep(HOLD_PATTERN);
const beforeApp = pgrep(APP_PATTERN);
const hangEnv = { ...env, PROMPTOBUS_CODEX_READY_MS: '3000', [HANG_FIRST_VAR]: '1' };
const hung = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'hang', '--harness', 'codex'], { cwd: ws, env: hangEnv });
check(': a stream that never emits turn/started still refuses lift',
  hung.status !== 0 && /did not lift/.test(hung.out), hung.out.slice(-400));
const extraHold = pgrep(HOLD_PATTERN).filter((p) => !beforeHold.includes(p));
const extraApp = pgrep(APP_PATTERN).filter((p) => !beforeApp.includes(p));
check(': after a lift refusal there are no holder processes',
  extraHold.length === 0 && extraApp.length === 0,
  `hold ${extraHold.join(',')} · app ${extraApp.join(',')}`);

planParticipant(HARNESS, 'worker:die', {
  turns: [{ do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'DIE' } }] }],
});
const diedUp = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'die', '--harness', 'codex'], { cwd: ws, env });
check(': the participant for the app-server death probe is up',
  diedUp.status === 0, diedUp.out.slice(-300));
const diePart = store.participantOf(store.readTask(home, TASK), 'worker:die');
const dieRec = readSession(diePart?.sessionRef ?? '', env);
if (dieRec?.appPid) {
  try { process.kill(dieRec.appPid, 'SIGKILL'); } catch { /* none */ }
}
const died = await waitFor(() => {
  const r = readSession(diePart?.sessionRef ?? '', env);
  const view = r ? codexDriver.inspect(diePart.sessionRef) : null;
  return r?.state === 'dead' && !pidAlive(dieRec.holderPid) && view?.stall ? view : null;
}, { timeoutMs: 8000 });
check(': app-server death kills the holder and inspect sets a stall',
  !!died && died.stall?.kind === 'stale' && !pidAlive(dieRec?.holderPid),
  JSON.stringify({ died, holder: dieRec?.holderPid }));
if (diePart?.sessionRef) await codexDriver.stop(diePart.sessionRef);

planParticipant(HARNESS, 'worker:slow', {
  turns: [{ do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'SLOW' } }] }],
});
const slowEnv = { ...env, PROMPTOBUS_CODEX_READY_MS: '25000', [FIRST_DELAY_VAR]: '5000' };
const slow = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'slow', '--harness', 'codex'], { cwd: ws, env: slowEnv });
check(': waitReady waits for a delayed first turn and does not give up before the holder',
  slow.status === 0 && /worker worker:slow lifted/.test(slow.out), slow.out.slice(-500));
const slowPart = store.participantOf(store.readTask(home, TASK), 'worker:slow');
if (slowPart?.sessionRef) await codexDriver.stop(slowPart.sessionRef);

// Second step: what actually reached the app-server. Since PB-161 that is the
// `config.toml` of the participant home, which the stand PARSES the way the binary
// does — an unreadable file leaves the participant with no MCP set at all. Until this
// point the stand workspace canon was a single bus entry, so lift never saw a
// url-server; here the canon gets one and the participant is lifted with both
// transports at once.
writeHostConfig(ws, {
  tools: ['claude', 'codex'],
  mcp: {
    'probe-http': { type: 'http', url: 'http://probe.invalid/mcp', headers: { api_key: 'PROBE-TOKEN' } },
  },
});

planParticipant(HARNESS, 'worker:mcp', {
  turns: [{ do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'CODEX-MCP' } }] }],
});
const mcpUp = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'mcp', '--harness', 'codex'], { cwd: ws, env });
check(': a participant with a url-server in the set is lifted — the Codex config was accepted',
  mcpUp.status === 0 && /worker worker:mcp lifted/.test(mcpUp.out), mcpUp.out.slice(-600));

const mcpPart = store.participantOf(store.readTask(home, TASK), 'worker:mcp');
const mcpThread = await awaitThread(readSession(mcpPart?.sessionRef ?? '', env)?.threadId);
const started = (() => {
  try {
    return parseHomeToml(mcpThread?.codexHome?.config).mcp_servers ?? {};
  } catch (e) {
    return { __unreadable: e.message };
  }
})();
const busKey = codexMcpName('promptobus', PREFIX);
const httpKey = codexMcpName('probe-http', PREFIX);
check('PB-161: in the home config the url-server is in url form, the bus in stdio form',
  Object.keys(started[httpKey] ?? {}).sort().join(',') === 'http_headers,url'
  && started[httpKey].http_headers.api_key === 'PROBE-TOKEN'
  && Object.keys(started[busKey] ?? {}).sort().join(',') === 'args,command,env',
  JSON.stringify(started));
check('PB-161: in the home config there are no canonical names — the bus is under the prefix',
  !('promptobus' in started) && !('probe-http' in started)
  && busKey in started && httpKey in started,
  JSON.stringify(Object.keys(started)));
check(': without --effort thread/start does not invent a model_reasoning_effort',
  mcpThread && !('model_reasoning_effort' in (mcpThread.config ?? {})),
  JSON.stringify(mcpThread?.config));
if (mcpPart?.sessionRef) await codexDriver.stop(mcpPart.sessionRef);

function harnessThread(part, sessionEnv = env) {
  return awaitThread(readSession(part?.sessionRef ?? '', sessionEnv)?.threadId);
}

planParticipant(HARNESS, 'worker:effw', {
  turns: [{ do: [
    { write: { path: 'codex/effort.md', text: '# effort\n' } },
    { commit: { message: ': effort probe' } },
    { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'EFFORT-W' } },
  ] }],
});
planParticipant(HARNESS, 'reviewer:effw', {
  turns: [{ do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: 'EFFORT-R' } }] }],
});
const effortUp = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'effw', '--harness', 'codex', '--effort', 'xhigh'], { cwd: ws, env });
check(': worker --effort xhigh lifts',
  effortUp.status === 0 && /worker worker:effw lifted/.test(effortUp.out), effortUp.out.slice(-600));
const effortWorker = store.participantOf(store.readTask(home, TASK), 'worker:effw');
const effortWorkerThread = await harnessThread(effortWorker);
check(': worker thread/start carries config.model_reasoning_effort and turn/start still carries effort',
  effortWorkerThread?.config?.model_reasoning_effort === 'xhigh'
    && effortWorkerThread?.firstRpc?.method === 'turn/start'
    && effortWorkerThread?.firstRpc?.params?.effort === 'xhigh',
  JSON.stringify({
    config: effortWorkerThread?.config,
    firstRpc: effortWorkerThread?.firstRpc,
  }));

const effortWt = effortWorker?.metadata?.worktree ?? wt;
const effortWrote = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
  .find((m) => String(m.body ?? '').includes('EFFORT-W')) ?? null, { timeoutMs: 20000 });
check(': worker --effort xhigh committed a change the reviewer can see',
  !!effortWrote, JSON.stringify(effortWrote));
const effortReviewed = cli([ 'review', effortWt, '--task', TASK, '--harness', 'codex', '--effort', 'xhigh'],
  { cwd: ws, env });
check(': reviewer --effort xhigh lifts a fresh Codex reviewer',
  effortReviewed.status === 0 && /reviewer reviewer:effw started/.test(effortReviewed.out),
  effortReviewed.out.slice(-600));
const effortReviewer = store.participantOf(store.readTask(home, TASK), 'reviewer:effw');
const effortReviewerThread = await harnessThread(effortReviewer);
check(': reviewer thread/start carries the same model_reasoning_effort; first RPC is turn/start with effort',
  effortReviewerThread?.config?.model_reasoning_effort === 'xhigh'
    && effortReviewerThread?.firstRpc?.method === 'turn/start'
    && effortReviewerThread?.firstRpc?.params?.effort === 'xhigh',
  JSON.stringify({
    config: effortReviewerThread?.config,
    firstRpc: effortReviewerThread?.firstRpc,
  }));
if (effortWorker?.sessionRef) await codexDriver.stop(effortWorker.sessionRef);
if (effortReviewer?.sessionRef) await codexDriver.stop(effortReviewer.sessionRef);

// ── A holder dies with its session ────────────────────────────────────────────
//
// The holder is detached on purpose: `promptobus spawn` returns after the first
// turn and someone has to hold the app-server stdio. What it must NOT outlive is
// its own session. Every other reap hangs off a cleanup hook — `stop`, and the
// stand's `armCleanup` — and the one take-down that leaks reaches no hook at all:
// the runner takes a file down with SIGKILL both at the file timeout and on
// Ctrl-C. Reproduced on this file 2026-09-05: SIGKILL leaves the holder and its
// app-server alive, SIGTERM leaves nothing, a clean finish leaves nothing. A
// 2026-09-04 run left twelve such processes alive into the next day, each holding
// a session file in a directory that had since been removed.
//
// So the record is removed here with the participant alive — which is what
// removing the run directory does to it — and the holder is expected to reap
// itself and its app-server. The wait is generous against the watch interval; the
// pids come from the record, so nothing machine-wide is read.
planParticipant(HARNESS, 'worker:reap', {
  turns: [{ do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'CODEX-REAP' } }] }],
});
// Its own registry, and the whole of it is removed below — which is what removing a
// run directory does to a holder. A registry of its own so the removal reaches this
// participant and nothing else: the stand reaps on exit from the records it can
// read, and taking the shared registry out from under it would leave a neighbour
// unreaped. `stderr-loop` makes the app-server write on stderr every 200 ms, so the
// holder is logging inside the window the watch has yet to close.
const reapHome = path.join(SB, 'reap-state');
const reapEnv = { ...env, PROMPTOBUS_CODEX_HOME: reapHome, [PROBE_VAR]: 'stderr-loop' };
const reapUp = cli(['spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'reap', '--harness', 'codex'], { cwd: ws, env: reapEnv });
const reapRef = store.participantOf(store.readTask(home, TASK), 'worker:reap')?.sessionRef;
const reapRec = readSession(reapRef ?? '', reapEnv);
check(': the participant whose registry is about to go is up, with a holder and an app-server',
  reapUp.status === 0 && pidAlive(reapRec?.holderPid) && pidAlive(reapRec?.appPid),
  `${reapUp.status} · holder ${reapRec?.holderPid} app ${reapRec?.appPid}`);

rmSync(reapHome, { recursive: true, force: true });
const reaped = await waitFor(() => !pidAlive(reapRec?.holderPid) && !pidAlive(reapRec?.appPid),
  { timeoutMs: 20_000, stepMs: 500 });
check(': the registry is gone — the holder reaps itself and its app-server, with nobody to reap it',
  reaped, `holder ${reapRec?.holderPid} alive=${pidAlive(reapRec?.holderPid)} · `
  + `app ${reapRec?.appPid} alive=${pidAlive(reapRec?.appPid)}`);

// The holder logs its app-server's stderr, and the log used to create its own
// directory on the way in. Under a removed registry that write would rebuild the
// tree the holder is dying with — one directory per leaked run, forever.
check(': a log write under a removed registry does not rebuild the tree',
  !existsSync(reapHome), reapHome);

{
  const listedView = {
    state: 'stale',
    busy: false,
    stall: { kind: 'stale', reason: 'the holder did not name a thread within 133000 ms' },
    id: null,
    note: null,
  };
  const listedSnap = {};
  for (const p of store.readTask(home, TASK).participants ?? []) {
    const addr = p.metadata?.address;
    if (addr === WORKER) {
      listedSnap[addr] = listedView;
      listedSnap[store.addrDir(addr)] = listedView;
    }
  }
  const listedOut = capture(() => printStatus(ws, { task: TASK, sessions: listedSnap }));
  const listedLine = String(listedOut).split('\n').find((l) => l.includes(WORKER)) ?? String(listedOut);
  check(': promptobus status prints LISTED for a stale Codex inspect view',
    /is LISTED, but there is no process behind it/.test(listedLine)
      && /There will be no messages from it/.test(listedLine),
    listedLine.slice(-800));
}

// If the reap did not happen the checks above are already red; leaving the processes
// behind would redden the run gate too, and about the wrong thing.
for (const pid of [reapRec?.holderPid, reapRec?.appPid]) {
  if (pidAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone between the read and the kill */ }
  }
}

// ── The home does not outlive the task, even when the holder died first ───────────
//
// `done` stops only participants whose session is ALIVE. A Codex participant whose
// app-server died reports `stale`, which is `dead` to the walk — so its `stop` is
// never called, and before this the only thing that removed the home was `stop`. What
// was left behind was a directory holding a copy of the owner's credentials and the
// canonical MCP set's `http_headers` in the clear.
planParticipant(HARNESS, 'worker:orphan', {
  turns: [{ do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'CODEX-ORPHAN' } }] }],
});
const orphanUp = cli(['spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'orphan', '--harness', 'codex'], { cwd: ws, env });
const orphanPart = store.participantOf(store.readTask(home, TASK), 'worker:orphan');
const orphanRec = readSession(orphanPart?.sessionRef ?? '', env);
const orphanHomeLive = orphanRec?.codexHome ?? '';
// Killed, not stopped: this is the take-down that reaches no hook.
for (const pid of [orphanRec?.holderPid, orphanRec?.appPid]) {
  if (pidAlive(pid)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* no group */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}
const orphanDead = await waitFor(() => !pidAlive(orphanRec?.holderPid) && !pidAlive(orphanRec?.appPid),
  { timeoutMs: 20_000, stepMs: 250 });
check('PB-161: a participant whose holder was killed still has its home, and its record still names it',
  orphanUp.status === 0 && orphanDead && !!orphanHomeLive && existsSync(orphanHomeLive)
    && codexDriver.inspect(orphanPart?.sessionRef ?? '').state === 'stale',
  `${orphanHomeLive} · ${JSON.stringify(codexDriver.inspect(orphanPart?.sessionRef ?? ''))}`);

const doneOut = cli(['done', '--task', TASK], { cwd: ws, env });
check('PB-161: done takes the home of a participant whose session died without a stop',
  doneOut.status === 0 && !existsSync(orphanHomeLive),
  `${doneOut.status} · ${orphanHomeLive} · ${doneOut.out.slice(-400)}`);

restore();
