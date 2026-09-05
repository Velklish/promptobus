// Driver contract and driver registry, entry point "./driver".
//
// Driver — adapter of one harness: it launches a participant session, recognises its
// state, wakes it, and can stop it. Which harness it is — the package does not know
// and has no right to know: only the contract is declared here, and the drivers
// themselves live at the consumer. The registry is passed into core EXPLICITLY, as a
// `harness → driver` map, and an unknown harness refuses BEFORE anything changes in
// the store: a refusal after writing the participant would leave in the task journal
// a participant with nothing to wake it by.
//
// Constraint invisible from this file: no harness name is here and none can be —
// the package set gate watches for that.
import { addressOf, GateError } from './protocol.js';
import type { PromptobusHost } from './host.js';
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

/**
 * What the driver can do. The snapshot is stored in the participant record.
 *
 * There are nine flags, in two kinds. The first five declare OPERATIONS — each has
 * a same-named method, and `requireCapability` asks for them. The last four
 * declare harness PROPERTIES, which have no method: they must be asked before
 * launch, because without them a role or an output line cannot be assembled —
 * not a separate call.
 */
export interface DriverCapabilities {
  spawn: boolean;
  attach: boolean;
  activation: Activation;
  inspect: boolean;
  stop: boolean;
  /**
   * Whether the harness can deny the session tools. Without it a read-only participant
   * does not exist at all, and `review` must refuse BEFORE launch: a launched reviewer
   * with write rights is not “review without a guarantee”, but a session that edits
   * the code under review.
   */
  denyTools?: boolean;
  /**
   * Whether the harness can accept its settings file or a system prompt for a single launch.
   * Today only the capabilities SNAPSHOT in the participant record reads it — evidence of
   * what it was launched with; the mechanism has no branch on it, because a driver without
   * a settings file will deliver the participant neither a loop guard nor skills, i.e. will
   * not launch it at all. `--harness` asks it first: there a person chooses the driver.
   */
  systemPrompt?: boolean;
  /**
   * Whether the harness has a session registry. Without it the session state is
   * unknown, not death: the mechanism has no right to declare a session dead just
   * because there is no one to ask about it.
   *
   * Read today TWOFOLD and without a branch on the flag itself: a driver without a
   * registry does not declare `inspect`, the snapshot gives such a participant
   * `unknown`, and from that `promptobus status` prints “no one to ask about it”,
   * cleanup leaves the directory, and the supervisor does not stop it. The flag
   * names the REASON for that unknown — so a second driver can declare it out loud
   * rather than by a silent absence of the operation.
   */
  sessionList?: boolean;
  /**
   * Whether a person can ENTER the session from a terminal. The word `attach` in the
   * contract is taken by the participant mode (`attached`), so human entry is called
   * `enter` (glossary).
   *
   * Today the capabilities snapshot and `phrases.enter` read it; the driver gives the
   * adapter an enter string for the stall route; there is no separate branch on the
   * flag — the route is that branch. `--harness` asks it first: for a harness with
   * no human entry the advice “only a person can reply” would have to be written
   * differently.
   */
  enter?: boolean;
}

// Participant mode — a v1 record field (`managed` | `attached`), and it has no second
// declaration: the driver contract and the store schema must speak of the same thing.
export type { ParticipantMode } from './v1/model.js';

/**
 * Session state in the snapshot. `alive` — a process stands behind the record, `stale` —
 * the record outlived its process, `gone` — there is no record at all. Distinguishing
 * these three is the driver's duty: harnesses have different signs, and core has one
 * question — whether to wait for messages from the participant.
 *
 * `unknown` is a fourth and is not about the session but about the observer: there
 * was no one to ask. No driver was found for the record's harness, or the driver did
 * not declare `inspect`. No consumer treats this as death: the rule “unknown is not
 * death” holds the supervisor exit, the stall report, and `promptobus done` cleanup —
 * taking unknown for death, the mechanism would stop a live task's listener and
 * remove a running session's config.
 */
