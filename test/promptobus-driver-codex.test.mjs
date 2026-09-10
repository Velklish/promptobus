// Codex driver — the third production bus driver. Run: npm test
//
// Subject — what Codex does differently from Claude Code and Cursor: an app-server
// process per participant, a rollout appears at turn/started, turn/start queues behind
// a turn in progress, the limit gate, denyTools as the sandbox, an empty
// LaunchPlan.files. The loop runs on the real mechanism. Only the `codex` binary is
// substituted ([harness-codex.mjs](harness-codex.mjs)).
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import Ajv from 'ajv';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { buildWorkspace, cli, store } from './scenario.mjs';
import {
  APPROVAL_VAR, CODEX_HOME_VAR, CURRENT_TIME_VAR, ELICIT_HANG_VAR, ELICIT_OVERLAP_VAR, ELICIT_VAR, FAIL_TURN_VAR, FIRST_DELAY_VAR,
  HANG_AFTER_START_VAR, HANG_FIRST_VAR, LIMIT_VAR, ORPHAN_VAR, PROBE_VAR,
  diagnoseTrace, installHarness, pidAlive, planParticipant, readTrace, traceFile,
} from './harness-codex.mjs';
import { waitFor } from './harness.mjs';
import { capture } from './console.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
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
check(': Codex diagnosis surfaces scenario errors before the later red verdict',
  diagnosis.startsWith(`scenario errors for ${DIAGNOSE_ADDRESS} (the cause is usually here):`)
    && diagnosis.includes('action-failed') && diagnosis.includes('later-red-verdict'),
  diagnosis);

const {
  codexDriver, PHRASES, PROVEN_CODEX_VERSION, DEFAULT_MODEL, REVIEWER_DENY,
} = await import(path.join(here, '..', 'lib', 'driver-codex.js'));
const {
  readSession, writeSession, dropSession, approvalReply, decideApproval, readyMs, preambleMs,
  TURN_STARTED_TIMEOUT_MS, holderLogFile, socketPath, startHolder, waitReady, reapHolder,
  codexMcpServers, codexMcpName, codexMcpPrefix, sessionsDir,
} = await import(path.join(here, '..', 'lib', 'codex-session.js'));
const { bindHarnessHomes } = await import(path.join(here, '..', 'lib', 'harness-home.js'));
const { status: printStatus, stallStands } = await import(path.join(here, '..', 'lib', 'status.js'));
const { liftDriver, REGISTRY } = await import(path.join(here, '..', 'lib', 'drivers.js'));
const { liftHarness, toolName } = await import(path.join(here, '..', 'lib', 'spawn.js'));
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

