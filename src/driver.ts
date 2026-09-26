// The driver contract.
// [reference/05-drivers.md#the-driver-contract](../docs/reference/05-drivers.md#the-driver-contract)
import { addressOf, GateError } from './protocol.js';
import type { HostMcpTool, HostToolBin, PromptobusHost } from './host.js';
import type { AvailabilityAdapter } from './model-routing.js';
import { PromptobusError } from './v1/errors.js';
import type { ParticipantMode, ParticipantV1, TaskV1 } from './v1/model.js';
import { putParticipant } from './v1/store.js';

/** How the participant is named to a person: the address if the adapter wrote one, otherwise the record id. */
function named(participant: ParticipantV1 | null | undefined): string {
  return addressOf(participant) ?? String(participant?.id ?? '');
}

/** How the participant is activated: the driver wakes the session itself (push) or the session polls (pull). */
export type Activation = 'push' | 'pull';

/** What the driver can do; the snapshot is stored in the participant record. Eleven flags in two
 * kinds: five declare OPERATIONS with a same-named method, six declare harness PROPERTIES. */
export interface DriverCapabilities {
  spawn: boolean;
  attach: boolean;
  activation: Activation;
  inspect: boolean;
  stop: boolean;
  /** Whether the harness can deny the session tools. Without it a read-only participant does not
   * exist, and `review` must refuse BEFORE launch rather than edit the code under review. */
  denyTools?: boolean;
  /** Whether the harness can mechanically deny canonical MCP write tools for a reviewer or
   * approver. Absent means MCP writes stay prompt-only for that harness. */
  mcpDenyTools?: boolean;
  /** Whether the harness takes its settings file or a system prompt for a single launch. Only the
   * capabilities SNAPSHOT reads it — a driver without one will not launch a participant at all. */
  systemPrompt?: boolean;
  /** Whether the harness has a session registry. Without it session state is unknown, not death.
   * The flag names the REASON for that unknown, rather than leaving a silent absent operation. */
  sessionList?: boolean;
  /** Whether a person can ENTER the session from a terminal. `attach` in the contract is taken by
   * the participant mode, so human entry is `enter` (glossary); the stall route is its branch. */
  enter?: boolean;
  /** Whether `review --approver` may lift on this harness. */
  approverLift?: boolean;
}

// Participant mode — a v1 record field (`managed` | `attached`), and it has no second
// declaration: the driver contract and the store schema must speak of the same thing.
export type { ParticipantMode } from './v1/model.js';

/** Session state in the snapshot: `alive`, `stale`, `gone` — and `unknown`, which is about the
 * OBSERVER, not the session. No consumer treats unknown as death. */
export type SessionState = 'alive' | 'stale' | 'gone' | 'unknown';

/** A harness refusal that names a time to retry after: the harness's words for that time, and the
 * instant they parse to — `null` when they do not. [05-drivers.md § A refusal that names a reset](../docs/reference/05-drivers.md#a-refusal-that-names-a-reset) */
export interface NamedReset {
  said: string;
  at: string | null;
}

/** Session stall as the driver named it: `kind` chooses the route, `reason` — words for a person. */
export interface SessionStall {
  kind: string;
  reason: string;
  /** Present only when the refusal named a time to retry after; the warden holds its knocks on it. */
  reset?: NamedReset;
}

// A limit word plus a retry phrase. A year is required to parse: `Date.parse` fills a missing one with 2001.
const RESET_PHRASE = /\b(?:try again at|resets(?:\s+at)?)\s+([^\n]+)/i;

/** The retry time a refusal names, or `null` when it names none. Harness-neutral: one fact, not a taxonomy.
 * `seen` is when the harness wrote the line: a wall time in a named zone means its next occurrence after that. */
export function namedReset(text: unknown, seen: number | null = null): NamedReset | null {
  const s = typeof text === 'string' ? text : '';
  if (!/\blimit\b/i.test(s)) return null;
  const said = RESET_PHRASE.exec(s)?.[1]?.trim().replace(/\.$/, '').trim();
  if (!said) return null;
  const plain = said.replace(/(\d)(?:st|nd|rd|th)\b/gi, '$1');
  const ms = /\b\d{4}\b/.test(plain) ? Date.parse(plain) : wallTimeAfter(plain, seen);
  return { said, at: Number.isFinite(ms) ? new Date(ms).toISOString() : null };
}

