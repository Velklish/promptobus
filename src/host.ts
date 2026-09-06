// Host contract: knowledge of the workspace the consumer passes into the bus
// explicitly on every call. There is no process-wide singleton: two hosts in
// one process are lawful and independent.
//
// Field names are about a workspace in general, not about one consumer's
// layout. Concrete paths (rules directory, tools manifest) are named by the
// implementation.

import path from 'node:path';

/** Host object marker: the suite uses it to tell a host from a root string. */
export const HOST_KIND = 'promptobus-host';

export interface HostRepo {
  nsPath: string;
  abs: string;
  via: string;
  group?: boolean;
}

export interface HostRepoCandidate {
  nsPath: string;
  kind?: string;
  personal?: boolean;
}

export class HostResolveError extends Error {
  readonly candidates: HostRepoCandidate[];

  constructor(message: string, candidates: HostRepoCandidate[] = []) {
    super(message);
    this.name = 'HostResolveError';
    this.candidates = candidates;
  }
}

export interface HostModuleNote {
  level: 'info' | 'warn';
  text: string;
}

export interface HostRepoModule {
  name: string;
  dir: string;
  via: string;
  meta: { review?: { skill?: string } } | null;
}

export interface HostServers {
  servers: Record<string, unknown>;
  external: string[];
}

export interface HostFreshness {
  branch: string | null;
  checkout: string | null;
  behind: number | null;
  ahead: number | null;
  headBehindDefault: number | null;
  checkoutBehind: number | null;
  checkoutAhead: number | null;
  dirty: boolean | null;
  updated: boolean;
  warnings: string[];
}

export interface HostToolBin {
  ok: boolean;
  /**
   * How to launch the tool. This is the only field that reaches a process spawn —
   * `liftoffParticipant` and the drivers pass it straight into it.
   *
   * A bare name (`PATH` resolve) and an absolute path are equally lawful: the
   * host chooses. The field has no other name. An implementation that returned
   * the path under its own title — `path`, `binPath` — would silently break
   * participant lift: `lib/**` is JavaScript, types check nothing there, and
   * `run(undefined)` is only visible in a live run. That is exactly what
   * happened at the extract: the ATI implementation returned `path`, consumers
   * read `path`, and the declared name was `bin` — the drift lived until the
   * first suite run.
   */
  bin?: string;
  /**
   * The binary's own version string as the host read it — the raw `--version`
   * line, not something normalised. Optional, and its absence means UNREAD: a
   * host that does not probe versions returns none, and a consumer may never
   * read that as "old".
   *
   * The shipped standalone host is such a host. It hands the name back without
   * searching (`src/standalone.ts`), so under it the `ultracode` refusal never
   * refuses, the two proven-version warnings never warn, and an availability
   * verdict carries no version at all — that is the DEFAULT, not a rare case.
   *
   * Declared here because four readers already exist and none of them could
   * name the field they read: the three drivers' `optionRefusal` and the three
   * availability adapters, which report it to a person as the verdict's
   * `version`. It is the drift `bin` above carries its comment about, one field
   * over — and load-bearing for a diagnosis rather than for a launch, which is
   * why it survived longer.
   */
  version?: string;
  note?: string;
  warn?: string;
  reason?: string;
}

/**
 * Former store, if this workspace ever has one.
 * `rel` — from the workspace root, exactly two segments joined by `/`: the
 * outer directory and the store inside it. Segments are non-empty, not `.`
 * and not `..`; an absolute path and `\\` are a shape error, not "no legacy".
 * `done` — the former CLI's close-active-tasks command, `<id>` placeholder.
 */
/**
 * The clone a directory belongs to, as the host names it. `abs` — the clone
 * root; `nsPath` — the host's namespace path for it (`group/repo`,
 * `external/repo`, or whatever the host uses for participant and task names).
 */
export interface HostClone {
  abs: string;
  nsPath: string;
}

export interface HostLegacyLayout {
  rel: string;
  done: string;
}