export type SessionState = 'alive' | 'stale' | 'gone' | 'unknown';

/** Session stall as the driver named it: `kind` chooses the route, `reason` — words for a person. */
export interface SessionStall {
  kind: string;
  reason: string;
}

/** What the driver knows about one session right now. */
export interface SessionView {
  state: SessionState;
  /** Whether the session is busy with a turn. The driver does not know — `false`: unknown is not treated as busy. */
  busy: boolean;
  stall: SessionStall | null;
  /** Session identifier for the adapter's human routes. */
  id: string | null;
  /**
   * The harness word about the state — for the adapter's human line. Core does not
   * read it and makes no decisions from it: each harness has its own vocabulary, and
   * agreeing on one is impossible, but showing it to a person is possible.
   */
  note?: string | null;
}

/**
 * Snapshot of participant sessions: address → what is known about its session. The key
 * is the ADDRESS, not the record id: health, stall marks and contact points are keyed
 * the same way, and it is what goes into the notification a person reads
 * ([protocol.ts](protocol.ts), `addressOf`). `null` — there is no state at all (the
 * driver did not parse the harness reply), and that is NOT “everyone is alive”. A
 * participant without a session reference (a person session behind the owner address)
 * is not listed in the snapshot at all.
 */
export type SessionSnapshot = Record<string, SessionView> | null;

/**
 * Harness-neutral MCP descriptor: how the participant reaches the bus and the other
 * servers. The driver itself translates it into its own config and arguments.
 */
export interface McpDescriptor {
  address: string;
  task: string;
  home: string;
  servers: Record<string, unknown>;
}

/**
 * Launch context: everything the driver needs, and nothing about its harness. Not a
 * single argv, flag name, or home path is here — the driver assembles those itself
 * in `prepare`. The consumer names the SUBJECT (“directories the participant may
 * read”, “the loop-guard command”), and only the driver knows how that looks for
 * the harness.
 */
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
  denyTools?: string[] | null;
  /** Workspace settings addressed to the participant: the driver puts them in its file. */
  extraSettings?: Record<string, unknown>;
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

/**
 * Launch plan: translation of the harness-neutral context into argv, configs and files.
 * Assembled by ONE `prepare` call, and the same object goes into `spawn`: `--dry-run`
 * printing and the real launch must speak of the same thing, and two assembly calls
 * would silently diverge.
 */
export interface LaunchPlan {
  /** Launch arguments. The consumer neither assembles nor edits them — only prints. */
  argv: string[];
  /** MCP config in the harness form: `--dry-run` reads it and the consumer writes it to disk. */
  mcpConfig: unknown;
  /** Settings file in the harness form. */
  settings: unknown;
  /** What will go to disk before launch. Order matters: the driver writes them in that order. */
  files: LaunchFile[];
  /**
   * Session working directory, if the driver chose NOT the one the caller named.
   * Needed where the harness does not accept settings for a single launch and reads
   * them from its own working directory: if it seated such a participant in the
   * caller directory, configs would land in a foreign tree. Field absent — the
   * directory from `SpawnContext.cwd` is used.
   */
  cwd?: string;
}

