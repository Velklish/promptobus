import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { mkdtempSync, realpathSync } from 'node:fs';
import { check } from './check.mjs';
import { capture } from './console.mjs';
import { stubCommand, writeHostConfig } from './sandbox.mjs';

function thrown(fn) {
  try {
    fn();
    return { threw: false, msg: '' };
  } catch (e) {
    return { threw: true, msg: e.message ?? String(e) };
  }
}

const SB = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'promptobus-approver-')));
const here = path.dirname(fileURLToPath(import.meta.url));
const NODE_BIN = path.join(here, '..', 'node_modules', '.bin');
const store = await import(path.join(here, '..', 'lib', 'store.js'));
const { planApprover, reviewerResultSent, approverLift } = await import(path.join(here, '..', 'lib', 'approver.js'));
const { ATTACHMENT_CONTRACT, GATE_LINE_COUNTS, GATE_LINE_VERIFICATION } = await import(path.join(here, '..', 'lib', 'handoff.js'));
const { review } = await import(path.join(here, '..', 'lib', 'review.js'));
const { helpText } = await import(path.join(here, '..', 'lib', 'cli.js'));
const { routingContext, models } = await import(path.join(here, '..', 'lib', 'models.js'));
const { PROMPTOBUS_SERVER } = await import(path.join(here, '..', 'lib', 'contract.js'));
const { hostOf } = await import(path.join(here, '..', 'lib', 'host.js'));

const WS = path.join(SB, 'ws');
mkdirSync(WS, { recursive: true });
writeHostConfig(WS, { tools: ['claude', 'cursor', 'codex'] });
writeFileSync(path.join(WS, 'AGENTS.md'), 'workspace\n');

const g = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};
g(WS, 'init', '-b', 'main');
const REPO = path.join(WS, 'repos', 'loads_search', 'cargos-api');
mkdirSync(REPO, { recursive: true });
g(REPO, 'init', '-b', 'main');
writeFileSync(path.join(REPO, 'AGENTS.md'), 'repo\n');
writeFileSync(path.join(REPO, 'a.txt'), 'v1\n');
g(REPO, 'add', '.');
g(REPO, 'commit', '-m', 'init', '-q');

const HOME = path.join(WS, '.promptobus');
process.env.PROMPTOBUS_HOME = HOME;
const host = hostOf(WS);
const TASK = 'pb2065-t20260913-120000';
store.createTask(HOME, {
  id: TASK,
  title: 'approver lift',
  status: 'active',
  adapter: { slug: 'pb2065', stamp: 't20260913-120000' },
  participants: [],
});

const worker = store.participantRecord('worker:cargos-api', {
  harness: 'claude',
  repo: 'repos/loads_search/cargos-api',
  repoAbs: REPO,
  branch: 'worktree-pb2065',
  worktree: REPO,
  baseSha: 'abc',
});
store.upsertParticipant(HOME, TASK, worker);
const assignedAt = '2026-09-13T12:00:00.000Z';
const reviewer = store.participantRecord('reviewer:cargos-api', {
  harness: 'claude',
  repo: 'repos/loads_search/cargos-api',
  repoAbs: REPO,
  started: assignedAt,
  reviewAssignedAt: assignedAt,
});
store.upsertParticipant(HOME, TASK, reviewer);

store.upsertParticipant(HOME, TASK, {
  ...worker,
  metadata: {
    ...worker.metadata,
    session: 'sess-worker',
    sessionId: '00000000-0000-4000-8000-000000000002',
  },
});

check(': reviewerResultSent is false before any reviewer result',
  reviewerResultSent(HOME, TASK, 'reviewer:cargos-api', reviewer) === false,
  String(reviewerResultSent(HOME, TASK, 'reviewer:cargos-api', reviewer)));

const noResult = thrown(() => planApprover(WS, { target: REPO, task: TASK, dryRun: true }));
check(': planApprover refuses without a reviewer result',
  noResult.threw && /type=result message from reviewer:cargos-api/.test(noResult.msg),
  noResult.msg);

store.sendMessage(HOME, TASK, {
  from: 'reviewer:cargos-api',
  to: store.ORCHESTRATOR,
  type: 'result',
  body: 'review done',
});

check(': reviewerResultSent is true after the reviewer result',
  reviewerResultSent(HOME, TASK, 'reviewer:cargos-api', reviewer) === true,
  String(reviewerResultSent(HOME, TASK, 'reviewer:cargos-api', reviewer)));

const { tallies } = await import(path.join(here, '..', 'lib', 'model-routing', 'telemetry.js'));
const firstResultAt = tallies(HOME, TASK).get('reviewer-cargos-api')?.lastResultAt;
const nextAssignment = new Date(Date.parse(firstResultAt) + 1).toISOString();
store.stampReviewAssignment(HOME, TASK, 'reviewer:cargos-api', null);
store.stampSnapshot(HOME, TASK, 'reviewer:cargos-api', {
  at: nextAssignment, head: null, clean: true, modifiedTracked: [],
});
check(': a prior-round result does not unlock the approver before the new assignment is sent',
  reviewerResultSent(HOME, TASK, 'reviewer:cargos-api', store.participantOf(store.readTask(HOME, TASK), 'reviewer:cargos-api')) === false,
  nextAssignment);
store.stampReviewAssignment(HOME, TASK, 'reviewer:cargos-api', nextAssignment);
check(': a prior-round result still does not unlock after the new assignment watermark',
  reviewerResultSent(HOME, TASK, 'reviewer:cargos-api', store.participantOf(store.readTask(HOME, TASK), 'reviewer:cargos-api')) === false,
  nextAssignment);
store.sendMessage(HOME, TASK, {
  from: 'reviewer:cargos-api',
  to: store.ORCHESTRATOR,
  type: 'result',
  body: 're-review done',
});
check(': a reviewer result at or after the assignment watermark unlocks the approver again',
  reviewerResultSent(HOME, TASK, 'reviewer:cargos-api', store.participantOf(store.readTask(HOME, TASK), 'reviewer:cargos-api')) === true,
  nextAssignment);

