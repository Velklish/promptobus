// `promptobus models`, and the routing gate `spawn` and `review` stand on.
//
// Everything below the command exists already as a library: the catalog and its
// overlays ([model-routing/catalog.js](model-routing/catalog.js)), the checks
// behind `models validate` ([validate.js](model-routing/validate.js)), the
// budgeted preflight and the availability cache
// ([preflight.js](model-routing/preflight.js),
// [cache.js](model-routing/cache.js)), and the pure resolver and renderer
// ([resolver.js](model-routing/resolver.js), [render.js](model-routing/render.js)).
// This file is the only place they meet, and it is deliberately the ONE place:
// `spawn` and `review` route through the same gate as `models` prints, so the
// decision a person is shown is the decision a lift is made on.
//
// **The order inside the gate is not free.** Explicit constraints are validated
// against the merged catalog and `host.declaredTools()` BEFORE `resolve` is
// called, because `resolve` cannot tell them apart: a harness the workspace
// never declared is absent from the snapshot, and the resolver filters its
// tuples out rather than excluding them ([03-cli](../docs/reference/03-cli.md)
// § Resolver). Both cases would reach the person as `chosen: null` with an empty
// candidate list, and "you named a harness this workspace does not have" would
// be indistinguishable from "nothing survived filtering".
import { existsSync, readFileSync } from 'node:fs';

import { GateError, PromptobusError } from '../dist/index.js';
import { adapterOf } from './drivers.js';
import { hostOf } from './host.js';
import {
  bad, info, ok, warn, writeFileAtomic,
} from './util.js';
import {
  CATALOG_FILE, OVERLAY_SCHEMA_VERSION, STRATEGIES, loadCatalog, readLayerFile,
} from './model-routing/catalog.js';
import { clearExhausted, snapshotEntry } from './model-routing/cache.js';
import { preflight } from './model-routing/preflight.js';
import { render } from './model-routing/render.js';
import { telemetryLine } from './model-routing/telemetry.js';
import { ROLES, applicableWindows, resolve } from './model-routing/resolver.js';
import { validate } from './model-routing/validate.js';

/**
 * Strategy of a `models` call that names none.
 *
 * `models` is the command a person runs to ask what the resolver would do, and a
 * question with no strategy is still a question. `balanced` is the answer with
 * no thumb on any scale — ADR-003's own middle weight set. `spawn` and `review`
 * have no default at all: without `--strategy` they route nothing and take
 * today's path, which is the legacy check the whole series is written against.
 */
export const DEFAULT_STRATEGY = 'balanced';

/** Role a `models` call that names none is answered for. */
export const DEFAULT_ROLE = 'worker';

/** Write one already-terminated block to the command's output stream. */
function emit(output, text) {
  const chunk = text.endsWith('\n') ? text : `${text}\n`;
  if (output && typeof output.write === 'function') output.write(chunk);
  else process.stdout.write(chunk);
}

/**
 * Where the decision takes the moment its snapshot was assembled.
 *
 * `preflight` stamps its answer with the moment it ran, which is right only for
 * a run in which every entry came back from a probe. It is wrong for one that
 * asked nothing — the facts are as old as the cache is — and wrong again for a
 * mixed run, where one harness was probed and two were reused: the fresh stamp
 * would report the age of the freshest fact over the oldest one.
 *
 * So the stamp is the OLDEST entry's own `checkedAt`. A snapshot is only as
 * fresh as the stalest thing inside it, which is the same rule the cache TTL
 * cascade applies to a single entry, and it needs no second read of the file.
 * An entry the cache never held carries the epoch, so a first run reports its
 * facts as ageless rather than as freshly measured — the loud reading is the
 * true one, and the harness rows carry `stale_cache` beside it.
 *
 * `source` is how the entries themselves came back, and it stays the resolver's
 * to compute; this only chooses which stamp the age is measured from.
 */
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

/**
 * Explicit constraints against the merged catalog and the workspace declaration.
 *
 * Each named value is checked on its own, and that is the reference's wording:
 * a value that matches no tuple of the merged catalog is `constraint-unknown`.
 * A COMBINATION that matches nothing is not this refusal — every tuple then
 * carries a `constraint-mismatch` exclusion, and the decision explains which
 * half of the pair did it. A refusal here would replace that explanation with
 * a shorter one that says less.
 */
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

