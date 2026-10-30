// The host integration entry point: what a host embedding the bus reads instead of package files.
// [reference/02-host.md#the-host-integration-entry-point](../docs/reference/02-host.md#the-host-integration-entry-point)

import { existsSync, readFileSync } from 'node:fs';
import * as contract from './contract.js';
import { REGISTRY, liftDriver } from './drivers.js';
import {
  INSTALL_TARGETS, SKILL_OWNERSHIP_MARKER, packageSkills, planHookInstall as planInstall,
} from './install.js';
import { MAILBOX_UNREAD_MARK } from './status.js';
import { BRANCH_CHANGED_MARK, WORKTREE_BRANCH_TEMPLATE, npmCiCommand } from './worktree.js';

import type { DriverCapabilities, DriverOptions, PromptobusHost } from '../dist/index.js';
import type { InstallPlan, InstallPlanHost, InstallHarness } from './install.js';
import type { AvailabilityWindow } from './model-routing/cache.js';
export type { InstallHarness, InstallTarget, PackageSkillFile, PackageSkill, InstallPlanHost, InstallWrite, InstallPlan } from './install.js';

export interface DriverDeclaration {
  readonly id: string;
  readonly capabilities: Readonly<DriverCapabilities>;
  readonly options: Readonly<DriverOptions>;
}
export interface DriverDeclarations {
  readonly fallback: string;
  readonly drivers: Readonly<Record<string, DriverDeclaration>>;
}
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
interface RuntimeRoutingWindow extends Omit<RoutingWindow, 'usedPercent'> { usedPercent: number | undefined }
interface RuntimeRoutingHarness extends Omit<RoutingHarness, 'windows'> { windows: RuntimeRoutingWindow[] }
interface RuntimeFinding { code?: string; layer?: string; at?: string; rule?: string; message: string }
interface RuntimeDiagnosis extends Omit<RoutingDiagnosis, 'harnesses' | 'errors' | 'warnings'> {
  harnesses: RuntimeRoutingHarness[];
  errors: RuntimeFinding[]; warnings: RuntimeFinding[];
}

export const PACKAGE_VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

export const PROMPTOBUS_TOOLS = Object.freeze([...contract.PROMPTOBUS_TOOLS]);
export const PROTOCOL_VERSIONS = Object.freeze([...contract.PROTOCOL_VERSIONS]);
export const { KNOCK_TEXT_MAX, PRUNE_DEFAULT_DAYS }: { KNOCK_TEXT_MAX: number; PRUNE_DEFAULT_DAYS: number } = contract;
export {
  BRANCH_CHANGED_MARK, INSTALL_TARGETS, MAILBOX_UNREAD_MARK, SKILL_OWNERSHIP_MARKER, WORKTREE_BRANCH_TEMPLATE,
  npmCiCommand, packageSkills,
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

// Data only: a copy of each shipped driver's id, capabilities and options, never the driver itself.
export const DRIVER_DECLARATIONS: DriverDeclarations = deepFreeze({
  fallback: REGISTRY.fallback!,
  drivers: Object.fromEntries(Object.entries(REGISTRY.drivers).map(([harness, driver]) => [
    harness, structuredClone({ id: driver.id, capabilities: driver.capabilities, options: driver.options }),
  ])),
});

export async function checkWake(harness: string | null = null, env = process.env) {
  const driver = liftDriver(harness);
  if (typeof driver.checkWake !== 'function') {
    return { harness: driver.id, endpoint: null, ok: false, error: 'no wake channel declared' };
  }
  return { harness: driver.id, ...(await driver.checkWake(env)) };
}

export function planHookInstall(host: InstallPlanHost, root: string, harnesses: readonly InstallHarness[]): InstallPlan {
  const { writes, owned, ownedSkills, unproven } = planInstall(host, root, harnesses);
  return { writes, owned, ownedSkills, unproven };
}

const windowOf = ({ kind, id, usedPercent, resetAt }: AvailabilityWindow): RuntimeRoutingWindow => ({ kind, id, usedPercent, resetAt: resetAt ?? null });

// The routing modules load on the call, not with the entry: most host commands never diagnose routing.
export function routingDiagnosis(host: PromptobusHost, options?: { now?: number }): Promise<RoutingDiagnosis>;
export async function routingDiagnosis(host: PromptobusHost, { now = Date.now() } = {}): Promise<RuntimeDiagnosis> {
  const { validate } = await import('./model-routing/validate.js');
  const { cacheFileOf, readSnapshot } = await import('./model-routing/cache.js');
  const { DEFAULT_STRATEGY, effectiveStrategy, routingContext } = await import('./models.js');

  const verdict = validate({ host, now });
  const file = cacheFileOf(host);
  const report: RuntimeDiagnosis = {
    layers: verdict.layers,
    errors: verdict.errors,
    warnings: verdict.warnings ?? [],
    cache: { file, present: existsSync(file), takenAt: readSnapshot(host)?.takenAt ?? null },
    strategy: null,
    harnesses: [],
    nearLimit: [],
    skipped: null,
    failure: null,
  };
  if (verdict.errors.length) return { ...report, skipped: 'layer-errors' };
  if (!host.declaredTools().length) report.skipped = 'no-declared-harness';

  try {
    report.strategy = effectiveStrategy(host, { now }) ?? { strategy: DEFAULT_STRATEGY, source: null };
    const ctx = await routingContext(host, {
      strategy: report.strategy.strategy, refresh: false, dryRun: true, now, permitEmptyCandidates: true,
    });
    report.harnesses = Object.entries(ctx!.snapshot.harnesses ?? {}).map(([harness, entry]) => ({
      harness,
      state: entry.state,
      reason: entry.reason ?? null,
      message: entry.message ?? '',
      tier: entry.tier ? { name: entry.tier.name, source: entry.tier.source } : null,
      windows: (entry.windows ?? []).map(windowOf),
    }));
    report.nearLimit = ctx!.decide().warnings.filter((w) => w.code === 'near-limit').map((w) => w.message);
  } catch (e) {
    report.failure = (e as Error).message;
  }
  return report;
}
