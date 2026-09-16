// The `models` command: what each subcommand reads and writes.
// [guides/model-routing.md#the-models-command-what-each-subcommand-reads-and-writes](../docs/guides/model-routing.md#the-models-command-what-each-subcommand-reads-and-writes)
import { existsSync } from 'node:fs';

import { GateError, PromptobusError } from '../dist/index.js';
import { writeFileAtomic } from '../dist/fs/atomic.js';
import { adapterOf, driverByHarness, eligibleHarnessesForRole, roleHarnessRefusal } from './drivers.js';
import { hostOf } from './host.js';
import {
  bad, info, ok, warn,
} from './util.js';
import {
  CATALOG_FILE, OVERLAY_SCHEMA_VERSION, ROUTED_ROLES, STRATEGIES, loadCatalog, readLayerFile, readLayers,
} from './model-routing/catalog.js';
import { clearExhausted, snapshotEntry } from './model-routing/cache.js';
import { preflight } from './model-routing/preflight.js';
import { render } from './model-routing/render.js';
import { readTelemetry, telemetryLine } from './model-routing/telemetry.js';
import { calibrate, renderCalibration } from './model-routing/calibrate.js';
import { applicableWindows, resolve } from './model-routing/resolver.js';
import { validate } from './model-routing/validate.js';

/** Strategy of a `models` call that names none: `balanced`, ADR-003's middle weight set — the
 * answer with no thumb on any scale. `spawn` and `review` have no default and route nothing. */
export const DEFAULT_STRATEGY = 'balanced';

/** Role a `models` call that names none is answered for. */
export const DEFAULT_ROLE = 'worker';

/** Ask one yes/no question on the terminal. `node:readline` is imported where it is used: a module
 * that opened stdin at load would attach a reader to every `models` call, warden ones included. */
async function defaultAsk(question) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Write one already-terminated block to the command's output stream. */
function emit(output, text) {
  const chunk = text.endsWith('\n') ? text : `${text}\n`;
  if (output && typeof output.write === 'function') output.write(chunk);
  else process.stdout.write(chunk);
}

// Where the decision takes the moment its snapshot was assembled.
// [guides/model-routing.md#agedsnapshot--where-the-decision-takes-the-moment-its-snapshot-was-assembled](../docs/guides/model-routing.md#agedsnapshot--where-the-decision-takes-the-moment-its-snapshot-was-assembled)
function agedSnapshot(snapshot) {
  const stamps = Object.values(snapshot.harnesses ?? {})
    .map((e) => Date.parse(e.checkedAt))
    .filter((ms) => Number.isFinite(ms));
  if (!stamps.length) return snapshot;
  return { ...snapshot, takenAt: new Date(Math.min(...stamps)).toISOString() };
}

/** Values of a constraint kind the merged catalog knows, sorted, for a refusal that lists them. */
function known(tuples, field) {
  return [...new Set(tuples.map((t) => t[field]).filter((v) => typeof v === 'string' && v))].sort();
}

/** Explicit constraints against the merged catalog and the workspace declaration, each value
 * checked on its own. A COMBINATION matching nothing is not this refusal — the decision explains it. */
function checkConstraints(policy, declared, { harness, model, effort }) {
  if (harness && !declared.includes(harness)) {
    throw new PromptobusError('harness-unknown',
      `--harness ${harness}: this workspace declares no such harness `
      + `(declared: ${declared.join(', ') || 'none'}) — routing asks only the harnesses it declared, `
      + 'and a tuple of an undeclared one is never in the snapshot to be chosen from');
  }
  const tuples = policy.tuples ?? [];
  const pairs = [['harness', harness], ['model', model], ['effort', effort]];
  for (const [field, value] of pairs) {
    if (!value) continue;
    if (tuples.some((t) => (t[field] ?? null) === value)) continue;
    throw new PromptobusError('constraint-unknown',
      `--${field} ${value}: no tuple of the merged catalog names it `
      + `(rated ${field}s: ${known(tuples, field).join(', ') || 'none'}). `
      + 'An explicit value is a constraint on the resolver, never a wish — the command does not '
      + 'replace it with a neighbour');
  }
}

/** The merged catalog, refusing on a layer it cannot read or a `schemaVersion` it does not know.
 * The full `models validate` sweep is a command a person types, not a toll on every lift. */
