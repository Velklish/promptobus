// The declared pipeline: one owner step, the gate steps in order, their defaults and the rules a
// declaration obeys. The prose is 02-host § The pipeline declaration.
import { statSync } from 'node:fs';
import path from 'node:path';
import type { HostPipelineStep, PromptobusHost } from './host.js';
import {
  defaultFloor, EDITS_TREE, SHIPPED_REGISTRY, STEP_KINDS, withSteps, WRITES_MAIN_TREE,
} from './registry.js';
import type { DeclaredStep, RoleEntry, RoleRegistry, StepKind } from './registry.js';
import { PromptobusError } from './v1/errors.js';

export const PIPELINE_INVALID = 'pipeline-invalid';

/** The registry door's step-name grammar, restated so the schema and a refusal can name the field. */
export const STEP_NAME_PATTERN = '^[a-z][a-z0-9-]{0,31}$';
const STEP_NAME_RE = new RegExp(STEP_NAME_PATTERN);

const PIPELINE_FIELDS = ['owner', 'gates'];
const OWNER_FIELDS = ['name', 'kind'];
const GATE_FIELDS = ['name', 'kind', 'instructions', 'qualityFloor'];
const GOVERNANCE = SHIPPED_REGISTRY.entries.filter((e) => e.layer === 'governance').map((e) => e.name);

export interface PipelineStep extends DeclaredStep {
  /** Absolute path of the file whose text joins the step's lift prompt; `null` — none. */
  readonly instructions: string | null;
  readonly qualityFloor: number;
  /** The declared value, before the kind's default fills an absent floor. */
  readonly declaredQualityFloor?: number;
}

export interface Pipeline {
  readonly owner: PipelineStep;
  readonly gates: readonly PipelineStep[];
}

/** One refused field. `line` is the text the load refusal and `models validate` both print. */
export interface PipelineFinding {
  readonly code: typeof PIPELINE_INVALID;
  readonly layer: string;
  readonly at: string;
  readonly message: string;
  readonly line: string;
}

function shipped(e: RoleEntry): PipelineStep {
  return Object.freeze({ name: e.name, kind: e.kind as StepKind, instructions: null, qualityFloor: e.floor as number });
}

const SHIPPED_STEPS = SHIPPED_REGISTRY.entries.filter((e) => e.layer === 'step');

/** The pipeline of an installation that declares none: the shipped registry's steps in order. */
export const DEFAULT_PIPELINE: Pipeline = Object.freeze({
  owner: shipped(SHIPPED_STEPS.find((e) => e.kind === EDITS_TREE) as RoleEntry),
  gates: Object.freeze(SHIPPED_STEPS.filter((e) => e.kind !== EDITS_TREE).map(shipped)),
});

/** The steps a host answers: the owner first, then the gates, with declared lift fields. */
export function pipelineSteps(pipeline: Pipeline): readonly HostPipelineStep[] {
  return Object.freeze([pipeline.owner, ...pipeline.gates].map(({ name, kind, instructions, declaredQualityFloor }) => Object.freeze({
    name, kind, ...(instructions === null ? {} : { instructions }),
    ...(declaredQualityFloor === undefined ? {} : { qualityFloor: declaredQualityFloor }),
  })));
}

/** The steps of a host's pipeline in order; the default ones while it declares none, or with no host. */
export function pipelineOf(host: PromptobusHost | null | undefined): readonly HostPipelineStep[] {
  return host?.pipeline?.() ?? pipelineSteps(DEFAULT_PIPELINE);
}

/** Whether a lift of this step takes a `--brief`: only a `writes-main-tree` step does. */
export function acceptsBrief(step: DeclaredStep): boolean {
  return step.kind === WRITES_MAIN_TREE;
}

/** The steps as a person reads them: names in order. */
export function pipelineText(steps: readonly DeclaredStep[]): string {
  return steps.map((s) => s.name).join(' → ');
}

/** One refused field, with the line the load refusal and `models validate` print. */
export function pipelineFinding(layer: string, at: string, message: string): PipelineFinding {
  return Object.freeze({
    code: PIPELINE_INVALID, layer, at, message, line: `${PIPELINE_INVALID} · ${layer} · ${at}: ${message}`,
  });
}

