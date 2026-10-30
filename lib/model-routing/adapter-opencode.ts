// OpenCode adapter: version, model list, and local-estimate windows from `opencode stats`.
// [guides/model-routing.md](../../docs/guides/model-routing.md#opencode-adapter-what-the-probe-reads)
import { spawnAndCapture, verdict } from './adapter-common.js';
import { OFF_ALLOWANCE_FLAG } from './cache.js';
import { loadCatalog } from './catalog.js';

import type { PromptobusHost } from '../../dist/index.js';
import type { AvailabilityWindow } from './cache.js';
import type { AdapterModel, AdapterVerdict, CaptureResult, RoutingAdapter } from './adapter-common.js';

interface OpenCodeAccount { denySuffixes?: string[]; allowance?: { monthlyTokens?: number } }
interface OpenCodeDependencies {
  capture?: (bin: string, argv: readonly string[], timeoutMs: number) => Promise<CaptureResult>;
  accountOf?: (host: PromptobusHost) => OpenCodeAccount | Promise<OpenCodeAccount>;
}
interface StatsTokens { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown; write?: unknown } }
interface StatsRow { model?: { providerID?: unknown; id?: unknown }; tokens?: StatsTokens }

/** The binary. The same name is what the host is asked to resolve. */
const TOOL = 'opencode';

/** argv printing the version: `opencode v2.0.20`. */
const VERSION_ARGV = ['--version'];

/** argv listing model ids, one `provider/model` per line. */
const MODELS_ARGV = ['models'];

/** OpenCode Go shares of the monthly token allowance. Session is the 5-hour window. */
export const OPENCODE_WINDOW_SHARES = Object.freeze({ session: 0.2, weekly: 0.5 });

/** Lengths those shares are applied to. Stats has no 5-hour flag; session usage is `--days 0`. */
export const OPENCODE_WINDOW_LENGTH_SEC = Object.freeze({
  session: 5 * 60 * 60,
  weekly: 7 * 24 * 60 * 60,
});

/** The stats invocations. `--json` because the text table truncates model ids. */
export const OPENCODE_STATS_ARGV = Object.freeze({
  session: Object.freeze(['stats', '--days', '0', '--models', '--json']),
  weekly: Object.freeze(['stats', '--days', '7', '--models', '--json']),
});

/** Suffixes that always receive `off-allowance`. An overlay's `denySuffixes` extends this list. */
export const OPENCODE_DENIED_SUFFIXES = Object.freeze(['-free', '-contributor']);

const SUFFIX_RE = /^-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function parseWarm(text: unknown) {
  const hit = String(text ?? '').match(/(\d+)\.(\d+)\.(\d+)/);
  return hit ? { major: Number(hit[1]), minor: Number(hit[2]), patch: Number(hit[3]) } : null;
}

function parseModelList(text: unknown) {
  const models = [];
  for (const line of String(text ?? '').split('\n')) {
    const id = line.trim();
    if (!id || /\s/.test(id) || !id.includes('/')) continue;
    models.push(id);
  }
  return [...new Set(models)].sort();
}