/**
 * Harness words that the adapter inserts into its lines. Shared text stays with the
 * adapter; the harness-specific command comes as a string from here: otherwise
 * everyone who prints a session line would have to know the harness enter command.
 */
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
  /**
   * How THIS harness names an MCP server tool — the name the session calls it by.
   * The client assembles the name, not the server, and different clients differ:
   * a participant prompt that names bus and memory tools must take the spelling
   * from here, otherwise the participant looks for a tool it does not have under
   * that name.
   *
   * The host is passed because for one harness the spelling carries the consumer's
   * identity: its MCP config keys are namespaced to avoid colliding with the
   * operator's personal set, the tool name is built out of the config key, and the
   * namespace is `commandName`. A driver whose spelling does not depend on the
   * workspace ignores the argument.
   */
  tool(server: string, name: string, host: PromptobusHost): string;
  /**
   * Rules of THIS harness appended to the participant prompt: what belongs to the
   * tool, not the assignment — its headless habits. Empty — nothing to append, and
   * the prompt stays exactly what the caller assembled.
   */
  promptRules: string;
  /**
   * What this harness calls the session when the mechanism does not choose the name.
   * `--dry-run` prints this string: it must say what is NOT in its output and why —
   * a name the binary invents at start cannot be printed in advance. Not declared —
   * the mechanism chooses the session name, and `--dry-run` prints it as-is.
   */
  naming?: string;
}

/**
 * Allowed option values and harness versions. The consumer does not know them and
 * has no right to know: effort levels, permission modes and deniable tools are the
 * harness vocabulary, not the bus.
 */
export interface DriverOptions {
  /**
   * Harness binary name: the adapter resolves its path by it, checks the version and
   * prints the command in `--dry-run`. It matches the driver `id` not by rule but
   * by fact for this harness: the name in the registry map and the executable name
   * are different subjects.
   */
  tool: string;
  /** Allowed effort values. */
  effortLevels: string[];
  /** Minimum harness version per effort level — where the value does not arrive with every version. */
  effortMinVersion?: Record<string, string>;
  /** Allowed permission modes and the one taken without a flag. */
  permissionModes: string[];
  defaultPermissionMode: string;
  /**
   * Model the participant is launched with without the `--model` flag. Home is the
   * driver: the model-name vocabulary belongs to the harness entirely, and one
   * binary default is rejected by another as any unknown id.
   */
  defaultModel: string;
  /**
   * Whether the harness takes the workspace skills directory for one session.
   * Optional: not declared — “does not take”, and the output line says so out loud
   * instead of promising the participant skills it never received.
   */
  skillsDir?: boolean;
  /** Tools taken from a read-only participant (`denyTools` capability). */
  denyTools: string[];
  /** Harness version on which the wake channel was proven. Not a gate — evidence. */
  provenVersion: string;
  /**
   * How the driver wakes the session: `socket` — a knock on a live session channel,
   * `turn` — a new turn on it, `inject` — inserting text into a live session besides
   * the socket. The distinction is not cosmetic: the set's stand-in channel substitutes
   * delivery only where it truly is a socket — the others have nothing to substitute,
   * and their `endpoint` is not a socket at all.
   */
  knockChannel: string;
  /** Ancestor variables that must not reach the session. */
  envDrop: string[];
  /**
   * Workspace utilities without which the driver will not launch a session. Names,
   * not paths: resolve, minimum version and refusal wording are held by the
   * consumer — that is also where the tool declaration lives. Optional: not
   * declared — the harness has no such dependencies, and there is nothing to ask.
   */
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
  /**
   * The record harness, as it named it. The consumer needs it to ask the ROUTE
   * of the same driver that parsed the state: the stall line is printed by
   * `status`, the `mailbox` reply and the supervisor report, and the command in
   * it is harness-specific. Field absent from the record — `null`, and the
   * consumer takes its registry `fallback`.
   */
  harness: string | null;
}

/**
 * Notification: what core asks to deliver. There is no text here on purpose — the
 * driver renders it, because the frame and the words belong to the harness channel,
 * not the bus.
 */
export type Notification =
  { kind: 'unread'; task: string; address: string; unread: number; messages: NotificationMessage[] };

/**
 * Stop outcome. Two flags, not one: `ok` says the operation did not refuse, and
 * `stopped` — that the session was actually stopped. The session is already gone,
 * the record has no identifier, the state was not parsed — that is success, but
 * there was nothing to stop, and printing such an outcome as “session closed”
 * would assert the unproven.
 */
