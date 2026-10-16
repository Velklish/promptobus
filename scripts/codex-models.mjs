// The binary's own model catalog, for a paid Codex raise: the model is verified against it
// BEFORE any session is spent. A script-local helper of the live scripts, not a suite module.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { MECHANISM_ROOT } from '../test/scenario.mjs';

const { ownerCodexHome } = await import(path.join(MECHANISM_ROOT, 'lib', 'driver-codex.js'));

const CATALOG_TIMEOUT_MS = 15000;

/** Entries the binary's catalog knows — `{slug, visibility}`; `null` when it could not be read.
 *  The catalog is read from the OWNER home the lift authenticates from, so both see one account. */
export function codexCatalogEntries(bin = 'codex', { env = process.env } = {}) {
  const r = spawnSync(bin, ['debug', 'models'], {
    encoding: 'utf8',
    timeout: CATALOG_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, CODEX_HOME: ownerCodexHome(env) },
  });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    const models = JSON.parse(r.stdout.trim())?.models;
    if (!Array.isArray(models)) return null;
    return models
      .map((m) => ({ slug: String(m?.slug ?? ''), visibility: String(m?.visibility ?? '') }))
      .filter((m) => m.slug);
  } catch {
    return null;
  }
}

/** The preflight of a paid raise: the model — asked, or the driver's default — must be one the
 *  binary's catalog knows; a hidden entry is still a named model (ADR-005). */
export function pickCodexModel(catalog, asked, fallback) {
  if (!catalog?.length) {
    return { reason: 'no model catalog from the binary (codex debug models) — a paid session would start on an unverified model' };
  }
  const slugs = catalog.map((m) => m.slug);
  const model = asked ?? fallback;
  if (!slugs.includes(model)) {
    return { reason: `model «${model}» is not in the binary's catalog (codex debug models): ${slugs.join(', ')}` };
  }
  return { model };
}