function routingLayerOf(error, host, catalogFile) {
  const layer = error.routingLayer ?? null;
  const path = layer?.kind === 'catalog'
    ? catalogFile
    : layer?.kind === 'overlay'
      ? (host.routingPaths?.()?.overlays ?? []).find((item) => item.id === layer.id)?.path
      : null;
  const subject = layer?.kind === 'host'
    ? 'the host routing declaration'
    : layer
      ? `routing layer "${layer.id}"${path ? ` (${path})` : ''}`
      : 'routing policy';
  return { kind: layer?.kind ?? null, id: layer?.id ?? null, path, subject };
}

function mergedCatalog({ host, constraints, catalogFile, now }) {
  try {
    return loadCatalog({ host, constraints, catalogFile, now });
  } catch (e) {
    if (!(e instanceof GateError)) throw e;
    const layer = routingLayerOf(e, host, catalogFile);
    const validateCommand = typeof host.busCommand === 'function'
      ? host.busCommand(['models', 'validate']) : null;
    throw new PromptobusError(layer.kind === 'catalog' ? 'catalog-invalid' : 'overlay-invalid',
      `${layer.subject} cannot be used: ${e.message}`
      + (validateCommand ? `. The whole picture is one command away: \`${validateCommand}\`` : ''));
  }
}

/** Everything a routed call needs, with the harnesses already asked. It returns a FUNCTION: the
 * awaiting half runs here, and the participants are known only inside a plan, where nothing awaits. */
export async function routingContext(rootOrHost, {
  strategy,
  role = DEFAULT_ROLE,
  harness = null,
  model = null,
  effort = null,
  allowPayg = false,
  refresh = false,
  dryRun = false,
  strategySource = null,
  catalogFile = CATALOG_FILE,
  adapterFor = adapterOf,
  now = Date.now(),
  permitEmptyCandidates = false,
} = {}) {
  const host = hostOf(rootOrHost);
  if (!STRATEGIES.includes(strategy)) {
    throw new PromptobusError('strategy-unknown',
      `--strategy: unknown value "${strategy ?? ''}" — allowed: ${STRATEGIES.join(', ')}. `
      + '"auto" is not one of them: classifying a task into a strategy is the orchestrating '
      + 'agent\'s decision, and the CLI is called with the concrete one');
  }
  if (!ROUTED_ROLES.includes(role)) {
    throw new PromptobusError('role-unknown', `--role: unknown value "${role ?? ''}" — allowed: ${ROUTED_ROLES.join(', ')}`);
  }
  const constraints = {
    harness: harness ?? null, model: model ?? null, effort: effort ?? null, allowPayg: allowPayg === true,
  };
  const declared = host.declaredTools();
  const eligible = eligibleHarnessesForRole(host, role);
  const policy = mergedCatalog({ host, constraints, catalogFile, now });
  checkConstraints(policy, declared, constraints);
  if (constraints.harness && declared.includes(constraints.harness) && !eligible.includes(constraints.harness)) {
    const refusal = roleHarnessRefusal(driverByHarness(constraints.harness), role);
    if (refusal) throw new PromptobusError('harness-refused', refusal);
  }
  if (!eligible.length) {
    if (!permitEmptyCandidates) {
      throw new PromptobusError('candidates-empty',
        role === 'approver' && declared.length
          ? `this workspace declares ${declared.join(', ')}, but none can lift an approver — `
            + 'routing asks only harnesses with approver lift, and the declared set leaves no tuple at all'
          : `this workspace declares no harness (${host.toolsManifestRel()}), so there is nothing to route to: `
            + 'the catalog is filtered by the declaration, and an empty declaration leaves no tuple at all');
    }
  }

  const rated = (h, m) => (policy.tuples ?? []).some((t) => t.harness === h && t.model === m);
  const snapshot = agedSnapshot(await preflight({
    host, harnesses: eligible, adapterFor, refresh, dryRun, rated,
  }));
  const strategyCommands = typeof host.busCommand === 'function'
    ? Object.fromEntries(['economy', 'balance']
      .map((name) => [name, host.busCommand(['models', 'strategy', '--set', name])]))
    : {};

  return {
    host,
    policy,
    snapshot,
    constraints,
    strategyCommands,
    decide: (liveParticipants = []) => {
      const decision = resolve({
        role, strategy, constraints, policy, snapshot, liveParticipants, strategyCommands, now,
      });
      // Only when the strategy was NOT named on the command line: a flag always wins, and the
      // absence of the field is what says the value came from the person.
      return strategySource ? { ...decision, strategySource } : decision;
    },
  };
}

/** The refusal a decision with no pick becomes. The rendered decision travels INSIDE the message:
 * a plan prints nothing, and the diagnostics a person needs are the lines `models` shows. */
