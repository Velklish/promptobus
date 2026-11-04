import { mergeRouting } from './catalog.js';
import type { DeclaredStep, PromptobusHost } from '../../dist/index.js';
import type { RoutingSources } from './catalog.js';
type ValidationCode = 'catalog-invalid' | 'overlay-invalid' | 'pipeline-invalid';
type MergeOptions = NonNullable<Parameters<typeof mergeRouting>[0]>;
export interface ValidationFinding {
    code: ValidationCode;
    layer: string;
    at: string;
    message: string;
    rule?: string;
    line?: string;
}
export interface ValidationWarning {
    code: string;
    message: string;
    layer?: string;
    at?: string;
    [key: string]: unknown;
}
interface ShapeFinding {
    at: string;
    note: string;
}
interface ValidationLayer {
    id: string;
    path?: string;
    present: boolean;
    data: unknown;
    writable?: boolean;
    failure?: {
        code: ValidationCode;
        note: string;
    };
}
interface ValidationVerdict {
    ok: boolean;
    errors: ValidationFinding[];
    warnings: ValidationWarning[];
    rules?: RoutingSources['rules'];
}
interface StackVerdict extends ValidationVerdict {
    layers: {
        id: string;
        path: string;
        present: boolean;
        writable: boolean;
    }[];
}
interface ValidationLayersOptions {
    canonical?: ValidationLayer;
    overlays?: ValidationLayer[];
    constraints?: MergeOptions['constraints'];
    steps?: readonly DeclaredStep[];
    now?: number;
}
export interface ValidationOptions {
    host?: PromptobusHost | null;
    constraints?: MergeOptions['constraints'];
    catalogFile?: string;
    now?: number;
}
export declare const WEIGHT_KEYS: string[];
/** Harnesses this CLI can actually launch. A tuple naming anything else is unroutable by construction. */
export declare function knownHarnesses(): string[];
/** Effort levels of one harness, from that driver's own dictionary. Unknown harness — an empty list. */
export declare function effortLevelsOf(harness: string): string[];
/** Grammar of the shipped catalog. Returns a list of `{ at, note }`; empty means the shape holds. */
export declare function checkCatalogShape(doc: unknown): ShapeFinding[];
/** Grammar of one overlay. Every field is optional except `schemaVersion`. */
export declare function checkOverlayShape(doc: unknown, stepNames?: readonly string[]): ShapeFinding[];
/** Validate a stack already in memory. Pure. The grammar gate is deliberate: semantic checks
 * run only on layers whose shape held, or a broken file answers with a stack trace. */
export declare function validateLayers({ canonical, overlays, constraints, steps, now }?: ValidationLayersOptions): ValidationVerdict;
/** The routing stack and the host's pipeline declaration, each finding in one list; `pipeline` is the
 * steps in order, `null` when the declaration is refused. */
export declare function validate(options?: ValidationOptions): StackVerdict & {
    pipeline: readonly DeclaredStep[] | null;
};
export {};