// `6:20am (Europe/Moscow)`: a 12-hour wall time and an IANA zone, nothing else. No zone, no time.
const WALL_TIME = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*\(([A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*)\)$/i;

function wallTimeAfter(said: string, seen: number | null): number {
  const m = WALL_TIME.exec(said);
  if (!m || seen === null || !Number.isFinite(seen)) return NaN;
  const [hour, minute] = [Number(m[1]), Number(m[2] ?? 0)];
  if (hour < 1 || hour > 12 || minute > 59) return NaN;
  const zone = m[4]!;
  let offset: (utc: number) => number;
  try {
    offset = zoneOffset(zone);
  } catch {
    return NaN;
  }
  const local = new Date(seen + offset(seen));
  const hh = (hour % 12) + (m[3]!.toLowerCase() === 'p' ? 12 : 0);
  for (let day = 0; day <= 1; day += 1) {
    const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day, hh, minute);
    const at = wall - offset(wall - offset(seen));
    if (at > seen) return at;
  }
  return NaN;
}

// The zone's offset from UTC at an instant, read back through `Intl`; an unknown zone throws RangeError.
function zoneOffset(zone: string): (utc: number) => number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  return (utc: number) => {
    const part = (type: string) => Number(fmt.formatToParts(utc).find((p) => p.type === type)?.value);
    const floor = utc - (((utc % 1000) + 1000) % 1000);
    return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) - floor;
  };
}

/** Whether a named reset still stands at `now`. A time that did not parse stands until the refusal clears. */
export function resetAhead(reset: NamedReset | null | undefined, now: number = Date.now()): boolean {
  if (!reset) return false;
  return reset.at === null || Date.parse(reset.at) > now;
}

/** The reset time for a person: the instant, or the harness's words marked as unread. */
export function resetText(reset: NamedReset): string {
  return reset.at ?? `a time the harness named as «${reset.said}», which does not parse`;
}

/** What the driver knows about one session right now. */
export interface SessionView {
  state: SessionState;
  /** Whether the session is busy with a turn. The driver does not know — `false`: unknown is not treated as busy. */
  busy: boolean;
  stall: SessionStall | null;
  /** Session identifier for the adapter's human routes. */
  id: string | null;
  /** The harness word about the state, for the adapter's human line. Core neither reads it nor
   * decides from it: each harness has its own vocabulary, and showing it is still possible. */
  note?: string | null;
}

/** Snapshot of participant sessions, keyed by ADDRESS as health and contact points are. `null` means
 * no state at all — NOT "everyone is alive"; a participant with no session reference is not listed. */
export type SessionSnapshot = Record<string, SessionView> | null;

/** Harness-neutral MCP descriptor: how the participant reaches the bus and the other servers. The
 * driver translates it into its own config and arguments. */
export interface McpDescriptor {
  address: string;
  task: string;
  home: string;
  servers: Record<string, unknown>;
}

/** A driver deny rule: plain harness ids, or structured MCP rules kept until prepare. */
export type DriverDenyTool = string | HostMcpTool;

/** Launch context: everything the driver needs and nothing about its harness. The consumer names the
 * SUBJECT; only the driver knows how that looks for the harness. */
export interface SpawnContext {
  /** Opaque session reference the driver later uses to recognise the session. */
  ref: string;
  address: string;
  task: string;
  home: string;
  mcp: McpDescriptor;
  prompt: string;
  cwd: string;
  /** Participant role — launch refusal wording depends on it. */
  role?: string;
  model?: string;
  effort?: string | null;
  permissionMode?: string | null;
  /** Directories outside `cwd` that the participant may read. */
  addDirs?: string[];
  /** Directory with workspace skills for one session. */
  pluginDir?: string | null;
  /** Where the driver puts its MCP config and its settings file. */
  mcpConfigPath?: string;
  settingsPath?: string;
  /** Loop-guard command: the driver wraps it in its own hook form. */
  guardCommand?: string;
  /** Tools taken from the participant (requires the `denyTools` capability). */
  denyTools?: DriverDenyTool[] | null;
  /** Workspace settings addressed to the participant: the driver puts them in its file. */
  extraSettings?: Record<string, unknown>;
  /** The environment the lift will pass. */
  env?: Record<string, string | undefined>;
  /** The rest is the consumer's business: the driver reads only what the contract named. */
  [key: string]: unknown;
}

