import { APPROVER, ORCHESTRATOR, REVIEWER, WORKER } from '../../dist/registry.js';
import { GATE_LINE_COUNTS, GATE_LINE_VERIFICATION, RESULT_BODY_MAX } from '../handoff.js';
import {
  renderApproverInstructions, renderOrchestratorInstructions, renderReporterInstructions,
  renderReviewerInstructions, renderReviewProcedure, renderTeamleadInstructions, renderWorkerInstructions,
} from './roles.js';

export const BB_ROLE_SKILLS = Object.freeze({
  [WORKER]: 'promptobus-worker', [REVIEWER]: 'promptobus-reviewer', [APPROVER]: 'promptobus-approver',
  teamlead: 'promptobus-teamlead', reporter: 'promptobus-reporter', [ORCHESTRATOR]: 'promptobus-orchestrator',
});

const tools = Object.freeze(Object.fromEntries([
  'promptobus_send', 'promptobus_mailbox', 'promptobus_task', 'promptobus_digest', 'promptobus_status', 'promptobus_ask',
].map(name => [name, `[${name} binding from initial context]`])));
const common = {
  tools,
  memory: 'Use only the memory reads explicitly supplied by the runtime; do not publish facts from this role.',
  contacts: 'Read the authenticated task contacts before sending. No contact is created by reading this skill.',
  lease: 'Take a lease for a named resource conflict, publication or controlled measurement only through the operation supplied in the task context.',
  communication: 'the authenticated native BB tools named in the initial context',
  repositorySkills: 'Read the repository rules and skills named in the initial context.',
  dependencies: 'Use the supplied repository preparation instructions; do not assume a package manager.',
  wait: 'End the turn when waiting for mail. The declared BB activation route continues this same participant; do not poll or start turns to wait.',
};
const rules = ['[rule paths supplied in initial context]'];
const brief = '[assignment supplied in initial context]';
const commandGrant = `## Command grants

The same canonical task carries the authenticated actor, immutable authorization token, exact command scope, all required preconditions and supplied owner confirmation. The task is the confirmation; no later confirmation message is required. Owner confirmation and grants must be complete owner inputs, never inferred from assignment prose. Current authority comes from the owner-published control reference, not a launch-time file or inline snapshot. Missing or mismatched authorization blocks the operation that needs it. A released grant is terminal. Delayed confirmation or resume must not revive it; remaining work needs a fresh complete grant.`;
const executionResources = `## Execution resources

Independent source reads, setup, builds, no-model checks, focused tests, full suites and gates may run concurrently within the approved actor/card limit after distinct worktree, output, temporary-directory and writable-cache ownership is established. Take an exclusive lease only for an explicitly named conflicting path or service, same-clone publication, or a declared controlled performance/load measurement. The generic machine lease remains opt-in; it is not required for ordinary full suites or gates.

Treat \`maxActiveIncludingOwner\` as owner-declared actor metadata; actual BB concurrency policy remains separate. Use the owner-supplied bounded execution route for mechanical calls. These instructions do not establish a universal BB scheduler or interception of arbitrary native commands.

Permission waiting consumes no generic compute capacity. After a permission or resource wait, immediately before execution, recheck the exact current phase, token, scope, resources and STOP through the supplied current-control route. A confirmed or UNKNOWN writer retains its named resource until an actual terminal receipt proves it drained. Administrative parking, control revocation or an ended grant alone does not drain a writer.`;
const participantCommands = `Immediately before every mechanical call, read current control and STOP through the supplied owner-validated route and verify that the active slot's authenticated actor and authorization token match your current granted scope. An earlier Proceed or mailbox assignment is insufficient when current ownership has changed. Refuse a call outside that exact scope or under STOP, an ended grant or mismatched ownership.

For each owned build, test or mutating command phase, use the checked launcher supplied by the built generation: \`node <generation>/commands/command-runner.js --admission /owned/input.json --output /owned/stem --by ACTOR -- EXEC ARGS\`. Its admission input contains \`{ binding, commandId }\` and must select the exact current \`grant.execution.commands\` entry using supplied bindings and task-owned paths. Invoke it through ordinary provider execution and its normal approval flow; \`--by\` records receipt attribution and does not authenticate the caller. If the immutable command grant is missing, report the blocked operation to the owner; do not use the legacy recorder or a native-command fallback for these admitted calls.

Obtain fresh normal-account routing before each substantial suite invocation and apply the supplied quota policy. Cached quota is not a fresh routing receipt. Follow the initial grant's preconditions until a changed precondition has acknowledged application; a later message cannot retroactively change a running call's guard.

Release the exact completed scope with your authenticated actor and token, confirming zero pending and running calls and that no further calls from that grant remain. A runner-only release does not authorize later closure lint. Keep actual commands, exits, start/end receipts and their limitations; do not repeat unchanged mandatory suites solely because Hold arrived late without demonstrated interference or an incomplete required receipt.`;
const orchestratorCommands = `Persist the authenticated actor, immutable authorization token, exact command scope and all preconditions with \`bb promptobus control publish\` before \`task create\` or any participant dispatch can activate the participant. The explicit initializer needs complete supplied owner confirmation and grants; it must not invent them from assignment prose. Publish that complete grant and owner confirmation in the same canonical task. Record the returned task id for audit only; do not create a second execution barrier. Later owner updates use the current revision for compare-and-swap; a stale update refuses. Keep tokens immutable, move them only from active to ended and never revive an ended token.

Before a source-and-evidence reviewer starts, land every original raw, direct receipt, inventory, gate and handover part. Supply the complete bounded manifest with actual artifact IDs in the initial immutable assignment. Missing or delayed parts block launch without a diagnostic reviewer model; a late steer or unread mailbox is not the sole evidence path. Preserve producer and relayer attribution. A repaired evidence bundle needs a fresh bounded phase when the old grant ended.

Keep the actor slot until the exact all-calls release is acknowledged, or an official task-owned stop/pause is verified. An all-calls release identifies actor, token and completed scope and confirms pending and running calls are zero. Validate it against current control before acknowledging it and reallocating the actor slot. Named resources held by confirmed or UNKNOWN writers still require an actual terminal receipt before reuse. A runner-only release does not authorize later closure lint.

Sent Hold and SDK send responses of sent or queued are not acknowledgments that the participant read or applied them. Revoke current control through its persisted owner identity even when ordinary owner admission is stopped, closed, orphaned or in error. When an active grant must be revoked or its remaining scope is uncertain, use the official task-owned participant stop/pause route and verify fresh actual status, paused delivery and zero pending/running calls before reassigning the actor slot. Control revocation prevents later Promptobus admissions; it does not prove physical Stop or completion of an already running call. Preserve worktrees, raw receipts and unrelated participants; do not reparent or change bindings to recover authorization.

A changed precondition during a running batch takes effect only after acknowledged application. If continuation under the old conditions is unacceptable, use verified official stop/pause. Preserve measured commands and receipt limitations; never claim cached quota was fresh or infer call overlap from commit timestamps. Do not repeat unchanged mandatory suites solely for late Hold delivery without demonstrated interference or an incomplete required receipt.`;
const evidenceProfile = 'BB evidence travels as UTF-8 opaque `.txt` attachments. Preserve the authenticated participant id from the runtime binding in `by`, including independent ids; do not invent a colon-address alias or substitute the orchestrator for the actor. Attachment acceptance is not schema validation: BB does not apply the native gate/handover schemas to these payloads and does not certify their truth.';
const verdictNames = 'Keep complete raw output authoritative. Preserve exact test names, order and repeated occurrences; keep parentheses, punctuation, Unicode and internal spacing. Remove only the terminal numeric duration from a supported verdict line, including when the name itself contains duration-like parentheses. Keep lint and other gate status separate from test names. Compare inventory counts and multiplicities with the complete raw test scope; missing raw, unsupported formats and approximate inventories are explicitly incomplete, never invented PASS or skip entries. The checkout-only reference helper `scripts/bb-evidence-verdict-names.mjs` delegates to `extractNodeTestVerdictNames(raw)` exported by `promptobus/bb-host`, for one flat passing Node spec scope with one complete footer. It does not support nested or concatenated scopes, custom verdict printers, other reporters, failed or skipped output; it cannot certify gates. See `docs/reference/04-protocol.md#bb-evidence-attachments`; manual lossless opaque UTF-8 evidence with retained raw output remains valid. Unsupported complete scope certification is not invented.';
const artifactDelivery = `Send an attachment through ${tools.promptobus_send} with type=artifact and artifact: { filename, content }, where content is UTF-8 text and filename ends in .txt. Read the landed filename from the immediate reply to your own send and cite that returned name in the result; do not infer it from a local path or another participant's reply.`;
const gateEvidence = `Attach gate evidence before the result, with one entry per command actually run: the exact command, \`exit\`, printed counts, full HEAD sha in \`tree\`, tracked-file \`dirty\` state, timestamp and authenticated actor in \`by\`. Keep raw output, including failing assertions. A command not run has no fabricated execution entry; name it and its reason as not run. ${GATE_LINE_COUNTS} ${GATE_LINE_VERIFICATION}`;
const evidenceOverflow = `The whole result body is at most ${RESULT_BODY_MAX} characters. Attach overflow before the result and cite its landed filename. Keep gate and handover evidence in separate .txt attachments, with their landed names in the **Gate** line. A filename and successful attachment do not prove a check ran; only an authorized re-run on the same sha can verify the claim.`;
const reviewerReport = `Every send body is at most ${RESULT_BODY_MAX} characters, including its header, findings, part marker and release. Do not truncate or drop findings. You produce no artifact of your own and need no filesystem writes. You may cite another participant's landed evidence filename in **Gate**.

If the complete report fits, send one terminal type=result with the four-line header, findings or 'No findings' and what was checked, then \`Review <grant-token> complete 0/0\` and the release below. Otherwise plan N parts before sending. Send all findings and overflow detail losslessly as consecutive type=status messages to the orchestrator through the supplied promptobus_send binding. Each body starts with \`Review <grant-token> part i/N\`, followed by a newline and the exact payload. Use the active grant token from initial context, fixed N and i=1 through N in send order. Measure the whole body against the cap; split even one long finding at a Unicode character boundary when needed. Rejoin payloads without inserted separators to recover the original report detail. Parts are not results or releases and need no acknowledgement.

After every part has a successful send reply, send one terminal type=result. It opens with the four-line header above, gives total findings by severity in **Done**, then \`Review <grant-token> complete N/N\`. Include a single all-calls release after all report content: authenticated actor, active token, exact completed review scope, pending=0 and running=0. No earlier part carries a release. After that release make no tool calls and end the turn. A failed or uncertain send leaves the report incomplete: do not claim completion, silently resend an uncertain part or release the grant as completed; tell the orchestrator the delivery gap through the supplied bounded channel.

The orchestrator checks completeness as described in the BB protocol; the bus does not assemble or validate report parts. Keep the final header concise and put overflow details in the numbered payloads.`;
const receiveReviewerReport = `A BB reviewer may send numbered status parts before its result. Read every full part body from the canonical mailbox/history, including acknowledged status messages; previews and the terminal header alone are insufficient. Match the authenticated reviewer sender and active grant token, fixed total N and consecutive send order 1 through N, then the terminal \`Review <grant-token> complete N/N\` marker (0/0 for a report wholly in the result). Rejoin payloads without inserted separators and check the findings against the severity totals in **Done**. Require a single terminal result after all parts and a single all-calls release with the authenticated actor, active token, completed scope, pending=0 and running=0. Reject missing, duplicated, reordered or mixed-token parts, inconsistent totals and an absent or early release before relying on the review or reallocating its slot. This is a procedural check: the bus does not assemble or validate report parts. A delivery gap requires repair under the current grant or a fresh grant when it has ended; it never permits dropping findings.`;
const handoverEvidence = `The handover evidence carries the full branch and base shas and all five pre-handover checks:

1. The difference of verdict NAMES against the base: every removed name with its reason, or the explicit empty list.
2. The committed mutation probe: sha, file:line, mutation applied, mutated run exit, base total, passed and unreached counts, expected names written before the run and actual reddened names. A cut-off run or one that reddens none of the expected names is not a successful probe. If the probe sha differs, explain why later changes reach neither the mutated code nor its tests.
3. \`git status --porcelain\` before the probe and after restoration. Dirty state is disclosed, never described as clean.
4. Every red called environmental, flaky or pre-existing, with its full assertion, same test on base and the failure-set difference. Red here and green on base belongs to this change.
5. Every gate not run, with its reason.

Declare an impossible check as \`notRun\` with a concrete reason. A missing check or one declared not run is not a pass. These are evidence for the reviewer to judge, not checks BB performs.`;
const preface = `This skill defines duties, not a participant binding or permission grant. Square-bracketed fields below refer to the initial context; they are not usable ids, addresses, paths, branches or commands. Use only authenticated runtime bindings. Missing context blocks the operation that needs it; never invent an identity, tool or recipient. Without a Promptobus task binding, an independently authorized standalone review may continue through its declared bounded reads, and must report that no bus hand-off was performed.

BB owns activation and Stop. End the turn when waiting, and use the supplied continuation route. Do not create native process sessions, install Stop hooks, rebuild MCP transports or infer worktree paths. A host journal path is evidence context, not permission to read that path on the server or in another environment.

In an ordinary bound participant's first turn, authenticate the actual BB task and mailbox bindings from initial context before substantive work. Report a bridge refusal once; do not substitute similarly named native MCP tools, invent another identity or start another diagnostic model. An empty Host catalog does not negate a complete selected role literal. The initial launchContext supplies owned and provider-permitted read roots, the role literal, active owner-confirmed grant, owner-validated current control reference, preparation and quota policy. The runtime rereads owner-published control at each existing Promptobus admission, including constrained reviewer reads, without adding filesystem roots. Historical file or inline control is evidence only; legacy tasks stay blocked and require an explicitly initialized new task through the supported route. Fresh phases look up the exact previous grant token in current owner control, never in their launch snapshot or a historical ended-token list. These inputs do not widen session or global permissions. Native commands outside Promptobus entry points, physical Stop and provider permission enforcement retain their separate limits. Configuration readiness does not measure an authenticated provider workflow; legacy startup remains notMeasured.

`;

