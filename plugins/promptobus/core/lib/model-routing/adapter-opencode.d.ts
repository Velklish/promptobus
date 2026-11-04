import type { PromptobusHost } from '../../dist/index.js';
import type { CaptureResult, RoutingAdapter } from './adapter-common.js';
interface OpenCodeAccount {
    denySuffixes?: string[];
    allowance?: {
        monthlyTokens?: number;
    };
}
interface OpenCodeDependencies {
    capture?: (bin: string, argv: readonly string[], timeoutMs: number) => Promise<CaptureResult>;
    accountOf?: (host: PromptobusHost) => OpenCodeAccount | Promise<OpenCodeAccount>;
}
/** OpenCode Go shares of the monthly token allowance. Session is the 5-hour window. */
export declare const OPENCODE_WINDOW_SHARES: Readonly<{
    session: 0.2;
    weekly: 0.5;
}>;
/** Lengths those shares are applied to. Stats has no 5-hour flag; session usage is `--days 0`. */
export declare const OPENCODE_WINDOW_LENGTH_SEC: Readonly<{
    session: number;
    weekly: number;
}>;
/** The stats invocations. `--json` because the text table truncates model ids. */
export declare const OPENCODE_STATS_ARGV: Readonly<{
    session: readonly string[];
    weekly: readonly string[];
}>;
/** Suffixes that always receive `off-allowance`. An overlay's `denySuffixes` extends this list. */
export declare const OPENCODE_DENIED_SUFFIXES: readonly string[];
/** Successful version telemetry establishes binary response; auth is checked by the lift. */
export declare function opencodeAvailability(deps?: OpenCodeDependencies): RoutingAdapter;
export {};