const HARNESS_TASK = 'pb235-approver-harness';
store.createTask(HOME, {
  id: HARNESS_TASK,
  title: 'approver harness stays',
  status: 'active',
  adapter: { slug: 'pb235', stamp: 't20260925-154900' },
  participants: [],
});
store.upsertParticipant(HOME, HARNESS_TASK, store.participantRecord('reviewer:cargos-api', {
  harness: 'claude',
  repo: 'repos/loads_search/cargos-api',
  repoAbs: REPO,
  started: assignedAt,
  reviewAssignedAt: assignedAt,
}));
store.sendMessage(HOME, HARNESS_TASK, {
  from: 'reviewer:cargos-api', to: store.ORCHESTRATOR, type: 'result', body: 'reviewed',
});
store.upsertParticipant(HOME, HARNESS_TASK, store.participantRecord('approver:cargos-api', {
  harness: 'claude',
  repo: 'repos/loads_search/cargos-api',
  repoAbs: REPO,
  started: assignedAt,
}));
const approverHarness = thrown(() => planApprover(WS, {
  target: REPO, task: HARNESS_TASK, dryRun: true, harness: 'cursor',
}));
check(': an approver harness change names the session state and no separate task',
  approverHarness.threw
  && /does not change an approver's harness/.test(approverHarness.msg)
  && /saw the session as unknown/.test(approverHarness.msg)
  && !/separate task/.test(approverHarness.msg)
  && !/--title/.test(approverHarness.msg),
  approverHarness.msg);

const OTHER_REPO = path.join(WS, 'repos', 'other', 'cargos-api');
mkdirSync(OTHER_REPO, { recursive: true });
g(OTHER_REPO, 'init', '-b', 'main');
writeFileSync(path.join(OTHER_REPO, 'AGENTS.md'), 'other\n');
g(OTHER_REPO, 'add', '.');
g(OTHER_REPO, 'commit', '-m', 'init', '-q');
const wrongRepoPlan = thrown(() => planApprover(WS, { target: OTHER_REPO, task: TASK, dryRun: true }));
check(': same slug at a different repository refuses before lift',
  wrongRepoPlan.threw
  && /recorded at/.test(wrongRepoPlan.msg)
  && wrongRepoPlan.msg.includes(REPO),
  wrongRepoPlan.msg);

const WRONG_REUSE_TASK = 'pb2065-wrong-reuse';
store.createTask(HOME, {
  id: WRONG_REUSE_TASK,
  title: 'approver wrong-repo reuse',
  status: 'active',
  adapter: { slug: 'pb2065', stamp: 't20260913-120004' },
  participants: [],
});
store.upsertParticipant(HOME, WRONG_REUSE_TASK, store.participantRecord('reviewer:cargos-api', {
  harness: 'claude',
  repo: 'repos/other/cargos-api',
  repoAbs: OTHER_REPO,
  started: assignedAt,
  reviewAssignedAt: assignedAt,
}));
store.sendMessage(HOME, WRONG_REUSE_TASK, {
  from: 'reviewer:cargos-api',
  to: store.ORCHESTRATOR,
  type: 'result',
  body: 'review done at other repo',
});
store.upsertParticipant(HOME, WRONG_REUSE_TASK, store.participantRecord('approver:cargos-api', {
  harness: 'claude',
  repo: 'repos/loads_search/cargos-api',
  repoAbs: REPO,
  session: 'sess-wrong-reuse',
  started: assignedAt,
}));
const wrongReuse = thrown(() => planApprover(WS, { target: OTHER_REPO, task: WRONG_REUSE_TASK, dryRun: true }));
check(': an approver recorded at another repoAbs is not reused for a different subject',
  wrongReuse.threw && /another subject cannot be reused/.test(wrongReuse.msg),
  wrongReuse.msg);
const { PromptobusError, ERROR_CODES } = await import(path.join(here, '..', 'dist', 'index.js'));
check(': harness-refused is a declared PromptobusError code',
  ERROR_CODES.includes('harness-refused'),
  ERROR_CODES.join(','));
const modelsCursorOnly = path.join(SB, 'models-cursor-only');
mkdirSync(modelsCursorOnly, { recursive: true });
writeHostConfig(modelsCursorOnly, { tools: ['cursor'] });
writeFileSync(path.join(modelsCursorOnly, 'AGENTS.md'), 'workspace\n');
let modelsJson = '';
const modelsCode = await models(hostOf(modelsCursorOnly), {
  role: 'approver',
  json: true,
  output: { write: (chunk) => { modelsJson += chunk; } },
});
const modelsDecision = JSON.parse(modelsJson.trim());
check(': models --role approver on a cursor-only workspace exits with chosen null, not candidates-empty',
  modelsCode === 0 && modelsDecision.chosen === null,
  JSON.stringify({ code: modelsCode, chosen: modelsDecision.chosen }));
const harnessRefused = await (async () => {
  try {
    await routingContext(modelsCursorOnly, {
      strategy: 'balanced', role: 'approver', harness: 'cursor', dryRun: true,
    });
    return { threw: false, code: null };
  } catch (e) {
    return { threw: true, code: e.code ?? null, msg: e.message ?? String(e) };
  }
})();
check(': routed approver --harness cursor raises harness-refused, not harness-unknown',
  harnessRefused.threw && harnessRefused.code === 'harness-refused',
  harnessRefused.msg ?? String(harnessRefused.code));

const CLI = path.join(here, '..', 'bin', 'promptobus.js');

const plan = planApprover(WS, { target: REPO, task: TASK, dryRun: true });
check(': planApprover names the approver address and clone root cwd',
  plan.address === 'approver:cargos-api'
  && plan.cloneRoot === REPO,
  JSON.stringify({ address: plan.address, cloneRoot: plan.cloneRoot }));

const claudePlan = planApprover(WS, { target: REPO, task: TASK, dryRun: true, harness: 'claude' });
check(': approver on Claude keeps edit and shell — package deny list is empty',
  (!claudePlan.launch.settings?.permissions?.deny?.length),
  JSON.stringify(claudePlan.launch.settings));
check(': approver on Claude is lifted with the worktree guard off — it writes to the clone root it sits in',
  JSON.parse(claudePlan.launch.files.find((f) => f.path === claudePlan.settingsPath).text)
    .worktree?.bgIsolation === 'none',
  JSON.stringify(claudePlan.launch.settings));
