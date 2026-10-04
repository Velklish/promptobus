// Types of `promptobus/integration`: [reference/02-host.md](../docs/reference/02-host.md#the-host-integration-entry-point).
import type { DriverCapabilities, DriverOptions, PromptobusHost, WakeProbe } from '../dist/index.js';

export declare const PACKAGE_VERSION: string;

export declare const PROMPTOBUS_TOOLS: readonly string[];
export declare const PROTOCOL_VERSIONS: readonly string[];
export declare const PRUNE_DEFAULT_DAYS: number;
export declare const KNOCK_TEXT_MAX: number;
export declare const MAILBOX_UNREAD_MARK: string;
export declare const BRANCH_CHANGED_MARK: string;
export declare const WORKTREE_BRANCH_TEMPLATE: string;
export declare function npmCiCommand(): string;

export interface DriverDeclaration {
  readonly id: string;
  readonly capabilities: Readonly<DriverCapabilities>;
  readonly options: Readonly<DriverOptions>;
}
export interface DriverDeclarations {
  readonly fallback: string;
  readonly drivers: Readonly<Record<string, DriverDeclaration>>;
}
export declare const DRIVER_DECLARATIONS: DriverDeclarations;
export declare function checkWake(
  harness?: string | null,
  env?: Record<string, string | undefined>,
): Promise<WakeProbe & { harness: string }>;

export type InstallHarness = 'claude' | 'cursor' | 'codex';
export interface InstallTarget {
  readonly hooksRel: string;
  readonly skillsRel: string;
}
export declare const INSTALL_TARGETS: Readonly<Record<InstallHarness, InstallTarget>>;
export declare const SKILL_OWNERSHIP_MARKER: string;
export interface PackageSkillFile {
  rel: string;
  abs: string;
  buffer: Uint8Array;
  text: string;
}
export interface PackageSkill {
  name: string;
  files: PackageSkillFile[];
}
export declare function packageSkills(): PackageSkill[];

export type InstallPlanHost = Pick<PromptobusHost, 'nodePath' | 'guardArgv' | 'busHookRel' | 'installManifestRel'>;
export interface InstallWrite {
  rel: string;
  abs: string;
  text: string | null;
  buffer?: Uint8Array | null;
  remove?: true;
}
export interface InstallPlan {
  writes: InstallWrite[];
  owned: Record<InstallHarness, string[]>;
  ownedSkills: Record<InstallHarness, string[]>;
  unproven: string[];
}
export declare function planHookInstall(
  host: InstallPlanHost,
  root: string,
  harnesses: readonly InstallHarness[],
): InstallPlan;

export interface RoutingLayer {
  id: string;
  path: string;
  present: boolean;
  writable: boolean;
}
export interface RoutingFinding {
  code?: string;
  layer?: string;
  at?: string;
  rule?: string;
  message: string;
  [field: string]: unknown;
}
export interface RoutingWindow {
  kind: string;
  id: string;
  usedPercent: number;
  resetAt: string | null;
}
export interface RoutingHarness {
  harness: string;
  state: string;
  reason: string | null;
  message: string;
  tier: { name: string; source: string } | null;
  windows: RoutingWindow[];
}
export interface RoutingDiagnosis {
  layers: RoutingLayer[];
  errors: RoutingFinding[];
  warnings: RoutingFinding[];
  cache: { file: string; present: boolean; takenAt: string | null };
  strategy: { strategy: string; source: string | null } | null;
  harnesses: RoutingHarness[];
  nearLimit: string[];
  skipped: 'layer-errors' | 'no-declared-harness' | null;
  failure: string | null;
}
export declare function routingDiagnosis(
  host: PromptobusHost,
  options?: { now?: number },
): Promise<RoutingDiagnosis>;