/** A file the driver asks to place next to the session before launch. */
export interface LaunchFile {
  path: string;
  text: string;
  /** The file holds a secret (tokens) — write it with `0600` permissions. */
  secret: boolean;
}

/** Launch plan: the harness-neutral context as argv, configs and files. Assembled by ONE `prepare`
 * call, and the same object goes into `spawn`, so print and deed cannot diverge. */
export interface LaunchPlan {
  /** Launch arguments, excluding a prompt delivered through a non-positional channel. */
  argv: string[];
  /** Assignment text when the harness does not take it as a positional argument; such a driver
   * delivers it itself, for example through a `turn/start` request. */
  prompt?: string;
  /** Descriptive command line for `--dry-run` when `argv` alone is not runnable. Absent — the
   * consumer prints `<tool> <argv without the last element> <prompt>`. */
  dryRunCommand?: string;
  /** MCP config in the harness form: `--dry-run` reads it and the consumer writes it to disk. */
  mcpConfig: unknown;
  /** Settings file in the harness form. */
  settings: unknown;
  /** What will go to disk before launch. Order matters: the driver writes them in that order. */
  files: LaunchFile[];
  /** Session working directory when the driver chose NOT the one the caller named — needed where a
   * harness reads settings from its working directory, or configs would land in a foreign tree. */
  cwd?: string;
}

/** Harness words the adapter inserts into its lines. Shared text stays with the adapter; the
 * harness-specific command comes from here, or every printer would know the enter command. */
export interface DriverPhrases {
  /** Where a person sees their sessions — the command as they would type it. */
  sessions: string;
  /** Session list could not be parsed: that is what the harness calls it. */
  unreadable: string;
  /** Enter the session from a terminal (`enter` capability). */
  enter(id: string): string;
  /** Stop the session by a person's hand. */
  stop(id: string): string;
  /** View the session journal. */
  logs(id: string): string;
  /** How THIS harness names an MCP server tool. The host is passed because for one harness the
   * spelling carries the consumer's identity; a driver that does not depend on it ignores it. */
  tool(server: string, name: string, host: PromptobusHost): string;
  /** The reviewer's MCP boundary in this harness's own measured vocabulary. */
  mcpBoundary: string;
  /** Rules of THIS harness appended to the participant prompt — its headless habits. Empty means
   * nothing to append, and the prompt stays exactly what the caller assembled. */
  promptRules: string;
  /** What this harness calls the session when the mechanism does not choose the name: `--dry-run`
   * prints this, because a name the binary invents at start cannot be printed in advance. */
  naming?: string;
}

/** A session record the harness puts in its participant MCP server's environment. */
export interface McpIdentityRecord {
  /** Environment variable carrying the absolute record path. */
  recordVar: string;
  /** Record field carrying the harness session id stored on the participant. */
  idField: string;
}

/** Allowed option values and harness versions. The consumer does not know them and has no right to:
 * effort levels, permission modes and deniable tools are harness vocabulary, not the bus. */
