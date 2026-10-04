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

export const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const PROMPTOBUS_TOOLS = Object.freeze([...contract.PROMPTOBUS_TOOLS]);
export const PROTOCOL_VERSIONS = Object.freeze([...contract.PROTOCOL_VERSIONS]);
export const { KNOCK_TEXT_MAX, PRUNE_DEFAULT_DAYS } = contract;
export {
  BRANCH_CHANGED_MARK, INSTALL_TARGETS, MAILBOX_UNREAD_MARK, SKILL_OWNERSHIP_MARKER, WORKTREE_BRANCH_TEMPLATE,
  npmCiCommand, packageSkills,
};

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

// Data only: a copy of each shipped driver's id, capabilities and options, never the driver itself.
export const DRIVER_DECLARATIONS = deepFreeze({
  fallback: REGISTRY.fallback,
  drivers: Object.fromEntries(Object.entries(REGISTRY.drivers).map(([harness, driver]) => [
    harness, structuredClone({ id: driver.id, capabilities: driver.capabilities, options: driver.options }),
  ])),
});

export async function checkWake(harness = null, env = process.env) {
  const driver = liftDriver(harness);
  if (typeof driver.checkWake !== 'function') {
    return { harness: driver.id, endpoint: null, ok: false, error: 'no wake channel declared' };
  }
  return { harness: driver.id, ...(await driver.checkWake(env)) };
}

export function planHookInstall(host, root, harnesses) {
  const { writes, owned, ownedSkills, unproven } = planInstall(host, root, harnesses);
  return { writes, owned, ownedSkills, unproven };
}

const windowOf = ({ kind, id, usedPercent, resetAt }) => ({ kind, id, usedPercent, resetAt: resetAt ?? null });

// The routing modules load on the call, not with the entry: most host commands never diagnose routing.
export async function routingDiagnosis(host, { now = Date.now() } = {}) {
  const { validate } = await import('./model-routing/validate.js');
  const { cacheFileOf, readSnapshot } = await import('./model-routing/cache.js');
  const { DEFAULT_STRATEGY, effectiveStrategy, routingContext } = await import('./models.js');

  const verdict = validate({ host, now });
  const file = cacheFileOf(host);
  const report = {
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
    report.harnesses = Object.entries(ctx.snapshot.harnesses ?? {}).map(([harness, entry]) => ({
      harness,
      state: entry.state,
      reason: entry.reason ?? null,
      message: entry.message ?? '',
      tier: entry.tier ? { name: entry.tier.name, source: entry.tier.source } : null,
      windows: (entry.windows ?? []).map(windowOf),
    }));
    report.nearLimit = ctx.decide().warnings.filter((w) => w.code === 'near-limit').map((w) => w.message);
  } catch (e) {
    report.failure = e.message;
  }
  return report;
}