export interface StopResult {
  ok: boolean;
  stopped: boolean;
  note: string;
  /**
   * The driver ISSUED the stop command but could not confirm the session vanished:
   * the wait ceiling ran out or the registry after the command was not parsed.
   * Without this flag `stopped: false` means “there was no session even before the
   * command”, and the consumer would print two different outcomes in the same
   * words — “there was nothing to stop” would deny that a stop was in fact needed.
   * Cleanup leaves the participant directory: for it the session is not dead.
   */
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
  /**
   * Harness vocabulary: allowed option values, versions, deniable tools.
   * Required, not “if present” (review remark): CLI help, both launches, `doctor`
   * and `lint` read it — and they read it WITHOUT a check, because a driver without
   * an options vocabulary will not launch a session at all. Making it optional
   * would defer and blur the refusal: the CLI takes values from it at the module
   * top level, so it would crash on any CLI command, including `--version`.
   */
  readonly options: DriverOptions;
  /** Harness strings for the adapter's human routes. Required for the same reason. */
  readonly phrases: DriverPhrases;
  /**
   * Translate the harness-neutral context into its launch plan. Writes nothing and
   * starts nothing: `--dry-run` prints exactly what `spawn` will execute.
   */
  prepare?(context: SpawnContext): LaunchPlan;
  spawn?(plan: LaunchPlan, runtime: SpawnContext): Promise<unknown>;
  attach?(plan: LaunchPlan, runtime: SpawnContext): Promise<unknown>;
  /** What was said about the launch after success: unconfirmed check, unparsed id. */
  saidLiftoff?(result: unknown): void;
  inspect?(ref: string): SessionView | null;
  /** Forget the remembered session list: after launch and stop it is stale. */
  forgetSessions?(): void;
  activate?(target: ActivationTarget, notification: Notification): Promise<ActivateResult> | ActivateResult;
  /** Notification text into this harness channel. Inside `activate`; outward — for the seam. */
  renderNotification?(notification: Notification): string;
  /**
   * What a person should do with this stall — in their harness commands. Shared
   * text (“stalled”, “LISTED”, “GONE”) stays with the adapter: it is one for all
   * harnesses.
   */
  stallRoute?(stall: StalledParticipant & { task?: string | null }, id: string | null, ref: string | null): string;
  /** Hand the contact point of ITS OWN session into the task store: only the harness knows the socket address. */
  registerWake?(home: string, task: string, address: string, env?: unknown, session?: string | null): unknown;
  /** Tell the supervisor journal that a write for a foreign address did not go through. */
  sayForeignWrite?(home: string, task: string, address: string, held: string, session: string | null, what: string): void;
  /** Wake-channel smoke for diagnostics: whether a socket was handed over and whether it accepts a connection. */
  checkWake?(env?: unknown): Promise<WakeProbe>;
  /**
   * Environment of the session being launched: the caller's `extra` is laid over the
   * inherited one, and the driver strips variables leaking from the ancestor. The
   * second argument is required in practice: it carries a lever the mechanism itself
   * sets (the memory-hook gate), and a driver that reads only `base` would lose it
   * silently.
   */
  sessionEnv?(base: unknown, extra?: Record<string, string>): Record<string, string | undefined>;
  /**
   * Refusal by harness version for the requested options — before the first write to
   * disk. `null` — nothing to refuse for: the version is fine or was not read, and
   * the mechanism has no right to assert “older than required” about the unread.
   */
  optionRefusal?(options: { effort?: string | null }, tool: unknown): string | null;
  /**
   * Names of delivered MCP servers shadowed by the user's PERSONAL records. Personal
   * config is a harness property: for a second driver it lives in a different place
   * and a different form, and the output line about shadowing is one for all.
   */
  shadowedUserServers?(names: string[]): string[];
  /**
   * Stop the session. `ok` — the operation did not refuse, `stopped` — the session
   * was actually stopped: nothing to stop is also success, but a different outcome,
   * and they must not be confused.
   *
   * **The operation returns when the harness already has NO session** — or with an
   * honest `stopped: false` and a reason in `note`, if the wait ran past its own
   * ceiling. Promising “stopped” earlier is not allowed: cleanup follows the stop,
   * and it asks the driver for the session state — if `stop` returned before its
   * death, the walk would see a live session and would lawfully leave its directory
   * until the next task close.
   *
   * The driver may wait, so the outcome can also be a promise: `stopParticipant`
   * `await`s it, and the consumer must do the same. A synchronous driver also
   * satisfies the contract — it has nothing to wait for if its harness loses the
   * session in the same call.
   */
  stop?(ref: string): StopResult | Promise<StopResult>;
  /**
   * Availability adapter of this harness: what the ACCOUNT can do, asked before
   * any session exists ([model-routing.ts](model-routing.ts)).
   *
   * Optional, and its absence is a state rather than an error: the registry
   * answers `unknown` / `probe_failed` for a driver that declares none, and the
   * resolver penalises `unknown` instead of blocking on it. That is what lets the
   * preflight ship before the adapters do.
   */
  readonly availability?: AvailabilityAdapter;
}

