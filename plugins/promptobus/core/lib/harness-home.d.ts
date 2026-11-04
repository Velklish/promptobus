import type { PromptobusHost } from '../dist/index.js';
import type { LibRegistry } from './driver-runtime.js';
type HarnessHomeHost = Partial<Pick<PromptobusHost, 'harnessStateHome'>>;
type HarnessBinHost = Partial<Pick<PromptobusHost, 'resolveToolBin'>>;
/** Bind the host whose `harnessStateHome` answers here; the FIRST binding of a process
 * wins and a later one is ignored — why, in the reference named at the head of this file. */
export declare function bindHarnessHomes(host: HarnessHomeHost | null | undefined): Required<Partial<Pick<PromptobusHost, "harnessStateHome">>> | null;
/** The environment variable one harness's registry is named by. */
export declare function harnessHomeVar(harness: string): string;
/** The registry directory for `harness`; `GateError` when neither the environment nor a
 * bound host names one — a refusal rather than a default under the real home. */
export declare function harnessStateHome(harness: string, env?: NodeJS.ProcessEnv): string;
/** Bind the host whose `resolveToolBin` names a harness binary for the calls made AFTER a lift —
 * the state query and the stop; the FIRST binding wins, as above. [05-drivers.md § The harness binary after a lift](../docs/reference/05-drivers.md#the-harness-binary-after-a-lift-the-lifts-door-not-path) */
export declare function bindHarnessBins(host: HarnessBinHost | null | undefined): Required<Partial<Pick<PromptobusHost, "resolveToolBin">>> | null;
/** `{ bin }` the way the lift resolves it, or `{ bin: null, reason }` naming what was looked for.
 * No host bound — the bare name and `PATH`, as before any host existed. */
export declare function harnessBin(tool: string): {
    bin: string;
    reason: null;
} | {
    bin: null;
    reason: string;
};
export declare const POLL_ENV_KEYS: readonly ['HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'CLAUDE_CONFIG_DIR', 'PATH', 'Path', 'PATHEXT', 'ComSpec', 'COMSPEC', 'SystemRoot', 'WINDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TMUX_TMPDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'NODE_OPTIONS', 'NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'];
export declare function pollEnvironmentOf(env: NodeJS.ProcessEnv): Readonly<NodeJS.ProcessEnv>;
export declare function bindPollEnvironment(env: NodeJS.ProcessEnv): Readonly<NodeJS.ProcessEnv>;
export declare function commonPollEnvironment(): NodeJS.ProcessEnv;
export interface HarnessContext {
    homes: Record<string, string | null>;
    bins: Record<string, string | null>;
    searchPath: string | null;
    pollEnvironment: Readonly<NodeJS.ProcessEnv>;
}
type HarnessContextHost = Pick<PromptobusHost, 'declaredTools' | 'harnessStateHome' | 'resolveToolBin'>;
export declare function serviceHarnessContext(host: HarnessContextHost, env: NodeJS.ProcessEnv, registry: Pick<LibRegistry, 'drivers'>, pollEnv?: NodeJS.ProcessEnv): HarnessContext;
export declare function requireServiceHarnessContext(expected: HarnessContext, host: HarnessContextHost, env: NodeJS.ProcessEnv, registry: Pick<LibRegistry, 'drivers'>, pollEnv?: NodeJS.ProcessEnv): void;
export declare function bindServiceHarnessContext(host: PromptobusHost, env: NodeJS.ProcessEnv, registry: Pick<LibRegistry, 'drivers'>): HarnessContext;
export {};