function tokenPart(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/** The stats table's tokens column. A missing or non-numeric part is unreadable, not zero. */
function tokenTotal(tokens: StatsTokens | null | undefined) {
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return null;
  const cache = tokens.cache && typeof tokens.cache === 'object' && !Array.isArray(tokens.cache)
    ? tokens.cache : null;
  if (!cache) return null;
  const parts = [tokens.input, tokens.output, tokens.reasoning, cache.read, cache.write].map(tokenPart);
  if (parts.some((n) => n === null)) return null;
  return (parts as number[]).reduce((sum, n) => sum + n, 0);
}

function parseStats(text: unknown) {
  let doc: { models?: StatsRow[] } | null;
  try {
    doc = JSON.parse(String(text ?? ''));
  } catch {
    return null;
  }
  if (!doc || !Array.isArray(doc.models)) return null;
  const usage = new Map<string, number>();
  for (const row of doc.models) {
    const provider = row?.model?.providerID;
    const id = row?.model?.id;
    if (typeof provider !== 'string' || !provider || typeof id !== 'string' || !id) continue;
    const tokens = tokenTotal(row.tokens);
    if (tokens === null) return null;
    const key = `${provider}/${id}`;
    usage.set(key, (usage.get(key) ?? 0) + tokens);
  }
  return usage;
}

function suffixesOf(account: OpenCodeAccount | null | undefined) {
  const extra = Array.isArray(account?.denySuffixes) ? account.denySuffixes : [];
  return [...new Set([...OPENCODE_DENIED_SUFFIXES, ...extra.filter((s) => SUFFIX_RE.test(s))])];
}

function modelRow(id: string, suffixes: string[]) {
  const row: AdapterModel = { model: id };
  if (suffixes.some((suffix) => id.endsWith(suffix))) row.flags = [OFF_ALLOWANCE_FLAG];
  return row;
}

function usedPercent(tokens: number, monthlyTokens: number, share: number) {
  const budget = monthlyTokens * share;
  if (!(budget > 0) || typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return null;
  const pct = (tokens / budget) * 100;
  if (!Number.isFinite(pct) || pct < 0) return null;
  return Math.min(100, pct);
}

function windowsFor(models: string[], sessionUsage: Map<string, number>, weeklyUsage: Map<string, number>, monthlyTokens: number | undefined) {
  const allowance = Number.isInteger(monthlyTokens) && monthlyTokens! > 0 ? monthlyTokens! : null;
  const out: AvailabilityWindow[] = [];
  for (const model of models) {
    const rows: [string, string, Map<string, number>, number, number][] = [
      ['session', '5h', sessionUsage, OPENCODE_WINDOW_LENGTH_SEC.session, OPENCODE_WINDOW_SHARES.session],
      ['weekly', '7d', weeklyUsage, OPENCODE_WINDOW_LENGTH_SEC.weekly, OPENCODE_WINDOW_SHARES.weekly],
    ];
    for (const [kind, prefix, usage, lengthSec, share] of rows) {
      const window: AvailabilityWindow = {
        id: `${prefix}:${model}`,
        kind,
        lengthSec,
        scope: { model, models: [model] },
        estimate: 'local-estimate',
        resetAt: null,
      };
      if (allowance !== null) {
        const pct = usedPercent(usage.get(model) ?? 0, allowance, share);
        if (pct === null) continue;
        window.usedPercent = pct;
      }
      out.push(window);
    }
  }
  return out;
}

async function accountOf(host: PromptobusHost, deps: OpenCodeDependencies): Promise<OpenCodeAccount> {
  if (deps.accountOf) return deps.accountOf(host);
  if (!host?.routingPaths) return {};
  try {
    return (loadCatalog({ host }).policy?.account?.opencode as OpenCodeAccount | undefined) ?? {};
  } catch {
    return {};
  }
}

async function captureArgv(capture: typeof spawnAndCapture, bin: string, argv: readonly string[], timeoutMs: number): Promise<CaptureResult | { timedOut: true; status: null; stdout: string; error?: never }> {
  if (!(timeoutMs > 0)) return { timedOut: true, status: null, stdout: '' };
  return capture(bin, argv, timeoutMs);
}

/** Successful version telemetry establishes binary response; auth is checked by the lift. */
export function opencodeAvailability(deps: OpenCodeDependencies = {}): RoutingAdapter {
  const capture = deps.capture ?? spawnAndCapture;
  return {
    tool: TOOL,
    readsVersion: true,
    probe: async ({ host, toolBin: tool, timeoutMs }) => {
      if (!tool) {
        return verdict('unknown', 'probe_failed', 'the host resolved no tool binary, so the harness was never asked');
      }
      if (!tool.ok || !tool.bin) {
        return verdict('unavailable', 'binary_missing',
          `no ${TOOL} binary on this machine — install it, or stop declaring this harness in the workspace`);
      }
      const deadline = Date.now() + timeoutMs;
      const left = () => deadline - Date.now();
      const answer = await captureArgv(capture, tool.bin, VERSION_ARGV, left());
      if (answer.timedOut) {
        return verdict('unknown', 'probe_timeout', 'opencode --version did not finish inside the preflight budget');
      }
      if (answer.error || answer.status !== 0) {
        return verdict('unknown', 'probe_failed', 'opencode --version could not be run', {});
      }
      const parsed = parseWarm(answer.stdout);
      const version = parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : null;
      const label = version ?? `unknown label ${JSON.stringify((answer.stdout ?? '').trim().split('\n')[0])}`;
      const versionFields = version ? { version } : {};
      const available = (message: string, extra: Partial<AdapterVerdict> = {}) => verdict('available', null, message, { ...versionFields, ...extra });
      const plain = `opencode ${label}; auth is checked by the lift`;
      const listed = await captureArgv(capture, tool.bin, MODELS_ARGV, left());
      const models = listed.timedOut || listed.error || listed.status !== 0
        ? []
        : parseModelList(listed.stdout);
      if (!models.length) {
        return verdict('unknown', 'probe_failed', `${plain}; the model list was not read`, {
          ...versionFields,
        });
      }
      const account = await accountOf(host, deps);
      const suffixes = suffixesOf(account);
      const inventory = {
        models: models.map((id) => modelRow(id, suffixes)),
        inventorySource: 'probe',
      };
      const session = await captureArgv(capture, tool.bin, OPENCODE_STATS_ARGV.session, left());
      const weekly = await captureArgv(capture, tool.bin, OPENCODE_STATS_ARGV.weekly, left());
      const sessionUsage = !session.timedOut && !session.error && session.status === 0
        ? parseStats(session.stdout) : null;
      const weeklyUsage = !weekly.timedOut && !weekly.error && weekly.status === 0
        ? parseStats(weekly.stdout) : null;
      if (!sessionUsage || !weeklyUsage) {
        return verdict('unknown', 'probe_failed', `${plain}; local-estimate windows were not read`, {
          ...versionFields, ...inventory,
        });
      }
      const monthlyTokens = account?.allowance?.monthlyTokens;
      const windows = windowsFor(models, sessionUsage, weeklyUsage, monthlyTokens);
      const allowance = Number.isInteger(monthlyTokens) && monthlyTokens! > 0
        ? 'against the declared monthly token allowance'
        : 'with no used percentage until account.opencode.allowance.monthlyTokens is set';
      return available(
        `${plain}; local-estimate windows from opencode stats ${allowance}`,
        { ...inventory, windows },
      );
    },
  };
}