// With the guard off the harness drops its own "Never push … force-push" line, so the preamble says it.
check(': the approver preamble forbids push and force-push and leaves the push to the orchestrator',
  claudePlan.prompt.includes('You never push, never force-push, and never rewrite commits that are already on the remote: the orchestrator pushes.'),
  claudePlan.prompt.slice(0, 700));

check(': the approver runs the gates, so its preamble puts them under the machine lease at its own address',
  claudePlan.prompt.includes(`promptobus lease --as approver:cargos-api --task ${TASK} -- <command…>`),
  claudePlan.prompt.slice(claudePlan.prompt.indexOf('## Machine lease'), claudePlan.prompt.indexOf('## Machine lease') + 300));

check(': the approver preamble quotes the attachment contract',
  claudePlan.prompt.includes(ATTACHMENT_CONTRACT),
  claudePlan.prompt.slice(claudePlan.prompt.indexOf('Hand-off'), claudePlan.prompt.indexOf('Hand-off') + 400));

const ASSIGN = path.join(SB, 'approver-assign.md');
writeFileSync(ASSIGN, 'Accept the piece. Do not push.\n');
const briefed = planApprover(WS, { target: REPO, task: TASK, dryRun: true, brief: ASSIGN });
check(': --brief is the approver assignment in the lift prompt',
  briefed.prompt.includes('## Assignment') && briefed.prompt.includes('Accept the piece. Do not push.'),
  briefed.prompt.slice(briefed.prompt.indexOf('## Assignment'), briefed.prompt.indexOf('## Assignment') + 160));
const missingBrief = thrown(() => planApprover(WS, {
  target: REPO, task: TASK, dryRun: true, brief: path.join(SB, 'no-assign.md'),
}));
check(': --brief names a file that has to exist',
  missingBrief.threw && /no assignment file/.test(missingBrief.msg),
  missingBrief.msg);
let briefWithoutApprover = '';
try {
  await review(WS, { target: REPO, task: TASK, brief: ASSIGN });
} catch (e) {
  briefWithoutApprover = e.message ?? String(e);
}
check(': --brief without --approver is refused because a reviewer subject is the diff',
  /refused without --approver/.test(briefWithoutApprover)
  && /reviewer's subject is the diff/.test(briefWithoutApprover),
  briefWithoutApprover);
check(': review help offers --brief as the approver assignment',
  helpText(host).includes('[--approver] [--brief <file>]')
  && /without --approver it is refused/.test(helpText(host)),
  helpText(host).split('\n').find((line) => line.includes('--brief')) ?? '');
const emptyBrief = thrown(() => planApprover(WS, { target: REPO, task: TASK, dryRun: true, brief: '' }));
check(': an empty --brief is refused the way spawn refuses it',
  emptyBrief.threw && /needed --brief/.test(emptyBrief.msg),
  emptyBrief.msg);
let emptyWithoutApprover = '';
try {
  await review(WS, { target: REPO, task: TASK, brief: '' });
} catch (e) {
  emptyWithoutApprover = e.message ?? String(e);
}
check(': an empty --brief without --approver is refused',
  /refused without --approver/.test(emptyWithoutApprover)
  && /reviewer's subject is the diff/.test(emptyWithoutApprover),
  emptyWithoutApprover);
const briefNames = (home, taskId) => (existsSync(store.filesDir(home, taskId))
  ? readdirSync(store.filesDir(home, taskId)).filter((name) => name.startsWith('brief-'))
  : []);
await capture(() => approverLift(WS, { target: REPO, task: TASK, dryRun: true, brief: ASSIGN }));
check(': a dry-run approver lift keeps no brief',
  briefNames(HOME, TASK).length === 0, briefNames(HOME, TASK).join(', '));

const NO_REVIEWER = 'pb250-no-reviewer';
store.createTask(HOME, {
  id: NO_REVIEWER, title: 'no reviewer', status: 'active', participants: [],
});
const noReviewer = thrown(() => planApprover(WS, {
  target: REPO, task: NO_REVIEWER, dryRun: true, brief: ASSIGN,
}));
check(': no such reviewer names the passed path and that the task has no reviewer',
  noReviewer.threw
  && noReviewer.msg.includes(REPO)
  && /this task records no reviewer/.test(noReviewer.msg)
  && /piece a reviewer already read/.test(noReviewer.msg),
  noReviewer.msg);
const refusedBriefs = existsSync(store.filesDir(HOME, NO_REVIEWER))
  ? readdirSync(store.filesDir(HOME, NO_REVIEWER)).filter((name) => name.startsWith('brief-'))
  : [];
check(': a refused approver lift keeps no brief',
  refusedBriefs.length === 0, refusedBriefs.join(', '));

const cursorPlan = planApprover(WS, { target: REPO, task: TASK, dryRun: true, harness: 'cursor' });
check(': approver on Cursor refuses before launch — project config is read only from the selected workspace',
  typeof cursorPlan.refusal === 'string'
  && cursorPlan.refusal.includes('harness "cursor" cannot lift an approver')
  && cursorPlan.refusal.includes('`.cursor/`')
  && cursorPlan.refusal.includes('clone root'),
  String(cursorPlan.refusal));
const cursorCliRefusal = spawnSync(process.execPath, [
  CLI, 'promptobus', 'review', REPO, '--task', TASK, '--approver', '--harness', 'cursor', '--dry-run',
], {
  encoding: 'utf8',
  cwd: WS,
  env: { ...process.env, PROMPTOBUS_HOME: HOME, PROMPTOBUS_WARDEN: 'off' },
});
check(': CLI review --approver --harness cursor refuses and does not register a participant',
  cursorCliRefusal.status !== 0
  && /cannot lift an approver/.test(`${cursorCliRefusal.stderr}${cursorCliRefusal.stdout}`)
  && !store.participantOf(store.readTask(HOME, TASK), 'approver:cargos-api'),
  `${cursorCliRefusal.status} ${cursorCliRefusal.stderr} ${cursorCliRefusal.stdout}`);