export function noCandidate(decision) {
  // Read off the VALUES, not the exclusion codes: a tuple dropped for a reason reached first —
  // an overlay deny — never carries `constraint-mismatch`, and the codes let neighbours in.
  const { harness, model, effort } = decision.constraints;
  const named = harness || model || effort;
  const selected = decision.candidates.filter((c) => (!harness || c.harness === harness)
    && (!model || c.model === model)
    && (!effort || c.effort === effort));
  const down = selected.length > 0
    && selected.every((c) => c.excluded?.code === 'harness-unavailable' || c.excluded?.code === 'harness-exhausted');
  const code = named && down ? 'constraint-unavailable' : 'candidates-empty';
  const tail = code === 'constraint-unavailable'
    ? 'The named combination is rated, but the harness that runs it is unavailable or exhausted, and an '
      + 'explicit value is never replaced by a neighbour. Drop the constraint to let the resolver choose, '
      + 'or clear the exhaustion once the account is back.'
    : 'Nothing survived filtering. Nothing was written: no task, no worktree and no participant record.';
  return new PromptobusError(code, `${render(decision)}\n${tail}`);
}

/** The decision as it is kept on the participant — compact on purpose.
 * [guides/model-routing.md#routingmetadata--the-decision-as-it-is-kept-on-the-participant](../docs/guides/model-routing.md#routingmetadata--the-decision-as-it-is-kept-on-the-participant) */
export function routingMetadata(decision, snapshot = null) {
  const chosen = decision.candidates.find((c) => c.chosen) ?? null;
  const entry = snapshot?.harnesses?.[decision.chosen.harness] ?? null;
  const windows = entry
    ? applicableWindows(entry, decision.chosen.model).map((w) => ({
      id: w.id, kind: w.kind, scope: w.scope ?? null, usedPercent: w.usedPercent,
    }))
    : [];
  return {
    strategy: decision.strategy,
    role: decision.role,
    tupleId: decision.chosen.tupleId,
    harness: decision.chosen.harness,
    model: decision.chosen.model,
    effort: decision.chosen.effort,
    score: chosen?.score?.total ?? null,
    ...(decision.strategySource ? { strategySource: decision.strategySource } : {}),
    snapshot: { ...decision.snapshot },
    windows,
    warnings: decision.warnings.map((w) => w.code),
    constraints: { ...decision.constraints },
  };
}

/** Participants already up, as the resolver wants them. Three kinds are left out: the orchestrator
 * (no harness of its own), a record with no model, and a dismissed one. `exclude` is the restart. */
export function liveTuples(taskMeta, { exclude = null } = {}) {
  return (taskMeta?.participants ?? [])
    .filter((p) => ROUTED_ROLES.includes(p.role))
    .filter((p) => p.metadata?.address !== exclude)
    .filter((p) => !p.metadata?.dismissed)
    .filter((p) => typeof p.metadata?.model === 'string' && p.metadata.model)
    .map((p) => ({ harness: p.harness, model: p.metadata.model, role: p.role }));
}

/** The pick, from a context already built and the task the lift joins. Synchronous on purpose —
 * `planReview` is called as a pure function by the suite and may not await. */
export function decideLift(ctx, { taskMeta = null, address = null } = {}) {
  if (!ctx) return null;
  const decision = ctx.decide(liveTuples(taskMeta, { exclude: address }));
  if (!decision.chosen) throw noCandidate(decision);
  return {
    decision,
    harness: decision.chosen.harness,
    model: decision.chosen.model,
    effort: decision.chosen.effort,
    metadata: routingMetadata(decision, ctx.snapshot),
  };
}

/** The routing half of a lift in one call, or `null` when it routes nothing — the whole legacy
 * path. The check lives here: two copies would drift, and the drifted one would ask the host. */
export async function routeLift(rootOrHost, {
  role,
  strategy = undefined,
  harness = null,
  model = null,
  effort = null,
  allowPayg = false,
  refresh = false,
  dryRun = false,
  taskMeta = null,
  address = null,
  catalogFile = CATALOG_FILE,
  adapterFor = adapterOf,
  now = Date.now(),
} = {}) {
  const host = hostOf(rootOrHost);
  // The default is read BEFORE the legacy gate: a call with no `--strategy` and no default
  // anywhere still returns having asked the host nothing but its overlay paths.
  const effective = effectiveStrategy(host, { strategy, catalogFile, now });
  if (!effective) return null;
  const ctx = await routingContext(host, {
    strategy: effective.strategy,
    strategySource: effective.source === 'flag' ? null : effective.source,
    role,
    harness,
    model,
    effort,
    allowPayg,
    refresh,
    dryRun,
    catalogFile,
    adapterFor,
    now,
  });
  return decideLift(ctx, { taskMeta, address });
}