export function renderBbInstructionSkill(role) {
  if (!Object.hasOwn(BB_ROLE_SKILLS, role)) throw new TypeError(`Unknown instruction role: ${role}`);
  let body;
  switch (role) {
    case WORKER:
      body = renderWorkerInstructions({ brief, rules, bindings: {
        ...common, preamble: 'You implement the assignment within the owned BB environment supplied in initial context.',
        workspace: 'Read and edit only the owned repository roots supplied in initial context.',
        orchestrator: 'the registered task coordinator',
        answerDelivery: 'The declared BB continuation route delivers the answer to this participant.',
        reviewDelivery: 'they arrive through the same declared continuation route',
        branchDelivery: 'Use only the assigned environment and branch. Report an explicitly authorized branch change before handing off; never infer a branch or environment from a participant name.',
        artifactDelivery,
        evidenceInstructions: [evidenceProfile, verdictNames, artifactDelivery, evidenceOverflow, gateEvidence, handoverEvidence].join('\n\n'),
        operationalRules: '',
      } });
      break;
    case REVIEWER:
      body = renderReviewerInstructions({ taskId: '[task id]', nsPath: '[repository]', repoDir: '[declared review root]',
        address: '[review participant address]', stepName: '[review step]', rules,
        reviewSubject: '[immutable diff, snapshot HEAD/base, tree state, attachments and gate/handover records supplied in initial context or a declared artifact]',
        instructionsSection: '', procedureText: renderReviewProcedure(null, {}),
        bindings: { ...common, mcpBoundary: 'Only declared bounded read tools are available.',
          externalReads: 'Canonical external tools remain unavailable until the runtime explicitly classifies and delivers them. Read only the declared review roots and evidence.',
          reviewerCommands: { isolation: 'Shell execution and edits are forbidden. Use declared bounded file reads.',
            procedureSkip: 'a build, test, analyzer or unavailable tool', record: 'you run no mechanical checks',
            gate: 'not run, because a reviewer runs no gates or mechanical checks' },
          reportInstructions: reviewerReport,
          reportSend: `Finished the review — deliver every numbered status part through ${tools.promptobus_send}, then the single terminal result and release, following the bounded hand-off form above.`,
          evidenceInstructions: `- ${evidenceProfile}
- ${verdictNames}
- Read the landed gate and handover .txt evidence named in the supplied review subject. Compare \`by\` with the authenticated actor and \`tree\` with the supplied HEAD, and read the disclosed \`dirty\` state and \`exit\` code. The same sha with dirty false and exit 0 is a claim about that commit only. A different sha, dirty tree, non-zero exit or absent evidence must be named in the report, not counted as passing evidence. You run no mechanical checks and cannot prove an author's run happened by reading an attachment. ${GATE_LINE_COUNTS} ${GATE_LINE_VERIFICATION}
- Read all five pre-handover checks: verdict-name differences, committed mutation probe, tree state at both ends, environmental-red comparisons against base, and gates not run. Missing checks and \`notRun\` checks are not passes. Judge the supplied evidence and disclose those limits; do not require a native-schema record or invent a validation result.`,
          close: 'BB owns session closure and Stop.', operationalRules: '',
        },
      });
      break;
    case APPROVER:
      body = renderApproverInstructions({ taskId: '[task id]', nsPath: '[repository]', address: '[acceptance participant address]', stepName: '[acceptance step]',
        reviewAddr: '[preceding participant address]',
        rules, brief, instructionsSection: '', bindings: { ...common,
          workspace: 'Use the owned acceptance environment and publication target supplied in initial context.',
          workerContext: 'When the authenticated contacts register a worker, use that supplied address; otherwise route participant traffic through the orchestrator.',
          workerContact: "You may write directly to the registered worker only when the orchestrator's assignment authorizes it. Without a registered worker, write to the orchestrator only.",
          acceptance: 'Perform the repository acceptance procedure and required gates in that environment. Publish only with the supplied authorized operation and its lease. If the target moved, reconcile in the acceptance environment, rerun the required checks and retry; do not edit a shared target directly.',
          evidenceInstructions: [evidenceProfile, verdictNames, artifactDelivery, evidenceOverflow, gateEvidence,
            "Read the worker's gate and handover evidence against the commit you accept, including all five checks and every notRun reason. You may cite another participant's landed filename, but record your own authorized gate executions with your own authenticated id. Missing, stale, dirty or failing evidence is not a pass; disclose it and follow the assigned acceptance procedure."].join('\n\n'),
        },
      });
      break;
    case 'teamlead':
      body = renderTeamleadInstructions({ rootTask: '[root task id]', childTask: '[child task id]', address: '[teamlead address]',
        rootAddress: '[root coordinator address]', root: '[owned coordinator environment]', brief, siblings: ['[registered sibling addresses]'], rules,
        bindings: { ...common, entry: 'native BB', installationNote: 'whose engine and rule bindings are supplied in initial context', secondaryMailbox: '' },
      });
      break;
    case 'reporter':
      body = renderReporterInstructions({ task: '[root task id]', root: '[owned reporter environment]', rules,
        bindings: { tools, contacts: common.contacts,
          journalSources: 'The engine-backed root and child journals supplied through the declared BB tools are your sources.',
          digestView: 'the engine-backed root-tree journal page', journalBody: 'the declared journal-body read operation',
          answerChannel: 'in the BB conversation through its supplied response channel',
          fileBoundary: 'File writes, shell execution, builds and tests are forbidden. Obtain journal bodies through the declared engine-backed read tools.',
        },
      });
      break;
    case ORCHESTRATOR:
      body = renderOrchestratorInstructions({ rules, brief, bindings: { tools,
        preamble: 'You coordinate this task through its authenticated BB participants. Follow the supplied owner approval boundaries and read the rule paths below.',
        delivery: 'The declared BB activation route delivers mail to this participant;', operationalRules: '',
      } });
      break;
  }
  if ([WORKER, APPROVER, ORCHESTRATOR].includes(role)) {
    body += `\n\n${commandGrant}\n\n${executionResources}\n\n${role === ORCHESTRATOR ? orchestratorCommands : participantCommands}`;
  }
  if (role === ORCHESTRATOR) body += `\n\n${receiveReviewerReport}`;
  return preface + body;
}

export function createBbInstructionDelivery(role, context) {
  const skill = BB_ROLE_SKILLS[role];
  if (!Object.hasOwn(BB_ROLE_SKILLS, role)) throw new TypeError(`Unknown instruction role: ${role}`);
  return {
    configuration: { tools: [], skills: [skill], instructions: `Follow ${skill}. Task, tool, environment, snapshot and gate bindings are supplied in the initial prompt or its declared artifacts; this selection grants no participant rights.` },
    initialPrompt: `## Runtime task context\n\n${JSON.stringify(context, null, 2)}`,
  };
}