/** One model-routing overlay layer: `id` names it in diagnostics, `path` is the file. */
export interface HostRoutingOverlay {
  id: string;
  path: string;
  /**
   * Whether this is the layer the TOOL writes (ADR-004, decision 6). PB-32 adds
   * the writer, `models strategy --set`; until then the flag is a declaration
   * with no caller, which is the order this package takes everywhere — the
   * contract first, then what runs on it.
   *
   * Exactly one layer carries it whenever any layer is declared; `readLayers`
   * refuses zero and refuses two, naming the layers it found. The refusal is at
   * the declaration rather than at the write for the reason `harnessStateHome`
   * refuses instead of guessing: a host that names layers and no writable one has
   * an incomplete declaration, and finding that out at the write costs a person
   * the edit they just made.
   *
   * A writable layer is STATE, not configuration, so it must not be a file
   * anybody commits. Under the standalone host it is `workspace`, and it lives at
   * `<promptobusHome>/model-routing.json` for exactly that reason — a consumer
   * keeps it wherever its own state lives, under the same one condition.
   *
   * A host should mark the HIGHEST-precedence layer, or the tool would write a
   * value a layer above it overrides; the writer PB-32 adds will warn when that
   * happens rather than leave the person to wonder why their default did not
   * take.
   */
  writable?: boolean;
}

/**
 * Where model routing keeps its files. Both are ACCOUNT-scoped, not workspace-
 * scoped, and that is why they do not come from `promptobusHome()`: that home is
 * the task store of one workspace, while auth, model inventory and the remaining
 * subscription limit belong to the account the harness binary is logged into. A
 * per-store cache would re-probe three harnesses for every checkout of the same
 * account.
 *
 * `overlays` is ordered LOWEST precedence first, and the order is the host's to
 * choose. One method with a list rather than a getter per layer, because a
 * consumer will want a layer of its own — its shipped deny lists and defaults —
 * between the person's user-wide and workspace-local files: with a list that is
 * a host-side choice, with getters it is another change to this interface and a
 * repin for every consumer. `id` is what the decision output and `models
 * validate` name a layer by, so a refusal reads `denied by overlay "workspace"`
 * and not a path the reader has to place themselves.
 *
 * A missing overlay file is normal. The host names paths; it does not promise
 * they exist.
 */
export interface HostRoutingPaths {
  cacheFile: string;
  overlays: HostRoutingOverlay[];
}

export interface PromptobusHost {
  readonly kind: typeof HOST_KIND;
  readonly id: string;
  readonly commandName: string;
  readonly version: string;
  readonly locale: string;

  workspaceRoot(): string;
  promptobusHome(): string;
  findRoot(cwd: string): string | null;
  /**
   * Model-routing files: the availability cache and the overlay layers, lowest
   * precedence first. See `HostRoutingPaths` — these are account-scoped, and
   * `promptobusHome()` is not used for routing.
   */
  routingPaths(): HostRoutingPaths;
  /**
   * Where the package keeps its own session registry for one harness — the
   * records `inspect`, `stop` and the wake path read and write. Account-scoped
   * like `routingPaths()`, and for the same reason: a session a harness keeps
   * alive belongs to the account its binary is logged into, not to one
   * workspace. `null` means the host names none, and then a run refuses.
   *
   * It refuses instead of guessing because the guess was measured. The package
   * used to fall back to `~/.promptobus/<harness>` when the per-harness
   * environment variable was unset. A consumer that had named its own
   * variables instead therefore had two harness registries writing into the
   * operator's REAL home while `inspect` read the sandbox — two halves of one
   * test looking at different directories, with no error anywhere and nothing
   * in either log to say so (PB-2). A named refusal costs one message; a
   * silent guess cost a day.
   *
   * Precedence at the call site: `PROMPTOBUS_<HARNESS>_HOME` from the
   * environment, then this method, then the refusal — which names both, so
   * the reader is not left to find out which of the two to set.
   */
  harnessStateHome(harness: string): string | null;