/** One line about a routed participant: strategy, tuple, snapshot age, warnings. */
export function routingLine(routing) {
  if (!routing) return null;
  const parts = [`routing: ${routing.strategy}`, routing.tupleId];
  if (typeof routing.score === 'number') parts.push(`score ${routing.score.toFixed(2)}`);
  if (routing.snapshot) parts.push(`snapshot ${routing.snapshot.ageSec} s old`);
  parts.push(routing.warnings?.length ? `warnings: ${routing.warnings.join(', ')}` : 'no warnings');
  return parts.join(' · ');
}

/** The decision inside a `--dry-run` plan, rendered rather than summarised: a dry run is where a
 * person checks the pick before paying for it, and a one-line summary hides the losers. */
export function sayDecision(decision) {
  info('routing decision:');
  for (const line of render(decision).trimEnd().split('\n')) console.log(`  ${line}`);
}

/** `models --clear-exhausted <harness>`: drop a reset-less exhaustion, and say whether one was held. */
function clearCommand(host, harness) {
  const declared = host.declaredTools();
  if (!declared.includes(harness)) {
    throw new PromptobusError('harness-unknown',
      `--clear-exhausted ${harness}: this workspace declares no such harness `
      + `(declared: ${declared.join(', ') || 'none'})`);
  }
  const { cacheFile } = host.routingPaths();
  if (clearExhausted(host, harness)) {
    ok(`${harness}: the exhaustion mark is cleared — the harness counts as unknown until the next --refresh probes it again (${cacheFile})`);
    return 0;
  }
  info(`${harness}: nothing to clear — the cache holds no exhaustion without a reset for it. `
    + 'An exhaustion that names its reset expires by itself and this flag leaves it alone'
    + `${existsSync(cacheFile) ? '' : `; there is no cache file yet (${cacheFile})`}`);
  return 0;
}

/** The bans in force, and who can lift each one. A deny rule is lifted in the layer that wrote it
 * and nowhere else, so a person reading `denied by policy` is told which file to open. */
function sayDenyRules(verdict) {
  const rules = (verdict.rules ?? []).filter((r) => r.rule === 'deny');
  if (!rules.length) return;
  info('deny rules in force — each is lifted only in the layer that wrote it, and no allow list reaches one:');
  for (const rule of rules) {
    const where = rule.role ? `deny.byRole.${rule.role}.${rule.kind}` : `deny.${rule.kind}`;
    console.log(`  ${where} of "${rule.layer}": ${rule.names.join(', ')}`);
  }
}

// --- the strategy default ----------------------------------------------------

/** The strategy a routed call will use, and where it came from: `--strategy`, then the merged
 * default, then `null` — the legacy path. Reading it costs the overlay files and nothing else. */
export function effectiveStrategy(host, { strategy, catalogFile = CATALOG_FILE, now = Date.now() } = {}) {
  if (strategy !== undefined && strategy !== null) return { strategy, source: 'flag' };
  let merged;
  try {
    merged = loadCatalog({ host, catalogFile, now });
  } catch (e) {
    if (e instanceof GateError) {
      const layer = routingLayerOf(e, host, catalogFile);
      const validateCommand = typeof host.busCommand === 'function'
        ? host.busCommand(['models', 'validate']) : null;
      warn(`${layer.subject} could not be used while reading the strategy default: ${e.message}`
        + (validateCommand ? `. Run \`${validateCommand}\` to inspect the routing stack` : ''));
      return null;
    }
    throw e;
  }
  const value = merged.policy?.defaults?.strategy;
  if (!value) return null;
  return { strategy: value, source: `overlay:${merged.sources?.defaults?.strategy ?? 'unknown'}` };
}

