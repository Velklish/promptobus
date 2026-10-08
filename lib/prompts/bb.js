import { APPROVER, ORCHESTRATOR, REVIEWER, WORKER } from '../../dist/registry.js';
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
  lease: 'Take a measurement or publication lease only through the operation supplied in the task context.',
  communication: 'the authenticated native BB tools named in the initial context',
  repositorySkills: 'Read the repository rules and skills named in the initial context.',
  dependencies: 'Use the supplied repository preparation instructions; do not assume a package manager.',
  wait: 'End the turn when waiting for mail. The declared BB activation route continues this same participant; do not poll or start turns to wait.',
};
const rules = ['[rule paths supplied in initial context]'];
const brief = '[assignment supplied in initial context]';
const preface = `This skill defines duties, not a participant binding or permission grant. Square-bracketed fields below refer to the initial context; they are not usable ids, addresses, paths, branches or commands. Use only authenticated runtime bindings. Missing context blocks the operation that needs it; never invent an identity, tool or recipient. Without a Promptobus task binding, an independently authorized standalone review may continue through its declared bounded reads, and must report that no bus hand-off was performed.

BB owns activation and Stop. End the turn when waiting, and use the supplied continuation route. Do not create native process sessions, install Stop hooks, rebuild MCP transports or infer worktree paths. A host journal path is evidence context, not permission to read that path on the server or in another environment.

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