export interface DriverOptions {
  /** Harness binary name: the adapter resolves its path by it. It matches the driver `id` by fact
   * rather than by rule — a registry key and an executable name are different subjects. */
  tool: string;
  /** Allowed effort values. */
  effortLevels: string[];
  /** Minimum harness version per effort level — where the value does not arrive with every version. */
  effortMinVersion?: Record<string, string>;
  /** Allowed permission modes and the one taken without a flag. */
  permissionModes: string[];
  defaultPermissionMode: string;
  /** Model the participant is launched with when there is no `--model` flag. The home is the driver:
   * one binary's default is refused by another as any unknown id. */
  defaultModel: string;
  /** Model alias the harness publishes → the full ids it resolves to today. The driver is the only
   * holder of this answer, since an alias points wherever the vendor moved it. */
  modelAliases?: Record<string, string[]>;
  /** Whether the harness takes the workspace skills directory for one session. Not declared means
   * "does not take", and the output says so rather than promising skills never received. */
  skillsDir?: boolean;
  /** Directories inside the participant's working directory this driver's launch files claim.
   * [reference/05-drivers.md#launch-directories-a-driver-claims](../docs/reference/05-drivers.md#launch-directories-a-driver-claims) */
  launchDirs?: string[];
  /** Tools taken from a read-only participant (`denyTools` capability). */
  denyTools: string[];
  /** Harness version on which the wake channel was proven. Not a gate — evidence. */
  provenVersion: string;
  /** The floor and the effort refusal need the binary's version. The preflight and a real lift
   * ask `readToolVersion` only when this is set. */
  readsVersion?: boolean;
  /** How the driver wakes the session: `socket`, `turn`, or `inject`. Not cosmetic — the suite's
   * stand-in channel substitutes delivery only where it truly is a socket. */
  knockChannel: string;
  /** Variable carrying the harness's OWN session id in a process it starts, or `null`. It answers
   * for a command the session runs, not for an MCP server child. See 02-host.md and ADR-010. */
  identityVar: string | null;
  /** Record proof for an MCP child, accepted only when home, task and address match. See 02-host.md and ADR-014. */
  mcpIdentity: McpIdentityRecord | null;
  /** Ancestor variables that must not reach the session. */
  envDrop: string[];
  /** Workspace utilities without which the driver will not launch: NAMES, not paths — resolve,
   * minimum version and refusal wording are the consumer's. Not declared means none. */
  utils?: string[];
}

/** What the wake-channel smoke saw. `endpoint === null` — the session does not hand one over at all. */
export interface WakeProbe {
  endpoint: string | null;
  ok: boolean;
  /** Reason in the harness words: what exactly is missing or what the socket answered. */
  error: string | null;
}

/** Where to knock: the participant opaque ref and the contact point it handed into the store. */
export interface ActivationTarget {
  ref: string | null;
  endpoint: { socket?: string | null; token?: string | null } | null;
}

/** Message extract for a notification: what the driver builds its text from. */
export interface NotificationMessage {
  id: string | null;
  type: string;
  from: string;
  ts: string;
  body: string;
  artifact: string | null;
}

/** A participant from whom there is nothing to wait for — as stall analysis named it. */
export interface StalledParticipant {
  address: string;
  /** Opaque session reference of the participant record. */
  ref: string | null;
  id: string | null;
  repoAbs: string | null;
  kind: string;
  reason: string;
  reset?: NamedReset;
  /** The record harness as it named it: the consumer needs it to ask the ROUTE of the same driver
   * that parsed the state. Absent from the record — `null`, and the registry `fallback` is taken. */
  harness: string | null;
}

/** Notification: what core asks to deliver. There is no text here on purpose — the driver renders it,
 * because the frame and the words belong to the harness channel, not the bus. */
export type Notification =
  { kind: 'unread'; task: string; address: string; unread: number; messages: NotificationMessage[] };

/** Stop outcome. Two flags, not one: `ok` says the operation did not refuse, `stopped` that a session
 * was actually stopped — nothing to stop is success, and must not print as "session closed". */
export interface StopResult {
  ok: boolean;
  stopped: boolean;
  note: string;
  /** The driver ISSUED the stop and could not confirm the session vanished. Without this flag
   * `stopped: false` would also mean "there was no session", and cleanup leaves the directory. */
  attempted?: boolean;
}

/** Activation outcome. This does not give a “delivered” flag — that one is the mailbox having been taken. */
export interface ActivateResult {
  ok: boolean;
  error?: string | null;
}