/** The one layer the host says the tool may write, or a refusal naming why there is none. */
function writableLayer(host) {
  const declared = host.routingPaths?.()?.overlays ?? [];
  const writable = declared.find((layer) => layer.writable === true);
  if (writable) return writable;
  throw new PromptobusError('overlay-invalid',
    declared.length
      ? `this host declares routing layers (${declared.map((l) => l.id).join(', ')}) and none of them is writable, `
        + 'so there is nowhere to keep a strategy default. Exactly one layer must be marked writable'
      : 'this host declares no routing overlay at all, so there is nowhere to keep a strategy default. '
        + 'A host that means the tool to write one declares a layer and marks it writable');
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Read a writable overlay without turning a non-object JSON value into an object of junk keys. */
function writableDocument(layer) {
  const file = readLayerFile(layer.path);
  if (file.present && !isObject(file.data)) {
    const found = Array.isArray(file.data) ? 'an array'
      : file.data === null ? 'null'
        : `a ${typeof file.data}`;
    throw new GateError(`routing layer ${layer.path} is not a JSON object: found ${found}`);
  }
  return file.data ?? { schemaVersion: OVERLAY_SCHEMA_VERSION };
}

/** `models strategy [--set <name> | --clear]`. The write keeps every other key of the file: the
 * layer is a person's file holding one machine-written value. Atomic and `0600`. */
function strategyCommand(host, { set: setTo, clear, catalogFile, now }) {
  const merged = loadCatalog({ host, catalogFile, now });
  const current = merged.policy?.defaults?.strategy ?? null;
  const from = merged.sources?.defaults?.strategy ?? null;

  if (!setTo && !clear) {
    if (current) info(`strategy default: ${current} · set by overlay "${from}"`);
    else {
      info('strategy default: none — `spawn` and `review` without --strategy route nothing and take '
        + `today\'s path. \`${host.busCommand(['models', 'strategy', '--set', '<name>'])}\` records one`);
    }
    sayAccountAnswers(host, merged);
    return 0;
  }
  if (setTo && clear) {
    throw new GateError('models strategy: --set and --clear ask for opposite things; pass one');
  }
  if (setTo && !STRATEGIES.includes(setTo)) {
    throw new PromptobusError('strategy-unknown',
      `models strategy --set: unknown value "${setTo}" — allowed: ${STRATEGIES.join(', ')}. `
      + '"auto" is not one of them: classifying a task into a strategy is the orchestrating agent\'s '
      + 'decision, and the recorded default is the concrete one');
  }

  const layer = writableLayer(host);
  const doc = writableDocument(layer);

  // Nothing to clear is not a write: creating a file to record the absence of a key would leave
  // an overlay that says nothing, and `--clear` twice would look like it did something.
  if (clear && doc.defaults?.strategy === undefined) {
    info(`no strategy default is set in overlay "${layer.id}" (${layer.path}) — nothing to clear`
      + `${current ? `. The effective default of ${current} comes from overlay "${from}"` : ''}`);
    return 0;
  }

  // The whole stack is read BEFORE anything is written: a broken layer above the writable one must
  // refuse while the file on disk is still the person's. It also catches a mis-marked writable layer.
  const declared = host.routingPaths?.()?.overlays ?? [];
  const above = declared.slice(declared.findIndex((l) => l.id === layer.id) + 1)
    .filter((l) => readLayerFile(l.path).data?.defaults?.strategy !== undefined);

  const defaults = { ...(doc.defaults ?? {}) };
  if (setTo) defaults.strategy = setTo;
  else delete defaults.strategy;
  const next = { ...doc, schemaVersion: doc.schemaVersion ?? OVERLAY_SCHEMA_VERSION, defaults };
  if (!Object.keys(next.defaults).length) delete next.defaults;
  writeFileAtomic(layer.path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });

  if (clear) {
    ok(`strategy default cleared from overlay "${layer.id}" (${layer.path})`);
  } else ok(`strategy default set to ${setTo} in overlay "${layer.id}" (${layer.path})`);

  if (above.length && setTo) {
    warn(`what was just written is shadowed: overlay "${above[above.length - 1].id}" sits above `
      + `"${layer.id}" and names a strategy default of its own, so that one is what takes effect`);
  }
  return 0;
}

/** The one question the tool cannot answer, printed rather than written (ADR-004): the writable
 * layer is per-workspace, so a tool-written answer would be given again in every workspace. */
function sayAccountAnswers(host, merged) {
  const declared = host.routingPaths?.()?.overlays ?? [];
  const user = declared.find((l) => l.id === 'user') ?? declared[0] ?? null;
  const answers = merged.policy?.account ?? {};
  const named = Object.entries(answers).filter(([, block]) => block?.plan);
  for (const [harness, block] of named) {
    info(`account.${harness}.plan: "${block.plan}" · from overlay `
      + `"${merged.sources?.account?.[`${harness}.plan`] ?? 'unknown'}" · a person's answer, displayed and scored by nothing`);
  }
  if (!user) return;
  const missing = host.declaredTools().filter((h) => !answers[h]?.plan);
  if (!missing.length) return;
  info(`no plan name recorded for ${missing.join(', ')}. No command writes it: add `
    + `\`"account": { "<harness>": { "plan": "<name>" } }\` to ${user.path} (layer "${user.id}") `
    + 'if you want it displayed. It is display only and enters no score');
}