const cursorBrief = spawnSync(process.execPath, [
  CLI, 'promptobus', 'review', REPO, '--task', TASK, '--approver', '--harness', 'cursor', '--brief', ASSIGN,
], {
  encoding: 'utf8',
  cwd: WS,
  env: { ...process.env, PROMPTOBUS_HOME: HOME, PROMPTOBUS_WARDEN: 'off' },
});
check(': --harness cursor with --brief keeps no brief',
  cursorBrief.status !== 0
  && /cannot lift an approver/.test(`${cursorBrief.stderr}${cursorBrief.stdout}`)
  && briefNames(HOME, TASK).length === 0,
  `${cursorBrief.status} ${cursorBrief.stderr} names=${briefNames(HOME, TASK).join(',')}`);

const { eligibleHarnessesForRole } = await import(path.join(here, '..', 'lib', 'drivers.js'));
check(': approver routing preflight uses only harnesses with approverLift',
  eligibleHarnessesForRole(hostOf(WS), 'approver').every((h) => h !== 'cursor' && h !== 'codex')
  && eligibleHarnessesForRole(hostOf(WS), 'approver').join(',') === 'claude',
  eligibleHarnessesForRole(hostOf(WS), 'approver').join(','));
const routedCtx = await routingContext(WS, { strategy: 'balanced', role: 'approver', dryRun: true });
const routedDecision = routedCtx.decide([]);
check(': routed approver lift never chooses cursor or codex before preflight',
  routedDecision.chosen.harness === 'claude',
  routedDecision.chosen.harness);

const cursorOnlyWs = path.join(SB, 'cursor-only');
mkdirSync(cursorOnlyWs, { recursive: true });
writeHostConfig(cursorOnlyWs, { tools: ['cursor'] });
writeFileSync(path.join(cursorOnlyWs, 'AGENTS.md'), 'workspace\n');
const cursorOnlyRefusal = await (async () => {
  try {
    await routingContext(cursorOnlyWs, {
      strategy: 'balanced', role: 'approver', harness: 'cursor', dryRun: true,
    });
    return { threw: false, msg: '' };
  } catch (e) {
    return { threw: true, msg: e.message ?? String(e) };
  }
})();
check(': routed approver --harness cursor keeps the harness refusal, not a missing-declaration error',
  cursorOnlyRefusal.threw
  && /cannot lift an approver/.test(cursorOnlyRefusal.msg)
  && !/declares no such harness/.test(cursorOnlyRefusal.msg),
  cursorOnlyRefusal.msg);
check(': routed approver catalog offers no cursor tuples',
  !routedDecision.candidates.some((c) => c.harness === 'cursor' && !c.excluded?.code),
  routedDecision.candidates.filter((c) => c.harness === 'cursor').map((c) => c.excluded?.code).join(','));
check(': routed approver catalog offers no codex tuples',
  !routedDecision.candidates.some((c) => c.harness === 'codex' && !c.excluded?.code),
  routedDecision.candidates.filter((c) => c.harness === 'codex').map((c) => c.excluded?.code).join(','));
check(': approver hand-off may cite another participant landed artifact by name',
  plan.prompt.includes('**cite** a landed artifact filename sent by another participant')
  && plan.prompt.includes('worker\'s gate record in the **Gate** line')
  && plan.prompt.includes('binds only to your own send'),
  plan.prompt.slice(plan.prompt.indexOf('Hand-off form'), plan.prompt.indexOf('Hand-off form') + 900));
check('PB-232: the approver preamble counts gates by command, and names each verification run after the aggregate',
  plan.prompt.includes(GATE_LINE_COUNTS) && plan.prompt.includes(GATE_LINE_VERIFICATION),
  plan.prompt.slice(plan.prompt.indexOf('Hand-off form')));

const codexPlan = planApprover(WS, { target: REPO, task: TASK, dryRun: true, harness: 'codex' });
check(': approver on Codex refuses before launch — launch files must not land in the shared clone root',
  typeof codexPlan.refusal === 'string'
  && codexPlan.refusal.includes('harness "codex" cannot lift an approver')
  && codexPlan.refusal.includes('clone root'),
  String(codexPlan.refusal));
const codexCliRefusal = spawnSync(process.execPath, [
  CLI, 'promptobus', 'review', REPO, '--task', TASK, '--approver', '--harness', 'codex', '--dry-run',
], {
  encoding: 'utf8',
  cwd: WS,
  env: { ...process.env, PROMPTOBUS_HOME: HOME, PROMPTOBUS_WARDEN: 'off' },
});
check(': CLI review --approver --harness codex refuses and does not register a participant',
  codexCliRefusal.status !== 0
  && /cannot lift an approver/.test(`${codexCliRefusal.stderr}${codexCliRefusal.stdout}`)
  && !store.participantOf(store.readTask(HOME, TASK), 'approver:cargos-api'),
  `${codexCliRefusal.status} ${codexCliRefusal.stderr} ${codexCliRefusal.stdout}`);
const codexOnlyWs = path.join(SB, 'codex-only');
mkdirSync(codexOnlyWs, { recursive: true });
writeHostConfig(codexOnlyWs, { tools: ['codex'] });
writeFileSync(path.join(codexOnlyWs, 'AGENTS.md'), 'workspace\n');
const codexOnlyRefusal = await (async () => {
  try {
    await routingContext(codexOnlyWs, {
      strategy: 'balanced', role: 'approver', harness: 'codex', dryRun: true,
    });
    return { threw: false, msg: '' };
  } catch (e) {
    return { threw: true, msg: e.message ?? String(e) };
  }
})();
check(': routed approver --harness codex keeps the harness refusal, not a missing-declaration error',
  codexOnlyRefusal.threw
  && /cannot lift an approver/.test(codexOnlyRefusal.msg)
  && !/declares no such harness/.test(codexOnlyRefusal.msg),
  codexOnlyRefusal.msg);

