// The typed half of the host fixture: every name of `promptobus/integration`, read through its declared types.
import {
  BRANCH_CHANGED_MARK, DRIVER_DECLARATIONS, INSTALL_TARGETS, KNOCK_TEXT_MAX, MAILBOX_UNREAD_MARK, PACKAGE_VERSION,
  PROMPTOBUS_TOOLS, PROTOCOL_VERSIONS, PRUNE_DEFAULT_DAYS, SKILL_OWNERSHIP_MARKER, WORKTREE_BRANCH_TEMPLATE,
  checkWake, npmCiCommand, packageSkills, planHookInstall, routingDiagnosis,
} from 'promptobus/integration';
import type { InstallPlan, InstallPlanHost, RoutingDiagnosis } from 'promptobus/integration';
import { createStandaloneHost } from 'promptobus/host';

const printed: string[] = [
  PACKAGE_VERSION, MAILBOX_UNREAD_MARK, BRANCH_CHANGED_MARK, WORKTREE_BRANCH_TEMPLATE, SKILL_OWNERSHIP_MARKER,
  npmCiCommand(), ...PROMPTOBUS_TOOLS, ...PROTOCOL_VERSIONS,
];
const limits: number[] = [PRUNE_DEFAULT_DAYS, KNOCK_TEXT_MAX];
const fallback: string = DRIVER_DECLARATIONS.fallback;
const effort: readonly string[] = DRIVER_DECLARATIONS.drivers[fallback]?.options.effortLevels ?? [];
const denies: boolean | undefined = DRIVER_DECLARATIONS.drivers[fallback]?.capabilities.denyTools;
const targets: string[] = [INSTALL_TARGETS.claude.skillsRel, INSTALL_TARGETS.cursor.hooksRel];
const skills: string[] = packageSkills().map((skill) => skill.name);
const host: InstallPlanHost = {
  nodePath: () => process.execPath,
  guardArgv: (args) => ['bin.js', ...args],
  busHookRel: () => 'bus.mjs',
  installManifestRel: () => 'manifest.json',
};
const plan: InstallPlan = planHookInstall(host, process.cwd(), ['codex']);
const wake: Promise<boolean> = checkWake('codex', {}).then((probe) => probe.ok && probe.harness === 'codex');
const report: Promise<RoutingDiagnosis['skipped']> = routingDiagnosis(createStandaloneHost({}), { now: 0 })
  .then((diagnosis) => diagnosis.skipped);

export { printed, limits, effort, denies, targets, skills, plan, wake, report };