/** Harness driver. The operations declared in capabilities are the ones implemented. */
export interface Driver {
  readonly id: string;
  readonly capabilities: DriverCapabilities;
  /** Harness vocabulary. Required, not "if present": the CLI takes values from it at module top
   * level, so an optional field would turn a missing driver vocabulary into a crash on `--version`. */
  readonly options: DriverOptions;
  /** Harness strings for the adapter's human routes. Required for the same reason. */
  readonly phrases: DriverPhrases;
  /** Optional pre-launch binary normalization; absence keeps the host result unchanged. */
  normalizeTool?(tool: HostToolBin, context?: { env?: Record<string, string | undefined> }): HostToolBin;
  /** Translate the harness-neutral context into its launch plan. Writes nothing and starts nothing:
   * `--dry-run` prints exactly what `spawn` will execute. */
  prepare?(context: SpawnContext): LaunchPlan;
  /** Translate canonical host MCP write-tool identities into this harness's deny rules. */
  mcpDenyTools?(tools: readonly HostMcpTool[]): DriverDenyTool[];
  spawn?(plan: LaunchPlan, runtime: SpawnContext): Promise<unknown>;
  attach?(plan: LaunchPlan, runtime: SpawnContext): Promise<unknown>;
  /** What was said about the launch after success: unconfirmed check, unparsed id. */
  saidLiftoff?(result: unknown): void;
  inspect?(ref: string): SessionView | null;
  /** Remove the harness state of one closed participant that does NOT live in its worktree — the
   * one leak with no other cleanup path, and it may hold credentials. Must not throw. */
  sweepParticipant?(participant: unknown, taskId: string): unknown;
  /** Forget the remembered session list: after launch and stop it is stale. */
  forgetSessions?(): void;
  activate?(target: ActivationTarget, notification: Notification): Promise<ActivateResult> | ActivateResult;
  /** Notification text into this harness channel. Inside `activate`; outward — for the seam. */
  renderNotification?(notification: Notification): string;
  /** What a person should do with this stall, in their harness commands. The shared state words stay
   * with the adapter: they are one for all harnesses. */
  stallRoute?(stall: StalledParticipant & { task?: string | null }, id: string | null, ref: string | null): string;
  /** Hand the contact point of ITS OWN session into the task store: only the harness knows the socket address. */
  registerWake?(home: string, task: string, address: string, env?: unknown, session?: string | null): unknown;
  /** Whether the session transcript at this path holds a question to the user still unanswered.
   * Positive evidence only: anything unread or unrecognised is `false`. */
  awaitsUser?(transcript: string): boolean;
  /** Tell the supervisor journal that a write for a foreign address did not go through. */
  sayForeignWrite?(home: string, task: string, address: string, held: string, session: string | null, what: string): void;
  /** Wake-channel smoke for diagnostics: whether a socket was handed over and whether it accepts a connection. */
  checkWake?(env?: unknown): Promise<WakeProbe>;
  /** Environment of the session being launched: the caller's `extra` over the inherited one, with
   * ancestor leaks stripped. The second argument carries a lever the mechanism itself sets. */
  sessionEnv?(base: unknown, extra?: Record<string, string>): Record<string, string | undefined>;
  /** Refusal by harness version for the requested options, before the first write to disk. `null`
   * means nothing to refuse for: the version is fine, or it was not read and may not be claimed. */
  optionRefusal?(options: { effort?: string | null }, tool: unknown): string | null;
  /** Throws GateError naming the file, before the first write of this lift, when this harness
   * would load a project hooks file it does not write. Returns nothing when there is nothing to refuse. */
  refuseForeignProjectHooks?(lookupDir: string, writtenDir: string): void;
  /** Names of delivered MCP servers shadowed by a person's PERSONAL records. Personal config is a
   * harness property; the output line about shadowing is one for all. */
  shadowedUserServers?(names: string[]): string[];
  /** Stop the session. **It returns when the harness already has NO session**, or with an honest
   * `stopped: false` and a reason — cleanup follows the stop. The outcome may be a promise. */
  stop?(ref: string): StopResult | Promise<StopResult>;
  /** Availability adapter of this harness: what the ACCOUNT can do, asked before any session exists.
   * Its absence is a state, not an error — the registry answers `unknown` / `probe_failed`. */
  readonly availability?: AvailabilityAdapter;
}

/** `harness → driver` map, assembled by the consumer and passed in: core neither creates nor looks up
 * drivers. `fallback` is for a record with NO `harness` field; a non-empty unknown name refuses. */
export interface Registry {
  readonly drivers: Readonly<Record<string, Driver>>;
  readonly fallback: string | null;
}