const REUSE_TASK = 'pb2065-reuse';
store.createTask(HOME, {
  id: REUSE_TASK,
  title: 'approver reuse',
  status: 'active',
  adapter: { slug: 'pb2065', stamp: 't20260913-120003' },
  participants: [],
});
store.upsertParticipant(HOME, REUSE_TASK, store.participantRecord('reviewer:cargos-api', {
  harness: 'claude',
  repo: 'repos/loads_search/cargos-api',
  repoAbs: REPO,
  started: assignedAt,
  reviewAssignedAt: assignedAt,
}));
store.sendMessage(HOME, REUSE_TASK, {
  from: 'reviewer:cargos-api',
  to: store.ORCHESTRATOR,
  type: 'result',
  body: 'review done',
});
const BIN = path.join(SB, 'bin');
mkdirSync(BIN, { recursive: true });
const BG_RAISED = path.join(SB, 'bg-raised.txt');
stubCommand(BIN, 'claude', `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('stub 1.0.0\\n'); process.exit(0); }
if (args[0] === '--bg') {
  const name = args[args.indexOf('--name') + 1] ?? '';
  writeFileSync(${JSON.stringify(BG_RAISED)}, name);
  process.stdout.write('backgrounded · cafe34 · ' + name + '\\n');
  process.exit(0);
}
if (args[0] === 'agents' && existsSync(${JSON.stringify(BG_RAISED)})) {
  const raised = readFileSync(${JSON.stringify(BG_RAISED)}, 'utf8');
  process.stdout.write(JSON.stringify([{
    id: 'sess-reuse',
    name: raised,
    status: 'running',
    sessionId: '00000000-0000-4000-8000-000000000010',
  }]));
  process.exit(0);
}
if (args[0] === 'agents') {
  process.stdout.write('[]');
  process.exit(0);
}
process.exit(0);`);
writeFileSync(BG_RAISED, 'Approver: reuse');
const PATH0 = process.env.PATH ?? '';
process.env.PATH = `${BIN}${path.delimiter}${NODE_BIN}${path.delimiter}${PATH0}`;
store.upsertParticipant(HOME, REUSE_TASK, store.participantRecord('approver:cargos-api', {
  harness: 'claude',
  repo: 'repos/loads_search/cargos-api',
  repoAbs: REPO,
  name: 'Approver: reuse',
  session: 'sess-reuse',
  sessionId: '00000000-0000-4000-8000-000000000010',
}));
const aliveAgain = planApprover(WS, {
  target: REPO, task: REUSE_TASK, dryRun: true, harness: 'claude',
});
check(': repeat approver lift reuses an alive session',
  aliveAgain.reuse === true && aliveAgain.sessionState === 'alive',
  JSON.stringify({ reuse: aliveAgain.reuse, state: aliveAgain.sessionState }));
const reuseBrief = await capture(() => approverLift(WS, {
  target: REPO, task: REUSE_TASK, harness: 'claude', brief: ASSIGN,
}));
check(': a reused approver is told --brief is not delivered and keeps no copy',
  /--brief is not delivered to approver:cargos-api/.test(reuseBrief)
  && /already on the bus/.test(reuseBrief)
  && briefNames(HOME, REUSE_TASK).length === 0,
  `${reuseBrief} names=${briefNames(HOME, REUSE_TASK).join(',')}`);

store.upsertParticipant(HOME, REUSE_TASK, store.participantRecord('approver:cargos-api', {
  harness: 'claude',
  repo: 'repos/loads_search/cargos-api',
  repoAbs: REPO,
  name: 'Approver: pending',
  pending: true,
}));
const pendingAgain = planApprover(WS, {
  target: REPO, task: REUSE_TASK, dryRun: true, harness: 'claude',
});
check(': repeat approver lift treats a pending unlaunched record as not reusable',
  pendingAgain.unlaunched === true && pendingAgain.reuse === false,
  JSON.stringify({ unlaunched: pendingAgain.unlaunched, reuse: pendingAgain.reuse }));

store.upsertParticipant(HOME, REUSE_TASK, store.participantRecord('approver:cargos-api', {
  harness: 'claude',
  repo: 'repos/loads_search/cargos-api',
  repoAbs: REPO,
  name: 'Approver: dead',
  session: 'gone',
  sessionId: '00000000-0000-4000-8000-000000000011',
}));
const deadAgain = planApprover(WS, {
  target: REPO, task: REUSE_TASK, dryRun: true, harness: 'claude',
});
check(': repeat approver lift does not reuse a dead session',
  deadAgain.sessionState === 'dead' && deadAgain.reuse === false,
  JSON.stringify({ state: deadAgain.sessionState, reuse: deadAgain.reuse }));

const OWNERLESS = 'pb2065-ownerless';
store.createTask(HOME, {
  id: OWNERLESS,
  title: 'ownerless approver',
  status: 'active',
  adapter: { slug: 'pb2065', stamp: 't20260913-120001' },
  participants: [],
});
store.upsertParticipant(HOME, OWNERLESS, store.participantRecord('reviewer:cargos-api', {
  harness: 'claude',
  repo: 'repos/loads_search/cargos-api',
  repoAbs: REPO,
  started: assignedAt,
  reviewAssignedAt: assignedAt,
}));
store.sendMessage(HOME, OWNERLESS, {
  from: 'reviewer:cargos-api',
  to: store.ORCHESTRATOR,
  type: 'result',
  body: 'review done',
});
const ownerlessPlan = planApprover(WS, { target: REPO, task: OWNERLESS, dryRun: true });
check(': ownerless approver prompt routes through the orchestrator, not worker null',
  !ownerlessPlan.prompt.includes('null')
  && ownerlessPlan.prompt.includes('route participant traffic through the orchestrator'),
  ownerlessPlan.prompt);

function mcpSend(role, sendArgs, { home = HOME, task = TASK, cwd = WS, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'mcp'], {
      cwd,
      env: {
        ...process.env,
        PROMPTOBUS_HOME: home,
        PROMPTOBUS_ROLE: role,
        PROMPTOBUS_TASK: task,
        PROMPTOBUS_WARDEN: 'off',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`mcp timeout for ${role}`));
    }, 15000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.stdin.write([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'promptobus_send', arguments: sendArgs },
      }),
    ].join('\n') + '\n');
    child.stdin.end();
  });
}