/** The alias dictionaries of the declared harnesses, through the registry and never by importing a
 * driver. A driver publishing no aliases contributes nothing, which is the honest answer. */
function aliasTables(host) {
  const out = {};
  for (const harness of host.declaredTools()) {
    let driver;
    try {
      driver = driverByHarness(harness);
    } catch {
      // A declared harness with no driver in the map is not this command's refusal: the workspace
      // names it, nothing can run it, and its records simply resolve no alias.
      continue;
    }
    const table = driver?.options?.modelAliases;
    if (table && typeof table === 'object') out[harness] = table;
  }
  return out;
}

/** The layer ADR-005 lets `--write` touch: the one whose id is `user`. Named by id and not taken
 * from `writable` — that one is per workspace, and a rating is not a property of one. */
function userLayer(host) {
  const declared = host.routingPaths?.()?.overlays ?? [];
  const layer = declared.find((l) => l.id === 'user');
  if (layer) return layer;
  throw new PromptobusError('overlay-invalid',
    declared.length
      ? `this host declares routing layers (${declared.map((l) => l.id).join(', ')}) and none of them `
        + 'is the account-scoped "user" layer, which is the only file calibrate may write'
      : 'this host declares no routing overlay at all, so there is nowhere to write calibrated ratings');
}

/** The proposed tuple/rating pairs named by the layers above `user`, with the highest writer kept. */
function shadowedRatings(host, target, proposed) {
  if (!Object.keys(proposed).length) return [];
  const declared = host.routingPaths?.()?.overlays ?? [];
  const index = declared.findIndex((layer) => layer.id === target.id);
  if (index < 0) return [];
  const byPair = new Map();
  for (const layer of declared.slice(index + 1)) {
    const upper = readLayerFile(layer.path).data;
    const ratings = upper?.ratings;
    if (!ratings || typeof ratings !== 'object' || Array.isArray(ratings)) continue;
    for (const [tuple, block] of Object.entries(proposed)) {
      const upperBlock = Object.hasOwn(ratings, tuple) ? ratings[tuple] : null;
      if (!upperBlock || typeof upperBlock !== 'object' || Array.isArray(upperBlock)) continue;
      for (const rating of Object.keys(block)) {
        if (Object.hasOwn(upperBlock, rating)) {
          byPair.set(JSON.stringify([tuple, rating]), { layer: layer.id, tuple, rating });
        }
      }
    }
  }
  const grouped = [];
  for (const { layer, tuple, rating } of byPair.values()) {
    let entry = grouped.find((item) => item.layer === layer && item.tuple === tuple);
    if (!entry) {
      entry = { layer, tuple, ratings: [] };
      grouped.push(entry);
    }
    entry.ratings.push(rating);
  }
  return grouped;
}

/** `models calibrate`. Three steps on purpose — read, ask the pure function, then merge with an
 * agreement in hand. Without a terminal it refuses unless `--yes` (ADR-005 option 5B). */