/**
 * The merged catalog, refusing on a layer that cannot be used.
 *
 * The merge is what a routed call needs, and the merge is all it runs: the full
 * `models validate` sweep — reference checks, weight sums, contradictions — is a
 * command a person types, not a toll on every lift, and its verdict is about
 * whether a person's files are RIGHT rather than whether this run can proceed.
 *
 * What the merge refuses on is a layer it cannot read or a `schemaVersion` it
 * does not know, and that arrives as one `GateError` sentence with no layer in
 * it. Which layer it was decides the code the person branches on, so the layers
 * are walked once to find the one that does not hold. The route out is named:
 * the whole picture is one command away.
 */
function mergedCatalog({ host, constraints, catalogFile, now }) {
  try {
    return loadCatalog({ host, constraints, catalogFile, now });
  } catch (e) {
    if (!(e instanceof GateError)) throw e;
    const layers = [{ id: 'catalog', path: catalogFile }, ...(host.routingPaths?.()?.overlays ?? [])];
    const broken = layers.find((l) => {
      if (!existsSync(l.path)) return false;
      try {
        return JSON.parse(readFileSync(l.path, 'utf8'))?.schemaVersion !== 1;
      } catch {
        return true;
      }
    }) ?? layers[0];
    throw new PromptobusError(broken.id === 'catalog' ? 'catalog-invalid' : 'overlay-invalid',
      `routing layer "${broken.id}" (${broken.path}) cannot be used: ${e.message}. `
      + 'The whole picture is one command away: `promptobus models validate`');
  }
}

/**
 * Everything a routed call needs, with the harnesses already asked.
 *
 * Returns `decide(liveParticipants)` rather than a decision because the two
 * halves have different clocks: the catalog and the preflight are the same for
 * the whole command and one of them is asynchronous, while the participants a
 * decision is measured against are known only once the task is resolved — which
 * is inside the plan, where nothing may await. So the awaiting half runs here
 * and hands the plan a pure function.
 *
 * `adapterFor` and `catalogFile` are seams: the suite routes against stand-in
 * adapters and a fixture catalog, and no test run may start a harness binary.
 */
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
} = {}) {
  const host = hostOf(rootOrHost);
  if (!STRATEGIES.includes(strategy)) {
    throw new PromptobusError('strategy-unknown',
      `--strategy: unknown value "${strategy ?? ''}" — allowed: ${STRATEGIES.join(', ')}. `
      + '"auto" is not one of them: classifying a task into a strategy is the orchestrating '
      + 'agent\'s decision, and the CLI is called with the concrete one');
  }
  if (!ROLES.includes(role)) {
    throw new PromptobusError('role-unknown', `--role: unknown value "${role ?? ''}" — allowed: ${ROLES.join(', ')}`);
  }
  const constraints = {
    harness: harness ?? null, model: model ?? null, effort: effort ?? null, allowPayg: allowPayg === true,
  };
  const declared = host.declaredTools();
  const policy = mergedCatalog({ host, constraints, catalogFile, now });
  checkConstraints(policy, declared, constraints);
  if (!declared.length) {
    throw new PromptobusError('candidates-empty',
      `this workspace declares no harness (${host.toolsManifestRel()}), so there is nothing to route to: `
      + 'the catalog is filtered by the declaration, and an empty declaration leaves no tuple at all');
  }

  const rated = (h, m) => (policy.tuples ?? []).some((t) => t.harness === h && t.model === m);
  const snapshot = agedSnapshot(await preflight({
    host, harnesses: declared, adapterFor, refresh, dryRun, rated,
  }));

  return {
    host,
    policy,
    snapshot,
    constraints,
    decide: (liveParticipants = []) => {
      const decision = resolve({
        role, strategy, constraints, policy, snapshot, liveParticipants, now,
      });
      // Only when the strategy was NOT named on the command line. A flag always
      // wins, and a document that recorded a source for it would be recording
      // where a value came from that came from the person — which is what the
      // absence of the field says.
      return strategySource ? { ...decision, strategySource } : decision;
    },
  };
}

/**
 * The refusal a decision with no pick becomes.
 *
 * The rendered decision travels inside the message rather than being printed
 * from here: a plan prints nothing — it is called as a pure function by the
 * suite — and the diagnostics a person needs are the same lines `models` shows.
 * Which code it carries is read off the candidates: when the explicit
 * constraints selected some tuples and every one of them fell to its harness
 * being down, the person named a combination that exists and cannot run
 * (`constraint-unavailable`); otherwise nothing survived filtering at all.
 */