const LIVE = path.join(SB, 'live');
mkdirSync(LIVE, { recursive: true });
const LIVE_WS = path.join(LIVE, 'ws');
mkdirSync(LIVE_WS, { recursive: true });
writeHostConfig(LIVE_WS, { tools: ['claude', 'cursor', 'codex'] });
writeFileSync(path.join(LIVE_WS, 'AGENTS.md'), 'workspace\n');
g(LIVE_WS, 'init', '-b', 'main');
const LIVE_REPO = path.join(LIVE_WS, 'repos', 'external', 'promptobus');
mkdirSync(LIVE_REPO, { recursive: true });
g(LIVE_REPO, 'init', '-b', 'main');
writeFileSync(path.join(LIVE_REPO, 'AGENTS.md'), 'repo\n');
g(LIVE_REPO, 'add', '.');
g(LIVE_REPO, 'commit', '-m', 'init', '-q');
const LIVE_WT = path.join(LIVE_REPO, '.claude', 'worktrees', 'a2a-warden');
g(LIVE_REPO, 'worktree', 'add', '-q', '-b', 'worktree-a2a-warden', LIVE_WT, 'main');
writeFileSync(path.join(LIVE_WT, 'warden.txt'), 'work\n');
g(LIVE_WT, 'add', '.');
g(LIVE_WT, 'commit', '-m', 'work', '-q');
const LIVE_HOME = path.join(LIVE_WS, '.promptobus');
const LIVE_TASK = 'pb2065-live-cli';
store.createTask(LIVE_HOME, {
  id: LIVE_TASK,
  title: 'live approver cli',
  status: 'active',
  adapter: { slug: 'pb2065', stamp: 't20260913-120002' },
  participants: [],
});
store.upsertParticipant(LIVE_HOME, LIVE_TASK, store.participantRecord('worker:warden', {
  harness: 'claude',
  repo: 'repos/external/promptobus',
  repoAbs: LIVE_WT,
  branch: 'worktree-a2a-warden',
  worktree: LIVE_WT,
}));
store.upsertParticipant(LIVE_HOME, LIVE_TASK, store.participantRecord('reviewer:warden', {
  harness: 'claude',
  repo: 'repos/external/promptobus',
  repoAbs: LIVE_WT,
  started: assignedAt,
  reviewAssignedAt: assignedAt,
}));
store.sendMessage(LIVE_HOME, LIVE_TASK, {
  from: 'reviewer:warden',
  to: store.ORCHESTRATOR,
  type: 'result',
  body: 'review done',
});
store.upsertParticipant(LIVE_HOME, LIVE_TASK, store.participantRecord('worker:warden', {
  harness: 'claude',
  repo: 'repos/external/promptobus',
  repoAbs: LIVE_WT,
  branch: 'worktree-a2a-warden',
  worktree: LIVE_WT,
  sessionId: '00000000-0000-4000-8000-000000000099',
}));

const LIVE_BIN = path.join(LIVE, 'bin');
mkdirSync(LIVE_BIN, { recursive: true });
const LIVE_BG = path.join(LIVE, 'bg-raised.txt');
stubCommand(LIVE_BIN, 'claude', `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('stub 1.0.0\\n'); process.exit(0); }
if (args[0] === '--bg') {
  const name = args[args.indexOf('--name') + 1] ?? '';
  writeFileSync(${JSON.stringify(LIVE_BG)}, name);
  process.stdout.write('backgrounded · cafe34 · ' + name + '\\n');
  process.exit(0);
}
if (args[0] === 'agents' && existsSync(${JSON.stringify(LIVE_BG)})) {
  const raised = readFileSync(${JSON.stringify(LIVE_BG)}, 'utf8');
  process.stdout.write(JSON.stringify([{
    id: 'sess-live',
    name: raised,
    status: 'running',
    sessionId: '00000000-0000-4000-8000-000000000001',
  }]));
  process.exit(0);
}
process.exit(0);`);
const LIVE_NODE_BIN = path.join(here, '..', 'node_modules', '.bin');
const liveLift = spawnSync(process.execPath, [
  CLI, 'promptobus', 'review', LIVE_WT, '--task', LIVE_TASK, '--approver',
], {
  encoding: 'utf8',
  cwd: LIVE_WS,
  env: {
    ...process.env,
    PROMPTOBUS_HOME: LIVE_HOME,
    PROMPTOBUS_WARDEN: 'off',
    PATH: `${LIVE_BIN}${path.delimiter}${LIVE_NODE_BIN}${path.delimiter}${process.env.PATH ?? ''}`,
  },
});
check(': CLI review --approver registers approver:warden from the worktree command',
  liveLift.status === 0
  && liveLift.stdout.includes('approver:warden')
  && !!store.participantOf(store.readTask(LIVE_HOME, LIVE_TASK), 'approver:warden'),
  `${liveLift.status} ${liveLift.stderr} ${liveLift.stdout}`);
check(': worktree approver lift names the clone root cwd, not undefined',
  liveLift.stdout.includes(`approver cwd: ${LIVE_REPO}`)
  && !liveLift.stdout.includes('approver cwd: undefined'),
  liveLift.stdout);

const liveApprover = store.participantOf(store.readTask(LIVE_HOME, LIVE_TASK), 'approver:warden');
check(': approver record keeps the worktree review target for relift, not the clone root',
  liveApprover?.metadata?.repoAbs === LIVE_WT,
  JSON.stringify({ repoAbs: liveApprover?.metadata?.repoAbs, wt: LIVE_WT, clone: LIVE_REPO }));

const wrongSubject = thrown(() => planApprover(LIVE_WS, { target: LIVE_REPO, task: LIVE_TASK, dryRun: true }));
check(': a clone-root approver lift names the path it got and the reviewer subject that would work',
  wrongSubject.threw
  && wrongSubject.msg.includes(LIVE_REPO)
  && wrongSubject.msg.includes(`reviewer:warden lifted from ${LIVE_WT}`)
  && /reviewer:promptobus/.test(wrongSubject.msg)
  && /piece a reviewer already read/.test(wrongSubject.msg),
  wrongSubject.msg);