async function calibrateCommand(host, {
  json, write, yes, catalogFile, now, output, ask, stdin,
}) {
  // `--yes` is the record of an agreement to a WRITE. On its own it agrees to nothing, and
  // ignoring it would let `calibrate --yes` read as "applied" in a script that lost `--write`.
  if (yes && !write) {
    throw new GateError('models calibrate: --yes records agreement to a write and there is no write to '
      + 'agree to. Pass --write with it, or drop it — without --write the command only prints');
  }

  // The SHIPPED catalog and the merged stack, separately: comparing against the merged one would
  // make a person's own override the base of the next comparison and walk the rating (ADR-005).
  const shipped = readLayers(host, { catalogFile }).canonical.data?.tuples ?? [];
  const merged = loadCatalog({ host, catalogFile, now });
  const { file, records, skipped } = readTelemetry(host);
  const report = calibrate(records, {
    tuples: shipped,
    overlayTuples: merged.tuples ?? [],
    overlaySources: merged.sources?.ratings ?? null,
    aliases: aliasTables(host),
  });
  const moved = Object.keys(report.ratings).length;

  const layer = write ? userLayer(host) : null;
  const shadowedBy = write ? shadowedRatings(host, layer, report.ratings) : [];

  // Text mode shows the complete proposal before asking. `--json` stays one document — its
  // non-TTY refusal is still raised before that document is emitted.
  if (!json) {
    info(`telemetry file: ${file}${skipped ? ` · ${skipped} unparsable line(s) skipped` : ''}`);
    emit(output, renderCalibration(report));
  }

  if (write && !yes && !stdin?.isTTY) {
    throw new GateError('models calibrate --write: stdin is not a terminal, so there is nobody to ask. '
      + 'Pass --yes to record that the person already agreed to exactly these lines, '
      + 'or run the command in a terminal');
  }

  let agreed = !write || Boolean(yes);
  if (write && !yes && moved) {
    // The prompt goes to stderr (`defaultAsk`), so it never lands in the
    // document `--json` puts on stdout.
    const answer = await ask(`merge ${moved} rating override(s) `
      + `into overlay "${layer.id}" (${layer.path})? [y/N] `);
    agreed = /^y(es)?$/i.test(String(answer ?? '').trim());
  }

  // Read, merge, write — and only `ratings`. The merge is per tuple and per rating, so a tuple a
  // person overrode by hand keeps whatever they did NOT calibrate.
  let applied = false;
  if (write && agreed && moved) {
    const doc = writableDocument(layer);
    const ratings = { ...(doc.ratings ?? {}) };
    for (const [tuple, block] of Object.entries(report.ratings)) {
      ratings[tuple] = { ...(ratings[tuple] ?? {}), ...block };
    }
    // `schemaVersion` 2 is not a courtesy: a v1 overlay carrying a value on the rating scale is
    // refused by load and by validate, so writing the block without it breaks the stack.
    const next = { ...doc, schemaVersion: OVERLAY_SCHEMA_VERSION, ratings };
    writeFileAtomic(layer.path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    applied = true;
  }

  if (applied && shadowedBy.length) {
    const declared = host.routingPaths?.()?.overlays ?? [];
    const highest = shadowedBy.reduce((current, item) => (
      declared.findIndex((layerItem) => layerItem.id === item.layer)
        > declared.findIndex((layerItem) => layerItem.id === current.layer)
        ? item : current
    ), shadowedBy[0]).layer;
    const pairs = shadowedBy
      .map(({ tuple, ratings }) => `"${tuple}" (${ratings.join(', ')})`)
      .join(', ');
    warn(`what was just written is shadowed: overlay "${highest}" sits above `
      + `"${layer.id}" and names ratings for ${pairs}, so those values are what take effect`);
  }

  // One document on stdout under `--json` and nothing else: `ok` and `info` go to the console, so
  // a machine reading stdout would get the document with a sentence glued to its end.
  if (json) {
    emit(output, JSON.stringify({
      ...report,
      file,
      skipped,
      write: write
        ? { layer: layer.id, path: layer.path, tuples: moved, applied, shadowedBy }
        : null,
    }, null, 2));
    return 0;
  }

  if (!write) {
    if (moved) info(`to apply these lines: ${host.busCommand(['models', 'calibrate', '--write'])}`);
    return 0;
  }
  if (!moved) {
    info('--write: no rating moved, so there is nothing to merge. The overlay is untouched');
    return 0;
  }
  if (!applied) {
    info('nothing written');
    return 0;
  }
  ok(`merged ${moved} rating override(s) into overlay `
    + `"${layer.id}" (${layer.path}); every other key of that file is unchanged`);
  return 0;
}

/** `models validate`: the catalog and every overlay, with the layers named. */
function validateCommand(host, { catalogFile, now }) {
  const verdict = validate({ host, catalogFile, now });
  info(`layers: ${verdict.layers
    .map((l) => `${l.id} ${l.present ? l.path : '(absent)'}${l.writable ? ' [writable]' : ''}`)
    .join('\n          ')}`);
  sayDenyRules(verdict);
  // The layer is printed the way an error prints it below: "is this mine?" is the
  // question the field was added for, and a person asks it here.
  for (const w of verdict.warnings) warn(`${w.code}${w.layer ? ` · ${w.layer}` : ''}: ${w.message}`);
  if (verdict.ok) {
    ok(`the catalog and ${verdict.layers.length - 1} overlay layer(s) hold`
      + `${verdict.warnings.length ? ` · ${verdict.warnings.length} warning(s)` : ''}`);
    return 0;
  }
  for (const e of verdict.errors) {
    bad(`${e.code} · ${e.layer}${e.at ? ` · ${e.at}` : ''}${e.rule ? ` · ${e.rule}` : ''}: ${e.message}`);
  }
  // The refusal carries the code of the FIRST finding, already printed above it: this is the
  // command that validates, so this is where `catalog-invalid` and `overlay-invalid` are raised.
  throw new PromptobusError(verdict.errors[0].code,
    `the routing catalog stack does not hold: ${verdict.errors.length} finding(s) above`);
}

/** What the resolver would pick right now, with the availability facts attached.
 * [guides/model-routing.md#availabilityof--the-decision-with-the-availability-facts-it-was-made-on-attached](../docs/guides/model-routing.md#availabilityof--the-decision-with-the-availability-facts-it-was-made-on-attached) */
export function availabilityOf(snapshot) {
  return Object.entries(snapshot?.harnesses ?? {}).map(([harness, entry]) => {
    // Through the snapshot's own projection, not around it: `snapshotEntry` rebuilds every field
    // it declares, so no field of a future version rides along into a second document.
    const e = snapshotEntry(entry);
    const row = {
      harness,
      state: e.state,
      reason: e.reason,
      checkedAt: e.checkedAt,
      source: e.source,
    };
    if ('tier' in e) row.tier = e.tier;
    if ('spendControlReached' in e) row.spendControlReached = e.spendControlReached;
    if (e.credits) row.credits = e.credits;
    if (e.resetCredits) row.resetCredits = e.resetCredits;
    if (e.windows?.length) row.windows = e.windows;
    return row;
  });
}

/** The decision with that block attached, or the decision itself when the snapshot carried no harness. */
function withAvailability(decision, snapshot) {
  const harnesses = availabilityOf(snapshot);
  return harnesses.length ? { ...decision, harnesses } : decision;
}

export async function models(rootOrHost, {
  strategy = undefined,
  role = DEFAULT_ROLE,
  refresh = false,
  json = false,
  clearExhausted: clearHarness = null,
  subcommand = null,
  set: setStrategy = null,
  clear: clearStrategy = false,
  write = false,
  yes = false,
  // The confirmation seam of `calibrate --write`, and the stream its TTY is read from. Both are
  // arguments so the suite can drive the agreed path and the refused one without a terminal.
  ask = defaultAsk,
  stdin = process.stdin,
  catalogFile = CATALOG_FILE,
  adapterFor = adapterOf,
  now = Date.now(),
  output = undefined,
} = {}) {
  const host = hostOf(rootOrHost);
  if (clearHarness) return clearCommand(host, clearHarness);
  const hasSet = setStrategy !== null && setStrategy !== undefined;
  if (hasSet && subcommand !== 'strategy') {
    throw new GateError('models strategy --set <name>: --set belongs to the strategy subcommand');
  }
  if (clearStrategy && subcommand !== 'strategy') {
    throw new GateError('models strategy --clear: --clear belongs to the strategy subcommand');
  }
  if (write && subcommand !== 'calibrate') {
    throw new GateError('models calibrate --write: --write belongs to the calibrate subcommand');
  }
  if (yes && subcommand !== 'calibrate') {
    throw new GateError('models calibrate --write --yes: --yes belongs to the calibrate subcommand');
  }
  if (subcommand === 'validate') return validateCommand(host, { catalogFile, now });
  if (subcommand === 'calibrate') {
    return calibrateCommand(host, {
      json, write, yes, catalogFile, now, output, ask, stdin,
    });
  }
  if (subcommand === 'strategy') {
    return strategyCommand(host, {
      set: setStrategy, clear: clearStrategy, catalogFile, now,
    });
  }
  if (subcommand) {
    throw new GateError(`models: unknown subcommand "${subcommand}" — `
      + 'the three are "validate", "strategy" and "calibrate"');
  }

  // `models` answers what the resolver would pick right now, so it reads the same default `spawn`
  // and `review` do. Below a recorded default sits `balanced`, not nothing.
  const wanted = effectiveStrategy(host, { strategy, catalogFile, now })
    ?? { strategy: DEFAULT_STRATEGY, source: null };
  const ctx = await routingContext(host, {
    strategy: wanted.strategy,
    strategySource: wanted.source === 'flag' ? null : wanted.source,
    role,
    refresh,
    dryRun: !refresh,
    catalogFile,
    adapterFor,
    now,
    permitEmptyCandidates: true,
  });
  const decision = withAvailability(ctx.decide(), ctx.snapshot);
  emit(output, json ? `${JSON.stringify(decision, null, 2)}` : render(decision));
  // Two notes travel BESIDE the document and only on the text run: `--json` prints one document a
  // machine parses, and neither the account question nor the telemetry count is a field of it.
  if (!json) {
    sayAccountAnswers(host, ctx.policy);
    info(telemetryLine(host));
  }
  return 0;
}