export function noCandidate(decision) {
  // Which candidates the explicit values selected is read off the values, not
  // off the exclusion codes. A tuple the resolver dropped for a reason it
  // reaches FIRST — an overlay deny — never carries `constraint-mismatch`, so
  // reading the codes let a denied neighbour of another harness into the set
  // and turned "the account you named is spent" back into "nothing survived".
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

/**
 * The decision as it is kept on the participant.
 *
 * Compact on purpose: the record travels into `task.json` and is read by a
 * person through `promptobus status`, not replayed. What is kept is what the
 * ADR names — the strategy, the tuple, the score, the age of the snapshot the
 * pick was made on, the warnings, and whether the constraints narrowed
 * anything. Warnings keep their codes and not their prose: the vocabulary is
 * closed ([03-cli](../docs/reference/03-cli.md)), and the sentences behind the
 * codes belong to the run that produced them.
 *
 * `windows` is the exception to "compact", and it earns its place: it is the
 * applicable windows of the CHOSEN tuple as the snapshot had them at this
 * moment, and it is the starting value a later reader needs to say what this run
 * spent — the delta of those windows between the lift and the finish. Without it
 * the delta has no first term, and the moment passes: the cache entry is a
 * minute old by the time anything asks. The set is the resolver's own
 * `applicableWindows`, not a second definition of the word, so a run is measured
 * against the windows its pick was scored on. Empty when the harness has none.
 */
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

/**
 * Participants already up, as the resolver wants them: `{ harness, model, role }`.
 *
 * Three kinds of record are left out, and each for its own reason. The
 * orchestrator has no harness of its own — its record carries the registry
 * fallback, and counting it would put a live-participant penalty on whichever
 * harness that happens to name. A record with no model never lifted a session.
 * A dismissed participant is finished, and its slot is free. `exclude` is the
 * address being lifted right now: a restart is not its own neighbour.
 */
export function liveTuples(taskMeta, { exclude = null } = {}) {
  return (taskMeta?.participants ?? [])
    .filter((p) => p.role === 'worker' || p.role === 'reviewer')
    .filter((p) => p.metadata?.address !== exclude)
    .filter((p) => !p.metadata?.dismissed)
    .filter((p) => typeof p.metadata?.model === 'string' && p.metadata.model)
    .map((p) => ({ harness: p.harness, model: p.metadata.model, role: p.role }));
}

/**
 * The pick, from a context already built and the task the lift joins.
 *
 * Synchronous on purpose, and that is the whole reason `routingContext` hands
 * back a function instead of a decision. The asynchronous half — the catalog and
 * the preflight — needs nothing but the host, while the participants a decision
 * is measured against are known only once the task is resolved, which happens
 * inside a plan; `planReview` is called as a pure synchronous function by the
 * suite and may not await. So the awaiting happens outside and the deciding
 * happens where the facts are.
 *
 * A run with no candidate leaves through `noCandidate`: a refusal carrying the
 * rendered decision, raised while the caller has still written nothing.
 */
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

/**
 * The routing half of a lift in one call, or `null` when the call routes nothing.
 *
 * `null` is the whole legacy path: without `--strategy` this returns before it
 * has asked the host anything, and the caller keeps today's values. The check
 * lives here rather than at the call sites — two copies of it would drift, and
 * the one that drifted would consult `declaredTools()` on a plain spawn.
 */
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
  // The default is read BEFORE the legacy gate, and it is the only thing that
  // moved: a call with no `--strategy` and no default anywhere still returns
  // here having asked the host nothing but its overlay paths.
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

/**
 * The decision inside a `--dry-run` plan: the same document `models` prints,
 * indented under a heading like the rest of the plan. Rendered rather than
 * summarised — a dry run is where a person checks the pick before paying for it,
 * and a one-line summary hides the candidates that lost.
 */
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

/**
 * The bans in force, and who can lift each one.
 *
 * Printed because the whole point of ADR-004's union is met where a person meets
 * it rather than only in the ADR: a deny rule is lifted in the layer that wrote
 * it and nowhere else, and no allow list anywhere reaches a ban — deny is
 * applied after allow. A person reading `denied by policy` on a candidate row
 * otherwise has to work out which of three files to open.
 */
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

/**
 * The strategy a routed call will actually use, and where it came from.
 *
 * Precedence is ADR-004's, and it is the rule ADR-003 already fixed for
 * `--harness`, `--model` and `--effort`: a value a person typed is never
 * replaced. So `--strategy` first, then the merged `defaults.strategy`, then
 * `null` — and `null` is the legacy path, unchanged, which is what ADR-003's "a
 * call with no `--strategy` routes nothing" still means where no layer sets one.
 *
 * Reading the default costs the overlay files and nothing else: no probe, no
 * harness, no cache. That matters because this runs on EVERY `spawn`, including
 * the ones that route nothing.
 */
export function effectiveStrategy(host, { strategy, catalogFile = CATALOG_FILE, now = Date.now() } = {}) {
  if (strategy !== undefined && strategy !== null) return { strategy, source: 'flag' };
  let merged;
  try {
    merged = loadCatalog({ host, catalogFile, now });
  } catch (e) {
    // A broken layer is not this function's refusal to make. Returning `null`
    // takes the legacy path, and the very next thing a routed call does is load
    // the same stack through `mergedCatalog`, which raises the layer-named
    // refusal a person can act on. Raising a second, worse-worded one here would
    // only mean an unrouted `spawn` — which never reads a layer today — starts
    // failing on a file it does not use.
    if (e instanceof GateError) return null;
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

/**
 * `models strategy [--set <name> | --clear]`.
 *
 * The write keeps every other key of the file and creates it with a
 * `schemaVersion` when it is not there, because the layer is a person's file
 * that happens to hold one machine-written value — not a file the tool owns.
 * Atomic and `0600`, like the availability cache: a half-written overlay is a
 * routing stack that refuses to load, and the mode is what the host contract
 * asks of a file under a person's home.
 */
function strategyCommand(host, { set: setTo, clear, catalogFile, now }) {
  const merged = loadCatalog({ host, catalogFile, now });
  const current = merged.policy?.defaults?.strategy ?? null;
  const from = merged.sources?.defaults?.strategy ?? null;

  if (!setTo && !clear) {
    if (current) info(`strategy default: ${current} · set by overlay "${from}"`);
    else {
      info('strategy default: none — `spawn` and `review` without --strategy route nothing and take '
        + 'today\'s path. `promptobus models strategy --set <name>` records one');
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
  const doc = readLayerFile(layer.path).data ?? { schemaVersion: OVERLAY_SCHEMA_VERSION };

  // Nothing to clear is not a write. Creating a file to record the absence of a
  // key would leave an overlay on disk that says nothing, in a directory that
  // had none — and `--clear` twice would look like it did something the second
  // time.
  if (clear && doc.defaults?.strategy === undefined) {
    info(`no strategy default is set in overlay "${layer.id}" (${layer.path}) — nothing to clear`
      + `${current ? `. The effective default of ${current} comes from overlay "${from}"` : ''}`);
    return 0;
  }

  // The whole stack is read BEFORE anything is written, and that order is the
  // point: a broken layer above the writable one must refuse while the file on
  // disk is still the one the person had. Reading it afterwards printed "✔ set"
  // and then threw, which is the one sequence a person cannot act on.
  //
  // What it is read for: a host that marks a layer other than the
  // highest-precedence one writable creates a trap — the tool writes a value a
  // layer above it overrides, and the person is left wondering why their default
  // did not take (02-host).
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

/**
 * The one question the tool cannot answer, printed rather than written.
 *
 * ADR-004: nothing writes `account.<harness>.plan`. The writable layer is
 * per-workspace, so a tool-written answer would be given again in every
 * workspace — the opposite of "asked once" — and declaring a second writable
 * layer to carry one string would make "exactly one writable layer" false the
 * first time it was used. So `models` names the key, the value if there is one,
 * and the path of the layer to add it to, and a person or an agent adds the
 * line. The value is display only and enters no score.
 */
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

/** `models validate`: the catalog and every overlay, with the layers named. */
function validateCommand(host, { catalogFile, now }) {
  const verdict = validate({ host, catalogFile, now });
  info(`layers: ${verdict.layers
    .map((l) => `${l.id} ${l.present ? l.path : '(absent)'}${l.writable ? ' [writable]' : ''}`)
    .join('\n          ')}`);
  sayDenyRules(verdict);
  for (const w of verdict.warnings) warn(`${w.code}: ${w.message}`);
  if (verdict.ok) {
    ok(`the catalog and ${verdict.layers.length - 1} overlay layer(s) hold`
      + `${verdict.warnings.length ? ` · ${verdict.warnings.length} warning(s)` : ''}`);
    return 0;
  }
  for (const e of verdict.errors) {
    bad(`${e.code} · ${e.layer}${e.at ? ` · ${e.at}` : ''}${e.rule ? ` · ${e.rule}` : ''}: ${e.message}`);
  }
  // The refusal carries the code of the FIRST finding, and the findings are
  // already printed above it: this is the command that validates, so this is
  // where `catalog-invalid` and `overlay-invalid` are raised.
  throw new PromptobusError(verdict.errors[0].code,
    `the routing catalog stack does not hold: ${verdict.errors.length} finding(s) above`);
}

/**
 * `promptobus models` — what the resolver would pick right now.
 *
 * The command asks nothing of any harness unless `--refresh` says so: it is the
 * question a person types, and a question that starts three harness binaries
 * and waits out the preflight budget is not one. `--refresh` is therefore also
 * the only thing that writes a cache entry here.
 */
/**
 * The decision with the availability facts it was made on attached (ADR-004).
 *
 * The block is assembled HERE and not in the resolver, and that is the whole
 * reason it exists as a separate step. `resolve` is pure — no disk, no clock of
 * its own — and the snapshot is the command's, so the command is the one place
 * that holds both. What it must not do is let the two outputs read different
 * sources: `render` prints the decision document and nothing else, so the block
 * has to travel inside the document or `--json` would stop carrying what the
 * text shows.
 *
 * It is a PROJECTION, field by field, for the reason the cache projects: the
 * snapshot entry is already the closed shape, and copying it wholesale would put
 * whatever a future field holds into a second document with its own schema.
 *
 * The order is the snapshot's, which is the order the harnesses were declared in
 * — deterministic, and the same order the text output prints.
 *
 * Exported because the golden fixtures are reproduced twice and the two runs must
 * not disagree: the command check runs this command, and the resolver check calls
 * the pure function and composes the same block from the same snapshot. A second
 * copy of this projection in a test would be the second description of one
 * contract that the schemas and this package's grammars already work to avoid.
 */
export function availabilityOf(snapshot) {
  return Object.entries(snapshot?.harnesses ?? {}).map(([harness, entry]) => {
    // Through the snapshot's own projection, not around it: `snapshotEntry`
    // rebuilds every field it declares, so nothing here shares an object with
    // the snapshot and no field of a future version rides along into a second
    // document with its own schema. It is idempotent on an entry the cache
    // already projected, which is the only kind that reaches here.
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
  catalogFile = CATALOG_FILE,
  adapterFor = adapterOf,
  now = Date.now(),
  output = undefined,
} = {}) {
  const host = hostOf(rootOrHost);
  if (clearHarness) return clearCommand(host, clearHarness);
  if (subcommand === 'validate') return validateCommand(host, { catalogFile, now });
  if (subcommand === 'strategy') {
    return strategyCommand(host, {
      set: setStrategy, clear: clearStrategy, catalogFile, now,
    });
  }
  if (subcommand) {
    throw new GateError(`models: unknown subcommand "${subcommand}" — the two are "validate" and "strategy"`);
  }

  // `models` answers "what would the resolver pick right now", so it has to read
  // the same default `spawn` and `review` do — otherwise `models strategy --set
  // balance` and `models` would disagree about what is in force, and the
  // near-limit line, which falls silent when it would propose the running
  // strategy, would never fall silent. Below the recorded default sits
  // `balanced` rather than nothing: a question with no strategy is still a
  // question, and `balanced` is the answer with no thumb on any scale.
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
  });
  const decision = withAvailability(ctx.decide(), ctx.snapshot);
  emit(output, json ? `${JSON.stringify(decision, null, 2)}` : render(decision));
  // Two notes that travel BESIDE the document rather than in it, and both only
  // on the text run: `--json` prints one document a machine parses, and neither
  // of these is a field of it.
  //
  // The one question the tool cannot answer is a note telling a person which
  // line to add to which file (ADR-004); the only place in the document it could
  // live is the availability block, whose shape belongs to the snapshot
  // contract. The telemetry line is a count and a size, no analysis (PB-37).
  if (!json) {
    sayAccountAnswers(host, ctx.policy);
    info(telemetryLine(host));
  }
  return 0;
}
