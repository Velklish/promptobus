// The standalone host.
// [reference/02-host.md#the-standalone-host](../docs/reference/02-host.md#the-standalone-host)

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  HOST_KIND, HostResolveError, homeOfRoot,
} from './host.js';
import { ROOT_DIR } from './v1/layout.js';
import type {
  HostFreshness, HostModuleNote, HostRepo, HostRepoCandidate, HostRepoModule,
  HostMcpToolClassification, HostRoutingPaths, HostServers, HostToolBin, PromptobusHost,
  HostClone,
} from './host.js';

export const HOST_CONFIG = 'promptobus.json';
const DEFAULT_COMMAND = 'promptobus';

// Model-routing file names of the standalone host. Names, not paths: the two homes they hang off
// differ, and one name serves both overlays because a layer is told apart by its id and its home.
const ROUTING_HOME = ROOT_DIR;
const PROJECT_HOME = ROOT_DIR;
const ROUTING_DIR = 'model-routing';
const ROUTING_CACHE = 'cache.json';
const ROUTING_OVERLAY = 'model-routing.json';

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_OUTPUT = 32 * 1024 * 1024;

export interface StandaloneHostOptions {
  cwd?: string;
  home?: string;
  id?: string;
  commandName?: string;
  version?: string;
  locale?: string;
  nodePath?: string;
  binPath?: string;
  extraEnv?: Record<string, string>;
  config?: Record<string, unknown>;
}

interface HostFile {
  commandName?: string;
  locale?: string;
  version?: string;
  tools?: string[];
  rules?: string[];
  mcp?: Record<string, unknown>;
  skills?: string;
  /** Argv of the command that restores process skills a repository does not keep in git, never a
   * shell line. Read from the SPAWNED REPOSITORY's own file ([03-cli.md § Spawn](../docs/reference/03-cli.md#spawn)). */
  generate?: string[];
}

function readConfig(file: string): HostFile {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as HostFile : {};
  } catch {
    return {};
  }
}

function findConfig(start: string): { root: string; config: HostFile } {
  let dir = path.resolve(start);
  for (;;) {
    const file = path.join(dir, HOST_CONFIG);
    if (existsSync(file)) return { root: dir, config: readConfig(file) };
    const parent = path.dirname(dir);
    if (parent === dir) return { root: path.resolve(start), config: {} };
    dir = parent;
  }
}

function git(repo: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_OUTPUT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
}

function isDiskPath(target: string): boolean {
  return /^\.{1,2}([\\/]|$)/.test(target) || path.isAbsolute(target);
}

