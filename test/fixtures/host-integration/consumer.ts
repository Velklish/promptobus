// The typed half of the host fixture: every name of `promptobus/integration`, read through its declared types.
import {
  BRANCH_CHANGED_MARK, DRIVER_DECLARATIONS, INSTALL_TARGETS, KNOCK_TEXT_MAX, MAILBOX_UNREAD_MARK, PACKAGE_VERSION,
  PROMPTOBUS_TOOLS, PROTOCOL_VERSIONS, PRUNE_DEFAULT_DAYS, SKILL_OWNERSHIP_MARKER, WORKTREE_BRANCH_TEMPLATE,
  approveCodexRootProfile, approveStandaloneRootProfile, checkWake, npmCiCommand, packageSkills, planHookInstall, routingDiagnosis,
} from 'promptobus/integration';
import type { InstallPlan, InstallPlanHost, InstallPlanOptions, RoutingDiagnosis, StandaloneRootProfileDescriptor, StandaloneRootProfileInput } from 'promptobus/integration';
import { createStandaloneHost } from 'promptobus/host';
import { createBbManagedAdmission } from 'promptobus/bb-host';

const declaredExports: typeof import('promptobus/integration') = {
  BRANCH_CHANGED_MARK, DRIVER_DECLARATIONS, INSTALL_TARGETS, KNOCK_TEXT_MAX, MAILBOX_UNREAD_MARK, PACKAGE_VERSION,
  PROMPTOBUS_TOOLS, PROTOCOL_VERSIONS, PRUNE_DEFAULT_DAYS, SKILL_OWNERSHIP_MARKER, WORKTREE_BRANCH_TEMPLATE,
  approveCodexRootProfile, approveStandaloneRootProfile, checkWake, npmCiCommand, packageSkills, planHookInstall,
  routingDiagnosis,
};

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
const rootProfile: Promise<{ root: string; home: string; profile: string; server: { url: string; required: boolean; http_headers_helper: string };
  startHook: { type: 'command'; command: string }; execPlanCommand: string }> = approveCodexRootProfile(createStandaloneHost({}),
  { id: 'typed-root', nativeStore: process.cwd() }, { PROMPTOBUS_ROLE: 'worker:typed' });
const controlledCreation: ReturnType<typeof approveCodexRootProfile> = approveCodexRootProfile(createStandaloneHost({}), {
  id: 'typed-controlled-root', nativeStore: process.cwd(), executionScope: Object.freeze({ project: 'project-owned', environment: 'environment-owned' }), createRoot: async descriptor => {
    const profile: string = descriptor.profile;
    return { id: `thr_${profile}` };
  },
}, { PROMPTOBUS_ROLE: 'worker:typed' });
const creationResult: Promise<{ state: 'pending' | 'uncertain' | 'bound'; bbThreadId: string | null } | undefined> = controlledCreation.then(value => value.creation);
const standaloneInput: StandaloneRootProfileInput = { id: 'typed-native', harness: 'claude', nativeStore: process.cwd(), executable: process.execPath };
const standaloneProfile: Promise<StandaloneRootProfileDescriptor> = approveStandaloneRootProfile(createStandaloneHost({}), standaloneInput, {});
const optionalInstall: Promise<InstallPlan> = standaloneProfile.then(profile => {
  const options: InstallPlanOptions = { rootProfile: profile };
  return planHookInstall(host, process.cwd(), [profile.harness], options);
});
const report: Promise<RoutingDiagnosis['skipped']> = routingDiagnosis(createStandaloneHost({}), { now: 0 })
  .then((diagnosis) => diagnosis.skipped);
const admission = createBbManagedAdmission(executionPath => createStandaloneHost({ cwd: executionPath }), {});
const managedMethods: Record<keyof typeof admission, true> = { scope: true, begin: true, complete: true };
const ownerScope: Promise<{ root: string; home: string }> = admission.scope(process.cwd());
const managedScope: Promise<{ root: string; home: string }> = admission.begin(process.cwd(), 'typed-intent');
const completedScope: Promise<{ root: string; home: string }> = admission.complete(process.cwd(), 'typed-intent', 'thr_typed_owned',
  { root: process.cwd(), home: process.cwd() });

export { declaredExports, printed, limits, effort, denies, targets, skills, plan, wake, rootProfile, controlledCreation, creationResult, standaloneInput, standaloneProfile, optionalInstall, report,
  admission, managedMethods, ownerScope, managedScope, completedScope };
