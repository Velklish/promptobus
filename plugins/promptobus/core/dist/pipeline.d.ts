import type { HostPipelineStep, PromptobusHost } from './host.js';
import type { DeclaredStep } from './registry.js';
import { PromptobusError } from './v1/errors.js';
export declare const PIPELINE_INVALID = "pipeline-invalid";
/** The registry door's step-name grammar, restated so the schema and a refusal can name the field. */
export declare const STEP_NAME_PATTERN = "^[a-z][a-z0-9-]{0,31}$";
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
/** The pipeline of an installation that declares none: the shipped registry's steps in order. */
export declare const DEFAULT_PIPELINE: Pipeline;
/** The steps a host answers: the owner first, then the gates, with declared lift fields. */
export declare function pipelineSteps(pipeline: Pipeline): readonly HostPipelineStep[];
/** The steps of a host's pipeline in order; the default ones while it declares none, or with no host. */
export declare function pipelineOf(host: Pick<PromptobusHost, 'pipeline'> | null | undefined): readonly HostPipelineStep[];
/** Whether a lift of this step takes a `--brief`: only a `writes-main-tree` step does. */
export declare function acceptsBrief(step: DeclaredStep): boolean;
/** The steps as a person reads them: names in order. */
export declare function pipelineText(steps: readonly DeclaredStep[]): string;
/** One refused field, with the line the load refusal and `models validate` print. */
export declare function pipelineFinding(layer: string, at: string, message: string): PipelineFinding;
/** The refusal of a declaration that does not hold: every finding's line, in order. */
export declare function pipelineRefusal(findings: readonly PipelineFinding[]): PromptobusError;
/** Check a `pipeline` value read from `file`; `instructions` resolve against `root`, the install root. */
export declare function readPipeline(raw: unknown, { root, file }: {
    root: string;
    file: string;
}): {
    pipeline: Pipeline | null;
    findings: PipelineFinding[];
};
/** What `models validate` reads of a host's pipeline: the steps it answers, or the findings that refuse it. */
export declare function pipelineVerdict(host: PromptobusHost | null | undefined): {
    steps: readonly DeclaredStep[] | null;
    findings: readonly PipelineFinding[];
};