export function createRegistry({ drivers, fallback = null }: {
  drivers: Record<string, Driver>;
  fallback?: string | null;
}): Registry {
  if (!drivers || typeof drivers !== 'object') throw new GateError('registry: a harness → driver map is required');
  for (const [harness, driver] of Object.entries(drivers)) {
    if (!driver?.id || !driver?.capabilities) {
      throw new GateError(`registry: driver «${harness}» has no id or capabilities — the contract is not met`);
    }
  }
  if (fallback !== null && !Object.hasOwn(drivers, fallback)) {
    throw new GateError(`registry: fallback «${fallback}» is not named in the harness → driver map`);
  }
  return { drivers: { ...drivers }, fallback };
}

/** Harness name of the record. Field absent entirely — the registry `fallback` is taken (a former-CLI record). */
export function harnessOf(participant: ParticipantV1 | null | undefined, registry: Registry): string | null {
  const declared = participant?.harness;
  if (typeof declared === 'string' && declared.trim()) return declared.trim();
  return registry.fallback;
}

/** Driver by harness name. Unknown — refusal, and the refusal is BEFORE any store write. */
export function driverFor(registry: Registry, harness: string | null | undefined): Driver {
  const known = Object.keys(registry.drivers);
  if (!harness) {
    throw new GateError('the participant harness is not named, and the registry declared no fallback — '
      + `known harnesses: ${known.join(', ') || 'none'}`);
  }
  const driver = registry.drivers[harness];
  if (!driver) {
    throw new GateError(`harness «${harness}» is unknown — known: ${known.join(', ') || 'none'}`);
  }
  return driver;
}

/** Whether the driver can do what is asked. Asked BEFORE the store changes: a declared capability
 * without an operation is the same refusal as an undeclared one. */
export function requireCapability(driver: Driver, op: 'spawn' | 'attach' | 'inspect' | 'stop'): void {
  if (!driver.capabilities?.[op]) {
    throw new GateError(`driver «${driver.id}» cannot ${op} — this operation is not declared by it`);
  }
  if (typeof (driver as unknown as Record<string, unknown>)[op] !== 'function') {
    throw new GateError(`driver «${driver.id}» declared ${op} but has no such operation`);
  }
}

/** Harness properties without their own operation: asked by the flag, not by method presence. */
export type DriverFeature = 'denyTools' | 'mcpDenyTools' | 'systemPrompt' | 'sessionList' | 'enter' | 'approverLift';

/** Whether the driver declared a harness property. Such flags have no operation, so an undeclared one
 * is read as "no" — the silent "it probably can" is what the flag exists against. */
export function hasFeature(driver: Driver, feature: DriverFeature): boolean {
  return driver.capabilities?.[feature] === true;
}

/** Whether the driver wakes on its own. A pull-driver does not wake the session — it organises its own polling. */
export function pushes(driver: Driver): boolean {
  return driver.capabilities?.activation === 'push';
}

/** Opaque session reference of the participant record. Former-CLI records carried it in `name`;
 * migration gave them a field of their own, and v1 has no second source. */
export function sessionRefOf(participant: ParticipantV1 | null | undefined): string | null {
  const ref = participant?.sessionRef;
  return typeof ref === 'string' && ref ? ref : null;
}

/** Write a participant the driver launched or attached to. The registry is asked FIRST: a refusal
 * after the write would leave a participant in the journal with nothing to wake it by. */
export function openParticipant(home: string, task: string, participant: ParticipantV1, registry: Registry, { mode = 'managed' as ParticipantMode } = {}): {
  driver: Driver; meta: TaskV1; record: ParticipantV1;
} {
  const driver = driverFor(registry, harnessOf(participant, registry));
  requireCapability(driver, mode === 'managed' ? 'spawn' : 'attach');
  const ref = sessionRefOf(participant);
  if (!ref) {
    throw new GateError(`participant ${named(participant)}: driver «${driver.id}» received no session reference — `
      + 'there will be nothing to recognise its session by later');
  }
  // The record is given to the caller in full: whoever appends a session id must put back THE SAME
  // record. A store refusal becomes a `GateError` — a busy journal is lawful for two lift commands.
  const record: ParticipantV1 = { ...participant, ...participantDriverFields(driver, { mode, ref }) };
  let meta: TaskV1;
  try {
    meta = putParticipant(home, task, record, () => new Date());
  } catch (e) {
    if (e instanceof PromptobusError) throw new GateError(e.message);
    throw e;
  }
  return { driver, meta, record };
}