  nodePath(): string;
  /** CLI entry this call was lifted with — it is how the participant bus stdio server is declared. */
  binPath(): string;
  /** Entry written to disk (hooks). For standalone this matches binPath. */
  layoutBinPath(): string;

  toolsManifestRel(): string;
  skillsDir(): string | null;
  pluginDir(): string | null;
  pluginManifestRel(): string;
  busHookRel(): string;
  installManifestRel(): string;
  pluginSkillsRel(): string;

  declaredTools(): string[];
  collectRules(repoDir: string): string[];
  moduleNote(repoDir: string): HostModuleNote;
  resolveRepoModule(repoDir: string): HostRepoModule | null;
  reviewSkillDir(name: string): string;

  participantServers(): HostServers;
  memorySection(toolName: (server: string, name: string) => string): string | null;

  resolveRepo(query: string): Promise<HostRepo>;
  repoAbsPath(nsPath: string): string;
  isClone(abs: string): boolean;
  formatCandidate(candidate: HostRepoCandidate): string;
  inWorkspace(abs: string): boolean;
  /**
   * The clone `abs` sits in, or `null` when no clone of this workspace
   * contains it. The host owns the layout entirely: which zones exist
   * (`repos/<group>/<repo>`, `external/<repo>`, a flat root), how deep a
   * namespace goes, whether a bare repository directly under a zone counts.
   * The package asks and never walks the tree itself: a walk from one "repos
   * root" knew a single zone, and the second zone a host grew turned into a
   * refusal the host could not word.
   */
  cloneOf(abs: string): HostClone | null;
  /**
   * Reviewer refusal about clone layout. `null` — this kind of refusal does
   * not apply for this host. A host that requires a particular shape of clone
   * (a group/repo pair, a known zone) says so in its `no-clone` and
   * `cwd-outside` texts: what a clone is, `cloneOf` has already decided.
   */
  reviewLayoutError(
    kind: 'not-clone' | 'outside' | 'no-clone' | 'cwd-outside' | 'ask-path',
    ctx?: { targetDir?: string; repoDir?: string; abs?: string; dir?: string },
  ): string | null;

  defaultBranch(repoDir: string): string | null;
  freshenRepo(repoDir: string): HostFreshness;
  reportFresh(result: HostFreshness, label: string): void;

  extraEnv(): Record<string, string>;
  resolveToolBin(name: string): HostToolBin;
  substituteVars(value: unknown): unknown;
  /**
   * Where to migrate from and how to close former tasks. `null` — nothing to
   * migrate from; that is how standalone and any host without a former-store
   * history look.
   */
  legacyLayout(): HostLegacyLayout | null;

  formatCommand(args: string[]): string;
  formatNpx(args: string[]): string;
  busCommand(args: string[]): string;
  /**
   * How to LAUNCH a bus subcommand: the whole argv, no leading `node`.
   *
   * `busCommand` next to it is for printing to a person, and is no good for
   * launch: the string would have to be parsed back. The package must not
   * assemble argv itself: it does not know whether its subcommands live at the
   * consumer binary root or under their own word. Assembled on that assumption,
   * `[binPath(), 'mcp']` would land in the consumer help, not on the bus —
   * silently, because a foreign CLI answers an unknown subcommand with help
   * and exit 0.
   */
  busArgv(args: string[]): string[];
  cloneHint(nsPath: string): string;
  syncHint(): string;
  workerPreamble(ctx: { taskId: string; nsPath: string; branch: string }): string;
  liveRunNote(nsPath: string): string;
}

export function isPromptobusHost(value: unknown): value is PromptobusHost {
  if (!value || typeof value !== 'object') return false;
  const rec = value as { kind?: unknown; workspaceRoot?: unknown; commandName?: unknown };
  return rec.kind === HOST_KIND
    && typeof rec.workspaceRoot === 'function'
    && typeof rec.commandName === 'string';
}

export function homeOfRoot(root: string, rel = '.promptobus'): string {
  return path.join(root, rel);
}