/**
 * `harness → driver` map. The consumer assembles it itself and passes it into core
 * explicitly: core neither creates drivers nor looks them up.
 *
 * `fallback` — the harness attributed to a participant record that has NO `harness`
 * field at all. The former CLI left such records when there was one harness; a
 * legacy fixture sits on them too. An empty field is not the same as an unknown
 * name: a non-empty unfamiliar harness refuses, and fallback does not save it.
 */
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

/**
 * Whether the driver can do what is asked of it. Asked BEFORE the store changes: a
 * declared capability without an operation is the same refusal as an undeclared
 * one, because they are indistinguishable to the caller.
 */
export function requireCapability(driver: Driver, op: 'spawn' | 'attach' | 'inspect' | 'stop'): void {
  if (!driver.capabilities?.[op]) {
    throw new GateError(`driver «${driver.id}» cannot ${op} — this operation is not declared by it`);
  }
  if (typeof (driver as unknown as Record<string, unknown>)[op] !== 'function') {
    throw new GateError(`driver «${driver.id}» declared ${op} but has no such operation`);
  }
}

/** Harness properties without their own operation: asked by the flag, not by method presence. */
export type DriverFeature = 'denyTools' | 'systemPrompt' | 'sessionList' | 'enter';

/**
 * Whether the driver declared a harness property. Such flags have no operation, so
 * `requireCapability` does not fit here: there is nothing to ask except the
 * declaration itself. An undeclared property is read as “no”: the silent “it
 * probably can” is exactly the case the flag was introduced for.
 */
export function hasFeature(driver: Driver, feature: DriverFeature): boolean {
  return driver.capabilities?.[feature] === true;
}

/** Whether the driver wakes on its own. A pull-driver does not wake the session — it organises its own polling. */
export function pushes(driver: Driver): boolean {
  return driver.capabilities?.activation === 'push';
}

/**
 * Opaque session reference of the participant record. Former-CLI records carried it
 * in the `name` field; migration ([migrate.ts](migrate.ts)) gave them a separate
 * field, so only that is read here — v1 has no second source.
 */
export function sessionRefOf(participant: ParticipantV1 | null | undefined): string | null {
  const ref = participant?.sessionRef;
  return typeof ref === 'string' && ref ? ref : null;
}

/**
 * Write a participant the driver launched (`managed`) or whose session it attached to
 * (`attached`).
 *
 * The registry is asked FIRST, and that is the whole point of the function: an
 * unknown harness and an undeclared operation refuse before anything changes in
 * the task journal. A refusal after the write would leave in the journal a
 * participant with nothing to wake it by — and the journal is read by the
 * supervisor, by `status`, and by cleanup.
 */
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
  // The record is given to the caller in full: `putParticipant` writes the participant
  // in full, and whoever appends a session id to it must put back THE SAME record, not
  // one assembled anew — otherwise the driver fields would vanish on the very next write.
  //
  // A store refusal is translated into `GateError`, as the mechanism door translates
  // it: two commands call launch, and a busy journal is a lawful outcome for them.
  // Two `promptobus spawn` of one run contend for the journal by construction, and
  // the loser must read “task journal is busy”, not a `PromptobusError` stack from
  // the outer catch.
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