/** Participant mode. Absent entirely means `managed` — the former CLI left spawn records. A
 * participant with no session reference has no mode: nobody launched a session behind it. */
export function modeOf(participant: ParticipantV1 | null | undefined): ParticipantMode | null {
  if (!sessionRefOf(participant)) return null;
  const raw = typeof participant?.mode === 'string' ? participant.mode.trim() : '';
  // Field absent entirely — `managed`: that is how the former CLI wrote participants, and spawn launched the session.
  if (!raw) return 'managed';
  // An unfamiliar non-empty value is a typo or junk from a hand edit, and a default here is
  // destructive: "if not attached, then managed" would stop a session the driver did not launch.
  return raw === 'managed' || raw === 'attached' ? raw : null;
}

/** Whether the driver owns this session: it launched it — it is the one to stop it. */
export function isManaged(participant: ParticipantV1 | null | undefined): boolean {
  return modeOf(participant) === 'managed';
}

/** Stop a participant session — a driver operation, not a command. Only `managed` may be stopped, and
 * the refusal is explicit; the outcome is awaited, since the driver may wait for the harness. */
export async function stopParticipant(participant: ParticipantV1, registry: Registry): Promise<StopResult> {
  const driver = driverFor(registry, harnessOf(participant, registry));
  requireCapability(driver, 'stop');
  const mode = modeOf(participant);
  if (mode !== 'managed') {
    // An unfamiliar value is named literally: "there is no mode" about a field with something in it
    // would read as "there is no field", and the two are fixed differently.
    const raw = typeof participant?.mode === 'string' ? participant.mode.trim() : '';
    const said = mode ?? (raw ? `«${raw}» — the contract does not know this mode` : 'there is no session behind it');
    throw new GateError(`participant ${named(participant)}: mode ${mode ? `«${mode}»` : said} — `
      + `driver «${driver.id}» did not launch this session and has no right to dispose of it`);
  }
  return driver.stop!(sessionRefOf(participant)!);
}

/** Driver fields in the participant record: harness, mode and the capabilities snapshot. */
export function participantDriverFields(driver: Driver, { mode, ref }: {
  mode: ParticipantMode;
  ref: string;
}): { harness: string; mode: ParticipantMode; sessionRef: string; capabilities: DriverCapabilities } {
  return {
    harness: driver.id,
    mode,
    sessionRef: ref,
    capabilities: { ...driver.capabilities },
  };
}

/** No one to ask: there is no driver, or it does not look. Neither death nor life — unknown. */
const UNKNOWN: SessionView = { state: 'unknown', busy: false, stall: null, id: null };

/** Snapshot of participant sessions, taken once per heartbeat. One unparsed session drops the whole
 * snapshot; one INVALID record does not — it gets `unknown`, and the walk goes on. */
export function snapshotSessions(participants: ParticipantV1[] | null | undefined, registry: Registry): SessionSnapshot {
  const view: Record<string, SessionView> = {};
  for (const p of participants ?? []) {
    const ref = sessionRefOf(p);
    const addr = addressOf(p);
    if (!addr || !ref) continue;
    let seen: SessionView | null;
    try {
      const driver = driverFor(registry, harnessOf(p, registry));
      if (!driver.capabilities?.inspect || typeof driver.inspect !== 'function') {
        view[addr] = UNKNOWN;
        continue;
      }
      seen = driver.inspect(ref);
    } catch (e) {
      view[addr] = e instanceof GateError
        ? { ...UNKNOWN, stall: { kind: 'unknown', reason: e.message } }
        : UNKNOWN;
      continue;
    }
    if (seen === null) return null;
    view[addr] = seen;
  }
  return view;
}

// Availability adapter contract, declared next door and re-exported here: a driver implements both,
// and an author should not find out that its two halves live behind two imports.
export * from './model-routing.js';