function defaultBranchOf(repoDir: string): string | null {
  const head = git(repoDir, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (head) return head.replace(/^refs\/remotes\/origin\//, '');
  for (const br of ['master', 'main']) {
    if (git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${br}`]) !== null) {
      return br;
    }
  }
  return git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

// The clone `dir` sits in: descend from the root to the first directory with `.git`. The root itself
// is never a clone here — a standalone workspace holds its clones below it. `nsPath` is the path from it.
function cloneBelow(root: string, dir: string): HostClone | null {
  const rel = path.relative(root, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  let abs = root;
  const taken: string[] = [];
  for (const part of rel.split(path.sep)) {
    abs = path.join(abs, part);
    taken.push(part);
    if (existsSync(path.join(abs, '.git'))) return { abs, nsPath: taken.join('/') };
  }
  return null;
}

export function createStandaloneHost(options: StandaloneHostOptions = {}): PromptobusHost {
  const found = findConfig(options.cwd ?? '.');
  const config: HostFile = { ...found.config, ...(options.config ?? {}) };
  const root = found.root;
  const commandName = options.commandName ?? config.commandName ?? DEFAULT_COMMAND;
  const version = options.version ?? config.version ?? '0.0.0';
  const locale = options.locale ?? config.locale ?? 'en';
  const nodePath = options.nodePath ?? process.execPath;
  const binPath = options.binPath ?? nodePath;
  const extra = { ...(options.extraEnv ?? {}) };
  const home = options.home ?? homeOfRoot(root);
  const tools = Array.isArray(config.tools) ? config.tools.map(String) : [];
  const ruleFiles = Array.isArray(config.rules) ? config.rules.map(String) : [];
  const mcp = config.mcp && typeof config.mcp === 'object' ? config.mcp : {};
  const skills = typeof config.skills === 'string' ? config.skills : null;

  const host: PromptobusHost = {
    kind: HOST_KIND,
    id: options.id ?? 'standalone',
    commandName,
    version,
    locale,

    workspaceRoot: () => root,
    promptobusHome: () => home,
    findRoot: (cwd) => {
      const hit = findConfig(cwd);
      return existsSync(path.join(hit.root, HOST_CONFIG)) ? hit.root : path.resolve(cwd);
    },
    // Routing files of a standalone workspace: the user home carries the account's cache and `user`
    // overlay, the store home the workspace layer the tool writes. A consumer inserts its own between.
    routingPaths: (): HostRoutingPaths => ({
      cacheFile: path.join(os.homedir(), ROUTING_HOME, ROUTING_DIR, ROUTING_CACHE),
      overlays: [
        { id: 'user', path: path.join(os.homedir(), ROUTING_HOME, ROUTING_OVERLAY) },
        // The workspace layer is STATE the tool writes, so it lives in this package's own directory
        // rather than the repository root. There is no fallback path: two would make the file depend on which exists.
        { id: 'workspace', path: path.join(home, ROUTING_OVERLAY), writable: true },
      ],
    }),

    // Session registry of one harness. Standalone answers the path the package used to fall back to,
    // so a single-user checkout keeps working: the refusal is for a host that names nothing.
    harnessStateHome: (harness: string): string | null => (harness
      ? path.join(os.homedir(), ROUTING_HOME, harness)
      : null),

    nodePath: () => nodePath,
    binPath: () => binPath,
    layoutBinPath: () => binPath,

    toolsManifestRel: () => HOST_CONFIG,
    skillsDir: () => (skills ? path.join(root, skills) : null),
    pluginDir: () => null,
    pluginManifestRel: () => path.join(PROJECT_HOME, 'plugin.json'),
    busHookRel: () => path.join(PROJECT_HOME, 'hooks', 'bus.mjs'),
    installManifestRel: () => path.join(PROJECT_HOME, 'manifest.json'),
    pluginSkillsRel: () => path.join(PROJECT_HOME, 'skills'),

    declaredTools: () => [...tools],
    collectRules: (repoDir) => {
      const files = [];
      const agents = path.join(repoDir, 'AGENTS.md');
      if (existsSync(agents)) files.push(agents);
      for (const rel of ruleFiles) {
        const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
        if (existsSync(abs)) files.push(abs);
      }
      return files;
    },
    moduleNote: (): HostModuleNote => ({
      level: 'info',
      text: 'workspace module does not apply — standalone host',
    }),
    resolveRepoModule: (): HostRepoModule | null => null,
    reviewSkillDir: (name) => path.join(root, PROJECT_HOME, 'skills', name),

    participantServers: (): HostServers => ({
      servers: { ...mcp },
      external: [],
    }),
    participantDenyTools: (): HostMcpToolClassification => ({ tools: [], complete: true }),
    memorySection: () => null,

    resolveRepo: async (query: string): Promise<HostRepo> => {
      if (!query) throw new HostResolveError('a repository name or path is required');
      const abs = isDiskPath(query) ? path.resolve(query) : path.resolve(root, query);
      if (!existsSync(abs)) {
        throw new HostResolveError(`«${query}» was not found on disk (${abs})`);
      }
      const rel = path.relative(root, abs);
      const nsPath = (!rel || rel.startsWith('..') || path.isAbsolute(rel))
        ? path.basename(abs)
        : rel.split(path.sep).join('/');
      return { nsPath, abs, via: 'path on disk' };
    },
    repoAbsPath: (nsPath) => (path.isAbsolute(nsPath) ? nsPath : path.join(root, nsPath)),
    isClone: (abs) => existsSync(path.join(abs, '.git')),
    formatCandidate: (candidate: HostRepoCandidate) => candidate.nsPath,
    inWorkspace: (abs) => {
      const rel = path.relative(root, abs);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    },
    cloneOf: (abs) => cloneBelow(root, abs),
    reviewLayoutError: (kind, ctx = {}) => {
      switch (kind) {
        case 'not-clone':
          return `${ctx.targetDir}: not a clone — there is no .git of its own here (nearest repository above: ${ctx.repoDir})`;
        case 'outside':
          return `${ctx.repoDir}: outside the workspace`;
        case 'no-clone':
          return `${ctx.repoDir}: clone not found`;
        case 'cwd-outside':
          return 'outside the workspace';
        case 'ask-path':
          return 'Name a path to a git repository inside the workspace.';
        default:
          return null;
      }
    },

    defaultBranch: (repoDir) => defaultBranchOf(repoDir),
    freshenRepo: (repoDir): HostFreshness => {
      const res: HostFreshness = {
        branch: null, checkout: null, behind: null, ahead: null,
        headBehindDefault: null, checkoutBehind: null, checkoutAhead: null,
        dirty: null, updated: false, warnings: [],
      };
      const fetch = spawnSync('git', ['-C', repoDir, 'fetch', '--quiet', 'origin'], {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (fetch.status !== 0) {
        res.warnings.push(`fetch origin failed: ${(fetch.stderr ?? '').toString().trim() || `exited ${fetch.status}`}`);
        return res;
      }
      res.updated = true;
      res.branch = defaultBranchOf(repoDir);
      res.checkout = git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const porcelain = git(repoDir, ['status', '--porcelain']);
      res.dirty = porcelain === null ? null : porcelain.length > 0;
      return res;
    },
    reportFresh: () => {
      // The package does not write to stdout/stderr: freshness reporting is the CLI adapter's business.
    },

    extraEnv: () => ({ ...extra }),
    // No `version`, deliberately: this host does not search for the binary, and `resolveToolBin` is
    // synchronous — see [02-host.md § The standalone host](../docs/reference/02-host.md#the-standalone-host).
    resolveToolBin: (name): HostToolBin => ({ ok: true, bin: name }),
    substituteVars: (value) => value,
    legacyLayout: () => null,

    formatCommand: (args) => [commandName, ...args].join(' '),
    formatNpx: (args) => ['npx', commandName, ...args].join(' '),
    busCommand: (args) => [commandName, ...args].join(' '),
    busArgv: (args) => [binPath, ...args],
    // Keep the established standalone spelling for its default entry: a configured command name is
    // already the dispatch word and must not receive the package's default prefix.
    guardArgv: (args) => commandName === DEFAULT_COMMAND
      ? [binPath, commandName, ...args]
      : [binPath, ...args],
    cloneHint: (nsPath) => `git clone <url> ${nsPath}`,
    syncHint: () => `${commandName} install`,
    workerPreamble: ({ taskId, nsPath, branch }) => (
      `You are a worker on task ${taskId}. Your working directory is an isolated git worktree `
      + `of repository ${nsPath} (branch ${branch}); you edit only that. Do not touch the main `
      + 'repository tree: your result stays on this branch, and the orchestrator collects it.'
    ),
    liveRunNote: () => '',
  };
  return host;
}