const BRIEF_TASK = 'pb250-brief';
const BRIEF_FILE = path.join(LIVE, 'assign.md');
writeFileSync(BRIEF_FILE, 'Accept the warden piece.\n');
store.createTask(LIVE_HOME, {
  id: BRIEF_TASK,
  title: 'approver brief',
  status: 'active',
  adapter: { slug: 'pb250', stamp: 't20260925-183000' },
  participants: [],
});
store.upsertParticipant(LIVE_HOME, BRIEF_TASK, store.participantRecord('worker:warden', {
  harness: 'claude',
  repo: 'repos/external/promptobus',
  repoAbs: LIVE_WT,
  branch: 'worktree-a2a-warden',
  worktree: LIVE_WT,
}));
store.upsertParticipant(LIVE_HOME, BRIEF_TASK, store.participantRecord('reviewer:warden', {
  harness: 'claude',
  repo: 'repos/external/promptobus',
  repoAbs: LIVE_WT,
  started: assignedAt,
  reviewAssignedAt: assignedAt,
}));
store.sendMessage(LIVE_HOME, BRIEF_TASK, {
  from: 'reviewer:warden', to: store.ORCHESTRATOR, type: 'result', body: 'review done',
});
const workerBrief = path.join(store.filesDir(LIVE_HOME, BRIEF_TASK), 'brief-warden.md');
mkdirSync(store.filesDir(LIVE_HOME, BRIEF_TASK), { recursive: true });
writeFileSync(workerBrief, 'the worker assignment\n');
const briefLift = spawnSync(process.execPath, [
  CLI, 'promptobus', 'review', LIVE_WT, '--task', BRIEF_TASK, '--approver', '--brief', BRIEF_FILE,
], {
  encoding: 'utf8',
  cwd: LIVE_WS,
  env: {
    ...process.env,
    PROMPTOBUS_HOME: LIVE_HOME,
    PROMPTOBUS_WARDEN: 'off',
    PATH: `${LIVE_BIN}${path.delimiter}${LIVE_NODE_BIN}${path.delimiter}${process.env.PATH ?? ''}`,
  },
});
const keptBrief = path.join(store.filesDir(LIVE_HOME, BRIEF_TASK), 'brief-approver-warden.md');
check(': an approver lifted with --brief keeps that assignment in the task files',
  briefLift.status === 0 && existsSync(keptBrief) && readFileSync(keptBrief, 'utf8').includes('Accept the warden piece.')
  && readFileSync(workerBrief, 'utf8') === 'the worker assignment\n',
  `${briefLift.status} ${briefLift.stderr} ${briefLift.stdout}`);
const refusedSubject = spawnSync(process.execPath, [
  CLI, 'promptobus', 'review', LIVE_REPO, '--task', BRIEF_TASK, '--approver', '--brief', BRIEF_FILE,
], {
  encoding: 'utf8',
  cwd: LIVE_WS,
  env: {
    ...process.env,
    PROMPTOBUS_HOME: LIVE_HOME,
    PROMPTOBUS_WARDEN: 'off',
    PATH: `${LIVE_BIN}${path.delimiter}${LIVE_NODE_BIN}${path.delimiter}${process.env.PATH ?? ''}`,
  },
});
const refusedNames = readdirSync(store.filesDir(LIVE_HOME, BRIEF_TASK)).filter((name) => name.startsWith('brief-')).sort();
check(': a refused approver lift after a kept brief does not write another copy',
  refusedSubject.status !== 0
  && refusedSubject.stderr.includes(LIVE_REPO)
  && refusedSubject.stderr.includes(LIVE_WT)
  && refusedNames.join(',') === 'brief-approver-warden.md,brief-warden.md'
  && readFileSync(workerBrief, 'utf8') === 'the worker assignment\n',
  `${refusedSubject.status} ${refusedSubject.stderr} names=${refusedNames.join(',')}`);
const FAIL_TASK = 'pb250-brief-fail';
store.createTask(LIVE_HOME, {
  id: FAIL_TASK,
  title: 'approver brief fails to start',
  status: 'active',
  adapter: { slug: 'pb250', stamp: 't20260925-183000' },
  participants: [],
});
store.upsertParticipant(LIVE_HOME, FAIL_TASK, store.participantRecord('worker:warden', {
  harness: 'claude',
  repo: 'repos/external/promptobus',
  repoAbs: LIVE_WT,
  branch: 'worktree-a2a-warden',
  worktree: LIVE_WT,
}));
store.upsertParticipant(LIVE_HOME, FAIL_TASK, store.participantRecord('reviewer:warden', {
  harness: 'claude',
  repo: 'repos/external/promptobus',
  repoAbs: LIVE_WT,
  started: assignedAt,
  reviewAssignedAt: assignedAt,
}));
store.sendMessage(LIVE_HOME, FAIL_TASK, {
  from: 'reviewer:warden', to: store.ORCHESTRATOR, type: 'result', body: 'review done',
});
const failWorkerBrief = path.join(store.filesDir(LIVE_HOME, FAIL_TASK), 'brief-warden.md');
mkdirSync(store.filesDir(LIVE_HOME, FAIL_TASK), { recursive: true });
writeFileSync(failWorkerBrief, 'the worker assignment\n');
const FAIL_BIN = path.join(LIVE, 'fail-bin');
mkdirSync(FAIL_BIN, { recursive: true });
stubCommand(FAIL_BIN, 'claude', `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('stub 1.0.0\\n'); process.exit(0); }
if (args[0] === '--bg') { process.stderr.write('launch refused\\n'); process.exit(1); }
if (args[0] === 'agents' && existsSync(${JSON.stringify(LIVE_BG)})) {
  const raised = readFileSync(${JSON.stringify(LIVE_BG)}, 'utf8');
  process.stdout.write(JSON.stringify([{ id: 'sess-live', name: raised, status: 'running', sessionId: '00000000-0000-4000-8000-000000000001' }]));
  process.exit(0);
}
process.exit(0);`);
const failedLift = spawnSync(process.execPath, [
  CLI, 'promptobus', 'review', LIVE_WT, '--task', FAIL_TASK, '--approver', '--brief', BRIEF_FILE,
], {
  encoding: 'utf8',
  cwd: LIVE_WS,
  env: {
    ...process.env,
    PROMPTOBUS_HOME: LIVE_HOME,
    PROMPTOBUS_WARDEN: 'off',
    PATH: `${FAIL_BIN}${path.delimiter}${LIVE_NODE_BIN}${path.delimiter}${process.env.PATH ?? ''}`,
  },
});
const failedNames = readdirSync(store.filesDir(LIVE_HOME, FAIL_TASK)).filter((name) => name.startsWith('brief-'));
check(': a launch that fails keeps no approver brief',
  failedLift.status !== 0
  && failedNames.join(',') === 'brief-warden.md'
  && readFileSync(failWorkerBrief, 'utf8') === 'the worker assignment\n'
  && !existsSync(path.join(store.filesDir(LIVE_HOME, FAIL_TASK), 'brief-approver-warden.md')),
  `${failedLift.status} ${failedLift.stderr} names=${failedNames.join(',')}`);