check(': Codex capabilities are declared, all nine',
  ['spawn', 'attach', 'activation', 'inspect', 'stop', 'denyTools', 'systemPrompt', 'sessionList', 'enter']
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

const unhandledApprovalMethods = [
  'item/tool/call',
  'account/chatgptAuthTokens/refresh',
  'attestation/generate',
];
const unhandledApprovalReplies = unhandledApprovalMethods.map((method) => ({
  method,
  reply: approvalReply(method, false),
}));
check(': measured server requests without approval rows return JSON-RPC method-not-found errors',
  unhandledApprovalReplies.every(({ method, reply }) => reply.__error?.code === -32601
    && reply.__error.message === `no handler for server request ${method}`),
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

check(': bus tool names are mcp__<override key>__name',
  PHRASES.tool('promptobus', 'promptobus_send', HOST) === `mcp__${codexMcpName('promptobus', PREFIX)}__promptobus_send`
  && PHRASES.tool('promptobus', 'promptobus_send', HOST) !== 'mcp__promptobus__promptobus_send',
  PHRASES.tool('promptobus', 'promptobus_send', HOST));

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
  toolName(codexDriver, 'promptobus', 'promptobus_send', HOST) === `mcp__${PREFIX}promptobus__promptobus_send`
  && toolName(codexDriver, 'promptobus', 'promptobus_mailbox', HOST) === PHRASES.tool('promptobus', 'promptobus_mailbox', HOST)
  && toolName(codexDriver, 'memory-hooks', 'search_facts', HOST) === `mcp__${PREFIX}memory-hooks__search_facts`,
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
      && toolName(codexDriver, 'promptobus', 'promptobus_send', HOST) === `mcp__${myKey}__promptobus_send`
      && toolName(codexDriver, 'promptobus', 'promptobus_send', OTHER) === `mcp__${theirKey}__promptobus_send`;
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
};
const workerPlan = codexDriver.prepare(ctx);
check(': argv is app-server --stdio, prompt separate; no files on disk',
  workerPlan.argv.length === 2 && workerPlan.argv[0] === 'app-server' && workerPlan.argv[1] === '--stdio'
  && workerPlan.prompt === 'PROMPT' && workerPlan.files.length === 0
  && workerPlan.settings.sandbox === 'workspace-write'
  && workerPlan.settings.approvalPolicy === 'on-request',
  JSON.stringify({ argv: workerPlan.argv.slice(0, 2), files: workerPlan.files.length, settings: workerPlan.settings }));

const reviewerPlan = codexDriver.prepare({ ...ctx, denyTools: REVIEWER_DENY, role: 'reviewer' });
check(': reviewer — sandbox read-only, same cwd, no files',
  reviewerPlan.settings.sandbox === 'read-only' && reviewerPlan.cwd === ctx.cwd
  && reviewerPlan.files.length === 0,
  JSON.stringify(reviewerPlan.settings));

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
    return text.includes(`mcp__${codexMcpName('promptobus', PREFIX)}__promptobus_mailbox`) && text.includes('BODY');
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
  CODEX_HOME: path.join(SB, 'caller-codex-home'),
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
check('step 1: the thread landed in the mechanism registry — thread id and holder are alive',
  !!record?.threadId && record.state === 'alive' && typeof record.holderPid === 'number',
  JSON.stringify({ threadId: record?.threadId, state: record?.state, holder: record?.holderPid }));

check(': the session record does not persist the caller environment',
  !!record && !('childEnv' in record), Object.keys(record ?? {}).sort().join(','));

const appThread = (() => {
  try {
    return JSON.parse(readFileSync(path.join(HARNESS, 'threads', `${record?.threadId ?? ''}.json`), 'utf8'));
  } catch {
    return null;
  }
})();
check(': the holder app-server drops CODEX_HOME but keeps PROMPTOBUS_CODEX_HOME',
  appThread?.appServerEnv?.CODEX_HOME === undefined
    && appThread?.appServerEnv?.PROMPTOBUS_CODEX_HOME === stateHome,
  JSON.stringify(appThread?.appServerEnv ?? null));

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
let legacyThread = null;
try {
  legacyThread = JSON.parse(readFileSync(path.join(HARNESS, 'threads', `${legacyReady.record?.threadId ?? ''}.json`), 'utf8'));
} catch { /* no thread */ }
check(': an old Codex record without a name uses the machine-name fallback',
  legacyReady.ok && legacyThread?.name === `promptobus:${TASK}:worker:legacy-name`,
  JSON.stringify({ ready: legacyReady, name: legacyThread?.name }));
await reapHolder(legacyRef, env);
dropSession(legacyRef, env);

const SECOND_TITLE = 'Second Codex named slice';
planParticipant(HARNESS, SECOND_WORKER, { turns: [{ do: [] }] });
const secondSpawned = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'cdx-second', '--title', SECOND_TITLE, '--harness', 'codex'], { cwd: ws, env });
const secondWp = store.participantOf(store.readTask(home, TASK), SECOND_WORKER);
const secondRef = secondWp?.sessionRef ?? '';
const secondRecord = readSession(secondRef, env);
let secondThread = null;
try {
  secondThread = JSON.parse(readFileSync(path.join(HARNESS, 'threads', `${secondRecord?.threadId ?? ''}.json`), 'utf8'));
} catch { /* no thread */ }
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
  !existsSync(path.join(wt, FORBIDDEN)),
  existsSync(path.join(wt, FORBIDDEN)) ? 'file exists' : 'no file');

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

const stopped = await codexDriver.stop(ref);
check('step 6: stop kills the holder and drops the record',
  stopped.ok && stopped.stopped && !readSession(ref, env),
  JSON.stringify(stopped));

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
let elicitWthread = null;
try {
  elicitWthread = JSON.parse(readFileSync(path.join(HARNESS, 'threads', `${elicitWdone?.threadId}.json`), 'utf8'));
} catch { /* none */ }
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
const APP_PATTERN = ere(`${path.join(SB, 'bin')}/codex.stub.mjs app-server --stdio`);

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

// Second step: what actually went into `thread/start`. The stand puts `params.config`
// into its thread record — that is what we read. Until this point the stand workspace
// canon was a single bus entry, so lift never saw a url-server; here the canon gets one
// and the participant is lifted with both transports at once.
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
const mcpThread = (() => {
  const id = readSession(mcpPart?.sessionRef ?? '', env)?.threadId;
  try {
    return JSON.parse(readFileSync(path.join(HARNESS, 'threads', `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
})();
const started = mcpThread?.config?.mcp_servers ?? {};
const busKey = codexMcpName('promptobus', PREFIX);
const httpKey = codexMcpName('probe-http', PREFIX);
check(': in thread/start the url-server went out in url form, the bus in stdio form',
  Object.keys(started[httpKey] ?? {}).sort().join(',') === 'http_headers,url'
  && started[httpKey].http_headers.api_key === 'PROBE-TOKEN'
  && Object.keys(started[busKey] ?? {}).sort().join(',') === 'args,command,env',
  JSON.stringify(started));
check(': in thread/start there are no canonical names — the bus went out under the prefix',
  !('promptobus' in started) && !('probe-http' in started)
  && busKey in started && httpKey in started,
  JSON.stringify(Object.keys(started)));
check(': without --effort thread/start does not invent a model_reasoning_effort',
  mcpThread && !('model_reasoning_effort' in (mcpThread.config ?? {})),
  JSON.stringify(mcpThread?.config));
if (mcpPart?.sessionRef) await codexDriver.stop(mcpPart.sessionRef);

function harnessThread(part, sessionEnv = env) {
  const id = readSession(part?.sessionRef ?? '', sessionEnv)?.threadId;
  try {
    return JSON.parse(readFileSync(path.join(HARNESS, 'threads', `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
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
const effortWorkerThread = harnessThread(effortWorker);
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
const effortReviewerThread = harnessThread(effortReviewer);
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

restore();