/** The refusal of a declaration that does not hold: every finding's line, in order. */
export function pipelineRefusal(findings: readonly PipelineFinding[]): PromptobusError {
  return new PromptobusError(PIPELINE_INVALID, findings.map((f) => f.line).join('\n'), { findings });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFile(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

const quoted = (v: unknown) => `«${typeof v === 'string' ? v : JSON.stringify(v)}»`;

/** Check a `pipeline` value read from `file`; `instructions` resolve against `root`, the install root. */
export function readPipeline(raw: unknown, { root, file }: { root: string; file: string }): {
  pipeline: Pipeline | null;
  findings: PipelineFinding[];
} {
  const findings: PipelineFinding[] = [];
  const refuse = (at: string, message: string) => { findings.push(pipelineFinding(file, at, message)); };
  if (!isObject(raw)) {
    refuse('pipeline', `${quoted(raw)} is not a pipeline: an object with owner and gates`);
    return { pipeline: null, findings };
  }
  for (const key of Object.keys(raw)) {
    if (!PIPELINE_FIELDS.includes(key)) refuse(`pipeline.${key}`, `is not a field of a pipeline: ${PIPELINE_FIELDS.join(', ')}`);
  }
  const listed: { at: string; value: unknown; owner: boolean }[] = [];
  if (raw.owner === undefined) refuse('pipeline.owner', `is required: the one step of kind ${EDITS_TREE}`);
  else listed.push({ at: 'pipeline.owner', value: raw.owner, owner: true });
  if (!Array.isArray(raw.gates)) {
    refuse('pipeline.gates', raw.gates === undefined ? 'is required: a list of steps, which may be empty'
      : `${quoted(raw.gates)} is not a list of steps`);
  } else {
    raw.gates.forEach((value, i) => listed.push({ at: `pipeline.gates[${i}]`, value, owner: false }));
  }

  let registry: RoleRegistry = SHIPPED_REGISTRY;
  const named = new Map<string, string>();
  const steps: PipelineStep[] = [];
  for (const { at, value, owner } of listed) {
    const step = checkStep(at, value, owner, root, refuse);
    if (!step) continue;
    const first = named.get(step.name);
    if (first) {
      refuse(`${at}.name`, `${quoted(step.name)} is already the name of ${first}`);
      continue;
    }
    named.set(step.name, `${at}.name`);
    try {
      registry = withSteps(registry, [{ name: step.name, kind: step.kind }]);
    } catch (e) {
      refuse(`${at}.name`, (e as Error).message);
      continue;
    }
    steps.push(Object.freeze({
      ...step, qualityFloor: step.qualityFloor ?? defaultFloor(registry, step.name) as number,
      ...(step.qualityFloor === null ? {} : { declaredQualityFloor: step.qualityFloor }),
    }));
  }
  if (findings.length) return { pipeline: null, findings };
  return { pipeline: Object.freeze({ owner: steps[0], gates: Object.freeze(steps.slice(1)) }), findings };
}

function checkStep(
  at: string,
  value: unknown,
  owner: boolean,
  root: string,
  refuse: (at: string, message: string) => void,
): (Omit<PipelineStep, 'qualityFloor'> & { qualityFloor: number | null }) | null {
  if (!isObject(value)) {
    refuse(at, `${quoted(value)} is not a step: an object with name and kind`);
    return null;
  }
  const fields = owner ? OWNER_FIELDS : GATE_FIELDS;
  const refused = new Set<string>();
  const refuseField = (field: string, message: string) => { refused.add(field); refuse(`${at}.${field}`, message); };
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) {
      refuseField(key, `is not a field of ${owner ? 'the owner step' : 'a gate step'}: ${fields.join(', ')}`);
    }
  }
  const { name, kind } = value;
  if (name === undefined) {
    refuseField('name', `is required: a step name is ${STEP_NAME_PATTERN}`);
  } else if (typeof name !== 'string' || !STEP_NAME_RE.test(name)) {
    refuseField('name', `${quoted(name)} is not a step name: a step name is ${STEP_NAME_PATTERN}`);
  } else if (GOVERNANCE.includes(name)) {
    refuseField('name', `${quoted(name)} is a governance role the package fixes (${GOVERNANCE.join(', ')}); `
      + 'a step cannot take its name');
  }
  if (kind === undefined) {
    refuseField('kind', `is required: ${owner ? EDITS_TREE : STEP_KINDS.filter((k) => k !== EDITS_TREE).join(' or ')}`);
  } else if (!STEP_KINDS.includes(kind as StepKind)) {
    refuseField('kind', `${quoted(kind)} is not a step kind: ${STEP_KINDS.join(', ')}`);
  } else if (owner && kind !== EDITS_TREE) {
    refuseField('kind', `the owner step is of kind ${EDITS_TREE}, not ${kind}`);
  } else if (!owner && kind === EDITS_TREE) {
    refuseField('kind', `a second ${EDITS_TREE} step: the owner step is the one that edits the tree, `
      + 'and two writers in one worktree are refused');
  }
  let instructions: string | null = null;
  if (value.instructions !== undefined && !refused.has('instructions')) {
    if (typeof value.instructions !== 'string' || !value.instructions.trim()) {
      refuseField('instructions', `${quoted(value.instructions)} is not a path: a file relative to the install root`);
    } else {
      instructions = path.resolve(root, value.instructions);
      const rel = path.relative(root, instructions);
      if (rel === '' || rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) {
        refuseField('instructions', `${quoted(value.instructions)} is outside the install root (${instructions})`);
      } else if (!isFile(instructions)) {
        refuseField('instructions', `${quoted(value.instructions)} is not a file (${instructions})`);
      }
    }
  }
  const floor = value.qualityFloor;
  if (floor !== undefined && !refused.has('qualityFloor')
    && (typeof floor !== 'number' || !Number.isInteger(floor) || floor < 1 || floor > 10)) {
    refuseField('qualityFloor', `${quoted(floor)} is not a quality floor: an integer from 1 through 10`);
  }
  if (refused.size) return null;
  return {
    name: name as string, kind: kind as StepKind, instructions, qualityFloor: floor === undefined ? null : floor as number,
  };
}

/** What `models validate` reads of a host's pipeline: the steps it answers, or the findings that refuse it. */
export function pipelineVerdict(host: PromptobusHost | null | undefined): {
  steps: readonly DeclaredStep[] | null;
  findings: readonly PipelineFinding[];
} {
  let steps: readonly DeclaredStep[];
  try {
    steps = pipelineOf(host);
    withSteps(SHIPPED_REGISTRY, steps);
  } catch (e) {
    if (e instanceof PromptobusError && e.code === PIPELINE_INVALID && Array.isArray(e.context.findings)) {
      return { steps: null, findings: e.context.findings as PipelineFinding[] };
    }
    return { steps: null, findings: [pipelineFinding('host', 'pipeline()', (e as Error).message)] };
  }
  return { steps, findings: [] };
}