const { stallLine } = await import(path.join(here, '..', 'lib', 'status.js'));
const reliftLine = stallLine({
  kind: 'gone',
  address: 'approver:warden',
  repoAbs: liveApprover.metadata.repoAbs,
  harness: 'claude',
  ref: liveApprover.metadata.name,
  reason: 'not in the list',
}, LIVE_TASK, hostOf(LIVE_WS));
check(': status relift names the worktree path and approver:warden, not approver:promptobus',
  reliftLine.includes('approver:warden')
  && reliftLine.includes('--approver')
  && reliftLine.includes(`"${LIVE_WT}"`)
  && !reliftLine.includes(`"${LIVE_REPO}"`)
  && !reliftLine.includes('approver:promptobus'),
  reliftLine);

const mcpOrchestrator = await mcpSend('approver:warden', { to: 'orchestrator', type: 'status', body: 'approver live via mcp' }, {
  home: LIVE_HOME,
  task: LIVE_TASK,
  cwd: LIVE_WS,
  env: { CLAUDE_CODE_SESSION_ID: '00000000-0000-4000-8000-000000000001' },
});
check(': live approver MCP mail reaches the orchestrator with a bus message id',
  mcpOrchestrator.status === 0
  && /sent status/.test(`${mcpOrchestrator.stdout}${mcpOrchestrator.stderr}`)
  && /· id /.test(`${mcpOrchestrator.stdout}${mcpOrchestrator.stderr}`),
  `${mcpOrchestrator.status} ${mcpOrchestrator.stderr} ${mcpOrchestrator.stdout}`);

const mcpToWorker = await mcpSend('approver:warden', { to: 'worker:warden', type: 'question', body: 'hand-off' }, {
  home: LIVE_HOME,
  task: LIVE_TASK,
  cwd: LIVE_WS,
  env: { CLAUDE_CODE_SESSION_ID: '00000000-0000-4000-8000-000000000001' },
});
check(': live approver MCP mail reaches the worker with a bus message id',
  mcpToWorker.status === 0
  && /sent question/.test(`${mcpToWorker.stdout}${mcpToWorker.stderr}`)
  && /· id /.test(`${mcpToWorker.stdout}${mcpToWorker.stderr}`)
  && store.countInbox(LIVE_HOME, LIVE_TASK, 'worker:warden') === 1,
  `${mcpToWorker.status} ${mcpToWorker.stderr} ${mcpToWorker.stdout}`);

const mcpWorkerReply = await mcpSend('worker:warden', { to: 'approver:warden', type: 'answer', body: 'here' }, {
  home: LIVE_HOME,
  task: LIVE_TASK,
  cwd: LIVE_WS,
  env: { CLAUDE_CODE_SESSION_ID: '00000000-0000-4000-8000-000000000099' },
});
check(': live worker MCP mail reaches the approver',
  mcpWorkerReply.status === 0 && /sent answer/.test(`${mcpWorkerReply.stdout}${mcpWorkerReply.stderr}`)
  && store.countInbox(LIVE_HOME, LIVE_TASK, 'approver:warden') === 1,
  `${mcpWorkerReply.status} ${mcpWorkerReply.stderr} ${mcpWorkerReply.stdout}`);

const CLI_PATH0 = process.env.PATH ?? '';
const BRIEF = path.join(SB, 'brief.md');
writeFileSync(BRIEF, 'brief\n');
const spawnReserved = spawnSync(process.execPath, [
  CLI, 'promptobus', 'spawn', '--repo', 'repos/loads_search/cargos-api', '--brief', BRIEF,
  '--task', TASK, '--worker', 'approver-x', '--dry-run',
], {
  encoding: 'utf8',
  cwd: WS,
  env: { ...process.env, PROMPTOBUS_HOME: HOME, PATH: `${NODE_BIN}${path.delimiter}${CLI_PATH0}` },
});
check(': spawn --worker approver- still refuses with the reserved prefix words',
  spawnReserved.status !== 0
  && spawnReserved.stderr.includes('prefix is taken by the approver'),
  `status=${spawnReserved.status} ${spawnReserved.stderr}`);

// A lift that resolves the binary itself, on a build below the ultracode floor.
// Passing `tool` with a version would stay green if the read were deleted.
const ULTRA_TASK = 'pb2065-ultra';
store.createTask(HOME, {
  id: ULTRA_TASK,
  title: 'approver ultracode',
  status: 'active',
  adapter: { slug: 'pb2065', stamp: 't20260913-170100' },
  participants: [],
});
store.upsertParticipant(HOME, ULTRA_TASK, store.participantRecord('reviewer:cargos-api', {
  harness: 'claude',
  repo: 'repos/loads_search/cargos-api',
  repoAbs: REPO,
  started: assignedAt,
  reviewAssignedAt: assignedAt,
}));
store.sendMessage(HOME, ULTRA_TASK, {
  from: 'reviewer:cargos-api',
  to: store.ORCHESTRATOR,
  type: 'result',
  body: 'review done',
});
const ULTRA_BIN = path.join(SB, 'ultra-bin');
stubCommand(ULTRA_BIN, 'claude', `const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('2.0.0 (Claude Code)\\n'); process.exit(0); }
process.stdout.write('[]');
process.exit(0);`);
const approverUrl = pathToFileURL(path.join(here, '..', 'lib', 'approver.js')).href;
const ultraApprover = spawnSync(process.execPath, ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(approverUrl)});\n`
  + `await m.approverLift(${JSON.stringify(WS)}, ${JSON.stringify({
    target: REPO, task: ULTRA_TASK, effort: 'ultracode',
  })});`,
], {
  encoding: 'utf8',
  cwd: WS,
  env: { ...process.env, PROMPTOBUS_HOME: HOME, PATH: `${ULTRA_BIN}${path.delimiter}${PATH0}` },
});
const ultraApproverText = `${ultraApprover.stdout}${ultraApprover.stderr}`;
check(': an approver with no tool seam still reads the binary and refuses ultracode',
  ultraApprover.status === 1 && ultraApproverText.includes('2.0.0') && /DEFAULT effort/.test(ultraApproverText),
  `status=${ultraApprover.status} ${ultraApproverText}`);