/**
 * Participant mode. Field absent entirely — `managed`: the former CLI left records
 * from spawn, and spawn launched the session itself. A participant without a
 * session reference has no mode: no one launched a session behind it (that is how
 * the task owner lives).
 */
export function modeOf(participant: ParticipantV1 | null | undefined): ParticipantMode | null {
  if (!sessionRefOf(participant)) return null;
  const raw = typeof participant?.mode === 'string' ? participant.mode.trim() : '';
  // Field absent entirely — `managed`: that is how the former CLI wrote participants, and spawn launched the session.
  if (!raw) return 'managed';
  // An unfamiliar non-empty value is a typo or junk from a hand edit, and a default
  // here is destructive (review remark): “if not attached, then managed” would stop
  // a session the driver did not launch. There is no mode — there is no one to stop
  // it, and an explicit call refuses.
  return raw === 'managed' || raw === 'attached' ? raw : null;
}

/** Whether the driver owns this session: it launched it — it is the one to stop it. */
export function isManaged(participant: ParticipantV1 | null | undefined): boolean {
  return modeOf(participant) === 'managed';
}

/**
 * Stop a participant session — a driver operation, not a command.
 *
 * Only `managed` may be stopped: the driver did not launch a session that attached
 * itself, and capability has nothing to do with it — the matter is the mode. The
 * refusal is explicit, not a silent skip: a foreign session quietly left alive is
 * exactly the case the mode was declared as a field for.
 *
 * Idempotence is on the driver: the session is already gone, it is dead, or its
 * state was not parsed — that is an outcome with its own words, not an error.
 *
 * The outcome is `await`ed: the driver may wait until the harness no longer has
 * the session, and the consumer must wait for it — otherwise cleanup would proceed
 * from a state that is not there yet.
 */
export async function stopParticipant(participant: ParticipantV1, registry: Registry): Promise<StopResult> {
  const driver = driverFor(registry, harnessOf(participant, registry));
  requireCapability(driver, 'stop');
  const mode = modeOf(participant);
  if (mode !== 'managed') {
    // An unfamiliar value is named literally: “there is no mode” about a field that
    // has something written in it would read as “there is no field”, and they are
    // fixed differently.
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

/**
 * Snapshot of participant sessions — the state-machine input. Taken once per heartbeat:
 * a driver reply stands on an external harness poll, and the supervision loop that
 * runs once a second does not start a poll of its own.
 *
 * If the driver did not parse the state of even one session — there is no snapshot
 * at all: unknown for one participant means the source is unavailable, not that
 * the others are dead.
 *
 * **One invalid record has no right to take the whole snapshot with it** (review
 * remark). A foreign harness and a driver that declared itself not looking give
 * that participant `unknown` — and the walk continues. Otherwise the refusal
 * leaked out and felled every snapshot reader at once: `promptobus status`
 * printing, the `promptobus done` walk in the middle of cleaning foreign tokens,
 * and the supervisor process itself. The supervision loop will speak about a
 * foreign harness — it has its own words and its own health mark there.
 */
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
    } catch {
      view[addr] = UNKNOWN;
      continue;
    }
    if (seen === null) return null;
    view[addr] = seen;
  }
  return view;
}

// Availability adapter contract, declared next door ([model-routing.ts](model-routing.ts))
// and re-exported here: a driver implements both, and an author of one harness
// should not have to find out that its two halves live behind two imports.
export * from './model-routing.js';
