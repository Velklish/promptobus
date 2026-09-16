// The host contract, in one sentence per member.
// [reference/02-host.md#the-host-contract-in-one-sentence-per-member](../docs/reference/02-host.md#the-host-contract-in-one-sentence-per-member)

import path from 'node:path';
import { ROOT_DIR } from './v1/layout.js';

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
  /** Names of externally authorized servers that did not travel to the participant. */
  external: string[];
}

/** A canonical MCP tool identity, independent of a harness's spelling. */
export interface HostMcpTool {
  server: string;
  tool: string;
}

/** The host's complete answer about canonical external MCP write tools. */
export interface HostMcpToolClassification {
  tools: HostMcpTool[];
  complete: boolean;
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
  /** How to launch the tool — the ONLY field that reaches a process spawn. A bare name and an
   * absolute path are equally lawful, and the field has no other name: a renamed one broke lift. */
  bin?: string;
  /** The binary's own version string as the host read it, raw.
   * [reference/02-host.md#the-binary-version-a-host-read-and-what-its-absence-means](../docs/reference/02-host.md#the-binary-version-a-host-read-and-what-its-absence-means) */
  version?: string;
  note?: string;
  warn?: string;
  reason?: string;
}

/** The clone a directory belongs to, as the host names it: `abs` is the clone root, `nsPath` the
 * host's namespace path for it (`group/repo`, `external/repo`, or whatever the host uses). */
export interface HostClone {
  abs: string;
  nsPath: string;
}

/** Former store, if this workspace ever has one. `rel` is two non-empty segments from the workspace
 * root — absolute or `\\` is a shape error, not "no legacy"; `done` closes former tasks, `<id>`. */
export interface HostLegacyLayout {
  rel: string;
  done: string;
}

/** One model-routing overlay layer: `id` names it in diagnostics, `path` is the file. */
export interface HostRoutingOverlay {
  id: string;
  path: string;
  /** Whether this is the layer the TOOL writes (ADR-004, decision 6).
   * [reference/02-host.md#the-layer-the-tool-writes](../docs/reference/02-host.md#the-layer-the-tool-writes) */
  writable?: boolean;
}

/** Where model routing keeps its files.
 * [reference/02-host.md#hostroutingpaths--where-model-routing-keeps-its-files](../docs/reference/02-host.md#hostroutingpaths--where-model-routing-keeps-its-files) */
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
  /** Model-routing files: the availability cache and the overlay layers, lowest precedence first.
   * Account-scoped — `promptobusHome()` is not used for routing. */
  routingPaths(): HostRoutingPaths;
  /** The environment variable one harness's registry is named by, and the refusal.
   * [reference/02-host.md#harnessstatehome--the-harness-session-registry-and-the-refusal-when-nobody-says](../docs/reference/02-host.md#harnessstatehome--the-harness-session-registry-and-the-refusal-when-nobody-says) */
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
  /** No longer written: the path `install` recognises an older feed hook by (PB-173). */
  busHookRel(): string;
  installManifestRel(): string;
  pluginSkillsRel(): string;

  declaredTools(): string[];
  collectRules(repoDir: string): string[];
  moduleNote(repoDir: string): HostModuleNote;
  resolveRepoModule(repoDir: string): HostRepoModule | null;
  reviewSkillDir(name: string): string;

  participantServers(): HostServers;
  /** Optional external write-tool classification for a constrained participant; never include the Promptobus bus. */
  participantDenyTools?(role: 'reviewer' | 'approver'): HostMcpToolClassification;
  memorySection(toolName: (server: string, name: string) => string): string | null;

  resolveRepo(query: string): Promise<HostRepo>;
  repoAbsPath(nsPath: string): string;
  isClone(abs: string): boolean;
  formatCandidate(candidate: HostRepoCandidate): string;
  inWorkspace(abs: string): boolean;
  /** The clone `abs` sits in, or `null`. The host owns the layout entirely; the package asks and
   * never walks the tree itself, because a walk knew one zone and refused the second. */
  cloneOf(abs: string): HostClone | null;
  /** Reviewer refusal about clone layout; `null` means this kind does not apply for this host. What
   * a clone IS has already been decided by `cloneOf`. */
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
  /** Where to migrate from and how to close former tasks. `null` — nothing to migrate from, which is
   * how standalone and any host without a former-store history look. */
  legacyLayout(): HostLegacyLayout | null;

  formatCommand(args: string[]): string;
  formatNpx(args: string[]): string;
  busCommand(args: string[]): string;
  /** How to LAUNCH a bus subcommand: the whole argv, no leading `node`. The package must not build
   * it — a wrong guess lands in the consumer help, silently, because that exits 0. */
  busArgv(args: string[]): string[];
  /** How to LAUNCH the loop guard hook: the whole argv, no leading `node`. Unlike `busArgv` this uses
   * `layoutBinPath()` — the hook is written into project settings and must call that layout's entry. */
  guardArgv(args: string[]): string[];
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

export function homeOfRoot(root: string, rel = ROOT_DIR): string {
  return path.join(root, rel);
}
