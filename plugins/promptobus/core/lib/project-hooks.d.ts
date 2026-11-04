export declare const TRUST_CONFIG = "promptobus.json";
type HookHarness = 'codex' | 'cursor';
interface HookJudgment {
    accepted: {
        key: string;
        command: string;
    }[];
    refused: string[];
    broken: string | null;
}
/** The trust rule as a sentence without its full stop, for a message about `root`'s hooks file of `harness`. */
export declare function trustRule(root: string, harness: HookHarness): string;
/** Trusted records as `{ key, command }`, every other record as its text, and why the declaration is unusable.
 * `declaration` stands in for the declaration file's text (`null`: none); `guard` is the lift's guard command. */
export declare function judgeHookRecords(text: string, root: string, harness: HookHarness, { declaration, guard }?: {
    declaration?: string | null;
    guard?: string | null;
}): HookJudgment;
export {};
